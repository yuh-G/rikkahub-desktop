// api/auth.test.ts — Web 访问鉴权(P1 设置页内置密码)行为锁
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { handleAuthTokenRequest, handleSetWebPassword, handleWebAuthStatus, isWebAuthAuthorized, stripAuthSecrets, webAuthEnabled } from "./auth";
import { flushSaveState, setState, state } from "../persistence/json-store";
import type { State } from "../foundation/types";

// 测试进程无 --password/RIKKAHHUB_PASSWORD → cliPassword=null,密码源只剩 settings.webPasswordHash。
// 测试进程没跑 loadState,注入最小 state(对齐 sse-broadcast.test.ts 惯例),每个用例前重置密码字段。
const priorState = state;
beforeAll(() => setState({ settings: { webPasswordHash: undefined, webServerJwtEnabled: false } } as unknown as State));
afterAll(async () => {
  // handleSetWebPassword → updateSettings → saveState 是 fire-and-forget:先 drain 在途落盘
  // 再复位——若先把 state 复位回 undefined,尾随写读 state.appliedMigrations 即抛 TypeError
  // (Linux CI #22 曾因此产生 1 个 unhandled error,本地时序碰巧不触发)。
  await flushSaveState();
  setState(priorState);
});

function resetPassword() {
  state.settings = { ...state.settings, webPasswordHash: undefined, webServerJwtEnabled: false };
}

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost/api/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function tokenFor(password: string): Promise<string | null> {
  const res = await handleAuthTokenRequest(postJson("auth/token", { password }));
  if (res.status !== 200) return null;
  const body = (await res.json()) as { token: string };
  return body.token;
}

beforeEach(() => resetPassword());

describe("web 鉴权开关", () => {
  test("未设密码 → 未启用,/api 全放行", () => {
    expect(webAuthEnabled()).toBe(false);
    const req = new Request("http://localhost/api/conversations");
    expect(isWebAuthAuthorized(req, new URL(req.url))).toBe(true);
  });

  test("设置页设密码 → 启用,/api 无 token 拒绝", async () => {
    const res = await handleSetWebPassword(postJson("settings/web-password", { newPassword: "s3cret" }));
    expect(res.status).toBe(200);
    expect(webAuthEnabled()).toBe(true);
    expect(state.settings.webServerJwtEnabled).toBe(true);
    expect(typeof state.settings.webPasswordHash).toBe("string");
    // 存的绝不是明文
    expect(state.settings.webPasswordHash).not.toContain("s3cret");

    const req = new Request("http://localhost/api/conversations");
    expect(isWebAuthAuthorized(req, new URL(req.url))).toBe(false);
  });
});

describe("token 签发与校验", () => {
  test("正确密码换 token → 携 token 的 /api 放行", async () => {
    await handleSetWebPassword(postJson("settings/web-password", { newPassword: "pw" }));
    const token = await tokenFor("pw");
    expect(token).toBeTruthy();
    const req = new Request("http://localhost/api/conversations", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(isWebAuthAuthorized(req, new URL(req.url))).toBe(true);
    // access_token query 形态(<img>/WebSocket 用)
    const q = new Request(`http://localhost/api/files/1?access_token=${token}`);
    expect(isWebAuthAuthorized(q, new URL(q.url))).toBe(true);
  });

  test("错误密码 → 401,换不到 token", async () => {
    await handleSetWebPassword(postJson("settings/web-password", { newPassword: "pw" }));
    expect(await tokenFor("wrong")).toBeNull();
  });
});

describe("设置端点鉴权(防未授权改/锁死)", () => {
  test("首设(无密码)放行;已设后无/错 currentPassword 拒绝改密", async () => {
    // 首设放行
    expect((await handleSetWebPassword(postJson("settings/web-password", { newPassword: "a" }))).status).toBe(200);
    // 已设:缺 currentPassword → 401
    expect((await handleSetWebPassword(postJson("settings/web-password", { newPassword: "b" }))).status).toBe(401);
    // 已设:错 currentPassword → 401
    expect(
      (await handleSetWebPassword(postJson("settings/web-password", { currentPassword: "nope", newPassword: "b" }))).status,
    ).toBe(401);
    // 已设:对 currentPassword → 200
    expect(
      (await handleSetWebPassword(postJson("settings/web-password", { currentPassword: "a", newPassword: "b" }))).status,
    ).toBe(200);
  });
});

describe("改/清密码令旧 token 失效", () => {
  test("改密码后旧 token 失效、新密码可用", async () => {
    await handleSetWebPassword(postJson("settings/web-password", { newPassword: "old" }));
    const oldToken = await tokenFor("old");
    expect(oldToken).toBeTruthy();
    // 改密
    await handleSetWebPassword(postJson("settings/web-password", { currentPassword: "old", newPassword: "new" }));
    const req = new Request("http://localhost/api/conversations", { headers: { authorization: `Bearer ${oldToken}` } });
    expect(isWebAuthAuthorized(req, new URL(req.url))).toBe(false);
    expect(await tokenFor("new")).toBeTruthy();
  });

  test("清密码(newPassword 空串)→ 恢复无鉴权", async () => {
    await handleSetWebPassword(postJson("settings/web-password", { newPassword: "x" }));
    expect(webAuthEnabled()).toBe(true);
    const res = await handleSetWebPassword(postJson("settings/web-password", { currentPassword: "x", newPassword: "" }));
    expect(res.status).toBe(200);
    expect(webAuthEnabled()).toBe(false);
    expect(state.settings.webServerJwtEnabled).toBe(false);
    const req = new Request("http://localhost/api/conversations");
    expect(isWebAuthAuthorized(req, new URL(req.url))).toBe(true);
  });
});

describe("web-auth/status(敏感边界:绝不泄露哈希)", () => {
  test("只回布尔,响应体不含哈希/明文", async () => {
    let body = (await (await handleWebAuthStatus()).json()) as Record<string, unknown>;
    expect(body).toEqual({ enabled: false, configured: false, lockedByDeployment: false });

    await handleSetWebPassword(postJson("settings/web-password", { newPassword: "s3cret" }));
    const res = await handleWebAuthStatus();
    body = (await res.json()) as Record<string, unknown>;
    expect(body.enabled).toBe(true);
    expect(body.configured).toBe(true);
    // 状态端点只回布尔:响应文本里不出现哈希或明文
    const text = JSON.stringify(body);
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain(String(state.settings.webPasswordHash));
  });

  test("stripAuthSecrets 剥掉 webPasswordHash(settings GET/SSE 暴露面纪律)", async () => {
    await handleSetWebPassword(postJson("settings/web-password", { newPassword: "s3cret" }));
    // 原始 state.settings 含哈希(备份/持久化面)…
    expect(typeof state.settings.webPasswordHash).toBe("string");
    // …但下发前端的副本被剥掉,且不改原对象
    const sanitized = stripAuthSecrets(state.settings) as unknown as Record<string, unknown>;
    expect("webPasswordHash" in sanitized).toBe(false);
    expect(typeof state.settings.webPasswordHash).toBe("string"); // 原对象仍在
    expect(sanitized.webServerJwtEnabled).toBe(true); // 其余字段不动
  });

  test("stripAuthSecrets 剥 OAuth 凭证为 oauthStatus 安全视图(refresh token 永不下发)", () => {
    // 订阅供应商(方案 §3):oauth.credential 含长效 refresh token,「值单向进不出」。
    // 前端只见登录态/账号/过期,不见 token 本身。
    const settings = {
      providers: [
        {
          id: "p-codex",
          authMode: "oauth",
          oauth: {
            flow: "openai-codex",
            signedInAt: 1727000000000,
            credential: { type: "oauth", access: "acc-secret", refresh: "ref-secret", expires: 9999999999000, accountId: "acct_123" },
          },
        },
        { id: "p-plain", apiKey: "sk-x" }, // 无 oauth 行 → 不动
      ],
    };
    const sanitized = stripAuthSecrets(settings) as any;
    const codex = sanitized.providers.find((p: any) => p.id === "p-codex");
    // oauth 凭证整个被剥,替换为安全视图
    expect(codex.oauth).toBeUndefined();
    expect(codex.oauthStatus).toEqual({
      signedIn: true,
      flow: "openai-codex",
      signedInAt: 1727000000000,
      expiresAt: 9999999999000,
      accountId: "acct_123",
      chatCapable: true,
    });
    // 响应文本里绝不出现 access/refresh token
    const text = JSON.stringify(sanitized);
    expect(text).not.toContain("acc-secret");
    expect(text).not.toContain("ref-secret");
    // 无 oauth 的供应商行原样保留
    expect(sanitized.providers.find((p: any) => p.id === "p-plain")).toEqual({ id: "p-plain", apiKey: "sk-x" });
    // 原对象不被改
    expect((settings.providers[0] as any).oauth.credential.refresh).toBe("ref-secret");
  });

  test("stripAuthSecrets 保留未登录订阅供应商的 authMode(无 oauth 行时不隐藏)", () => {
    // 预置订阅供应商未登录时 authMode:"oauth" 但无 oauth 行——若把 authMode 也剥了,
    // 前端就认不出这是订阅供应商,登录卡片/「订阅」徽章会消失。未登录也发安全视图
    // (signedIn:false + flow/chatCapable):登录卡要在首登前挂「仅工作区/合规」提示。
    // 预置 UUID 反查得到 flow;Claude 订阅的 chatCapable:false 是登录卡提示与选择器
    // 过滤的依据。非预置 id(异常行)flow 给空串、按可对话处理。
    const settings = {
      providers: [
        { id: "p-kimi", authMode: "oauth", name: "Kimi Code" }, // 无 oauth 行、非预置 UUID
        { id: "d4f86913-80d5-45e4-84ea-3e652ac63cda", authMode: "oauth", name: "Claude" }, // Claude 订阅预置,未登录
        { id: "98d0557b-0700-41e5-b1d6-ee875a53ae5a", authMode: "oauth", name: "ChatGPT" }, // Codex 预置,未登录
      ],
    };
    const sanitized = stripAuthSecrets(settings) as any;
    expect(sanitized.providers[0].authMode).toBe("oauth");
    expect(sanitized.providers[0].name).toBe("Kimi Code");
    expect(sanitized.providers[0].oauthStatus).toEqual({ signedIn: false, flow: "", chatCapable: true });
    expect(sanitized.providers[1].oauthStatus).toEqual({ signedIn: false, flow: "anthropic", chatCapable: false });
    expect(sanitized.providers[2].oauthStatus).toEqual({ signedIn: false, flow: "openai-codex", chatCapable: true });
  });

  test("stripAuthSecrets 丢弃 state 里残留的 oauthStatus,只按 oauth 现算(登出后卡片不得仍显示已登录)", () => {
    // 旧版 settings/provider POST 把前端回传的派生视图落进了 state。登出剥掉 oauth 后,
    // 若 stripAuthSecrets 原样透传残留的 oauthStatus,前端会永远看到 signedIn:true。
    const settings = {
      providers: [
        { id: "p-kimi", authMode: "oauth", oauthStatus: { signedIn: true, flow: "kimi-coding", signedInAt: 1 } }, // 已登出但视图残留
        {
          id: "p-codex",
          authMode: "oauth",
          oauthStatus: { signedIn: true, flow: "openai-codex", signedInAt: 1, accountId: "stale" }, // 残留的旧视图
          oauth: { flow: "openai-codex", signedInAt: 2, credential: { type: "oauth", access: "a", refresh: "r", expires: 3 } },
        },
      ],
    };
    const sanitized = stripAuthSecrets(settings) as any;
    expect(sanitized.providers[0].oauthStatus).toEqual({ signedIn: false, flow: "", chatCapable: true });
    // 有 oauth 行时以 oauth 现算,残留视图的字段(accountId:"stale")不得渗出。
    expect(sanitized.providers[1].oauthStatus).toEqual({ signedIn: true, flow: "openai-codex", signedInAt: 2, expiresAt: 3, accountId: undefined, chatCapable: true });
  });
});
