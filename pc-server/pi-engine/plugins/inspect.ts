// pi-engine/plugins/inspect.ts — 单个插件登记了什么(插件页的工具 / 指令清单,P5.8)
//
// 只加载扩展(跑一次插件的工厂函数,不建会话、不发 session_start),读它登记的工具与指令。加载期裁决不在这里做:
// 插件页要列出插件登记的全部工具(逐工具开关作用在名字上),被拿掉的那部分由审计说明。
// 要执行插件代码,所以只经 pi 驱动的 inspectPlugin 调用(主程序不直接引用本文件,engines/engine-agnostic-guard.test.ts 锁)。

import { loadExtensions } from "../../../pi/packages/coding-agent/src/core/extensions/loader.ts";
import type { EnginePlugin } from "../../engines/contract";
import type { EnginePluginInspectionDto } from "../../foundation/types/plugins";
import { isReservedPiCommand } from "./arbiter";
import { resolvePiPluginEntries } from "./entries";

/** 形状即插件详情接口的那一部分(foundation/types/plugins)。 */
export type PiPluginInspection = EnginePluginInspectionDto;

export async function inspectPiPlugin(plugin: EnginePlugin, cwd: string): Promise<PiPluginInspection> {
  const { entries, errors } = resolvePiPluginEntries([plugin]);
  const inspection: PiPluginInspection = { tools: [], commands: [], mcpServers: [], errors: errors.map((item) => item.error) };
  if (entries.length === 0) return inspection;
  const loaded = await loadExtensions(entries.map((entry) => entry.file), cwd);
  inspection.errors.push(...loaded.errors.map((item) => item.error));
  for (const extension of loaded.extensions) {
    for (const tool of extension.tools.values()) {
      const description = tool.definition.description;
      inspection.tools.push({ name: tool.definition.name, ...(description ? { description } : {}) });
    }
    for (const command of extension.commands.values()) {
      if (isReservedPiCommand(command.name)) continue;
      inspection.commands.push({ name: command.name, ...(command.description ? { description: command.description } : {}) });
    }
  }
  for (const server of loaded.runtime.mcpServers.list()) {
    inspection.mcpServers.push({ name: server.name, config: server.config as unknown as Record<string, unknown> });
  }
  return inspection;
}
