// 插件页(设置 → 拓展 → 插件)的视图栈与页内状态(D20,方案 §5.13 / P6.2)。只在内存。
//
// 栈底恒为首页;前进 / 返回 / 替换栈顶都在这个二级页里完成,不另开路由。离开二级页(组件卸载,含关闭设置)时
// resetPluginsView() 只清导航(栈、滑入方向、滚动位置);筛选排序、忙碌态、列表与详情缓存留着——后端的安装可能
// 还在跑,回来时照样显示转圈。
import { create } from "zustand";

import { openSettingsDialog } from "~/stores/settings-dialog-store";
import type { EnginePluginDetailDto, EnginePluginListDto, EnginePluginUpdatesDto } from "~/types/plugins";

export type PluginDetailTab = "overview" | "tools" | "audit";

export type PluginView =
  | { kind: "home" }
  | { kind: "detail"; pluginId: string; tab?: PluginDetailTab }
  | { kind: "market"; sourceId?: string }
  | { kind: "market-detail"; sourceId: string; name: string }
  | { kind: "upload" };

export type PluginShowFilter = "all" | "enabled" | "disabled";
export type PluginSort = "added" | "name";

export interface PluginHomeFilters {
  query: string;
  show: PluginShowFilter;
  /** "all" 或引擎 id;引擎不足两个时不生效(筛选项也不出现)。 */
  engine: string;
  sort: PluginSort;
}

export const DEFAULT_PLUGIN_FILTERS: PluginHomeFilters = { query: "", show: "all", engine: "all", sort: "added" };

interface PluginsViewState {
  stack: PluginView[];
  /** 最近一次导航的方向,决定新视图从哪边滑入;null = 刚进来(只淡入)。 */
  direction: "forward" | "back" | null;
  /** 离开时的滚动位置(按视图键),返回时恢复;由页面在视图切换时记下(仓库不碰 DOM)。 */
  scrollByView: Record<string, number>;
  /** 页面容器滚离了顶部(吸顶工具栏据此显出下缘细线)。 */
  scrolled: boolean;
  filters: PluginHomeFilters;
  /** 键 = 插件 id / market:<源>:<包名> / upload。 */
  busy: Record<string, true>;
  list: EnginePluginListDto | null;
  updates: EnginePluginUpdatesDto["updates"];
  /** 键 = 插件 id + installedAt:重装后自然失效。 */
  detailCache: Record<string, EnginePluginDetailDto>;
}

const HOME: PluginView = { kind: "home" };

export const usePluginsViewStore = create<PluginsViewState>(() => ({
  stack: [HOME],
  direction: null,
  scrollByView: {},
  scrolled: false,
  filters: DEFAULT_PLUGIN_FILTERS,
  busy: {},
  list: null,
  updates: {},
  detailCache: {},
}));

/** 视图的身份:同一身份换参数(如市场切页签)不算换视图,不重放进入动画。 */
export function pluginViewKey(view: PluginView): string {
  if (view.kind === "detail") return `detail:${view.pluginId}`;
  if (view.kind === "market-detail") return `market-detail:${view.sourceId}:${view.name}`;
  return view.kind;
}

export function topPluginView(stack: readonly PluginView[]): PluginView {
  return stack[stack.length - 1] ?? HOME;
}

export function pushPluginView(view: PluginView): void {
  usePluginsViewStore.setState((state) => ({ stack: [...state.stack, view], direction: "forward" }));
}

export function backPluginView(): void {
  usePluginsViewStore.setState((state) =>
    state.stack.length > 1 ? { stack: state.stack.slice(0, -1), direction: "back" } : state,
  );
}

/** 换掉栈顶(上传装好后换成新插件的详情,返回即回首页)。栈底的首页不被换掉,那时等于前进。 */
export function replacePluginView(view: PluginView): void {
  usePluginsViewStore.setState((state) => ({
    stack: state.stack.length > 1 ? [...state.stack.slice(0, -1), view] : [HOME, view],
    direction: "forward",
  }));
}

export function resetPluginsView(): void {
  usePluginsViewStore.setState({ stack: [HOME], direction: null, scrollByView: {}, scrolled: false });
}

export function rememberPluginScroll(viewKey: string, top: number): void {
  usePluginsViewStore.setState((state) => ({ scrollByView: { ...state.scrollByView, [viewKey]: top } }));
}

export function setPluginsScrolled(scrolled: boolean): void {
  if (usePluginsViewStore.getState().scrolled !== scrolled) usePluginsViewStore.setState({ scrolled });
}

/** 把栈设成「首页 → 这个插件的详情」;已经停在它的详情上则不动。深链是「进入这一页」,不做滑入。 */
export function showPluginDetail(pluginId: string, tab?: PluginDetailTab): void {
  usePluginsViewStore.setState((state) => {
    const top = topPluginView(state.stack);
    if (top.kind === "detail" && top.pluginId === pluginId) return state;
    return { stack: [HOME, { kind: "detail", pluginId, ...(tab ? { tab } : {}) }], direction: null };
  });
}

export function pluginDetailSearch(pluginId: string, tab?: PluginDetailTab): string {
  const params = new URLSearchParams({ section: "extensions", sub: "plugins", plugin: pluginId });
  if (tab) params.set("tab", tab);
  return `?${params.toString()}`;
}

/** 深链:别处(工具卡的否决署名、MCP 页的「来自插件」、选择列表)跳到一个插件的详情。查询串里也带上插件 id,
 *  新开的页面(没有内存里的栈)由插件页挂载时读出。 */
export function openPluginDetail(pluginId: string, tab?: PluginDetailTab): void {
  showPluginDetail(pluginId, tab);
  openSettingsDialog(pluginDetailSearch(pluginId, tab));
}

export function parsePluginDetailTab(value: string | null): PluginDetailTab | undefined {
  return value === "overview" || value === "tools" || value === "audit" ? value : undefined;
}

export function setPluginFilters(patch: Partial<PluginHomeFilters>): void {
  usePluginsViewStore.setState((state) => ({ filters: { ...state.filters, ...patch } }));
}

export function marketBusyKey(sourceId: string, name: string): string {
  return `market:${sourceId}:${name}`;
}

export function setPluginBusy(key: string, busy: boolean): void {
  usePluginsViewStore.setState((state) => {
    if (Boolean(state.busy[key]) === busy) return state;
    const next = { ...state.busy };
    if (busy) next[key] = true;
    else delete next[key];
    return { busy: next };
  });
}

export function setPluginList(list: EnginePluginListDto): void {
  usePluginsViewStore.setState({ list });
}

export function setPluginUpdates(updates: EnginePluginUpdatesDto["updates"]): void {
  usePluginsViewStore.setState({ updates });
}

function detailCacheKey(pluginId: string, installedAt: string): string {
  return `${pluginId}@${installedAt}`;
}

export function cachePluginDetail(detail: EnginePluginDetailDto): void {
  const key = detailCacheKey(detail.plugin.id, detail.plugin.installedAt);
  usePluginsViewStore.setState((state) => ({ detailCache: { ...state.detailCache, [key]: detail } }));
}

export function cachedPluginDetail(pluginId: string, installedAt: string): EnginePluginDetailDto | undefined {
  return usePluginsViewStore.getState().detailCache[detailCacheKey(pluginId, installedAt)];
}
