// model-providers/prompt-cache-defaults.ts — 「Claude 提示缓存」按端点取的默认值(方案 §5.17.3,D31)
//
// 字段三态:true / false / 不填。不填 = 按端点取默认:Claude 格式、非订阅、主机是 api.anthropic.com 开,其余关
// (中转站不一定保留 Anthropic 缓存,开了白付写入价)。聊天引擎的请求构建、工作区授权(promptCachePolicyFor)、
// 设置页、给 APP 端的导出都读这里;源码扫描锁在 prompt-cache-defaults.test.ts。
// 「缓存预热」(promptCacheWarming,§5.17.3)同样三态,也在这里取默认与生效值。
// 前端经 @server 直接引用,所以本模块不得引用任何 Bun / node 模块。

/** 判定只用得到这几个字段:服务端 Provider 与前端 ProviderProfile 都满足。 */
export interface PromptCacheFields {
  type?: unknown;
  baseUrl?: unknown;
  authMode?: unknown;
  promptCaching?: boolean;
  promptCacheWarming?: boolean;
}

const OFFICIAL_ANTHROPIC_HOST = "api.anthropic.com";
/** Claude 订阅的授权流程 id(model-providers/auth/flows.ts 的 OAUTH_FLOWS.anthropic)。 */
const CLAUDE_SUBSCRIPTION_FLOW = "anthropic";

function hostOf(baseUrl: unknown): string {
  try {
    return new URL(String(baseUrl ?? "")).hostname;
  } catch {
    return ""; // 地址不合法:当作非官方端点
  }
}

/** 字段不填时的值。订阅行恒为 false:它们的缓存由授权恒开(engines/model-grant.ts),这个字段对它们不起作用。 */
export function claudePromptCachingDefault(provider: PromptCacheFields): boolean {
  return provider.type === "claude" && provider.authMode !== "oauth" && hostOf(provider.baseUrl) === OFFICIAL_ANTHROPIC_HOST;
}

/** 生效值:用户设过就用用户的,否则取默认。 */
export function claudePromptCachingEnabled(provider: PromptCacheFields): boolean {
  return typeof provider.promptCaching === "boolean" ? provider.promptCaching : claudePromptCachingDefault(provider);
}

/** 会预热的只有 API Key 的 Claude 格式(任意主机)与 Claude 订阅;其余订阅、其余协议不预热,字段写了也不算。
 *  subscriptionFlow:订阅行所属的授权流程 id(服务端 oauthFlowFor(provider)?.id,前端 oauthStatus.flow)。预置订阅表
 *  在 flows.ts,本模块引不到它,由调用方给。 */
function cacheWarmingEligible(provider: PromptCacheFields, subscriptionFlow: string | undefined): boolean {
  if (provider.authMode === "oauth") return subscriptionFlow === CLAUDE_SUBSCRIPTION_FLOW;
  return provider.type === "claude";
}

/** 「缓存预热」不填时的值:官方端点(API Key)与 Claude 订阅开,其余关。 */
export function claudePromptCacheWarmingDefault(provider: PromptCacheFields, subscriptionFlow?: string): boolean {
  if (!cacheWarmingEligible(provider, subscriptionFlow)) return false;
  return provider.authMode === "oauth" || hostOf(provider.baseUrl) === OFFICIAL_ANTHROPIC_HOST;
}

/** 「缓存预热」开关的生效值(没资格的行恒为 false)。API Key 行还要缓存开着才真的预热,见 promptCachePolicyFor。 */
export function claudePromptCacheWarmingEnabled(provider: PromptCacheFields, subscriptionFlow?: string): boolean {
  if (!cacheWarmingEligible(provider, subscriptionFlow)) return false;
  return typeof provider.promptCacheWarming === "boolean"
    ? provider.promptCacheWarming
    : claudePromptCacheWarmingDefault(provider, subscriptionFlow);
}
