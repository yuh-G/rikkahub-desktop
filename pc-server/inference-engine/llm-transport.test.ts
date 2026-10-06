// inference-engine/llm-transport.test.ts — 请求通道单测(T 阶段 §6 T1)。
//
// 锁:①三种 input 形状 × 两种 headers 形状规范化结果一致(B1 类根除)②中间件有序
// ③中间件短路 ④终点以**字符串 URL** 调底层 fetch(P8:传 Request 会丢 net.ts 的
// timeout:0/UA)⑤signal 透传 ⑥非字符串 body 原样透传不被吞。
//
// 无 mock.module:只临时替换 globalThis.fetch 记录终点调用(try/finally 恢复)。
import { afterEach, describe, expect, test } from "bun:test";
import {
  createLlmFetch,
  normalizeLlmRequest,
  type LlmCallContext,
  type LlmMiddleware,
} from "./llm-transport";
import type { Provider } from "../foundation/types";

const ctx: LlmCallContext = {
  engine: "chat",
  provider: { id: "p1", name: "Test", type: "claude", baseUrl: "https://api.anthropic.com" } as Provider,
  conversationId: "c1",
  purpose: "generation",
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function captureTerminal(): { calls: Array<{ input: unknown; init: RequestInit | undefined }> } {
  const calls: Array<{ input: unknown; init: RequestInit | undefined }> = [];
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    calls.push({ input, init });
    return Promise.resolve(new Response("ok", { status: 200 }));
  }) as typeof fetch;
  return { calls };
}

describe("normalizeLlmRequest — 形状规范化", () => {
  test("string / URL / Request 三形态 → 同一 LlmRequest(url/method/headers)", async () => {
    const headers = { "content-type": "application/json", "x-api-key": "sk-test" };
    const body = JSON.stringify({ a: 1 });

    const fromString = await normalizeLlmRequest("https://api.anthropic.com/v1/messages", {
      method: "post",
      headers,
      body,
    });
    const fromUrl = await normalizeLlmRequest(new URL("https://api.anthropic.com/v1/messages"), {
      method: "POST",
      headers,
      body,
    });
    const fromRequest = await normalizeLlmRequest(
      new Request("https://api.anthropic.com/v1/messages", { method: "POST", headers, body }),
    );

    for (const n of [fromString, fromUrl, fromRequest]) {
      expect(n.url).toBe("https://api.anthropic.com/v1/messages");
      expect(n.method).toBe("POST");
      expect(n.headers.get("x-api-key")).toBe("sk-test");
      expect(n.headers.get("content-type")).toBe("application/json");
      expect(n.body).toBe(body);
      expect(n.rawBody).toBe(body);
    }
  });

  test("headers 为 Headers 实例时也规范化(B1:真实 SDK 传 Headers 实例)", async () => {
    const headers = new Headers({ "x-api-key": "sk-real" });
    const n = await normalizeLlmRequest("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(n.headers.get("x-api-key")).toBe("sk-real");
    // 健壮性:`{...headersInstance}` 会得 {},确认我们没退回那个形状。
    expect(Object.fromEntries(n.headers.entries())["x-api-key"]).toBe("sk-real");
  });

  test("非字符串 body(ReadableStream)→ body=undefined,rawBody 保留原对象", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
        controller.close();
      },
    });
    const n = await normalizeLlmRequest("https://x/v1/messages", { method: "POST", body: stream });
    expect(n.body).toBeUndefined();
    expect(n.rawBody).toBe(stream);
  });

  test("Request 输入带流 body 时 clone 读取不吞原流", async () => {
    const req = new Request("https://x/v1/messages", { method: "POST", body: "{\"k\":1}" });
    const n = await normalizeLlmRequest(req);
    expect(n.body).toBe('{"k":1}');
    // 原 Request 的 body 仍可读(clone 语义)。
    expect(await req.text()).toBe('{"k":1}');
  });
});

describe("createLlmFetch — 链执行", () => {
  test("中间件按数组顺序经过(前项在外层)", async () => {
    const order: string[] = [];
    const mw = (name: string): LlmMiddleware => async (req, _c, next) => {
      order.push(`${name}:in`);
      const res = await next(req);
      order.push(`${name}:out`);
      return res;
    };
    captureTerminal();
    const fetchFn = createLlmFetch(ctx, [mw("A"), mw("B")]);
    await fetchFn("https://x/v1/messages", { method: "POST", body: "{}" });
    expect(order).toEqual(["A:in", "B:in", "B:out", "A:out"]);
  });

  test("中间件可短路(返回自造 Response,终点不触达)", async () => {
    const { calls } = captureTerminal();
    const shortCircuit: LlmMiddleware = async () => new Response("intercepted", { status: 418 });
    const fetchFn = createLlmFetch(ctx, [shortCircuit]);
    const res = await fetchFn("https://x/v1/messages", { method: "POST", body: "{}" });
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("intercepted");
    expect(calls.length).toBe(0);
  });

  test("无中间件时直达终点", async () => {
    const { calls } = captureTerminal();
    const fetchFn = createLlmFetch(ctx, []);
    await fetchFn("https://x/v1/messages", { method: "POST", body: "{}" });
    expect(calls.length).toBe(1);
  });

  test("终点以字符串 URL + init 调底层 fetch,不传 Request 对象(P8)", async () => {
    const { calls } = captureTerminal();
    const fetchFn = createLlmFetch(ctx, []);
    await fetchFn(new Request("https://x/v1/messages", { method: "POST", body: "{\"k\":1}" }));
    expect(calls.length).toBe(1);
    expect(typeof calls[0]!.input).toBe("string");
    expect(calls[0]!.input).toBe("https://x/v1/messages");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBe('{"k":1}');
    // headers 是 Headers 实例(供 net.ts 的 identity/UA 注入正常读取)。
    expect(calls[0]!.init?.headers).toBeInstanceOf(Headers);
  });

  test("signal 透传到终点", async () => {
    const { calls } = captureTerminal();
    const controller = new AbortController();
    const fetchFn = createLlmFetch(ctx, []);
    await fetchFn("https://x/v1/messages", { method: "POST", body: "{}", signal: controller.signal });
    expect(calls[0]!.init?.signal).toBe(controller.signal);
  });

  test("非字符串 body 透传到终点(不被吞)", async () => {
    const { calls } = captureTerminal();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hi"));
        c.close();
      },
    });
    const fetchFn = createLlmFetch(ctx, []);
    await fetchFn("https://x/v1/messages", { method: "POST", body: stream });
    expect(calls[0]!.init?.body).toBe(stream);
  });

  test("中间件可改写请求(url / headers / body)后透给终点", async () => {
    const { calls } = captureTerminal();
    const rewriter: LlmMiddleware = async (req, _c, next) => {
      req.headers.set("x-injected", "1");
      req.url = "https://x/v1/messages?rewritten=1";
      return next(req);
    };
    const fetchFn = createLlmFetch(ctx, [rewriter]);
    await fetchFn("https://x/v1/messages", { method: "POST", body: "{}" });
    expect(calls[0]!.input).toBe("https://x/v1/messages?rewritten=1");
    expect(new Headers(calls[0]!.init?.headers).get("x-injected")).toBe("1");
  });
});

describe("createLlmFetch — ctx 透传", () => {
  test("中间件拿到组装时的 ctx(引擎 / 供应商 / 会话 / 用途)", async () => {
    let seen: LlmCallContext | undefined;
    const spy: LlmMiddleware = async (req, c, next) => {
      seen = c;
      return next(req);
    };
    captureTerminal();
    const fetchFn = createLlmFetch(ctx, [spy]);
    await fetchFn("https://x/v1/messages", { method: "POST", body: "{}" });
    expect(seen).toBe(ctx);
  });
});
