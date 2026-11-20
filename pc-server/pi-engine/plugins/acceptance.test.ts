// pi-engine/plugins/acceptance.test.ts — P5a 验收(M1):真实插件 + 替身钩子经应用全链路
//
// 走生产装配:开发者字段 devPiPluginPaths → 编排器 generateAnswer → 回环(strict)→ pi 驱动 → 裁决层 /
// 界面桥 → 应用侧审批、对话框、错误中心、会话存储。四个插件每次都同时装上(与演示一致):
// ①待办(rpiv-todo):任务跨轮保留;清掉工作集、从库里重新装载(模拟重启)后仍在。插件在 session_shutdown
//   时丢掉自己的内存态、session_start 时从会话分支重放,所以状态只可能来自应用存下的私有条目;
// ②提问(rpiv-ask-user-question):rpc 模式下走 select 对话框;对话框出现在应用的界面状态里,经
//   /ui-response 回答后答案回到插件、进工具结果;
// ③权限(pi-permission-system,无配置 = 默认询问):它在 tool_call 里弹的对话框被吞掉、裁决作废——没有人
//   回答这一轮也能跑完,工具照常执行,错误中心有 pi_plugin_discarded;
// ④替身钩子:不弹窗的否决生效,工具卡与回给模型的结果都署插件 id,错误中心有 pi_plugin_vetoed。
// 真实插件的本地副本在 Reference-project(不进仓库);缺席时整组跳过并打提示。
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-plugin-acceptance-"));

const conversations = await import("../../conversations/index");
const { checkoutConversation, configureWorkingSet, registerConversation, releaseConversation, removeConversations } = await import("../../conversations/working-set");
const { getConversationMeta } = await import("../../conversations/read-queries");
const { generating } = await import("../../conversations/generation-state");
const { generateAnswer } = await import("../../conversations/orchestrator");
const { engineUiSnapshot } = await import("../../conversations/engine-interaction");
const { loadEngineEntries } = await import("../../conversations/engine-entries");
const ws = await import("../../workspace");
const { defaultAssistant } = await import("../../assistants");
const { defaultState } = await import("../../app-config/defaults");
const { setState, state } = await import("../../persistence/json-store");
const { model, provider } = await import("../../model-providers");
const { forgetSessionToolAllowances, pendingToolApprovalCount } = await import("../../inference-engine/approval-gate");
const { handleConversationRoutes } = await import("../../api/handlers/conversations");
const { clearAppErrors, recentAppErrors } = await import("../../observability/app-errors");
const { startFakeOpenAiSse } = await import("../../test-utils/fake-openai-sse");
const { useInProcessPiDriver } = await import("../../test-utils/in-process-pi");

import type { Conversation, State } from "../../foundation/types";
import type { FakeOpenAiSseServer, FakeSseTurn } from "../../test-utils/fake-openai-sse";

const pluginRoot = resolve(import.meta.dir, "../../../Reference-project/extensions/_lab/appdata/engines/pi/npm/node_modules");
const realPlugins = {
  todo: join(pluginRoot, "@juicesharp", "rpiv-todo"),
  ask: join(pluginRoot, "@juicesharp", "rpiv-ask-user-question"),
  permission: join(pluginRoot, "@gotgenes", "pi-permission-system"),
};
const realPluginsPresent = Object.values(realPlugins).every((path) => existsSync(join(path, "package.json")));
if (!realPluginsPresent) {
  console.warn(`\n[plugin-acceptance] 真实插件本地副本缺席,跳过 P5a 验收(期望位置:${pluginRoot})。\n`);
}

const lab = mkdtempSync(join(tmpdir(), "rkh-plugin-acceptance-lab-"));
const vetoPlugin = join(lab, "veto-guard.js");
writeFileSync(
  vetoPlugin,
  `export default function (pi) {
  pi.on("tool_call", async (event) => {
    if (event.toolName === "write" && String(event.input.path ?? "").includes("secret")) {
      return { block: true, reason: "secret files are off limits" };
    }
  });
}
`,
);

const priorState = state;
const db = conversations.openConversationsDb();
configureWorkingSet({
  loadConversation: (convId) => {
    const meta = getConversationMeta(db, convId);
    if (!meta) return undefined;
    meta.messages = conversations.loadConversationNodesFromDb(db, convId);
    return meta;
  },
  isGenerating: (id) => generating.has(id),
  hasSseClients: () => false,
  hasDirty: () => false,
});

const servers: FakeOpenAiSseServer[] = [];
const restorePiDriver = useInProcessPiDriver();
afterAll(async () => {
  restorePiDriver();
  setState(priorState);
  await Promise.all(servers.map((server) => server.close()));
});
const PLUGIN_IDS = {
  todo: "dev:rpiv-todo",
  ask: "dev:rpiv-ask-user-question",
  permission: "dev:pi-permission-system",
  veto: "dev:veto-guard",
};

/** 每个用例一个假上游 + 一份 state:四个插件经开发者字段装上,快速模型置空(不跑标题等后台请求)。 */
async function installUpstream(turns: FakeSseTurn[]) {
  const server = await startFakeOpenAiSse(turns);
  servers.push(server);
  const ourModel = model("fake-model", "Acceptance Model");
  const ourProvider = provider({ id: crypto.randomUUID(), name: "Acceptance", baseUrl: server.baseUrl, apiKey: "sk-test", enabled: true, models: [ourModel] });
  const next = defaultState();
  next.settings.assistantId = "a1";
  next.settings.assistants = [{ ...defaultAssistant(), id: "a1", name: "acceptance" }];
  next.settings.providers = [ourProvider];
  next.settings.chatModelId = ourModel.id;
  next.settings.fastModelId = "";
  next.settings.devPiPluginPaths = [realPlugins.todo, realPlugins.ask, realPlugins.permission, vetoPlugin];
  setState(next as State);
  return server;
}

let seq = 0;
function userMessage(text: string) {
  seq += 1;
  return {
    id: `acc-m-${seq}`,
    role: "USER",
    parts: [{ type: "text", text }],
    annotations: [],
    createdAt: new Date().toISOString(),
    finishedAt: null,
    translation: null,
  };
}

function seedConversation(workspaceId: string, text: string): Conversation {
  const now = Date.now();
  const conversation = {
    id: `acc-conv-${crypto.randomUUID()}`,
    assistantId: "a1",
    systemPrompt: null,
    title: "验收会话",
    messages: [{ id: `acc-n-${seq}`, selectIndex: 0, messages: [userMessage(text)] }],
    chatSuggestions: [],
    isPinned: false,
    createAt: now,
    updateAt: now,
    workspaceId,
  } as unknown as Conversation;
  conversations.persistConversation(conversation);
  registerConversation(conversation);
  return conversation;
}

function appendUser(conversation: Conversation, text: string): void {
  conversation.messages.push({ id: `acc-n-${seq}-${conversation.messages.length}`, selectIndex: 0, messages: [userMessage(text)] } as never);
}

type ToolPartView = { type: "tool"; toolCallId: string; toolName: string; output?: unknown; approvalState?: { type?: string } };
function toolPart(conversation: Conversation, toolCallId: string): ToolPartView | undefined {
  for (const node of conversation.messages) {
    for (const msg of node.messages) {
      const found = (msg.parts as unknown as ToolPartView[]).find((part) => part?.type === "tool" && part.toolCallId === toolCallId);
      if (found) return found;
    }
  }
  return undefined;
}
const outputText = (part: ToolPartView | undefined) =>
  ((part?.output as Array<{ text?: string; error?: string }> | undefined) ?? []).map((item) => item.text ?? item.error ?? "").join("\n");

async function post(conversationId: string, sub: string, body: unknown) {
  const url = new URL(`http://localhost/api/conversations/${conversationId}/${sub}`);
  const response = await handleConversationRoutes(
    new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    url,
    `conversations/${conversationId}/${sub}`,
  );
  return response!.status;
}

async function waitUntil(cond: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 插件工具默认询问:等审批卡挂起,批准。 */
async function approvePluginTool(conversationId: string, toolCallId: string, alwaysAllowInSession = false) {
  await waitUntil(() => pendingToolApprovalCount() === 1);
  expect(await post(conversationId, "tool-approval", { toolCallId, approved: true, alwaysAllowInSession })).toBe(202);
}

const audits = (code: string) =>
  recentAppErrors()
    .filter((entry) => entry.code === code)
    .map((entry) => `${entry.params?.plugin} ${entry.params?.subject}${entry.params?.detail ? ` ${entry.params.detail}` : ""} ×${entry.count}`);
/** 插件加载失败、处理函数抛错、对话框失败(只看插件的码:同进程里别的测试会留下与本组无关的诊断)。 */
const pluginFailures = () => recentAppErrors().filter((entry) => entry.code?.startsWith("pi_plugin_") && entry.severity !== "info");

describe.skipIf(!realPluginsPresent)("P5a 验收:四个插件同时装上", () => {
  test("待办:任务跨轮保留;清掉内存、从库里重新装载(模拟重启)后仍在", async () => {
    clearAppErrors();
    const create = { action: "create", subject: "写验收报告" };
    const server = await installUpstream([
      { toolCalls: [{ id: "tc-todo-1", name: "todo", arguments: JSON.stringify(create) }] },
      { content: "建好了" },
      { toolCalls: [{ id: "tc-todo-2", name: "todo", arguments: JSON.stringify({ action: "list" }) }] },
      { content: "还在" },
      { toolCalls: [{ id: "tc-todo-3", name: "todo", arguments: JSON.stringify({ action: "list" }) }] },
      { content: "重启后也在" },
    ]);
    const workspace = ws.createWorkspace({ type: "managed", name: "acc-todo" });
    const conversation = seedConversation(workspace.id, "记个待办");

    const first = generateAnswer(conversation);
    await approvePluginTool(conversation.id, "tc-todo-1", true);
    await first;
    expect(outputText(toolPart(conversation, "tc-todo-1"))).toBe("Created #1: 写验收报告 (pending)");
    const declared = (server.requests[0]!.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
    expect(declared).toEqual(expect.arrayContaining(["todo", "ask_user_question"]));
    const stored = loadEngineEntries(db, conversation.id, "pi").flatMap((group) => group.entries.map((entry) => entry.payload as { type: string; customType?: string }));
    expect(stored).toContainEqual(expect.objectContaining({ type: "custom", customType: "rpiv-todo-state" }));

    // 第二轮:同会话「总是允许」生效不再挂卡;插件从应用交回的会话分支重放出任务。
    appendUser(conversation, "看看待办");
    await generateAnswer(conversation);
    expect(outputText(toolPart(conversation, "tc-todo-2"))).toBe("[pending] #1 写验收报告");

    // 模拟重启:会话级免问与工作集都是内存态,清掉;会话从库里重新装载。
    conversations.flushConvDirtyNow();
    forgetSessionToolAllowances(conversation.id);
    removeConversations([conversation.id]);
    const reloaded = checkoutConversation(conversation.id)!;
    releaseConversation(conversation.id);
    expect(reloaded).not.toBe(conversation);
    appendUser(reloaded, "重启后再看看");
    const third = generateAnswer(reloaded);
    await approvePluginTool(reloaded.id, "tc-todo-3");
    await third;
    expect(outputText(toolPart(reloaded, "tc-todo-3"))).toBe("[pending] #1 写验收报告");
    expect(pluginFailures()).toEqual([]);
  }, 60_000);

  test("提问:对话框出现在应用里(署插件 id),经 /ui-response 回答后答案回到插件、交给模型", async () => {
    clearAppErrors();
    const questions = [{ question: "用哪个方案?", header: "方案", options: [{ label: "甲", description: "稳妥" }, { label: "乙", description: "激进" }] }];
    const server = await installUpstream([
      { toolCalls: [{ id: "tc-ask-1", name: "ask_user_question", arguments: JSON.stringify({ questions }) }] },
      { content: "那就乙" },
    ]);
    const workspace = ws.createWorkspace({ type: "managed", name: "acc-ask" });
    const conversation = seedConversation(workspace.id, "问我一下");

    const run = generateAnswer(conversation);
    await approvePluginTool(conversation.id, "tc-ask-1");
    await waitUntil(() => (engineUiSnapshot(conversation.id)?.dialogs.length ?? 0) === 1);
    const dialog = engineUiSnapshot(conversation.id)!.dialogs[0]!;
    expect(dialog.source).toBe(PLUGIN_IDS.ask);
    expect(dialog.request.kind).toBe("select");
    const request = dialog.request as { kind: "select"; title: string; options: string[] };
    expect(request.title).toContain("用哪个方案?");
    expect(request.options[1]).toStartWith("2. 乙");
    expect(await post(conversation.id, "ui-response", { requestId: dialog.requestId, value: request.options[1] })).toBe(202);
    await run;

    expect(outputText(toolPart(conversation, "tc-ask-1"))).toContain('"用哪个方案?"="乙"');
    expect(JSON.stringify(server.requests[1]!.messages)).toContain('\\"用哪个方案?\\"=\\"乙\\"');
    expect(engineUiSnapshot(conversation.id)).toBeNull();
    expect(pendingToolApprovalCount()).toBe(0);
  }, 60_000);
  test("权限 + 替身钩子:权限插件的询问被吞、裁决作废,写入照常;替身不弹窗的否决生效并署名", async () => {
    clearAppErrors();
    const server = await installUpstream([
      { toolCalls: [{ id: "tc-w-ok", name: "write", arguments: JSON.stringify({ path: "notes.txt", content: "ok" }) }] },
      { toolCalls: [{ id: "tc-w-secret", name: "write", arguments: JSON.stringify({ path: "secret.txt", content: "nope" }) }] },
      { content: "写完了" },
    ]);
    const workspace = ws.createWorkspace({ type: "managed", name: "acc-guard" });
    const conversation = seedConversation(workspace.id, "写两个文件");

    // 没有人回答任何东西:插件的对话框若到了应用,这一轮会一直等下去。
    await generateAnswer(conversation);
    expect(readFileSync(join(workspace.root, "notes.txt"), "utf-8")).toBe("ok");
    expect(existsSync(join(workspace.root, "secret.txt"))).toBe(false);
    const blocked = `Blocked by plugin "${PLUGIN_IDS.veto}": secret files are off limits`;
    expect(outputText(toolPart(conversation, "tc-w-secret"))).toBe(blocked);
    expect(JSON.stringify(server.requests[2]!.messages)).toContain(blocked.replaceAll('"', '\\"'));
    expect(engineUiSnapshot(conversation.id)).toBeNull();
    expect(pendingToolApprovalCount()).toBe(0);

    // 两次写入各被权限插件询问一次(错误中心把同码同参数的记录合并计数)。
    expect(audits("pi_plugin_discarded")).toEqual([`${PLUGIN_IDS.permission} write ×2`]);
    expect(audits("pi_plugin_vetoed")).toEqual([`${PLUGIN_IDS.veto} write secret files are off limits ×1`]);
    expect(pluginFailures()).toEqual([]);
  }, 60_000);
});
