// conversations/auxiliary.ts — 辅助生成（标题/建议/翻译/提示词优化/OCR/会话压缩）
// 纪律：纯搬迁自 server.ts（阶段 5.3g），行为不变。

import type { Assistant, AuxiliaryTextOptions, Conversation, Message, MessagePart, Model } from "../foundation/types";
import { applyPlaceholders, id, isRecord, localeDisplayName, message, textFromParts, uniqueStrings } from "../foundation/utils";
import { state } from "../persistence/json-store";
import { broadcastConversation, broadcastEngineStatus } from "../api/sse";
import { DEFAULT_AUTO_MODEL_ID, applyCustomBody, applyRequestHeaders, findModel } from "../model-providers";
import { applyShaping, resolveProviderAuthForProvider } from "../model-providers/auth";
import { endpointFor } from "../model-providers/checks";
import { openAiMaxTokensField, reasoningLevelNormalized } from "../model-providers/request-dialect";
import { internalOutputCap, requiredOutputCap } from "../model-providers/model-limits";
import {
  auxiliaryReasoningPayloadForProvider,
  claudeThinkingPayload,
  dataUrlForMessageUrl,
  hostOfProvider,
  isModelAllowTemperature,
  parseDataUrl,
  supportsAbility,
  supportsInputModality,
} from "../inference-engine/message-builder";
import {
  completionMessageText,
  fetchClaudeAuxiliaryStream,
  fetchGoogleAuxiliaryStream,
  fetchOpenAiAuxiliaryStream,
  fetchText,
  modelsDevCache,
} from "../inference-engine/providers";
import {
  DEFAULT_COMPRESS_PROMPT,
  DEFAULT_OCR_PROMPT,
  DEFAULT_SUGGESTION_PROMPT,
  DEFAULT_TITLE_PROMPT,
  OCR_OUTPUT_TOKENS,
  SUGGESTION_CHARACTER_LIMIT,
  TITLE_CHARACTER_LIMIT,
} from "../app-config/prompts";
import { compressing } from "./generation-state";
import { getConversation, persistConversation, selectedConversationMessages } from "./index";
import { reportError } from "../observability/app-errors";
import { findAssistant, summaryAsText } from "./helpers";
import { agentSummaryAsText, buildAgentCompactionContext, extractAgentActivity } from "../workspace/compaction";

export function cleanAuxiliaryText(text: string, fallback = "") {
  const cleaned = text.replace(/^["“”'‘’]+|["“”'‘’]+$/g, "").trim();
  if (!cleaned || cleaned === "(empty response)") {
    if (fallback) return fallback;
    throw new Error("Auxiliary model returned empty response");
  }
  return cleaned;
}

function firstAuxiliaryLine(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

export function limitAuxiliaryText(text: string, limit: number) {
  return Array.from(text).slice(0, limit).join("");
}

/** 标题生成。modelId 由调用方决定口径:自动生成传 resolveFastModelId()(没配就不该调到这里);
 *  手动「重新生成标题」传会话模型兜底——那是用户显式点的一次动作,回退用主模型合理。 */
export async function generateTitleForConversation(conversation: Conversation, modelId: string) {
  const summary = conversationSummary(conversation, 4).trim();
  const firstText = textFromParts(conversation.messages[0]?.messages[0]?.parts ?? []).trim();
  const content = summary || firstText;
  if (!content) return "New Conversation";
  const prompt = applyPlaceholders(state.settings.titlePrompt || DEFAULT_TITLE_PROMPT, {
    locale: localeDisplayName(),
    content: selectedConversationMessages(conversation).slice(-4).map(summaryAsText).join("\n\n"),
  });
  // 推理档不传 → 默认 auto:让模型自行决定是否思考,不再硬编码 "off"(部分新模型思考
  // 不可关,硬关反而出错;APP 亦默认 AUTO)。
  const text = await fetchAuxiliaryText(modelId, prompt, "title", {
    conversationId: conversation.id,
  });
  return limitAuxiliaryText(
    firstAuxiliaryLine(cleanAuxiliaryText(text, limitAuxiliaryText(firstText, TITLE_CHARACTER_LIMIT) || "New Conversation")),
    TITLE_CHARACTER_LIMIT,
  ) || "New Conversation";
}

export function shouldAutoGenerateTitle(conversation: Conversation) {
  const firstText = textFromParts(conversation.messages[0]?.messages[0]?.parts ?? []).trim();
  const title = String(conversation.title ?? "").trim();
  if (!title || title === "New Conversation") return true;
  if (firstText && title === limitAuxiliaryText(firstText, TITLE_CHARACTER_LIMIT)) return true;
  return false;
}

function conversationSummary(conversation: Conversation, takeLast = 8) {
  return conversation.messages
    .map((node) => node.messages[node.selectIndex] ?? node.messages[0])
    .filter(Boolean)
    .slice(-takeLast)
    .map((msg) => summaryAsText(msg))
    .filter((line) => line.trim().length > 6)
    .join("\n\n");
}

export function isQwenMtModel(modelId: string) {
  const normalized = modelId.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  return tokens.includes("qwen") && tokens.includes("mt");
}

export function englishLanguageName(locale: string) {
  const language = locale.trim() || Intl.DateTimeFormat().resolvedOptions().locale;
  try {
    const displayNames = new Intl.DisplayNames(["en"], { type: "language" });
    return displayNames.of(language) || displayNames.of(language.split(/[-_]/)[0]) || language;
  } catch {
    return language.split(/[-_]/)[0] || language;
  }
}

export async function fetchAuxiliaryText(modelId: string, prompt: string, kind: string, options: AuxiliaryTextOptions = {}) {
  const picked = findModel(modelId || state.settings.chatModelId);
  const providerItem = picked.provider;
  const modelItem = picked.model;
  const selectedModel = modelItem.modelId === "auto" ? "gpt-4o-mini" : modelItem.modelId;
  const maxTokens = options.maxTokens ?? null;
  const reasoningLevel = options.reasoningLevel ?? null;
  const stream = options.stream === true;
  // 取消信号:仅压缩链路(带 signal 调用)生效,其余调用方 undefined —— 与既有不传 signal 行为逐字节一致。
  const signal = options.signal;
  const pushDelta = (text: string) => {
    if (text) options.onDelta?.(text);
  };
  const assistant = {
    ...findAssistant(state.settings.assistantId),
    chatModelId: modelItem.id,
    systemPrompt: "",
    temperature: options.temperature ?? null,
    topP: null,
    maxTokens,
    streamOutput: false,
    enabledSkills: [],
    mcpServers: [],
    localTools: [],
    customBodies: options.customBody
      ? Object.entries(options.customBody).map(([key, value]) => ({ key, value }))
      : [],
  } as Assistant;
  // 订阅供应商:凭据在服务端 oauth 里,apiKey 恒空——先经 resolveProviderAuthForProvider
  // 解析(可能触发锁内刷新),后续注入点统一用 credentialHeaders 而非裸 apiKey。
  const resolvedAuth = await resolveProviderAuthForProvider(providerItem, { signal });
  const headers = applyRequestHeaders(
    { "Content-Type": "application/json", ...resolvedAuth.headers },
    assistant,
    providerItem,
    modelItem,
    options.conversationId,
  );
  let endpoint = endpointFor(providerItem);
  let body: Record<string, any>;
  // 订阅供应商整形(Codex:删 max_output_tokens、并 include、补 originator/OpenAI-Beta 头)与主生成
  // 路径同一时机:body 定稿后、applyCustomBody 前。辅助调用漏整形 = 标题/建议在 Codex 上 400。
  const shaped = (draft: Record<string, any>) => {
    if (providerItem.authMode === "oauth" && providerItem.oauth) applyShaping(providerItem.oauth.flow, headers, draft);
    return draft;
  };

  if (providerItem.type === "google") {
    // issue10:Gemini 鉴权统一走 x-goog-api-key 头,URL 不再带 ?key=(中转网关只认 header)。
    // 订阅供应商:google 暂无 oauth 形态,apiKey 恒空时 credentialHeaders 已含解析头。
    if (providerItem.authMode !== "oauth") headers["x-goog-api-key"] = providerItem.apiKey;
    endpoint = `${providerItem.baseUrl.replace(/\/+$/, "")}/models/${selectedModel}:generateContent`;
    body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        ...(maxTokens != null ? { maxOutputTokens: maxTokens } : {}),
        ...(options.temperature != null ? { temperature: options.temperature } : {}),
      },
    };
    if (stream) {
      const streamEndpoint = `${providerItem.baseUrl.replace(/\/+$/, "")}/models/${selectedModel}:streamGenerateContent`;
      try {
        return cleanAuxiliaryText(await fetchGoogleAuxiliaryStream(streamEndpoint, headers, applyCustomBody(shaped(body), assistant, modelItem), providerItem, pushDelta, signal));
      } catch {
        // Fall back to non-streaming auxiliary calls; some compatible gateways do not expose Gemini streaming.
      }
    }
    return fetchText(endpoint, headers, applyCustomBody(shaped(body), assistant, modelItem), providerItem, (raw) => raw.candidates?.[0]?.content?.parts?.[0]?.text, signal);
  }
  if (providerItem.type === "claude") {
    // 订阅供应商(Kimi/Claude):oauth 轨已在 credentialHeaders 注入 Authorization: Bearer;
    // apiKey 轨保持 x-api-key。互斥,不双发。
    if (providerItem.authMode !== "oauth") headers["x-api-key"] = providerItem.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body = {
      model: selectedModel,
      // Anthropic 协议 max_tokens 必填。两种来源分开处理:调用方给了 maxTokens 的
      // (提示词优化 4096)那是**我们的**任务预算,须收进模型真实上限(internalOutputCap);
      // 没给的(标题/建议/翻译/压缩)走与主生成路径同一个 requiredOutputCap 单源。
      // 此前是 `maxTokens ?? DEFAULT_OUTPUT_TOKENS` —— 后者恒 64000,对输出上限低于
      // 此值的模型(claude-3-haiku 4096、cohere command-r 4000)Anthropic 直接 400,
      // 与本次 1210 报障同类,只是触发面在辅助任务、更难被注意到。
      max_tokens:
        maxTokens != null
          ? internalOutputCap(modelsDevCache, providerItem, modelItem.modelId, maxTokens)
          : requiredOutputCap(modelsDevCache, providerItem, modelItem.modelId, null),
      messages: [{ role: "user", content: prompt }],
      stream,
      ...(options.temperature != null && (!reasoningLevel || !reasoningEnabled(reasoningLevel)) ? { temperature: options.temperature } : {}),
      // 与主路径一致：thinking + output_config，DeepSeek 走 Claude 格式时 display:"raw"
      ...(reasoningLevel ? claudeThinkingPayload(modelItem, reasoningLevel) : {}),
    };
    if (stream) {
      try {
        return cleanAuxiliaryText(await fetchClaudeAuxiliaryStream(endpoint, headers, applyCustomBody(shaped(body), assistant, modelItem), providerItem, pushDelta, signal));
      } catch {
        body.stream = false;
      }
    }
    return fetchText(endpoint, headers, applyCustomBody(shaped(body), assistant, modelItem), providerItem, (raw) => raw.content?.map((item: { text?: string }) => item.text ?? "").join("\n"), signal);
  }
  if (providerItem.authMode !== "oauth") headers.Authorization = `Bearer ${providerItem.apiKey}`;
  body = providerItem.useResponseApi
    ? {
        model: selectedModel,
        input: [{ role: "user", content: prompt }],
        stream,
        store: false,
        ...(maxTokens != null ? { max_output_tokens: maxTokens } : {}),
        ...(reasoningLevel && supportsAbility(modelItem, "REASONING")
          ? { reasoning: { summary: "auto", ...(reasoningLevelNormalized(reasoningLevel) !== "auto" ? { effort: reasoningLevelNormalized(reasoningLevel) === "off" ? "none" : reasoningLevelNormalized(reasoningLevel) } : {}) } }
          : {}),
      }
    : {
        model: selectedModel,
        messages: [{ role: "user", content: prompt }],
        stream,
        // 上限字段名走统一请求方言（model-providers/request-dialect），与主生成路径一致。
        ...(maxTokens != null ? { [openAiMaxTokensField(hostOfProvider(providerItem))]: maxTokens } : {}),
        ...(options.temperature != null && isModelAllowTemperature(modelItem) ? { temperature: options.temperature } : {}),
        ...(options.topP != null && isModelAllowTemperature(modelItem) ? { top_p: options.topP } : {}),
        ...auxiliaryReasoningPayloadForProvider(providerItem, modelItem, reasoningLevel),
      };
  if (stream) {
    try {
      const text = await fetchOpenAiAuxiliaryStream(endpoint, headers, applyCustomBody(shaped(body), assistant, modelItem), providerItem, pushDelta, signal);
      if (!text || text === "(empty response)") throw new Error(`${kind} model returned empty response`);
      return text;
    } catch {
      body.stream = false;
    }
  }
  const text = await fetchText(endpoint, headers, applyCustomBody(shaped(body), assistant, modelItem), providerItem, completionMessageText, signal);
  if (!text || text === "(empty response)") throw new Error(`${kind} model returned empty response`);
  return text;
}

function reasoningEnabled(level: string | null | undefined) {
  return reasoningLevelNormalized(level) !== "off";
}

/** 某个模型 id 是否指向用户真实配置的模型。
 *  纪律:AUTO 哨兵(`DEFAULT_AUTO_MODEL_ID`,出厂默认值)**不算已配置**——它的语义是
 *  「用户没选」。旧版把它白名单放行,导致辅助任务以为有模型可用,进而落到 findModel 的
 *  兜底(第一个供应商 + 猜一个 "auto"→gpt-4o-mini),对不提供该模型的服务商必 400。
 *  这是「标题/建议生成失败」弹窗的根因。判否后由各调用方决定回退口径(见
 *  resolveFastModelId / 压缩模型回退会话模型)。 */
export function modelExists(modelId: string | null | undefined) {
  if (!modelId || modelId === DEFAULT_AUTO_MODEL_ID) return false;
  return state.settings.providers.some((providerItem) =>
    providerItem.models.some((modelItem) => modelItem.id === modelId || modelItem.modelId === modelId)
  );
}

/** 会话自身的生效模型 id(助手覆盖 > 全局默认)。 */
export function conversationModelIdFor(conversation: Conversation): string {
  return findAssistant(conversation.assistantId).chatModelId || state.settings.chatModelId;
}

/** 快速模型(标题/建议)的生效解析:**没配就是没配**,返回 null 让调用方整体跳过。
 *  刻意不回退主模型——标题每会话一次尚可,建议回复每轮一次,拿主模型跑不划算;宁可
 *  标题退成首条消息文本、建议不出,也不替用户花钱。三类"没配"归一处理:
 *  空串(设置页选了「未设置」)/ AUTO 哨兵(出厂默认,从未选过)/ 指向已删除的模型。
 *  关键是跳过必须**静默**:此前哨兵被 modelExists 白名单放行,辅助任务照常发请求 →
 *  findModel 兜底猜 gpt-4o-mini → 服务商不提供必 400 → 每轮弹两条失败提示。 */
export function resolveFastModelId(): string | null {
  const configured = state.settings.fastModelId;
  return modelExists(configured) ? configured : null;
}

/** 标题/建议两个后生成任务各自的生效快速模型 id(唯一裁决点):快速模型没配,或对应
 *  子功能被用户在设置里关停(快速模型卡的 Prompt 页开关),都为 null。为 null 时调用方
 *  走既有的「未配置」路径——标题退首条消息文本命名、建议不生成,开关关停与从未配置的
 *  外在行为完全一致,不新增第三类状态。 */
export function resolvePostGenerationModelIds(): { title: string | null; suggestion: string | null } {
  const fast = resolveFastModelId();
  return {
    title: state.settings.titleGenerationEnabled === false ? null : fast,
    suggestion: state.settings.enableSuggestion === false ? null : fast,
  };
}

/** OCR 模型(图片转文字备用通道)的生效解析:OCR 属于"报错档"功能(用户拍板:
 *  未配置不兜底、不静默)——没配就抛人话错误,由调用方落成图片 part 的失败态,
 *  前端在图片下方渲染提示并引导去设置。与标题/建议的"静默跳过"档刻意相反:OCR
 *  只在「聊天模型看不见图」时才被需要,跳过它等于把一张模型读不到的图悄悄丢进
 *  上下文,用户必须知情。 */
export function requireOcrModelId(): string {
  if (modelExists(state.settings.ocrModelId)) return state.settings.ocrModelId;
  throw new Error("当前聊天模型不支持图片输入,且未配置 OCR 模型。请到「设置 - 默认模型与提示词」为 OCR 指定一个支持视觉的模型");
}

async function fetchAuxiliaryOcrText(imageUrl: string) {
  const ocrModelId = requireOcrModelId();
  const picked = findModel(ocrModelId);
  const providerItem = picked.provider;
  const modelItem = picked.model;
  const selectedModel = modelItem.modelId === "auto" ? "gpt-4o-mini" : modelItem.modelId;
  const prompt = state.settings.ocrPrompt || DEFAULT_OCR_PROMPT;
  const dataUrl = dataUrlForMessageUrl(imageUrl);
  // OCR 的 2048 是我们给这个任务定的预算,不是用户的选择:收进模型真实上限,免得对
  // 输出上限更低的模型硬发大数(见 internalOutputCap 头注)。三个协议 + assistant 共用。
  const ocrCap = internalOutputCap(modelsDevCache, providerItem, modelItem.modelId, OCR_OUTPUT_TOKENS);
  const assistant = {
    ...findAssistant(state.settings.assistantId),
    chatModelId: modelItem.id,
    systemPrompt: "",
    temperature: 0,
    topP: null,
    maxTokens: ocrCap,
    streamOutput: false,
    enabledSkills: [],
    mcpServers: [],
    localTools: [],
  } as Assistant;
  // 订阅供应商:凭据在服务端 oauth 里,apiKey 恒空——先解析(可能触发锁内刷新)。
  const resolvedAuth = await resolveProviderAuthForProvider(providerItem);
  const headers = applyRequestHeaders({ "Content-Type": "application/json", ...resolvedAuth.headers }, assistant, providerItem, modelItem);
  let endpoint = endpointFor(providerItem);
  let body: Record<string, any>;
  // 订阅供应商整形,同 fetchAuxiliaryText:body 定稿后、applyCustomBody 前。
  const shaped = (draft: Record<string, any>) => {
    if (providerItem.authMode === "oauth" && providerItem.oauth) applyShaping(providerItem.oauth.flow, headers, draft);
    return draft;
  };

  if (providerItem.type === "google") {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return "";
    if (providerItem.authMode !== "oauth") headers["x-goog-api-key"] = providerItem.apiKey;
    endpoint = `${providerItem.baseUrl.replace(/\/+$/, "")}/models/${selectedModel}:generateContent`;
    body = {
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType: parsed.mime, data: parsed.data } },
        ],
      }],
    };
    return cleanAuxiliaryText(await fetchText(endpoint, headers, applyCustomBody(shaped(body), assistant, modelItem), providerItem, (raw) => raw.candidates?.[0]?.content?.parts?.[0]?.text));
  }

  if (providerItem.type === "claude") {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return "";
    if (providerItem.authMode !== "oauth") headers["x-api-key"] = providerItem.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body = {
      model: selectedModel,
      max_tokens: ocrCap,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image", source: { type: "base64", media_type: parsed.mime, data: parsed.data } },
        ],
      }],
    };
    return cleanAuxiliaryText(await fetchText(endpoint, headers, applyCustomBody(shaped(body), assistant, modelItem), providerItem, (raw) => raw.content?.map((item: { text?: string }) => item.text ?? "").join("\n")));
  }

  if (providerItem.authMode !== "oauth") headers.Authorization = `Bearer ${providerItem.apiKey}`;
  body = providerItem.useResponseApi
    ? {
        model: selectedModel,
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: dataUrl },
          ],
        }],
        max_output_tokens: ocrCap,
      }
    : {
        model: selectedModel,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        }],
        // 上限字段名走统一请求方言（o 系官方口同样具备视觉能力，恒发 max_tokens 会 400）。
        [openAiMaxTokensField(hostOfProvider(providerItem))]: ocrCap,
        temperature: isModelAllowTemperature(modelItem) ? 0 : undefined,
      };
  return cleanAuxiliaryText(await fetchText(endpoint, headers, applyCustomBody(shaped(body), assistant, modelItem), providerItem, completionMessageText));
}

/** 是否需要 OCR:聊天模型看不见图(inputModalities 无 IMAGE)。**不再**在判据里
 *  连带要求 OCR 模型已配置——未配置时也要走到 attachOcrToImageParts,让图片 part
 *  落成"failed + 人话错误"而非静默无痕(报错档语义,见 requireOcrModelId 注)。 */
function needsOcrForModel(modelItem: Model) {
  return !supportsInputModality(modelItem, "IMAGE");
}

export async function attachOcrToImageParts(parts: MessagePart[], modelItem: Model) {
  if (!needsOcrForModel(modelItem)) return parts;
  const next = [...parts];
  for (let index = 0; index < next.length; index += 1) {
    const part = next[index];
    if (!isRecord(part) || part.type !== "image") continue;
    const metadata = isRecord(part.metadata) ? part.metadata : {};
    if (String(metadata.ocrText ?? "").trim()) continue;
    const url = String(part.url ?? "");
    if (!url) continue;
    try {
      const ocrText = await fetchAuxiliaryOcrText(url);
      if (ocrText) {
        next[index] = { ...part, metadata: { ...metadata, ocrText, ocrStatus: "done" } };
      }
    } catch (err) {
      next[index] = {
        ...part,
        metadata: {
          ...metadata,
          ocrStatus: "failed",
          ocrError: err instanceof Error ? err.message : String(err),
        },
      };
      // info 级(错误中心留痕,不弹全局 toast):失败已就地落在图片 part 上,用户在
      // 会话里看得到红色提示——再弹全局 toast 是双重打扰(多图场景会连环弹)。
      reportError("provider", "info", "OCR 识别失败", err, "ocr_failed");
    }
  }
  return next;
}

export function markOcrPendingParts(parts: MessagePart[], modelItem: Model) {
  if (!needsOcrForModel(modelItem)) return parts;
  return parts.map((part) => {
    if (!isRecord(part) || part.type !== "image") return part;
    const metadata = isRecord(part.metadata) ? part.metadata : {};
    if (String(metadata.ocrText ?? "").trim()) return part;
    return { ...part, metadata: { ...metadata, ocrStatus: "pending" } };
  });
}

/** 建议回复生成。modelId 必传(快速模型):未配置时调用方不该调到这里。 */
export async function generateSuggestionsForConversation(conversation: Conversation, modelId: string) {
  const content = conversationSummary(conversation, 8);
  if (!content) return [];
  const prompt = applyPlaceholders(state.settings.suggestionPrompt || DEFAULT_SUGGESTION_PROMPT, {
    locale: localeDisplayName(),
    content: selectedConversationMessages(conversation).slice(-8).map(summaryAsText).join("\n\n"),
  });
  const text = await fetchAuxiliaryText(modelId, prompt, "suggestion", {
    conversationId: conversation.id,
  });
  return uniqueStrings(
    text
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)、])\s*/, "").trim())
      .filter(Boolean)
      .map((line) => limitAuxiliaryText(line, SUGGESTION_CHARACTER_LIMIT))
      .filter(Boolean),
  ).slice(0, 10);
}

/** 压缩发生点标记(两模式共享):压缩完成时打在"当时的最新一条消息"上,前端据此在该
 *  消息下方渲染"上下文已压缩"分割线——锚定用户发起压缩的位置。刻意不锚定切点/摘要
 *  的技术形态(pi 保留窗口的切点在时间线中段,线画在那里用户会疑惑"我在底部发的
 *  /compact,线怎么跑上面去了")。幂等:同一条消息不重复打。 */
export function markCompactionBoundary(conversation: Conversation): void {
  const tail = selectedConversationMessages(conversation).at(-1);
  if (!tail) return;
  tail.annotations ??= [];
  if (tail.annotations.some((item) => isRecord(item) && item.type === "compaction_boundary")) return;
  tail.annotations.push({ type: "compaction_boundary" });
}

export async function compressConversation(conversation: Conversation, additionalPrompt = "", targetTokens = 2000, keepRecentMessages = 32, signal?: AbortSignal) {
  const allMessages = selectedConversationMessages(conversation);
  if (allMessages.length === 0) throw new Error("当前会话没有可压缩的消息");
  // 审计防线快照:压缩是"按开头快照整体覆盖 messages"的破坏性替换,期间任何写入
  // (发消息/重新生成/删除节点等)都会在覆盖时被静默吞掉。API 三写入口已 409 互斥,
  // 这里再记引用+长度,落库前比对——防住未来新增的绕过入口的写路径(fail-safe:
  // 宁可压缩作废重来,不可丢用户数据)。
  const messagesRefBefore = conversation.messages;
  const messagesLengthBefore = conversation.messages.length;

  // 内测反馈(310K 会话 /compact 报"消息数量不足"):按条数保留的语义对"少而长"的会话
  // 不成立——20 条超长消息的会话 token 巨大,却因条数 ≤ 默认保留 32 条被整体划进保留区,
  // 直接拒绝。压缩的目的是省上下文,"保留最近 N 条"是手段不是目的:条数不足时自动降级
  // 为保留一半(至少压掉一半旧消息),恒可压。单条消息 floor(1/2)=0 → 全压成摘要,同样成立。
  let effectiveKeepRecent = keepRecentMessages;
  if (effectiveKeepRecent > 0 && allMessages.length <= effectiveKeepRecent) {
    effectiveKeepRecent = Math.floor(allMessages.length / 2);
  }

  let messagesToCompress: Message[];
  let messagesToKeep: Message[];
  if (effectiveKeepRecent > 0) {
    messagesToCompress = allMessages.slice(0, -effectiveKeepRecent);
    messagesToKeep = allMessages.slice(-effectiveKeepRecent);
  } else {
    messagesToCompress = allMessages;
    messagesToKeep = [];
  }

  const splitMessages = (messages: Message[]): Message[][] => {
    if (messages.length <= 256) return [messages];
    const mid = Math.floor(messages.length / 2);
    return [...splitMessages(messages.slice(0, mid)), ...splitMessages(messages.slice(mid))];
  };

  // Agent 分化(§9.8):入口/管线/提示词同一套,仅输入构建按会话类型变——工具 part 折为
  // 摘要行进压缩输入,工作区活动清单经 {additional_context} 结构化注入(pi CompactionDetails
  // 思想)。chat 会话(workspaceId 空)走原路径,逐字节不变。
  const isAgent = Boolean(conversation.workspaceId);
  const summarize = isAgent ? (msg: Message) => agentSummaryAsText(msg, summaryAsText(msg)) : summaryAsText;
  const chunks = splitMessages(messagesToCompress);
  const summaries: string[] = [];
  // 失败/取消的 UI 收尾无需在此处理:进度在 engine-status 帧里(compress 端点 finally
  // 统一广播 busy:false),不再有落在会话对象上的瞬态标签需要清理。
  for (const chunk of chunks) {
    // R7-4:每个分块前查取消——用户中途取消不再烧后续分块的 LLM 轮次。
    if (signal?.aborted) throw new DOMException("Compression cancelled", "AbortError");
    // 分块进度走 engine-status 帧(状态条统一渲染"正在压缩上下文 (n/m) · 已处理 xx秒")。
    // 原实现借 chatSuggestions 建议条展示进度文本——挪用了建议区的语义位,且文案
    // 无法 i18n;进度本就是引擎状态的一部分,并入 engine-status 后该 hack 退役。
    // startedAt 从 compressing 注册表回读(compress 端点开始时写入),进度帧不重置计时。
    broadcastEngineStatus(conversation.id, {
      busy: true,
      phase: "compacting",
      progress: { current: summaries.length + 1, total: chunks.length },
      ...(compressing.has(conversation.id) ? { startedAt: compressing.get(conversation.id) } : {}),
    });
    const contextSections = [
      additionalPrompt.trim() ? `Additional instructions from user: ${additionalPrompt.trim()}` : "",
      isAgent ? buildAgentCompactionContext(extractAgentActivity(chunk)) : "",
    ].filter(Boolean);
    const prompt = applyPlaceholders(state.settings.compressPrompt || DEFAULT_COMPRESS_PROMPT, {
      content: chunk.map(summarize).join("\n\n"),
      target_tokens: String(targetTokens),
      additional_context: contextSections.join("\n\n"),
      locale: localeDisplayName(),
    });
    // 压缩模型未配置(空/AUTO 哨兵)或已被删除 → 回退会话模型。不能直接把哨兵交给
    // findModel:它查不到就兜底"第一个供应商 + 猜 auto→gpt-4o-mini",对不提供该模型的
    // 服务商必 400(与标题/建议同一根因)。
    summaries.push(cleanAuxiliaryText(await fetchAuxiliaryText(
      modelExists(state.settings.compressModelId) ? state.settings.compressModelId : conversationModelIdFor(conversation),
      prompt,
      "compression",
      {
        stream: true,
        signal,
        conversationId: conversation.id,
      },
    )));
  }
  // R7-4:落库前最后一道闸——取消后 LLM 结果作废,绝不改写会话(压缩是破坏性替换,
  // 取消语义必须硬保证)。
  if (signal?.aborted) throw new DOMException("Compression cancelled", "AbortError");
  // 批6复审 G1:会话在压缩期间被删除/被导入替换时结果同样作废——下方 persistConversation
  // 是无条件 upsert,会把已删会话复活成"只剩摘要"的僵尸。
  if (getConversation(conversation.id) !== conversation) throw new Error("会话已被删除,压缩结果作废");
  // 审计防线:期间有写入(push 改长度 / delete-filter 换引用)则整体作废,绝不覆盖。
  if (conversation.messages !== messagesRefBefore || conversation.messages.length !== messagesLengthBefore) {
    throw new Error("会话在压缩期间发生变更,压缩结果作废,请重试");
  }

  conversation.messages = [
    ...summaries.filter(Boolean).map((summary) => ({ id: id(), messages: [message("USER", [{ type: "text", text: summary }])], selectIndex: 0 })),
    ...messagesToKeep.map((msg) => ({ id: id(), messages: [JSON.parse(JSON.stringify(msg))], selectIndex: 0 })),
  ];
  markCompactionBoundary(conversation);
  conversation.chatSuggestions = [];
  conversation.updateAt = Date.now();
  persistConversation(conversation);
  broadcastConversation(conversation);
  return summaries;
}
