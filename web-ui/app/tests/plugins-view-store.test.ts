// plugins-view-store.test.ts — 插件页的视图栈(前进 / 返回 / 替换 / 深链)与离开时的复位范围。
import { beforeEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_PLUGIN_FILTERS,
  backPluginView,
  cachePluginDetail,
  cachedPluginDetail,
  marketResultKey,
  openPluginDetail,
  parsePluginDetailTab,
  pluginDetailSearch,
  pluginViewKey,
  pushPluginView,
  rememberPluginScroll,
  replacePluginView,
  resetPluginsView,
  setPluginBusy,
  setPluginFilters,
  showPluginDetail,
  storeMarketPage,
  topPluginView,
  usePluginsViewStore,
} from "~/stores/plugins-view-store";
import { resolveSettingsLocation } from "~/components/settings/settings-nav";
import { useSettingsDialogStore } from "~/stores/settings-dialog-store";
import type { EnginePluginDetailDto } from "~/types/plugins";

const state = () => usePluginsViewStore.getState();
const kinds = () => state().stack.map((view) => view.kind);

beforeEach(() => {
  resetPluginsView();
  usePluginsViewStore.setState({ filters: DEFAULT_PLUGIN_FILTERS, busy: {}, detailCache: {} });
  useSettingsDialogStore.setState({ open: false, section: "general", subBySection: {}, search: "" });
});

describe("视图栈", () => {
  test("栈底恒为首页;前进记方向,返回到底不再弹出", () => {
    expect(kinds()).toEqual(["home"]);
    expect(state().direction).toBeNull();
    pushPluginView({ kind: "market" });
    pushPluginView({ kind: "market-detail", sourceId: "pi-official", name: "pi-web-access" });
    expect(kinds()).toEqual(["home", "market", "market-detail"]);
    expect(state().direction).toBe("forward");
    backPluginView();
    expect(topPluginView(state().stack)).toEqual({ kind: "market" });
    expect(state().direction).toBe("back");
    backPluginView();
    backPluginView();
    expect(kinds()).toEqual(["home"]);
  });

  test("替换栈顶:上传装好后换成详情,返回即回首页;栈里只有首页时等于前进", () => {
    pushPluginView({ kind: "upload" });
    replacePluginView({ kind: "detail", pluginId: "pi:up" });
    expect(kinds()).toEqual(["home", "detail"]);
    expect(state().direction).toBe("forward");
    backPluginView();
    expect(kinds()).toEqual(["home"]);
    replacePluginView({ kind: "detail", pluginId: "pi:a" });
    expect(kinds()).toEqual(["home", "detail"]);
  });

  test("视图键:同一视图换参数不算换视图", () => {
    expect(pluginViewKey({ kind: "market-detail", sourceId: "a", name: "x" })).not.toBe(
      pluginViewKey({ kind: "market-detail", sourceId: "b", name: "x" }),
    );
    expect(pluginViewKey({ kind: "detail", pluginId: "pi:a", tab: "tools" })).toBe(pluginViewKey({ kind: "detail", pluginId: "pi:a" }));
    expect(pluginViewKey({ kind: "detail", pluginId: "pi:a" })).not.toBe(pluginViewKey({ kind: "detail", pluginId: "pi:b" }));
  });

  test("离开二级页只清导航:筛选、忙碌态、详情缓存留着", () => {
    pushPluginView({ kind: "market" });
    rememberPluginScroll("home", 320);
    setPluginFilters({ query: "web", sort: "name" });
    setPluginBusy("pi:a", true);
    resetPluginsView();
    expect(kinds()).toEqual(["home"]);
    expect(state().direction).toBeNull();
    expect(state().scrollByView).toEqual({});
    expect(state().filters).toMatchObject({ query: "web", sort: "name" });
    expect(state().busy).toEqual({ "pi:a": true });
  });

  test("忙碌态按键增删,重复设置不换对象", () => {
    setPluginBusy("upload", true);
    const before = state().busy;
    setPluginBusy("upload", true);
    expect(state().busy).toBe(before);
    setPluginBusy("upload", false);
    expect(state().busy).toEqual({});
  });
});

describe("深链", () => {
  test("showPluginDetail 把栈设成首页 → 详情(只淡入);已经停在它的详情上不动", () => {
    pushPluginView({ kind: "market" });
    showPluginDetail("pi:a", "audit");
    expect(state().stack).toEqual([{ kind: "home" }, { kind: "detail", pluginId: "pi:a", tab: "audit" }]);
    expect(state().direction).toBeNull();
    const stack = state().stack;
    showPluginDetail("pi:a");
    expect(state().stack).toBe(stack);
  });

  test("openPluginDetail 同时把设置定位到插件页,查询串带插件 id 与页签", () => {
    openPluginDetail("pi:@scope/name", "tools");
    expect(kinds()).toEqual(["home", "detail"]);
    const { open, search, section, subBySection } = useSettingsDialogStore.getState();
    expect(open).toBe(true);
    expect(search).toBe(pluginDetailSearch("pi:@scope/name", "tools"));
    expect(section).toBe("extensions");
    expect(subBySection.extensions).toBe("plugins");
    expect(resolveSettingsLocation(search)).toEqual({ section: "extensions", sub: "plugins" });
    const params = new URLSearchParams(search);
    expect(params.get("plugin")).toBe("pi:@scope/name");
    expect(params.get("tab")).toBe("tools");
  });

  test("页签参数只认三种", () => {
    expect(parsePluginDetailTab("tools")).toBe("tools");
    expect(parsePluginDetailTab("readme")).toBeUndefined();
    expect(parsePluginDetailTab(null)).toBeUndefined();
  });
});

test("详情缓存按插件 id + installedAt:重装后不再命中", () => {
  const detail = { plugin: { id: "pi:a", installedAt: "2026-11-01T00:00:00.000Z" } } as EnginePluginDetailDto;
  cachePluginDetail(detail);
  expect(cachedPluginDetail("pi:a", "2026-11-01T00:00:00.000Z")).toBe(detail);
  expect(cachedPluginDetail("pi:a", "2026-11-02T00:00:00.000Z")).toBeUndefined();
});

describe("市场结果", () => {
  const item = (name: string) => ({ name, links: {}, source: { kind: "npm" as const, spec: name } });
  const page = (index: number, names: string[], hasMore = true) => ({
    items: names.map(item),
    total: 50,
    page: index,
    pageSize: 24,
    hasMore,
    fromCache: false,
    generatedAt: "",
  });

  test("第 0 页替换,之后的页按包名去重追加;下一页号与 hasMore 跟着最后一页", () => {
    const key = marketResultKey("pi-official", "web");
    usePluginsViewStore.setState({ marketResults: {} });
    storeMarketPage(key, page(0, ["a", "b"]));
    storeMarketPage(key, page(1, ["b", "c"], false));
    expect(state().marketResults[key]).toMatchObject({ nextPage: 2, hasMore: false, total: 50 });
    expect(state().marketResults[key]!.items.map((entry) => entry.name)).toEqual(["a", "b", "c"]);
    storeMarketPage(key, page(0, ["z"]));
    expect(state().marketResults[key]!.items.map((entry) => entry.name)).toEqual(["z"]);
  });

  test("源与搜索词组成的键互不串", () => {
    expect(marketResultKey("a", "bc")).not.toBe(marketResultKey("ab", "c"));
  });
});
