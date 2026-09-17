// model-providers/index 纯函数单测:能力推断(Kimi 代际经方言谓词——回归锁)。
import { describe, expect, it } from "bun:test";

import { SUNSET_PROVIDER_IDS, builtinProviderRank, defaultProviders, inferInputModalities, inferModelAbilities } from "./index";

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

  it("2026-09 新注册模型能力:腾讯 hy3/hy4 等新命中 TOOL+REASONING;裸名/常规模型不误伤", () => {
    // 对齐 APP ModelRegistry:hy3/hy4、mimo-v3、minimax-m3、longcat、step-3.7、muse、裸 k3 均 toolReasoningAbility()。
    for (const id of ["hy3", "hy4-preview", "mimo-v3", "minimax-m3", "longcat-2.0", "step-3.7-flash", "qwen3.8-max", "gpt-5.6", "gpt-6-astra", "muse-spark", "muse-glimmer", "k3", "deepseek-flash"]) {
      const abilities = inferModelAbilities(id);
      expect(abilities).toContain("TOOL");
      expect(abilities).toContain("REASONING");
    }
    // 误伤面:别的词含 hy/mimo 子串不该升级(词边界/锚点守卫);gpt-4o 本就有 TOOL(既有行为),
    // 但它不该被新规则误升 REASONING。
    for (const id of ["mystic-hy", "shyte"]) {
      expect(inferModelAbilities(id)).not.toContain("TOOL");
    }
    expect(inferModelAbilities("gpt-4o")).not.toContain("REASONING");
  });

  it("2026-09 新模型视觉:对齐 APP visionInput() 登记;纯文本型号不收", () => {
    // 有 visionInput() 的(APP 行号见 index.ts 注释):含裸 k3(KIMI_K3_ALIAS)与 muse 系。
    for (const id of ["deepseek-flash", "deepseek-v4.1-flash", "step-3.7-flash", "minimax-m3", "mimo-v3", "mimo-v2.5", "longcat-2.0", "qwen3.8", "glm-5.3-flash", "gpt-5.6", "gpt-6-astra", "k3", "muse-spark"]) {
      expect(inferInputModalities(id)).toContain("IMAGE");
    }
    // 无 visionInput() 的纯文本(APP 同样不收):hy3/hy4、qwen3.7/3.8-max、glm-5.2/5.3 普通版。
    for (const id of ["hy3", "hy4", "qwen3.8-max", "qwen3.7-max", "glm-5.2", "glm-5.3"]) {
      expect(inferInputModalities(id)).not.toContain("IMAGE");
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
