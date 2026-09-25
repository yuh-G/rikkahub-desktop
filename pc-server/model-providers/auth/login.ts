// model-providers/auth/login.ts — 登录编排(方案 §2.4 §4.3)。
// 职责:startLogin / cancelLogin / logout,以及把 pi-ai 的 AuthInteraction 翻译成
// 宿主 SSE 事件(provider_auth)。关键纪律:
//   1. 每个 provider 同时只允许一个登录尝试(attempt 表)。
//   2. 10 分钟总超时(对齐 OAuth 设备码 15min 上限,留余量),超时自动 abort。
//   3. 登录成功 → CAS 写 oauth + authMode=oauth + enabled=true(方案 §4.3 形态 C)。
//   4. 取消/失败 → 不残留半成品 oauth 行。
//   5. 全程凭据不出本模块:access/refresh 不落日志、不进 SSE 载荷。

import type { OAuthCredential, ProviderAuthInteraction } from "../../../pi/packages/ai/src/auth/types.ts";
import { updateSettings } from "../../app-config";
import type { OAuthFlowId, Provider } from "../../foundation/types";
import { reportError } from "../../observability/app-errors";
import { state } from "../../persistence/json-store";
import { bundledModelsFor } from "./catalog";
import { OAUTH_FLOWS, loadOAuthFlow } from "./flows";

export type LoginPhase =
  | "select_method"
  | "waiting_browser"
  | "waiting_device_code"
  | "exchanging"
  | "success"
  | "error"
  | "cancelled";

export interface ProviderAuthEvent {
  providerId: string;
  flow: string;
  phase: LoginPhase;
  /** select_method 时可选的登录方式(id + i18n labelKey)。 */
  methods?: ReadonlyArray<{ id: string; labelKey: string }>;
  /** waiting_browser 时的授权 URL(用户复制到浏览器)。 */
  authUrl?: string;
  /** waiting_device_code 时的验证码/地址/倒计时。 */
  deviceCode?: { userCode: string; verificationUri: string; expiresInSeconds?: number };
  message?: string;
}

type AttemptState = {
  controller: AbortController;
  timeout: ReturnType<typeof setTimeout>;
  /** 挂起的 prompt 的 resolver(取消时统一 reject)。 */
  pendingPrompt?: { reject: (err: Error) => void };
  /** 最近一次广播的事件(取消/结束时不再需要补发)。 */
  lastEvent?: ProviderAuthEvent;
};

// providerId → 进行中的尝试。内存态,不落盘。
const attempts = new Map<string, AttemptState>();

let broadcast: (event: ProviderAuthEvent) => void = () => {};
/** api/sse.ts 注入,把登录进度推给前端三态卡片。 */
export function initProviderAuthBroadcast(fn: (event: ProviderAuthEvent) => void): void {
  broadcast = fn;
}

function emit(event: ProviderAuthEvent, attempt?: AttemptState): void {
  if (attempt) attempt.lastEvent = event;
  try {
    broadcast(event);
  } catch (error) {
    reportError("provider", "warn", "provider_auth broadcast failed", error, "oauth_broadcast_failed");
  }
}

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

function cleanup(providerId: string): void {
  const attempt = attempts.get(providerId);
  if (!attempt) return;
  clearTimeout(attempt.timeout);
  attempts.delete(providerId);
}

function finish(providerId: string, event: ProviderAuthEvent): void {
  const attempt = attempts.get(providerId);
  emit(event, attempt);
  cleanup(providerId);
}

/** 登录成功落盘:写 oauth + authMode=oauth + enabled=true,并在「当前无模型」时铺入捆绑目录。
 *  CAS 由调用方独占(此时 attempt 已独占该 provider 的写通道),直接读-改-写即可。flowId 从
 *  startLogin 显式传入(它已做过"oauth 行 → 登记表"的判定),这里不再推断、不落兜底值。 */
function commitLogin(providerId: string, flowId: OAuthFlowId, credential: OAuthCredential): boolean {
  const provider = state.settings.providers.find((p) => p.id === providerId);
  if (!provider) return false;
  // 仅在「当前无模型」时铺捆绑目录——用户若已手动加过模型,不覆盖其裁剪结果。
  const bundled = provider.models.length > 0 ? provider.models : bundledModelsFor(flowId);
  const providers = state.settings.providers.map((p): Provider =>
    p.id === providerId
      ? {
          ...p,
          authMode: "oauth" as const,
          enabled: true,
          models: bundled,
          oauth: {
            flow: flowId,
            credential: credential as unknown as Record<string, import("../../foundation/types").JsonValue>,
            signedInAt: Date.now(),
          },
        }
      : p,
  );
  updateSettings({ ...state.settings, providers });
  return true;
}

/** 登出:剥 oauth + authMode 回 apiKey + enabled 回落 false。 */
export function logoutProvider(providerId: string): boolean {
  const provider = state.settings.providers.find((p) => p.id === providerId);
  if (!provider?.oauth) return false;
  // 若有进行中的登录尝试,先取消。
  cancelLogin(providerId);
  const providers = state.settings.providers.map((p): Provider => {
    if (p.id !== providerId) return p;
    const rest = { ...p };
    delete rest.oauth;
    return { ...rest, authMode: "apiKey" as const, enabled: false };
  });
  updateSettings({ ...state.settings, providers });
  return true;
}

export function cancelLogin(providerId: string): void {
  const attempt = attempts.get(providerId);
  if (!attempt) return;
  attempt.pendingPrompt?.reject(new Error("Login cancelled"));
  attempt.controller.abort();
  finish(providerId, { providerId, flow: flowOf(providerId), phase: "cancelled", message: "已取消登录" });
}

function flowOf(providerId: string): string {
  return state.settings.providers.find((p) => p.id === providerId)?.oauth?.flow ?? "";
}

/** 登录流程的 AuthInteraction 实现:把 pi 的 prompt/notify 翻译成 SSE 事件。 */
function makeInteraction(providerId: string, flow: string, attempt: AttemptState): ProviderAuthInteraction {
  return {
    signal: attempt.controller.signal,
    notify(event) {
      const base = { providerId, flow };
      if (event.type === "auth_url") {
        emit({ ...base, phase: "waiting_browser", authUrl: event.url, message: event.instructions }, attempt);
      } else if (event.type === "device_code") {
        emit(
          {
            ...base,
            phase: "waiting_device_code",
            deviceCode: {
              userCode: event.userCode,
              verificationUri: event.verificationUri,
              expiresInSeconds: event.expiresInSeconds,
            },
          },
          attempt,
        );
      } else if (event.type === "progress" || event.type === "info") {
        emit({ ...base, phase: "exchanging", message: event.message }, attempt);
      }
    },
    prompt(prompt) {
      if (attempt.controller.signal.aborted) return Promise.reject(new Error("Login cancelled"));
      if (prompt.type === "select") {
        // select 是登录方式选择:把选项广播出去,等前端经 manual-code 端点回传 id。
        const meta = OAUTH_FLOWS[flow as keyof typeof OAUTH_FLOWS];
        emit(
          {
            providerId,
            flow,
            phase: "select_method",
            methods: meta?.loginMethods ?? prompt.options.map((o) => ({ id: o.id, labelKey: o.label })),
            message: prompt.message,
          },
          attempt,
        );
      } else if (prompt.type === "manual_code") {
        emit({ providerId, flow, phase: "waiting_browser", message: prompt.message }, attempt);
      }
      return new Promise<string>((resolve, reject) => {
        attempt.pendingPrompt = { reject };
        // manual-code 端点会调 resumePrompt 注入用户输入。
        pendingPromptResolvers.set(providerId, resolve);
        prompt.signal?.addEventListener("abort", () => {
          pendingPromptResolvers.delete(providerId);
          reject(new Error("Login cancelled"));
        });
      });
    },
  };
}

// manual-code 端点注入用户输入的通道。providerId → prompt resolver。
const pendingPromptResolvers = new Map<string, (value: string) => void>();

/** 前端回传登录方式选择或手动粘贴的授权码/重定向 URL。 */
export function resumePrompt(providerId: string, input: string): boolean {
  const resolve = pendingPromptResolvers.get(providerId);
  if (!resolve) return false;
  pendingPromptResolvers.delete(providerId);
  resolve(input);
  return true;
}

/** 预置订阅供应商的固定 id(与 model-providers/index.ts 的 OAUTH_PROVIDER_IDS 对齐)。
 *  未登录的预置供应商(无 oauth 行)用它反查 flow——固定 UUID 一经发布不可变,比
 *  按 baseUrl host 嗅探稳。 */
const PRESET_OAUTH_PROVIDER_IDS: Readonly<Record<string, string>> = {
  "98d0557b-0700-41e5-b1d6-ee875a53ae5a": "openai-codex", // ChatGPT
  "f9622c8b-5037-4540-b875-3d301521367b": "kimi-coding", // Kimi Code
};

function inferFlowForProvider(provider: Provider): OAuthFlowId | undefined {
  return PRESET_OAUTH_PROVIDER_IDS[provider.id] as OAuthFlowId | undefined;
}

export async function startLogin(providerId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const provider = state.settings.providers.find((p) => p.id === providerId);
  if (!provider) return { ok: false, error: "provider not found" };
  if (provider.authMode !== "oauth") return { ok: false, error: "provider is not an OAuth provider" };
  if (attempts.has(providerId)) return { ok: false, error: "login already in progress" };

  // flow 判定:已登录的行存了 oauth.flow;未登录的订阅供应商(预置 ChatGPT/Kimi Code)
  // 没有 oauth 行,从预置固定 id 反查(inferFlowForProvider)。
  const flowId = provider.oauth?.flow ?? inferFlowForProvider(provider);
  if (!flowId || !OAUTH_FLOWS[flowId]) return { ok: false, error: "unknown OAuth flow" };

  const controller = new AbortController();
  const attempt: AttemptState = {
    controller,
    timeout: setTimeout(() => {
      cancelLogin(providerId);
    }, LOGIN_TIMEOUT_MS),
  };
  attempts.set(providerId, attempt);

  try {
    const flow = OAUTH_FLOWS[flowId];
    const oauth = await loadOAuthFlow(flowId);
    emit({ providerId, flow: flowId, phase: "select_method", methods: flow.loginMethods ?? undefined, message: oauth.loginLabel ?? oauth.name }, attempt);

    const credential = await oauth.login(makeInteraction(providerId, flowId, attempt));
    if (controller.signal.aborted) return { ok: false, error: "cancelled" };
    const ok = commitLogin(providerId, flowId, credential);
    if (!ok) {
      finish(providerId, { providerId, flow: flowId, phase: "error", message: "登录成功但凭据落盘失败,请重试" });
      return { ok: false, error: "commit failed" };
    }
    finish(providerId, { providerId, flow: flowId, phase: "success", message: "登录成功" });
    return { ok: true };
  } catch (error) {
    const cancelled = controller.signal.aborted || (error instanceof Error && /cancelled/i.test(error.message));
    const message = cancelled ? "已取消登录" : error instanceof Error ? error.message : String(error);
    if (!cancelled) {
      reportError("provider", "warn", `OAuth login failed for ${providerId}`, error, "oauth_login_failed", { providerId, flow: flowId });
    }
    finish(providerId, { providerId, flow: flowId, phase: cancelled ? "cancelled" : "error", message });
    return { ok: false, error: message };
  }
}

/** 查询当前是否有进行中的登录尝试(前端恢复连接时对齐状态)。 */
export function loginInProgress(providerId: string): boolean {
  return attempts.has(providerId);
}
