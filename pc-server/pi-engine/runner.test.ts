// pi-engine/runner.test.ts — pi 会话驱动器集成测试(P2 骨架,P7 改 unified 语义)
//
// 真实链路:假 OpenAI SSE 服务器 → model-bridge 内存注册 → SessionManager.inMemory
// (P7:上下文从 history 灌注,零 jsonl)→ 事件桥 → sink。覆盖:首轮生成、DB 历史
// 灌注回放(硬证据:上游请求体携带灌注的历史)、既有压缩记录重放(pi 引擎上下文
// 以摘要起头=编码器 appendCompaction 语义生效)、手动压缩捕获、预中止。
//
// 生产语义 + 零落盘契约:pi 自动压缩(threshold/overflow)由引擎按"本会话内真实
// usage"判定,灌注存量消息 usage 恒 0(zeroUsage)不参与计量——自动压缩只在真实
// 长会话里自然触发,测试环境不复现。该路径的正确性由 capturedCompactions 的捕获
// 单元(context-encoder.test 的压缩记录重放 + 本文件手动压缩端到端)共同钉住;
// inMemory 会话的零文件生命周期即 P7 契约本身。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GenerationEvent } from "../inference-engine/events";
import type { Message } from "../foundation/types";
import { message } from "../foundation/utils";
import { model, provider } from "../model-providers";
import { runPiCompaction, runPiGeneration } from "./runner";
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

function testContext(conversationId: string, promptText: string, extras: Partial<Parameters<typeof runPiGeneration>[0]> = {}) {
  const events: GenerationEvent[] = [];
  const ourProvider = provider({ id: PROVIDER_ID, name: "Runner Test Provider", baseUrl: server.baseUrl, apiKey: "sk-test" });
  const ourModel = model("fake-model", "Runner Test Model");
  return {
    events,
    ctx: {
      provider: ourProvider,
      model: ourModel,
      conversationId,
      cwd,
      history: [] as Message[],
      promptText,
      sink: (event: GenerationEvent) => events.push(event),
      ...extras,
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
      provider: ourProvider,
      model: ourModel,
      conversationId: "conv-runner-manual",
      cwd,
      history: [user1, asst1],
      sink: (event: GenerationEvent) => events.push(event),
    });

    expect(result.summary).toContain("手动压缩摘要");
    expect(result.tokensBefore).toBeGreaterThan(0);
    // 手动压缩的切点由 pi 在灌注条目里选(firstKeptEntryId 反查必命中,runner 契约)。
    expect(result.compaction.cutMessageId).not.toBeNull();
    expect([user1.id, asst1.id]).toContain(result.compaction.cutMessageId!);
    expect(result.compaction.summary).toBe(result.summary);
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
    // 复刻 orchestrator 生成路径的装配形状:history = 富化全序列,syntheticIds 标出
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
