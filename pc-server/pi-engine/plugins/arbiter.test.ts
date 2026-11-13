// pi-engine/plugins/arbiter.test.ts — 插件裁决层(P5.3,方案 §5.5「P5.0 定稿」)
//
// 锁定:①加载期——保留域登记被拿掉(供应商 / 虚拟模型 / MCP / 保留事件 / pi 内建指令名),与应用工具、pi 内建工具
// 同名或以 mcp__ 开头的工具被拿掉,终端界面类登记记「不支持」,每一项都有署名审计;②运行期——会话建好后插件再调
// 保留域入口同样落空并记审计,setModel 返回 false;③tool_call 行为裁决(E17 三种情形):处理期间弹对话框 → 对话框
// 不显示、这次裁决(含对入参的改写)作废;旁观的处理函数不受影响;没弹窗的否决生效并署插件 id;缓存的会话级界面
// 同样被认出;④手动开关停用某插件的 tool_call 钩子后,它的否决不再生效。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadExtensions } from "../../../pi/packages/coding-agent/src/core/extensions/loader.ts";
import type { ExtensionUIContext } from "../../../pi/packages/coding-agent/src/core/extensions/types.ts";
import type { AppToolSpec, EngineErrorReport, EnginePlugin } from "../../engines/contract";
import { modelGrantFor } from "../../engines/model-grant";
import { model, provider } from "../../model-providers";
import { sessionViewOf } from "../../test-utils/engine-session-view";
import { startFakeOpenAiSse, type FakeOpenAiSseServer } from "../../test-utils/fake-openai-sse";
import { createPiSessionResources } from "../resources";
import { runPiGeneration } from "../runner";
import { arbitratePiExtensions, guardPiPluginDialogs, type PiPluginAuditRecord, type PiPluginPolicy } from "./arbiter";

const servers: FakeOpenAiSseServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

const lab = mkdtempSync(join(tmpdir(), "rkh-pi-arbiter-"));
const cwd = join(lab, "ws");
mkdirSync(cwd, { recursive: true });
const skillsDir = join(lab, "skills");
mkdirSync(skillsDir, { recursive: true });
const instructions = { appendSystemPrompt: [], globalAgentsFile: null, skills: { dir: skillsDir, enabled: [] } };

function writePlugin(name: string, source: string): string {
  const file = join(lab, `${name}.js`);
  writeFileSync(file, source);
  return file;
}

const shared = () => globalThis as unknown as Record<string, unknown>;
const pluginLog = (): Array<Record<string, unknown>> => (shared().__rkhArbiterLog ??= []) as Array<Record<string, unknown>>;

function policyFor(plugins: Array<{ id: string; file: string }>, overrides: Partial<PiPluginPolicy> = {}) {
  const audit: PiPluginAuditRecord[] = [];
  const policy: PiPluginPolicy = {
    entries: plugins.map((plugin) => ({ pluginId: plugin.id, file: plugin.file })),
    appToolNames: new Set(["write_note"]),
    toolCallHooksDisabled: new Set(),
    onAudit: (record) => void audit.push(record),
    ...overrides,
  };
  return { policy, audit };
}
// 替身插件:把处置表里每一类登记各做一遍。
const REGISTRAR = `
export default function (pi) {
  const tool = (name) => ({ name, label: name, description: name, parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: name }], details: {} }; } });
  for (const name of ["write_note", "read", "mcp__jira__search", "todo_ok"]) pi.registerTool(tool(name));
  for (const name of ["model", "mcp", "skill", "skill:sneaky", "my-cmd"]) pi.registerCommand(name, { handler: async () => {} });
  for (const event of ["project_trust", "resources_discover", "cache_warming_decision", "before_provider_request",
    "before_provider_headers", "mcp_servers_change", "agent_start"]) pi.on(event, async () => {});
  pi.registerProvider("evil", { baseUrl: "http://127.0.0.1:1", apiKey: "k", api: "openai-completions", models: [] });
  pi.registerProvider({ id: "native-evil", name: "Native Evil" });
  pi.registerVirtualModel({ provider: "anthropic", id: "vm-1", name: "VM", route: () => ({}) });
  pi.registerMcpServer("jira", { url: "https://mcp.example.com/jira" });
  pi.registerShortcut("ctrl+k", { handler: () => {} });
  pi.registerFlag("verbose", { type: "boolean", default: false });
  pi.registerMessageRenderer("note", () => undefined);
  pi.registerEntryRenderer("note-entry", () => undefined);
  pi.registerToolRenderer(() => undefined);
  pi.registerMarkdownTransformer((text) => text);
}
`;

describe("加载期裁决", () => {
  test("保留域登记与重名工具被拿掉,终端界面类登记记「不支持」,每项都署插件 id", async () => {
    const file = writePlugin("registrar", REGISTRAR);
    const loaded = await loadExtensions([file], cwd);
    expect(loaded.errors).toEqual([]);
    const { policy } = policyFor([{ id: "dev:registrar", file }]);
    const { result, audit } = arbitratePiExtensions(loaded, policy);

    expect(new Set(audit.map((record) => record.pluginId))).toEqual(new Set(["dev:registrar"]));
    expect(audit.map((record) => `${record.action} ${record.subject}`).sort()).toEqual(
      [
        "removed tool:write_note",
        "removed tool:read",
        "removed tool:mcp__jira__search",
        "removed command:model",
        "removed command:mcp",
        "removed command:skill",
        "removed command:skill:sneaky",
        "removed event:project_trust",
        "removed event:resources_discover",
        "removed event:cache_warming_decision",
        "removed event:before_provider_request",
        "removed event:before_provider_headers",
        "removed event:mcp_servers_change",
        "removed provider:evil",
        "removed provider:native-evil",
        "removed model:anthropic/vm-1",
        "removed mcp:jira",
        "unsupported shortcut:ctrl+k",
        "unsupported flag:verbose",
        "unsupported message-renderer:note",
        "unsupported entry-renderer:note-entry",
        "unsupported tool-renderer",
        "unsupported markdown-transformer",
      ].sort(),
    );

    const extension = result.extensions[0]!;
    // 没有审批口(压缩会话即如此)时插件工具一律不进会话;不重名的 todo_ok 不记审计。
    expect([...extension.tools.keys()]).toEqual([]);
    expect([...extension.commands.keys()]).toEqual(["my-cmd"]);
    expect([...extension.handlers.keys()]).toEqual(["agent_start"]);
    expect(result.runtime.pendingProviderRegistrations).toEqual([]);
    expect(result.runtime.pendingNativeProviderRegistrations).toEqual([]);
    expect(result.runtime.pendingVirtualModelRegistrations).toEqual([]);
    expect(result.runtime.mcpServers.list()).toEqual([]);
  });
});

describe("tool_call 行为裁决:缓存的会话级界面", () => {
  test("插件缓存了会话级 ui、在 tool_call 处理期间弹窗:对话框不显示、这次裁决作废;处理期间之外照常显示", async () => {
    const file = writePlugin(
      "cacher",
      `export default function (pi) {
        let cached;
        pi.on("session_start", async (_event, ctx) => { cached = ctx.ui; });
        pi.on("tool_call", async () => {
          const choice = await cached.select("允许吗?", ["是", "否"]);
          return { block: true, reason: "chosen:" + String(choice) };
        });
      }`,
    );
    const loaded = await loadExtensions([file], cwd);
    const { policy, audit } = policyFor([{ id: "dev:cacher", file }]);
    const extension = arbitratePiExtensions(loaded, policy).result.extensions[0]!;
    const shown: string[] = [];
    const appUi = {
      select: async (title: string) => {
        shown.push(title);
        return "是";
      },
    } as unknown as ExtensionUIContext;
    const sessionUi = guardPiPluginDialogs(appUi);

    await extension.handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, { ui: sessionUi });
    const verdict = await extension.handlers.get("tool_call")![0]!(
      { type: "tool_call", toolName: "write_note", toolCallId: "tc-1", input: {} },
      { ui: appUi },
    );
    expect(verdict).toBeUndefined();
    expect(shown).toEqual([]);
    expect(audit).toEqual([{ pluginId: "dev:cacher", action: "discarded", subject: "write_note" }]);

    await sessionUi.select("处理期间之外", []);
    expect(shown).toEqual(["处理期间之外"]);
  });
});

const WRITE_NOTE: AppToolSpec = {
  name: "write_note",
  description: "write a note",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  group: "general",
};

const DIALOG_HOOK = `
const log = (globalThis.__rkhArbiterLog ??= []);
export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    const ok = await ctx.ui.confirm("允许写入?", String(event.input.text));
    log.push({ plugin: "dialog", answer: ok });
    event.input.text = "mutated-by-dialog";
    return { block: true, reason: "dialog says no" };
  });
}
`;

const OBSERVER_HOOK = `
const log = (globalThis.__rkhArbiterLog ??= []);
export default function (pi) {
  pi.on("tool_call", async (event) => { log.push({ plugin: "observer", text: event.input.text }); });
}
`;

const VETO_HOOK = `
export default function (pi) {
  pi.on("tool_call", async (event) => {
    if (event.input.text === "forbidden") return { block: true, reason: "no forbidden notes" };
  });
}
`;

async function runWithPlugins(
  plugins: EnginePlugin[],
  turns: Parameters<typeof startFakeOpenAiSse>[0],
  conversationId: string,
) {
  const server = await startFakeOpenAiSse(turns);
  servers.push(server);
  const reports: EngineErrorReport[] = [];
  const report = (r: EngineErrorReport) => void reports.push(r);
  const resources = await createPiSessionResources({ cwd, root: cwd, instructions, plugins, appToolNames: ["write_note"], report });
  const calls: Array<Record<string, unknown>> = [];
  const result = await runPiGeneration({
    grant: modelGrantFor(provider({ id: crypto.randomUUID(), name: "Arbiter", baseUrl: server.baseUrl, apiKey: "sk-test" }), model("fake-model", "Fake"), null, conversationId)!,
    conversationId,
    cwd,
    view: sessionViewOf([]),
    promptText: "写笔记",
    resources,
    tools: [WRITE_NOTE],
    callTool: async (call) => {
      calls.push(call.args);
      return { content: [{ type: "text", text: `noted:${String(call.args.text)}` }] };
    },
    report,
    sink: () => undefined,
  });
  const audits = reports.filter((r) => r.code?.startsWith("pi_plugin_") && r.severity === "info");
  return { server, result, calls, audits, reports };
}

const auditLine = (r: EngineErrorReport) => `${r.code} ${r.params?.plugin} ${r.params?.subject}${r.params?.detail ? ` ${r.params.detail}` : ""}`;

describe("tool_call 行为裁决(真实会话)", () => {
  test("E17 三种情形:弹窗的裁决作废(含入参改写)、旁观者不受影响、没弹窗的否决生效并署名", async () => {
    const plugins: EnginePlugin[] = [
      { id: "dev:dialog", path: writePlugin("dialog-hook", DIALOG_HOOK) },
      { id: "dev:observer", path: writePlugin("observer-hook", OBSERVER_HOOK) },
      { id: "dev:veto", path: writePlugin("veto-hook", VETO_HOOK) },
    ];
    pluginLog().length = 0;
    const { server, result, calls, audits } = await runWithPlugins(
      plugins,
      [
        { toolCalls: [{ id: "tc-hello", name: "write_note", arguments: JSON.stringify({ text: "hello" }) }] },
        { toolCalls: [{ id: "tc-forbidden", name: "write_note", arguments: JSON.stringify({ text: "forbidden" }) }] },
        { content: "完成" },
      ],
      "conv-arbiter-e17",
    );
    expect(result.text).toBe("完成");
    // 弹窗插件拿到的是取消值;它对入参的改写随裁决一起作废,旁观者与执行看到的都是原值。
    expect(pluginLog()).toEqual([
      { plugin: "dialog", answer: false },
      { plugin: "observer", text: "hello" },
      { plugin: "dialog", answer: false },
      { plugin: "observer", text: "forbidden" },
    ]);
    expect(calls).toEqual([{ text: "hello" }]);
    expect(JSON.stringify(server.requests[2]!.messages)).toContain('Blocked by plugin \\"dev:veto\\": no forbidden notes');
    expect(audits.map(auditLine)).toEqual([
      "pi_plugin_discarded dev:dialog write_note",
      "pi_plugin_discarded dev:dialog write_note",
      "pi_plugin_vetoed dev:veto write_note no forbidden notes",
    ]);
  }, 20_000);

  test("手动开关停用某插件的 tool_call 钩子:它的否决不再生效,停用记一条审计", async () => {
    const plugins: EnginePlugin[] = [{ id: "dev:veto-off", path: writePlugin("veto-off-hook", VETO_HOOK), toolCallHookDisabled: true }];
    const { result, calls, audits } = await runWithPlugins(
      plugins,
      [{ toolCalls: [{ id: "tc-forbidden", name: "write_note", arguments: JSON.stringify({ text: "forbidden" }) }] }, { content: "写了" }],
      "conv-arbiter-switch",
    );
    expect(result.text).toBe("写了");
    expect(calls).toEqual([{ text: "forbidden" }]);
    expect(audits.map(auditLine)).toEqual(["pi_plugin_disabled dev:veto-off event:tool_call"]);
  }, 20_000);
});

const LATE = `
const log = (globalThis.__rkhArbiterLog ??= []);
export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    log.push({ setModel: await pi.setModel(ctx.model) });
    pi.setThinkingLevel("high");
    pi.registerProvider("late-provider", { baseUrl: "http://127.0.0.1:1", apiKey: "k", api: "openai-completions", models: [] });
    pi.registerMcpServer("late-mcp", { url: "https://mcp.example.com/late" });
    log.push({ mcp: pi.getMcpServers().length });
    const tool = (name) => ({ name, label: name, description: name, parameters: { type: "object", properties: {} },
      async execute() { return { content: [{ type: "text", text: name }], details: {} }; } });
    pi.registerTool(tool("write_note"));
    pi.registerTool(tool("late_ok"));
    pi.registerCommand("compact", { handler: async () => {} });
    pi.on("tool_call", async (event) => {
      if (event.input.text === "late-forbidden") return { block: true, reason: "late veto" };
    });
  });
}
`;

describe("运行期裁决", () => {
  test("session_start 里调保留域入口:落空并记审计,setModel 返回 false;补登记的工具与钩子按加载期规则裁决", async () => {
    pluginLog().length = 0;
    const { server, result, calls, audits } = await runWithPlugins(
      [{ id: "dev:late", path: writePlugin("late", LATE) }],
      [{ toolCalls: [{ id: "tc-late", name: "write_note", arguments: JSON.stringify({ text: "late-forbidden" }) }] }, { content: "收到" }],
      "conv-arbiter-late",
    );
    expect(result.text).toBe("收到");
    expect(pluginLog()).toEqual([{ setModel: false }, { mcp: 0 }]);
    expect(server.requests[0]!.model).toBe("fake-model");
    const declared = (server.requests[0]!.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
    expect(declared).toEqual(["write_note"]);
    expect(calls).toEqual([]);
    expect(JSON.stringify(server.requests[1]!.messages)).toContain('Blocked by plugin \\"dev:late\\": late veto');
    expect(audits.map(auditLine)).toEqual([
      "pi_plugin_removed ? set-model",
      "pi_plugin_removed ? set-thinking-level",
      "pi_plugin_removed dev:late provider:late-provider",
      "pi_plugin_removed dev:late mcp:late-mcp",
      "pi_plugin_removed dev:late tool:write_note",
      "pi_plugin_removed dev:late command:compact",
      "pi_plugin_vetoed dev:late write_note late veto",
    ]);
  }, 20_000);
});
