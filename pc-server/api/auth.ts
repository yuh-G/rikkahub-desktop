// api/auth.ts — Web 访问鉴权（阶段 5.2，解决 N-1 容器/局域网零鉴权）
//
// 密码来源(优先级从高到低):
//   1. 部署者显式注入:--password / RIKKAHUB_PASSWORD(容器/反代场景,明文只在进程内)。
//   2. 设置页内置设置:state.settings.webPasswordHash(存 HMAC 派生哈希,永不存明文)。
// 两者皆无 → webAuthEnabled()=false,/api/* 完全旁路,桌面本机形态(127.0.0.1 + Origin
// 白名单)行为不变。配上密码后,所有 /api/* 请求必须携带有效 token(Authorization: Bearer
// 或 access_token query——后者供 <img>/<audio>/WebSocket 等无法设 header 的场景使用)。
//
// 契约对齐前端既有脚手架(web-ui/app/services/api.ts):
//   POST /api/auth/token  body {password}  →  200 {token, expiresAt(epoch ms)} / 401 {error, code}
//   任意 /api/* 返回 401 时前端清 token 并弹出密码闸门(rikkahub:web-auth-required)。
//
// token 设计:HMAC-SHA256 无状态签名(v1.<过期毫秒>.<hmac hex>),密钥从密码派生。
// 无需服务端存储,重启依旧有效;改/清密码即令所有旧 token 失效(密钥随密码变化)。

import { createHmac, timingSafeEqual } from "node:crypto";
import { error, json, readJson } from "./request";
import { state } from "../persistence/json-store";
import { updateSettings } from "../app-config";

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天，前端 localStorage 按 expiresAt 自行过期
const TOKEN_PREFIX = "v1";

/** 派生哈希:密码 → HMAC-SHA256(固定应用级盐)。设置页存的与签 token 用的都是它,
 *  明文永不离进程。同一派生即"改密码 → 全部旧 token 失效"的天然来源。 */
function deriveHash(password: string): string {
  return createHmac("sha256", "rikkahub-web-auth-v1").update(password).digest("hex");
}

function resolveCliPassword(): string | null {
  const eqArg = Bun.argv.find((arg) => arg.startsWith("--password="));
  if (eqArg) return eqArg.slice("--password=".length) || null;
  const flagIndex = Bun.argv.findIndex((arg) => arg === "--password");
  if (flagIndex >= 0 && Bun.argv[flagIndex + 1]) return Bun.argv[flagIndex + 1];
  return process.env.RIKKAHUB_PASSWORD || null;
}

// 部署者注入的明文密码(argv/env)。模块加载时解析一次(进程参数运行期不变);
// 存在则优先于设置页密码,且设置页对其只读(改密码需改部署配置)。
const cliPassword = resolveCliPassword();

/** 当前生效的派生哈希(签/验 token 的密钥源)。每次现读,支持设置页运行时改密。 */
function activeHash(): string | null {
  if (cliPassword != null) return deriveHash(cliPassword);
  const stored = state.settings?.webPasswordHash;
  return typeof stored === "string" && stored ? stored : null;
}

export function webAuthEnabled(): boolean {
  return activeHash() != null;
}

function signingKey(): Buffer {
  // 密钥直接从 activeHash(已是密码的派生)再派生,不反向暴露设置页存的哈希。
  return createHmac("sha256", "rikkahub-web-token-v1").update(activeHash() ?? "").digest();
}

function signPayload(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("hex");
}

function issueToken(): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = `${TOKEN_PREFIX}.${expiresAt}`;
  return { token: `${payload}.${signPayload(payload)}`, expiresAt };
}

function verifyToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) return false;
  const expected = signPayload(`${parts[0]}.${parts[1]}`);
  const given = parts[2];
  if (given.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}

// 暴力破解节流：60 秒窗口内 5 次失败后拒绝（429），窗口滑动重置。
// 全局而非按 IP——本服务常部署在反代/容器后，remote address 不可靠；
// 全局限速对单用户自用场景无感，对脚本爆破足够致命（约 7,200 次/天）。
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 5;
let failureWindowStart = 0;
let failureCount = 0;

function registerFailure(): void {
  const now = Date.now();
  if (now - failureWindowStart > FAILURE_WINDOW_MS) {
    failureWindowStart = now;
    failureCount = 0;
  }
  failureCount += 1;
}

function throttled(): boolean {
  return Date.now() - failureWindowStart <= FAILURE_WINDOW_MS && failureCount >= MAX_FAILURES_PER_WINDOW;
}

function constantDelay(): Promise<void> {
  // 恒定延迟：拉平正确/错误路径的响应时间差，同时给爆破脚本加成本。
  return new Promise((resolve) => setTimeout(resolve, 250));
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

/** 校验用户输入的明文密码是否命中当前生效密码(无论来自 argv/env 还是设置页)。 */
function passwordMatches(given: string): boolean {
  const active = activeHash();
  if (active == null) return false;
  return safeEqualHex(deriveHash(given), active);
}

/** POST /api/auth/token 处理器。未启用鉴权时也响应（明确告知无需密码），便于前端探测。 */
export async function handleAuthTokenRequest(request: Request): Promise<Response> {
  if (!webAuthEnabled()) {
    return error("Web authentication is not enabled on this server", 400);
  }
  if (throttled()) {
    return error("Too many failed attempts, try again later", 429);
  }
  const body = await readJson<{ password?: unknown }>(request);
  const given = typeof body.password === "string" ? body.password : "";
  if (!given || !passwordMatches(given)) {
    registerFailure();
    await constantDelay();
    return error("Invalid password", 401);
  }
  return json(issueToken());
}

/** /api/* 请求的鉴权检查。未启用时恒 true；auth/token 端点本身放行。 */
export function isWebAuthAuthorized(request: Request, url: URL): boolean {
  if (!webAuthEnabled()) return true;
  if (url.pathname === "/api/auth/token") return true;
  // 专题9 MCP OAuth:授权回调来自外部浏览器重定向,带不了应用 token。安全面:该路径只
  // 消费一次性 state(服务端内存校验)+授权码,不暴露任何用户数据。
  if (url.pathname === "/api/mcp/oauth/callback") return true;
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ") && verifyToken(authHeader.slice(7).trim())) return true;
  const queryToken = url.searchParams.get("access_token");
  if (queryToken && verifyToken(queryToken)) return true;
  return false;
}

// —— 设置页内置密码(P1,2026-09-19)——
// 此前密码只能经 --password/RIKKAHHUB_PASSWORD 在启动时注入,Docker 用户不知道要配、配错
// 也没反馈(唯一提示是容器日志里一条没人看的 warnIfExposedWithoutAuth)。这里把密码纳入
// 运行时设置:容器/对外部署的用户可在设置页直接设/改/清,无需改 docker run。

/** 设置页密码是否已配置(仅布尔,哈希本身不下发前端)。 */
export function webPasswordConfigured(): boolean {
  return activeHash() != null;
}

/** 下发前端前剥掉认证敏感字段。webPasswordHash 是认证者(非凭证):泄露它在暴力破解前
 *  即可冒充访问全部数据,代价高于 providers 的 apiKey(那些是凭证,本明文下发——可信本地
 *  UI 模型)。故 settings 的 GET/SSE 两个暴露面统一经此净化;state.json 与备份不受影响
 *  (它们读 state.settings 原值,不经这里)。 */
export function stripAuthSecrets<T>(settings: T): T {
  if (settings == null || typeof settings !== "object") return settings;
  const copy = { ...(settings as Record<string, unknown>) };
  delete copy.webPasswordHash;
  return copy as T;
}

/** 密码是否被部署者(argv/env)锁定——锁定时设置页只读,改密码须改部署配置。 */
export function webPasswordLockedByDeployment(): boolean {
  return cliPassword != null;
}

/**
 * POST /api/settings/web-password 处理器。body { currentPassword?, newPassword }。
 * newPassword 空串 = 清除密码(恢复无鉴权)。
 * 鉴权(防未授权者改/锁死服务):
 *   - 部署者锁定(argv/env) → 拒绝,只能在部署层改;
 *   - 已设密码 → 必须提供正确的 currentPassword;
 *   - 未设密码(容器首设) → 放行 currentPassword(这是设置入口本身)。
 * 改/清都会改 signingKey,旧 token 天然全失效。
 */
export async function handleSetWebPassword(request: Request): Promise<Response> {
  if (webPasswordLockedByDeployment()) {
    return error("访问密码由部署配置(--password / RIKKAHUB_PASSWORD)管理,请在部署层修改", 400);
  }
  const body = await readJson<{ currentPassword?: unknown; newPassword?: unknown }>(request).catch(
    () => ({}) as { currentPassword?: unknown; newPassword?: unknown },
  );
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : null;
  if (newPassword === null) return error("缺少 newPassword 字段", 400);

  if (webPasswordConfigured()) {
    // 已设密码:必须验旧。节流复用登录通道,防爆破旧密码。
    if (throttled()) return error("Too many failed attempts, try again later", 429);
    const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
    if (!current || !passwordMatches(current)) {
      registerFailure();
      await constantDelay();
      return error("当前密码不正确", 401);
    }
  }

  const trimmed = newPassword.trim();
  updateSettings({
    ...state.settings,
    webPasswordHash: trimmed === "" ? undefined : deriveHash(trimmed),
    // 口径对齐:webServerJwtEnabled 跟随"密码是否配置"(该字段本是遗留显示位,后端鉴权
    // 真正消费的是密码存在与否)。设/清密码时同步,前端"web 服务"状态显示不再失真。
    webServerJwtEnabled: trimmed !== "" || cliPassword != null,
  });
  return json({ status: "ok", configured: trimmed !== "" });
}

/** GET /api/web-auth/status 处理器:只回布尔,永不回哈希。供横幅与设置页状态卡判定,
 *  避免把敏感字段塞进 settings 广播面(settings 里 apiKey 等本明文下发——可信本地 UI
 *  模型;但密码哈希是认证者,泄露代价高于凭证,故走这个独立的非敏感端点)。 */
export function handleWebAuthStatus(): Response {
  return json({
    enabled: webAuthEnabled(),
    configured: webPasswordConfigured(),
    lockedByDeployment: webPasswordLockedByDeployment(),
  });
}

/** 启动时提示：绑定了非回环地址却没配密码 → 全部数据对同网络裸奔，必须让用户知道。 */
export function warnIfExposedWithoutAuth(bindHostname: string): void {
  const loopback = bindHostname === "127.0.0.1" || bindHostname === "localhost" || bindHostname === "::1";
  if (loopback || webAuthEnabled()) return;
  console.warn(
    "[security] 服务绑定在 " + bindHostname + " 且未设置访问密码：同一网络内任何设备都能读取全部会话与 API Key。" +
    "可在设置 → 数据中设置访问密码,或通过 --password <密码> / 环境变量 RIKKAHUB_PASSWORD 注入。",
  );
}
