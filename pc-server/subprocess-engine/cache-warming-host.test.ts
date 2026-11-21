// subprocess-engine/cache-warming-host.test.ts — 缓存预热经真的引擎宿主进程跑一遍(方案 §5.17.4、PW.5)
//
// 与生产同一条路:launchEngineHost 起 engine-host 角色(spawnSelf + 专用通道),pi 驱动在子进程里,主程序这边只实现
// EngineHost。假 Anthropic 上游;寿命经只测试用的环境变量缩成 10.25 秒(子进程沿用 bun test 的 NODE_ENV,短寿命只在测试下
// 生效,见 pi-engine/model-bridge 的 testPromptCacheLifetime)。锁:①工具挂在跨进程的 host.tools.call 上时到期前重发,请求体
// 与会话请求只差输出上限;②预热的请求记录带 purpose 跨进程回到主程序,用量条目经 host.session.append 回来;③一轮结束即停;
// ④宿主进程被强杀,定时器随进程消失,不再有请求。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppToolResult, EngineEntryInput, EngineHost, ModelRequestRecord, TurnInput } from "../engines/contract";
import { modelGrantFor } from "../engines/model-grant";
import { model, provider } from "../model-providers";
import { anthropicTextTurn, anthropicToolTurn, startFakeAnthropic, type FakeAnthropicServer } from "../test-utils/fake-anthropic-sse";
import { launchEngineHost, type EngineHostProcess } from "./host-launch";

const scratch = mkdtempSync(join(tmpdir(), "rkh-warm-host-"));
const PROMPT_TOKENS = 400_000;
const QUIET_MS = 700;
const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of closers.reverse()) await close();
  rmSync(scratch, { recursive: true, force: true });
});

interface Recorded {
  logs: ModelRequestRecord[];
  entries: EngineEntryInput[];
}

function hostWith(tool: () => Promise<AppToolResult>, recorded: Recorded): EngineHost {
  return {
    emit: () => undefined,
    session: { load: async () => ({ items: [], compactions: [] }), append: async (_turn, entries) => void recorded.entries.push(...entries) },
    tools: { call: tool },
    permission: { check: async () => ({ scope: "default" }) },
    interaction: { dialog: async () => ({ cancelled: true }), dismiss: () => undefined, show: () => undefined },
    steer: { take: async () => [] },
    turn: { request: () => undefined },
    models: { credential: async () => ({}), log: (_turn, record) => void recorded.logs.push(record) },
    report: () => undefined,
  };
}

async function launch(host: EngineHost): Promise<EngineHostProcess> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: "test",
    RIKKAHUB_PC_DATA_DIR: mkdtempSync(join(scratch, "data-")),
    RIKKAHUB_TEST_PROMPT_CACHE_TTL_SECONDS: "10.25",
    NO_PROXY: "127.0.0.1,localhost",
  };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[key];
  const child = await launchEngineHost({
    host,
    proxyConfig: { mode: "direct", url: "", username: "", password: "", bypassRules: "", userAgent: "" },
    onAppError: () => undefined,
    onProtocolError: () => undefined,
    env,
  });
  closers.push(async () => {
    await child.stop();
  });
  return child;
}

function inputFor(upstream: FakeAnthropicServer): TurnInput {
  const relay = provider({
    id: crypto.randomUUID(),
    name: "Warm Host",
    type: "claude",
    baseUrl: upstream.baseUrl,
    apiKey: "sk-host",
    promptCaching: true,
    promptCacheWarming: true,
  });
  const grant = modelGrantFor(relay, model("claude-sonnet-4-6"), null, "conv-warm-host")!;
  const root = mkdtempSync(join(scratch, "ws-"));
  return {
    model: { ...grant, limits: { ...grant.limits, contextWindow: 1_000_000 } },
    reasoningLevel: null,
    workspace: { cwd: root, root },
    instructions: { appendSystemPrompt: [], globalAgentsFile: null, skills: { dir: mkdtempSync(join(scratch, "skills-")), enabled: [] } },
    plugins: [],
    prompt: { text: "查一下", images: [] },
    tools: [{ name: "lookup", description: "查资料", parameters: { type: "object", properties: {} } }],
  };
}

async function upstreamFor(): Promise<FakeAnthropicServer> {
  const upstream = await startFakeAnthropic(
    [anthropicToolTurn("tu-host", "lookup", {}, PROMPT_TOKENS), anthropicTextTurn("完成", { input_tokens: PROMPT_TOKENS })],
    { promptTokens: PROMPT_TOKENS },
  );
  closers.push(upstream.close);
  return upstream;
}

async function until(cond: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const started = performance.now();
  while (!cond()) {
    if (performance.now() - started > timeoutMs) throw new Error(`等待超时:${label}`);
    await Bun.sleep(10);
  }
}

/** 工具挂在主程序这边,直到测试放行。 */
function heldTool() {
  let release: (() => void) | undefined;
  return {
    tool: () => new Promise<AppToolResult>((resolve) => (release = () => resolve({ content: [{ type: "text", text: "查到了" }] }))),
    release: () => release?.(),
  };
}

describe("缓存预热 × 引擎宿主进程", () => {
  test("工具挂着时重发;记录带 purpose、用量条目跨进程回到主程序;一轮结束即停", async () => {
    const upstream = await upstreamFor();
    const recorded: Recorded = { logs: [], entries: [] };
    const held = heldTool();
    const child = await launch(hostWith(held.tool, recorded));
    const run = child.driver.startTurn({ conversationId: "conv-warm-host", turnId: "turn-1", input: inputFor(upstream) });
    await until(() => upstream.warms().length >= 2, "两次重发");
    held.release();
    expect((await run).text).toBe("完成");

    const [first] = upstream.sessions();
    for (const warm of upstream.warms()) {
      expect({ ...warm.body, max_tokens: first!.body.max_tokens } as Record<string, unknown>).toEqual(first!.body);
    }
    const settled = upstream.calls.length;
    await Bun.sleep(QUIET_MS);
    expect(upstream.calls.length).toBe(settled);

    await until(() => recorded.logs.length >= upstream.calls.length, "请求记录");
    expect(recorded.logs.filter((record) => record.purpose === "cache_warm").length).toBe(upstream.warms().length);
    expect(recorded.logs.filter((record) => record.purpose === undefined).length).toBe(upstream.sessions().length);
    const warmUsage = recorded.entries.filter((entry) => (entry.payload as { type?: string; kind?: string }).kind === "cache_warm");
    expect(warmUsage.length).toBeGreaterThanOrEqual(1);
  }, 40_000);

  test("宿主进程被强杀:定时器随进程消失,不再有请求", async () => {
    const upstream = await upstreamFor();
    const held = heldTool();
    const child = await launch(hostWith(held.tool, { logs: [], entries: [] }));
    const run = child.driver.startTurn({ conversationId: "conv-warm-host-2", turnId: "turn-2", input: inputFor(upstream) }).catch(() => undefined);
    await until(() => upstream.warms().length >= 1, "第一次重发");
    child.kill();
    await child.exited;
    await run;
    const after = upstream.calls.length;
    await Bun.sleep(QUIET_MS);
    expect(upstream.calls.length).toBe(after);
  }, 40_000);
});
