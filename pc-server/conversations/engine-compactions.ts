// conversations/engine-compactions.ts — 引擎原生压缩记录的会话级存取(引擎中立)。
//
// conversation.engineCompactions 是 SQLite 单一事实源下「引擎记忆被压缩到哪」的唯一载体
// (P7);记录结构与引擎无关——任何原生压缩引擎(pi / 未来 dsh 等)的产物都落同一列、
// 经同一对函数读写。故住会话层而非某个引擎目录(T5 从编排器迁出)。
//
// 分工:引擎产出 CapturedEngineCompaction(切点映射回 DB 消息 id),下一轮把
// EngineCompactionRecord 重放进自身上下文;本模块只管「解析 DB 列」与「落库 + 外显分割线」。
// 两个记录类型住 foundation/types(与 Conversation.engineCompactions 列同处),引擎与会话层共用。

import type { CapturedEngineCompaction, Conversation, EngineCompactionRecord, JsonValue } from "../foundation/types";
import { isRecord } from "../foundation/utils";
import { markCompactionBoundary } from "./auxiliary";
import { markConversationRowDirty, scheduleThrottledConvFlush, selectedConversationMessages } from "./index";

/** conversation.engineCompactions(DB 任意 JSON)→ 记录契约。宽容校验:坏条目丢弃而
 *  不是整列作废(与列解析"损坏回 null"同哲学)。 */
export function parseEngineCompactions(raw: JsonValue[] | null | undefined): EngineCompactionRecord[] {
  const records: EngineCompactionRecord[] = [];
  for (const item of raw ?? []) {
    if (!isRecord(item)) continue;
    if (typeof item.cutMessageId !== "string" || typeof item.summary !== "string") continue;
    const record: EngineCompactionRecord = {
      cutMessageId: item.cutMessageId,
      summary: item.summary,
      tokensBefore: typeof item.tokensBefore === "number" ? item.tokensBefore : 0,
    };
    if (typeof item.createdAt === "string") record.createdAt = item.createdAt;
    records.push(record);
  }
  return records;
}

/** 本轮压缩产物落 conversation.engineCompactions(生成路径的自动压缩与手动压缩同一落点)。
 *  cutMessageId 为 null(引擎自动压缩的切点可能落在本轮 prompt 之后,而本轮消息尚未
 *  入库)按"外收拢"落当前尾消息 id——只多保不少保,下一轮编码器按"切点在场"自校验生效。 */
export function applyCapturedEngineCompactions(conversation: Conversation, captured: CapturedEngineCompaction[]): void {
  if (!captured.length) return;
  const tail = selectedConversationMessages(conversation).at(-1);
  const records = parseEngineCompactions(conversation.engineCompactions);
  for (const item of captured) {
    const cutMessageId = item.cutMessageId ?? tail?.id;
    if (!cutMessageId) continue; // 无任何消息可挂靠(理论不可达):丢记录好过写错切点
    records.push({
      cutMessageId,
      summary: item.summary,
      tokensBefore: item.tokensBefore,
      createdAt: new Date().toISOString(),
    });
  }
  conversation.engineCompactions = records as unknown as JsonValue[];
  // 压缩发生点外显:分割线锚定"压缩时刻的最新消息"(自动/手动压缩同点生效)。
  markCompactionBoundary(conversation);
  markConversationRowDirty(conversation.id);
  scheduleThrottledConvFlush();
}
