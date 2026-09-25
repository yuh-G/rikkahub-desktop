// tools/mcp-oauth.ts — MCP OAuth 2.1 授权客户端与协调器(专题9,对齐安卓 McpOAuthClient/McpOAuthCoordinator)
// 实现 MCP 授权规范所需环节:RFC 9728 受保护资源元数据发现、RFC 8414/OIDC 授权服务器元数据发现、
// RFC 7591 动态客户端注册(DCR)、带 PKCE(S256) 的授权码流程、RFC 8707 Resource Indicators、令牌刷新。
// 令牌持久化在 server.commonOptions.oauth,字段名与安卓 McpOAuthState 一致(备份互通零转换)。
// PC 与安卓的差异:回调走本机 HTTP 回环地址(RFC 8252),而非安卓的自定义 scheme。

import { createHash, randomBytes } from "node:crypto";

import { isRecord } from "../foundation/utils";
import { state } from "../persistence/json-store";
import { updateSettings } from "../app-config";
import type { JsonValue } from "../foundation/types";

const DISCOVERY_TIMEOUT_MS = 15_000;
const TOKEN_TIMEOUT_MS = 30_000;
const TOKEN_REFRESH_LEEWAY_MS = 60_000;
const PENDING_AUTH_TTL_MS = 5 * 60_000;

/** 与安卓 McpOAuthState 同构的持久化形状(全部可选,缺省即未授权)。 */
export interface McpOAuthStateRecord {
  enabled?: boolean;
  clientId?: string | null;
  clientSecret?: string | null;
  /** A4(专题9复查):DCR 注册时固化的回调地址。仅在我们自己动态注册/授权成功时写入;
   *  端口顺延/手改后与当前地址不一致时用于触发自动重注册(见 startMcpOAuth)。
   *  预配置 clientId 的服务器不写此字段(不能擅自换身份)。安卓侧无此字段,
   *  其 Json 配置 ignoreUnknownKeys,跨端备份透传无害。 */
  redirectUri?: string | null;
  authorizationEndpoint?: string | null;
  tokenEndpoint?: string | null;
  registrationEndpoint?: string | null;
  scope?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number;
}

interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

interface AuthorizationServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

interface PendingAuthorization {
  serverId: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string | null;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  authorizationEndpoint: string;
  scope: string | null;
  resource: string;
  createdAt: number;
}

/** 以 state 参数为键的待完成授权;回调命中后即删除(state 一次性)。 */
const pendingAuthorizations = new Map<string, PendingAuthorization>();
/** 按 serverId 串行化令牌刷新,避免并发工具调用重复消费同一个 refresh token。 */
const refreshChains = new Map<string, Promise<void>>();

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier, "ascii").digest());
  return { verifier, challenge };
}

/** 规范化 canonical resource URI(RFC 8707 + MCP 规范):小写 scheme/host、去掉 fragment。 */
export function canonicalResource(serverUrl: string): string {
  try {
    const url = new URL(serverUrl);
    url.hash = "";
    return url.toString();
  } catch {
    return serverUrl;
  }
}

function originOf(url: URL): string {
  return url.origin;
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetchWithTimeout(url, { headers: { Accept: "application/json" } }, DISCOVERY_TIMEOUT_MS);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// 元数据发现(与安卓 McpOAuthClient 同序:401 探测 → well-known 组合)
// ---------------------------------------------------------------------------

/** 向 MCP Server 发一次探测请求,从 401 的 WWW-Authenticate 提取 resource_metadata。 */
async function probeResourceMetadataUrl(serverUrl: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(
      serverUrl,
      { headers: { Accept: "application/json, text/event-stream" } },
      DISCOVERY_TIMEOUT_MS,
    );
    // 探测只看头,响应体(可能是长 SSE)立刻丢弃。
    try { await response.body?.cancel(); } catch { /* 无所谓 */ }
    if (response.status !== 401) return null;
    const header = response.headers.get("WWW-Authenticate") ?? "";
    return /resource_metadata="([^"]+)"/.exec(header)?.[1] ?? null;
  } catch {
    return null;
  }
}

function wellKnownPrmUrls(serverUrl: string): string[] {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return [];
  }
  const origin = originOf(url);
  const path = url.pathname.replace(/\/+$/, "");
  const urls: string[] = [];
  if (path && path !== "/") urls.push(`${origin}/.well-known/oauth-protected-resource${path}`);
  urls.push(`${origin}/.well-known/oauth-protected-resource`);
  return [...new Set(urls)];
}

function wellKnownAsUrls(issuer: string): string[] {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return [];
  }
  const origin = originOf(url);
  const path = url.pathname.replace(/\/+$/, "");
  const urls: string[] = [];
  if (path && path !== "/") {
    urls.push(`${origin}/.well-known/oauth-authorization-server${path}`);
    urls.push(`${origin}/.well-known/openid-configuration${path}`);
    urls.push(`${origin}${path}/.well-known/openid-configuration`);
  }
  urls.push(`${origin}/.well-known/oauth-authorization-server`);
  urls.push(`${origin}/.well-known/openid-configuration`);
  return [...new Set(urls)];
}

async function discoverProtectedResource(serverUrl: string): Promise<ProtectedResourceMetadata> {
  const candidates: string[] = [];
  const probed = await probeResourceMetadataUrl(serverUrl);
  if (probed) candidates.push(probed);
  candidates.push(...wellKnownPrmUrls(serverUrl));
  for (const url of [...new Set(candidates)]) {
    try {
      const meta = await getJson<ProtectedResourceMetadata>(url);
      if (Array.isArray(meta.authorization_servers) && meta.authorization_servers.length > 0) return meta;
    } catch {
      // 尝试下一个候选。
    }
  }
  throw new Error("无法发现受保护资源元数据(protected resource metadata)——该 MCP 服务器可能不支持 OAuth");
}

async function discoverAuthorizationServer(issuer: string): Promise<AuthorizationServerMetadata> {
  for (const url of wellKnownAsUrls(issuer)) {
    try {
      const meta = await getJson<AuthorizationServerMetadata>(url);
      if (meta.authorization_endpoint && meta.token_endpoint) return meta;
    } catch {
      // 尝试下一个候选。
    }
  }
  throw new Error(`无法发现授权服务器元数据(authorization server metadata): ${issuer}`);
}

/** 动态客户端注册(RFC 7591),公共客户端通常无 secret。 */
async function registerClient(
  registrationEndpoint: string,
  clientName: string,
  redirectUri: string,
  scope: string | null,
): Promise<{ clientId: string; clientSecret: string | null }> {
  const response = await fetchWithTimeout(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: clientName || "RikkaHub",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(scope ? { scope } : {}),
    }),
  }, TOKEN_TIMEOUT_MS);
  const text = await response.text();
  if (!response.ok) throw new Error(`动态客户端注册失败 HTTP ${response.status}: ${text.slice(0, 300)}`);
  const raw = JSON.parse(text) as { client_id?: string; client_secret?: string };
  if (!raw.client_id) throw new Error("动态客户端注册响应缺少 client_id");
  return { clientId: raw.client_id, clientSecret: raw.client_secret ?? null };
}

async function postToken(tokenEndpoint: string, form: Record<string, string>): Promise<TokenResponse> {
  const response = await fetchWithTimeout(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  }, TOKEN_TIMEOUT_MS);
  const text = await response.text();
  if (!response.ok) throw new Error(`令牌请求失败 HTTP ${response.status}: ${text.slice(0, 300)}`);
  const raw = JSON.parse(text) as TokenResponse;
  if (!raw.access_token) throw new Error("令牌响应缺少 access_token");
  return raw;
}

function computeExpiry(expiresIn: number | undefined): number {
  return expiresIn && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0;
}

// ---------------------------------------------------------------------------
// settings 读写(oauth 状态挂在 server.commonOptions.oauth)
// ---------------------------------------------------------------------------

function findServer(serverId: string): Record<string, JsonValue> | null {
  return (state.settings.mcpServers as Array<Record<string, JsonValue>>)
    .find((item) => String(item.id ?? "") === serverId) ?? null;
}

export function oauthStateOf(server: Record<string, JsonValue>): McpOAuthStateRecord | null {
  const common = isRecord(server.commonOptions) ? server.commonOptions : {};
  return isRecord(common.oauth) ? (common.oauth as McpOAuthStateRecord) : null;
}

/** 持久化某服务器的 oauth 状态。故意原地替换 commonOptions 而保留 server 对象引用——
 *  settings 路由的防陈旧写回守卫用引用相等判定(includes(server)),换对象会让并发中的
 *  保存/同步被误判为"已被替换"而 409。 */
function persistOauth(serverId: string, oauth: McpOAuthStateRecord | null): void {
  refreshFailureAt.delete(serverId); // 重新授权/清除授权都让冷却失效,立刻允许下一次刷新
  const server = findServer(serverId);
  if (!server) return;
  const common = isRecord(server.commonOptions) ? server.commonOptions : {};
  server.commonOptions = { ...common, oauth: oauth as unknown as JsonValue };
  updateSettings({ ...state.settings, mcpServers: [...(state.settings.mcpServers as JsonValue[])] });
}

// ---------------------------------------------------------------------------
// 授权流程
// ---------------------------------------------------------------------------

function sweepExpiredPending(): void {
  const now = Date.now();
  for (const [key, pending] of pendingAuthorizations) {
    if (now - pending.createdAt > PENDING_AUTH_TTL_MS) pendingAuthorizations.delete(key);
  }
}

/** 发起授权:发现元数据 → (必要时)动态注册 → 生成 PKCE/state → 返回浏览器授权 URL。
 *  中间产物(端点/clientId)先落盘,令牌在回调完成后落盘。 */
/** A4(专题9复查):端口漂移防护决策。DCR 把 redirect_uris 固化成注册时的
 *  localhost:<端口>,而本项目端口会被占用顺延/可手改——旧 clientId 带旧回调地址,
 *  授权服务器会以 invalid redirect_uri 拒绝,且报错发生在浏览器侧、应用内无提示。
 *  回调地址已变时:支持动态注册就换新身份重注册(旧授权作废属预期);不支持则
 *  应用内明确报错。existing.redirectUri 缺失 = 预配置 clientId 或本字段引入前的
 *  旧授权状态 → 不动(不能擅自换预配置身份;旧状态在下次授权成功时自愈,见回调)。
 *  只换了回环写法(见 isSameLoopbackCallback)不算漂移:keep 并沿用已注册的那个。 */
export function redirectUriDriftAction(
  existing: McpOAuthStateRecord | null,
  currentRedirectUri: string,
  hasRegistrationEndpoint: boolean,
): "keep" | "reregister" | "fail" {
  const clientId = existing?.clientId ?? null;
  const registered = existing?.redirectUri ?? null;
  if (!clientId || !registered || isSameLoopbackCallback(registered, currentRedirectUri)) return "keep";
  return hasRegistrationEndpoint ? "reregister" : "fail";
}

/** 两个回调地址是否送达同一处:逐字相同,或仅主机在 localhost / 127.0.0.1 之间互换(scheme、端口、
 *  路径、查询都一致)。服务端在回环意图下同时占住 127.0.0.1 与 ::1(issue #62,foundation/port-binding),
 *  这两种写法的回调都只会落到本进程——页面换了写法(浏览器手敲 127.0.0.1,或界面改拨字面 IP)就不该
 *  让动态注册换身份、让不支持动态注册的服务报错。[::1] 不在此列:本机无 IPv6 回环、仅 IPv4 监听时它不可达。 */
export function isSameLoopbackCallback(a: string, b: string): boolean {
  if (a === b) return true;
  let left: URL;
  let right: URL;
  try {
    left = new URL(a);
    right = new URL(b);
  } catch {
    return false; // 非法地址不做等价推断,按漂移处理
  }
  const interchangeable = (host: string) => host === "localhost" || host === "127.0.0.1";
  return interchangeable(left.hostname) && interchangeable(right.hostname)
    && left.protocol === right.protocol && left.port === right.port
    && left.pathname === right.pathname && left.search === right.search;
}

export async function startMcpOAuth(serverId: string, redirectUri: string): Promise<{ authorizationUrl: string }> {
  sweepExpiredPending();
  const server = findServer(serverId);
  if (!server) throw new Error("MCP server not found");
  const serverUrl = String(server.url ?? "").trim();
  if (!/^https?:\/\//i.test(serverUrl)) throw new Error("MCP server URL 为空或非法,无法授权");
  const common = isRecord(server.commonOptions) ? server.commonOptions : {};
  const serverName = String(common.name ?? "MCP Server");
  const existing = oauthStateOf(server);

  const protectedResource = await discoverProtectedResource(serverUrl);
  const issuer = protectedResource.authorization_servers?.[0];
  if (!issuer) throw new Error("受保护资源未声明授权服务器");
  const metadata = await discoverAuthorizationServer(issuer);
  const authorizationEndpoint = metadata.authorization_endpoint!;
  const tokenEndpoint = metadata.token_endpoint!;
  const scope = existing?.scope
    ?? protectedResource.scopes_supported?.join(" ")
    ?? metadata.scopes_supported?.join(" ")
    ?? null;

  let clientId = existing?.clientId ?? null;
  let clientSecret = existing?.clientSecret ?? null;
  const registeredRedirectUri = existing?.redirectUri ?? null;
  const drift = redirectUriDriftAction(existing, redirectUri, Boolean(metadata.registration_endpoint));
  if (drift === "fail") {
    throw new Error(
      `应用回调地址已变化(注册时 ${registeredRedirectUri},当前 ${redirectUri}),`
        + "且授权服务器不支持动态注册。请清除授权后重试,或将应用端口改回原值",
    );
  }
  if (drift === "reregister") {
    clientId = null;
    clientSecret = null;
  }
  // 沿用旧 clientId 且有注册记录时,授权与换码逐字使用注册时的回调——它可能是与当前等价的另一种
  // 回环写法,授权服务器只认注册过的那个字符串。
  const callbackUri = clientId && registeredRedirectUri ? registeredRedirectUri : redirectUri;
  let registeredNow = false;
  if (!clientId) {
    if (!metadata.registration_endpoint) throw new Error("授权服务器不支持动态注册,且未预配置 client_id");
    const registration = await registerClient(metadata.registration_endpoint, serverName, redirectUri, scope);
    clientId = registration.clientId;
    clientSecret = registration.clientSecret;
    registeredNow = true;
  }

  const pkce = generatePkce();
  const stateParam = base64Url(randomBytes(16));
  const resource = canonicalResource(serverUrl);
  persistOauth(serverId, {
    ...(existing ?? {}),
    enabled: true,
    clientId,
    clientSecret,
    // 本次新注册才可断言注册地址;沿用旧 clientId 时保留旧记录(缺失即保持缺失)。
    redirectUri: registeredNow ? redirectUri : registeredRedirectUri,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: metadata.registration_endpoint ?? null,
    scope,
  });
  pendingAuthorizations.set(stateParam, {
    serverId,
    codeVerifier: pkce.verifier,
    redirectUri: callbackUri,
    clientId,
    clientSecret,
    tokenEndpoint,
    registrationEndpoint: metadata.registration_endpoint ?? null,
    authorizationEndpoint,
    scope,
    resource,
    createdAt: Date.now(),
  });

  const authUrl = new URL(authorizationEndpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", callbackUri);
  authUrl.searchParams.set("code_challenge", pkce.challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", stateParam);
  authUrl.searchParams.set("resource", resource);
  if (scope) authUrl.searchParams.set("scope", scope);
  return { authorizationUrl: authUrl.toString() };
}

/** 浏览器回调:校验 state → 授权码换令牌 → 落盘。返回给回调页展示的结果。 */
export async function completeMcpOAuth(params: {
  code?: string | null;
  state?: string | null;
  error?: string | null;
  errorDescription?: string | null;
}): Promise<{ ok: boolean; message: string; serverName?: string }> {
  sweepExpiredPending();
  const stateParam = params.state ?? "";
  const pending = stateParam ? pendingAuthorizations.get(stateParam) : undefined;
  if (!pending) return { ok: false, message: "授权会话不存在或已过期,请回到应用重新发起授权" };
  pendingAuthorizations.delete(stateParam);
  const server = findServer(pending.serverId);
  const serverName = server && isRecord(server.commonOptions) ? String(server.commonOptions.name ?? "MCP Server") : "MCP Server";
  if (params.error) {
    return { ok: false, message: `授权失败: ${params.error}${params.errorDescription ? ` (${params.errorDescription})` : ""}`, serverName };
  }
  if (!params.code) return { ok: false, message: "授权失败: 未返回授权码", serverName };
  if (!server) return { ok: false, message: "MCP 服务器已被删除,授权结果无处可存", serverName };

  const token = await postToken(pending.tokenEndpoint, {
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.codeVerifier,
    resource: pending.resource,
    ...(pending.clientSecret ? { client_secret: pending.clientSecret } : {}),
  });
  persistOauth(pending.serverId, {
    enabled: true,
    clientId: pending.clientId,
    clientSecret: pending.clientSecret,
    // A4:授权走通即实证该回调地址与此 clientId 匹配——落盘供漂移检测,
    // 顺带把本字段引入前的旧授权状态自愈成可检测形态。
    redirectUri: pending.redirectUri,
    authorizationEndpoint: pending.authorizationEndpoint,
    tokenEndpoint: pending.tokenEndpoint,
    registrationEndpoint: pending.registrationEndpoint,
    scope: token.scope ?? pending.scope,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    expiresAt: computeExpiry(token.expires_in),
  });
  return { ok: true, message: "授权成功,令牌已保存", serverName };
}

/** 清除授权(对齐安卓 clearAuthorization):oauth 整体置 null。 */
export function clearMcpOAuth(serverId: string): void {
  const server = findServer(serverId);
  if (!server) throw new Error("MCP server not found");
  persistOauth(serverId, null);
}

// ---------------------------------------------------------------------------
// 令牌刷新(对齐安卓 ensureFreshToken:按 serverId 串行,拿锁后重读配置)
// ---------------------------------------------------------------------------

function tokenNeedsRefresh(oauth: McpOAuthStateRecord): boolean {
  if (oauth.enabled !== true || !oauth.refreshToken) return false;
  const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0;
  const expired = expiresAt > 0 && Date.now() >= expiresAt - TOKEN_REFRESH_LEEWAY_MS;
  return !oauth.accessToken || expired;
}

// D13(复查):刷新失败冷却。坏令牌端点(离线/服务下线)会让之后每次工具调用都白等一次
// 网络超时;失败后冷却期内跳过重试,成功刷新或用户重新授权(persistOauth)即清除。
const REFRESH_FAILURE_COOLDOWN_MS = 60_000;
const refreshFailureAt = new Map<string, number>();

async function refreshServerToken(serverId: string): Promise<void> {
  // 拿到"锁"后重读最新配置:排队期间可能已被并发刷新过。
  const server = findServer(serverId);
  if (!server) return;
  const oauth = oauthStateOf(server);
  if (!oauth || !tokenNeedsRefresh(oauth)) return;
  if (!oauth.tokenEndpoint || !oauth.clientId) return;
  try {
    const token = await postToken(oauth.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken!,
      client_id: oauth.clientId,
      resource: canonicalResource(String(server.url ?? "")),
      ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}),
      ...(oauth.scope ? { scope: oauth.scope } : {}),
    });
    persistOauth(serverId, {
      ...oauth,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? oauth.refreshToken,
      expiresAt: computeExpiry(token.expires_in),
      scope: token.scope ?? oauth.scope,
    });
    refreshFailureAt.delete(serverId);
  } catch (err) {
    refreshFailureAt.set(serverId, Date.now());
    // 刷新失败不致命:保留旧令牌尝试请求,401 由上层错误面呈现,用户可重新授权。
    console.warn(`[mcp-oauth] 令牌刷新失败(server ${serverId}):`, err instanceof Error ? err.message : err);
  }
}

/** 若该服务器启用了 OAuth 且令牌临期/缺失,则刷新并持久化。按 serverId 串行。 */
export async function ensureFreshMcpToken(server: Record<string, JsonValue>): Promise<Record<string, JsonValue>> {
  const serverId = String(server.id ?? "");
  const oauth = oauthStateOf(server);
  if (!serverId || !oauth || !tokenNeedsRefresh(oauth)) return server;
  const failedAt = refreshFailureAt.get(serverId);
  if (failedAt !== undefined && Date.now() - failedAt < REFRESH_FAILURE_COOLDOWN_MS) return server;
  const prev = refreshChains.get(serverId) ?? Promise.resolve();
  const run = prev.then(() => refreshServerToken(serverId));
  refreshChains.set(serverId, run.catch(() => { /* 已在 refreshServerToken 内兜底 */ }));
  await run;
  return findServer(serverId) ?? server;
}

