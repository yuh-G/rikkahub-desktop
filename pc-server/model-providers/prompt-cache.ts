// model-providers/prompt-cache.ts — 提示缓存策略单源(方案 §5.2,C1)。
//
// 背景:缓存相关设置(promptCaching/promptCacheTtl/promptCacheKey)此前由聊天引擎
// 各构建点散读 provider 字段,pi 引擎完全不受管(上游默认 short,无视开关)。多引擎
// 时代(聊天/pi/未来子进程引擎)必须有一个引擎中立的策略出口——所有引擎的请求构建
// 都从 promptCachePolicyFor 读,不再各自读 provider 字段、更不得各自复制业务规则。
//
// 与 request-dialect 的分工:方言回答"协议怎么发"(host 级事实);本模块回答
// "用户的缓存意图是什么"(provider 级配置)。两者都是引擎只读的单源,新引擎接入
// 只翻译不决策。

import type { Provider } from "../foundation/types";
import { isOAuthProvider } from "./auth";

/** 引擎中立的提示缓存策略。字段按**协议方言**抽象而非按引擎:任何引擎只要它能表达
 *  "Anthropic 形缓存标记"(cache_control)或"OpenAI 形缓存键"(prompt_cache_key),
 *  就从同一策略翻译。未来出现第三种缓存方言(如 Google implicit cache)在接口加
 *  字段,不绕过单源——接口演进点只有这一处(方案 §5.7-①)。 */
export interface PromptCachePolicy {
  /** Anthropic 格式:是否打 cache_control。 */
  anthropicCaching: boolean;
  anthropicTtl: "5m" | "1h";
  /** 缓存预热(仅 anthropicCaching 时有意义;C2 宿主预热服务消费)。 */
  warming: boolean;
  /** OpenAI 格式:是否发 prompt_cache_key。 */
  openaiCacheKey: boolean;
}

/** 策略单源。订阅行规则(D10,2026-10-05 拍板)住在函数体内而非各引擎适配器:
 *  OAuth 预置的 Claude 行(订阅制官方 Anthropic 端点)缓存恒开,无视 promptCaching
 *  字段——该字段从未对订阅行被 UI 写过,照字面读会把官方端点判成关,纯粹损失订阅
 *  额度下的缓存收益;官方端点必认 cache_control,无第三方拒收面。规则在策略函数里
 *  = 引擎中立:聊天、pi、未来任何 Agent 引擎(进程内或子进程)读策略即自动继承,
 *  各引擎适配器不得自行复制这条规则。 */
export function promptCachePolicyFor(provider: Provider): PromptCachePolicy {
  // 订阅行只可能是官方 Anthropic 端点(flow=anthropic 锁死);type 不是 claude 的
  // OAuth 行(如 Codex)没有 anthropicCaching 概念,恒开对它们无副作用。
  const subscriptionClaude = provider.type === "claude" && isOAuthProvider(provider);
  const anthropicCaching = subscriptionClaude || provider.promptCaching === true;
  return {
    anthropicCaching,
    anthropicTtl: provider.promptCacheTtl === "1h" ? "1h" : "5m",
    // promptCacheWarming 是 PC 独有字段(C3 加 UI),语义 !== false 即开——旧数据/APP
    // 导入缺失该字段时预热跟随默认开,与「订阅行缓存恒开则预热恒开」的 D10 推论一致。
    warming: anthropicCaching && provider.promptCacheWarming !== false,
    openaiCacheKey: provider.promptCacheKey === true,
  };
}
