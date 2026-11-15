// pi-engine/plugins/commands.test.ts — 插件指令的列举与执行(P5.7,方案 §5.9)
//
// 锁定(真 pi 驱动经 strict 回环 + 假供应商):①没有活会话时单独加载插件列出指令(入口类同名的已被裁决层拿掉,
// 能力类同名的留着),有活会话时读它的登记表(含 session_start 里补登记的);②执行在长驻会话上调插件的处理函数,
// 零模型请求,插件内存态跨「轮次 → 指令 → 轮次」保留,处理函数里的对话框经 host.interaction 到达、署插件 id;
// ③处理函数里 sendMessage({triggerTurn}) 变成开轮请求(指令执行在应用的轮次之外);④会话管理动作一律按取消回答
// 并记审计;⑤ctx.compact() 等压缩做完再返回,压缩记录随结果交回、原生条目经 session.append 交回;⑥处理函数抛错以
// 错误拒绝,署插件 id;指令已不存在时同样拒绝。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-pi-plugin-commands-"));

const { connectDriver, connectHost } = await import("../../engines/loopback");
const { modelGrantFor } = await import("../../engines/model-grant");
const { model, provider } = await import("../../model-providers");
const { message } = await import("../../foundation/utils");
const { sessionViewOf } = await import("../../test-utils/engine-session-view");
const { startFakeOpenAiSse } = await import("../../test-utils/fake-openai-sse");
const { createPiDriver } = await import("../driver");
const { piCommandId } = await import("./commands");

import type {
  EngineDialogCall,
  EngineEntryInput,
  EngineErrorReport,
  EngineHost,
  EngineSessionView,
  EngineTurnRequest,
  TurnInput,
} from "../../engines/contract";
import type { FakeOpenAiSseServer, FakeSseTurn } from "../../test-utils/fake-openai-sse";

const servers: FakeOpenAiSseServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

const lab = mkdtempSync(join(tmpdir(), "rkh-pi-plugin-commands-lab-"));
const cwd = join(lab, "ws");
mkdirSync(cwd, { recursive: true });
const skillsDir = join(lab, "skills");
mkdirSync(skillsDir, { recursive: true });
const instructions = { appendSystemPrompt: [], globalAgentsFile: null, skills: { dir: skillsDir, enabled: [] } };

// 替身插件:登记能力类同名(compact)、入口类同名(model)、自有指令;处理函数把会话管理动作的回答、对话框答案、
// 内存计数写进全局日志;session_start 里补登记一条。
const pluginFile = join(lab, "todo.js");
writeFileSync(
  pluginFile,
  `const log = (globalThis.__rkhCommandLog ??= []);
export default function (pi) {
  let count = 0;
  pi.registerCommand("todos", {
    description: "list todos",
    handler: async (args, ctx) => {
      count += 1;
      log.push({ todos: args, count, idle: ctx.isIdle() });
    },
  });
  pi.registerCommand("model", { handler: async () => {} });
  pi.registerCommand("compact", {
    description: "compact by todos",
    handler: async (args, ctx) => {
      ctx.compact({ customInstructions: "keep todos " + args });
    },
  });
  pi.registerCommand("ask", {
    handler: async (_args, ctx) => {
      const pick = await ctx.ui.select("pick", ["x", "y"]);
      const forked = await ctx.fork("anything");
      const fresh = await ctx.newSession();
      log.push({ pick, forked: forked.cancelled, fresh: fresh.cancelled });
    },
  });
  pi.registerCommand("again", {
    handler: async () => {
      pi.sendMessage({ customType: "todo-nudge", content: "继续处理待办", display: true }, { triggerTurn: true });
    },
  });
  pi.registerCommand("boom", {
    handler: async () => {
      throw new Error("kaboom");
    },
  });
  pi.on("session_start", async () => {
    pi.registerCommand("late", { handler: async () => { log.push({ late: true }); } });
  });
}
`,
);
const plugins = [{ id: "dev:todo", path: pluginFile }];
const commandLog = (): Array<Record<string, unknown>> => ((globalThis as Record<string, unknown>).__rkhCommandLog ??= []) as Array<Record<string, unknown>>;

async function upstream(turns: FakeSseTurn[]) {
  const server = await startFakeOpenAiSse(turns);
  servers.push(server);
  return server;
}

const providerIds = new Map<string, string>();

/** 同一会话每次给同一份授权(授权进配置键,变了长驻会话就重建)。 */
function inputFor(server: FakeOpenAiSseServer, conversationId: string, prompt = ""): TurnInput {
  let providerId = providerIds.get(conversationId);
  if (!providerId) providerIds.set(conversationId, (providerId = crypto.randomUUID()));
  return {
    model: modelGrantFor(provider({ id: providerId, name: "Commands", baseUrl: server.baseUrl, apiKey: "sk-test" }), model("fake-model", "Fake"), null, conversationId)!,
    reasoningLevel: null,
    workspace: { cwd, root: cwd },
    instructions,
    plugins,
    prompt: { text: prompt, images: [] },
    tools: [],
  };
}

function harness(views: () => EngineSessionView) {
  const dialogs: EngineDialogCall[] = [];
  const appended: EngineEntryInput[] = [];
  const turnRequests: EngineTurnRequest[] = [];
  const reports: EngineErrorReport[] = [];
  const host: EngineHost = {
    emit: () => undefined,
    session: { load: async () => views(), append: async (_turn, entries) => void appended.push(...entries) },
    tools: {
      call: async () => {
        throw new Error("本测试没有应用工具");
      },
    },
    permission: { check: async () => ({ scope: "default" }) },
    interaction: {
      dialog: async (call) => {
        dialogs.push(call);
        return { cancelled: false, value: "y" };
      },
      dismiss: () => undefined,
      show: () => undefined,
    },
    steer: { take: async () => [] },
    turn: { request: (req) => void turnRequests.push(req) },
    models: { credential: async () => ({}), log: () => undefined },
    report: (report) => void reports.push(report),
  };
  const driver = connectDriver(createPiDriver(connectHost(host, { strict: true })), { strict: true });
  return { driver, dialogs, appended, turnRequests, reports };
}

const summary = (commands: Array<{ name: string; source: string; description?: string }>) =>
  commands.map((command) => `${command.source} ${command.name}${command.description ? ` (${command.description})` : ""}`);

const auditSubjects = (reports: EngineErrorReport[]) =>
  reports.filter((report) => report.code?.startsWith("pi_plugin_")).map((report) => `${report.code} ${report.params?.subject}`);

describe("插件指令", () => {
  test("列举(无活会话 → 单独加载;有活会话 → 读登记表)、执行零模型请求且内存态跨轮保留、对话框署名、会话管理动作取消", async () => {
    const conversationId = "6b1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    commandLog().length = 0;
    let view = sessionViewOf([]);
    const { driver, dialogs, turnRequests, reports } = harness(() => view);
    expect(driver.capabilities.commands).toBe(true);

    // 没有活会话:单独加载插件。入口类同名的 model 被裁决层拿掉;能力类同名的 compact 留着;
    // session_start 里补登记的 late 此时还看不到(没发 session_start)。
    const cold = await driver.listCommands!({ conversationId, plugins, workspace: { cwd, root: cwd } });
    expect(summary(cold)).toEqual([
      "plugin:dev:todo todos (list todos)",
      "plugin:dev:todo compact (compact by todos)",
      "plugin:dev:todo ask",
      "plugin:dev:todo again",
      "plugin:dev:todo boom",
    ]);
    expect(cold[0]!.id).toBe(piCommandId("dev:todo", "todos"));

    // 先跑一轮,留下长驻会话。
    const server = await upstream([{ content: "答1" }, { content: "答2" }]);
    const u1 = message("USER", [{ type: "text", text: "问1" }]);
    expect((await driver.startTurn({ conversationId, turnId: "t1", input: inputFor(server, conversationId, "问1") })).text).toBe("答1");
    const a1 = message("ASSISTANT", [{ type: "text", text: "答1" }], "fake-model");
    view = sessionViewOf([u1, a1]);

    const warm = await driver.listCommands!({ conversationId, plugins, workspace: { cwd, root: cwd } });
    expect(warm.map((command) => command.name)).toContain("late");

    // 执行:在同一个长驻会话上(插件内存计数延续),零模型请求。
    const run = (commandId: string, args = "") =>
      driver.runCommand!({ conversationId, turnId: crypto.randomUUID(), input: inputFor(server, conversationId), commandId, args });
    await run(piCommandId("dev:todo", "todos"), "本周");
    await run(piCommandId("dev:todo", "todos"));
    await run(piCommandId("dev:todo", "late"));
    expect(commandLog()).toEqual([
      { todos: "本周", count: 1, idle: true },
      { todos: "", count: 2, idle: true },
      { late: true },
    ]);
    expect(server.requests).toHaveLength(1);

    // 对话框经宿主、署插件 id;fork / newSession 按取消回答并记审计。
    await run(piCommandId("dev:todo", "ask"));
    expect(dialogs.map((call) => [call.source, call.request.kind])).toEqual([["dev:todo", "select"]]);
    expect(commandLog().at(-1)).toEqual({ pick: "y", forked: true, fresh: true });
    expect(auditSubjects(reports)).toEqual(expect.arrayContaining(["pi_plugin_removed fork", "pi_plugin_removed new-session"]));

    // 处理函数要模型再答一轮:不在指令里开跑,变成开轮请求;应用开轮时带回请求 id。
    await run(piCommandId("dev:todo", "again"));
    expect(server.requests).toHaveLength(1);
    expect(turnRequests).toHaveLength(1);
    expect(turnRequests[0]).toMatchObject({ engine: "pi", conversationId, source: "dev:todo" });
    const triggered = await driver.startTurn({
      conversationId,
      turnId: "t2",
      input: { ...inputFor(server, conversationId), trigger: { kind: "engine", requestId: turnRequests[0]!.requestId } },
    });
    expect(triggered.text).toBe("答2");
    expect(JSON.stringify(server.requests[1]!.messages)).toContain("继续处理待办");
    // 插件内存态仍在:同一个会话跑过了轮次 → 指令 → 轮次。
    view = sessionViewOf([u1, a1, message("ASSISTANT", [{ type: "text", text: "答2" }], "fake-model")]);

    // 处理函数抛错:以错误拒绝,署插件 id;指令不存在同样拒绝。
    await expect(run(piCommandId("dev:todo", "boom"))).rejects.toThrow("插件 dev:todo 的指令 /boom 出错:kaboom");
    await expect(run(piCommandId("dev:todo", "gone"))).rejects.toThrow("该指令已不可用");
    await driver.dispose();
  }, 60_000);

  test("ctx.compact():等压缩做完再返回,压缩记录随结果交回,原生压缩条目经 session.append 交回", async () => {
    const conversationId = "6c1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const server = await upstream([{ content: "按待办压缩的摘要" }, { content: "按待办压缩的摘要" }]);
    const history = [];
    for (let round = 0; round < 6; round++) {
      const filler = `第${round}轮长历史。`.repeat(2000);
      history.push(message("USER", [{ type: "text", text: filler }]), message("ASSISTANT", [{ type: "text", text: filler }], "fake-model"));
    }
    const view = sessionViewOf(history);
    const { driver, appended } = harness(() => view);
    const result = await driver.runCommand!({
      conversationId,
      turnId: "c1",
      input: inputFor(server, conversationId),
      commandId: piCommandId("dev:todo", "compact"),
      args: "A",
    });
    expect(result.compactions).toHaveLength(1);
    expect(result.compactions[0]!.summary).toContain("按待办压缩的摘要");
    expect(result.compactions[0]!.tokensBefore).toBeGreaterThan(20_000);
    expect(history.map((item) => item.id)).toContain(result.compactions[0]!.cutMessageId ?? "");
    expect(appended.map((entry) => (entry.payload as { type?: string }).type)).toContain("compaction");
    expect(JSON.stringify(server.requests[0]!.messages)).toContain("keep todos A");
    await driver.dispose();
  }, 60_000);
});
