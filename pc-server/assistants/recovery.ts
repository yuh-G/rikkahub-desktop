// assistants/recovery.ts — 从会话记录恢复缺失的助手(数据恢复,对齐 APP b9c0d3b7)
//
// 场景:删助手不删会话(设置端点的既有语义,保守正确),而会话列表/分页/搜索全部按
// 当前助手过滤——引用已删助手的会话在全部 UI 面上不可见,数据还在活库但无路可达。
// 本层提供扫描(哪些助手 id 被引用但设置里不存在)与恢复(为它们创建占位助手,让
// 会话重新可见)。恢复的助手只保证"能打开会话":人设/模型等配置无法从会话记录重建。

import { getConversationsDb } from "../conversations";
import { countConversationsByAssistant } from "../conversations/read-queries";
import { state } from "../persistence/json-store";
import { updateSettings } from "../app-config";
import type { Assistant } from "../foundation/types";
import { defaultAssistant } from "./index";

export interface MissingAssistant {
  assistantId: string;
  conversationCount: number;
}

/** 扫描:会话记录引用、但设置中已不存在的助手 id(按会话数降序——恢复哪个的
 *  优先级一目了然)。活库不可用时返回空(会话功能整体不可用的既有降级语义)。 */
export function scanMissingAssistants(): MissingAssistant[] {
  const db = getConversationsDb();
  if (!db) return [];
  const existing = new Set(state.settings.assistants.map((assistant) => assistant.id));
  return countConversationsByAssistant(db)
    .filter((row) => !existing.has(row.assistantId))
    .map((row) => ({ assistantId: row.assistantId, conversationCount: row.count }));
}

/** 恢复:为全部缺失助手创建占位助手(名字按会话数从多到少编号)。
 *  与扫描同频重算缺失集(防止 UI 停留期间的并发删除/新增);零缺失返回 0 幂等。
 *  占位助手沿用 defaultAssistant 形态——不发明新字段,用户接手后可正常编辑;
 *  经 updateSettings 收口,落盘/SSE 广播/列表失效与正常设置保存同路。 */
export function recoverMissingAssistants(): number {
  const missing = scanMissingAssistants();
  if (missing.length === 0) return 0;
  const recovered: Assistant[] = missing.map((item, index) => ({
    ...defaultAssistant(),
    id: item.assistantId,
    name: `恢复的助手 ${index + 1}`,
  }));
  updateSettings({ ...state.settings, assistants: [...state.settings.assistants, ...recovered] });
  return recovered.length;
}
