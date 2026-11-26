// scripts/engine-contract-smoke.ts — 契约跨进程证明(方案 §5.3 不变式 3,P2.6)
//   bun run smoke:engine-contract      (在 pc-server 目录下)
//
// 父进程扮演应用:起假供应商,经 subprocess-engine/host-launch 把 pi 驱动拉进引擎宿主进程(spawnSelf("engine-host"),
// 专用通道 + 长度前缀帧,与生产同一条路),自己实现 EngineHost。跑两轮:
//   1. 工具调用 → 待审批(子进程的工具执行挂在跨进程的 host.tools.call 上,父进程在真实审批门
//      inference-engine/approval-gate 登记等待)→ 批准 → 轮边界取补发 → 结束;
//   2. 工具调用待审批时中止:父进程先收敛自己的审批等待(应用以生成信号做同一件事),再 driver.abort。
// 另读一次插件登记了什么(inspectPlugin,P7.2.5):插件代码在宿主进程里执行,主程序只收到清单。
// 宿主进程以手动代理启动:插件在加载时读到的代理环境变量就是宿主镜像的结果(syncProxyEnvToProcess),改设置推过去后跟着变。
// 断言事件带轮次身份、补发进了下一次模型请求、模型请求日志与 pi 原生条目(P3.4)经 host 回到父进程。
// 生产不走这条路;它证明「同进程 / 独立进程」只是部署选择(方案 D9)。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AppToolCall,
  EngineEntryInput,
  EngineHost,
  EngineInstructions,
  ModelGrant,
  ModelRequestRecord,
  TurnInput,
  TurnRef,
} from "../engines/contract";
import type { GenerationEvent } from "../inference-engine/events";
import { pendingToolApprovalCount, resolveToolApproval, waitForToolApproval } from "../inference-engine/approval-gate";
import type { ProxyConfig } from "../foundation/types";
import { launchEngineHost } from "../subprocess-engine/host-launch";
import { startFakeOpenAiSse } from "../test-utils/fake-openai-sse";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail !== undefined ? `  →  ${JSON.stringify(detail)}` : ""}`);
  }
}

async function waitUntil(cond: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时:${label}`);
    await Bun.sleep(10);
  }
}

const scratch = mkdtempSync(join(tmpdir(), "rkh-engine-contract-"));
const workspaceRoot = mkdtempSync(join(scratch, "ws-"));
const skillsDir = mkdtempSync(join(scratch, "skills-"));

const upstream = await startFakeOpenAiSse([
  // 第一轮:工具调用 → 批准后带补发续采样。
  { toolCalls: [{ id: "tc-approve", name: "write_note", arguments: JSON.stringify({ text: "跨进程" }) }] },
  { content: "已记下,也看到了补发" },
  // 第二轮:工具调用挂在审批上时中止;续采样不应发生。
  { toolCalls: [{ id: "tc-abort", name: "write_note", arguments: JSON.stringify({ text: "不会执行" }) }] },
  { content: "不应到达" },
]);

const grant: ModelGrant = {
  providerId: "smoke-provider",
  providerName: "契约冒烟供应商",
  protocol: "openai-completions",
  baseUrl: upstream.baseUrl,
  modelId: "fake-model",
  displayName: "Fake",
  reasoning: false,
  imageInput: false,
  limits: { contextWindow: 128_000, maxTokens: 8_192 },
  headers: {},
  credential: { kind: "api-key", apiKey: "sk-smoke" },
  promptCache: { enabled: false, retention: "short", warming: false },
  userAgent: "RikkaHub-ContractSmoke/1.0",
};
const instructions: EngineInstructions = { appendSystemPrompt: [], globalAgentsFile: null, skills: { dir: skillsDir, enabled: [] } };
const writeNote: TurnInput["tools"][number] = {
  name: "write_note",
  description: "记一条笔记",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

function inputFor(prompt: string): TurnInput {
  return {
    model: grant,
    reasoningLevel: null,
    workspace: { cwd: workspaceRoot, root: workspaceRoot },
    instructions,
    plugins: [],
    prompt: { text: prompt, images: [] },
    tools: [writeNote],
  };
}

// ── 父进程的 EngineHost:审批走真实审批门,中止由每轮的生成信号收敛 ────────────────
const events: Array<{ turn: TurnRef; event: GenerationEvent }> = [];
const toolCalls: AppToolCall[] = [];
const steerTakes: TurnRef[] = [];
const appendedEntries: Array<{ turn: TurnRef; entries: EngineEntryInput[] }> = [];
const requestLogs: Array<{ turn: TurnRef; record: ModelRequestRecord }> = [];
const signals = new Map<string, AbortController>();
let steerQueue: string[] = [];

const host: EngineHost = {
  emit: (turn, event) => void events.push({ turn, event }),
  session: {
    load: async () => ({ items: [], compactions: [] }),
    append: async (turn, entries) => void appendedEntries.push({ turn, entries }),
  },
  tools: {
    async call(call) {
      toolCalls.push(call);
      const decision = await waitForToolApproval(call.conversationId, call.toolCallId, signals.get(call.turnId)?.signal);
      if (!decision.approved) throw new Error(`用户拒绝:${decision.reason ?? ""}`);
      return { content: [{ type: "text", text: `已记录:${String(call.args.text)}` }] };
    },
  },
  permission: {
    async check() {
      throw new Error("冒烟不调用插件工具与引擎自带工具");
    },
  },
  interaction: {
    dialog: async () => ({ cancelled: true }),
    dismiss: () => undefined,
    show: () => undefined,
  },
  steer: {
    async take(turn) {
      steerTakes.push(turn);
      const taken = steerQueue;
      steerQueue = [];
      return taken;
    },
  },
  turn: { request: () => undefined },
  models: {
    credential: async () => {
      throw new Error("冒烟只用 API Key 授权");
    },
    log: (turn, record) => void requestLogs.push({ turn, record }),
  },
  report: (report) => console.error(`[host.report] ${report.severity} ${report.message}`),
};

// ── 拉起引擎宿主进程并握手(与生产同一条路:spawnSelf + 专用通道)─────────────────────
const protocolErrors: string[] = [];
const hostErrors: string[] = [];
const childEnv: Record<string, string | undefined> = {
  ...process.env,
  RIKKAHUB_PC_DATA_DIR: join(scratch, "pc-data"),
  NO_PROXY: "127.0.0.1,localhost",
};
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete childEnv[key];
// 记数的假代理:假供应商在回环上,宿主的壳对回环一律直连,整场下来它一个请求都不该收到
let proxyHits = 0;
const fakeProxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => (proxyHits++, new Response("via-proxy")) });
const fakeProxyPort = fakeProxy.port ?? 0;
const proxyAt = (port: number) => `http://127.0.0.1:${port}`;
const manualProxy = (url: string): ProxyConfig => ({ mode: "manual", url, username: "", password: "", bypassRules: "smoke.invalid", userAgent: "" });
const child = await launchEngineHost({
  host,
  proxyConfig: manualProxy(proxyAt(fakeProxyPort)),
  onAppError: (entry) => void hostErrors.push(`${entry.severity} ${entry.message}`),
  onProtocolError: (reason) => void protocolErrors.push(reason),
  env: childEnv,
});

try {
  const driver = child.driver;
  console.log(`engine-contract smoke — 引擎宿主进程 pid ${child.pid},驱动 ${driver.kind}(${driver.capabilities.placement})`);
  check("握手:能力声明跨进程到达", driver.kind === "pi" && driver.capabilities.placement === "portable"
    && driver.capabilities.resumeSemantics === "run-and-suspend" && typeof driver.compact === "function");

  // ── 第一轮:工具 → 待审批 → 批准 → 补发 → 结束 ─────────────────────────────────
  {
    const turn: TurnRef = { conversationId: "conv-smoke-1", turnId: "turn-smoke-1" };
    signals.set(turn.turnId, new AbortController());
    const run = driver.startTurn({ ...turn, input: inputFor("记一条笔记") });
    await waitUntil(() => pendingToolApprovalCount() === 1, "工具调用挂到审批门");
    check("工具调用跨进程到达,带轮次身份与参数", toolCalls.length === 1
      && toolCalls[0]!.turnId === turn.turnId && toolCalls[0]!.toolCallId === "tc-approve" && toolCalls[0]!.args.text === "跨进程",
    toolCalls);
    check("待审批期间生成保持在跑(run-and-suspend):上游只收到一个请求", upstream.requests.length === 1);
    steerQueue = ["顺便补一句:跨进程补发"];
    check("用户批准唤醒在途等待者", resolveToolApproval(turn.conversationId, "tc-approve", { approved: true }));
    const result = await run;
    check("轮次正常结束,返回终局文本", result.text === "已记下,也看到了补发", result);
    const secondRequest = JSON.stringify(upstream.requests[1]?.messages ?? []);
    check("工具结果进了下一次模型请求", secondRequest.includes("已记录:跨进程"));
    check("补发在轮边界被取走并注入下一次模型请求", secondRequest.includes("跨进程补发") && steerTakes.length >= 1);
    check("事件全部带本轮身份", events.length > 0 && events.every((item) => item.turn.turnId === turn.turnId));
    check("流式文本事件跨进程到达", events.some((item) => item.event.kind === "text_delta"));
    const firstTurnEntries = appendedEntries.filter((item) => item.turn.turnId === turn.turnId).flatMap((item) => item.entries);
    check("原生条目经 host.session.append 回到父进程(助手消息与工具结果,带格式版本与条目 id)",
      firstTurnEntries.length > 0
        && firstTurnEntries.every((entry) => typeof entry.format === "string" && typeof entry.entryId === "string")
        && JSON.stringify(firstTurnEntries).includes("已记录:跨进程")
        && JSON.stringify(firstTurnEntries).includes("已记下,也看到了补发"),
      firstTurnEntries);
    await waitUntil(() => requestLogs.length >= 2, "两条模型请求日志");
    check("模型请求日志经 host.models.log 回到父进程(带授权身份,流式不读体)",
      requestLogs.every(({ turn: logTurn, record }) => logTurn.turnId === turn.turnId && record.ok && record.status === 200
        && record.providerName === grant.providerName && record.responseBody === undefined),
      requestLogs.map((item) => item.record));
    signals.delete(turn.turnId);
  }

  // ── 插件登记了什么:在宿主进程里加载插件 ─────────────────────────────────────────
  {
    const pluginFile = join(scratch, "peek-plugin.ts");
    writeFileSync(pluginFile, `export default function (pi) {
  pi.registerTool({ name: "peek", label: "peek", description: "看一眼", parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; } });
  pi.registerCommand("todos", { description: "待办", handler: async () => {} });
}
`);
    const inspection = await driver.inspectPlugin!({ plugin: { id: "dev:peek", path: pluginFile } });
    check("inspectPlugin 跨进程:宿主进程加载插件,交回工具与指令清单",
      JSON.stringify(inspection.tools) === JSON.stringify([{ name: "peek", description: "看一眼" }])
        && inspection.commands.map((item) => item.name).join() === "todos" && inspection.errors.length === 0,
      inspection);
  }

  // ── 宿主把生效代理镜像进环境变量:插件加载时读到的就是它,改设置推过去后跟着变 ───────────────────
  {
    const pluginFile = join(scratch, "env-peek-plugin.ts");
    writeFileSync(pluginFile, `import https from "node:https";
export default function (pi) {
  const seen = {
    hp: process.env.HTTPS_PROXY ?? null,
    np: process.env.NO_PROXY ?? null,
    agent: Boolean(https.globalAgent.options?.proxyEnv),
  };
  pi.registerCommand("env-peek", { description: JSON.stringify(seen), handler: async () => {} });
}
`);
    const peek = async () => {
      const inspection = await driver.inspectPlugin!({ plugin: { id: "dev:env-peek", path: pluginFile } });
      const description = inspection.commands.find((item) => item.name === "env-peek")?.description ?? "{}";
      return JSON.parse(description) as { hp: string | null; np: string | null; agent: boolean };
    };
    const atLaunch = await peek();
    check("宿主镜像(启动行):插件读到 HTTPS_PROXY = 设置里的代理,NO_PROXY 含回环与用户名单,node:https 全局 Agent 已换",
      atLaunch.hp === proxyAt(fakeProxyPort) && atLaunch.np === "localhost,127.0.0.1,::1,smoke.invalid" && atLaunch.agent, atLaunch);
    child.pushProxyConfig(manualProxy(proxyAt(fakeProxyPort + 1)));
    const afterChange = await peek();
    check("宿主镜像(改设置推送):下一次加载读到新地址", afterChange.hp === proxyAt(fakeProxyPort + 1) && afterChange.agent, afterChange);
    child.pushProxyConfig({ mode: "direct", url: "", username: "", password: "", bypassRules: "", userAgent: "" });
    const afterDirect = await peek();
    check("宿主镜像(切直连):代理环境变量清空,全局 Agent 还原", afterDirect.hp === null && afterDirect.np === null && !afterDirect.agent, afterDirect);
  }

  // ── 第二轮:待审批时中止 ─────────────────────────────────────────────────────────
  {
    const turn: TurnRef = { conversationId: "conv-smoke-2", turnId: "turn-smoke-2" };
    const controller = new AbortController();
    signals.set(turn.turnId, controller);
    const before = upstream.requests.length;
    const run = driver.startTurn({ ...turn, input: inputFor("再记一条") });
    await waitUntil(() => pendingToolApprovalCount() === 1, "第二轮工具调用挂到审批门");
    // 应用的中止顺序:生成信号先收敛在途审批(卡转 denied),再经 callEngineDriver 转成 driver.abort。
    controller.abort();
    await driver.abort(turn.conversationId, "interrupted");
    const result = await run;
    check("中止后轮次正常返回,stopReason=aborted", result.stopReason === "aborted", result);
    check("中止后没有续采样:上游只多收到一个请求", upstream.requests.length - before === 1);
    check("审批等待已收敛", pendingToolApprovalCount() === 0);
    signals.delete(turn.turnId);
  }

  await driver.dispose();
  check("通道上没有协议问题", protocolErrors.length === 0, protocolErrors);
  check("回环上的假供应商不经代理:假代理一个请求都没收到", proxyHits === 0, { proxyHits });
} catch (err) {
  failures++;
  console.error(`FAIL  ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await child.stop();
  const exit = await child.exited;
  check("关掉通道后宿主进程自己以 0 退出", exit.exitCode === 0, exit);
  await upstream.close();
  fakeProxy.stop(true);
  rmSync(scratch, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`宿主进程退出码 ${String(exit.exitCode ?? exit.signal)};转来的错误 ${JSON.stringify(hostErrors)};stderr 尾部:\n${exit.stderrTail}`);
  }
}

if (failures > 0) {
  console.error(`\nengine-contract smoke: ${failures} 项失败`);
  process.exit(1);
}
console.log("\nengine-contract smoke: 全部通过");
