// pi-engine/plugins/ui-bridge.test.ts — 插件界面上下文 → host.interaction(P5.5)
//
// 锁定(真 pi 驱动经 strict 回环 + 假供应商):①绑了界面通道的会话里 ctx.hasUI 为真、mode 为 "rpc",
// 主题可读;②插件工具执行中的 select / confirm / input 经 host.interaction.dialog 到达宿主,来源 = 插件 id,
// 答案原样回到插件;取消按 pi 无界面时的默认值回答;③插件给的超时到了按取消回答并经 dismiss 让应用收起;
// ④notify / setStatus / setWidget(字符串数组)/ setWorkingMessage 经 host.interaction.show 送达(纯文本,
// 工厂形态落空);⑤tool_call 处理期间的对话框仍被吞掉、该次裁决作废(不到达宿主);⑥应用侧:对话框经
// POST /ui-response 回答,中止 / 收尾按取消;解绑后迟到的对话框按取消回答。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-pi-ui-bridge-"));

const { connectDriver, connectHost } = await import("../../engines/loopback");
const { appEngineHost, bindEngineTurn } = await import("../../engines/host");
const { modelGrantFor } = await import("../../engines/model-grant");
const { model, provider } = await import("../../model-providers");
const { startFakeOpenAiSse } = await import("../../test-utils/fake-openai-sse");
const { createPiDriver } = await import("../driver");
const { createEngineInteraction, engineUiSnapshot, pendingEngineDialogKind } = await import("../../conversations/engine-interaction");
const { clearToolApprovalWaiters, pendingToolApprovalCount } = await import("../../inference-engine/approval-gate");
const { handleConversationRoutes } = await import("../../api/handlers/conversations");
const { configureWorkingSet, registerConversation } = await import("../../conversations/working-set");

import type {
  EngineDialogAnswer,
  EngineDialogCall,
  EngineDialogDismiss,
  EngineHost,
  EngineUiNoticeCall,
  TurnInput,
} from "../../engines/contract";
import type { Conversation } from "../../foundation/types";
import type { GenerationEvent } from "../../inference-engine/events";
import type { FakeOpenAiSseServer, FakeSseTurn } from "../../test-utils/fake-openai-sse";

const servers: FakeOpenAiSseServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

const lab = mkdtempSync(join(tmpdir(), "rkh-pi-ui-bridge-lab-"));
const cwd = join(lab, "ws");
mkdirSync(cwd, { recursive: true });
const skillsDir = join(lab, "skills");
mkdirSync(skillsDir, { recursive: true });
const instructions = { appendSystemPrompt: [], globalAgentsFile: null, skills: { dir: skillsDir, enabled: [] } };

// 插件:session_start 记下界面能力;工具 ask 依次弹 select / confirm / input(带超时)并把答案回给模型;
// 工具执行与 tool_call 钩子里各发一批瞬态界面;guarded 工具的 tool_call 钩子弹窗(应被吞掉)。
const pluginFile = join(lab, "asker.js");
writeFileSync(
  pluginFile,
  `const seen = (globalThis.__rkhUiBridge ??= {});
export default function (pi) {
  pi.on("session_start", (_event, ctx) => {
    seen.hasUI = ctx.hasUI;
    seen.mode = ctx.mode;
    seen.themed = ctx.ui.theme.fg("accent", "x") + ctx.ui.theme.bold("y");
    seen.cachedUi = ctx.ui;
  });
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "guarded") return;
    // 用 session_start 时缓存的会话级界面(不是处理函数拿到的 ctx.ui),兜底守卫同样要吞掉。
    const ok = await seen.cachedUi.confirm("hook asks", "allow?");
    seen.hookAnswer = ok;
    return { block: true, reason: "should be discarded" };
  });
  pi.registerTool({
    name: "ask",
    label: "ask",
    description: "ask the user",
    parameters: { type: "object", properties: {} },
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      ctx.ui.notify("\\u001b[31mhello\\u001b[0m", "warning");
      ctx.ui.setStatus("perm", "mode: ask");
      ctx.ui.setWidget("todo", ["- [ ] one", "- [x] two"]);
      ctx.ui.setWidget("fancy", () => ({ render: () => [] }));
      ctx.ui.setWorkingMessage("thinking hard");
      const pick = await ctx.ui.select("pick one", ["a", "b"]);
      const sure = await ctx.ui.confirm("sure?", "really");
      const typed = await ctx.ui.input("type", "placeholder", { timeout: seen.inputTimeout });
      ctx.ui.setStatus("perm", undefined);
      return { content: [{ type: "text", text: JSON.stringify({ pick, sure, typed: typed ?? null }) }] };
    },
  });
  pi.registerTool({
    name: "guarded",
    label: "guarded",
    description: "a tool whose hook prompts",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "guarded ran" }] };
    },
  });
}
`,
);
// 第二个插件什么都不登记:装了两个插件时,署名只能来自裁决层的作用域(不能靠「只有一个插件」兜底)。
const idlePlugin = join(lab, "idle.js");
writeFileSync(idlePlugin, "export default function () {}\n");
const plugins = [
  { id: "dev:asker", path: pluginFile },
  { id: "dev:idle", path: idlePlugin },
];
const seen = () => ((globalThis as Record<string, unknown>).__rkhUiBridge ??= {}) as Record<string, unknown>;

async function upstream(turns: FakeSseTurn[]) {
  const server = await startFakeOpenAiSse(turns);
  servers.push(server);
  return server;
}

function inputFor(server: FakeOpenAiSseServer, conversationId: string): TurnInput {
  return {
    model: modelGrantFor(provider({ id: crypto.randomUUID(), name: "UI Bridge", baseUrl: server.baseUrl, apiKey: "sk-test" }), model("fake-model", "Fake"), null, conversationId)!,
    reasoningLevel: null,
    workspace: { cwd, root: cwd },
    instructions,
    plugins,
    prompt: { text: "问我", images: [] },
    tools: [],
  };
}

const toolTurns = (id: string, name: string, reply: string): FakeSseTurn[] => [
  { toolCalls: [{ id, name, arguments: "{}" }] },
  { content: reply },
];

/** 引擎侧宿主:插件工具审批直接放行;界面请求交给 answer 决定。 */
function harness(answer: (call: EngineDialogCall) => Promise<EngineDialogAnswer>) {
  const dialogs: EngineDialogCall[] = [];
  const dismissed: EngineDialogDismiss[] = [];
  const notices: EngineUiNoticeCall[] = [];
  const events: GenerationEvent[] = [];
  const host: EngineHost = {
    emit: (_turn, event) => void events.push(event),
    session: { load: async () => ({ items: [], compactions: [] }), append: async () => undefined },
    tools: {
      call: async () => {
        throw new Error("本测试没有应用工具");
      },
    },
    permission: { check: async () => undefined },
    interaction: {
      dialog: (call) => {
        dialogs.push(call);
        return answer(call);
      },
      dismiss: (call) => void dismissed.push(call),
      show: (call) => void notices.push(call),
    },
    steer: { take: async () => [] },
    models: { credential: async () => ({}), log: () => undefined },
    report: () => undefined,
  };
  const driver = connectDriver(createPiDriver(connectHost(host, { strict: true })), { strict: true });
  return { driver, dialogs, dismissed, notices, events };
}

const toolOutput = (events: GenerationEvent[]): unknown => {
  const output = (events.filter((event) => event.kind === "tool_result").at(-1) as { output?: Array<{ text?: string }> } | undefined)?.output;
  return JSON.parse(output?.[0]?.text ?? "null");
};

describe("插件界面桥(引擎侧)", () => {
  test("hasUI / rpc / 主题可读;对话框到达宿主带插件来源,答案回到插件;瞬态界面纯文本送达", async () => {
    seen().inputTimeout = undefined;
    const answers: Record<string, EngineDialogAnswer> = {
      select: { cancelled: false, value: "b" },
      confirm: { cancelled: false, value: true },
      input: { cancelled: false, value: "typed text" },
    };
    const server = await upstream(toolTurns("tc-ask-1", "ask", "问完了"));
    const { driver, dialogs, notices, events } = harness(async (call) => answers[call.request.kind]!);
    const turn = { conversationId: "conv-ui-1", turnId: "turn-ui-1" };
    expect((await driver.startTurn({ ...turn, input: inputFor(server, turn.conversationId) })).text).toBe("问完了");

    expect(seen().hasUI).toBe(true);
    expect(seen().mode).toBe("rpc");
    expect(seen().themed).toBe("xy");
    expect(dialogs.map(({ requestId: _id, ...rest }) => rest)).toEqual([
      { ...turn, source: "dev:asker", request: { kind: "select", title: "pick one", options: ["a", "b"] } },
      { ...turn, source: "dev:asker", request: { kind: "confirm", title: "sure?", message: "really" } },
      { ...turn, source: "dev:asker", request: { kind: "input", title: "type", placeholder: "placeholder" } },
    ]);
    expect(new Set(dialogs.map((call) => call.requestId)).size).toBe(3);
    expect(toolOutput(events)).toEqual({ pick: "b", sure: true, typed: "typed text" });
    expect(notices).toEqual([
      { ...turn, source: "dev:asker", notice: { kind: "notify", message: "hello", level: "warning" } },
      { ...turn, source: "dev:asker", notice: { kind: "status", key: "perm", text: "mode: ask" } },
      { ...turn, source: "dev:asker", notice: { kind: "widget", key: "todo", lines: ["- [ ] one", "- [x] two"] } },
      { ...turn, source: "dev:asker", notice: { kind: "working", text: "thinking hard" } },
      { ...turn, source: "dev:asker", notice: { kind: "status", key: "perm", text: null } },
    ]);
  }, 30_000);

  test("取消按 pi 无界面时的默认值回答;插件给的超时到了按取消回答并 dismiss", async () => {
    seen().inputTimeout = 50;
    const server = await upstream(toolTurns("tc-ask-2", "ask", "都取消了"));
    // select / confirm 立即取消;input 永不回答,靠插件的 50ms 超时收场。
    const { driver, dialogs, dismissed, events } = harness((call) =>
      call.request.kind === "input" ? new Promise(() => {}) : Promise.resolve({ cancelled: true }),
    );
    const turn = { conversationId: "conv-ui-2", turnId: "turn-ui-2" };
    expect((await driver.startTurn({ ...turn, input: inputFor(server, turn.conversationId) })).text).toBe("都取消了");
    // select 取消 = undefined(JSON 里不出现),confirm 取消 = false。
    expect(toolOutput(events)).toEqual({ sure: false, typed: null });
    const inputCall = dialogs.find((call) => call.request.kind === "input")!;
    expect(dismissed).toEqual([{ ...turn, requestId: inputCall.requestId }]);
  }, 30_000);

  test("tool_call 处理期间的对话框不到达宿主,该次裁决作废(工具照常执行)", async () => {
    delete seen().hookAnswer;
    const server = await upstream(toolTurns("tc-guarded", "guarded", "执行了"));
    const { driver, dialogs, events } = harness(async () => ({ cancelled: false, value: true }));
    const turn = { conversationId: "conv-ui-3", turnId: "turn-ui-3" };
    expect((await driver.startTurn({ ...turn, input: inputFor(server, turn.conversationId) })).text).toBe("执行了");
    expect(dialogs).toEqual([]);
    expect(seen().hookAnswer).toBe(false);
    expect(events.find((event) => event.kind === "tool_result")).toMatchObject({ output: [{ type: "text", text: "guarded ran" }] });
  }, 30_000);
});

describe("插件界面(应用侧)", () => {
  const conversationId = "conv-ui-app";
  const turn = { conversationId, turnId: "turn-ui-app" };
  const statusEvents: unknown[] = [];
  const sink = (event: GenerationEvent) => {
    if (event.kind === "engine_status") statusEvents.push(event.status);
  };
  configureWorkingSet({ loadConversation: () => undefined, isGenerating: () => false, hasSseClients: () => false, hasDirty: () => false });
  registerConversation({ id: conversationId, assistantId: "a", messages: [] } as unknown as Conversation);

  async function respond(body: unknown) {
    const url = new URL(`http://localhost/api/conversations/${conversationId}/ui-response`);
    const response = await handleConversationRoutes(
      new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      url,
      `conversations/${conversationId}/ui-response`,
    );
    return response!.status;
  }

  const dialogCall = (requestId: string, request: EngineDialogCall["request"]): EngineDialogCall => ({ ...turn, requestId, source: "dev:asker", request });

  test("对话框经 /ui-response 回答;类型不符 400、查不到 404;等待期间进「等待用户」状态;瞬态状态进补发快照", async () => {
    const session = createEngineInteraction(conversationId, sink);
    const unbind = bindEngineTurn(turn, { sink, interaction: session.interaction, providers: [] });
    try {
      const pending = appEngineHost.interaction.dialog(dialogCall("rq-1", { kind: "confirm", title: "继续吗", message: "?" }));
      expect(pendingEngineDialogKind(conversationId, "rq-1")).toBe("confirm");
      expect(statusEvents.at(-1)).toMatchObject({ busy: true, phase: "awaiting_approval", summary: "继续吗" });
      appEngineHost.interaction.show({ ...turn, source: "dev:asker", notice: { kind: "status", key: "k", text: "状态" } });
      expect(engineUiSnapshot(conversationId)).toMatchObject({
        dialogs: [{ requestId: "rq-1", source: "dev:asker", request: { kind: "confirm" } }],
        statuses: [{ source: "dev:asker", key: "k", text: "状态" }],
      });
      expect(await respond({ requestId: "rq-1", value: "yes" })).toBe(400);
      expect(await respond({ requestId: "rq-x", value: true })).toBe(404);
      expect(await respond({ requestId: "rq-1", value: true })).toBe(202);
      expect(await pending).toEqual({ cancelled: false, value: true });
      expect(statusEvents.at(-1)).toEqual({ busy: false });
      expect(engineUiSnapshot(conversationId)?.dialogs).toEqual([]);

      const typed = appEngineHost.interaction.dialog(dialogCall("rq-2", { kind: "input", title: "输入" }));
      expect(await respond({ requestId: "rq-2", cancelled: true })).toBe(202);
      expect(await typed).toEqual({ cancelled: true });
    } finally {
      unbind();
      session.close();
    }
    expect(engineUiSnapshot(conversationId)).toBeNull();
    expect(pendingToolApprovalCount()).toBe(0);
  });

  test("dismiss / 中止 / 收尾清扫 / close 都按取消收场;解绑后迟到的对话框按取消回答、通知丢弃", async () => {
    const controller = new AbortController();
    const session = createEngineInteraction(conversationId, sink, controller.signal);
    const unbind = bindEngineTurn(turn, { sink, interaction: session.interaction, providers: [] });
    const dismissedOne = appEngineHost.interaction.dialog(dialogCall("rq-3", { kind: "select", title: "选", options: ["a"] }));
    appEngineHost.interaction.dismiss({ ...turn, requestId: "rq-3" });
    expect(await dismissedOne).toEqual({ cancelled: true });
    const aborted = appEngineHost.interaction.dialog(dialogCall("rq-4", { kind: "select", title: "选", options: ["a"] }));
    controller.abort();
    expect(await aborted).toEqual({ cancelled: true });
    unbind();
    session.close();

    const second = createEngineInteraction(conversationId, sink);
    const unbindSecond = bindEngineTurn(turn, { sink, interaction: second.interaction, providers: [] });
    const swept = appEngineHost.interaction.dialog(dialogCall("rq-5", { kind: "confirm", title: "确认", message: "" }));
    clearToolApprovalWaiters(conversationId);
    expect(await swept).toEqual({ cancelled: true });
    const closedOne = appEngineHost.interaction.dialog(dialogCall("rq-6", { kind: "confirm", title: "确认", message: "" }));
    second.close();
    expect(await closedOne).toEqual({ cancelled: true });
    unbindSecond();

    expect(await appEngineHost.interaction.dialog(dialogCall("rq-7", { kind: "input", title: "迟到" }))).toEqual({ cancelled: true });
    appEngineHost.interaction.show({ ...turn, source: "dev:asker", notice: { kind: "status", key: "k", text: "迟到" } });
    expect(engineUiSnapshot(conversationId)).toBeNull();
    expect(pendingToolApprovalCount()).toBe(0);
  });
});
