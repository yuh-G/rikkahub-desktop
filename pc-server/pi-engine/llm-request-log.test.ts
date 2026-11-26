// 日志问题 1:工作区 LLM 请求接入统一日志管线——ALS 上下文圈定 + origin 精准匹配 +
// 流式/错误两种记录口径。离线测试:先把 globalThis.fetch 换成 fake,再装拦截器
// (fake 即拦截器的 inner),全程零真实网络。
// 注意:bun 的 mock.module 全局生效,展开真实模块只覆盖 addLog(tool-loop.test 同款纪律)。
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

import * as actualLogs from "../api/logs";

const logged: Array<Record<string, unknown>> = [];
mock.module("../api/logs", () => ({ ...actualLogs, addLog: (entry: Record<string, unknown>) => logged.push(entry) }));

const { installLlmRequestLogInterceptor, llmLogContextFor, runWithLlmRequestLog } = await import("./llm-request-log");

// fake inner fetch:按 URL 决定响应形态。装拦截器前替换,拦截器闭包捕获它为 inner。
let fakeResponder: (url: string) => Response | Promise<Response> = () => new Response("ok", { status: 200 });
// async 包装:responder 的 throw 变 rejection(真实 fetch 从不同步抛,fake 保持同语义)。
const fakeFetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return fakeResponder(url);
}) as typeof fetch;
// bun test 同进程且"先加载全部文件、再统一跑测试":globalThis.fetch 的替换绝不能放
// 顶层(加载阶段),否则与其他文件顶层的 `const realFetch = globalThis.fetch` 快照交错,
// 恢复链错乱会让 pi vendor 的 retry 系测试拿到假响应而超时。收进本文件的
// beforeAll/afterAll(执行阶段,文件内成对),替换窗口只覆盖本文件的用例。
let realFetch: typeof fetch;
beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  installLlmRequestLogInterceptor(); // 闭包捕获 fakeFetch 为 inner(幂等,进程内一次)
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const CTX = { providerId: "p1", providerName: "测试供应商", origin: "https://api.example.com" };

async function flushLogs(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("工作区 LLM 请求日志壳", () => {
  test("llmLogContextFor:提取 origin;非法 baseUrl 返回 null(该轮不记不炸)", () => {
    expect(llmLogContextFor({ id: "a", name: "n", baseUrl: "https://api.moonshot.cn/v1" })).toEqual({
      providerId: "a",
      providerName: "n",
      origin: "https://api.moonshot.cn",
    });
    expect(llmLogContextFor({ id: "a", name: "n", baseUrl: "not-a-url" })).toBeNull();
  });

  test("上下文内 + origin 匹配:LLM 请求记入管线(kind=provider:agent,含请求体与时长)", async () => {
    logged.length = 0;
    fakeResponder = () => new Response("stream...", { status: 200 });
    await runWithLlmRequestLog(CTX, () =>
      fetch("https://api.example.com/v1/chat/completions", { method: "POST", body: '{"model":"m1"}' }),
    );
    await flushLogs();
    expect(logged.length).toBe(1);
    expect(logged[0]).toMatchObject({
      providerId: "p1",
      providerName: "测试供应商",
      url: "https://api.example.com/v1/chat/completions",
      ok: true,
      status: 200,
      kind: "provider:agent",
      method: "POST",
      requestBody: '{"model":"m1"}',
    });
    expect(typeof logged[0].durationMs).toBe("number");
  });

  test("上下文内但 origin 不匹配(工具的搜索/抓取请求):透传不记,零双记", async () => {
    logged.length = 0;
    await runWithLlmRequestLog(CTX, () => fetch("https://search.other.com/api"));
    await flushLogs();
    expect(logged.length).toBe(0);
  });

  test("无上下文(聊天引擎路径):透传不记(它有自己的调用点日志)", async () => {
    logged.length = 0;
    await fetch("https://api.example.com/v1/chat/completions");
    await flushLogs();
    expect(logged.length).toBe(0);
  });

  test("非 2xx:记录错误体(截断)与 error 字段", async () => {
    logged.length = 0;
    fakeResponder = () => new Response('{"error":{"message":"quota exceeded"}}', { status: 429 });
    await runWithLlmRequestLog(CTX, () => fetch("https://api.example.com/v1/chat/completions", { method: "POST" }));
    await flushLogs();
    expect(logged.length).toBe(1);
    expect(logged[0]).toMatchObject({ ok: false, status: 429 });
    expect(String(logged[0].responseBody)).toContain("quota exceeded");
    expect(String(logged[0].error)).toContain("quota exceeded");
  });

  test("网络异常(reject):ok=false status=0,错误摘要入档,promise 语义不变(照常抛给 pi)", async () => {
    logged.length = 0;
    fakeResponder = () => {
      throw new Error("connect ECONNREFUSED");
    };
    await expect(runWithLlmRequestLog(CTX, () => fetch("https://api.example.com/v1/x"))).rejects.toThrow(
      "ECONNREFUSED",
    );
    await flushLogs();
    expect(logged.length).toBe(1);
    expect(logged[0]).toMatchObject({ ok: false, status: 0 });
    expect(String(logged[0].error)).toContain("ECONNREFUSED");
  });

  test("嵌套异步(pi SDK 内部多层 await):ALS 上下文穿透", async () => {
    logged.length = 0;
    fakeResponder = () => new Response("ok", { status: 200 });
    await runWithLlmRequestLog(CTX, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await fetch("https://api.example.com/v1/messages");
    });
    await flushLogs();
    expect(logged.length).toBe(1);
    expect(logged[0].url).toBe("https://api.example.com/v1/messages");
  });
});
