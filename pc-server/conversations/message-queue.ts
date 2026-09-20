// conversations/message-queue.ts — 消息发送队列(生成中补发不打断,对齐 APP 2.5.0 MessageQueue / Codex 排队输入)
//
// 语义定稿(与产品决策一致,见 台账 §1.2):
//   - 队列里只压「待触发的生成」,用户消息本体在入队前已照常落库进会话历史(发送即持久化)。
//     故队列本体为纯内存态——重启后只丢「还没触发的生成」,消息内容零丢失,可手动 regenerate。
//     这与 Codex 的内存队列模型一致(Codex rollout 只持久化「已注入历史」的 item,不持久化队列本体)。
//   - 跨引擎统一:队列对引擎种类完全无感。它只在 generateAnswer 完成时由编排层派发下一条,
//     而 generateAnswer 是聊天/pi 唯一注册生成的入口——新增引擎自动继承,队列零改动。
//
// 终局三态(对齐 Codex ThreadIdleCause,2026-09-19 用户问题①):
//   Completed(正常完成)/ Failed(请求失败) → 收尾续跑派发(Failed 已被 pause 门控拦住,
//     语义=排队消息是失败恢复手段);Interrupted(用户 stop/打断) → 队列冻结(heldByInterrupt),
//     不点火、不 pause、不清空——用户按下停止的意图是「让这轮停」,队列自动接棒重跑一轮违背
//     该意图。恢复只有一个途径:用户显式操作(resume 端点/新消息/重新发送),对齐 Codex
//     on_thread_idle 对 cause==Interrupted 直接 return 的门控。任何会话写入口的 abort 接管
//     (send/regenerate/edit/删会话)同样 hold——它们都替换「用户主动打断当前流」的语义。
//
// 生命周期:入队/派发由编排层调 enqueueMessage / shiftNextQueued;失败自动 pause(保留全部项,
//   待用户 resume);用户打断自动 hold(保留全部项,resume 解除);会话删除/导入作废经
//   clearMessageQueue(挂 deleteConversationsById 收口)清除。
//   所有 mutation 由调用方负责随后 broadcastQueueState(SSE 快照直通,队列自身不发帧)。

import type { MessagePart } from "../foundation/types";
import { id } from "../foundation/utils";
import { textFromParts } from "../foundation/utils";
import { clearSteeringChannel } from "./steering-channel";

/** 单个排队项(引擎无关)。parts 即下一条 generateAnswer 的用户输入快照(入队时已不可变拷贝)。
 *  waitingReply:语音模式标记——派发此项生成后,需把该轮 assistant 文本经回复通道交付等待方。 */
export interface QueuedGeneration {
  id: string;
  parts: MessagePart[];
  createdAt: number;
  waitingReply?: boolean;
}

interface QueueState {
  items: QueuedGeneration[];
  /** 失败自动暂停:保留全部排队项,直到用户显式 resume。对齐 APP「失败自动暂停」。 */
  paused: boolean;
  /** 用户打断冻结(终局三态之 Interrupted):不派发不清空,区别于 paused(失败暂停)——
   *  快照对前端同一呈现(「已暂停,等用户操作」),但恢复语义分离:pause 等显式 resume,
   *  hold 同样等显式 resume(或下一条新消息直发时自然解除)。见文件头「终局三态」。 */
  heldByInterrupt: boolean;
}

/** 线上快照形状(SSE 帧 + 会话详情 DTO 共用;preview 由 parts 派生,前端直接渲染)。 */
export interface MessageQueueSnapshotItem {
  id: string;
  preview: string;
  hasAttachments: boolean;
  createdAt: number;
}

/** 队列停摆原因(线上快照字段;前端据此分态提示):
 *  - failed:上一条生成失败自动暂停——错误恢复语境,警示色 + 「继续发送」;
 *  - interrupted:用户主动停止后的打断冻结——用户自己的决定,不是故障,中性提示 + 「继续发送」。
 *  两者恢复动作同为 resume;paused(失败)优先呈现(需要用户知道出了错)。 */
export type MessageQueueHoldReason = "failed" | "interrupted";

export interface MessageQueueSnapshot {
  items: MessageQueueSnapshotItem[];
  /** null = 正常排队中(当前回复结束后自动依次发送)。 */
  held: MessageQueueHoldReason | null;
}

/** 会话级发送队列注册表(内存态,随 working-set 生命周期;不落库)。 */
const queues = new Map<string, QueueState>();

/** 语音模式回复通道:被派发排队的生成在收尾后,把该轮 assistant 文本 resolve 给等待方。
 *  键 = `${conversationId}:${queuedItemId}`(以排队项 id 为唯一凭据,派发即确定,不受期间
 *  其他消息影响)。仅语音模式注册;键盘走 SSE,不依赖此通道。值 null = 无回复可播报
 *  (空回复/失败/stop/被移除/清队列),语音模式据此跳过播报、直接重开麦。 */
const queuedReplyWaiters = new Map<string, (text: string | null) => void>();

function replyKey(conversationId: string, queuedItemId: string): string {
  return `${conversationId}:${queuedItemId}`;
}

/** 注册「等这条排队生成的回复文本」。返回 Promise,在收尾/移除/清队列时恰好 resolve 一次。 */
export function waitForQueuedReply(conversationId: string, queuedItemId: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    // 单等待方语义:同键重复注册时先释放旧的(resolve null),防泄漏。
    deliverQueuedReply(conversationId, queuedItemId, null);
    queuedReplyWaiters.set(replyKey(conversationId, queuedItemId), resolve);
  });
}

/** 收尾时交付回复文本(编排层成功路径调用);无等待方或重复交付皆幂等空操作。 */
export function deliverQueuedReply(conversationId: string, queuedItemId: string, text: string | null): void {
  const key = replyKey(conversationId, queuedItemId);
  const resolve = queuedReplyWaiters.get(key);
  if (!resolve) return;
  queuedReplyWaiters.delete(key);
  resolve(text && text.trim().length > 0 ? text : null);
}

function ensureQueue(conversationId: string): QueueState {
  let q = queues.get(conversationId);
  if (!q) {
    q = { items: [], paused: false, heldByInterrupt: false };
    queues.set(conversationId, q);
  }
  return q;
}

/** 入队一条待生成。parts 取不可变快照,防调用方后续改草稿污染队列(对齐 APP toList() 快照纪律)。 */
export function enqueueMessage(conversationId: string, parts: MessagePart[], opts?: { waitingReply?: boolean }): QueuedGeneration {
  const item: QueuedGeneration = { id: id(), parts: parts.map((p) => ({ ...p })), createdAt: Date.now(), waitingReply: opts?.waitingReply };
  ensureQueue(conversationId).items.push(item);
  return item;
}

/** 取出队首(不判 paused/占用——那是派发方的门控职责);队空返回 undefined。 */
export function shiftNextQueued(conversationId: string): QueuedGeneration | undefined {
  return queues.get(conversationId)?.items.shift();
}

export function isQueuePaused(conversationId: string): boolean {
  const q = queues.get(conversationId);
  return q?.paused ?? false;
}

/** 队列是否被「用户打断」冻结(终局三态之 Interrupted)。派发方门控用;
 *  与 paused 正交(一个管失败暂停、一个管打断冻结,任一置位都不派发)。 */
export function isQueueHeldByInterrupt(conversationId: string): boolean {
  const q = queues.get(conversationId);
  return q?.heldByInterrupt ?? false;
}

/** 用户打断当前生成时冻结队列(stop 端点/各写入口 abort 接管点调用)。保留全部排队项,
 *  不清空不点火——对齐 Codex Interrupted 终局不派发。无队列时也登记冻结(ensure 语义):
 *  stop 之后才入队的新消息同样被拦住——用户刚按下停止,静默期待不应被「后来的排队」
 *  打破;解冻途径同下(显式 resume/空闲直发)。 */
export function holdMessageQueue(conversationId: string): void {
  ensureQueue(conversationId).heldByInterrupt = true;
}

/** 解除打断冻结(不动 paused——失败暂停的解除仍走 resumeMessageQueue,语义分离)。 */
export function releaseMessageQueueHold(conversationId: string): void {
  const q = queues.get(conversationId);
  if (q) q.heldByInterrupt = false;
}

export function queueLength(conversationId: string): number {
  return queues.get(conversationId)?.items.length ?? 0;
}

export function hasQueuedMessages(conversationId: string): boolean {
  return queueLength(conversationId) > 0;
}

export function pauseMessageQueue(conversationId: string): void {
  ensureQueue(conversationId).paused = true;
}

export function resumeMessageQueue(conversationId: string): void {
  const q = queues.get(conversationId);
  if (q) {
    q.paused = false;
    // resume 是用户显式「继续」动作:失败暂停与打断冻结一并解除(对齐 Codex 队列
    // resume 的单入口——用户按了继续,没有理由再区分是哪种原因停的)。
    q.heldByInterrupt = false;
  }
}

/** 删除指定排队项;返回被删项(供调用方回收其不再被引用的附件),不存在返回 null。
 *  该项若有人在等回复(语音模式),resolve null —— 消息被撤回,无可播报。 */
export function removeQueuedMessage(conversationId: string, itemId: string): QueuedGeneration | null {
  const q = queues.get(conversationId);
  if (!q) return null;
  const idx = q.items.findIndex((it) => it.id === itemId);
  if (idx < 0) return null;
  const [removed] = q.items.splice(idx, 1);
  if (removed) deliverQueuedReply(conversationId, removed.id, null);
  return removed ?? null;
}

/** 就地更新排队项内容(编辑)。只换 parts,不动 FIFO 位次;不存在返回 false。 */
export function editQueuedMessage(conversationId: string, itemId: string, parts: MessagePart[]): boolean {
  const q = queues.get(conversationId);
  const item = q?.items.find((it) => it.id === itemId);
  if (!item) return false;
  item.parts = parts.map((p) => ({ ...p }));
  return true;
}

/** 清空会话队列(会话删除/导入作废时调用)。幂等。挂起的语音回复等待一并 resolve null。 */
export function clearMessageQueue(conversationId: string): void {
  queues.delete(conversationId);
  for (const [key, resolve] of Array.from(queuedReplyWaiters)) {
    if (key.startsWith(`${conversationId}:`)) {
      queuedReplyWaiters.delete(key);
      resolve(null);
    }
  }
  // steering 通道同会话一并作废(事实源已清,残留项会在排水时被 isStillQueued 滤掉,
  // 但直接清更干净——省一次必败的过滤)。
  clearSteeringChannel(conversationId);
}

/** 预览文本:取首段可见文本截断;无文本(纯附件)回退占位,前端按 hasAttachments 渲染 chip。 */
function previewOf(parts: MessagePart[]): string {
  const text = textFromParts(parts).replace(/\s+/g, " ").trim();
  return text.length > 120 ? text.slice(0, 120) + "…" : text;
}

function hasAttachments(parts: MessagePart[]): boolean {
  return parts.some((p) => p.type === "image" || p.type === "video" || p.type === "audio" || p.type === "document");
}

/** 生成线上快照(无队列返回 null,前端据此隐藏面板;不读则无副作用)。
 *  held 分态呈现停摆原因(见 MessageQueueHoldReason),恢复动作同为 resume。 */
export function queueSnapshotFor(conversationId: string): MessageQueueSnapshot | null {
  const q = queues.get(conversationId);
  if (!q || q.items.length === 0) return null;
  return {
    items: q.items.map((it) => ({
      id: it.id,
      preview: previewOf(it.parts),
      hasAttachments: hasAttachments(it.parts),
      createdAt: it.createdAt,
    })),
    held: q.paused ? "failed" : q.heldByInterrupt ? "interrupted" : null,
  };
}

/** 排队项被派发生成时回调(编排层注入,用于登记「该生成源自哪个排队项」)。仅语音模式
 *  走「排队 + 回复通道」需要;键盘排队不需要取回回复,回调可空。模块级单回调,避免循环依赖。 */
let queuedDispatchListener: ((conversationId: string, item: QueuedGeneration) => void) | null = null;
export function setOnQueuedGenerationDispatched(listener: ((conversationId: string, item: QueuedGeneration) => void) | null): void {
  queuedDispatchListener = listener;
}
export function notifyQueuedGenerationDispatched(conversationId: string, item: QueuedGeneration): void {
  queuedDispatchListener?.(conversationId, item);
}
