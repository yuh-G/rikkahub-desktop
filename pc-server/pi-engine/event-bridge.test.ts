// pi-engine/event-bridge.test.ts — 事件桥契约测试(P2,升级 pi 的回归门)
//
// 两层锁定:
// 1) 纯映射:pi 事件样本 → 期望 GenerationEvent 序列(样本按 vendored pi 的类型构造,
//    pi 升级若改事件形状,本文件直接编译失败——与桥内 never 穷举门互为表里);
// 2) 落地回放:样本流经桥 + 共享应用器(conversations/generation-apply,生产同款)写到
//    真实 Message,断言最终 part 序列(方案 §六 P2-4 "pi 事件样本→期望 part 序列")。

import { describe, expect, test } from "bun:test";

import type { AgentSessionEvent } from "../../pi/packages/coding-agent/src/core/agent-session.ts";
import type { AssistantMessage, AssistantMessageEvent, ToolCall, Usage } from "../../pi/packages/ai/src/types.ts";
import type { Conversation, Message, MessageNode, ToolOutputEntry, ToolPart } from "../foundation/types";
import type { GenerationEvent } from "../inference-engine/events";
import { createGenerationEventApplier } from "../conversations/generation-apply";
import { message } from "../foundation/utils";
import { clearAppErrors, recentAppErrors } from "../observability/app-errors";
import { createPiEventBridge, mapPiToolContent, mapPiUsage } from "./event-bridge";

// ----- pi 事件样本工厂(形状由 vendored pi 类型编译期锁定)-----

function usage(partial: Partial<Usage> = {}): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...partial,
  };
}

function assistantMessage(content: AssistantMessage["content"], partial: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage: usage(),
    stopReason: "stop",
    timestamp: 0,
    ...partial,
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

function update(partial: AssistantMessage, ev: AssistantMessageEvent): AgentSessionEvent {
  return { type: "message_update", message: partial, assistantMessageEvent: ev };
}

// ----- 1) 纯映射 -----

describe("pi 事件桥:纯映射", () => {
  test("文本增量 → text_delta;思维链增量 → reasoning_delta;空增量丢弃", () => {
    const bridge = createPiEventBridge();
    const partial = assistantMessage([{ type: "text", text: "He" }], { stopReason: "pending" });
    expect(bridge.handle(update(partial, { type: "text_delta", contentIndex: 0, delta: "He", partial })))
      .toEqual([{ kind: "text_delta", text: "He" }]);
    expect(bridge.handle(update(partial, { type: "thinking_delta", contentIndex: 0, delta: "推理", partial })))
      .toEqual([{ kind: "reasoning_delta", text: "推理" }]);
    expect(bridge.handle(update(partial, { type: "text_delta", contentIndex: 0, delta: "", partial }))).toEqual([]);
  });

  test("流式工具调用:id/name 齐备即建卡,参数增量累计,终局以解析后参数幂等收口", () => {
    const bridge = createPiEventBridge();
    const call = toolCall("call-1", "read", {});
    const partial = assistantMessage([call], { stopReason: "pending" });
    expect(bridge.handle(update(partial, { type: "toolcall_start", contentIndex: 0, partial }))).toEqual([
      { kind: "tool_call_created", toolCallId: "call-1", toolName: "read", input: "", approvalState: { type: "auto" } },
    ]);
    expect(bridge.handle(update(partial, { type: "toolcall_delta", contentIndex: 0, delta: '{"path":', partial })))
      .toEqual([{ kind: "tool_input_delta", toolCallId: "call-1", input: '{"path":' }]);
    expect(bridge.handle(update(partial, { type: "toolcall_delta", contentIndex: 0, delta: '"a.txt"}', partial })))
      .toEqual([{ kind: "tool_input_delta", toolCallId: "call-1", input: '{"path":"a.txt"}' }]);
    const finalCall = toolCall("call-1", "read", { path: "a.txt" });
    expect(bridge.handle(update(partial, { type: "toolcall_end", contentIndex: 0, toolCall: finalCall, partial })))
      .toEqual([
        {
          kind: "tool_call_created",
          toolCallId: "call-1",
          toolName: "read",
          input: '{"path":"a.txt"}',
          approvalState: { type: "auto" },
        },
      ]);
  });

  test("流式工具块 id 未知时不建空卡,终局兜底建卡", () => {
    const bridge = createPiEventBridge();
    const pending = toolCall("", "", {});
    const partial = assistantMessage([pending], { stopReason: "pending" });
    expect(bridge.handle(update(partial, { type: "toolcall_start", contentIndex: 0, partial }))).toEqual([]);
    expect(bridge.handle(update(partial, { type: "toolcall_delta", contentIndex: 0, delta: "{", partial }))).toEqual([]);
    const finalCall = toolCall("call-9", "bash", { command: "ls" });
    const events = bridge.handle(update(partial, { type: "toolcall_end", contentIndex: 0, toolCall: finalCall, partial }));
    expect(events).toEqual([
      {
        kind: "tool_call_created",
        toolCallId: "call-9",
        toolName: "bash",
        input: '{"command":"ls"}',
        approvalState: { type: "auto" },
      },
    ]);
  });

  test("工具执行生命周期:start 幂等建卡,update 全量快照回写,end 终局回写", () => {
    const bridge = createPiEventBridge();
    expect(bridge.handle({ type: "tool_execution_start", toolCallId: "call-2", toolName: "read", args: { path: "b" } }))
      .toEqual([
        { kind: "tool_call_created", toolCallId: "call-2", toolName: "read", input: '{"path":"b"}', approvalState: { type: "auto" } },
      ]);
    expect(
      bridge.handle({
        type: "tool_execution_update",
        toolCallId: "call-2",
        toolName: "read",
        args: { path: "b" },
        partialResult: { content: [{ type: "text", text: "partial" }], details: undefined },
      }),
      // issue #59:partial 快照带 final:false(应用器据此不落每工具计时终点)。
    ).toEqual([{ kind: "tool_result", toolCallId: "call-2", output: [{ type: "text", text: "partial" }], final: false }]);
    expect(
      bridge.handle({
        type: "tool_execution_end",
        toolCallId: "call-2",
        toolName: "read",
        result: { content: [{ type: "text", text: "done" }], details: undefined },
        isError: false,
      }),
    ).toEqual([{ kind: "tool_result", toolCallId: "call-2", output: [{ type: "text", text: "done" }] }]);
  });

  test("工具失败 → 历史契约 {error} 载荷", () => {
    const bridge = createPiEventBridge();
    bridge.handle({ type: "tool_execution_start", toolCallId: "call-3", toolName: "bash", args: {} });
    expect(
      bridge.handle({
        type: "tool_execution_end",
        toolCallId: "call-3",
        toolName: "bash",
        result: { content: [{ type: "text", text: "boom" }], details: undefined },
        isError: true,
      }),
    ).toEqual([{ kind: "tool_result", toolCallId: "call-3", output: [{ error: "boom" }] }]);
  });

  test("details.app.output 优先于 content:通用工具结构化输出(含图)忠实还原+来源标记", () => {
    const bridge = createPiEventBridge();
    bridge.handle({ type: "tool_execution_start", toolCallId: "call-app", toolName: "search_web", args: {} });
    const appOutput: ToolOutputEntry[] = [
      { type: "text", text: "1. Result" },
      { type: "image", url: "/api/files/img-1.png" },
    ];
    expect(
      bridge.handle({
        type: "tool_execution_end",
        toolCallId: "call-app",
        toolName: "search_web",
        result: { content: [{ type: "text", text: "model-facing text" }], details: { app: { output: appOutput } } },
        isError: false,
      }),
    ).toEqual([
      {
        kind: "tool_result",
        toolCallId: "call-app",
        // P7:app 通道首条目打 pi:{src:"app"} 来源标记(DB→pi 重建时选 openAiToolOutput
        // 再计算通道),其余条目原样;UI 渲染忽略未知 metadata,契约不受影响。
        output: [
          { type: "text", text: "1. Result", metadata: { pi: { src: "app" } } },
          { type: "image", url: "/api/files/img-1.png" },
        ],
      },
    ]);
  });

  test("bash_execution_update:显式 id 累加;无 id 归唯一在执行工具;歧义/未建卡丢弃", () => {
    const bridge = createPiEventBridge();
    // 未建卡:丢弃(会话级 "!" bash 不属于任何工具卡)
    expect(bridge.handle({ type: "bash_execution_update", id: "nobody", delta: "x" })).toEqual([]);
    bridge.handle({ type: "tool_execution_start", toolCallId: "call-4", toolName: "bash", args: {} });
    expect(bridge.handle({ type: "bash_execution_update", id: "call-4", delta: "line1\n" }))
      .toEqual([{ kind: "tool_result", toolCallId: "call-4", output: [{ type: "text", text: "line1\n" }], final: false }]);
    // 无 id:唯一在执行 → 归它,输出累计
    expect(bridge.handle({ type: "bash_execution_update", delta: "line2" }))
      .toEqual([{ kind: "tool_result", toolCallId: "call-4", output: [{ type: "text", text: "line1\nline2" }], final: false }]);
    // 第二个工具开始执行 → 无 id 归属歧义,丢弃
    bridge.handle({ type: "tool_execution_start", toolCallId: "call-5", toolName: "read", args: {} });
    expect(bridge.handle({ type: "bash_execution_update", delta: "?" })).toEqual([]);
  });

  test("bash 增量通道让位于 partial-result 通道(防双写)", () => {
    const bridge = createPiEventBridge();
    bridge.handle({ type: "tool_execution_start", toolCallId: "call-6", toolName: "bash", args: {} });
    bridge.handle({
      type: "tool_execution_update",
      toolCallId: "call-6",
      toolName: "bash",
      args: {},
      partialResult: { content: [{ type: "text", text: "snapshot" }], details: undefined },
    });
    expect(bridge.handle({ type: "bash_execution_update", id: "call-6", delta: "raw" })).toEqual([]);
  });

  test("message_end(assistant) → engine_fidelity(先) + usage 映射 + 终局文本/停止原因进 outcome", () => {
    const bridge = createPiEventBridge();
    const final = assistantMessage([{ type: "text", text: "答案" }], {
      usage: usage({ input: 100, output: 20, cacheRead: 60, cacheWrite: 10, totalTokens: 190 }),
    });
    expect(bridge.handle({ type: "message_end", message: final })).toEqual([
      {
        kind: "engine_fidelity",
        message: {
          msg: 0,
          api: "openai-completions",
          provider: "test-provider",
          model: "test-model",
          blocks: [{ type: "text", len: 2 }],
        },
      },
      { kind: "usage", usage: { promptTokens: 170, completionTokens: 20, totalTokens: 190, cachedTokens: 60 } },
    ]);
    const outcome = bridge.outcome();
    expect(outcome.text).toBe("答案");
    expect(outcome.stopReason).toBe("stop");
    expect(outcome.errorMessage).toBeNull();
  });

  test("engine_fidelity(P7):块结构/签名/redacted 逐块捕获,消息序号跨 message_end 递增", () => {
    const bridge = createPiEventBridge();
    const first = bridge.handle({
      type: "message_end",
      message: assistantMessage(
        [
          { type: "thinking", thinking: "推理", thinkingSignature: "sig-1" },
          { type: "thinking", thinking: "", thinkingSignature: "enc-payload", redacted: true },
          toolCall("call-f", "bash", { command: "ls" }),
        ],
        { stopReason: "toolUse" },
      ),
    });
    expect(first[0]).toEqual({
      kind: "engine_fidelity",
      message: {
        msg: 0,
        api: "openai-completions",
        provider: "test-provider",
        model: "test-model",
        blocks: [
          { type: "thinking", len: 2, sig: "sig-1" },
          { type: "thinking", len: 0, sig: "enc-payload", redacted: true },
          { type: "toolCall", toolCallId: "call-f" },
        ],
      },
    });
    const second = bridge.handle({
      type: "message_end",
      message: assistantMessage([{ type: "text", text: "完成" }]),
    });
    expect(second[0]).toEqual({
      kind: "engine_fidelity",
      message: {
        msg: 1,
        api: "openai-completions",
        provider: "test-provider",
        model: "test-model",
        blocks: [{ type: "text", len: 2 }],
      },
    });
  });

  test("上游失败:stopReason=error 与 errorMessage 进 outcome", () => {
    const bridge = createPiEventBridge();
    const failed = assistantMessage([], { stopReason: "error", errorMessage: "429 too many requests" });
    bridge.handle({ type: "message_end", message: failed });
    expect(bridge.outcome().stopReason).toBe("error");
    expect(bridge.outcome().errorMessage).toBe("429 too many requests");
  });

  test("生命周期/会话状态事件不产生 part 操作", () => {
    const bridge = createPiEventBridge();
    const silent: AgentSessionEvent[] = [
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "message_start", message: assistantMessage([]) },
      { type: "turn_end", message: assistantMessage([]), toolResults: [] },
      { type: "agent_end", messages: [], willRetry: false },
      { type: "agent_settled" },
      { type: "queue_update", steering: [], followUp: [] },
      { type: "session_info_changed", name: undefined },
      { type: "thinking_level_changed", level: "off" },
      { type: "summarization_retry_attempt_start", source: "branchSummary" },
      { type: "bash_execution_update", delta: "orphan" },
    ];
    for (const event of silent) expect(bridge.handle(event)).toEqual([]);
  });

  test("压缩/自动重试/摘要重试 → engine_status 瞬态状态(P5)", () => {
    const bridge = createPiEventBridge();
    expect(bridge.handle({ type: "compaction_start", reason: "threshold" })).toEqual([
      { kind: "engine_status", status: { busy: true, phase: "compacting", reason: "threshold" } },
    ]);
    expect(bridge.handle({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false })).toEqual([
      { kind: "engine_status", status: { busy: false } },
    ]);
    expect(bridge.handle({ type: "auto_retry_start", attempt: 2, maxAttempts: 4, delayMs: 100, errorMessage: "x" })).toEqual([
      { kind: "engine_status", status: { busy: true, phase: "retrying", attempt: 2, maxAttempts: 4 } },
    ]);
    expect(bridge.handle({ type: "auto_retry_end", success: true, attempt: 2 })).toEqual([
      { kind: "engine_status", status: { busy: false } },
    ]);
    expect(bridge.handle({ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 2, delayMs: 1, errorMessage: "x" })).toEqual([
      { kind: "engine_status", status: { busy: true, phase: "compacting" } },
    ]);
    expect(bridge.handle({ type: "summarization_retry_finished" })).toEqual([
      { kind: "engine_status", status: { busy: false } },
    ]);
  });

  test("压缩失败(pi 0.84.2 compaction_end.errorMessage)→ 自动压缩上报;手动/成功/中止不上报", () => {
    clearAppErrors();
    const bridge = createPiEventBridge();
    // 自动压缩(threshold/overflow)失败:状态条照常清除,同时把 errorMessage 上报进错误中心
    // (severity error;用户不知情,压缩没发生=后续可能上下文溢出,必须知道)。
    expect(
      bridge.handle({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false, errorMessage: "Compaction failed: boom" }),
    ).toEqual([{ kind: "engine_status", status: { busy: false } }]);
    const errs = recentAppErrors();
    expect(errs.some((e) => e.domain === "pi-engine" && e.severity === "error" && e.message.includes("压缩失败"))).toBe(true);
    // 手动压缩(manual)失败不上报:HTTP 错误路径已给人话 toast(runner PI_COMPACT_ERROR_TEXT
    // 映射),再报即同一失败双 toast(内测反馈:/compact 小会话必报"记忆还很小"时弹两条)。
    clearAppErrors();
    bridge.handle({ type: "compaction_end", reason: "manual", result: undefined, aborted: false, willRetry: false, errorMessage: "Compaction failed: Nothing to compact (session too small)" });
    expect(recentAppErrors().filter((e) => e.domain === "pi-engine")).toHaveLength(0);
    // 成功(有 result)与中止(aborted,errorMessage 为 undefined)均不上报。
    bridge.handle({ type: "compaction_end", reason: "manual", result: { summary: "s", firstKeptEntryId: "e", tokensBefore: 1, estimatedTokensAfter: 1, usage: undefined, details: undefined } as never, aborted: false, willRetry: false });
    bridge.handle({ type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false });
    expect(recentAppErrors().filter((e) => e.domain === "pi-engine")).toHaveLength(0);
  });

  test("mapPiUsage/mapPiToolContent 口径", () => {
    expect(mapPiUsage(usage({ input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 0 })))
      .toEqual({ promptTokens: 15, completionTokens: 5, totalTokens: 20, cachedTokens: 3 });
    expect(mapPiToolContent([
      { type: "text", text: "t" },
      { type: "image", data: "QUJD", mimeType: "image/png" },
    ])).toEqual([
      { type: "text", text: "t" },
      { type: "image", url: "data:image/png;base64,QUJD" },
    ]);
  });
});

// ----- 2) 落地回放:事件样本 → 桥 → 共享应用器 → 真实 part 序列 -----

function generationTarget(): { conversation: Conversation; node: MessageNode; msg: Message } {
  const msg = message("ASSISTANT", [], "test-model");
  msg.parts = [{ type: "loading", label: "正在生成回复" }]; // 生产入口 setMessageLoading 同款占位
  const node: MessageNode = { id: "node-1", messages: [msg], selectIndex: 0 };
  const conversation: Conversation = {
    id: "conv-1",
    assistantId: "a-1",
    systemPrompt: null,
    title: "",
    messages: [node],
    chatSuggestions: [],
    isPinned: false,
    createAt: 0,
    updateAt: 0,
  };
  return { conversation, node, msg };
}

function replay(events: AgentSessionEvent[]): Message {
  const { conversation, node, msg } = generationTarget();
  const bridge = createPiEventBridge();
  const apply = createGenerationEventApplier({ conversation, node, message: msg });
  for (const event of events) {
    for (const generationEvent of bridge.handle(event)) apply(generationEvent);
  }
  return msg;
}

describe("pi 事件桥:落地回放(生产同款应用器)", () => {
  test("思维链→工具调用→执行→次轮正文:期望 part 序列 [reasoning(已收口), tool(有输出), text]", () => {
    const call = toolCall("call-a", "read", {});
    const turn1 = assistantMessage([{ type: "thinking", thinking: "" }, call], { stopReason: "pending" });
    const turn2 = assistantMessage([{ type: "text", text: "" }], { stopReason: "pending" });
    const msg = replay([
      { type: "agent_start" },
      { type: "turn_start" },
      update(turn1, { type: "thinking_delta", contentIndex: 0, delta: "先看文件", partial: turn1 }),
      update(turn1, { type: "toolcall_start", contentIndex: 1, partial: turn1 }),
      update(turn1, {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: toolCall("call-a", "read", { path: "a.txt" }),
        partial: turn1,
      }),
      {
        type: "message_end",
        message: assistantMessage([{ type: "thinking", thinking: "先看文件" }, toolCall("call-a", "read", { path: "a.txt" })], {
          usage: usage({ input: 10, output: 4, totalTokens: 14 }),
          stopReason: "toolUse",
        }),
      },
      { type: "tool_execution_start", toolCallId: "call-a", toolName: "read", args: { path: "a.txt" } },
      {
        type: "tool_execution_end",
        toolCallId: "call-a",
        toolName: "read",
        result: { content: [{ type: "text", text: "文件内容" }], details: undefined },
        isError: false,
      },
      { type: "turn_start" },
      update(turn2, { type: "text_delta", contentIndex: 0, delta: "结论:", partial: turn2 }),
      update(turn2, { type: "text_delta", contentIndex: 0, delta: "OK", partial: turn2 }),
      {
        type: "message_end",
        message: assistantMessage([{ type: "text", text: "结论:OK" }], {
          usage: usage({ input: 20, output: 6, totalTokens: 26 }),
        }),
      },
      { type: "agent_end", messages: [], willRetry: false },
    ]);

    expect(msg.parts.map((part) => part.type)).toEqual(["reasoning", "tool", "text"]);
    const [reasoning, tool, text] = msg.parts as [
      Extract<Message["parts"][number], { type: "reasoning" }>,
      ToolPart,
      Extract<Message["parts"][number], { type: "text" }>,
    ];
    expect(reasoning.reasoning).toBe("先看文件");
    expect(reasoning.finishedAt).toBeTruthy(); // 建卡即收口思维链(应用器 finishReasoningParts)
    expect(tool.toolCallId).toBe("call-a");
    expect(tool.toolName).toBe("read");
    expect(tool.input).toBe('{"path":"a.txt"}');
    expect(tool.output).toEqual([{ type: "text", text: "文件内容" }]);
    expect(tool.approvalState).toEqual({ type: "auto" });
    expect(text.text).toBe("结论:OK");
    // loading 占位被首个真实内容剥离
    expect(msg.parts.some((part) => part.type === "loading")).toBe(false);
    // usage 按 mergeTokenUsage 合并(两轮,后轮非零值覆盖);P5 统计对齐:应用器统一补
    // contextLimit 分母(测试环境 models.dev 缓存未加载 → null,前端降级只显示分子)
    expect(msg.usage).toEqual({ promptTokens: 20, completionTokens: 6, totalTokens: 26, cachedTokens: 0, contextLimit: null });
    // P7 保真注解:两条引擎消息的块结构按序落 annotations(重建分组与签名的依据)
    expect(msg.annotations).toEqual([
      {
        type: "pi-fidelity",
        v: 1,
        api: "openai-completions",
        provider: "test-provider",
        model: "test-model",
        messages: [
          [
            { type: "thinking", len: 4 },
            { type: "toolCall", toolCallId: "call-a" },
          ],
          [{ type: "text", len: 5 }],
        ],
      },
    ]);
  });

  test("bash 增量输出:tool part 单 text 条目纯前缀增长(SSE 可走 text_delta 快路),终局替换", () => {
    const events: AgentSessionEvent[] = [
      { type: "tool_execution_start", toolCallId: "call-b", toolName: "bash", args: { command: "ls" } },
      { type: "bash_execution_update", id: "call-b", delta: "a.txt\n" },
      { type: "bash_execution_update", id: "call-b", delta: "b.txt\n" },
      {
        type: "tool_execution_end",
        toolCallId: "call-b",
        toolName: "bash",
        result: { content: [{ type: "text", text: "a.txt\nb.txt\n(exit 0)" }], details: undefined },
        isError: false,
      },
    ];
    const msg = replay(events);
    const tool = msg.parts.find((part) => part.type === "tool") as ToolPart;
    expect(tool.output).toEqual([{ type: "text", text: "a.txt\nb.txt\n(exit 0)" }]);
  });

  test("纯文本回答:单 text part,无思维链/工具残留", () => {
    const partial = assistantMessage([{ type: "text", text: "" }], { stopReason: "pending" });
    const msg = replay([
      update(partial, { type: "text_delta", contentIndex: 0, delta: "你好", partial }),
      update(partial, { type: "text_delta", contentIndex: 0, delta: "!", partial }),
      { type: "message_end", message: assistantMessage([{ type: "text", text: "你好!" }]) },
    ]);
    expect(msg.parts).toHaveLength(1);
    expect(msg.parts[0]).toMatchObject({ type: "text", text: "你好!" });
  });
});

// 编译期字典完整性:GenerationEvent 的 kind 集合被桥/应用器覆盖(此断言只为
// 在 GenerationEvent 扩展时提醒同步审视桥的产出面,运行时恒真)。
const _generationKinds: GenerationEvent["kind"][] = [
  "text_delta", "reasoning_delta", "image_delta", "tool_call_created", "tool_input_delta",
  "tool_approval_updated", "tool_result", "usage", "engine_status", "engine_fidelity",
  "finished", "error", "abort",
];
void _generationKinds;
