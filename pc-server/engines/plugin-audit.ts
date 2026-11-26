// engines/plugin-audit.ts — 每个插件「哪部分没生效、为什么」(插件页的审计,P5.8)
//
// 来源是引擎经 host.report 交回的诊断:pi 的裁决审计(pi_plugin_<动作>)、加载失败、处理函数出错,参数里带插件 id。
// 错误中心那份是全局环形缓冲(会被别的错误挤掉、用户可以清空),这里按插件另存一份:同一插件同一码同一对象只留
// 一条(次数累加、详情取最近一次)。只在内存。引擎对加载期的同一条只报一次(进程内去重),所以卸载、重装都不清空,
// 否则重装后加载期的审计就再也看不到了;卸载后的残留没有记录对应,不会显示。

import type { PluginAuditEntryDto } from "../foundation/types/plugins";
import type { EngineErrorReport } from "./contract";

export type PluginAuditEntry = PluginAuditEntryDto;

const MAX_ENTRIES_PER_PLUGIN = 200;

const audits = new Map<string, Map<string, PluginAuditEntry>>();

function stringParam(params: EngineErrorReport["params"], key: string): string | undefined {
  const value = params?.[key];
  return value === undefined ? undefined : String(value);
}

export function recordPluginAudit(report: EngineErrorReport): void {
  const pluginId = stringParam(report.params, "plugin");
  if (!report.code || !pluginId || pluginId === "?") return;
  const event = stringParam(report.params, "event");
  const subject = stringParam(report.params, "subject") ?? (event ? `event:${event}` : "load");
  const detail = stringParam(report.params, "detail") ?? stringParam(report.params, "error");
  let entries = audits.get(pluginId);
  if (!entries) audits.set(pluginId, (entries = new Map()));
  const key = `${report.code}|${subject}`;
  const existing = entries.get(key);
  const lastAt = new Date().toISOString();
  if (existing) {
    entries.delete(key);
    entries.set(key, { ...existing, count: existing.count + 1, lastAt, ...(detail !== undefined ? { detail } : {}) });
    return;
  }
  entries.set(key, { code: report.code, subject, ...(detail !== undefined ? { detail } : {}), count: 1, lastAt });
  if (entries.size > MAX_ENTRIES_PER_PLUGIN) entries.delete(entries.keys().next().value!);
}

/** 最近的在前。 */
export function pluginAudit(pluginId: string): PluginAuditEntry[] {
  return [...(audits.get(pluginId)?.values() ?? [])].reverse();
}
