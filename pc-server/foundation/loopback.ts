// foundation/loopback.ts — 「仅本机」主机名判定的单一来源(纯函数,零依赖)
//
// 被 port-binding(绑定策略)与 origin-relay(界面 origin 接力)共用;后者还会被 web-ui
// 经 @server 别名打进浏览器包(其 tsconfig 无 Bun 类型),故本模块必须与一切 Bun/node
// 运行时引用隔离——只准字符串与 URL 语义。

/** 回环意图下的绑定组。首个为主地址:OS 分配端口时由它取号,退化兜底时只留它。 */
export const LOOPBACK_GROUP = ["127.0.0.1", "::1"] as const;

/** 「仅本机」意图的三种写法(含 URL 里带方括号的 IPv6 形态),大小写不敏感。 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}
