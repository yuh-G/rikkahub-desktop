// inference-engine/message-builder.ts — API 消息格式转换
// 纪律：把 UI Message / Conversation 转成 OpenAI / Claude / Google / Response API 请求体。
// 不处理网络请求、不读写 state.json、不广播 SSE。

import { existsSync, readFileSync } from "node:fs";
import type { ApiMessage, Assistant, JsonValue, Message, MessagePart, Model, Provider, ToolOutputEntry } from "../foundation/types";
import { id, isRecord } from "../foundation/utils";
import {
  ARK_SEED2_EFFORT_BY_LEVEL,
  budgetTokensFor,
  deepseekEffortFor,
  effortLowHighMaxFor,
  gemini3ThinkingLevelFor,
  isArkSeed2Model,
  isKimiK26Model,
  isKimiK27Model,
  isKimiK3Model,
  isMiMoOfficialHost,
  isSamplingLockedModel,
  isSiliconFlowEffortModel,
  isZhipuEffortModel,
  isZhipuForcedThinkingModel,
  isZhipuGlm53Model,
  reasoningLevelNormalized,
  SILICONFLOW_THINKING_MODELS,
  ZHIPU_GLM53_EFFORT_BY_LEVEL,
} from "../model-providers/request-dialect";
import { fallbackDocumentText, readExtractedTextSync } from "../files/index";
import { ensureExtractedTextAsync } from "../files/extraction";
import { UNRESOLVED_TOOL_RESULT_TEXT, parseToolInput, toolArgumentsJson, toolResultTextForApi } from "../tools/format";
import { state } from "../persistence/json-store";

export function fileEntryFromApiUrl(url: string) {
  const match = url.match(/^\/api\/files\/(\d+)\/content(?:\?.*)?$/) ?? url.match(/^\/files\/(\d+)\/content(?:\?.*)?$/);
  if (!match) return null;
  return state.files.find((file) => file.id === Number(match[1])) ?? null;
}


export function dataUrlForMessageUrl(url: string) {
  if (!url || url.startsWith("data:") || /^https?:\/\//i.test(url)) return url;
  const entry = fileEntryFromApiUrl(url);
  if (!entry || !existsSync(entry.path)) return url;
  const data = readFileSync(entry.path).toString("base64");
  return `data:${entry.mime || "application/octet-stream"};base64,${data}`;
}


export function parseDataUrl(url: string) {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/);
  return match ? { mime: match[1], data: match[2] } : null;
}


export function documentPromptText(fileName: string, content: string) {
  return `## user sent a file: ${fileName}
<content>
\`\`\`
${content}
\`\`\`
</content>`;
}


// issue6:对齐安卓 DocumentAsPromptTransformer(add(0, prompt))——文档全文排在消息
// parts 最前、用户问题在后。Gemini 等长上下文模型对"长内容在前、指令在后"敏感
// (Google 官方长上下文指引),问题在前会显著降低模型对长文档中后段的利用率,
// 表现为"上传长文只有前几千行被用到"。仅在请求构建时重排,存储与 UI 展示不变。
export function documentPartsFirst<T>(parts: T[]): T[] {
  const isDoc = (p: T) => isRecord(p) && (p as Record<string, unknown>).type === "document";
  if (!parts.some(isDoc)) return parts;
  return [...parts.filter(isDoc), ...parts.filter((p) => !isDoc(p))];
}

export function contentPartsForApi(parts: MessagePart[], targetModel?: Model) {
  const stripImageForOcr = targetModel ? !supportsInputModality(targetModel, "IMAGE") : false;
  const result: any[] = [];
  for (const part of documentPartsFirst(parts)) {
    if (!isRecord(part)) continue;
    if (part.type === "text") {
      const text = String(part.text ?? "");
      if (text) result.push({ type: "text", text });
    } else if (part.type === "image") {
      const metadata = isRecord(part.metadata) ? part.metadata : {};
      const ocrText = String(metadata.ocrText ?? "").trim();
      // Android OcrTransformer: when chat model has no IMAGE input, replace image with OCR text.
      // Otherwise (model supports image), keep the image and append OCR text alongside as extra hint.
      if (stripImageForOcr && ocrText) {
        result.push({
          type: "text",
          text: `<image_file_ocr>\n${ocrText}\n</image_file_ocr>`,
        });
        continue;
      }
      const url = dataUrlForMessageUrl(String(part.url ?? ""));
      if (url) result.push({ type: "image_url", image_url: { url } });
      if (ocrText) {
        result.push({
          type: "text",
          text: `<image_file_ocr>\n${ocrText}\n</image_file_ocr>`,
        });
      }
    } else if (part.type === "document") {
      const fileName = String(part.fileName ?? "document");
      const url = String(part.url ?? "");
      const entry = fileEntryFromApiUrl(url);
      // 3-4:只读旁车缓存,未命中降级 fallback 并后台补抽(此前同步解析大 PDF
      // 会把整个后端阻塞数秒,其他会话的流式一起冻结)。
      const extractedText = entry ? readExtractedTextSync(entry).trim() : "";
      if (!extractedText && entry) ensureExtractedTextAsync(entry);
      result.push({
        type: "text",
        text: extractedText
          ? documentPromptText(fileName, extractedText)
          : fallbackDocumentText({ fileName, url, entry: entry ?? null }),
      });
    } else if (part.type === "audio" || part.type === "video") {
      const url = String(part.url ?? "");
      if (url) result.push({ type: "text", text: `[${part.type}: ${url}]` });
    }
  }
  return result;
}


export function apiContentFromParts(parts: MessagePart[], fallbackText = "", targetModel?: Model) {
  const contentParts = contentPartsForApi(parts, targetModel);
  if (contentParts.length === 0) return fallbackText;
  if (contentParts.length === 1 && contentParts[0].type === "text") return contentParts[0].text;
  return contentParts;
}


export function claudeContentFromApiContent(content: any) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((part) => {
    if (part?.type === "image_url") {
      const dataUrl = String(part.image_url?.url ?? "");
      const parsed = parseDataUrl(dataUrl);
      if (parsed) {
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: parsed.mime,
            data: parsed.data,
          },
        };
      }
      return { type: "text", text: `[Image: ${dataUrl}]` };
    }
    if (part?.type === "text") return { type: "text", text: String(part.text ?? "") };
    return { type: "text", text: JSON.stringify(part) };
  });
}


export function claudeCacheControlEphemeral(providerItem: Provider) {
  return {
    type: "ephemeral",
    ...(providerItem.promptCacheTtl === "1h" ? { ttl: "1h" } : {}),
  };
}


export function claudeTextBlock(text: string) {
  return { type: "text", text };
}


export function claudeContentBlocks(content: any) {
  const converted = claudeContentFromApiContent(content);
  return Array.isArray(converted) ? converted : [claudeTextBlock(String(converted ?? ""))];
}


export function claudeBlocksFromUiParts(parts: ToolOutputEntry[]) {
  const blocks: any[] = [];
  for (const part of parts as unknown as Array<Record<string, JsonValue>>) {
    if (!isRecord(part)) continue;
    if (part.type === "text") {
      const text = String(part.text ?? "");
      if (text) blocks.push({ type: "text", text });
    } else if (part.type === "image") {
      const parsed = parseDataUrl(dataUrlForMessageUrl(String(part.url ?? "")));
      if (parsed) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: parsed.mime, data: parsed.data },
        });
      } else {
        const url = String(part.url ?? "");
        if (url) blocks.push({ type: "text", text: `[Image: ${url}]` });
      }
    } else if (part.type === "document") {
      const fileName = String(part.fileName ?? "document");
      const url = String(part.url ?? "");
      const entry = fileEntryFromApiUrl(url);
      // 3-4:同上,只读缓存+后台补抽。
      const extractedText = entry ? readExtractedTextSync(entry).trim() : "";
      if (!extractedText && entry) ensureExtractedTextAsync(entry);
      blocks.push({
        type: "text",
        text: extractedText
          ? documentPromptText(fileName, extractedText)
          : fallbackDocumentText({ fileName, url, entry: entry ?? null }),
      });
    }
  }
  // 无可投影内容时给确定性占位而非空 text block:Anthropic 明确拒空文本块(400
  // "text content blocks must be non-empty",见下方 claudeMessagesFromApiMessages 头注),
  // 空 tool_result 正是触发形态。占位与 OpenAI 系的 toolResultTextForApi 同一常量,
  // 三家 provider 对"有调用无结果"的回灌表述统一。
  return blocks.length ? blocks : [claudeTextBlock(UNRESOLVED_TOOL_RESULT_TEXT)];
}


export function claudeToolUseBlock(toolCall: any) {
  const fn = toolCall?.function ?? {};
  return {
    type: "tool_use",
    id: String(toolCall?.id ?? id()),
    name: String(fn.name ?? ""),
    input: parseToolInput(fn.arguments),
  };
}


export function claudeToolResultBlock(toolMessage: ApiMessage) {
  const outputParts = Array.isArray(toolMessage._rikkahub_tool_output_parts)
    ? claudeBlocksFromUiParts(toolMessage._rikkahub_tool_output_parts)
    : claudeContentBlocks(toolMessage.content);
  return {
    type: "tool_result",
    tool_use_id: String(toolMessage.tool_call_id ?? ""),
    content: outputParts,
  };
}


export function withClaudeCacheOnLastBlock(content: any, providerItem: Provider) {
  const blocks = claudeContentBlocks(content);
  if (blocks.length === 0) return blocks;
  return blocks.map((block, index) =>
    index === blocks.length - 1 && isRecord(block)
      ? { ...block, cache_control: claudeCacheControlEphemeral(providerItem) }
      : block,
  );
}


export function claudeSystemContent(system: unknown, providerItem: Provider) {
  const text = String(system ?? "").trim();
  if (!text) return undefined;
  // 对齐安卓 ClaudeProvider.buildMessageRequest：system 始终以 text block 数组发送
  // （无缓存时也用数组，避免部分第三方代理只认数组格式）；开启 promptCaching 时
  // 在最后一个 block 上加 cache_control。
  if (providerItem.promptCaching === true) return withClaudeCacheOnLastBlock(text, providerItem);
  return [claudeTextBlock(text)];
}


export function claudeMessagesFromApiMessages(messages: ApiMessage[], providerItem: Provider) {
  const items: any[] = messages
    .filter((item) => item.role !== "system")
    .flatMap((item): any[] => {
      if (item.role === "assistant") {
        const content = claudeContentBlocks(item.content).filter((block) =>
          !isRecord(block) || block.type !== "text" || String(block.text ?? "").trim()
        );
        const toolCalls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
        const toolUseBlocks = toolCalls.map(claudeToolUseBlock).filter((block) => block.name);
        const blocks = [...content, ...toolUseBlocks];
        return blocks.length ? [{ role: "assistant", content: blocks }] : [];
      }
      if (item.role === "tool") {
        return [{ role: "user", content: [claudeToolResultBlock(item)] }];
      }
      return [{ role: "user", content: claudeContentBlocks(item.content) }];
    });

  // 合并连续的 tool_result user message（对齐安卓 ClaudeProvider.addAssistantMessage +
  // groupPartsByToolBoundary，见 ClaudeProviderMessageTest "parallel tool calls should be in
  // same assistant message"）。OpenAI 格式把一轮 assistant 并行的多个 tool_use 结果拆成多条
  // 独立的 role:"tool" 消息，逐条映射会产生连续的 role:"user" message，违反 Anthropic 的
  // user/assistant 严格交替规则 → 400 "text content blocks must be non-empty"。这里把同一轮的
  // 所有 tool_result 合并进一个 user message 的 content 数组；只合并前后都是纯 tool_result 的
  // 相邻项，不触碰普通文本 user message 与 assistant message。
  const isToolResultUser = (entry: (typeof items)[number]) =>
    entry.role === "user" &&
    Array.isArray(entry.content) &&
    entry.content.length > 0 &&
    entry.content.every((block: JsonValue) => isRecord(block) && block.type === "tool_result");
  const mergedItems: typeof items = [];
  for (const item of items) {
    const prevIdx = mergedItems.length - 1;
    const prev = prevIdx >= 0 ? mergedItems[prevIdx] : undefined;
    if (isToolResultUser(item) && prev !== undefined && isToolResultUser(prev)) {
      prev.content = [...prev.content, ...item.content];
    } else {
      mergedItems.push(item);
    }
  }

  if (providerItem.promptCaching !== true) return mergedItems;

  const realUserIndices = mergedItems
    .map((item, index) => {
      const content = Array.isArray(item.content) ? item.content : [];
      const hasOnlyToolResults = content.length > 0 && content.every((block: JsonValue) => isRecord(block) && block.type === "tool_result");
      return item.role === "user" && !hasOnlyToolResults ? index : -1;
    })
    .filter((index) => index >= 0);
  const targetIndex = realUserIndices.length >= 2 ? realUserIndices[realUserIndices.length - 2] : -1;
  if (targetIndex < 0) return mergedItems;
  return mergedItems.map((item, index) =>
    index === targetIndex
      ? { ...item, content: withClaudeCacheOnLastBlock(item.content, providerItem) }
      : item,
  );
}


export function claudeToolsFromOpenAiTools(tools: any[], providerItem: Provider) {
  return tools
    .map((tool, index) => {
      const fn = tool?.function ?? {};
      const name = String(fn.name ?? "");
      if (!name) return null;
      return {
        name,
        description: String(fn.description ?? ""),
        input_schema: isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
        ...(providerItem.promptCaching === true && index === tools.length - 1
          ? { cache_control: claudeCacheControlEphemeral(providerItem) }
          : {}),
      };
    })
    .filter(Boolean);
}

// 递归剔除 Google Gemini 不支持的 JSON Schema 关键字。镜像安卓
// me/rerere/ai/util/Request.kt 的 removeElements + GoogleProvider 中对
// functionDeclarations.parameters 的清理（const/format/additionalProperties/enum 等）。

export const GOOGLE_SCHEMA_STRIP_KEYS = new Set([
  "const",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "additionalProperties",
  "enum",
]);


export function googleStripSchemaKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => googleStripSchemaKeys(item));
  if (isRecord(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [key, val] of Object.entries(value)) {
      if (GOOGLE_SCHEMA_STRIP_KEYS.has(key)) continue;
      out[key] = googleStripSchemaKeys(val as JsonValue);
    }
    return out;
  }
  return value;
}

// 把 OpenAI 格式的 function tools 转成 Gemini functionDeclarations，镜像安卓
// GoogleProvider.buildCompletionRequestBody:418-445。

export function googleFunctionDeclarations(tools: any[]) {
  return tools
    .map((tool) => {
      const fn = tool?.function ?? {};
      const name = String(fn.name ?? "");
      if (!name) return null;
      return {
        name,
        description: String(fn.description ?? ""),
        parameters: googleStripSchemaKeys(isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} }),
      };
    })
    .filter(Boolean);
}

// 把单条 OpenAI 格式 content 转成 Gemini parts（text / inlineData）。

export function googlePartsFromApiContent(content: any): Record<string, JsonValue>[] {
  if (typeof content === "string") {
    return content ? [{ text: content }] : [];
  }
  if (!Array.isArray(content)) {
    const text = String(content ?? "");
    return text ? [{ text }] : [];
  }
  const parts: Record<string, JsonValue>[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item.type === "text") {
      const text = String(item.text ?? "");
      if (text) parts.push({ text });
    } else if (item.type === "image_url") {
      const dataUrl = String((item.image_url as any)?.url ?? "");
      const parsed = parseDataUrl(dataUrl);
      if (parsed) {
        parts.push({ inlineData: { mimeType: parsed.mime, data: parsed.data } });
      } else if (dataUrl) {
        parts.push({ text: `[Image: ${dataUrl}]` });
      }
    }
  }
  return parts;
}

// 把 OpenAI 格式的 messagesForApi 转成 Gemini contents。镜像安卓
// GoogleProvider.buildContents/addModelMessage/addUserMessage：
// - system 消息单独抽出，不进 contents
// - assistant 的 tool_calls → functionCall part
// - role:"tool" 结果 → functionResponse part（Gemini 中以 user role 发送）

export function googleContentsFromApiMessages(messages: ApiMessage[]): Record<string, JsonValue>[] {
  const contents: Record<string, JsonValue>[] = [];
  for (const item of messages) {
    if (item.role === "system") continue;
    if (item.role === "tool") {
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            name: String((item as any).name ?? ""),
            response: { result: apiContentText(item.content) },
          },
        }],
      });
      continue;
    }
    if (item.role === "assistant") {
      const parts = googlePartsFromApiContent(item.content);
      const toolCalls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
      for (const call of toolCalls) {
        const fn = (call as any)?.function ?? {};
        const name = String(fn.name ?? "");
        if (!name) continue;
        parts.push({ functionCall: { name, args: parseToolInput(fn.arguments) } });
      }
      if (parts.length) contents.push({ role: "model", parts });
      continue;
    }
    const parts = googlePartsFromApiContent(item.content);
    if (parts.length) contents.push({ role: "user", parts });
  }
  return contents;
}

// 构建 Gemini 的 generationConfig（含 thinkingConfig）。镜像安卓
// GoogleProvider.buildCompletionRequestBody:366-409。

export function googleGenerationConfig(modelItem: Model, assistant: Assistant) {
  const config: Record<string, JsonValue> = {};
  if (assistant.temperature != null) config.temperature = assistant.temperature;
  if (assistant.topP != null) config.topP = assistant.topP;
  if (assistant.maxTokens != null) config.maxOutputTokens = assistant.maxTokens;
  if (supportsOutputModality(modelItem, "IMAGE")) {
    config.responseModalities = ["TEXT", "IMAGE"];
  }
  if (supportsAbility(modelItem, "REASONING")) {
    const normalized = reasoningLevelNormalized(assistant.reasoningLevel);
    const isGemini3 = /\bgemini[-._]?3\b/i.test(modelItem.modelId);
    const isGeminiPro = /2[.-]5.*pro/i.test(modelItem.modelId);
    const thinkingConfig: Record<string, JsonValue> = { includeThoughts: true };
    if (normalized === "off") {
      if (isGemini3) {
        // Gemini 3 思考不可关：off 取该型号的最少思考档（Pro 无 minimal，表内收 low）。
        thinkingConfig.thinkingLevel = gemini3ThinkingLevelFor(modelItem.modelId, "minimal");
      } else if (!isGeminiPro) {
        thinkingConfig.thinkingBudget = 0;
        thinkingConfig.includeThoughts = false;
      }
    } else if (normalized !== "auto") {
      if (isGemini3) {
        thinkingConfig.thinkingLevel = gemini3ThinkingLevelFor(modelItem.modelId, normalized);
      } else {
        thinkingConfig.thinkingBudget = budgetTokensFor(normalized);
      }
    }
    config.thinkingConfig = thinkingConfig;
  }
  return config;
}


export const GOOGLE_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" },
];

// 构建 Gemini 的完整请求体。镜像安卓 GoogleProvider.buildCompletionRequestBody。

export function groupAssistantPartsByToolBoundary(parts: MessagePart[]): Array<
  { kind: "content"; parts: JsonValue[] } | { kind: "tools"; tools: JsonValue[] }
> {
  const groups: Array<{ kind: "content"; parts: JsonValue[] } | { kind: "tools"; tools: JsonValue[] }> = [];
  let pendingContent: JsonValue[] = [];
  let pendingTools: JsonValue[] = [];
  const flushContent = () => {
    if (pendingContent.length) {
      groups.push({ kind: "content", parts: pendingContent });
      pendingContent = [];
    }
  };
  const flushTools = () => {
    if (pendingTools.length) {
      groups.push({ kind: "tools", tools: pendingTools });
      pendingTools = [];
    }
  };
  for (const part of parts) {
    if (isRecord(part) && part.type === "tool") {
      flushContent();
      pendingTools.push(part);
    } else {
      flushTools();
      pendingContent.push(part);
    }
  }
  flushContent();
  flushTools();
  return groups;
}


export function appendAssistantApiMessages(items: ApiMessage[], message: Message, includeReasoning: boolean) {
  const groups = groupAssistantPartsByToolBoundary(message.parts);
  const contentBuffer: string[] = [];
  let reasoningBuffer = "";

  const flushAssistant = (tools: JsonValue[] = []) => {
    const content = contentBuffer.join("\n").trim();
    const reasoning = reasoningBuffer.trim();
    if (!content && !reasoning && tools.length === 0) return;
    const payload: ApiMessage = {
      role: "assistant",
      content,
    };
    if (includeReasoning && reasoning) payload.reasoning_content = reasoning;
    if (tools.length) {
      payload.tool_calls = tools.map((tool) => {
        const record = isRecord(tool) ? tool : {};
        return {
          id: String(record.toolCallId ?? id()),
          type: "function",
          function: {
            name: String(record.toolName ?? ""),
            arguments: toolArgumentsJson(record.input),
          },
        };
      });
    }
    items.push(payload);
    contentBuffer.length = 0;
    // 同一条 ASSISTANT 消息里 reasoning 只贴在它后面"第一组"
    // tool_calls 上（与安卓 addAssistantMessages 行为一致：reasoning
    // 在 Tools group 输出后不会被复用）。
    reasoningBuffer = "";
  };

  for (const group of groups) {
    if (group.kind === "content") {
      for (const part of group.parts) {
        if (!isRecord(part)) continue;
        if (part.type === "reasoning") {
          const reasoning = String(part.reasoning ?? "").trim();
          if (reasoning) reasoningBuffer += `${reasoningBuffer ? "\n" : ""}${reasoning}`;
          continue;
        }
        if (part.type === "text") {
          const text = String(part.text ?? "").trim();
          if (text) contentBuffer.push(text);
          continue;
        }
        if (part.type === "image" || part.type === "document" || part.type === "audio" || part.type === "video") {
          const url = String(part.url ?? "");
          const name = String(part.fileName ?? part.type);
          if (url) contentBuffer.push(`[${name}] ${url}`);
          continue;
        }
      }
      continue;
    }
    // Tools group：所有连续的 tool 调用合并到同一条 assistant 消息里，
    // 紧跟它们的 role:"tool" 结果消息。
    flushAssistant(group.tools);
    for (const part of group.tools) {
      if (!isRecord(part)) continue;
      items.push({
        role: "tool",
        name: String(part.toolName ?? ""),
        tool_call_id: String(part.toolCallId ?? ""),
        content: toolResultTextForApi(part),
        _rikkahub_tool_output_parts: Array.isArray(part.output) ? part.output : [],
      });
    }
  }
  flushAssistant();
}


// reasoningLevelNormalized 上提至 model-providers/request-dialect(方言单源,工作区引擎同用)。

// budgetTokensFor 上提至 model-providers/request-dialect(方言单源,工作区引擎同用)。

// DeepSeek 系列模型的特色是展示原始思维链。当 DeepSeek 走 Anthropic(Claude) 格式时，
// 用 display:"raw" 而非 "summarized"，让用户看到完整的思维链而非摘要。其它模型保持
// "summarized"。匹配 deepseek-r1 / deepseek-reasoner / deepseek-v4 等当前与未来命名。

export function isDeepSeekModel(modelItem: Model) {
  return /deepseek/i.test(String(modelItem.modelId ?? ""));
}

// 构建 Claude(Anthropic) 的 thinking + output_config 负载，主路径与辅助路径共用，
// 对齐安卓 ClaudeProvider.buildMessageRequest:308-331。

export function claudeThinkingPayload(modelItem: Model, level: string | null | undefined): Record<string, JsonValue> {
  if (!supportsAbility(modelItem, "REASONING")) return {};
  const normalized = reasoningLevelNormalized(level);
  if (normalized === "off") return { thinking: { type: "disabled" } };
  const display = isDeepSeekModel(modelItem) ? "raw" : "summarized";
  if (normalized === "auto") return { thinking: { type: "adaptive", display } };
  return { thinking: { type: "adaptive", display }, output_config: { effort: normalized } };
}


export function supportsAbility(modelItem: Model, ability: string) {
  return (modelItem.abilities ?? []).map((item) => String(item).toUpperCase()).includes(ability.toUpperCase());
}


export function supportsInputModality(modelItem: Model, modality: string) {
  return (modelItem.inputModalities ?? []).map((item) => String(item).toUpperCase()).includes(modality.toUpperCase());
}


export function supportsOutputModality(modelItem: Model, modality: string) {
  return (modelItem.outputModalities ?? []).map((item) => String(item).toUpperCase()).includes(modality.toUpperCase());
}


export function hasBuiltInTool(modelItem: Model, toolType: string) {
  return (Array.isArray(modelItem.tools) ? modelItem.tools : []).some((tool) => {
    if (typeof tool === "string") return tool.toLowerCase() === toolType.toLowerCase();
    if (tool && typeof tool === "object" && !Array.isArray(tool)) return String(tool.type ?? "").toLowerCase() === toolType.toLowerCase();
    return false;
  });
}


/** 防双搜唯一裁决(对齐安卓 ChatToolFactory.kt:21 shouldUseExternalWebSearch):
 *  全局外挂搜索开关开 **且** 模型未声明内置 search 时,才允许注入外挂 search_web。
 *  模型自带内置搜索(Google googleSearch / OpenAI Responses web_search)时,外挂必须
 *  让位——否则同一轮模型手里同时攥着"服务端内置搜索"和"外挂 search_web"两套,可能
 *  重复调用、结果打架。Google 路在 conversation-encoding 已天然互斥(内置优先整组
 *  functionDeclarations 不发);本谓词补的是 OpenAI Responses 路(orchestrator 把
 *  functionTools 与 responseApiBuiltInTools 并列发出)与一切未来引擎。
 *
 *  单源纪律:外挂 search_web 的唯一注入源 openAiSearchTools(tools/bound)经本谓词门控,
 *  聊天引擎(conversationFunctionTools)与 pi 引擎(createPiGeneralTools)同口消费——
 *  未来新引擎只要从同一注入源取外挂搜索,天然继承本闸,无需各自复刻判定。 */
export function shouldUseExternalWebSearch(enableWebSearch: boolean, modelItem: Model | null | undefined) {
  return enableWebSearch && !(modelItem && hasBuiltInTool(modelItem, "search"));
}


export function responseApiBuiltInTools(modelItem: Model) {
  const tools: Record<string, JsonValue>[] = [];
  if (hasBuiltInTool(modelItem, "search")) tools.push({ type: "web_search" });
  if (hasBuiltInTool(modelItem, "image_generation")) tools.push({ type: "image_generation", model: "gpt-image-2" });
  return tools;
}


export function openAiChatCompletionsModalities(modelItem: Model, providerItem: Provider) {
  if (hostOfProvider(providerItem) === "openrouter.ai" && supportsOutputModality(modelItem, "IMAGE")) {
    return ["image", "text"];
  }
  return undefined;
}


export function responseProviderCapabilities(providerItem: Provider) {
  const host = hostOfProvider(providerItem);
  if (host === "ark.cn-beijing.volces.com") {
    return { supportsReasoningSummary: false, supportsEncryptedContent: false };
  }
  return { supportsReasoningSummary: true, supportsEncryptedContent: true };
}


export function responseApiReasoningForProvider(providerItem: Provider, modelItem: Model, level: string | null | undefined) {
  if (!supportsAbility(modelItem, "REASONING")) return undefined;
  const normalized = reasoningLevelNormalized(level);
  const capabilities = responseProviderCapabilities(providerItem);
  const payload: Record<string, JsonValue> = {};
  if (capabilities.supportsReasoningSummary) payload.summary = "auto";
  if (normalized !== "auto") {
    payload.effort = normalized === "off" ? "none" : normalized;
  }
  return payload;
}


export function responseApiIncludeForProvider(providerItem: Provider, modelItem: Model) {
  if (!supportsAbility(modelItem, "REASONING")) return undefined;
  return responseProviderCapabilities(providerItem).supportsEncryptedContent
    ? ["reasoning.encrypted_content"]
    : undefined;
}


export function apiContentText(content: unknown) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (isRecord(part)) return String(part.text ?? part.content ?? "");
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}


export function responseApiContentFromUiParts(parts: JsonValue[], role: string) {
  const content = documentPartsFirst(parts)
    .map((part) => {
      if (!isRecord(part)) return null;
      if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
        return {
          type: role === "assistant" ? "output_text" : "input_text",
          text: String(part.text ?? ""),
        };
      }
      if (part.type === "image") {
        return responseApiImagePart(part, role);
      }
      if (part.type === "image_url" || part.type === "input_image" || part.type === "output_image") {
        const rawImageUrl = isRecord(part.image_url) ? part.image_url.url : part.image_url;
        const url = String(rawImageUrl ?? part.url ?? "");
        return {
          type: role === "assistant" ? "output_image" : "input_image",
          image_url: url,
        };
      }
      if (part.type === "document") return responseApiDocumentPart(part);
      if (part.type === "audio" || part.type === "video") return responseApiTextPart(`[${part.type}: ${String(part.url ?? "")}]`, role);
      return null;
    })
    .filter(Boolean);
  const singlePart = content.length === 1 ? content[0] : undefined;
  if (isRecord(singlePart) && (singlePart.type === "input_text" || singlePart.type === "output_text") && "text" in singlePart) {
    return String(singlePart.text ?? "");
  }
  return content;
}


export function responseApiReasoningItem(part: Record<string, JsonValue>) {
  const reasoning = String(part.reasoning ?? "").trim();
  if (!reasoning) return null;
  const metadata = isRecord(part.metadata) ? part.metadata : {};
  const payload: Record<string, JsonValue> = {
    type: "reasoning",
    summary: [{ type: "summary_text", text: reasoning }],
  };
  const reasoningId = String(metadata.reasoning_id ?? "").trim();
  if (reasoningId) payload.id = reasoningId;
  const encryptedContent = String(metadata.encrypted_content ?? "").trim();
  if (encryptedContent) payload.encrypted_content = encryptedContent;
  return payload;
}


export function responseApiTextPart(text: string, role: string) {
  return { type: role === "assistant" ? "output_text" : "input_text", text };
}


export function responseApiImagePart(part: Record<string, JsonValue>, role: string, stripForOcr = false) {
  const metadata = isRecord(part.metadata) ? part.metadata : {};
  const ocrText = String(metadata.ocrText ?? "").trim();
  if (stripForOcr && ocrText) {
    return responseApiTextPart(`<image_file_ocr>\n${ocrText}\n</image_file_ocr>`, role);
  }
  const url = dataUrlForMessageUrl(String(part.url ?? ""));
  if (!url) return null;
  return {
    type: role === "assistant" ? "output_image" : "input_image",
    image_url: url,
  };
}


export function responseApiDocumentPart(part: Record<string, JsonValue>) {
  const fileName = String(part.fileName ?? "document");
  const url = String(part.url ?? "");
  const entry = fileEntryFromApiUrl(url);
  // 3-4:同上,只读缓存+后台补抽。
  const extractedText = entry ? readExtractedTextSync(entry).trim() : "";
  if (!extractedText && entry) ensureExtractedTextAsync(entry);
  return responseApiTextPart(
    extractedText ? documentPromptText(fileName, extractedText) : fallbackDocumentText({ fileName, url, entry: entry ?? null }),
    "user",
  );
}


export function responseApiImageGenerationItem(part: Record<string, JsonValue>) {
  const metadata = isRecord(part.metadata) ? part.metadata : {};
  const callId = String(metadata.openai_image_call_id ?? "").trim();
  if (!callId) return null;
  return { type: "image_generation_call", id: callId };
}


/** UI 消息 → Responses API input 项数组。includeReasoningItems 控制历史 reasoning
 *  项（{type:"reasoning", summary:[…]}）是否回传：OpenAI 私有形态，仅官方主机接受，
 *  第三方端点（火山等）解析不了直接 400——判定在调用方（conversationResponseApiInput）
 *  按主机方言 + provider 开关决定，本函数默认 true 跟随 OpenAI 官方语义。 */
export function responseApiMessagesFromUiMessages(messages: Message[], targetModel?: Model, includeReasoningItems = true) {
  const stripImageForOcr = targetModel ? !supportsInputModality(targetModel, "IMAGE") : false;
  const items: ApiMessage[] = [];
  for (const messageValue of messages) {
    if (messageValue.role === "SYSTEM") continue;
    if (messageValue.role === "ASSISTANT") {
      const contentBuffer: JsonValue[] = [];
      const flushContent = () => {
        const content = responseApiContentFromUiParts(contentBuffer, "assistant");
        const hasContent = typeof content === "string"
          ? content.trim().length > 0
          : Array.isArray(content) && content.length > 0;
        if (hasContent) items.push({ role: "assistant", content });
        contentBuffer.length = 0;
      };
      for (const part of messageValue.parts) {
        if (!isRecord(part)) continue;
        if (part.type === "reasoning") {
          flushContent();
          if (includeReasoningItems) {
            const reasoningItem = responseApiReasoningItem(part);
            if (reasoningItem) items.push(reasoningItem);
          }
          continue;
        }
        if (part.type === "image") {
          const imageCall = responseApiImageGenerationItem(part);
          if (imageCall) {
            flushContent();
            items.push(imageCall);
            continue;
          }
          contentBuffer.push(part);
          continue;
        }
        if (part.type === "text" || part.type === "document" || part.type === "audio" || part.type === "video") {
          if (part.type === "document") contentBuffer.push(responseApiDocumentPart(part));
          else if (part.type === "audio" || part.type === "video") contentBuffer.push(responseApiTextPart(`[${part.type}: ${String(part.url ?? "")}]`, "assistant"));
          else contentBuffer.push(part);
          continue;
        }
        if (part.type === "tool") {
          flushContent();
          items.push({
            type: "function_call",
            call_id: String(part.toolCallId ?? ""),
            name: String(part.toolName ?? ""),
            arguments: toolArgumentsJson(part.input),
          });
          items.push({
            type: "function_call_output",
            call_id: String(part.toolCallId ?? ""),
            output: toolResultTextForApi(part),
          });
        }
      }
      flushContent();
      continue;
    }
    const role = messageValue.role === "TOOL" ? "tool" : "user";
    const contentParts = documentPartsFirst(messageValue.parts)
      .map((part) => {
        if (!isRecord(part)) return null;
        if (part.type === "text") return part;
        if (part.type === "image") return responseApiImagePart(part, role, stripImageForOcr);
        if (part.type === "document") return responseApiDocumentPart(part);
        if (part.type === "audio" || part.type === "video") return responseApiTextPart(`[${part.type}: ${String(part.url ?? "")}]`, role);
        return null;
      })
      .filter(Boolean) as JsonValue[];
    const content = responseApiContentFromUiParts(contentParts, role);
    const hasContent = typeof content === "string"
      ? content.trim().length > 0
      : Array.isArray(content) && content.length > 0;
    if (hasContent) items.push({ role, content });
  }
  return items;
}


export function isModelAllowTemperature(modelItem: Model) {
  // 薄壳:锁定事实单源在 request-dialect.isSamplingLockedModel(o 系/精确 gpt-5/
  // Kimi K2.5+,依据见彼处);orchestrator 主对话与 auxiliary 的 temperature/top_p
  // 都经本函数,未来引擎接采样设置时直接消费方言谓词。
  return !isSamplingLockedModel(modelItem.modelId);
}


export function hostOfProvider(providerItem: Provider) {
  try {
    return new URL(providerItem.baseUrl).hostname;
  } catch {
    return "";
  }
}


export function reasoningPayloadForProvider(providerItem: Provider, modelItem: Model, level: string | null | undefined) {
  if (!supportsAbility(modelItem, "REASONING")) return {};
  const normalized = reasoningLevelNormalized(level);
  const enabled = normalized !== "off";
  const host = hostOfProvider(providerItem);
  if (host === "api.mistral.ai") return {}; // Mistral 不支持 reasoning params
  if (host === "openrouter.ai") {
    if (normalized === "off") return { reasoning: { effort: "none" } };
    if (normalized === "auto") return { reasoning: { enabled: true } };
    return { reasoning: { effort: normalized } };
  }
  if (host === "dashscope.aliyuncs.com") {
    const result: Record<string, any> = { enable_thinking: enabled };
    // 百炼官方:thinking_budget 适用 Qwen3 系与直供 GLM/Kimi,唯 kimi-k3 不支持该参数。
    if (normalized !== "auto" && !isKimiK3Model(modelItem.modelId)) result.thinking_budget = budgetTokensFor(normalized);
    return result;
  }
  if (host === "api.siliconflow.cn") {
    // 白名单单源在 request-dialect(工作区引擎经 model-bridge 消费同一份名单)。
    // V4 系/GLM-5.2 托管版另支持 reasoning_effort(服务端自行收拢 low/medium→high、
    // xhigh→max),原样透传与 enable_thinking 并发。
    if (!SILICONFLOW_THINKING_MODELS.has(modelItem.modelId)) return {};
    const sfEffort = enabled && normalized !== "auto" && isSiliconFlowEffortModel(modelItem.modelId) ? normalized : undefined;
    return { enable_thinking: enabled, ...(sfEffort ? { reasoning_effort: sfEffort } : {}) };
  }
  if (host === "api.moonshot.cn") {
    // Kimi 逐代 thinking 语义(官方"思考模型"文档;安卓仅覆盖到 K2.6 #1586,K3 为 PC 先行。
    // 代际判定与 K3 档位收拢表单源在 request-dialect,pi 引擎消费同一张表):
    // - K3:始终思考+保留式思考常开,thinking 参数已移除(官方明示"不应传入",对照
    //   K2.7-code 传 disabled 直接 400);推理强度改用顶层 reasoning_effort,仅
    //   low/high/max 三档(默认 max)。off 无法关思考,映射 low(官方 FAQ:嫌思考久
    //   就调 low);auto 不发字段,用服务端默认。
    // - K2.7-code:始终思考,传 {type:"disabled"} 报错;省略 thinking 即 keep:"all"
    //   语义,故一律不发。
    // - K2.6:thinking{type} 可开关;开启时需显式 keep:"all" 才保留历史思考(#1586)。
    // - 其余(K2.5/kimi-latest 等):维持 thinking{type} 开关,与安卓一致。
    if (isKimiK3Model(modelItem.modelId)) {
      if (normalized === "auto") return {};
      if (!enabled) return { reasoning_effort: "low" };
      return { reasoning_effort: effortLowHighMaxFor(normalized) ?? "high" };
    }
    if (isKimiK27Model(modelItem.modelId)) return {};
    const thinking: Record<string, any> = { type: enabled ? "enabled" : "disabled" };
    if (enabled && isKimiK26Model(modelItem.modelId)) thinking.keep = "all";
    return { thinking };
  }
  if (["ark.cn-beijing.volces.com", "open.bigmodel.cn", "api.deepseek.com"].includes(host)) {
    // thinking:{type} 生态的 effort 增强(模型级方言,2026-09 各厂官方口径,pi 引擎经
    // thinkingLevelMap 消费同源表,两引擎口径恒同):
    // - DeepSeek 官方:v4 收拢表(xhigh→high,与 K3 表口径不同,勿混用);
    // - 智谱 GLM-5.2+:5.3 系查窄表(服务端仅收 max/high/low,其余 400),5.2 原样透传
    //   (服务端收全七档自行收拢);5.1 及以下不发 effort;
    // - 火山方舟 Doubao Seed 2.x:查 seed2 表(仅收 minimal/low/medium/high);老系不发。
    let effort: string | undefined;
    if (enabled && normalized !== "auto") {
      if (host === "api.deepseek.com") {
        effort = deepseekEffortFor(normalized);
      } else if (host === "open.bigmodel.cn" && isZhipuEffortModel(modelItem.modelId)) {
        effort = isZhipuGlm53Model(modelItem.modelId)
          ? (ZHIPU_GLM53_EFFORT_BY_LEVEL as Record<string, string>)[normalized]
          : normalized;
      } else if (host === "ark.cn-beijing.volces.com" && isArkSeed2Model(modelItem.modelId)) {
        effort = (ARK_SEED2_EFFORT_BY_LEVEL as Record<string, string>)[normalized];
      }
    }
    // 智谱强制思考型号(GLM-5.3 系/4.7/4.5V):思考不可关,off 档发 disabled 直接 400——
    // 省略 thinking 字段走模型默认(恒思考),与 K3"off 不可达"同语义。
    if (host === "open.bigmodel.cn" && isZhipuForcedThinkingModel(modelItem.modelId) && !enabled) return {};
    return { thinking: { type: enabled ? "enabled" : "disabled" }, ...(effort ? { reasoning_effort: effort } : {}) };
  }
  if (host === "integrate.api.nvidia.com") {
    if (normalized === "auto") return {};
    if (modelItem.modelId.toLowerCase().includes("deepseek-v4")) {
      // 对齐 Android ChatCompletionsAPI:384-390——xhigh/max 都升 "max",其余非 off 归 "high"。
      if (normalized === "xhigh" || normalized === "max") return { reasoning_effort: "max" };
      if (normalized === "off") return { reasoning_effort: "none" };
      return { reasoning_effort: "high" };
    }
    // Non-deepseek NVIDIA: maps "none" → "low", passes everything else through (Android: level.effort)
    if (normalized === "off") return { reasoning_effort: "low" };
    return { reasoning_effort: normalized };
  }
  if (host === "chat.intern-ai.org.cn") return { thinking_mode: enabled };
  // 小米 MiMo 官方(api.xiaomimimo.com 及 token-plan-cn 子域):思考开关走 thinking:{type},
  // 无 effort/keep(对齐安卓 ChatCompletionsAPI L354-360);此前缺分支会落兜底 reasoning_effort,
  // 端点不识该字段。pi 引擎经 openAiThinkingSwitchProtocol 同判 thinking-type-object。
  if (isMiMoOfficialHost(host)) return { thinking: { type: enabled ? "enabled" : "disabled" } };
  // issue10:Gemini 经 OpenAI 兼容层(官方 /openai 端点及各类中转网关)时,思维链必须用
  // extra_body.google.thinking_config 显式请求 include_thoughts,否则模型即使思考也不回传
  // 思维内容(对齐 Cherry Studio;安卓端此场景同样缺失,属 PC 端补强)。字段区分与原生
  // 路径 googleGenerationConfig 一致:Gemini 3 用 thinking_level,2.5 系用 thinking_budget。
  if (/\bgemini[-._]?\d/i.test(modelItem.modelId)) {
    const isGemini3 = /\bgemini[-._]?3\b/i.test(modelItem.modelId);
    const isGeminiPro = /2[.-]5.*pro/i.test(modelItem.modelId);
    const thinkingConfig: Record<string, any> = { include_thoughts: true };
    if (normalized === "off") {
      if (isGemini3) {
        // 同原生路径：off 取该型号最少思考档（档位表单源 request-dialect）。
        thinkingConfig.thinking_level = gemini3ThinkingLevelFor(modelItem.modelId, "minimal");
      } else if (!isGeminiPro) {
        thinkingConfig.thinking_budget = 0;
        thinkingConfig.include_thoughts = false;
      }
    } else if (normalized !== "auto") {
      if (isGemini3) {
        thinkingConfig.thinking_level = gemini3ThinkingLevelFor(modelItem.modelId, normalized);
      } else {
        thinkingConfig.thinking_budget = budgetTokensFor(normalized);
      }
    }
    return { extra_body: { google: { thinking_config: thinkingConfig } } };
  }
  // Android default else branch: passes effort through as-is (including "xhigh").
  // OFF maps to "low" (lowest budget), AUTO sends no field.
  if (normalized === "auto") return {};
  if (normalized === "off") return { reasoning_effort: "low" };
  // K3 经透传型中转(未知 host)同样只认 low/high/max——档位收拢与 moonshot 官方
  // 分支、pi 引擎共用 request-dialect 同一张表;网关型 host(OpenRouter/DashScope
  // 等)有自己的方言翻译,已在上方各自分支返回,不经此兜底。
  if (isKimiK3Model(modelItem.modelId)) return { reasoning_effort: effortLowHighMaxFor(normalized) ?? "high" };
  return { reasoning_effort: normalized };
}


export function auxiliaryReasoningPayloadForProvider(providerItem: Provider, modelItem: Model, level: string | null | undefined) {
  if (!level || !supportsAbility(modelItem, "REASONING")) return {};
  return reasoningPayloadForProvider(providerItem, modelItem, level);
}


