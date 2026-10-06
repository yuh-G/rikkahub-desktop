// pi-engine/cache-retention.test.ts — C1 缓存策略注入行为锁(跨引擎平价 + 三态出线)。
//
// 锁两件事:
//  1. streamFunction 包装的三态出线(C0 实测形态):策略翻译 none/short/long → 请求体
//     cache_control 0/1/1 处,short={type:"ephemeral"},long 带 ttl:"1h"。pi 升级重构
//     sdk 内部 streamFn 结构时此处先红,防静默回到 pi 默认 short(=无视开关恒打标记)。
//  2. 跨引擎平价:同一 provider 配置下,聊天引擎构建体(orchestrator 顶层 cache_control
//     + message-builder 三个块级断点)与 pi 出线请求的 cache_control 有无一致——开关关
//     两引擎都不打,开关开两引擎都打。「Claude 提示缓存」从此真正管住所有引擎(D3a)。
//  3. OpenAI 格式 prompt_cache_key 平价:开=发(值=conversationId,与聊天引擎同值),
//     关=不发(修复 S6:pi 的 Responses/completions 此前恒发,绕过了开关)。
//  4. 会话 id 稳定化:同一会话第二轮请求的 prompt_cache_key/会话 id 与第一轮相同
//     (此前 pi 每轮随机 uuidv7,同会话永远打不进同一缓存分片)。
//  5. T3/T4 通道注入:pi 生成的 LLM fetch 真的经 ctx.llmFetchFor 下发的通道出线(传一条
//     可观察到调用的 fetch 作为通道,断言它被 pi 调到了——这是「请求通道接线成立」的终极锁);
//     google 轨不注入(否则 pi 抛 "Custom fetch is not supported")。
//
// Anthropic 轨用假 SSE 服务器直驱 runPiGeneration(注册轨,真实 createAgentSession);
// 聊天引擎侧用纯函数构建体(claudeSystemContent/claudeToolsFromOpenAiMessages 同款
// 断言面,claude-prompt-cache.test.ts 已细锁块级位置,这里只锁"有无一致")。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";

import type { GenerationEvent } from "../inference-engine/events";
import type { Message, Provider } from "../foundation/types";
import { message } from "../foundation/utils";
import { model, provider } from "../model-providers";
import { runPiGeneration, piInjectsLlmFetch } from "./runner";
import { createLlmFetch } from "../inference-engine/llm-transport";
import { claudeSystemContent, claudeToolsFromOpenAiTools } from "../inference-engine/message-builder";

/** 单轮纯文本回答的 anthropic SSE 剧本(与聊天引擎 claude-loop.test 同格式)。
 *  注意 data 载荷必须带顶层 "type" 字段——pi 的流适配器按 event.type 判别,
 *  只认 SSE event: 行名会全部静默丢弃(pi 自家测试 fixture 同款形状)。 */
const TEXT_TURN = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"回答"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

/** 深数出线体里 cache_control 的出现形态全集(位置不限——块级位置由
 *  claude-prompt-cache.test 锁聊天引擎侧,这里锁"有几处、什么形状")。 */
function cacheControlOccurrences(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      if ("cache_control" in record) found.push(record.cache_control as Record<string, unknown>);
      Object.values(record).forEach(walk);
    }
  };
  walk(body);
  return found;
}

const anthropicRequests: Array<Record<string, unknown>> = [];
let anthropicServer: http.Server;
let anthropicBase = "";
let cwd: string;

beforeAll(async () => {
  anthropicServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk.toString()));
    req.on("end", () => {
      anthropicRequests.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(TEXT_TURN);
      res.end();
    });
  });
  await new Promise<void>((resolve) => anthropicServer.listen(0, "127.0.0.1", resolve));
  anthropicBase = `http://127.0.0.1:${(anthropicServer.address() as AddressInfo).port}`;
  cwd = mkdtempSync(join(tmpdir(), "pi-cache-ret-"));
});

afterAll(async () => {
  anthropicServer.close();
});

// ---- 1) streamFunction 三态出线(pi 注册轨,真实 createAgentSession) ----

function claudeProviderFixture(overrides: Partial<Provider> = {}): Provider {
  return provider({
    id: "00000000-0000-4000-8000-0000000000c1",
    name: "Cache Parity Claude",
    baseUrl: anthropicBase,
    apiKey: "sk-test",
    type: "claude",
    ...overrides,
  });
}

const fakeClaudeModel = model("claude-fake-4-5", "Fake Claude");

async function runPiTurn(providerFixture: Provider, conversationId: string): Promise<string> {
  const events: GenerationEvent[] = [];
  const result = await runPiGeneration({
    provider: providerFixture,
    model: fakeClaudeModel,
    conversationId,
    cwd,
    history: [] as Message[],
    promptText: "你好",
    sink: (event) => events.push(event),
    // T4:LLM 请求通道工厂直用全局 fetch——本用例的假 SSE 服务器就是上游,请求经它出线。
    llmFetchFor: () => fetch,
  });
  return result.text;
}

// ---- 1) streamFunction 三态出线(pi 注册轨,真实 createAgentSession) ----

describe("pi cacheRetention 注入三态出线(策略单源 → 请求体)", () => {
  test("开关关(none):请求体零 cache_control——工作区请求随「Claude 提示缓存」开关收敛(S6 治理)", async () => {
    const requestsBefore = anthropicRequests.length;
    await runPiTurn(claudeProviderFixture({ promptCaching: false }), "conv-cache-none");
    expect(cacheControlOccurrences(anthropicRequests[requestsBefore]!)).toEqual([]);
  });

  test("开关开 5m(short):出 cache_control {type:ephemeral}(无 ttl)", async () => {
    const requestsBefore = anthropicRequests.length;
    await runPiTurn(claudeProviderFixture({ promptCaching: true }), "conv-cache-short");
    const marks = cacheControlOccurrences(anthropicRequests[requestsBefore]!);
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((mark) => mark.type === "ephemeral" && mark.ttl === undefined)).toBe(true);
  });

  test("开关开 1h(long):出 cache_control {type:ephemeral,ttl:1h}", async () => {
    const requestsBefore = anthropicRequests.length;
    await runPiTurn(claudeProviderFixture({ promptCaching: true, promptCacheTtl: "1h" }), "conv-cache-long");
    const marks = cacheControlOccurrences(anthropicRequests[requestsBefore]!);
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((mark) => mark.type === "ephemeral" && mark.ttl === "1h")).toBe(true);
  });

  // 订阅 Claude 行(D10 恒开)在 model-providers/prompt-cache.test.ts 单元级锁定
  // (策略函数直接断言);这里不驱动 builtin 轨——订阅行的 baseUrl/auth 由 pi 内建
  // provider 锁死(官方 api.anthropic.com + OAuth),没有可拦截的假服务器落点,
  // 集成级会真打官方端点。翻译层 piCacheRetentionFor 对订阅行的输入与普通行完全
  // 同构(anthropicCaching=true → short/long),单元锁即闭环。
});

// ---- 2) 跨引擎平价(有无一致) ----

describe("跨引擎 cache_control 平价(同一配置,聊天引擎构建体 vs pi 出线)", () => {
  const parityTools = [
    { function: { name: "alpha", description: "a", parameters: { type: "object", properties: {} } } },
  ];

  function chatEngineMarks(providerFixture: Provider): number {
    // 聊天引擎侧断言面 = 构建体三处断点之和(顶层 cache_control 在 orchestrator body,
    // 与块级断点同条件同源;块级已由 claude-prompt-cache.test 细锁,这里数块级即可)。
    let count = 0;
    const system = claudeSystemContent("系统提示词", providerFixture) as Array<Record<string, unknown>>;
    count += system.filter((block) => block.cache_control).length;
    const toolList = claudeToolsFromOpenAiTools(parityTools, providerFixture) as Array<Record<string, unknown>>;
    count += toolList.filter((tool) => tool.cache_control).length;
    return count;
  }

  test("开关关:两引擎都零标记", async () => {
    const off = claudeProviderFixture({ promptCaching: false });
    expect(chatEngineMarks(off)).toBe(0);
    const requestsBefore = anthropicRequests.length;
    await runPiTurn(off, "conv-parity-off");
    expect(cacheControlOccurrences(anthropicRequests[requestsBefore]!)).toEqual([]);
  });

  test("开关开:两引擎都打标记(聊天 ≥1 处块级 + pi ≥1 处)", async () => {
    const on = claudeProviderFixture({ promptCaching: true });
    expect(chatEngineMarks(on)).toBeGreaterThan(0);
    const requestsBefore = anthropicRequests.length;
    await runPiTurn(on, "conv-parity-on");
    expect(cacheControlOccurrences(anthropicRequests[requestsBefore]!).length).toBeGreaterThan(0);
  });
});

// ---- 3)+4) OpenAI 格式 prompt_cache_key 平价 + 会话 id 稳定 ----

describe("OpenAI 格式 prompt_cache_key(策略开关 + 会话 id 稳定化)", () => {
  // 走 Responses 轨(useResponseApi):prompt_cache_key 的发送条件与主机无关
  // (openai-responses.ts buildParams:cacheRetention !== "none" 即发)——completions 轨
  // pi 对非官方主机额外门控(仅 long 才发,pi 自家语义:第三方无 OpenAI 缓存路由),
  // Responses 轨正是 S6 报障形态(恒发绕过开关),也是行为锁的正确落点。
  const RESPONSES_SCRIPT = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant","id":"msg_1"}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"回答"}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","role":"assistant","id":"msg_1","content":[{"type":"output_text","text":"回答"}]}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":8,"output_tokens":2}}}\n\n',
  ].join("");

  let responsesServer: http.Server;
  let responsesBase = "";
  const responsesRequests: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    responsesServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk.toString()));
      req.on("end", () => {
        responsesRequests.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(RESPONSES_SCRIPT);
        res.end();
      });
    });
    await new Promise<void>((resolve) => responsesServer.listen(0, "127.0.0.1", resolve));
    responsesBase = `http://127.0.0.1:${(responsesServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    responsesServer.close();
  });

  function responsesProviderFixture(overrides: Partial<Provider> = {}): Provider {
    return provider({
      id: "00000000-0000-4000-8000-0000000000o1",
      name: "Cache Key Provider",
      baseUrl: responsesBase,
      apiKey: "sk-test",
      useResponseApi: true,
      ...overrides,
    });
  }

  async function runResponsesTurn(conversationId: string, providerFixture: Provider): Promise<void> {
    await runPiGeneration({
      provider: providerFixture,
      model: model("fake-responses-model", "Fake Responses"),
      conversationId,
      cwd,
      history: [] as Message[],
      promptText: "你好",
      sink: () => {},
      llmFetchFor: () => fetch, // T4:LLM 请求通道工厂(测试直用全局 fetch,假上游即落点)
    });
  }

  test("开关关:prompt_cache_key 不发(S6 修复:此前 pi 恒发绕过开关)", async () => {
    const before = responsesRequests.length;
    await runResponsesTurn("conv-key-off", responsesProviderFixture({ promptCacheKey: false }));
    expect((responsesRequests[before] as Record<string, unknown>).prompt_cache_key).toBeUndefined();
  });

  test("开关开:prompt_cache_key 发且值=conversationId(与聊天引擎同值),跨轮稳定", async () => {
    const conversationId = "0d9f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
    const on = responsesProviderFixture({ promptCacheKey: true });
    // 同一会话两轮(第二轮灌一条历史,驱动第二个上游请求)。
    await runResponsesTurn(conversationId, on);
    await runPiGeneration({
      provider: on,
      model: model("fake-responses-model", "Fake Responses"),
      conversationId,
      cwd,
      history: [message("USER", [{ type: "text", text: "第一轮" }])] as Message[],
      promptText: "第二轮",
      sink: () => {},
      llmFetchFor: () => fetch, // T4:LLM 请求通道工厂
    });
    // 两个请求:键都发、值都是会话 id(此前 pi 每轮随机 uuidv7,同会话永远打不进
    // 同一缓存分片——稳定化后跨轮同值)。
    const mine = responsesRequests.slice(-2) as Array<Record<string, unknown>>;
    expect(mine.length).toBe(2);
    for (const request of mine) {
      expect(request.prompt_cache_key).toBe(conversationId);
    }
  });
});

// ---- 5) T3/T4 通道注入:pi 的 LLM fetch 真的经 ctx.llmFetchFor ----

describe("T3/T4 请求通道注入(pi streamFunction 包装)", () => {
  test("pi 生成的每条请求经 ctx.llmFetchFor 返回的通道出线(可观察 fetch 被调用)", async () => {
    // 通道即 pi 的唯一 LLM 出口:传一条会记录调用的 fetch 作通道,断言 pi 用它发了请求。
    // 这是「请求通道接线成立」的终极集成锁——若 streamFunction 包装失效(上游重构 /
    // 补丁丢失),请求会回到 globalThis.fetch,此断言先红。
    const channelCalls: string[] = [];
    const channel = createLlmFetch(
      { engine: "pi", provider: claudeProviderFixture({ promptCaching: false }), conversationId: "conv-channel", purpose: "generation" },
      [],
    );
    const observing: typeof fetch = (async (input, init) => {
      channelCalls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return channel(input, init);
    }) as typeof fetch;
    await runPiGeneration({
      provider: claudeProviderFixture({ promptCaching: false }),
      model: fakeClaudeModel,
      conversationId: "conv-channel",
      cwd,
      history: [] as Message[],
      promptText: "你好",
      sink: () => {},
      llmFetchFor: () => observing,
    });
    expect(channelCalls.length).toBeGreaterThanOrEqual(1);
    expect(channelCalls[0]).toContain("/v1/messages");
  });

  test("pi 内建模型(含不支持自定义 fetch 的 google 轨)不注入通道;anthropic/openai 注入", () => {
    // P5:google 两个适配器拒收自定义 fetch → 不注入(否则 pi 抛 "Custom fetch is not
    // supported");其余协议一律注入。
    expect(piInjectsLlmFetch(provider({ id: "g", name: "G", baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "k", type: "google" }))).toBe(false);
    expect(piInjectsLlmFetch(provider({ id: "c", name: "C", baseUrl: "https://api.anthropic.com/v1", apiKey: "k", type: "claude" }))).toBe(true);
    expect(piInjectsLlmFetch(provider({ id: "o", name: "O", baseUrl: "https://api.openai.com/v1", apiKey: "k", type: "openai" }))).toBe(true);
  });
});
