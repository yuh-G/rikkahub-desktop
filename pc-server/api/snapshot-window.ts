// api/snapshot-window.ts — 会话快照窗口化(专题2 I-2,纯函数,单测覆盖)
//
// 问题:快照帧(开流首帧 + broadcastConversation)始终携带整个会话。几百上千节点的
// 大会话快照可达 10MB+,且**每轮生成结束**都全量重播一次——传输体积与会话规模成正比,
// I-1 协商只救了"切走再切回未变化"的场景,救不了"正在大会话里聊天"。
//
// 解法:快照只带最近 SNAPSHOT_NODE_WINDOW 个节点(nodesOffset = 首个携带节点的绝对
// 下标),同时附带**全部**节点的内容戳清单 nodeStamps(每节点一个 wyhash64 短串,
// 千节点约 10KB)。客户端用清单做"可验证前缀合并":已加载的更早节点逐个比对内容戳,
// 一致才保留,不一致即丢弃(向上滚动时经 nodes 分片端点重拉)——永不猜测,失配只
// 退化为一次重拉,不会画错。老节点的内容变化(翻译/编辑/分支切换)由按 id 寻址的
// node_update 帧携带新 stamp 送达,客户端同步更新清单,保证清单始终反映本地真实版本。
//
// 节点数 ≤ 窗口的会话(绝大多数)nodesOffset=0、messages 完整,除多出 stamp 清单外
// 与旧行为逐字节一致——风险被约束在巨型会话内。
import { toMessageNodeDtos } from "../conversations";
import { queueSnapshotFor } from "../conversations/message-queue";
import type { Conversation, MessageNode } from "../foundation/types";
import type { ConversationDto } from "../foundation/types/dto";

/** 快照携带的节点窗口大小。环境变量仅供冒烟/联调用小窗口触发分页路径。 */
export const SNAPSHOT_NODE_WINDOW = (() => {
  const raw = Number(process.env.RIKKA_SNAPSHOT_NODE_WINDOW ?? "");
  return Number.isInteger(raw) && raw >= 2 ? raw : 60;
})();

/**
 * 节点内容戳:整节点 JSON 的 wyhash64(Bun 原生,GB/s 级)。任何用户可见变化
 * (分支增删、selectIndex、parts 内容、翻译、finishedAt...)都会改变它。
 * 键序对同一内存实例稳定;编辑等路径重建对象即使语义等价也可能变戳——代价只是
 * 客户端保守丢弃前缀后重拉,不影响正确性。
 */
export function nodeStamp(node: MessageNode): string {
  return Bun.hash.wyhash(JSON.stringify(node)).toString(36);
}

/**
 * 构造快照 DTO:窗口化 messages + 全量 nodeStamps 清单。
 * windowNodes = Infinity 时退化为"全量 + 清单"(REST 详情端点用,导出/轮询兜底
 * 依赖完整数据)。
 */
export function toSnapshotConversationDto(
  conversation: Conversation,
  isGenerating: boolean,
  windowNodes: number = SNAPSHOT_NODE_WINDOW,
): ConversationDto {
  const total = conversation.messages.length;
  const offset = Math.max(0, total - windowNodes);
  return {
    ...conversation,
    messages: toMessageNodeDtos(offset === 0 ? conversation.messages : conversation.messages.slice(offset)),
    isGenerating,
    nodesOffset: offset,
    nodeStamps: conversation.messages.map(nodeStamp),
    // 消息发送队列快照(内存态,瞬时不落库):生成中补发排队的面板数据源。队空为 null。
    messageQueue: queueSnapshotFor(conversation.id),
  };
}
