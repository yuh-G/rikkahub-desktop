// 设置的位置(一级 + 各一级上次停留的二级)与桌面模态的开合。设置有两种承载形态:md 及以上
// 是盖在当前页面上的模态(本 store 驱动,root 常驻挂载),窄屏是 /settings 整页钻取式(路由
// 驱动)。二级记忆两种形态共用本 store 的 subBySection;形态切换(拉宽/拉窄窗口)双向搬运
// section + sub + 查询参数,见 settings-dialog.tsx 与 routes/settings.tsx。
import { create } from "zustand";

import {
  resolveSettingsLocation,
  resolveSettingsSub,
  settingsSubItems,
  type SettingsLocation,
  type SettingsTabId,
} from "~/components/settings/settings-nav";
import { resetBindingAssistant } from "~/stores/extension-binding-store";

interface SettingsDialogState {
  open: boolean;
  /** 当前一级。关闭后保留,下次无参打开回到上次停留处。 */
  section: SettingsTabId;
  /** 每个一级上次停留的二级(只记有二级的一级)。只在内存:会话内的肌肉记忆,冷启动不该跳到奇怪位置。 */
  subBySection: Partial<Record<SettingsTabId, string>>;
  /**
   * 深链查询串(如 "?section=models&sub=providers&providerId=…"),页面经 getSettingsParam 读取。
   * 只用一次:用户主动切一级/二级即清空,否则页面重挂载时会被再次拉回深链目标。
   */
  search: string;
  /** 侧栏设置搜索的输入。两种形态共用:模态的 Esc 守卫要读它(有输入时 Esc 先清空而非关闭)。 */
  navQuery: string;
  /** 搜索选中后待定位的设置项;壳层的页面挂载后据此滚动 + 闪烁,定位完即清空。 */
  focusTarget: SettingsFocusTarget | null;
}

/** 搜索结果跳转后在页面里要找的设置项。nonce 让「重复选中同一项」也能再次触发定位。 */
export interface SettingsFocusTarget {
  /** 目标页键:壳层只在该页挂载时定位,中途换页不会把定位带到别的页上。 */
  page: string;
  title: string;
  /** 在「高级设置」折叠区内:找不到行(未展开)时先替用户展开再找。 */
  advanced: boolean;
  /** 页内分段标签的文字:先切到该标签再找行。 */
  tab?: string;
  nonce: number;
}

export const useSettingsDialogStore = create<SettingsDialogState>(() => ({
  open: false,
  section: "general",
  subBySection: {},
  search: "",
  navQuery: "",
  focusTarget: null,
}));

/** 当前一级下应显示的二级:记忆值合法则用之,否则第一个;无二级为 null。 */
export function currentSettingsSub(state: Pick<SettingsDialogState, "section" | "subBySection">): string | null {
  return resolveSettingsSub(state.section, state.subBySection[state.section]);
}

/** 把一个显式位置的二级写进记忆;sub 为空或不属于该一级时不动记忆。 */
function rememberSub(
  subBySection: SettingsDialogState["subBySection"],
  location: SettingsLocation,
): SettingsDialogState["subBySection"] {
  if (!settingsSubItems(location.section).some((item) => item.id === location.sub)) return subBySection;
  return { ...subBySection, [location.section]: location.sub! };
}

/** 打开模态。search 为空 = 回到上次位置且清掉旧深链参数;合法深链则定位过去。 */
export function openSettingsDialog(search = ""): void {
  const location = resolveSettingsLocation(search);
  resetBindingAssistant();
  useSettingsDialogStore.setState((state) => ({
    open: true,
    search,
    navQuery: "",
    focusTarget: null,
    section: location?.section ?? state.section,
    subBySection: location ? rememberSub(state.subBySection, location) : state.subBySection,
  }));
}

export function closeSettingsDialog(): void {
  useSettingsDialogStore.setState({ open: false });
}

export function toggleSettingsDialog(): void {
  if (useSettingsDialogStore.getState().open) closeSettingsDialog();
  else openSettingsDialog();
}

/** 用户主动切一级:二级由记忆或默认推出。 */
export function setSettingsDialogSection(section: SettingsTabId): void {
  useSettingsDialogStore.setState({ section, search: "" });
}

/** 用户主动切当前一级的二级。 */
export function setSettingsDialogSub(sub: string): void {
  useSettingsDialogStore.setState((state) => ({
    search: "",
    subBySection: rememberSub(state.subBySection, { section: state.section, sub }),
  }));
}

export function setSettingsNavQuery(navQuery: string): void {
  useSettingsDialogStore.setState({ navQuery });
}

/**
 * 搜索选中:清空搜索、记下待定位项。位置切换由调用方按形态完成(模态 setSettingsDialogLocation,
 * 整页走路由)——两者都在同一次事件里,页面挂载时 focusTarget 已就位。
 */
export function requestSettingsFocus(target: Omit<SettingsFocusTarget, "nonce"> | null): void {
  useSettingsDialogStore.setState({
    navQuery: "",
    focusTarget: target ? { ...target, nonce: Date.now() + Math.random() } : null,
  });
}

export function clearSettingsFocus(): void {
  useSettingsDialogStore.setState({ focusTarget: null });
}

/** 模态里一次切到指定一级 + 二级(搜索选中用;sub 不属于该一级时按记忆/默认补全)。 */
export function setSettingsDialogLocation(section: SettingsTabId, sub: string | null): void {
  useSettingsDialogStore.setState((state) => ({
    section,
    search: "",
    subBySection: rememberSub(state.subBySection, { section, sub }),
  }));
}

/**
 * 整页形态的位置写入:与模态共用二级记忆,但不碰模态的开合与 search(整页的深链在地址栏)。
 * 返回补全后的二级,供整页同步地址栏。
 */
export function rememberSettingsLocation(location: SettingsLocation): string | null {
  useSettingsDialogStore.setState((state) => ({
    section: location.section,
    subBySection: rememberSub(state.subBySection, location),
  }));
  return currentSettingsSub(useSettingsDialogStore.getState());
}

/**
 * 把查询串的位置改写为指定的一级/二级(无二级则去掉 sub),其余深链参数原样保留
 * (形态切换时搬运用;传空串则只产出位置本身)。
 */
export function withSettingsLocation(search: string, section: SettingsTabId, sub: string | null): string {
  const params = new URLSearchParams(search);
  params.set("section", section);
  if (sub) params.set("sub", sub);
  else params.delete("sub");
  return `?${params.toString()}`;
}

/**
 * 页面读取深链参数(providerId / modelId / tab …)的唯一入口。来源随承载形态:
 * 模态打开时取模态的 search,否则取整页路由的地址栏。页面只在挂载时读一次。
 */
export function getSettingsParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  const { open, search } = useSettingsDialogStore.getState();
  return new URLSearchParams(open ? search : window.location.search).get(name);
}
