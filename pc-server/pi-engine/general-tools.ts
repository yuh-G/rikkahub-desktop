// pi-engine/general-tools.ts — 通用工具与 MCP 桥注册为 pi customTools(P4,方案 §3.2/§4.9)
//
// 挂载裁决(§4.9 落定):search_web / scrape_web / save_memory / ask_user + 按助手启用的 mcp__*。
// 不挂:use_skill(pi 原生 <available_skills> 替代)、get_time_info(有 bash)、tts/clipboard(v1 收面)。
//
// ask_user(P6 起进工作区):早期注释"挂起语义与 pi 循环冲突"针对的是聊天式"返回 pending 哨兵
// → 整批暂停→重触发"。pi 已有更强的 run-and-suspend 原语(gateToolApproval 在 execute 内挂起
// 单工具),ask_user 只是"决议里多带一个 answer 字段"的特例——经 inference-engine/ask-user-flow
// 的 gateAskUser 挂起,/tool-approval 端点把答复经 approval-gate 送达在途 execute,执行返回真实
// 结果,循环原地继续,零冲突。答案回灌模型的文本与聊天引擎逐字一致(扁平 {"answers":{...}}
// 契约,经 details.app.output 由事件桥还原成 text part)。
//
// 根源纪律:一行分发/守卫/审批逻辑都不复刻——
// - 声明:tools/bound 的同一组装配函数(与聊天引擎进模型的 schema 逐字同源);
// - 执行:tools/execution.executeToolCall(搜索开关守卫/MCP OAuth 预刷新/analytics/
//   save_memory 写策略全在其内);
// - 审批:tools/approval.initialApprovalState(MCP 每工具 needsApproval + 助手级
//   override 的既有体系原样生效;search/scrape/memory 恒 auto——与聊天引擎逐字一致)
//   + approval-flow 共享生命周期(与工作区工具同一状态机);
// - 结果:toolResultToParts + realizeToolResult(MCP 图片落盘为 /api/files URL)后,
//   模型面 = openAiToolOutput(与聊天回灌模型的字符串同源),UI 面 = entries 经
//   details.app.output 由事件桥整批还原(part.output 与聊天渲染契约逐字一致)。
//
// jsonl 体积纪律:单 text 条目时 content 即全部信息,不带 details.app(避免大文本
// 在引擎记忆里双写);仅当 entries 含图片/多条目时才带,桥按有无 app 标记选路。

import type { ToolDefinition } from "../../pi/packages/coding-agent/src/core/extensions/types.ts";
import type { Assistant, Conversation, JsonValue, Model, ToolOutputEntry } from "../foundation/types";
import type { GenerationEventSink } from "../inference-engine/events";
import { openAiLocalTools, openAiMcpTools, openAiSearchTools } from "../tools/bound";
import { executeToolCall, realizeToolResult, toolResultToParts } from "../tools/execution";
import { openAiToolOutput } from "../tools/format";
import { initialApprovalState } from "../tools/approval";
import { gateToolApproval } from "../inference-engine/approval-flow";
import { gateAskUser } from "../inference-engine/ask-user-flow";
import { normalizeAskUserQuestions, serializeAskUserAnswer, ASK_USER_TOOL_NAME } from "../tools/ask-user";

type PiToolParameters = ToolDefinition["parameters"];
type PiToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;

export interface PiGeneralToolsContext {
  conversation: Conversation;
  assistant: Assistant;
  sink: GenerationEventSink;
  /** save_memory 待确认队列的来源标注(当前 ASSISTANT 节点,与聊天路径同口径)。 */
  messageNodeId?: string;
  /** 生效模型。用于外挂 search_web 的防双搜门控(openAiSearchTools 单源谓词):模型
   *  已声明内置 search 时外挂让位。pi 引擎当前不接内置搜索(只挂外挂),传它是为了与
   *  聊天引擎同一注入源同一判定——未来 pi 接内置搜索或新引擎照抄时零成本继承。 */
  model?: Model | null;
}

/** entries → pi AgentToolResult。模型面文本与聊天引擎 resolvedToolOutput 同源
 *  (openAiToolOutput);UI 面 entries 走 details.app 还原通道。 */
function toGeneralPiToolResult(entries: ToolOutputEntry[]): PiToolResult {
  const text = openAiToolOutput(entries);
  const isPlainSingleText = entries.length === 1 && entries[0]?.type === "text";
  return {
    content: [{ type: "text", text }],
    details: isPlainSingleText ? {} : { app: { output: entries } },
  } as PiToolResult;
}

function buildGeneralTool(
  declaration: { name: string; description: string; parameters: Record<string, unknown> },
  ctx: PiGeneralToolsContext,
): ToolDefinition {
  const { name } = declaration;
  return {
    name,
    label: name,
    description: declaration.description,
    // 无 promptSnippet:不进 pi 系统提示词 Available tools 清单(那里只该有编码工具,
    // 引擎契约原文已有"you may have access to other custom tools"兜底句)——与聊天
    // 引擎"通用工具只出现在 API tools 数组"同构。
    parameters: declaration.parameters as unknown as PiToolParameters,
    // 与工作区工具同为 sequential:审批卡一次一张,MCP 慢调用不并发抢跑。
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      const args = (params ?? {}) as Record<string, JsonValue>;
      const argsJson = JSON.stringify(args);
      const approval = initialApprovalState(name, ctx.assistant, ctx.conversation, argsJson);
      // 域4-1:通用/MCP 工具审批的摘要——优先 url/query 等可读字段,退化工具名。
      const approvalTarget = args.url ?? args.query ?? args.content ?? args.path ?? args.command;
      const approvalSummary =
        typeof approvalTarget === "string" && approvalTarget.trim() ? approvalTarget.trim().slice(0, 120) : undefined;
      await gateToolApproval(approval, {
        conversationId: ctx.conversation.id,
        toolCallId,
        sink: ctx.sink,
        signal,
        toolName: name,
        ...(approvalSummary ? { summary: approvalSummary } : {}),
      });
      const raw = await executeToolCall(
        { id: toolCallId, function: { name, arguments: argsJson } },
        ctx.assistant,
        {
          conversationId: ctx.conversation.id,
          conversationTitle: ctx.conversation.title,
          messageNodeId: ctx.messageNodeId,
          signal,
        },
      );
      const entries = await realizeToolResult(await toolResultToParts(raw));
      return toGeneralPiToolResult(entries);
    },
  };
}

/** ask_user 专用构造:不经 gateToolApproval+executeToolCall,改走 gateAskUser——决议携答复
 *  载荷,答案即工具结果(扁平契约,与聊天引擎 answered 回放逐字一致)。executionMode 同为
 *  sequential:提问卡与审批卡一次一张,不与其它工具并发抢跑。 */
function buildAskUserTool(
  declaration: { name: string; description: string; parameters: Record<string, unknown> },
  ctx: PiGeneralToolsContext,
): ToolDefinition {
  return {
    name: declaration.name,
    label: declaration.name,
    description: declaration.description,
    parameters: declaration.parameters as unknown as PiToolParameters,
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      const args = (params ?? {}) as Record<string, JsonValue>;
      const normalized = normalizeAskUserQuestions(args.questions);
      if ("error" in normalized) throw new Error(normalized.error);
      const summary = normalized.questions[0]?.question.trim().slice(0, 120);
      const resolution = await gateAskUser({
        conversationId: ctx.conversation.id,
        toolCallId,
        sink: ctx.sink,
        signal,
        ...(summary ? { summary } : {}),
      });
      // denied/中止在 gateAskUser 内已抛错(桥映射 {error}/中断);此处返回时必为 answered。
      if (resolution.kind !== "answered") throw new Error("ask_user did not resolve to an answer");
      const entries: ToolOutputEntry[] = [{ type: "text", text: serializeAskUserAnswer(resolution.answers) }];
      return toGeneralPiToolResult(entries);
    },
  };
}

/** 会话装配入口:声明与聊天引擎同源(openAiSearchTools 带全局开关门控、save_memory
 *  带记忆开关+写策略门控、openAiMcpTools 带服务器/工具双层启用过滤),关掉的面在
 *  这里天然为空——用户没启用 MCP 时 pi 会话零 MCP 工具(§3.2)。 */
export function createPiGeneralTools(ctx: PiGeneralToolsContext): ToolDefinition[] {
  const declarations = [
    ...openAiSearchTools(ctx.model),
    ...openAiLocalTools(ctx.assistant).filter(
      (tool) => tool.function.name === "save_memory" || tool.function.name === ASK_USER_TOOL_NAME,
    ),
    ...openAiMcpTools(ctx.assistant),
  ];
  return declarations.map((decl) => {
    const shaped = {
      name: String(decl.function.name),
      description: String(decl.function.description ?? ""),
      parameters: (decl.function.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
    };
    return shaped.name === ASK_USER_TOOL_NAME ? buildAskUserTool(shaped, ctx) : buildGeneralTool(shaped, ctx);
  });
}
