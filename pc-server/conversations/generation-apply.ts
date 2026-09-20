// conversations/generation-apply.ts — GenerationEvent → 消息 parts 的唯一写入字典
//
// P2(pi 引擎)抽取自 generateAnswer 的内联 applyEvent,逐字搬迁、行为零变。
// 抽取动机:这是"生成事件如何落到 Message.parts + 持久化/SSE"的权威语义,聊天引擎
// (orchestrator 的 sink)与 pi 事件桥(pi-engine/event-bridge → 本应用器)必须同源——
// 两套写入逻辑必然漂移,漂移即渲染/落库分叉。桥契约测试也经本模块回放,测的是真实写入。
//
// 纪律:本模块只写传入的 message/conversation/node 与 touchStream(标脏+节流落库+合帧
// 广播),不碰全局 state、不直接落库、不直接广播——与原 applyEvent 完全一致。

import type { Conversation, JsonValue, StreamHooks } from "../foundation/types";
import type { GenerationEvent, GenerationEventSink, GenerationTarget, StreamHooksWithSink } from "../inference-engine/events";
import { isRecord } from "../foundation/utils";
import { touchStream } from "../api/sse";
import { fillContextLimit } from "../inference-engine/providers";
import { mergeTokenUsage } from "../inference-engine/tool-loop";
import {
  addStreamImage,
  addStreamText,
  appendReasoningDelta,
  finishReasoningParts,
  replaceLoadingReasoningWithTool,
} from "../inference-engine/parts";

/** 应用目标 = 会话 + 活落点。node/message 是活视图(GenerationTarget):steer 边界分裂
 *  换绑后,后续事件必须落进新节点——所以下面每个事件都现读 target,不缓存。 */
export interface GenerationApplyTarget extends GenerationTarget {
  readonly conversation: Conversation;
}

/** 构造把 GenerationEvent 应用到指定消息的应用器。语义与 generateAnswer 原内联
 *  applyEvent 逐字一致(含各 case 的幂等与"只升不降"审批规则),见各分支注释。 */
export function createGenerationEventApplier(target: GenerationApplyTarget): GenerationEventSink {
  return (event: GenerationEvent) => {
    // 每事件现读落点。曾在此处创建时解构一次,导致 steer 分裂后延续输出继续写进已定格
    // 的 ai_1、ai_2 空到收尾才被整段回填(2026-09-20 用户实测 2-1/2-2)。
    const { conversation, node, message: currentMessage } = target;
    const streamHooks: StreamHooks = { message: currentMessage, conversation, node };
    switch (event.kind) {
      // 文本/思维链/图片增量写入内存后必须 touchStream(标脏 + 200ms 节流落库 + 33ms 节流
      // 广播),与下方三个 tool case 对齐。5.3g 搬迁时该调用曾丢失(收官审查 P0-2):无工具
      // 会话全程无增量帧、无增量落库,流式中崩溃丢整段回答。
      case "text_delta":
        addStreamText(streamHooks, event.text);
        touchStream(streamHooks as StreamHooksWithSink);
        break;
      case "reasoning_delta":
        appendReasoningDelta(streamHooks as StreamHooksWithSink, event.text, event.metadata);
        touchStream(streamHooks as StreamHooksWithSink);
        break;
      case "image_delta":
        addStreamImage(streamHooks, event.url, event.metadata);
        touchStream(streamHooks as StreamHooksWithSink);
        break;
      case "tool_call_created": {
        finishReasoningParts(currentMessage);
        // 幂等化:OpenAI 系流内建卡(参数未齐的下界)后,循环层读完整轮还会发一次
        // 终局建卡事件——已有同 id 卡时改为更新参数与审批态(只升不降:auto/pending
        // 可被终局覆盖,用户已决定的 approved/denied 不回写),不再追加重复卡。
        const exists = currentMessage.parts.some(
          (part) => isRecord(part) && part.type === "tool" && part.toolCallId === event.toolCallId,
        );
        if (exists) {
          currentMessage.parts = currentMessage.parts.map((part) => {
            if (!isRecord(part) || part.type !== "tool" || part.toolCallId !== event.toolCallId) return part;
            const current = isRecord(part.approvalState) ? String(part.approvalState.type ?? "") : "";
            return {
              ...part,
              ...(event.input ? { input: event.input } : {}),
              ...(current === "auto" || current === "pending" ? { approvalState: event.approvalState } : {}),
            };
          });
        } else {
          replaceLoadingReasoningWithTool(currentMessage, {
            type: "tool",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
            output: [],
            approvalState: event.approvalState,
            // issue #59:每工具计时起点。徽章此前用消息级 createdAt/finishedAt 计时,
            // 工具完成后秒数随整条消息的流式墙钟继续涨("加载技能用时X秒一直增加")。
            // 按契约纪律挂 metadata(不新增顶层字段,安卓端安全)。幂等重建(流内建卡
            // 后终局再发建卡事件)不改写起点——首个时间戳即真实建卡时刻。
            metadata: { toolStartedAt: new Date().toISOString() },
          });
        }
        touchStream(streamHooks as StreamHooksWithSink);
        break;
      }
      case "tool_input_delta":
        currentMessage.parts = currentMessage.parts.map((part) => {
          if (!isRecord(part) || part.type !== "tool" || part.toolCallId !== event.toolCallId) return part;
          return { ...part, input: event.input };
        });
        touchStream(streamHooks as StreamHooksWithSink);
        break;
      case "tool_approval_updated":
        // 审批态上调同步(流内建卡的无参数下界 → 参数齐备后的终局)。只改 auto/pending
        // 态的卡,绝不回写用户已决定的 approved/denied。
        currentMessage.parts = currentMessage.parts.map((part) => {
          if (!isRecord(part) || part.type !== "tool" || part.toolCallId !== event.toolCallId) return part;
          const current = isRecord(part.approvalState) ? String(part.approvalState.type ?? "") : "";
          if (current !== "auto" && current !== "pending") return part;
          return { ...part, approvalState: event.approvalState };
        });
        touchStream(streamHooks as StreamHooksWithSink);
        break;
      case "tool_result":
        currentMessage.parts = currentMessage.parts.map((part) => {
          if (!isRecord(part) || part.type !== "tool" || part.toolCallId !== event.toolCallId) return part;
          // issue #59:终局结果(final 缺省视为终局)落每工具计时终点;partial 中间帧
          // 只刷新 output 不动戳,流式输出期间秒数继续走表。只补不覆盖——已定格的
          // 终点不因后续同 id 帧回退(审批恢复重发终局时保首次定格)。
          if (event.final === false) return { ...part, output: event.output };
          // pending 哨兵(ask_user/MCP 审批挂起)非终局:卡在等用户,秒数必须继续走,
          // 真实结果由 resume 路径落地时才定格。
          if (event.output.length === 1 && isRecord(event.output[0]) && "pending" in event.output[0]) {
            return { ...part, output: event.output };
          }
          const meta = (isRecord(part.metadata) ? part.metadata : {}) as Record<string, JsonValue>;
          if (meta.toolFinishedAt != null) return { ...part, output: event.output };
          return {
            ...part,
            output: event.output,
            metadata: { ...meta, toolFinishedAt: new Date().toISOString() },
          };
        });
        touchStream(streamHooks as StreamHooksWithSink);
        break;
      case "usage":
        // P1-3:多轮工具调用时每轮都发 usage 事件,merge 防后轮缺字段清零已知值。
        currentMessage.usage = mergeTokenUsage(currentMessage.usage, event.usage);
        // P5 统计对齐:pi 路径的 usage 不经 providers 的填充点,在应用器统一补
        // contextLimit(分母);已填则内部跳过,chat 路径幂等。
        fillContextLimit(currentMessage);
        break;
      case "engine_fidelity": {
        // P7 保真注解:引擎消息块结构落 assistant 消息 annotations(type:"pi-fidelity",
        // 按 msg 序号幂等覆盖)。不产 part;安卓导出被 PC_ONLY_ANNOTATION_TYPES 拦截;
        // DB→pi 重建时据此把合并 parts 切回引擎消息与原块(签名随 sig 回填)。
        let record = currentMessage.annotations.find(
          (a): a is { type: string; v: number; api: string; provider: string; model: string; messages: JsonValue[] } =>
            isRecord(a) && a.type === "pi-fidelity" && Array.isArray(a.messages),
        );
        if (!record) {
          record = { type: "pi-fidelity", v: 1, api: "", provider: "", model: "", messages: [] };
          currentMessage.annotations.push(record);
        }
        // api/provider/model 同轮恒定,记录级存一份(后到覆盖,幂等)。
        record.api = event.message.api;
        record.provider = event.message.provider;
        record.model = event.message.model;
        record.messages[event.message.msg] = event.message.blocks as unknown as JsonValue;
        touchStream(streamHooks as StreamHooksWithSink);
        break;
      }
      // engine_status:瞬态状态不落库不产 part,由协调器 sink 包装直通 SSE(P5)。
      case "engine_status":
        break;
      // finished/error/abort:终局语义由生成入口(generateAnswer / pi runner 的返回与
      // 抛错)承载,不经应用器——与原内联 applyEvent 一致(其 switch 亦无这三个 case)。
      case "finished":
      case "error":
      case "abort":
        break;
    }
  };
}
