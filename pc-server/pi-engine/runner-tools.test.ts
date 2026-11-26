// pi-engine/runner-tools.test.ts — runner × customTools × 审批门的全链路集成(P3)
//
// 与 workspace-tools.test.ts(工具 execute 单体生命周期)的分工:本文件跑真 pi 会话
// 循环——假 OpenAI SSE 回工具调用帧 → pi 执行我们的 customTools → 结果回灌上游 →
// 终局文本落 sink。核心断言三件事:
//   1) 工具产出真的进了下一轮上游请求(引擎循环闭合的硬证据);
//   2) 审批 pending 挂起时循环不散架,放行/拒绝后循环走到终局;
//   3) 等待审批中用户停止:prompt 正常返回(非 error),等待者零泄漏。
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-pirunner-tools-"));

const conversations = await import("../conversations");
const { configureWorkingSet } = await import("../conversations/working-set");
const { getConversationMeta } = await import("../conversations/read-queries");
const ws = await import("../workspace");
const { workspaceRuntimeForConversation } = await import("../workspace/runtime");
const { createPiWorkspaceTools } = await import("./workspace-tools");
const { resolveToolApproval, pendingToolApprovalCount } = await import("../inference-engine/approval-gate");
const { runPiGeneration } = await import("./runner");
const { model, provider } = await import("../model-providers");
const { startFakeOpenAiSse } = await import("../test-utils/fake-openai-sse");

import type { GenerationEvent } from "../inference-engine/events";
import type { FakeOpenAiSseServer, FakeSseTurn } from "../test-utils/fake-openai-sse";

const db = conversations.openConversationsDb();
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

const fakeAssistant = { id: "a1", name: "A", systemPrompt: "", mcpServers: [] } as never;

let seq = 0;
function bindWorkspaceConversation(preset?: "confirm_each") {
  seq += 1;
  const workspace = ws.createWorkspace({ type: "managed", name: `runner-tools-${seq}` });
  if (preset) ws.updateWorkspace(workspace.id, { permissionPreset: preset });
  const conversation = {
    id: `pirunner-conv-${seq}`,
    assistantId: "a1",
    systemPrompt: null,
    title: `t-${seq}`,
    messages: [],
    chatSuggestions: [],
    isPinned: false,
    createAt: 1000,
    updateAt: 2000,
    workspaceId: workspace.id,
    workspaceCwd: null,
  };
  conversations.persistConversation(conversation);
  return { workspace, conversation };
}

const servers: FakeOpenAiSseServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function scriptedRun(
  turns: FakeSseTurn[],
  conversation: { id: string },
  cwd: string,
  extras: { signal?: AbortSignal } = {},
) {
  const server = await startFakeOpenAiSse(turns);
  servers.push(server);
  const events: GenerationEvent[] = [];
  const sink = (event: GenerationEvent) => void events.push(event);
  const run = runPiGeneration({
    provider: provider({ id: crypto.randomUUID(), name: "Runner Tools Provider", baseUrl: server.baseUrl, apiKey: "sk-test" }),
    model: model("fake-model", "Runner Tools Model"),
    conversationId: conversation.id,
    cwd,
    history: [],
    promptText: "干活",
    tools: createPiWorkspaceTools({ conversation: conversation as never, assistant: fakeAssistant, sink }),
    sink,
    ...extras,
  });
  return { server, events, run };
}

function approvalStates(events: GenerationEvent[]): Array<{ type: string; reason?: string }> {
  return events
    .filter((event) => event.kind === "tool_approval_updated")
    .map((event) => (event as { approvalState: { type: string; reason?: string } }).approvalState);
}

async function waitUntil(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("pi runner × customTools 集成", () => {
  test("免审工具循环:read 产出回灌上游,终局文本落 sink", async () => {
    const { workspace, conversation } = bindWorkspaceConversation();
    writeFileSync(join(workspace.root, "hello.txt"), "runner-roundtrip-marker\n");
    const cwd = workspaceRuntimeForConversation(conversation as never)!.cwd;
    const { server, events, run } = await scriptedRun(
      [
        { toolCalls: [{ id: "tc-read-1", name: "read", arguments: JSON.stringify({ path: "hello.txt" }) }] },
        { content: "读完了", usage: { prompt_tokens: 40, completion_tokens: 6 } },
      ],
      conversation,
      cwd,
    );
    const result = await run;
    expect(result.text).toBe("读完了");
    // 工具循环闭合的硬证据:第二轮上游请求必须携带工具产出(文件内容标记)。
    expect(server.requests.length).toBe(2);
    expect(JSON.stringify(server.requests[1])).toContain("runner-roundtrip-marker");
    // 事件面:建卡(免审 auto)→ 工具结果 → 终局文本;全程零审批事件。
    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("tool_call_created");
    expect(kinds).toContain("tool_result");
    expect(approvalStates(events)).toEqual([]);
    const toolResult = events.find((event) => event.kind === "tool_result") as
      | { output: Array<{ type?: string; text?: string }> }
      | undefined;
    expect(JSON.stringify(toolResult?.output ?? [])).toContain("runner-roundtrip-marker");
  }, 30_000);

  test("审批放行:pending 挂起循环不散架,放行后落盘并走到终局", async () => {
    const { workspace, conversation } = bindWorkspaceConversation("confirm_each");
    const cwd = workspaceRuntimeForConversation(conversation as never)!.cwd;
    const { events, run } = await scriptedRun(
      [
        { toolCalls: [{ id: "tc-write-1", name: "write", arguments: JSON.stringify({ path: "made.txt", content: "approved-by-gate" }) }] },
        { content: "写好了" },
      ],
      conversation,
      cwd,
    );
    await waitUntil(() => approvalStates(events).some((state) => state.type === "pending"));
    expect(pendingToolApprovalCount()).toBe(1);
    expect(resolveToolApproval(conversation.id, "tc-write-1", { approved: true })).toBe(true);
    const result = await run;
    expect(result.text).toBe("写好了");
    expect(readFileSync(join(workspace.root, "made.txt"), "utf-8")).toBe("approved-by-gate");
    expect(approvalStates(events).map((state) => state.type)).toEqual(["pending", "approved"]);
    expect(pendingToolApprovalCount()).toBe(0);
  }, 30_000);

  test("审批拒绝:拒绝文案作为工具错误回灌上游,循环继续到终局,文件未落盘", async () => {
    const { workspace, conversation } = bindWorkspaceConversation("confirm_each");
    const cwd = workspaceRuntimeForConversation(conversation as never)!.cwd;
    const { server, events, run } = await scriptedRun(
      [
        { toolCalls: [{ id: "tc-write-2", name: "write", arguments: JSON.stringify({ path: "evil.txt", content: "nope" }) }] },
        { content: "好的,不写了" },
      ],
      conversation,
      cwd,
    );
    await waitUntil(() => approvalStates(events).some((state) => state.type === "pending"));
    expect(resolveToolApproval(conversation.id, "tc-write-2", { approved: false, reason: "危险" })).toBe(true);
    const result = await run;
    expect(result.text).toBe("好的,不写了");
    expect(existsSync(join(workspace.root, "evil.txt"))).toBe(false);
    // 拒绝进入模型视野:第二轮请求携带历史契约拒绝文案,模型据此改道。
    expect(JSON.stringify(server.requests[1])).toContain("Tool execution denied by user");
    expect(approvalStates(events).map((state) => state.type)).toEqual(["pending", "denied"]);
    // 事件面收到 {error} 裸载荷(与聊天引擎失败工具形状一致)。
    const errorResult = events.find(
      (event) => event.kind === "tool_result" && JSON.stringify((event as { output: unknown }).output).includes("denied"),
    );
    expect(errorResult).toBeDefined();
  }, 30_000);

  test("bash 增量输出全链路:执行中 partial 快照流进 sink,终局带 exitCode metadata", async () => {
    const { mountedWorkspaceToolNames } = await import("../workspace/runtime");
    if (!mountedWorkspaceToolNames().includes("bash")) return; // K3:无 bash 机器挂载矩阵不含 bash
    const { conversation } = bindWorkspaceConversation();
    const cwd = workspaceRuntimeForConversation(conversation as never)!.cwd;
    const { events, run } = await scriptedRun(
      [
        { toolCalls: [{ id: "tc-bash-1", name: "bash", arguments: JSON.stringify({ command: "echo first; sleep 0.5; echo second" }) }] },
        { content: "跑完了" },
      ],
      conversation,
      cwd,
    );
    const result = await run;
    expect(result.text).toBe("跑完了");
    const bashResults = events.filter(
      (event) => event.kind === "tool_result" && (event as { toolCallId: string }).toolCallId === "tc-bash-1",
    ) as Array<{ output: unknown }>;
    // 增量决策落地证据(P3 条目 3:沿用我们 accumulator,经 pi onUpdate →
    // tool_execution_update 通道回流):终局之前至少一次 partial 快照,且该快照
    // 只含前半段输出——证明是执行中回写,不是终局重放。
    expect(bashResults.length).toBeGreaterThanOrEqual(2);
    const partialTexts = bashResults.slice(0, -1).map((entry) => JSON.stringify(entry.output));
    expect(partialTexts.some((text) => text.includes("first") && !text.includes("second"))).toBe(true);
    const final = JSON.stringify(bashResults[bashResults.length - 1]!.output);
    expect(final).toContain("first");
    expect(final).toContain("second");
    expect(final).toContain("\"exitCode\":0");
  }, 30_000);

  test("等待审批中停止生成:prompt 正常返回(非 error 抛出),等待者零泄漏", async () => {
    const { workspace, conversation } = bindWorkspaceConversation("confirm_each");
    const cwd = workspaceRuntimeForConversation(conversation as never)!.cwd;
    const controller = new AbortController();
    const { events, run } = await scriptedRun(
      [{ toolCalls: [{ id: "tc-write-3", name: "write", arguments: JSON.stringify({ path: "late.txt", content: "x" }) }] }],
      conversation,
      cwd,
      { signal: controller.signal },
    );
    await waitUntil(() => approvalStates(events).some((state) => state.type === "pending"));
    controller.abort();
    // runner 契约:用户中止不抛(调用方 generateAnswer 按 signal.aborted 走中止收尾)。
    const result = await run;
    expect(typeof result.text).toBe("string");
    expect(existsSync(join(workspace.root, "late.txt"))).toBe(false);
    expect(approvalStates(events).map((state) => state.type)).toEqual(["pending", "denied"]);
    expect(pendingToolApprovalCount()).toBe(0);
  }, 30_000);
});
