// inference-engine/chat-generation.ts — 聊天引擎一轮生成:按供应商类型分发到各家客户端与流式工具循环
//
// 从 conversations/orchestrator.ts 原样搬出(P2.4):聊天驱动(engines/chat-driver)直接调用它,
// 注册表不再需要编排器注入生成函数。新增供应商类型时改这里的两个分发函数。

import type { Assistant, Conversation, Model, Provider } from "../foundation/types";
import type { GenerationEventSink, GenerationTarget, StreamHooksWithSink, ToolExecutor } from "./events";
import { state } from "../persistence/json-store";
import { applyCustomBody, applyRequestHeaders, findModel } from "../model-providers";
import { resolveProviderAuthForProvider, applyShaping } from "../model-providers/auth";
import { endpointFor } from "../model-providers/checks";
import { openAiMaxTokensField, reasoningLevelNormalized } from "../model-providers/request-dialect";
import { requiredOutputCap } from "../model-providers/model-limits";
import {
  claudeCacheControlEphemeral,
  claudeMessagesFromApiMessages,
  claudeSystemContent,
  claudeThinkingPayload,
  claudeToolsFromOpenAiTools,
  chatCompletionsWireMessages,
  hostOfProvider,
  isModelAllowTemperature,
  openAiChatCompletionsModalities,
  reasoningPayloadForProvider,
  responseApiBuiltInTools,
  responseApiFunctionTool,
  responseApiIncludeForProvider,
  responseApiReasoningForProvider,
  supportsAbility,
} from "./message-builder";
import {
  buildGoogleRequestBody,
  conversationAssistantHistoryParts,
  conversationMessagesForApi,
  conversationResponseApiInput,
  conversationResponseApiInstructions,
} from "./conversation-encoding";
import {
  fetchClaudeTextWithTools,
  fetchOpenAiText,
  fetchOpenAiTextStreaming,
  fetchText,
  modelsDevCache,
  streamClaudeChatWithTools,
  streamGoogleChatWithTools,
} from "./providers";
import { buildInteractionsRequestBody, streamInteractionsChatWithTools } from "./interactions";
import { conversationFunctionTools } from "../tools/bound";
import { findAssistant } from "../conversations/helpers";

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
  // 订阅供应商:凭据在服务端 oauth 里,apiKey 恒空——先经 resolveProviderAuthForProvider
  // 解析(可能触发锁内刷新),后续注入点统一用 resolvedCredentialHeaders 而非裸 apiKey。
  const resolvedAuth = await resolveProviderAuthForProvider(providerItem, { signal });
  const credentialHeaders = resolvedAuth.headers;
  // 消息端点在凭据解析后拼:订阅供应商的 baseUrl 可能由凭证派生(Copilot 的 proxy-ep)。
  const url = endpointFor(providerItem, resolvedAuth.baseUrl);
  const headers = applyRequestHeaders({ "Content-Type": "application/json", ...credentialHeaders }, assistant, providerItem, picked.model, conversation.id);
  // 对齐 e63d017：OpenAI 路径才让 includeHistoryReasoning 生效；
  // claude/google 不走 OpenAI assistant 序列化，一律保持 true。
  const includeHistoryReasoning =
    providerItem.type === "openai" ? providerItem.includeHistoryReasoning !== false : true;
  const messagesForApi = conversationMessagesForApi(conversation, assistant, includeHistoryReasoning);
  // 动态头取值依据(仅 Copilot 的 X-Initiator/Copilot-Vision-Request 消费)。
  const shapingContext = {
    lastMessageRole: messagesForApi[messagesForApi.length - 1]?.role,
    hasImages: messagesForApi.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p?.type === "image_url" || p?.type === "input_image"),
    ),
  };
  let body: Record<string, any>;
  // 订阅供应商整形(§13.3 全路径覆盖,与辅助调用同一时机):body 定稿后、applyCustomBody 前。
  const shaped = (draft: Record<string, any>) => {
    if (providerItem.authMode === "oauth" && providerItem.oauth) {
      applyShaping(providerItem.oauth.flow, headers, draft, providerItem.oauth.credential, shapingContext);
    }
    return draft;
  };

  if (providerItem.type === "google") {
    // issue10：Gemini 鉴权走 x-goog-api-key 头（与安卓非 Vertex 路径、Cherry Studio 一致）。
    // 此前用 ?key= query，官方两者都收，但主流中转网关只解析 header，query 会被判 invalid key。
    // 订阅供应商:google 暂无 oauth 形态,apiKey 恒空时 credentialHeaders 已含解析头。
    if (providerItem.authMode !== "oauth") headers["x-goog-api-key"] = providerItem.apiKey;
    const baseUrl = providerItem.baseUrl;
    // Interactions API 开关(APP 2.5.6 2cd62ad2,GA 2026-06):google 型供应商级开关,
    // 默认关走 generateContent。历史 assistant 轮签名保真需要落库 parts(messagesForApi
    // 的 chat-completions 形态不带签名),经 conversationAssistantHistoryParts 取。
    if (providerItem.useInteractionsApi === true && hooks?.message != null) {
      const functionTools = supportsAbility(picked.model, "TOOL")
        ? conversationFunctionTools(assistant, picked.model)
        : [];
      body = buildInteractionsRequestBody(
        messagesForApi,
        conversationAssistantHistoryParts(conversation, assistant, messagesForApi),
        picked.model,
        assistant,
        functionTools,
      );
      return streamInteractionsChatWithTools(baseUrl, headers, selectedModel, applyCustomBody(shaped(body), assistant, picked.model), providerItem, assistant, signal, hooks);
    }
    body = buildGoogleRequestBody(messagesForApi, picked.model, assistant);
    const finalBody = applyCustomBody(shaped(body), assistant, picked.model);
    // 有 hooks（来自会话）时走 SSE 流式 + 工具循环；辅助调用无 hooks 时退回非流式。
    if (hooks?.message != null) {
      return streamGoogleChatWithTools(baseUrl, headers, selectedModel, finalBody, providerItem, assistant, signal, hooks);
    }
    const googleUrl = `${baseUrl.replace(/\/+$/, "")}/models/${selectedModel}:generateContent`;
    return fetchText(googleUrl, headers, finalBody, providerItem, (raw) => raw.candidates?.[0]?.content?.parts?.map((part: any) => part?.text ?? "").join("") ?? "", signal);
  }

  if (providerItem.type === "claude") {
    // 订阅供应商(Kimi/Claude):oauth 轨已在 credentialHeaders 注入 Authorization: Bearer;
    // apiKey 轨保持 x-api-key。互斥,不双发。
    if (providerItem.authMode !== "oauth") headers["x-api-key"] = providerItem.apiKey;
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
      return streamClaudeChatWithTools(url, headers, applyCustomBody(shaped(body), assistant, picked.model), providerItem, assistant, signal, hooks!);
    }
    return fetchClaudeTextWithTools(url, headers, applyCustomBody(shaped(body), assistant, picked.model), providerItem, assistant, signal, hooks);
  }

  if (providerItem.authMode !== "oauth") headers.Authorization = `Bearer ${providerItem.apiKey}`;
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
        ...functionTools.map(responseApiFunctionTool),
        ...builtInTools,
      ].filter(Boolean),
    };
    if (!body.tools.length) delete body.tools;
    // 订阅供应商整形:Codex 需 include reasoning.encrypted_content、不识别 max_output_tokens。
    return fetchText(url, headers, applyCustomBody(shaped(body), assistant, picked.model), providerItem, (raw) => raw.output_text ?? raw.output?.flatMap((item: any) => item.content ?? []).map((item: any) => item.text ?? "").join("\n"), signal);
  }
  const tools = supportsAbility(picked.model, "TOOL") ? conversationFunctionTools(assistant, picked.model) : [];
  body = {
    model: selectedModel,
    // chat-completions 出线前剥 tool 消息的内部字段（name/_rikkahub_tool_output_parts）。
    messages: chatCompletionsWireMessages(messagesForApi),
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
  return fetchOpenAiText(url, headers, applyCustomBody(shaped(body), assistant, picked.model), providerItem, assistant, signal, hooks);
}

export async function callProviderStreaming(
  conversation: Conversation,
  target: GenerationTarget,
  ctx: { signal?: AbortSignal; sink: GenerationEventSink; executeTool: ToolExecutor; snapshot?: GenerationSnapshot; onSteerBoundary?: () => string[] },
): Promise<string> {
  const assistant = ctx.snapshot?.assistant ?? findAssistant(conversation.assistantId);
  const picked = ctx.snapshot
    ? { provider: ctx.snapshot.provider, model: ctx.snapshot.model }
    : findModel(assistant.chatModelId ?? state.settings.chatModelId);
  const providerItem = picked.provider;
  const selectedModel = picked.model.modelId === "auto" ? "gpt-4o-mini" : picked.model.modelId;
  // 订阅供应商:凭据在服务端 oauth 里,apiKey 恒空——先解析(可能触发锁内刷新),
  // Authorization 由 credentialHeaders 供给,不再裸拼 apiKey。
  const resolvedAuth = await resolveProviderAuthForProvider(providerItem, { signal: ctx.signal });
  // 消息端点在凭据解析后拼:订阅供应商的 baseUrl 可能由凭证派生(Copilot 的 proxy-ep)。
  const url = endpointFor(providerItem, resolvedAuth.baseUrl);
  const headers = applyRequestHeaders(
    { "Content-Type": "application/json", ...resolvedAuth.headers },
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
  // 动态头取值依据(仅 Copilot 的 X-Initiator/Copilot-Vision-Request 消费)。
  const shapingContext = {
    lastMessageRole: messagesForApi[messagesForApi.length - 1]?.role,
    hasImages: messagesForApi.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p?.type === "image_url" || p?.type === "input_image"),
    ),
  };
  // 订阅供应商整形(§13.3 全路径覆盖):body 定稿后、applyCustomBody 前。
  const shaped = (draft: Record<string, any>) => {
    if (providerItem.authMode === "oauth" && providerItem.oauth) {
      applyShaping(providerItem.oauth.flow, headers, draft, providerItem.oauth.credential, shapingContext);
    }
    return draft;
  };
  // hooks 的 message/node 是活视图:工具循环骨架与 provider reader 直接读 hooks.message
  // (usage 合并 / 思维链收口 / 快照模式的可见文本回读 / 下一轮编码取 reasoning),
  // steer 分裂换绑后这些读写必须落到新节点,所以不能在这里取值缓存。
  const hooks: StreamHooksWithSink = {
    get message() {
      return target.message;
    },
    get node() {
      return target.node;
    },
    conversation,
    sink: ctx.sink,
    executeTool: ctx.executeTool,
    // steering 轮边界透传(用户问题②):协调器装配的排水回调直抵工具循环骨架,
    // 引擎层零感知副作用。
    onSteerBoundary: ctx.onSteerBoundary,
  };
  if (providerItem.type !== "openai") {
    // 把本函数已解析的快照透传，确保 claude/google 路径与 openai 路径读到同一代配置
    return callProvider(conversation, ctx.signal, hooks, { assistant, provider: picked.provider, model: picked.model });
  }
  if (providerItem.useResponseApi) {
    const responseTools = [
      ...tools.map(responseApiFunctionTool),
      ...responseApiBuiltInTools(picked.model),
    ];
    const systemContent = conversationResponseApiInstructions(conversation, assistant);
    const reasoning = responseApiReasoningForProvider(providerItem, picked.model, assistant.reasoningLevel);
    const include = responseApiIncludeForProvider(providerItem, picked.model);
    const body = applyCustomBody(shaped({
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
    }), assistant, picked.model);
    // 订阅供应商整形:Codex 需 include reasoning.encrypted_content、不识别 max_output_tokens。
    return fetchOpenAiTextStreaming(url, headers, body, providerItem, assistant, hooks, ctx.signal);
  }
  const body = applyCustomBody(shaped({
    model: selectedModel,
    // 同非流式路径：出线前剥 tool 消息的内部字段。
    messages: chatCompletionsWireMessages(messagesForApi),
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
  }), assistant, picked.model);
  return fetchOpenAiTextStreaming(url, headers, body, providerItem, assistant, hooks, ctx.signal);
}
