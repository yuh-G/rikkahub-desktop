// display-names.test.ts — 官方显示名解析与落库回填的行为锁。
// 核心不变量:官方名只认领「displayName === modelId」的行(未认领信号);
// 前缀行不取(那是同家族另一个模型的名字)、(latest) 噪音剥除、幂等零写。
// 「谁规范谁获胜」:与 id 排版等价的官方名不认领(无增量,落库只会占坑锁死启发式)。

import { describe, expect, test } from "bun:test";

import { setState, state } from "../persistence/json-store";
import { backfillModelDisplayNames, isUnclaimedDisplayName, officialDisplayNameFor } from "./display-names";
import { model } from "./index";
import type { ModelCatalog } from "./model-limits";

function makeCatalog(): ModelCatalog {
  return {
    openai: {
      api: "https://api.openai.com/v1",
      models: {
        // 排版规整类(gpt-5.4 / gpt-5.4-mini):官方名只是把 id 规整了大小写/分隔,
        // 启发式能产出同级形态 → 不认领。
        "gpt-5.4": { name: "GPT-5.4", limit: { context: 400000 } },
        "gpt-5.4-mini": { name: "GPT-5.4 mini" },
        // 营销名类:字符集与 id 不同(携带真实增量) → 认领。
        "gpt-5.4-sol": { name: "GPT-5.6 Sol" },
      },
    } as never,
    anthropic: {
      models: {
        "claude-opus-4-5": { name: "Claude Opus 4.5 (latest)" },
        "claude-opus-4-5-20251101": { name: "Claude Opus 4.5" },
      },
    } as never,
    siliconflow: {
      models: {
        "tencent/Hunyuan-A13B-Instruct": { name: "tencent/Hunyuan-A13B-Instruct" },
      },
    } as never,
    google: {
      models: {
        "gemini-2.5-pro": { name: "Gemini 2.5 Pro" },
        "gemini-2.5-flash-image": { name: "Nano Banana" },
        "gemma-3-27b-it": { name: "Gemma 3 27B IT" },
      },
    } as never,
  };
}

function setProviders(models: unknown[]): void {
  setState({ settings: { providers: [{ id: "p1", name: "OpenAI", baseUrl: "https://api.openai.com/v1", models }] } } as never);
}
describe("officialDisplayNameFor", () => {
  const catalog = makeCatalog();

  test("精确 id 命中返回官方名;排版规整类(只是大小写/分隔加工)按「谁规范谁获胜」不认领", () => {
    // 启发式对 gpt-5.4 / gpt-5.4-mini 产出 GPT-5.4 / GPT-5.4 mini(逐字节相同),
    // 官方名无增量 → null(渲染层启发式接管)
    expect(officialDisplayNameFor(catalog, "api.openai.com", "gpt-5.4-mini")).toBeNull();
    expect(officialDisplayNameFor(catalog, "api.openai.com", "gpt-5.4")).toBeNull();
    // 营销名(id 是 gpt-5.4-sol、官方名是 GPT-5.6 Sol)携带真实增量 → 认领
    expect(officialDisplayNameFor(catalog, "api.openai.com", "gpt-5.4-sol")).toBe("GPT-5.6 Sol");
  });

  test("(latest) 噪音剥除后仍要过排版闸门;日期别名行的删词是增量,照常认领", () => {
    // 基名行:剥 (latest) 后 Claude Opus 4.5 与 id 排版等价 → 启发式接管
    expect(officialDisplayNameFor(catalog, "api.anthropic.com", "claude-opus-4-5")).toBeNull();
    // 别名行:官方名剥掉了 8 位日期(id 的字符集超集)→ 有增量,落库稳定真值
    expect(officialDisplayNameFor(catalog, "api.anthropic.com", "claude-opus-4-5-20251101")).toBe("Claude Opus 4.5");
  });

  test("非 latest 括注保留(承载真实语义)", () => {
    const withPreview = { openai: { api: "https://api.openai.com/v1", models: { m: { name: "Model X (preview)" } } } } as never as ModelCatalog;
    expect(officialDisplayNameFor(withPreview, "api.openai.com", "m")).toBe("Model X (preview)");
  });

  test("无精确 id 时返回 null——前缀行(同家族另一模型)绝不取", () => {
    expect(officialDisplayNameFor(catalog, "api.openai.com", "gpt-5")).toBeNull();
    expect(officialDisplayNameFor(catalog, "api.openai.com", "gpt-5.4-turbo")).toBeNull();
  });

  test("目录未加载 / 空 id / 目录行无 name 返回 null", () => {
    expect(officialDisplayNameFor(null, "api.openai.com", "gpt-5.4")).toBeNull();
    expect(officialDisplayNameFor(catalog, "api.openai.com", "")).toBeNull();
    const hollow = { openai: { api: "https://api.openai.com/v1", models: { a: {}, b: { name: "  " } } } } as never as ModelCatalog;
    expect(officialDisplayNameFor(hollow, "api.openai.com", "a")).toBeNull();
    expect(officialDisplayNameFor(hollow, "api.openai.com", "b")).toBeNull();
  });

  test("排版等价闸门:官方名与 id 只差大小写/连字/斜杠 = 无增量,不认领", () => {
    // 整条 id 抄进 name(siliconflow 形态,落库会让界面显示带斜杠的原始 id)
    expect(officialDisplayNameFor(catalog, "api.siliconflow.cn", "tencent/Hunyuan-A13B-Instruct")).toBeNull();
    // 连字改空格的排版变体(启发式本就能产出同级形态)
    expect(officialDisplayNameFor(catalog, "generativelanguage.googleapis.com", "gemma-3-27b-it")).toBeNull();
    expect(officialDisplayNameFor(catalog, "generativelanguage.googleapis.com", "gemini-2.5-pro")).toBeNull();
    // 携带真实增量的行照常认领(营销昵称,字符集与 id 不同)
    expect(officialDisplayNameFor(catalog, "generativelanguage.googleapis.com", "gemini-2.5-flash-image")).toBe("Nano Banana");
  });
});

describe("isUnclaimedDisplayName", () => {
  test("displayName 等于 modelId = 未认领(获取列表/默认出厂形态)", () => {
    expect(isUnclaimedDisplayName(model("gpt-5.4"))).toBe(true);
  });

  test("用户手改名 / 官方名 / 上游名都已认领,不碰", () => {
    expect(isUnclaimedDisplayName({ ...model("gpt-5.4"), displayName: "我的快枪手" })).toBe(false);
    expect(isUnclaimedDisplayName({ ...model("gpt-5.4"), displayName: "GPT-5.4" })).toBe(false);
  });
});

describe("backfillModelDisplayNames", () => {
  test("只填有增量的行;排版等价行保持未认领(启发式接管);手改名原样;幂等", () => {
    setProviders([model("gpt-5.4"), model("gpt-5.4-sol"), { ...model("gpt-5.4-mini"), displayName: "我的迷你" }]);
    const catalog = makeCatalog();
    backfillModelDisplayNames(catalog);
    const models = state.settings.providers[0].models;
    // gpt-5.4 官方名与 id 排版等价 → 不落库,行保持未认领(渲染层启发式给 GPT-5.4)
    expect(models[0].displayName).toBe("gpt-5.4");
    // gpt-5.4-sol 官方名携带营销增量(GPT-5.6 Sol)→ 落库
    expect(models[1].displayName).toBe("GPT-5.6 Sol");
    // 手改名不碰
    expect(models[2].displayName).toBe("我的迷你");
    backfillModelDisplayNames(catalog);
    expect(state.settings.providers[0].models[1].displayName).toBe("GPT-5.6 Sol");
  });

  test("目录未加载时零写入", () => {
    setProviders([model("gpt-5.4")]);
    const before = JSON.stringify(state.settings.providers);
    backfillModelDisplayNames(null);
    expect(JSON.stringify(state.settings.providers)).toBe(before);
  });
});
