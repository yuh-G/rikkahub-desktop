// pi-engine/streaming-args-patch.test.ts — 锁 vendor 补丁 [RIKKAHUB PATCH:
// streaming-args-once] 的行为(pi/packages/ai 六个流适配器 + agent/proxy)。
//
// 补丁内容:toolcall_delta 每帧不再对累计参数做全量 parseStreamingJson(上游 O(n²):
// 300KB 参数 ≈ 14.5s 纯解析,阻塞事件循环;deepseek-harness 对 pi-ai 0.87.1 打过
// 同款补丁,上游 issue pi#9265)。参数只在 toolcall_end/终局解析一次。
//
// 行为锁(补丁丢失即红):
//   1. 大参数(200KB)分帧流入,总耗时与帧数线性(每帧全量 parse 时 200KB 要数秒,
//      这里用宽松上限卡住"二次方失控"形态,不给 CI 速度留误报面);
//   2. 终局参数完整正确(流中 arguments 停留 {} 无害,toolcall_end 携带解析后的对象);
//   3. 流式增量照常出线(event-bridge 只读 delta 文本,不受补丁影响)。
// 直连 pi 的 openai-completions 流适配器(不经 runner 全链):补丁面在适配器内部,
// 直接喂数据最短路径;runner 集成路径已有 runner-tools.test 覆盖。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { stream as streamOpenAiCompletions } from "../../pi/packages/ai/src/api/openai-completions.ts";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    // 单端点:回放一个"大参数工具调用"的 chat/completions SSE——参数按 CHUNK 字节分帧,
    // 复刻真实大参数(write 大文件)的流入形态。400KB/128B 帧是经测的锁定锚点:补丁
    // 生效 <100ms;补丁丢失(每帧全量 parse)实测 ≈10s(二次方:帧数×累计长度)。
    const content = "x".repeat(400_000);
    const args = JSON.stringify({ file_path: "/repo/big/file.ts", content });
    const CHUNK = 128;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const frame = (payload: object) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    frame({
      id: "chatcmpl-args",
      object: "chat.completion.chunk",
      created: 0,
      model: "fake",
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_big", type: "function", function: { name: "write", arguments: "" } }] }, finish_reason: null }],
    });
    for (let i = 0; i < args.length; i += CHUNK) {
      frame({
        id: "chatcmpl-args",
        object: "chat.completion.chunk",
        created: 0,
        model: "fake",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + CHUNK) } }] }, finish_reason: null }],
      });
    }
    frame({
      id: "chatcmpl-args",
      object: "chat.completion.chunk",
      created: 0,
      model: "fake",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 5, completion_tokens: 9 },
    });
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
});

/** 最小 pi Model 形状(openai-completions 流适配器只消费这些字段;cost 全 0)。
 *  须在 beforeAll 之后构建(baseUrl 是运行时端口)。 */
function makeFakeModel(): never {
  return {
    id: "fake",
    name: "Fake",
    api: "openai-completions",
    provider: "patch-test",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as never;
}

describe("vendor 补丁行为锁:streaming-args-once(流式参数只在终局解析一次)", () => {
  test("大参数分帧流入:终局参数完整、增量照常、耗时线性(每帧全量 parse 会二次方失控)", async () => {
    const context = {
      systemPrompt: undefined,
      messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: Date.now() },
      ],
      tools: [],
    };
    const fakeModel = makeFakeModel();
    const deltas: string[] = [];
    let finalArgs: Record<string, unknown> | null = null;
    const started = performance.now();
    const stream = streamOpenAiCompletions(fakeModel, context as never, { apiKey: "k" });
    for await (const ev of stream) {
      if (ev.type === "toolcall_delta") deltas.push(ev.delta);
      if (ev.type === "toolcall_end") finalArgs = ev.toolCall.arguments as Record<string, unknown>;
    }
    const elapsed = performance.now() - started;
    // 1) 终局参数完整正确(这是补丁唯一不能破坏的硬契约)。
    expect(finalArgs).not.toBeNull();
    expect((finalArgs as Record<string, unknown>).file_path).toBe("/repo/big/file.ts");
    expect(String((finalArgs as Record<string, unknown>).content).length).toBe(400_000);
    // 2) 流式增量照常出线(event-bridge 的 tool_input_delta 源)。
    expect(deltas.join("")).toBe(JSON.stringify({ file_path: "/repo/big/file.ts", content: "x".repeat(400_000) }));
    // 3) 耗时上限:补丁生效时 400KB/3126 帧实测 <100ms;补丁丢失(每帧全量 parse)
    //    实测 ≈10s。上限 3s——比生效态宽 30 倍,比丢失态严 3 倍,锁定二次方失控。
    expect(elapsed).toBeLessThan(3000);
  });
});
