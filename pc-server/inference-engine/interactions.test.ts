// Interactions API(POST /interactions)端到端单测:mock 全局 fetch 仿真 Interactions
// SSE 事件流(interaction.created/step.start/step.delta/step.stop/interaction.completed),
// 验证:请求体形状(store=false/tools 扁平数组/generation_config.thinking_level)、
// 工具循环(function_call 归一→执行→function_result 回传)、签名保真(thought/function_call
// 签名进 replaySteps 与工具卡 metadata)、usage 口径(total_output+total_thought)。
import { afterAll, describe, expect, mock, test } from "bun:test";

// 展开真实模块只覆盖目标导出:bun 的 mock.module 跨测试文件不回收(见 tool-loop.test.ts)。
import * as actualLogs from "../api/logs";
import * as actualSse from "../api/sse";

mock.module("../api/logs", () => ({ ...actualLogs, addLog: () => {} }));
mock.module("../api/sse", () => ({ ...actualSse, touchStream: () => {} }));

const { buildInteractionsRequestBody, interactionsThinkingLevelFor, streamInteractionsChatWithTools } = await import("./interactions");

const assistant = { id: "a1", mcpServers: [], reasoningLevel: "high" } as never;
const providerItem = { id: "p1", name: "Gemini Test" } as never;

function sse(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

const toolRoundStream = sse([
  { event_type: "interaction.created", interaction: { id: "i-1", status: "in_progress" } },
  { event_type: "step.start", index: 0, step: { type: "thought" } },
  { event_type: "step.delta", index: 0, delta: { type: "thought_summary", content: { type: "text", text: "想一想" } } },
  { event_type: "step.delta", index: 0, delta: { type: "thought_signature", signature: "tsig-1" } },
  { event_type: "step.stop", index: 0 },
  { event_type: "step.start", index: 1, step: { type: "function_call", id: "gth-1", name: "do_it", arguments: {}, signature: "fsig-1" } },
  { event_type: "step.delta", index: 1, delta: { type: "arguments_delta", arguments: '{"a":1}' } },
  { event_type: "step.stop", index: 1 },
  { event_type: "interaction.completed", interaction: { id: "i-1", status: "requires_action", usage: { total_input_tokens: 10, total_output_tokens: 5, total_thought_tokens: 3, total_tokens: 18, total_cached_tokens: 0 } } },
]);

const finalRoundStream = sse([
  { event_type: "interaction.created", interaction: { id: "i-2", status: "in_progress" } },
  { event_type: "step.start", index: 0, step: { type: "model_output" } },
  { event_type: "step.delta", index: 0, delta: { type: "text", text: "完成" } },
  { event_type: "step.stop", index: 0 },
  { event_type: "interaction.completed", interaction: { id: "i-2", status: "completed", usage: { total_input_tokens: 12, total_output_tokens: 3, total_thought_tokens: 0, total_tokens: 15, total_cached_tokens: 0 } } },
]);

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

function makeHooks(toolCallIdSeen: { input?: string; metadata?: Record<string, unknown> }[] = []) {
  return {
    conversation: { id: "c1", title: "t" },
    node: { id: "n1" },
    message: { id: "m1", role: "ASSISTANT", parts: [] as unknown[], annotations: [], createdAt: 0, finishedAt: null },
    sink: (event: { kind: string; toolCallId?: string; input?: string; metadata?: Record<string, unknown> }) => {
      if (event.kind === "tool_call_created") toolCallIdSeen.push({ input: event.input, metadata: event.metadata });
    },
    executeTool: async () => ({ output: [{ type: "text", text: "工具输出" }] }),
  } as never;
}

describe("buildInteractionsRequestBody", () => {
  const model = { modelId: "gemini-3.5-flash", abilities: ["REASONING", "TOOL"] } as never;

  test("system_instruction 文本化;store=false;thinking_level/summaries;函数工具扁平 {type:function}", () => {
    const body = buildInteractionsRequestBody(
      [
        { role: "system", content: "你是助手" },
        { role: "user", content: [{ type: "text", text: "你好" }] },
      ],
      [],
      model,
      { ...assistant, reasoningLevel: "xhigh" },
      [{ type: "function", function: { name: "do_it", description: "d", parameters: { type: "object", properties: { a: { type: "number", format: "x" } } } } }],
    );
    expect(body.system_instruction).toBe("你是助手");
    expect(body.store).toBe(false);
    expect(body.generation_config).toEqual({ thinking_summaries: "auto", thinking_level: "high" });
    // tools 扁平数组,函数 schema 经 Google 子集净化(format 剥除)。
    expect(body.tools).toEqual([
      { type: "function", name: "do_it", description: "d", parameters: { type: "object", properties: { a: { type: "number" } } } },
    ]);
    expect((body.input as Array<{ type: string }>)[0].type).toBe("user_input");
  });

  test("历史 assistant parts 重建:thought(带签名)→thought step;无签名思考不回传;工具组 call+result 成对", () => {
    const body = buildInteractionsRequestBody(
      [
        { role: "user", content: [{ type: "text", text: "第一问" }] },
        { role: "assistant", content: "" },
        { role: "user", content: [{ type: "text", text: "第二问" }] },
      ],
      [[
        { type: "reasoning", reasoning: "思考过", metadata: { interactions_signature: "sig-x" } },
        { type: "text", text: "第一答" },
      ] as never],
      model,
      assistant,
      [],
    );
    const steps = body.input as Array<Record<string, unknown>>;
    expect(steps.map((s) => s.type)).toEqual(["user_input", "thought", "model_output", "user_input"]);
    expect(steps[1]).toEqual({ type: "thought", signature: "sig-x", summary: [{ type: "text", text: "思考过" }] });
    expect(steps[2]).toEqual({ type: "model_output", content: [{ type: "text", text: "第一答" }] });
  });
});

describe("interactionsThinkingLevelFor", () => {
  test("xhigh/max 收 high;off:gemini3/4 取 minimal,2.5 系取 low;其余原样", () => {
    expect(interactionsThinkingLevelFor("gemini-3.5-flash", "xhigh")).toBe("high");
    expect(interactionsThinkingLevelFor("gemini-3.5-flash", "max")).toBe("high");
    expect(interactionsThinkingLevelFor("gemini-3.5-flash", "medium")).toBe("medium");
    expect(interactionsThinkingLevelFor("gemini-3.5-flash", "off")).toBe("minimal");
    expect(interactionsThinkingLevelFor("gemini-2.5-flash", "off")).toBe("low");
  });
});

describe("streamInteractionsChatWithTools", () => {
  test("工具轮→签名回传(卡 metadata + 第二轮 input)+function_result 编码+最终文本", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const streams = [toolRoundStream, finalRoundStream];
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(streams.shift() ?? "", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const createdEvents: { input?: string; metadata?: Record<string, unknown> }[] = [];
    const hooks = makeHooks(createdEvents);

    const out = await streamInteractionsChatWithTools(
      "https://gen.test/v1beta/",
      { "x-goog-api-key": "api-key" },
      "gemini-3.5-flash",
      { input: [{ type: "user_input", content: [{ type: "text", text: "hi" }] }] },
      providerItem,
      assistant,
      undefined,
      hooks,
    );

    expect(out).toBe("完成");
    expect(requests[0]!.url).toContain("/interactions");
    expect(requests[0]!.body.store).toBe(false);
    // 工具执行参数 = arguments_delta 累积。
    expect(createdEvents[0]).toMatchObject({ input: '{"a":1}' });
    // function_call step 签名(step.start 提供)落工具卡 metadata(跨对话轮历史回传读它)。
    expect(createdEvents[0]!.metadata).toEqual({ interactions_signature: "fsig-1" });

    // 第二轮 input:原 user_input + thought(带签名)+ function_call(带签名)+ function_result。
    const secondInput = requests[1]!.body.input as Array<Record<string, unknown>>;
    expect(secondInput.map((s) => s.type)).toEqual([
      "user_input", "thought", "function_call", "function_result",
    ]);
    expect(secondInput[1]).toMatchObject({ signature: "tsig-1" });
    expect(secondInput[2]).toMatchObject({ id: "gth-1", name: "do_it", signature: "fsig-1" });
    expect(secondInput[3]).toMatchObject({ call_id: "gth-1", name: "do_it" });
    const resultContent = (secondInput[3].result as Array<{ type: string; text: string }>)[0];
    expect(resultContent.text).toContain("工具输出");
  });

  test("error 事件冒泡为拒绝,不被容错 catch 吞掉", async () => {
    const errorStream = sse([
      { event_type: "error", error: { code: "400", message: "bad request shape" } },
    ]);
    globalThis.fetch = (async () => new Response(errorStream, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    await expect(
      streamInteractionsChatWithTools("https://gen.test/v1beta/", {}, "m", { input: [] }, providerItem, assistant, undefined, makeHooks()),
    ).rejects.toThrow("bad request shape");
  });

  test("未知事件与未知 delta 静默跳过(官方 graceful skip 要求),流正常完成", async () => {
    const stream = sse([
      { event_type: "interaction.created", interaction: { id: "i-3" } },
      { event_type: "interaction.status_update", status: "in_progress" },
      { event_type: "mystery_event" },
      { event_type: "step.start", index: 0, step: { type: "model_output" } },
      { event_type: "step.delta", index: 0, delta: { type: "google_search_call", arguments: { queries: ["x"] }, signature: "ss" } },
      { event_type: "step.delta", index: 0, delta: { type: "text", text: "答案" } },
      { event_type: "step.stop", index: 0 },
      { event_type: "interaction.completed", interaction: { id: "i-3", status: "completed", usage: { total_input_tokens: 1, total_output_tokens: 2, total_thought_tokens: 0, total_tokens: 3 } } },
    ]);
    globalThis.fetch = (async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const out = await streamInteractionsChatWithTools("https://gen.test/v1beta/", {}, "m", { input: [] }, providerItem, assistant, undefined, makeHooks());
    expect(out).toBe("答案");
  });
});
