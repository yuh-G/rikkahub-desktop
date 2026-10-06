// engines/llm-middlewares.test.ts — T4 组装点(engines/llm-middlewares)行为锁。
//
// 锁三件事(方案 §6 T4 / §4.3):
//  1. **预热推导谓词** warmingEligible:预热不再靠 adapter 声明,而是从事实推出——
//     `host && run-and-suspend && 策略开 && 官方端点` 四者缺一即 false。D-T2「聊天引擎
//     不预热」由 pause-resume 自动成立。用合成 adapter 逐格覆盖真值表。
//  2. **注册表契约**:每个注册 adapter 必须声明 transport(进程内 host / 子进程 external),
//     且 requestLog 取值合法。第三引擎接入时忘了声明 = 本测试先红。
//  3. **组装决策由声明驱动**(非硬编码):同一请求经 pi adapter(requestLog="transport")的
//     通道记入请求日志,经 chat adapter(requestLog="call-site")的通道不记——证明「挂不挂
//     日志中间件」是读 adapter.transport 推出来的。
//
// 纪律:bun test 同进程,mock.module 与 globalThis.fetch 替换只收进本文件(展开真实模块
// 只覆盖 addLog;global fetch 替换收进 beforeAll/afterAll——llm-request-log.test 同款)。

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

import * as actualLogs from "../api/logs";

const logged: Array<Record<string, unknown>> = [];
mock.module("../api/logs", () => ({ ...actualLogs, addLog: (entry: Record<string, unknown>) => logged.push(entry) }));

const { warmingEligible, engineLlmFetchFor } = await import("./llm-middlewares");
const { createEngineRegistry } = await import("./index");
const { createPiAdapter } = await import("./pi-adapter");
const { createChatAdapter } = await import("./chat-adapter");
const { provider } = await import("../model-providers");
const { resetCacheWarmingForTest, warmingScheduler } = await import("../inference-engine/cache-warming");

import type { EngineAdapter } from "./index";
import type { Provider } from "../foundation/types";

const claudeFixture = (overrides: Record<string, unknown> = {}): Provider =>
  provider({
    id: "p-claude",
    name: "官方 Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "sk-test",
    type: "claude",
    promptCaching: true,
    ...overrides,
  });

/** 合成 adapter:只填 warmingEligible 要读的三格(transport / resumeSemantics),其余置惰性桩。 */
function synthAdapter(transport: EngineAdapter["transport"], resumeSemantics: EngineAdapter["resumeSemantics"]): EngineAdapter {
  return {
    kind: "test",
    matches: () => false,
    resumeSemantics,
    steering: "none",
    transport,
    run: async () => "",
  };
}

describe("warmingEligible — 预热推导真值表(§4.3 预热不声明,而是推出)", () => {
  const hostTransport = { mode: "host", requestLog: "transport" } as const;
  const callSiteTransport = { mode: "host", requestLog: "call-site" } as const;
  const externalTransport = { mode: "external" } as const;

  test("四者全真 → 可预热(run-and-suspend + host + 策略开 + 官方端点)", () => {
    expect(warmingEligible(synthAdapter(hostTransport, "run-and-suspend"), claudeFixture())).toBe(true);
    // 日志来源(call-site / transport)不影响预热判定——只关心是否走宿主通道。
    expect(warmingEligible(synthAdapter(callSiteTransport, "run-and-suspend"), claudeFixture())).toBe(true);
  });

  test("pause-resume(聊天引擎语义)→ 恒 false(D-T2 由此自动成立,不靠特例声明)", () => {
    expect(warmingEligible(synthAdapter(hostTransport, "pause-resume"), claudeFixture())).toBe(false);
  });

  test("子进程引擎(transport=external)→ 恒 false(架构边界:宿主不跨进程预热)", () => {
    expect(warmingEligible(synthAdapter(externalTransport, "run-and-suspend"), claudeFixture())).toBe(false);
  });

  test("策略关 / 第三方端点 → false(端点身份与用户开关都读单源)", () => {
    expect(warmingEligible(synthAdapter(hostTransport, "run-and-suspend"), claudeFixture({ promptCacheWarming: false }))).toBe(false);
    expect(warmingEligible(synthAdapter(hostTransport, "run-and-suspend"), claudeFixture({ promptCaching: false }))).toBe(false);
    expect(warmingEligible(synthAdapter(hostTransport, "run-and-suspend"), claudeFixture({ baseUrl: "https://relay.example.com/v1" }))).toBe(false);
    expect(
      warmingEligible(synthAdapter(hostTransport, "run-and-suspend"), provider({ id: "o", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "k" })),
    ).toBe(false);
  });
});

describe("注册表契约:每个 adapter 必须声明 transport(新引擎漏声明即红)", () => {
  function buildRegistry(): EngineAdapter[] {
    return createEngineRegistry({
      chatRun: async () => "",
      piRun: async () => "",
      piCompact: async () => ({ summary: "", tokensBefore: 0, estimatedTokensAfter: null }),
    });
  }

  test("全部注册 adapter 声明合法 transport;进程内两引擎的事实声明", () => {
    const registry = buildRegistry();
    expect(registry.length).toBeGreaterThanOrEqual(2);
    for (const adapter of registry) {
      const t = adapter.transport;
      expect(t).toBeDefined();
      if (t.mode === "host") {
        expect(["transport", "call-site"]).toContain(t.requestLog);
      } else {
        expect(t.mode).toBe("external");
      }
    }
    // 进程内两引擎的事实声明(与 pi-route.test 的端点契约同一份事实,此处按 kind 取)。
    const pi = registry.find((a) => a.kind === "pi")!;
    const chat = registry.find((a) => a.kind === "chat")!;
    expect(pi.transport).toEqual({ mode: "host", requestLog: "transport" }); // SDK 内部发请求 → 通道记日志
    expect(chat.transport).toEqual({ mode: "host", requestLog: "call-site" }); // 调用点自记
    // 预热只可能落在 run-and-suspend 的宿主引擎上:注册表里恰是 pi。
    expect(warmingEligible(pi, claudeFixture())).toBe(true);
    expect(warmingEligible(chat, claudeFixture())).toBe(false);
  });

  test("注册表恒以 chat 收尾(兜底引擎,resolveEngine 的不空保证)", () => {
    const registry = buildRegistry();
    expect(registry[registry.length - 1]!.kind).toBe("chat");
  });
});

// ---- 组装决策由声明驱动(行为锁) ----

let realFetch: typeof fetch;
beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
afterEach(() => {
  logged.length = 0;
});

describe("engineLlmFetchFor — 组装决策读 adapter.transport,非硬编码", () => {
  const convId = "conv-assembly";

  test("requestLog=transport(pi):经通道的请求记入 provider:agent", async () => {
    const adapter = createPiAdapter({ run: async () => "", compact: async () => ({ summary: "", tokensBefore: 0, estimatedTokensAfter: null }) });
    const channel = engineLlmFetchFor(adapter, convId, "generation")(claudeFixture());
    await channel("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(logged.filter((l) => l.kind === "provider:agent").length).toBe(1);
  });

  test("requestLog=call-site(chat):经通道的请求不记(调用点自记,零双记)", async () => {
    const adapter = createChatAdapter(async () => "");
    const channel = engineLlmFetchFor(adapter, convId, "generation")(claudeFixture());
    await channel("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(logged.filter((l) => l.kind === "provider:agent").length).toBe(0);
  });

  test("transport=external(子进程引擎):无中间件、无预热——宿主通道对其是纯直通", async () => {
    // 子进程引擎的请求不经宿主进程;编排层仍按统一形态下发工厂(不为某类引擎开分支),
    // 组装点据声明返回空链。断言用「调度器调用计数」观测捕获(捕获即调度一次保温定时器),
    // 并先跑**正对照**(pi:host + run-and-suspend)证明该观测对捕获敏感——否则「0 次」
    // 可能只是观测失灵。
    const url = "https://api.anthropic.com/v1/messages";
    const init = (): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-test" },
      body: JSON.stringify({
        model: "m",
        max_tokens: 8,
        system: [{ type: "text", text: "S".repeat(20_000), cache_control: { type: "ephemeral" } }],
        messages: [],
      }),
    });
    const originalSet = warmingScheduler.set;
    let scheduled = 0;
    warmingScheduler.set = (fn, ms) => {
      scheduled += 1;
      return originalSet(fn, ms);
    };
    try {
      const pi = createPiAdapter({ run: async () => "", compact: async () => ({ summary: "", tokensBefore: 0, estimatedTokensAfter: null }) });
      await engineLlmFetchFor(pi, "conv-ext-control", "generation")(claudeFixture())(url, init());
      expect(scheduled).toBe(1); // 正对照:宿主 run-and-suspend 引擎确实捕获并调度

      scheduled = 0;
      logged.length = 0;
      const external = synthAdapter({ mode: "external" }, "run-and-suspend");
      await engineLlmFetchFor(external, "conv-ext", "generation")(claudeFixture())(url, init());
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(scheduled).toBe(0); // 无预热捕获
      expect(logged.length).toBe(0); // 无请求日志中间件
    } finally {
      warmingScheduler.set = originalSet;
      resetCacheWarmingForTest(); // 清掉正对照留下的(unref)保温定时器
    }
  });

  test("工厂按供应商取身份:同一条工厂对不同供应商返回独立通道(压缩路径摘要模型归属正确)", () => {
    const adapter = createPiAdapter({ run: async () => "", compact: async () => ({ summary: "", tokensBefore: 0, estimatedTokensAfter: null }) });
    const factory = engineLlmFetchFor(adapter, convId, "compaction");
    const a = factory(claudeFixture());
    const b = factory(provider({ id: "o", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "k" }));
    expect(a).not.toBe(b);
    expect(typeof a).toBe("function");
  });
});
