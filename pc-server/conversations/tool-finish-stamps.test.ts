// conversations/tool-finish-stamps.test.ts — #59 补完:终局收口补戳的行为锁。
// applier 的终局 tool_result 只覆盖"工具自然跑完";用户点停止/发新消息打断待审批/
// 审批恢复直写 output 这三条终局不走 applier,终点戳由 finishToolParts 统一补。
// 锁定语义:有 output 即已执行完毕 → 补 toolFinishedAt;只补不覆盖;pending 待审批
// 卡跳过(等待期间秒数照走是 #59 的刻意语义);无 output 的飞行中卡保持无戳。
import { describe, expect, test } from "bun:test";

import type { Conversation, Message, MessageNode, ToolPart } from "../foundation/types";
import { finishToolParts } from "../inference-engine/parts";
import { finishInterruptedPendingToolsInConversation } from "./helpers";

function makeMessage(parts: Message["parts"]): { conversation: Conversation; message: Message } {
  const message: Message = {
    id: "msg-1",
    role: "ASSISTANT",
    parts,
    annotations: [],
    createdAt: new Date().toISOString(),
    finishedAt: null,
    translation: null,
    modelId: "m1",
    usage: null,
  };
  const node: MessageNode = { id: "node-1", messages: [message], selectIndex: 0 };
  const conversation: Conversation = {
    id: "conv-1",
    assistantId: "a1",
    title: "t",
    messages: [node],
    isPinned: false,
    createAt: Date.now(),
    updateAt: Date.now(),
    systemPrompt: null,
    chatSuggestions: [],
  };
  return { conversation, message };
}

function toolPart(overrides: Partial<ToolPart> = {}): ToolPart {
  return {
    type: "tool",
    toolCallId: "call-1",
    toolName: "use_skill",
    input: "{}",
    output: [],
    approvalState: { type: "auto" },
    ...overrides,
  };
}

describe("finishToolParts(终局收口补戳)", () => {
  test("有 output 无戳 → 补 toolFinishedAt", () => {
    const { message } = makeMessage([toolPart({ output: [{ type: "text", text: "done" }] })]);
    finishToolParts(message);
    expect(typeof message.parts[0] && message.parts[0].type === "tool" && typeof (message.parts[0] as ToolPart).metadata?.toolFinishedAt === "string").toBe(true);
  });

  test("已有戳 → 不覆盖(更早的真实终点优先)", () => {
    const original = "2026-01-01T00:00:00.000Z";
    const { message } = makeMessage([
      toolPart({ output: [{ type: "text", text: "done" }], metadata: { toolFinishedAt: original } }),
    ]);
    finishToolParts(message);
    expect((message.parts[0] as ToolPart).metadata?.toolFinishedAt).toBe(original);
  });

  test("无 output(飞行中/未执行) → 不补", () => {
    const { message } = makeMessage([toolPart()]);
    finishToolParts(message);
    expect((message.parts[0] as ToolPart).metadata?.toolFinishedAt).toBeUndefined();
  });

  test("pending 待审批卡 → 跳过(等待期间秒数照走)", () => {
    // 双保险场景:pending 卡即使带 {pending} 占位 output 也不定格
    const { message } = makeMessage([
      toolPart({
        approvalState: { type: "pending" },
        output: [{ error: "pending approval" } as never],
      }),
    ]);
    finishToolParts(message);
    expect((message.parts[0] as ToolPart).metadata?.toolFinishedAt).toBeUndefined();
  });

  test("幂等:二次调用不改动已补的戳", () => {
    const { message } = makeMessage([toolPart({ output: [{ type: "text", text: "done" }] })]);
    finishToolParts(message);
    const stamped = (message.parts[0] as ToolPart).metadata?.toolFinishedAt;
    finishToolParts(message);
    expect((message.parts[0] as ToolPart).metadata?.toolFinishedAt).toBe(stamped);
  });
});

describe("finishInterruptedPendingToolsInConversation(发新消息打断 pending)", () => {
  test("pending 卡转 denied + 落 output → 终点戳同步定格", () => {
    const { conversation } = makeMessage([toolPart({ approvalState: { type: "pending" } })]);
    const changed = finishInterruptedPendingToolsInConversation(conversation);
    expect(changed).toBe(true);
    const part = conversation.messages[0].messages[0].parts[0] as ToolPart;
    expect(part.approvalState.type).toBe("denied");
    expect(Array.isArray(part.output) && part.output.length > 0).toBe(true);
    expect(typeof part.metadata?.toolFinishedAt === "string").toBe(true);
  });

  test("无 pending 卡的消息 → 不改动", () => {
    const { conversation } = makeMessage([toolPart({ output: [{ type: "text", text: "done" }], metadata: { toolFinishedAt: "2026-01-01T00:00:00.000Z" } })]);
    expect(finishInterruptedPendingToolsInConversation(conversation)).toBe(false);
  });
});
