// 桌面端设置模态的开合与位置。设置有两种承载形态:md 及以上是盖在当前页面上的模态
// (本 store 驱动,root 常驻挂载),窄屏是 /settings 整页钻取式(路由驱动)。两种形态
// 之间的切换(拉宽/拉窄窗口)双向搬运 section + 查询参数,见 settings-dialog.tsx 与
// routes/settings.tsx。
import { create } from "zustand";

import { isSettingsTabId, type SettingsTabId } from "~/components/settings/settings-nav";

interface SettingsDialogState {
  open: boolean;
  /** 当前一级分区。关闭后保留,下次无参打开回到上次停留处。 */
  section: SettingsTabId;
  /** 深链查询串(如 "?section=providers&providerId=…"),分区经 getSettingsParam 读取。 */
  search: string;
}

export const useSettingsDialogStore = create<SettingsDialogState>(() => ({
  open: false,
  section: "general",
  search: "",
}));

/** 打开模态。search 为空 = 回到上次分区且清掉旧深链参数。 */
export function openSettingsDialog(search = ""): void {
  const section = new URLSearchParams(search).get("section");
  useSettingsDialogStore.setState((state) => ({
    open: true,
    search,
    section: section && isSettingsTabId(section) ? section : state.section,
  }));
}

export function closeSettingsDialog(): void {
  useSettingsDialogStore.setState({ open: false });
}

export function toggleSettingsDialog(): void {
  if (useSettingsDialogStore.getState().open) closeSettingsDialog();
  else openSettingsDialog();
}

export function setSettingsDialogSection(section: SettingsTabId): void {
  useSettingsDialogStore.setState({ section });
}

/** 把查询串的 section 改写为指定值,其余深链参数原样保留(形态切换时搬运用)。 */
export function withSettingsSection(search: string, section: SettingsTabId): string {
  const params = new URLSearchParams(search);
  params.set("section", section);
  return `?${params.toString()}`;
}

/**
 * 分区读取深链参数(providerId / modelId / tab …)的唯一入口。来源随承载形态:
 * 模态打开时取模态的 search,否则取整页路由的地址栏。分区只在挂载时读一次。
 */
export function getSettingsParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  const { open, search } = useSettingsDialogStore.getState();
  return new URLSearchParams(open ? search : window.location.search).get(name);
}
