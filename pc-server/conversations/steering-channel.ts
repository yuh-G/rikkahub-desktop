// conversations/steering-channel.ts — 生成中用户消息的「下一请求边界」注入通道(steering)
//
// 对齐 Codex 的 start_or_steer_turn / pending_input 语义(用户问题②,2026-09-19):
// 模型正在工作(思考/搜索/工具循环)时用户补发的新 prompt,期待的不是「等全部完成后
// 作为独立新一轮」,而是「模型完成当前动作、构建下一个模型请求之前」送达——及时
// 增补意图或背景,模型在当前任务中途就能看到。
//
// 落地形态(引擎无关通道 + 两个引擎各自的注入实现):
//   - 聊天引擎:runStreamingToolLoop 的轮边界(工具批执行完、encodeNextTurn 之后、
//     下一次 fetchRound 之前)经 drainSteeringMessages 取出,把排队消息编码成 user
//     turn 追加进请求体(三家 Provider 的 body 形态由注入回调处理)。
//   - pi 引擎:runPiWorkspaceGeneration 驱动 pi 原生 session.steer()(agent-loop 在
//     当前轮工具执行完后、下一次 LLM 调用前排水 steering 队列,语义逐字一致)。
//
// 与消息发送队列(FIFO 保底派发)的关系:queue/enqueue 生成中入队时同步推送本通道
// 一份——队列仍是「事实源」(用户可改/撤/看序),steering 只是「及时性通道」。消息被
// 注入引擎后由注入方按 item.id 回调 consumeSteering 通知队列移除对应项(已注入≠待
// 触发,不派发);消息在注入前被撤回/编辑,下次排水时 id 已不在队列 → 丢弃。
//
// 生命周期:纯内存、per-conversation。生成收尾未注入的残留(引擎无轮边界可注入:纯
// 文本流、pi 不可用回落等)自动作废——FIFO 队列还留着同一条消息,收尾派发兜底,零丢失。
import type { MessagePart } from "../foundation/types";
import { textFromParts } from "../foundation/utils";

interface SteeringItem {
  /** 与 FIFO 队列项同 id(事实源联动键)。 */
  id: string;
  parts: MessagePart[];
}

const channels = new Map<string, SteeringItem[]>();

/** 生成中入队时同步推送一份到 steering 通道(在 queue/enqueue 端点调用)。
 *  纯附件(无文本)的补发不进通道:steering 注入面是 user turn 文本,塞不进图片;它留在
 *  FIFO 队列由收尾派发走完整的多模态发送路径,零丢失。由此保证不变式「排水命中 ⟺
 *  有可注入文本」——引擎侧「注入即分段」的判定只需看返回数组非空。 */
export function pushSteeringMessage(conversationId: string, itemId: string, parts: MessagePart[]): void {
  if (textFromParts(parts).trim().length === 0) return;
  let ch = channels.get(conversationId);
  if (!ch) {
    ch = [];
    channels.set(conversationId, ch);
  }
  // 幂等:同 id 重复推送(防御)只留最新内容。
  const idx = ch.findIndex((it) => it.id === itemId);
  const item: SteeringItem = { id: itemId, parts: parts.map((p) => ({ ...p })) };
  if (idx >= 0) ch[idx] = item;
  else ch.push(item);
}

/** 引擎轮边界取走全部待注入消息(取走即出通道)。仍留在 FIFO 队列里的项才注入
 *  (isStillQueued 由调用方注入,检查事实源;被撤回/编辑的排队项不注入)。
 *  返回数组按推送序排列;注入方逐条回 consume 回调通知队列移除。 */
export function drainSteeringMessages(
  conversationId: string,
  isStillQueued: (itemId: string) => boolean,
): SteeringItem[] {
  const ch = channels.get(conversationId);
  if (!ch || ch.length === 0) return [];
  const taken = ch.splice(0, ch.length);
  // 事实源过滤:排队项已不在 FIFO 队列(撤回/编辑重建/清队列)→ 不注入。整批都被
  // 撤走时返回空,taken 也无需回灌(它们的事实源副本已消亡)。
  return taken.filter((it) => isStillQueued(it.id));
}

/** 按 id 移出通道(排队项被编辑时调用——通道持旧内容快照,注入旧文不如不注入;
 *  撤回路径无需调用:排水时的 isStillQueued 过滤已兜)。 */
export function removeSteeringMessage(conversationId: string, itemId: string): void {
  const ch = channels.get(conversationId);
  if (!ch) return;
  const idx = ch.findIndex((it) => it.id === itemId);
  if (idx >= 0) ch.splice(idx, 1);
}

/** 生成收尾/会话清理时丢弃未注入的残留(FIFO 队列仍是事实源,派发兜底,零丢失)。 */
export function clearSteeringChannel(conversationId: string): void {
  channels.delete(conversationId);
}
