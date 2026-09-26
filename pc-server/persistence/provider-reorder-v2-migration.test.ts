// persistence/provider-reorder-v2-migration.test.ts — 2.0.0-preview-v4 二次重排+改名+下架
// 的行为锁(用户拍板 2026-09-26)。锁五条:①老用户(仅 1.1.1 标记)启动即得新顺序,双标记
// 齐全;②改名只认旧默认名,用户自定义名不动;③硅基流动未配 key 删除、配过 key 保留;
//④幂等:重跑不再变序;⑤备份恢复形态(双标记已种,import.ts R4-1)不重排 builtin 顺序。

import { describe, expect, test } from "bun:test";
import { normalizeState, PROVIDER_REORDER_MIGRATION, PROVIDER_REORDER_MIGRATION_V2 } from "./state-load";

const DEEPSEEK = "f099ad5b-ef03-446d-8e78-7e36787f780b";
const NA_API = "e7a2b5c3-8f4d-4e6a-9b1c-3d5f7e8a2c04";
const ZHIPU = "3bc40dc1-b11a-46fa-863b-6306971223be";
const MOONSHOT = "d6c4d8c6-3f62-4ca9-a6f3-7ade6b15ecc3";
const KIMI_CODE = "f9622c8b-5037-4540-b875-3d301521367b"; // OAUTH_FLOWS["kimi-coding"].presetProviderId
const HUNYUAN = "ef5d149b-8e34-404b-818c-6ec242e5c3c5";
const MINIMAX = "b4deabea-20fb-4101-a74c-65679c7e4754";
const MIMO = "a2bafe83-eaf8-47bf-a8c7-3dd82d89f637";
const VERCEL = "386e0f29-8228-4512-affe-8fd8add82d88";
const COPILOT = "55bff930-76fb-47e4-a19c-6b48e201bf48"; // OAUTH_FLOWS["github-copilot"].presetProviderId
const SILICONFLOW = "56a94d29-c88b-41c5-8e09-38a7612d6cf8";

const row = (id: string, name: string, apiKey = "") => ({ id, name, apiKey }) as any;

/** v2 迁移前的老用户形态:1.1.1 标记在场,providers 乱序混着旧名(含待下架的硅基流动)。 */
function legacyState() {
  return {
    appliedMigrations: [PROVIDER_REORDER_MIGRATION],
    settings: {
      providers: [
        row(SILICONFLOW, "硅基流动"),
        row(COPILOT, "GitHub Copilot"),
        row(VERCEL, "Vercel AI Gateway"),
        row(ZHIPU, "智谱AI开放平台"),
        row(DEEPSEEK, "DeepSeek"),
        row(NA_API, "钠API"),
        row(MOONSHOT, "月之暗面"),
        row(KIMI_CODE, "Kimi Code"),
        row(HUNYUAN, "腾讯混元"),
        row(MINIMAX, "MiniMax"),
        row(MIMO, "MIMO"),
      ],
      assistants: [],
    },
  } as any;
}

describe("2.0.0-preview-v4 预置供应商重排迁移", () => {
  test("老用户启动即得新顺序+新名,双标记齐全,硅基流动(未配 key)移除", () => {
    const state = normalizeState(legacyState());
    const ids = state.settings.providers.map((p) => p.id);
    const idx = (id: string) => ids.indexOf(id);

    expect(idx(NA_API)).toBeLessThan(idx(DEEPSEEK));
    expect(idx(DEEPSEEK)).toBeLessThan(idx(ZHIPU));
    expect(idx(ZHIPU)).toBeLessThan(idx(MOONSHOT));
    // Kimi Code 订阅贴月之暗面(锚点归位,排序沉尾后须拉回)。
    expect(idx(KIMI_CODE)).toBe(idx(MOONSHOT) + 1);
    expect(idx(HUNYUAN)).toBeLessThan(idx(MINIMAX));
    expect(idx(MINIMAX)).toBeLessThan(idx(MIMO));
    // Copilot 订阅贴 Vercel(新锚点)。
    expect(state.settings.providers[idx(VERCEL) + 1]?.id).toBe(COPILOT);
    // 改名生效。
    const nameOf = (id: string) => state.settings.providers.find((p) => p.id === id)?.name;
    expect(nameOf(ZHIPU)).toBe("智谱");
    expect(nameOf(VERCEL)).toBe("Vercel");
    expect(nameOf(COPILOT)).toBe("Copilot");
    // 下架清理:未配 key 的硅基流动删除;新标记写入且不冲掉旧标记。
    expect(ids).not.toContain(SILICONFLOW);
    expect(state.appliedMigrations).toContain(PROVIDER_REORDER_MIGRATION);
    expect(state.appliedMigrations).toContain(PROVIDER_REORDER_MIGRATION_V2);
  });

  test("改名不越权:用户自定义过的名字一字不动", () => {
    const state = normalizeState({
      ...legacyState(),
      settings: {
        ...legacyState().settings,
        providers: [row(ZHIPU, "我的智谱中转"), row(VERCEL, "我的网关"), row(COPILOT, "我的Copilot")],
      },
    });
    const names = state.settings.providers.map((p) => p.name);
    expect(names).toContain("我的智谱中转");
    expect(names).toContain("我的网关");
    expect(names).toContain("我的Copilot");
  });

  test("硅基流动配过 key 的保留(SUNSET 语义:不静默删凭据)", () => {
    const state = normalizeState({
      ...legacyState(),
      settings: {
        ...legacyState().settings,
        providers: [row(SILICONFLOW, "硅基流动", "sk-keep")],
      },
    });
    expect(state.settings.providers.some((p) => p.id === SILICONFLOW && p.apiKey === "sk-keep")).toBe(true);
  });

  test("幂等:迁移后再跑一遍 normalize,顺序与标记不再变化", () => {
    const once = normalizeState(legacyState());
    const twice = normalizeState(structuredClone(once) as any);
    expect(twice.settings.providers.map((p) => p.id)).toEqual(once.settings.providers.map((p) => p.id));
    expect((twice.appliedMigrations ?? []).filter((m) => m === PROVIDER_REORDER_MIGRATION_V2)).toHaveLength(1);
  });

  test("备份恢复形态(双标记已种,R4-1):不重排 builtin 顺序,改名仍自愈", () => {
    const state = normalizeState({
      appliedMigrations: [PROVIDER_REORDER_MIGRATION, PROVIDER_REORDER_MIGRATION_V2],
      settings: {
        providers: [row(DEEPSEEK, "DeepSeek"), row(NA_API, "钠API"), row(ZHIPU, "智谱AI开放平台")],
        assistants: [],
      },
    } as any);
    const ids = state.settings.providers.map((p) => p.id);
    // 用户备份里的顺序原样保留(钠API 仍在 DeepSeek 之后,未被拉到前面)。
    expect(ids.indexOf(DEEPSEEK)).toBeLessThan(ids.indexOf(NA_API));
    // 显示名无条件自愈(改名不走标记)。
    expect(state.settings.providers.find((p) => p.id === ZHIPU)?.name).toBe("智谱");
  });

  test("全新状态:出厂清单即最终顺序(排序+锚点归位收敛到 defaultProviders 序)", () => {
    const state = normalizeState({ settings: { providers: [], assistants: [] } as any } as any);
    expect(state.settings.providers.map((p) => p.name)).toEqual([
      "OpenAI",
      "ChatGPT",
      "Anthropic",
      "Claude",
      "Gemini",
      "xAI",
      "Grok",
      "钠API",
      "DeepSeek",
      "智谱",
      "月之暗面",
      "Kimi Code",
      "阿里云百炼",
      "火山引擎",
      "腾讯混元",
      "MiniMax",
      "MIMO",
      "阶跃星辰",
      "OpenRouter",
      "Vercel",
      "Copilot",
    ]);
  });
});
