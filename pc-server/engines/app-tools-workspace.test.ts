// pi-engine/workspace-tools.test.ts — 七工具 customTools 的契约对照 + 审批内化行为(P3)
//
// 两类保障:
// 1) 升级回归门:我们移植工具(customTools 声明来源)与 pi 原版工厂的 name/description/
//    parameters 必须语义全等(键序无关;TypeBox 先 required 后 properties,纯序差)。
//    pi 升级改工具面 → 本测试红,倒逼重新对齐移植层(方案 §〇 升级纪律)。
// 2) 审批内化(方案 §4.4):auto 直执行;pending 挂卡等决定(放行→userApproved 执行/
//    拒绝→历史契约文案抛错);中止时卡收敛 denied。
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-pitools-test-"));

const conversations = await import("../conversations");
const { configureWorkingSet } = await import("../conversations/working-set");
const { getConversationMeta } = await import("../conversations/read-queries");
const ws = await import("../workspace");
const runtime = await import("../workspace/runtime");
const { createPiWorkspaceTools } = await import("./workspace-tools");
const { resolveToolApproval, pendingToolApprovalCount } = await import("../inference-engine/approval-gate");
const ourTools = {
  read: (await import("../workspace/tools/read")).createReadTool,
  bash: (await import("../workspace/tools/bash")).createBashTool,
  edit: (await import("../workspace/tools/edit")).createEditTool,
  write: (await import("../workspace/tools/write")).createWriteTool,
  grep: (await import("../workspace/tools/grep")).createGrepTool,
  find: (await import("../workspace/tools/find")).createFindTool,
  ls: (await import("../workspace/tools/ls")).createLsTool,
};
const pi = await import("../../pi/packages/coding-agent/src/core/sdk.ts");
const piPromptContributions: Record<string, { snippet: string; guidelines: readonly string[] }> = {
  read: (await import("../../pi/packages/coding-agent/src/core/tools/read.ts")).readToolSystemPromptContribution,
  bash: (await import("../../pi/packages/coding-agent/src/core/tools/bash.ts")).bashToolSystemPromptContribution,
  edit: (await import("../../pi/packages/coding-agent/src/core/tools/edit.ts")).editToolSystemPromptContribution,
  write: (await import("../../pi/packages/coding-agent/src/core/tools/write.ts")).writeToolSystemPromptContribution,
  grep: (await import("../../pi/packages/coding-agent/src/core/tools/grep.ts")).grepToolSystemPromptContribution,
  find: (await import("../../pi/packages/coding-agent/src/core/tools/find.ts")).findToolSystemPromptContribution,
  ls: (await import("../../pi/packages/coding-agent/src/core/tools/ls.ts")).lsToolSystemPromptContribution,
};
import type { GenerationEvent } from "../inference-engine/events";

const db = conversations.openConversationsDb();

function installWorkingSet() {
  configureWorkingSet({
    loadConversation: (convId) => {
      const meta = getConversationMeta(db, convId);
      if (!meta) return undefined;
      meta.messages = conversations.loadConversationNodesFromDb(db, convId);
      return meta;
    },
    isGenerating: () => false,
    hasSseClients: () => false,
    hasDirty: () => false,
  });
}
installWorkingSet();
beforeAll(installWorkingSet);

let seq = 0;
function bindConversation(workspaceId: string | null) {
  seq += 1;
  const conversation = {
    id: `pitools-conv-${seq}`,
    assistantId: "a1",
    systemPrompt: null,
    title: `t-${seq}`,
    messages: [],
    chatSuggestions: [],
    isPinned: false,
    createAt: 1000,
    updateAt: 2000,
    workspaceId,
    workspaceCwd: null,
  };
  conversations.persistConversation(conversation);
  return conversation;
}

const fakeAssistant = { id: "a1", name: "A", systemPrompt: "", mcpServers: [] } as never;

type SinkLog = { events: GenerationEvent[]; sink: (event: GenerationEvent) => void };
function makeSink(): SinkLog {
  const events: GenerationEvent[] = [];
  return { events, sink: (event) => void events.push(event) };
}

function approvalEvents(log: SinkLog): Array<{ type: string; reason?: string }> {
  return log.events
    .filter((event) => event.kind === "tool_approval_updated")
    .map((event) => (event as { approvalState: { type: string; reason?: string } }).approvalState);
}

async function waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) out[key] = canonical((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

type AnyTool = { name: string; description: string; parameters: unknown };
type ExecFn = (
  toolCallId: string,
  params: unknown,
  signal?: AbortSignal,
  onUpdate?: (partial: unknown) => void,
) => Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown> }>;

function execOf(tool: { execute: unknown }): ExecFn {
  return tool.execute as ExecFn;
}

describe("契约对照(pi 升级回归门)", () => {
  test("七工具 name/description/parameters 与 pi 原版语义全等(键序无关)", () => {
    const cwd = process.cwd();
    const piFactories: Record<string, AnyTool> = {
      read: pi.createReadTool(cwd) as AnyTool,
      bash: pi.createBashTool(cwd) as AnyTool,
      edit: pi.createEditTool(cwd) as AnyTool,
      write: pi.createWriteTool(cwd) as AnyTool,
      grep: pi.createGrepTool(cwd) as AnyTool,
      find: pi.createFindTool(cwd) as AnyTool,
      ls: pi.createLsTool(cwd) as AnyTool,
    };
    for (const [name, factory] of Object.entries(ourTools)) {
      const mine = factory(cwd) as unknown as AnyTool;
      const theirs = piFactories[name];
      expect(mine.name).toBe(theirs.name);
      expect(mine.description).toBe(theirs.description);
      expect(canonical(JSON.parse(JSON.stringify(mine.parameters)))).toEqual(
        canonical(JSON.parse(JSON.stringify(theirs.parameters))),
      );
    }
    // bash 是唯一在 pi 工厂产物上暴露 promptSnippet 的工具,顺带钉住镜像文案。
    const piBash = piFactories.bash as AnyTool & { promptSnippet?: string };
    expect(piBash.promptSnippet).toBe("Execute bash commands (ls, grep, find, etc.)");
  });

  test("createPiWorkspaceTools:挂载矩阵 + sequential + snippet + edit prepareArguments", () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "contract" });
    const conversation = bindConversation(workspace.id);
    const log = makeSink();
    const tools = createPiWorkspaceTools({ conversation, assistant: fakeAssistant, sink: log.sink });
    expect(tools.map((tool) => tool.name)).toEqual(runtime.mountedWorkspaceToolNames());
    for (const tool of tools) {
      expect(tool.executionMode).toBe("sequential");
      expect(typeof tool.promptSnippet).toBe("string");
      expect((tool.promptSnippet ?? "").length).toBeGreaterThan(0);
      expect(tool.label).toBe(tool.name);
      if (tool.name === "edit") expect(typeof tool.prepareArguments).toBe("function");
      else expect(tool.prepareArguments).toBeUndefined();
    }
  });

  test("promptSnippet/promptGuidelines 逐字镜像 pi 各工具的 SystemPromptContribution 常量(bash 不镜像 PI_* 条目)", () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "prompt-mirror" });
    const conversation = bindConversation(workspace.id);
    const tools = createPiWorkspaceTools({ conversation, assistant: fakeAssistant, sink: makeSink().sink });
    for (const tool of tools) {
      const contribution = piPromptContributions[tool.name];
      expect(contribution).toBeDefined();
      expect(tool.promptSnippet).toBe(contribution!.snippet);
      const expectedGuidelines = tool.name === "bash" || contribution!.guidelines.length === 0 ? undefined : [...contribution!.guidelines];
      expect(tool.promptGuidelines).toEqual(expectedGuidelines);
    }
  });
});

describe("审批内化(execute 生命周期)", () => {
  test("balanced 档区内读:免审直执行(零审批事件)", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "auto-read" });
    writeFileSync(join(workspace.root, "hello.txt"), "hello from pi tools\n");
    const conversation = bindConversation(workspace.id);
    const log = makeSink();
    const tools = createPiWorkspaceTools({ conversation, assistant: fakeAssistant, sink: log.sink });
    const read = tools.find((tool) => tool.name === "read")!;
    const result = await execOf(read)("call-read-1", { path: "hello.txt" });
    expect(result.content[0]?.text ?? "").toContain("hello from pi tools");
    // 小文本读取本就无 details(与聊天引擎一致,不造假 metadata);
    // details.workspace 的还原往返由下方 bash 用例(exitCode)钉住。
    expect(result.details).toEqual({});
    expect(approvalEvents(log)).toEqual([]);
  });

  test("confirm_each 档 write:pending 挂卡 → 放行 → 落盘,事件序 pending→approved", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "gate-approve" });
    ws.updateWorkspace(workspace.id, { permissionPreset: "confirm_each" });
    const conversation = bindConversation(workspace.id);
    const log = makeSink();
    const tools = createPiWorkspaceTools({ conversation, assistant: fakeAssistant, sink: log.sink });
    const write = tools.find((tool) => tool.name === "write")!;
    const running = execOf(write)("call-write-1", { path: "made.txt", content: "approved!" });
    await waitUntil(() => approvalEvents(log).some((state) => state.type === "pending"));
    expect(pendingToolApprovalCount()).toBe(1);
    expect(resolveToolApproval(conversation.id, "call-write-1", { approved: true })).toBe(true);
    await running;
    expect(readFileSync(join(workspace.root, "made.txt"), "utf-8")).toBe("approved!");
    expect(approvalEvents(log).map((state) => state.type)).toEqual(["pending", "approved"]);
  });

  test("confirm_each 档 write:拒绝 → 历史契约文案抛错,文件未落盘,卡 denied", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "gate-deny" });
    ws.updateWorkspace(workspace.id, { permissionPreset: "confirm_each" });
    const conversation = bindConversation(workspace.id);
    const log = makeSink();
    const tools = createPiWorkspaceTools({ conversation, assistant: fakeAssistant, sink: log.sink });
    const write = tools.find((tool) => tool.name === "write")!;
    const running = execOf(write)("call-write-2", { path: "evil.txt", content: "nope" });
    await waitUntil(() => approvalEvents(log).some((state) => state.type === "pending"));
    expect(resolveToolApproval(conversation.id, "call-write-2", { approved: false, reason: "不允许" })).toBe(true);
    await expect(running).rejects.toThrow("Tool execution denied by user. Reason: 不允许");
    expect(existsSync(join(workspace.root, "evil.txt"))).toBe(false);
    const states = approvalEvents(log);
    expect(states.map((state) => state.type)).toEqual(["pending", "denied"]);
    expect(states[1]?.reason).toBe("不允许");
  });

  test("等待审批中生成被停止:AbortError 上抛,卡收敛 denied(绝不悬在 pending)", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "gate-abort" });
    ws.updateWorkspace(workspace.id, { permissionPreset: "confirm_each" });
    const conversation = bindConversation(workspace.id);
    const log = makeSink();
    const tools = createPiWorkspaceTools({ conversation, assistant: fakeAssistant, sink: log.sink });
    const write = tools.find((tool) => tool.name === "write")!;
    const controller = new AbortController();
    const running = execOf(write)("call-write-3", { path: "late.txt", content: "x" }, controller.signal);
    await waitUntil(() => approvalEvents(log).some((state) => state.type === "pending"));
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    const states = approvalEvents(log);
    expect(states.map((state) => state.type)).toEqual(["pending", "denied"]);
    expect(states[1]?.reason).toBe("Generation stopped before the approval decision");
    expect(pendingToolApprovalCount()).toBe(0);
  });

  test("balanced 档危险命令:pending 缘由带 Destructive 说明;拒绝后不执行", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "gate-danger" });
    const conversation = bindConversation(workspace.id);
    const log = makeSink();
    const tools = createPiWorkspaceTools({ conversation, assistant: fakeAssistant, sink: log.sink });
    const bash = tools.find((tool) => tool.name === "bash");
    if (!bash) return; // K3:本机无 bash 时挂载矩阵不含 bash,该路径由 approval 单测覆盖
    const running = execOf(bash)("call-bash-1", { command: "rm -rf /" });
    await waitUntil(() => approvalEvents(log).some((state) => state.type === "pending"));
    const pending = approvalEvents(log)[0]!;
    expect(pending.reason ?? "").toContain("Destructive command pattern");
    expect(resolveToolApproval(conversation.id, "call-bash-1", { approved: false, reason: "no" })).toBe(true);
    await expect(running).rejects.toThrow("Tool execution denied by user");
  });

  test("balanced 档 bash 普通命令:免审执行,exitCode 进 workspace details", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "auto-bash" });
    const conversation = bindConversation(workspace.id);
    const log = makeSink();
    const tools = createPiWorkspaceTools({ conversation, assistant: fakeAssistant, sink: log.sink });
    const bash = tools.find((tool) => tool.name === "bash");
    if (!bash) return; // K3 兜底矩阵机器跳过
    const result = await execOf(bash)("call-bash-2", { command: "echo pi-p3-ok" });
    expect(result.content[0]?.text ?? "").toContain("pi-p3-ok");
    const details = result.details as { workspace?: { tool?: string; details?: { exitCode?: number } } };
    expect(details.workspace?.tool).toBe("bash");
    expect(details.workspace?.details?.exitCode).toBe(0);
    expect(approvalEvents(log)).toEqual([]);
  });
});
