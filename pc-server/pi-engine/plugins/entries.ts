// pi-engine/plugins/entries.ts — 插件位置 → pi 扩展入口文件(P5.2)
//
// 应用给的是插件位置(入口文件或包目录)。这里按 pi 的包约定展开成入口文件再交给资源加载器
// (additionalExtensionPaths),而不是把包目录直接交过去:pi 对包目录会顺带收集包里声明的技能 /
// 提示词模板 / 主题,并且这条路不受 noSkills / noPromptTemplates 约束——技能是应用资源,插件包不能
// 借此塞进来,也不能用同名技能挤掉技能库里的那份(pi 按先到先得处理重名)。
// 入口规则与 pi 加载器一致:package.json 的 pi.extensions(存在的项)→ index.ts → index.js。
// 一个插件可以有多个入口文件;入口文件 → 插件 id 的对应关系是插件身份的来源(审计、否决署名、
// 审批来源都按它认领,方案 §5.5「插件身份」)。

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readPiManifest } from "../../../pi/packages/coding-agent/src/core/pi-manifest.ts";
import { getResourcePathKey } from "../../../pi/packages/coding-agent/src/core/source-info.ts";
import type { EnginePlugin } from "../../engines/contract";

export interface PiPluginEntry {
  pluginId: string;
  file: string;
}

export interface PiPluginEntryError {
  pluginId: string;
  path: string;
  error: string;
}

function entriesOfDirectory(dir: string): string[] {
  const declared = (readPiManifest(join(dir, "package.json"))?.extensions ?? [])
    .map((entry) => resolve(dir, entry))
    .filter((file) => existsSync(file));
  if (declared.length > 0) return declared;
  for (const name of ["index.ts", "index.js"]) {
    const file = join(dir, name);
    if (existsSync(file)) return [file];
  }
  return [];
}

export function resolvePiPluginEntries(plugins: EnginePlugin[]): { entries: PiPluginEntry[]; errors: PiPluginEntryError[] } {
  const entries: PiPluginEntry[] = [];
  const errors: PiPluginEntryError[] = [];
  const seen = new Set<string>();
  for (const plugin of plugins) {
    const location = resolve(plugin.path);
    let files: string[];
    try {
      files = statSync(location).isDirectory() ? entriesOfDirectory(location) : [location];
    } catch {
      // stat 失败 = 路径不存在或不可读,按配置错误报给用户,其它插件照常加载。
      errors.push({ pluginId: plugin.id, path: location, error: "插件路径不存在" });
      continue;
    }
    if (files.length === 0) {
      errors.push({ pluginId: plugin.id, path: location, error: "插件目录里找不到入口(package.json 的 pi.extensions、index.ts 或 index.js)" });
      continue;
    }
    for (const file of files) {
      // 同一个入口文件只认第一个声明它的插件(两条清单项指向同一包时不重复加载)。
      const key = getResourcePathKey(file);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ pluginId: plugin.id, file });
    }
  }
  return { entries, errors };
}

/** 按扩展的加载路径认领插件 id(路径比较走 pi 自己的规范化:真实路径 + Windows 大小写不敏感)。 */
export function pluginIdForExtensionPath(entries: readonly PiPluginEntry[], extensionPath: string): string | undefined {
  const key = getResourcePathKey(extensionPath);
  return entries.find((entry) => getResourcePathKey(entry.file) === key)?.pluginId;
}
