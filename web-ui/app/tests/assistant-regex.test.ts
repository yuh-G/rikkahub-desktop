import { describe, expect, test } from "bun:test";

import { applyAssistantRegexes } from "~/lib/assistant-regex";

const assistant = {
  id: "assistant-regex-smoke",
  name: "Regex Smoke",
  regexes: [
    {
      id: "assistant-visual",
      enabled: true,
      visualOnly: true,
      affectingScope: ["ASSISTANT"],
      findRegex: "visible-secret",
      replaceString: "visible-redacted",
    },
    {
      id: "assistant-stored",
      enabled: true,
      visualOnly: false,
      affectingScope: ["ASSISTANT"],
      findRegex: "stored-secret",
      replaceString: "stored-redacted",
    },
    {
      id: "user-visual",
      enabled: true,
      visualOnly: true,
      affectingScope: ["USER"],
      findRegex: "user-secret",
      replaceString: "user-redacted",
    },
  ],
} as any;

describe("assistant visual regex transforms", () => {
  test("visual regex applies only to matching visual display scope", () => {
    expect(applyAssistantRegexes("visible-secret", assistant, "ASSISTANT", true)).toBe(
      "visible-redacted",
    );
    expect(applyAssistantRegexes("visible-secret", assistant, "USER", true)).toBe("visible-secret");
  });

  test("non-visual regex is kept out of visual-only render pass", () => {
    expect(applyAssistantRegexes("stored-secret", assistant, "ASSISTANT", true)).toBe(
      "stored-secret",
    );
    expect(applyAssistantRegexes("stored-secret", assistant, "ASSISTANT", false)).toBe(
      "stored-redacted",
    );
  });

  test("user and assistant scopes stay isolated", () => {
    expect(applyAssistantRegexes("user-secret", assistant, "USER", true)).toBe("user-redacted");
    expect(applyAssistantRegexes("user-secret", assistant, "ASSISTANT", true)).toBe("user-secret");
  });
});

// 批次二 R8-3:编译缓存与病态正则防线
describe("assistant regex hardening", () => {
  const makeAssistant = (findRegex: string, replaceString = "X") =>
    ({
      id: "hardening",
      name: "Hardening",
      regexes: [
        {
          id: "r1",
          enabled: true,
          visualOnly: true,
          affectingScope: ["ASSISTANT"],
          findRegex,
          replaceString,
        },
      ],
    }) as any;

  test("invalid regex is ignored and text passes through", () => {
    expect(applyAssistantRegexes("hello", makeAssistant("([unclosed"), "ASSISTANT", true)).toBe(
      "hello",
    );
  });

  test("pattern longer than the length cap is rejected", () => {
    const longPattern = "a".repeat(501);
    const text = "a".repeat(501);
    expect(applyAssistantRegexes(text, makeAssistant(longPattern), "ASSISTANT", true)).toBe(text);
  });

  test("cached global regex stays correct across repeated calls (lastIndex reset)", () => {
    const a = makeAssistant("foo", "bar");
    expect(applyAssistantRegexes("foo foo foo", a, "ASSISTANT", true)).toBe("bar bar bar");
    expect(applyAssistantRegexes("foo foo foo", a, "ASSISTANT", true)).toBe("bar bar bar");
  });

  test("catastrophic pattern is disabled after exceeding the time budget", () => {
    // (a+)+$ 对 "aaa...b" 是经典灾难性回溯:26 个 a ≈ 2^26 级回溯,必然超 50ms 预算。
    const a = makeAssistant("(a+)+$", "X");
    const evil = `${"a".repeat(26)}b`;
    // 首跑:超预算,pattern 被拉黑(文本无匹配,原样返回)
    expect(applyAssistantRegexes(evil, a, "ASSISTANT", true)).toBe(evil);
    // 复跑:更长的输入也不再执行该 pattern,立即返回。慢 runner 上绝对耗时含调度噪声,
    // 断言改相对口径——与一条被拉黑 pattern 的普通遍历同量级,而非与灾难回溯同量级。
    const longer = `${"a".repeat(40)}b`;
    const passes = 200;
    const startedAt = performance.now();
    for (let i = 0; i < passes; i++) {
      expect(applyAssistantRegexes(longer, a, "ASSISTANT", true)).toBe(longer);
    }
    const perCallMs = (performance.now() - startedAt) / passes;
    expect(perCallMs).toBeLessThan(5);
  });
});
