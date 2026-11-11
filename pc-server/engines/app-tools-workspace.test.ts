// engines/app-tools-workspace.test.ts — 工作区工具在应用侧的审批与执行(host.tools.call 的执行面)
//
// 审批内化(方案 §4.4):auto 直执行;pending 挂卡等决定(放行→userApproved 执行/
// 拒绝→历史契约文案抛错);中止时卡收敛 denied。pi 侧的包装与提示词镜像见
// pi-engine/app-tools.test.ts。
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-pitools-test-"));

const conversations = await import("../conversations");
const { configureWorkingSet } = await import("../conversations/working-set");
const { getConversationMeta } = await import("../conversations/read-queries");
const ws = await import("../workspace");
const { createAppToolCaller, workspaceToolSpecs } = await import("./app-tools");
const { resolveToolApproval, pendingToolApprovalCount } = await import("../inference-engine/approval-gate");
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

/** 本会话工作区工具的应用侧调用入口(生产 = host.tools.call 落到这里)。 */
function callerFor(conversation: ReturnType<typeof bindConversation>, log: SinkLog, signal?: AbortSignal) {
  const ctx = { conversation: conversation as never, assistant: fakeAssistant, sink: log.sink, signal };
  const specs = workspaceToolSpecs(conversation as never);
  const call = createAppToolCaller(ctx, specs);
  return { specs, call: (toolCallId: string, name: string, args: Record<string, unknown>) => call({ toolCallId, name, args: args as never }) };
}

describe("审批内化(应用侧调用生命周期)", () => {
  test("balanced 档区内读:免审直执行(零审批事件)", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "auto-read" });
    writeFileSync(join(workspace.root, "hello.txt"), "hello from pi tools\n");
    const conversation = bindConversation(workspace.id);
    const log = makeSink();
    const tools = callerFor(conversation, log);
    const result = await tools.call("call-read-1", "read", { path: "hello.txt" });
    const first = result.content[0];
    expect(first?.type === "text" ? first.text : "").toContain("hello from pi tools");
    // 小文本读取本就无 details(与聊天引擎一致,不造假 metadata);
    // 结构化细节的往返由下方 bash 用例(exitCode)钉住。
    expect(result.details).toBeUndefined();
    expect(approvalEvents(log)).toEqual([]);
  });

  test("confirm_each 档 write:pending 挂卡 → 放行 → 落盘,事件序 pending→approved", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "gate-approve" });
    ws.updateWorkspace(workspace.id, { permissionPreset: "confirm_each" });
    const conversation = bindConversation(workspace.id);
    const log = makeSink();
    const tools = callerFor(conversation, log);
    const running = tools.call("call-write-1", "write", { path: "made.txt", content: "approved!" });
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
    const tools = callerFor(conversation, log);
    const running = tools.call("call-write-2", "write", { path: "evil.txt", content: "nope" });
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
    const controller = new AbortController();
    const tools = callerFor(conversation, log, controller.signal);
    const running = tools.call("call-write-3", "write", { path: "late.txt", content: "x" });
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
    const tools = callerFor(conversation, log);
    if (!tools.specs.some((spec) => spec.name === "bash")) return; // K3:本机无 bash 时挂载矩阵不含 bash,该路径由 approval 单测覆盖
    const running = tools.call("call-bash-1", "bash", { command: "rm -rf /" });
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
    const tools = callerFor(conversation, log);
    if (!tools.specs.some((spec) => spec.name === "bash")) return; // K3 兜底矩阵机器跳过
    const result = await tools.call("call-bash-2", "bash", { command: "echo pi-p3-ok" });
    const first = result.content[0];
    expect(first?.type === "text" ? first.text : "").toContain("pi-p3-ok");
    expect(result.details?.tool).toBe("bash");
    expect(result.details?.details.exitCode).toBe(0);
    expect(approvalEvents(log)).toEqual([]);
  });
});
