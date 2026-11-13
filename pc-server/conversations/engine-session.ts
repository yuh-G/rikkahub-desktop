// conversations/engine-session.ts — 契约 host.session 的应用侧实现(重构方案 §5.4 / P3.2)
//
// 视图:选中路径(窗口化、富化后)逐项给出中立消息,外加本引擎锚定在该消息上的原生条目——
// 只有条目已封存、且该消息当前的引擎可见摘要与封存值一致时才给。摘要取富化前的中立消息
// (模板渲染、时间提醒、注入都不进摘要),合成行没有原生条目。摘要范围是一条消息(pi 的锚定粒度)。
// 写入:追加锚定到调用时的落点消息(补发分裂后即新开的续写消息)。一次生成第一次写某个锚定时
// 先清掉它此前的条目(只可能来自更早的生成,已不对应消息现在的内容)。生成入口若复用了一条已有
// 内容的助手消息,这条消息不封存:新条目只覆盖这次生成的部分,整条交给回退编码才不会丢内容。
// 封存:只在轮正常结束、应用收尾(输出变换、定格思考与工具卡、摘除占位)之后,按收尾后的内容
// 封存本次写过的全部锚定。中止与失败不封存——这些轮次的原生条目可能停在半截(有工具调用没有
// 结果),装载时作废,由中立内容回退编码。

import type { Database } from "bun:sqlite";
import type {
  EngineCompactionRecord,
  EngineEntryInput,
  EngineKind,
  EngineSessionItem,
  EngineSessionView,
  PromptInput,
} from "../engines/contract";
import type { Conversation, Message } from "../foundation/types";
import { appendEngineEntries, clearEngineEntries, engineVisibleDigest, loadEngineEntries, sealEngineEntries } from "./engine-entries";
import { conversationExistsInDb } from "./read-queries";

type Db = InstanceType<typeof Database>;

export interface EngineSessionSource {
  conversationId: string;
  engine: EngineKind;
  /** 选中路径的中立消息(富化前):摘要的来源。 */
  neutral: readonly Message[];
  /** 富化产物(窗口化、模板渲染、合成行插入之后),即视图的项序。 */
  enriched: readonly Message[];
  syntheticIds: ReadonlySet<string>;
  userInputs: Record<string, PromptInput>;
  compactions: EngineCompactionRecord[];
}

/** db 为 null(活库未打开)时视图不带原生条目。 */
export function buildEngineSessionView(db: Db | null, source: EngineSessionSource): EngineSessionView {
  const groups = new Map(
    (db ? loadEngineEntries(db, source.conversationId, source.engine) : []).map((group) => [group.anchorMessageId, group]),
  );
  const neutralById = new Map(source.neutral.map((message) => [message.id, message]));
  const items = source.enriched.map((message): EngineSessionItem => {
    const synthetic = source.syntheticIds.has(message.id);
    const item: EngineSessionItem = { message, synthetic };
    const input = source.userInputs[message.id];
    if (input) item.input = input;
    const group = synthetic ? undefined : groups.get(message.id);
    const neutral = neutralById.get(message.id);
    if (group?.digest && neutral && group.digest === engineVisibleDigest([neutral])) item.native = group.entries;
    return item;
  });
  return { items, compactions: source.compactions };
}

export interface EngineSessionWriter {
  /** 追加到锚定消息(调用方传当前落点)。活库未打开或会话已删除时丢弃:删除会中止生成,
   *  迟到的追加没有可挂的会话。写入失败照常抛出,且这个锚定本次不再封存。 */
  append(anchorMessageId: string, entries: readonly EngineEntryInput[]): void;
  /** 轮正常结束、应用收尾之后调用:每个写过的锚定按它现在的内容封存;锚定消息已不在会话里则跳过。 */
  seal(conversation: Conversation): void;
}

export interface EngineSessionWriterOptions {
  /** 生成入口复用的、已有内容的助手消息 id(见头注:不封存)。 */
  reusedMessageId?: string | null;
}

/** 一次生成一个写入方(补发分裂前后的落点共用它)。 */
export function createEngineSessionWriter(
  db: Db | null,
  conversationId: string,
  engine: EngineKind,
  options: EngineSessionWriterOptions = {},
): EngineSessionWriter {
  const anchors = new Set<string>();
  /** 写入失败过的锚定:组里可能缺条目,不封存(装载时走回退编码)。 */
  const broken = new Set<string>();
  return {
    append(anchorMessageId, entries) {
      if (!db || entries.length === 0 || !conversationExistsInDb(db, conversationId)) return;
      try {
        db.transaction(() => {
          if (!anchors.has(anchorMessageId)) clearEngineEntries(db, conversationId, engine, anchorMessageId);
          appendEngineEntries(db, conversationId, engine, anchorMessageId, entries);
        })();
      } catch (error) {
        broken.add(anchorMessageId);
        throw error;
      }
      anchors.add(anchorMessageId);
    },
    seal(conversation) {
      if (!db || anchors.size === 0) return;
      const byId = new Map(conversation.messages.flatMap((node) => node.messages.map((message) => [message.id, message] as const)));
      db.transaction(() => {
        for (const anchor of anchors) {
          const message = byId.get(anchor);
          if (message && anchor !== options.reusedMessageId && !broken.has(anchor)) {
            sealEngineEntries(db, conversationId, engine, anchor, engineVisibleDigest([message]));
          }
        }
      })();
    },
  };
}
