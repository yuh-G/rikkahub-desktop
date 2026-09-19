// inference-engine/providers.ts — LLM Provider 流式实现与解析辅助
// 纪律：负责 Provider HTTP 调用、流式解析、工具循环；不直接写 state.json / SQLite / SSE。
// 临时反向依赖 server.ts：本文件仍从 server.ts import 尚未拆出的辅助函数。

import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { Assistant, JsonValue, Message, Provider, ApiMessage, ClaudeStreamRoundResult, GoogleStreamRoundResult, ToolPart } from "../foundation/types";
import { id, isRecord, reasoningFromParts, safeJsonParse, visibleReasoningFromMessage, visibleTextFromMessage } from "../foundation/utils";
import { MODELS_DEV_CACHE_PATH } from "../foundation/paths";
import { fetchWithTimeout, readWithIdleTimeout } from "../foundation/net";
import { initialApprovalState, toolNeedsApproval } from "../tools/approval";
import { toolArgumentsJson, toolExecutionErrorPayload, toolResultTextForApi } from "../tools/format";
import {
  claudeBlocksFromUiParts,
} from "./message-builder";
import { ensureReasoningPart, finishReasoningParts, normalizeGeneratedImageUrl } from "./parts";
import type { StreamHooksWithSink, ToolCall, ToolResult } from "./events";
import {
  findModel,
  jsonBody,
  textBody,
} from "../model-providers";
import { contextWindowFor } from "../model-providers/model-limits";
import { addLog } from "../api/logs";
import { touchStream } from "../api/sse";
import { MAX_TOOL_STEPS, mergeTokenUsage, runStreamingToolLoop, toolCallContext, STREAM_IDLE_TIMEOUT_MS, type ProviderRoundAdapter, type NormalizedToolCall } from "./tool-loop";
export { mergeTokenUsage } from "./tool-loop";

// P1-5:工具循环骨架迁至 tool-loop.ts,这里重导出维持既有导入方。
export { MAX_TOOL_STEPS, toolCallContext };

/** 流内上游错误(Claude error 事件 / Gemini promptFeedback.blockReason)。
 *  全面审查 3-1:SSE 帧解析的容错 catch 必须放行"真实上游错误"、只吞 malformed
 *  fragment——用类型判别替代字符串前缀匹配(前缀匹配曾把 Anthropic 的
 *  overloaded/rate_limit 错误当碎片吞掉,残缺回答被当正常完成落库)。 */
export class UpstreamStreamError extends Error {}

/** 上游非 2xx 统一报文(B:404 形态诊断)。404 几乎总是「URL 打错了地方」——Base URL
 *  缺/多路径段(最常见漏 /v1)、chatCompletionsPath 拼写、中转平台改版,或模型 ID 不存在
 *  (Anthropic 的 model not_found 也走 404)。这类错误的响应正文往往是一页 HTML 或空串,
 *  毫无线索,故报文带上最终请求 URL 让用户一眼定位;其他状态码语义清晰(401/403 鉴权、
 *  429 限流、400 参数),厂商正文自带解释,保持原样拼接。 */
export function upstreamHttpError(providerItem: Provider, url: string, status: number, bodyText: string): Error {
  const body = bodyText.slice(0, 500);
  if (status !== 404) return new Error(`${providerItem.name} ${status}: ${body}`);
  return new Error(
    `${providerItem.name} 404: 接口路径不存在。实际请求 URL: ${url}\n` +
      `请检查 Base URL 形态(是否缺少或多了 /v1 等路径段)与模型 ID 是否存在。${body ? `\n${body}` : ""}`,
  );
}

// models.dev 开源模型目录缓存 —— 用于查询模型的最大上下文窗口,显示在对话统计行
// (分子 = 当前上下文 = promptTokens,分母 = 模型 contextLimit)。
// 数据源 https://models.dev/api.json,缓存到 pc-data,1 天 TTL,fetch 失败降级为空(不报错)。
// 策略参考 opencode 的 models-dev.ts:磁盘缓存 + 原子写(tmp→rename)+ 失败用旧缓存。
const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000; // 1 天
// 6-2:辅助流(标题/翻译/建议/压缩)总时长硬上限。任务输出可长(压缩长会话分钟级),
// 给 10 分钟余量——目的只是防上游黑洞导致 promise 永挂,不是节奏控制。
const AUX_STREAM_TIMEOUT_MS = 600_000;
export let modelsDevCache: Record<string, any> | null = null;
let modelsDevLoading: Promise<void> | null = null;

// 启动时 fire-and-forget 触发(见文件末尾),之后内存命中。失败只打日志,绝不抛。
// force=true 时跳过磁盘 TTL 检查、总是拉最新(用于"获取模型列表"等用户主动想试新模型的场景)。
export async function loadModelsDev(force = false): Promise<void> {
  // 正在加载 → 复用(避免并发 fetch);非强制且内存已有 → 复用。
  if (modelsDevLoading) return modelsDevLoading;
  if (!force && modelsDevCache !== null) return Promise.resolve();
  modelsDevLoading = (async () => {
    // 1. 磁盘缓存未过期且非强制 → 直接用(force 时跳过,总是拉最新)
    if (!force) {
      try {
        const stat = statSync(MODELS_DEV_CACHE_PATH);
        if (Date.now() - stat.mtimeMs < MODELS_DEV_TTL_MS) {
          modelsDevCache = JSON.parse(readFileSync(MODELS_DEV_CACHE_PATH, "utf8"));
          return;
        }
      } catch {
        // 无缓存文件或损坏 → 继续 fetch
      }
    }
    // 2. fetch(超时 10s)
    try {
      const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const parsed = JSON.parse(text) as Record<string, any>;
      // 3. 原子写:tmp → rename,避免半截文件
      const tmp = `${MODELS_DEV_CACHE_PATH}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, text);
        renameSync(tmp, MODELS_DEV_CACHE_PATH);
      } catch {
        try { unlinkSync(tmp); } catch { /* best-effort */ }
      }
      modelsDevCache = parsed;
    } catch (err) {
      console.warn(
        "[models-dev] fetch failed, falling back to stale cache or empty:",
        err instanceof Error ? err.message : err,
      );
      try {
        modelsDevCache = JSON.parse(readFileSync(MODELS_DEV_CACHE_PATH, "utf8"));
      } catch {
        modelsDevCache = {};
      }
    } finally {
      modelsDevLoading = null;
    }
  })();
  return modelsDevLoading;
}

// 模型极限查表已迁至 model-providers/model-limits.ts(按端点身份取值 + 输出上限自洽性
// 校验)。此前这里按"provider type + 名字搜全目录"命中第一个,决定统计行分母时无害,
// 成为出站 max_tokens 来源后就是硬 400 的来源(2026-09-09 智谱 GLM-5.3 报障)。
// 本文件保留 fillContextLimit —— 它是 usage 回填,依赖 findModel/modelsDevCache。

// 给 message.usage 填充 contextLimit(基于 msg.modelId 查 models.dev)。cache 未加载或
// 匹配不到时填 null(降级:前端只显示分子)。已填则跳过,避免重复 findModel。
export function fillContextLimit(msg: Message) {
  if (!msg.usage || typeof msg.usage !== "object") return;
  const usage = msg.usage as Record<string, unknown>;
  if (usage.contextLimit !== undefined) return;
  if (!msg.modelId || !modelsDevCache) {
    usage.contextLimit = null;
    return;
  }
  const found = findModel(msg.modelId);
  if (!found) {
    usage.contextLimit = null;
    return;
  }
  usage.contextLimit = contextWindowFor(modelsDevCache, found.provider, found.model.modelId);
}

export function appendUsageFromRaw(msg: Message | undefined, raw: any) {
  if (!msg) return;
  // Chat Completions 的 usage 在 raw.usage;Responses API 的在 raw.response.usage
  // (response.completed 事件嵌套一层 response)。
  const usage = raw?.usage ?? raw?.response?.usage;
  if (!usage || typeof usage !== "object") return;
  // 缓存命中字段各家方言不同(对齐安卓 #1576):OpenAI/DeepSeek 嵌套
  // prompt_tokens_details.cached_tokens → Responses API input_tokens_details →
  // Moonshot 顶层 cached_tokens → DeepSeek 旧版 prompt_cache_hit_tokens。
  msg.usage = mergeTokenUsage(msg.usage, {
    promptTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? 0),
    completionTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ?? 0),
    totalTokens: Number(usage.total_tokens ?? usage.totalTokens ?? 0),
    cachedTokens: Number(
      usage.prompt_tokens_details?.cached_tokens
        ?? usage.input_tokens_details?.cached_tokens
        ?? usage.cached_tokens
        ?? usage.prompt_cache_hit_tokens
        ?? usage.cachedTokens
        ?? 0,
    ),
  });
  fillContextLimit(msg);
}

export async function fetchText(
  url: string,
  headers: Record<string, string>,
  body: JsonValue | object,
  providerItem: Provider,
  pick: (raw: any) => string | undefined,
  signal?: AbortSignal,
) {
  const started = Date.now();
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  const rawText = await response.text();
  let raw: any = {};
  try {
    raw = rawText ? JSON.parse(rawText) : {};
  } catch {
    raw = { text: rawText };
  }
  addLog({
    providerId: providerItem.id,
    providerName: providerItem.name,
    url,
    ok: response.ok,
    status: response.status,
    kind: "provider:chat",
    durationMs: Date.now() - started,
    method: "POST",
    requestHeaders: headers,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    requestBody: jsonBody(body),
    responseBody: textBody(rawText),
    error: response.ok ? undefined : textBody(rawText),
  });
  if (!response.ok) throw upstreamHttpError(providerItem, url, response.status, rawText);
  return pick(raw)?.trim() || "(empty response)";
}

export function claudeTextFromContent(content: any[]) {
  return content
    .map((item) => {
      if (!isRecord(item)) return "";
      if (typeof item.text === "string") return item.text;
      if (typeof item.thinking === "string") return "";
      return "";
    })
    .join("")
    .trim();
}

// Claude usage 合并:对齐安卓 ClaudeProvider.parseTokenUsage + Usage.merge。
//
// 两个坑:
// 1) Claude 的 usage.input_tokens 只算 cache-miss 部分,真正发给模型的输入 token 还要加
//    cache_read_input_tokens + cache_creation_input_tokens。多轮对话里历史几乎全命中缓存,
//    input_tokens 会小到个位数(例:input=17 / cache_read=754 → 真实 prompt 771)。只取
//    input_tokens 会让前端"当前上下文"不随轮次增长——下一轮的 cache 命中更多,input_tokens
//    反而可能更小。
// 2) message_delta 事件只带 output_tokens(无 input_tokens / cache_*),直接覆盖会让上一条
//    message_start 写入的 promptTokens 归零。参照安卓 merge:新值 > 0 才采用,否则保留前值。
export function mergeClaudeUsage(
  u: any,
  prev: Message["usage"] | undefined,
): Message["usage"] | undefined {
  if (!u || typeof u !== "object") return prev;
  const inputTokens = Number(u.input_tokens ?? 0);
  const cacheRead = Number(u.cache_read_input_tokens ?? 0);
  const cacheCreation = Number(u.cache_creation_input_tokens ?? 0);
  const promptTokens = inputTokens + cacheRead + cacheCreation;
  const completionTokens = Number(u.output_tokens ?? 0);
  const mergedPrompt = promptTokens > 0 ? promptTokens : ((prev as any)?.promptTokens ?? 0);
  const mergedCompletion =
    completionTokens > 0 ? completionTokens : ((prev as any)?.completionTokens ?? 0);
  return {
    promptTokens: mergedPrompt,
    completionTokens: mergedCompletion,
    totalTokens: mergedPrompt + mergedCompletion,
    cachedTokens: cacheRead > 0 ? cacheRead : ((prev as any)?.cachedTokens ?? 0),
  };
}

export async function readClaudeStreamingRound(
  response: Response,
  hooks: StreamHooksWithSink,
  assistant: Assistant,
  signal?: AbortSignal,
): Promise<ClaudeStreamRoundResult> {
  const reader = response.body?.getReader();
  if (!reader) {
    return { blocks: [], textOut: "", thinkingOut: "", stopReason: null, usage: undefined, raw: "" };
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let raw = "";
  // Index-keyed accumulators for the active content blocks. Claude emits content_block_start
  // with an index, then deltas with the same index, then content_block_stop. We mirror that
  // structure here so concurrent text + thinking + tool_use blocks all reconstruct correctly.
  const blocks = new Map<number, Record<string, any>>();
  let textOut = "";
  let thinkingOut = "";
  let stopReason: string | null = null;
  let usage: Message["usage"] | undefined;
  const setUsage = (u: any) => {
    usage = mergeClaudeUsage(u, usage);
  };
  const handleEvent = (eventName: string, dataJson: any) => {
    if (!dataJson || typeof dataJson !== "object") return;
    if (eventName === "message_start") {
      const u = dataJson.message?.usage;
      // anthropic 语义:message_start.usage.output_tokens 是起始计数(常为 1),最终值
      // 只来自 message_delta。Kimi coding 等兼容端点 message_delta 不带 usage,若把
      // 起始值当真:completionTokens 恒 1,ensureUsage 字段级估算兜底被非零值挡住,
      // TPS 显示≈0(内测两连反馈的最终根因)。message_start 只吸收 input 侧字段;
      // output 侧留给 message_delta——官方端点正常覆盖,兼容端点落估算兜底。
      if (u) setUsage({ ...u, output_tokens: 0 });
      return;
    }
    if (eventName === "message_delta") {
      if (dataJson.delta?.stop_reason) stopReason = String(dataJson.delta.stop_reason);
      if (dataJson.usage) setUsage(dataJson.usage);
      return;
    }
    if (eventName === "message_stop") return;
    if (eventName === "error") {
      const errMessage = dataJson.error?.message ?? "Claude stream error";
      throw new UpstreamStreamError(String(errMessage));
    }
    const index = typeof dataJson.index === "number" ? dataJson.index : -1;
    if (eventName === "content_block_start") {
      const block = dataJson.content_block ?? {};
      blocks.set(index, { ...block, _inputBuffer: "" });
      const type = String(block.type ?? "");
      if (type === "tool_use") {
        // Insert/refresh a Tool part immediately so the user sees the tool card appear right
        // when Claude announces the call, even before the input_json_delta arrives.
        if (hooks.message) {
          finishReasoningParts(hooks.message);
          hooks.sink?.({
            kind: "tool_call_created",
            toolCallId: String(block.id ?? ""),
            toolName: String(block.name ?? ""),
            input: "",
            approvalState: initialApprovalState(String(block.name ?? ""), assistant, hooks.conversation),
          });
          touchStream(hooks);
        }
      } else if (type === "text" && block.text) {
        textOut += block.text;
        hooks.sink?.({ kind: "text_delta", text: String(block.text) });
      } else if (type === "thinking" && block.thinking) {
        thinkingOut += block.thinking;
        hooks.sink?.({ kind: "reasoning_delta", text: String(block.thinking) });
      }
      return;
    }
    if (eventName === "content_block_delta") {
      const delta = dataJson.delta ?? {};
      const dtype = String(delta.type ?? "");
      const block = blocks.get(index) ?? {};
      if (dtype === "text_delta" && typeof delta.text === "string") {
        textOut += delta.text;
        hooks.sink?.({ kind: "text_delta", text: delta.text });
      } else if (dtype === "thinking_delta" && typeof delta.thinking === "string") {
        thinkingOut += delta.thinking;
        hooks.sink?.({ kind: "reasoning_delta", text: delta.thinking });
      } else if (dtype === "signature_delta" && typeof delta.signature === "string") {
        block.signature = String(block.signature ?? "") + delta.signature;
        blocks.set(index, block);
      } else if (dtype === "input_json_delta" && typeof delta.partial_json === "string") {
        block._inputBuffer = String(block._inputBuffer ?? "") + delta.partial_json;
        blocks.set(index, block);
        // Stream the partial input into the tool part so users see argument JSON taking shape.
        if (hooks.message && block.type === "tool_use") {
          const targetId = String(block.id ?? "");
          if (targetId) {
            if (hooks.sink) {
              hooks.sink({ kind: "tool_input_delta", toolCallId: targetId, input: block._inputBuffer });
            } else {
              hooks.message.parts = hooks.message.parts.map((part) => {
                if (!isRecord(part) || part.type !== "tool" || part.toolCallId !== targetId) return part;
                return { ...part, input: block._inputBuffer };
              });
            }
            touchStream(hooks);
          }
        }
      }
      return;
    }
    if (eventName === "content_block_stop") {
      const block = blocks.get(index);
      if (!block) return;
      if (block.type === "tool_use" && block._inputBuffer) {
        // Finalize tool input as parsed object.
        try {
          block.input = JSON.parse(block._inputBuffer);
        } catch {
          block.input = block._inputBuffer;
        }
      }
      delete block._inputBuffer;
      blocks.set(index, block);
      return;
    }
  };
  for (;;) {
    if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
    // R3-1:空闲看门狗(此前仅 OpenAI 有),防上游黑洞导致 reader.read() 永久悬挂。
    const { done, value } = await readWithIdleTimeout(() => reader.read(), STREAM_IDLE_TIMEOUT_MS);
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    raw += chunk;
    buffer += chunk;
    // SSE frames are separated by a blank line. Inside a frame, lines starting with `event:`
    // set the event type and `data:` lines contribute payload (concatenated). Anthropic
    // always uses single-line data, but we handle the general case.
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      let eventName = "message";
      const dataLines: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim() || "message";
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      const data = dataLines.join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        handleEvent(eventName, JSON.parse(data));
      } catch (err) {
        if (err instanceof UpstreamStreamError) throw err;
        // Ignore malformed fragments — Anthropic occasionally pings.
      }
    }
  }
  // Drain the trailing partial frame if any.
  if (buffer.trim()) {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of buffer.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim() || "message";
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    const data = dataLines.join("\n");
    if (data && data !== "[DONE]") {
      try {
        handleEvent(eventName, JSON.parse(data));
      } catch (err) {
        if (err instanceof UpstreamStreamError) throw err;
        // ignore malformed trailing fragment
      }
    }
  }
  const orderedBlocks = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, block]) => block);
  return { blocks: orderedBlocks, textOut, thinkingOut, stopReason, usage, raw };
}

// 专题9:Claude 非流式单轮。助手关闭"流式输出"时使用:响应是完整 messages 对象,
// content blocks 与流式聚合后的 blocks 同构(text/thinking/tool_use),直接一次性发事件。
// 工具卡也在此创建(与流式 reader 一致),骨架的 toolCardsCreatedInStream 语义不变。
export async function readClaudeJsonRound(
  response: Response,
  hooks: StreamHooksWithSink,
  assistant: Assistant,
): Promise<ClaudeStreamRoundResult> {
  const rawText = await response.text();
  let raw: any = {};
  try {
    raw = rawText ? JSON.parse(rawText) : {};
  } catch {
    throw new Error(`Claude 非流式响应不是合法 JSON: ${rawText.slice(0, 200)}`);
  }
  const blocks: Array<Record<string, any>> = Array.isArray(raw.content) ? raw.content.filter(isRecord) : [];
  let textOut = "";
  let thinkingOut = "";
  for (const block of blocks) {
    const type = String(block.type ?? "");
    if (type === "thinking" && typeof block.thinking === "string" && block.thinking) {
      thinkingOut += block.thinking;
      hooks.sink?.({ kind: "reasoning_delta", text: block.thinking });
    } else if (type === "text" && typeof block.text === "string" && block.text) {
      textOut += block.text;
      hooks.sink?.({ kind: "text_delta", text: block.text });
    } else if (type === "tool_use" && hooks.message) {
      const name = String(block.name ?? "");
      const inputJson = JSON.stringify(isRecord(block.input) ? block.input : {});
      finishReasoningParts(hooks.message);
      hooks.sink?.({
        kind: "tool_call_created",
        toolCallId: String(block.id ?? id()),
        toolName: name,
        input: inputJson,
        approvalState: initialApprovalState(name, assistant, hooks.conversation, inputJson),
      });
      touchStream(hooks);
    }
  }
  return {
    blocks,
    textOut,
    thinkingOut,
    stopReason: typeof raw.stop_reason === "string" ? raw.stop_reason : null,
    usage: mergeClaudeUsage(raw.usage, undefined),
    raw: rawText,
  };
}

export async function streamClaudeChatWithTools(
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  providerItem: Provider,
  assistant: Assistant,
  signal: AbortSignal | undefined,
  hooks: StreamHooksWithSink,
) {
  // P1-5:循环骨架统一到 runStreamingToolLoop,本函数只保留 Claude 特定的 Round Adapter。
  let messages = Array.isArray(body.messages) ? [...body.messages] : [];
  const initialBody: Record<string, unknown> = { ...body, messages, stream: true };

  const adapter: ProviderRoundAdapter = {
    providerItem,
    logUrl: url,
    logHeaders: headers,
    fetchRound: (requestBody, _round, sig, nonStream) => fetch(url, {
      method: "POST",
      headers: nonStream ? headers : { ...headers, Accept: "text/event-stream" },
      body: JSON.stringify(requestBody),
      signal: sig,
      // 注意:无需在此传 Bun timeout 键。net.ts 的 fetch 拦截器已对所有走 globalThis.fetch
      // 的调用统一注入 timeout:0(禁用 Bun 300s socket 空闲定时器),计时权归 headerTimeoutMs。
    }),
    // R3-1:头超时统一 600s(流式/非流式同值,用户需求 2026-08-01:非流式对齐流式——
    // 非流式响应头要等全文生成完,长思考模型 5 分钟以上很常见,300s 会误杀)。
    headerTimeoutMs: () => 600_000,
    makeNonStreamBody: (requestBody) => ({ ...requestBody, stream: false }),
    async readRound(response, sig, nonStream) {
      const round = nonStream
        ? await readClaudeJsonRound(response, hooks, assistant)
        : await readClaudeStreamingRound(response, hooks, assistant, sig);
      const toolCalls: NormalizedToolCall[] = round.blocks
        .filter((block) => block.type === "tool_use")
        .map((toolUse) => {
          const toolInput = isRecord(toolUse.input)
            ? toolUse.input
            : (typeof toolUse.input === "string" && toolUse.input ? safeJsonParse(toolUse.input) : {});
          return {
            id: String(toolUse.id ?? id()),
            name: String(toolUse.name ?? ""),
            arguments: JSON.stringify(toolInput ?? {}),
          };
        });
      return { text: round.textOut, usage: round.usage, toolCalls, replay: round };
    },
    encodeNextTurn(result, toolResults) {
      const round = result.replay as ClaudeStreamRoundResult;
      const toolResultBlocks = toolResults.map(({ call, output }) => ({
        type: "tool_result",
        tool_use_id: call.id,
        content: claudeBlocksFromUiParts(output) as unknown as JsonValue,
      }));
      // Anthropic requires us to echo the assistant's content blocks verbatim (including the
      // tool_use entries) before sending the tool_result user turn. Strip our internal markers
      // and pass the rest through.
      const assistantBlocksForReplay = round.blocks
        .filter((block) => block && (block.type === "text" || block.type === "thinking" || block.type === "tool_use"))
        .map((block) => {
          if (block.type === "tool_use") {
            return { type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} };
          }
          if (block.type === "thinking") {
            return block.signature
              ? { type: "thinking", thinking: block.thinking ?? "", signature: block.signature }
              : { type: "thinking", thinking: block.thinking ?? "" };
          }
          return { type: "text", text: block.text ?? "" };
        });
      messages = [
        ...messages,
        { role: "assistant", content: assistantBlocksForReplay },
        { role: "user", content: toolResultBlocks },
      ];
      return { ...body, messages, stream: true };
    },
    logResponseBody(result) {
      return textBody((result.replay as ClaudeStreamRoundResult).raw);
    },
    joinTextWithNewline: true,
    toolCardsCreatedInStream: true,
    finishReasoningOnFinal: true,
    exhaustedError: "Too many consecutive Claude tool calls without final assistant content",
    // steering 注入(用户问题②):Claude 协议要求角色交替,上一条 encodeNextTurn 已以
    // {role:"user", content:[tool_result...]} 收尾——补发文本并入该 user turn 的 content
    // 末尾(块序:tool_result 块在前、text 块在后),而非另起 user turn(会被 400 拒)。
    // 多条补发以空行并成一段文本。防御:末条不是 user turn(异常 body)时退化为追加
    // 新 user turn,宁可协议风险也不丢消息(实际不可达——encodeNextTurn 恒以 user 收尾)。
    appendSteeringUserTurns: (requestBody, texts) => {
      const messagesArr = [...(Array.isArray(requestBody.messages) ? requestBody.messages : [])];
      const last = messagesArr[messagesArr.length - 1] as { role?: string; content?: unknown } | undefined;
      if (last && last.role === "user" && Array.isArray(last.content)) {
        messagesArr[messagesArr.length - 1] = {
          ...last,
          content: [...last.content, { type: "text", text: texts.join("\n\n") }],
        };
      } else {
        messagesArr.push({ role: "user", content: [{ type: "text", text: texts.join("\n\n") }] });
      }
      return { ...requestBody, messages: messagesArr, stream: true };
    },
  };
  return runStreamingToolLoop(adapter, initialBody, assistant, signal, hooks);
}

export async function fetchClaudeTextWithTools(
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  providerItem: Provider,
  assistant: Assistant,
  signal?: AbortSignal,
  hooks?: StreamHooksWithSink,
) {
  let messages = Array.isArray(body.messages) ? [...body.messages] : [];
  let currentBody = { ...body, messages, stream: false };
  let allContent = "";

  for (let round = 0; round < MAX_TOOL_STEPS; round += 1) {
    // R3-4:非流式路径同样每轮首查停止。
    if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
    const started = Date.now();
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(currentBody), signal });
    const rawText = await response.text();
    let raw: any = {};
    try {
      raw = rawText ? JSON.parse(rawText) : {};
    } catch {
      raw = { text: rawText };
    }
    addLog({
      providerId: providerItem.id,
      providerName: providerItem.name,
      url,
      ok: response.ok,
      status: response.status,
      kind: round === 0 ? "provider:chat" : "provider:chat:tool_result",
      durationMs: Date.now() - started,
      method: "POST",
      requestHeaders: headers,
      responseHeaders: Object.fromEntries(response.headers.entries()),
      requestBody: jsonBody(currentBody),
      responseBody: textBody(rawText),
      error: response.ok ? undefined : textBody(rawText),
    });
    if (!response.ok) throw upstreamHttpError(providerItem, url, response.status, rawText);

    const content: JsonValue[] = Array.isArray(raw.content) ? raw.content : [];
    const text = claudeTextFromContent(content);
    if (text) {
      allContent += `${allContent ? "\n" : ""}${text}`;
      hooks?.sink?.({ kind: "text_delta", text });
    }
    const toolUses = content.filter((item: JsonValue): item is Record<string, JsonValue> => isRecord(item) && item.type === "tool_use");
    if (toolUses.length === 0) return allContent.trim() || "(empty response)";

    const toolResultBlocks = [];
    const dispatchCtx = toolCallContext(hooks);
    // Same rationale as the stream path: bail out of the turn if any tool needs approval so
    // we don't end up sending an unanswered tool_use to Anthropic on the next turn.
    const hasPendingInBatch = toolUses.some((toolUse) =>
      toolNeedsApproval(String(toolUse.name ?? ""), assistant, hooks?.conversation, JSON.stringify(isRecord(toolUse.input) ? toolUse.input : {})),
    );
    for (const toolUse of toolUses) {
      // R3-4:停止后剩余工具不再执行。
      if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
      const toolCall = {
        id: String(toolUse.id ?? id()),
        type: "function",
        function: {
          name: String(toolUse.name ?? ""),
          arguments: JSON.stringify(isRecord(toolUse.input) ? toolUse.input : {}),
        },
      };
      const toolPart: ToolPart = {
        type: "tool",
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        input: toolCall.function.arguments,
        output: [],
        approvalState: initialApprovalState(toolCall.function.name, assistant, hooks?.conversation, toolCall.function.arguments),
      };
      if (hooks?.message) {
        finishReasoningParts(hooks.message);
        hooks.sink?.({
          kind: "tool_call_created",
          toolCallId: String(toolPart.toolCallId),
          toolName: String(toolPart.toolName),
          input: String(toolPart.input),
          approvalState: toolPart.approvalState,
        });
        touchStream(hooks);
      }
      if (hasPendingInBatch) {
        // Tool card is in pending state; skip execution and let the rest of the batch land
        // as pending cards too (so the UI shows the full set of decisions to approve/deny).
        continue;
      }
      let toolResult: ToolResult;
      try {
        toolResult = await dispatchCtx!.executeTool!(toolCall as ToolCall, dispatchCtx);
      } catch (err) {
        toolResult = { output: [toolExecutionErrorPayload(err)] };
      }
      const outputParts = toolResult.output;
      if (hooks?.sink) {
        hooks.sink({ kind: "tool_result", toolCallId: toolCall.id, output: outputParts });
      } else {
        toolPart.output = outputParts;
        touchStream(hooks);
      }
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: toolCall.id,
        content: claudeBlocksFromUiParts(outputParts),
      });
    }
    if (hasPendingInBatch) {
      return allContent.trim() || "";
    }

    messages = [
      ...messages,
      { role: "assistant", content },
      { role: "user", content: toolResultBlocks },
    ];
    currentBody = { ...body, messages, stream: false };
  }

  throw new Error("Too many consecutive Claude tool calls without final assistant content");
}

export function googleUsageFromMeta(meta: any): Message["usage"] | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const promptTokens = Number(meta.promptTokenCount ?? 0);
  const thoughtTokens = Number(meta.thoughtsTokenCount ?? 0);
  const candidatesTokens = Number(meta.candidatesTokenCount ?? 0);
  return {
    promptTokens,
    completionTokens: candidatesTokens + thoughtTokens,
    totalTokens: Number(meta.totalTokenCount ?? 0),
    cachedTokens: Number(meta.cachedContentTokenCount ?? 0),
  };
}

// 单个 generateContent 形状的响应对象 → 轮次聚合结果 + 实时事件。流式(SSE 逐 chunk)与
// 非流式(整包一次)共用同一份解析(专题9),避免两份 part-walk 漂移。
function applyGoogleRoundChunk(
  raw: any,
  result: GoogleStreamRoundResult,
  hooks: StreamHooksWithSink,
  assistant: Assistant,
) {
  if (!raw || typeof raw !== "object") return;
  const blockReason = raw.promptFeedback?.blockReason;
  if (blockReason) throw new UpstreamStreamError(`Gemini blocked: ${blockReason}`);
  const meta = raw.usageMetadata;
  // P1-3:merge 而非覆写——Google 流式末尾 chunk 的 usageMetadata 可能缺
  // cachedContentTokenCount,覆写会把前面 chunk 已报的命中数清零。
  if (meta) result.usage = mergeTokenUsage(result.usage ?? null, googleUsageFromMeta(meta) ?? null) ?? undefined;
  const candidate = raw.candidates?.[0];
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return;
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (typeof part.text === "string" && part.text) {
      if (part.thought === true) {
        result.thinkingOut += part.text;
        hooks.sink?.({ kind: "reasoning_delta", text: part.text });
      } else {
        result.textOut += part.text;
        result.modelParts.push({ text: part.text });
        hooks.sink?.({ kind: "text_delta", text: part.text });
      }
    } else if (isRecord(part.inlineData)) {
      const mime = String((part.inlineData as any).mimeType ?? "image/png");
      const data = String((part.inlineData as any).data ?? "");
      if (part.thought === true) {
        // 思考过程中的草稿图直接忽略，对齐安卓 parseMessagePart。
        continue;
      }
      if (data && mime.startsWith("image/")) {
        hooks.sink?.({ kind: "image_delta", url: `data:${mime};base64,${data}` });
      }
    } else if (isRecord(part.functionCall)) {
      const fc = part.functionCall as any;
      const name = String(fc.name ?? "");
      if (!name) continue;
      const args = isRecord(fc.args) ? (fc.args as Record<string, JsonValue>) : {};
      const thoughtSignature = part.thoughtSignature != null ? String(part.thoughtSignature) : undefined;
      const callId = id();
      result.functionCalls.push({ id: callId, name, args, thoughtSignature });
      result.modelParts.push({
        functionCall: { name, args },
        ...(thoughtSignature ? { thoughtSignature } : {}),
      });
      if (hooks.message) {
        finishReasoningParts(hooks.message);
        hooks.sink?.({
          kind: "tool_call_created",
          toolCallId: callId,
          toolName: name,
          input: JSON.stringify(args),
          // Gemini 函数调用整体到达，建卡即参数齐备的终局审批态
          approvalState: initialApprovalState(name, assistant, hooks.conversation, JSON.stringify(args)),
        });
        touchStream(hooks);
      }
    }
  }
}

// 专题9:Gemini 非流式单轮(generateContent)。助手关闭"流式输出"时使用;
// 响应就是一个完整的 generateContent 对象,直接走共用解析一次性发事件。
export async function readGoogleJsonRound(
  response: Response,
  hooks: StreamHooksWithSink,
  assistant: Assistant,
): Promise<GoogleStreamRoundResult> {
  const rawText = await response.text();
  const result: GoogleStreamRoundResult = {
    textOut: "",
    thinkingOut: "",
    functionCalls: [],
    modelParts: [],
    usage: undefined,
    raw: rawText,
  };
  let raw: any = {};
  try {
    raw = rawText ? JSON.parse(rawText) : {};
  } catch {
    throw new Error(`Gemini 非流式响应不是合法 JSON: ${rawText.slice(0, 200)}`);
  }
  applyGoogleRoundChunk(raw, result, hooks, assistant);
  return result;
}

export async function readGoogleStreamingRound(
  response: Response,
  hooks: StreamHooksWithSink,
  assistant: Assistant,
  signal?: AbortSignal,
): Promise<GoogleStreamRoundResult> {
  const reader = response.body?.getReader();
  const result: GoogleStreamRoundResult = {
    textOut: "",
    thinkingOut: "",
    functionCalls: [],
    modelParts: [],
    usage: undefined,
    raw: "",
  };
  if (!reader) return result;
  const decoder = new TextDecoder();
  let buffer = "";

  const handleChunk = (raw: any) => applyGoogleRoundChunk(raw, result, hooks, assistant);

  for (;;) {
    if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
    // R3-1:空闲看门狗(此前仅 OpenAI 有),防上游黑洞导致 reader.read() 永久悬挂。
    const { done, value } = await readWithIdleTimeout(() => reader.read(), STREAM_IDLE_TIMEOUT_MS);
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    result.raw += chunk;
    buffer += chunk;
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const payload of parseSseChunks(frame)) {
        if (!payload || payload === "[DONE]") continue;
        try {
          handleChunk(JSON.parse(payload));
        } catch (err) {
          if (err instanceof UpstreamStreamError) throw err;
          // 忽略 Gemini 偶发的非 JSON 行
        }
      }
    }
  }
  if (buffer.trim()) {
    for (const payload of parseSseChunks(buffer)) {
      if (!payload || payload === "[DONE]") continue;
      try {
        handleChunk(JSON.parse(payload));
      } catch (err) {
        if (err instanceof UpstreamStreamError) throw err;
        // ignore malformed trailing fragment
      }
    }
  }
  return result;
}

// 驱动 Gemini 的流式工具循环。镜像安卓 GenerationHandler 的 step 循环 + GoogleProvider.streamText：
// 每轮拿到 functionCall 就执行工具，把 functionResponse 作为 user 消息追加，再发起下一轮，
// 直到模型不再请求工具。无 hooks（辅助调用）时不会走到这里。
export async function streamGoogleChatWithTools(
  baseUrl: string,
  headers: Record<string, string>,
  modelId: string,
  body: Record<string, any>,
  providerItem: Provider,
  assistant: Assistant,
  signal: AbortSignal | undefined,
  hooks: StreamHooksWithSink,
) {
  // P1-5:循环骨架统一到 runStreamingToolLoop,本函数只保留 Google 特定的 Round Adapter。
  // issue10:鉴权已移入 headers 的 x-goog-api-key(调用方设置),URL 不再带 ?key=。
  const streamUrl = `${baseUrl.replace(/\/+$/, "")}/models/${modelId}:streamGenerateContent?alt=sse`;
  // 专题9:助手关闭"流式输出"时走 generateContent(非流式);Gemini 的流式/非流式区别在
  // URL 而非请求体,makeNonStreamBody 为恒等,由 fetchRound 按 nonStream 切换端点。
  const jsonUrl = `${baseUrl.replace(/\/+$/, "")}/models/${modelId}:generateContent`;
  let contents = Array.isArray(body.contents) ? [...body.contents] : [];
  const initialBody: Record<string, unknown> = { ...body, contents };

  const adapter: ProviderRoundAdapter = {
    providerItem,
    logUrl: streamUrl,
    logHeaders: headers,
    fetchRound: (requestBody, _round, sig, nonStream) => fetch(nonStream ? jsonUrl : streamUrl, {
      method: "POST",
      headers: nonStream ? headers : { ...headers, Accept: "text/event-stream" },
      body: JSON.stringify(requestBody),
      signal: sig,
      // Bun timeout 由 net.ts fetch 拦截器统一注入 timeout:0(见 Claude 适配器处注释)。
    }),
    // R3-1:头超时统一 600s(流式/非流式同值,用户需求 2026-08-01:非流式对齐流式,
    // 理由同 Claude/OpenAI 适配器处注释)。
    headerTimeoutMs: () => 600_000,
    makeNonStreamBody: (requestBody) => requestBody,
    async readRound(response, sig, nonStream) {
      const round = nonStream
        ? await readGoogleJsonRound(response, hooks, assistant)
        : await readGoogleStreamingRound(response, hooks, assistant, sig);
      const toolCalls: NormalizedToolCall[] = round.functionCalls.map((fc) => ({
        id: fc.id,
        name: fc.name,
        arguments: JSON.stringify(fc.args ?? {}),
      }));
      return { text: round.textOut, usage: round.usage, toolCalls, replay: round };
    },
    encodeNextTurn(result, toolResults) {
      const round = result.replay as GoogleStreamRoundResult;
      // result 文本经 toolResultTextForApi(工具结果的唯一投影,同 OpenAI/Claude 两系):
      // ①空输出给确定性占位而非空串——Gemini 不像火山那样按必填拒,但"有调用无结果"
      // 回灌给模型的表述必须与另两系逐字一致(否则模型行为随 provider 漂移);②无 text
      // part 的输出(纯图片等)不再退化成空串,由 openAiToolOutput 兜底序列化。
      const responseParts = toolResults.map(({ call, output }) => ({
        functionResponse: { name: call.name, response: { result: toolResultTextForApi({ output }) } },
      }));
      // Gemini 要求把模型这轮的 parts（含 functionCall）原样回放，再追加 user 的 functionResponse。
      contents = [
        ...contents,
        { role: "model", parts: round.modelParts.length ? round.modelParts : [{ text: round.textOut }] },
        { role: "user", parts: responseParts },
      ];
      return { ...body, contents };
    },
    logResponseBody(result) {
      return textBody((result.replay as GoogleStreamRoundResult).raw);
    },
    joinTextWithNewline: true,
    toolCardsCreatedInStream: true,
    finishReasoningOnFinal: true,
    exhaustedError: "Too many consecutive Gemini tool calls without final assistant content",
    // steering 注入(用户问题②):Gemini 无严格交替约束,补发文本并入上一条 user
    // turn(与 functionResponse 同 turn)的 parts 末尾——与 Claude 同位的语义选择:
    // 补发是「用户对当前任务的中途插话」,不是独立新轮。多条补发以空行并成一段。
    appendSteeringUserTurns: (requestBody, texts) => {
      const contentsArr = [...(Array.isArray(requestBody.contents) ? requestBody.contents : [])] as Array<{ role?: string; parts?: unknown[] }>;
      const last = contentsArr[contentsArr.length - 1];
      const textPart = { text: texts.join("\n\n") };
      if (last && last.role === "user" && Array.isArray(last.parts)) {
        contentsArr[contentsArr.length - 1] = { ...last, parts: [...last.parts, textPart] };
      } else {
        contentsArr.push({ role: "user", parts: [textPart] });
      }
      return { ...requestBody, contents: contentsArr };
    },
  };
  return runStreamingToolLoop(adapter, initialBody, assistant, signal, hooks);
}

// functionResponse 的 result 文本：把工具输出 parts 拼成纯文本，对齐安卓
// toFunctionResponsePart（只取 Text part 拼接）。
export async function fetchOpenAiText(
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  providerItem: Provider,
  assistant: Assistant,
  signal?: AbortSignal,
  hooks?: StreamHooksWithSink,
) {
  let messages = Array.isArray(body.messages) ? [...body.messages] : [];
  let currentBody = { ...body, messages, stream: false };
  let allContent = "";
  for (let round = 0; round < MAX_TOOL_STEPS; round += 1) {
    // R3-4:非流式路径同样每轮首查停止。
    if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
    const started = Date.now();
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(currentBody), signal });
    const rawText = await response.text();
    let raw: any = {};
    try {
      raw = rawText ? JSON.parse(rawText) : {};
    } catch {
      raw = { text: rawText };
    }
    addLog({
      providerId: providerItem.id,
      providerName: providerItem.name,
      url,
      ok: response.ok,
      status: response.status,
      kind: round === 0 ? "provider:chat" : "provider:chat:tool_result",
      durationMs: Date.now() - started,
      method: "POST",
      requestHeaders: headers,
      responseHeaders: Object.fromEntries(response.headers.entries()),
      requestBody: jsonBody(currentBody),
      responseBody: textBody(rawText),
      error: response.ok ? undefined : textBody(rawText),
    });
    if (!response.ok) throw upstreamHttpError(providerItem, url, response.status, rawText);

    const assistantMessage = raw.choices?.[0]?.message ?? {};
    const content = completionMessageText(raw);
    if (content) {
      allContent += content;
      hooks?.sink?.({ kind: "text_delta", text: content });
    }
    const toolCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];
    if (toolCalls.length === 0) return allContent.trim() || "(empty response)";

    const toolMessages = [];
    const hasPendingInBatch = toolCalls.some((toolCall: any) =>
      toolNeedsApproval(String(toolCall?.function?.name ?? ""), assistant, hooks?.conversation, toolArgumentsJson(toolCall?.function?.arguments)),
    );
    const dispatchCtx = toolCallContext(hooks);
    for (const toolCall of toolCalls) {
      // R3-4:停止后剩余工具不再执行。
      if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
      // arguments 经 toolArgumentsJson 归一(""→"{}"):不规范上游会回空串,?? 接不住,空参
      // 工具卡落库后在下一轮历史编码里就是严格端点 400 的弹药(见 toolArgumentsJson 头注)。
      const toolArguments = toolArgumentsJson(toolCall.function?.arguments);
      const toolPart: ToolPart = {
        type: "tool",
        toolCallId: String(toolCall.id ?? id()),
        toolName: String(toolCall.function?.name ?? ""),
        input: toolArguments,
        output: [],
        approvalState: initialApprovalState(String(toolCall.function?.name ?? ""), assistant, hooks?.conversation, toolArguments),
      };
      if (hooks?.message) {
        finishReasoningParts(hooks.message);
        hooks.sink?.({
          kind: "tool_call_created",
          toolCallId: String(toolPart.toolCallId),
          toolName: String(toolPart.toolName),
          input: String(toolPart.input),
          approvalState: toolPart.approvalState,
        });
        touchStream(hooks);
      }
      if (hasPendingInBatch) {
        continue;
      }
      let toolResult: ToolResult;
      try {
        toolResult = await dispatchCtx!.executeTool!(toolCall as ToolCall, dispatchCtx);
      } catch (err) {
        toolResult = { output: [toolExecutionErrorPayload(err)] };
      }
      const outputParts = toolResult.output;
      // 本地 toolPart 恒记录输出:sink 分支的卡在消息里(由应用器写),但下面的结果项投影
      // 读的是这个本地对象——不写就会被当成"无输出"而落到中断占位文案。
      toolPart.output = outputParts;
      if (hooks?.sink) {
        hooks.sink({ kind: "tool_result", toolCallId: String((toolPart as Record<string, JsonValue>).toolCallId), output: outputParts });
      } else {
        touchStream(hooks);
      }
      toolMessages.push({
        role: "tool",
        tool_call_id: (toolPart as Record<string, JsonValue>).toolCallId,
        content: toolResultTextForApi(toolPart),
      });
    }
    if (hasPendingInBatch) {
      return allContent.trim() || "";
    }
    messages = [
      ...messages,
      compactAssistantToolMessage(
        content,
        toolCalls,
        String(assistantMessage.reasoning_content ?? assistantMessage.reasoning ?? ""),
      ),
      ...toolMessages,
    ];
    currentBody = { ...body, messages, stream: false };
  }
  throw new Error("Too many consecutive tool calls without final assistant content");
}

export function responseMessageText(raw: any): string {
  const chunks: string[] = [];
  const walk = (value: any) => {
    if (value == null) return;
    if (typeof value === "string") {
      chunks.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value !== "object") return;
    const type = String(value.type ?? "");
    if (
      typeof value.text === "string" &&
      (!type || type === "text" || type === "output_text" || type === "message")
    ) {
      chunks.push(value.text);
    }
    if (type === "image_generation_call" && typeof value.result === "string") {
      chunks.push(`\n\n![generated image](${normalizeGeneratedImageUrl(value.result)})\n\n`);
    }
    if (typeof value.content === "string") chunks.push(value.content);
    if (value.content) walk(value.content);
    if (value.output_text) walk(value.output_text);
  };
  if (typeof raw.output_text === "string") chunks.push(raw.output_text);
  walk(raw.output);
  return chunks.join("").trim();
}

export function completionMessageText(raw: any): string {
  const message = raw.choices?.[0]?.message ?? raw.choices?.[0]?.delta ?? {};
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item: any) => typeof item === "string" ? item : String(item?.text ?? item?.content ?? ""))
      .join("")
      .trim();
  }
  return responseMessageText(raw);
}

export function parseSseChunks(text: string) {
  return text
    // 事件分隔认 CRLF(与各家 reader 的读循环分帧一致),理由见 readOpenAiStream 注释。
    .split(/\r?\n\r?\n/)
    .flatMap((block) => {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean)
        .join("\n")
        .trim();
      if (!data) return [];
      if (data === "[DONE]") return [data];
      // R3-7:SSE 规范允许一个事件的 data 跨多行——join 后才是完整载荷。此前无条件按行
      // 再拆,跨行 JSON 每行都解析失败被调用方容错吞掉,内容整段静默丢失且无报错(对齐
      // readClaudeStreamingRound 的 join 后整体 parse)。单行载荷(三家官方上游的现状)
      // 行为不变;join 后不是合法 JSON 时退回逐行拆分——兼容"同一 block 里塞多个单行
      // JSON 事件"的不规范上游(旧行为)。
      if (!data.includes("\n")) return [data];
      try {
        JSON.parse(data);
        return [data];
      } catch {
        return data
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
      }
    });
}

export function responseEventToDelta(raw: any) {
  const type = String(raw.type ?? "");
  if (type === "response.output_text.delta") return { content: String(raw.delta ?? "") };
  if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
    return { reasoning_content: String(raw.delta ?? "") };
  }
  if (type === "response.output_item.added") {
    const item = raw.item ?? {};
    if (item.type === "image_generation_call") {
      return {
        image_url: "",
        metadata: { openai_image_call_id: String(item.id ?? "") },
      };
    }
    if (item.type === "reasoning") {
      return {
        reasoning_content: "",
        metadata: {
          reasoning_id: String(item.id ?? ""),
          encrypted_content: String(item.encrypted_content ?? ""),
        },
      };
    }
    if (item.type === "function_call") {
      return {
        tool_calls: [{
          index: Number(raw.output_index ?? 0),
          // 取 call_id(工具调用配对 id，spec 必填)；item.id(fc_…，输出条目 id)只作劣质
          // 中转缺 call_id 时的兜底。真值判定而非 ??：空串也要落到兜底(同 mergeToolCallDeltas)。
          id: String(item.call_id || item.id || ""),
          type: "function",
          function: {
            name: String(item.name ?? ""),
            arguments: String(item.arguments ?? ""),
          },
        }],
      };
    }
  }
  if (type === "response.output_item.done") {
    const item = raw.item ?? {};
    if (item.type === "image_generation_call") {
      return {
        image_url: String(item.result ?? ""),
        metadata: { openai_image_call_id: String(item.id ?? "") },
      };
    }
    if (item.type === "reasoning") {
      const summary = Array.isArray(item.summary)
        ? item.summary.map((part: any) => String(part?.text ?? "")).join("")
        : "";
      return {
        reasoning_content: summary,
        metadata: {
          reasoning_id: String(item.id ?? ""),
          encrypted_content: String(item.encrypted_content ?? ""),
        },
        _rikkahubSnapshot: true,
      };
    }
  }
  // 参数帧只认 call_id，绝不取 item_id——Responses 的 function_call 带两个语义不同的 id
  // (官方 OpenAPI FunctionToolCall):item.id 是【输出条目】id(fc_…，可选)，item.call_id 是
  // 【工具调用】配对 id(call_…，必填)；而 arguments.delta/done 两帧按 spec 只带 item_id
  // (即 fc_…)、根本没有 call_id 字段。取 item_id 当调用 id 会把已建槽的 call_… 改写成 fc_…：
  // ①流内已建的卡(call_…)从此收不到 tool_input_delta，参数永久空；②轮末循环层按 fc_… 另
  // 建一张卡 —— 一次调用落库两张卡，空参幽灵卡进第二轮历史编码即 400(火山 MissingParameter
  // input.arguments，2026-09-07 内测报障)。槽位对应本就靠 output_index，id 在此帧是冗余的。
  if (type === "response.function_call_arguments.delta") {
    return {
      tool_calls: [{
        index: Number(raw.output_index ?? 0),
        id: String(raw.call_id ?? ""),
        type: "function",
        function: { name: "", arguments: String(raw.delta ?? "") },
      }],
    };
  }
  if (type === "response.function_call_arguments.done") {
    return {
      tool_calls: [{
        index: Number(raw.output_index ?? 0),
        id: String(raw.call_id ?? ""),
        type: "function",
        function: { name: "", arguments: String(raw.arguments ?? "") },
        _rikkahubSnapshot: true,
      }],
    };
  }
  return null;
}

export function deltaTextContent(delta: any) {
  if (typeof delta.content === "string") return delta.content;
  if (typeof delta.text === "string") return delta.text;
  if (typeof delta.output_text === "string") return delta.output_text;
  if (Array.isArray(delta.content)) {
    return delta.content
      .map((item: any) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.delta === "string") return item.delta;
        return "";
      })
      .join("");
  }
  return "";
}

export function deltaReasoningContent(delta: any) {
  const direct = delta.reasoning_content ?? delta.reasoning ?? delta.thinking ?? delta.reasoning_text ?? delta.reasoning_summary;
  if (typeof direct === "string") return direct;
  if (Array.isArray(delta.content)) {
    return delta.content
      .map((item: any) => {
        if (typeof item?.thinking === "string") return item.thinking;
        if (Array.isArray(item?.thinking)) return item.thinking.map((x: any) => String(x?.text ?? "")).join("");
        if (item?.type === "reasoning" && typeof item?.text === "string") return item.text;
        return "";
      })
      .join("");
  }
  return "";
}

export async function readOpenAiStream(
  response: Response,
  onDelta: (delta: any, raw?: any) => { content?: string } | void,
  signal?: AbortSignal,
) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  for (;;) {
    if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
    // R3-1/R3-5:空闲看门狗改用统一 helper(三家一致);原文案写死"10min"与实际 120s 自相矛盾。
    const { done, value } = await readWithIdleTimeout(() => reader.read(), STREAM_IDLE_TIMEOUT_MS);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // 内测反馈(Kimi 流式卡顿排查):事件分隔统一认 CRLF——HTTP/SSE 规范允许 \r\n,上游或
    // 中间层用 \r\n\r\n 分隔时,旧 /\n\n+/ 整流切不开,全程攒 buffer 直到流结束才兜底
    // 解析(表现为一个字不出→最后哗啦全出)。与 readClaudeStreamingRound/Google reader 对齐。
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      for (const payload of parseSseChunks(part)) {
        if (payload === "[DONE]") continue;
        try {
          const raw = JSON.parse(payload);
          const delta = raw.choices?.[0]?.delta ?? raw.choices?.[0]?.message ?? responseEventToDelta(raw) ?? {};
          // 即使 delta 为空也要调 onDelta:OpenAI Chat Completions 流式的 final usage chunk
          // (choices 为空数组 → delta 为空对象)和 Responses API 的 response.completed 事件
          // (responseEventToDelta 返回 null → delta 为空)的 usage 只在这些"空 delta"包里出现,
          // 跳过就永远捕获不到(非流式回放版 readOpenAiSseTextIntoMessage 有对应分支)。
          const applied = onDelta(delta, raw);
          if (Object.keys(delta).length > 0) {
            full += (applied as any)?.content ?? deltaTextContent(delta);
          }
        } catch {
          // Ignore malformed stream fragments.
        }
      }
    }
  }
  for (const payload of parseSseChunks(buffer)) {
    if (payload === "[DONE]") continue;
    try {
      const raw = JSON.parse(payload);
      const delta = raw.choices?.[0]?.delta ?? raw.choices?.[0]?.message ?? responseEventToDelta(raw) ?? {};
      const applied = onDelta(delta, raw);
      if (Object.keys(delta).length > 0) {
        full += (applied as any)?.content ?? deltaTextContent(delta);
      }
    } catch {
      // Ignore malformed trailing stream fragments.
    }
  }
  return full;
}

export function applyOpenAiDelta(
  delta: any,
  rawEvent: any,
  hooks: StreamHooksWithSink,
  toolCalls: any[],
  assistant?: Assistant,
) {
  appendUsageFromRaw(hooks.message, rawEvent);
  let content = "";
  let reasoning = "";
  const isSnapshot = !!rawEvent?.choices?.[0]?.message;
  const deltaMetadata = isRecord(delta.metadata) ? delta.metadata as Record<string, JsonValue> : undefined;
  if (deltaMetadata && (deltaMetadata.reasoning_id || deltaMetadata.encrypted_content)) {
    ensureReasoningPart(hooks, deltaMetadata);
  }
  const reasoningDelta = deltaReasoningContent(delta);
  if (reasoningDelta) {
    const currentReasoning = (isSnapshot || delta._rikkahubSnapshot) ? visibleReasoningFromMessage(hooks.message) : "";
    const nextReasoning = (isSnapshot || delta._rikkahubSnapshot) && currentReasoning && reasoningDelta.startsWith(currentReasoning)
      ? reasoningDelta.slice(currentReasoning.length)
      : reasoningDelta;
    if (nextReasoning) {
      reasoning += nextReasoning;
      hooks.sink?.({ kind: "reasoning_delta", text: nextReasoning, metadata: deltaMetadata });
    }
  }
  const contentDelta = deltaTextContent(delta);
  if (contentDelta) {
    const currentText = isSnapshot ? visibleTextFromMessage(hooks.message) : "";
    const nextContent = isSnapshot && currentText && contentDelta.startsWith(currentText)
      ? contentDelta.slice(currentText.length)
      : contentDelta;
    if (nextContent) {
      content += nextContent;
      hooks.sink?.({ kind: "text_delta", text: nextContent });
    }
  }
  if (typeof delta.image_url === "string") {
    hooks.sink?.({ kind: "image_delta", url: delta.image_url, metadata: isRecord(delta.metadata) ? delta.metadata as Record<string, JsonValue> : {} });
  }
  if (Array.isArray(delta.tool_calls)) {
    const mode = isSnapshot || delta.tool_calls.some((call: any) => call?._rikkahubSnapshot) ? "snapshot" : "delta";
    mergeToolCallDeltas(toolCalls, delta.tool_calls, mode);
    // 流式(delta)模式下即时建卡+参数流(对齐 Claude reader 的 content_block_start /
    // input_json_delta 行为):此前 OpenAI 系工具调用在整轮流读完才由循环层建卡,而
    // write/edit 等工具的参数(整个文件内容)本身就是流式生成的,这段窗口可长达几十秒
    // ——期间思考卡持续计时、无任何工具反馈。id+name 齐备即宣告建卡(审批态用无参数
    // 下界,循环层 pre-scan 后经幂等更新上调终局);后续参数增量走 tool_input_delta。
    // snapshot(非流式/回放)模式无实时窗口,仍由循环层建卡。
    if (mode === "delta" && hooks.sink && hooks.message) {
      for (const call of toolCalls) {
        if (!call || typeof call !== "object") continue;
        const callId = String(call.id ?? "");
        const callName = String(call.function?.name ?? "");
        if (!callId || !callName) continue;
        const args = String(call.function?.arguments ?? "");
        if (!call._announced) {
          call._announced = true;
          finishReasoningParts(hooks.message);
          hooks.sink({
            kind: "tool_call_created",
            toolCallId: callId,
            toolName: callName,
            input: args,
            approvalState: assistant
              ? initialApprovalState(callName, assistant, hooks.conversation)
              : { type: "auto" },
          });
        } else if (args) {
          hooks.sink({ kind: "tool_input_delta", toolCallId: callId, input: args });
        }
      }
    }
  }
  return { content, reasoning };
}

export async function fetchOpenAiAuxiliaryStream(
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  providerItem: Provider,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
) {
  const started = Date.now();
  const response = await fetchWithTimeout(url, { method: "POST", headers: { ...headers, Accept: "text/event-stream" }, body: JSON.stringify(body), timeoutMs: AUX_STREAM_TIMEOUT_MS, signal });
  let text = "";
  if (response.ok) {
    text = await readOpenAiStream(response, (delta) => {
      const content = deltaTextContent(delta);
      onDelta(content);
      return { content };
    });
  } else {
    text = await response.text();
  }
  addLog({
    providerId: providerItem.id,
    providerName: providerItem.name,
    url,
    ok: response.ok,
    status: response.status,
    kind: "provider:aux:stream",
    durationMs: Date.now() - started,
    method: "POST",
    requestHeaders: headers,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    requestBody: jsonBody(body),
    responseBody: textBody(text),
    error: response.ok ? undefined : textBody(text),
  });
  if (!response.ok) throw upstreamHttpError(providerItem, url, response.status, text);
  return text.trim() || "(empty response)";
}

export async function fetchClaudeAuxiliaryStream(
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  providerItem: Provider,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
) {
  const started = Date.now();
  const response = await fetchWithTimeout(url, { method: "POST", headers: { ...headers, Accept: "text/event-stream" }, body: JSON.stringify(body), timeoutMs: AUX_STREAM_TIMEOUT_MS, signal });
  if (!response.ok) {
    const text = await response.text();
    addLog({
      providerId: providerItem.id,
      providerName: providerItem.name,
      url,
      ok: false,
      status: response.status,
      kind: "provider:aux:stream",
      durationMs: Date.now() - started,
      method: "POST",
      requestHeaders: headers,
      responseHeaders: Object.fromEntries(response.headers.entries()),
      requestBody: jsonBody(body),
      responseBody: textBody(text),
      error: textBody(text),
    });
    throw upstreamHttpError(providerItem, url, response.status, text);
  }
  const text = await readClaudeStream(response, (content) => {
    onDelta(content);
  });
  addLog({
    providerId: providerItem.id,
    providerName: providerItem.name,
    url,
    ok: true,
    status: response.status,
    kind: "provider:aux:stream",
    durationMs: Date.now() - started,
    method: "POST",
    requestHeaders: headers,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    requestBody: jsonBody(body),
    responseBody: textBody(text),
  });
  return text.trim() || "(empty response)";
}

export function claudeEventText(raw: any) {
  const type = String(raw?.type ?? "");
  const delta = raw?.delta ?? {};
  if (type === "content_block_delta") {
    if (delta.type === "text_delta") return String(delta.text ?? "");
    if (delta.type === "thinking_delta") return "";
  }
  if (type === "content_block_start") {
    const block = raw?.content_block ?? {};
    return block.type === "text" ? String(block.text ?? "") : "";
  }
  if (typeof delta.text === "string") return delta.text;
  return "";
}

export async function readClaudeStream(response: Response, onDelta: (text: string, raw?: any) => void, signal?: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  for (;;) {
    if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // 事件分隔认 CRLF,理由见 readOpenAiStream 同位置注释。
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      for (const payload of parseSseChunks(part)) {
        try {
          const raw = JSON.parse(payload);
          const text = claudeEventText(raw);
          if (!text) continue;
          full += text;
          onDelta(text, raw);
        } catch {
          // Ignore malformed Anthropic stream fragments.
        }
      }
    }
  }
  for (const payload of parseSseChunks(buffer)) {
    try {
      const raw = JSON.parse(payload);
      const text = claudeEventText(raw);
      if (!text) continue;
      full += text;
      onDelta(text, raw);
    } catch {
      // Ignore malformed trailing Anthropic stream fragments.
    }
  }
  return full;
}

export async function fetchGoogleAuxiliaryStream(
  url: string,
  headers: Record<string, string>,
  body: JsonValue | object,
  providerItem: Provider,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
) {
  const started = Date.now();
  const response = await fetchWithTimeout(url, { method: "POST", headers: { ...headers, Accept: "text/event-stream" }, body: JSON.stringify(body), timeoutMs: AUX_STREAM_TIMEOUT_MS, signal });
  const rawText = await response.text();
  addLog({
    providerId: providerItem.id,
    providerName: providerItem.name,
    url,
    ok: response.ok,
    status: response.status,
    kind: "provider:aux:stream",
    durationMs: Date.now() - started,
    method: "POST",
    requestHeaders: headers,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    requestBody: jsonBody(body),
    responseBody: textBody(rawText),
    error: response.ok ? undefined : textBody(rawText),
  });
  if (!response.ok) throw upstreamHttpError(providerItem, url, response.status, rawText);
  const chunks = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  let text = "";
  for (const chunk of chunks) {
    const delta = String(chunk?.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
    if (!delta) continue;
    text += delta;
    onDelta(delta);
  }
  return text.trim() || "(empty response)";
}

export function readOpenAiSseTextIntoMessage(rawText: string, hooks: StreamHooksWithSink, toolCalls: any[], assistant?: Assistant) {
  let content = "";
  let reasoning = "";
  for (const payload of parseSseChunks(rawText)) {
    if (payload === "[DONE]") continue;
    try {
      const raw = JSON.parse(payload);
      const delta = raw.choices?.[0]?.delta ?? raw.choices?.[0]?.message ?? responseEventToDelta(raw) ?? {};
      if (Object.keys(delta).length === 0) {
        appendUsageFromRaw(hooks.message, raw);
        continue;
      }
      const applied = applyOpenAiDelta(delta, raw, hooks, toolCalls, assistant);
      content += applied.content;
      reasoning += applied.reasoning;
    } catch {
      // Ignore malformed stream fragments, matching the streaming reader.
    }
  }
  return { content, reasoning };
}

export function compactAssistantToolMessage(content: string, toolCalls: any[], reasoningContent = "") {
  const payload: ApiMessage = {
    role: "assistant",
    content: content || "",
    tool_calls: toolCalls,
  };
  if (reasoningContent.trim()) payload.reasoning_content = reasoningContent.trim();
  return payload;
}

// ===== 流式续传回放纪律：只消费归一化密集数组（RoundResult.toolCalls）=====
// 流式 toolCalls 按上游 index/output_index 建槽，是潜在稀疏数组：Responses API 的
// output_index 语义是"输出序列位置"，reasoning/内置工具占号后 function_call 不从 0
// 起（必然产洞）；chat-completions 的 index 语义是"tool_calls 数组内序号"（规范上
// 从 0 连续，仅不规范中转会跳号）。洞经 JSON.stringify 变成续传体里的 null 项，
// 火山等严格端点直接 400（MissingParameter input.role，2026-09-05 内测报障）；且
// 原始条目缺 id 时与工具结果项的兜底 id 配对断裂。readRound 归一化已过滤洞/无名
// 并兜底 id，续传两分支一律经下面两个投影函数消费它，原始 replay 数组不得进续传体。

/** Responses API 续传的 function_call 回放项。arguments 再经 toolArgumentsJson:
 *  readRound 归一化已做过一次(幂等),这里重做一次是为了让"上线的 function_call 项
 *  恒非空参"成为本函数的局部性质——未来新 provider 若自建 NormalizedToolCall 而漏了
 *  归一化,也不会从这条路把空串送上去。 */
export function responseApiToolCallItems(toolCalls: NormalizedToolCall[]) {
  return toolCalls.map((call) => ({
    type: "function_call",
    call_id: call.id,
    name: call.name,
    arguments: toolArgumentsJson(call.arguments),
  }));
}

/** chat-completions 续传的 tool_calls 回放（OpenAI 嵌套形态）。arguments 同上归一。 */
export function chatToolCallsFromNormalized(toolCalls: NormalizedToolCall[]) {
  return toolCalls.map((call) => ({
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: toolArgumentsJson(call.arguments) },
  }));
}



export function extractToolNameFromArguments(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.name === "string") return parsed.name;
    if (typeof parsed?.tool_name === "string") return parsed.tool_name;
  } catch {
    // Leave the original tool name unchanged if arguments are partial or non-JSON.
  }
  return "";
}

export function mergeToolCallDeltas(existing: any[], deltaCalls: any[], mode: "delta" | "snapshot" = "delta") {
  for (const delta of deltaCalls) {
    const index = Number(delta.index ?? existing.length);
    const current = existing[index] ?? { id: "", type: "function", function: { name: "", arguments: "" } };
    const incomingName = String(delta.function?.name ?? "");
    const incomingArguments = String(delta.function?.arguments ?? "");
    const currentName = String(current.function?.name ?? "");
    const currentArguments = String(current.function?.arguments ?? "");
    const nextArguments = mode === "snapshot"
      ? (incomingArguments || currentArguments)
      : currentArguments + incomingArguments;
    const inferredName = !currentName && !incomingName ? extractToolNameFromArguments(nextArguments) : "";
    existing[index] = {
      ...current,
      // 真值判定而非 ??：Responses 流的 arguments.delta/done 帧 id 取自 item_id/call_id，
      // 帧上两者皆缺时为 ""——?? 会让空串覆盖 output_item.added 已写入的真 call_id，
      // 续传的 function_call/function_call_output 配对 id 全变空（火山等严格端点 400）。
      id: delta.id || current.id,
      type: delta.type ?? current.type,
      function: {
        name: incomingName || currentName || inferredName,
        arguments: nextArguments,
      },
    };
  }
}

export async function readOpenAiResponseIntoMessage(
  response: Response,
  hooks: StreamHooksWithSink,
  signal?: AbortSignal,
  assistant?: Assistant,
) {
  const toolCalls: any[] = [];
  const contentType = response.headers.get("content-type") ?? "";
  let content = "";
  let reasoning = "";
  let rawText = "";
  let raw: any = {};

  if (contentType.includes("text/event-stream")) {
    content = await readOpenAiStream(response, (delta, rawEvent) => {
      const applied = applyOpenAiDelta(delta, rawEvent, hooks, toolCalls, assistant);
      reasoning += applied.reasoning;
      return applied;
    }, signal);
  } else {
    rawText = await response.text();
    if (/^\s*data:/m.test(rawText)) {
      const streamed = readOpenAiSseTextIntoMessage(rawText, hooks, toolCalls, assistant);
      content = streamed.content;
      reasoning = streamed.reasoning;
      return { content, reasoning, toolCalls, rawText, raw };
    }
    try {
      raw = rawText ? JSON.parse(rawText) : {};
    } catch {
      raw = { text: rawText };
    }
    if (Array.isArray(raw.output)) {
      // Responses API 非流式(专题9,助手关闭"流式输出"):output 是文档序的项数组
      // (reasoning/message/function_call/image_generation_call),逐项发出等价事件。
      for (const item of raw.output) {
        if (!isRecord(item)) continue;
        const itemType = String(item.type ?? "");
        if (itemType === "reasoning") {
          const summary = Array.isArray(item.summary) ? item.summary : [];
          const text = summary.map((entry: any) => String(entry?.text ?? "")).filter(Boolean).join("\n");
          if (text) {
            reasoning += text;
            hooks.sink?.({ kind: "reasoning_delta", text });
          }
        } else if (itemType === "message") {
          const contentItems = Array.isArray(item.content) ? item.content : [];
          const text = contentItems
            .map((entry: any) => (isRecord(entry) && typeof entry.text === "string" ? entry.text : ""))
            .filter(Boolean)
            .join("");
          if (text) {
            content += text;
            hooks.sink?.({ kind: "text_delta", text });
          }
        } else if (itemType === "function_call") {
          mergeToolCallDeltas(toolCalls, [{
            index: toolCalls.length,
            // 同流式路径:call_id 优先(工具调用配对 id),item.id 仅缺失时兜底。
            id: String(item.call_id || item.id || ""),
            type: "function",
            function: { name: String(item.name ?? ""), arguments: String(item.arguments ?? "{}") },
          }], "snapshot");
        } else if (itemType === "image_generation_call" && typeof item.result === "string" && item.result) {
          hooks.sink?.({ kind: "image_delta", url: normalizeGeneratedImageUrl(item.result) });
        }
      }
      appendUsageFromRaw(hooks.message, raw);
      return { content, reasoning, toolCalls, rawText, raw };
    }
    const message = raw.choices?.[0]?.message ?? {};
    content = completionMessageText(raw);
    reasoning = String(message.reasoning_content ?? message.reasoning ?? "").trim();
    if (reasoning) hooks.sink?.({ kind: "reasoning_delta", text: reasoning });
    if (content) hooks.sink?.({ kind: "text_delta", text: content });
    if (Array.isArray(message.tool_calls)) {
      mergeToolCallDeltas(toolCalls, message.tool_calls.map((call: any, index: number) => ({ ...call, index })), "snapshot");
    }
    appendUsageFromRaw(hooks.message, raw);
  }

  return { content, reasoning, toolCalls, rawText, raw };
}

export async function fetchOpenAiTextStreaming(
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  providerItem: Provider,
  assistant: Assistant,
  hooks: StreamHooksWithSink,
  signal?: AbortSignal,
) {
  // P1-5:循环骨架统一到 runStreamingToolLoop,本函数只保留 OpenAI 特定的 Round Adapter。
  const useResponseInput = Array.isArray(body.input) && !Array.isArray(body.messages);
  let messages = [...(useResponseInput ? body.input ?? [] : body.messages ?? [])];
  const initialBody: Record<string, unknown> = useResponseInput ? { ...body, input: messages } : { ...body, messages };

  type OpenAiRoundReplay = Awaited<ReturnType<typeof readOpenAiResponseIntoMessage>>;

  const adapter: ProviderRoundAdapter = {
    providerItem,
    logUrl: url,
    logHeaders: headers,
    fetchRound: (requestBody, _round, sig) => fetch(url, {
      method: "POST",
      headers: requestBody.stream === false ? headers : { ...headers, Accept: "text/event-stream" },
      body: JSON.stringify(requestBody),
      signal: sig,
      // Bun timeout 由 net.ts fetch 拦截器统一注入 timeout:0(见 Claude 适配器处注释)。
    }),
    // R3-1:头超时统一 600s(原 OpenAI 自建包装,现下沉为骨架能力;用户需求 2026-08-01:
    // 非流式从 300s 对齐流式 600s——非流式响应头要等全文生成完,长思考模型误杀风险更高)。
    headerTimeoutMs: () => 600_000,
    async readRound(response, sig) {
      const r = await readOpenAiResponseIntoMessage(response, hooks, sig, assistant);
      // 稀疏数组洞与无名条目过滤:Responses API 流按 output_index 建槽,function_call 与
      // web_search_call 混发时索引不连续产生 undefined 洞(gpt-5.5 + web_search 崩溃 bug);
      // web_search_call 由 OpenAI 服务端执行,无需本地工具往返,跳过即正确行为。无名条目是
      // 非 function 输出项残留的幻影 delta。归一化时给缺失 id 生成兜底(原实现在建卡时生成;
      // executeTool 收到的 id 从"可能 undefined"变为兜底值,工具执行不依赖 id,无行为影响)。
      const normalized: NormalizedToolCall[] = [];
      for (const toolCall of r.toolCalls) {
        if (!toolCall || typeof toolCall !== "object") continue;
        if (!toolCall.function?.name) continue;
        // 兜底须覆盖空串（?? 只接 null/undefined）：流帧的 id 恒经 String(… ?? "")
        // 归一，缺失时是 "" 而非 undefined，旧写法会把空串原样放行，续传配对
        // call_id 全空（严格端点 400）。
        const rawId = String(toolCall.id ?? "").trim();
        normalized.push({
          id: rawId || id(),
          name: String(toolCall.function?.name ?? ""),
          // 同 id 的空串问题:arguments 缺失时流帧给的是 ""(不是 undefined),?? 接不住。
          // 归一到 "{}" —— 空串既非合法 JSON、也过不了严格端点的必填校验。
          arguments: toolArgumentsJson(toolCall.function?.arguments),
        });
      }
      return { text: r.content, toolCalls: normalized, replay: r };
    },
    encodeNextTurn(result, toolResults) {
      const r = result.replay as OpenAiRoundReplay;
      const toolMessages = toolResults.map(({ call, output }) => {
        const toolPart: ToolPart = {
          type: "tool",
          toolCallId: call.id,
          toolName: call.name,
          input: call.arguments,
          output,
          approvalState: initialApprovalState(call.name, assistant, hooks.conversation),
        };
        return useResponseInput
          ? { type: "function_call_output", call_id: call.id, output: toolResultTextForApi(toolPart) }
          : { role: "tool", tool_call_id: call.id, content: toolResultTextForApi(toolPart) };
      });
      if (useResponseInput) {
        // 用归一化密集数组（与 toolMessages 的 call.id 同源，配对恒成立；勿用 r.toolCalls
        // 原始稀疏数组——洞会序列化成 input 的 null 项，见 responseApiToolCallItems 头注）。
        messages = [...messages, ...responseApiToolCallItems(result.toolCalls), ...toolMessages];
        return { ...body, input: messages, stream: true };
      }
      messages = [
        ...messages,
        // 同 responses 分支纪律:用归一化密集数组(见回放纪律节注),不规范中转跳号
        // 建槽的洞不得进 tool_calls。
        compactAssistantToolMessage(r.content, chatToolCallsFromNormalized(result.toolCalls), r.reasoning || reasoningFromParts(hooks.message?.parts ?? [])),
        ...toolMessages,
      ];
      return { ...body, messages, stream: true };
    },
    logResponseBody(result) {
      const r = result.replay as OpenAiRoundReplay;
      return textBody(r.rawText || r.content || JSON.stringify({
        toolCalls: r.toolCalls.map((toolCall: any) => ({
          id: toolCall?.id,
          name: toolCall?.function?.name,
          argumentsLength: String(toolCall?.function?.arguments ?? "").length,
        })),
        reasoningLength: r.reasoning.length,
      }));
    },
    joinTextWithNewline: false,
    toolCardsCreatedInStream: false,
    finishReasoningOnFinal: false,
    exhaustedError: "Too many consecutive tool calls without final assistant content",
    // steering 注入(用户问题②):user turn 追加进请求体消息序列。Responses 形态的
    // input 条目用 {role:"user",content} 通用形状(官方 Responses 接受简写),chat
    // completions 形态走 messages——两种形态都在工具结果之后,与 Codex pending_input
    // 的排水位对齐。
    appendSteeringUserTurns: (requestBody, texts) => {
      const userTurns = texts.map((text) => ({ role: "user", content: text }));
      if (useResponseInput) {
        const input = [...(Array.isArray(requestBody.input) ? requestBody.input : []), ...userTurns];
        return { ...requestBody, input };
      }
      const messagesArr = [...(Array.isArray(requestBody.messages) ? requestBody.messages : []), ...userTurns];
      return { ...requestBody, messages: messagesArr };
    },
    // 专题9:助手关闭"流式输出"时的整程非流式(与下方降级用同一改造)。
    makeNonStreamBody: (requestBody) => ({ ...requestBody, stream: false, stream_options: undefined }),
    nonStreamFallback: {
      // stream_options: undefined 会被 JSON.stringify 丢弃,与原实现一致
      makeBody: (requestBody) => ({ ...requestBody, stream: false, stream_options: undefined }),
      connectHint: "\n流式连接失败，正在按非流式重试...",
      interruptHint: "\n流式连接中断，正在按非流式重试...",
    },
  };
  return runStreamingToolLoop(adapter, initialBody, assistant, signal, hooks);
}
