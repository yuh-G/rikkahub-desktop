// model-name-heuristic.test.ts — 启发式规整的验收用例。
// 主体用例集 = 用户拍板的 15 例(2026-09-29),逐条编码;启发式路径的唯一权威标准。
// 目录(官方名)路径的覆盖在 display-names.test.ts,本文件只锁「无目录时的下限」。

import { describe, expect, test } from "bun:test";
import { isUnclaimedModelDisplayName, prettifyModelId } from "./model-name-heuristic";

describe("isUnclaimedModelDisplayName — 未认领信号(渲染与落库共用的尺)", () => {
  test("空 / 等于 id / 与 id 排版等价 = 未认领;有增量 = 已认领", () => {
    expect(isUnclaimedModelDisplayName("", "gpt-5.4")).toBe(true);
    expect(isUnclaimedModelDisplayName(undefined, "gpt-5.4")).toBe(true);
    expect(isUnclaimedModelDisplayName("gpt-5.4", "gpt-5.4")).toBe(true);
    // 排版等价:只差大小写/连字/空格/点号(上游懒名抄写形态)
    expect(isUnclaimedModelDisplayName("K3", "k3")).toBe(true);
    expect(isUnclaimedModelDisplayName("Claude Opus 4.6", "claude-opus-4-6")).toBe(true);
    expect(isUnclaimedModelDisplayName("GPT 5.4 mini", "gpt-5.4-mini")).toBe(true);
    // 有真增量:保持已认领
    expect(isUnclaimedModelDisplayName("Kimi K3", "k3")).toBe(false);
    expect(isUnclaimedModelDisplayName("我的快枪手", "gpt-5.4")).toBe(false);
    // 删词改写(非排版等价)刻意不纳入:与「上游轻量策展」不可靠区分
    expect(isUnclaimedModelDisplayName("K2.7 Coding", "kimi-for-coding")).toBe(false);
  });
});

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

  test("日期别名行与官方基名同名(2026-09 审计:官方名从不保留 8 位日期尾巴)", () => {
    expect(prettifyModelId("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5");
  });

  test("快照日期尾剥离,给干净基名(用户拍板 2026-09-29;目录主流形态是括注,启发式产不出)", () => {
    expect(prettifyModelId("gpt-4o-2024-05-13")).toBe("GPT-4o");
    expect(prettifyModelId("gpt-4o-mini-2024-07-18")).toBe("GPT-4o mini");
    expect(prettifyModelId("qwen3-max-2026-01-23")).toBe("Qwen3 Max");
  });

  test("裸品牌-latest 连字保留:剥后只剩品牌词时 Latest 是唯一可区分内容(用户拍板 2026-09-29)", () => {
    expect(prettifyModelId("kimi-latest")).toBe("Kimi-Latest");
    expect(prettifyModelId("glm-latest")).toBe("GLM-Latest");
    expect(prettifyModelId("deepseek-latest")).toBe("DeepSeek-Latest");
    // 剥后还有功能词的照常剥(官方惯例)
    expect(prettifyModelId("mistral-large-latest")).toBe("Mistral Large");
    expect(prettifyModelId("gpt-5.2-chat-latest")).toBe("GPT-5.2 Chat");
    expect(prettifyModelId("mistral-code-latest")).toBe("Mistral Code");
  });

  test("chatgpt-image 是 OpenAI 图像系别名,按家族产品名收口(用户拍板 2026-09-29)", () => {
    expect(prettifyModelId("chatgpt-image-latest")).toBe("GPT-Image");
  });

  test("「品牌+X」缩写变体恒大写:目录全量实证 FlashX/AirX/TensorX 无一例外", () => {
    expect(prettifyModelId("glm-4.7-flashx")).toBe("GLM-4.7 FlashX");
    expect(prettifyModelId("glm-5.3-flashx")).toBe("GLM-5.3 FlashX");
    expect(prettifyModelId("glm-4.5-airx")).toBe("GLM-4.5 AirX");
    // max/codex 是完整单词,x 属于词本身,不受影响
    expect(prettifyModelId("qwen3-max")).toBe("Qwen3 Max");
    expect(prettifyModelId("gpt-5.3-codex-spark")).toBe("GPT-5.3 Codex Spark");
  });

  test("已是混合形态的段不二次破坏大小写", () => {
    expect(prettifyModelId("gpt-4o-mini")).toBe("GPT-4o mini");
    expect(prettifyModelId("GLM-4.7")).toBe("GLM-4.7");
  });

  test("点号分隔等同连字符;Gemini 家族 flash-lite 官方连字", () => {
    expect(prettifyModelId("gemini-2.5-flash-lite")).toBe("Gemini 2.5 Flash-Lite");
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
