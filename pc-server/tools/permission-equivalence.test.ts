// tools/permission-equivalence.test.ts — P4.4 等价性:按类别的新判定与按工具名的旧判定(5d4c763 原样副本)逐项相同
// 样本 = 工具名 × 参数(含参数未到)× 会话形状(没绑工作区 / 三档 / 工作区记录丢失 / 子目录 cwd)
//        × 助手的 MCP 设置(全局逐工具 / 助手覆盖 / 未选中 / 服务停用 / 工具已关)。
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Assistant, State } from "../foundation/types";

// paths.ts 在 import 时刻固化 dataDir——必须先设环境变量再动态加载被测模块。
process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-permission-eq-test-"));

const conversations = await import("../conversations");
const ws = await import("../workspace");
const { skillsDir } = await import("../foundation/paths");
const store = await import("../persistence/json-store");
const { defaultState } = await import("../app-config/defaults");
const { initialApprovalState, toolNeedsApproval } = await import("./approval");
const { legacyInitialApprovalState, legacyToolNeedsApproval } = await import("./approval-legacy");

conversations.openConversationsDb();
store.setState(defaultState() as State);
store.state.settings.mcpServers = [
  {
    id: "s1",
    commonOptions: {
      name: "S1",
      enable: true,
      tools: [
        { name: "ask me", enable: true, needsApproval: true },
        { name: "free", enable: true, needsApproval: false },
        { name: "off", enable: false, needsApproval: true },
        { name: "overridden", enable: true, needsApproval: false },
      ],
    },
  },
  { id: "s2", commonOptions: { name: "S2", enable: false, tools: [{ name: "dormant", enable: true, needsApproval: true }] } },
] as State["settings"]["mcpServers"];

const assistants: Assistant[] = [
  { id: "a-plain", mcpServers: ["s1", "s2"] },
  {
    id: "a-override",
    mcpServers: ["s1"],
    mcpToolOverrides: { s1: { "ask me": { needsApproval: false }, overridden: { needsApproval: true }, free: { enable: false } } },
  },
  { id: "a-none", mcpServers: [] },
] as unknown as Assistant[];

const TOOL_NAMES = [
  "", "read", "grep", "find", "ls", "write", "edit", "bash",
  "search_web", "scrape_web", "use_skill", "save_memory", "get_time_info", "clipboard_tool", "text_to_speech", "ask_user",
  "mcp__ask_me", "mcp__free", "mcp__off", "mcp__overridden", "mcp__dormant", "mcp__missing", "mcp__",
  "unknown_tool",
];

function conversationShapes() {
  const shapes: Array<{ label: string; conversation: { id: string; workspaceId?: string | null; workspaceCwd?: string | null } | null | undefined }> = [
    { label: "缺省", conversation: undefined },
    { label: "null", conversation: null },
    { label: "没绑工作区", conversation: { id: "c-none", workspaceId: null } },
    { label: "工作区记录丢失", conversation: { id: "c-gone", workspaceId: "ws-missing" } },
  ];
  for (const preset of ["confirm_each", "balanced", "full_access"] as const) {
    const workspace = ws.createWorkspace({ type: "managed", name: `eq-${preset}` });
    ws.updateWorkspace(workspace.id, { permissionPreset: preset });
    shapes.push({ label: preset, conversation: { id: `c-${preset}`, workspaceId: workspace.id } });
    shapes.push({ label: `${preset}/sub`, conversation: { id: `c-${preset}-sub`, workspaceId: workspace.id, workspaceCwd: "sub" } });
  }
  return shapes;
}

const ARGS: Array<string | undefined> = [
  undefined,
  "",
  "not json",
  "[]",
  "{}",
  JSON.stringify({ path: "a.txt", content: "x" }),
  JSON.stringify({ path: "../escape.txt" }),
  JSON.stringify({ path: "../../escape.txt" }),
  JSON.stringify({ path: "~/escape.txt" }),
  JSON.stringify({ path: join(homedir(), "x.txt") }),
  JSON.stringify({ path: join(skillsDir, "demo", "SKILL.md") }),
  JSON.stringify({ path: `${skillsDir}-evil/x.md` }),
  JSON.stringify({ path: "   " }),
  JSON.stringify({ path: 42 }),
  JSON.stringify({ command: "ls -la" }),
  JSON.stringify({ command: "rm -rf /" }),
  JSON.stringify({ command: "bun test && git status" }),
  JSON.stringify({ command: 7 }),
  JSON.stringify({ url: "https://example.com" }),
  JSON.stringify({ questions: [{ id: "q1", question: "?" }] }),
];

describe("新旧审批判定等价", () => {
  test("toolNeedsApproval 与 initialApprovalState 在全部样本上逐项相同", () => {
    let samples = 0;
    let pendings = 0;
    for (const { label, conversation } of conversationShapes()) {
      for (const assistant of assistants) {
        for (const name of TOOL_NAMES) {
          for (const args of ARGS) {
            const where = `${label} / ${assistant.id} / ${name} / ${args}`;
            const next = initialApprovalState(name, assistant, conversation, args);
            expect({ where, state: next }).toEqual({ where, state: legacyInitialApprovalState(name, assistant, conversation, args) });
            const needs = toolNeedsApproval(name, assistant, conversation, args);
            expect({ where, needs }).toEqual({ where, needs: legacyToolNeedsApproval(name, assistant, conversation, args) });
            samples += 1;
            if (needs) pendings += 1;
          }
        }
      }
    }
    // 样本要真的覆盖到两种结果,而不是全 auto 的空等价。
    expect(samples).toBeGreaterThan(5000);
    expect(pendings).toBeGreaterThan(500);
  });
});
