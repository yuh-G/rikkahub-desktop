// tools/third-party-approval.test.ts — 第三方工具(MCP、插件)的审批按模式分治(D32)
// 工作区会话只看档位:询问批准每次问,默认权限与完全访问不问,MCP 的「需要用户审核」不起作用;对话模式里 MCP 照旧看
// 逐工具设置(含助手级覆盖)。审批卡「此会话内总是允许」两类都记,只记在本会话、只对带免问键的审批生效,会话删除即忘。
// 档位每次调用现读,会话中途换档下一次调用就生效;工作区记录丢失按最严档。
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assistant, State, WorkspacePermissionPreset } from "../foundation/types";
import type { GenerationEvent } from "../inference-engine/events";

// paths.ts 在 import 时刻固化 dataDir——必须先设环境变量再动态加载被测模块。
process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-third-party-approval-test-"));

const { appToolSessionAllowKey, decideAppToolPermission, mcpToolSessionKey, pluginToolApprovalState, pluginToolSessionKey } = await import("./approval");
const { gateToolApproval } = await import("../inference-engine/approval-flow");
const gate = await import("../inference-engine/approval-gate");
const { defaultState } = await import("../app-config/defaults");
const { defaultAssistant } = await import("../assistants");
const conversations = await import("../conversations");
const ws = await import("../workspace");
const jsonStore = await import("../persistence/json-store");

jsonStore.setState(defaultState());
jsonStore.state.settings.mcpServers = [
  {
    id: "srv1",
    commonOptions: {
      name: "Fake",
      enable: true,
      tools: [
        { name: "alpha", enable: true, needsApproval: true },
        { name: "beta", enable: true, needsApproval: false },
      ],
    },
  },
] as State["settings"]["mcpServers"];
conversations.openConversationsDb();

type ConversationPick = { id: string; workspaceId: string | null; workspaceCwd: string | null };

const assistant = (overrides: Partial<Assistant> = {}): Assistant => ({ ...defaultAssistant(), id: "tpa-a", mcpServers: ["srv1"], ...overrides });

let seq = 0;
function workspaceConversation(preset: WorkspacePermissionPreset) {
  seq += 1;
  const workspace = ws.createWorkspace({ type: "managed", name: `tpa-${seq}` });
  ws.updateWorkspace(workspace.id, { permissionPreset: preset });
  return { workspace, conversation: { id: `tpa-ws-${seq}`, workspaceId: workspace.id, workspaceCwd: null } as ConversationPick };
}
const chatConversation = (id: string): ConversationPick => ({ id, workspaceId: null, workspaceCwd: null });

const mcp = (toolName: string, a: Assistant, conversation: ConversationPick) => decideAppToolPermission(toolName, a, conversation, "{}").type;
const plugin = (conversation: ConversationPick, toolName = "lookup", pluginId = "demo-plugin") =>
  pluginToolApprovalState(conversation, pluginId, toolName).type;

async function approveOnce(conversationId: string, toolCallId: string, alwaysAllowInSession: boolean, sessionAllowKey?: string) {
  const events: GenerationEvent[] = [];
  const run = gateToolApproval({ type: "pending" }, {
    conversationId,
    toolCallId,
    sink: (event) => void events.push(event),
    ...(sessionAllowKey ? { sessionAllowKey } : {}),
  });
  expect(gate.resolveToolApproval(conversationId, toolCallId, { approved: true, alwaysAllowInSession })).toBe(true);
  expect(await run).toBe(true);
}

describe("工作区会话:只看档位", () => {
  test("询问批准:MCP 工具(不论开关)与插件工具都问;待审卡不附缘由", () => {
    const { conversation } = workspaceConversation("confirm_each");
    expect(mcp("mcp__alpha", assistant(), conversation)).toBe("pending");
    expect(mcp("mcp__beta", assistant(), conversation)).toBe("pending");
    expect(pluginToolApprovalState(conversation, "demo-plugin", "lookup")).toEqual({ type: "pending" });
  });

  test("默认权限、完全访问:都不问,标了「需要用户审核」的 MCP 工具也不问", () => {
    for (const preset of ["balanced", "full_access"] as const) {
      const { conversation } = workspaceConversation(preset);
      expect(mcp("mcp__alpha", assistant(), conversation)).toBe("auto");
      expect(mcp("mcp__beta", assistant({ mcpToolOverrides: { srv1: { beta: { needsApproval: true } } } }), conversation)).toBe("auto");
      expect(plugin(conversation)).toBe("auto");
    }
  });

  test("档位每次现读:会话中途换档,下一次调用就按新档判", () => {
    const { workspace, conversation } = workspaceConversation("balanced");
    expect(mcp("mcp__beta", assistant(), conversation)).toBe("auto");
    expect(plugin(conversation)).toBe("auto");
    ws.updateWorkspace(workspace.id, { permissionPreset: "confirm_each" });
    expect(mcp("mcp__beta", assistant(), conversation)).toBe("pending");
    expect(plugin(conversation)).toBe("pending");
  });

  test("工作区记录丢失:按最严档询问", () => {
    const gone: ConversationPick = { id: "tpa-gone", workspaceId: "no-such-workspace", workspaceCwd: null };
    expect(mcp("mcp__beta", assistant(), gone)).toBe("pending");
    expect(plugin(gone)).toBe("pending");
  });
});

describe("对话模式:MCP 看逐工具设置", () => {
  test("全局开关,助手级覆盖优先;审批不带免问键,选了「总是允许」也不记", async () => {
    const conversation = chatConversation("tpa-chat-1");
    expect(mcp("mcp__alpha", assistant(), conversation)).toBe("pending");
    expect(mcp("mcp__beta", assistant(), conversation)).toBe("auto");
    const overridden = assistant({ mcpToolOverrides: { srv1: { alpha: { needsApproval: false }, beta: { needsApproval: true } } } });
    expect(mcp("mcp__alpha", overridden, conversation)).toBe("auto");
    expect(mcp("mcp__beta", overridden, conversation)).toBe("pending");
    expect(appToolSessionAllowKey("mcp__alpha", conversation)).toBeUndefined();
    await approveOnce(conversation.id, "tpa-chat-call", true, appToolSessionAllowKey("mcp__alpha", conversation));
    expect(mcp("mcp__alpha", assistant(), conversation)).toBe("pending");
  });
});

describe("此会话内总是允许", () => {
  test("免问键:工作区会话里的 MCP 工具有,别的应用工具没有", () => {
    const { conversation } = workspaceConversation("confirm_each");
    expect(appToolSessionAllowKey("mcp__alpha", conversation)).toBe(mcpToolSessionKey("mcp__alpha"));
    expect(appToolSessionAllowKey("search_web", conversation)).toBeUndefined();
    expect(appToolSessionAllowKey("ask_user", conversation)).toBeUndefined();
  });

  test("只批准一次不记;选了之后本会话免问,别的会话、别的工具、别的插件照问", async () => {
    const { conversation } = workspaceConversation("confirm_each");
    const other = workspaceConversation("confirm_each").conversation;
    const pluginKey = pluginToolSessionKey("demo-plugin", "lookup");
    await approveOnce(conversation.id, "tpa-1", false, pluginKey);
    expect(plugin(conversation)).toBe("pending");

    await approveOnce(conversation.id, "tpa-2", true, pluginKey);
    await approveOnce(conversation.id, "tpa-3", true, appToolSessionAllowKey("mcp__alpha", conversation));
    expect(pluginToolApprovalState(conversation, "demo-plugin", "lookup")).toEqual({ type: "auto" });
    expect(mcp("mcp__alpha", assistant(), conversation)).toBe("auto");
    expect(plugin(other)).toBe("pending");
    expect(mcp("mcp__alpha", assistant(), other)).toBe("pending");
    expect(plugin(conversation, "other")).toBe("pending");
    expect(plugin(conversation, "lookup", "other-plugin")).toBe("pending");
    expect(mcp("mcp__beta", assistant(), conversation)).toBe("pending");
  });

  test("不带免问键的审批(写入 / 执行类)即使带了「总是允许」也不记", async () => {
    const { conversation } = workspaceConversation("confirm_each");
    await approveOnce(conversation.id, "tpa-4", true);
    expect(gate.isToolAllowedForSession(conversation.id, pluginToolSessionKey("demo-plugin", "lookup"))).toBe(false);
    expect(gate.isToolAllowedForSession(conversation.id, mcpToolSessionKey("mcp__alpha"))).toBe(false);
  });

  test("会话删除即忘", async () => {
    const { conversation } = workspaceConversation("confirm_each");
    await approveOnce(conversation.id, "tpa-5", true, pluginToolSessionKey("demo-plugin", "lookup"));
    await approveOnce(conversation.id, "tpa-6", true, mcpToolSessionKey("mcp__alpha"));
    expect(plugin(conversation)).toBe("auto");
    gate.forgetSessionToolAllowances(conversation.id);
    expect(plugin(conversation)).toBe("pending");
    expect(mcp("mcp__alpha", assistant(), conversation)).toBe("pending");
  });
});
