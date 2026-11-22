// search/deepseek-search.test.ts — DeepSeek 搜索服务(/v1/tools/search、/v1/tools/fetch)的行为锁
//
// 假上游经服务行的自定义地址接进来(换根不换路径,与用户填中转站是同一条路)。锁:请求体与鉴权;摘要优先、空时用 snippet;
// 结果数钳到 1–50;抓取的标题与正文;401 / 402 / 429 换下一个 key,fetch 的 403(拒抓)与 404 不换;连接测试逐 key 给失败码;
// 选中 DeepSeek 时 query 参数说明带上它认的运算符。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-deepseek-search-"));

const jsonStore = await import("../persistence/json-store");
const { defaultState } = await import("../app-config/defaults");
const { runScrapeWeb, runSearchWeb, testSearchService } = await import("./index");
const { openAiSearchTools } = await import("../tools/bound");

import type { JsonValue, State } from "../foundation/types";

interface Seen {
  path: string;
  auth: string;
  body: Record<string, unknown>;
}

const seen: Seen[] = [];
/** 按 key 定的回复;没登记的 key 回成功。 */
const failures = new Map<string, { status: number; body: string }>();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const auth = request.headers.get("authorization") ?? "";
    const body = (await request.json()) as Record<string, unknown>;
    seen.push({ path, auth, body });
    const failure = failures.get(auth.replace(/^Bearer /, ""));
    if (failure) return new Response(failure.body, { status: failure.status, headers: { "Content-Type": "application/json" } });
    if (path === "/v1/tools/search") {
      return Response.json({
        results: [
          { rerank_score: 2.5, title: "长摘要", url: "https://a.example/1", snippet: "短", summary: "给模型读的长摘要", content: "", date: "2026-06-01T00:00:00+00:00", authority: 3 },
          { rerank_score: 2.1, title: "只有 snippet", url: "https://b.example/2", snippet: "界面用的短摘要", summary: "", content: "", date: null, authority: 1 },
        ],
      });
    }
    if (path === "/v1/tools/fetch") return Response.json({ title: "", content: "# 正文\n\nMarkdown" });
    return new Response("not found", { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
});

const apiError = (message: string) => JSON.stringify({ error: { message, type: "x", param: null, code: "x" } });

function selectDeepSeek(fields: Record<string, JsonValue> = {}) {
  const next = defaultState() as State;
  const index = next.settings.searchServices.findIndex((service) => (service as Record<string, JsonValue>).type === "deepseek");
  expect(index).toBeGreaterThanOrEqual(0);
  next.settings.searchServices[index] = { type: "deepseek", id: "ds", name: "DeepSeek", apiKey: "k1", url: base, ...fields };
  next.settings.searchServiceSelected = index;
  next.settings.enableWebSearch = true;
  jsonStore.setState(next);
}

beforeEach(() => {
  seen.length = 0;
  failures.clear();
});

describe("DeepSeek 搜索", () => {
  test("请求体与鉴权;摘要优先,空时用 snippet", async () => {
    selectDeepSeek();
    const result = await runSearchWeb({ query: "DeepSeek site:github.com" });
    expect(seen).toEqual([{ path: "/v1/tools/search", auth: "Bearer k1", body: { query: "DeepSeek site:github.com", count: 10 } }]);
    const items = result.items as Array<{ id: string; title: string; url: string; text: string }>;
    expect(items.map((item) => [item.id, item.title, item.url, item.text])).toEqual([
      ["1", "长摘要", "https://a.example/1", "给模型读的长摘要"],
      ["2", "只有 snippet", "https://b.example/2", "界面用的短摘要"],
    ]);
  });

  test("结果数钳到 1–50(上游的范围)", async () => {
    selectDeepSeek({ resultSize: 80 });
    await runSearchWeb({ query: "q" });
    expect(seen[0]!.body.count).toBe(50);
  });

  test("401 / 402 / 429 换下一个 key;最后一个也失败时报上游原文", async () => {
    selectDeepSeek({ apiKey: "bad paid busy good" });
    failures.set("bad", { status: 401, body: apiError("Authentication Fails") });
    failures.set("paid", { status: 402, body: apiError("Insufficient Balance") });
    failures.set("busy", { status: 429, body: apiError("Rate limit reached") });
    const result = await runSearchWeb({ query: "q" });
    expect(result.items.length).toBe(2);
    expect(seen.map((call) => call.auth)).toEqual(["Bearer bad", "Bearer paid", "Bearer busy", "Bearer good"]);

    selectDeepSeek({ apiKey: "paid" });
    await expect(runSearchWeb({ query: "q" })).rejects.toThrow("DeepSeek search failed: #402 Insufficient Balance");
  });

  test("400 不换 key", async () => {
    selectDeepSeek({ apiKey: "k1 k2" });
    failures.set("k1", { status: 400, body: apiError("query too long") });
    await expect(runSearchWeb({ query: "q" })).rejects.toThrow("#400 query too long");
    expect(seen.length).toBe(1);
  });
});

describe("DeepSeek 抓取", () => {
  test("请求体 {url};正文是 Markdown,空标题不带", async () => {
    selectDeepSeek();
    const page = await runScrapeWeb({ url: "https://a.example/1" });
    expect(seen).toEqual([{ path: "/v1/tools/fetch", auth: "Bearer k1", body: { url: "https://a.example/1" } }]);
    expect(page).toMatchObject({ url: "https://a.example/1", text: "# 正文\n\nMarkdown" });
    expect((page as { title?: string }).title).toBeUndefined();
  });

  test("403(网页被对方的安全策略拒抓)与 404 与 key 无关,不换 key", async () => {
    selectDeepSeek({ apiKey: "k1 k2" });
    failures.set("k1", { status: 403, body: apiError("Blocked by security policy") });
    await expect(runScrapeWeb({ url: "https://a.example/1" })).rejects.toThrow("DeepSeek fetch failed: #403 Blocked by security policy");
    expect(seen.length).toBe(1);
  });
});

describe("DeepSeek 连接测试", () => {
  test("逐 key 给结果:401 = 鉴权失败,402 = 额度用尽;任一成功即可用", async () => {
    failures.set("bad", { status: 401, body: apiError("Authentication Fails") });
    failures.set("paid", { status: 402, body: apiError("Insufficient Balance") });
    const result = await testSearchService({ type: "deepseek", id: "ds", name: "DeepSeek", apiKey: "bad paid good", url: base });
    expect(result.status).toBe("ok");
    expect(result.endpoint).toBe(`${base}/v1/tools/search`);
    expect((result as { keys: Array<{ status: string; failCode?: string }> }).keys.map((key) => key.failCode ?? key.status)).toEqual([
      "auth_invalid",
      "quota_exhausted",
      "ok",
    ]);
    expect(seen.every((call) => call.body.count === 1)).toBe(true);
  });
});

describe("工具参数说明", () => {
  const queryDescription = () =>
    (openAiSearchTools()[0]!.function.parameters as { properties: { query: { description: string } } }).properties.query.description;

  test("选中 DeepSeek 时带上它认的运算符与长度;别的服务不带", () => {
    selectDeepSeek();
    expect(queryDescription()).toContain("site:");
    expect(queryDescription()).toContain("1-128 characters");
    jsonStore.state.settings.searchServiceSelected = 0;
    expect(queryDescription()).toBe("Focused search query");
  });
});
