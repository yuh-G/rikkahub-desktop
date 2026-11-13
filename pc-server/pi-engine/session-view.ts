// pi-engine/session-view.ts — 会话视图 → pi 内存会话(重构方案 §5.4 / P3.3)
//
// 每轮由应用给的会话视图(host.session.load)重建 pi 会话,经 pi 自己的恢复路径装载:
// SessionManager.inMemory(cwd, {id}, entries) 在条目里没有会话头时按 id 生成头,叶 = 最后一条。
// 逐项规则:
// - 用户行与合成行(时间提醒、聊天位注入)恒由中立内容编码(context-encoder):用户输入每轮由
//   应用物化,注入不沉淀为引擎记忆;
// - 助手行带有效原生条目(应用已按摘要校验过)→ 原样取用;否则回退编码。原生组里刻意不取每轮
//   重建的东西:用户消息(由前面的中立行给出)、system 消息(系统提示词每轮由 resources 重建,见
//   model-bridge 的 supportsMidConvoSystemMessages)、模型与思考档位(由本轮授权给出)、压缩与分支
//   摘要(压缩仍以会话级 engineCompactions 为准,重放在下方)。
// - 整组回退的情形:格式不识别、形状不对、组里没有助手消息,或原生内容与这一行的引擎可见文本不一致
//   ——应用对助手内容的改写(输出变换、消息模板)要让模型看到改写后的内容,与保真注解失配同一语义。
// - 条目 id:原生条目保留自身 id,回退条目由消息 id 确定性派生。整条序列按视图顺序重连成线性链
//   (pi 一轮内的会话本就是线性的)。
// pi 会话 id = 应用会话 id:prompt_cache_key 与会话亲和头跨轮稳定(§4.5)。
//
// 写路径(P3.4,createPiEntrySync):装载之后 pi 新增的条目经 host.session.append 交给应用,锚定由
// 应用按当前落点决定。pi 的追加大多不发 entry_appended(message_end 落库、模型/档位变更、压缩都不发),
// 所以按 getEntries() 与已交出的 id 对账:条目只追加、id 唯一,对账是精确的。每轮重建的条目不写
// (装载时同样剔除;用户消息还带着图片原文)。

import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  assertValidSessionId,
  type NewSessionOptions,
  type SessionEntry,
} from "../../pi/packages/coding-agent/src/core/session-manager.ts";
import type { EngineCompactionRecord, EngineEntryInput, EngineSessionItem, EngineSessionView } from "../engines/contract";
import type { JsonValue, Message } from "../foundation/types";
import { isRecord } from "../foundation/utils";
import { encodeNeutralMessage } from "./context-encoder";

/** pi 原生条目的格式版本(EngineEntryInput.format)。随 pi 会话版本走:pi 升级改了条目形状时
 *  旧条目不再被识别,整组回退一次。 */
export const PI_ENTRY_FORMAT = `pi-session-v${CURRENT_SESSION_VERSION}`;

export interface PiSessionFromView {
  manager: SessionManager;
  /** 消息 id → 它在会话里的条目 id(压缩切点映射用;合成行不在内)。 */
  entryIdsByMessageId: Map<string, string[]>;
  /** 走了 legacy 退化的助手行(诊断;合成行不在内,legacy 是它们的设计路径)。 */
  degradedMessageIds: string[];
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
    case "compaction":
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
    if (!rebuiltEachTurn(entry)) entries.push(entry);
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
function replayCompaction(
  manager: SessionManager,
  compactions: readonly EngineCompactionRecord[],
  entryIdsByMessageId: ReadonlyMap<string, string[]>,
  firstEntryId: string | null,
  hasSynthetic: boolean,
): void {
  const applicable = compactions.filter((record) => entryIdsByMessageId.has(record.cutMessageId)).at(-1);
  if (!applicable) return;
  const cutEntryIds = entryIdsByMessageId.get(applicable.cutMessageId)!;
  const boundary = hasSynthetic ? firstEntryId : cutEntryIds[0];
  manager.appendCompaction(applicable.summary, boundary ?? cutEntryIds[0]!, applicable.tokensBefore);
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
  for (const item of view.items) {
    let group = nativeEntriesOf(item);
    if (!group) {
      const fallback = fallbackEntriesOf(item, fallbackModelId);
      group = fallback.entries;
      if (fallback.degraded && !item.synthetic) degradedMessageIds.push(item.message.id);
    }
    for (const entry of group) entries.push({ ...entry, parentId: entries.at(-1)?.id ?? null });
    // 合成行不进切点映射:它的 id 不是会话里的消息 id,切点经外收拢落上来时由调用方按尾消息兜底。
    if (group.length && !item.synthetic) entryIdsByMessageId.set(item.message.id, group.map((entry) => entry.id));
  }
  const manager = SessionManager.inMemory(options.cwd, sessionOptionsFor(options.conversationId), entries);
  replayCompaction(manager, view.compactions, entryIdsByMessageId, entries[0]?.id ?? null, view.items.some((item) => item.synthetic));
  return { manager, entryIdsByMessageId, degradedMessageIds };
}

export interface PiEntrySync {
  /** 立即交出上次以来的新条目(应用在收到时按当时的落点锚定,所以必须在补发换绑之前调用)。
   *  返回的 Promise 在已交出的各批都送达后兑现,从不拒绝。 */
  flush(): Promise<void>;
}

/** 在会话装载完成之后创建:此刻已有的条目(视图装载的、压缩重放的)视为已在存储里。
 *  送达失败经 onError 报一次;应用侧不封存写失败的锚定,那条消息下一轮走回退编码。 */
export function createPiEntrySync(
  manager: SessionManager,
  append: (entries: EngineEntryInput[]) => Promise<void>,
  onError: (error: unknown) => void,
): PiEntrySync {
  const known = new Set(manager.getEntries().map((entry) => entry.id));
  let delivered: Promise<void> = Promise.resolve();
  let reported = false;
  return {
    flush() {
      const fresh = manager.getEntries().filter((entry) => !known.has(entry.id));
      for (const entry of fresh) known.add(entry.id);
      const batch = fresh
        .filter((entry) => !rebuiltEachTurn(entry))
        .map((entry): EngineEntryInput => ({ format: PI_ENTRY_FORMAT, entryId: entry.id, payload: entry as unknown as JsonValue }));
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
  };
}
