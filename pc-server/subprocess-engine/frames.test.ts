// subprocess-engine/frames.test.ts — 长度前缀帧的切分(P7.2.2)
import { describe, expect, test } from "bun:test";

import { createFrameDecoder, encodeFrame } from "./frames";

function collect(limit?: number) {
  const frames: string[] = [];
  const violations: string[] = [];
  const decoder = createFrameDecoder((text) => frames.push(text), (reason) => violations.push(reason), limit);
  return { frames, violations, decoder };
}

describe("长度前缀帧", () => {
  const samples = ["", "{}", '{"jsonrpc":"2.0","method":"host.emit","params":["中文 ✓ 𝒳"]}', "x".repeat(70_000)];
  const wire = Buffer.concat(samples.map(encodeFrame));

  test("一块里多帧、逐字节到达、任意位置切开:交付的帧与发出的一致", () => {
    const whole = collect();
    whole.decoder.feed(wire);
    expect(whole.frames).toEqual(samples);

    const byByte = collect();
    for (let i = 0; i < wire.length; i++) byByte.decoder.feed(wire.subarray(i, i + 1));
    expect(byByte.frames).toEqual(samples);

    for (const cut of [1, 3, 4, 5, 7, 70_010]) {
      const split = collect();
      split.decoder.feed(wire.subarray(0, cut));
      split.decoder.feed(wire.subarray(cut));
      expect(split.frames).toEqual(samples);
      expect(split.decoder.buffered).toBe(0);
    }
  });

  test("5 MB 的帧分成 64 KB 的块到达:原样还原,不留残余", () => {
    const big = JSON.stringify({ pad: "多字节".repeat(600_000) });
    const bytes = encodeFrame(big);
    const { frames, decoder } = collect();
    for (let offset = 0; offset < bytes.length; offset += 65_536) decoder.feed(bytes.subarray(offset, offset + 65_536));
    expect(frames).toEqual([big]);
    expect(decoder.buffered).toBe(0);
  });

  test("超过单帧上限即判违例,之后的字节不再处理;上限可在握手后改", () => {
    const small = collect(16);
    small.decoder.feed(Buffer.concat([encodeFrame("ok"), encodeFrame("x".repeat(17)), encodeFrame("after")]));
    expect(small.frames).toEqual(["ok"]);
    expect(small.violations).toHaveLength(1);
    expect(small.decoder.violated).toBe(true);

    const raised = collect(16);
    raised.decoder.setMaxFrameBytes(64);
    raised.decoder.feed(encodeFrame("x".repeat(40)));
    expect(raised.frames).toHaveLength(1);
  });

  test("正文不是合法 UTF-8:判违例", () => {
    const { frames, violations, decoder } = collect();
    const bad = Buffer.from([0, 0, 0, 2, 0xc3, 0x28]);
    decoder.feed(bad);
    expect(frames).toEqual([]);
    expect(violations).toHaveLength(1);
  });
});
