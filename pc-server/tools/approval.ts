// tools/approval.ts — 工具审批状态判断
// 纪律：纯函数，只读取 assistant / settings / 工作区档位，不读写 state 运行时副作用。
// workspace 工具（read/write/edit/bash）按会话绑定工作区的 permissionPreset 走审批
// 矩阵（workspace/approval.ts）。判定两段式：参数未到（args 缺省）用无参数下界，
// 参数齐备用终局判定（危险命令/区外写入才在 balanced 档触发审批）——单调只升不降，
// 循环层负责把上调同步回已建的卡（见 workspace/approval.ts 头注）。

import { getStringArray, isRecord } from "../foundation/utils";
import type { Assistant, Conversation, JsonValue, ToolApprovalState } from "../foundation/types";
import { skillsDir } from "../foundation/paths";
import { state } from "../persistence/json-store";
import {
  isWorkspaceToolName,
  lexicalWorkspaceCwd,
  workspaceCallApprovalReason,
  workspaceToolNeedsApproval,
  type WorkspaceToolName,
} from "../workspace/approval";
import { getWorkspace } from "../workspace";

type ConversationWorkspacePick = Pick<Conversation, "workspaceId" | "workspaceCwd">;

function parseArgsRecord(args: string): Record<string, JsonValue> {
  try {
    const parsed = JSON.parse(args) as JsonValue;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 工作区工具审批判定。args 缺省 = 参数未到（流式建卡），给无参数下界。 */
function workspaceApprovalDecision(
  toolName: WorkspaceToolName,
  conversation: ConversationWorkspacePick | null | undefined,
  args?: string,
): { pending: boolean; reason?: string } {
  // 工作区工具只在 workspaceId 非空的会话挂载；非工作区会话的残留调用在执行层被拒
  // （workspace/runtime.ts 守卫），这里不挂审批。
  const workspaceId = conversation?.workspaceId;
  if (!workspaceId) return { pending: false };
  const workspace = getWorkspace(workspaceId);
  // 工作区记录丢失 → 按最严档处理（执行层同样会拒，pending 卡只是多一道门）。
  const preset = workspace?.permissionPreset ?? "confirm_each";
  if (args === undefined || !workspace) {
    return { pending: workspaceToolNeedsApproval(toolName, preset) };
  }
  const reason = workspaceCallApprovalReason(toolName, preset, parseArgsRecord(args), {
    root: workspace.root,
    cwd: lexicalWorkspaceCwd(workspace.root, conversation?.workspaceCwd),
    // §6.7:技能库 pc-data/skills/ 免审批可写(AI 装/改技能不弹窗)。
    approvalExemptWritePrefixes: [skillsDir],
  });
  if (reason === null) return { pending: false };
  return { pending: true, ...(reason ? { reason } : {}) };
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

// Returns true if this tool requires user approval before executing — mirrors Android's
// GenerationHandler.kt:184-189 logic (`toolDef?.needsApproval == true && state is Auto -> Pending`).
// PC scope: `ask_user` is always pending (it's literally a "ask the user" prompt), and any
// MCP tool whose effective needsApproval (override-resolved) is true gets pending too. Local
// built-ins (search/scrape/memory/etc.) currently never need approval — Android matches.
export function toolNeedsApproval(
  toolName: string,
  assistant: Assistant,
  conversation?: ConversationWorkspacePick | null,
  args?: string,
): boolean {
  if (!toolName) return false;
  if (toolName === "ask_user") return true;
  if (isWorkspaceToolName(toolName)) {
    return workspaceApprovalDecision(toolName, conversation, args).pending;
  }
  if (!toolName.startsWith("mcp__")) return false;
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

export function initialApprovalState(
  toolName: string,
  assistant: Assistant,
  conversation?: ConversationWorkspacePick | null,
  args?: string,
): ToolApprovalState {
  if (isWorkspaceToolName(toolName)) {
    const decision = workspaceApprovalDecision(toolName, conversation, args);
    if (!decision.pending) return { type: "auto" };
    return decision.reason ? { type: "pending", reason: decision.reason } : { type: "pending" };
  }
  return toolNeedsApproval(toolName, assistant, conversation) ? { type: "pending" } : { type: "auto" };
}
