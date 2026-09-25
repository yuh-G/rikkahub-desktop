// model-providers/auth/credential-store.ts — pi-ai CredentialStore 契约在宿主 state 上的实现。
// 纪律(方案 §2.4):
//   1. modify 是唯一写路径,pi Models.getAuth 的读-改-写(刷新窗口内锁内二次校验)跑在
//      这里的 per-provider 串行队列上——同一 provider 的并发请求不会双刷被轮换的 refresh token。
//   2. 写凭证 = 读 state → 生成新 providers 数组 → updateSettings 一次性原子落盘,
//      永远不做「先内存改、后落盘」的两步态(崩在窗口内不会留半写状态)。
//   3. mutate 回调可能做网络刷新(resolve.ts 在锁内跑 oauth.refresh),故队列是 async 的,
//      不锁 state 全局、只锁 (providerId) 粒度——不同供应商互不影响。

import type { OAuthCredential } from "../../../pi/packages/ai/src/auth/types.ts";
import { updateSettings } from "../../app-config";
import type { Provider } from "../../foundation/types";
import { reportError } from "../../observability/app-errors";
import { state } from "../../persistence/json-store";

export type Credential = OAuthCredential;

export interface CredentialStore {
  read(providerId: string, options?: { signal?: AbortSignal }): Promise<Credential | undefined>;
  list(): Promise<Array<{ providerId: string; type: "oauth" }>>;
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: { signal?: AbortSignal },
  ): Promise<Credential | undefined>;
  delete(providerId: string, options?: { signal?: AbortSignal }): Promise<void>;
}

// per-provider 串行队列。Value 是队尾 promise;新任务链接其上,严格 FIFO。
const tails = new Map<string, Promise<void>>();

function enqueue<T>(providerId: string, run: () => Promise<T>): Promise<T> {
  const prev = tails.get(providerId) ?? Promise.resolve();
  const next = prev.then(run, run); // 前序失败不阻断后续
  tails.set(
    providerId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function findProvider(providerId: string): Provider | undefined {
  // state 可能未初始化(pi 引擎测试 / 纯工具调用场景)——安全回落 undefined。
  return state?.settings?.providers?.find((p) => p.id === providerId);
}

function readCredential(providerId: string): Credential | undefined {
  const provider = findProvider(providerId);
  if (!provider?.oauth) return undefined;
  return provider.oauth.credential as unknown as Credential;
}

/** CAS 落盘:mutate 期间 provider 行可能已被别处改写(登录/注销/POST 保存),refresh
 *  指纹相验——若行内 refresh 已不是我们 mutate 时的起点,说明有并发写赢了,本次写丢弃。 */
function commitCredential(providerId: string, expectRefresh: string | undefined, next: Credential | undefined): boolean {
  const provider = findProvider(providerId);
  if (!provider) return false;
  const currentRefresh = provider.oauth?.credential?.refresh;
  if (currentRefresh !== expectRefresh) return false;
  const providers = state.settings.providers.map((p): Provider => {
    if (p.id !== providerId) return p;
    if (next === undefined) {
      const rest = { ...p };
      delete rest.oauth;
      return { ...rest, authMode: p.authMode === "oauth" ? "apiKey" : p.authMode };
    }
    return {
      ...p,
      authMode: "oauth" as const,
      enabled: true,
      oauth: {
        flow: p.oauth?.flow ?? "openai-codex",
        credential: next as unknown as Record<string, import("../../foundation/types").JsonValue>,
        signedInAt: p.oauth?.signedInAt ?? Date.now(),
      },
    };
  });
  updateSettings({ ...state.settings, providers });
  return true;
}

export function createPiCredentialStore(): CredentialStore {
  return {
    async read(providerId, options) {
      options?.signal?.throwIfAborted();
      return readCredential(providerId);
    },

    async list() {
      return (state?.settings?.providers ?? [])
        .filter((p) => p.oauth != null)
        .map((p) => ({ providerId: p.id, type: "oauth" as const }));
    },

    async modify(providerId, fn, options) {
      options?.signal?.throwIfAborted();
      return enqueue(providerId, async () => {
        options?.signal?.throwIfAborted();
        const before = readCredential(providerId);
        const expectRefresh = before?.refresh;
        let next: Credential | undefined;
        try {
          next = await fn(before);
        } catch (error) {
          reportError("provider", "warn", `OAuth credential modify failed for ${providerId}`, error, "oauth_modify_failed", { providerId });
          throw error;
        }
        // 回调返回 undefined = 不改动(另一次请求已刷新/已注销),直接返回当前。
        if (next === undefined) return readCredential(providerId);
        const ok = commitCredential(providerId, expectRefresh, next);
        if (!ok) {
          // CAS 失败:行已被并发写改写。返回当前实际凭证,让调用方基于新事实再决策。
          return readCredential(providerId);
        }
        return next;
      });
    },

    async delete(providerId, options) {
      options?.signal?.throwIfAborted();
      return enqueue(providerId, async () => {
        commitCredential(providerId, readCredential(providerId)?.refresh, undefined);
      });
    },
  };
}
