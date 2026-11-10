// engines/loopback.test.ts — 回环传输的可序列化闸门(方案 §5.3 不变式 2 的执行器)
import { describe, expect, test } from "bun:test";
import { CodedError } from "../foundation/errors";
import type { EngineDriver, EngineHost, TurnRequest } from "./contract";
import { assertJsonSafe, connectDriver, connectHost, ContractPayloadError, jsonRoundTrip, STRICT_CONTRACT_TRANSPORT } from "./loopback";

const turn = { conversationId: "c1", turnId: "t1" };

function fakeDriver(overrides: Partial<EngineDriver> = {}): EngineDriver {
  return {
    kind: "fake",
    capabilities: { resumeSemantics: "run-and-suspend", steering: "boundary", nativeCompaction: false, placement: "portable" },
    startTurn: async () => ({ text: "ok", stopReason: "stop", compactions: [] }),
    abort: async () => undefined,
    dispose: async () => undefined,
    ...overrides,
  };
}

describe("assertJsonSafe", () => {
  test("纯数据通过;对象属性的 undefined 视为缺省键", () => {
    expect(() => assertJsonSafe({ a: 1, b: "x", c: [true, null], d: { e: undefined } }, "v")).not.toThrow();
  });

  test.each([
    ["函数", { fn: () => 1 }, "v.fn 是 function"],
    ["类实例", { at: new Date() }, "v.at 是类实例(Date)"],
    ["Map", { m: new Map() }, "v.m 是类实例(Map)"],
    ["非有限数", { n: Number.NaN }, "v.n 是非有限数"],
    ["数组里的 undefined", { list: [1, undefined] }, "v.list[1] 是数组里的 undefined"],
  ])("%s 被拒并指出路径", (_label, value, message) => {
    expect(() => assertJsonSafe(value, "v")).toThrow(message);
  });

  test("循环引用被拒;同一对象出现在兄弟位置不算循环", () => {
    const shared = { x: 1 };
    expect(() => assertJsonSafe({ a: shared, b: shared }, "v")).not.toThrow();
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => assertJsonSafe(loop, "v")).toThrow(ContractPayloadError);
  });

  test("jsonRoundTrip 返回副本,不与原对象共享引用", () => {
    const source = { nested: { list: [1, 2] } };
    const copy = jsonRoundTrip(source, "v");
    expect(copy).toEqual(source);
    expect(copy.nested).not.toBe(source.nested);
  });
});

describe("connectDriver / connectHost", () => {
  test("strict=false 原样返回(生产直调,零开销)", () => {
    const driver = fakeDriver();
    expect(connectDriver(driver, { strict: false })).toBe(driver);
  });

  test("bun test 下默认 strict", () => {
    expect(STRICT_CONTRACT_TRANSPORT).toBe(true);
  });

  test("strict:参数与返回值都是往返后的副本", async () => {
    let received: TurnRequest | undefined;
    const original: TurnRequest = { ...turn };
    const driver = connectDriver(
      fakeDriver({
        startTurn: async (req) => {
          received = req;
          return { text: "done", stopReason: null, compactions: [{ cutMessageId: null, summary: "s", tokensBefore: 3 }] };
        },
      }),
      { strict: true },
    );
    const result = await driver.startTurn(original);
    expect(received).toEqual(original);
    expect(received).not.toBe(original);
    expect(result.compactions[0]?.cutMessageId).toBeNull();
  });

  test("strict:引擎返回不可序列化的值 → 拒绝", async () => {
    const driver = connectDriver(
      fakeDriver({ startTurn: async () => ({ text: "x", stopReason: null, compactions: [], extra: () => 1 }) as never }),
      { strict: true },
    );
    await expect(driver.startTurn(turn)).rejects.toThrow("driver(fake).startTurn(返回值).extra 是 function");
  });

  test("strict:拒绝原因按跨进程形态还原(AbortError / CodedError / 普通错误)", async () => {
    const failWith = (err: unknown) => connectDriver(fakeDriver({ startTurn: async () => { throw err; } }), { strict: true });

    const aborted = await failWith(new DOMException("Generation stopped", "AbortError")).startTurn(turn).catch((e) => e);
    expect(aborted).toBeInstanceOf(DOMException);
    expect(aborted.name).toBe("AbortError");

    const coded = await failWith(new CodedError("压缩过短", "compact_context_too_short")).startTurn(turn).catch((e) => e);
    expect(coded).toBeInstanceOf(CodedError);
    expect(coded.errorCode).toBe("compact_context_too_short");

    const plain = await failWith(new Error("上游 500")).startTurn(turn).catch((e) => e);
    expect(plain).toBeInstanceOf(Error);
    expect(plain.message).toBe("上游 500");
  });

  test("strict:宿主侧单向通知同样校验(emit 携带函数即抛)", () => {
    const host: EngineHost = {
      emit: () => undefined,
      tools: { call: async () => ({ content: [] }) },
      steer: { take: async () => [] },
      models: { credential: async () => ({}) },
      report: () => undefined,
    };
    const strict = connectHost(host, { strict: true });
    expect(() => strict.emit(turn, { kind: "text_delta", text: "hi" })).not.toThrow();
    expect(() => strict.emit(turn, { kind: "text_delta", text: "hi", sneaky: () => 1 } as never)).toThrow(ContractPayloadError);
  });
});
