// engines/plugins.ts — 本轮要加载的引擎插件(应用侧组装,契约 EnginePlugin[])
//
// 会话加载的插件 = 插件记录里该引擎、全局已启用、且会话助手已绑定的(方案 §5.9 D16),外加开发者字段
// settings.devPiPluginPaths 里的位置(只对 pi;不经绑定,对所有工作区会话生效,插件开发与验收用)。
// 开发者条目的 id 由路径派生(`dev:<包目录名或文件名>`,入口是 index.* 时取所在目录名;重名追加 `#2`…),
// 与插件记录的 id(`<engine>:<name>`)不会相撞。
// 插件集合、钩子开关、逐工具开关、安装时刻都在 EnginePlugin 里,变了即换长驻会话的配置键(引擎自行判定重建),
// 所以改绑定、启停、重装都不必通知引擎。
// 安装位置:npm / git 来源与上传的压缩包装在 <数据目录>/engines/<engine>/npm,上传的存档与单个脚本在同级的
// uploads/(两处都不进任何备份);本地来源原地使用。

import { basename, dirname, extname, join } from "node:path";
import { dataDir } from "../foundation/paths";
import type { Assistant } from "../foundation/types";
import type { EnginePluginRecord, EnginePluginSource, Settings } from "../foundation/types/settings";
import { getStringArray, uniqueStrings } from "../foundation/utils";
import type { EngineKind, EnginePlugin } from "./contract";
import { normalizePluginMeta } from "./plugin-package";

export function enginePluginInstallRoot(engine: string): string {
  return join(dataDir, "engines", engine, "npm");
}

/** 路径分隔符、Windows 文件名里不许出现的字符与控制字符。 */
export const UNSAFE_FILE_NAME = /[\\/<>:"|?*\u0000-\u001f]/;

export function enginePluginUploadsDir(engine: string): string {
  return join(dataDir, "engines", engine, "uploads");
}

/** 上传的单个脚本(不进安装目录,原地加载)。 */
export function isUploadedScript(source: EnginePluginSource): boolean {
  return source.kind === "upload" && source.spec.startsWith("scripts/");
}

/** 来源装进安装目录(按包名占一个位置,同名即同一个位置):npm、git、上传的压缩包。 */
export function isPackageSource(source: EnginePluginSource): boolean {
  return source.kind === "npm" || source.kind === "git" || (source.kind === "upload" && !isUploadedScript(source));
}

/** 上传来源的 spec 只能是 uploads/ 下的一个文件名或 scripts/<文件名>(读盘时防坏行指到别处)。 */
export function isSafeUploadSpec(spec: string): boolean {
  const name = spec.startsWith("scripts/") ? spec.slice("scripts/".length) : spec;
  return name !== "" && !name.startsWith(".") && !UNSAFE_FILE_NAME.test(name);
}

/** 插件记录在本机的位置(包目录,或本地来源给的入口文件 / 目录,或上传的脚本)。 */
export function locateEnginePlugin(record: Pick<EnginePluginRecord, "engine" | "name" | "source">): string {
  if (record.source.kind === "local") return record.source.spec;
  if (isUploadedScript(record.source)) return join(enginePluginUploadsDir(record.engine), ...record.source.spec.split("/"));
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
    if (!source || !["npm", "git", "local", "upload"].includes(source.kind) || typeof source.spec !== "string" || !source.spec) continue;
    if (source.kind === "upload" && !isSafeUploadSpec(source.spec)) continue;
    seen.add(raw.id);
    const meta = normalizePluginMeta(raw.meta);
    const toolSwitches: EnginePluginRecord["toolSwitches"] = {};
    for (const [name, sw] of Object.entries(raw.toolSwitches ?? {})) {
      if (!sw || typeof sw !== "object") continue;
      toolSwitches[name] = typeof sw.enabled === "boolean" ? { enabled: sw.enabled } : {};
    }
    records.push({
      id: raw.id,
      engine: raw.engine,
      name: typeof raw.name === "string" && raw.name ? raw.name : raw.id,
      source: { kind: source.kind, spec: source.spec, ...(typeof source.registry === "string" && /^https?:\/\//i.test(source.registry) ? { registry: source.registry } : {}) },
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
