// engines/rpc-events.test.ts — host.emit 跨进程整形与合并(P7.2.4)
//
// 锁:①编码 → 解码逐条还原原事件(参数后缀、建卡不重带参数、执行中输出的后缀、非前缀快照整份);②线上只带新增
// 内容;③合并:窗口外的第一条立即发,窗口内相邻正文拼接、同卡快照留最新,非增量事件连同攒着的立即发;④经应用器
// 落成的消息与逐条直发相同。
import { describe, expect, test } from "bun:test";

import { createGenerationEventApplier } from "../conversations/generation-apply";
import type { Conversation, Message } from "../foundation/types";
import type { GenerationEvent } from "../inference-engine/events";
import type { TurnRef } from "./contract";
import { createEmitCoalescer, createEmitDecoder, createEmitEncoder, type WireEmitBatch } from "./rpc-events";

const turn: TurnRef = { conversationId: "conv-ev", turnId: "turn-ev" };

function roundTrip(events: GenerationEvent[]) {
  const encode = createEmitEncoder();
  const decode = createEmitDecoder();
  const wires = events.map((event) => JSON.parse(JSON.stringify(encode(turn, event))));
  return { wires, decoded: wires.map((wire) => decode(turn, wire)) };
}

const card = (input: string): GenerationEvent => ({
  kind: "tool_call_created",
  toolCallId: "tc",
  toolName: "write",
  input,
  approvalState: { type: "auto" },
  metadata: { attribution: { pluginId: "dev:x" } },
});
const running = (text: string, extra: Record<string, unknown> = {}): GenerationEvent => ({
  kind: "tool_result",
  toolCallId: "tc",
  output: [{ type: "text", text, ...extra } as never],
  final: false,
});

describe("整形", () => {
  test("参数后缀、建卡不重带参数、输出后缀;解码逐条还原原事件", () => {
    const events: GenerationEvent[] = [
      card(""),
      { kind: "tool_input_delta", toolCallId: "tc", input: '{"pa' },
      { kind: "tool_input_delta", toolCallId: "tc", input: '{"path":"a"}' },
      card('{"path":"a"}'),
      card('{"path":"a"}'),
      running("line1\n", { metadata: { workspace: { tool: "bash", details: {} } } }),
      running("line1\nline2\n", { metadata: { workspace: { tool: "bash", details: {} } } }),
      running("[truncated]\nline3\n"),
      { kind: "tool_result", toolCallId: "tc", output: [{ type: "text", text: "done" }] },
      { kind: "tool_input_delta", toolCallId: "tc", input: '{"x":1}' },
    ];
    const { wires, decoded } = roundTrip(events);
    expect(decoded).toEqual(events);
    expect(wires[2]).toEqual({ kind: "tool_input_delta", toolCallId: "tc", append: 'th":"a"}' });
    expect(wires[3]).not.toHaveProperty("input");
    expect(wires[3].sameInput).toBe(true);
    expect(wires[6].append).toBe("line2\n");
    expect(JSON.stringify(wires[6])).not.toContain("line1");
    // 不是前缀延伸的快照整份发;终局结果清掉记录,之后的同 id 事件也是整份。
    expect(wires[7]).toEqual(events[7]);
    expect(wires[9]).toEqual(events[9]);
  });

  test("不同轮的同 id 工具卡互不干扰;缩写找不到前文即抛", () => {
    const encode = createEmitEncoder();
    const other: TurnRef = { conversationId: "conv-ev", turnId: "turn-other" };
    encode(turn, { kind: "tool_input_delta", toolCallId: "tc", input: "{" });
    expect(encode(other, { kind: "tool_input_delta", toolCallId: "tc", input: "{}" })).toEqual({ kind: "tool_input_delta", toolCallId: "tc", input: "{}" });
    expect(() => createEmitDecoder()(turn, { kind: "tool_input_delta", toolCallId: "tc", append: "}" })).toThrow("没有前文");
  });

  test("写大文件:2000 段累计参数,线上只有参数本身的量级", () => {
    const chunk = "x".repeat(50);
    const events: GenerationEvent[] = [card("")];
    let input = "";
    for (let i = 0; i < 2000; i += 1) {
      input += chunk;
      events.push({ kind: "tool_input_delta", toolCallId: "tc", input });
    }
    events.push(card(input), card(input));
    const { wires, decoded } = roundTrip(events);
    expect(decoded.at(-1)).toEqual(events.at(-1)!);
    const bytes = wires.reduce((sum, wire) => sum + JSON.stringify(wire).length, 0);
    // 未合并时每条另有几十字节的外壳(累计全文的发法是 1 亿字节)。
    expect(bytes).toBeLessThan(input.length * 3);
  });
});

describe("合并", () => {
  async function collect(run: (emit: (event: GenerationEvent) => void, flush: () => void) => Promise<void> | void) {
    const batches: WireEmitBatch[] = [];
    const coalescer = createEmitCoalescer((batch) => void batches.push(JSON.parse(JSON.stringify(batch))));
    await run((event) => coalescer.emit(turn, event), () => coalescer.flush());
    await Bun.sleep(40);
    coalescer.close();
    const decode = createEmitDecoder();
    return { batches, events: batches.flat().map(([ref, wire]) => decode(ref, wire)) };
  }

  test("窗口外的第一条立即发;窗口内相邻正文拼接,同卡快照只留最新;收尾事件连同攒着的立即发", async () => {
    let immediate = 0;
    const { batches, events } = await collect((emit) => {
      emit({ kind: "text_delta", text: "a" });
      immediate = 1;
      emit({ kind: "text_delta", text: "b" });
      emit({ kind: "text_delta", text: "c" });
      emit({ kind: "reasoning_delta", text: "r1" });
      emit({ kind: "reasoning_delta", text: "r2" });
      emit(card(""));
      emit({ kind: "tool_input_delta", toolCallId: "tc", input: '{"a' });
      emit({ kind: "tool_input_delta", toolCallId: "tc", input: '{"a":1}' });
      emit(running("1\n"));
      emit(running("1\n2\n"));
      emit({ kind: "finished", content: "abc", stopReason: "stop" });
    });
    expect(immediate).toBe(1);
    expect(batches[0]).toEqual([[turn, { kind: "text_delta", text: "a" }]]);
    expect(events).toEqual([
      { kind: "text_delta", text: "a" },
      { kind: "text_delta", text: "bc" },
      { kind: "reasoning_delta", text: "r1r2" },
      card(""),
      { kind: "tool_input_delta", toolCallId: "tc", input: '{"a":1}' },
      running("1\n2\n"),
      { kind: "finished", content: "abc", stopReason: "stop" },
    ]);
  });

  test("攒着的增量按窗口到点发出;带 metadata 的思考增量不合并", async () => {
    const { batches, events } = await collect(async (emit) => {
      emit({ kind: "text_delta", text: "a" });
      emit({ kind: "reasoning_delta", text: "x", metadata: { sig: "1" } });
      emit({ kind: "reasoning_delta", text: "y" });
    });
    expect(batches.length).toBe(2);
    expect(events).toEqual([
      { kind: "text_delta", text: "a" },
      { kind: "reasoning_delta", text: "x", metadata: { sig: "1" } },
      { kind: "reasoning_delta", text: "y" },
    ]);
  });

  test("flush 立即发出攒着的;close 后不再发", async () => {
    const batches: WireEmitBatch[] = [];
    const coalescer = createEmitCoalescer((batch) => void batches.push(batch));
    coalescer.emit(turn, { kind: "text_delta", text: "a" });
    coalescer.emit(turn, { kind: "text_delta", text: "b" });
    expect(batches.length).toBe(1);
    coalescer.flush();
    expect(batches.length).toBe(2);
    coalescer.emit(turn, { kind: "text_delta", text: "c" });
    coalescer.close();
    await Bun.sleep(40);
    expect(batches.flat().map(([, wire]) => wire.text)).toEqual(["a", "b"]);
  });
});

describe("经应用器落成的消息", () => {
  function applyAll(events: GenerationEvent[]): Message {
    const message: Message = {
      id: "m", role: "ASSISTANT", parts: [], annotations: [], createdAt: "", finishedAt: null, translation: null, modelId: "m1", usage: null,
    };
    const node = { id: "n", messages: [message], selectIndex: 0 };
    const conversation = { id: "c", assistantId: "a", title: "t", messages: [node], isPinned: false, createAt: 0, updateAt: 0, systemPrompt: null, chatSuggestions: [] } as Conversation;
    const apply = createGenerationEventApplier({ conversation, node, message });
    for (const event of events) apply(event);
    // 时间戳随应用时刻变,比对前抹掉。
    return JSON.parse(JSON.stringify(message, (key, value) => (/At$/.test(key) ? null : value)));
  }

  test("合并 + 整形后逐条应用,与原事件逐条应用落成相同的消息", async () => {
    const events: GenerationEvent[] = [
      { kind: "reasoning_delta", text: "想" },
      { kind: "reasoning_delta", text: "一想" },
      { kind: "text_delta", text: "好" },
      { kind: "text_delta", text: "的" },
      card(""),
      ...Array.from({ length: 30 }, (_, i): GenerationEvent => ({ kind: "tool_input_delta", toolCallId: "tc", input: `{"n":${"9".repeat(i + 1)}}`.slice(0, i + 3) })),
      card('{"n":1}'),
      { kind: "tool_approval_updated", toolCallId: "tc", approvalState: { type: "pending" } },
      { kind: "tool_approval_updated", toolCallId: "tc", approvalState: { type: "approved" } },
      card('{"n":1}'),
      ...Array.from({ length: 20 }, (_, i) => running(Array.from({ length: i + 1 }, (_, k) => `L${k}
`).join(""))),
      { kind: "tool_result", toolCallId: "tc", output: [{ type: "text", text: "完成" }] },
      { kind: "text_delta", text: "收尾" },
    ];
    const batches: WireEmitBatch[] = [];
    const coalescer = createEmitCoalescer((batch) => void batches.push(JSON.parse(JSON.stringify(batch))));
    for (const event of events) coalescer.emit(turn, event);
    await Bun.sleep(40);
    coalescer.close();
    const decode = createEmitDecoder();
    const viaWire = batches.flat().map(([ref, wire]) => decode(ref, wire));
    expect(viaWire.length).toBeLessThan(events.length);
    expect(applyAll(viaWire)).toEqual(applyAll(events));
  });
});
