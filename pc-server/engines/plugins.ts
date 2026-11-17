// engines/plugins.ts — 本轮要加载的引擎插件(应用侧组装,契约 EnginePlugin[])
//
// 会话加载的插件 = 插件记录里该引擎、全局已启用、且会话助手已绑定的(方案 §5.9 D16),外加开发者字段
// settings.devPiPluginPaths 里的位置(只对 pi;不经绑定,对所有工作区会话生效,插件开发与验收用)。
// 开发者条目的 id 由路径派生(`dev:<包目录名或文件名>`,入口是 index.* 时取所在目录名;重名追加 `#2`…),
// 与插件记录的 id(`<engine>:<name>`)不会相撞。
// 插件集合、钩子开关、逐工具开关、安装时刻都在 EnginePlugin 里,变了即换长驻会话的配置键(引擎自行判定重建),
// 所以改绑定、启停、重装都不必通知引擎。
// 安装位置:npm / git 来源装在 <数据目录>/engines/<engine>/npm(不进任何备份);本地来源原地使用。

import { basename, dirname, extname, join } from "node:path";
import { dataDir } from "../foundation/paths";
import type { Assistant } from "../foundation/types";
import type { EnginePluginRecord, Settings } from "../foundation/types/settings";
import { getStringArray, uniqueStrings } from "../foundation/utils";
import type { EngineKind, EnginePlugin } from "./contract";
import { normalizePluginMeta } from "./plugin-package";

export function enginePluginInstallRoot(engine: string): string {
  return join(dataDir, "engines", engine, "npm");
}

/** 插件记录在本机的位置(包目录,或本地来源给的入口文件 / 目录)。 */
export function locateEnginePlugin(record: Pick<EnginePluginRecord, "engine" | "name" | "source">): string {
  if (record.source.kind === "local") return record.source.spec;
  return join(enginePluginInstallRoot(record.engine), "node_modules", ...record.name.split("/"));
}

export function enginePluginsFor(
  engine: EngineKind,
  settings: Partial<Pick<Settings, "devPiPluginPaths" | "enginePlugins">>,
  assistant: Pick<Assistant, "enginePluginIds"> | null | undefined,
): EnginePlugin[] {
  const plugins: EnginePlugin[] = [];
  const bound = new Set(getStringArray(assistant?.enginePluginIds));
  for (const record of settings.enginePlugins ?? []) {
    if (record.engine !== engine || !record.enabled || !bound.has(record.id)) continue;
    const disabledTools = Object.entries(record.toolSwitches ?? {})
      .filter(([, value]) => value.enabled === false)
      .map(([name]) => name);
    plugins.push({
      id: record.id,
      path: locateEnginePlugin(record),
      ...(record.hookSwitches?.toolCall === false ? { toolCallHookDisabled: true } : {}),
      ...(disabledTools.length > 0 ? { disabledTools } : {}),
      revision: record.installedAt,
    });
  }
  if (engine === "pi") plugins.push(...devPlugins(settings.devPiPluginPaths));
  return plugins;
}

/** 本地插件的显示名:包目录名或文件名,入口是 index.* 时取所在目录名。 */
export function pluginNameFromPath(path: string): string {
  const stem = basename(path, extname(path));
  return (stem === "index" ? basename(dirname(path)) : stem) || "plugin";
}

function devPlugins(paths: unknown): EnginePlugin[] {
  const plugins: EnginePlugin[] = [];
  const taken = new Set<string>();
  for (const path of uniqueStrings(getStringArray(paths))) {
    const name = pluginNameFromPath(path);
    let id = `dev:${name}`;
    for (let n = 2; taken.has(id); n++) id = `dev:${name}#${n}`;
    taken.add(id);
    plugins.push({ id, path });
  }
  return plugins;
}

/** 插件记录的规范化(读盘与导入时):丢掉缺 id / 引擎 / 来源的坏行与重复 id,补齐开关的缺省值。 */
export function normalizeEnginePluginRecords(value: unknown): EnginePluginRecord[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const records: EnginePluginRecord[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Partial<EnginePluginRecord>;
    const source = raw.source;
    if (typeof raw.id !== "string" || !raw.id || seen.has(raw.id) || typeof raw.engine !== "string" || !raw.engine) continue;
    if (!source || !["npm", "git", "local"].includes(source.kind) || typeof source.spec !== "string" || !source.spec) continue;
    seen.add(raw.id);
    const meta = normalizePluginMeta(raw.meta);
    const toolSwitches: EnginePluginRecord["toolSwitches"] = {};
    for (const [name, sw] of Object.entries(raw.toolSwitches ?? {})) {
      if (!sw || typeof sw !== "object") continue;
      toolSwitches[name] = {
        ...(typeof sw.enabled === "boolean" ? { enabled: sw.enabled } : {}),
        ...(typeof sw.exempt === "boolean" ? { exempt: sw.exempt } : {}),
      };
    }
    records.push({
      id: raw.id,
      engine: raw.engine,
      name: typeof raw.name === "string" && raw.name ? raw.name : raw.id,
      source: { kind: source.kind, spec: source.spec },
      version: typeof raw.version === "string" ? raw.version : null,
      enabled: raw.enabled !== false,
      hookSwitches: { toolCall: raw.hookSwitches?.toolCall !== false },
      toolSwitches,
      installedAt: typeof raw.installedAt === "string" ? raw.installedAt : "",
      ...(meta ? { meta } : {}),
    });
  }
  return records;
}

/** 插件页逐工具免问(插件工具审批的读取点)。 */
export function isEnginePluginToolExempt(records: readonly EnginePluginRecord[] | undefined, pluginId: string, toolName: string): boolean {
  return records?.find((record) => record.id === pluginId)?.toolSwitches[toolName]?.exempt === true;
}
