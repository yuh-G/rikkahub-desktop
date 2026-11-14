// engines/app-tools.ts — 应用工具的应用侧实现(契约 AppToolSpec + host.tools.call 的执行面)
//
// 引擎只拿工具规格(名称/描述/JSON Schema/分组),调用一律交回这里:审批(含 ask_user 提问)、
// 执行、结果实体化在应用侧一次完成,执行中的部分输出直接写进工具卡(sink),不回绕引擎。
//
// 工具面:
// - 工作区工具:P4b 起由引擎自带(pi 内建工具定义 + 应用后端,pi-engine/builtin-tools.ts),不再作为应用工具
//   下发;执行前经 host.permission.check 回到这里的 createToolPermissionChecker 审批。下面的 group "workspace"
//   执行路径(executeWorkspaceToolCore)待 P4b.4 随移植层一并删除。
// - 通用工具(group "general",§4.9 落定):search_web / scrape_web / save_memory / ask_user +
//   按助手启用的 mcp__*。不挂 use_skill(pi 原生 <available_skills> 替代)、get_time_info
//   (有 bash)、tts/clipboard(v1 收面)。声明用 tools/bound 的同一组装配函数(与聊天引擎
//   进模型的 schema 逐字同源,关掉的面天然为空);执行走 tools/execution.executeToolCall
//   (搜索开关守卫/MCP OAuth 预刷新/analytics/save_memory 写策略全在其内)。
//
// 审批:tools/approval.decideAppToolPermission(与聊天引擎同一判定函数:工作区三档矩阵、MCP 每
// 工具 needsApproval + 助手级 override,search/scrape/memory 恒 auto)+ approval-flow 共享
// 生命周期。ask_user 是「决议里多带一个 answer 字段」的特例,经 gateAskUser 挂起,答案即工具
// 结果(扁平 {"answers":{...}} 契约,与聊天引擎 answered 回放逐字一致)。
//
// 结果形态(AppToolResult):
// - content 是模型可见结果。通用工具 = openAiToolOutput(entries),与聊天回灌模型的字符串同源。
// - display 是工具卡条目(realizeToolResult 已把 MCP 图片落盘为 /api/files URL)。单 text 条目时
//   content 即全部信息,不带 display(避免大文本在引擎记忆里双写)。
// - details 是工作区工具的结构化细节(diff/exitCode,jsonSafeDetails 截断口径与聊天引擎同源)。

import type { AppToolResult, AppToolSpec, PermissionCheck, PermissionGrant } from "./contract";
import type { Assistant, Conversation, JsonValue, Model, ToolOutputEntry } from "../foundation/types";
import type { GenerationEventSink, GenerationTarget } from "../inference-engine/events";
import { gateToolApproval } from "../inference-engine/approval-flow";
import { gateAskUser } from "../inference-engine/ask-user-flow";
import { decideAppToolPermission, decideEngineToolPermission, pluginToolApprovalState, pluginToolSessionKey } from "../tools/approval";
import { ASK_USER_TOOL_NAME, normalizeAskUserQuestions, serializeAskUserAnswer } from "../tools/ask-user";
import { openAiLocalTools, openAiMcpTools, openAiSearchTools } from "../tools/bound";
import { executeToolCall, realizeToolResult, toolResultToParts } from "../tools/execution";
import { openAiToolOutput } from "../tools/format";
import { getWorkspace, touchWorkspaceAccess } from "../workspace";
import { executeWorkspaceToolCore, jsonSafeDetails, openAiWorkspaceTools } from "../workspace/runtime";
import type { WorkspaceToolOutput } from "../workspace/tools/types";

export interface AppToolsContext {
  /** 会话对象(审批矩阵的 workspaceId/workspaceCwd 语境 + 执行内核的会话归属守卫)。 */
  conversation: Conversation;
  /** 生成快照里的助手(审批判定与通用工具执行都按它)。 */
  assistant: Assistant;
  /** 审批状态迁移与执行中部分输出的下沉(与引擎事件共用同一应用器)。 */
  sink: GenerationEventSink;
  /** save_memory 待确认队列的来源标注(当前 ASSISTANT 节点,与聊天路径同口径)。
   *  活落点:steer 分裂后新 ai_2 接管,执行时现读 node.id 才落到真正产出该工具调用的节点。 */
  target?: GenerationTarget;
  /** 生效模型。用于外挂 search_web 的防双搜门控(openAiSearchTools 单源谓词):模型已声明
   *  内置 search 时外挂让位,与聊天引擎同一注入源同一判定。 */
  model?: Model | null;
  /** 本轮生成的取消信号:等待审批中停止生成时卡收敛 denied,执行中的工具随之中止。 */
  signal?: AbortSignal;
}

export interface AppToolInvocation {
  toolCallId: string;
  name: string;
  args: Record<string, JsonValue>;
}

export type AppToolCaller = (call: AppToolInvocation) => Promise<AppToolResult>;

function specFromDeclaration(fn: Record<string, unknown>, group: AppToolSpec["group"]): AppToolSpec {
  return {
    name: String(fn.name),
    description: String(fn.description ?? ""),
    parameters: (fn.parameters ?? { type: "object", properties: {} }) as Record<string, JsonValue>,
    group,
  };
}

export function workspaceToolSpecs(conversation: Conversation): AppToolSpec[] {
  return openAiWorkspaceTools(conversation).map((decl) =>
    specFromDeclaration(decl.function as Record<string, unknown>, "workspace"),
  );
}

export function generalToolSpecs(assistant: Assistant, model?: Model | null): AppToolSpec[] {
  const declarations = [
    ...openAiSearchTools(model),
    ...openAiLocalTools(assistant).filter(
      (tool) => tool.function.name === "save_memory" || tool.function.name === ASK_USER_TOOL_NAME,
    ),
    ...openAiMcpTools(assistant),
  ];
  return declarations.map((decl) => specFromDeclaration(decl.function as Record<string, unknown>, "general"));
}

/** 本轮下发给引擎的应用工具:只有通用工具。工作区工具由引擎自带(pi 内建工具,P4b),执行前经
 *  host.permission.check 回应用审批。 */
export function appToolSpecsFor(ctx: AppToolsContext): AppToolSpec[] {
  return generalToolSpecs(ctx.assistant, ctx.model);
}

/** 内核部分输出 → 工具卡条目:text 原样、图片封成 data URL、结构化细节挂首个 text 条目的
 *  metadata.workspace(无 text 条目时补一个空载体)——与工具结果经 pi 回到事件桥的还原
 *  口径逐字一致。 */
function workspacePartialEntries(name: string, output: WorkspaceToolOutput<unknown>): ToolOutputEntry[] {
  const entries: ToolOutputEntry[] = output.content.map((item) =>
    item.type === "text" ? { type: "text", text: item.text } : { type: "image", url: `data:${item.mimeType};base64,${item.data}` },
  );
  const details = jsonSafeDetails(output.details);
  if (!details) return entries;
  const metadata = { workspace: { tool: name, details } };
  const firstText = entries.find((entry): entry is Extract<ToolOutputEntry, { type: "text" }> => (entry as { type?: unknown }).type === "text");
  if (firstText) firstText.metadata = metadata;
  else entries.push({ type: "text", text: "", metadata });
  return entries;
}

function workspaceResult(name: string, output: WorkspaceToolOutput<unknown>): AppToolResult {
  const details = jsonSafeDetails(output.details);
  return { content: output.content, ...(details ? { details: { tool: name, details } } : {}) };
}

function generalResult(entries: ToolOutputEntry[]): AppToolResult {
  const isPlainSingleText = entries.length === 1 && entries[0]?.type === "text";
  return {
    content: [{ type: "text", text: openAiToolOutput(entries) }],
    ...(isPlainSingleText ? {} : { display: entries }),
  };
}

/** 审批通知/状态摘要(域4-1):取审批对象本体,截断防爆通知体。 */
function summaryOf(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined;
}

async function callWorkspaceTool(ctx: AppToolsContext, name: string, call: AppToolInvocation): Promise<AppToolResult> {
  const { args, toolCallId } = call;
  const approval = decideAppToolPermission(name, ctx.assistant, ctx.conversation, JSON.stringify(args));
  const summary = summaryOf(args.command ?? args.path);
  // 返回 true = 用户对 pending 卡显式批准,是危险命令拦截的知情同意放行门
  // (workspace/runtime.ts),仅此路径可置 true。
  const userApproved = await gateToolApproval(approval, {
    conversationId: ctx.conversation.id,
    toolCallId,
    sink: ctx.sink,
    signal: ctx.signal,
    toolName: name,
    ...(summary ? { summary } : {}),
  });
  const output = await executeWorkspaceToolCore(name, args, {
    conversationId: ctx.conversation.id,
    userApproved,
    signal: ctx.signal,
    // 执行中部分输出直写工具卡(bash 内核 100ms 自节流,SSE 33ms 合帧)。非终局:不落
    // toolFinishedAt(issue #59 每工具计时终点);空快照(bash 起跑的首帧)不写。
    onUpdate: (partial) => {
      if (!partial.content.length) return;
      ctx.sink({ kind: "tool_result", toolCallId, output: workspacePartialEntries(name, partial), final: false });
    },
  });
  return workspaceResult(name, output);
}

async function callAskUser(ctx: AppToolsContext, call: AppToolInvocation): Promise<AppToolResult> {
  const normalized = normalizeAskUserQuestions(call.args.questions);
  if ("error" in normalized) throw new Error(normalized.error);
  const summary = normalized.questions[0]?.question.trim().slice(0, 120);
  const resolution = await gateAskUser({
    conversationId: ctx.conversation.id,
    toolCallId: call.toolCallId,
    sink: ctx.sink,
    signal: ctx.signal,
    ...(summary ? { summary } : {}),
  });
  // denied/中止在 gateAskUser 内已抛错;此处返回时必为 answered。
  if (resolution.kind !== "answered") throw new Error("ask_user did not resolve to an answer");
  return generalResult([{ type: "text", text: serializeAskUserAnswer(resolution.answers) }]);
}

async function callGeneralTool(ctx: AppToolsContext, call: AppToolInvocation): Promise<AppToolResult> {
  const { name, args, toolCallId } = call;
  const argsJson = JSON.stringify(args);
  const approval = decideAppToolPermission(name, ctx.assistant, ctx.conversation, argsJson);
  const summary = summaryOf(args.url ?? args.query ?? args.content ?? args.path ?? args.command);
  await gateToolApproval(approval, {
    conversationId: ctx.conversation.id,
    toolCallId,
    sink: ctx.sink,
    signal: ctx.signal,
    toolName: name,
    ...(summary ? { summary } : {}),
  });
  const raw = await executeToolCall({ id: toolCallId, function: { name, arguments: argsJson } }, ctx.assistant, {
    conversationId: ctx.conversation.id,
    conversationTitle: ctx.conversation.title,
    messageNodeId: ctx.target?.node.id,
    signal: ctx.signal,
  });
  return generalResult(await realizeToolResult(await toolResultToParts(raw)));
}

/** 本轮的工具调用入口。只认本轮下发过的规格(分组决定执行路径);被拒绝或执行失败以错误
 *  拒绝,错误文本即给模型的工具结果(审批拒绝是历史契约文案,与聊天引擎逐字一致)。 */
export function createAppToolCaller(ctx: AppToolsContext, specs: readonly AppToolSpec[]): AppToolCaller {
  const groups = new Map(specs.map((spec) => [spec.name, spec.group]));
  return async (call) => {
    const group = groups.get(call.name);
    if (!group) throw new Error(`Unknown tool: ${call.name}`);
    // 工作区组的名字由执行内核校验(executeWorkspaceToolCore 对未知名报错回灌模型)。
    if (group === "workspace") return callWorkspaceTool(ctx, call.name, call);
    if (call.name === ASK_USER_TOOL_NAME) return callAskUser(ctx, call);
    return callGeneralTool(ctx, call);
  };
}

/** 引擎自己执行的工具的审批请求(契约 PermissionCheck 去掉轮次归属,归属由本轮绑定给出)。 */
export type ToolPermissionRequest = Omit<PermissionCheck, "conversationId" | "turnId">;

export type ToolPermissionChecker = (req: ToolPermissionRequest) => Promise<PermissionGrant>;

const DEFAULT_GRANT: PermissionGrant = { scope: "default" };

/** 引擎自己执行的工具在执行前过应用审批。工具卡由引擎事件建,这里只驱动它的审批态;拒绝与中止的语义
 *  与应用工具同一生命周期。
 *  - 插件工具:类别 plugin,默认询问;插件页免问或本会话已「总是允许」则免问。放行范围恒为 default。
 *  - 引擎自带工具(pi 的 read / bash 等):按引擎给的类别与对象走工作区三档矩阵。用户在卡上批准了这次调用
 *    或档位是完全访问 → unrestricted(写入走宽界、危险命令放行),否则 default。 */
export function createToolPermissionChecker(ctx: AppToolsContext): ToolPermissionChecker {
  return async (req) => {
    const flow = { conversationId: ctx.conversation.id, toolCallId: req.toolCallId, sink: ctx.sink, signal: ctx.signal, toolName: req.toolName };
    if (req.origin.kind === "plugin") {
      const { pluginId } = req.origin;
      await gateToolApproval(pluginToolApprovalState(ctx.conversation.id, pluginId, req.toolName), {
        ...flow,
        sessionAllowKey: pluginToolSessionKey(pluginId, req.toolName),
      });
      return DEFAULT_GRANT;
    }
    if (!req.category || !req.target) throw new Error(`引擎工具 ${req.toolName} 的审批请求缺少类别或对象`);
    const workspace = ctx.conversation.workspaceId ? getWorkspace(ctx.conversation.workspaceId) : null;
    if (!workspace) {
      throw new Error(`Tool '${req.toolName}' is unavailable: this conversation is no longer bound to an existing workspace.`);
    }
    const approval = decideEngineToolPermission(ctx.conversation, req.toolName, req.category, req.target);
    const summary = summaryOf(req.args.command ?? req.args.path);
    // 返回 true = 用户对 pending 卡显式批准:区外写入与危险命令的知情同意。
    const userApproved = await gateToolApproval(approval, { ...flow, ...(summary ? { summary } : {}) });
    touchWorkspaceAccess(workspace.id);
    return userApproved || workspace.permissionPreset === "full_access" ? { scope: "unrestricted" } : DEFAULT_GRANT;
  };
}
