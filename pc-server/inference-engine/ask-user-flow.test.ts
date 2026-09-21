// inference-engine/ask-user-flow.test.ts — gateAskUser 挂起生命周期行为锁。
//
// 钉住 run-and-suspend 引擎(pi)ask_user 的四条路径(与 approval-gate/approval-flow 同口径):
//   作答 → 卡收敛 answered + 决议带解析后的答案映射;拒绝 → 卡收敛 denied + 抛历史契约文案;
//   中止 → 卡收敛 denied(绝不悬 pending) + 抛 AbortError;孤儿决定 → resolveToolApproval 返 false。
//   全程 awaitingApproval 登记表不许残留"假等待"。
import { describe, expect, test } from "bun:test";
import { gateAskUser } from "./ask-user-flow";
import { pendingToolApprovalCount, resolveToolApproval } from "./approval-gate";
import { awaitingApproval } from "../conversations/generation-state";
import { serializeAskUserAnswer } from "../tools/ask-user";
import type { GenerationEvent } from "./events";

function fixture(conversationId: string) {
  const events: GenerationEvent[] = [];
  return {
    events,
    ctx: (toolCallId: string, signal?: AbortSignal) => ({
      conversationId,
      toolCallId,
      sink: (event: GenerationEvent) => void events.push(event),
      ...(signal ? { signal } : {}),
      summary: "Q1",
    }),
  };
}

const approvalStates = (events: GenerationEvent[]) =>
  events.filter((e) => e.kind === "tool_approval_updated").map((e) => e.approvalState);

describe("gateAskUser 生命周期", () => {
  test("作答:pending 卡 → resolve 携 answer → 决议带解析答案,卡收敛 answered,等待登记表清空", async () => {
    const { events, ctx } = fixture("conv-answered");
    const before = pendingToolApprovalCount();
    const running = gateAskUser(ctx("call-1"));
    await Bun.sleep(10);

    expect(approvalStates(events)).toEqual([{ type: "pending" }]);
    expect(awaitingApproval.has("conv-answered")).toBe(true);
    expect(pendingToolApprovalCount()).toBe(before + 1);

    const payload = serializeAskUserAnswer({ q1: "选项A, 补充说明" });
    expect(resolveToolApproval("conv-answered", "call-1", { approved: true, answer: payload })).toBe(true);

    const resolution = await running;
    expect(resolution).toEqual({ kind: "answered", answers: { q1: "选项A, 补充说明" } });
    expect(approvalStates(events).at(-1)).toEqual({ type: "answered", answer: payload });
    expect(awaitingApproval.has("conv-answered")).toBe(false);
    expect(pendingToolApprovalCount()).toBe(before);
  });

  test("拒绝:卡收敛 denied + 抛历史契约拒绝文案,等待登记表清空", async () => {
    const { events, ctx } = fixture("conv-denied");
    const running = gateAskUser(ctx("call-2"));
    await Bun.sleep(10);
    expect(resolveToolApproval("conv-denied", "call-2", { approved: false, reason: "不想答" })).toBe(true);
    await expect(running).rejects.toThrow("Tool execution denied by user. Reason: 不想答");
    expect(approvalStates(events).at(-1)).toEqual({ type: "denied", reason: "不想答" });
    expect(awaitingApproval.has("conv-denied")).toBe(false);
  });

  test("中止:signal abort → 卡收敛 denied(不悬 pending) + 抛 AbortError", async () => {
    const { events, ctx } = fixture("conv-abort");
    const controller = new AbortController();
    const running = gateAskUser(ctx("call-3", controller.signal));
    await Bun.sleep(10);
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(approvalStates(events).at(-1)).toEqual({
      type: "denied",
      reason: "Generation stopped before the approval decision",
    });
    expect(awaitingApproval.has("conv-abort")).toBe(false);
  });

  test("孤儿决定:无在途等待者时 resolveToolApproval 返 false(API 仅记录状态)", () => {
    expect(resolveToolApproval("conv-orphan", "no-such-call", { approved: true, answer: "{}" })).toBe(false);
  });
});
