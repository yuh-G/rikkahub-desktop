// model-providers/auth/login.test.ts — 锁登录编排状态机(方案 §2.4 §4.3)。
// 关键不变量:
//   1. 每 provider 同时只允许一个登录尝试;
//   2. 成功 → 写 oauth(带 flowId)+ authMode=oauth + enabled=true,广播 success;
//   3. 取消 → 广播 cancelled,不写 oauth;
//   4. 失败 → 广播 error,不写 oauth;
//   5. 登出 → 剥 oauth + authMode=apiKey + enabled=false。
// seed 对齐真实预置(固定 UUID + authMode:"oauth"),因为 startLogin 的 flow 判定走
// PRESET_OAUTH_PROVIDER_IDS(id → flow),不是按 host 嗅探。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cancelLogin, initProviderAuthBroadcast, loginInProgress, logoutProvider, startLogin, type ProviderAuthEvent } from "./login";
import { clearOAuthFlowOverride, overrideOAuthFlow } from "./flows";
import { setState, state } from "../../persistence/json-store";
import { defaultSettings } from "../../app-config/defaults";
import type { Provider } from "../../foundation/types";

// 预置 ChatGPT(Codex 订阅)行的固定 id,见 model-providers/index.ts OAUTH_PROVIDER_IDS。
const CODEX_PROVIDER_ID = "98d0557b-0700-41e5-b1d6-ee875a53ae5a";

function seedOAuthProvider(): void {
  const provider: Provider = {
    id: CODEX_PROVIDER_ID,
    type: "openai",
    enabled: false,
    name: "ChatGPT",
    builtIn: true,
    shortDescription: "",
    description: "",
    apiKey: "",
    authMode: "oauth",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    useResponseApi: true,
    models: [],
    balanceOption: { enabled: false, apiPath: "", resultPath: "" },
  } as Provider;
  setState({ ...state, settings: { ...state.settings, providers: [...state.settings.providers, provider] } } as any);
}

describe("login orchestration", () => {
  const events: ProviderAuthEvent[] = [];
  beforeEach(() => {
    setState({ settings: structuredClone(defaultSettings()) } as any);
    seedOAuthProvider();
    events.length = 0;
    initProviderAuthBroadcast((e) => events.push(e));
    // 清掉前一个测试可能注入的 flow 替身,防真实实现触网。
    clearOAuthFlowOverride("openai-codex");
  });
  afterEach(() => setState({ ...state, settings: { ...state.settings, providers: [] } } as any));

  test("startLogin on non-existent provider returns error", async () => {
    const result = await startLogin("nonexistent");
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("not found");
  });

  test("startLogin on apiKey provider returns error", async () => {
    const apiKeyProvider = { ...state.settings.providers.find((p) => p.id === CODEX_PROVIDER_ID)!, authMode: "apiKey" as const };
    setState({ ...state, settings: { ...state.settings, providers: [apiKeyProvider] } } as any);
    const result = await startLogin(CODEX_PROVIDER_ID);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("not an OAuth");
  });

  test("cancelLogin on idle provider is a no-op", () => {
    cancelLogin(CODEX_PROVIDER_ID);
    expect(events.filter((e) => e.providerId === CODEX_PROVIDER_ID)).toHaveLength(0);
  });

  test("logoutProvider strips oauth and resets authMode/enabled", async () => {
    // 先手动种一个已登录的 oauth 行
    const providers = state.settings.providers.map((p) =>
      p.id === CODEX_PROVIDER_ID
        ? {
            ...p,
            authMode: "oauth" as const,
            enabled: true,
            oauth: { flow: "openai-codex" as const, credential: { type: "oauth", access: "a", refresh: "r", expires: 9999999999000 }, signedInAt: 1 },
          }
        : p,
    );
    setState({ ...state, settings: { ...state.settings, providers } } as any);
    const ok = logoutProvider(CODEX_PROVIDER_ID);
    expect(ok).toBe(true);
    const provider = state.settings.providers.find((p) => p.id === CODEX_PROVIDER_ID);
    expect(provider?.oauth).toBeUndefined();
    expect(provider?.authMode).toBe("apiKey");
    expect(provider?.enabled).toBe(false);
  });

  test("logoutProvider on non-oauth provider returns false", () => {
    expect(logoutProvider(CODEX_PROVIDER_ID)).toBe(false);
  });

  test("successful login commits oauth with the resolved flowId and bundles catalog models", async () => {
    overrideOAuthFlow("openai-codex", {
      name: "Test Codex",
      login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 9999999999000 }),
      refresh: async () => { throw new Error("not in test"); },
      toAuth: async (cred) => ({ apiKey: cred.access }),
    });
    const result = await startLogin(CODEX_PROVIDER_ID);
    expect(result.ok).toBe(true);
    const provider = state.settings.providers.find((p) => p.id === CODEX_PROVIDER_ID);
    // 关键断言:flow 必须由 startLogin 判定后传入,不能落硬编码兜底(否则 Kimi 首登会被错标)。
    expect(provider?.oauth?.flow).toBe("openai-codex");
    expect(provider?.authMode).toBe("oauth");
    expect(provider?.enabled).toBe(true);
    // 捆绑目录:登录成功后 models 非空(pi data JSON 存在),且每条都有 modelId/displayName。
    expect(provider?.models.length).toBeGreaterThan(0);
    expect(provider?.models[0]?.modelId).toBeTruthy();
    expect(provider?.models[0]?.displayName).toBeTruthy();
    expect(events.some((e) => e.phase === "success")).toBe(true);
  });

  test("loginInProgress reflects attempt state and cancel finishes it", async () => {
    expect(loginInProgress(CODEX_PROVIDER_ID)).toBe(false);
    // 注入一个挂起的 login(永不 resolve,模拟用户未操作)。
    // 先查 signal.aborted 再挂监听:取消可能发生在 loadOAuthFlow 期间(此时监听尚未挂),
    // 对已中止的信号挂 abort 监听永不触发——那样 promise 不会 settle、测试会挂死。
    overrideOAuthFlow("openai-codex", {
      name: "Test",
      login: async (interaction) => {
        if (interaction.signal.aborted) throw new Error("Login cancelled");
        await new Promise((_, reject) => interaction.signal.addEventListener("abort", () => reject(new Error("Login cancelled"))));
        throw new Error("unreachable");
      },
      refresh: async () => { throw new Error("not in test"); },
      toAuth: async (cred) => ({ apiKey: cred.access }),
    });
    const promise = startLogin(CODEX_PROVIDER_ID);
    // startLogin 同步注册 attempt(attempts.set 在第一个 await 之前),inProgress 立即为 true。
    expect(loginInProgress(CODEX_PROVIDER_ID)).toBe(true);
    cancelLogin(CODEX_PROVIDER_ID);
    await promise;
    expect(loginInProgress(CODEX_PROVIDER_ID)).toBe(false);
    expect(events.some((e) => e.phase === "cancelled")).toBe(true);
  });
});
