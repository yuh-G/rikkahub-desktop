// pi-engine/app-tools.ts — 契约应用工具(AppToolSpec)→ pi customTools
//
// 方案 §4.3 裁决:pi 的大脑 + 我们的手。应用提供的工具(通用工具 / MCP 桥)在这里包成 pi ToolDefinition,
// execute 只做一件事:把调用交给应用(生产 = host.tools.call)。审批(含 ask_user 提问)、执行、结果实体化都
// 在应用侧一次完成(engines/app-tools.ts),执行中的部分输出由应用直接写进工具卡,不回绕引擎。工作区工具
// 不走这里:它们是 pi 的内建工具,见 builtin-tools.ts。
//
// 引擎侧只补自己的约定:
// - 不带 promptSnippet:不进系统提示词的 Available tools 清单(那里只该有编码工具,pi 系统提示词已有
//   "you may have access to other custom tools" 兜底句),与聊天引擎"通用工具只出现在 API tools 数组"同构。
//   参数校验:pi 1.5 起所有工具参数经 pi-schema 校验(coerce),我们的 OpenAI 形状 schema 原样可用。
// - executionMode 全部 "sequential":pi 默认并行执行工具批(agent.ts 的 toolExecution 默认 "parallel"),
//   批内任一 sequential 即整批顺序(agent-loop.ts 的 hasSequentialToolCall)——审批卡"执行到哪个弹哪个"的
//   节奏、MCP 慢调用不并发抢跑,都靠它。
//
// 结果回到 pi 时按应用给的形态打 details 标记,事件桥(event-bridge.mapPiToolResult)据此还原工具卡:
// display(应用已实体化的卡片条目)→ {app:{output}};结构化细节 → {workspace:{tool,details}};
// 都没有则按 content 映射。

import type { ToolDefinition } from "../../pi/packages/coding-agent/src/core/extensions/types.ts";
import type { AppToolResult, AppToolSpec } from "../engines/contract";
import type { JsonValue } from "../foundation/types";
import { markToolGated } from "./tool-gate";

type PiToolParameters = ToolDefinition["parameters"];
type PiToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;

/** 一次应用工具调用(引擎侧视角;会话/轮次归属由调用方补成契约 AppToolCall)。 */
export interface PiAppToolInvocation {
  toolCallId: string;
  name: string;
  args: Record<string, JsonValue>;
}

export type PiAppToolCaller = (call: PiAppToolInvocation) => Promise<AppToolResult>;

function toPiToolResult(result: AppToolResult): PiToolResult {
  const details = result.display
    ? { app: { output: result.display } }
    : result.details
      ? { workspace: result.details }
      : {};
  return { content: result.content, details } as PiToolResult;
}

function buildTool(spec: AppToolSpec, call: PiAppToolCaller | undefined): ToolDefinition {
  return markToolGated({
    name: spec.name,
    // pi 内建工具的 label 就是小写工具名(tools/*.ts);label 仅 TUI 用,保持同构。
    label: spec.name,
    description: spec.description,
    parameters: spec.parameters as unknown as PiToolParameters,
    executionMode: "sequential",
    // 不用 pi 传入的 signal:取消走 driver.abort,应用侧用自己的生成信号收敛在途审批与执行。
    async execute(toolCallId, params) {
      if (!call) throw new Error(`应用工具通道未接线,无法执行 ${spec.name}`);
      const args = (params ?? {}) as Record<string, JsonValue>;
      return toPiToolResult(await call({ toolCallId, name: spec.name, args }));
    },
  } satisfies ToolDefinition);
}

export function createPiAppTools(specs: readonly AppToolSpec[], call: PiAppToolCaller | undefined): ToolDefinition[] {
  return specs.map((spec) => buildTool(spec, call));
}
