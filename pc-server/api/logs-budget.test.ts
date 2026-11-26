// api/logs-budget.test.ts — 请求日志正文限量、列表不带正文、按 id 取详情(PF.4)。
// 契约:正文(请求体 + 响应体)合计超过预算时从最旧的开始只释放正文,条目留着并标记;最新一条永远保留正文;
// 入列时记下两个长度;GET /api/logs 不带正文、错误文本截短;GET /api/logs/:id 回完整条目,找不到 404;清空照旧。
import { beforeEach, describe, expect, test } from "bun:test";

import type { RequestLog, State } from "../foundation/types";
import { setState, state } from "../persistence/json-store";
import { addLog, LOG_BODY_BUDGET_CHARS, logListItem, releaseOldLogBodies } from "./logs";
import { handleSystemRoutes } from "./handlers/system";

beforeEach(() => {
  setState({ ...state, logs: [], stats: { totalRequests: 0, failedRequests: 0, byProvider: {}, byGroup: {} } } as State);
});

const base = { providerId: "p1", providerName: "Fake", url: "https://example.test/v1/chat", ok: true, status: 200, method: "POST" };
const log = (idValue: string, requestBody?: string, responseBody?: string): RequestLog => ({ id: idValue, at: 1, ...base, requestBody, responseBody });

async function route(path: string, method = "GET") {
  const response = await handleSystemRoutes(new Request(`http://127.0.0.1/api/${path}`, { method }), new URL(`http://127.0.0.1/api/${path}`), path);
  return { status: response!.status, body: await response!.json() };
}

describe("正文预算", () => {
  test("从最新往最旧累加,越线那条起往后只释放正文;已释放的不再计入", () => {
    const logs = [log("a", "x".repeat(40), "y".repeat(10)), log("b", "x".repeat(30)), log("c", "x".repeat(30), "y"), log("d", "x".repeat(5))];
    releaseOldLogBodies(logs, 80);
    expect(logs.map((l) => [l.id, l.requestBody?.length ?? null, l.responseBody?.length ?? null, l.bodiesReleased ?? false])).toEqual([
      ["a", 40, 10, false],
      ["b", 30, null, false],
      ["c", null, null, true],
      ["d", null, null, true],
    ]);
    releaseOldLogBodies(logs, 80);
    expect(logs.filter((l) => l.bodiesReleased).map((l) => l.id)).toEqual(["c", "d"]);
  });

  test("最新一条哪怕自己就超预算也保留正文", () => {
    const logs = [log("big", "x".repeat(200)), log("old", "x")];
    releaseOldLogBodies(logs, 100);
    expect(logs[0]!.requestBody?.length).toBe(200);
    expect(logs[1]!.bodiesReleased).toBe(true);
  });

  test("addLog:记下两个长度;总量超预算后最旧的正文被释放,条目数仍按 100 条截", () => {
    const quarter = "x".repeat(LOG_BODY_BUDGET_CHARS / 4);
    for (let i = 0; i < 6; i++) addLog({ ...base, kind: `k${i}`, requestBody: quarter, responseBody: "ok" });
    expect(state.logs).toHaveLength(6);
    expect(state.logs[0]).toMatchObject({ kind: "k5", requestBodyLength: quarter.length, responseBodyLength: 2 });
    expect(state.logs.map((l) => l.bodiesReleased ?? false)).toEqual([false, false, false, true, true, true]);
    expect(state.logs[5]).toMatchObject({ kind: "k0", requestBodyLength: quarter.length, bodiesReleased: true });
    expect(state.logs[5]!.requestBody).toBeUndefined();
    const total = state.logs.reduce((n, l) => n + (l.requestBody?.length ?? 0) + (l.responseBody?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(LOG_BODY_BUDGET_CHARS);
    for (let i = 0; i < 120; i++) addLog({ ...base, kind: "small", requestBody: "{}" });
    expect(state.logs).toHaveLength(100);
  });
});

describe("接口", () => {
  test("列表不带正文、留着头与长度,错误文本截短;详情带完整正文;找不到回 404", async () => {
    const longError = "e".repeat(5000);
    addLog({ ...base, ok: false, status: 500, requestHeaders: { Authorization: "Bearer sk-abcdefghijk" }, requestBody: '{"model":"m"}', responseBody: longError, error: longError });
    const { status, body } = await route("logs");
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].requestBody).toBeUndefined();
    expect(body[0].responseBody).toBeUndefined();
    expect(body[0]).toMatchObject({ requestBodyLength: 13, responseBodyLength: 5000, requestHeaders: { Authorization: "Bearer sk-***ijk" } });
    expect(body[0].error.length).toBeLessThan(1100);
    const detail = await route(`logs/${body[0].id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ requestBody: '{"model":"m"}', responseBody: longError, error: longError });
    expect((await route("logs/no-such-id")).status).toBe(404);
  });

  test("列表项是拷贝:截短错误文本不改动内存里的条目", () => {
    const entry = log("x", "req", "res");
    entry.error = "e".repeat(5000);
    const item = logListItem(entry);
    expect(item.error!.length).toBeLessThan(1100);
    expect(entry.error.length).toBe(5000);
    expect(entry.requestBody).toBe("req");
  });

  test("清空之后列表为空、详情 404", async () => {
    addLog({ ...base, requestBody: "{}" });
    const id = state.logs[0]!.id;
    expect((await route("logs", "DELETE")).status).toBe(200);
    expect((await route("logs")).body).toEqual([]);
    expect((await route(`logs/${id}`)).status).toBe(404);
  });
});
