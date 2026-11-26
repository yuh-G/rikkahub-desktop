// conversations/engine-compactions.ts — 会话级引擎压缩记录(conversation.engineCompactions)
//
// 压缩记录是引擎中立的会话事实(切点消息 id + 摘要),由应用读写;引擎只消费契约里的
// EngineCompactionRecord。两件事住这里:
// - parseEngineCompactions:DB 任意 JSON → 契约形状,坏条目丢弃而不是整列作废;
// - effectiveEngineCompaction:富化层取窗口锚之前的单源判定——切点落在空行、被删消息、
//   零条目行上的记录不生效。谓词必须与引擎编码器的重放过滤一致(编码器只对「编出了
//   ≥1 个条目」的行登记切点映射),一致性由 pi-engine/context-encoder.test.ts 锁定。

import type { EngineCompactionRecord } from "../engines/contract";
import type { JsonValue, Message, Model } from "../foundation/types";
import { isRecord } from "../foundation/utils";
import { promptInputFromParts } from "../inference-engine/prompt-input";

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

/** 该行能否编出 ≥1 个引擎条目。USER 行看模型可见输入,ASSISTANT 行看有无文本、工具卡或 notice,
 *  SYSTEM 行不进引擎上下文。 */
function encodesToEntries(message: Message, model: Model): boolean {
  if (message.role === "USER") {
    const input = promptInputFromParts(message.parts, model);
    return Boolean(input.text) || input.images.length > 0;
  }
  if (message.role === "ASSISTANT") {
    return message.parts.some((part) => isRecord(part) && (part.type === "text" || part.type === "tool" || part.type === "notice"));
  }
  return false;
}

/** 取最新一条切点在场且可编码的记录,无则 null。 */
export function effectiveEngineCompaction(
  compactions: EngineCompactionRecord[],
  history: Message[],
  model: Model,
): EngineCompactionRecord | null {
  return (
    compactions
      .filter((record) => {
        const cut = history.find((msg) => msg.id === record.cutMessageId);
        return cut !== undefined && encodesToEntries(cut, model);
      })
      .at(-1) ?? null
  );
}
