// 回归:normalizeState 必须一次性剥除持久化的 providers[].oauthStatus。
// 该字段是 stripAuthSecrets 下发前端的派生视图,旧版 settings/provider POST 曾把前端回传的
// 视图落进 state——登出剥掉 oauth 后它还留着 signedIn:true,卡片永远显示「已登录」。
// 每次加载无条件剥除,天然覆盖备份恢复带回的旧值;oauth 真值与其余字段原样保留。
import { describe, expect, test } from "bun:test";
import { normalizeState } from "./state-load";

const KIMI_ID = "f9622c8b-5037-4540-b875-3d301521367b";

describe("providers[].oauthStatus 残留剥离", () => {
  test("登出后残留的 oauthStatus 被剥除,authMode/oauth 等真值不动", () => {
    const state = normalizeState({
      settings: {
        providers: [
          {
            id: KIMI_ID,
            type: "claude",
            enabled: false,
            name: "Kimi Code",
            baseUrl: "https://api.kimi.com/coding",
            authMode: "oauth",
            oauthStatus: { signedIn: true, flow: "kimi-coding", signedInAt: 1 },
            models: [],
          },
          {
            id: "p-codex-signed-in",
            type: "openai",
            enabled: true,
            name: "ChatGPT",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authMode: "oauth",
            oauthStatus: { signedIn: true, flow: "openai-codex", signedInAt: 1 },
            oauth: { flow: "openai-codex", signedInAt: 2, credential: { type: "oauth", access: "a", refresh: "r", expires: 3 } },
            models: [],
          },
        ],
      } as any,
    });
    const kimi = state.settings.providers.find((p) => p.id === KIMI_ID) as unknown as Record<string, unknown>;
    expect("oauthStatus" in kimi).toBe(false);
    expect(kimi.authMode).toBe("oauth");
    expect(kimi.oauth).toBeUndefined();
    const codex = state.settings.providers.find((p) => p.id === "p-codex-signed-in") as unknown as Record<string, unknown>;
    expect("oauthStatus" in codex).toBe(false);
    expect((codex.oauth as { credential: { refresh: string } }).credential.refresh).toBe("r");
  });

  test("预置订阅供应商被旧版冲成 apiKey 的 authMode 拨回 oauth;自定义供应商的 authMode 不动", () => {
    const state = normalizeState({
      settings: {
        providers: [
          { id: KIMI_ID, type: "claude", enabled: false, name: "Kimi Code", baseUrl: "https://api.kimi.com/coding", authMode: "apiKey", models: [] },
          { id: "custom-1", type: "openai", enabled: true, name: "中转", baseUrl: "https://relay.example/v1", apiKey: "sk", models: [] },
        ],
      } as any,
    });
    expect(state.settings.providers.find((p) => p.id === KIMI_ID)?.authMode).toBe("oauth");
    expect(state.settings.providers.find((p) => p.id === "custom-1")?.authMode).toBeUndefined();
  });
});
