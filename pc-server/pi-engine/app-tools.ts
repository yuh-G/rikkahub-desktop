// pi-engine/app-tools.ts — 契约应用工具(AppToolSpec)→ pi customTools
//
// 方案 §4.3 裁决:pi 的大脑 + 我们的手。pi 内建工具不启用(noTools:"builtin",它们绕开
// 我们的审批与边界壳);应用提供的工具(七个工作区工具 + 通用工具/MCP 桥)在这里包成 pi
// ToolDefinition,execute 只做一件事:把调用交给应用(生产 = host.tools.call)。审批(含
// ask_user 提问)、执行、结果实体化都在应用侧一次完成(engines/app-tools.ts),执行中的
// 部分输出由应用直接写进工具卡,不回绕引擎。
//
// 引擎侧只补自己的约定:
// - 工作区工具(group "workspace")的 promptSnippet/promptGuidelines 逐字镜像 pi 内建工具
//   (coding-agent/src/core/tools/*.ts),系统提示词的 Available tools/Guidelines 措辞与 pi
//   原生体验等同(有 snippet 才进 Available tools)。通用工具不带 snippet:不进那份清单
//   (那里只该有编码工具,pi 系统提示词已有"you may have access to other custom tools"
//   兜底句),与聊天引擎"通用工具只出现在 API tools 数组"同构。
// - edit 与 pi 原版一样挂 prepareArguments,legacy 形状(顶层 oldText/JSON 字符串 edits)
//   在校验前修复。参数校验:pi 1.5 起所有工具参数经 pi-schema 校验(ai/src/utils/
//   validation.ts 的 compile(schema, { coerce: true })),我们的 OpenAI 形状 schema 原样可用。
// - executionMode 全部 "sequential":pi 默认并行执行工具批(agent.ts 的 toolExecution 默认
//   "parallel"),批内任一 sequential 即整批顺序(agent-loop.ts 的 hasSequentialToolCall)——
//   审批卡"执行到哪个弹哪个"的节奏、bash 输出不交错、MCP 慢调用不并发抢跑,都靠它。
//
// 结果回到 pi 时按应用给的形态打 details 标记,事件桥(event-bridge.mapPiToolResult)据此
// 还原工具卡:display(应用已实体化的卡片条目)→ {app:{output}};工作区结构化细节
// (diff/exitCode)→ {workspace:{tool,details}};都没有则按 content 映射。

import type { ToolDefinition } from "../../pi/packages/coding-agent/src/core/extensions/types.ts";
import type { AppToolResult, AppToolSpec } from "../engines/contract";
import type { JsonValue } from "../foundation/types";
import { prepareEditArguments } from "../workspace/tools/edit";

type PiToolParameters = ToolDefinition["parameters"];
type PiToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;

/** 一次应用工具调用(引擎侧视角;会话/轮次归属由调用方补成契约 AppToolCall)。 */
export interface PiAppToolInvocation {
  toolCallId: string;
  name: string;
  args: Record<string, JsonValue>;
}

export type PiAppToolCaller = (call: PiAppToolInvocation) => Promise<AppToolResult>;

/** pi 内建工具的 Available tools 一行摘要,逐字镜像 pi 各工具的
 *  `<name>ToolSystemPromptContribution.snippet`(coding-agent/src/core/tools/*.ts)。 */
const PROMPT_SNIPPETS: Record<string, string> = {
  read: "Read file contents",
  bash: "Execute bash commands (ls, grep, find, etc.)",
  edit: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
  write: "Create or overwrite files",
  grep: "Search file contents for patterns (respects .gitignore)",
  find: "Find files by glob pattern (respects .gitignore)",
  ls: "List directory contents",
};

/** pi 内建工具的 Guidelines 追加条目,逐字镜像 `<name>ToolSystemPromptContribution.guidelines`。
 *  bash 的 PI_* 环境变量条目不镜像(它以 exposeSessionEnvironment 为前提,我们不暴露 pi 会话
 *  环境变量);grep/find/ls 与 pi 一致无条目。两张表由 app-tools.test.ts 对照 pi 常量锁定。 */
const PROMPT_GUIDELINES: Record<string, string[]> = {
  read: ["Use read to examine files instead of cat or sed."],
  write: ["Use write only for new files or complete rewrites."],
  edit: [
    "Use edit for targeted changes. Batch changes to one file in a single call.",
    "Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.",
  ],
};

function toPiToolResult(result: AppToolResult): PiToolResult {
  const details = result.display
    ? { app: { output: result.display } }
    : result.details
      ? { workspace: result.details }
      : {};
  return { content: result.content, details } as PiToolResult;
}

function buildTool(spec: AppToolSpec, call: PiAppToolCaller | undefined): ToolDefinition {
  const workspace = spec.group === "workspace";
  const snippet = workspace ? PROMPT_SNIPPETS[spec.name] : undefined;
  const guidelines = workspace ? PROMPT_GUIDELINES[spec.name] : undefined;
  return {
    name: spec.name,
    // pi 内建工具的 label 就是小写工具名(tools/*.ts);label 仅 TUI 用,保持同构。
    label: spec.name,
    description: spec.description,
    ...(snippet ? { promptSnippet: snippet } : {}),
    ...(guidelines ? { promptGuidelines: guidelines } : {}),
    parameters: spec.parameters as unknown as PiToolParameters,
    ...(workspace && spec.name === "edit"
      ? { prepareArguments: prepareEditArguments as ToolDefinition["prepareArguments"] }
      : {}),
    executionMode: "sequential",
    // 不用 pi 传入的 signal:取消走 driver.abort,应用侧用自己的生成信号收敛在途审批与执行。
    async execute(toolCallId, params) {
      if (!call) throw new Error(`应用工具通道未接线,无法执行 ${spec.name}`);
      const args = (params ?? {}) as Record<string, JsonValue>;
      return toPiToolResult(await call({ toolCallId, name: spec.name, args }));
    },
  };
}

export function createPiAppTools(specs: readonly AppToolSpec[], call: PiAppToolCaller | undefined): ToolDefinition[] {
  return specs.map((spec) => buildTool(spec, call));
}
