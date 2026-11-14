// 展示型 diff 解析(M2-3):格式来自 pi 内建 edit 工具的 generateDiffString(pi/packages/coding-agent/src/core/tools/edit-diff.ts)
// ——`+12 内容`/`-12 内容`/` 12 上下文`/`    ...` 跳行标记。
import { describe, expect, test } from "bun:test";

import { parseDiffLines, parseDiffStats } from "~/components/workspace/diff-view";

const SAMPLE = ["  1 const a = 1;", "-  2 const b = 2;", "+  2 const b = 3;", "+  3 const c = 4;", "      ...", " 10 export {};"].join(
  "\n",
);

describe("parseDiffLines", () => {
  test("符号/行号/内容三段解析", () => {
    const lines = parseDiffLines(SAMPLE);
    expect(lines[0]).toEqual({ sign: " ", lineNo: "1", text: "const a = 1;" });
    expect(lines[1]).toEqual({ sign: "-", lineNo: "2", text: "const b = 2;" });
    expect(lines[2]).toEqual({ sign: "+", lineNo: "2", text: "const b = 3;" });
  });

  test("跳行标记识别为省略行", () => {
    const lines = parseDiffLines(SAMPLE);
    expect(lines[4]!.ellipsis).toBe(true);
  });

  test("不合格行按上下文兜底,不抛错", () => {
    const lines = parseDiffLines("随便什么内容");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.sign).toBe(" ");
  });

  test("空串 → 空列表", () => {
    expect(parseDiffLines("")).toEqual([]);
  });
});

describe("parseDiffStats", () => {
  test("+N/-M 统计", () => {
    expect(parseDiffStats(SAMPLE)).toEqual({ added: 2, removed: 1 });
  });

  test("无变更", () => {
    expect(parseDiffStats("  1 a\n  2 b")).toEqual({ added: 0, removed: 0 });
  });
});
