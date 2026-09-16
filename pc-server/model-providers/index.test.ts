// model-providers/index 纯函数单测:能力推断(Kimi 代际经方言谓词——回归锁)。
import { describe, expect, it } from "bun:test";

import { SUNSET_PROVIDER_IDS, builtinProviderRank, defaultProviders, inferModelAbilities } from "./index";

describe("inferModelAbilities", () => {
  it("Kimi K2.5+ 全系推理(方言谓词;曾因正则无 kimi 模式致能力位缺失:UI 无推理选项、两引擎思考链路未激活)", () => {
    for (const id of [
      "kimi-k3",
      "kimi-k3.5",
      "k3",
      "kimi-k2.5",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "Pro/moonshotai/Kimi-K2.5",
      "kimi-thinking-preview", // 关键词 thinking 兜住(既有行为)
    ]) {
      expect(inferModelAbilities(id)).toContain("REASONING");
    }
    // 旧代不误伤:legacy 模型非推理。
    for (const id of ["kimi-latest", "moonshot-v1-8k", "kimi-k2"]) {
      expect(inferModelAbilities(id)).not.toContain("REASONING");
    }
  });

  it("既有模式回归锁:主流推理模型仍识别,常规模型不误伤", () => {
    for (const id of ["gpt-5", "o3-mini", "deepseek-reasoner", "qwen3-max", "glm-5", "claude-opus-4-6", "gemini-2.5-pro", "grok-4"]) {
      expect(inferModelAbilities(id)).toContain("REASONING");
    }
    for (const id of ["gpt-4o", "gemini-2.0-flash", "llama-3.3-70b"]) {
      expect(inferModelAbilities(id)).not.toContain("REASONING");
    }
  });
});

describe("预置供应商(对齐 APP)", () => {
  it("MiniMax(Claude 形)/ MIMO(OpenAI 形)在册,base 与 APP 一致;MaruCode 赞助商不移植", () => {
    const byId = new Map(defaultProviders().map((p) => [p.id, p]));
    const minimax = byId.get("b4deabea-20fb-4101-a74c-65679c7e4754");
    expect(minimax?.name).toBe("MiniMax");
    expect(minimax?.type).toBe("claude");
    expect(minimax?.baseUrl).toBe("https://api.minimaxi.com/anthropic/v1");
    const mimo = byId.get("a2bafe83-eaf8-47bf-a8c7-3dd82d89f637");
    expect(mimo?.name).toBe("MIMO");
    expect(mimo?.type).toBe("openai");
    expect(mimo?.baseUrl).toBe("https://api.xiaomimimo.com/v1");
    // MaruCode(afbc54ad-…)是 APP 赞助商位,明确不引进。
    expect(byId.has("afbc54ad-807e-4455-9594-7d7a546356ad")).toBe(false);
    // 两家都按预置顺序参与排序(rank 有限值)。
    expect(builtinProviderRank(minimax!)).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(builtinProviderRank(mimo!)).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it("RikkaHub 已下架:不在默认集,在 SUNSET 集(存量子清理只删未配 key 的)", () => {
    const RID = "a8d2d463-e8c0-41f2-b89e-f5eb8e716cce";
    expect(defaultProviders().some((p) => p.id === RID)).toBe(false);
    expect(SUNSET_PROVIDER_IDS.has(RID)).toBe(true);
    // 下架后不再参与内置排序(回 MAX_SAFE_INTEGER,沉到自定义区)。
    expect(builtinProviderRank({ id: RID } as any)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("SUNSET 集合不残留在默认供应商里", () => {
    const ids = new Set(defaultProviders().map((p) => p.id));
    for (const sunsetId of SUNSET_PROVIDER_IDS) {
      expect(ids.has(sunsetId)).toBe(false);
    }
  });
});
