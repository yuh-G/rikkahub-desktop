import { describe, expect, test } from "bun:test";

import { applyAssistantRegexes } from "./assistant-regex";

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
    expect(applyAssistantRegexes("visible-secret", assistant, "ASSISTANT", true)).toBe("visible-redacted");
    expect(applyAssistantRegexes("visible-secret", assistant, "USER", true)).toBe("visible-secret");
  });

  test("non-visual regex is kept out of visual-only render pass", () => {
    expect(applyAssistantRegexes("stored-secret", assistant, "ASSISTANT", true)).toBe("stored-secret");
    expect(applyAssistantRegexes("stored-secret", assistant, "ASSISTANT", false)).toBe("stored-redacted");
  });

  test("user and assistant scopes stay isolated", () => {
    expect(applyAssistantRegexes("user-secret", assistant, "USER", true)).toBe("user-redacted");
    expect(applyAssistantRegexes("user-secret", assistant, "ASSISTANT", true)).toBe("user-secret");
  });
});
