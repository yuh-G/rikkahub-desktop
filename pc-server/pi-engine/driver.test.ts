// pi-engine/driver.test.ts — pi 驱动经回环传输(strict:每个载荷 JSON 往返)跑契约
//
// 锁定:①一轮生成只经 EngineHost 拿应用的东西——事件带 TurnRef、工具调用带 turnId 回到
// host.tools.call、轮边界 await host.steer.take 后注入下一次请求;②abort(conversationId)
// 中止在途轮次,轮次正常返回已生成部分;③压缩的摘要模型映射不进 pi 时经 host.report 报 warn
// 并回退会话模型;pi 的已知压缩错误以 CodedError 穿过传输(前端按 errorCode 查文案);④模型请求
// 经模型出口发出,每条请求的日志记录带 TurnRef 经 host.models.log 回到应用。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodedError } from "../foundation/errors";
import { message } from "../foundation/utils";
import type { GenerationEvent } from "../inference-engine/events";
import type {
  AppToolCall,
  AppToolResult,
  EngineErrorReport,
  EngineHost,
  EngineInstructions,
  EngineSessionView,
  ModelRequestRecord,
  TurnInput,
  TurnRef,
} from "../engines/contract";
import { connectDriver, connectHost } from "../engines/loopback";
import { modelGrantFor } from "../engines/model-grant";
import { model, provider } from "../model-providers";
import { startFakeOpenAiSse, type FakeOpenAiSseServer, type FakeSseTurn } from "../test-utils/fake-openai-sse";
import { createPiDriver } from "./driver";

const servers: FakeOpenAiSseServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

const root = mkdtempSync(join(tmpdir(), "pi-driver-"));
const instructions: EngineInstructions = {
  appendSystemPrompt: [],
  globalAgentsFile: null,
  skills: { dir: mkdtempSync(join(tmpdir(), "pi-driver-skills-")), enabled: [] },
};

interface HostLog {
  events: Array<{ turn: TurnRef; event: GenerationEvent }>;
  sessionLoads: TurnRef[];
  toolCalls: AppToolCall[];
  steerTakes: TurnRef[];
  reports: EngineErrorReport[];
  requests: Array<{ turn: TurnRef; record: ModelRequestRecord }>;
}

function fakeHost(options: { steer?: () => string[]; tool?: (call: AppToolCall) => Promise<AppToolResult>; view?: EngineSessionView } = {}) {
  const log: HostLog = { events: [], sessionLoads: [], toolCalls: [], steerTakes: [], reports: [], requests: [] };
  const host: EngineHost = {
    emit: (turn, event) => void log.events.push({ turn, event }),
    session: {
      load: async (turn) => {
        log.sessionLoads.push(turn);
        return options.view ?? { items: [], compactions: [] };
      },
      append: async () => undefined,
    },
    tools: {
      call: async (call) => {
        log.toolCalls.push(call);
        return options.tool ? options.tool(call) : { content: [{ type: "text", text: "查到了" }] };
      },
    },
    steer: {
      take: async (turn) => {
        log.steerTakes.push(turn);
        return options.steer?.() ?? [];
      },
    },
    models: {
      credential: async () => ({}),
      log: (turn, record) => void log.requests.push({ turn, record }),
    },
    report: (report) => void log.reports.push(report),
  };
  return { host, log };
}

function strictDriver(host: EngineHost) {
  return connectDriver(createPiDriver(connectHost(host, { strict: true })), { strict: true });
}

async function upstream(turns: FakeSseTurn[]) {
  const server = await startFakeOpenAiSse(turns);
  servers.push(server);
  return server;
}

function grantFor(server: FakeOpenAiSseServer, modelId = "fake-model", extra: Record<string, unknown> = {}) {
  const ourProvider = provider({ id: crypto.randomUUID(), name: "Driver Provider", baseUrl: server.baseUrl, apiKey: "sk-test", ...extra });
  return modelGrantFor(ourProvider, model(modelId, modelId), null, "conv-driver")!;
}

function inputFor(server: FakeOpenAiSseServer, prompt: string, tools: TurnInput["tools"] = []): TurnInput {
  return {
    model: grantFor(server),
    reasoningLevel: null,
    workspace: { cwd: root, root },
    instructions,
    prompt: { text: prompt, images: [] },
    tools,
  };
}

const lookupTool: TurnInput["tools"][number] = {
  name: "lookup",
  description: "查资料",
  parameters: { type: "object", properties: { q: { type: "string" } } },
  group: "general",
};

describe("pi 驱动 × 契约(strict 回环)", () => {
  test("一轮生成:事件带 TurnRef,工具调用回到 host.tools.call,轮边界取补发并注入下一次请求", async () => {
    let pending: string[] = [];
    const server = await upstream([
      {
        toolCalls: [{ id: "tc-1", name: "lookup", arguments: JSON.stringify({ q: "天气" }) }],
        beforeRespond: () => {
          pending = ["顺便看看明天"];
        },
      },
      { content: "今天晴,明天多云" },
    ]);
    const { host, log } = fakeHost({
      steer: () => {
        const taken = pending;
        pending = [];
        return taken;
      },
    });
    const turn = { conversationId: "conv-driver-1", turnId: "turn-1" };
    const result = await strictDriver(host).startTurn({ ...turn, input: inputFor(server, "查天气", [lookupTool]) });

    expect(result.text).toBe("今天晴,明天多云");
    expect(result.compactions).toEqual([]);
    expect(log.toolCalls).toEqual([{ ...turn, toolCallId: "tc-1", name: "lookup", args: { q: "天气" } }]);
    expect(log.events.length).toBeGreaterThan(0);
    expect(log.events.every((item) => item.turn.turnId === "turn-1" && item.turn.conversationId === "conv-driver-1")).toBe(true);
    // 每个 turn_end 取一次:工具轮之后(取走补发)+ 最终轮之后(空)。
    expect(log.steerTakes).toEqual([turn, turn]);
    const secondRequest = JSON.stringify(server.requests[1]?.messages);
    expect(secondRequest).toContain("查到了");
    expect(secondRequest).toContain("顺便看看明天");
    // 两次模型请求各一条日志,身份取自授权,流式响应不读体。
    await Bun.sleep(10);
    expect(log.requests.map((item) => item.turn)).toEqual([turn, turn]);
    for (const { record } of log.requests) {
      expect(record).toMatchObject({ providerName: "Driver Provider", method: "POST", ok: true, status: 200 });
      expect(record.url).toBe(`${server.baseUrl}/chat/completions`);
      expect(record.requestBody).toContain('"fake-model"');
      expect(record.responseBody).toBeUndefined();
    }
  }, 30_000);

  test("历史只经 host.session.load 取:视图项按序编码进请求,合成行照常编码", async () => {
    const server = await upstream([{ content: "好" }]);
    const user = message("USER", [{ type: "text", text: "早先的问题" }]);
    const ai = message("ASSISTANT", [{ type: "text", text: "早先的回答" }], "fake-model");
    const reminder = message("USER", [{ type: "text", text: "时间提醒" }]);
    const { host, log } = fakeHost({
      view: {
        items: [
          { message: user, synthetic: false, input: { text: "早先的问题", images: [] } },
          { message: ai, synthetic: false },
          { message: reminder, synthetic: true, input: { text: "时间提醒", images: [] } },
        ],
        compactions: [],
      },
    });
    const turn = { conversationId: "conv-driver-view", turnId: "turn-view" };
    await strictDriver(host).startTurn({ ...turn, input: inputFor(server, "新问题") });
    expect(log.sessionLoads).toEqual([turn]);
    const sent = JSON.stringify(server.requests[0]?.messages);
    const order = ["早先的问题", "早先的回答", "时间提醒", "新问题"].map((text) => sent.indexOf(text));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  }, 30_000);

  test("abort(conversationId):在途轮次被中止,正常返回(中止收尾归应用)", async () => {
    let release!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = await upstream([
      { toolCalls: [{ id: "tc-hang", name: "lookup", arguments: "{}" }] },
      { content: "不应到达" },
    ]);
    const { host, log } = fakeHost({
      // 工具挂住直到中止:模拟等待审批中的停止。
      tool: () =>
        new Promise((_, reject) => {
          release();
          setTimeout(() => reject(new Error("Tool execution aborted")), 200);
        }),
    });
    const driver = strictDriver(host);
    const run = driver.startTurn({ conversationId: "conv-driver-2", turnId: "turn-2", input: inputFor(server, "开始", [lookupTool]) });
    await toolStarted;
    await driver.abort("conv-driver-2", "interrupted");
    const result = await run;
    expect(result.stopReason).toBe("aborted");
    expect(server.requests.length).toBe(1);
    expect(log.toolCalls.length).toBe(1);
  }, 30_000);

  test("缺工作区:以错误拒绝(portable 驱动只认请求数据)", async () => {
    const server = await upstream([]);
    const { host } = fakeHost();
    const input = { ...inputFor(server, "hi"), workspace: null };
    await expect(strictDriver(host).startTurn({ conversationId: "conv-driver-3", turnId: "turn-3", input })).rejects.toThrow(
      "请求未带工作区",
    );
    expect(server.requests.length).toBe(0);
  });

  test("压缩:摘要模型映射不进 pi → report warn 回退会话模型;已知错误以 CodedError 穿过传输", async () => {
    const server = await upstream([]);
    const { host, log } = fakeHost();
    const summarizer = grantFor(server, "custom-path-model", { chatCompletionsPath: "/v1/custom/completions" });
    const error = await strictDriver(host)
      .compact!({
        conversationId: "conv-driver-4",
        turnId: "turn-4",
        model: grantFor(server),
        summarizer,
        reasoningLevel: null,
        workspace: { cwd: root, root },
        instructions,
        customInstructions: "",
      })
      .catch((err: unknown) => err);
    expect(log.reports).toEqual([
      {
        domain: "provider",
        severity: "warn",
        message: "压缩模型 custom-path-model 无法在工作区引擎使用,本次压缩改用会话模型",
        code: "compact_summarizer_fallback",
      },
    ]);
    // 空会话在发任何请求前就被 pi 判为过短。
    expect(error).toBeInstanceOf(CodedError);
    expect((error as CodedError).errorCode).toBe("compact_context_too_short");
    expect(server.requests.length).toBe(0);
  });
});
