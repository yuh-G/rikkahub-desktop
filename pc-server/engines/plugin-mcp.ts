// engines/plugin-mcp.ts — 插件声明的 MCP 服务登记进应用的 MCP 列表(P5.8b,D13,方案 §5.9)
//
// 声明在安装 / 重装时读出(插件加载期经 registerMcpServer 登记的那批,形状是各 MCP 客户端通用的 mcpServers 条目),
// 每条转成一台 MCP 服务器记录:id 由「插件 id + 服务名」派生(重装得到同一个 id),带来源 source(tools/mcp-source)。
// 重装按 id 合并:只更新连接配置(地址、请求头;地址变了清掉旧授权,免得令牌发到新地址),用户在 MCP 页改的
// 开关、逐工具设置、显示名都保留;新版不再声明的服务器移除。插件启停只翻 source.active,卸载移除它的全部服务器。
// 应用只连 HTTP 服务器:stdio(本地程序)、借用引擎供应商凭据(auth)、请求头引用环境变量或命令的声明不登记,
// 原因交给调用方写审计。exposure / toolExposure / timeout 不映射(应用把服务器的工具直接给模型,逐工具开关在 MCP 页)。
// 会话里插件运行期再登记 / 取消登记的服务器不收集(那是单个会话的状态,应用的 MCP 列表是全局的),只记审计。

import { createHash } from "node:crypto";
import type { JsonValue } from "../foundation/types";
import type { EnginePluginRecord } from "../foundation/types/settings";
import { isRecord } from "../foundation/utils";
import { toMcpHeaderPairs } from "../tools/mcp-headers";
import { pluginMcpSource, type PluginMcpSource } from "../tools/mcp-source";

export interface PluginMcpDeclaration {
  name: string;
  config: Record<string, unknown>;
}

export interface PluginMcpSkipped {
  name: string;
  reason: string;
}

/** 稳定 id(UUID 形状,与用户新建的服务器同一种写法)。 */
export function pluginMcpServerId(pluginId: string, name: string): string {
  const hex = createHash("sha256").update(`${pluginId}\n${name}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function unsupportedReason(config: Record<string, unknown>): string | null {
  if (typeof config.url !== "string") return "transport: stdio";
  if (config.auth !== undefined) return "auth.provider";
  const headers = isRecord(config.headers) ? Object.values(config.headers) : [];
  if (headers.some((value) => typeof value === "string" && (value.includes("${") || value.startsWith("!")))) return "headers: ${VAR} / !command";
  return null;
}

function headerPairs(config: Record<string, unknown>): JsonValue[] {
  const headers = isRecord(config.headers) ? config.headers : {};
  return toMcpHeaderPairs(Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }))) as unknown as JsonValue[];
}

function serverFor(pluginId: string, active: boolean, declaration: PluginMcpDeclaration, existing: Record<string, JsonValue> | undefined): Record<string, JsonValue> {
  const url = String(declaration.config.url);
  const source: PluginMcpSource = { kind: "plugin", pluginId, name: declaration.name, active };
  const connection = { type: "streamable_http", url, source: source as unknown as JsonValue };
  if (existing && isRecord(existing.commonOptions)) {
    const common = existing.commonOptions;
    return {
      ...existing,
      ...connection,
      commonOptions: { ...common, headers: headerPairs(declaration.config), ...(existing.url !== url ? { oauth: null } : {}) },
    };
  }
  return {
    id: pluginMcpServerId(pluginId, declaration.name),
    ...connection,
    commonOptions: {
      enable: declaration.config.enabled !== false,
      name: declaration.name,
      headers: headerPairs(declaration.config),
      tools: [],
      lastSyncAt: null,
      lastSyncError: "",
      connected: false,
      oauth: null,
    },
  };
}

/** 按插件这次的声明重排它的服务器(其余服务器原样、原位);返回没登记的声明及原因。 */
export function syncPluginMcpServers(
  servers: readonly JsonValue[],
  pluginId: string,
  active: boolean,
  declarations: readonly PluginMcpDeclaration[],
): { servers: JsonValue[]; skipped: PluginMcpSkipped[] } {
  const skipped: PluginMcpSkipped[] = [];
  const wanted = new Map<string, PluginMcpDeclaration>();
  for (const declaration of declarations) {
    const reason = unsupportedReason(declaration.config);
    if (reason) skipped.push({ name: declaration.name, reason });
    else wanted.set(pluginMcpServerId(pluginId, declaration.name), declaration);
  }
  const next: JsonValue[] = [];
  for (const server of servers) {
    if (pluginMcpSource(server)?.pluginId !== pluginId) {
      next.push(server);
      continue;
    }
    const id = String((server as Record<string, JsonValue>).id ?? "");
    const declaration = wanted.get(id);
    if (!declaration) continue;
    wanted.delete(id);
    next.push(serverFor(pluginId, active, declaration, server as Record<string, JsonValue>));
  }
  for (const declaration of wanted.values()) next.push(serverFor(pluginId, active, declaration, undefined));
  return { servers: next, skipped };
}

function withActive(server: JsonValue, active: (pluginId: string) => boolean | undefined): JsonValue {
  const source = pluginMcpSource(server);
  const next = source ? active(source.pluginId) : undefined;
  if (!source || next === undefined || source.active === next) return server;
  return { ...(server as Record<string, JsonValue>), source: { ...source, active: next } as unknown as JsonValue };
}

export function setPluginMcpServersActive(servers: readonly JsonValue[], pluginId: string, active: boolean): JsonValue[] {
  return servers.map((server) => withActive(server, (id) => (id === pluginId ? active : undefined)));
}

export function removePluginMcpServers(servers: readonly JsonValue[], pluginId: string): JsonValue[] {
  return servers.filter((server) => pluginMcpSource(server)?.pluginId !== pluginId);
}

/** 读盘与导入后:插件记录已不在的服务器移除,source.active 跟插件记录的启停对齐。 */
export function reconcilePluginMcpServers(servers: readonly JsonValue[], records: readonly EnginePluginRecord[]): JsonValue[] {
  const enabled = new Map(records.map((record) => [record.id, record.enabled]));
  return servers
    .filter((server) => {
      const source = pluginMcpSource(server);
      return !source || enabled.has(source.pluginId);
    })
    .map((server) => withActive(server, (id) => enabled.get(id)));
}
