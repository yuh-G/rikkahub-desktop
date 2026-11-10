// pi-engine/workspace-tools.ts — 我们的七个工作区工具注册为 pi customTools(P3)
//
// 方案 §4.3 裁决:pi 的大脑 + 我们已 pi 化的手。pi 内建工具不启用(noTools:"builtin",
// 它们绕开我们的审批与边界壳);本模块把 workspace/ 的守卫+执行内核
// (executeWorkspaceToolCore:三道闸/危险命令拦截/宽严边界/K3 shell)包装成 pi
// ToolDefinition。名称/描述/JSON Schema 复用移植层(与 pi 原版逐字一致,模型无感);
// promptSnippet/promptGuidelines 逐字镜像 pi 内建工具(coding-agent/src/core/tools/*.ts),
// 系统提示词的 Available tools/Guidelines 措辞与 pi 原生体验等同(§七-3 实证:
// 有 snippet 才进 Available tools)。
//
// 审批内化(方案 §4.4):execute 里查三档矩阵(tools/approval.initialApprovalState,
// 与聊天引擎同一判定函数)→ 生命周期(挂卡/等待/放行/拒绝/中止收敛)在共享状态机
// approval-flow.gateToolApproval 里,与 MCP 桥/通用工具(general-tools)同一份。
//
// executionMode 全部 "sequential":pi 默认并行执行工具批(agent.ts:230),批内任一
// sequential 即整批顺序(agent-loop.ts:422)——审批卡"执行到哪个弹哪个"的节奏、
// bash 输出不交错、与聊天引擎顺序执行心智,三者都靠它。
//
// 参数校验:pi 1.5 起所有工具参数经 pi-schema 校验(ai/src/utils/validation.ts 的
// compile(schema, { coerce: true })),JSON Schema 与 TypeBox 同一条路径并做宽松转换
// (数字字符串→数字、单值→数组);我们的 OpenAI 形状 schema 原样可用。
// edit 与 pi 原版一样挂 prepareArguments,legacy 形状(顶层 oldText/JSON 字符串 edits)
// 在校验前修复。

import type { ToolDefinition } from "../../pi/packages/coding-agent/src/core/extensions/types.ts";
import type { Assistant, Conversation, JsonValue } from "../foundation/types";
import type { GenerationEventSink } from "../inference-engine/events";
import { initialApprovalState } from "../tools/approval";
import type { WorkspaceToolName } from "../workspace/approval";
import { executeWorkspaceToolCore, jsonSafeDetails, openAiWorkspaceTools } from "../workspace/runtime";
import type { WorkspaceToolOutput } from "../workspace/tools/types";
import { prepareEditArguments } from "../workspace/tools/edit";
import { gateToolApproval } from "../inference-engine/approval-flow";

type PiToolParameters = ToolDefinition["parameters"];
type PiToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;

/** pi 内建工具的 Available tools 一行摘要,逐字镜像 pi 各工具的
 *  `<name>ToolSystemPromptContribution.snippet`(coding-agent/src/core/tools/*.ts)。 */
const PROMPT_SNIPPETS: Record<WorkspaceToolName, string> = {
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
 *  环境变量);grep/find/ls 与 pi 一致无条目。两张表由 workspace-tools.test.ts 对照 pi 常量锁定。 */
const PROMPT_GUIDELINES: Partial<Record<WorkspaceToolName, string[]>> = {
  read: ["Use read to examine files instead of cat or sed."],
  write: ["Use write only for new files or complete rewrites."],
  edit: [
    "Use edit for targeted changes. Batch changes to one file in a single call.",
    "Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.",
  ],
};

export interface PiWorkspaceToolsContext {
  /** 会话对象(审批矩阵的 workspaceId/workspaceCwd 语境 + 执行内核的会话归属守卫)。 */
  conversation: Conversation;
  /** 生成快照里的助手(initialApprovalState 签名;工作区工具的判定实际只依赖会话)。 */
  assistant: Assistant;
  /** 审批状态迁移事件下沉(pending/approved/denied 卡状态,与桥共用同一应用器)。 */
  sink: GenerationEventSink;
}

/** 内核产出 → pi AgentToolResult。content 形状与 pi TextContent/ImageContent 同构
 *  (移植层 types.ts 就是按 pi 形状定义的);details 打上 {workspace:{tool,details}}
 *  标记,事件桥据此还原 part metadata(前端 diff/exitCode 渲染契约,与聊天引擎
 *  runtime.toToolResult 同源同截断)。 */
function toPiToolResult(name: WorkspaceToolName, output: WorkspaceToolOutput<unknown>): PiToolResult {
  const details = jsonSafeDetails(output.details);
  return {
    content: output.content,
    details: details ? { workspace: { tool: name, details } } : {},
  } as PiToolResult;
}

function buildTool(
  name: WorkspaceToolName,
  declaration: { description: string; parameters: Record<string, unknown> },
  ctx: PiWorkspaceToolsContext,
): ToolDefinition {
  return {
    name,
    // pi 内建工具的 label 就是小写工具名(tools/*.ts);label 仅 TUI 用,保持同构。
    label: name,
    description: declaration.description,
    promptSnippet: PROMPT_SNIPPETS[name],
    ...(PROMPT_GUIDELINES[name] ? { promptGuidelines: PROMPT_GUIDELINES[name] } : {}),
    parameters: declaration.parameters as unknown as PiToolParameters,
    ...(name === "edit" ? { prepareArguments: prepareEditArguments as ToolDefinition["prepareArguments"] } : {}),
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate) {
      const args = (params ?? {}) as Record<string, JsonValue>;
      // —— 审批内化:参数齐备的终局判定(与聊天引擎 initialApprovalState 同一函数),
      // 生命周期走共享状态机;返回 true = 用户对 pending 卡显式批准,是危险命令
      // 拦截的知情同意放行门(workspace/runtime.ts),仅此路径可置 true。 ——
      const approval = initialApprovalState(name, ctx.assistant, ctx.conversation, JSON.stringify(args));
      // 域4-1:通知摘要取审批对象本体(bash=command,write/edit/read=path),截断防爆通知体。
      const approvalTarget = args.command ?? args.path;
      const approvalSummary = typeof approvalTarget === "string" && approvalTarget.trim() ? approvalTarget.trim().slice(0, 120) : undefined;
      const userApproved = await gateToolApproval(approval, {
        conversationId: ctx.conversation.id,
        toolCallId,
        sink: ctx.sink,
        signal,
        toolName: name,
        ...(approvalSummary ? { summary: approvalSummary } : {}),
      });
      const result = await executeWorkspaceToolCore(name, args, {
        conversationId: ctx.conversation.id,
        userApproved,
        signal,
        // 执行中部分输出走 pi 原生 onUpdate 通道(→ tool_execution_update → 桥 →
        // tool_result 快照;bash 内核 100ms 自节流,SSE 33ms 合帧,无双重节流迟滞)。
        onUpdate: onUpdate ? (partial) => onUpdate(toPiToolResult(name, partial)) : undefined,
      });
      return toPiToolResult(name, result);
    },
  };
}

/** 会话装配入口:按 K3 挂载矩阵(bash 可用: read/bash/edit/write;不可用: read/edit/
 *  write/grep/find/ls)产出 pi customTools。声明(名称/描述/schema)复用挂载层
 *  openAiWorkspaceTools——与聊天引擎进模型的声明同源,逐字一致。 */
export function createPiWorkspaceTools(ctx: PiWorkspaceToolsContext): ToolDefinition[] {
  const declarations = openAiWorkspaceTools(ctx.conversation);
  return declarations.map((decl) => {
    const fn = decl.function as Record<string, JsonValue>;
    const name = String(fn.name) as WorkspaceToolName;
    return buildTool(
      name,
      { description: String(fn.description), parameters: fn.parameters as Record<string, unknown> },
      ctx,
    );
  });
}
