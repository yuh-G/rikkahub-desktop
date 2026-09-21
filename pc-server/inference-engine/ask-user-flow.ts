// inference-engine/ask-user-flow.ts — ask_user 挂起生命周期(引擎无关汇合层,T2 同层)
//
// 与 approval-flow.gateToolApproval 同源同构,唯一差异:审批门决议不只放行/拒绝,还要把
// 用户的"答复载荷"带回在途 execute。这是把既有的 run-and-suspend 原语泛化一步——
// 它本就为 pi 的"工具执行中挂起等用户"而生(工作区/MCP 审批),ask_user 只是"决议里多了
// 一个 answer 字段"的特例。
//
// 聊天引擎不经此门:它的 ask_user 是"返回 pending 哨兵 → 整批暂停 → /tool-approval 写
// answered → 重触发续跑"两段式,答案从持久化 part 读。本模块只服务 run-and-suspend 引擎
// (pi,及未来把审批/提问内化进 execute 的引擎)。
//
// 纪律:零 pi 导入,不碰 parts/SQLite/SSE 落盘——sink 事件由应用器统一落地。

import type { GenerationEventSink } from "./events";
import { waitForToolApproval } from "./approval-gate";
import { awaitingApproval } from "../conversations/generation-state";
import { parseAskUserAnswer, type AskUserAnswerMap } from "../tools/ask-user";

export type AskUserResolution =
  | { kind: "answered"; answers: AskUserAnswerMap }
  | { kind: "denied"; reason: string };
// 中止不列为变体:以抛 AbortError 上抛(与 gateToolApproval 逐字一致),由引擎记中断。

export interface AskUserFlowContext {
  conversationId: string;
  toolCallId: string;
  sink: GenerationEventSink;
  signal?: AbortSignal;
  /** 状态栏/桌面通知摘要(首问题干,截断后)。 */
  summary?: string;
}

/** 挂起当前 ask_user 工具调用直到用户作答/拒绝/中止。决议经 approval-gate 汇合:
 *  作答 → 卡收敛 answered 并返回解析后的答案映射;拒绝 → 卡收敛 denied 抛历史契约文案;
 *  中止 → 卡收敛 denied(绝不悬 pending)再上抛 AbortError。 */
export async function gateAskUser(ctx: AskUserFlowContext): Promise<AskUserResolution> {
  ctx.sink({ kind: "tool_approval_updated", toolCallId: ctx.toolCallId, approvalState: { type: "pending" } });
  awaitingApproval.set(ctx.conversationId, {
    startedAt: Date.now(),
    toolName: "ask_user",
    ...(ctx.summary ? { summary: ctx.summary } : {}),
  });
  ctx.sink({
    kind: "engine_status",
    status: {
      busy: true,
      phase: "awaiting_approval",
      startedAt: Date.now(),
      toolCallId: ctx.toolCallId,
      toolName: "ask_user",
      ...(ctx.summary ? { summary: ctx.summary } : {}),
    },
  });
  let decision;
  try {
    decision = await waitForToolApproval(ctx.conversationId, ctx.toolCallId, ctx.signal);
  } catch (err) {
    awaitingApproval.delete(ctx.conversationId);
    ctx.sink({ kind: "engine_status", status: { busy: false } });
    ctx.sink({
      kind: "tool_approval_updated",
      toolCallId: ctx.toolCallId,
      approvalState: { type: "denied", reason: "Generation stopped before the approval decision" },
    });
    throw err;
  }
  awaitingApproval.delete(ctx.conversationId);
  ctx.sink({ kind: "engine_status", status: { busy: false } });
  if (!decision.approved) {
    const reason = (decision.reason ?? "").trim() || "No reason provided";
    ctx.sink({
      kind: "tool_approval_updated",
      toolCallId: ctx.toolCallId,
      approvalState: { type: "denied", reason },
    });
    throw new Error(`Tool execution denied by user. Reason: ${reason}`);
  }
  const answer = decision.answer ?? "";
  ctx.sink({
    kind: "tool_approval_updated",
    toolCallId: ctx.toolCallId,
    approvalState: { type: "answered", answer },
  });
  return { kind: "answered", answers: parseAskUserAnswer(answer) };
}
