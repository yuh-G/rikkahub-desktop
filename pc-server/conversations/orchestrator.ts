// conversations/orchestrator.ts — 会话生成编排（Provider 分发、流式工具循环挂接、生成主链路与收尾任务）
// 纪律：纯搬迁自 server.ts（阶段 5.3g），行为不变。推理引擎经 GenerationEvent sink 与本层解耦。

import type { ApiMessage, Assistant, Conversation, JsonValue, Message, MessageNode, Model, Provider, ToolPendingOutput } from "../foundation/types";
import { bumpAnalyticsErrCount } from "../app-config/analytics";
import type { GenerationEventSink, StreamHooksWithSink, ToolExecutor } from "../inference-engine/events";
import { id, isRecord, message, textFromParts } from "../foundation/utils";
import { classifyProxyError } from "../foundation/net";
import { classifyContextOverflowError, classifyOutputCapError, classifyRateLimitError } from "../inference-engine/provider-errors";
import { state } from "../persistence/json-store";
import { addLog } from "../api/logs";
import { broadcastConversation, broadcastEngineStatus, broadcastList, broadcastNodeUpdate, touchStream } from "../api/sse";
import { applyCustomBody, applyRequestHeaders, findModel } from "../model-providers";
import { endpointFor } from "../model-providers/checks";
import { openAiMaxTokensField, reasoningLevelNormalized } from "../model-providers/request-dialect";
import {
  claudeCacheControlEphemeral,
  claudeMessagesFromApiMessages,
  claudeSystemContent,
  claudeThinkingPayload,
  claudeToolsFromOpenAiTools,
  hostOfProvider,
  isModelAllowTemperature,
  openAiChatCompletionsModalities,
  reasoningPayloadForProvider,
  responseApiBuiltInTools,
  responseApiIncludeForProvider,
  responseApiReasoningForProvider,
  supportsAbility,
} from "../inference-engine/message-builder";
import {
  buildGoogleRequestBody,
  conversationMessagesForApi,
  conversationResponseApiInput,
  conversationResponseApiInstructions,
} from "../inference-engine/conversation-encoding";
import {
  fetchClaudeTextWithTools,
  fetchOpenAiText,
  fetchOpenAiTextStreaming,
  fetchText,
  modelsDevCache,
  streamClaudeChatWithTools,
  streamGoogleChatWithTools,
} from "../inference-engine/providers";
import { contextWindowFor, requiredOutputCap } from "../model-providers/model-limits";
import {
  finishReasoningParts,
  setMessageLoading,
  streamStartedMessages,
} from "../inference-engine/parts";
import { createGenerationEventApplier } from "./generation-apply";
import { apiToolCallFromPart, toolExecutionErrorPayload, toolResultTextForApi } from "../tools/format";
import { conversationFunctionTools } from "../tools/bound";
import { executeToolCall, realizeToolResult, toolResultToParts } from "../tools/execution";
import type { WorkspaceRuntime } from "../workspace/runtime";
import {
  createEngineRegistry,
  resolveEngine,
  type EngineAdapter,
  type EngineCompactContext,
  type EngineCompactionResult,
  type EngineKind,
  type EngineRunContext,
} from "../engines";
import { MANUAL_COMPACT_KEEP_RECENT_TOKENS, runPiCompaction, runPiGeneration, type CapturedEngineCompaction } from "../pi-engine/runner";
import { mapProviderModelToPi } from "../pi-engine/model-bridge";
import { createPiWorkspaceTools } from "../pi-engine/workspace-tools";
import { createPiGeneralTools } from "../pi-engine/general-tools";
import { createPiSessionResources } from "../pi-engine/resources";
import { piPromptInputFromParts } from "../pi-engine/attachments";
import { effectiveEngineCompaction, type EngineCompactionRecord } from "../pi-engine/context-encoder";
import { encodableMessages, enrichMessages, applyTemplateToMessage } from "../inference-engine/message-enrichment";
import { applyOutputTransforms } from "../assistants";
import { TITLE_CHARACTER_LIMIT } from "../app-config/prompts";
import { flushConvDirtyNow, getConversation, getConversationsDb, markConversationRowDirty, markMessageNodeDirty, persistConversation, scheduleThrottledConvFlush, selectedConversationMessages } from "./index";
import { checkoutConversation, releaseConversation } from "./working-set";
import { conversationExistsInDb } from "./read-queries";
import { reportError } from "../observability/app-errors";
import { awaitingApproval, generating } from "./generation-state";
import { deliverQueuedReply, isQueuePaused, notifyQueuedGenerationDispatched, pauseMessageQueue, setOnQueuedGenerationDispatched, shiftNextQueued } from "./message-queue";
import {
  appendTextPart,
  canResumeToolExecution,
  ensureUsage,
  findAssistant,
  finishMessage,
  hasPendingToolApproval,
  hasResumableToolParts,
  toolApprovalType,
} from "./helpers";
import { generateSuggestionsForConversation, generateTitleForConversation, limitAuxiliaryText, markCompactionBoundary, modelExists, resolveFastModelId, shouldAutoGenerateTitle } from "./auxiliary";

/** 生成入口一次性解析的配置快照（P1-4）。流式生成横跨多个 await 点，用户中途改配置
 *  （换模型/改工具集/删助手）时，updateSettings 会整体替换 state.settings——持有入口
 *  时刻的引用即天然快照（旧对象不会被原地修改），保证同一次生成读到同一代配置。 */
export interface GenerationSnapshot {
  assistant: Assistant;
  provider: Provider;
  model: Model;
}

export async function callProvider(
  conversation: Conversation,
  signal?: AbortSignal,
  hooks?: StreamHooksWithSink,
  snapshot?: GenerationSnapshot,
) {
  const assistant = snapshot?.assistant ?? findAssistant(conversation.assistantId);
  const picked = snapshot
    ? { provider: snapshot.provider, model: snapshot.model }
    : findModel(assistant.chatModelId ?? state.settings.chatModelId);
  const providerItem = picked.provider;
  const selectedModel = picked.model.modelId === "auto" ? "gpt-4o-mini" : picked.model.modelId;
  const url = endpointFor(providerItem);
  const headers = applyRequestHeaders({ "Content-Type": "application/json" }, assistant, providerItem, picked.model, conversation.id);
  // 对齐 e63d017：OpenAI 路径才让 includeHistoryReasoning 生效；
  // claude/google 不走 OpenAI assistant 序列化，一律保持 true。
  const includeHistoryReasoning =
    providerItem.type === "openai" ? providerItem.includeHistoryReasoning !== false : true;
  const messagesForApi = conversationMessagesForApi(conversation, assistant, includeHistoryReasoning);
  let body: Record<string, any>;

  if (providerItem.type === "google") {
    // issue10：Gemini 鉴权走 x-goog-api-key 头（与安卓非 Vertex 路径、Cherry Studio 一致）。
    // 此前用 ?key= query，官方两者都收，但主流中转网关只解析 header，query 会被判 invalid key。
    headers["x-goog-api-key"] = providerItem.apiKey;
    const baseUrl = providerItem.baseUrl;
    body = buildGoogleRequestBody(messagesForApi, picked.model, assistant);
    const finalBody = applyCustomBody(body, assistant, picked.model);
    // 有 hooks（来自会话）时走 SSE 流式 + 工具循环；辅助调用无 hooks 时退回非流式。
    if (hooks?.message != null) {
      return streamGoogleChatWithTools(baseUrl, headers, selectedModel, finalBody, providerItem, assistant, signal, hooks);
    }
    const googleUrl = `${baseUrl.replace(/\/+$/, "")}/models/${selectedModel}:generateContent`;
    return fetchText(googleUrl, headers, finalBody, providerItem, (raw) => raw.candidates?.[0]?.content?.parts?.map((part: any) => part?.text ?? "").join("") ?? "", signal);
  }

  if (providerItem.type === "claude") {
    headers["x-api-key"] = providerItem.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    const messages = messagesForApi;
    const systemContent = messages.find((item) => item.role === "system")?.content;
    const functionTools = supportsAbility(picked.model, "TOOL")
      ? conversationFunctionTools(assistant, picked.model)
      : [];
    const claudeTools = claudeToolsFromOpenAiTools(functionTools, providerItem);
    const normalizedReasoning = reasoningLevelNormalized(assistant.reasoningLevel);
    const reasoningActive = supportsAbility(picked.model, "REASONING") && normalizedReasoning !== "off";
    // Always stream when invoked from a conversation (hooks present). The streaming path handles
    // text + thinking + tool_use deltas live, matching Android (ClaudeProvider.streamText). The
    // non-streaming fallback only runs for auxiliary calls without hooks (title/translate, etc.).
    const canStream = hooks?.message != null;
    body = {
      model: selectedModel,
      // 上限四级(requiredOutputCap 单源,与工作区引擎同一函数):助手设置 > 目录真实
      // 输出上限(按端点身份查,拒 output≥context 的占位行)> 方言兜底,再收进窗口。
      // Anthropic 协议 max_tokens 必填,所以这条路必须给数——但绝不能给"名字撞来的"数:
      // 2026-09-09 智谱 GLM-5.3 的 1210 报障就是旧查表在 213 个目录里撞到某转售商的
      // {context:1048576, output:1048576} 占位行,把窗口尺寸当输出上限发了出去。
      max_tokens: requiredOutputCap(modelsDevCache, providerItem, picked.model.modelId, assistant.maxTokens),
      stream: canStream,
      system: claudeSystemContent(systemContent, providerItem),
      messages: claudeMessagesFromApiMessages(messages, providerItem),
      // 顶层 cache_control: 让 Anthropic 自动管理缓存断点
      // 对齐安卓 ClaudeProvider.kt:275-278 (commit d2e52106)
      ...(providerItem.promptCaching === true
        ? { cache_control: claudeCacheControlEphemeral(providerItem) }
        : {}),
      ...(assistant.temperature != null && !reasoningActive ? { temperature: assistant.temperature } : {}),
      ...(assistant.topP != null ? { top_p: assistant.topP } : {}),
      // thinking + output_config：DeepSeek 走 Claude 格式时用 display:"raw" 展示原始思维链
      ...claudeThinkingPayload(picked.model, assistant.reasoningLevel),
      ...(claudeTools.length ? { tools: claudeTools } : {}),
    };
    if (canStream) {
      return streamClaudeChatWithTools(url, headers, applyCustomBody(body, assistant, picked.model), providerItem, assistant, signal, hooks!);
    }
    return fetchClaudeTextWithTools(url, headers, applyCustomBody(body, assistant, picked.model), providerItem, assistant, signal, hooks);
  }

  headers.Authorization = `Bearer ${providerItem.apiKey}`;
  // 台账 §7.4,对齐安卓 ChatCompletionsAPI.kt:262 —— OpenRouter 在请求体发 session_id(非
  // 头;网关据此把同会话路由到同一上游实例,前缀缓存更可能命中)。仅 chat-completions 形态
  // 有此事;responses 形态安卓无对应。conversation.id 即会话身份(与 prompt_cache_key 同物)。
  const openRouterSessionId =
    hostOfProvider(providerItem) === "openrouter.ai" ? conversation.id : undefined;
  if (providerItem.useResponseApi) {
    const functionTools = supportsAbility(picked.model, "TOOL") ? conversationFunctionTools(assistant, picked.model) : [];
    const builtInTools = responseApiBuiltInTools(picked.model);
    const systemContent = conversationResponseApiInstructions(conversation, assistant);
    const reasoning = responseApiReasoningForProvider(providerItem, picked.model, assistant.reasoningLevel);
    const include = responseApiIncludeForProvider(providerItem, picked.model);
    body = {
      model: selectedModel,
      stream: false,
      store: false,
      ...(systemContent ? { instructions: systemContent } : {}),
      input: conversationResponseApiInput(conversation, assistant),
      ...(isModelAllowTemperature(picked.model) ? { temperature: assistant.temperature ?? undefined } : {}),
      ...(isModelAllowTemperature(picked.model) ? { top_p: assistant.topP ?? undefined } : {}),
      ...(assistant.maxTokens != null ? { max_output_tokens: assistant.maxTokens } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(include ? { include } : {}),
      ...(providerItem.promptCacheKey === true ? { prompt_cache_key: conversation.id } : {}),
      tools: [
        ...functionTools.map((tool: any) => ({
          type: "function",
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })),
        ...builtInTools,
      ].filter(Boolean),
    };
    if (!body.tools.length) delete body.tools;
    return fetchText(url, headers, applyCustomBody(body, assistant, picked.model), providerItem, (raw) => raw.output_text ?? raw.output?.flatMap((item: any) => item.content ?? []).map((item: any) => item.text ?? "").join("\n"), signal);
  }
  const tools = supportsAbility(picked.model, "TOOL") ? conversationFunctionTools(assistant, picked.model) : [];
  body = {
    model: selectedModel,
    messages: messagesForApi,
    temperature: isModelAllowTemperature(picked.model) ? assistant.temperature ?? undefined : undefined,
    top_p: isModelAllowTemperature(picked.model) ? assistant.topP ?? undefined : undefined,
    // 上限字段名走统一请求方言（model-providers/request-dialect）：官方 OpenAI 口
    // max_completion_tokens（o 系硬要求），其余 max_tokens（第三方对未知字段静默忽略）。
    ...(assistant.maxTokens != null ? { [openAiMaxTokensField(hostOfProvider(providerItem))]: assistant.maxTokens } : {}),
    ...(providerItem.type === "openai" ? { modalities: openAiChatCompletionsModalities(picked.model, providerItem) } : {}),
    ...reasoningPayloadForProvider(providerItem, picked.model, assistant.reasoningLevel),
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? "auto" : undefined,
    ...(providerItem.promptCacheKey === true ? { prompt_cache_key: conversation.id } : {}),
    ...(openRouterSessionId ? { session_id: openRouterSessionId } : {}),
  };
  return fetchOpenAiText(url, headers, applyCustomBody(body, assistant, picked.model), providerItem, assistant, signal, hooks);
}

export async function callProviderStreaming(
  conversation: Conversation,
  assistantMessage: Message,
  assistantNode: MessageNode,
  ctx: { signal?: AbortSignal; sink: GenerationEventSink; executeTool: ToolExecutor; snapshot?: GenerationSnapshot },
): Promise<string> {
  const assistant = ctx.snapshot?.assistant ?? findAssistant(conversation.assistantId);
  const picked = ctx.snapshot
    ? { provider: ctx.snapshot.provider, model: ctx.snapshot.model }
    : findModel(assistant.chatModelId ?? state.settings.chatModelId);
  const providerItem = picked.provider;
  const selectedModel = picked.model.modelId === "auto" ? "gpt-4o-mini" : picked.model.modelId;
  const url = endpointFor(providerItem);
  const headers = applyRequestHeaders(
    { "Content-Type": "application/json", Authorization: `Bearer ${providerItem.apiKey}` },
    assistant,
    providerItem,
    picked.model,
    conversation.id,
  );
  const openRouterSessionId =
    hostOfProvider(providerItem) === "openrouter.ai" ? conversation.id : undefined;
  const messagesForApi = conversationMessagesForApi(
    conversation,
    assistant,
    // 对齐 e63d017：OpenAI 类型 provider 才尊重 includeHistoryReasoning 选项；
    // 默认 true，仅当用户显式关闭时才不回传历史 reasoning_content。
    providerItem.type === "openai" ? providerItem.includeHistoryReasoning !== false : true,
  );
  const tools = supportsAbility(picked.model, "TOOL") ? conversationFunctionTools(assistant, picked.model) : [];
  const hooks: StreamHooksWithSink = {
    message: assistantMessage,
    conversation,
    node: assistantNode,
    sink: ctx.sink,
    executeTool: ctx.executeTool,
  };
  if (providerItem.type !== "openai") {
    // 把本函数已解析的快照透传，确保 claude/google 路径与 openai 路径读到同一代配置
    return callProvider(conversation, ctx.signal, hooks, { assistant, provider: picked.provider, model: picked.model });
  }
  if (providerItem.useResponseApi) {
    const responseTools = [
      ...tools.map((tool: any) => ({
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      })),
      ...responseApiBuiltInTools(picked.model),
    ];
    const systemContent = conversationResponseApiInstructions(conversation, assistant);
    const reasoning = responseApiReasoningForProvider(providerItem, picked.model, assistant.reasoningLevel);
    const include = responseApiIncludeForProvider(providerItem, picked.model);
    const body = applyCustomBody({
      model: selectedModel,
      stream: true,
      store: false,
      ...(systemContent ? { instructions: systemContent } : {}),
      input: conversationResponseApiInput(conversation, assistant),
      ...(isModelAllowTemperature(picked.model) ? { temperature: assistant.temperature ?? undefined } : {}),
      ...(isModelAllowTemperature(picked.model) ? { top_p: assistant.topP ?? undefined } : {}),
      ...(assistant.maxTokens != null ? { max_output_tokens: assistant.maxTokens } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(include ? { include } : {}),
      ...(providerItem.promptCacheKey === true ? { prompt_cache_key: conversation.id } : {}),
      tools: responseTools.length ? responseTools : undefined,
    }, assistant, picked.model);
    return fetchOpenAiTextStreaming(url, headers, body, providerItem, assistant, hooks, ctx.signal);
  }
  const body = applyCustomBody({
    model: selectedModel,
    messages: messagesForApi,
    temperature: isModelAllowTemperature(picked.model) ? assistant.temperature ?? undefined : undefined,
    top_p: isModelAllowTemperature(picked.model) ? assistant.topP ?? undefined : undefined,
    // 上限字段名走统一请求方言（与非流式路径同一行注释所指）。
    ...(assistant.maxTokens != null ? { [openAiMaxTokensField(hostOfProvider(providerItem))]: assistant.maxTokens } : {}),
    ...(providerItem.type === "openai" ? { modalities: openAiChatCompletionsModalities(picked.model, providerItem) } : {}),
    ...reasoningPayloadForProvider(providerItem, picked.model, assistant.reasoningLevel),
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? "auto" : undefined,
    ...(providerItem.promptCacheKey === true ? { prompt_cache_key: conversation.id } : {}),
    ...(openRouterSessionId ? { session_id: openRouterSessionId } : {}),
    stream: true,
    stream_options: hostOfProvider(providerItem) === "api.mistral.ai" ? undefined : { include_usage: true },
  }, assistant, picked.model);
  return fetchOpenAiTextStreaming(url, headers, body, providerItem, assistant, hooks, ctx.signal);
}

export async function executeApprovedToolPart(
  part: Record<string, JsonValue>,
  assistant: Assistant,
  context?: { conversationId?: string; messageNodeId?: string; signal?: AbortSignal },
) {
  const approvalType = toolApprovalType(part);
  if (approvalType === "answered") return String((part.approvalState as Record<string, JsonValue>)?.answer ?? "");
  if (approvalType === "denied") {
    const reason = String((part.approvalState as Record<string, JsonValue>)?.reason ?? "").trim() || "No reason provided";
    return { error: `Tool execution denied by user. Reason: ${reason}` };
  }
  // 走到这里 = 用户对 pending 卡显式批准：userApproved 是危险命令拦截的
  // 知情同意放行门（workspace/runtime.ts），仅此路径可置 true。
  return executeToolCall(apiToolCallFromPart(part), assistant, { ...context, userApproved: true });
}

export async function resumeApprovedToolParts(
  conversation: Conversation,
  assistant: Assistant,
  assistantMessage: Message,
  assistantNode: MessageNode,
  useResponseInput: boolean,
  signal?: AbortSignal,
) {
  const toolMessages: ApiMessage[] = [];
  let changed = false;
  for (const part of assistantMessage.parts) {
    if (!isRecord(part) || part.type !== "tool") continue;
    if (Array.isArray(part.output) && part.output.length > 0) continue;
    if (!canResumeToolExecution(part)) continue;
    let toolResult: unknown;
    try {
      toolResult = await executeApprovedToolPart(part, assistant, {
        conversationId: conversation.id,
        messageNodeId: assistantNode.id,
        signal,
      });
    } catch (err) {
      toolResult = toolExecutionErrorPayload(err);
    }
    const normalized = await toolResultToParts(toolResult);
    part.output = await realizeToolResult(normalized);
    // issue #59:审批恢复(批准后重跑/暂停后 resume)直写 output,不经应用器——每工具
    // 计时终点在这里补戳(只补不覆盖)。denied 分支走 toolExecutionErrorPayload 的
    // {error} 载荷语义,同样是被用户裁决的终局,一并定格。
    if (!isRecord(part.metadata) || part.metadata.toolFinishedAt == null) {
      part.metadata = { ...(isRecord(part.metadata) ? part.metadata : {}), toolFinishedAt: new Date().toISOString() };
    }
    changed = true;
    toolMessages.push(
      useResponseInput
        ? { type: "function_call_output", call_id: String(part.toolCallId ?? ""), output: toolResultTextForApi(part) }
        : { role: "tool", tool_call_id: String(part.toolCallId ?? ""), content: toolResultTextForApi(part) },
    );
  }
  if (changed) {
    conversation.updateAt = Date.now();
    touchStream({ message: assistantMessage, conversation, node: assistantNode });
  }
  return toolMessages;
}

function cloneConversation(conversation: Conversation): Conversation {
  return JSON.parse(JSON.stringify(conversation)) as Conversation;
}

// 批6复审 G2:当前生成流正在写的消息(按会话)。R2-3 的入口接管 abort 后,旧流异步退出,
// 若新流经 ensureAssistantGenerationNode 复用了同一空占位消息,旧流的收尾不得再触碰它。
// generating 登记判定"是否被接管",本记录判定"新流是否复用了同一消息对象"。
const activeGenerationMessages = new Map<string, Message>();

function completeConversationGeneration(conversationId: string, controller: AbortController) {
  const current = generating.get(conversationId);
  if (current !== controller) {
    // 已被接管(current 为新流 controller):所有权归新流,不得清。
    // 登记被外部清除(stop/删会话,current 为空):顺手清所有权记录,防陈旧 Message 引用滞留。
    if (!current) activeGenerationMessages.delete(conversationId);
    return;
  }
  generating.delete(conversationId);
  activeGenerationMessages.delete(conversationId);
  // The generating Map drives the sidebar's per-conversation streaming indicator
  // (rendered via the conversations-list SSE). Now that broadcastNodeUpdateNow no
  // longer pings the list on every chunk (see comment at api/sse.ts scheduleNodeBroadcast), we have
  // to explicitly refresh on the false→true and true→false transitions so the
  // indicator turns on/off. Caller `generateAnswer` calls broadcastConversation
  // at start which already touches broadcastList, and we cover the end transition
  // right here.
  broadcastList();
  // 1.2.6:流式结束,全量 reconcile 活库——刷残余脏标记 + persistConversation,把流式
  // 期间增量 upsert 的节点和任何新增/删除的节点统一对齐(清孤立节点行)。幂等
  // (upsert 会话行 + 删旧节点 + 重插)。会话已被并发删除时跳过;flushConvDirty
  // 也会跳过已删会话的脏标记。
  flushConvDirtyNow();
  const conv = getConversation(conversationId);
  if (conv) persistConversation(conv);
}

function conversationStillExists(conversationId: string) {
  // DB-first 批1:直查活库。新建会话即时落库(ensureConversation 1.2.6 起),无漏检窗口。
  const db = getConversationsDb();
  return db ? conversationExistsInDb(db, conversationId) : false;
}

/** 队列快照变化 → 会话 SSE 重广播(前端队列面板即据此刷新)。低频事件,不走合帧热路径。 */
function broadcastQueueState(conversationId: string) {
  const conv = getConversation(conversationId);
  if (conv) broadcastConversation(conv);
}

/** 队首派发核心(前置:调用方已确认空闲且未暂停)。 */
function dispatchQueuedHead(conversationId: string) {
  const conversation = getConversation(conversationId);
  if (!conversation) return;
  const next = shiftNextQueued(conversationId);
  if (!next) return;
  // 把队首的用户消息本体落库进历史(与 send 入口同构;parts 入队时已做正则变换),再基于最新历史点火下一条。
  const userMessage = message("USER", next.parts.map((p) => ({ ...p })));
  const userNode = { id: id(), messages: [userMessage], selectIndex: 0 };
  conversation.messages.push(userNode);
  conversation.chatSuggestions = [];
  conversation.updateAt = Date.now();
  persistConversation(conversation);
  broadcastConversation(conversation);
  // 队列状态已变(少一条),面板立即刷新。
  broadcastQueueState(conversationId);
  // 语音模式回复通道:登记本条生成源自哪个排队项(经 message-queue 回调,仅 waitingReply 项生效)。
  notifyQueuedGenerationDispatched(conversationId, next);
  // 点火下一条。generateAnswer 入口自带「先中止旧流」不变式,但此处旧流已收尾(generating
  // 登记刚被 completeConversationGeneration 清除),它登记新 controller 并正常驱动。
  void generateAnswer(conversation);
}

/**
 * 消息发送队列派发(跨引擎统一):空闲 && 未暂停 && 队非空时,从队首取下一条待生成并点火。
 * 触发点:generateAnswer 收尾(经 stillMine 快照判「未被接管」后调用)+ queue/resume 端点(空闲时)。
 * 队列对引擎种类无感——它只调 generateAnswer,而那是聊天/pi 唯一注册生成的入口,新增引擎自动继承。
 */
export function dispatchMessageQueue(conversationId: string) {
  if (generating.has(conversationId)) return; // 占用中:不打断,等当前流收尾续跑。
  if (isQueuePaused(conversationId)) return;
  dispatchQueuedHead(conversationId);
}

/** 语音模式回复通道:登记「当前正在跑的排队生成」的源排队项 id。值仅存于内存,随收尾结算
 *  后删除;并发安全靠 generateAnswer 的「先 abort 再接管」不变式(同会话同一时刻只跑一条)。 */
const queuedGenerationSource = new Map<string, string>();
/** 已交付回复的排队项 id(防同消息被接管重跑时重复交付)。键同排队项生命周期,交付后即弃。 */
const deliveredQueuedGenerations = new Set<string>();
// 排队项被派发即登记来源。回复等待只在语音模式注册(waitingReply),键盘排队不触发回复通道。
setOnQueuedGenerationDispatched((conversationId, item) => {
  if (item.waitingReply) queuedGenerationSource.set(conversationId, item.id);
});

async function runPostGenerationTasks(conversationId: string, snapshot: Conversation, assistantMessageId: string) {
  const liveConversation = () => getConversation(conversationId);
  // 快速模型解析一次,两个后台任务共用。null = 没配(空/出厂哨兵/指向已删模型)→ 两者
  // 都静默跳过:标题退成首条消息文本,建议不生成,不弹任何失败提示,也不擅自拿主模型
  // 跑(建议回复每轮一次,用主模型不划算)。用户想要 AI 标题就去设置里配快速模型。
  const fastModelId = resolveFastModelId();
  if (shouldAutoGenerateTitle(snapshot) && fastModelId) {
    try {
      const title = await generateTitleForConversation(snapshot, fastModelId);
      const live = liveConversation();
      if (live && shouldAutoGenerateTitle(live)) {
        live.title = title;
        persistConversation(live);
        broadcastConversation(live);
      }
    } catch (titleError) {
      addLog({
        providerId: "",
        providerName: "RikkaHub PC",
        url: "conversation:title",
        ok: false,
        status: 0,
        kind: "aux:title",
        error: titleError instanceof Error ? titleError.message : String(titleError),
      });
      // info 级:标题只是便利功能,回退首条消息文本后用户无感损失。只进错误中心供排查,
      // 不弹全局 toast——后台任务的失败不该打断用户手上的事。
      reportError("provider", "info", "标题自动生成失败，已回退为首条消息文本", titleError, "title_generation_failed");
      // Title generation failed → fall back to first user message text (Android parity).
      const live = liveConversation();
      if (live && shouldAutoGenerateTitle(live)) {
        const firstText = textFromParts(live.messages[0]?.messages[0]?.parts ?? []).trim();
        const fallback = limitAuxiliaryText(firstText, TITLE_CHARACTER_LIMIT) || "New Conversation";
        live.title = fallback;
        persistConversation(live);
        broadcastConversation(live);
      }
    }
  } else if (shouldAutoGenerateTitle(snapshot)) {
    // 未配快速模型 → 不调任何模型,直接用首条用户消息文本命名(与 Android 同口径)。
    const live = liveConversation();
    if (live && shouldAutoGenerateTitle(live)) {
      const firstText = textFromParts(live.messages[0]?.messages[0]?.parts ?? []).trim();
      const fallback = limitAuxiliaryText(firstText, TITLE_CHARACTER_LIMIT) || "New Conversation";
      if (fallback !== live.title) {
        live.title = fallback;
        persistConversation(live);
        broadcastConversation(live);
      }
    }
  }

  if (!fastModelId) return;
  try {
    const suggestions = await generateSuggestionsForConversation(snapshot, fastModelId);
    const live = liveConversation();
    const lastNode = live?.messages[live.messages.length - 1];
    const lastMessage = lastNode?.messages[lastNode.selectIndex] ?? lastNode?.messages[0];
    if (live && lastMessage?.id === assistantMessageId && !generating.has(live.id)) {
      live.chatSuggestions = suggestions;
      live.updateAt = Date.now();
      persistConversation(live);
      broadcastConversation(live);
    }
  } catch (suggestionError) {
    // Suggestions are auxiliary;正文生成状态不应受影响。info 级同标题:少几个建议 chip
    // 不构成需要打扰用户的故障。
    reportError("provider", "info", "会话建议生成失败", suggestionError, "suggestion_generation_failed");
  }
}

/** pi 模型极限取值(P5 统计与压缩对齐):contextWindow 从 models.dev 查真实窗口
 *  (决定 pi 自动压缩阈值),maxTokens 走 requiredOutputCap —— 与聊天引擎 Claude 分支
 *  **同一个函数**,不是"同源口径"的口头约定。pi 的模型配置要求必须给出 maxTokens
 *  (它会恒发上限字段),所以这里同样属于"协议逼我给数"的场合。 */
function piModelLimitsFor(provider: Provider, model: Model, assistant: Assistant) {
  return {
    contextWindow: contextWindowFor(modelsDevCache, provider, model.modelId),
    maxTokens: requiredOutputCap(modelsDevCache, provider, model.modelId, assistant.maxTokens),
  };
}

/** P7:conversation.engineCompactions(DB 任意 JSON)→ 编码器契约。宽容校验:
 *  坏条目丢弃而不是整列作废(与列解析"损坏回 null"同哲学)。 */
function parseEngineCompactions(raw: JsonValue[] | null | undefined): EngineCompactionRecord[] {
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

/** P7:本轮压缩产物落 conversation.engineCompactions。cutMessageId 为 null(pi 自动压缩
 *  的切点可能落在本轮 prompt 之后,而本轮消息尚未入库)按"外收拢"落当前尾消息
 *  id——只多保不少保,下一轮编码器按"切点在场"自校验生效。 */
function applyCapturedEngineCompactions(conversation: Conversation, captured: CapturedEngineCompaction[]): void {
  if (!captured.length) return;
  const tail = selectedConversationMessages(conversation).at(-1);
  const records = parseEngineCompactions(conversation.engineCompactions);
  for (const item of captured) {
    const cutMessageId = item.cutMessageId ?? tail?.id;
    if (!cutMessageId) continue; // 无任何消息可挂靠(理论不可达):丢记录好过写错切点
    records.push({
      cutMessageId,
      summary: item.summary,
      tokensBefore: item.tokensBefore,
      createdAt: new Date().toISOString(),
    });
  }
  conversation.engineCompactions = records as unknown as JsonValue[];
  // 压缩发生点外显:分割线锚定"压缩时刻的最新消息"(自动/手动压缩同点生效)。
  markCompactionBoundary(conversation);
  markConversationRowDirty(conversation.id);
  scheduleThrottledConvFlush();
}

/** pi 引擎生成装配(P3 路由 + P4 资源统一 + P7 会话数据统一 + P8/P9 注入面统一)。
 *  T1 起收敛为 pi adapter 的 run 实现:输入是引擎无关 EngineRunContext + pi 专属
 *  piRuntime(由 adapter 在 matches() 判定后透传)。
 *  - prompt 输入取末 USER 节点选中消息(P4 附件面:文档/OCR 文本化与聊天引擎同母本,
 *    图片走 pi 原生 images 通道);prompt 文本经消息模板渲染(四件套之一);
 *  - 引擎上下文 = 编码器从富化后的选中路径历史(不含本轮 prompt 消息)确定性重建,
 *    压缩记录从 conversation.engineCompactions 进同一灌注——重新生成/编辑重发/分支切换
 *    天然生效(UI 选中路径就是引擎记忆,所见即所记);
 *  - 消息富化 = enrichMessages(四件套共享层):模板/时间提醒/lorebook+模式注入/
 *    窗口化(滞回截断 ∨ 压缩切点锚,P9)——聊天位注入/时间提醒随富化全序列(含
 *    合成行)灌进 pi 引擎,与聊天引擎逐字同生效;合成行由 syntheticIds 标出,编码器
 *    挡在切点映射/退化诊断外;系统位注入经 appendSystemPrompt 进 pi 系统面;
 *  - 工具面 = 七个工作区工具 + 通用工具/MCP 桥(P4),审批全部内化在工具 execute;
 *  - 资源面 = createPiSessionResources(技能白名单/AGENTS.md 边界过滤/人设+记忆冻结
 *    appendSystemPrompt/受控 settings)。 */
async function runPiWorkspaceGeneration(
  ctx: EngineRunContext & { piRuntime: WorkspaceRuntime | null },
  sink: GenerationEventSink,
  signal?: AbortSignal,
): Promise<string> {
  const { conversation, assistantNode } = ctx;
  const runtime = ctx.piRuntime;
  if (!runtime) {
    // 路由不变式:resolveEngine 选中 pi 时 matches() 已确认工作区可用。此处为防御兜底
    // (adapter WeakMap 透传被回收的极端情况)——不可达于正常路径,报错好过静默走错引擎。
    throw new Error("pi 引擎被选中但工作区运行时不可用(路由判定与执行不一致)。");
  }
  const deps = { assistant: ctx.assistant, providerItem: ctx.provider, selectedModel: ctx.model };
  const lastUserNode = [...conversation.messages]
    .reverse()
    .find((node) => (node.messages[node.selectIndex] ?? node.messages[0])?.role === "USER");
  const promptMessage = lastUserNode ? (lastUserNode.messages[lastUserNode.selectIndex] ?? lastUserNode.messages[0]) : null;
  // prompt 文本先经消息模板渲染(与历史消息同一富化口径),再走附件文本化。
  const template = deps.assistant.messageTemplate?.trim() || "{{ message }}";
  const templatedPromptParts = promptMessage
    ? applyTemplateToMessage(promptMessage, template, "user", deps.assistant, deps.selectedModel)
    : [];
  const promptInput = promptMessage
    ? piPromptInputFromParts(templatedPromptParts, deps.selectedModel)
    : { text: "", images: [] };
  if (!promptInput.text && !promptInput.images.length) {
    // 无文本且无图片输入直接走失败分支给出人话。
    throw new Error("工作区会话缺少可发送的用户消息内容,无法驱动工作区引擎。");
  }

  // 四件套富化(P9 灌注统一):历史消息(不含本轮 prompt)经共享层裁决;压缩切点
  // (effectiveEngineCompaction 单源判定)作为富化窗口锚——注入行/提醒恒在窗口内、恒在
  // 切点之后:既进模型视野,又永不落进被摘要吸收的旧历史。富化全序列(含合成行)
  // 进引擎,每轮从 DB 原文重新裁决,DB 零沉淀。
  const historySource = selectedConversationMessages(conversation).filter((msg) => msg.id !== promptMessage?.id);
  const compactionRecords = parseEngineCompactions(conversation.engineCompactions);
  const cut = effectiveEngineCompaction(compactionRecords, historySource, deps.selectedModel);
  const enriched = enrichMessages(historySource, {
    conversation,
    assistant: deps.assistant,
    model: deps.selectedModel,
    windowStartMessageId: cut?.cutMessageId,
  });

  // 系统位注入(before/after_system_prompt)经 appendSystemPrompt 进 pi 系统面——
  // 与人设/记忆/搜索指引同一插槽,位置在 pi Guidelines 之后、project_context 之前。
  const systemInjection = [enriched.systemInjectionBefore, enriched.systemInjectionAfter].filter(Boolean).join("\n");
  const resources = await createPiSessionResources({
    conversation,
    assistant: deps.assistant,
    model: deps.selectedModel,
    cwd: runtime.cwd,
    root: runtime.root,
    extraAppendSystemPrompt: systemInjection ? [systemInjection] : undefined,
  });

  const result = await runPiGeneration({
    provider: deps.providerItem,
    model: deps.selectedModel,
    modelLimits: piModelLimitsFor(deps.providerItem, deps.selectedModel, deps.assistant),
    // 思考强度与聊天引擎同源(助手设置);pi 档位翻译见 model-bridge piThinkingLevelFor。
    reasoningLevel: deps.assistant.reasoningLevel,
    conversationId: conversation.id,
    cwd: runtime.cwd,
    history: enriched.messages,
    syntheticIds: enriched.syntheticIds,
    compactions: compactionRecords,
    promptText: promptInput.text,
    images: promptInput.images,
    resources,
    tools: [
      ...createPiWorkspaceTools({ conversation, assistant: deps.assistant, sink }),
      ...createPiGeneralTools({ conversation, assistant: deps.assistant, sink, messageNodeId: assistantNode.id, model: deps.selectedModel }),
    ],
    sink,
    signal,
  });
  applyCapturedEngineCompactions(conversation, result.capturedCompactions);
  return result.text;
}

/** 引擎注册表(T1):编排器把各引擎的生成/压缩实现注入 adapter 工厂。pi 在前(工作区
 *  可用即接管),chat 兜底。新增引擎在此注册一行,runGeneration/续跑语义/压缩路由/
 *  审批旁路判定无需再改。 */
const ENGINE_REGISTRY = createEngineRegistry({
  chatRun: (ctx, sink, signal) =>
    callProviderStreaming(ctx.conversation, ctx.assistantMessage, ctx.assistantNode, {
      signal,
      sink,
      executeTool: ctx.executeTool,
      // P1-4:generateAnswer 入口解析的 assistant/provider/model 贯穿本次生成,
      // callProviderStreaming 不再从可能已被替换的 state.settings 重新解析。
      snapshot: { assistant: ctx.assistant, provider: ctx.provider, model: ctx.model },
    }),
  piRun: (ctx, sink, signal) => runPiWorkspaceGeneration(ctx, sink, signal),
  piCompact: (ctx, sink, signal) => runPiWorkspaceCompaction(ctx, sink, signal),
});

/** 纯生成逻辑：经引擎注册表分发到命中 adapter,由 sink 发出生成事件。
 *  本函数不直接写 state.json、不直接广播 SSE、不直接落盘 SQLite——这些副作用由
 *  协调器 generateAnswer 统一处理。 */
async function runGeneration(
  deps: EngineRunContext & { adapter: EngineAdapter },
  sink: GenerationEventSink,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
  // T1:布尔路由退役——引擎选择已收敛为 resolveEngine 选出的 adapter.run。pi 专属
  // 决策(piRuntime)由 pi adapter 在 matches()/run() 内部携带,不再污染本层。
  return deps.adapter.run(deps, sink, signal);
}

/** pi 引擎压缩装配(P5 原生 compaction + P7 产物落 engineCompactions)。压缩路由收编:
 *  收敛为 pi adapter 的 compact 实现——路由判定(工作区可用)已由 matches() 承担,
 *  本函数只管驱动;engine_status 经调用方注入的 sink 直通,广播与终局清条不在此层。
 *  压缩的对象是"模型实际看到的消息":与生成路径同一富化裁决(模板/提醒/注入),
 *  但合成消息经 encodableMessages 剥回纯真实行(P9)——手动压缩是用户策展行为,
 *  摘要只覆盖真实对话;注入是配置不是对话,时间提醒只描述节奏,均不进摘要。
 *  窗口锚照常生效:切点前的历史已被上一轮摘要吸收,压缩对象从切点起即可。 */
async function runPiWorkspaceCompaction(
  ctx: EngineCompactContext & { piRuntime: WorkspaceRuntime | null },
  sink: GenerationEventSink,
  signal?: AbortSignal,
): Promise<EngineCompactionResult> {
  const { conversation, assistant } = ctx;
  const runtime = ctx.piRuntime;
  if (!runtime) {
    // 路由不变式:resolveEngine 选中 pi 时 matches() 已确认工作区可用。此处为防御兜底
    // (与 runPiWorkspaceGeneration 同一防御)——不可达于正常路径,报错好过静默走错引擎。
    throw new Error("pi 引擎被选中但工作区运行时不可用(路由判定与执行不一致)。");
  }
  const compactionRecords = parseEngineCompactions(conversation.engineCompactions);
  const cut = effectiveEngineCompaction(compactionRecords, selectedConversationMessages(conversation), ctx.model);
  const enriched = enrichMessages(selectedConversationMessages(conversation), {
    conversation,
    assistant,
    model: ctx.model,
    windowStartMessageId: cut?.cutMessageId,
  });
  const history = encodableMessages(enriched.messages, enriched.syntheticIds);
  const systemInjection = [enriched.systemInjectionBefore, enriched.systemInjectionAfter].filter(Boolean).join("\n");
  const resources = await createPiSessionResources({
    conversation,
    assistant,
    model: ctx.model,
    cwd: runtime.cwd,
    root: runtime.root,
    extraAppendSystemPrompt: systemInjection ? [systemInjection] : undefined,
    // 手动压缩门槛/保留窗口调低(中文 chars/4 低估问题,rationale 见 runner.ts 常量)。
    compactionKeepRecentTokens: MANUAL_COMPACT_KEEP_RECENT_TOKENS,
  });
  // 摘要模型:公共压缩模型优先(ctx.summarizer,装配点已决策),pi 映射不进(自定义
  // 补全路径的 openai 型服务商等)则回退会话模型——公共设置是偏好不是硬约束,
  // 压缩必须总能进行,回退留 warn 让用户知情。注意窗口锚定/富化裁决(上方 cut/
  // enriched)仍按 ctx.model:压缩对象是"会话模型实际看到的消息",与生成路径同一
  // 视角,勿随摘要模型漂移。
  let summarizer = ctx.summarizer;
  if (summarizer.model.id !== ctx.model.id && !mapProviderModelToPi(summarizer.provider, summarizer.model).ok) {
    reportError(
      "provider",
      "warn",
      `压缩模型 ${summarizer.model.displayName || summarizer.model.modelId} 无法在工作区引擎使用,本次压缩改用会话模型`,
      undefined,
      "compact_summarizer_fallback",
    );
    summarizer = { provider: ctx.provider, model: ctx.model };
  }
  const result = await runPiCompaction({
    provider: summarizer.provider,
    model: summarizer.model,
    modelLimits: piModelLimitsFor(summarizer.provider, summarizer.model, assistant),
    reasoningLevel: assistant.reasoningLevel,
    conversationId: conversation.id,
    cwd: runtime.cwd,
    history,
    compactions: compactionRecords,
    resources,
    customInstructions: ctx.customInstructions,
    signal,
    sink,
  });
  // 产物落库是引擎注入实现的义务——与生成路径的压缩捕获同一落点、同一 helper。
  applyCapturedEngineCompactions(conversation, [result.compaction]);
  return result;
}

/** 引擎原生压缩入口(压缩路由收编:经注册表分发,与生成路由同源)。返回 null =
 *  命中引擎未声明 compact 能力(chat 无引擎记忆)——调用方回落 UI 历史压缩(聊天
 *  引擎从 UI 历史构建请求,压 UI 历史即压上下文)。工作区不可用(缺根/未信任)时
 *  pi 的 matches() 不命中、落到 chat 兜底,同样回落——与生成路由的降级天然一致。
 *  压缩期间 engine_status 直通状态条,finally 兜底清除(取消/失败不挂"压缩中");
 *  瞬态状态的「怎么发」是引擎的事(经 sink),「怎么播/怎么兜底清」是本层的事,
 *  与 generateAnswer 的 sink 职责划分一致。 */
export async function compactEngineConversation(
  conversation: Conversation,
  customInstructions: string,
  signal?: AbortSignal,
): Promise<{ engine: EngineKind; summary: string; tokensBefore: number; estimatedTokensAfter: number | null } | null> {
  const assistant = findAssistant(conversation.assistantId);
  const adapter = resolveEngine(ENGINE_REGISTRY, conversation, assistant);
  if (!adapter.compact) return null;
  const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
  // 压缩模型公共化(「设置-默认模型与提示词」是公共基础设施):配置了压缩模型则
  // 所有引擎的摘要生成都用它,未配置回退会话模型。modelExists 先行:压缩模型被
  // 删除后设置残留 id 不该改变语义(findModel 对不存在 id 会兜底 chatModelId,
  // 那是"默认聊天模型"不是"用户指定的压缩模型",宁可回退会话模型)。
  const summarizerPicked = modelExists(state.settings.compressModelId)
    ? findModel(state.settings.compressModelId)
    : picked;
  try {
    const result = await adapter.compact(
      {
        conversation,
        assistant,
        provider: picked.provider,
        model: picked.model,
        summarizer: { provider: summarizerPicked.provider, model: summarizerPicked.model },
        customInstructions,
      },
      (event) => {
        if (event.kind === "engine_status") broadcastEngineStatus(conversation.id, event.status);
      },
      signal,
    );
    return {
      engine: adapter.kind,
      summary: result.summary,
      tokensBefore: result.tokensBefore,
      estimatedTokensAfter: result.estimatedTokensAfter,
    };
  } finally {
    broadcastEngineStatus(conversation.id, { busy: false });
  }
}

/** 会话的引擎判定(注册表路由的只读查询)。编排器外的消费点(审批端点等)用它替代
 *  自行判定(如以"工作区可用"旁路推断引擎),保证与生成/压缩路由永远同源——
 *  第三引擎接入时这些消费点自动跟随注册表,无需再改。 */
export function resolveEngineForConversation(conversation: Conversation): EngineAdapter {
  return resolveEngine(ENGINE_REGISTRY, conversation, findAssistant(conversation.assistantId));
}

export async function generateAnswer(conversation: Conversation, regenerateAtNodeId?: string) {
  // R2-3:入口自带"先中止旧流"不变式。端点级守卫(send/edit/regenerate 的先 abort)挡不住
  // OCR 续体窗口:两条消息的续体先后异步触发本函数时,后者若直接 generating.set 会顶掉
  // 前者的 controller——前者成无主流,两路流式交错写同一节点(parts 交叉污染)、且无人能停。
  // 把端点级纪律下沉为编排器不变式:同会话已有登记流,先 abort 再接管(后到者胜,与端点
  // 语义一致)。completeConversationGeneration 按 controller 身份幂等,旧流收尾不会误删新登记。
  generating.get(conversation.id)?.abort();
  const controller = new AbortController();
  generating.set(conversation.id, controller);
  // DB-first:整个生成期持有引用(与 finally 的 release 恰好配对一次;
  // completeConversationGeneration 有多处幂等调用,release 不能放那里)。
  // generating 条件本身也挡 sweep,refs 是纵深防御(abort 后 generating 先被清的窗口)。
  checkoutConversation(conversation.id);
  const assistant = findAssistant(conversation.assistantId);
  const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
  // T1:路由在入口一次判定并贯穿本次生成(与 P1-4 配置快照同理)——引擎选择收敛为
  // 注册表 resolveEngine(pi 命中工作区三道闸即接管,否则 chat 兜底)。续跑/暂停语义
  // 不再写死 "!piRuntime",改读 adapter.resumeSemantics。
  const adapter = resolveEngine(ENGINE_REGISTRY, conversation, assistant);
  const isRunAndSuspend = adapter.resumeSemantics === "run-and-suspend";
  // 重新生成 ASSISTANT:调用方已在该 node 追加空占位 message 并把 selectIndex 指向它,
  // 直接复用,绕开 ensureAssistantGenerationNode(它会复用末尾 assistant 或新建 node,
  // 都不是"在指定 node 上新增分支")。find 不到时安全回退到默认逻辑。
  let assistantNode: MessageNode;
  if (regenerateAtNodeId) {
    const found = conversation.messages.find((n) => n.id === regenerateAtNodeId);
    assistantNode = found ?? ensureAssistantGenerationNode(conversation, picked.model.id);
  } else {
    assistantNode = ensureAssistantGenerationNode(conversation, picked.model.id);
  }
  const currentMessage = assistantNode.messages[assistantNode.selectIndex];
  activeGenerationMessages.set(conversation.id, currentMessage);
  // P1-3:四条出口路径(pending/done/aborted/failed)的共同收尾序列。差异只在 parts 与
  // finishedAt 处理,由 applyParts 注入。completeConversationGeneration 幂等,finally 兜底。
  const finalizeOutcome = (applyParts: () => void) => {
    // 批6复审 G2:接管守卫——被新流接管且新流复用同一消息对象时,旧流的收尾若继续执行,
    // 会对新流正在写的回答做 transforms/盖 finishedAt/写估算 usage,失败分支甚至把
    // "请求失败"文本和 model_call_error 注解追加进去。此时静默退出(消息已易主,由新流
    // 负责收尾);新流用的是新消息对象时,旧流仍照常收尾自己的消息,行为不变。
    const owner = generating.get(conversation.id);
    if (owner && owner !== controller && activeGenerationMessages.get(conversation.id) === currentMessage) return;
    applyOutputTransforms(currentMessage, assistant);
    finishReasoningParts(currentMessage);
    applyParts();
    ensureUsage(currentMessage, conversation);
    conversation.updateAt = Date.now();
    completeConversationGeneration(conversation.id, controller);
    broadcastNodeUpdate(conversation, assistantNode);
    broadcastConversation(conversation);
  };
  // T1:续跑语义读 adapter 声明——仅 pause-resume 引擎(聊天)有"整批暂停→逐卡批准→
  // 重触发续跑";run-and-suspend 引擎(pi)的工具审批由 approval-gate 挂起汇合,不重触发。
  const resumingApprovedTools = adapter.resumeSemantics === "pause-resume" && hasResumableToolParts(currentMessage);
  currentMessage.finishedAt = null;
  // R7-2:重入生成(续写/重试复用同一消息对象)时清掉上一轮的失败标记,
  // 本轮成功后前端错误横幅不再残留;本轮再失败会在 catch 里重新落标记。
  // 异常数据容忍:annotations 缺失(手改/极老数据)不能让生成入口崩死整个会话——
  // 这里顺手自愈为数组,后续 push 同样安全(用户数据安全优先)。
  currentMessage.annotations = (currentMessage.annotations ?? []).filter(
    (item) => !(typeof item === "object" && item !== null && (item as { type?: unknown }).type === "model_call_error"),
  );
  // Allow createdAt to be re-stamped on the first content chunk of this generation pass —
  // supports regenerate, which reuses the same message object.
  streamStartedMessages.delete(currentMessage);
  if (!resumingApprovedTools) {
    // 专题11复审:非续跑的重入生成(重试等复用同一消息对象)清掉上一代 usage——
    // mergeTokenUsage 的“新值>0 才覆盖”会把上一代的 cachedTokens/completionTokens
    // 带进本轮统计。续跑(工具审批恢复)是同一请求的延续,保留。
    currentMessage.usage = null;
    // Show a loading placeholder immediately so the UI has visual feedback during the
    // upstream first-token wait. addStreamText / replaceLoadingReasoningWithTool will
    // strip this placeholder as soon as the first real delta arrives.
    setMessageLoading(currentMessage);
  }
  conversation.updateAt = Date.now();
  broadcastNodeUpdate(conversation, assistantNode);
  try {
    if (resumingApprovedTools) {
      await resumeApprovedToolParts(conversation, assistant, currentMessage, assistantNode, false, controller.signal);
    }
    // 工具执行闭包：把 server.ts 里的 executeToolCall 包装成 ToolExecutor 接口。
    // 这里保留对全局 state 的读写（如 saveToolBinaryContent），因为协调器仍然是唯一拥有
    // state 写权限的层；后续 Phase 会再把文件落盘拆到 files/ 模块。
    const executeTool: ToolExecutor = async (toolCall, context) => {
      // 注入生成级 signal（工作区工具据此取消，bash 连杀进程树）与部分输出回写
      // （bash 执行中把尾部输出写进 tool part，走现有 touchStream 合帧管线）。
      const raw = await executeToolCall(toolCall, assistant, {
        ...context,
        signal: controller.signal,
        onToolPartialOutput: (output) => applyEvent({ kind: "tool_result", toolCallId: toolCall.id, output, final: false }),
      });
      // ask_user / MCP 审批等 pending 状态直接作为单 output 载荷返回，让协调器走暂停路径。
      if (isRecord(raw) && "pending" in raw) {
        return { output: [raw as unknown as ToolPendingOutput] };
      }
      const normalized = await toolResultToParts(raw);
      const output = await realizeToolResult(normalized);
      return { output };
    };
    // P2(pi 引擎):内联 applyEvent 抽取为共享应用器(conversations/generation-apply.ts,
    // 逐字搬迁行为零变)——聊天引擎与 pi 事件桥共用同一份"事件→parts"写入字典。
    const applyEvent = createGenerationEventApplier({ conversation, node: assistantNode, message: currentMessage });
    const sink: GenerationEventSink = (event) => {
      // P5:引擎瞬态状态(压缩中/自动重试)不落库不产 part,直通会话 SSE 状态条;
      // 其余事件照走应用器。generateAnswer finally 兜底 busy:false,中途 abort 不挂条。
      if (event.kind === "engine_status") {
        broadcastEngineStatus(conversation.id, event.status);
        return;
      }
      applyEvent(event);
    };
    const content = await runGeneration(
      {
        conversation,
        assistantMessage: currentMessage,
        assistantNode,
        assistant,
        provider: picked.provider,
        model: picked.model,
        executeTool,
        adapter,
      },
      sink,
      controller.signal,
    );
    if (controller.signal.aborted) throw new DOMException("Generation stopped", "AbortError");
    if (adapter.resumeSemantics === "pause-resume" && hasPendingToolApproval(currentMessage)) {
      // 注:hasPendingToolApproval 判定在 applyOutputTransforms 之前与旧实现一致——
      // 旧实现先 transform 再判定,但 transform 只改 text/reasoning parts,不触碰 tool
      // parts 的 approvalState,判定结果不受影响;两分支的 transform 都由 finalize 统一做。
      finalizeOutcome(() => {
        currentMessage.finishedAt = null;
      });
      return;
    }
    finalizeOutcome(() => {
      if (currentMessage.parts.length === 0) {
        finishMessage(currentMessage, [{ type: "text", text: content }]);
      } else {
        const hasText = textFromParts(currentMessage.parts).trim().length > 0;
        if (!hasText && content && content !== "(empty response)") {
          appendTextPart(currentMessage, content);
        }
        currentMessage.finishedAt = new Date().toISOString();
      }
    });
    const snapshot = cloneConversation(conversation);
    void runPostGenerationTasks(conversation.id, snapshot, currentMessage.id);
    // 语音模式回复通道:本条若源自「等回复的排队生成」,把该轮 assistant 文本交付等待方。
    // 空正文交付 null(语音模式据此跳过播报)。已交付集合防「同消息被接管重跑」重复交付。
    const replySourceId = queuedGenerationSource.get(conversation.id);
    if (replySourceId && !deliveredQueuedGenerations.has(replySourceId)) {
      deliveredQueuedGenerations.add(replySourceId);
      deliverQueuedReply(conversation.id, replySourceId, textFromParts(currentMessage.parts));
    }
  } catch (err) {
    if (!conversationStillExists(conversation.id)) {
      completeConversationGeneration(conversation.id, controller);
      return;
    }
    // 批6复审 G3:abort 意图支配错误分类——部分 fetch 实现/上游在 abort 时抛的是普通
    // 网络错误而非 AbortError,若走失败分支会给用户主动停止的回答追加"请求失败"+错误
    // 注解并弹全局错误。只要本流已被要求中止,一律按中止收尾。
    if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
      finalizeOutcome(() => {
        // 批6复审 G4:中止若发生在首个 delta 之前,loading 占位没人摘(正常路径由首个
        // delta 摘,stop 端点手工摘,但删会话/接管等 abort 路径不经过 stop 端点),
        // 前端"打字点"会永久残留在已完结消息上。与 stop 端点的手工摘除对齐。
        currentMessage.parts = currentMessage.parts.filter((part) => !(isRecord(part) && part.type === "loading"));
        currentMessage.finishedAt = new Date().toISOString();
      });
      return;
    }
    // 匿名遥测:只记"发生了一次 provider 失败",不采集错误内容/模型/服务商。
    bumpAnalyticsErrCount();
    const rawContent = err instanceof Error ? err.message : String(err);
    const proxyHint = classifyProxyError(err, state.settings.proxyConfig);
    const failureText =
      proxyHint
      ?? classifyContextOverflowError(err)
      ?? classifyOutputCapError(err)
      ?? classifyRateLimitError(err)
      ?? `请求失败：${rawContent}`;
    // P2-1(N-7 归宿):失败文本除了落在消息注解上(仅会话内可见),还上报全局通道——
    // 用户不在该会话页时也能收到通知(批2 接前端 toast)。
    reportError("provider", "error", failureText, err);
    // 消息发送队列:失败自动暂停(保留全部排队项,待用户手动 resume 续跑)。对齐 APP
    // onGenerationFinished(cause != null) → pause。仅真失败暂停——用户主动 stop/中止在上面
    // 已 return,不会到这;故 stop 不会暂停队列,只停在「无下一条自动点火」。
    pauseMessageQueue(conversation.id);
    broadcastQueueState(conversation.id);
    finalizeOutcome(() => {
      // 错误零污染正文(对齐 Android addError):失败详情只活在 model_call_error 注解的
      // message 字段,由前端错误卡呈现;正文保留半截真实产出。既无正文也无错误的流
      // (中止/纯失败)不会走到这里——中止分支已先行返回。
      currentMessage.finishedAt = new Date().toISOString();
      // R7-2:结构化错误标记——前端错误卡由它驱动,详情取注解的 message 字段,
      // 不再对正文做关键词正则(讨论 HTTP 状态码/超时的正常回答不误报)。
      currentMessage.annotations.push({ type: "model_call_error", message: failureText });
    });
  } finally {
    // 语音模式回复通道兜底:成功路径已交付;走到 finally 仍未交付 = 本条排队生成以
    // abort/失败/被接管收尾(均无可播报回复),交付 null 让语音模式跳过播报、直接重开麦。
    const replySourceId = queuedGenerationSource.get(conversation.id);
    if (replySourceId && !deliveredQueuedGenerations.has(replySourceId)) {
      deliveredQueuedGenerations.add(replySourceId);
      deliverQueuedReply(conversation.id, replySourceId, null);
    }
    // 消息发送队列:本条流彻底收尾后派发下一条。接管判据——generateAnswer 入口/set()前的
    // 中止、stop 端点、删会话都先把 generating delete 成空,故「登记为空」语义含糊(既可能是
    // 本流刚收尾,也可能是被 stop/删后本流仍在跑 finally)。真正的接管信号是「登记在册的是
    // 另一个 controller」;仅此时不派发(由接管方收尾续跑),其余(本流正常/中止/失败收尾)都续跑。
    const takenOver = generating.has(conversation.id) && generating.get(conversation.id) !== controller;
    // P5:生成终局兜底清引擎状态条——压缩/重试进行中 abort/失败时,end 事件可能永远
    // 不来,不清会挂死"压缩中"。幂等,聊天引擎路径广播空集合无副作用。T1:判定改读
    // resumeSemantics——只有 run-and-suspend 引擎(pi)会发瞬态状态条,聊天引擎不发。
    if (isRunAndSuspend) broadcastEngineStatus(conversation.id, { busy: false });
    // 域4-1:审批等待注册表兜底清除——gateToolApproval 的正常路径(决定/中止)已注销,
    // 这里是"生成终局但审批仍挂着"的防御(引擎 run 因故结束而 execute 未走到注销)。
    // 幂等(delete 不存在键无副作用),与 busy:false 同点收口。
    awaitingApproval.delete(conversation.id);
    if (conversationStillExists(conversation.id)) {
      broadcastNodeUpdate(conversation, assistantNode);
      broadcastConversation(conversation);
    }
    completeConversationGeneration(conversation.id, controller);
    releaseConversation(conversation.id);
    // 生成真正结束(登记已清)→ 派发队列下一条。失败已在 catch 里 pause,dispatchMessageQueue
    // 的 paused 门控让它自动停稳;abort/正常收尾则接续点火。被接管时跳过(接管方自会续跑)。
    if (!takenOver) dispatchMessageQueue(conversation.id);
  }
}

export function ensureAssistantGenerationNode(conversation: Conversation, modelId: string): MessageNode {
  const last = conversation.messages[conversation.messages.length - 1];
  if (last?.messages[last.selectIndex]?.role === "ASSISTANT") {
    const msg = last.messages[last.selectIndex];
    msg.modelId = modelId;
    return last;
  }
  const assistantNode: MessageNode = {
    id: id(),
    messages: [message("ASSISTANT", [], modelId)],
    selectIndex: 0,
  };
  conversation.messages.push(assistantNode);
  // 新节点立即标脏:节点创建到第一个 chunk 之间存在窗口,若此窗口内导出/统计(DB-first
  // 读活库)或进程崩溃,未标脏的节点不在任何落库计划里。标脏后 flushConvDirtyNow 可见,
  // 与旧"读内存必含该节点"行为对齐。
  markMessageNodeDirty(conversation.id, assistantNode.id);
  scheduleThrottledConvFlush();
  return assistantNode;
}
