// conversations/generation-apply — issue #59 每工具计时戳行为锁。
// 工具卡此前用消息级 createdAt/finishedAt 计时:工具完成后(徽章已切"用时")秒数仍随
// 整条消息的流式墙钟涨,"加载技能用时X秒一直增加"。锁定新契约:
// - 建卡事件落 metadata.toolStartedAt;
// - 终局 tool_result(final 缺省/true)落 metadata.toolFinishedAt,只补不覆盖;
// - partial(final:false)与 pending 哨兵只刷 output,不落终点戳(秒数继续走表)。
import { describe, expect, test } from "bun:test";

import type { Conversation, Message, MessageNode } from "../foundation/types";
import { createGenerationEventApplier } from "./generation-apply";

function makeTarget() {
  const message: Message = {
    id: "msg-1",
    role: "ASSISTANT",
    parts: [],
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
  return { conversation, node, message };
}

function toolPartOf(message: Message) {
  const part = message.parts.find((p) => p.type === "tool");
  if (!part || part.type !== "tool") throw new Error("tool part not found");
  return part;
}

describe("generation-apply:每工具计时戳(issue #59)", () => {
  test("建卡落 toolStartedAt;终局 tool_result 落 toolFinishedAt", () => {
    const target = makeTarget();
    const apply = createGenerationEventApplier(target);
    apply({ kind: "tool_call_created", toolCallId: "c1", toolName: "use_skill", input: "{}", approvalState: { type: "auto" } });
    const startedAt = toolPartOf(target.message).metadata?.toolStartedAt;
    expect(typeof startedAt).toBe("string");

    apply({ kind: "tool_result", toolCallId: "c1", output: [{ type: "text", text: "ok" }] });
    const meta = toolPartOf(target.message).metadata as Record<string, unknown>;
    expect(typeof meta.toolFinishedAt).toBe("string");
    // 起点不因终局帧漂移
    expect(meta.toolStartedAt).toBe(startedAt);
  });

  test("partial(final:false)只刷 output,不落 toolFinishedAt", () => {
    const target = makeTarget();
    const apply = createGenerationEventApplier(target);
    apply({ kind: "tool_call_created", toolCallId: "c2", toolName: "bash", input: "{}", approvalState: { type: "auto" } });
    apply({ kind: "tool_result", toolCallId: "c2", output: [{ type: "text", text: "partial" }], final: false });
    const part = toolPartOf(target.message);
    expect(part.metadata?.toolFinishedAt).toBeUndefined();
    expect(part.output).toEqual([{ type: "text", text: "partial" }]);
  });

  test("pending 哨兵(ask_user)不落 toolFinishedAt,秒数继续走表", () => {
    const target = makeTarget();
    const apply = createGenerationEventApplier(target);
    apply({ kind: "tool_call_created", toolCallId: "c3", toolName: "ask_user", input: "{}", approvalState: { type: "auto" } });
    apply({ kind: "tool_result", toolCallId: "c3", output: [{ pending: true }] });
    const part = toolPartOf(target.message);
    expect(part.metadata?.toolFinishedAt).toBeUndefined();
    // 终局答复(经 tool_result 无 final)之后才定格(map 替换 part,重取新引用)
    apply({ kind: "tool_result", toolCallId: "c3", output: [{ type: "text", text: '{"answers":{}}' }] });
    expect(typeof toolPartOf(target.message).metadata?.toolFinishedAt).toBe("string");
  });

  test("终局戳只补不覆盖:同 id 重发终局帧保首次定格", () => {
    const target = makeTarget();
    const apply = createGenerationEventApplier(target);
    apply({ kind: "tool_call_created", toolCallId: "c4", toolName: "read", input: "{}", approvalState: { type: "auto" } });
    apply({ kind: "tool_result", toolCallId: "c4", output: [{ type: "text", text: "v1" }] });
    const first = toolPartOf(target.message).metadata?.toolFinishedAt;
    apply({ kind: "tool_result", toolCallId: "c4", output: [{ type: "text", text: "v2" }] });
    const part = toolPartOf(target.message);
    expect(part.metadata?.toolFinishedAt).toBe(first);
    expect(part.output).toEqual([{ type: "text", text: "v2" }]); // output 仍随后帧刷新
  });
});

describe("generation-apply:落点是活视图(steer 边界换绑)", () => {
  test("换绑后事件落进新消息,旧消息一个字节不变", () => {
    // 事故形态(2026-09-20 用户实测 2-1/2-2):应用器创建时解构缓存了落点,steer 分裂
    // 换绑后第二轮正文继续写进已定格的 ai_1,ai_2 空到收尾才被整段回填。锁定:每事件现读。
    const first = makeTarget();
    const second = makeTarget();
    second.message.id = "msg-2";
    second.node.id = "node-2";
    let current = { node: first.node, message: first.message };
    const apply = createGenerationEventApplier({
      conversation: first.conversation,
      get node() {
        return current.node;
      },
      get message() {
        return current.message;
      },
    });

    apply({ kind: "text_delta", text: "第一段" });
    current = { node: second.node, message: second.message };
    apply({ kind: "text_delta", text: "第二段" });
    apply({ kind: "tool_call_created", toolCallId: "t-after", toolName: "read", input: "{}", approvalState: { type: "auto" } });
    apply({ kind: "usage", usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } });

    expect(first.message.parts).toEqual([{ type: "text", text: "第一段" }]);
    expect(first.message.usage).toBeNull();
    expect(second.message.parts.map((p) => p.type)).toEqual(["text", "tool"]);
    expect(second.message.parts[0]).toEqual({ type: "text", text: "第二段" });
    expect((second.message.usage as { totalTokens?: number } | null)?.totalTokens).toBe(3);
  });
});
