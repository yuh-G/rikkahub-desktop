// workspace/performance.test.ts — M4-2 性能验收(可在无头环境量化断言的部分)。
// 前端 fps(5MB 会话流式 ≥45fps)必须真机测,不在此伪造;此处锁住两条决定前端流畅度的
// 后端不变量,它们是"大会话不卡"的根:
//   1) 长输出内存有界 + 全量落盘:20MB bash 输出下,进程常驻内存维持在 KB 量级,
//      完整输出进临时文件而非内存(累积器是 pi 内建 bash 工具自带的;落盘目录由 pi 定在系统临时目录);
//   2) 流式传输 O(N) 而非 O(N²):工具单文本输出逐块增长时,增量协议每帧只发新增字节,
//      累计传输量恰等于最终长度(线性),远低于"每帧重发整节点"的二次量。
import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";

import { OutputAccumulator } from "../../pi/packages/coding-agent/src/core/tools/output-accumulator.ts";
import { DEFAULT_MAX_BYTES } from "../../pi/packages/coding-agent/src/core/tools/truncate.ts";
import { diffFingerprints, fingerprintNode } from "../api/node-delta";
import type { MessageNode } from "../foundation/types";

describe("长输出内存有界 + 落盘(bash 流式)", () => {
  test("20MB 输出:显示截断 ≤ 50KB,常驻内存 < 1MB,完整输出落盘", async () => {
    const acc = new OutputAccumulator({ tempFilePrefix: "rkh-perf" });

    const oneMb = Buffer.alloc(1024 * 1024, 0x61); // 'a' * 1MB
    const totalMb = 20;
    for (let i = 0; i < totalMb; i++) acc.append(oneMb);
    acc.finish();

    const snap = acc.snapshot({ persistIfTruncated: true });
    await acc.closeTempFile();

    // 显示快照按 50KB 尾部截断,不把 20MB 塞给前端
    expect(Buffer.byteLength(snap.content, "utf-8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(snap.truncation.truncated).toBe(true);
    expect(snap.truncation.totalBytes).toBe(totalMb * 1024 * 1024);

    // 完整输出在磁盘,不在内存
    expect(snap.fullOutputPath).toBeTruthy();
    expect(statSync(snap.fullOutputPath!).size).toBe(totalMb * 1024 * 1024);

    // 白盒断言常驻内存有界:落盘后 rawChunks 清空,tailText 受 maxRollingBytes 约束
    const priv = acc as unknown as { rawChunks: Buffer[]; tailText: string };
    const retained = priv.rawChunks.reduce((s, b) => s + b.length, 0) + Buffer.byteLength(priv.tailText, "utf-8");
    expect(retained).toBeLessThan(1024 * 1024); // 20MB 流常驻 < 1MB
  });
});

describe("流式传输 O(N)(增量协议 vs 整节点重发)", () => {
  function nodeWithToolText(text: string): MessageNode {
    return {
      messages: [
        {
          id: "m1",
          role: "ASSISTANT",
          parts: [{ type: "tool", toolName: "bash", toolCallId: "c1", input: "{}", output: [{ type: "text", text }] }],
        },
      ],
      selectIndex: 0,
    } as unknown as MessageNode;
  }

  test("工具单文本输出逐块增长:累计增量量 = 最终长度(线性),零关键帧回退", () => {
    const step = 4096;
    const steps = 500; // 最终 ~2MB
    let acc = "";
    let prev = fingerprintNode(nodeWithToolText(acc))!;
    let totalDeltaBytes = 0;
    let keyframes = 0;

    for (let i = 0; i < steps; i++) {
      acc += "x".repeat(step);
      const cur = fingerprintNode(nodeWithToolText(acc))!;
      const deltas = diffFingerprints(prev, cur);
      if (deltas === null) {
        keyframes++;
      } else {
        totalDeltaBytes += deltas.reduce((s, d) => s + d.text.length, 0);
      }
      prev = cur;
    }

    // 每帧只发新增块,无一次回退整节点关键帧
    expect(keyframes).toBe(0);
    // 线性:每个字节恰传一次,累计 = 最终长度
    expect(totalDeltaBytes).toBe(step * steps);
    // 与"每帧重发整节点"的二次量对比,低两个数量级以上
    const naiveQuadratic = (step * steps * (steps + 1)) / 2;
    expect(totalDeltaBytes).toBeLessThan(naiveQuadratic / 100);
  });
});
