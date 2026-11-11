// pi-engine/cache-retention.test.ts — 授权缓存策略 → pi 出线请求的行为锁(P2.3a)
//
// 锁三件事(假上游直驱真实 createAgentSession,断言请求体):
//  1. Anthropic 三态:开关关 = 零 cache_control;开 5m = {type:"ephemeral"};开 1h = 带 ttl:"1h"。
//     pi 不传 cacheRetention 时按 short 处理,所以这组用例一红就是「开关对工作区失效」回来了。
//  2. OpenAI 形缓存键:Responses 与 completions(第三方主机)开关开才发 prompt_cache_key,
//     与聊天引擎同义(pi 自己的 auto 规则在 Responses 上恒发、在 completions 上只认官方主机)。
//  3. 显式值优先:手动压缩的摘要请求自带 cacheRetention:"none",策略开着也不打标记。
// 订阅登录行的策略(恒开)在映射层锁;它们走 pi 内建供应商,出线形态由上游维护。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Message, Provider } from "../foundation/types";
import { message } from "../foundation/utils";
import { model, provider } from "../model-providers";
import { modelGrantFor, promptCachePolicyFor } from "../engines/model-grant";
import { userInputsFor } from "../inference-engine/prompt-input";
import { startFakeOpenAiSse, type FakeOpenAiSseServer } from "../test-utils/fake-openai-sse";
import { piCacheRetentionFor } from "./model-bridge";
import { runPiCompaction, runPiGeneration } from "./runner";

/** data 载荷必须带顶层 type:pi 的流适配器按它判别,只看 SSE event: 行名会全部丢弃。 */
const ANTHROPIC_TEXT_TURN = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"回答"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

const RESPONSES_TEXT_TURN = [
  'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
  'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant","id":"msg_1"}}\n\n',
  'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"回答"}\n\n',
  'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","role":"assistant","id":"msg_1","content":[{"type":"output_text","text":"回答"}]}}\n\n',
  'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":8,"output_tokens":2}}}\n\n',
].join("");

interface ScriptedServer {
  baseUrl: string;
  requests: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

/** 每个 POST 都回同一段 SSE 剧本并记下请求体。 */
async function scriptedSse(script: string): Promise<ScriptedServer> {
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    requests.push(JSON.parse(body) as Record<string, unknown>);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.end(script);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 请求体里所有 cache_control 的值(位置不限;块级位置由聊天引擎侧的测试锁)。 */
function cacheControls(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if ("cache_control" in record) found.push(record.cache_control as Record<string, unknown>);
    Object.values(record).forEach(walk);
  };
  walk(body);
  return found;
}

let anthropic: ScriptedServer;
let responses: ScriptedServer;
let completions: FakeOpenAiSseServer;
let cwd: string;

beforeAll(async () => {
  anthropic = await scriptedSse(ANTHROPIC_TEXT_TURN);
  responses = await scriptedSse(RESPONSES_TEXT_TURN);
  completions = await startFakeOpenAiSse([{ content: "回答" }, { content: "回答" }]);
  cwd = mkdtempSync(join(tmpdir(), "pi-cache-retention-"));
});

afterAll(async () => {
  await Promise.all([anthropic.close(), responses.close(), completions.close()]);
});

const claudeModel = model("claude-fake-4-5", "Fake Claude");

function claudeRow(overrides: Partial<Provider> = {}): Provider {
  return provider({ id: crypto.randomUUID(), name: "Cache Claude", baseUrl: anthropic.baseUrl, apiKey: "sk-test", type: "claude", ...overrides });
}

async function runTurn(row: Provider, modelRow = claudeModel): Promise<void> {
  const conversationId = crypto.randomUUID();
  await runPiGeneration({
    grant: modelGrantFor(row, modelRow, null, conversationId)!,
    conversationId,
    cwd,
    history: [] as Message[],
    userInputs: {},
    promptText: "你好",
    sink: () => {},
  });
}

describe("Anthropic:开关三态出线", () => {
  test("开关关:请求体零 cache_control", async () => {
    const before = anthropic.requests.length;
    await runTurn(claudeRow({ promptCaching: false }));
    expect(cacheControls(anthropic.requests[before]!)).toEqual([]);
  });

  test("开 5m:cache_control 为 {type:ephemeral},无 ttl", async () => {
    const before = anthropic.requests.length;
    await runTurn(claudeRow({ promptCaching: true }));
    const marks = cacheControls(anthropic.requests[before]!);
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((mark) => mark.type === "ephemeral" && mark.ttl === undefined)).toBe(true);
  });

  test("开 1h:cache_control 带 ttl:1h", async () => {
    const before = anthropic.requests.length;
    await runTurn(claudeRow({ promptCaching: true, promptCacheTtl: "1h" }));
    const marks = cacheControls(anthropic.requests[before]!);
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((mark) => mark.type === "ephemeral" && mark.ttl === "1h")).toBe(true);
  });
});

describe("OpenAI 形缓存键:开关开才发 prompt_cache_key", () => {
  const responsesRow = (promptCacheKey: boolean) =>
    provider({ id: crypto.randomUUID(), name: "Cache Responses", baseUrl: responses.baseUrl, apiKey: "sk-test", useResponseApi: true, promptCacheKey });
  const completionsRow = (promptCacheKey: boolean) =>
    provider({ id: crypto.randomUUID(), name: "Cache Completions", baseUrl: completions.baseUrl, apiKey: "sk-test", promptCacheKey });
  const gpt = model("gpt-fake", "Fake GPT");

  test("Responses", async () => {
    const before = responses.requests.length;
    await runTurn(responsesRow(false), gpt);
    await runTurn(responsesRow(true), gpt);
    expect(responses.requests[before]!.prompt_cache_key).toBeUndefined();
    expect(typeof responses.requests[before + 1]!.prompt_cache_key).toBe("string");
  });

  test("completions(第三方主机)", async () => {
    const before = completions.requests.length;
    await runTurn(completionsRow(false), gpt);
    await runTurn(completionsRow(true), gpt);
    expect(completions.requests[before]!.prompt_cache_key).toBeUndefined();
    expect(typeof completions.requests[before + 1]!.prompt_cache_key).toBe("string");
  });
});

test("显式值优先:手动压缩的摘要请求在策略开着时也不打缓存标记", async () => {
  // 可压缩的历史:pi 按 chars/4 估算,~100k 字符保证旧段进摘要区(同 runner.test 手动压缩用例)。
  const filler = "很长的历史内容,".repeat(12000);
  const history = [
    message("USER", [{ type: "text", text: `问题${filler}` }]),
    message("ASSISTANT", [{ type: "text", text: `回答${filler}` }]),
  ];
  const row = claudeRow({ promptCaching: true });
  const before = anthropic.requests.length;
  const result = await runPiCompaction({
    grant: modelGrantFor(row, claudeModel, null, "conv-cache-compact")!,
    conversationId: "conv-cache-compact",
    cwd,
    history,
    userInputs: userInputsFor(history, claudeModel),
    sink: () => {},
  });
  expect(result.summary).toContain("回答");
  // 切点落在轮中时 pi 会多发一次前缀摘要,所以逐个检查本次压缩的全部请求。
  const summaryRequests = anthropic.requests.slice(before);
  expect(summaryRequests.length).toBeGreaterThan(0);
  expect(summaryRequests.flatMap(cacheControls)).toEqual([]);
}, 20_000);

describe("策略组装与翻译", () => {
  test("订阅登录行恒开(保留期取服务端默认);google 恒关;API Key 行跟随各自开关", () => {
    const oauthClaude = claudeRow({ authMode: "oauth", promptCaching: false });
    expect(promptCachePolicyFor(oauthClaude)).toEqual({ enabled: true, retention: "short" });
    expect(promptCachePolicyFor(provider({ id: "g", name: "G", baseUrl: "https://g.example", type: "google" }))).toEqual({
      enabled: false,
      retention: "short",
    });
    expect(promptCachePolicyFor(claudeRow({ promptCaching: true, promptCacheTtl: "1h" }))).toEqual({ enabled: true, retention: "long" });
    expect(promptCachePolicyFor(provider({ id: "o", name: "O", baseUrl: "https://o.example", promptCacheKey: true }))).toEqual({
      enabled: true,
      retention: "short",
    });
  });

  test("翻译:关 = none(pi 缺省按 short,必须显式关),开 = short / long", () => {
    expect(piCacheRetentionFor({ enabled: false, retention: "long" })).toBe("none");
    expect(piCacheRetentionFor({ enabled: true, retention: "short" })).toBe("short");
    expect(piCacheRetentionFor({ enabled: true, retention: "long" })).toBe("long");
  });
});
