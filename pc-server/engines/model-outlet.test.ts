// engines/model-outlet.test.ts — 模型出口的行为锁 + 全局 fetch 壳登记(P2.5)
//
// A 行为:入口规范化(Request 输入拆成字符串 URL + init、头统一成 Headers)、日志口径(响应头到手
//   即记、流式不读体、非 2xx 带错误体、网络失败 status 0)、google 轨不注入出口。
// B 完整性:生产代码里给 globalThis.fetch 赋值的文件只允许登记在册的两层壳。引擎想记日志/改请求,
//   走模型出口;再加一层全局壳即变红。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { applyModelOutlet } from "../pi-engine/model-bridge";
import type { ModelRequestRecord } from "./contract";
import { createModelOutlet } from "./model-outlet";

const identity = { providerId: "p1", providerName: "出口测试" };

let server: ReturnType<typeof Bun.serve>;
const received: Array<{ url: string; method: string; headers: Headers; body: string }> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      received.push({ url: req.url, method: req.method, headers: req.headers, body: await req.text() });
      const path = new URL(req.url).pathname;
      if (path === "/fail") return new Response('{"error":{"message":"quota exceeded"}}', { status: 429 });
      return new Response("data: hello\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

function outletWithLog() {
  const records: ModelRequestRecord[] = [];
  return { records, outlet: createModelOutlet(identity, (record) => void records.push(record)) };
}

async function flushLogs(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("A 行为:模型出口", () => {
  test("字符串 URL + 任意头形状:原样发出,日志带身份、方法、请求体,流式响应体留给调用方", async () => {
    const { records, outlet } = outletWithLog();
    const url = `${server.url}stream`;
    const response = await outlet(url, {
      method: "POST",
      headers: new Headers({ "X-Custom": "1", "Content-Type": "application/json" }),
      body: '{"model":"m"}',
    });
    // 调用方仍能完整读到流式体(出口不消费它)。
    expect(await response.text()).toBe("data: hello\n\n");
    await flushLogs();
    expect(received.at(-1)?.headers.get("x-custom")).toBe("1");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ ...identity, url, method: "POST", ok: true, status: 200, requestBody: '{"model":"m"}' });
    expect(records[0]!.responseBody).toBeUndefined();
    expect(records[0]!.responseHeaders?.["content-type"]).toBe("text/event-stream");
    expect(typeof records[0]!.durationMs).toBe("number");
  });

  test("Request 输入:拆成字符串 URL + init 交给全局 fetch(net.ts 的壳对 Request 输入不注入超时与 UA)", async () => {
    const seen: Array<Parameters<typeof fetch>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      seen.push(args);
      return realFetch(...args);
    }) as typeof fetch;
    try {
      const { records, outlet } = outletWithLog();
      const url = `${server.url}req`;
      await outlet(new Request(url, { method: "POST", headers: { "X-From": "request" }, body: "payload" }));
      await flushLogs();
      expect(typeof seen[0]?.[0]).toBe("string");
      expect(seen[0]?.[1]?.headers).toBeInstanceOf(Headers);
      expect(received.at(-1)).toMatchObject({ method: "POST", body: "payload" });
      expect(received.at(-1)?.headers.get("x-from")).toBe("request");
      expect(records[0]).toMatchObject({ url, method: "POST", requestBody: "payload" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("非 2xx:日志带截断的错误体;调用方读到的响应不受影响", async () => {
    const { records, outlet } = outletWithLog();
    const response = await outlet(`${server.url}fail`, { method: "POST" });
    expect(await response.text()).toContain("quota exceeded");
    await flushLogs();
    expect(records[0]).toMatchObject({ ok: false, status: 429 });
    expect(records[0]!.responseBody).toContain("quota exceeded");
    expect(records[0]!.error).toContain("quota exceeded");
  });

  test("网络失败:status 0 入档,错误照常抛给调用方", async () => {
    const { records, outlet } = outletWithLog();
    await expect(outlet("http://127.0.0.1:1/unreachable")).rejects.toThrow();
    await flushLogs();
    expect(records[0]).toMatchObject({ ok: false, status: 0, method: "GET" });
    expect(records[0]!.error).toBeTruthy();
  });

  test("pi 运行时注入:google 两条轨不带 fetch(上游拒收),其余轨带出口", () => {
    const seen: Array<{ api: string; fetch: unknown }> = [];
    const runtime = {
      streamSimple: ((model: { api: string }, _context: unknown, options?: { fetch?: unknown }) => {
        seen.push({ api: model.api, fetch: options?.fetch });
        return undefined as never;
      }) as never,
    };
    const outlet = createModelOutlet(identity, () => {});
    applyModelOutlet(runtime, { session: outlet, cacheWarm: outlet });
    const call = runtime.streamSimple as unknown as (model: { api: string }, context: unknown, options?: object) => void;
    for (const api of ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai", "google-vertex"]) {
      call({ api }, {}, { signal: undefined });
    }
    expect(seen.map((item) => [item.api, item.fetch === outlet])).toEqual([
      ["openai-completions", true],
      ["openai-responses", true],
      ["anthropic-messages", true],
      ["google-generative-ai", false],
      ["google-vertex", false],
    ]);
  });

  test("缓存预热的重放(disableContinuation)走另一个出口,记录带 purpose:cache_warm", async () => {
    const used: unknown[] = [];
    const runtime = {
      streamSimple: ((_model: unknown, _context: unknown, options?: { fetch?: unknown }) => {
        used.push(options?.fetch);
        return undefined as never;
      }) as never,
    };
    const session = createModelOutlet(identity, () => {});
    const records: ModelRequestRecord[] = [];
    const cacheWarm = createModelOutlet(identity, (record) => void records.push(record), "cache_warm");
    applyModelOutlet(runtime, { session, cacheWarm });
    const call = runtime.streamSimple as unknown as (model: { api: string }, context: unknown, options?: object) => void;
    call({ api: "anthropic-messages" }, {}, {});
    call({ api: "anthropic-messages" }, {}, { maxTokens: 1, disableContinuation: true });
    expect(used).toEqual([session, cacheWarm]);
    await cacheWarm(`${server.url}warm`, { method: "POST", body: "{}" });
    await flushLogs();
    expect(records[0]).toMatchObject({ method: "POST", ok: true, purpose: "cache_warm" });
  });
});

// ── B 完整性:全局 fetch 壳登记 ─────────────────────────────────────────────────
// 登记表 = 允许给 globalThis.fetch 赋值的生产文件。
const REGISTERED_GLOBAL_FETCH_SHELLS: ReadonlySet<string> = new Set([
  // 基础设施壳:代理 / UA / 关 Bun 300s 空闲定时器 / SSE 禁压缩,管全部出站请求。
  "foundation/net.ts",
  // pi google 轨的请求日志壳(上游适配器拒收注入的 fetch;拆除条件见其头注)。
  "pi-engine/llm-request-log.ts",
]);

const SERVER_ROOT = join(import.meta.dir, "..");
const SKIP_DIRS = new Set(["node_modules", "dist"]);

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...productionFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
}

const GLOBAL_FETCH_ASSIGNMENT = /\bglobalThis\.fetch\s*=(?!=)|defineProperty\(\s*globalThis\s*,\s*["']fetch["']/;

describe("B 完整性:全局 fetch 壳只有登记在册的两层", () => {
  test("给 globalThis.fetch 赋值的生产文件集与登记表一致", () => {
    const found = productionFiles(SERVER_ROOT)
      .filter((file) => GLOBAL_FETCH_ASSIGNMENT.test(stripComments(readFileSync(file, "utf8"))))
      .map((file) => relative(SERVER_ROOT, file).replaceAll("\\", "/"))
      .sort();
    expect(
      found,
      "全局 fetch 壳只允许 foundation/net.ts(基础设施)与 pi google 轨日志壳。引擎的模型请求要记日志或改写,"
        + "走 engines/model-outlet(作为引擎模型客户端的 fetch 注入),不要再包一层全局壳。",
    ).toEqual([...REGISTERED_GLOBAL_FETCH_SHELLS].sort());
  });

  test("扫描器自检:识别赋值与 defineProperty,不误报比较与注释", () => {
    expect(GLOBAL_FETCH_ASSIGNMENT.test("globalThis.fetch = wrapped;")).toBe(true);
    expect(GLOBAL_FETCH_ASSIGNMENT.test('Object.defineProperty(globalThis, "fetch", { value })')).toBe(true);
    expect(GLOBAL_FETCH_ASSIGNMENT.test("if (options.fetch === globalThis.fetch) {}")).toBe(false);
    expect(GLOBAL_FETCH_ASSIGNMENT.test("globalThis.fetch === inner")).toBe(false);
    expect(GLOBAL_FETCH_ASSIGNMENT.test(stripComments("// globalThis.fetch = x"))).toBe(false);
  });
});
