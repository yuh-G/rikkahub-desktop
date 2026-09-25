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

  test("chatCapable:false 的订阅(Claude Pro/Max)在宿主全路径闸门拒绝,人话报错(仅工作区可用)", async () => {
    // 宿主引擎的凭证都经本函数:对话/辅助/图像/连通性测试在此统一拦下。pi 引擎(工作区)
    // 走 createPiCredentialStore,不经过本函数——闸门不能误伤工作区。
    const provider = makeProvider({
      authMode: "oauth",
      oauth: {
        flow: "anthropic",
        signedInAt: 1,
        credential: { type: "oauth", access: "ant-acc", refresh: "ant-ref", expires: Date.now() + 3600_000 },
      },
    });
    setState({ ...state, settings: { ...state.settings, providers: [provider] } } as any);
    try {
      await resolveProviderAuthForProvider(provider);
      throw new Error("expected gate rejection");
    } catch (error) {
      expect((error as Error).message).toContain("仅在工作区可用");
    }
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

  test("凭证进入刷新窗口(<5min):锁内刷新恰好一次,轮换后的 refresh 回写宿主行,后续解析不再刷", async () => {
    // 长对话跨刷新窗口压测(P1 遗留)的单元锁:临期触发一次自动刷新 → 新 access 立即生效
    // → 轮换 refresh 落盘(CAS)→ 凭证新鲜后同一请求链不再刷新(无感继续生成)。
    let refreshCalls = 0;
    overrideOAuthFlow("openai-codex", {
      name: "Test Codex",
      login: async () => {
        throw new Error("not in test");
      },
      refresh: async () => {
        refreshCalls += 1;
        return { type: "oauth", access: `a-${refreshCalls}`, refresh: `r-${refreshCalls}`, expires: Date.now() + 30 * 60_000 };
      },
      toAuth: async (cred) => ({ apiKey: cred.access }),
    });
    const provider = makeProvider({
      authMode: "oauth",
      oauth: { flow: "openai-codex", credential: { type: "oauth", access: "a-old", refresh: "r-old", expires: Date.now() + 60_000 }, signedInAt: 1 },
      apiKey: "",
    });
    setState({ ...state, settings: { ...state.settings, providers: [provider] } } as any);
    const resolved = await resolveProviderAuthForProvider(provider);
    expect(refreshCalls).toBe(1);
    expect(resolved.headers.Authorization).toBe("Bearer a-1");
    expect(state.settings.providers[0]?.oauth?.credential?.refresh).toBe("r-1");
    const again = await resolveProviderAuthForProvider(state.settings.providers[0]);
    expect(refreshCalls).toBe(1);
    expect(again.headers.Authorization).toBe("Bearer a-1");
  });

  test("minOAuthValidityMs 要求更长余量:默认窗口内但余量不足 → 同样触发刷新(读即新鲜语义)", async () => {
    let refreshCalls = 0;
    overrideOAuthFlow("openai-codex", {
      name: "Test Codex",
      login: async () => {
        throw new Error("not in test");
      },
      refresh: async () => {
        refreshCalls += 1;
        return { type: "oauth", access: "a-fresh", refresh: "r-fresh", expires: Date.now() + 30 * 60_000 };
      },
      toAuth: async (cred) => ({ apiKey: cred.access }),
    });
    const provider = makeProvider({
      authMode: "oauth",
      // 距过期 6 分钟:>默认 5min 窗口,<调用方要求的 10min —— 必须刷新。
      oauth: { flow: "openai-codex", credential: { type: "oauth", access: "a-old", refresh: "r-old", expires: Date.now() + 6 * 60_000 }, signedInAt: 1 },
      apiKey: "",
    });
    setState({ ...state, settings: { ...state.settings, providers: [provider] } } as any);
    const resolved = await resolveProviderAuthForProvider(provider, { minOAuthValidityMs: 10 * 60_000 });
    expect(refreshCalls).toBe(1);
    expect(resolved.headers.Authorization).toBe("Bearer a-fresh");
  });
});
