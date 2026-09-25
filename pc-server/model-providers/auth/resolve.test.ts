// model-providers/auth/resolve.test.ts — 锁 resolveProviderAuthForProvider 的双轨语义。
// apiKey 轨:逐字节对齐 providerHeaders()(不引入任何新口径);oauth 轨:走 pi-ai
// resolveProviderAuth(读-改-写锁内刷新)+ toAuth 归一成 headers/baseUrl。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveProviderAuthForProvider } from "./resolve";
import { overrideOAuthFlow } from "./flows";
import { setState, state } from "../../persistence/json-store";
import { defaultSettings } from "../../app-config/defaults";
import type { Provider } from "../../foundation/types";

function makeProvider(overrides: Partial<Provider>): Provider {
  return {
    id: "p1",
    type: "openai",
    enabled: true,
    name: "Test",
    builtIn: false,
    shortDescription: "",
    description: "",
    apiKey: "sk-test",
    baseUrl: "https://api.example.com",
    models: [],
    balanceOption: { enabled: false, apiPath: "", resultPath: "" },
    ...overrides,
  } as Provider;
}

describe("resolveProviderAuthForProvider", () => {
  beforeEach(() => setState({ settings: structuredClone(defaultSettings()) } as any));
  afterEach(() => setState({ ...state, settings: { ...state.settings, providers: [] } } as any));

  test("apiKey provider: headers identical to providerHeaders()", async () => {
    const provider = makeProvider({ authMode: "apiKey", apiKey: "sk-live" });
    setState({ ...state, settings: { ...state.settings, providers: [provider] } } as any);
    const resolved = await resolveProviderAuthForProvider(provider);
    expect(resolved.headers).toEqual({ Authorization: "Bearer sk-live" });
    expect(resolved.baseUrl).toBeUndefined();
  });

  test("claude apiKey provider: x-api-key + anthropic-version", async () => {
    const provider = makeProvider({ type: "claude", authMode: "apiKey", apiKey: "sk-ant" });
    setState({ ...state, settings: { ...state.settings, providers: [provider] } } as any);
    const resolved = await resolveProviderAuthForProvider(provider);
    expect(resolved.headers).toEqual({ "x-api-key": "sk-ant", "anthropic-version": "2023-06-01" });
  });

  test("oauth provider with credential: resolves via pi-ai (toAuth 不触网)", async () => {
    // 注入假 toAuth——真实 openai-codex 的 toAuth 会解码 JWT 提 accountId,不触网;
    // 但为防未来 pi 实现变化引入网络依赖,这里显式替身,测试锁定「解析归一」语义。
    overrideOAuthFlow("openai-codex", {
      name: "Test Codex",
      login: async () => { throw new Error("not in test"); },
      refresh: async () => { throw new Error("not in test"); },
      toAuth: async (cred) => ({ apiKey: cred.access }),
    });
    const provider = makeProvider({
      authMode: "oauth",
      oauth: {
        flow: "openai-codex",
        credential: { type: "oauth", access: "a", refresh: "r", expires: 9999999999000 },
        signedInAt: 1,
      },
      apiKey: "",
    });
    setState({ ...state, settings: { ...state.settings, providers: [provider] } } as any);
    const resolved = await resolveProviderAuthForProvider(provider);
    expect(resolved.headers.Authorization).toBe("Bearer a");
  });

  test("oauth provider without credential row in state: throws", async () => {
    // authMode=oauth 但 state.providers 里找不到该 provider(或行内无 oauth)→
    // readCredential 返回 undefined,resolveProviderAuth 回落 ambient(空)→ undefined → 抛。
    const provider = makeProvider({
      authMode: "oauth",
      oauth: { flow: "openai-codex", credential: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60000 }, signedInAt: 1 },
      apiKey: "",
    });
    // 不把 provider 放进 state —— readCredential 找不到行。
    await expect(resolveProviderAuthForProvider(provider)).rejects.toThrow();
  });

  test("oauth provider with unknown flow: throws", async () => {
    const provider = makeProvider({
      authMode: "oauth",
      oauth: { flow: "unknown-flow" as any, credential: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60000 }, signedInAt: 1 },
      apiKey: "",
    });
    setState({ ...state, settings: { ...state.settings, providers: [provider] } } as any);
    await expect(resolveProviderAuthForProvider(provider)).rejects.toThrow("not registered");
  });
});
