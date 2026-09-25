// model-providers/auth/credential-store.test.ts — 锁 pi CredentialStore 在宿主 state 上的行为。
// 关键不变量(方案 §2.4):
//   1. 同一 provider 的 modify 串行化(并发刷新不双刷被轮换的 refresh token);
//   2. CAS:mutate 期间 refresh 被别处改写 → 本次写丢弃,返回当前实际凭证;
//   3. delete 剥 oauth,authMode 保持 oauth(订阅供应商 OAuth-only 形态),enabled 不动;
//   4. read/list 只读,不改 state。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPiCredentialStore } from "./credential-store";
import { setState, state } from "../../persistence/json-store";
import { updateSettings } from "../../app-config";
import { defaultSettings } from "../../app-config/defaults";
import type { Provider } from "../../foundation/types";

function seedProvider(id: string, refresh: string): void {
  const provider: Provider = {
    id,
    type: "openai",
    enabled: true,
    name: id,
    builtIn: false,
    shortDescription: "",
    description: "",
    apiKey: "",
    authMode: "oauth",
    oauth: { flow: "openai-codex", credential: { type: "oauth", access: "a", refresh, expires: Date.now() + 60000 }, signedInAt: 1 },
    baseUrl: "",
    models: [],
    balanceOption: { enabled: false, apiPath: "", resultPath: "" },
  };
  // 直接 setState 而非 updateSettings:后者会经 normalizeState 回填预置供应商,
  // 覆盖测试想注入的精简 providers 列表。
  setState({ ...state, settings: { ...state.settings, providers: [...state.settings.providers, provider] } } as any);
}

function currentRefresh(id: string): string | undefined {
  return state.settings.providers.find((p) => p.id === id)?.oauth?.credential?.refresh as string | undefined;
}

describe("pi credential store", () => {
  beforeEach(() => {
    setState({ settings: structuredClone(defaultSettings()) } as any);
    seedProvider("p1", "r0");
  });
  afterEach(() => setState({ ...state, settings: { ...state.settings, providers: [] } } as any));

  test("read returns the stored credential", async () => {
    const store = createPiCredentialStore();
    const cred = await store.read("p1");
    expect(cred?.refresh).toBe("r0");
  });

  test("modify serializes concurrent mutations", async () => {
    const store = createPiCredentialStore();
    const order: string[] = [];
    const [a, b] = await Promise.all([
      store.modify("p1", async (cur) => {
        order.push(`a-enter:${cur?.refresh}`);
        await new Promise((r) => setTimeout(r, 30));
        return { type: "oauth", access: "a1", refresh: "r1", expires: Date.now() + 60000 };
      }),
      store.modify("p1", async (cur) => {
        order.push(`b-enter:${cur?.refresh}`);
        return { type: "oauth", access: "a2", refresh: "r2", expires: Date.now() + 60000 };
      }),
    ]);
    // 串行化:b 看到的是 a 写入后的 r1,而不是 r0。
    expect(order).toEqual(["a-enter:r0", "b-enter:r1"]);
    expect(currentRefresh("p1")).toBe("r2");
    expect(a?.refresh).toBe("r1");
    expect(b?.refresh).toBe("r2");
  });

  test("modify CAS: concurrent refresh change discards the write", async () => {
    const store = createPiCredentialStore();
    // mutate 期间外部把 refresh 改成 rX(模拟另一通道登录/注销),CAS 应丢弃本次写。
    const result = await store.modify("p1", async () => {
      updateSettings({
        ...state.settings,
        providers: state.settings.providers.map((p) =>
          p.id === "p1" ? { ...p, oauth: { ...p.oauth!, credential: { type: "oauth", access: "ax", refresh: "rX", expires: 1 } } } : p,
        ),
      });
      return { type: "oauth", access: "a1", refresh: "r1", expires: Date.now() + 60000 };
    });
    // 返回的是当前实际凭证(rX),不是被丢弃的 r1。
    expect(result?.refresh).toBe("rX");
    expect(currentRefresh("p1")).toBe("rX");
  });

  test("delete strips oauth but keeps the subscription shape (authMode=oauth)", async () => {
    const store = createPiCredentialStore();
    await store.delete("p1");
    const provider = state.settings.providers.find((p) => p.id === "p1");
    expect(provider?.oauth).toBeUndefined();
    // 与 logoutProvider 同口径:登出 ≠ 变成 API Key 供应商。
    expect(provider?.authMode).toBe("oauth");
    expect(provider?.enabled).toBe(true); // delete 不动 enabled(由调用方决定)
  });

  test("list enumerates oauth providers under their pi provider id (same key space as read/modify)", async () => {
    seedProvider("p2", "r2");
    const store = createPiCredentialStore();
    const list = await store.list();
    // seed 的两行都是 openai-codex flow → 都以 pi id 上报(宿主 UUID 不是 pi 认识的键)。
    expect(list.map((e) => e.providerId)).toEqual(["openai-codex", "openai-codex"]);
    expect(list.every((e) => e.type === "oauth")).toBe(true);
  });

  test("read on missing provider resolves undefined", async () => {
    const store = createPiCredentialStore();
    expect(await store.read("nonexistent")).toBeUndefined();
  });

  test("pi provider id 反查:刷新回写落到宿主行(宿主 id ≠ pi id 时不丢刷新)", async () => {
    // 预置订阅供应商的真实形态:state 行 id 是宿主固定 UUID,而 pi 侧 resolveProviderAuth /
    // Models.getAuth 以 pi 内置 id("openai-codex")为键。modify 的 CAS 必须锁「反查到的
    // 那行的宿主 id」,否则刷新后的新 refresh token 因 p.id !== piId 失配而永远落不了盘。
    const HOST_UUID = "98d0557b-0700-41e5-b1d6-ee875a53ae5a";
    // 重置为只有这一个宿主行(去掉 beforeEach 的 "p1" 占位)。
    setState({ ...state, settings: { ...state.settings, providers: [] } } as any);
    seedProvider(HOST_UUID, "r-old");
    const store = createPiCredentialStore();
    // 以 pi 内置 id 为键做读-改-写(模拟 resolve.ts 的 resolveProviderAuth 调用)。
    const next = await store.modify("openai-codex", async (cur) => {
      expect(cur?.refresh).toBe("r-old"); // 反查读到了宿主行的旧凭证
      return { type: "oauth", access: "a-new", refresh: "r-new", expires: 9999999999000 };
    });
    expect(next?.refresh).toBe("r-new");
    // 关键断言:宿主行的凭证被实际更新(回写命中,不是返回了新值但 state 仍旧)。
    expect(currentRefresh(HOST_UUID)).toBe("r-new");
    // 再以 pi id 读,应读到回写后的新凭证。
    expect((await store.read("openai-codex"))?.refresh).toBe("r-new");
  });
});
