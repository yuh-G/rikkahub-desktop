// api/net-context.ts — 每请求网络上下文(回环判定)。
//
// server-main.ts 在 serve fetch 里标记(只有那里拿得到 server.requestIP),handler 层按需查询,
// 避免为个别端点改动 routeApi 与全部 handler 的签名。WeakSet 键住 Request 对象本身,
// 生命周期与请求同长,零泄漏。
//
// 判定语义与 /api/app/shutdown 的回环闸一致(R5-1 教训):带代理转发头的请求一律不算本机
// ——本机反代(nginx/caddy)会把远程请求的 remote address 洗成 127.0.0.1,而 Tauri 壳与
// 本机 UI 都直连 Bun 端口、绝不经代理。

const loopbackRequests = new WeakSet<Request>();

export function isLoopbackAddress(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function hasProxyForwardHeaders(request: Request): boolean {
  return request.headers.has("x-forwarded-for") || request.headers.has("x-real-ip") || request.headers.has("forwarded");
}

/** serve fetch 侧标记:remote address 为回环且无代理转发头才算本机直连。 */
export function markRequestNetworkContext(request: Request, remoteAddress: string): void {
  if (isLoopbackAddress(remoteAddress) && !hasProxyForwardHeaders(request)) {
    loopbackRequests.add(request);
  }
}

/** 本请求是否来自本机直连(Tauri 壳/本机浏览器)。"仅限本机"端点(如 data/export/to-path
 *  向宿主任意路径写文件)以此为闸。 */
export function isLoopbackRequest(request: Request): boolean {
  return loopbackRequests.has(request);
}
