// assistants/extension-selection.ts — 「用哪些拓展」这一组选择的形状与改写规则(D19,方案 §5.12)。
//
// 助手上的这组字段是「该助手下新会话的默认」;会话上同名的一组是这个会话实际用的。字段名、形状都与
// 助手记录一致(备份往返不变)。MCP 的两条联动规则(总开关重开时复活被逐工具关光的服务器、逐工具关光
// 时自动关总开关)只在这里写一份,助手弹窗、会话选择器、服务端接口共用。
//
// 纪律:本模块零 Bun/node 引用——web-ui 经 @server 直接复用。

export type McpToolOverride = { enable?: boolean; needsApproval?: boolean };
export type McpToolOverrides = Record<string, Record<string, McpToolOverride>>;

export interface ExtensionSelection {
  mcpServers: string[];
  mcpToolOverrides: McpToolOverrides;
  enabledSkills: string[];
  enginePluginIds: string[];
  modeInjectionIds: string[];
  lorebookIds: string[];
  quickMessageIds: string[];
}

export type McpSelection = Pick<ExtensionSelection, "mcpServers" | "mcpToolOverrides">;

const ID_LIST_KEYS = ["mcpServers", "enabledSkills", "enginePluginIds", "modeInjectionIds", "lorebookIds", "quickMessageIds"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))];
}

function readOverrides(value: unknown): McpToolOverrides | null {
  if (!isRecord(value)) return null;
  const out: McpToolOverrides = {};
  for (const [serverId, tools] of Object.entries(value)) {
    if (!isRecord(tools)) continue;
    const perServer: Record<string, McpToolOverride> = {};
    for (const [toolName, raw] of Object.entries(tools)) {
      if (!isRecord(raw)) continue;
      const entry: McpToolOverride = {};
      if (typeof raw.enable === "boolean") entry.enable = raw.enable;
      if (typeof raw.needsApproval === "boolean") entry.needsApproval = raw.needsApproval;
      if (Object.keys(entry).length > 0) perServer[toolName] = entry;
    }
    if (Object.keys(perServer).length > 0) out[serverId] = perServer;
  }
  return out;
}

/** 从任意记录(助手、请求体)里读出合法的部分选择;缺的、形状不对的键不出现。 */
export function readSelectionPatch(value: unknown): Partial<ExtensionSelection> {
  if (!isRecord(value)) return {};
  const patch: Partial<ExtensionSelection> = {};
  for (const key of ID_LIST_KEYS) {
    const ids = idList(value[key]);
    if (ids) patch[key] = ids;
  }
  const overrides = readOverrides(value.mcpToolOverrides);
  if (overrides) patch.mcpToolOverrides = overrides;
  return patch;
}

/** 助手上的默认选择(缺字段按空)。 */
export function selectionOf(assistant: unknown): ExtensionSelection {
  return {
    mcpServers: [],
    mcpToolOverrides: {},
    enabledSkills: [],
    enginePluginIds: [],
    modeInjectionIds: [],
    lorebookIds: [],
    quickMessageIds: [],
    ...readSelectionPatch(assistant),
  };
}

function findServer(servers: readonly unknown[], serverId: string): Record<string, unknown> | null {
  return (servers.find((server) => isRecord(server) && String(server.id ?? "") === serverId) as Record<string, unknown> | undefined) ?? null;
}

/** 全局可见的工具名(MCP 页里关掉的工具对谁都不出现,逐工具设置只在这些里面细分)。 */
function visibleToolNames(server: Record<string, unknown> | null): string[] {
  const common = server && isRecord(server.commonOptions) ? server.commonOptions : null;
  const tools = common && Array.isArray(common.tools) ? common.tools.filter(isRecord) : [];
  return tools.filter((tool) => tool.enable !== false).map((tool) => String(tool.name ?? ""));
}

function allToolsOverriddenOff(overrides: McpToolOverrides, serverId: string, servers: readonly unknown[]): boolean {
  const visible = visibleToolNames(findServer(servers, serverId));
  const perServer = overrides[serverId] ?? {};
  return visible.length > 0 && visible.every((name) => perServer[name]?.enable === false);
}

/** 开 / 关一台服务器。重新打开时,若它的可见工具全被逐工具设置关着(没有留下任何「要哪几个」的意思),
 *  清掉这些 enable 覆盖让工具全部回来;needsApproval 是另一维度,保留。 */
export function withMcpServerSelected(
  selection: McpSelection,
  serverId: string,
  selected: boolean,
  servers: readonly unknown[],
): McpSelection {
  const ids = new Set(selection.mcpServers);
  const wasSelected = ids.has(serverId);
  if (selected) ids.add(serverId);
  else ids.delete(serverId);
  let overrides = selection.mcpToolOverrides;
  if (selected && !wasSelected && allToolsOverriddenOff(overrides, serverId, servers)) {
    const kept: Record<string, McpToolOverride> = {};
    for (const [toolName, entry] of Object.entries(overrides[serverId] ?? {})) {
      if (typeof entry.needsApproval === "boolean") kept[toolName] = { needsApproval: entry.needsApproval };
    }
    overrides = { ...overrides };
    if (Object.keys(kept).length === 0) delete overrides[serverId];
    else overrides[serverId] = kept;
  }
  return { mcpServers: [...ids], mcpToolOverrides: overrides };
}

/** 改一个工具的覆盖。null = 清掉这一项(回到全局设置)。改完若这台服务器的可见工具全被关掉,
 *  总开关跟着关(与 MCP 页「工具全关 → 服务器关」同一规则)。 */
export function withMcpToolOverride(
  selection: McpSelection,
  serverId: string,
  toolName: string,
  patch: { enable?: boolean | null; needsApproval?: boolean | null },
  servers: readonly unknown[],
): McpSelection {
  const overrides = { ...selection.mcpToolOverrides };
  const perServer = { ...(overrides[serverId] ?? {}) };
  const next: McpToolOverride = { ...(perServer[toolName] ?? {}) };
  if (patch.enable === null) delete next.enable;
  else if (typeof patch.enable === "boolean") next.enable = patch.enable;
  if (patch.needsApproval === null) delete next.needsApproval;
  else if (typeof patch.needsApproval === "boolean") next.needsApproval = patch.needsApproval;
  if (Object.keys(next).length === 0) delete perServer[toolName];
  else perServer[toolName] = next;
  if (Object.keys(perServer).length === 0) delete overrides[serverId];
  else overrides[serverId] = perServer;
  const mcpServers = selection.mcpServers.includes(serverId) && allToolsOverriddenOff(overrides, serverId, servers)
    ? selection.mcpServers.filter((id) => id !== serverId)
    : selection.mcpServers;
  return { mcpServers, mcpToolOverrides: overrides };
}
