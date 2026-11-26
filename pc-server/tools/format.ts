// tools/format.ts — 工具结果格式化与输入解析
// 纪律：纯函数，只负责把工具 part / 输出转成 API 消息可用的字符串或对象。

import { id, isRecord, textFromParts } from "../foundation/utils";
import type { JsonValue, ToolErrorOutput, ToolOutputEntry } from "../foundation/types";

export function parseToolInput(value: unknown): Record<string, JsonValue> {
  if (isRecord(value)) return value as Record<string, JsonValue>;
  if (typeof value !== "string") return {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? (parsed as Record<string, JsonValue>) : {};
  } catch {
    return {};
  }
}

/** 工具卡 input → 上游 `arguments` 的唯一投影。空/空白一律归 "{}"。
 *
 *  必须真值判定而非 `?? "{}"`：ToolPart.input 的类型是 string（非可选），落库形态里
 *  "参数缺失" 表现为**空串**而不是 undefined，`??` 接不住 —— 空串直接发上去，严格端点
 *  报必填参数缺失(火山 MissingParameter input.arguments，2026-09-07 内测报障的第二问必炸)。
 *  ""不是合法 JSON，模型侧也无法解析，故归一到零参调用的 "{}" 是唯一正确解。
 *  历史库里已有的空参工具卡（旧版 id 串台产的幽灵卡，见 responseEventToDelta 头注）
 *  经此归一后也能正常回传，老会话不必删档。 */
export function toolArgumentsJson(input: unknown): string {
  const text = typeof input === "string" ? input.trim() : "";
  return text || "{}";
}

export function toolExecutionErrorPayload(err: unknown): ToolErrorOutput {
  if (err instanceof Error) {
    return {
      error: `[${err.name || "Error"}] ${err.message}${err.stack ? `\n${err.stack}` : ""}`,
    };
  }
  return { error: String(err) };
}

export function openAiToolOutput(parts: ToolOutputEntry[]): string {
  const text = textFromParts(parts);
  if (text) return text;
  return parts.length ? JSON.stringify(parts) : "";
}

/** 工作区工具的结构化细节(diff / exitCode 等)进工具卡前的截断口径:整文件 diff 之类的长文本截断,
 *  保护消息体与前端渲染(§4.5 有界渲染);不可序列化的字段丢弃(details 只服务渲染与导出)。 */
const DETAILS_TEXT_CAP = 100_000;

export function jsonSafeDetails(details: unknown): Record<string, JsonValue> | null {
  if (details == null || typeof details !== "object") return null;
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (typeof value === "string" && value.length > DETAILS_TEXT_CAP) {
      out[key] = `${value.slice(0, DETAILS_TEXT_CAP)}\n[... truncated]`;
      continue;
    }
    try {
      out[key] = JSON.parse(JSON.stringify(value)) as JsonValue;
    } catch {
      // 不可序列化的字段直接丢弃(details 只服务渲染/导出,非正确性数据)
    }
  }
  return Object.keys(out).length ? out : null;
}

export function toolOutputForApproval(part: Record<string, unknown>): string {
  const approvalState = isRecord(part.approvalState) ? part.approvalState : { type: "auto" };
  const type = String(approvalState.type ?? "auto");
  if (type === "answered") return String(approvalState.answer ?? "");
  if (type === "denied") {
    const reason = String(approvalState.reason ?? "").trim() || "No reason provided";
    return JSON.stringify({ error: `Tool execution denied by user. Reason: ${reason}` });
  }
  return "";
}

export function resolvedToolOutput(part: Record<string, unknown>): string {
  const output = Array.isArray(part.output) ? part.output : [];
  const fromOutput = openAiToolOutput(output as ToolOutputEntry[]);
  if (fromOutput) return fromOutput;
  return toolOutputForApproval(part);
}

/** 工具卡 → 上游工具结果项（`function_call_output.output` / `role:"tool"` 的 content）的
 *  唯一投影。既无真实输出、又无审批派生输出时给确定性占位，绝不发空串。
 *
 *  Why：`function_call` 与其结果项必须成对且都要"有内容"——中断残留 / 旧版串台产的空卡
 *  会让结果项是空串，严格端点(火山)按必填校验拒整个请求(与 arguments 空串同类，见
 *  toolArgumentsJson)。占位文案与 pi 引擎 context-encoder 的同场景补录逐字一致：
 *  两引擎回灌给模型的"未产出结果"表述统一，模型行为不因引擎而异。 */
export function toolResultTextForApi(part: Record<string, unknown>): string {
  return resolvedToolOutput(part) || UNRESOLVED_TOOL_RESULT_TEXT;
}

/** 工具调用有记录但无结果时回灌给模型的确定性文案。pi 引擎 context-encoder 的中断
 *  补录用同一字面量——改这里必须同步改那边（跨引擎表述统一）。 */
export const UNRESOLVED_TOOL_RESULT_TEXT = "Tool execution was interrupted before producing a result.";

export function apiToolCallFromPart(part: Record<string, unknown>) {
  return {
    id: String(part.toolCallId ?? id()),
    type: "function" as const,
    function: {
      name: String(part.toolName ?? ""),
      arguments: toolArgumentsJson(part.input),
    },
  };
}
