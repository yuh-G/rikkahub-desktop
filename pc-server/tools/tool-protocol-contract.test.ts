// 工具调用协议契约:跨引擎、跨 provider 的"退化工具卡不得投影成空"不变式。
//
// 动机(2026-09-05 / 09-07 三起同族报障,均表现为火山 400):
// ① 续传稀疏数组洞 → input 里 null 项(MissingParameter input.role);
// ② 历史 reasoning 项私有形态(input.role);
// ③ Responses 双 id 串台产空参幽灵卡 → MissingParameter input.arguments。
// 三次触发物不同,但都是同一个类:**某条投影路径把"缺失"表达成了空值,而严格端点按
// 必填校验拒整个请求**。逐点修永远修不完——每接一个新引擎/新 provider 就多一批投影点。
//
// 本文件把不变式机械化,两道防线:
// - A(行为):喂同一个退化工具卡(空 input + 空 output,即"有调用无结果"的落库形态),
//   要求每条上线路径都产出非空 arguments 与非空结果内容。这是所有严格端点的公共下界。
// - B(完整性):协议判别符(function_call / function_call_output / tool_result /
//   role:"tool" / functionResponse / role:"toolResult")的构造点文件集必须与登记表一致。
//   新引擎一旦自建投影而没走 tools/format.ts 的两个单源函数,本测试立刻变红——它不判断
//   新代码对不对,它强迫作者做出并登记这个决定(同 backup/android-contract-sync.test.ts 纪律)。
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { SessionManager } from "../../pi/packages/coding-agent/src/core/session-manager.ts";
import type { Message, Model, ToolPart } from "../foundation/types";
import { message } from "../foundation/utils";
import {
  appendAssistantApiMessages,
  claudeToolResultBlock,
  googleContentsFromApiMessages,
  responseApiMessagesFromUiMessages,
} from "../inference-engine/message-builder";
import { chatToolCallsFromNormalized, responseApiToolCallItems } from "../inference-engine/providers";
import { seedPiSessionFromHistory } from "../pi-engine/context-encoder";

/** 退化工具卡:参数与结果双缺。旧 id 串台产的幽灵卡、中断残留卡都是这个形状。 */
const DEGENERATE: ToolPart = {
  type: "tool",
  toolCallId: "call_degenerate",
  toolName: "lookup",
  input: "",
  output: [],
  approvalState: { type: "auto" },
};

function assistantRow(): Message {
  return message("ASSISTANT", [DEGENERATE]) as Message;
}

function nonEmpty(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((entry) => {
      if (typeof entry === "string") return entry.trim().length > 0;
      if (entry && typeof entry === "object" && "text" in entry) return String((entry as { text?: unknown }).text ?? "").trim().length > 0;
      return true; // 图片等非文本块自带内容
    });
  }
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

describe("A 行为:退化工具卡在每条上线路径都不得投影成空", () => {
  test("Responses 历史编码(对话模式第二问的实际来源)", () => {
    const items = responseApiMessagesFromUiMessages([assistantRow()]) as Array<Record<string, unknown>>;
    const call = items.find((item) => item.type === "function_call")!;
    const output = items.find((item) => item.type === "function_call_output")!;
    expect(nonEmpty(call.arguments)).toBe(true);
    expect(nonEmpty(output.output)).toBe(true);
    // call_id 两侧必须配对,否则上游报 "No tool output found for function call"。
    expect(call.call_id).toBe(output.call_id);
  });

  test("chat-completions 历史编码 + Google contents(经同一 ApiMessage 中间层)", () => {
    const items: Array<Record<string, unknown>> = [];
    appendAssistantApiMessages(items as never, assistantRow(), true);
    const assistantTurn = items.find((item) => Array.isArray(item.tool_calls))!;
    const toolTurn = items.find((item) => item.role === "tool")!;
    const toolCalls = assistantTurn.tool_calls as Array<{ function: { arguments: string } }>;
    expect(nonEmpty(toolCalls[0]!.function.arguments)).toBe(true);
    expect(nonEmpty(toolTurn.content)).toBe(true);

    // Google 侧消费同一中间层:functionCall.args 是对象(空对象合法),functionResponse
    // 的 result 文本不得为空——Gemini 不按必填拒,但"无结果"的表述必须与另两系一致。
    const contents = googleContentsFromApiMessages(items as never);
    const responseTurn = contents.find((entry) =>
      Array.isArray(entry.parts) && entry.parts.some((part) => part && typeof part === "object" && "functionResponse" in part),
    )!;
    const fr = (responseTurn.parts as Array<Record<string, any>>)[0]!.functionResponse;
    expect(nonEmpty(fr.response.result)).toBe(true);
  });

  test("Claude tool_result(Anthropic 明确拒空 text block)", () => {
    const block = claudeToolResultBlock({
      role: "tool",
      tool_call_id: DEGENERATE.toolCallId,
      content: "",
      _rikkahub_tool_output_parts: [],
    } as never);
    expect(nonEmpty(block.content)).toBe(true);
  });

  test("流式续传投影(本轮 encodeNextTurn 的唯一入口)", () => {
    const normalized = [{ id: "call_degenerate", name: "lookup", arguments: "" }];
    expect(nonEmpty(responseApiToolCallItems(normalized)[0]!.arguments)).toBe(true);
    expect(nonEmpty(chatToolCallsFromNormalized(normalized)[0]!.function.arguments)).toBe(true);
  });

  test("pi 引擎(工作区模式)上下文编码", () => {
    const manager = SessionManager.inMemory(process.cwd());
    seedPiSessionFromHistory({
      manager,
      history: [assistantRow()],
      model: { modelId: "m", inputModalities: ["TEXT"] } as unknown as Model,
    });
    const toolResult = manager.buildSessionContext().messages.find((entry) => entry.role === "toolResult")!;
    expect(nonEmpty((toolResult as { content: unknown }).content)).toBe(true);
  });
});

// ── B 完整性:协议构造点文件集登记 ────────────────────────────────────────────
// 登记表 = "已审阅过、确认经 tools/format.ts 单源投影(或本身就是那个单源)"的文件。
const REGISTERED_PROTOCOL_FILES: ReadonlySet<string> = new Set([
  // 三家 provider 的消息编码器:tool_calls.arguments 经 toolArgumentsJson,
  // 结果项经 toolResultTextForApi / claudeBlocksFromUiParts(内部同一占位常量)。
  "inference-engine/message-builder.ts",
  // Gemini Interactions 路的 step 构造:function_call.arguments 从 toolArgumentsJson/
  // JSON.parse 收口、function_result 经 toolResultTextForApi(空输出占位同常量)。
  "inference-engine/interactions.ts",
  // 流式工具循环的 provider 适配层(含续传投影 responseApiToolCallItems /
  // chatToolCallsFromNormalized 与三家 encodeNextTurn)。
  "inference-engine/providers.ts",
  // 审批续跑的结果项回放。
  "conversations/orchestrator.ts",
  // 工作区引擎:DB 历史 → pi 消息(toolResult 空输出补同一占位常量)。
  "pi-engine/context-encoder.ts",
]);

/** 协议判别符:出现即意味着"这里在构造发给模型的工具调用/结果项"。 */
const PROTOCOL_MARKERS = [
  'type: "function_call"',
  'type: "function_call_output"',
  'type: "tool_result"',
  'role: "tool"',
  'role: "toolResult"',
  "functionResponse:",
] as const;

const SERVER_ROOT = join(import.meta.dir, "..");
const SKIP_DIRS = new Set(["node_modules", "scripts", "test-utils", "dist"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

describe("B 完整性:协议构造点必须登记(新引擎的强制路口)", () => {
  test("构造点文件集与登记表一致", () => {
    const found = new Set<string>();
    for (const file of sourceFiles(SERVER_ROOT)) {
      const source = readFileSync(file, "utf8");
      if (!PROTOCOL_MARKERS.some((marker) => source.includes(marker))) continue;
      found.add(relative(SERVER_ROOT, file).replaceAll("\\", "/"));
    }
    const unregistered = [...found].filter((file) => !REGISTERED_PROTOCOL_FILES.has(file)).sort();
    expect(
      unregistered,
      `以下文件在构造发给模型的工具调用/结果项,但未登记:\n  ${unregistered.join("\n  ")}\n` +
        "请确认它的 arguments 经 tools/format.ts 的 toolArgumentsJson、结果内容经 toolResultTextForApi " +
        "(Claude 系走 claudeBlocksFromUiParts,共用 UNRESOLVED_TOOL_RESULT_TEXT),然后登记进 " +
        "REGISTERED_PROTOCOL_FILES。空 arguments / 空结果内容会被严格端点(火山等)按必填校验 400。",
    ).toEqual([]);
    // 登记表不得留下已删除/已重构掉的陈旧条目。
    const stale = [...REGISTERED_PROTOCOL_FILES].filter((file) => !found.has(file)).sort();
    expect(stale, `登记表存在陈旧条目(文件已不再构造协议项):\n  ${stale.join("\n  ")}`).toEqual([]);
  });
});
