// inference-engine/approval-flow.ts — 审批内化生命周期(P3 内联于 pi 工作区工具,P4 抽取共用,T2 迁出 pi-engine)
//
// 单一事实源:pending 卡 → approval-gate 等待 → 放行/拒绝/中止收敛的完整状态机。
// 消费者:engines/app-tools(应用工具的应用侧执行面:七个工作区工具与 MCP 桥/通用工具)。
// 两边的差异只在"审批判定"(工作区三档矩阵 vs MCP 档位规则),判定结果作为参数传入,
// 生命周期本身零分叉——审批语义改版(如 §4.4 回退面)只动这一处。
//
// 定位(T2):审批生命周期是引擎无关的公共能力——任何引擎(pi/聊天/未来子进程引擎)的
// 工具走 pending 审批时都收敛到同一状态机。本模块与 approval-gate 同属引擎无关汇合层,
// 不归属任何单一引擎,故迁出 pi-engine 与 events.ts 同层。
//
// 纪律:零 pi 导入(消费方各自持有引擎侧 ToolDefinition 类型),也不碰 parts/SQLite/SSE
// ——sink 事件由应用器统一落地。

import type { ToolApprovalState } from "../foundation/types";
import type { GenerationEventSink } from "./events";
import { allowToolForSession, waitForToolApproval, type ToolApprovalDecision } from "./approval-gate";
import { awaitingApproval } from "../conversations/generation-state";

export interface ApprovalFlowContext {
  conversationId: string;
  toolCallId: string;
  sink: GenerationEventSink;
  signal?: AbortSignal;
  /** 域4-1:通知/状态摘要用的工具名与审批对象摘要(命令/路径,截断后)。 */
  toolName?: string;
  summary?: string;
  /** 会话级免问键(P4.3):带了它,用户批准时选「此会话内总是允许」才会被记下,同会话之后
   *  判定为免问。目前只有插件工具带;工作区与 MCP 工具不带,沿用各自的档位与逐工具设置。 */
  sessionAllowKey?: string;
}

/** 走完审批生命周期。approval 为非 pending(auto 等)时立即返回 false(免审执行);
 *  pending 时挂卡等待:批准 → 收敛 approved 并返回 true(userApproved 知情同意门);
 *  拒绝 → 收敛 denied 并抛历史契约文案(桥映射为 {error} 载荷,与聊天引擎逐字一致);
 *  中止 → 卡收敛 denied(绝不悬 pending)再上抛 AbortError,pi 记 error tool result。 */
export async function gateToolApproval(approval: ToolApprovalState, ctx: ApprovalFlowContext): Promise<boolean> {
  if (approval.type !== "pending") return false;
  ctx.sink({ kind: "tool_approval_updated", toolCallId: ctx.toolCallId, approvalState: approval });
  // 域4-1:等待期间注册会话级"等待审批"态——SSE 重连快照据此恢复琥珀态点,桌面
  // 通知据此知道"哪个会话在等用户"。engine_status 帧由协调器 sink 直通 SSE 状态条;
  // 注册表是跨重连的权威记录(engine-status 帧瞬态,重连即丢)。决定/中止/兜底任一
  // 路径离开等待都必须注销,绝不残留"假等待"。
  awaitingApproval.set(ctx.conversationId, {
    startedAt: Date.now(),
    ...(ctx.toolName ? { toolName: ctx.toolName } : {}),
    ...(ctx.summary ? { summary: ctx.summary } : {}),
  });
  ctx.sink({
    kind: "engine_status",
    status: {
      busy: true,
      phase: "awaiting_approval",
      startedAt: Date.now(),
      toolCallId: ctx.toolCallId,
      ...(ctx.toolName ? { toolName: ctx.toolName } : {}),
      ...(ctx.summary ? { summary: ctx.summary } : {}),
    },
  });
  let decision: ToolApprovalDecision;
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
    ctx.sink({
      kind: "tool_approval_updated",
      toolCallId: ctx.toolCallId,
      approvalState: { type: "denied", reason: decision.reason ?? "" },
    });
    const reason = (decision.reason ?? "").trim() || "No reason provided";
    throw new Error(`Tool execution denied by user. Reason: ${reason}`);
  }
  if (decision.alwaysAllowInSession && ctx.sessionAllowKey) allowToolForSession(ctx.conversationId, ctx.sessionAllowKey);
  ctx.sink({ kind: "tool_approval_updated", toolCallId: ctx.toolCallId, approvalState: { type: "approved" } });
  return true;
}
