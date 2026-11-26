// pi-engine/session-view.ts — 会话视图 → pi 内存会话(重构方案 §5.4 / P3.3)
//
// 每轮由应用给的会话视图(host.session.load)重建 pi 会话,经 pi 自己的恢复路径装载:
// SessionManager.inMemory(cwd, {id}, entries) 在条目里没有会话头时按 id 生成头,叶 = 最后一条。
// 逐项规则:
// - 用户行恒由中立内容编码(context-encoder):用户输入每轮由应用物化。合成行(时间提醒、聊天位注入)
//   编码后不进会话条目,作为 syntheticRows 交给 runner,每次请求前插到锚点消息之前:注入不沉淀为引擎记忆,
//   会话跨轮复用(P5.6)时也不会因为注入位置随对话增长而移动就判为不一致;
// - 助手行带有效原生条目(应用已按摘要校验过)→ 原样取用;否则回退编码。原生组里刻意不取每轮
//   重建的东西:用户消息(由前面的中立行给出)、system 消息(系统提示词每轮由 resources 重建,见
//   model-bridge 的 supportsMidConvoSystemMessages)、模型与思考档位(由本轮授权给出)、分支摘要。
// - 压缩(P3.5):会话级 engineCompactions 决定是否压缩、切点在哪;原生压缩条目(details、用量、插件
//   标记)不在组内原位取用,只在配上生效记录时接到序列末尾,配不上则由记录重建。
// - 整组回退的情形:格式不识别、形状不对、组里没有助手消息,或原生内容与这一行的引擎可见文本不一致
//   ——应用对助手内容的改写(输出变换、消息模板)要让模型看到改写后的内容,与保真注解失配同一语义。
// - 条目 id:原生条目保留自身 id,回退条目由消息 id 确定性派生。整条序列按视图顺序重连成线性链
//   (pi 一轮内的会话本就是线性的)。
// pi 会话 id = 应用会话 id:prompt_cache_key 与会话亲和头跨轮稳定(§4.5)。
//
// 写路径(P3.4,createPiEntrySync):装载之后 pi 新增的条目经 host.session.append 交给应用,锚定由
// 应用按当前落点决定。pi 的追加大多不发 entry_appended(message_end 落库、模型/档位变更、压缩都不发),
// 所以按 getEntries() 与已交出的 id 对账:条目只追加、id 唯一,对账是精确的。每轮重建的条目不写
// (装载时同样剔除;用户消息还带着图片原文)。压缩条目要写:生成中的自动压缩随本轮落点,手动压缩
// 由应用锚定到当时的尾消息。

import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  assertValidSessionId,
  type CompactionEntry,
  type NewSessionOptions,
  type SessionEntry,
} from "../../pi/packages/coding-agent/src/core/session-manager.ts";
import type { EngineCompactionRecord, EngineEntryInput, EngineSessionItem, EngineSessionView } from "../engines/contract";
import type { JsonValue, Message } from "../foundation/types";
import { isRecord } from "../foundation/utils";
import type { AgentMessage } from "../../pi/packages/agent/src/types.ts";
import type { Message as PiAgentMessage } from "../../pi/packages/ai/src/types.ts";
import { encodeNeutralMessage } from "./context-encoder";

/** pi 原生条目的格式版本(EngineEntryInput.format)。随 pi 会话版本走:pi 升级改了条目形状时
 *  旧条目不再被识别,整组回退一次。 */
export const PI_ENTRY_FORMAT = `pi-session-v${CURRENT_SESSION_VERSION}`;

/** 逐请求注入的合成行(时间提醒、聊天位注入):不进会话条目,每次请求前插到锚点消息之前。 */
export interface PiSyntheticRows {
  /** 插在这条应用消息的首条模型可见消息之前;null = 插在本轮起始消息(本轮用户输入)之前。 */
  beforeMessageId: string | null;
  messages: PiAgentMessage[];
}

export interface PiSessionFromView {
  manager: SessionManager;
  /** 消息 id → 它在会话里的条目 id(压缩切点映射、合成行锚点用;合成行不在内)。 */
  entryIdsByMessageId: Map<string, string[]>;
  /** 走了 legacy 退化的助手行(诊断;合成行不在内,legacy 是它们的设计路径)。 */
  degradedMessageIds: string[];
  syntheticRows: PiSyntheticRows[];
}

function isEntryShape(payload: unknown): boolean {
  if (!isRecord(payload) || typeof payload.type !== "string" || payload.type === "session") return false;
  if (typeof payload.id !== "string" || !payload.id) return false;
  if (payload.type !== "message") return true;
  const message = payload.message;
  return isRecord(message) && typeof message.role === "string" && (message.role !== "assistant" || Array.isArray(message.content));
}

function rebuiltEachTurn(entry: SessionEntry): boolean {
  switch (entry.type) {
    case "branch_summary":
    case "model_change":
    case "thinking_level_change":
      return true;
    case "message":
      return entry.message.role === "user" || entry.message.role === "system";
    default:
      return false;
  }
}

/** 组里的原生压缩条目。不放回组内原位:压缩以会话级记录为准,配上对的才在序列末尾取用。 */
function nativeCompactionsOf(item: EngineSessionItem): CompactionEntry[] {
  if (item.synthetic || !item.native) return [];
  return item.native.flatMap((raw) =>
    raw.format === PI_ENTRY_FORMAT && isEntryShape(raw.payload) && (raw.payload as { type: string }).type === "compaction"
      ? [raw.payload as unknown as CompactionEntry]
      : [],
  );
}

/** 原生助手消息的文本、思考与工具调用序列是否就是这一行(富化后)的内容。流式增量逐字并进 parts,
 *  未经改写时两边拼起来逐字相等;redacted 思考没有增量,不参与比较。 */
function matchesNeutral(entries: readonly SessionEntry[], message: Message): boolean {
  const native = { text: "", reasoning: "", tools: [] as string[] };
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const block of entry.message.content) {
      if (block.type === "text") native.text += block.text;
      else if (block.type === "thinking" && !block.redacted) native.reasoning += block.thinking;
      else if (block.type === "toolCall") native.tools.push(block.id);
    }
  }
  const neutral = { text: "", reasoning: "", tools: [] as string[] };
  for (const part of message.parts) {
    if (part.type === "text") neutral.text += part.text;
    else if (part.type === "reasoning") neutral.reasoning += part.reasoning;
    else if (part.type === "tool") neutral.tools.push(part.toolCallId);
  }
  return (
    native.text === neutral.text &&
    native.reasoning === neutral.reasoning &&
    native.tools.length === neutral.tools.length &&
    native.tools.every((id, index) => id === neutral.tools[index])
  );
}

/** 可取用的原生条目;null = 该项走回退编码。 */
function nativeEntriesOf(item: EngineSessionItem): SessionEntry[] | null {
  if (item.synthetic || item.message.role !== "ASSISTANT" || !item.native?.length) return null;
  const entries: SessionEntry[] = [];
  for (const raw of item.native) {
    if (raw.format !== PI_ENTRY_FORMAT || !isEntryShape(raw.payload)) return null;
    const entry = raw.payload as unknown as SessionEntry;
    if (entry.type !== "compaction" && !rebuiltEachTurn(entry)) entries.push(entry);
  }
  const hasAssistant = entries.some((entry) => entry.type === "message" && entry.message.role === "assistant");
  return hasAssistant && matchesNeutral(entries, item.message) ? entries : null;
}

function fallbackEntriesOf(item: EngineSessionItem, fallbackModelId: string): { entries: SessionEntry[]; degraded: boolean } {
  const { message } = item;
  const { messages, degraded } = encodeNeutralMessage(message, item.input, fallbackModelId);
  const entries = messages.map((piMessage, index): SessionEntry => ({
    type: "message",
    id: `${message.id}:${index}`,
    parentId: null,
    timestamp: message.createdAt,
    message: piMessage,
  }));
  return { entries, degraded };
}

/** pi 会话 id 取应用会话 id。不合 pi 的 id 规则时(应用的 UUID 恒合规)退回 pi 生成的随机 id:
 *  只是缓存键与亲和头不再跨轮稳定,生成照常。 */
function sessionOptionsFor(conversationId: string): NewSessionOptions | undefined {
  try {
    assertValidSessionId(conversationId);
    return { id: conversationId };
  } catch {
    return undefined; // 不合规则:按上面的注释退回随机 id
  }
}

/** 压缩:取切点仍在场的最新记录。firstKept 指向"切点行之前、不可吸收的开头段"之后的第一个条目,
 *  而非恒等于序列首条目:
 *  - 生产路径:富化窗口锚(windowStartMessageId)已把切点前的真实历史挡在视图外,窗口内排在切点行
 *    之前的只可能是 top_of_chat 注入/首条时间提醒(配置快照,必须留在可见区),所以有合成行时
 *    firstKept 取序列首条目;
 *  - 无合成行的视图(手动压缩、测试直灌):切点前的真实历史在序列里,理应被摘要吸收,firstKept 取
 *    切点行的首条目。
 *  生效判定与应用侧 effectiveEngineCompaction(conversations/engine-compactions)必须一致,由
 *  context-encoder.test.ts 锁定。 */
function applicableCompaction(
  compactions: readonly EngineCompactionRecord[],
  entryIdsByMessageId: ReadonlyMap<string, string[]>,
  firstEntryId: string | null,
  hasSynthetic: boolean,
): { record: EngineCompactionRecord; firstKeptEntryId: string } | null {
  const record = compactions.filter((item) => entryIdsByMessageId.has(item.cutMessageId)).at(-1);
  if (!record) return null;
  const cutEntryIds = entryIdsByMessageId.get(record.cutMessageId)!;
  const boundary = hasSynthetic ? firstEntryId : cutEntryIds[0];
  return { record, firstKeptEntryId: boundary ?? cutEntryIds[0]! };
}

/** 视图 → 装载好的 pi 内存会话。视图不含本轮新用户输入(那条走 session.prompt)。 */
export function createPiSessionFromView(options: {
  cwd: string;
  conversationId: string;
  view: EngineSessionView;
  /** legacy 行缺 modelId 时 AssistantMessage.model 的占位(会话模型 id)。 */
  fallbackModelId: string;
}): PiSessionFromView {
  const { view, fallbackModelId } = options;
  const entries: SessionEntry[] = [];
  const entryIdsByMessageId = new Map<string, string[]>();
  const degradedMessageIds: string[] = [];
  const syntheticRows: PiSyntheticRows[] = [];
  let pendingSynthetic: PiAgentMessage[] = [];
  for (const item of view.items) {
    if (item.synthetic) {
      pendingSynthetic.push(...encodeNeutralMessage(item.message, item.input, fallbackModelId).messages);
      continue;
    }
    let group = nativeEntriesOf(item);
    if (!group) {
      const fallback = fallbackEntriesOf(item, fallbackModelId);
      group = fallback.entries;
      if (fallback.degraded) degradedMessageIds.push(item.message.id);
    }
    for (const entry of group) entries.push({ ...entry, parentId: entries.at(-1)?.id ?? null });
    if (group.length === 0) continue;
    entryIdsByMessageId.set(item.message.id, group.map((entry) => entry.id));
    if (pendingSynthetic.length > 0) {
      syntheticRows.push({ beforeMessageId: item.message.id, messages: pendingSynthetic });
      pendingSynthetic = [];
    }
  }
  if (pendingSynthetic.length > 0) syntheticRows.push({ beforeMessageId: null, messages: pendingSynthetic });
  // 压缩接在序列末尾(上下文与放在原位相同:摘要 + firstKept 起的条目)。生效的记录配得上原生条目
  // (摘要与压缩前用量相同)→ 原样取用(id、时间戳、details、用量都在),只按上面的规则重定 firstKept;
  // 否则由记录重建。
  const compaction = applicableCompaction(view.compactions, entryIdsByMessageId, entries[0]?.id ?? null, view.items.some((item) => item.synthetic));
  const native = compaction
    ? view.items.flatMap(nativeCompactionsOf).findLast((entry) => entry.summary === compaction.record.summary && entry.tokensBefore === compaction.record.tokensBefore)
    : undefined;
  if (compaction && native) entries.push({ ...native, parentId: entries.at(-1)?.id ?? null, firstKeptEntryId: compaction.firstKeptEntryId });
  const manager = SessionManager.inMemory(options.cwd, sessionOptionsFor(options.conversationId), entries);
  if (compaction && !native) manager.appendCompaction(compaction.record.summary, compaction.firstKeptEntryId, compaction.record.tokensBefore);
  return { manager, entryIdsByMessageId, degradedMessageIds, syntheticRows };
}

function visibleMessagesOf(messages: readonly AgentMessage[]): string {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const { timestamp: _timestamp, ...rest } = message as AgentMessage & { timestamp?: number };
      return JSON.stringify(rest);
    })
    .join("\n");
}

/** 活会话能否接着用(P5.6):把视图重建出的会话与活会话按模型可见的消息逐条比对。相同就接着用;任何不同
 *  (编辑、重新生成、分支切换、没封存的中止或失败轮次、别的引擎写的回答、压缩)都重建。比对忽略 system 消息
 *  (系统提示词由资源给出)、时间戳(不进请求)、不产生消息的条目,以及活会话里还没交给应用的条目(轮次之间
 *  插件追加的,下一轮第一次对账时交出)。返回 重建会话条目 id → 活会话条目 id;不能接着用时为 null。 */
export function matchLiveSession(live: SessionManager, fresh: SessionManager, pending: ReadonlySet<string>): Map<string, string> | null {
  const rows = (manager: SessionManager, skip?: ReadonlySet<string>) =>
    manager.buildSessionProjection().entries.flatMap((entry) => {
      if (skip?.has(entry.sourceEntry.id)) return [];
      const visible = visibleMessagesOf(entry.messages);
      return visible ? [{ id: entry.sourceEntry.id, visible }] : [];
    });
  const liveRows = rows(live, pending);
  const freshRows = rows(fresh);
  if (liveRows.length !== freshRows.length) return null;
  const mapping = new Map<string, string>();
  for (const [index, row] of freshRows.entries()) {
    const other = liveRows[index]!;
    if (row.visible !== other.visible) return null;
    mapping.set(row.id, other.id);
  }
  return mapping;
}

/** 一轮的合成行插入计划。按消息对象定位:会话条目里的 message 条目的消息对象就是投影与请求里的那个对象
 *  (custom_message 等每次投影新建对象的条目不能当锚点)。 */
export interface PiSyntheticPlan {
  before: Map<object, AgentMessage[]>;
  /** 插在本轮之前的历史之后(本轮起始消息可能是插件消息,每次投影都是新对象,所以按「前一条」定位)。 */
  atTurnStart: AgentMessage[];
  /** 本轮开始前最后一条 message 条目的消息对象;null = 本轮之前没有历史,插在开头的 system 消息之后。 */
  after: object | null;
}

export const EMPTY_SYNTHETIC_PLAN: PiSyntheticPlan = { before: new Map(), atTurnStart: [], after: null };

/** 在本轮开跑之前调用(after 取此刻会话的最后一条 message 条目)。entryIdsOf:应用消息 id → 它在这个
 *  会话里的条目 id(接着用的活会话要先换成活会话的 id)。锚点找不到(不该发生)的行并到本轮之前,
 *  宁可错位也不丢。 */
export function planSyntheticRows(
  manager: SessionManager,
  rows: readonly PiSyntheticRows[],
  entryIdsOf: (messageId: string) => readonly string[] | undefined,
): PiSyntheticPlan {
  const last = manager.getEntries().findLast((entry) => entry.type === "message");
  const plan: PiSyntheticPlan = { before: new Map(), atTurnStart: [], after: last?.type === "message" ? last.message : null };
  for (const row of rows) {
    const anchor = row.beforeMessageId
      ? entryIdsOf(row.beforeMessageId)
          ?.map((entryId) => manager.getEntry(entryId))
          .find((entry) => entry?.type === "message")
      : undefined;
    if (anchor?.type === "message") plan.before.set(anchor.message, [...(plan.before.get(anchor.message) ?? []), ...row.messages]);
    else plan.atTurnStart.push(...row.messages);
  }
  return plan;
}

/** 每次请求前把合成行插进上下文(不改会话条目)。本轮之前的那条消息找不到时,起始那批放在末尾;
 *  锚点不在本次上下文里的行(不该发生)并进起始那批,宁可错位也不丢。 */
export function injectSyntheticRows(messages: readonly AgentMessage[], plan: PiSyntheticPlan): AgentMessage[] {
  if (plan.before.size === 0 && plan.atTurnStart.length === 0) return [...messages];
  const present = new Set<object>(messages);
  const orphans = [...plan.before].flatMap(([anchor, rows]) => (present.has(anchor) ? [] : rows));
  const atTurnStart = [...orphans, ...plan.atTurnStart];
  const out: AgentMessage[] = [];
  let placed = atTurnStart.length === 0;
  let rest = messages;
  if (!placed && plan.after === null) {
    const head = messages.findIndex((message) => message.role !== "system");
    const split = head === -1 ? messages.length : head;
    out.push(...messages.slice(0, split), ...atTurnStart);
    placed = true;
    rest = messages.slice(split);
  }
  for (const message of rest) {
    const rows = plan.before.get(message);
    if (rows) out.push(...rows);
    out.push(message);
    if (!placed && message === plan.after) {
      out.push(...atTurnStart);
      placed = true;
    }
  }
  if (!placed) out.push(...atTurnStart);
  return out;
}

/** pi 条目 → 交给应用的条目(载荷即条目本身)。压缩条目去掉 systemMessage:那是压缩时刻系统提示词的
 *  快照,而系统提示词每轮重建(与不存 system 消息同理;由记录重建的压缩也不带它)。 */
export function toPiEngineEntry(entry: SessionEntry): EngineEntryInput {
  let payload: SessionEntry = entry;
  if (entry.type === "compaction") {
    const { systemMessage: _snapshot, ...rest } = entry;
    payload = rest;
  }
  return { format: PI_ENTRY_FORMAT, entryId: entry.id, payload: payload as unknown as JsonValue };
}

export interface PiEntrySync {
  /** 立即交出上次以来的新条目(应用在收到时按当时的落点锚定,所以必须在补发换绑之前调用)。
   *  返回的 Promise 在已交出的各批都送达后兑现,从不拒绝。 */
  flush(): Promise<void>;
  /** 还没交出的条目 id(会话跨轮复用时,轮次之间插件追加的条目要到下一轮的对账才交出)。 */
  undelivered(): Set<string>;
}

/** 在会话装载完成之后创建:此刻已有的条目(视图装载的、压缩重放的)视为已在存储里,pending 里的除外
 *  (接着用的会话在轮次之间由插件追加、还没交出的条目,本轮交出)。送达失败经 onError 报一次;应用侧
 *  不封存写失败的锚定,那条消息下一轮走回退编码。 */
export function createPiEntrySync(
  manager: SessionManager,
  append: (entries: EngineEntryInput[]) => Promise<void>,
  onError: (error: unknown) => void,
  pending: ReadonlySet<string> = new Set(),
): PiEntrySync {
  const known = new Set(manager.getEntries().flatMap((entry) => (pending.has(entry.id) ? [] : [entry.id])));
  let delivered: Promise<void> = Promise.resolve();
  let reported = false;
  return {
    flush() {
      const fresh = manager.getEntries().filter((entry) => !known.has(entry.id));
      for (const entry of fresh) known.add(entry.id);
      const batch = fresh.filter((entry) => !rebuiltEachTurn(entry)).map(toPiEngineEntry);
      if (batch.length > 0) {
        const sent = append(batch).catch((error: unknown) => {
          if (reported) return;
          reported = true;
          onError(error);
        });
        delivered = Promise.all([delivered, sent]).then(() => undefined);
      }
      return delivered;
    },
    undelivered() {
      return new Set(manager.getEntries().flatMap((entry) => (known.has(entry.id) ? [] : [entry.id])));
    },
  };
}
