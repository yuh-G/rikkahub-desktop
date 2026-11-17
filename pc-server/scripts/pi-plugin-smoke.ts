// scripts/pi-plugin-smoke.ts — 头部插件冒烟(P5.10;每次同步 pi 上游的验收项)
//   bun run smoke:pi-plugins      (在 pc-server 目录下)
//
// 八个头部插件的本地副本(Reference-project 下装好的 node_modules,不进仓库)同时装进 pi 会话,假供应商脚本化
// 跑若干轮,断言每个插件的主要功能在应用的接线下照常工作。插件声明的 pi 版本要求很松(多是 "*"),pi 升级把它们
// 弄坏了不会自己报,所以升级 pi 后必须跑一次(CLAUDE.md 升级流程第 6 步)。
// 版本钉在 PINNED:副本的版本与之不符即失败——换了副本要重新确认用例,再改这张表。
// 走 runner 这一层(资源装配 → 裁决层 → 界面桥 → 工作区工具 → 子会话约束);编排器与存储那一层由
// pi-engine/plugins/acceptance.test.ts 管。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// 插件与 pi 内部会读写 pi 数据目录:指到临时目录,先于任何引用 foundation/paths 的模块。
const scratch = mkdtempSync(join(tmpdir(), "rkh-pi-plugin-smoke-"));
process.env.RIKKAHUB_PC_DATA_DIR = join(scratch, "data");

const { bindPiAgentDir } = await import("../pi-engine/agent-dir");
const { createPiSessionResources } = await import("../pi-engine/resources");
const { runPiCommand, runPiGeneration } = await import("../pi-engine/runner");
const { commandsOfExtensions, piCommandId } = await import("../pi-engine/plugins/commands");
const { modelGrantFor } = await import("../engines/model-grant");
const { model, provider } = await import("../model-providers");
const { sessionViewOf } = await import("../test-utils/engine-session-view");
const { startFakeOpenAiSse } = await import("../test-utils/fake-openai-sse");

import type { EngineDialogCall, EngineErrorReport, EnginePlugin, EngineUiNoticeCall, TurnRef } from "../engines/contract";
import type { PiBuiltinToolApproval } from "../pi-engine/builtin-tools";
import type { FakeOpenAiSseServer, FakeSseTurn } from "../test-utils/fake-openai-sse";

bindPiAgentDir();

const PLUGIN_ROOT = resolve(import.meta.dir, "../../Reference-project/extensions/_lab/appdata/engines/pi/npm/node_modules");

/** 验收过的版本,以及每个插件必须还在的工具与指令(用例要用的、或插件的主要入口)。 */
const PINNED = [
  { id: "dev:rpiv-todo", name: "@juicesharp/rpiv-todo", version: "2.15.0", tools: ["todo"], commands: ["todos"] },
  { id: "dev:rpiv-ask-user-question", name: "@juicesharp/rpiv-ask-user-question", version: "2.15.0", tools: ["ask_user_question"], commands: [] },
  { id: "dev:pi-permission-system", name: "@gotgenes/pi-permission-system", version: "42.0.0", tools: [], commands: ["permission-system"] },
  { id: "dev:tintinweb-subagents", name: "@tintinweb/pi-subagents", version: "0.23.1", tools: ["Agent", "get_subagent_result"], commands: ["agents"] },
  { id: "dev:pi-subagents", name: "pi-subagents", version: "0.87.0", tools: ["subagent"], commands: ["subagents"] },
  { id: "dev:pi-mcp-adapter", name: "pi-mcp-adapter", version: "7.0.1", tools: ["mcp"], commands: ["mcp-adapter"] },
  { id: "dev:pi-web-access", name: "pi-web-access", version: "0.47.0", tools: ["web_search", "fetch_content"], commands: ["websearch"] },
  { id: "dev:pi-lens", name: "pi-lens", version: "4.4.11", tools: ["lens_diagnostics", "ast_grep_search"], commands: ["lens-health"] },
];

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail !== undefined ? `  →  ${JSON.stringify(detail)?.slice(0, 600)}` : ""}`);
  }
}

const plugins: EnginePlugin[] = [];
for (const { id, name, version } of PINNED) {
  const path = join(PLUGIN_ROOT, name);
  const manifest = join(path, "package.json");
  if (!existsSync(manifest)) {
    console.error(`插件副本缺席:${path}(本冒烟需要 Reference-project 里装好的头部插件)`);
    process.exit(1);
  }
  const actual = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version;
  check(`版本 ${name}@${version}`, actual === version, { actual });
  plugins.push({ id, path });
}

const instructions = { appendSystemPrompt: [], globalAgentsFile: null, skills: { dir: join(scratch, "skills"), enabled: [] } };
mkdirSync(instructions.skills.dir, { recursive: true });

// ---- 一个用例 = 一个工作区 + 一个假上游 + 全部插件 ----

interface Harness {
  cwd: string;
  outside: string;
  server: FakeOpenAiSseServer;
  reports: EngineErrorReport[];
  dialogs: Array<Omit<EngineDialogCall, keyof TurnRef>>;
  notices: Array<Omit<EngineUiNoticeCall, keyof TurnRef>>;
  approvals: PiBuiltinToolApproval[];
  pluginToolCalls: string[];
}

const servers: FakeOpenAiSseServer[] = [];

async function harness(name: string, turns: FakeSseTurn[]) {
  const cwd = join(scratch, name, "ws");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "notes.md"), "hello from notes");
  const server = await startFakeOpenAiSse(turns);
  servers.push(server);
  const h: Harness = { cwd, outside: join(scratch, name, "outside.txt"), server, reports: [], dialogs: [], notices: [], approvals: [], pluginToolCalls: [] };
  const report = (r: EngineErrorReport) => void h.reports.push(r);
  const approvePluginTool = async (req: { toolName: string }) => {
    h.pluginToolCalls.push(req.toolName);
    return undefined;
  };
  const resources = await createPiSessionResources({ cwd, root: cwd, instructions, plugins, approvePluginTool, report });
  const ourModel = model("fake-model", "Smoke Model");
  const conversationId = `conv-${name}`;
  const inputs = {
    grant: modelGrantFor(provider({ id: crypto.randomUUID(), name: "Smoke", baseUrl: server.baseUrl, apiKey: "sk-test" }), ourModel, null, conversationId)!,
    conversationId,
    cwd,
    view: sessionViewOf([], { model: ourModel }),
    resources,
    approvePluginTool,
    report,
    workspaceTools: {
      root: cwd,
      approve: async (req: PiBuiltinToolApproval) => {
        h.approvals.push(req);
        return { scope: "default" as const };
      },
    },
    interaction: {
      dialog: async (call: Omit<EngineDialogCall, keyof TurnRef>) => {
        h.dialogs.push(call);
        // 选第二项;确认 = 是;输入 = 固定文本。
        if (call.request.kind === "select") return { cancelled: false as const, value: call.request.options[1] ?? call.request.options[0]! };
        if (call.request.kind === "confirm") return { cancelled: false as const, value: true };
        return { cancelled: false as const, value: "smoke" };
      },
      dismiss: () => undefined,
      show: (call: Omit<EngineUiNoticeCall, keyof TurnRef>) => void h.notices.push(call),
    },
    sink: () => undefined,
  };
  return { h, resources, inputs };
}

/** 工具结果(从之后的模型请求里取:pi 把它作为 role=tool 的消息回灌)。 */
function toolResult(server: FakeOpenAiSseServer, toolCallId: string): string | undefined {
  for (const request of server.requests) {
    for (const message of (request.messages as Array<{ role: string; tool_call_id?: string; content?: unknown }>) ?? []) {
      if (message.role === "tool" && message.tool_call_id === toolCallId) {
        return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      }
    }
  }
  return undefined;
}

/** 插件出的问题(加载失败、处理函数抛错、对话框失败);裁决层的 info 级记录(不支持的快捷键等)不算。 */
const pluginFailures = (h: Harness) => h.reports.filter((r) => r.code?.startsWith("pi_plugin_") && r.severity !== "info");
const audits = (h: Harness, code: string) => h.reports.filter((r) => r.code === code).map((r) => `${r.params?.plugin} ${r.params?.subject}`);
const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: JSON.stringify(args) });

async function scenario(title: string, run: () => Promise<void>, timeoutMs = 90_000) {
  console.log(`\n== ${title}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`超时 ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (err) {
    check(`${title}:跑完`, false, err instanceof Error ? err.stack ?? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

await scenario("加载:八个插件同时装上,登记的工具与指令都在", async () => {
  const { h, resources } = await harness("load", []);
  const { extensions, errors } = resources.resourceLoader.getExtensions();
  check("没有加载错误", errors.length === 0 && pluginFailures(h).length === 0, { errors, failures: pluginFailures(h) });
  check("八个插件都进了会话", new Set(resources.plugins.map((entry) => entry.pluginId)).size === plugins.length, resources.plugins);
  const commands = commandsOfExtensions(extensions, resources.plugins);
  for (const pinned of PINNED) {
    const files = new Set(resources.plugins.filter((entry) => entry.pluginId === pinned.id).map((entry) => entry.file));
    const tools = extensions.filter((ext) => files.has(ext.path)).flatMap((ext) => [...ext.tools.keys()]);
    const names = commands.filter((command) => command.source === `plugin:${pinned.id}`).map((command) => command.name);
    const missing = [...pinned.tools.filter((name) => !tools.includes(name)), ...pinned.commands.filter((name) => !names.includes(name))];
    check(`${pinned.id} 的工具与指令`, missing.length === 0, { missing, tools, commands: names });
  }
});

await scenario("待办 + 提问:插件工具经审批口执行,提问走应用对话框,答案回到模型;/todos 指令经界面通道通知", async () => {
  const questions = [{ question: "用哪个方案?", header: "方案", options: [{ label: "甲", description: "稳妥" }, { label: "乙", description: "激进" }] }];
  const { h, inputs } = await harness("todo-ask", [
    { toolCalls: [call("tc-todo-1", "todo", { action: "create", subject: "写冒烟报告" })] },
    { toolCalls: [call("tc-todo-2", "todo", { action: "list" })] },
    { toolCalls: [call("tc-ask-1", "ask_user_question", { questions })] },
    { content: "那就乙" },
  ]);
  const result = await runPiGeneration({ ...inputs, promptText: "记个待办再问我" });
  check("这一轮答完", result.text === "那就乙", result.text);
  check("插件工具都经过审批口", JSON.stringify(h.pluginToolCalls) === JSON.stringify(["todo", "todo", "ask_user_question"]), h.pluginToolCalls);
  check("todo 建出任务", toolResult(h.server, "tc-todo-1") === "Created #1: 写冒烟报告 (pending)", toolResult(h.server, "tc-todo-1"));
  check("todo 列出任务", toolResult(h.server, "tc-todo-2") === "[pending] #1 写冒烟报告", toolResult(h.server, "tc-todo-2"));
  const dialog = h.dialogs.find((item) => item.source === "dev:rpiv-ask-user-question");
  check("提问出现在应用对话框(select,署插件 id)", dialog?.request.kind === "select" && dialog.request.title.includes("用哪个方案?"), h.dialogs);
  check("答案回到模型", toolResult(h.server, "tc-ask-1")?.includes('"用哪个方案?"="乙"') === true, toolResult(h.server, "tc-ask-1"));
  check("没有插件故障", pluginFailures(h).length === 0, pluginFailures(h));

  await runPiCommand({ ...inputs, commandId: piCommandId("dev:rpiv-todo", "todos"), args: "" });
  const notice = h.notices.find((item) => item.source === "dev:rpiv-todo" && item.notice.kind === "notify");
  check("/todos 经界面通道通知", notice !== undefined, h.notices);
});

await scenario("权限插件:tool_call 里的询问被吞、裁决作废,写入照常(署名进错误中心)", async () => {
  const { h, inputs } = await harness("permission", [
    { toolCalls: [call("tc-w-1", "write", { path: "notes.txt", content: "ok" })] },
    { content: "写完了" },
  ]);
  const result = await runPiGeneration({ ...inputs, promptText: "写个文件" });
  check("这一轮答完", result.text === "写完了", result.text);
  check("文件写进工作区", existsSync(join(h.cwd, "notes.txt")) && readFileSync(join(h.cwd, "notes.txt"), "utf8") === "ok");
  check("写入经工作区审批口", h.approvals.some((req) => req.toolName === "write" && req.category === "write"), h.approvals);
  check("权限插件的对话框没到应用", !h.dialogs.some((item) => item.source === "dev:pi-permission-system"), h.dialogs);
  check("错误中心有 pi_plugin_discarded(权限插件,write)", audits(h, "pi_plugin_discarded").includes("dev:pi-permission-system write"), audits(h, "pi_plugin_discarded"));
  check("没有插件故障", pluginFailures(h).length === 0, pluginFailures(h));
});

await scenario("工具类插件:pi-lens 的钩子不挡读改;mcp 报出服务器状态;fetch_content 拦下内网地址", async () => {
  const { h, inputs } = await harness("tools", [
    { toolCalls: [call("tc-read", "read", { path: "notes.md" })] },
    { toolCalls: [call("tc-edit", "edit", { path: "notes.md", edits: [{ oldText: "hello", newText: "hi" }] })] },
    { toolCalls: [call("tc-mcp", "mcp", {})] },
    { toolCalls: [call("tc-fetch", "fetch_content", { url: "http://127.0.0.1:9/" })] },
    { content: "看完了" },
  ]);
  const result = await runPiGeneration({ ...inputs, promptText: "读改一下文件,再看看 mcp 与网页" });
  check("这一轮答完", result.text === "看完了", result.text);
  check("read 读到内容", toolResult(h.server, "tc-read")?.includes("hello from notes") === true, toolResult(h.server, "tc-read"));
  check("edit 改进文件", readFileSync(join(h.cwd, "notes.md"), "utf8") === "hi from notes", readFileSync(join(h.cwd, "notes.md"), "utf8"));
  // 临时数据目录里没有 MCP 配置:零个服务器。
  check("mcp 报出服务器状态", toolResult(h.server, "tc-mcp")?.startsWith("MCP: 0/0 servers") === true, toolResult(h.server, "tc-mcp"));
  // 插件自己的 SSRF 防护先于联网:不发出请求。
  check("fetch_content 拦下内网地址", toolResult(h.server, "tc-fetch")?.includes("Blocked internal address") === true, toolResult(h.server, "tc-fetch"));
  check("mcp / fetch_content 经审批口", ["mcp", "fetch_content"].every((name) => h.pluginToolCalls.includes(name)), h.pluginToolCalls);
  check("没有插件故障", pluginFailures(h).length === 0, pluginFailures(h));
});

// 子代理:前台子任务在进程内另开会话(模型随父会话),子会话的内建工具经本轮审批口(noPrompt)、default 范围下区外写入被拒。
const childTurns = (cwd: string, outside: string, prefix: string): FakeSseTurn[] => [
  {
    toolCalls: [
      call(`${prefix}-out`, "write", { path: outside, content: "x" }),
      call(`${prefix}-read`, "read", { path: join(cwd, "notes.md") }),
    ],
  },
  { content: "子任务完成" },
];

async function subagentScenario(name: string, spawn: (h: Harness) => ReturnType<typeof call>) {
  const turns: FakeSseTurn[] = [];
  const { h, inputs } = await harness(name, turns);
  turns.push({ toolCalls: [spawn(h)] }, ...childTurns(h.cwd, h.outside, name), { content: "完成" });
  const result = await runPiGeneration({ ...inputs, promptText: "派个子任务" });
  check("这一轮答完", result.text === "完成", { text: result.text, requests: h.server.requests.length });
  const childApprovals = h.approvals.filter((req) => req.noPrompt);
  check("子会话的内建工具经审批口(noPrompt)", childApprovals.map((req) => req.toolName).join(",") === "write,read", h.approvals);
  check("区外写入被拒", toolResult(h.server, `${name}-out`)?.includes("outside the workspace boundary") === true && !existsSync(h.outside), toolResult(h.server, `${name}-out`));
  check("区内读取照常", toolResult(h.server, `${name}-read`)?.includes("hello from notes") === true, toolResult(h.server, `${name}-read`));
  check("子任务结果回到父会话", toolResult(h.server, "spawn")?.includes("子任务完成") === true, toolResult(h.server, "spawn"));
  check("没有插件故障", pluginFailures(h).length === 0, pluginFailures(h));
}

await scenario("子代理(@tintinweb/pi-subagents):Agent 前台子任务", () =>
  subagentScenario("tintinweb", () =>
    call("spawn", "Agent", { prompt: "do the sub-task", description: "sub-task", subagent_type: "general-purpose", run_in_background: false }),
  ),
);

await scenario("子代理(pi-subagents):subagent 前台子任务", () =>
  subagentScenario("pisub", () => call("spawn", "subagent", { agent: "delegate", task: "do the sub-task", async: false })),
);

await Promise.all(servers.map((server) => server.close()));
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
