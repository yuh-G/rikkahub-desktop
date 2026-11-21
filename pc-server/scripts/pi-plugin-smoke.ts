// scripts/pi-plugin-smoke.ts — pi 插件冒烟(P5.10;每次同步 pi 上游的验收项;P7.2.8 起经引擎宿主进程跑)
//   bun run smoke:pi-plugins      (在 pc-server 目录下)
//
// 两批插件的本地副本(Reference-project 下装好的 node_modules,不进仓库):八个头部插件(HEAD)同时装进一个会话,
// 另一批十二个(EXTRA)同时装进另一个会话。假供应商脚本化跑若干轮,断言每个插件的主要功能在应用的接线下照常工作。
// 插件声明的 pi 版本要求很松(多是 "*"),pi 升级把它们弄坏了不会自己报,所以升级 pi 后必须跑一次(CLAUDE.md
// 升级流程第 6 步)。版本钉在 HEAD / EXTRA:副本的版本与之不符即失败——换了副本要重新确认用例,再改表。
// 与生产同一条路:经 subprocess-engine/host-launch 起一个引擎宿主进程(spawnSelf("engine-host") + 专用通道),插件在那里
// 加载执行;本脚本扮演应用,实现 EngineHost(审批、对话框、界面通知、开轮请求、上报都跨进程回到这里)。编排器与存储
// 那一层由 pi-engine/plugins/acceptance.test.ts 管。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// 插件与 pi 内部会读写 pi 数据目录:指到临时目录。不少插件还往用户主目录里写自己的数据(~/.pi-lens、~/.cc-safety-net、
// ~/.context-mode,pi-memory 写 ~/.pi/agent/memory),主目录也指过去;宿主进程继承这几个环境变量。
const scratch = mkdtempSync(join(tmpdir(), "rkh-pi-plugin-smoke-"));
process.env.RIKKAHUB_PC_DATA_DIR = join(scratch, "data");
process.env.HOME = process.env.USERPROFILE = join(scratch, "home");
mkdirSync(process.env.HOME, { recursive: true });

const { modelGrantFor } = await import("../engines/model-grant");
const { model, provider } = await import("../model-providers");
const { launchEngineHost } = await import("../subprocess-engine/host-launch");
const { sessionViewOf } = await import("../test-utils/engine-session-view");
const { startFakeOpenAiSse } = await import("../test-utils/fake-openai-sse");
const { shellAvailability } = await import("../workspace/runtime");

import type {
  EngineDialogAnswer,
  EngineDialogCall,
  EngineErrorReport,
  EngineHost,
  EnginePlugin,
  EngineTurnRequest,
  EngineUiNoticeCall,
  PermissionCheck,
  TurnInput,
} from "../engines/contract";
import type { AppErrorDto } from "../foundation/types/dto";
import type { FakeOpenAiSseServer, FakeSseTurn } from "../test-utils/fake-openai-sse";

const HEAD_ROOT = resolve(import.meta.dir, "../../Reference-project/extensions/_lab/appdata/engines/pi/npm/node_modules");
const EXTRA_ROOT = resolve(import.meta.dir, "../../Reference-project/extensions/_lab_more/node_modules");

interface Pinned {
  id: string;
  name: string;
  version: string;
  /** 必须还在的工具与指令(用例要用的、或插件的主要入口)。 */
  tools: string[];
  commands: string[];
}

/** 头部插件:验收过的版本。 */
const HEAD: Pinned[] = [
  { id: "dev:rpiv-todo", name: "@juicesharp/rpiv-todo", version: "2.15.0", tools: ["todo"], commands: ["todos"] },
  { id: "dev:rpiv-ask-user-question", name: "@juicesharp/rpiv-ask-user-question", version: "2.15.0", tools: ["ask_user_question"], commands: [] },
  { id: "dev:pi-permission-system", name: "@gotgenes/pi-permission-system", version: "42.0.0", tools: [], commands: ["permission-system"] },
  { id: "dev:tintinweb-subagents", name: "@tintinweb/pi-subagents", version: "0.23.1", tools: ["Agent", "get_subagent_result"], commands: ["agents"] },
  { id: "dev:pi-subagents", name: "pi-subagents", version: "0.87.0", tools: ["subagent"], commands: ["subagents"] },
  { id: "dev:pi-mcp-adapter", name: "pi-mcp-adapter", version: "7.0.1", tools: ["mcp"], commands: ["mcp-adapter"] },
  { id: "dev:pi-web-access", name: "pi-web-access", version: "0.47.0", tools: ["web_search", "fetch_content"], commands: ["websearch"] },
  { id: "dev:pi-lens", name: "pi-lens", version: "4.4.11", tools: ["lens_diagnostics", "ast_grep_search"], commands: ["lens-health"] },
];

/** 补充插件(npm 上 pi-package 关键字下载量靠前的另一批,2026-11-17 装):覆盖头部插件没有的形态——别家的
 *  tool_call 否决、运行期才登记工具、插件另开旁路会话、经对话框走菜单、指令里请求开轮、往主目录写数据。
 *  pi-intercom 没收:它起一个全机共享的中转进程(系统 node + tsx,刻意脱离启动它的进程),最后一个会话断开 5 秒后
 *  自己退出;但会话在向它登记之前就关掉时它不会退出。冒烟里每轮会话不到一秒就关,正好撞上,留下了进程。 */
const EXTRA: Pinned[] = [
  { id: "dev:cc-safety-net", name: "cc-safety-net", version: "2.7.14", tools: [], commands: ["cc-safety-net"] },
  { id: "dev:pi-mcp-extension", name: "pi-mcp-extension", version: "1.15.3", tools: ["mcp_status", "mcp_connect"], commands: ["mcp:start"] },
  { id: "dev:pi-plan-mode", name: "@narumitw/pi-plan-mode", version: "0.60.1", tools: ["plan_mode_question", "plan_mode_complete"], commands: ["plan"] },
  { id: "dev:pi-web-search", name: "pi-web-search", version: "1.7.0", tools: ["web_search", "url_context"], commands: [] },
  { id: "dev:pi-simplify", name: "pi-simplify", version: "0.2.3", tools: [], commands: ["simplify"] },
  { id: "dev:pi-btw", name: "pi-btw", version: "0.8.1", tools: [], commands: ["btw"] },
  { id: "dev:pi-powerline-footer", name: "pi-powerline-footer", version: "0.22.0", tools: [], commands: ["powerline"] },
  { id: "dev:pi-usage", name: "@narumitw/pi-usage", version: "0.69.3", tools: [], commands: ["usage"] },
  { id: "dev:plannotator", name: "@plannotator/pi-extension", version: "0.28.66", tools: ["plannotator_submit_plan"], commands: ["plannotator-review"] },
  { id: "dev:ponytail", name: "@dietrichgebert/ponytail", version: "5.3.3", tools: [], commands: ["ponytail"] },
  { id: "dev:pi-memory", name: "pi-memory", version: "0.4.2", tools: ["memory_write", "memory_read", "memory_search"], commands: [] },
  // 工具在 before_agent_start 里才登记(运行期 registerTool),加载时没有。
  { id: "dev:context-mode", name: "context-mode", version: "2.2.0", tools: [], commands: [] },
];

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail !== undefined ? `  →  ${JSON.stringify(detail)?.slice(0, 600)}` : ""}`);
  }
}

function pluginsOf(set: Pinned[], root: string): EnginePlugin[] {
  return set.map(({ id, name, version }) => {
    const path = join(root, name);
    const manifest = join(path, "package.json");
    if (!existsSync(manifest)) {
      const install = root === EXTRA_ROOT ? `(装法:cd ${root}/.. && bun add --omit=peer ${set.map((item) => `${item.name}@${item.version}`).join(" ")})` : "";
      console.error(`插件副本缺席:${path}${install}`);
      process.exit(1);
    }
    const actual = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version;
    check(`版本 ${name}@${version}`, actual === version, { actual });
    return { id, path };
  });
}
const plugins = pluginsOf(HEAD, HEAD_ROOT);
const extraPlugins = pluginsOf(EXTRA, EXTRA_ROOT);

const instructions = { appendSystemPrompt: [], globalAgentsFile: null, skills: { dir: join(scratch, "skills"), enabled: [] } };
mkdirSync(instructions.skills.dir, { recursive: true });

// ---- 一个用例 = 一个工作区 + 一个假上游 + 全部插件,一个会话 ----

interface Harness {
  cwd: string;
  outside: string;
  server: FakeOpenAiSseServer;
  reports: EngineErrorReport[];
  dialogs: EngineDialogCall[];
  notices: EngineUiNoticeCall[];
  approvals: PermissionCheck[];
  pluginToolCalls: string[];
  turnRequests: EngineTurnRequest[];
  answer: (call: EngineDialogCall) => EngineDialogAnswer;
}

const servers: FakeOpenAiSseServer[] = [];
const { shell } = shellAvailability();

/** 对话框默认答法:选第二项;确认 = 是;输入 = 固定文本。 */
function defaultAnswer(call: EngineDialogCall): EngineDialogAnswer {
  if (call.request.kind === "select") return { cancelled: false, value: call.request.options[1] ?? call.request.options[0]! };
  if (call.request.kind === "confirm") return { cancelled: false, value: true };
  return { cancelled: false, value: "smoke" };
}

// ---- 应用这一侧:一个引擎宿主进程,EngineHost 按会话把回调分给各用例 ----

const ourModel = model("fake-model", "Smoke Model");
const harnesses = new Map<string, Harness>();
/** host.report 不带会话:记给当前用例最近建的那个(用例一个接一个跑)。 */
let reportTo: Harness | null = null;
const hostAppErrors: AppErrorDto[] = [];
const protocolErrors: string[] = [];
function harnessOf(conversationId: string): Harness {
  const h = harnesses.get(conversationId);
  if (!h) throw new Error(`没有这个会话的用例:${conversationId}`);
  return h;
}
const appHost: EngineHost = {
  emit: () => undefined,
  session: { load: async () => sessionViewOf([], { model: ourModel }), append: async () => undefined },
  tools: {
    call: async (call) => {
      throw new Error(`冒烟没有应用工具:${call.name}`);
    },
  },
  permission: {
    async check(req) {
      const h = harnessOf(req.conversationId);
      if (req.origin.kind === "plugin") h.pluginToolCalls.push(req.toolName);
      else h.approvals.push(req);
      return { scope: "default" };
    },
  },
  interaction: {
    dialog: async (call) => {
      const h = harnessOf(call.conversationId);
      h.dialogs.push(call);
      return h.answer(call);
    },
    dismiss: () => undefined,
    show: (call) => void harnessOf(call.conversationId).notices.push(call),
  },
  steer: { take: async () => [] },
  turn: { request: (req) => void harnessOf(req.conversationId).turnRequests.push(req) },
  models: {
    credential: async () => {
      throw new Error("冒烟只用 API Key 授权");
    },
    log: () => undefined,
  },
  report: (report) => void reportTo?.reports.push(report),
};
const hostEnv: Record<string, string | undefined> = { ...process.env, NO_PROXY: "127.0.0.1,localhost" };
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete hostEnv[key];
const engineHost = await launchEngineHost({
  host: appHost,
  // 宿主进程装了与主程序同一层网络壳;假上游在回环上,直连
  proxyConfig: { mode: "direct", url: "", username: "", password: "", bypassRules: "", userAgent: "" },
  onAppError: (entry) => void hostAppErrors.push(entry),
  onProtocolError: (reason) => void protocolErrors.push(reason),
  env: hostEnv,
});
const { driver } = engineHost;
console.log(`引擎宿主进程 pid ${engineHost.pid}`);

/** 本用例里建的会话:用例结束时让引擎丢掉它们的长驻会话(插件状态不带到下一个用例)。 */
let scenarioConversations: string[] = [];

async function harness(
  name: string,
  turns: FakeSseTurn[],
  options: { plugins?: EnginePlugin[]; answer?: typeof defaultAnswer } = {},
) {
  const cwd = join(scratch, name, "ws");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "notes.md"), "hello from notes");
  const server = await startFakeOpenAiSse(turns);
  servers.push(server);
  const conversationId = `conv-${name}`;
  const h: Harness = {
    cwd, outside: join(scratch, name, "outside.txt"), server, reports: [], dialogs: [], notices: [], approvals: [], pluginToolCalls: [], turnRequests: [],
    answer: options.answer ?? defaultAnswer,
  };
  harnesses.set(conversationId, h);
  scenarioConversations.push(conversationId);
  reportTo = h;
  const input: TurnInput = {
    model: modelGrantFor(provider({ id: crypto.randomUUID(), name: "Smoke", baseUrl: server.baseUrl, apiKey: "sk-test" }), ourModel, null, conversationId)!,
    reasoningLevel: null,
    workspace: { cwd, root: cwd, ...(shell ? { shell } : {}) },
    instructions,
    plugins: options.plugins ?? plugins,
    prompt: { text: "", images: [] },
    tools: [],
  };
  let seq = 0;
  const turn = (promptText: string) =>
    driver.startTurn({ conversationId, turnId: `${name}-t${++seq}`, input: { ...input, prompt: { text: promptText, images: [] } } });
  const commands = () => driver.listCommands!({ conversationId, plugins: input.plugins, workspace: input.workspace });
  /** 照界面的走法:先列出这个会话的指令,按插件与名字找到调用键,再执行。 */
  const command = async (pluginId: string, commandName: string, args = "") => {
    const found = (await commands()).find((item) => item.source === `plugin:${pluginId}` && item.name === commandName);
    if (!found) throw new Error(`指令不在清单里:${pluginId} /${commandName}`);
    return driver.runCommand!({ conversationId, turnId: `${name}-c${++seq}`, input, commandId: found.id, args });
  };
  return { h, turn, command, commands };
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
    // 插件状态不带到下一个用例
    for (const conversationId of scenarioConversations) await driver.invalidate(conversationId);
    scenarioConversations = [];
  }
}

/** 每个插件单独读一遍登记了什么(插件页走的那条路),固定的工具都在;再全部同时装进一个会话跑一轮:没有加载错误,
 *  固定的指令在这个会话的指令清单里。 */
async function loadScenario(name: string, set: Pinned[], group: EnginePlugin[]) {
  const { h, turn, commands } = await harness(name, [{ content: "装好了" }], { plugins: group });
  const registered = new Map<string, string[]>();
  for (const pinned of set) {
    const inspection = await driver.inspectPlugin!({ plugin: group.find((item) => item.id === pinned.id)! });
    check(`${pinned.id} 单独加载没有错误`, inspection.errors.length === 0, inspection.errors);
    registered.set(pinned.id, inspection.tools.map((tool) => tool.name));
  }
  const result = await turn("装好了吗");
  check(`${group.length} 个插件同时装上跑完一轮`, result.text === "装好了", result.text);
  check("没有加载错误", pluginFailures(h).length === 0, pluginFailures(h));
  const listed = await commands();
  for (const pinned of set) {
    const tools = registered.get(pinned.id) ?? [];
    const names = listed.filter((command) => command.source === `plugin:${pinned.id}`).map((command) => command.name);
    const missing = [...pinned.tools.filter((tool) => !tools.includes(tool)), ...pinned.commands.filter((command) => !names.includes(command))];
    check(`${pinned.id} 的工具与指令`, missing.length === 0, { missing, tools, commands: names });
  }
}

await scenario("加载:八个头部插件同时装上,登记的工具与指令都在", () => loadScenario("load", HEAD, plugins));

await scenario("待办 + 提问:插件工具经审批口执行,提问走应用对话框,答案回到模型;/todos 指令经界面通道通知", async () => {
  const questions = [{ question: "用哪个方案?", header: "方案", options: [{ label: "甲", description: "稳妥" }, { label: "乙", description: "激进" }] }];
  const { h, turn, command } = await harness("todo-ask", [
    { toolCalls: [call("tc-todo-1", "todo", { action: "create", subject: "写冒烟报告" })] },
    { toolCalls: [call("tc-todo-2", "todo", { action: "list" })] },
    { toolCalls: [call("tc-ask-1", "ask_user_question", { questions })] },
    { content: "那就乙" },
  ]);
  const result = await turn("记个待办再问我");
  check("这一轮答完", result.text === "那就乙", result.text);
  check("插件工具都经过审批口", JSON.stringify(h.pluginToolCalls) === JSON.stringify(["todo", "todo", "ask_user_question"]), h.pluginToolCalls);
  check("todo 建出任务", toolResult(h.server, "tc-todo-1") === "Created #1: 写冒烟报告 (pending)", toolResult(h.server, "tc-todo-1"));
  check("todo 列出任务", toolResult(h.server, "tc-todo-2") === "[pending] #1 写冒烟报告", toolResult(h.server, "tc-todo-2"));
  const dialog = h.dialogs.find((item) => item.source === "dev:rpiv-ask-user-question");
  check("提问出现在应用对话框(select,署插件 id)", dialog?.request.kind === "select" && dialog.request.title.includes("用哪个方案?"), h.dialogs);
  check("答案回到模型", toolResult(h.server, "tc-ask-1")?.includes('"用哪个方案?"="乙"') === true, toolResult(h.server, "tc-ask-1"));
  check("没有插件故障", pluginFailures(h).length === 0, pluginFailures(h));

  await command("dev:rpiv-todo", "todos");
  const notice = h.notices.find((item) => item.source === "dev:rpiv-todo" && item.notice.kind === "notify");
  check("/todos 经界面通道通知", notice !== undefined, h.notices);
});

await scenario("权限插件:tool_call 里的询问被吞、裁决作废,写入照常(署名进错误中心)", async () => {
  const { h, turn } = await harness("permission", [
    { toolCalls: [call("tc-w-1", "write", { path: "notes.txt", content: "ok" })] },
    { content: "写完了" },
  ]);
  const result = await turn("写个文件");
  check("这一轮答完", result.text === "写完了", result.text);
  check("文件写进工作区", existsSync(join(h.cwd, "notes.txt")) && readFileSync(join(h.cwd, "notes.txt"), "utf8") === "ok");
  check("写入经工作区审批口", h.approvals.some((req) => req.toolName === "write" && req.category === "write"), h.approvals);
  check("权限插件的对话框没到应用", !h.dialogs.some((item) => item.source === "dev:pi-permission-system"), h.dialogs);
  check("错误中心有 pi_plugin_discarded(权限插件,write)", audits(h, "pi_plugin_discarded").includes("dev:pi-permission-system write"), audits(h, "pi_plugin_discarded"));
  check("没有插件故障", pluginFailures(h).length === 0, pluginFailures(h));
});

await scenario("工具类插件:pi-lens 的钩子不挡读改;mcp 报出服务器状态;fetch_content 拦下内网地址", async () => {
  const { h, turn } = await harness("tools", [
    { toolCalls: [call("tc-read", "read", { path: "notes.md" })] },
    { toolCalls: [call("tc-edit", "edit", { path: "notes.md", edits: [{ oldText: "hello", newText: "hi" }] })] },
    { toolCalls: [call("tc-mcp", "mcp", {})] },
    { toolCalls: [call("tc-fetch", "fetch_content", { url: "http://127.0.0.1:9/" })] },
    { content: "看完了" },
  ]);
  const result = await turn("读改一下文件,再看看 mcp 与网页");
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
  const { h, turn } = await harness(name, turns);
  turns.push({ toolCalls: [spawn(h)] }, ...childTurns(h.cwd, h.outside, name), { content: "完成" });
  const result = await turn("派个子任务");
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

// ---- 补充插件:另一批十二个同时装进一个会话 ----

const BTW_ANSWER = "旁路回答:2";

await scenario("补充插件 · 加载:十二个插件同时装上,登记的工具与指令都在", () => loadScenario("extra-load", EXTRA, extraPlugins));

await scenario("补充插件 · 生成:别家的 tool_call 否决、运行期登记的工具、记忆工具、按模型能力拒绝的搜索", async () => {
  const { h, turn } = await harness(
    "extra-turn",
    [
      { toolCalls: [call("x-env", "read", { path: ".env" })] },
      { toolCalls: [call("x-rm", "bash", { command: "rm -rf ~/rkh-smoke-never" })] },
      { toolCalls: [call("x-read", "read", { path: "notes.md" })] },
      { toolCalls: [call("x-mw", "memory_write", { target: "long_term", content: "smoke fact" })] },
      { toolCalls: [call("x-mr", "memory_read", { target: "long_term" })] },
      { toolCalls: [call("x-mcp", "mcp_status", {})] },
      { toolCalls: [call("x-ws", "web_search", { query: "pi agent" })] },
      { content: "补充一轮完" },
    ],
    { plugins: extraPlugins },
  );
  writeFileSync(join(h.cwd, ".env"), "SECRET=1");
  const result = await turn("跑一圈");
  check("这一轮答完", result.text === "补充一轮完", result.text);
  check("cc-safety-net 否决读 .env(署名)", toolResult(h.server, "x-env")?.startsWith('Blocked by plugin "dev:cc-safety-net"') === true, toolResult(h.server, "x-env"));
  // 应用自己的危险命令表不认这条(删的不是根目录与主目录本身),是插件拦下的。
  check("cc-safety-net 否决工作区外的 rm -rf(署名)", toolResult(h.server, "x-rm")?.startsWith('Blocked by plugin "dev:cc-safety-net"') === true, toolResult(h.server, "x-rm"));
  check("否决记进错误中心", audits(h, "pi_plugin_vetoed").filter((item) => item.startsWith("dev:cc-safety-net")).length === 2, audits(h, "pi_plugin_vetoed"));
  check("普通读取照常", toolResult(h.server, "x-read")?.includes("hello from notes") === true, toolResult(h.server, "x-read"));
  check("pi-memory 写入后读回", toolResult(h.server, "x-mr")?.includes("smoke fact") === true, { write: toolResult(h.server, "x-mw"), read: toolResult(h.server, "x-mr") });
  check("pi-memory 写进(重定向后的)主目录", existsSync(join(process.env.HOME!, ".pi", "agent", "memory", "MEMORY.md")));
  check("pi-mcp-extension 的 mcp_status 给出结果", toolResult(h.server, "x-mcp") !== undefined && !toolResult(h.server, "x-mcp")!.includes("not found"), toolResult(h.server, "x-mcp"));
  check("pi-web-search 对不支持原生搜索的模型拒绝(不联网)", toolResult(h.server, "x-ws")?.includes("does not support native web search") === true, toolResult(h.server, "x-ws"));
  const declared = ((h.server.requests[0]?.tools ?? []) as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
  check("context-mode 在 before_agent_start 里登记的工具进了这一轮", declared.includes("ctx_execute") && declared.includes("ctx_search"), declared);
  check("插件工具都经过审批口", ["memory_write", "memory_read", "mcp_status", "web_search"].every((name) => h.pluginToolCalls.includes(name)), h.pluginToolCalls);
  check("没有插件故障", pluginFailures(h).length === 0, pluginFailures(h));
});

await scenario("补充插件 · 指令:菜单走对话框、模式切换、旁路会话、请求开轮", async () => {
  const turns: FakeSseTurn[] = [{ content: BTW_ANSWER }];
  // 菜单类指令循环弹选择框直到选「关闭」:前两次照默认答,之后取消。
  let menuDialogs = 0;
  const { h, command: run } = await harness("extra-commands", turns, {
    plugins: extraPlugins,
    answer: (dialog) => (++menuDialogs > 2 ? { cancelled: true } : defaultAnswer(dialog)),
  });
  const noticesOf = (pluginId: string) => h.notices.filter((item) => item.source === pluginId).map((item) => item.notice);

  await run("dev:pi-usage", "usage");
  const usageDialog = h.dialogs.find((item) => item.source === "dev:pi-usage");
  check("/usage 的菜单经应用对话框(select,署插件 id)", usageDialog?.request.kind === "select" && usageDialog.request.options.length > 1, h.dialogs);

  await run("dev:pi-plan-mode", "plan", "start");
  check("/plan start 进入计划模式(状态经界面通道)", noticesOf("dev:pi-plan-mode").some((notice) => notice.kind === "status" && notice.text === "plan active"), noticesOf("dev:pi-plan-mode"));
  await run("dev:pi-plan-mode", "plan", "exit");

  await run("dev:pi-simplify", "simplify");
  check("/simplify 在没有改动时提示(不开轮)", noticesOf("dev:pi-simplify").some((notice) => notice.kind === "notify"), noticesOf("dev:pi-simplify"));

  await run("dev:ponytail", "ponytail");
  check("/ponytail 报出当前档位", noticesOf("dev:ponytail").some((notice) => notice.kind === "notify" && notice.message.startsWith("Ponytail:")), noticesOf("dev:ponytail"));

  const requestsBefore = h.server.requests.length;
  await run("dev:pi-btw", "btw", "1+1 等于几?");
  check("/btw 另开旁路会话问了模型", h.server.requests.length === requestsBefore + 1, { requests: h.server.requests.length - requestsBefore });
  check("/btw 的回答经界面通道显示", noticesOf("dev:pi-btw").some((notice) => notice.kind === "notify"), noticesOf("dev:pi-btw"));

  await run("dev:cc-safety-net", "cc-safety-net", "为什么拦我");
  check("/cc-safety-net 以用户消息请求开轮(带说明与提问)", h.turnRequests.some((req) => req.source === "dev:cc-safety-net" && req.prompt?.includes("为什么拦我") === true), h.turnRequests);

  check("没有插件故障", pluginFailures(h).length === 0, pluginFailures(h));
});

check("通道上没有协议问题", protocolErrors.length === 0, protocolErrors);
// 宿主进程里经 reportError 记下的(未捕获异常兜底等)随通道回到这里;插件自己的 info 级记录不算
const hostErrors = hostAppErrors.filter((entry) => entry.severity !== "info");
check("宿主进程没有报出 warn / error", hostErrors.length === 0, hostErrors.map((entry) => `${entry.severity} ${entry.message}`));
await driver.dispose();
await engineHost.stop();
const exit = await engineHost.exited;
check("关掉通道后宿主进程自己以 0 退出", exit.exitCode === 0, exit);
await Promise.all(servers.map((server) => server.close()));
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
