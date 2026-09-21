// lib/id.ts — 唯一 ID 生成(secure-context 治本,issue #55/#56)
//
// crypto.randomUUID 只在安全上下文(HTTPS / localhost)可用。Docker 经裸 IP(http://<VPS>:8080)
// 访问时为非安全上下文,randomUUID 是 undefined —— 此前 20 处裸调全部抛 TypeError,设置页
// 「添加助手/供应商/搜索/MCP」一点就崩。统一走本函数:randomUUID 可用则用,否则 getRandomValues
// (insecure context 仍可用)手拼 RFC4122 v4,再兜底 Math.random(碰撞概率可接受,仅作前端临时 id)。

/** 生成 RFC4122 v4 形态的 UUID 字符串;任何浏览器上下文(含非安全)都可用。 */
export function createId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  if (typeof c?.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
