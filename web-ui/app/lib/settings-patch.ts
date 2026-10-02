// 设置的乐观写入工具。两条纪律(设置页拆成多个二级页后尤其要紧):
// ① 只提交变更的字段——后端 settings/display 是字段级浅合并,整份快照回发会让一页
//    卸载时补发的旧值盖掉另一页刚保存的新值;
// ② 乐观更新一律基于 store 里的最新快照打补丁,不用调用方渲染时闭包里的 settings。
import { toast } from "sonner";

import i18n from "~/i18n";
import api from "~/services/api";
import { useSettingsStore } from "~/stores/app-store";
import type { DisplaySetting, Settings } from "~/types";

/**
 * 把补丁打到 store 的最新 settings 上(无快照时不动)。补丁依赖现值(如改列表里的一项)时
 * 传函数,拿到的是此刻的最新快照。
 */
export function patchSettingsLocal(patch: Partial<Settings> | ((settings: Settings) => Partial<Settings>)): void {
  const store = useSettingsStore.getState();
  if (!store.settings) return;
  const next = typeof patch === "function" ? patch(store.settings) : patch;
  store.setSettings({ ...store.settings, ...next });
}

/**
 * 按 id 替换列表中的一项,不存在则追加。新建/保存后的乐观写入一律用它:SSE 回推可能先于
 * 请求响应到达,此时最新快照里已经有这一项,直接追加会出现重复条目。
 */
export function upsertById<T extends { id?: unknown }>(items: readonly T[], item: T): T[] {
  const id = String(item.id);
  return items.some((existing) => String(existing.id) === id)
    ? items.map((existing) => (String(existing.id) === id ? item : existing))
    : [...items, item];
}

function patchDisplayLocal(patch: Partial<DisplaySetting>): void {
  const settings = useSettingsStore.getState().settings;
  if (settings) patchSettingsLocal({ displaySetting: { ...settings.displaySetting, ...patch } });
}

/**
 * 提交 displaySetting 的部分字段:先乐观写本地,失败则把本次改过、且之后没被别处再改的
 * 字段回滚,并抛出(供自动保存显示失败态)。
 */
export async function saveDisplayPatch(patch: Partial<DisplaySetting>): Promise<void> {
  const before = useSettingsStore.getState().settings?.displaySetting;
  patchDisplayLocal(patch);
  try {
    await api.post("settings/display", patch);
  } catch (error) {
    const current = useSettingsStore.getState().settings?.displaySetting;
    if (before && current) {
      const rollback: Partial<DisplaySetting> = {};
      for (const key of Object.keys(patch) as (keyof DisplaySetting)[]) {
        if (current[key] === patch[key]) Object.assign(rollback, { [key]: before[key] });
      }
      patchDisplayLocal(rollback);
    }
    throw error;
  }
}

/** 即点即存的开关/选择用:失败统一提示,调用方无需处理。 */
export function patchDisplay(patch: Partial<DisplaySetting>): void {
  saveDisplayPatch(patch).catch((error: unknown) => {
    toast.error(i18n.t("settings:common.save_failed"), {
      description: error instanceof Error ? error.message : undefined,
    });
  });
}
