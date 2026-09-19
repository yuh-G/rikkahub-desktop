// inference-engine/events.ts — 生成事件流与工具执行接口
// 纪律：本文件只定义类型与回调契约，不写具体实现，避免被 server.ts 的细节污染。

import type { JsonValue, Message, StreamHooks, ToolApprovalState, ToolOutputEntry } from "../foundation/types";

/** 生成过程中产生的单个事件。协调器（generateAnswer）根据这些事件更新消息、
 *  持久化状态和广播 SSE；推理引擎本身不直接执行副作用。 */
export type GenerationEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "reasoning_delta"; text: string; metadata?: Record<string, JsonValue> }
  | { kind: "image_delta"; url: string; metadata?: Record<string, JsonValue> }
  | {
      kind: "tool_call_created";
      toolCallId: string;
      toolName: string;
      input: string;
      approvalState: ToolApprovalState;
    }
  | { kind: "tool_input_delta"; toolCallId: string; input: string }
  // 审批态上调同步:流内建卡(参数未到)给的是无参数下界,批内预扫描参数齐备后
  // 若终局为 pending,循环层发此事件把卡从 auto 上调(带缘由)。只升不降。
  | { kind: "tool_approval_updated"; toolCallId: string; approvalState: ToolApprovalState }
  // final 区分终局与 partial:partial(bash 流式中间帧/tool_execution_update 快照)只
  // 刷新 output;终局(缺省视为终局,兼容旧发射点)才落 metadata.toolFinishedAt——
  // issue #59 的每工具计时终点。pending 哨兵(ask_user 暂停)不是终局,标记 partial。
  | { kind: "tool_result"; toolCallId: string; output: ToolOutputEntry[]; final?: boolean }
  | { kind: "usage"; usage: Message["usage"] }
  // 引擎会话状态(P5):压缩中/自动重试中等瞬态提示。不落库不产 part,
  // 协调器直通 SSE 给前端状态条;busy=false 即清除。detail 是给状态条的展示参数。
  // 引擎中性契约——任何引擎(pi/未来子进程引擎)有瞬态状态都可发,不归属单一引擎。
  | { kind: "engine_status"; status: EngineStatus }
  // 引擎消息保真(P7):一条 assistant 引擎消息的块结构。应用器落到
  // 消息 annotations(type:"pi-fidelity",按 msg 序号幂等覆盖),供 DB→引擎上下文
  // 重建逐字节复现;不产 part,不进安卓导出(export.ts PC_ONLY_ANNOTATION_TYPES)。
  // 引擎中性契约——pi 目前是唯一消费方,但结构对任何需逐字节复现引擎消息块的引擎通用。
  | { kind: "engine_fidelity"; message: EngineMessageFidelity }
  | { kind: "finished"; content: string; stopReason: string | null }
  | { kind: "error"; error: string }
  | { kind: "abort" };

/** 引擎 assistant 消息的保真块(P7 会话数据统一)。parts 是合并视图(连续同类增量
 *  并入同一 part),blocks 记录引擎侧真实块边界:len 把合并后的 part 文本切回原块,
 *  sig/redacted 是思维链跨轮重放的签名载荷(Anthropic 签名/OpenAI reasoning id/
 *  redacted 加密载荷),toolCallId 对齐工具卡。conditional spread 保证无 undefined
 *  键,整体 JsonValue 可序列化。引擎中性——任何需逐字节复现引擎消息块的引擎通用。 */
export interface EngineFidelityBlock {
  type: "thinking" | "text" | "toolCall";
  len?: number;
  sig?: string;
  redacted?: boolean;
  toolCallId?: string;
  [key: string]: JsonValue | undefined;
}

/** 一条 assistant 引擎消息的保真结构。msg 为本轮生成内的引擎消息序号(0 起;
 *  一轮代理循环可产多条 assistant 消息,序号即 DB→引擎重建时的分组依据)。
 *  api/provider/model:引擎 AssistantMessage 的必填元数据(不上线,但重建时用捕获值
 *  比占位符干净,且引擎会话上下文的 model 派生读它)。 */
export interface EngineMessageFidelity {
  msg: number;
  api: string;
  provider: string;
  model: string;
  blocks: EngineFidelityBlock[];
}

/** 引擎瞬态状态(会话级,SSE engine-status 事件载荷)。引擎中性——pi 目前消费
 *  compacting/retrying 两相,未来引擎可按需扩展 phase 枚举。 */
export type EngineStatus =
  | { busy: false }
  | {
      busy: true;
      /** awaiting_approval(域4-1):审批挂起期间持续——用户离开页面/失焦时靠它外显
       *  等待,与 compacting/retrying 同一瞬态通道(不落库、SSE 重连即快照恢复)。 */
      phase: "compacting" | "retrying" | "awaiting_approval";
      /** compacting:manual/threshold/overflow;retrying 无。 */
      reason?: string;
      /** retrying:第几次/共几次。 */
      attempt?: number;
      maxAttempts?: number;
      /** compacting(UI 历史压缩):分块进度。状态条渲染"(current/total)"。 */
      progress?: { current: number; total: number };
      /** 压缩/审批开始时刻(epoch ms,服务端权威),状态条"已处理/已等待 xx秒"计时起点。 */
      startedAt?: number;
      /** awaiting_approval:挂起等待的工具调用 id(前端定位审批卡/通知摘要)。 */
      toolCallId?: string;
      /** awaiting_approval:工具名(通知摘要用,如 bash/edit)。 */
      toolName?: string;
      /** awaiting_approval:审批对象一句话摘要(截断后的命令/路径)。 */
      summary?: string;
    };

/** 事件接收器。Provider 流式函数在解析到增量时调用它。 */
export type GenerationEventSink = (event: GenerationEvent) => void;

/** 与 Provider API 对齐的工具调用描述。 */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** 传给工具执行的上下文信息。tracing / 记忆来源之外，M1-4 起承载工作区执行语境：
 *  signal 由协调器注入（bash 取消杀进程树的前提）；userApproved 仅在审批恢复路径
 *  为 true（危险命令拦截的知情同意放行门，workspace/runtime.ts）。 */
export interface ToolContext {
  conversationId?: string;
  conversationTitle?: string;
  messageNodeId?: string;
  signal?: AbortSignal;
  userApproved?: boolean;
  /** 执行中部分输出回写（bash 流式输出，M1-5）：写回当前 tool part 的 output，
   *  走现有 node_update 关键帧管线（pi 内核 100ms 节流 + touchStream 33ms 合帧）。 */
  onToolPartialOutput?: (output: ToolOutputEntry[]) => void;
}

/** 工具执行的标准化返回值。
 *  - output: 要显示在对话里的 UI parts。
 *  - fileCreation: 工具想创建文件（如 MCP 图片）时返回的描述符，
 *    由协调器统一落盘，避免工具直接修改 global state.files。 */
export interface ToolResult {
  output: ToolOutputEntry[];
  /** 工具想创建的文件描述符列表（如 MCP 图片）。由协调器统一落盘，避免工具直接修改 global state.files。 */
  fileCreations?: Array<{ data: string; mime: string; prefix: string }>;
}

/** 推理引擎对工具执行层的抽象。实现可以暂时仍是 server.ts 里的 executeToolCall，
 *  但接口保证二者不形成循环 import。 */
export type ToolExecutor = (toolCall: ToolCall, context?: ToolContext) => Promise<ToolResult>;

/** 流式钩子的事件下沉扩展。推理引擎通过 sink 发出事件，由协调器（generateAnswer）
 *  应用到 message 并触发持久化/SSE；executeTool 是注入的工具执行回调。 */
export type StreamHooksWithSink = StreamHooks & {
  sink?: GenerationEventSink;
  executeTool?: ToolExecutor;
  /** steering 轮边界(用户问题②,对齐 Codex pending_input):工具批执行完、下一轮模型
   *  请求构建前由循环骨架调用。协调器实现 = 从 steering 通道排水仍有效的排队消息,
   *  落库 user 节点 + 通知 FIFO 队列移除,返回各消息的文本数组(空数组 = 无注入)。
   *  引擎只拿文本编码进请求体,落库/队列/广播全在协调器——副作用不进引擎层。 */
  onSteerBoundary?: () => string[];
};

/** 工具调度上下文：在工具执行回调外再包一层 executeTool 引用，
 *  让 Provider 函数无需直接 import server.ts 的 executeToolCall。 */
export type ToolDispatchContext = ToolContext & { executeTool?: ToolExecutor };
