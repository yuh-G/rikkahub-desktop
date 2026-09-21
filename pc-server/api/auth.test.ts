// api/auth.test.ts — Web 访问鉴权(P1 设置页内置密码)行为锁
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { handleAuthTokenRequest, handleSetWebPassword, handleWebAuthStatus, isWebAuthAuthorized, stripAuthSecrets, webAuthEnabled } from "./auth";
import { setState, state } from "../persistence/json-store";
import type { State } from "../foundation/types";

// 测试进程无 --password/RIKKAHHUB_PASSWORD → cliPassword=null,密码源只剩 settings.webPasswordHash。
// 测试进程没跑 loadState,注入最小 state(对齐 sse-broadcast.test.ts 惯例),每个用例前重置密码字段。
const priorState = state;
beforeAll(() => setState({ settings: { webPasswordHash: undefined, webServerJwtEnabled: false } } as unknown as State));
afterAll(() => setState(priorState));

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
});
