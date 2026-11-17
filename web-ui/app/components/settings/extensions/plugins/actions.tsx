// 插件的几个动作(首页的「⋯」与详情的标题栏共用):启停与开关、更新、重装、卸载。启停与开关先改本地快照(开关
// 立刻翻过去,失败再翻回);更新 / 重装 / 卸载要等后端,忙碌态记在视图仓库(切视图不丢)。成功后把返回的那一行写进
// 设置的本地快照(不等 SSE 回推),结果用 toast 报。
import { toast } from "sonner";

import i18n from "~/i18n";
import { extractErrorMessage } from "~/lib/error";
import { pluginsApi, refreshPluginList, refreshPluginUpdates } from "~/lib/plugins-api";
import { patchSettingsLocal, upsertById } from "~/lib/settings-patch";
import { confirmDialog } from "~/stores/confirm-store";
import { setPluginBusy } from "~/stores/plugins-view-store";
import type { EnginePluginRecord, EnginePluginViewDto } from "~/types/plugins";

import { recordOfView } from "./model";

function applyPluginView(plugin: EnginePluginViewDto): void {
  patchSettingsLocal((settings) => ({ enginePlugins: upsertById(settings.enginePlugins ?? [], recordOfView(plugin)) }));
}

async function busyWhile<T>(pluginId: string, task: () => Promise<T>): Promise<T | null> {
  setPluginBusy(pluginId, true);
  try {
    return await task();
  } catch (error) {
    toast.error(extractErrorMessage(error, i18n.t("settings:plugins.action_failed")));
    return null;
  } finally {
    setPluginBusy(pluginId, false);
  }
}

function patchRecordLocal(pluginId: string, patch: (record: EnginePluginRecord) => EnginePluginRecord): void {
  patchSettingsLocal((settings) => ({
    enginePlugins: (settings.enginePlugins ?? []).map((item) => (item.id === pluginId ? patch(item) : item)),
  }));
}

async function optimistic(record: EnginePluginRecord, next: EnginePluginRecord, request: () => Promise<{ plugin: EnginePluginViewDto }>) {
  patchRecordLocal(record.id, () => next);
  try {
    applyPluginView((await request()).plugin);
  } catch (error) {
    patchRecordLocal(record.id, () => record);
    toast.error(extractErrorMessage(error, i18n.t("settings:plugins.action_failed")));
  }
}

export function setPluginEnabled(record: EnginePluginRecord, enabled: boolean): Promise<void> {
  return optimistic(record, { ...record, enabled }, () => pluginsApi.setEnabled(record.id, enabled));
}

export function setPluginToolCallHook(record: EnginePluginRecord, toolCall: boolean): Promise<void> {
  return optimistic(record, { ...record, hookSwitches: { ...record.hookSwitches, toolCall } }, () =>
    pluginsApi.setSwitches(record.id, { toolCall }),
  );
}

export function setPluginToolSwitch(
  record: EnginePluginRecord,
  toolName: string,
  patch: { enabled?: boolean; exempt?: boolean },
): Promise<void> {
  const toolSwitches = { ...record.toolSwitches, [toolName]: { ...record.toolSwitches[toolName], ...patch } };
  return optimistic(record, { ...record, toolSwitches }, () => pluginsApi.setSwitches(record.id, { tools: { [toolName]: patch } }));
}

export async function updatePlugin(record: EnginePluginRecord): Promise<void> {
  const result = await busyWhile(record.id, () => pluginsApi.update(record.id));
  if (!result) return;
  applyPluginView(result.plugin);
  void refreshPluginUpdates();
  toast.success(i18n.t("settings:plugins.updated", { name: record.name, version: result.plugin.version ?? "" }));
}

export async function reinstallPlugin(record: EnginePluginRecord): Promise<void> {
  const result = await busyWhile(record.id, () => pluginsApi.reinstall(record.id));
  if (!result) return;
  applyPluginView(result.plugin);
  void refreshPluginList();
  toast.success(i18n.t("settings:plugins.reinstalled", { name: record.name }));
}

/** 先确认。onRemoved 在记录从本地快照删掉之前调用(详情借此先退回首页,不闪「找不到」)。 */
export async function uninstallPlugin(record: EnginePluginRecord, onRemoved?: () => void): Promise<void> {
  const confirmed = await confirmDialog({
    title: i18n.t("settings:plugins.uninstall_title", { name: record.name }),
    description: i18n.t("settings:plugins.uninstall_desc"),
    confirmLabel: i18n.t("settings:plugins.uninstall"),
    danger: true,
  });
  if (!confirmed) return;
  const result = await busyWhile(record.id, () => pluginsApi.uninstall(record.id));
  if (!result) return;
  onRemoved?.();
  patchSettingsLocal((settings) => ({
    enginePlugins: (settings.enginePlugins ?? []).filter((item) => item.id !== record.id),
  }));
  toast.success(i18n.t("settings:plugins.uninstalled", { name: record.name }));
}

/** 详情「⋯」里的检查更新:绕过后端缓存查一次,结果用 toast 报。 */
export async function checkPluginUpdate(record: EnginePluginRecord): Promise<void> {
  const updates = await busyWhile(record.id, () => refreshPluginUpdates(true));
  const entry = updates?.[record.id];
  if (!entry?.latest) {
    toast.error(i18n.t("settings:plugins.check_failed"));
    return;
  }
  if (entry.hasUpdate) toast.info(i18n.t("settings:plugins.update_found", { name: record.name, version: entry.latest }));
  else toast.success(i18n.t("settings:plugins.up_to_date", { name: record.name }));
}
