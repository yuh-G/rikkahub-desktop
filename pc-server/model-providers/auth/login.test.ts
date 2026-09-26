// model-providers/auth/login.test.ts — 锁登录编排状态机(方案 §2.4 §4.3)。
// 关键不变量:
//   1. 每 provider 同时只允许一个登录尝试;
//   2. 成功 → 写 oauth(带 flowId)+ authMode=oauth + enabled=true,广播 success;
//   3. 取消 → 广播 cancelled,不写 oauth;
//   4. 失败 → 广播 error,不写 oauth;
//   5. 登出 → 剥 oauth + enabled=false;authMode 保持 oauth(订阅供应商是 OAuth-only 形态);
//   6. startLogin 不等授权流跑完就返回(HTTP 层不能挂着等用户操作),终局经 completion/SSE。
// seed 对齐真实预置(固定 UUID + authMode:"oauth"),因为 startLogin 的 flow 判定走
// oauthFlowFor(flows.ts 的 presetProviderId 反查),不是按 host 嗅探。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cancelLogin, currentLoginEvent, initProviderAuthBroadcast, loginInProgress, logoutProvider, resumePrompt, startLogin, type ProviderAuthEvent } from "./login";
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

  test("logoutProvider strips oauth, disables, and keeps the subscription shape (authMode=oauth)", async () => {
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
    // 登出 ≠ 变成 API Key 供应商:形态不变,前端仍渲染订阅卡片、startLogin 仍可再登录。
    expect(provider?.authMode).toBe("oauth");
    expect(provider?.enabled).toBe(false);
  });

  test("logoutProvider also clears a stale persisted oauthStatus view (legacy POST write-back)", () => {
    // 旧版 settings/provider POST 把前端回传的派生视图落进了 state:oauth 已无、oauthStatus 还在
    // ——正是「退出登录后卡片仍显示已登录」的数据形态。登出必须能清掉它。
    const providers = state.settings.providers.map((p) =>
      p.id === CODEX_PROVIDER_ID
        ? { ...p, authMode: "oauth" as const, enabled: false, oauthStatus: { signedIn: true, flow: "openai-codex", signedInAt: 1 } }
        : p,
    );
    setState({ ...state, settings: { ...state.settings, providers } } as any);
    expect(logoutProvider(CODEX_PROVIDER_ID)).toBe(true);
    const provider = state.settings.providers.find((p) => p.id === CODEX_PROVIDER_ID) as Record<string, unknown> | undefined;
    expect(provider?.oauthStatus).toBeUndefined();
    expect(provider?.oauth).toBeUndefined();
    expect(provider?.authMode).toBe("oauth");
  });

  test("logoutProvider on a signed-out provider returns false", () => {
    expect(logoutProvider(CODEX_PROVIDER_ID)).toBe(false);
  });

  test("startLogin 登记即补「准备中」帧:flow 加载/首个 notify 之前刷新页面也能恢复面板", async () => {
    // Kimi/Copilot/xAI 三条流在 loadOAuthFlow 之后、首个 notify 之前要发网络请求(拿设备码/
    // 授权 URL)。若这窗口里用户刷新页面,GET oauth/status 曾回 inProgress:true + event:null,
    // 前端拿不到可渲染的帧 → 只剩被「已在登录中」拒绝的按钮、连取消都点不到。登记 attempt
    // 后必须先有一帧可恢复的兜底帧。
    overrideOAuthFlow("openai-codex", {
      name: "Test",
      login: async (interaction) => {
        // 模拟 pi 在 notify 之前发网络请求:先 await,再 notify。
        await new Promise((resolve) => setTimeout(resolve, 5));
        interaction.notify({ type: "auth_url", url: "https://example.com/auth", instructions: "" });
        return { type: "oauth", access: "a", refresh: "r", expires: 9999999999000 };
      },
      refresh: async () => { throw new Error("not in test"); },
      toAuth: async (cred) => ({ apiKey: cred.access }),
    });
    const result = await startLogin(CODEX_PROVIDER_ID);
    if (!result.ok) throw new Error(result.error);
    // startLogin 一返回(异步授权流刚起步、真实帧尚未到):仍有可渲染的兜底帧,非 null。
    expect(loginInProgress(CODEX_PROVIDER_ID)).toBe(true);
    const frame = currentLoginEvent(CODEX_PROVIDER_ID);
    expect(frame).not.toBeNull();
    expect(["exchanging", "waiting_browser"]).toContain(frame!.phase);
    await result.completion;
  });

  test("startLogin returns before the flow completes; completion resolves with the outcome", async () => {
    // 授权流卡在「等用户」:startLogin 必须先返回(否则 oauth/start 请求挂到 ky 超时,
    // 前端按钮锁在 submitting——ChatGPT 选登录方式的两个按钮点不动就是这么来的)。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    overrideOAuthFlow("openai-codex", {
      name: "Test",
      login: async (interaction) => {
        interaction.notify({ type: "auth_url", url: "https://example.com/auth", instructions: "" });
        await gate;
        return { type: "oauth", access: "a", refresh: "r", expires: 9999999999000 };
      },
      refresh: async () => { throw new Error("not in test"); },
      toAuth: async (cred) => ({ apiKey: cred.access }),
    });
    const result = await startLogin(CODEX_PROVIDER_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // 已返回但流程仍在跑:attempt 存活、凭证未落盘、最近一帧可查(刷新页面后面板靠它恢复)。
    expect(loginInProgress(CODEX_PROVIDER_ID)).toBe(true);
    expect(state.settings.providers.find((p) => p.id === CODEX_PROVIDER_ID)?.oauth).toBeUndefined();
    expect(currentLoginEvent(CODEX_PROVIDER_ID)?.phase).toBe("waiting_browser");
    release();
    const outcome = await result.completion;
    expect(outcome.ok).toBe(true);
    expect(loginInProgress(CODEX_PROVIDER_ID)).toBe(false);
    expect(currentLoginEvent(CODEX_PROVIDER_ID)).toBeNull();
    expect(state.settings.providers.find((p) => p.id === CODEX_PROVIDER_ID)?.oauth?.flow).toBe("openai-codex");
  });

  test("cancel then immediately restart: the old flow's late teardown must not kill the new attempt", async () => {
    // 授权流在后台异步收尾:旧流程收到 abort 后要过几个 tick 才 reject。若这期间用户已重新
    // 点了登录,旧流程的终局不能把表里的新尝试删掉(否则新流程在跑、状态却显示空闲)。
    let rejectOld!: (err: Error) => void;
    let calls = 0;
    overrideOAuthFlow("openai-codex", {
      name: "Test",
      login: async (interaction) => {
        calls += 1;
        if (calls === 1) {
          // 旧流程:不立即响应 abort,等测试手动 reject(模拟迟到的收尾)。
          return new Promise((_, reject) => { rejectOld = reject; });
        }
        await new Promise((_, reject) => interaction.signal.addEventListener("abort", () => reject(new Error("Login cancelled"))));
        throw new Error("unreachable");
      },
      refresh: async () => { throw new Error("not in test"); },
      toAuth: async (cred) => ({ apiKey: cred.access }),
    });
    const first = await startLogin(CODEX_PROVIDER_ID);
    if (!first.ok) throw new Error(first.error);
    cancelLogin(CODEX_PROVIDER_ID);
    const second = await startLogin(CODEX_PROVIDER_ID);
    expect(second.ok).toBe(true);
    expect(loginInProgress(CODEX_PROVIDER_ID)).toBe(true);
    // 旧流程此时才 reject(controller 已 abort → 判为 cancelled)。
    rejectOld(new Error("Login cancelled"));
    expect((await first.completion).ok).toBe(false);
    // 新尝试仍活着,没有被旧流程的收尾误删。
    expect(loginInProgress(CODEX_PROVIDER_ID)).toBe(true);
    cancelLogin(CODEX_PROVIDER_ID);
    if (second.ok) await second.completion;
    expect(loginInProgress(CODEX_PROVIDER_ID)).toBe(false);
  });

  test("browser flow: manual_code prompt frame keeps the authUrl from the preceding auth_url notify", async () => {
    // pi 的浏览器流是 notify(auth_url) 紧接 prompt(manual_code)。前端整帧替换 authEvent,
    // 第二帧若丢了 authUrl,「打开浏览器 / 复制链接 / 手贴授权码」整块会消失只剩转圈。
    overrideOAuthFlow("openai-codex", {
      name: "Test",
      login: async (interaction) => {
        interaction.notify({ type: "auth_url", url: "https://auth.example/login", instructions: "" });
        const input = await interaction.prompt({ type: "manual_code", message: "paste code", placeholder: "" });
        return { type: "oauth", access: input, refresh: "r", expires: 9999999999000 };
      },
      refresh: async () => { throw new Error("not in test"); },
      toAuth: async (cred) => ({ apiKey: cred.access }),
    });
    const result = await startLogin(CODEX_PROVIDER_ID);
    if (!result.ok) throw new Error(result.error);
    // 两帧都是 waiting_browser,且第二帧(manual_code 提示)仍带 authUrl。
    const frames = events.filter((e) => e.providerId === CODEX_PROVIDER_ID && e.phase === "waiting_browser");
    expect(frames).toHaveLength(2);
    expect(frames[0].authUrl).toBe("https://auth.example/login");
    expect(frames[1].authUrl).toBe("https://auth.example/login");
    expect(frames[1].message).toBe("paste code");
    // 刷新后面板靠最近一帧恢复,同样得有 authUrl。
    expect(currentLoginEvent(CODEX_PROVIDER_ID)?.authUrl).toBe("https://auth.example/login");
    // 手贴授权码经 resumePrompt 注入,流程走到成功。
    expect(resumePrompt(CODEX_PROVIDER_ID, "code-123")).toBe(true);
    expect((await result.completion).ok).toBe(true);
    expect(state.settings.providers.find((p) => p.id === CODEX_PROVIDER_ID)?.oauth?.credential?.access).toBe("code-123");
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
    if (!result.ok) throw new Error("unreachable");
    expect((await result.completion).ok).toBe(true);
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

  test("text prompt (Copilot enterprise domain): waiting_input frame with placeholder, answered via resumePrompt", async () => {
    overrideOAuthFlow("openai-codex", {
      name: "Test",
      login: async (interaction) => {
        const domain = await interaction.prompt({ type: "text", message: "GitHub Enterprise URL", placeholder: "company.ghe.com" });
        return { type: "oauth", access: `token-for:${domain || "github.com"}`, refresh: "r", expires: 9999999999000 };
      },
      refresh: async () => {
        throw new Error("not in test");
      },
      toAuth: async (cred) => ({ apiKey: cred.access }),
    });
    const result = await startLogin(CODEX_PROVIDER_ID);
    if (!result.ok) throw new Error(result.error);
    const frame = events.find((e) => e.phase === "waiting_input");
    expect(frame?.message).toBe("GitHub Enterprise URL");
    expect(frame?.placeholder).toBe("company.ghe.com");
    // 空串回传 = 用户留空用 github.com(pi 流程对空串的语义),不能被当成"没有输入"拒收。
    expect(resumePrompt(CODEX_PROVIDER_ID, "")).toBe(true);
    expect((await result.completion).ok).toBe(true);
    expect(state.settings.providers.find((p) => p.id === CODEX_PROVIDER_ID)?.oauth?.credential?.access).toBe("token-for:github.com");
  });

  test("device_code frame: autoOpenUrl only for flows with deviceCodeAutoOpen in the registry", async () => {
    // Kimi/xAI 的设备码 verificationUri 已是带 user_code 的免输入完整链接(pi 实现把
    // verification_uri_complete 折叠了进去),前端可自动拉起;Copilot/ChatGPT 设备码是裸地址,
    // 自动打开只会把用户带到还要手抄验证码的输入页。autoOpenUrl 由登记表单点裁决。
    const KIMI_PROVIDER_ID = "f9622c8b-5037-4540-b875-3d301521367b";
    const kimiProvider = { ...state.settings.providers.find((p) => p.id === CODEX_PROVIDER_ID)!, id: KIMI_PROVIDER_ID, name: "Kimi Code" };
    setState({ ...state, settings: { ...state.settings, providers: [...state.settings.providers, kimiProvider] } } as any);
    const hangOnDeviceCode = async (interaction: any) => {
      interaction.notify({ type: "device_code", userCode: "ABCD-EFGH", verificationUri: "https://auth.example/device?user_code=ABCD-EFGH", intervalSeconds: 5, expiresInSeconds: 900 });
      await new Promise((_, reject) => interaction.signal.addEventListener("abort", () => reject(new Error("Login cancelled"))));
      throw new Error("unreachable");
    };
    try {
      overrideOAuthFlow("kimi-coding", { name: "Kimi", login: hangOnDeviceCode, refresh: async () => { throw new Error("not in test"); }, toAuth: async (cred) => ({ apiKey: cred.access }) });
      overrideOAuthFlow("openai-codex", { name: "Codex", login: hangOnDeviceCode, refresh: async () => { throw new Error("not in test"); }, toAuth: async (cred) => ({ apiKey: cred.access }) });
      const kimi = await startLogin(KIMI_PROVIDER_ID);
      if (!kimi.ok) throw new Error(kimi.error);
      cancelLogin(KIMI_PROVIDER_ID);
      const codex = await startLogin(CODEX_PROVIDER_ID);
      if (!codex.ok) throw new Error(codex.error);
      const kimiFrame = events.find((e) => e.providerId === KIMI_PROVIDER_ID && e.phase === "waiting_device_code");
      const codexFrame = events.find((e) => e.providerId === CODEX_PROVIDER_ID && e.phase === "waiting_device_code");
      expect(kimiFrame?.deviceCode?.autoOpenUrl).toBe("https://auth.example/device?user_code=ABCD-EFGH");
      // 裸地址流:链接本身照发(前端展示),只是不标记可自动打开。
      expect(codexFrame?.deviceCode?.autoOpenUrl).toBeUndefined();
      expect(codexFrame?.deviceCode?.verificationUri).toBe("https://auth.example/device?user_code=ABCD-EFGH");
      cancelLogin(CODEX_PROVIDER_ID);
    } finally {
      clearOAuthFlowOverride("kimi-coding");
      clearOAuthFlowOverride("openai-codex");
    }
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
