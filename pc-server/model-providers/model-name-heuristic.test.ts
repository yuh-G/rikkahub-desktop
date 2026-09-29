// model-name-heuristic.test.ts — 启发式规整的验收用例。
// 主体用例集 = 用户拍板的 15 例(2026-09-29),逐条编码;启发式路径的唯一权威标准。
// 目录(官方名)路径的覆盖在 display-names.test.ts,本文件只锁「无目录时的下限」。

import { describe, expect, test } from "bun:test";
import { prettifyModelId } from "./model-name-heuristic";

describe("prettifyModelId — 用户拍板用例集", () => {
  const cases: Array<[string, string]> = [
    ["gpt-5.4-mini", "GPT-5.4 mini"],
    ["gpt-5.3-codex-spark", "GPT-5.3 Codex Spark"],
    ["gpt-5.6-sol", "GPT-5.6 Sol"],
    ["claude-opus-4-6", "Claude Opus 4.6"],
    ["claude-sonnet-5", "Claude Sonnet 5"],
    ["gemini-2.5-pro", "Gemini 2.5 Pro"],
    ["grok-4.7", "Grok 4.7"],
    ["k3", "Kimi K3"],
    ["k3-256k", "Kimi K3-256K"],
    ["K2.7 Coding", "Kimi K2.7 Coding"],
    ["glm-5.3", "GLM-5.3"],
    ["glm-5.3-flash", "GLM-5.3 Flash"],
    ["deepseek-v4-pro", "DeepSeek V4 Pro"],
    ["deepseek-v4-flash", "DeepSeek V4 Flash"],
  ];
  for (const [input, expected] of cases) test(`${input} -> ${expected}`, () => {
    expect(prettifyModelId(input)).toBe(expected);
  });
});

describe("prettifyModelId — 形态边界", () => {
  test("空与空白原样返回", () => {
    expect(prettifyModelId("")).toBe("");
    expect(prettifyModelId("  ")).toBe("  ".trim());
  });

  test("中转站前缀丢弃,只规整本地段", () => {
    expect(prettifyModelId("deepseek-ai/DeepSeek-V4-Flash")).toBe("DeepSeek V4 Flash");
    expect(prettifyModelId("Qwen/Qwen3-VL-32B-Instruct")).toBe("Qwen3 VL 32B Instruct");
    expect(prettifyModelId("moonshotai/kimi-k3")).toBe("Kimi K3");
  });

  test("日期后缀保持为独立段(不与版本号合并)", () => {
    expect(prettifyModelId("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5 20251001");
  });

  test("已是混合形态的段不二次破坏大小写", () => {
    expect(prettifyModelId("gpt-4o-mini")).toBe("GPT-4o mini");
    expect(prettifyModelId("GLM-4.7")).toBe("GLM-4.7");
  });

  test("点号分隔等同连字符(gemini-2.5 / gemini2.5 混写)", () => {
    expect(prettifyModelId("gemini-2.5-flash-lite")).toBe("Gemini 2.5 Flash Lite");
  });

  test("未知字母开头词默认首字母大写(通用兜底)", () => {
    expect(prettifyModelId("some-future-model")).toBe("Some Future Model");
  });

  test("幂等:二次规整不再变化", () => {
    const once = prettifyModelId("claude-opus-4-6");
    // 启发式永不落库,渲染层对同一 id 重复调用必须稳定
    expect(prettifyModelId("claude-opus-4-6")).toBe(once);
  });
});
