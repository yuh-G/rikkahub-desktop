// api/snapshot-negotiation.ts — 会话快照协商令牌(专题2 I-1,纯函数,单测覆盖)
//
// 问题:会话 SSE 每次连接(切换会话、重连)首帧无条件推全量快照;大会话(10MB 级)
// 在"切走再切回"这类内容根本没变的场景里也要整体序列化 + 传输 + 解析 + 整树替换。
//
// 解法:服务端在每个 snapshot 帧携带不透明协商令牌;客户端重开流时把缓存快照对应的
// 令牌原样带上(?token=),服务端比对当前令牌——一致则首帧只发轻量 snapshot_meta
// (客户端继续用缓存),不一致则照常发全量快照。客户端不解释令牌内容。
//
// 令牌 = `${updateAt}:${结构指纹}`。updateAt 是主判据(任何内容变更都会 bump);
// 结构指纹(FNV-1a 遍历节点/消息/各 part 文本长度等,O(结构) 与文本长度无关)封堵
// 同毫秒两次变更导致 updateAt 相同而内容不同的碰撞窗口。指纹覆盖不到的极端碰撞
// (同毫秒 + 等长原位改写)概率趋零,且任何后续变更即自愈——数据本身永远无风险,
// 代价上限是一次陈旧视图。

import type { Conversation } from "../foundation/types";
import { queueSnapshotFor } from "../conversations/message-queue";

/** FNV-1a 32 位,增量喂入字符串。 */
function fnv1a(hash: number, text: string): number {
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export function conversationNegotiationToken(conversation: Conversation): string {
  let h = 0x811c9dc5;
  h = fnv1a(h, conversation.title);
  h = fnv1a(h, conversation.systemPrompt ?? "\u0000");
  h = fnv1a(h, `${conversation.isPinned ? 1 : 0}|${conversation.chatSuggestions.length}|${conversation.messages.length}`);
  for (const node of conversation.messages) {
    h = fnv1a(h, `${node.id}|${node.selectIndex}|${node.messages.length}`);
    for (const msg of node.messages) {
      h = fnv1a(h, `${msg.id}|${msg.parts.length}|${msg.finishedAt ?? ""}|${msg.translation?.length ?? -1}`);
      for (const part of msg.parts) {
        if (!part || typeof part !== "object") continue;
        const textLen =
          part.type === "text" && typeof part.text === "string"
            ? part.text.length
            : part.type === "reasoning" && typeof part.reasoning === "string"
              ? part.reasoning.length
              : -1;
        h = fnv1a(h, `${String(part.type ?? "")}:${textLen}`);
      }
    }
  }
  // 消息发送队列(内存态)不计入内容戳,但它的变化(入队/派发/暂停)必须让缓存令牌失效——
  // 否则切走再切回时 snapshot_meta 协商命中缓存,队列面板拿到陈旧快照。把队列签名并进令牌。
  const queue = queueSnapshotFor(conversation.id);
  h = fnv1a(h, queue ? `${queue.items.length}|${queue.held ?? "-"}|${queue.items.map((i) => i.id).join(",")}` : "∅");
  return `${conversation.updateAt}:${h.toString(36)}`;
}
