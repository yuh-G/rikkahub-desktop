// conversations/cache-warming-route.test.ts — 缓存预热经编排器的端到端记账(方案 §5.17.5)
//
// 工作区会话走进程内 pi 驱动(strict 回环),供应商是假 Anthropic 上游。轮里一张写文件的审批卡没人管,这段时间 pi 在缓存
// 到期前重发;寿命经只测试用的环境变量缩成几秒。锁:①日志里预热的重发带 purpose:"cache_warm",会话请求不带;②请求统计只数
// 会话请求,重发失败也不计失败;③看板的失败计数不动;④重发的请求头与它重放的会话请求相同(鉴权、会话身份、UA)。
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-cache-warming-route-"));

const conversations = await import("./index");
const { configureWorkingSet, registerConversation } = await import("./working-set");
const { getConversationMeta } = await import("./read-queries");
const { generating } = await import("./generation-state");
const { generateAnswer } = await import("./orchestrator");
const ws = await import("../workspace");
const { defaultAssistant } = await import("../assistants");
const { defaultState } = await import("../app-config/defaults");
const analytics = await import("../app-config/analytics");
const jsonStore = await import("../persistence/json-store");
const { model, provider } = await import("../model-providers");
const { pendingToolApprovalCount, resolveToolApproval } = await import("../inference-engine/approval-gate");
const { useInProcessPiDriver } = await import("../test-utils/in-process-pi");
const { anthropicTextTurn, anthropicToolTurn, startFakeAnthropic } = await import("../test-utils/fake-anthropic-sse");

import type { Conversation, State } from "../foundation/types";

const priorState = jsonStore.state;
const db = conversations.openConversationsDb();
configureWorkingSet({
  loadConversation: (convId) => {
    const meta = getConversationMeta(db, convId);
    if (!meta) return undefined;
    meta.messages = conversations.loadConversationNodesFromDb(db, convId);
    return meta;
  },
  isGenerating: (id) => generating.has(id),
  hasSseClients: () => false,
  hasDirty: () => false,
});

const restorePiDriver = useInProcessPiDriver();
const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  delete process.env.RIKKAHUB_TEST_PROMPT_CACHE_TTL_SECONDS;
  restorePiDriver();
  jsonStore.setState(priorState);
  await Promise.all(closers.map((close) => close()));
});

// 寿命 10.25 秒 → 250 毫秒重发一次。提示词 5 万 token:pi 算得出重发划算,又在保守窗口(12.8 万)的自动压缩线以下。
const PROMPT_TOKENS = 50_000;

async function waitUntil(cond: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const started = performance.now();
  while (!cond()) {
    if (performance.now() - started > timeoutMs) throw new Error(`等待超时:${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("缓存预热经编排器", () => {
  test("审批卡挂着时重发:日志标预热、不计统计、重发失败不计失败、看板失败数不动、请求头与会话请求相同", async () => {
    process.env.RIKKAHUB_TEST_PROMPT_CACHE_TTL_SECONDS = "10.25";
    const upstream = await startFakeAnthropic(
      [anthropicToolTurn("tu-route", "write", { path: "warm.txt", content: "预热" }, PROMPT_TOKENS), anthropicTextTurn("写好了", { input_tokens: PROMPT_TOKENS })],
      {
        promptTokens: PROMPT_TOKENS,
        reply: (count) => (count === 2 ? { status: 429, body: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "慢点" } }) } : undefined),
      },
    );
    closers.push(upstream.close);
    const ourModel = model("claude-sonnet-4-6");
    const ourProvider = provider({
      id: crypto.randomUUID(),
      type: "claude",
      name: "Warm Route",
      baseUrl: upstream.baseUrl,
      apiKey: "sk-route",
      enabled: true,
      promptCaching: true,
      promptCacheWarming: true,
      models: [ourModel],
    });
    const next = defaultState();
    next.settings.assistantId = "a1";
    next.settings.assistants = [{ ...defaultAssistant(), id: "a1", name: "warm-route" }];
    next.settings.providers = [ourProvider];
    next.settings.chatModelId = ourModel.id;
    next.settings.fastModelId = "";
    jsonStore.setState(next as State);

    const workspace = ws.createWorkspace({ type: "managed", name: "warm-route" });
    ws.updateWorkspace(workspace.id, { permissionPreset: "confirm_each" });
    const now = Date.now();
    const conversation = {
      id: "warm-route-conv",
      assistantId: "a1",
      systemPrompt: null,
      title: "预热",
      messages: [
        {
          id: "warm-route-n1",
          selectIndex: 0,
          messages: [{ id: "warm-route-u1", role: "USER", parts: [{ type: "text", text: "写个文件" }], annotations: [], createdAt: new Date(now).toISOString(), finishedAt: null, translation: null }],
        },
      ],
      chatSuggestions: [],
      isPinned: false,
      createAt: now,
      updateAt: now,
      workspaceId: workspace.id,
    } as unknown as Conversation;
    conversations.persistConversation(conversation);
    registerConversation(conversation);

    const errBumps = spyOn(analytics, "bumpAnalyticsErrCount");
    const statsBefore = structuredClone(jsonStore.state.stats);
    try {
      const generation = generateAnswer(conversation);
      await waitUntil(() => pendingToolApprovalCount() === 1, "审批卡");
      await waitUntil(() => upstream.warms().length >= 3, "三次重发(第二次回 429)");
      resolveToolApproval(conversation.id, "tu-route", { approved: true });
      await generation;
      await new Promise((resolve) => setTimeout(resolve, 100)); // 迟到的请求记录(响应头到手才记)

      const warms = upstream.warms().length;
      const logs = jsonStore.state.logs.filter((log) => log.providerId === ourProvider.id);
      const warmLogs = logs.filter((log) => log.purpose === "cache_warm");
      const sessionLogs = logs.filter((log) => log.purpose === undefined);
      expect(warmLogs.length).toBe(warms);
      expect(warmLogs.some((log) => log.status === 429)).toBe(true);
      expect(sessionLogs.length).toBe(upstream.sessions().length);
      expect(jsonStore.state.stats.totalRequests - statsBefore.totalRequests).toBe(sessionLogs.length);
      expect(jsonStore.state.stats.failedRequests).toBe(statsBefore.failedRequests);
      expect(errBumps).not.toHaveBeenCalled();

      const [first] = upstream.sessions();
      const headersOf = (headers: Record<string, unknown>) => {
        const { "content-length": _length, ...rest } = headers;
        return rest;
      };
      for (const warm of upstream.warms()) expect(headersOf(warm.headers)).toEqual(headersOf(first!.headers));
      expect(first!.headers["x-api-key"]).toBe("sk-route");
      expect(first!.headers["x-session-id"]).toBe(conversation.id);
      expect(String(first!.headers["user-agent"])).toContain("RikkaHub-Desktop/");
    } finally {
      errBumps.mockRestore();
    }
  }, 30_000);
});
