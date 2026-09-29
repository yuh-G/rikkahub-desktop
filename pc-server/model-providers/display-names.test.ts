// display-names.test.ts — 官方显示名解析与落库回填的行为锁。
// 核心不变量:官方名只认领「displayName === modelId」的行(未认领信号);
// 前缀行不取(那是同家族另一个模型的名字)、(latest) 噪音剥除、幂等零写。

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
        "gpt-5.4": { name: "GPT-5.4", limit: { context: 400000 } },
        "gpt-5.4-mini": { name: "GPT-5.4 mini" },
      },
    } as never,
    anthropic: {
      models: {
        "claude-opus-4-5": { name: "Claude Opus 4.5 (latest)" },
        "claude-opus-4-5-20251101": { name: "Claude Opus 4.5" },
      },
    } as never,
  };
}

function setProviders(models: unknown[]): void {
  setState({ settings: { providers: [{ id: "p1", name: "OpenAI", baseUrl: "https://api.openai.com/v1", models }] } } as never);
}
describe("officialDisplayNameFor", () => {
  const catalog = makeCatalog();

  test("精确 id 命中返回官方名(host 索引定位目录键)", () => {
    expect(officialDisplayNameFor(catalog, "api.openai.com", "gpt-5.4-mini")).toBe("GPT-5.4 mini");
    expect(officialDisplayNameFor(catalog, "api.openai.com", "gpt-5.4")).toBe("GPT-5.4");
  });

  test("(latest) 噪音后缀剥除(用户拍板:claude-opus-4-5 → Claude Opus 4.5)", () => {
    expect(officialDisplayNameFor(catalog, "api.anthropic.com", "claude-opus-4-5")).toBe("Claude Opus 4.5");
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
  test("只填未认领行;手改名原样;幂等(二跑零变更)", () => {
    setProviders([model("gpt-5.4"), { ...model("gpt-5.4-mini"), displayName: "我的迷你" }]);
    const catalog = makeCatalog();
    backfillModelDisplayNames(catalog);
    const models = state.settings.providers[0].models;
    expect(models[0].displayName).toBe("GPT-5.4");
    expect(models[1].displayName).toBe("我的迷你");
    backfillModelDisplayNames(catalog);
    expect(state.settings.providers[0].models[0].displayName).toBe("GPT-5.4");
  });

  test("目录未加载时零写入", () => {
    setProviders([model("gpt-5.4")]);
    const before = JSON.stringify(state.settings.providers);
    backfillModelDisplayNames(null);
    expect(JSON.stringify(state.settings.providers)).toBe(before);
  });
});
