// 下划线开头的文件不会被 Pages 注册为路由,专放跨端点共享的小工具。

export const AUTH_COOKIE = "dash_auth";

// 鉴权:URL token(curl / 首次进入)或 HttpOnly cookie(dashboard 下发)二选一。
// cookie 值就是 AUTH_TOKEN 本身——单管理员场景不需要会话表,泄露面等同 token。
export function isAuthorized(context: { env: { AUTH_TOKEN?: string }; request: Request }, url: URL): boolean {
  const secret = context.env.AUTH_TOKEN;
  if (!secret) return false; // 未配置一律拒绝,fail-closed
  if (url.searchParams.get("token") === secret) return true;
  const cookies = context.request.headers.get("Cookie") ?? "";
  return cookies.split(";").some((c) => c.trim() === AUTH_COOKIE + "=" + secret);
}

export function authCookie(secret: string): string {
  // 30 天;SameSite=Strict 下第三方页面无法携带,Secure 仅 https(pages.dev 恒为 https)。
  return `${AUTH_COOKIE}=${secret}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`;
}

// YYYY-MM-DD 既要格式对、也要是真实日历日期(堵 2026-13-45 / 02-30 这类)。
export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// 日期字符串加减天数(全程 UTC,避免本地时区污染 "YYYY-MM-DD")。
export function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
