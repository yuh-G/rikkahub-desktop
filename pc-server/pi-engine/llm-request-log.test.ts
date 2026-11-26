// pi google 轨请求日志壳(P2.5 收窄):只为拒收自定义 fetch 的轨开上下文;上下文内 + origin 匹配才记,
// 记录语义与模型出口共用 recordModelResponse。离线测试:先把 globalThis.fetch 换成 fake,再装壳
// (fake 即壳的 inner),全程零真实网络。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { ModelRequestRecord } from "../engines/contract";
import { googleRequestLogContextFor, installGoogleRequestLogShell, runWithGoogleRequestLog } from "./llm-request-log";

const logged: ModelRequestRecord[] = [];
const log = (record: ModelRequestRecord) => void logged.push(record);

// fake inner fetch:按 URL 决定响应形态。装壳前替换,壳的闭包捕获它为 inner。
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
  installGoogleRequestLogShell(); // 闭包捕获 fakeFetch 为 inner(幂等,进程内一次)
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const GRANT = { providerId: "p1", providerName: "测试供应商", baseUrl: "https://generativelanguage.example.com/v1beta" };
const CTX = googleRequestLogContextFor("google-generative-ai", GRANT, log);
const ENDPOINT = "https://generativelanguage.example.com/v1beta/models/g:streamGenerateContent?alt=sse";

async function flushLogs(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("pi google 轨请求日志壳", () => {
  test("上下文只为 google 两条轨开;其余轨与非法 baseUrl 返回 null(由模型出口记 / 不记不炸)", () => {
    expect(CTX).toMatchObject({ identity: { providerId: "p1", providerName: "测试供应商" }, origin: "https://generativelanguage.example.com" });
    expect(googleRequestLogContextFor("google-vertex", GRANT, log)).not.toBeNull();
    expect(googleRequestLogContextFor("openai-completions", GRANT, log)).toBeNull();
    expect(googleRequestLogContextFor("anthropic-messages", GRANT, log)).toBeNull();
    expect(googleRequestLogContextFor("google-generative-ai", { ...GRANT, baseUrl: "not-a-url" }, log)).toBeNull();
    expect(googleRequestLogContextFor("google-generative-ai", GRANT, undefined)).toBeNull();
  });

  test("上下文内 + origin 匹配:记入(含请求体与时长,流式不读响应体)", async () => {
    logged.length = 0;
    fakeResponder = () => new Response("data: ...", { status: 200 });
    await runWithGoogleRequestLog(CTX, () => fetch(ENDPOINT, { method: "POST", body: '{"contents":[]}' }));
    await flushLogs();
    expect(logged.length).toBe(1);
    expect(logged[0]).toMatchObject({
      providerId: "p1",
      providerName: "测试供应商",
      url: ENDPOINT,
      ok: true,
      status: 200,
      method: "POST",
      requestBody: '{"contents":[]}',
    });
    expect(typeof logged[0]!.durationMs).toBe("number");
    expect(logged[0]!.responseBody).toBeUndefined();
  });

  test("上下文内但 origin 不匹配(工具的搜索/抓取请求):透传不记,零双记", async () => {
    logged.length = 0;
    await runWithGoogleRequestLog(CTX, () => fetch("https://search.other.com/api"));
    await flushLogs();
    expect(logged.length).toBe(0);
  });

  test("无上下文(其余轨/聊天引擎):透传不记", async () => {
    logged.length = 0;
    await fetch(ENDPOINT);
    await runWithGoogleRequestLog(null, () => fetch(ENDPOINT));
    await flushLogs();
    expect(logged.length).toBe(0);
  });

  test("非 2xx:记录错误体(截断)与 error 字段", async () => {
    logged.length = 0;
    fakeResponder = () => new Response('{"error":{"message":"quota exceeded"}}', { status: 429 });
    await runWithGoogleRequestLog(CTX, () => fetch(ENDPOINT, { method: "POST" }));
    await flushLogs();
    expect(logged.length).toBe(1);
    expect(logged[0]).toMatchObject({ ok: false, status: 429 });
    expect(String(logged[0]!.responseBody)).toContain("quota exceeded");
    expect(String(logged[0]!.error)).toContain("quota exceeded");
  });

  test("网络异常(reject):ok=false status=0,错误摘要入档,promise 语义不变(照常抛给 pi)", async () => {
    logged.length = 0;
    fakeResponder = () => {
      throw new Error("connect ECONNREFUSED");
    };
    await expect(runWithGoogleRequestLog(CTX, () => fetch(ENDPOINT))).rejects.toThrow("ECONNREFUSED");
    await flushLogs();
    expect(logged.length).toBe(1);
    expect(logged[0]).toMatchObject({ ok: false, status: 0 });
    expect(String(logged[0]!.error)).toContain("ECONNREFUSED");
  });

  test("嵌套异步(pi SDK 内部多层 await):ALS 上下文穿透", async () => {
    logged.length = 0;
    fakeResponder = () => new Response("ok", { status: 200 });
    await runWithGoogleRequestLog(CTX, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await fetch(ENDPOINT);
    });
    await flushLogs();
    expect(logged.length).toBe(1);
    expect(logged[0]!.url).toBe(ENDPOINT);
  });
});
