// pi-engine/plugins/inspect.ts — 单个插件登记了什么(插件页的工具 / 指令清单,P5.8)
//
// 只加载扩展(跑一次插件的工厂函数,不建会话、不发 session_start),读它登记的工具与指令。加载期裁决不在这里做:
// 插件页要列出插件登记的全部工具(逐工具开关作用在名字上),被拿掉的那部分由审计说明。

import { loadExtensions } from "../../../pi/packages/coding-agent/src/core/extensions/loader.ts";
import type { EnginePlugin } from "../../engines/contract";
import { isReservedPiCommand } from "./arbiter";
import { resolvePiPluginEntries } from "./entries";

export interface PiPluginInspection {
  tools: Array<{ name: string; description?: string }>;
  /** 入口类同名的指令不列(裁决层恒拿掉)。 */
  commands: Array<{ name: string; description?: string }>;
  /** 插件加载期经 registerMcpServer 声明的 MCP 服务(应用登记进自己的 MCP 列表,engines/plugin-mcp)。 */
  mcpServers: Array<{ name: string; config: Record<string, unknown> }>;
  errors: string[];
}

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

/** 插件包里能不能找到 pi 扩展入口(安装后校验用);找不到时返回原因。 */
export function piPluginEntryError(plugin: EnginePlugin): string | null {
  const { entries, errors } = resolvePiPluginEntries([plugin]);
  return entries.length > 0 ? null : (errors[0]?.error ?? "插件里找不到入口");
}
