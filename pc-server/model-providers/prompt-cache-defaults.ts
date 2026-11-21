// model-providers/prompt-cache-defaults.ts — 「Claude 提示缓存」按端点取的默认值(方案 §5.17.3,D31)
//
// 字段三态:true / false / 不填。不填 = 按端点取默认:Claude 格式、非订阅、主机是 api.anthropic.com 开,其余关
// (中转站不一定保留 Anthropic 缓存,开了白付写入价)。聊天引擎的请求构建、工作区授权(promptCachePolicyFor)、
// 设置页、给 APP 端的导出都读这里;源码扫描锁在 prompt-cache-defaults.test.ts。
// 前端经 @server 直接引用,所以本模块不得引用任何 Bun / node 模块。

/** 判定只用得到这几个字段:服务端 Provider 与前端 ProviderProfile 都满足。 */
export interface PromptCacheFields {
  type?: unknown;
  baseUrl?: unknown;
  authMode?: unknown;
  promptCaching?: boolean;
}

const OFFICIAL_ANTHROPIC_HOST = "api.anthropic.com";

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
