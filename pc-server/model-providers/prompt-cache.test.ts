// model-providers/prompt-cache.test.ts — 策略单源单测(方案 §8.2 C1-1)。
// 四字段 × 默认值 × 订阅行规则(D10):策略是所有引擎的缓存意图唯一出口,
// 任何字段语义漂移(默认值翻转/订阅行规则走形)都在这里先红。
import { describe, expect, test } from "bun:test";

import { promptCachePolicyFor } from "./prompt-cache";
import type { Provider } from "../foundation/types";

function claudeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    type: "claude",
    id: "test-claude",
    enabled: true,
    name: "Test Claude",
    builtIn: false,
    shortDescription: "",
    description: "",
    apiKey: "sk-test",
    baseUrl: "https://api.anthropic.com",
    models: [],
    balanceOption: { enabled: false, apiPath: "", resultPath: "" },
    ...overrides,
  };
}

function oauthClaudeProvider(overrides: Partial<Provider> = {}): Provider {
  return claudeProvider({
    authMode: "oauth",
    oauth: { flow: "anthropic", credential: {}, signedInAt: 0 },
    ...overrides,
  });
}

describe("promptCachePolicyFor 默认值(字段字面语义)", () => {
  test("apiKey 行全默认:缓存关、TTL 5m、预热跟随关、OpenAI 键关", () => {
    expect(promptCachePolicyFor(claudeProvider())).toEqual({
      anthropicCaching: false,
      anthropicTtl: "5m",
      warming: false,
      openaiCacheKey: false,
    });
  });

  test("promptCaching 开:anthropicCaching 开,warming 默认跟随开(!== false 即开)", () => {
    const policy = promptCachePolicyFor(claudeProvider({ promptCaching: true }));
    expect(policy.anthropicCaching).toBe(true);
    expect(policy.warming).toBe(true);
    expect(policy.anthropicTtl).toBe("5m");
  });

  test("promptCaching 开 + 显式 promptCacheWarming:false → 预热关", () => {
    expect(promptCachePolicyFor(claudeProvider({ promptCaching: true, promptCacheWarming: false })).warming).toBe(false);
  });

  test("promptCaching 开 + promptCacheWarming:true → 预热开(显式与默认同形)", () => {
    expect(promptCachePolicyFor(claudeProvider({ promptCaching: true, promptCacheWarming: true })).warming).toBe(true);
  });

  test("TTL:1h 显式、缺省与非法值落 5m(normalize 同款口径)", () => {
    expect(promptCachePolicyFor(claudeProvider({ promptCaching: true, promptCacheTtl: "1h" })).anthropicTtl).toBe("1h");
    expect(promptCachePolicyFor(claudeProvider({ promptCaching: true, promptCacheTtl: "5m" })).anthropicTtl).toBe("5m");
    expect(promptCachePolicyFor(claudeProvider({ promptCaching: true, promptCacheTtl: undefined })).anthropicTtl).toBe("5m");
  });

  test("promptCacheKey:仅 openaiCacheKey 消费,不影响 anthropic 面(旧散读行为保持)", () => {
    const policy = promptCachePolicyFor(claudeProvider({ promptCacheKey: true }));
    expect(policy.openaiCacheKey).toBe(true);
    expect(policy.anthropicCaching).toBe(false);
  });
});

describe("订阅行规则(D10:规则住策略单源,引擎中立)", () => {
  test("OAuth Claude 行缓存恒开:无视 promptCaching 字段(undefined/显式 false 均开)", () => {
    expect(promptCachePolicyFor(oauthClaudeProvider()).anthropicCaching).toBe(true);
    expect(promptCachePolicyFor(oauthClaudeProvider({ promptCaching: false })).anthropicCaching).toBe(true);
    expect(promptCachePolicyFor(oauthClaudeProvider({ promptCaching: true })).anthropicCaching).toBe(true);
  });

  test("订阅行预热默认跟随开;用户显式关(promptCacheWarming:false)仍然关——恒开的只是缓存,预热尊重用户", () => {
    expect(promptCachePolicyFor(oauthClaudeProvider()).warming).toBe(true);
    expect(promptCachePolicyFor(oauthClaudeProvider({ promptCacheWarming: false })).warming).toBe(false);
  });

  test("非 claude 的 OAuth 行(如 Codex)不吃订阅行规则:anthropicCaching 仍读字段字面", () => {
    const codexLike = {
      type: "openai",
      authMode: "oauth" as const,
      useResponseApi: true,
    } as unknown as Provider;
    expect(promptCachePolicyFor(codexLike).anthropicCaching).toBe(false);
  });
});
