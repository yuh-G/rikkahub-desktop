// test-utils/fake-openai-sse.ts — 本地假 OpenAI chat/completions SSE 服务器
// (pi-engine 冒烟与 runner 集成测试共用;SSE 帧格式抄自 pi 自家测试
// pi/packages/ai/test/openai-completions-thinking-as-text.test.ts)。
// 剧本制:每收到一个 POST 消耗一个 turn;剧本耗尽即 500(测试用例应精确声明轮数)。

import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeSseToolCall {
  id: string;
  name: string;
  /** 完整 JSON 参数字符串(单帧发出;分帧累计路径由桥单测覆盖)。 */
  arguments: string;
}

export interface FakeSseTurn {
  /** assistant 正文(单帧发出;分帧对桥无语义差,pi 客户端逐帧累计)。 */
  content?: string;
  /** 本轮工具调用(P3:驱动 pi 执行 customTools;finish_reason 自动为 tool_calls)。 */
  toolCalls?: FakeSseToolCall[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  /** 收到请求后、写响应前执行:确定性模拟"LLM 调用进行中"发生的并发事件
   *  (如压缩落库防线测试在摘要生成期间注入新消息)。 */
  beforeRespond?: () => void | Promise<void>;
}

export interface FakeOpenAiSseServer {
  baseUrl: string;
  /** 每个请求的完整 body(JSON 解析后),测试断言上下文回放用。 */
  requests: Array<Record<string, unknown>>;
  /** 与 requests 同序的请求头(Node 已把头名转小写)。 */
  requestHeaders: http.IncomingHttpHeaders[];
  close(): Promise<void>;
}

export async function startFakeOpenAiSse(turns: FakeSseTurn[]): Promise<FakeOpenAiSseServer> {
  const requests: Array<Record<string, unknown>> = [];
  const requestHeaders: http.IncomingHttpHeaders[] = [];
  let cursor = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    requests.push(JSON.parse(body) as Record<string, unknown>);
    requestHeaders.push(req.headers);
    const turn = turns[cursor];
    cursor += 1;
    if (!turn) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "fake sse script exhausted" } }));
      return;
    }
    if (turn.beforeRespond) await turn.beforeRespond();
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const frame = (payload: object) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (turn.content !== undefined) {
      frame({
        id: "chatcmpl-fake",
        object: "chat.completion.chunk",
        created: 0,
        model: "fake-model",
        choices: [{ index: 0, delta: { role: "assistant", content: turn.content }, finish_reason: null }],
      });
    }
    if (turn.toolCalls?.length) {
      frame({
        id: "chatcmpl-fake",
        object: "chat.completion.chunk",
        created: 0,
        model: "fake-model",
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: turn.toolCalls.map((call, index) => ({
              index,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            })),
          },
          finish_reason: null,
        }],
      });
    }
    frame({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 0,
      model: "fake-model",
      choices: [{ index: 0, delta: {}, finish_reason: turn.toolCalls?.length ? "tool_calls" : "stop" }],
      usage: turn.usage ?? { prompt_tokens: 7, completion_tokens: 5 },
    });
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    requestHeaders,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}
