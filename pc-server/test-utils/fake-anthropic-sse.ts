// test-utils/fake-anthropic-sse.ts — 本地假 Anthropic /v1/messages SSE 服务器(缓存预热的测试共用:驱动层时间线、编排器
// 端到端、PW.5 经引擎宿主进程跑的那一遍)。
//
// 会话请求按剧本依次回;输出上限为 1 的请求当作预热的重发(pi 只有预热把 max_tokens 压到 1),默认回一条命中缓存的
// 短回复。data 载荷带顶层 type:pi 的流适配器按它判别。

import http from "node:http";
import type { AddressInfo } from "node:net";

export const anthropicSse = (events: Array<[string, Record<string, unknown>]>) =>
  events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join("");

/** 一轮工具调用。promptTokens 进 message_start 的用量:pi 按它算重发划不划算,太小时不预热。 */
export function anthropicToolTurn(id: string, name: string, input: Record<string, unknown>, promptTokens: number): string {
  return anthropicSse([
    ["message_start", { message: { usage: { input_tokens: promptTokens } } }],
    ["content_block_start", { index: 0, content_block: { type: "tool_use", id, name, input: {} } }],
    ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }],
    ["message_stop", {}],
  ]);
}

export function anthropicTextTurn(text: string, usage: Record<string, number>): string {
  return anthropicSse([
    ["message_start", { message: { usage } }],
    ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
    ["message_stop", {}],
  ]);
}

export interface FakeAnthropicCall {
  body: Record<string, unknown>;
  /** Node 已把头名转小写。 */
  headers: http.IncomingHttpHeaders;
  /** performance.now()(拨 Date 的测试也能比先后)。 */
  at: number;
}

/** 字符串 = SSE 正文(200);对象 = 非 2xx 的 JSON 错误。 */
export type FakeAnthropicReply = string | { status: number; body: string };

export interface FakeAnthropicServer {
  baseUrl: string;
  calls: FakeAnthropicCall[];
  warms(): FakeAnthropicCall[];
  sessions(): FakeAnthropicCall[];
  close(): Promise<void>;
}

export const isWarmCall = (call: FakeAnthropicCall) => call.body.max_tokens === 1;

/** warm.reply / warm.onWarm 的 count = 这是第几次重发(从 1 起)。 */
export async function startFakeAnthropic(
  turns: FakeAnthropicReply[],
  warm: { promptTokens?: number; onWarm?: (count: number) => void; reply?: (count: number) => FakeAnthropicReply | undefined } = {},
): Promise<FakeAnthropicServer> {
  const warmReply = anthropicTextTurn(".", { input_tokens: 0, cache_read_input_tokens: warm.promptTokens ?? 0 });
  const calls: FakeAnthropicCall[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk.toString();
    const call = { body: JSON.parse(raw) as Record<string, unknown>, headers: req.headers, at: performance.now() };
    calls.push(call);
    const warmCount = isWarmCall(call) ? calls.filter(isWarmCall).length : 0;
    if (warmCount) warm.onWarm?.(warmCount);
    const reply = warmCount ? (warm.reply?.(warmCount) ?? warmReply) : (turns.shift() ?? anthropicTextTurn("剧本外的请求", { input_tokens: 1 }));
    if (typeof reply !== "string") {
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(reply.body);
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.end(reply);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    warms: () => calls.filter(isWarmCall),
    sessions: () => calls.filter((call) => !isWarmCall(call)),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
