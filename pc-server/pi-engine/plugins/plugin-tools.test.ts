// pi-engine/plugins/plugin-tools.test.ts — 插件工具进会话 + 执行前审批(P5.4)
//
// 锁定:①裁决后的插件工具进入上游请求的工具声明,执行前经 host.permission.check(带 turnId、来源 = 插件 id);
// ②应用侧审批口(createToolPermissionChecker)在要询问时:待审卡 → 批准后执行、拒绝则不执行且拒绝理由
// 回给模型;选了「此会话内总是允许」后同会话同工具不再询问;③事件桥给插件工具建通用工具卡,结果只按 content
// 映射(插件自己的 details 不进卡);④没有审批口的会话(压缩)不声明插件工具。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-pi-plugin-tools-"));

const { createToolPermissionChecker } = await import("../../engines/app-tools");
const { piBuiltinToolNames } = await import("../builtin-tools");
const { resolveToolApproval, forgetSessionToolAllowances } = await import("../../inference-engine/approval-gate");
const { connectDriver, connectHost } = await import("../../engines/loopback");
const { modelGrantFor } = await import("../../engines/model-grant");
const { model, provider } = await import("../../model-providers");
const { startFakeOpenAiSse } = await import("../../test-utils/fake-openai-sse");
const { createPiDriver } = await import("../driver");
const { createPiSessionResources } = await import("../resources");

import type { EngineHost, PermissionCheck, TurnInput } from "../../engines/contract";
import type { GenerationEvent } from "../../inference-engine/events";
import type { FakeOpenAiSseServer, FakeSseTurn } from "../../test-utils/fake-openai-sse";

const servers: FakeOpenAiSseServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

const lab = mkdtempSync(join(tmpdir(), "rkh-pi-plugin-tools-lab-"));
const cwd = join(lab, "ws");
mkdirSync(cwd, { recursive: true });
const skillsDir = join(lab, "skills");
mkdirSync(skillsDir, { recursive: true });
const instructions = { appendSystemPrompt: [], globalAgentsFile: null, skills: { dir: skillsDir, enabled: [] } };

const pluginFile = join(lab, "counter.js");
writeFileSync(
  pluginFile,
  `const log = (globalThis.__rkhPluginToolLog ??= []);
export default function (pi) {
  pi.registerTool({
    name: "counter_add",
    label: "counter_add",
    description: "add to the counter",
    parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    async execute(_id, params) {
      log.push(params.n);
      return { content: [{ type: "text", text: "added " + params.n }], details: { workspace: { tool: "counter", details: { total: params.n } }, total: params.n } };
    },
  });
}
`,
);
const plugins = [{ id: "dev:counter", path: pluginFile }];
const executed = (): number[] => ((globalThis as Record<string, unknown>).__rkhPluginToolLog ??= []) as number[];
function harness(conversationId: string) {
  const events: GenerationEvent[] = [];
  const checks: PermissionCheck[] = [];
  const sink = (event: GenerationEvent) => void events.push(event);
  // 应用侧审批口(生产 = 编排器给本轮绑定的 checkPermission,经 host.permission.check 到达)。会话不绑工作区记录 →
  // 按最严档询问,与「询问批准」同一判定。
  const check = createToolPermissionChecker({ conversation: { id: conversationId } as never, assistant: {} as never, sink });
  const host: EngineHost = {
    emit: (_turn, event) => sink(event),
    session: { load: async () => ({ items: [], compactions: [] }), append: async () => undefined },
    tools: {
      call: async () => {
        throw new Error("本测试没有应用工具");
      },
    },
    permission: {
      check: async (req) => {
        checks.push(req);
        const { conversationId: _conversationId, turnId: _turnId, ...call } = req;
        return check(call);
      },
    },
    interaction: { dialog: async () => ({ cancelled: true }), dismiss: () => undefined, show: () => undefined },
    steer: { take: async () => [] },
    turn: { request: () => undefined },
    models: { credential: async () => ({}), log: () => undefined },
    report: () => undefined,
  };
  const driver = connectDriver(createPiDriver(connectHost(host, { strict: true })), { strict: true });
  return { driver, events, checks };
}

async function upstream(turns: FakeSseTurn[]) {
  const server = await startFakeOpenAiSse(turns);
  servers.push(server);
  return server;
}

function inputFor(server: FakeOpenAiSseServer, conversationId: string): TurnInput {
  return {
    model: modelGrantFor(provider({ id: crypto.randomUUID(), name: "Plugin Tools", baseUrl: server.baseUrl, apiKey: "sk-test" }), model("fake-model", "Fake"), null, conversationId)!,
    reasoningLevel: null,
    workspace: { cwd, root: cwd },
    instructions,
    plugins,
    prompt: { text: "加一下", images: [] },
    tools: [],
  };
}

const approvals = (events: GenerationEvent[]) =>
  events.filter((event) => event.kind === "tool_approval_updated").map((event) => (event as { approvalState: { type: string } }).approvalState.type);

async function waitUntil(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const addTurns = (id: string, n: number, reply: string): FakeSseTurn[] => [
  { toolCalls: [{ id, name: "counter_add", arguments: JSON.stringify({ n }) }] },
  { content: reply },
];

describe("插件工具 × 应用审批", () => {
  test("插件工具进上游声明;执行前待审,批准后执行;通用工具卡只按 content 映射;选「总是允许」后同会话免问", async () => {
    const conversationId = "conv-plugin-tools-1";
    executed().length = 0;
    const server = await upstream(addTurns("tc-add-1", 2, "加好了"));
    const { driver, events, checks } = harness(conversationId);
    const turn = { conversationId, turnId: "turn-1" };
    const run = driver.startTurn({ ...turn, input: inputFor(server, conversationId) });
    await waitUntil(() => approvals(events).includes("pending"));
    expect(executed()).toEqual([]);
    expect(resolveToolApproval(conversationId, "tc-add-1", { approved: true, alwaysAllowInSession: true })).toBe(true);
    expect((await run).text).toBe("加好了");

    const declared = (server.requests[0]!.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
    // 工作区会话照常带 pi 内建工具(测试 TurnInput 没有 shell → 兜底组)。
    expect(declared.toSorted()).toEqual(["counter_add", ...piBuiltinToolNames(undefined)].toSorted());
    expect(checks).toEqual([
      { ...turn, toolCallId: "tc-add-1", toolName: "counter_add", origin: { kind: "plugin", pluginId: "dev:counter" } },
    ]);
    expect(executed()).toEqual([2]);
    expect(approvals(events)).toEqual(["pending", "approved"]);
    // 工具卡署名「来自插件 X」:建卡即带登记它的插件 id。
    expect(events.find((event) => event.kind === "tool_call_created")).toMatchObject({
      toolName: "counter_add",
      metadata: { attribution: { pluginId: "dev:counter" } },
    });
    // 插件的 details 恰好带 workspace 键也不被当成工作区工具细节。
    expect((events.filter((event) => event.kind === "tool_result").at(-1) as { output: unknown }).output).toEqual([{ type: "text", text: "added 2" }]);

    // 同会话下一轮:「总是允许」生效,不再挂卡。
    const second = await upstream(addTurns("tc-add-2", 3, "又加好了"));
    const next = harness(conversationId);
    expect((await next.driver.startTurn({ conversationId, turnId: "turn-2", input: inputFor(second, conversationId) })).text).toBe("又加好了");
    expect(executed()).toEqual([2, 3]);
    expect(approvals(next.events)).toEqual([]);
    forgetSessionToolAllowances(conversationId);
  }, 30_000);

  test("拒绝:插件工具不执行,拒绝理由作为工具结果回给模型", async () => {
    const conversationId = "conv-plugin-tools-2";
    executed().length = 0;
    const server = await upstream(addTurns("tc-add-3", 5, "那就不加"));
    const { driver, events } = harness(conversationId);
    const run = driver.startTurn({ conversationId, turnId: "turn-3", input: inputFor(server, conversationId) });
    await waitUntil(() => approvals(events).includes("pending"));
    resolveToolApproval(conversationId, "tc-add-3", { approved: false, reason: "不要动计数器" });
    expect((await run).text).toBe("那就不加");
    expect(executed()).toEqual([]);
    expect(approvals(events)).toEqual(["pending", "denied"]);
    expect(JSON.stringify(server.requests[1]!.messages)).toContain("Tool execution denied by user. Reason: 不要动计数器");
  }, 30_000);

  test("没有审批口的会话(压缩)不声明插件工具", async () => {
    const resources = await createPiSessionResources({ cwd, root: cwd, instructions, plugins });
    expect([...resources.resourceLoader.getExtensions().extensions[0]!.tools.keys()]).toEqual([]);
  });
});
