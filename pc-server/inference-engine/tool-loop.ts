// inference-engine/tool-loop.ts — 统一流式工具循环骨架（P1-5，方案见 项目重构方案.md「P1-5 方案」）
//
// 三家 provider（OpenAI/Claude/Google）的流式工具循环骨架原本各写一遍、逐字重复约 60%——
// 任何流式/工具循环 bug 都要修三遍。本模块吸收全部共同骨架：
//   轮次推进(MAX_TOOL_STEPS) / abort 检查 / fetch / 错误与成功请求日志 / usage 下沉 /
//   文本累积 / 工具卡创建(未在流内建卡的 provider) / 审批 pre-scan bail / 工具执行分发 /
//   非流式降级重试(可选能力) / 超限抛错。
// Provider 差异经 ProviderRoundAdapter 注入：单轮流解析、工具调用归一、下一轮编码(回放
// assistant 轮 + 工具结果轮的 provider 特定格式)、日志载荷、若干参数化的差异点位。
//
// 骨架搬迁纪律：本文件从三个旧循环逐字搬迁共同骨架。批次三(R3-1/R3-4)在此兑现了
// tool-loop 原注释预告的"行为修复单独提交":
//   · R3-1 头超时 + signal 桥接由骨架统一(headerTimeoutMs),Claude/Google 不再裸奔;
//   · R3-4 工具执行 for 循环每迭代查 signal.aborted,三家一致(删除 abortCheckAfterRead
//     冻结点——此前 Claude/Google 停止后本轮工具仍会执行,违背用户"停止"心智)。
// 其余仍为纯参数化差异(文案/编码格式等),不做无谓统一。
import type { Assistant, Message, Provider } from "../foundation/types";
import { initialApprovalState } from "../tools/approval";
import { toolExecutionErrorPayload } from "../tools/format";
import { finishReasoningParts } from "./parts";
import type { StreamHooksWithSink, ToolCall, ToolDispatchContext, ToolResult } from "./events";
import type { ToolOutputEntry, ToolPart } from "../foundation/types";
import { jsonBody, textBody } from "../model-providers";
import { addLog } from "../api/logs";
import { touchStream } from "../api/sse";
import { isRecord } from "../foundation/utils";

// 专题11-P1-3:usage 合并语义对齐安卓 Usage.merge——新值>0 才覆盖,否则保留旧值。
// 流式/多轮场景里,后到的 usage 事件缺某字段(如 Google 末尾 chunk 不带
// cachedContentTokenCount)时不能把已知的缓存命中数清零——这是“命中数有时不显示”
// 的根因之一。contextLimit 随旧值保留(新值有则用新值),避免重查 models.dev。
export function mergeTokenUsage(prev: Message["usage"], next: Message["usage"]): Message["usage"] {
  if (!next || typeof next !== "object") return prev;
  if (!prev || typeof prev !== "object") return next;
  const prevRec = prev as Record<string, unknown>;
  const nextRec = next as Record<string, unknown>;
  const pick = (key: string) => {
    const value = Number(nextRec[key] ?? 0);
    return value > 0 ? value : Number(prevRec[key] ?? 0) || 0;
  };
  const contextLimit = nextRec.contextLimit !== undefined ? nextRec.contextLimit : prevRec.contextLimit;
  // generationMs 单调累计(骨架每轮发的都是至今总和),新值>0 覆盖语义天然正确。
  const generationMs = pick("generationMs");
  return {
    promptTokens: pick("promptTokens"),
    completionTokens: pick("completionTokens"),
    totalTokens: pick("totalTokens"),
    cachedTokens: pick("cachedTokens"),
    ...(contextLimit !== undefined ? { contextLimit: contextLimit as number | null } : {}),
    ...(generationMs > 0 ? { generationMs } : {}),
  };
}

export const MAX_TOOL_STEPS = 256;

// R3-1:主对话流的空闲看门狗预算。上游黑洞(TCP 通但永不回头,或流中途静默不断连——
// 劣质中转站常见)时,若无此上限 reader.read() 永久悬挂,generating 卡死、挡住 working-set
// 清扫且不可自愈。三家流式 reader 统一走 readWithIdleTimeout 包装(此前仅 OpenAI 有;
// 包装函数已于专题7下沉到 foundation/net.ts 供全库复用)。
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

// R3-1:头超时 + 外部 signal 桥接。下沉自 OpenAI adapter 的 fetchRound 包装,现为骨架能力,
// 三家共用。响应头到达(fetch settle)即 cleanup 清定时器、摘外部 abort 监听——之后的流式
// 读阶段由各 reader 直接轮询外部 signal 处理用户停止(见 readRound),不依赖本 controller。
async function fetchRoundWithHeaderTimeout(
  adapter: ProviderRoundAdapter,
  requestBody: Record<string, unknown>,
  round: number,
  externalSignal: AbortSignal | undefined,
  nonStream: boolean,
): Promise<Response> {
  const timeoutMs = adapter.headerTimeoutMs(requestBody, nonStream);
  if (timeoutMs <= 0) return adapter.fetchRound(requestBody, round, externalSignal, nonStream);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let abortHandler: (() => void) | null = null;
  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    if (externalSignal && abortHandler) externalSignal.removeEventListener("abort", abortHandler);
  };
  if (externalSignal) {
    abortHandler = () => controller.abort(externalSignal.reason);
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener("abort", abortHandler, { once: true });
  }
  timeout = setTimeout(
    () => controller.abort(new Error(`响应头超时:${Math.round(timeoutMs / 1000)}s 内未收到上游响应`)),
    timeoutMs,
  );
  return adapter.fetchRound(requestBody, round, controller.signal, nonStream).finally(cleanup);
}

export function toolCallContext(hooks?: StreamHooksWithSink): ToolDispatchContext | undefined {
  if (!hooks?.conversation) return undefined;
  return {
    conversationId: hooks.conversation.id,
    conversationTitle: hooks.conversation.title || undefined,
    messageNodeId: hooks.node?.id,
    executeTool: hooks.executeTool,
  };
}

/** 归一化的工具调用（三家提取形状 tool_use / functionCall / toolCalls 统一到此）。 */
export interface NormalizedToolCall {
  id: string;
  name: string;
  /** JSON string（与 OpenAI function.arguments 对齐；Claude/Google 的对象入参由 adapter 序列化）。 */
  arguments: string;
}

/** 单轮请求的解析结果。replay 是 adapter 私有的回放载荷（如 Claude 的 content blocks、
 *  Google 的 modelParts、OpenAI 的 raw toolCalls 数组），骨架原样传给 encodeNextTurn。 */
export interface RoundResult {
  text: string;
  usage?: Message["usage"];
  toolCalls: NormalizedToolCall[];
  replay: unknown;
}

export interface ExecutedToolResult {
  call: NormalizedToolCall;
  output: ToolOutputEntry[];
}

export interface ProviderRoundAdapter {
  providerItem: Provider;
  /** 请求日志的 url 字段。 */
  logUrl: string;
  /** 请求日志的 requestHeaders 字段。 */
  logHeaders: Record<string, string>;
  /** 发起单轮请求。骨架统一负责"头超时 + 外部 signal 桥接"(R3-1),传入桥接后的 signal;
   *  adapter 只管拼 url/headers/body 并把 signal 透传给 fetch。 */
  fetchRound(requestBody: Record<string, unknown>, round: number, signal: AbortSignal | undefined, nonStream?: boolean): Promise<Response>;
  /** 本轮"响应头超时"预算(ms):上游 TCP 通但迟迟不回响应头时的看门狗;返回 0 表示禁用。
   *  下沉自 OpenAI,三家统一后 Claude/Google 主链路不再无超时裸奔;现三家流式/非流式
   *  均取 600s(2026-08-01 非流式对齐流式)。 */
  headerTimeoutMs(requestBody: Record<string, unknown>, nonStream?: boolean): number;
  /** 读取并解析单轮响应，流内增量经 hooks/sink 下沉。nonStream=true 时响应体是一次性
   *  JSON(非 SSE),reader 需按非流式解析并一次性发出等价事件(专题9)。 */
  readRound(response: Response, signal: AbortSignal | undefined, nonStream?: boolean): Promise<RoundResult>;
  /** 编码下一轮请求 body：回放本轮 assistant 轮 + 工具结果轮（provider 特定格式）。 */
  encodeNextTurn(result: RoundResult, toolResults: ExecutedToolResult[]): Record<string, unknown>;
  /** 成功轮的响应日志载荷。 */
  logResponseBody(result: RoundResult): string;
  /** 文本累积是否用换行分隔（Claude/Google: true；OpenAI: false 直接拼接）。 */
  joinTextWithNewline: boolean;
  /** 工具卡是否已在流内创建（Claude/Google: true；OpenAI: false → 骨架在循环层建卡）。 */
  toolCardsCreatedInStream: boolean;
  /** 无工具调用最终返回前的收尾（Claude/Google: finishReasoningParts；OpenAI: 无）。 */
  finishReasoningOnFinal: boolean;
  /** MAX_TOOL_STEPS 超限的报错文案（三家文案不同，冻结）。 */
  exhaustedError: string;
  /** steering 注入(用户问题②,对齐 Codex pending_input):把「生成中补发」的用户消息
   *  编码为 provider 特定的 user turn 追加进下一轮请求体(OpenAI messages / Responses
   *  input / Claude messages / Google contents)。骨架在轮边界(工具批执行完、下一轮
   *  fetch 前)调用;不实现 = 该 provider 无注入能力(消息留在 FIFO 队列收尾派发兜底)。 */
  appendSteeringUserTurns?(body: Record<string, unknown>, texts: string[]): Record<string, unknown>;
  /** 专题9:助手"流式输出"开关关闭时的非流式请求体改造(对齐安卓 GenerationHandler 的
   *  stream = assistant.streamOutput)。三家均实现;与 nonStreamFallback(流式失败自动
   *  降级,仅 OpenAI)正交——本能力由用户显式选择,从第一轮起全程非流式。 */
  makeNonStreamBody?(body: Record<string, unknown>): Record<string, unknown>;
  /** 流式失败降级为非流式重试（仅 OpenAI）。makeBody 把请求体改造为非流式形态。 */
  nonStreamFallback?: {
    makeBody(body: Record<string, unknown>): Record<string, unknown>;
    /** fetch 本身失败（连接失败）时的提示，追加 detail。 */
    connectHint: string;
    /** 读流中断时的提示。 */
    interruptHint: string;
  };
}

function logRound(
  adapter: ProviderRoundAdapter,
  round: number,
  startedAt: number,
  requestBody: Record<string, unknown>,
  fields: { ok: boolean; status: number; responseHeaders?: Record<string, string>; responseBody: string; error?: string },
): void {
  addLog({
    providerId: adapter.providerItem.id,
    providerName: adapter.providerItem.name,
    url: adapter.logUrl,
    ok: fields.ok,
    status: fields.status,
    kind: round === 0 ? "provider:chat:stream" : "provider:chat:tool_result:stream",
    durationMs: Date.now() - startedAt,
    method: "POST",
    requestHeaders: adapter.logHeaders,
    ...(fields.responseHeaders ? { responseHeaders: fields.responseHeaders } : {}),
    requestBody: jsonBody(requestBody),
    responseBody: fields.responseBody,
    ...(fields.error !== undefined ? { error: fields.error } : {}),
  });
}

/** 统一流式工具循环。返回最终 assistant 文本（与三个旧循环的返回值语义逐字一致）。 */
export async function runStreamingToolLoop(
  adapter: ProviderRoundAdapter,
  initialBody: Record<string, unknown>,
  assistant: Assistant,
  signal: AbortSignal | undefined,
  hooks: StreamHooksWithSink,
): Promise<string> {
  let currentBody = initialBody;
  let allContent = "";
  let forceNonStream = false;
  // 纯生成耗时累计(usage.generationMs):每轮"发请求→流读完"的成功轮时长之和。轮间
  // 工具执行/审批不在计时窗内;失败轮(fetch 或读流抛错后降级重试)不计——统计行
  // token/s 的语义是模型生成吞吐,等待与重试损耗不摊进去。
  let generationMs = 0;
  // 专题9:助手"流式输出"关闭 → 从第一轮起就按非流式请求(工具循环的每一轮都非流式)。
  // 用户显式选择时 nonStreamFallback 的降级重试不再适用(已经是非流式,降无可降)。
  const userNonStream = assistant.streamOutput === false && adapter.makeNonStreamBody != null;

  // steering 轮边界(用户问题②,对齐 Codex「Pending input is drained into history before
  // building the next model request」):把本轮回放进请求体后,向协调器要「生成中补发」的
  // 用户消息文本,由 adapter 编码成 user turn 追加。协调器在同一调用里落库 steer user、把
  // 落点换到新节点、联动 FIFO 队列(副作用不进引擎层);本函数只拿纯文本。命中即分段:
  // 返回文本与生成耗时都切到「当前气泡」口径。adapter 无注入能力时不排水(排水即分裂,
  // 不能注入就不能分裂——消息留在队列由收尾派发兜底)。返回 true = 有注入,循环需继续。
  const absorbSteering = (result: RoundResult, toolResults: ExecutedToolResult[]): boolean => {
    if (!adapter.appendSteeringUserTurns) return false;
    const steerTexts = hooks.onSteerBoundary?.() ?? [];
    if (steerTexts.length === 0) return false;
    currentBody = adapter.appendSteeringUserTurns(adapter.encodeNextTurn(result, toolResults), steerTexts);
    allContent = "";
    generationMs = 0;
    return true;
  };

  for (let round = 0; round < MAX_TOOL_STEPS; round += 1) {
    if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
    const roundStarted = Date.now();
    const nonStreamRound = userNonStream || (forceNonStream && adapter.nonStreamFallback != null);
    const requestBody = userNonStream
      ? adapter.makeNonStreamBody!(currentBody)
      : forceNonStream && adapter.nonStreamFallback
        ? adapter.nonStreamFallback.makeBody(currentBody)
        : currentBody;

    let response: Response;
    try {
      response = await fetchRoundWithHeaderTimeout(adapter, requestBody, round, signal, nonStreamRound);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logRound(adapter, round, roundStarted, requestBody, { ok: false, status: 0, responseBody: "", error: detail });
      if (adapter.nonStreamFallback && !forceNonStream && !userNonStream && !signal?.aborted) {
        forceNonStream = true;
        hooks.sink?.({ kind: "reasoning_delta", text: `${adapter.nonStreamFallback.connectHint} ${detail}` });
        round -= 1;
        continue;
      }
      throw err;
    }

    if (!response.ok) {
      const text = await response.text();
      logRound(adapter, round, roundStarted, requestBody, {
        ok: false,
        status: response.status,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        responseBody: textBody(text),
        error: textBody(text),
      });
      throw new Error(`${adapter.providerItem.name} ${response.status}: ${text.slice(0, 500)}`);
    }

    let result: RoundResult;
    try {
      result = await adapter.readRound(response, signal, nonStreamRound);
    } catch (err) {
      logRound(adapter, round, roundStarted, requestBody, {
        ok: false,
        status: response.status,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        responseBody: "",
        error: err instanceof Error ? err.message : String(err),
      });
      if (adapter.nonStreamFallback && !forceNonStream && !userNonStream && !signal?.aborted) {
        forceNonStream = true;
        hooks.sink?.({ kind: "reasoning_delta", text: adapter.nonStreamFallback.interruptHint });
        round -= 1;
        continue;
      }
      throw err;
    }

    generationMs += Date.now() - roundStarted;
    if (hooks.message) {
      // 即使本轮上游未回报 usage 也要下沉 generationMs 累计值:token 字段给 0,
      // mergeTokenUsage 的 pick 语义会保留已知旧值,不会清零。
      const roundUsage = result.usage && typeof result.usage === "object" && !Array.isArray(result.usage) ? result.usage : {};
      const usagePayload = {
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        ...roundUsage,
        generationMs,
      };
      if (hooks.sink) hooks.sink({ kind: "usage", usage: usagePayload });
      else hooks.message.usage = mergeTokenUsage(hooks.message.usage, usagePayload);
    }

    logRound(adapter, round, roundStarted, requestBody, {
      ok: true,
      status: response.status,
      responseHeaders: Object.fromEntries(response.headers.entries()),
      responseBody: adapter.logResponseBody(result),
    });

    if (adapter.joinTextWithNewline) {
      if (result.text) allContent += `${allContent ? "\n" : ""}${result.text}`;
    } else {
      allContent += result.text;
    }

    // R3-4:读流结束后统一检查 abort(此前仅 OpenAI 查)。流读取期间的 abort 只中断网络,
    // 若恰在"读完→执行工具"窗口停止,不查就会照常执行本轮工具。
    if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");

    if (result.toolCalls.length === 0) {
      if (adapter.finishReasoningOnFinal) finishReasoningParts(hooks.message!);
      // 最终轮也是边界(Codex needs_follow_up = model_needs_follow_up || has_pending_input):
      // 模型答完时若有补发待处理,不结束本次生成、不等收尾派发重开一条——在同一生成内
      // 回放本轮 assistant 正文 + 追加补发 user turn,再采样一轮。用户视角:ai_1 定格、
      // user_2 落下、ai_2 接着答,与工具轮边界的形态完全一致;停止键仍指向同一条流。
      if (absorbSteering(result, [])) {
        round -= 1; // 用户插话触发的再采样不占工具轮预算(预算防的是模型失控循环)
        continue;
      }
      return allContent.trim() || "(empty response)";
    }

    // 审批 pre-scan：批内任一工具需要用户审批就整批不执行（避免部分执行后下一轮缺
    // tool_result）。此刻流已读完、参数齐备，这里是审批的终局判定（工作区工具在
    // balanced 档依赖参数：危险命令/区外写入才审批）。generateAnswer 看到
    // hasPendingToolApproval 会暂停等用户决定。
    const approvalByCall = new Map(
      result.toolCalls.map((call) => [call.id, initialApprovalState(call.name, assistant, hooks.conversation, call.arguments)] as const),
    );
    const hasPendingInBatch = [...approvalByCall.values()].some((state) => state.type === "pending");
    // 流内建卡的 provider（Claude）在参数未到时用无参数下界建卡；终局若上调为
    // pending，把卡状态同步上去（只升不降，auto 卡才会被改写）。Google 的函数调用
    // 整体到达、建卡即终局，此处的重复 pending 同步幂等无害。
    if (adapter.toolCardsCreatedInStream && hooks.message) {
      for (const call of result.toolCalls) {
        const finalState = approvalByCall.get(call.id)!;
        if (finalState.type !== "pending") continue;
        if (hooks.sink) {
          hooks.sink({ kind: "tool_approval_updated", toolCallId: call.id, approvalState: finalState });
        } else {
          hooks.message.parts = hooks.message.parts.map((part) => {
            if (!isRecord(part) || part.type !== "tool" || part.toolCallId !== call.id) return part;
            const current = isRecord(part.approvalState) ? String(part.approvalState.type ?? "") : "";
            return current === "auto" || current === "pending" ? { ...part, approvalState: finalState } : part;
          });
        }
      }
      if (hasPendingInBatch) touchStream(hooks);
    }
    const dispatchCtx = toolCallContext(hooks);
    const toolResults: ExecutedToolResult[] = [];

    for (const call of result.toolCalls) {
      // R3-4:每个工具执行前查停止——用户看到工具卡即点停止时,不再执行剩余工具的副作用
      // (MCP 写操作/剪贴板/TTS 等)。已建卡的工具保留为无输出态落库,orchestrator 正常收尾。
      if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
      if (!adapter.toolCardsCreatedInStream && hooks.message) {
        // 流内不建卡的 provider（OpenAI）：循环层创建工具卡（pending 时也要渲染卡）
        const toolPart: ToolPart = {
          type: "tool",
          toolCallId: call.id,
          toolName: call.name,
          input: call.arguments,
          output: [],
          // 循环层建卡时参数已齐，直接用终局审批态（含缘由）
          approvalState: approvalByCall.get(call.id) ?? initialApprovalState(call.name, assistant, hooks.conversation, call.arguments),
        };
        finishReasoningParts(hooks.message);
        hooks.sink?.({
          kind: "tool_call_created",
          toolCallId: toolPart.toolCallId,
          toolName: toolPart.toolName,
          input: String(toolPart.input),
          approvalState: toolPart.approvalState,
        });
        touchStream(hooks);
      }
      if (hasPendingInBatch) continue;

      const toolCall: ToolCall = { id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } };
      let toolResult: ToolResult;
      try {
        toolResult = await dispatchCtx!.executeTool!(toolCall, dispatchCtx);
      } catch (err) {
        toolResult = { output: [toolExecutionErrorPayload(err)] };
      }
      const outputParts = toolResult.output;
      if (hooks.message) {
        if (hooks.sink) {
          hooks.sink({ kind: "tool_result", toolCallId: call.id, output: outputParts });
        } else {
          hooks.message.parts = hooks.message.parts.map((part) => {
            if (!isRecord(part) || part.type !== "tool" || part.toolCallId !== call.id) return part;
            return { ...part, input: call.arguments, output: outputParts };
          });
          touchStream(hooks);
        }
      }
      toolResults.push({ call, output: outputParts });
    }

    if (hasPendingInBatch) {
      return allContent.trim() || "";
    }

    // 工具轮边界:注入发生在本轮所有工具结果之后——与 Codex 的 pending_input 排水位
    // (assistant 轮回放 + 工具结果 + 用户补发)逐字对齐。无注入时照常编码下一轮。
    if (!absorbSteering(result, toolResults)) currentBody = adapter.encodeNextTurn(result, toolResults);
  }

  throw new Error(adapter.exhaustedError);
}

