// scripts/engine-contract-smoke.ts — 契约跨进程证明(方案 §5.3 不变式 3,P2.6)
//   bun run smoke:engine-contract      (在 pc-server 目录下)
//
// 父进程扮演应用:起假供应商,把 pi 驱动拉进子进程(pi-engine/host-process.ts),经 stdio 行帧
// (engines/stdio-transport)连上,自己实现 EngineHost。跑两轮:
//   1. 工具调用 → 待审批(子进程的工具执行挂在跨进程的 host.tools.call 上,父进程在真实审批门
//      inference-engine/approval-gate 登记等待)→ 批准 → 轮边界取补发 → 结束;
//   2. 工具调用待审批时中止:父进程先收敛自己的审批等待(应用以生成信号做同一件事),再 driver.abort。
// 断言事件带轮次身份、补发进了下一次模型请求、模型请求日志经 host.models.log 回到父进程。
// 生产不走这条路;它证明「同进程 / 独立进程」只是部署选择(方案 D9)。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  AppToolCall,
  EngineHost,
  EngineInstructions,
  ModelGrant,
  ModelRequestRecord,
  TurnInput,
  TurnRef,
} from "../engines/contract";
import { connectDriverOverStdio } from "../engines/stdio-transport";
import type { GenerationEvent } from "../inference-engine/events";
import { pendingToolApprovalCount, resolveToolApproval, waitForToolApproval } from "../inference-engine/approval-gate";
import { spawnSubprocess } from "../subprocess-engine/process";
import { createLineFramer } from "../subprocess-engine/protocol";
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

const serverDir = resolve(import.meta.dir, "..");
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
  promptCache: { enabled: false, retention: "short" },
  userAgent: "RikkaHub-ContractSmoke/1.0",
};
const instructions: EngineInstructions = { appendSystemPrompt: [], globalAgentsFile: null, skills: { dir: skillsDir, enabled: [] } };
const writeNote: TurnInput["tools"][number] = {
  name: "write_note",
  description: "记一条笔记",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  group: "general",
};

function inputFor(prompt: string): TurnInput {
  return {
    model: grant,
    reasoningLevel: null,
    workspace: { cwd: workspaceRoot, root: workspaceRoot },
    instructions,
    history: { messages: [], syntheticIds: [], compactions: [], userInputs: {} },
    prompt: { text: prompt, images: [] },
    tools: [writeNote],
  };
}

// ── 父进程的 EngineHost:审批走真实审批门,中止由每轮的生成信号收敛 ────────────────
const events: Array<{ turn: TurnRef; event: GenerationEvent }> = [];
const toolCalls: AppToolCall[] = [];
const steerTakes: TurnRef[] = [];
const requestLogs: Array<{ turn: TurnRef; record: ModelRequestRecord }> = [];
const signals = new Map<string, AbortController>();
let steerQueue: string[] = [];

const host: EngineHost = {
  emit: (turn, event) => void events.push({ turn, event }),
  tools: {
    async call(call) {
      toolCalls.push(call);
      const decision = await waitForToolApproval(call.conversationId, call.toolCallId, signals.get(call.turnId)?.signal);
      if (!decision.approved) throw new Error(`用户拒绝:${decision.reason ?? ""}`);
      return { content: [{ type: "text", text: `已记录:${String(call.args.text)}` }] };
    },
  },
  steer: {
    async take(turn) {
      steerTakes.push(turn);
      const taken = steerQueue;
      steerQueue = [];
      return taken;
    },
  },
  models: {
    credential: async () => {
      throw new Error("冒烟只用 API Key 授权");
    },
    log: (turn, record) => void requestLogs.push({ turn, record }),
  },
  report: (report) => console.error(`[host.report] ${report.severity} ${report.message}`),
};

// ── 拉起子进程并握手 ─────────────────────────────────────────────────────────────
const stderrLines: string[] = [];
let handleRef: ReturnType<typeof spawnSubprocess> | undefined;
const connection = connectDriverOverStdio(
  (line) => void handleRef?.writeLine(line),
  host,
  (reason) => stderrLines.push(`[protocol] ${reason}`),
);
const framer = createLineFramer((frame) => {
  if (frame.type === "line") connection.receive(frame.text);
  else stderrLines.push(`[framer] ${frame.reason}`);
});
const child = spawnSubprocess({
  cmd: process.execPath,
  args: ["run", "pi-engine/host-process.ts"],
  cwd: serverDir,
  env: {
    RIKKAHUB_PC_DATA_DIR: join(scratch, "pc-data"),
    // 子进程不装 foundation/net 的代理壳:回环请求不能被宿主机的代理环境变量劫持。
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    ALL_PROXY: "",
    all_proxy: "",
    NO_PROXY: "127.0.0.1,localhost",
  },
  displayName: "pi 引擎宿主进程",
  onStdoutChunk: (chunk) => framer.feed(chunk),
  onStderrChunk: (chunk) => stderrLines.push(Buffer.from(chunk).toString("utf8").trimEnd()),
});
handleRef = child;
void child.exited.then((info) => {
  framer.flush();
  connection.close(`子进程退出:${info.kind}`);
});

try {
  const driver = await Promise.race([
    connection.ready,
    Bun.sleep(30_000).then(() => {
      throw new Error("子进程 30s 内未握手");
    }),
  ]);
  console.log(`engine-contract smoke — 子进程 pid ${child.pid},驱动 ${driver.kind}(${driver.capabilities.placement})`);
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
    await waitUntil(() => requestLogs.length >= 2, "两条模型请求日志");
    check("模型请求日志经 host.models.log 回到父进程(带授权身份,流式不读体)",
      requestLogs.every(({ turn: logTurn, record }) => logTurn.turnId === turn.turnId && record.ok && record.status === 200
        && record.providerName === grant.providerName && record.responseBody === undefined),
      requestLogs.map((item) => item.record));
    signals.delete(turn.turnId);
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
} catch (err) {
  failures++;
  console.error(`FAIL  ${err instanceof Error ? err.message : String(err)}`);
} finally {
  child.kill();
  const exit = await child.exited;
  await upstream.close();
  rmSync(scratch, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`子进程退出:${exit.kind};stderr 尾部:\n${stderrLines.slice(-40).join("\n")}`);
  }
}

if (failures > 0) {
  console.error(`\nengine-contract smoke: ${failures} 项失败`);
  process.exit(1);
}
console.log("\nengine-contract smoke: 全部通过");
