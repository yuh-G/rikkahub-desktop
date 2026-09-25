// A4 回归(专题9复查):MCP OAuth 端口漂移防护。DCR 注册把 redirect_uris 固化成注册时
// 的 localhost:<端口>;端口顺延/手改后,旧 clientId 重新授权会被授权服务器以
// invalid redirect_uri 拒绝且报错在浏览器侧。startMcpOAuth 现依据 redirectUriDriftAction
// 决策:漂移且支持 DCR → 换新身份重注册;不支持 → 应用内明确报错;
// 预配置/旧状态(无 redirectUri 记录) → 保持不动。
// issue #62 起服务端占满 127.0.0.1 与 ::1:只在 localhost / 127.0.0.1 之间换写法不算漂移,
// 且授权与换码必须逐字沿用注册时的那个回调。
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { completeMcpOAuth, isSameLoopbackCallback, oauthStateOf, redirectUriDriftAction, startMcpOAuth } from "./mcp-oauth";
import { flushSaveState, setState, state } from "../persistence/json-store";
import type { JsonValue, State } from "../foundation/types";

const CUR = "http://localhost:8090/api/mcp/oauth/callback";
const OLD = "http://localhost:8080/api/mcp/oauth/callback";

describe("redirectUriDriftAction", () => {
  test("无既有授权状态:keep(走常规首次注册)", () => {
    expect(redirectUriDriftAction(null, CUR, true)).toBe("keep");
  });

  test("回调地址未变:keep(沿用旧 clientId)", () => {
    expect(redirectUriDriftAction({ clientId: "c1", redirectUri: CUR }, CUR, true)).toBe("keep");
  });

  test("漂移 + 支持动态注册:reregister(换新身份,旧授权作废属预期)", () => {
    expect(redirectUriDriftAction({ clientId: "c1", redirectUri: OLD }, CUR, true)).toBe("reregister");
  });

  test("漂移 + 不支持动态注册:fail(应用内报错,不送用户去浏览器撞墙)", () => {
    expect(redirectUriDriftAction({ clientId: "c1", redirectUri: OLD }, CUR, false)).toBe("fail");
  });

  test("redirectUri 无记录(预配置 clientId/本字段引入前的旧授权):keep,不擅自换身份", () => {
    expect(redirectUriDriftAction({ clientId: "c1" }, CUR, true)).toBe("keep");
    expect(redirectUriDriftAction({ clientId: "c1", redirectUri: null }, CUR, false)).toBe("keep");
  });

  test("只换了回环写法(localhost ↔ 127.0.0.1,同端口):keep,两种 DCR 能力下都不动身份", () => {
    const literal = "http://127.0.0.1:8080/api/mcp/oauth/callback";
    expect(redirectUriDriftAction({ clientId: "c1", redirectUri: OLD }, literal, true)).toBe("keep");
    expect(redirectUriDriftAction({ clientId: "c1", redirectUri: literal }, OLD, false)).toBe("keep");
  });
});

describe("isSameLoopbackCallback", () => {
  const path = "/api/mcp/oauth/callback";
  test("localhost 与 127.0.0.1 互换(大小写不敏感)视为同一回调", () => {
    expect(isSameLoopbackCallback(`http://localhost:8080${path}`, `http://127.0.0.1:8080${path}`)).toBe(true);
    expect(isSameLoopbackCallback(`http://LOCALHOST:8080${path}`, `http://localhost:8080${path}`)).toBe(true);
  });
  test("逐字相同即同一回调(包括非回环的网页部署地址)", () => {
    expect(isSameLoopbackCallback(`https://rikka.example.com${path}`, `https://rikka.example.com${path}`)).toBe(true);
  });
  test("端口、路径、查询、scheme 任一不同都不等价", () => {
    expect(isSameLoopbackCallback(`http://localhost:8080${path}`, `http://127.0.0.1:8081${path}`)).toBe(false);
    expect(isSameLoopbackCallback(`http://localhost:8080${path}`, `http://127.0.0.1:8080/other`)).toBe(false);
    expect(isSameLoopbackCallback(`http://localhost:8080${path}?a=1`, `http://127.0.0.1:8080${path}`)).toBe(false);
    expect(isSameLoopbackCallback(`https://localhost:8080${path}`, `http://127.0.0.1:8080${path}`)).toBe(false);
  });
  test("[::1]、局域网地址不参与互换;非法地址不等价", () => {
    expect(isSameLoopbackCallback(`http://[::1]:8080${path}`, `http://localhost:8080${path}`)).toBe(false);
    expect(isSameLoopbackCallback(`http://192.168.1.5:8080${path}`, `http://localhost:8080${path}`)).toBe(false);
    expect(isSameLoopbackCallback("not a url", `http://localhost:8080${path}`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// startMcpOAuth → completeMcpOAuth 全链路:模拟 MCP 资源服务器 + 授权服务器,断言授权 URL、
// 动态注册与换码请求里实际发出的 redirect_uri。
// ---------------------------------------------------------------------------

const registrations: string[][] = [];
const tokenForms: URLSearchParams[] = [];
let authServer: ReturnType<typeof Bun.serve>;
let base = "";

const priorState = state;
beforeAll(() => {
  authServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/mcp") {
        return new Response("", { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${base}/prm"` } });
      }
      if (pathname === "/prm") return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
      if (pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
        });
      }
      if (pathname === "/register") {
        const body = (await request.json()) as { redirect_uris: string[] };
        registrations.push(body.redirect_uris);
        return Response.json({ client_id: "c-new" });
      }
      if (pathname === "/token") {
        tokenForms.push(new URLSearchParams(await request.text()));
        return Response.json({ access_token: "at", expires_in: 3600 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${authServer.port}`;
});
afterEach(() => {
  registrations.length = 0;
  tokenForms.length = 0;
});
afterAll(async () => {
  authServer.stop(true);
  // persistOauth → updateSettings → saveState 是 fire-and-forget:先 drain 在途落盘再复位(同 auth.test.ts)。
  await flushSaveState();
  setState(priorState);
});

function withServer(oauth: Record<string, JsonValue>) {
  const server = { id: "s1", url: `${base}/mcp`, commonOptions: { name: "Demo", oauth } };
  setState({ settings: { mcpServers: [server] } } as unknown as State);
}

function storedOauth() {
  return oauthStateOf((state.settings.mcpServers as Array<Record<string, JsonValue>>)[0]!);
}

describe("startMcpOAuth 回调地址(全链路)", () => {
  test("只换回环写法:沿用 clientId 不重注册,授权与换码逐字用注册时的回调", async () => {
    const registered = "http://localhost:8080/api/mcp/oauth/callback";
    withServer({ enabled: true, clientId: "c1", redirectUri: registered });

    const { authorizationUrl } = await startMcpOAuth("s1", "http://127.0.0.1:8080/api/mcp/oauth/callback");
    const auth = new URL(authorizationUrl);
    expect(auth.searchParams.get("client_id")).toBe("c1");
    expect(auth.searchParams.get("redirect_uri")).toBe(registered);
    expect(registrations).toHaveLength(0);

    const outcome = await completeMcpOAuth({ code: "code-1", state: auth.searchParams.get("state") });
    expect(outcome.ok).toBe(true);
    expect(tokenForms[0]!.get("redirect_uri")).toBe(registered);
    expect(storedOauth()).toMatchObject({ clientId: "c1", redirectUri: registered, accessToken: "at" });
  });

  test("端口变了仍是漂移:以当前地址重注册,授权与换码都用新地址", async () => {
    const current = "http://127.0.0.1:8081/api/mcp/oauth/callback";
    withServer({ enabled: true, clientId: "c1", redirectUri: "http://localhost:8080/api/mcp/oauth/callback" });

    const { authorizationUrl } = await startMcpOAuth("s1", current);
    const auth = new URL(authorizationUrl);
    expect(registrations).toEqual([[current]]);
    expect(auth.searchParams.get("client_id")).toBe("c-new");
    expect(auth.searchParams.get("redirect_uri")).toBe(current);

    await completeMcpOAuth({ code: "code-2", state: auth.searchParams.get("state") });
    expect(tokenForms[0]!.get("redirect_uri")).toBe(current);
    expect(storedOauth()).toMatchObject({ clientId: "c-new", redirectUri: current });
  });
});
