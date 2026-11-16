// tools/approval.ts — 工具审批接线:工具名 + 参数 → PermissionRequest,应用设置 → PermissionPolicy
// 判定本身在 tools/permission.ts(只读「类别 + 对象」的纯函数),工具名 → 类别 + 对象的知识在
// tools/tool-categories.ts。这里只做两件事:查表并从参数取对象(args 缺省 = 参数未到,请求不带对象,
// 得无参数下界);把会话绑定工作区的档位与 MCP 逐工具设置解析成策略。策略按类别惰性解析:非 MCP 工具不读 state,非写入 / 执行不查工作区。
// 终局比下界只升不降,循环层负责把上调同步回已建的卡(见 tools/permission.ts 头注)。

import { getStringArray, isRecord } from "../foundation/utils";
import type { Assistant, Conversation, JsonValue, ToolApprovalState } from "../foundation/types";
import { skillsDir } from "../foundation/paths";
import { state } from "../persistence/json-store";
import { lexicalWorkspaceCwd } from "../workspace/approval";
import { getWorkspace } from "../workspace";
import { isEnginePluginToolExempt } from "../engines/plugins";
import { isToolAllowedForSession } from "../inference-engine/approval-gate";
import {
  decidePermission,
  type PermissionDecision,
  type PermissionPolicy,
  type PermissionTarget,
  type ToolCategory,
  type WorkspacePolicy,
} from "./permission";
import { classifyAppTool } from "./tool-categories";

type ConversationWorkspacePick = Pick<Conversation, "id" | "workspaceId" | "workspaceCwd">;

function parseArgsRecord(args: string): Record<string, JsonValue> {
  try {
    const parsed = JSON.parse(args) as JsonValue;
    return isRecord(parsed) ? parsed : {};
  } catch {
    // 参数不是合法 JSON:按无对象处理,执行层会按 schema 报错回灌模型。
    return {};
  }
}

function workspacePolicy(conversation: ConversationWorkspacePick | null | undefined): WorkspacePolicy | null {
  const workspaceId = conversation?.workspaceId;
  if (!workspaceId) return null;
  const workspace = getWorkspace(workspaceId);
  // 工作区记录丢失 → 按最严档处理(执行层同样会拒,pending 卡只是多一道门)。
  if (!workspace) return { preset: "confirm_each", root: "", cwd: "", exemptWritePrefixes: [] };
  return {
    preset: workspace.permissionPreset,
    root: workspace.root,
    cwd: lexicalWorkspaceCwd(workspace.root, conversation?.workspaceCwd),
    // §6.7:技能库 pc-data/skills/ 免审批可写(AI 装/改技能不弹窗)。
    exemptWritePrefixes: [skillsDir],
  };
}

export function getMcpToolOverride(
  assistant: Assistant,
  serverId: string,
  toolName: string,
): { enable?: boolean; needsApproval?: boolean } | undefined {
  const overrides = isRecord(assistant.mcpToolOverrides)
    ? (assistant.mcpToolOverrides as Record<string, Record<string, { enable?: boolean; needsApproval?: boolean }>>)
    : undefined;
  if (!overrides) return undefined;
  const perServer = overrides[serverId];
  if (!perServer) return undefined;
  return perServer[toolName];
}

// Per-assistant resolved enable state for a tool. Global tool.enable=false ⇒ false (override
// can never reactivate a globally-disabled tool — matches the user's stated rule "设置中关闭
// 的工具会话里看不见"). Otherwise, the override.enable wins; absence falls back to true.
export function isMcpToolEnabledForAssistant(
  assistant: Assistant,
  serverId: string,
  tool: Record<string, unknown>,
): boolean {
  if (tool.enable === false) return false;
  const override = getMcpToolOverride(assistant, serverId, String(tool.name ?? ""));
  if (override?.enable === false) return false;
  return true;
}

// Per-assistant resolved needsApproval state. Override wins when set (true/false), otherwise
// falls back to the global per-tool needsApproval flag.
export function isMcpToolApprovalRequiredForAssistant(
  assistant: Assistant,
  serverId: string,
  tool: Record<string, unknown>,
): boolean {
  const override = getMcpToolOverride(assistant, serverId, String(tool.name ?? ""));
  if (typeof override?.needsApproval === "boolean") return override.needsApproval;
  return tool.needsApproval === true;
}

/** 该 MCP 工具对当前助手生效的 needsApproval;助手没选中、服务停用或工具已关 → false(本轮不会挂载)。 */
function mcpApprovalRequired(toolName: string, assistant: Assistant): boolean {
  const selected = new Set(getStringArray(assistant.mcpServers));
  const servers = (state.settings.mcpServers as Array<Record<string, unknown>>)
    .filter((server) => selected.has(String(server.id ?? "")) && isRecord(server.commonOptions) && server.commonOptions.enable !== false);
  for (const server of servers) {
    const common = server.commonOptions as Record<string, unknown>;
    const tools = Array.isArray(common.tools) ? common.tools.filter(isRecord) : [];
    const matched = tools.find(
      (tool) =>
        isMcpToolEnabledForAssistant(assistant, String(server.id ?? ""), tool)
        && `mcp__${String(tool.name ?? "").replace(/[^a-zA-Z0-9_-]/g, "_")}` === toolName,
    );
    if (matched) return isMcpToolApprovalRequiredForAssistant(assistant, String(server.id ?? ""), matched);
  }
  return false;
}

/** 一次应用工具调用的审批判定(两个引擎、聊天引擎各供应商路径的唯一入口)。args 缺省 = 参数未到
 *  (流式建卡),给无参数下界;结果直接作工具卡的初始审批态。 */
export function decideAppToolPermission(
  toolName: string,
  assistant: Assistant,
  conversation?: ConversationWorkspacePick | null,
  args?: string,
): PermissionDecision {
  const entry = classifyAppTool(toolName);
  if (!entry) return { type: "auto" };
  const { category } = entry;
  const policy: PermissionPolicy = {};
  if (category === "write" || category === "execute") policy.workspace = workspacePolicy(conversation);
  if (category === "mcp") policy.mcpApprovalRequired = mcpApprovalRequired(toolName, assistant);
  return decidePermission(
    {
      conversationId: conversation?.id ?? "",
      toolName,
      category,
      ...(args === undefined ? {} : { target: entry.target(parseArgsRecord(args)) }),
      origin: { kind: "app" },
    },
    policy,
  );
}

/** 引擎自带工具(pi 的 read / bash 等)的审批判定:类别与对象由引擎按自己的映射表给出,这里不认工具名。
 *  对象恒已齐备(执行前才问),得到的就是终局。 */
export function decideEngineToolPermission(
  conversation: ConversationWorkspacePick,
  toolName: string,
  category: ToolCategory,
  target: PermissionTarget,
): PermissionDecision {
  const policy: PermissionPolicy = {};
  if (category === "write" || category === "execute") policy.workspace = workspacePolicy(conversation);
  return decidePermission({ conversationId: conversation.id, toolName, category, target, origin: { kind: "engine" } }, policy);
}

/** 插件工具的会话级免问键(审批卡「此会话内总是允许该工具」记在这个键上)。 */
export function pluginToolSessionKey(pluginId: string, toolName: string): string {
  return `plugin:${pluginId}:${toolName}`;
}

/** 一次插件工具调用的审批判定:默认询问;插件页设了免问或本会话已选「总是允许」则免问。 */
export function pluginToolApprovalState(conversationId: string, pluginId: string, toolName: string): ToolApprovalState {
  return decidePermission(
    { conversationId, toolName, category: "plugin", origin: { kind: "plugin", pluginId } },
    {
      pluginToolExempt: isEnginePluginToolExempt(state.settings.enginePlugins, pluginId, toolName),
      allowedForSession: isToolAllowedForSession(conversationId, pluginToolSessionKey(pluginId, toolName)),
    },
  );
}
