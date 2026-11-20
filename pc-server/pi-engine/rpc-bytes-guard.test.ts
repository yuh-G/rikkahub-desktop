// pi-engine/rpc-bytes-guard.test.ts — 跨进程字节守卫(P7.2.4,方案 §5.14.8 验收第 2 条)
//
// 真 pi 驱动经 rpc-transport 连到假宿主(两端在内存里对接,线上就是将来走管道的那些文字),跑三个固定场景,统计
// 线上实际字节数,超过「这一轮新增内容」的若干倍即失败:①长历史的第二轮(会话视图对账、请求正文差分);②流式写
// 一个 100 KB 的文件(参数后缀、建卡不重带);③输出很多的命令(执行中的输出只传新增)。同时核对不整形时的字节数
// 确实是新增内容的几十倍以上,证明场景真的走到了累计路径。以后谁再加一种全量发送的消息,会被它拦住。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-rpc-bytes-"));

const { connectDriverOverRpc, serveDriverOverRpc } = await import("../engines/rpc-transport");
const { modelGrantFor } = await import("../engines/model-grant");
const { message } = await import("../foundation/utils");
const { model, provider } = await import("../model-providers");
const { startFakeOpenAiSse } = await import("../test-utils/fake-openai-sse");
const { shellAvailability } = await import("../workspace/runtime");
const { createPiDriver } = await import("./driver");

import type { EngineDriver, EngineHost, EngineSessionItem, EngineSessionView, TurnInput } from "../engines/contract";
import type { FakeOpenAiSseServer, FakeSseTurn } from "../test-utils/fake-openai-sse";

const servers: FakeOpenAiSseServer[] = [];
const drivers: EngineDriver[] = [];
afterAll(async () => {
  await Promise.all(drivers.map((driver) => driver.dispose()));
  await Promise.all(servers.map((server) => server.close()));
});

const lab = mkdtempSync(join(tmpdir(), "rkh-rpc-bytes-lab-"));
const cwd = join(lab, "ws");
mkdirSync(cwd, { recursive: true });
const skillsDir = join(lab, "skills");
mkdirSync(skillsDir, { recursive: true });
const shell = shellAvailability().shell;

/** 线上字节(两个方向合计)与「不整形、不合并时 host.emit 本该发的字节」。 */
interface Meter {
  wire: number;
  rawEmit: number;
}

function harness(view: () => EngineSessionView) {
  const meter: Meter = { wire: 0, rawEmit: 0 };
  const protocolErrors: string[] = [];
  const host: EngineHost = {
    emit: () => undefined,
    session: { load: async () => view(), append: async () => undefined },
    tools: {
      call: async () => {
        throw new Error("本测试没有应用工具");
      },
    },
    permission: { check: async () => ({ scope: "default" }) },
    interaction: { dialog: async () => ({ cancelled: true }), dismiss: () => undefined, show: () => undefined },
    steer: { take: async () => [] },
    turn: { request: () => undefined },
    models: { credential: async () => ({}), log: () => undefined },
    report: () => undefined,
  };
  let toEngine: (line: string) => void = () => {};
  const app = connectDriverOverRpc(
    (line) => {
      meter.wire += line.length;
      queueMicrotask(() => toEngine(line));
    },
    host,
    (reason) => void protocolErrors.push(reason),
  );
  const engine = serveDriverOverRpc(
    (line) => {
      meter.wire += line.length;
      queueMicrotask(() => app.receive(line));
    },
    (rpcHost) =>
      createPiDriver({
        ...rpcHost,
        emit: (turn, event) => {
          meter.rawEmit += JSON.stringify([turn, event]).length;
          rpcHost.emit(turn, event);
        },
      }),
    (reason) => void protocolErrors.push(reason),
  );
  toEngine = (line) => engine.receive(line);
  return { ready: app.ready.then((driver) => (drivers.push(driver), driver)), meter, protocolErrors };
}

async function upstream(turns: FakeSseTurn[]) {
  const server = await startFakeOpenAiSse(turns);
  servers.push(server);
  return server;
}

function inputFor(server: FakeOpenAiSseServer, conversationId: string, text: string, withShell = false): TurnInput {
  return {
    model: modelGrantFor(provider({ id: crypto.randomUUID(), name: "Bytes", baseUrl: server.baseUrl, apiKey: "sk-test" }), model("fake-model", "Fake"), null, conversationId)!,
    reasoningLevel: null,
    workspace: { cwd, root: cwd, ...(withShell && shell ? { shell } : {}) },
    instructions: { appendSystemPrompt: [], globalAgentsFile: null, skills: { dir: skillsDir, enabled: [] } },
    plugins: [],
    prompt: { text, images: [] },
    tools: [],
  };
}

const userItem = (text: string): EngineSessionItem => ({ message: message("USER", [{ type: "text", text }]), synthetic: false, input: { text, images: [] } });
const aiItem = (text: string): EngineSessionItem => ({ message: message("ASSISTANT", [{ type: "text", text }], "fake-model"), synthetic: false });

async function measured(meter: Meter, run: () => Promise<unknown>) {
  const before = { ...meter };
  await run();
  // 合并窗口里攒着的最后一批随结果一起发,等一拍让通道静下来。
  await Bun.sleep(30);
  return { wire: meter.wire - before.wire, rawEmit: meter.rawEmit - before.rawEmit };
}

describe("跨进程字节守卫", () => {
  test("长历史:第一轮整份传视图;第二轮只多传新增的两条与指纹清单,请求正文只传差分", async () => {
    const conversationId = "conv-bytes-history";
    const items: EngineSessionItem[] = [];
    for (let i = 0; i < 75; i += 1) items.push(userItem(`第${i}个问题:` + "问".repeat(600)), aiItem(`第${i}个回答:` + "答".repeat(1400)));
    const historyChars = JSON.stringify(items).length;
    let view: EngineSessionView = { items, compactions: [] };
    const { ready, meter, protocolErrors } = harness(() => view);
    const driver = await ready;
    const first = await upstream([{ content: "第一轮回答" }]);
    const turn1 = await measured(meter, () => driver.startTurn({ conversationId, turnId: "t1", input: inputFor(first, conversationId, "新问题一") }));
    expect(turn1.wire).toBeGreaterThan(historyChars);

    const added = [userItem("新问题一"), aiItem("第一轮回答")];
    view = { items: [...items, ...added], compactions: [] };
    const second = await upstream([{ content: "第二轮回答" }]);
    const turn2 = await measured(meter, () => driver.startTurn({ conversationId, turnId: "t2", input: inputFor(second, conversationId, "新问题二") }));
    // 新增内容只有几百字;宿主侧的指纹清单 150 条 × 约 35 字,应用侧回的是「清单第几条起连续几条」;其余是这一轮
    // 固定的请求与事件外壳。
    expect(turn2.wire).toBeLessThan(historyChars / 20);
    expect(protocolErrors).toEqual([]);
  }, 30_000);

  test("流式写 100 KB 的文件:线上是文件内容的几倍,不整形时是几百倍", async () => {
    const conversationId = "conv-bytes-write";
    const content = "写入的内容".repeat(100 * 1024 / 15);
    const args = JSON.stringify({ path: "big.txt", content });
    const { ready, meter, protocolErrors } = harness(() => ({ items: [], compactions: [] }));
    const driver = await ready;
    const server = await upstream([
      { toolCalls: [{ id: "tc-big", name: "write", arguments: args }], argumentFrames: 1000 },
      { content: "写好了" },
    ]);
    const run = await measured(meter, () => driver.startTurn({ conversationId, turnId: "t-write", input: inputFor(server, conversationId, "写个大文件") }));
    // 新增内容 = 参数本身;它合理地出现在参数流、结果后的第二次请求正文与交回的原生条目里。
    expect(run.wire).toBeLessThan(args.length * 5);
    expect(run.rawEmit).toBeGreaterThan(args.length * 100);
    expect(protocolErrors).toEqual([]);
  }, 60_000);

  test.skipIf(!shell)("输出很多的命令:执行中的输出只传新增,滚动截断后也是", async () => {
    const conversationId = "conv-bytes-noisy";
    const command = 'for ((i=1;i<=40;i++)); do for ((j=1;j<=80;j++)); do echo "batch $i line $j ................"; done; sleep 0.05; done';
    const { ready, meter, protocolErrors } = harness(() => ({ items: [], compactions: [] }));
    const driver = await ready;
    const server = await upstream([
      { toolCalls: [{ id: "tc-noisy", name: "bash", arguments: JSON.stringify({ command }) }] },
      { content: "跑完了" },
    ]);
    const run = await measured(meter, () =>
      driver.startTurn({ conversationId, turnId: "t-noisy", input: inputFor(server, conversationId, "跑个命令", true) }),
    );
    let output = "";
    for (let i = 1; i <= 40; i += 1) for (let j = 1; j <= 80; j += 1) output += `batch ${i} line ${j} ................\n`;
    // 新增内容 = 命令的全部输出;终局结果(pi 截到 50 KB)另在结果、第二次请求正文与原生条目里各出现一次。
    expect(run.wire).toBeLessThan(output.length * 4);
    expect(run.rawEmit).toBeGreaterThan(run.wire * 2);
    expect(protocolErrors).toEqual([]);
  }, 60_000);
});
