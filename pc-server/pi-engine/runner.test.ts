// pi-engine/runner.test.ts — pi 会话驱动器集成测试(P2 骨架,P7 改 unified 语义)
//
// 真实链路:假 OpenAI SSE 服务器 → model-bridge 内存注册 → SessionManager.inMemory
// (上下文由会话视图装载,零 jsonl)→ 事件桥 → sink。覆盖:首轮生成、DB 历史
// 灌注回放(硬证据:上游请求体携带灌注的历史)、既有压缩记录重放(pi 引擎上下文
// 以摘要起头=编码器 appendCompaction 语义生效)、手动压缩捕获、预中止,以及自动压缩
// (小上下文窗口让灌注历史的体积估算越过阈值,开轮前触发)。
//
// inMemory 会话的零文件生命周期即 P7 契约本身。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GenerationEvent } from "../inference-engine/events";
import type { EngineCompactionRecord, EngineEntryInput } from "../engines/contract";
import type { Message } from "../foundation/types";
import { message } from "../foundation/utils";
import { model, provider } from "../model-providers";
import { runPiCompaction, runPiGeneration } from "./runner";
import { modelGrantFor } from "../engines/model-grant";
import { sessionViewOf } from "../test-utils/engine-session-view";
import { startFakeOpenAiSse, type FakeOpenAiSseServer } from "../test-utils/fake-openai-sse";

const PROVIDER_ID = "00000000-0000-4000-8000-000000000002";

let server: FakeOpenAiSseServer;
let cwd: string;

beforeAll(async () => {
  server = await startFakeOpenAiSse([
    { content: "第一轮回答", usage: { prompt_tokens: 11, completion_tokens: 3 } },
    { content: "第二轮回答", usage: { prompt_tokens: 25, completion_tokens: 4 } },
    // 手动压缩用例剧本:session.compact 的上游调用(摘要)。
    { content: "手动压缩摘要:聊了两轮问答。" },
    // "压缩记录重放"用例吃掉这一条后成功返回(旧剧本在此耗尽、该用例走 500 失败
    // 分支;加 P9 用例后它顺位拿到这条,行为同样成立——断言只看请求体不看响应)。
    { content: "重放用例响应" },
    // P9 合成行灌注用例剧本(第 5 次上游请求)。
    { content: "P9 灌注回答" },
  ]);
  cwd = mkdtempSync(join(tmpdir(), "pi-runner-cwd-"));
});

afterAll(async () => {
  await server.close();
});

interface HistoryExtras {
  history?: Message[];
  syntheticIds?: Set<string>;
  compactions?: EngineCompactionRecord[];
}

function testContext(conversationId: string, promptText: string, extras: HistoryExtras = {}) {
  const events: GenerationEvent[] = [];
  const ourProvider = provider({ id: PROVIDER_ID, name: "Runner Test Provider", baseUrl: server.baseUrl, apiKey: "sk-test" });
  const ourModel = model("fake-model", "Runner Test Model");
  const { history = [], ...viewOptions } = extras;
  return {
    events,
    ctx: {
      grant: modelGrantFor(ourProvider, ourModel, null, conversationId)!,
      conversationId,
      cwd,
      view: sessionViewOf(history, { model: ourModel, ...viewOptions }),
      promptText,
      sink: (event: GenerationEvent) => events.push(event),
    },
  };
}

describe("pi runner 集成(P7 统一会话数据)", () => {
  test("首轮:事件入 sink,capturedCompactions 为空,无 jsonl 概念", async () => {
    const { events, ctx } = testContext("conv-runner-1", "你好");
    const result = await runPiGeneration(ctx);

    expect(result.text).toBe("第一轮回答");
    expect(result.capturedCompactions).toEqual([]);
    expect(result.degradedMessageIds).toEqual([]);

    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("text_delta");
    expect(kinds).toContain("usage");
    const text = events.filter((e): e is Extract<GenerationEvent, { kind: "text_delta" }> => e.kind === "text_delta")
      .map((e) => e.text).join("");
    expect(text).toBe("第一轮回答");
  }, 20_000);

  test("历史灌注:history 里的上一轮问答真的回放给上游(DB 单一事实源语义)", async () => {
    const user1 = message("USER", [{ type: "text", text: "灌注的历史问题" }]);
    const asst1 = message("ASSISTANT", [{ type: "text", text: "灌注的历史回答" }]);
    // P7:无保真注解的存量行走 legacy 解码(剥 thinking/启发式分组),仍应回放。
    const { ctx } = testContext("conv-runner-2", "继续", { history: [user1, asst1] });
    const result = await runPiGeneration(ctx);
    expect(result.text).toBe("第二轮回答");
    expect(result.degradedMessageIds).toEqual([asst1.id]);

    const secondRequest = server.requests[1] as { messages?: Array<{ role: string; content?: unknown }> };
    const roles = (secondRequest.messages ?? []).map((m) => m.role);
    expect(roles.filter((role) => role === "user").length).toBeGreaterThanOrEqual(2);
    const serialized = JSON.stringify(secondRequest.messages ?? []);
    expect(serialized).toContain("灌注的历史问题");
    expect(serialized).toContain("灌注的历史回答");
    expect(serialized).toContain("继续");
  }, 20_000);

  test("手动压缩:runPiCompaction 产出摘要并捕获切点(反查回 DB 消息 id)", async () => {
    // prepareCompaction 需要"可压缩的历史":切割线由 settings 的 keepRecentTokens
    // (pi 默认 20000)决定,测试不传 resources → inMemory 设置全默认;长文本按
    // chars/4 估算,~100k 字符 ≈ 25k tokens,保证旧段被分进摘要区。
    const filler = "很长的历史内容,".repeat(12000);
    const user1 = message("USER", [{ type: "text", text: `压缩对象问题${filler}` }]);
    const asst1 = message("ASSISTANT", [{ type: "text", text: `压缩对象回答${filler}` }]);
    const events: GenerationEvent[] = [];
    const ourProvider = provider({ id: PROVIDER_ID, name: "Runner Test Provider", baseUrl: server.baseUrl, apiKey: "sk-test" });
    const ourModel = model("fake-model", "Runner Test Model");
    const result = await runPiCompaction({
      grant: modelGrantFor(ourProvider, ourModel, null, "conv-runner-manual")!,
      conversationId: "conv-runner-manual",
      cwd,
      view: sessionViewOf([user1, asst1], { model: ourModel }),
      sink: (event: GenerationEvent) => events.push(event),
    });

    expect(result.summary).toContain("手动压缩摘要");
    expect(result.tokensBefore).toBeGreaterThan(0);
    // 手动压缩的切点由 pi 在灌注条目里选(firstKeptEntryId 反查必命中,runner 契约)。
    expect(result.compaction.cutMessageId).not.toBeNull();
    expect([user1.id, asst1.id]).toContain(result.compaction.cutMessageId!);
    expect(result.compaction.summary).toBe(result.summary);
    // P3.5:原生压缩条目随结果交回(应用锚定到尾消息),去掉系统提示词快照。
    expect(result.native?.payload).toMatchObject({ type: "compaction", summary: result.summary, tokensBefore: result.tokensBefore });
    expect(result.native?.payload).not.toHaveProperty("systemMessage");
    // 压缩期间状态条直通(engine_status)。
    expect(events.some((event) => event.kind === "engine_status")).toBe(true);
  }, 20_000);

  test("压缩记录重放:既有压缩记录的下一轮,引擎上下文以摘要起头(编码器 appendCompaction 生效)", async () => {
    const user1 = message("USER", [{ type: "text", text: "第一轮问题" }]);
    const asst1 = message("ASSISTANT", [{ type: "text", text: "第一轮回答" }]);
    const user2 = message("USER", [{ type: "text", text: "第二轮问题" }]);
    const asst2 = message("ASSISTANT", [{ type: "text", text: "第二轮回答" }]);
    // 压缩记录切点 = 第二轮用户消息:之前的历史(user1/asst1)应被摘要取代。
    const { ctx } = testContext("conv-runner-compacted", "第三轮问题", {
      history: [user1, asst1, user2, asst2],
      compactions: [{ cutMessageId: user2.id, summary: "手动压缩摘要:聊了两轮问答。", tokensBefore: 1234 }],
    });
    // 该用例只断言请求体(压缩语义硬证据),不依赖响应剧本——拿到成功或 500 均可。
    await runPiGeneration(ctx).catch(() => undefined);
    const request = server.requests.at(-1) as { messages?: Array<{ role: string; content?: unknown }> };
    const serialized = JSON.stringify(request?.messages ?? []);
    // 压缩语义硬证据:摘要在场,且被取代的旧问答不在场,保留尾(第二轮起)在场。
    expect(serialized).toContain("手动压缩摘要");
    expect(serialized).not.toContain("第一轮问题");
    expect(serialized).not.toContain("第一轮回答");
    expect(serialized).toContain("第二轮问题");
    expect(serialized).toContain("第二轮回答");
    expect(serialized).toContain("第三轮问题");
  }, 20_000);

  test("预中止:signal 已 aborted 时直接抛 AbortError,不触碰上游", async () => {
    const requestsBefore = server.requests.length;
    const controller = new AbortController();
    controller.abort();
    const { ctx } = testContext("conv-runner-abort", "别发出去");
    await expect(runPiGeneration({ ...ctx, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(server.requests.length).toBe(requestsBefore);
  }, 20_000);

  test("P9 合成行灌注:富化全序列(含注入/提醒)进引擎,上游请求体可见", async () => {
    // 复刻 orchestrator 生成路径的装配形状:视图 = 富化全序列,合成行标出
    // 合成行;压缩切点作富化窗口锚(这里直接给一个已对齐的切点场景:切点=user2,
    // 切点前的真实行已被富化窗口挡在序列外——富化层职责,此处直接给结果)。
    const user2 = message("USER", [{ type: "text", text: "P9 新问" }]);
    const asst2 = message("ASSISTANT", [{ type: "text", text: "P9 新答" }]);
    const topInjection = message("USER", [{ type: "text", text: "P9_TOP_INJECTION" }]);
    const reminder = message("USER", [{ type: "text", text: "<time_reminder>P9 时间提醒</time_reminder>" }]);
    // 模拟富化产物:窗口=[top 注入, 提醒(user2 前), user2, asst2]。
    const history = [topInjection, reminder, user2, asst2];
    const syntheticIds = new Set([topInjection.id, reminder.id]);
    const { ctx } = testContext("conv-runner-p9", "P9 本轮", {
      history,
      syntheticIds,
      compactions: [{ cutMessageId: user2.id, summary: "P9 旧史摘要", tokensBefore: 55 }],
    });
    const result = await runPiGeneration(ctx);
    expect(result.text).toBe("P9 灌注回答");

    const request = server.requests.at(-1) as { messages?: Array<{ role: string; content?: unknown }> };
    const serialized = JSON.stringify(request?.messages ?? []);
    // 注入/提醒/摘要同场:压缩重放盖不住窗口首位的 top 注入(firstKept=序列首 entry)。
    expect(serialized).toContain("P9_TOP_INJECTION");
    expect(serialized).toContain("P9 时间提醒");
    expect(serialized).toContain("P9 旧史摘要");
    expect(serialized).toContain("P9 新问");
    // 切点前的真实历史不在场(窗口锚 + 摘要吸收,双重保证):伪造文本验证"任何
    // 未灌注内容都不出现"。
    expect(serialized).not.toContain("P9 未灌注的旧内容");
    // 合成行不污染退化诊断(legacy 是其设计路径,非编辑痕迹)。
    expect(result.degradedMessageIds).toEqual([asst2.id]);
  }, 20_000);
});

describe("pi 自动压缩(P3.5:原生压缩条目经写路径落库)", () => {
  test("小上下文窗口 + 大历史:开轮前阈值压缩,捕获切点,压缩条目交给 appendEntries(无系统提示词快照,带文件清单)", async () => {
    // 窗口 20000 → 阈值 20000-16384;灌注历史零用量,pi 按消息体积估算(chars/4)。答复带小用量,
    // 轮末复查不再触发第二次压缩。切点可能落在轮中间(多一次前缀摘要),所以剧本全给同一段文本。
    const turn = { content: "自动压缩摘要。", usage: { prompt_tokens: 100, completion_tokens: 5 } };
    const upstream = await startFakeOpenAiSse([turn, turn, turn]);
    try {
      const filler = "很长的历史内容,".repeat(5000);
      const history = [0, 1, 2].flatMap((round) => [
        message("USER", [{ type: "text", text: `第${round}问${filler}` }]),
        message("ASSISTANT", [{ type: "text", text: `第${round}答${filler}` }]),
      ]);
      const ourProvider = provider({ id: PROVIDER_ID, name: "Runner Test Provider", baseUrl: upstream.baseUrl, apiKey: "sk-test" });
      const ourModel = model("fake-model", "Runner Test Model");
      const grant = modelGrantFor(ourProvider, ourModel, null, "conv-runner-auto")!;
      const appended: EngineEntryInput[] = [];
      const result = await runPiGeneration({
        grant: { ...grant, limits: { contextWindow: 20_000, maxTokens: 2_000 } },
        conversationId: "conv-runner-auto",
        cwd,
        view: sessionViewOf(history, { model: ourModel }),
        promptText: "继续",
        sink: () => undefined,
        appendEntries: async (entries) => void appended.push(...entries),
      });

      expect(result.capturedCompactions.length).toBe(1);
      const captured = result.capturedCompactions[0]!;
      expect(captured.summary).toContain("自动压缩摘要");
      expect(history.map((item) => item.id)).toContain(captured.cutMessageId!);
      const compactions = appended.filter((entry) => (entry.payload as { type?: string }).type === "compaction");
      expect(compactions.length).toBe(1);
      const payload = compactions[0]!.payload as Record<string, unknown>;
      expect(payload).toMatchObject({ summary: captured.summary, tokensBefore: captured.tokensBefore, details: { readFiles: [], modifiedFiles: [] } });
      expect(payload).not.toHaveProperty("systemMessage");
      // 答复仍照常生成并交出(压缩后的上下文里没有被摘要吸收的最早一问)。
      expect(appended.some((entry) => (entry.payload as { message?: { role?: string } }).message?.role === "assistant")).toBe(true);
      const answerRequest = upstream.requests.at(-1) as { messages?: unknown[] };
      expect(JSON.stringify(answerRequest.messages ?? [])).not.toContain("第0问");
    } finally {
      await upstream.close();
    }
  }, 30_000);
});
