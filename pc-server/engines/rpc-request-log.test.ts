// engines/rpc-request-log.test.ts — host.models.log 请求正文差分(P7.2.4)
//
// 锁:①逐条还原原记录(首次整份、之后差分、不像的整份、短正文不做差分);②会话间互不干扰;③差分只带新增的量级;
// ④找不到前文即抛,抛过之后整份发的记录照常还原。
import { describe, expect, test } from "bun:test";

import type { ModelRequestRecord, TurnRef } from "./contract";
import { createRequestLogDecoder, createRequestLogEncoder } from "./rpc-request-log";

const turnA: TurnRef = { conversationId: "conv-a", turnId: "t1" };
const turnB: TurnRef = { conversationId: "conv-b", turnId: "t2" };

const record = (requestBody?: string): ModelRequestRecord => ({
  providerId: "p", providerName: "P", url: "http://x/v1/chat/completions", method: "POST", ok: true, status: 200, durationMs: 5,
  ...(requestBody === undefined ? {} : { requestBody }),
});

const body = (turns: number, tail = "") =>
  JSON.stringify({ model: "m", messages: Array.from({ length: turns }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `第${i}条`.repeat(40) })), stream: true, tail });

describe("请求正文差分", () => {
  test("首次整份、之后只传差分;逐条还原原记录;会话间互不干扰", () => {
    const encode = createRequestLogEncoder();
    const decode = createRequestLogDecoder();
    const sequence: Array<[TurnRef, ModelRequestRecord]> = [
      [turnA, record(body(40))],
      [turnA, record(body(42))],
      [turnB, record(body(40, "b"))],
      [turnA, record(body(42, "改了结尾"))],
      [turnA, record("短")],
      [turnA, record(body(44))],
      [turnA, record(JSON.stringify({ other: "x".repeat(20_000) }))],
      [turnA, record()],
      [turnB, record(body(42, "b"))],
    ];
    const wires = sequence.map(([turn, item]) => [turn, JSON.parse(JSON.stringify(encode(turn, item)))] as const);
    expect(wires.map(([turn, wire]) => decode(turn, wire))).toEqual(sequence.map(([, item]) => item));
    expect(wires.map(([, wire]) => ("bodyDiff" in wire ? "diff" : "full"))).toEqual(["full", "diff", "full", "diff", "full", "full", "full", "full", "diff"]);
    const diff = wires[1]![1].bodyDiff!;
    expect(diff.insert.length).toBeLessThan(1_000);
  });

  test("找不到前文即抛;之后整份发的记录照常还原", () => {
    const encode = createRequestLogEncoder();
    encode(turnA, record(body(40)));
    const wire = encode(turnA, record(body(41)));
    const decode = createRequestLogDecoder();
    expect(() => decode(turnA, wire)).toThrow("没有前文");
    expect(decode(turnA, record(body(40)))).toEqual(record(body(40)));
  });
});
