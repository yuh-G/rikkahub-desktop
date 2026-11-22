// persistence/search-tombstone.test.ts — R1-12 回归:内置搜索服务补齐必须尊重删除墓碑。
// 锁住的语义:①无墓碑时缺失的内置 type 照常补齐(老行为);②有墓碑的 type 不复活
// (重启/备份恢复同走 normalizeState,一并覆盖);③空列表回填 defaults 时同样豁免墓碑;
// ④墓碑规范化(小写去重)。

import { describe, expect, test } from "bun:test";
import { normalizeState } from "./state-load";
import type { JsonValue } from "../foundation/types";

function searchTypes(state: ReturnType<typeof normalizeState>): string[] {
  return (state.settings.searchServices as Array<Record<string, JsonValue>>)
    .map((s) => String(s.type ?? "").toLowerCase());
}

describe("R1-12 搜索服务删除墓碑", () => {
  test("无墓碑:缺失的内置 type 照常补齐(老用户升级行为不变)", () => {
    const state = normalizeState({
      settings: { searchServices: [{ type: "bing_local", id: "b1", name: "Bing" }] } as any,
    });
    const types = searchTypes(state);
    expect(types).toContain("tinyfish");
    expect(types).toContain("firecrawl");
    expect(types).toContain("grok");
    expect(types).toContain("deepseek");
  });

  test("有墓碑:删掉的内置 type 不复活,其余照补", () => {
    const state = normalizeState({
      settings: {
        searchServices: [{ type: "bing_local", id: "b1", name: "Bing" }],
        dismissedSearchServiceTypes: ["tinyfish", "grok"],
      } as any,
    });
    const types = searchTypes(state);
    expect(types).not.toContain("tinyfish");
    expect(types).not.toContain("grok");
    expect(types).toContain("firecrawl");
  });

  test("空列表回填 defaults 时同样豁免墓碑", () => {
    const state = normalizeState({
      settings: { searchServices: [], dismissedSearchServiceTypes: ["tavily"] } as any,
    });
    const types = searchTypes(state);
    expect(types.length).toBeGreaterThan(0);
    expect(types).not.toContain("tavily");
  });

  test("墓碑规范化:大小写混杂与重复收敛为小写去重", () => {
    const state = normalizeState({
      settings: {
        searchServices: [{ type: "bing_local", id: "b1", name: "Bing" }],
        dismissedSearchServiceTypes: ["TinyFish", "tinyfish", " GROK ", 42 as unknown as string],
      } as any,
    });
    expect(state.settings.dismissedSearchServiceTypes).toEqual(["tinyfish", "grok"]);
    expect(searchTypes(state)).not.toContain("tinyfish");
  });
});
