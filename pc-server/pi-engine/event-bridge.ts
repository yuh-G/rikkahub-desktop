// pi-engine/event-bridge.ts — pi AgentSessionEvent → 我们的 GenerationEvent 映射桥(P2)
//
// 定位:pi 会话是"另一个产生 GenerationEvent 的引擎"。桥只做纯映射(无 I/O、无落库、
// 无广播),产出交给与聊天引擎同源的应用器(conversations/generation-apply.ts)——
// parts 形状、touchStream 落库/合帧广播、幂等规则由那里统一保证,写入面零新增。
//
// 映射字典(方案 §4.5,对照 pi/packages/agent/src/types.ts:422 AgentEvent 与
// coding-agent/src/core/agent-session.ts:139 AgentSessionEvent 全联合校准):
//   message_update.text_delta      → text_delta
//   message_update.thinking_delta  → reasoning_delta
//   message_update.toolcall_start/delta/end → tool_call_created(id/name 齐备即建卡,
//     幂等)+ tool_input_delta(参数增量)+ 终局 tool_call_created(完整参数)
//   tool_execution_start           → tool_call_created(兜底幂等建卡,approvalState auto)
//   tool_execution_update          → tool_result(partialResult.content 全量快照替换;
//     单 text 条目恰好命中 node-delta 的 isStreamableToolPart 快路,SSE 走 text_delta 帧)
//   tool_execution_end             → tool_result(成功 → content 映射;失败 → {error} 载荷,
//     与聊天引擎 toolExecutionErrorPayload 的历史契约形状一致)
//   result.details.workspace       → 首个 text 条目的 metadata.workspace(P3:我们的
//     customTools 打包的 diff/exitCode 等结构化细节,还原口径与聊天引擎
//     runtime.toToolResult 逐字一致——前端渲染器与安卓导出适配层吃同一形状)
//   bash_execution_update          → tool_result(增量累加;仅当该工具卡未被
//     tool_execution_update 通道认领,防双写。P3 我们的 bash customTool 若经
//     session.executeBash({id: toolCallId}) 流式输出,即由此通道回写)
//   message_end(assistant)         → engine_fidelity(P7:块结构/签名注解,先发)
//                                    + usage(pi Usage → 我们的 TokenUsage 口径,P5 精化)
//   agent_end                      → 无 part 操作;终局结果经 outcome() 由 runner 消费
//   compaction_*/auto_retry_*/summarization_retry_* → P2 无 part 操作(P5 接会话状态 UI)
//   其余生命周期/队列/条目事件      → 无 part 操作
//
// 升级 pi 的回归门:switch 对 event.type 穷举 + never 断言,pi 新增事件类型会让我们的
// typecheck 直接失败,倒逼重新校准本字典(方案 §〇 "升级 pi = 重新 vendor + 跑桥契约测试")。

import type { AgentSessionEvent } from "../../pi/packages/coding-agent/src/core/agent-session.ts";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  ImageContent,
  TextContent,
  Usage as PiUsage,
} from "../../pi/packages/ai/src/types.ts";
import type { EngineFidelityBlock, GenerationEvent } from "../inference-engine/events";
import type { JsonValue, ToolOutputEntry } from "../foundation/types";
import { reportError } from "../observability/app-errors";

/** pi Usage → 我们的 TokenUsage(conversations/helpers ensureUsage 同形)。
 *  口径:promptTokens 含缓存读写(对齐 OpenAI prompt_tokens 语义);cachedTokens=cacheRead。
 *  P5 统计对齐阶段按 provider 逐一精化(方案 §六 P5-2)。 */
export function mapPiUsage(usage: PiUsage): Record<string, JsonValue> {
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  return {
    promptTokens,
    completionTokens: usage.output,
    totalTokens: usage.totalTokens > 0 ? usage.totalTokens : promptTokens + usage.output,
    cachedTokens: usage.cacheRead,
  };
}

/** pi 工具产出(text/image)→ 我们的 ToolOutputEntry。image 是 base64 裸数据,
 *  封装成 data URL(前端 ImagePart 渲染契约)。 */
export function mapPiToolContent(content: readonly (TextContent | ImageContent)[]): ToolOutputEntry[] {
  const entries: ToolOutputEntry[] = [];
  for (const item of content) {
    if (item.type === "text") entries.push({ type: "text", text: item.text });
    else if (item.type === "image") entries.push({ type: "image", url: `data:${item.mimeType};base64,${item.data}` });
  }
  return entries;
}

function contentText(content: readonly (TextContent | ImageContent)[]): string {
  return content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

/** pi 工具结果的宽松视图(AgentToolResult;details 只认我们 customTools 打的两种标记:
 *  {workspace:{tool,details}}(工作区工具,还原为 part metadata)与
 *  {app:{output}}(通用工具/MCP 桥,entries 整批还原),其他引擎侧 details 不进 part)。 */
interface PiToolResultView {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
}

function workspaceMetadataOf(details: unknown): Record<string, JsonValue> | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const workspace = (details as Record<string, unknown>).workspace;
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return null;
  return { workspace: workspace as JsonValue };
}

/** 通用工具桥的 {app:{output}} 标记:general-tools 已把聊天引擎实体化产物
 *  (realizeToolResult,含 /api/files 图片 URL)原样打包,直接作为 part.output——
 *  UI 渲染契约与聊天引擎逐字一致,不经 pi content 往返(那会把文件 URL 图降级)。 */
function appOutputOf(details: unknown): ToolOutputEntry[] | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const app = (details as Record<string, unknown>).app;
  if (!app || typeof app !== "object" || Array.isArray(app)) return null;
  const output = (app as Record<string, unknown>).output;
  return Array.isArray(output) ? (output as ToolOutputEntry[]) : null;
}

/** 工具结果 → ToolOutputEntry[](tool_execution_update/end 共用)。metadata 附着规则
 *  与聊天引擎 runtime.toToolResult 逐字一致:挂首个 text 条目;无 text 条目而 details
 *  存在时,补一个空 text 载体。
 *  P7 来源标记:{app:{output}} 通道(通用工具实体化产物)在首条目 metadata 打
 *  pi:{src:"app"}——模型面文本是 openAiToolOutput(entries) 的再计算产物,与工作区
 *  工具"逐字 content"通道在多条目时不可从形状区分,捕获时标记供 DB→pi 重建选路。 */
export function mapPiToolResult(result: PiToolResultView | undefined): ToolOutputEntry[] {
  const appOutput = appOutputOf(result?.details);
  if (appOutput) {
    const [first, ...rest] = appOutput;
    if (!first || typeof first !== "object") return appOutput;
    const firstRecord = first as Record<string, unknown>;
    const existingMeta =
      firstRecord.metadata && typeof firstRecord.metadata === "object" && !Array.isArray(firstRecord.metadata)
        ? (firstRecord.metadata as Record<string, JsonValue>)
        : {};
    const marked = { ...firstRecord, metadata: { ...existingMeta, pi: { src: "app" } } } as unknown as ToolOutputEntry;
    return [marked, ...rest];
  }
  const entries = result?.content?.length ? mapPiToolContent(result.content) : [];
  const metadata = workspaceMetadataOf(result?.details);
  if (!metadata) return entries;
  const firstText = entries.find(
    (entry): entry is Extract<ToolOutputEntry, { type: "text" }> =>
      typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "text",
  );
  if (firstText) firstText.metadata = metadata;
  else entries.push({ type: "text", text: "", metadata });
  return entries;
}

/** 桥观察到的会话终局(runner 据此决定 return / throw)。 */
export interface PiBridgeOutcome {
  /** 最后一条 assistant 消息的 stopReason(未见到则 null)。 */
  stopReason: string | null;
  /** stopReason 为 error 时的错误文案。 */
  errorMessage: string | null;
  /** 全程累计的 assistant 可见文本(runner 的返回值,替代聊天引擎的 allContent)。 */
  text: string;
}

interface ToolCardState {
  /** 是否已发过建卡事件(tool_call_created 幂等,但避免无谓重复帧)。 */
  created: boolean;
  /** 流式参数累计文本(toolcall_delta)。 */
  argsText: string;
  /** 部分输出通道:bash_execution_update 增量累加,或 tool_execution_update 全量快照。
   *  一旦 partial-result 通道出现,bash 增量通道对该卡失效(防双写)。 */
  outputMode: "none" | "bash-delta" | "partial-result";
  /** bash-delta 通道的累计输出。 */
  bashText: string;
}

/** 有状态映射桥:一次生成一个实例。状态只服务于关联(卡去重/参数累计/输出通道仲裁),
 *  不持有任何外部资源。 */
export function createPiEventBridge() {
  const cards = new Map<string, ToolCardState>();
  /** message_update 流式工具块:contentIndex → toolCallId(建卡后参数增量寻址用)。 */
  const streamingToolByIndex = new Map<number, string>();
  /** 正在执行的工具(tool_execution_start..end 窗口),bash_execution_update 无 id 时
   *  唯一在执行的工具即目标。 */
  const executing = new Set<string>();
  const outcome: PiBridgeOutcome = { stopReason: null, errorMessage: null, text: "" };
  /** P7 保真:本轮引擎消息序号(每个 assistant message_end 递增,注解分组键)。 */
  let engineMessageOrdinal = 0;

  function card(toolCallId: string): ToolCardState {
    let entry = cards.get(toolCallId);
    if (!entry) {
      entry = { created: false, argsText: "", outputMode: "none", bashText: "" };
      cards.set(toolCallId, entry);
    }
    return entry;
  }

  function createCardEvents(toolCallId: string, toolName: string, input: string): GenerationEvent[] {
    const entry = card(toolCallId);
    if (entry.created && !input) return [];
    entry.created = true;
    return [{
      kind: "tool_call_created",
      toolCallId,
      toolName,
      input,
      // P2 语义:工具在 pi 会话进程内执行,无审批环节 → auto。P3 审批内化到
      // customTools.execute 后,pending/approved 生命周期由工具自身经 sink 驱动。
      approvalState: { type: "auto" },
    }];
  }

  /** 流式 assistant 消息事件(message_update.assistantMessageEvent)。 */
  function handleAssistantStream(ev: AssistantMessageEvent): GenerationEvent[] {
    switch (ev.type) {
      case "text_delta":
        return ev.delta ? [{ kind: "text_delta", text: ev.delta }] : [];
      case "thinking_delta":
        return ev.delta ? [{ kind: "reasoning_delta", text: ev.delta }] : [];
      case "toolcall_start":
      case "toolcall_delta": {
        // partial.content[contentIndex] 是构建中的 ToolCall。id/name 一齐即建卡
        // (OpenAI 首帧带 id+name,Anthropic content_block_start 带,Google 一次性给全);
        // 未齐则等 toolcall_end 兜底——绝不用空 id 建卡(id 是全链路关联键)。
        const partial = ev.partial.content[ev.contentIndex];
        const events: GenerationEvent[] = [];
        if (partial && partial.type === "toolCall" && partial.id && partial.name) {
          const entry = card(partial.id);
          if (!entry.created) {
            streamingToolByIndex.set(ev.contentIndex, partial.id);
            events.push(...createCardEvents(partial.id, partial.name, ""));
          }
          if (ev.type === "toolcall_delta" && ev.delta) {
            entry.argsText += ev.delta;
            events.push({ kind: "tool_input_delta", toolCallId: partial.id, input: entry.argsText });
          }
        }
        return events;
      }
      case "toolcall_end": {
        streamingToolByIndex.delete(ev.contentIndex);
        // 终局建卡/更新:完整参数以 pi 解析后的对象为准(与聊天引擎"终局建卡事件
        // 覆盖流内下界"同构,应用器幂等更新)。
        const input = JSON.stringify(ev.toolCall.arguments ?? {});
        const entry = card(ev.toolCall.id);
        entry.created = true;
        return [{
          kind: "tool_call_created",
          toolCallId: ev.toolCall.id,
          toolName: ev.toolCall.name,
          input,
          approvalState: { type: "auto" },
        }];
      }
      // start/end 帧不产生 part 操作:文本/思维链 part 由应用器随首个增量惰性创建,
      // 思维链收口由应用器的 addStreamText(遇正文自动收口)与生成收尾 finishReasoningParts 保证。
      case "start":
      case "text_start":
      case "text_end":
      case "thinking_start":
      case "thinking_end":
      case "done":
      case "error":
        return [];
    }
  }

  /** P7 保真:assistant 引擎消息 content → 块序列(len 供合并 part 文本切回原块;
   *  sig/redacted 是思维链重放签名;toolCallId 对齐工具卡)。conditional spread
   *  保证无 undefined 键(注解走 JSON 落库)。 */
  function fidelityBlocks(message: AssistantMessage): EngineFidelityBlock[] {
    const blocks: EngineFidelityBlock[] = [];
    for (const item of message.content) {
      if (item.type === "thinking") {
        blocks.push({
          type: "thinking",
          len: item.thinking.length,
          ...(item.thinkingSignature ? { sig: item.thinkingSignature } : {}),
          ...(item.redacted ? { redacted: true } : {}),
        });
      } else if (item.type === "text") {
        blocks.push({ type: "text", len: item.text.length });
      } else if (item.type === "toolCall") {
        blocks.push({ type: "toolCall", toolCallId: item.id });
      }
    }
    return blocks;
  }

  function recordAssistantEnd(message: AssistantMessage): GenerationEvent[] {
    outcome.stopReason = message.stopReason;
    outcome.errorMessage = message.errorMessage ?? null;
    outcome.text = message.content
      .filter((item): item is TextContent => item.type === "text")
      .map((item) => item.text)
      .reduce((sum, text) => (sum ? `${sum}\n${text}` : text), outcome.text);
    // 保真注解先于 usage:结构事件与统计事件互不依赖,固定顺序便于契约测试断言。
    const events: GenerationEvent[] = [
      {
        kind: "engine_fidelity",
        message: {
          msg: engineMessageOrdinal++,
          api: String(message.api),
          provider: String(message.provider),
          model: message.model,
          blocks: fidelityBlocks(message),
        },
      },
    ];
    if (message.usage) events.push({ kind: "usage", usage: mapPiUsage(message.usage) });
    return events;
  }

  function handle(event: AgentSessionEvent): GenerationEvent[] {
    switch (event.type) {
      case "message_update":
        return event.message.role === "assistant" ? handleAssistantStream(event.assistantMessageEvent) : [];
      case "message_end": {
        // assistant:收敛 usage 与终局文本。toolResult:不在此回写(tool_execution_end
        // 已带 result+isError,双通道回写必双写)。user/自定义消息:P2 无 part 语义。
        if (event.message.role === "assistant") return recordAssistantEnd(event.message as AssistantMessage);
        return [];
      }
      case "tool_execution_start": {
        executing.add(event.toolCallId);
        // 兜底幂等建卡:流式建卡失败(provider 不回流式工具块)时,执行开始也能出卡;
        // 已建卡时应用器按"只升不降"更新参数,无副作用。
        return createCardEvents(event.toolCallId, event.toolName, JSON.stringify(event.args ?? {}));
      }
      case "tool_execution_update": {
        const entry = card(event.toolCallId);
        entry.outputMode = "partial-result";
        const partial = event.partialResult as PiToolResultView | undefined;
        if (!partial?.content?.length) return [];
        // partial 快照非终局:不落 toolFinishedAt(issue #59 每工具计时终点)。
        return [{ kind: "tool_result", toolCallId: event.toolCallId, output: mapPiToolResult(partial), final: false }];
      }
      case "tool_execution_end": {
        executing.delete(event.toolCallId);
        const result = event.result as PiToolResultView | undefined;
        if (event.isError) {
          // 历史契约:失败工具的 output 是 {error} 裸载荷(前端与消息回放层按此解析;
          // 与聊天引擎 toolExecutionErrorPayload 一致,失败不附 metadata)。
          const text = result?.content?.length ? contentText(result.content) : "Tool execution failed";
          return [{ kind: "tool_result", toolCallId: event.toolCallId, output: [{ error: text }] }];
        }
        return [{ kind: "tool_result", toolCallId: event.toolCallId, output: mapPiToolResult(result) }];
      }
      case "bash_execution_update": {
        // 归属仲裁:显式 id 优先;无 id 时仅当恰有一个工具在执行。找不到归属或该卡已被
        // partial-result 通道认领 → 丢弃(宁缺毋双写;会话级 "!" bash 不属于任何工具卡)。
        const targetId = event.id ?? (executing.size === 1 ? [...executing][0] : undefined);
        if (!targetId) return [];
        const entry = card(targetId);
        if (!entry.created || entry.outputMode === "partial-result") return [];
        entry.outputMode = "bash-delta";
        entry.bashText += event.delta;
        // bash 流式增量非终局:执行还在跑,秒数继续走表(tool_execution_end 才定格)。
        return [{ kind: "tool_result", toolCallId: targetId, output: [{ type: "text", text: entry.bashText }], final: false }];
      }
      // 引擎瞬态状态(P5):压缩/自动重试/摘要重试 → engine_status,协调器直通 SSE
      // 状态条,不落库不产 part。end/finished 一律回 busy:false(状态条即清)。
      case "compaction_start":
        return [{ kind: "engine_status", status: { busy: true, phase: "compacting", reason: event.reason } }];
      case "compaction_end": {
        // pi 0.84.2 起 compaction_end 失败分支携带 errorMessage(同 session_compact_failed
        // 扩展事件的信息,但走我们已订阅的 AgentSessionEvent 主通道——接扩展事件是冗余副本)。
        // 摘要生成失败走 summarization_retry_* 自动重试(上面已映射成状态条,非终败);
        // aborted 时 errorMessage 为 undefined,天然排除。
        // reason 分流(内测反馈:/compact 失败双 toast):manual = 用户主动压缩,失败已由
        // HTTP 错误路径给出人话 toast(runner PI_COMPACT_ERROR_TEXT 映射),此处再报即同一
        // 失败重复打扰;threshold/overflow = 生成期间自动压缩,用户不知情,失败必须上报
        // (压缩没发生=后续可能上下文溢出)。
        if (event.errorMessage && event.reason !== "manual") {
          reportError("pi-engine", "error", "会话上下文压缩失败,继续对话可能超出模型上下文窗口", event.errorMessage);
        }
        return [{ kind: "engine_status", status: { busy: false } }];
      }
      case "auto_retry_start":
        return [
          {
            kind: "engine_status",
            status: { busy: true, phase: "retrying", attempt: event.attempt, maxAttempts: event.maxAttempts },
          },
        ];
      case "auto_retry_end":
        return [{ kind: "engine_status", status: { busy: false } }];
      case "summarization_retry_scheduled":
        // 摘要生成失败自动重试:对用户仍是"压缩中"(reason 桥不可知,归 manual 展示同文案)。
        return [{ kind: "engine_status", status: { busy: true, phase: "compacting" } }];
      case "summarization_retry_finished":
        return [{ kind: "engine_status", status: { busy: false } }];
      // 生命周期/会话状态事件:无 part 操作。agent_end 的终局语义经 outcome() 由
      // runner 消费。
      case "agent_start":
      case "agent_end":
      case "agent_settled":
      case "turn_start":
      case "turn_end":
      case "message_start":
      case "queue_update":
      case "entry_appended":
      case "session_info_changed":
      case "thinking_level_changed":
      case "summarization_retry_attempt_start":
        return [];
      default: {
        // 穷举门:pi 升级新增事件类型 → 编译失败,倒逼校准映射字典。
        const unreachable: never = event;
        void unreachable;
        return [];
      }
    }
  }

  return {
    handle,
    outcome: (): PiBridgeOutcome => ({ ...outcome }),
  };
}

export type PiEventBridge = ReturnType<typeof createPiEventBridge>;
