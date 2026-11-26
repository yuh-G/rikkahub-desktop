// 专题11-P1-3 回归网:缓存命中字段多方言解析(对齐安卓 #1576)与 usage 合并语义
// (新值>0 才覆盖)。防止"后到的 usage 事件缺字段把已知命中数清零"回潮。
import { describe, expect, test } from "bun:test";
import { appendUsageFromRaw } from "./providers";
import { mergeTokenUsage } from "./tool-loop";
import { message } from "../foundation/utils";

function usageOf(raw: Record<string, unknown>) {
  const msg = message("ASSISTANT", []);
  appendUsageFromRaw(msg, { usage: raw });
  return msg.usage as Record<string, number>;
}

describe("appendUsageFromRaw 方言解析", () => {
  test("OpenAI 嵌套 prompt_tokens_details.cached_tokens", () => {
    const usage = usageOf({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 64 } });
    expect(usage.cachedTokens).toBe(64);
    expect(usage.promptTokens).toBe(100);
  });

  test("Responses API 嵌套 input_tokens_details.cached_tokens", () => {
    const usage = usageOf({ input_tokens: 200, output_tokens: 20, input_tokens_details: { cached_tokens: 128 } });
    expect(usage.cachedTokens).toBe(128);
  });

  test("Moonshot 顶层 cached_tokens", () => {
    const usage = usageOf({ prompt_tokens: 50, completion_tokens: 5, cached_tokens: 30 });
    expect(usage.cachedTokens).toBe(30);
  });

  test("DeepSeek prompt_cache_hit_tokens", () => {
    const usage = usageOf({ prompt_tokens: 19239, completion_tokens: 500, prompt_cache_hit_tokens: 14976 });
    expect(usage.cachedTokens).toBe(14976);
  });

  test("无缓存字段时为 0", () => {
    expect(usageOf({ prompt_tokens: 10, completion_tokens: 1 }).cachedTokens).toBe(0);
  });
});

describe("usage 合并语义(新值>0 才覆盖)", () => {
  test("后到事件缺缓存字段不清零已知命中数", () => {
    const msg = message("ASSISTANT", []);
    appendUsageFromRaw(msg, { usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } } });
    appendUsageFromRaw(msg, { usage: { prompt_tokens: 100, completion_tokens: 42 } });
    const usage = msg.usage as Record<string, number>;
    expect(usage.cachedTokens).toBe(80);
    expect(usage.completionTokens).toBe(42);
  });

  test("mergeTokenUsage:新值为 0 保留旧值,新值>0 覆盖", () => {
    const prev = { promptTokens: 100, completionTokens: 10, totalTokens: 110, cachedTokens: 64 };
    const next = { promptTokens: 200, completionTokens: 0, totalTokens: 0, cachedTokens: 0 };
    expect(mergeTokenUsage(prev, next)).toEqual({ promptTokens: 200, completionTokens: 10, totalTokens: 110, cachedTokens: 64 });
  });

  test("mergeTokenUsage:contextLimit 随旧值保留", () => {
    const prev = { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0, contextLimit: 128000 };
    const next = { promptTokens: 5, completionTokens: 2, totalTokens: 7, cachedTokens: 3 };
    expect((mergeTokenUsage(prev, next) as Record<string, number>).contextLimit).toBe(128000);
  });

  test("mergeTokenUsage:一侧为空返回另一侧", () => {
    const only = { promptTokens: 1, completionTokens: 2, totalTokens: 3, cachedTokens: 0 };
    expect(mergeTokenUsage(null, only)).toEqual(only);
    expect(mergeTokenUsage(only, null)).toEqual(only);
  });

  test("mergeTokenUsage:generationMs 累计值后到覆盖,后到缺省保留旧值,恒零不写字段", () => {
    const base = { promptTokens: 1, completionTokens: 2, totalTokens: 3, cachedTokens: 0 };
    // 骨架每轮发的都是至今累计,后到值更大 → 覆盖。
    const merged = mergeTokenUsage({ ...base, generationMs: 1200 }, { ...base, generationMs: 3400 });
    expect((merged as Record<string, number>).generationMs).toBe(3400);
    // 后到事件不带该字段(如 pi 路径的 usage)不清掉已知值。
    const kept = mergeTokenUsage({ ...base, generationMs: 1200 }, { ...base });
    expect((kept as Record<string, number>).generationMs).toBe(1200);
    // 两侧都没有 → 不虚构字段(旧数据形状不变,前端按缺省回退全程)。
    expect("generationMs" in (mergeTokenUsage({ ...base }, { ...base }) as object)).toBe(false);
  });
});

describe("ensureUsage 估算兜底与纯时长载荷的交互", () => {
  test("骨架下沉的全 0 token+generationMs 载荷不挡估算;估算保留真实生成时长", async () => {
    const { ensureUsage } = await import("../conversations/helpers");
    const msg = message("ASSISTANT", [{ type: "text", text: "这是一段需要估算 token 的回复文本内容" }]);
    msg.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, generationMs: 500 };
    ensureUsage(msg);
    const usage = msg.usage as Record<string, unknown>;
    expect(usage.estimated).toBe(true);
    expect(Number(usage.completionTokens)).toBeGreaterThan(0);
    expect(usage.generationMs).toBe(500);
  });

  test("实质 token 存在时不动(厂商已回报,不得覆盖为估算)", async () => {
    const { ensureUsage } = await import("../conversations/helpers");
    const msg = message("ASSISTANT", [{ type: "text", text: "文本" }]);
    msg.usage = { promptTokens: 10, completionTokens: 20, totalTokens: 30, cachedTokens: 0, generationMs: 800 };
    ensureUsage(msg);
    expect(msg.usage).toMatchObject({ promptTokens: 10, completionTokens: 20, generationMs: 800 });
    expect((msg.usage as Record<string, unknown>).estimated).toBeUndefined();
  });

  test("字段级兜底:上游只回 input(Kimi anthropic 端点 output_tokens 恒 0) → prompt 保留真实值,completion 估算补齐", async () => {
    // 内测实锤:api.kimi.com/coding anthropic 兼容端点 message_start 只回 input_tokens,
    // output_tokens 恒 0 且 message_delta 不带 usage。旧判定"任一非零就全信"被 prompt
    // 挡住 → completion 恒 0,TPS 行消失/失真。
    const { ensureUsage } = await import("../conversations/helpers");
    const { estimateTokens } = await import("../foundation/utils");
    const text = "秋天的清晨,雾气还未散尽。".repeat(30);
    const msg = message("ASSISTANT", [{ type: "text", text }]);
    msg.usage = { promptTokens: 106, completionTokens: 0, totalTokens: 106, cachedTokens: 3, generationMs: 12800 };
    ensureUsage(msg);
    const usage = msg.usage as Record<string, unknown>;
    expect(usage.promptTokens).toBe(106); // 真实值保留
    expect(Number(usage.completionTokens)).toBe(estimateTokens(text)); // 缺失侧估算补齐
    expect(usage.cachedTokens).toBe(3); // 上游缓存命中保留
    expect(usage.generationMs).toBe(12800); // 真实耗时保留
    expect(usage.estimated).toBe(true); // 含估算成分,统计页照旧排除
    expect(Number(usage.totalTokens)).toBe(106 + estimateTokens(text));
  });

  test("起始计数残留:completionTokens=1(anthropic message_start 起始值) → 视为缺失,估算兜底", async () => {
    // 内测两连反馈的最终根因:anthropic message_start.usage.output_tokens 是起始计数
    // (恒 1),Kimi coding 兼容端点 message_delta 不带 usage,残留 1 挡住兜底 → TPS≈0。
    // 对话模式已在 mergeClaudeUsage 源头剥离;工作区走 pi vendor(不可改)仍会下沉 1,
    // ensureUsage 按语义收紧:completion=1 不是可信回报。
    const { ensureUsage } = await import("../conversations/helpers");
    const { estimateTokens } = await import("../foundation/utils");
    const text = "长回答正文,远超一个 token 的量。".repeat(40);
    const msg = message("ASSISTANT", [{ type: "text", text }]);
    msg.usage = { promptTokens: 3200, completionTokens: 1, totalTokens: 3201, cachedTokens: 0, generationMs: 21000 };
    ensureUsage(msg);
    const usage = msg.usage as Record<string, unknown>;
    expect(usage.promptTokens).toBe(3200); // 真实 input 保留
    expect(Number(usage.completionTokens)).toBe(estimateTokens(text)); // 残留 1 被估算覆盖
    expect(usage.generationMs).toBe(21000);
    expect(usage.estimated).toBe(true);
  });

  test("思考模型估算:正文与思维链都计入输出(内测反馈 Kimi TPS 异常小的回归)", async () => {
    // 旧写法 estimateTokens(text || reasoning) 是短路——正文非空时思维链一个 token
    // 不计,思考型模型(思维链几千 token+正文几百)的输出被低估一个数量级。
    const { ensureUsage } = await import("../conversations/helpers");
    const { estimateTokens } = await import("../foundation/utils");
    const reasoning = "推理过程逐步展开,包含大量中间演算与自我检查。".repeat(80);
    const text = "简短结论。";
    const msg = message("ASSISTANT", [
      { type: "reasoning", reasoning },
      { type: "text", text },
    ]);
    ensureUsage(msg);
    const completionTokens = Number((msg.usage as Record<string, unknown>).completionTokens);
    expect(completionTokens).toBe(estimateTokens(text) + estimateTokens(reasoning));
    expect(completionTokens).toBeGreaterThan(estimateTokens(text));
  });
});
