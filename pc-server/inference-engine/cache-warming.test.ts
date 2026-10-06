// inference-engine/cache-warming.test.ts — C2 宿主预热服务行为锁。
//
// 锁住六件事(方案 §8.2 C2 验收口径):
//  1. 门控:策略关(warming=false)/第三方 Anthropic 端点 → 不捕获不重放;
//     官方 api.anthropic.com + 策略开 → 捕获并调度。
//  2. 值得预热:无缓存证明(cachedTokens/cacheWriteTokens 全 0)且 prompt 短 → 不调度;
//     有证明或 prompt 足够长 → 调度。重放形态 = 原请求体 + max_tokens:1 + stream:false。
//  3. 到点触发:受控时钟推进到 nextWarmAt → 发一次重放,成功后重排下一次(计时重置)。
//  4. 迟到防线:时钟推进超过 refreshDeadline → 不发,计划终止。
//  5. 停止条件:生成结束 stopCacheWarming / 会话删除 discardCacheWarmingState / 1 小时
//     硬上限 → 不再重放;新请求覆盖旧计划并重置计时。
//  6. 重放安全:预算式 thinking(type:"enabled")不捕获;失败重放停止计划并 info 上报。
//
// 驱动方式:fake inner fetch(拦截器闭包捕获)+ 受控 warmingClock + 立即调度器
// (llm-request-log.test 同款纪律:全局 fetch 替换只收进 beforeAll/afterAll 执行窗口,
// 不 patch 全局 Date/setTimeout——bun test 同进程,全局 mock 会污染别的文件)。

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

import * as actualLogs from "../api/logs";

const logged: Array<Record<string, unknown>> = [];
mock.module("../api/logs", () => ({ ...actualLogs, addLog: (entry: Record<string, unknown>) => logged.push(entry) }));

const {
  cacheWarmingContextFor,
  cacheWarmingDelayMs,
  discardCacheWarmingState,
  installCacheWarmingInterceptor,
  isAnthropicReplayable,
  isWarmingEligibleEndpoint,
  noteCacheUsage,
  resetCacheWarmingForTest,
  runWithCacheWarming,
  stopCacheWarming,
  warmingClock,
  warmingScheduler,
} = await import("./cache-warming");
const { provider } = await import("../model-providers");

// ---- fake fetch(拦截器 inner)----
const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
let fetchResponder: (url: string, body: Record<string, unknown>) => Response = () => new Response("{}", { status: 200 });
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  fetchCalls.push({ url, init });
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  return fetchResponder(url, body);
}) as typeof fetch;

let realFetch: typeof fetch;
let realClockNow: () => number;
const originalSchedulerSet = warmingScheduler.set;
const originalSchedulerClear = warmingScheduler.clear;

// 受控时钟:nowMs 可推进。调度器模拟"按时触发":收到延迟 ms 就把时钟推进 ms+overshoot
// 再回调(0 延迟即原地触发)——refresh 的迟到判定/重排语义全由真实 clock+deadline 驱动,
// 只是不等真墙钟。「迟到」用例单独设 overshoot 越过 deadline,模拟休眠唤醒后的迟到。
let nowMs = 1_000_000;
const advanceClock = (ms: number) => {
  nowMs += ms;
};
/** 立即调度器的额外推进量(默认 0=精确到点;迟到用例设正数)。 */
let scheduleOvershootMs = 0;
/** 每个 flushAsync 窗口只放行一次定时器触发:真实定时器的 270s 间隔在测试里被压成
 *  0ms,不设闸的话一次 flush 就把"重放→重排→再重放"整条链跑穿,断言没法分拍。 */
let firesLeftThisFlush = 0;
/** 测试代数:afterEach 递增,旧代调度器的退避重挂链就地消亡——否则残留链会在下个
 *  用例的 flush 窗口里抢走名额,把"该发的重放"挤成不发(跨用例污染)。 */
let schedulerGeneration = 0;

beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  realClockNow = warmingClock.now;
  warmingClock.now = () => nowMs;
  warmingScheduler.set = (fn: () => void, ms: number) => {
    const generation = schedulerGeneration;
    const arm = (delay: number): ReturnType<typeof setTimeout> =>
      originalSchedulerSet(() => {
        if (generation !== schedulerGeneration) return; // 用例已收场:链就地消亡
        if (firesLeftThisFlush <= 0) {
          // 本拍名额已用:降档重挂(5ms 退避,防 0ms 自旋热环烧事件循环)等下一拍。
          handle = arm(5);
          return;
        }
        firesLeftThisFlush -= 1;
        // 到点即触发:把时钟推到「计划触发时刻 + 额外迟到量」再执行回调,refresh 内的
        // 迟到防线/重排计算读到的都是正确的到点时刻。
        nowMs += Math.max(0, ms) + scheduleOvershootMs;
        fn();
      }, delay);
    let handle = arm(0);
    return handle;
  };
  installCacheWarmingInterceptor(); // 闭包捕获 fakeFetch 为 inner(幂等,进程内一次)
});
afterAll(() => {
  globalThis.fetch = realFetch;
  warmingClock.now = realClockNow;
  warmingScheduler.set = originalSchedulerSet;
  warmingScheduler.clear = originalSchedulerClear;
});
afterEach(() => {
  schedulerGeneration += 1; // 残留退避链就地消亡(见声明处注释)
  resetCacheWarmingForTest();
  fetchCalls.length = 0;
  logged.length = 0;
  nowMs = 1_000_000;
  scheduleOvershootMs = 0;
  fetchResponder = () => new Response("{}", { status: 200 });
});

// ---- fixtures ----

function anthropicProviderFixture(overrides: Record<string, unknown> = {}) {
  return provider({
    id: "00000000-0000-4000-8000-0000000000w1",
    name: "Warming Claude",
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "sk-test",
    type: "claude",
    promptCaching: true,
    ...overrides,
  });
}

/** 一条"带 cache_control 的长 prompt"Anthropic 流式请求(system 块级标记,pi 形态)。 */
const LONG_BODY = {
  model: "claude-fake-5",
  max_tokens: 8192,
  stream: true,
  system: [{ type: "text", text: "S".repeat(20_000), cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "你好".repeat(500) }] }],
};

async function fireAnthropicRequest(
  ctxProvider: ReturnType<typeof anthropicProviderFixture>,
  conversationId: string,
  body: Record<string, unknown> = LONG_BODY,
) {
  await runWithCacheWarming(cacheWarmingContextFor(ctxProvider, conversationId), () =>
    fetch(`https://api.anthropic.com/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-test" },
      body: JSON.stringify(body),
    }),
  );
}

/** 一个 flush = 一个"到点拍":放行一次定时器触发并等它跑完(重放的 fetch/日志都是
 *  异步链)。需要下一拍就再 flush 一次——与生产的 270s 间隔同构,只是毫秒级。 */
async function flushAsync(): Promise<void> {
  firesLeftThisFlush = 1;
  await new Promise((resolve) => setTimeout(resolve, 20));
  firesLeftThisFlush = 0;
}

// ---- 1) 门控 ----

describe("C2 预热门控(策略单源 + 端点身份)", () => {
  test("isWarmingEligibleEndpoint:官方 Anthropic 主机可预热;第三方兼容端点/非 claude 行不可", () => {
    expect(isWarmingEligibleEndpoint(anthropicProviderFixture())).toBe(true);
    expect(isWarmingEligibleEndpoint(anthropicProviderFixture({ baseUrl: "https://relay.example.com/v1" }))).toBe(false);
    expect(isWarmingEligibleEndpoint(provider({ id: "o1", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "k" }))).toBe(false);
  });

  test("策略关(promptCacheWarming:false 或 promptCaching 关):上下文为 null,fetch 壳透传零捕获", async () => {
    expect(cacheWarmingContextFor(anthropicProviderFixture({ promptCacheWarming: false }), "c1")).toBeNull();
    expect(cacheWarmingContextFor(anthropicProviderFixture({ promptCaching: false }), "c1")).toBeNull();
    await fireAnthropicRequest(anthropicProviderFixture({ promptCacheWarming: false }), "conv-gate-off");
    await flushAsync();
    // 捕获面:fetchCalls 只含原始请求(1 = 主请求,0 = 重放)
    expect(fetchCalls.length).toBe(1);
  });

  test("订阅 Claude 行(oauth)策略恒开 → 上下文建立(与 D10 联动)", () => {
    const subscriptionRow = anthropicProviderFixture({ authMode: "oauth", promptCaching: undefined });
    expect(cacheWarmingContextFor(subscriptionRow, "c1")).not.toBeNull();
  });

  test("端点门控:第三方 Anthropic 兼容端点即使策略开也不捕获", async () => {
    await fireAnthropicRequest(anthropicProviderFixture({ baseUrl: "https://relay.example.com/v1" }), "conv-relay");
    await flushAsync();
    expect(fetchCalls.length).toBe(1);
  });
});

// ---- 2) 值得预热 + 重放形态 ----

describe("C2 值得预热判定与重放形态", () => {
  test("无缓存证明且 prompt 短(<2048 token):不调度", async () => {
    const shortBody = { ...LONG_BODY, system: [{ type: "text", text: "短", cache_control: { type: "ephemeral" } }] };
    await fireAnthropicRequest(anthropicProviderFixture(), "conv-short", shortBody);
    await flushAsync();
    expect(fetchCalls.length).toBe(1);
  });

  test("noteCacheUsage 报告缓存读:promptTokens 证明落档,同会话下一请求可调度", async () => {
    noteCacheUsage("conv-proven", { promptTokens: 9000, cachedTokens: 8500, completionTokens: 10, totalTokens: 9010 });
    await fireAnthropicRequest(anthropicProviderFixture(), "conv-proven");
    await flushAsync();
    // 捕获即调度(时钟受控,调度器立即):第一拍就会发出重放
    expect(fetchCalls.length).toBe(2);
    const replay = fetchCalls[1]!;
    const replayBody = JSON.parse(String(replay.init?.body)) as Record<string, unknown>;
    // 重放形态:原体 + max_tokens:1 + stream:false,其余逐字段一致(system/cache_control 原样)
    expect(replayBody.max_tokens).toBe(1);
    expect(replayBody.stream).toBe(false);
    expect(replayBody.model).toBe(LONG_BODY.model);
    expect((replayBody.system as Array<Record<string, unknown>>)[0]!.cache_control).toEqual({ type: "ephemeral" });
    // 原始头保留(鉴权照旧)
    expect((replay.init?.headers as Record<string, string>)["x-api-key"]).toBe("sk-test");
  });

  test("prompt 本身足够长(估算通道):即使 usage 未证明也可调度", async () => {
    await fireAnthropicRequest(anthropicProviderFixture(), "conv-long");
    await flushAsync();
    expect(fetchCalls.length).toBe(2);
  });

  test("请求体零 cache_control:不捕获(这轮没在写缓存,重放无意义)", async () => {
    const noMark = { ...LONG_BODY, system: [{ type: "text", text: "S".repeat(20_000) }] };
    await fireAnthropicRequest(anthropicProviderFixture(), "conv-nomark", noMark);
    await flushAsync();
    expect(fetchCalls.length).toBe(1);
  });
});

// ---- 3)+4) 到点触发 + 迟到防线 ----

describe("C2 调度语义(pi 公式吸收)", () => {
  test("cacheWarmingDelayMs:min(TTL×90%, TTL−10s);≤10s 无意义", () => {
    expect(cacheWarmingDelayMs(300_000)).toBe(270_000);
    expect(cacheWarmingDelayMs(3_600_000)).toBe(3_240_000); // 1h×90% = 54min
    expect(cacheWarmingDelayMs(10_000)).toBeUndefined();
  });

  test("到点触发:捕获即调度,首拍重放一次;成功后重排,下一拍到点再发(计时重置)", async () => {
    noteCacheUsage("conv-fire", { promptTokens: 9000, cachedTokens: 8500 });
    await fireAnthropicRequest(anthropicProviderFixture(), "conv-fire");
    await flushAsync();
    // 主请求 + 首拍重放;重排的下一拍要再 flush 才发(分拍闸,270s 间隔同构)
    expect(fetchCalls.length).toBe(2);
    const replayAt = nowMs;
    await flushAsync();
    expect(fetchCalls.length).toBe(3);
    // 第二拍发生在首拍之后一个完整周期(调度回调把时钟推了 nextWarmAt−now)
    expect(nowMs - replayAt).toBeGreaterThanOrEqual(270_000);
  });

  test("迟到防线:定时器迟到越过 refreshDeadline → 不发,计划终止", async () => {
    noteCacheUsage("conv-late", { promptTokens: 9000, cachedTokens: 8500 });
    // overshoot 模拟休眠迟到:回调时时钟多推 16s(5m TTL 的 deadline=nextWarmAt+15s,
    // 越过即迟到)——第一拍就撞线,不发任何重放。
    scheduleOvershootMs = 16_000;
    await fireAnthropicRequest(anthropicProviderFixture(), "conv-late");
    await flushAsync();
    expect(fetchCalls.length).toBe(1); // 只有主请求,迟到重放被拦
    // 计划已删:再 flush/任意推进都不再发
    await flushAsync();
    expect(fetchCalls.length).toBe(1);
  });

  test("重放失败(非 2xx):计划停止 + info 级 reportError(cache_warm_failed)", async () => {
    noteCacheUsage("conv-fail", { promptTokens: 9000, cachedTokens: 8500 });
    fetchResponder = () => new Response('{"error":{"type":"overloaded"}}', { status: 529 });
    await fireAnthropicRequest(anthropicProviderFixture(), "conv-fail");
    await flushAsync();
    expect(fetchCalls.length).toBe(2);
    const warmLogs = logged.filter((l) => l.kind === "provider:cache-warm");
    expect(warmLogs.length).toBe(1);
    expect(warmLogs[0]!.ok).toBe(false);
    expect(warmLogs[0]!.status).toBe(529);
    // 计划已停:再 flush 不再发包
    await flushAsync();
    expect(fetchCalls.length).toBe(2);
    const { recentAppErrors } = await import("../observability/app-errors");
    const entry = recentAppErrors().find((e) => e.code === "cache_warm_failed");
    expect(entry).toBeDefined();
    expect(entry!.severity).toBe("info");
  });
});

// ---- 5) 停止条件 ----

describe("C2 停止条件(streaming 模式:生成结束即停)", () => {
  test("stopCacheWarming:清掉计划,后续拍不再重放", async () => {
    noteCacheUsage("conv-stop", { promptTokens: 9000, cachedTokens: 8500 });
    await fireAnthropicRequest(anthropicProviderFixture(), "conv-stop");
    stopCacheWarming("conv-stop");
    fetchCalls.length = 0;
    await flushAsync();
    await flushAsync();
    expect(fetchCalls.length).toBe(0);
  });

  test("会话删除 discardCacheWarmingState:连缓存证明一起清", async () => {
    noteCacheUsage("conv-del", { promptTokens: 9000, cachedTokens: 8500 });
    discardCacheWarmingState("conv-del");
    // 证明被清:同会话再发请求,不满足"值得预热"(prompt 短款判定)则不调度
    const shortBody = { ...LONG_BODY, system: [{ type: "text", text: "短", cache_control: { type: "ephemeral" } }] };
    await fireAnthropicRequest(anthropicProviderFixture(), "conv-del", shortBody);
    await flushAsync();
    expect(fetchCalls.length).toBe(1);
  });

  test("1 小时硬上限:越过硬上限的重排被拒,计划终止", async () => {
    noteCacheUsage("conv-cap", { promptTokens: 9000, cachedTokens: 8500 });
    await fireAnthropicRequest(anthropicProviderFixture(), "conv-cap");
    await flushAsync();
    expect(fetchCalls.length).toBe(2); // 首拍(t0+270s)
    // 把时钟推到接近硬上限再拍一次:重放成功但重排时 nextWarmAt 越过 startedAt+1h
    // → 计划删除。之后任意拍都不再发包。
    advanceClock(3_600_000 - 270_000 - 5_000);
    await flushAsync();
    const countAfterSecondBeat = fetchCalls.length;
    await flushAsync();
    await flushAsync();
    expect(fetchCalls.length).toBe(countAfterSecondBeat);
    expect(fetchCalls.length).toBeLessThanOrEqual(3);
  });

  test("新请求覆盖旧计划:同会话第二次捕获重置计时(旧 timer 清除防双热)", async () => {
    noteCacheUsage("conv-override", { promptTokens: 9000, cachedTokens: 8500 });
    await fireAnthropicRequest(anthropicProviderFixture(), "conv-override");
    await fireAnthropicRequest(anthropicProviderFixture(), "conv-override");
    await flushAsync();
    // 两次捕获:第一计划的 timer 被清除(双热防线),只剩第二计划在跑。flush 窗口内
    // 主请求×2 + 第二计划重放×1(其到点回调推时钟 270s 后发出)。
    expect(fetchCalls.length).toBe(3);
  });
});

// ---- 6) 重放安全 ----

describe("C2 重放安全谓词", () => {
  test("isAnthropicReplayable:adaptive/disabled/无 thinking 可重放;预算式 enabled 不可", () => {
    expect(isAnthropicReplayable({})).toBe(true);
    expect(isAnthropicReplayable({ thinking: { type: "adaptive" } })).toBe(true);
    expect(isAnthropicReplayable({ thinking: { type: "disabled" } })).toBe(true);
    expect(isAnthropicReplayable({ thinking: { type: "enabled", budget_tokens: 8192 } })).toBe(false);
  });

  test("预算式 thinking 请求不被捕获(防线:budget 由 max_tokens 推导,重放变缓存键)", async () => {
    noteCacheUsage("conv-budget", { promptTokens: 9000, cachedTokens: 8500 });
    const budgetBody = { ...LONG_BODY, thinking: { type: "enabled", budget_tokens: 8192 } };
    await fireAnthropicRequest(anthropicProviderFixture(), "conv-budget", budgetBody);
    await flushAsync();
    expect(fetchCalls.length).toBe(1);
  });
});
