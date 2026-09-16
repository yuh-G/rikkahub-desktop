// tools/ask-user.ts — ask_user 工具的单一事实源(对话引擎 + pi 工作区引擎共用)。
//
// 纪律:纯函数、零 I/O、零状态。schema 声明 / 归一化 / 答案合并 / 回放文本全部收在这
// 一处,两个引擎的适配层(聊天 tools/local.ts 的 pending 哨兵、pi-engine 的 gateAskUser
// 定制工具)只做薄封装,各写各的会导致模型面与 UI 面漂移。
//
// 前后端共用:web-ui 侧经 @server 别名 import 本文件的纯函数与类型(与 app/types/parts.ts
// 同源模式),UI 的解析/合并与后端逐字一致,避免双份逻辑。
//
// 兼容契约(冻结):ToolApprovalState.answered.answer 是字符串,内容为扁平 JSON
//   {"answers": { [questionId]: string }}。多选答案按 APP 规则用 ", " 合并(自定义文本
//   追加在最后),不引入嵌套结构——历史 part 与安卓端都这么存,改形即破契约。

import { isRecord } from "../foundation/utils";
import type { JsonValue } from "../foundation/types";

export const ASK_USER_TOOL_NAME = "ask_user";

/** 单次最多向用户抛 3 个问题(codex 同款钳制:问太多用户会烦,模型该分批)。 */
export const ASK_USER_MAX_QUESTIONS = 3;

export type AskUserSelectionType = "text" | "single" | "multi";

export interface AskUserQuestion {
  id: string;
  question: string;
  /** 归一化后恒有值:省略/非法一律落 "text"(纯文本)。 */
  selectionType: AskUserSelectionType;
  /** 建议选项(纯字符串;可能为空数组=text 纯文本题)。 */
  options: string[];
}

/** 归一化后的答复映射:questionId → 用户答案(多选已 ", " 合并)。 */
export type AskUserAnswerMap = Record<string, string>;

const SELECTION_TYPES: readonly AskUserSelectionType[] = ["text", "single", "multi"];

/** 模型面 schema 的 questions 数组片段(definitions.ts 声明用,双引擎同源)。 */
export function askUserQuestionsSchema(): Record<string, JsonValue> {
  return {
    type: "array",
    description: "List of questions to ask the user (1 to 3)",
    items: {
      type: "object",
      properties: {
        id: { type: "string", description: "Unique identifier for this question" },
        question: { type: "string", description: "The question text to display to the user" },
        options: {
          type: "array",
          description: "Optional list of suggested options for the user to choose from",
          items: { type: "string" },
        },
        selection_type: {
          type: "string",
          enum: ["text", "single", "multi"],
          description:
            "Answer type: text (free text input, default), single (select one option or enter custom text), multi (select options and/or enter custom text)",
        },
      },
      required: ["id", "question"],
    },
  };
}

/** 模型面工具描述(codex/APP 对齐:明示每种题型都可自由文本,multi 可与选项合并)。 */
export const ASK_USER_TOOL_DESCRIPTION =
  "Ask the user one or more questions when you need clarification, additional information, or confirmation. " +
  "Each question can optionally provide a list of suggested options for the user to choose from. " +
  "The user may provide a free-text answer for every question, including single and multi selection questions. " +
  "For multi selection questions, custom text can be combined with selected options. " +
  "The answers will be returned as a JSON object mapping question IDs to the user's responses.";

/** 服务端归一化(codex 式"不信模型"):逐项纠错、钳题数、补默认。返回 {error} 让调用方
 *  回灌模型重试,而不是静默吞掉畸形入参。容错解析历史 part 时(UI/回放)同用本函数。 */
export function normalizeAskUserQuestions(
  raw: unknown,
): { questions: AskUserQuestion[] } | { error: string } {
  const list = Array.isArray(raw) ? raw : [];
  const questions: AskUserQuestion[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const question = typeof item.question === "string" ? item.question.trim() : "";
    if (!id || !question) continue;
    const selectionType: AskUserSelectionType = SELECTION_TYPES.includes(
      item.selection_type as AskUserSelectionType,
    )
      ? (item.selection_type as AskUserSelectionType)
      : "text";
    const options = (Array.isArray(item.options) ? item.options : [])
      .filter((o): o is string => typeof o === "string" && o.trim().length > 0)
      .map((o) => o.trim());
    questions.push({ id, question, selectionType, options });
  }
  if (questions.length === 0) return { error: "ask_user requires at least one valid question (each with a non-empty id and question)" };
  if (questions.length > ASK_USER_MAX_QUESTIONS) {
    return { error: `ask_user accepts at most ${ASK_USER_MAX_QUESTIONS} questions per call, got ${questions.length}` };
  }
  return { questions };
}

/** 容错读取 answered.answer(扁平 {"answers":{qid:string}} 契约)。解析失败/非对象 → 空映射。 */
export function parseAskUserAnswer(answerString: string): AskUserAnswerMap {
  try {
    const parsed = JSON.parse(answerString);
    if (!isRecord(parsed) || !isRecord(parsed.answers)) return {};
    const out: AskUserAnswerMap = {};
    for (const [key, value] of Object.entries(parsed.answers)) {
      if (typeof value === "string") out[key] = value;
      else if (Array.isArray(value)) out[key] = value.filter((v): v is string => typeof v === "string").join(", ");
    }
    return out;
  } catch {
    return {};
  }
}

/** 答案合并(APP 规则,双引擎 + UI 同源):multi = 已选选项 + 非空自定义文本,逗号合并,
 *  自定义文本追加最后;text/single = 文本框原值(chip 选择已写回该框)。 */
export function mergeAskUserAnswer(
  selectionType: AskUserSelectionType,
  selected: string[],
  customText: string,
): string {
  const text = customText.trim();
  if (selectionType !== "multi") return text || (selected[0] ?? "");
  const parts = [...selected.map((s) => s.trim()).filter(Boolean)];
  if (text) parts.push(text);
  return parts.join(", ");
}

/** 把 UI 收集的原始选择(每题 {selected, customText})合并成契约答案映射。 */
export function buildAskUserAnswerMap(
  questions: AskUserQuestion[],
  raw: Record<string, { selected: string[]; customText: string }>,
): AskUserAnswerMap {
  const out: AskUserAnswerMap = {};
  for (const q of questions) {
    const entry = raw[q.id] ?? { selected: [], customText: "" };
    out[q.id] = mergeAskUserAnswer(q.selectionType, entry.selected, entry.customText);
  }
  return out;
}

/** 序列化为落库/回放的 answer 字符串(扁平契约)。 */
export function serializeAskUserAnswer(map: AskUserAnswerMap): string {
  return JSON.stringify({ answers: map });
}

/** 聊天引擎 pending 哨兵(tools/local.ts 用):归一化失败返回 null,由调用方抛错回灌模型。 */
export function buildAskUserPending(
  args: Record<string, JsonValue>,
): { pending: true; questions: AskUserQuestion[]; note: string } | { error: string } {
  const normalized = normalizeAskUserQuestions(args.questions);
  if ("error" in normalized) return { error: normalized.error };
  return {
    pending: true,
    questions: normalized.questions,
    note: "The question has been shown in the conversation. Wait for the user answer before continuing.",
  };
}
