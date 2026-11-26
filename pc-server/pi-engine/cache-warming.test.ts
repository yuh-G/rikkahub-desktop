// pi-engine/cache-warming.test.ts — 「缓存预热」:哪些授权会预热、模型桥给的寿命与价格、一轮之内的时间线(方案 §5.17.3/§5.17.4)
//
// 时间线经 strict 回环驱动真实的 pi 驱动(与生产同一套会话装配),假 Anthropic 上游。寿命经只测试用的环境变量缩成
// 10.25 秒:pi 在寿命 90% 与到期前 10 秒里取早的那个重发,即会话请求后 250 毫秒重发一次。轮里放一个跑得慢或挂住的
// 工具,这段时间就是「一轮运行期间」。重发请求按 max_tokens === 1 认(pi 只有预热把输出上限压到 1)。
// 经真的引擎宿主进程跑的那一遍在 PW.5。
// 记账(§5.17.5):重发按 disableContinuation 认,源码扫描锁住 pi 里只有预热设它;预热的用量条目作为私有条目交给应用、
// 重载时原样回到 pi 会话、不影响长驻会话复用。日志与统计口径的端到端在 conversations/cache-warming-route.test.ts。

import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import type {
  AppToolResult,
  EngineEntryInput,
  EngineHost,
  EngineInstructions,
  EngineSessionView,
  ModelGrant,
  TurnInput,
} from "../engines/contract";
import { connectDriver, connectHost } from "../engines/loopback";
import { modelGrantFor, promptCachePolicyFor } from "../engines/model-grant";
import type { Provider, ToolPart } from "../foundation/types";
import { message } from "../foundation/utils";
import { model, provider } from "../model-providers";
import { sessionViewOf } from "../test-utils/engine-session-view";
import {
  anthropicTextTurn,
  anthropicToolTurn,
  type FakeAnthropicReply,
  type FakeAnthropicServer,
  startFakeAnthropic,
} from "../test-utils/fake-anthropic-sse";
import { createPiDriver } from "./driver";
import { mapGrantToPi } from "./model-bridge";
import { createPiSessionResources } from "./resources";
import { runPiGeneration } from "./runner";
import { createPiSessionHost } from "./session-host";
import { createPiSessionFromView } from "./session-view";

const CLAUDE_SUBSCRIPTION = "d4f86913-80d5-45e4-84ea-3e652ac63cda"; // OAUTH_FLOWS.anthropic.presetProviderId
const KIMI_SUBSCRIPTION = "f9622c8b-5037-4540-b875-3d301521367b"; // OAUTH_FLOWS["kimi-coding"].presetProviderId
const CATALOG_MODEL = "claude-sonnet-4-6"; // pi 目录 anthropic 里有:寿命 300/3600 秒,缓存读 0.3、写 3.75 美元/百万

const claude = (overrides: Partial<Provider> = {}) =>
  provider({ id: crypto.randomUUID(), name: "Warm Claude", baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-test", type: "claude", ...overrides });

const warmingOf = (row: Provider) => promptCachePolicyFor(row).warming;

describe("哪些授权会预热", () => {
  test("官方端点不填 = 预热;用户关了预热、或关了缓存 = 不预热", () => {
    expect(warmingOf(claude())).toBe(true);
    expect(warmingOf(claude({ promptCacheWarming: false }))).toBe(false);
    expect(warmingOf(claude({ promptCaching: false }))).toBe(false);
  });

  test("中转站:默认不预热;缓存与预热都开才预热;只开预热、缓存不填(= 关)不预热", () => {
    const relay = { baseUrl: "https://relay.example.com/v1" };
    expect(warmingOf(claude(relay))).toBe(false);
    expect(warmingOf(claude({ ...relay, promptCaching: true }))).toBe(false);
    expect(warmingOf(claude({ ...relay, promptCaching: true, promptCacheWarming: true }))).toBe(true);
    expect(warmingOf(claude({ ...relay, promptCacheWarming: true }))).toBe(false);
  });

  test("Claude 订阅默认预热、可关;其余订阅(同为 Claude 格式的 Kimi Code)字段写了开也不预热", () => {
    expect(warmingOf(claude({ id: CLAUDE_SUBSCRIPTION, authMode: "oauth" }))).toBe(true);
    expect(warmingOf(claude({ id: CLAUDE_SUBSCRIPTION, authMode: "oauth", promptCacheWarming: false }))).toBe(false);
    expect(warmingOf(claude({ id: KIMI_SUBSCRIPTION, authMode: "oauth", promptCacheWarming: true }))).toBe(false);
  });

  test("OpenAI / Google 格式恒不预热", () => {
    expect(warmingOf(provider({ id: "o", name: "O", baseUrl: "https://api.openai.com/v1", promptCacheKey: true, promptCacheWarming: true }))).toBe(false);
    expect(warmingOf(provider({ id: "g", name: "G", baseUrl: "https://g.example", type: "google", promptCacheWarming: true }))).toBe(false);
  });
});

function registeredModelOf(grant: ModelGrant) {
  const mapped = mapGrantToPi(grant);
  if (!mapped.ok || mapped.mapping.kind !== "registered") throw new Error("应映射为 registered");
  return mapped.mapping.config.models![0]! as { cost: Record<string, unknown>; promptCache?: Record<string, number> };
}

describe("模型桥:寿命与价格", () => {
  const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  test("预热的授权:寿命与价格取 pi 目录里 anthropic 同 id 的模型", () => {
    const config = registeredModelOf(modelGrantFor(claude(), model(CATALOG_MODEL))!);
    expect(config.promptCache).toEqual({ short: 300, long: 3600 });
    expect(config.cost).toMatchObject({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  });

  test("目录里没有同 id(中转站改了模型名):不给寿命与价格,pi 不预热", () => {
    const relay = claude({ baseUrl: "https://relay.example.com/v1", promptCaching: true, promptCacheWarming: true });
    const config = registeredModelOf(modelGrantFor(relay, model("relay-renamed-sonnet"))!);
    expect(config.promptCache).toBeUndefined();
    expect(config.cost).toEqual(ZERO);
  });

  test("不预热的授权:与改前相同(零价格、无寿命)", () => {
    const config = registeredModelOf(modelGrantFor(claude({ promptCacheWarming: false }), model(CATALOG_MODEL))!);
    expect(config.promptCache).toBeUndefined();
    expect(config.cost).toEqual(ZERO);
  });
});

// ---- 时间线 ----

const TTL_SECONDS = 10.25; // pi 的重发间隔 = min(寿命 × 0.9, 寿命 − 10 秒) = 250 毫秒
const DELAY_MS = 250;
const TOOL_MS = 700; // 工具跑这么久,够重发两次
const QUIET_MS = 700; // 近三个重发间隔:该停的话这段时间里不会再有请求

// pi 按上一条回复的提示词量算账,太小时重发不划算,它不预热。给 40 万:idle 档(两轮之间,续上的概率按 15% 算)也划算,
// 所以「一轮结束即停」能分清我们给的 streaming 与 pi 默认的 idle。
const PROMPT_TOKENS = 400_000;
const toolTurn = (id: string) => anthropicToolTurn(id, "lookup", {}, PROMPT_TOKENS);
const textTurn = (text: string) => anthropicTextTurn(text, { input_tokens: PROMPT_TOKENS });

const closers: Array<() => Promise<void>> = [];

async function anthropicUpstream(turns: FakeAnthropicReply[], warm: Parameters<typeof startFakeAnthropic>[1] = {}) {
  const server = await startFakeAnthropic(turns, { promptTokens: PROMPT_TOKENS, ...warm });
  closers.push(server.close);
  return server;
}
type Upstream = FakeAnthropicServer;

const root = mkdtempSync(join(tmpdir(), "pi-cache-warming-"));
const instructions: EngineInstructions = {
  appendSystemPrompt: [],
  globalAgentsFile: null,
  skills: { dir: mkdtempSync(join(tmpdir(), "pi-cache-warming-skills-")), enabled: [] },
};
const lookupTool: TurnInput["tools"][number] = { name: "lookup", description: "查资料", parameters: { type: "object", properties: {} } };
const TOOL_RESULT: AppToolResult = { content: [{ type: "text", text: "查到了" }] };

function driverWith(tool: () => Promise<AppToolResult>) {
  const host: EngineHost = {
    emit: () => undefined,
    session: { load: async () => ({ items: [], compactions: [] }), append: async () => undefined },
    tools: { call: tool },
    permission: { check: async () => ({ scope: "default" }) },
    interaction: { dialog: async () => ({ cancelled: true }), dismiss: () => undefined, show: () => undefined },
    steer: { take: async () => [] },
    turn: { request: () => undefined },
    models: { credential: async () => ({}), log: () => undefined },
    report: () => undefined,
  };
  const driver = connectDriver(createPiDriver(connectHost(host, { strict: true })), { strict: true });
  closers.push(() => driver.dispose());
  return driver;
}

/** 本机假上游不是官方主机(= 中转站),缓存与预热都显式开;模型 id 取目录里有的。 */
function inputFor(upstream: Upstream, row: Partial<Provider> = {}, modelId = CATALOG_MODEL): TurnInput {
  const relay = claude({ baseUrl: upstream.baseUrl, promptCaching: true, promptCacheWarming: true, ...row });
  const grant = modelGrantFor(relay, model(modelId), null, "conv-cache-warming")!;
  return {
    // 本机主机查不到窗口,桥会给保守的 12.8 万;放宽到 100 万,免得 40 万的用量触发 pi 自动压缩。
    model: { ...grant, limits: { ...grant.limits, contextWindow: 1_000_000 } },
    reasoningLevel: null,
    workspace: { cwd: root, root },
    instructions,
    plugins: [],
    prompt: { text: "查一下", images: [] },
    tools: [lookupTool],
  };
}

const toolTakes = (ms: number) => () => Bun.sleep(ms).then(() => TOOL_RESULT);

/** 工具挂住,直到测试放行(正常交回结果)或让它失败(应用中止一轮时,挂着的工具调用以失败收场)。 */
function heldTool() {
  let settle: { resolve: (result: AppToolResult) => void; reject: (err: Error) => void } | undefined;
  return {
    tool: () => new Promise<AppToolResult>((resolve, reject) => (settle = { resolve, reject })),
    release: () => settle?.resolve(TOOL_RESULT),
    fail: () => settle?.reject(new Error("Tool execution aborted")),
  };
}

async function until(cond: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const started = performance.now();
  while (!cond()) {
    if (performance.now() - started > timeoutMs) throw new Error(`等待超时:${label}`);
    await Bun.sleep(10);
  }
}

/** 这段时间里上游一个请求也没收到。 */
async function expectQuiet(upstream: Upstream): Promise<void> {
  const count = upstream.calls.length;
  await Bun.sleep(QUIET_MS);
  expect(upstream.calls.length).toBe(count);
}

const turnOf = (conversationId: string, input: TurnInput) => ({ conversationId, turnId: crypto.randomUUID(), input });

describe("时间线(假 Anthropic 上游,寿命缩成几秒)", () => {
  beforeAll(() => {
    process.env.RIKKAHUB_TEST_PROMPT_CACHE_TTL_SECONDS = String(TTL_SECONDS);
  });
  afterAll(async () => {
    delete process.env.RIKKAHUB_TEST_PROMPT_CACHE_TTL_SECONDS;
    await Promise.all(closers.map((close) => close()));
  });

  test("工具跑着时到期前重发,内容与上一个会话请求相同只差输出上限;一轮结束即停", async () => {
    const upstream = await anthropicUpstream([toolTurn("tu-1"), textTurn("完成")]);
    const driver = driverWith(toolTakes(TOOL_MS));
    const result = await driver.startTurn(turnOf("conv-warm-1", inputFor(upstream)));
    expect(result.text).toBe("完成");
    const [first, second] = upstream.sessions();
    const warms = upstream.warms().filter((call) => call.at < second!.at);
    expect(warms.length).toBeGreaterThanOrEqual(2);
    // 按寿命排的时间重发(不是一收到回复就发),早于到期。
    expect(warms[0]!.at - first!.at).toBeGreaterThan(DELAY_MS * 0.8);
    expect(warms[0]!.at - first!.at).toBeLessThan(TTL_SECONDS * 1000);
    for (const warm of warms) {
      expect({ ...warm.body, max_tokens: first!.body.max_tokens } as Record<string, unknown>).toEqual(first!.body);
    }
    expect(JSON.stringify(first!.body)).toContain("cache_control");
    await expectQuiet(upstream);
  }, 20_000);

  test("点停止即停", async () => {
    const upstream = await anthropicUpstream([toolTurn("tu-2")]);
    const held = heldTool();
    const driver = driverWith(held.tool);
    const run = driver.startTurn(turnOf("conv-warm-2", inputFor(upstream)));
    await until(() => upstream.warms().length >= 1, "第一次重发");
    await driver.abort("conv-warm-2", "interrupted");
    held.fail();
    expect((await run).stopReason).toBe("aborted");
    await expectQuiet(upstream);
  }, 20_000);

  test("删会话即停(应用先中止在跑的那轮,再作废会话)", async () => {
    const upstream = await anthropicUpstream([toolTurn("tu-3")]);
    const held = heldTool();
    const driver = driverWith(held.tool);
    const run = driver.startTurn(turnOf("conv-warm-3", inputFor(upstream)));
    await until(() => upstream.warms().length >= 1, "第一次重发");
    await driver.abort("conv-warm-3", "deleted");
    const invalidated = driver.invalidate("conv-warm-3");
    held.fail();
    await Promise.all([run, invalidated]);
    await expectQuiet(upstream);
  }, 20_000);

  test("一轮失败即停", async () => {
    const upstream = await anthropicUpstream([
      toolTurn("tu-4"),
      { status: 400, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "坏请求" } }) },
    ]);
    const driver = driverWith(toolTakes(TOOL_MS));
    await expect(driver.startTurn(turnOf("conv-warm-4", inputFor(upstream)))).rejects.toThrow("坏请求");
    expect(upstream.warms().length).toBeGreaterThanOrEqual(1);
    await expectQuiet(upstream);
  }, 20_000);

  test("重发失败(429)不影响这一轮,下一次照常再试", async () => {
    const upstream = await anthropicUpstream([toolTurn("tu-5"), textTurn("完成")], {
      reply: (count) => (count === 1 ? { status: 429, body: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "慢点" } }) } : undefined),
    });
    const driver = driverWith(toolTakes(TOOL_MS));
    const result = await driver.startTurn(turnOf("conv-warm-5", inputFor(upstream)));
    expect(result.text).toBe("完成");
    const second = upstream.sessions()[1]!;
    expect(upstream.warms().filter((call) => call.at < second.at).length).toBeGreaterThanOrEqual(2);
  }, 20_000);

  test("改开关:下一轮换会话,新会话不预热", async () => {
    const upstream = await anthropicUpstream([toolTurn("tu-6"), textTurn("一"), toolTurn("tu-7"), textTurn("二")]);
    const driver = driverWith(toolTakes(TOOL_MS));
    await driver.startTurn(turnOf("conv-warm-6", inputFor(upstream)));
    const warmed = upstream.warms().length;
    expect(warmed).toBeGreaterThanOrEqual(2);
    const result = await driver.startTurn(turnOf("conv-warm-6", inputFor(upstream, { promptCacheWarming: false })));
    expect(result.text).toBe("二");
    expect(upstream.warms().length).toBe(warmed);
  }, 20_000);

  test("价格查不到(目录里没有这个模型 id):一次也不重发", async () => {
    const upstream = await anthropicUpstream([toolTurn("tu-8"), textTurn("完成")]);
    const driver = driverWith(toolTakes(TOOL_MS));
    await driver.startTurn(turnOf("conv-warm-8", inputFor(upstream, {}, "relay-renamed-sonnet")));
    expect(upstream.calls.length).toBe(2);
  }, 20_000);

  test("1 小时上限:拨快到 59 分钟照常续,拨满 1 小时即停", async () => {
    const held = heldTool();
    const upstream = await anthropicUpstream([toolTurn("tu-9"), textTurn("完成")], {
      // 在重发到达时拨表:pi 收到这次回复后排下一次,排的时候看上限。
      onWarm: (count) => {
        if (count === 1) setSystemTime(new Date(Date.now() + 59 * 60_000));
        if (count === 2) setSystemTime(new Date(Date.now() + 60_000));
      },
    });
    const driver = driverWith(held.tool);
    try {
      const run = driver.startTurn(turnOf("conv-warm-9", inputFor(upstream)));
      await until(() => upstream.warms().length >= 2, "第二次重发");
      await expectQuiet(upstream);
      expect(upstream.warms().length).toBe(2);
      held.release();
      expect((await run).text).toBe("完成");
    } finally {
      setSystemTime();
    }
  }, 20_000);
});

describe("记账(§5.17.5)", () => {
  afterAll(async () => {
    await Promise.all(closers.map((close) => close()));
  });

  test("源码扫描:pi 里只有预热的重放选项设 disableContinuation(模型出口按它认出预热的重发)", () => {
    const packages = resolve(import.meta.dir, "..", "..", "pi", "packages");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name === "node_modules") return [];
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
      });
    const setters = readdirSync(packages)
      .flatMap((name) => {
        const src = join(packages, name, "src");
        try {
          return walk(src);
        } catch {
          return []; // 没有 src 的包(只有脚本或文档)
        }
      })
      .filter((file) => /disableContinuation\s*[:=]\s*true\b/.test(readFileSync(file, "utf8")))
      .map((file) => relative(packages, file).split(sep).join("/"));
    expect(setters).toEqual(["ai/src/cache-warming.ts"]);
  });

  test("预热的用量作为私有条目交给应用;重载时原样回到 pi 会话;下一轮照常接着用长驻会话", async () => {
    process.env.RIKKAHUB_TEST_PROMPT_CACHE_TTL_SECONDS = String(TTL_SECONDS);
    try {
      const upstream = await anthropicUpstream([toolTurn("tu-r1"), textTurn("完成"), textTurn("第二轮")]);
      const sessions = createPiSessionHost({ onTurnRequest: () => undefined });
      closers.push(() => sessions.dispose());
      const conversationId = crypto.randomUUID();
      const grant = inputFor(upstream).model;
      const turn = async (view: EngineSessionView, promptText: string) => {
        const delivered: EngineEntryInput[] = [];
        await runPiGeneration({
          grant,
          conversationId,
          cwd: root,
          view,
          promptText,
          resources: (approvePluginTool) => createPiSessionResources({ cwd: root, root, instructions, approvePluginTool, cacheWarming: true }),
          appendEntries: async (entries) => void delivered.push(...entries),
          sessions: { host: sessions, key: "k" },
          tools: [lookupTool],
          callTool: toolTakes(TOOL_MS),
          sink: () => undefined,
        });
        return delivered;
      };

      const delivered = await turn(sessionViewOf([]), "查一下");
      const warmUsage = delivered.filter((entry) => {
        const payload = entry.payload as { type?: string; kind?: string };
        return payload.type === "usage" && payload.kind === "cache_warm";
      });
      expect(warmUsage.length).toBeGreaterThanOrEqual(1);
      expect(warmUsage.length).toBeLessThanOrEqual(upstream.warms().length);
      const live = sessions.peek(conversationId);
      expect(live).toBeDefined();

      // 应用封存后下一轮原样给回:中立消息 = 工具调用 + 回答正文,原生组 = 这一轮交出的全部条目。
      const user = message("USER", [{ type: "text", text: "查一下" }]);
      const tool = { type: "tool", toolCallId: "tu-r1", toolName: "lookup", input: "{}", output: [{ type: "text", text: "查到了" }], approvalState: { type: "auto" } } as ToolPart;
      const answer = message("ASSISTANT", [tool, { type: "text", text: "完成" }], CATALOG_MODEL);
      const view = sessionViewOf([user, answer]);
      view.items[1]!.native = delivered.map((entry, seq) => ({ seq, format: entry.format, entryId: entry.entryId ?? null, payload: JSON.parse(JSON.stringify(entry.payload)) }));

      const reloaded = createPiSessionFromView({ cwd: root, conversationId, view, fallbackModelId: CATALOG_MODEL });
      const reloadedIds = new Set(reloaded.manager.getEntries().map((entry) => entry.id));
      expect(warmUsage.every((entry) => reloadedIds.has(entry.entryId!))).toBe(true);
      expect(reloaded.degradedMessageIds).toEqual([]);

      await turn(view, "接着");
      expect(sessions.peek(conversationId)).toBe(live);
      expect(upstream.sessions().length).toBe(3);
    } finally {
      delete process.env.RIKKAHUB_TEST_PROMPT_CACHE_TTL_SECONDS;
    }
  }, 20_000);
});
