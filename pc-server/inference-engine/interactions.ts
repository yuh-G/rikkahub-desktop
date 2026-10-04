// inference-engine/interactions.ts — Gemini Interactions API(POST /interactions)
//
// 与 generateContent 平行的 Google 第二协议面,镜像安卓 InteractionsAPI.kt +
// InteractionsStreamDecoder.kt(2cd62ad2)。官方 2026-06 GA;供应商级开关默认关
// (Provider.useInteractionsApi),仅 google 型走这里。
//
// 与 generateContent 路的关键差异(官方 OpenAPI spec 2026-10-05 直抓取证):
//   - 无 contents/safetySettings:消息是 input step 数组(无状态 store=false,
//     每轮回传完整 step 列表);safety_settings 会被拒收,不发。
//   - 采样/思考进 generation_config:{temperature,top_p,max_output_tokens,
//     thinking_level(minimal/low/medium/high),thinking_summaries:"auto"}。
//   - tools 是扁平数组:函数 {type:"function",name,description,parameters} 与
//     内置 {type:"google_search"}/{type:"url_context"} 混放。
//   - thought/function_call 带加密 signature——多轮回传必须原样携带(丢签名
//     服务端拒续轮或思考质量劣化)。签名经 part metadata(interactions_signature,
//     与安卓 GoogleInteractionsMetadata 同 key)跨对话轮存活。
//
// 流式事件:interaction.created → step.start/step.delta(s)/step.stop * →
// interaction.completed(usage)/error。delta 类型按 step 聚合:text(累积)、
// image(整张)、thought_summary(ReasoningDelta)、thought_signature(step 尾)、
// arguments_delta(累积)、服务端工具 call/result(delta 与 step 同名)。
// 未知事件/未知 delta 官方要求"log and skip"——容错跳过,不抛错。

import type { Assistant, JsonValue, Message, Model, Provider, ApiMessage } from "../foundation/types";
import { id, isRecord } from "../foundation/utils";
import { initialApprovalState } from "../tools/approval";
import { toolResultTextForApi } from "../tools/format";
import { appendReasoningDelta, finishReasoningParts } from "./parts";
import type { StreamHooksWithSink } from "./events";
import {
  apiContentText,
  googleFunctionDeclarations,
  hasBuiltInTool,
  parseDataUrl,
  supportsAbility,
  supportsOutputModality,
} from "./message-builder";
import { isThinkingLevelGeminiModel, reasoningLevelNormalized } from "../model-providers/request-dialect";
import { readWithIdleTimeout } from "../foundation/net";
import { STREAM_IDLE_TIMEOUT_MS, runStreamingToolLoop, type ProviderRoundAdapter } from "./tool-loop";
import { textBody } from "../model-providers";
import { groupAssistantPartsByToolBoundary } from "./message-builder";

export interface InteractionsStreamRoundResult {
  textOut: string;
  thinkingOut: string;
  functionCalls: Array<{ id: string; name: string; args: Record<string, JsonValue>; signature?: string }>;
  /** 回放载荷:本轮产出的 step 数组原样追加进下一轮 input(无状态回传)。 */
  replaySteps: Array<Record<string, JsonValue>>;
  usage: Message["usage"] | undefined;
  raw: string;
}

// ── 请求体构造 ─────────────────────────────────────────────────────────────

/** 单条 content 元素:text / image(base64 或 uri)。镜像安卓 buildContentElement。 */
function interactionsContentElement(item: Record<string, JsonValue> | undefined): Record<string, JsonValue> | null {
  if (!item) return null;
  if (item.type === "text") {
    const text = String(item.text ?? "");
    return text ? { type: "text", text } : null;
  }
  if (item.type === "image_url") {
    const dataUrl = String((item.image_url as any)?.url ?? "");
    const parsed = parseDataUrl(dataUrl);
    if (parsed) return { type: "image", mime_type: parsed.mime, data: parsed.data };
    if (dataUrl) return { type: "image", uri: dataUrl };
    return null;
  }
  return null;
}

/** Interactions 的 thinking_level 值域是 minimal/low/medium/high(spec 枚举),
 *  无 xhigh/max——比 generateContent 窄。档位收拢同 pi getThinkingLevel 口径:
 *  xhigh/max→high;off:Gemini 3/4 系思考不可关取 minimal,2.5 系取 low(镜像安卓)。 */
export function interactionsThinkingLevelFor(modelId: string, level: string): string {
  if (level === "off") return isThinkingLevelGeminiModel(modelId) ? "minimal" : "low";
  if (level === "minimal") return "minimal";
  if (level === "low") return "low";
  if (level === "medium") return "medium";
  return "high";
}

/** messagesForApi → Interactions input steps(首问编码;历史轮走 interactionsStepsFromParts)。 */
export function interactionsInputFromApiMessages(messages: ApiMessage[]): Array<Record<string, JsonValue>> {
  const steps: Array<Record<string, JsonValue>> = [];
  for (const item of messages) {
    if (item.role === "system") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    const elements = (content as Array<Record<string, JsonValue>>)
      .map((part) => interactionsContentElement(part))
      .filter(Boolean) as Array<Record<string, JsonValue>>;
    if (item.role === "user" || item.role === "tool") {
      if (elements.length) steps.push({ type: "user_input", content: elements });
      continue;
    }
    // assistant:文本进 model_output;tool_calls 进 function_call steps(无签名——
    // 历史里没有 step 上下文,与安卓"签名缺失的思考直接丢弃"同语义)。
    if (elements.length) steps.push({ type: "model_output", content: elements });
    const toolCalls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
    for (const call of toolCalls) {
      const fn = (call as any)?.function ?? {};
      const name = String(fn.name ?? "");
      if (!name) continue;
      let args: Record<string, JsonValue> = {};
      if (typeof fn.arguments === "string" && fn.arguments) {
        try {
          const parsed = JSON.parse(fn.arguments);
          if (isRecord(parsed)) args = parsed as Record<string, JsonValue>;
        } catch {
          // 不规范参数串:发空对象,与 parseToolInput 同容错。
        }
      } else if (isRecord(fn.arguments)) {
        args = fn.arguments as Record<string, JsonValue>;
      }
      steps.push({ type: "function_call", id: String((call as any).id ?? id()), name, arguments: args });
    }
  }
  return steps;
}

/** 落库 parts → input steps(历史轮重建:签名从 metadata 读回,镜像安卓 buildInput
 *  的 groupPartsByToolBoundary 分组)。这是 Interactions 无状态多轮的权威编码:
 *  同一对话切换 generateContent ⇄ Interactions 后历史里的两种签名 key 互不误读。 */
export function interactionsStepsFromParts(messageParts: Array<Record<string, unknown>>): Array<Record<string, JsonValue>> {
  const steps: Array<Record<string, JsonValue>> = [];
  for (const group of groupAssistantPartsByToolBoundary(messageParts as never)) {
    if (group.kind === "content") {
      const elements: Array<Record<string, JsonValue>> = [];
      let reasoning = "";
      let reasoningSignature: string | undefined;
      for (const part of group.parts) {
        if (!isRecord(part)) continue;
        if (part.type === "text") {
          const text = String(part.text ?? "");
          if (text) elements.push({ type: "text", text });
          continue;
        }
        if (part.type === "reasoning") {
          const text = String(part.reasoning ?? "").trim();
          if (text) reasoning += `${reasoning ? "\n" : ""}${text}`;
          const sig = isRecord(part.metadata) ? part.metadata.interactions_signature : undefined;
          if (typeof sig === "string" && sig) reasoningSignature = sig;
          continue;
        }
        // 历史图片:整张回传 uri。
        if (part.type === "image") {
          const url = String(part.url ?? "");
          if (url) elements.push({ type: "image", ...(url.startsWith("data:") ? dataUrlToInline(url) : { uri: url }) });
          continue;
        }
      }
      // thought step:签名缺失(非 Interactions 来源的思考)不回传——服务端只认自己
      // 签发过的思考(安卓同语义);model_output 元素非空才发。
      if (reasoning && reasoningSignature) {
        steps.push({ type: "thought", signature: reasoningSignature, summary: [{ type: "text", text: reasoning }] });
      }
      if (elements.length) steps.push({ type: "model_output", content: elements });
      continue;
    }
    // tools group:并发调用先全部 function_call(签名从卡 metadata 读回),再对应
    // function_result(与安卓"先全部 call、再全部 result"的顺序对齐)。
    const calls: Array<Record<string, JsonValue>> = [];
    const results: Array<Record<string, JsonValue>> = [];
    for (const tool of group.tools) {
      if (!isRecord(tool)) continue;
      const callId = String(tool.toolCallId ?? id());
      const name = String(tool.toolName ?? "");
      if (!name) continue;
      let args: Record<string, JsonValue> = {};
      if (typeof tool.input === "string" && tool.input) {
        try {
          const parsed = JSON.parse(tool.input);
          if (isRecord(parsed)) args = parsed as Record<string, JsonValue>;
        } catch {
          // 空/坏参数串:发空对象。
        }
      }
      const sig = isRecord(tool.metadata) ? tool.metadata.interactions_signature : undefined;
      calls.push({
        type: "function_call",
        id: callId,
        name,
        arguments: args,
        ...(typeof sig === "string" && sig ? { signature: sig } : {}),
      });
      // result 必须非空:空输出给占位文本(空串 step 被拒)。
      const resultText = toolResultTextForApi(tool as never) || " ";
      results.push({ type: "function_result", call_id: callId, name, result: [{ type: "text", text: resultText }] });
    }
    steps.push(...calls, ...results);
  }
  return steps;
}

function dataUrlToInline(url: string): Record<string, JsonValue> {
  const parsed = parseDataUrl(url);
  if (!parsed) return { uri: url };
  return { mime_type: parsed.mime, data: parsed.data };
}

/** Interactions 完整请求体。镜像安卓 InteractionsAPI.buildRequestBody。
 *  与 generateContent 路(buildGoogleRequestBody)的关键差异:历史 assistant 轮经
 *  interactionsStepsFromParts 从落库 parts 重建(签名保真——messagesForApi 的
 *  chat-completions 形态不带签名);本轮之后的会话内回放走 replaySteps(encodeNextTurn)。 */
export function buildInteractionsRequestBody(
  messagesForApi: ApiMessage[],
  historyAssistantParts: Array<Record<string, unknown>>[],
  modelItem: Model,
  assistant: Assistant,
  functionTools: any[],
): Record<string, JsonValue> {
  const systemContent = messagesForApi.find((item) => item.role === "system")?.content;
  const hasImageOutput = supportsOutputModality(modelItem, "IMAGE");

  // input:历史 assistant 轮按工具边界重建(thought/function_call 带签名回传),
  // 其余轮(user/system 之外)沿用 messagesForApi 的通用编码。
  const input: Array<Record<string, JsonValue>> = [];
  let historyIndex = 0;
  for (const item of messagesForApi) {
    if (item.role === "assistant") {
      input.push(...interactionsStepsFromParts(historyAssistantParts[historyIndex] ?? []));
      historyIndex += 1;
      continue;
    }
    const elements = contentElementsFromApiItem(item);
    if (elements) input.push(elements);
  }

  const config: Record<string, JsonValue> = {};
  if (assistant.temperature != null) config.temperature = assistant.temperature;
  if (assistant.topP != null) config.top_p = assistant.topP;
  if (assistant.maxTokens != null) config.max_output_tokens = assistant.maxTokens;
  if (supportsAbility(modelItem, "REASONING")) {
    config.thinking_summaries = "auto";
    const normalized = reasoningLevelNormalized(assistant.reasoningLevel);
    if (normalized !== "auto") config.thinking_level = interactionsThinkingLevelFor(modelItem.modelId, normalized);
  }

  // tools 扁平数组:内置优先(google_search/url_context),否则函数工具(与 generateContent
  // 路的互斥语义一致);函数 schema 经 googleStripSchemaKeys 同一份 OpenAPI 子集净化。
  const tools: Array<Record<string, JsonValue>> = [];
  if (hasBuiltInTool(modelItem, "search")) {
    tools.push({ type: "google_search" });
  } else if (hasBuiltInTool(modelItem, "url_context") || hasBuiltInTool(modelItem, "urlContext")) {
    tools.push({ type: "url_context" });
  } else {
    for (const declaration of googleFunctionDeclarations(functionTools)) {
      if (!declaration) continue;
      tools.push({ type: "function", name: declaration.name, description: declaration.description, parameters: declaration.parameters });
    }
  }

  return {
    ...(systemContent && !hasImageOutput ? { system_instruction: apiContentText(systemContent) } : {}),
    input,
    store: false as JsonValue,
    ...(Object.keys(config).length ? { generation_config: config } : {}),
    ...(tools.length ? { tools } : {}),
    ...(hasImageOutput ? { response_format: [{ type: "text" }, { type: "image" }] } : {}),
  };
}

/** 单条非 assistant 消息 → user_input step(或 null 跳过)。 */
function contentElementsFromApiItem(item: ApiMessage): Record<string, JsonValue> | null {
  const content = Array.isArray(item.content) ? item.content : [];
  const elements = (content as Array<Record<string, JsonValue>>)
    .map((part) => interactionsContentElement(part))
    .filter(Boolean) as Array<Record<string, JsonValue>>;
  return elements.length ? { type: "user_input", content: elements } : null;
}

// ── SSE 解码 ───────────────────────────────────────────────────────────────

interface StepState {
  index: number;
  type: string;
  signature?: string;
  argsBuffer: string;
  hasArgsDelta: boolean;
  initialArgs?: Record<string, JsonValue>;
  /** function_call 专属(step.start 提供)。 */
  callId?: string;
  name?: string;
}

/** usage:completionTokens = total_output_tokens + total_thought_tokens(镜像安卓
 *  parseInteractionsUsage 的口径——思考 token 在统计行当生成 token 计)。 */
export function interactionsUsageFromMeta(meta: any): Message["usage"] | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  return {
    promptTokens: Number(meta.total_input_tokens ?? 0),
    completionTokens: Number(meta.total_output_tokens ?? 0) + Number(meta.total_thought_tokens ?? 0),
    totalTokens: Number(meta.total_tokens ?? 0),
    cachedTokens: Number(meta.total_cached_tokens ?? 0),
  };
}

/**
 * 逐 SSE 事件驱动解码器。聚合策略与 readGoogleStreamingRound 的共用解析一致:
 * text/thinking/image/functionCall 分别落 textOut/thinkingOut/modelParts/functionCalls,
 * 实时增量经 sink 下沉。服务端工具(google_search/url_context)的 call/result step
 * 只做计数展示的占位——PC 消息层无 server_tool part(安卓有),本轮以结果摘要文本
 * 附到正文(与 google 原生路 grounding 的降级口径一致:不让搜索工具卡空转)。
 */
export function makeInteractionsDecoder(result: InteractionsStreamRoundResult, hooks: StreamHooksWithSink, assistant: Assistant) {
  const steps = new Map<number, StepState>();
  let sawInteractionEnd = false;

  const stateFor = (index: number, type?: string, raw?: Record<string, JsonValue>): StepState => {
    let state = steps.get(index);
    if (!state) {
      state = { index, type: type ?? "model_output", argsBuffer: "", hasArgsDelta: false };
      steps.set(index, state);
    } else if (type) {
      state.type = type;
    }
    if (raw) {
      const sig = raw.signature;
      if (typeof sig === "string" && sig) state.signature = sig;
      if (isRecord(raw.arguments) && !state.hasArgsDelta) state.initialArgs = raw.arguments as Record<string, JsonValue>;
    }
    return state;
  };

  const closeFunctionCall = (state: StepState) => {
    // 参数:增量累积优先(官方语义"must be accumulated"),无增量时用 step.start 的
    // 整体 arguments(非流式返回形态)。
    let args: Record<string, JsonValue> = state.initialArgs ?? {};
    if (state.hasArgsDelta && state.argsBuffer) {
      try {
        const parsed = JSON.parse(state.argsBuffer);
        if (isRecord(parsed)) args = parsed as Record<string, JsonValue>;
      } catch {
        // 残缺参数串:发空对象,让工具端报参数错而不是发坏 JSON。
      }
    }
    const callId = state.callId ?? id();
    const name = state.name ?? "";
    if (!name) return;
    const signature = state.signature;
    result.functionCalls.push({ id: callId, name, args, ...(signature ? { signature } : {}) });
    // 回放 step(下一轮 input 原样回传;签名是续轮的硬要求)。
    result.replaySteps.push({
      type: "function_call",
      id: callId,
      name,
      arguments: args,
      ...(signature ? { signature } : {}),
    });
    if (hooks.message) {
      finishReasoningParts(hooks.message);
      hooks.sink?.({
        kind: "tool_call_created",
        toolCallId: callId,
        toolName: name,
        input: JSON.stringify(args),
        approvalState: initialApprovalState(name, assistant, hooks.conversation, JSON.stringify(args)),
        ...(signature ? { metadata: { interactions_signature: signature } } : {}),
      });
    }
  };

  const handleEvent = (payload: any) => {
    const eventType = String(payload?.event_type ?? payload?.type ?? "");
    if (eventType === "interaction.created" || eventType === "interaction.completed") {
      sawInteractionEnd = eventType === "interaction.completed";
      const usage = payload?.interaction?.usage;
      if (usage) result.usage = interactionsUsageFromMeta(usage);
      return;
    }
    if (eventType === "error") {
      const message = payload?.error?.message ?? "Gemini Interactions stream error";
      throw new Error(`Gemini Interactions: ${String(message)}`);
    }
    if (eventType === "step.start") {
      const index = Number(payload?.index ?? 0);
      const step = isRecord(payload?.step) ? payload.step as Record<string, JsonValue> : {};
      const type = String(step.type ?? "");
      const state = stateFor(index, type || undefined, step);
      if (type === "function_call") {
        state.callId = String(step.id ?? "");
        state.name = String(step.name ?? "");
      }
      // thought/model_output 的文本可能整段出现在 step.start(非流式形态)。
      if (Array.isArray(step.content)) {
        for (const element of step.content) {
          if (!isRecord(element)) continue;
          if (element.type === "text" && typeof element.text === "string" && element.text) {
            if (type === "model_output") {
              result.textOut += element.text;
              hooks.sink?.({ kind: "text_delta", text: element.text });
            }
          }
        }
      }
      return;
    }
    if (eventType === "step.delta") {
      const index = Number(payload?.index ?? 0);
      const delta = isRecord(payload?.delta) ? payload.delta as Record<string, JsonValue> : {};
      const deltaType = String(delta.type ?? "");
      if (deltaType === "text") {
        stateFor(index, "model_output");
        const text = String(delta.text ?? "");
        if (text) {
          result.textOut += text;
          hooks.sink?.({ kind: "text_delta", text });
        }
        return;
      }
      if (deltaType === "thought_summary") {
        stateFor(index, "thought");
        const content = isRecord(delta.content) ? delta.content : {};
        const text = String(content.text ?? "");
        if (text) {
          result.thinkingOut += text;
          appendReasoningDelta(hooks, text);
        }
        return;
      }
      if (deltaType === "thought_signature") {
        const state = stateFor(index, "thought");
        const sig = String(delta.signature ?? "");
        if (sig) state.signature = sig;
        return;
      }
      if (deltaType === "arguments_delta") {
        const state = stateFor(index, "function_call");
        const chunk = String(delta.arguments ?? "");
        if (chunk) {
          state.hasArgsDelta = true;
          state.argsBuffer += chunk;
        }
        return;
      }
      if (deltaType === "image") {
        const data = String(delta.data ?? "");
        const mime = String(delta.mime_type ?? "image/png");
        if (data) hooks.sink?.({ kind: "image_delta", url: `data:${mime};base64,${data}` });
        return;
      }
      // 服务端工具 delta(google_search_call/url_context_call 及 result)与其他未知
      // delta:官方要求 graceful skip——不抛错,静默忽略(签名/结果不回传的代价见
      // 落库说明:服务端工具本轮以正文摘要呈现,不参与无状态回放)。
      return;
    }
    if (eventType === "step.stop") {
      const index = Number(payload?.index ?? 0);
      const state = steps.get(index);
      steps.delete(index);
      if (!state) return;
      if (state.type === "function_call") {
        closeFunctionCall(state);
        return;
      }
      if (state.type === "thought") {
        // thought step 收官:回放 step 带 signature(Gemini 3 续轮思考的硬要求)——
        // 签名缺失(非 Interactions 来源的思考,如切换协议前的历史)不回传,服务端只认
        // 自己签发过的思考;签名同步进 UI reasoning part 的 metadata(跨对话轮历史
        // 回放读它,thought 的文本摘要在 thinkingOut,回放 step 需带 summary)。
        if (state.signature) {
          const summary = result.thinkingOut.trim();
          result.replaySteps.push({
            type: "thought",
            signature: state.signature,
            ...(summary ? { summary: [{ type: "text", text: summary }] } : {}),
          });
          appendReasoningDelta(hooks, "", { interactions_signature: state.signature });
        }
        return;
      }
      return;
    }
    // status_update / done / 未知事件:skip(官方 streaming 文档要求)。
  };

  return {
    handleEvent,
    finish() {
      // 连接提前断开:关掉所有未 stop 的 step(function_call 保参数收口,thought 保签名)。
      for (const state of steps.values()) {
        if (state.type === "function_call") closeFunctionCall(state);
      }
      steps.clear();
      return sawInteractionEnd;
    },
  };
}

// ── 流式主循环(工具循环骨架的 Google-Interactions Adapter)────────────────

export async function streamInteractionsChatWithTools(
  baseUrl: string,
  headers: Record<string, string>,
  modelId: string,
  body: Record<string, any>,
  providerItem: Provider,
  assistant: Assistant,
  signal: AbortSignal | undefined,
  hooks: StreamHooksWithSink,
) {
  // body 由 orchestrator 用 buildInteractionsRequestBody 构造(含 tools 数组);本函数
  // 只管循环骨架接线。无状态回传:input 每轮追加 replaySteps + function_result steps。
  // store:false 是 Interactions 无状态模式的硬性声明(服务端默认存储,这里显式关掉),
  // 恒在骨架发出的请求体上。
  const url = `${baseUrl.replace(/\/+$/, "")}/interactions`;
  let input = Array.isArray(body.input) ? [...body.input] : [];

  const adapter: ProviderRoundAdapter = {
    providerItem,
    logUrl: url,
    logHeaders: headers,
    fetchRound: (requestBody, _round, sig, nonStream) => fetch(url, {
      method: "POST",
      headers: nonStream ? headers : { ...headers, Accept: "text/event-stream" },
      body: JSON.stringify(nonStream ? { ...requestBody, stream: false } : { ...requestBody, stream: true }),
      signal: sig,
    }),
    headerTimeoutMs: () => 600_000,
    makeNonStreamBody: (requestBody) => ({ ...requestBody, stream: false }),
    async readRound(response, sig, nonStream) {
      const result: InteractionsStreamRoundResult = { textOut: "", thinkingOut: "", functionCalls: [], replaySteps: [], usage: undefined, raw: "" };
      const decoder = makeInteractionsDecoder(result, hooks, assistant);
      if (nonStream) {
        const rawText = await response.text();
        result.raw = rawText;
        let parsed: any;
        try {
          parsed = rawText ? JSON.parse(rawText) : {};
        } catch {
          throw new Error(`Gemini Interactions 非流式响应不是合法 JSON: ${rawText.slice(0, 200)}`);
        }
        // 非流式:单个 interaction 对象,steps 数组先逐条喂 step.start(建 state),再统一
        // step.stop 收口——与流式同一条解码路径,流式/非流式不会各养一份解析(专题9纪律)。
        const interaction = parsed.interaction ?? parsed;
        const steps = Array.isArray(interaction?.steps) ? interaction.steps : [];
        steps.forEach((step: unknown, index: number) => {
          if (isRecord(step)) decoder.handleEvent({ event_type: "step.start", index, step });
        });
        for (let index = 0; index < steps.length; index += 1) {
          decoder.handleEvent({ event_type: "step.stop", index });
        }
        if (interaction?.usage) result.usage = interactionsUsageFromMeta(interaction.usage);
        const toolCalls = result.functionCalls.map((fc) => ({ id: fc.id, name: fc.name, arguments: JSON.stringify(fc.args ?? {}) }));
        return { text: result.textOut, usage: result.usage, toolCalls, replay: result };
      }

      const reader = response.body?.getReader();
      if (!reader) return { text: result.textOut, usage: result.usage, toolCalls: [], replay: result };
      const textDecoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        if (sig?.aborted) throw new DOMException("Generation stopped", "AbortError");
        const { done, value } = await readWithIdleTimeout(() => reader.read(), STREAM_IDLE_TIMEOUT_MS);
        if (done) break;
        const chunk = textDecoder.decode(value, { stream: true });
        result.raw += chunk;
        buffer += chunk;
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          for (const payload of splitInteractionsSseData(frame)) {
            if (!payload || payload === "[DONE]") continue;
            try {
              decoder.handleEvent(JSON.parse(payload));
            } catch (err) {
              if (err instanceof Error && err.message.startsWith("Gemini Interactions:")) throw err;
              // 偶发非 JSON 行:skip。
            }
          }
        }
      }
      if (buffer.trim()) {
        for (const payload of splitInteractionsSseData(buffer)) {
          if (!payload || payload === "[DONE]") continue;
          try {
            decoder.handleEvent(JSON.parse(payload));
          } catch (err) {
            if (err instanceof Error && err.message.startsWith("Gemini Interactions:")) throw err;
          }
        }
      }
      decoder.finish();
      const toolCalls = result.functionCalls.map((fc) => ({ id: fc.id, name: fc.name, arguments: JSON.stringify(fc.args ?? {}) }));
      return { text: result.textOut, usage: result.usage, toolCalls, replay: result };
    },
    encodeNextTurn(result, toolResults) {
      const round = result.replay as InteractionsStreamRoundResult;
      // 无状态回传:input 追加本轮 replay steps(model_output/thought/function_call)+
      // 每个工具的 function_result(空输出占位,与安卓 buildInput 同防御)。
      const resultSteps = toolResults.map(({ call, output }) => ({
        type: "function_result",
        call_id: call.id,
        name: call.name,
        result: [{ type: "text", text: toolResultTextForApi({ output }) || " " }],
      }));
      input = [...input, ...round.replaySteps, ...resultSteps];
      return { ...body, input };
    },
    logResponseBody(result) {
      return textBody((result.replay as InteractionsStreamRoundResult).raw);
    },
    joinTextWithNewline: true,
    toolCardsCreatedInStream: true,
    finishReasoningOnFinal: true,
    exhaustedError: "Too many consecutive Gemini Interactions tool calls without final assistant content",
    appendSteeringUserTurns: (requestBody, texts) => {
      const steps = [...(Array.isArray(requestBody.input) ? requestBody.input : [])] as Array<Record<string, JsonValue>>;
      steps.push({ type: "user_input", content: [{ type: "text", text: texts.join("\n\n") }] });
      return { ...requestBody, input: steps };
    },
  };
  return runStreamingToolLoop(adapter, { ...body, input, store: false }, assistant, signal, hooks);
}

/** SSE 帧里抽 data: 载荷(与 parseSseChunks 同语义,Interactions 事件单行)。 */
function splitInteractionsSseData(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
}
