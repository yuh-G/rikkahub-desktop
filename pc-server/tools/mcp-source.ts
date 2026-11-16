// tools/mcp-source.ts — MCP 服务器记录的来源,与「助手选没选用这台服务器」(D13,方案 §5.9)
//
// 用户自己加的服务器看助手的 mcpServers 勾选。插件带来的服务器(source.kind = plugin,由插件安装登记,
// 见 engines/plugin-mcp)跟随插件:插件启用(source.active)且助手绑定了这个插件即选用,不看勾选。
// 两种都还要过服务器总开关 commonOptions.enable(用户在 MCP 页的开关),那一项由调用方判。

import { getStringArray, isRecord } from "../foundation/utils";

export interface PluginMcpSource {
  kind: "plugin";
  pluginId: string;
  /** 插件声明里的服务名。 */
  name: string;
  /** 插件启停的镜像:插件停用时它的服务器对谁都不可用,用户在 MCP 页的开关不动。 */
  active: boolean;
}

export function pluginMcpSource(server: unknown): PluginMcpSource | null {
  if (!isRecord(server) || !isRecord(server.source) || server.source.kind !== "plugin") return null;
  const { pluginId, name, active } = server.source;
  if (typeof pluginId !== "string" || !pluginId) return null;
  return { kind: "plugin", pluginId, name: typeof name === "string" ? name : "", active: active !== false };
}

export function isMcpServerSelected(
  assistant: { mcpServers?: unknown; enginePluginIds?: unknown },
  server: Record<string, unknown>,
): boolean {
  const source = pluginMcpSource(server);
  if (source) return source.active && getStringArray(assistant.enginePluginIds).includes(source.pluginId);
  return getStringArray(assistant.mcpServers).includes(String(server.id ?? ""));
}
