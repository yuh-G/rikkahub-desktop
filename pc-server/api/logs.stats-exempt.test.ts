// api/logs.stats-exempt.test.ts — F3/B3 回归锁:保温日志(provider:cache-warm)不进
// stats 计数器,普通请求照计。
//
// 单独成文件的原因:bun 的 mock.module 会热替换模块注册表,连 mock 之前 import 的
// `import * as actualLogs` 都被换掉——cache-warming.test.ts 里 mock 了 addLog(推数组),
// 同文件无法再对真 addLog 断言 stats。这里零 mock,直接走真模块。
import { describe, expect, test } from "bun:test";

const jsonStore = await import("../persistence/json-store");
const { defaultState } = await import("../app-config/defaults");
const { addLog } = await import("./logs");

const baseEntry = {
  providerId: "p1",
  providerName: "Warming Claude",
  url: "https://api.anthropic.com/v1/messages",
  ok: true,
  status: 200,
  durationMs: 5,
  method: "POST",
} as const;

describe("addLog stats 豁免(STATS_EXEMPT_KINDS)", () => {
  test("provider:cache-warm 不计 totalRequests/byProvider/byGroup;普通请求照计", () => {
    jsonStore.setState(defaultState());
    addLog({ ...baseEntry, kind: "provider:cache-warm" });
    expect(jsonStore.state.stats.totalRequests).toBe(0);
    expect(jsonStore.state.stats.byProvider["Warming Claude"]).toBeUndefined();
    expect(jsonStore.state.stats.byGroup["模型请求"]).toBeUndefined();
    // 日志列表照常可见(用户要能看到保温请求确实发了)。
    expect(jsonStore.state.logs.some((l) => l.kind === "provider:cache-warm")).toBe(true);

    addLog({ ...baseEntry, kind: "provider:agent" });
    expect(jsonStore.state.stats.totalRequests).toBe(1);
    expect(jsonStore.state.stats.byProvider["Warming Claude"]).toEqual({ ok: 1, failed: 0 });
    expect(jsonStore.state.stats.byGroup["模型请求"]).toEqual({ ok: 1, failed: 0 });
  });
});
