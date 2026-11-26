// pi-engine/plugins/commands.ts — 插件指令的列举与查找(P5.7,方案 §5.9)
//
// 列举:会话有活的 pi 会话且插件集合相同 → 读它的登记表(含插件在 session_start 里补登记的);否则只加载扩展、
// 过一遍加载期裁决再读。这样插件的工厂函数多跑一次(不发 session_start、不绑会话)——pi 每建一个会话、每次
// /reload 都会跑它,插件本就要经得起;结果按工作目录 + 入口文件(含修改时间)缓存。
// 入口类指令名在裁决层已拿掉;session_start 之后运行期才登记的不经裁决,列举与查找时按同一名单再滤一次。
// 指令 id = JSON [插件 id, 指令名]:执行时在活会话的扩展里按它找,与 pi 自己给重名指令的「name:序号」无关
// (序号随加载顺序变)。

import { statSync } from "node:fs";
import { loadExtensions } from "../../../pi/packages/coding-agent/src/core/extensions/loader.ts";
import type { Extension, RegisteredCommand } from "../../../pi/packages/coding-agent/src/core/extensions/types.ts";
import type { EngineCommand, EnginePlugin } from "../../engines/contract";
import { arbitratePiExtensions, isReservedPiCommand } from "./arbiter";
import { pluginIdForExtensionPath, resolvePiPluginEntries, type PiPluginEntry } from "./entries";

export const piCommandId = (pluginId: string, name: string) => JSON.stringify([pluginId, name]);

export function commandsOfExtensions(extensions: readonly Extension[], entries: readonly PiPluginEntry[]): EngineCommand[] {
  const commands: EngineCommand[] = [];
  const seen = new Set<string>();
  for (const extension of extensions) {
    const pluginId = pluginIdForExtensionPath(entries, extension.path);
    if (!pluginId) continue;
    for (const command of extension.commands.values()) {
      if (isReservedPiCommand(command.name)) continue;
      const id = piCommandId(pluginId, command.name);
      if (seen.has(id)) continue;
      seen.add(id);
      commands.push({ id, name: command.name, ...(command.description ? { description: command.description } : {}), source: `plugin:${pluginId}` });
    }
  }
  return commands;
}

export function findPiPluginCommand(
  extensions: readonly Extension[],
  entries: readonly PiPluginEntry[],
  id: string,
): { pluginId: string; command: RegisteredCommand } | undefined {
  for (const extension of extensions) {
    const pluginId = pluginIdForExtensionPath(entries, extension.path);
    if (!pluginId) continue;
    for (const command of extension.commands.values()) {
      if (!isReservedPiCommand(command.name) && piCommandId(pluginId, command.name) === id) return { pluginId, command };
    }
  }
  return undefined;
}

const sameEntries = (a: readonly PiPluginEntry[], b: readonly PiPluginEntry[]) =>
  a.length === b.length && a.every((entry, index) => entry.pluginId === b[index]!.pluginId && entry.file === b[index]!.file);

/** 活会话的扩展与插件入口(没有活会话时不给)。 */
export interface PiLiveCommandSource {
  extensions: readonly Extension[];
  entries: readonly PiPluginEntry[];
}

export interface PiCommandCatalog {
  list(plugins: EnginePlugin[], cwd: string, live: PiLiveCommandSource | undefined): Promise<EngineCommand[]>;
  clear(): void;
}

export function createPiCommandCatalog(): PiCommandCatalog {
  const loaded = new Map<string, Promise<EngineCommand[]>>();
  return {
    async list(plugins, cwd, live) {
      const { entries } = resolvePiPluginEntries(plugins);
      if (entries.length === 0) return [];
      if (live && sameEntries(live.entries, entries)) return commandsOfExtensions(live.extensions, live.entries);
      // 入口文件改过(开发中的插件)即重新加载。
      const key = JSON.stringify({ cwd, entries: entries.map((entry) => [entry.pluginId, entry.file, mtimeOf(entry.file)]) });
      let pending = loaded.get(key);
      if (!pending) {
        pending = (async () => {
          const result = await loadExtensions(
            entries.map((entry) => entry.file),
            cwd,
          );
          // 加载失败与裁决审计由会话装配上报(resources);这里只读登记表。
          arbitratePiExtensions(result, { entries, appToolNames: new Set(), toolCallHooksDisabled: new Set(), onAudit: () => undefined });
          return commandsOfExtensions(result.extensions, entries);
        })();
        loaded.set(key, pending);
        pending.catch(() => loaded.delete(key));
      }
      return pending;
    },
    clear() {
      loaded.clear();
    },
  };
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0; // 文件刚被删:照常加载,加载器报它的错
  }
}
