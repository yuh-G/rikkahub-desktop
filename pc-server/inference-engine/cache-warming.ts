// inference-engine/cache-warming.ts — 宿主级提示缓存预热服务(方案 §5.3,C2)。
//
// 价值场景:工作区长工具运行 / 等待审批超过缓存 TTL(5m/1h)时,提示缓存过期,续聊
// 要全价重写(Anthropic 写入还加收 25% 溢价)。本服务在条目过期前自动重放一次原请求
// (max_tokens:1,非流式)——命中即把计时器重置回满,代价≈一次缓存读(原价 10%)+1 token。
//
// 架构定位(多引擎统一管理):
//   - 捕获在 **fetch 层**(AsyncLocalStorage「生成上下文」,与 llm-request-log 同款模式):
//     任何进程内引擎(聊天/pi/未来引擎)的 Anthropic 请求走 globalThis.fetch 即被覆盖,
//     引擎侧零代码。EngineAdapter.cacheWarming="host" 是这一事实的声明面。
//   - 策略来自 promptCachePolicyFor 单源(C1):warming 关 = 不捕获不重放,与「Claude
//     提示缓存」开关联动;订阅 Claude 行缓存恒开 ⇒ 预热恒开,同源继承。
//   - 启用条件数据驱动(比 pi 更保守,防对不识缓存的端点白烧钱):仅官方 Anthropic 主机
//     (api.anthropic.com)或订阅轨(同样锁官方端点)可预热——第三方 Anthropic 兼容端点
//     (中转站)没有可信 TTL 语义,默认不预热。
//   - 调度/停止逻辑吸收自 pi 的 cache-warmer.ts(v1.0.3 通读,三防线全带):
//     ①迟到防线:refreshDeadline = nextWarmAt + 剩余margin/2,定时器因休眠/事件循环
//       阻塞迟到时超过即停(迟到的"保温"大概率已变全价 cache write);
//     ②重放安全谓词 isReplayable:预算式 thinking(thinking.type==="enabled")的
//       budget 由 max_tokens 推导,重放会变缓存键——不重放。宿主两引擎对 Claude 恒走
//       adaptive(聊天 claudeThinkingPayload / pi forceAdaptiveThinking),该谓词是防线
//       而非日常路径;
//     ③TTL 真值:官方端点登记常量 {5m:300s, 1h:3600s}(Anthropic 文档,pi 目录同值),
//       不拍脑袋。
//   - 不吸收 pi 的美元经济判断(apiKey 轨 cost 全 0 无从计算):以「上一轮回报了缓存读
//     或写(证明该端点确实在缓存)且 prompt≥2048(Anthropic 最小可缓存长度,严档)」替代。
//   - 第一期只做 streaming 模式(pi 同名语义):本轮生成进行中才保温,生成结束即停。
//     空闲期保温(pi "idle" 模式,15% 续聊概率)不做。
//   - 记账:重放进请求日志(kind=provider:cache-warm),**不进** stats 计数器、不进消息
//     usage——它是保温动作不是用户对话。
//
// 安装顺序:与 llm-request-log 相同——在 installProxyFetchInterceptor 之后安装(包外层)。

import { AsyncLocalStorage } from "node:async_hooks";
import { addLog } from "../api/logs";
import type { Provider } from "../foundation/types";
import { safeJsonParse } from "../foundation/utils";
import { reportError } from "../observability/app-errors";
import { promptCachePolicyFor } from "../model-providers/prompt-cache";
import { hostOfProvider } from "./message-builder";

/** Anthropic 官方提示缓存 TTL(秒)。来源:Anthropic 官方文档 prompt-caching 页
 *  (5 分钟 / 1 小时两档,命中即重置);与 pi 目录 promptCache 同值。第三方兼容端点
 *  的 TTL 语义不可信,预热门控直接排除(见 isWarmingEligibleEndpoint)。 */
const ANTHROPIC_TTL_SECONDS: Readonly<Record<"5m" | "1h", number>> = { "5m": 300, "1h": 3600 };

/** Anthropic 最小可缓存 prompt 长度(tokens;Haiku 系是 2048,取严档)。 */
const MIN_CACHEABLE_PROMPT_TOKENS = 2048;

/** 预热不跨越本时长(pi 同款:自被保温请求发出起算的硬上限)。 */
const MAX_WARMING_AGE_MS = 60 * 60_000;

/** pi 同款:在 TTL 的 90% 处刷新,且至少保留 10 秒余量。 */
export function cacheWarmingDelayMs(ttlMs: number): number | undefined {
  if (ttlMs <= 10_000) return undefined;
  return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

// ── 生成上下文 ALS ─────────────────────────────────────────────────

/** 编排层在每次 generateAnswer 外层进入的预热上下文。conversationId 定界停止条件
 *  (生成结束/会话删除),provider 携带策略与端点身份。 */
export interface CacheWarmingContext {
  conversationId: string;
  provider: Provider;
}

const als = new AsyncLocalStorage<CacheWarmingContext>();

/** 编排层入口:把一次生成包进预热上下文(策略关/端点不合格时传 null 免记)。 */
export function runWithCacheWarming<T>(context: CacheWarmingContext | null, fn: () => T): T {
  if (!context) return fn();
  return als.run(context, fn);
}

/** 从 provider 判定本轮生成是否要建立预热上下文(编排层入口调用;策略单源消费)。 */
export function cacheWarmingContextFor(provider: Provider, conversationId: string): CacheWarmingContext | null {
  const policy = promptCachePolicyFor(provider);
  if (!policy.warming) return null;
  if (!isWarmingEligibleEndpoint(provider)) return null;
  return { conversationId, provider };
}

/** 端点门控:仅官方 Anthropic 主机(订阅轨 flow 锁死同端点)。第三方 Anthropic 兼容
 *  端点(中转站)的 cache_control/TTL 语义不受我们控制——多数容忍字段但自行缓存,
 *  重放保温既可能白烧也可能被限流,默认关(D3a 同精神:宁少勿乱发)。 */
export function isWarmingEligibleEndpoint(provider: Provider): boolean {
  if (provider.type !== "claude") return false;
  return hostOfProvider(provider) === "api.anthropic.com";
}

/** 预算式 thinking 的 budget_tokens 由 max_tokens 推导,重放(改 max_tokens:1)会
 *  变缓存键且模型可能继续长思考——不可重放。宿主两引擎对 Claude 恒 adaptive,本谓词
 *  是防线:adaptive/disabled/无 thinking 都可重放。 */
export function isAnthropicReplayable(requestBody: Record<string, unknown>): boolean {
  const thinking = requestBody.thinking;
  return !(isRecord(thinking) && thinking.type === "enabled");
}

// ── 捕获(fetch 层)与调度 ─────────────────────────────────────────

/** 时钟注入口:生产恒 Date.now;测试替换成受控时钟再恢复。TTL 是分钟级常量,测试
 *  不等真墙钟——用受控时钟驱动"到点/迟到"判定,定时器经 warmingScheduler 压到
 *  立即触发,语义由 clock 与 deadline 断言锁住。(不 patch 全局 Date/setTimeout:
 *  bun test 全部文件同进程,全局 mock 是纪律红线,见 llm-request-log.test 同款。) */
export const warmingClock = { now: (): number => Date.now() };
/** 调度注入口:测试换成立即调度;生产按剩余延迟真实调度(unref 保退出干净)。 */
export const warmingScheduler = {
  set(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clear(timer: ReturnType<typeof setTimeout>): void {
    clearTimeout(timer);
  },
};

/** 捕获到的可重放请求(url + headers + body 三元组,取自真实出站请求)。 */
interface CapturedWarmRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  capturedAt: number;
}

/** 每会话的保温计划(同一时刻至多一个:新请求覆盖旧计划并重置计时,pi 的
 *  CacheWarmer.start 同语义)。 */
interface WarmingPlan {
  conversationId: string;
  providerId: string;
  providerName: string;
  request: CapturedWarmRequest;
  ttlMs: number;
  /** 迟到防线:超过即停不发(pi refreshDeadlineAt 同款)。 */
  refreshDeadlineAt: number;
  /** 硬上限锚:自首个被保温请求起算 1 小时。 */
  startedAt: number;
  nextWarmAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const plans = new Map<string, WarmingPlan>();

/** 上一轮 usage 的缓存证明,per conversation。usage 事件(noteCacheUsage)写入,
 *  捕获时读取——「值得预热」= 端点确实在缓存(读过或写过)+ prompt 够长(Anthropic
 *  最小可缓存 2048 tokens,严档取值)。 */
const provenTokens = new Map<string, number>();

/** 编排层把生成 usage 事件镜像给预热服务(生成事件 kind="usage" 时调用)。这是
 *  「值得预热」判定的唯一数据源——不证明就不重放,零白烧。参数是 Message["usage"]
 *  (JsonValue | null,领域形状),此处防御性取字段——事件面的 usage 在两家引擎侧都
 *  是 TokenUsage 形状,但类型不窄化到那个形状,靠运行时判定保持引擎中立。 */
export function noteCacheUsage(conversationId: string, usage: unknown): void {
  if (!isRecord(usage)) return;
  const pick = (key: string): number => {
    const value = usage[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  };
  const cached = pick("cachedTokens") + pick("cacheWriteTokens");
  if (cached <= 0) return;
  provenTokens.set(conversationId, Math.max(pick("promptTokens"), cached));
}

/** 编排层通知:本轮生成结束(pending/done/aborted/failed 全部路径)。第一期只有
 *  streaming 模式——生成结束即停(pi onAgentSettled(streaming) 同语义)。 */
export function stopCacheWarming(conversationId: string): void {
  const plan = plans.get(conversationId);
  if (!plan) return;
  if (plan.timer) warmingScheduler.clear(plan.timer);
  plans.delete(conversationId);
}

/** 会话删除/测试清理口(幂等)。 */
export function discardCacheWarmingState(conversationId: string): void {
  stopCacheWarming(conversationId);
  provenTokens.delete(conversationId);
}

/** 测试用:清空全部计划与证明。 */
export function resetCacheWarmingForTest(): void {
  for (const plan of plans.values()) {
    if (plan.timer) warmingScheduler.clear(plan.timer);
  }
  plans.clear();
  provenTokens.clear();
}

function warmRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  // 原样重放,只改两个字段:输出上限 1、非流式。thinking 负载保持原样——重放安全
  // 已由 isAnthropicReplayable 把关(预算式不可重放,adaptive 不受 max_tokens 影响)。
  return { ...body, max_tokens: 1, stream: false };
}

async function refresh(plan: WarmingPlan): Promise<void> {
  plan.timer = undefined;
  if (plans.get(plan.conversationId) !== plan) return; // 已被新计划/停止接管
  // 迟到防线:休眠/事件循环阻塞致定时器迟到,剩余余量已不足一半 → 停,别把
  // "保温"发成全价 cache write(pi refreshDeadlineMissed 同语义)。
  if (warmingClock.now() > plan.refreshDeadlineAt) {
    plans.delete(plan.conversationId);
    return;
  }
  const started = warmingClock.now();
  const body = warmRequestBody(plan.request.body);
  let ok = false;
  let status = 0;
  let error: string | undefined;
  try {
    const response = await fetch(plan.request.url, {
      method: "POST",
      headers: plan.request.headers,
      body: JSON.stringify(body),
    });
    ok = response.ok;
    status = response.status;
    if (!ok) error = (await response.text().catch(() => "")).slice(0, 500);
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  addLog({
    providerId: plan.providerId,
    providerName: plan.providerName,
    url: plan.request.url,
    ok,
    status,
    kind: "provider:cache-warm",
    durationMs: warmingClock.now() - started,
    method: "POST",
    requestBody: JSON.stringify(body).slice(0, 2000),
    ...(error !== undefined ? { error } : {}),
  });
  if (!ok) {
    // 重放失败:停(下一轮真实请求会重建缓存,重试只会叠加错误),info 级留痕。
    plans.delete(plan.conversationId);
    reportError(
      "provider",
      "info",
      `提示缓存保温请求失败(${status || "网络错误"}),已停止该会话的缓存保温。`,
      undefined,
      "cache_warm_failed",
      { status: String(status || 0) },
    );
    return;
  }
  // 成功 → 重排下一次(命中即计时重置回满)。startedAt 不动:1 小时硬上限从首个请求起算。
  schedule(plan);
}

function schedule(plan: WarmingPlan): void {
  const delayMs = cacheWarmingDelayMs(plan.ttlMs)!;
  plan.nextWarmAt = warmingClock.now() + delayMs;
  // 剩余余量的一半留给定时器迟到与请求派发(pi 同款注释:迟到的保温大概率已变全价写)。
  plan.refreshDeadlineAt = plan.nextWarmAt + Math.floor((plan.ttlMs - delayMs) / 2);
  if (plan.nextWarmAt - plan.startedAt > MAX_WARMING_AGE_MS || warmingClock.now() >= plan.startedAt + MAX_WARMING_AGE_MS) {
    if (plan.timer) warmingScheduler.clear(plan.timer);
    plans.delete(plan.conversationId);
    return;
  }
  plan.timer = warmingScheduler.set(() => void refresh(plan), Math.max(0, plan.nextWarmAt - warmingClock.now()));
}

/** 从捕获的请求体粗估 prompt 规模(兜底通道:usage 尚未回报缓存证明时,拦「prompt
 *  太短根本进不了缓存」的空转;1 token≈4 字符工程近似,偏保守即可)。 */
function estimatePromptTokensFromBody(body: Record<string, unknown>): number {
  let chars = 0;
  const system = body.system;
  if (typeof system === "string") chars += system.length;
  else if (Array.isArray(system)) {
    for (const block of system) if (isRecord(block) && typeof block.text === "string") chars += block.text.length;
  }
  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!isRecord(msg)) continue;
      if (typeof msg.content === "string") chars += msg.content.length;
      else if (Array.isArray(msg.content)) {
        for (const block of msg.content) if (isRecord(block) && typeof block.text === "string") chars += block.text.length;
      }
    }
  }
  return Math.floor(chars / 4);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 请求体里任何位置带 cache_control(顶层/system 块/消息块/tools 块)即视为「这轮
 *  在写缓存」。pi 的 anthropic-messages 适配器把标记打在 system 末块、tools 末块与
 *  最后一条 user 消息;聊天引擎另有顶层 cache_control(安卓对齐形态)——全查。 */
function bodyHasCacheControl(body: Record<string, unknown>): boolean {
  if (body.cache_control != null) return true;
  const system = body.system;
  if (Array.isArray(system)) {
    for (const block of system) if (isRecord(block) && block.cache_control != null) return true;
  }
  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!isRecord(msg) || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) if (isRecord(block) && block.cache_control != null) return true;
    }
  }
  const tools = body.tools;
  if (Array.isArray(tools)) {
    for (const tool of tools) if (isRecord(tool) && tool.cache_control != null) return true;
  }
  return false;
}

let installed = false;

/** 安装预热捕获壳(幂等)。必须晚于 installProxyFetchInterceptor。只捕获 Anthropic
 *  /v1/messages 流式请求(生成主链路形态;非流式辅助调用无 ALS 上下文天然不进)。
 *  工具循环的后续轮(同一 ALS 上下文内)会覆盖旧计划并重置计时——保温对象永远是
 *  「最新上下文」(pi 的 CacheWarmer.start 同语义)。 */
export function installCacheWarmingInterceptor(): void {
  if (installed) return;
  installed = true;
  const inner = globalThis.fetch;
  globalThis.fetch = function (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
    const ctx = als.getStore();
    if (ctx) {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input instanceof Request ? input.url : "";
      if (
        /\/v1\/messages(\?|$)/.test(target) &&
        (init?.method ?? "POST").toUpperCase() === "POST" &&
        typeof init?.body === "string"
      ) {
        captureRequest(ctx, target, init as { body: string; headers?: Record<string, string> });
      }
    }
    return inner(input, init);
  } as typeof fetch;
}

function captureRequest(ctx: CacheWarmingContext, url: string, init: { body: string; headers?: Record<string, string> }): void {
  const body = safeJsonParse(init.body);
  if (!isRecord(body)) return;
  if (!isAnthropicReplayable(body)) return;
  if (!bodyHasCacheControl(body)) return;
  const proven = provenTokens.get(ctx.conversationId) ?? 0;
  if (proven < MIN_CACHEABLE_PROMPT_TOKENS && estimatePromptTokensFromBody(body) < MIN_CACHEABLE_PROMPT_TOKENS) return;
  const ttlMs = ANTHROPIC_TTL_SECONDS[promptCachePolicyFor(ctx.provider).anthropicTtl] * 1000;
  if (cacheWarmingDelayMs(ttlMs) === undefined) return;
  // 新请求覆盖旧计划(旧 timer 必须清,防双热)。
  const old = plans.get(ctx.conversationId);
  if (old?.timer) warmingScheduler.clear(old.timer);
  plans.set(ctx.conversationId, {
    conversationId: ctx.conversationId,
    providerId: ctx.provider.id,
    providerName: ctx.provider.name,
    request: {
      url,
      headers: typeof init.headers === "object" && init.headers != null ? { ...init.headers } : {},
      body,
      capturedAt: warmingClock.now(),
    },
    ttlMs,
    refreshDeadlineAt: 0,
    startedAt: warmingClock.now(),
    nextWarmAt: 0,
    timer: undefined,
  });
  schedule(plans.get(ctx.conversationId)!);
}
