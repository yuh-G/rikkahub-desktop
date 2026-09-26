// inference-engine/provider-errors.ts — provider 报错的人话映射
// (专题4 超上下文 + 专题7 限流/过载;原名 context-overflow.ts,随职责扩展改名)
//
// 三家 provider 的报错各说各话,原文透传给用户就是天书。这里只做识别与换文案,
// 不改任何错误处理流程;模式刻意保守——误判(把正常报错说成限流/超上下文,误导用户
// 白折腾)比漏判(用户看到原文)更糟。调用点在 orchestrator 的生成失败分支,
// 与 classifyProxyError 串成 代理 ?? 超上下文 ?? 输出上限 ?? 限流 ?? 原文 的分类链。

export const CONTEXT_OVERFLOW_MESSAGE = "超出模型最大上下文窗口，建议压缩对话或切换窗口更大的模型";

const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
  // OpenAI 官方错误码;各 OpenAI 兼容网关(SiliconFlow/OpenRouter 等)大多原样转发
  /context_length_exceeded/i,
  // OpenAI/DeepSeek 文案:"This model's maximum context length is 65536 tokens. However..."
  /maximum context length/i,
  // Claude:"prompt is too long: 210145 tokens > 200000 maximum"
  /prompt is too long/i,
  // Claude(带 max_tokens 的变体):"input length and `max_tokens` exceed context limit"
  /exceed[s]? context limit/i,
  // Gemini:"The input token count (1189529) exceeds the maximum number of tokens allowed (1048576)"
  /input token count .*exceeds/i,
  /exceeds the maximum number of tokens/i,
  // 通用兜底:明确说"超过上下文窗口"的其他 OpenAI 兼容实现
  /exceed[s]? (the )?context window/i,
];

/** 命中"超上下文窗口"类报错时返回给用户的替换文案,否则 null(维持原报错)。 */
export function classifyContextOverflowError(err: unknown): string | null {
  const text = err instanceof Error ? err.message : String(err ?? "");
  if (!text) return null;
  return CONTEXT_OVERFLOW_PATTERNS.some((re) => re.test(text)) ? CONTEXT_OVERFLOW_MESSAGE : null;
}

export const RATE_LIMIT_MESSAGE = "服务商限流或暂时过载（请求过于频繁 / 配额不足 / 上游繁忙），请稍后重试，或更换模型/服务商";

const RATE_LIMIT_PATTERNS: RegExp[] = [
  // tool-loop 抛错格式为 `名字 状态码: 正文`,429 状态码本身就是限流的权威信号
  /\s429:/,
  // OpenAI "Rate limit reached" / code rate_limit_exceeded;Claude type rate_limit_error
  /rate[ _-]?limit/i,
  // 429 的通用 HTTP status text(部分网关只回这个)
  /too many requests/i,
  // Gemini 429 的 status 字段
  /RESOURCE_EXHAUSTED/,
  // OpenAI 欠费/配额耗尽(insufficient_quota,也走 429)
  /insufficient_quota/i,
  /exceeded your current quota/i,
  // Claude 529:{"type":"overloaded_error","message":"Overloaded"}
  /overloaded_error/i,
];

/** 命中"限流/配额/上游过载"类报错时返回人话文案(附原始错误,常含可等待秒数),否则 null。 */
export function classifyRateLimitError(err: unknown): string | null {
  const text = err instanceof Error ? err.message : String(err ?? "");
  if (!text) return null;
  if (!RATE_LIMIT_PATTERNS.some((re) => re.test(text))) return null;
  return `${RATE_LIMIT_MESSAGE}\n[原始错误] ${text}`;
}

export const OUTPUT_CAP_MESSAGE =
  "本次请求的「最大输出长度」超出该模型允许的范围。请在助手设置里把它调小或清空（清空＝交由服务商决定）";

// 「输出上限本身非法」——与超上下文是两类不同的错误,别混:
//   超上下文 = 输入太长(prompt 塞不进窗口),用户该压缩/换大窗口模型;
//   本类     = max_tokens 这个数字本身越界(与输入长度无关),用户该改设置项。
// 上游文案各说各话,故按"提到上限字段名 + 提到范围/超限"的组合命中,不靠单一关键词。
const OUTPUT_CAP_PATTERNS: RegExp[] = [
  // 智谱 GLM(2026-09-09 报障原文):[1210][max_tokens参数非法：限制数值范围[1,131072]]
  /max_tokens\s*参数非法/i,
  // 通用中文表述(国内生态常见变体:参数错误/取值范围/不合法)
  /max[_-]?(?:tokens|output[_-]?tokens|completion[_-]?tokens)[^\n]{0,24}(?:参数错误|不合法|非法|取值范围|超出范围)/i,
  // Anthropic:"max_tokens: 200000 > 64000, which is the maximum allowed number of output tokens"
  /max_tokens[^\n]{0,80}maximum allowed/i,
  // OpenAI 系:"max_tokens is too large" / "Invalid value for 'max_output_tokens'"
  /max[_-]?(?:tokens|output[_-]?tokens|completion[_-]?tokens)\D{0,20}(?:is too large|must be (?:less|at most|between)|exceeds the maximum)/i,
  /(?:invalid value|unsupported value)[^\n]{0,40}max[_-]?(?:tokens|output[_-]?tokens|completion[_-]?tokens)/i,
];

/** 命中"输出上限数值非法"时返回可行动文案(附原文,含上游给出的合法区间),否则 null。
 *
 *  必须排在 classifyContextOverflowError **之后**:Anthropic 的
 *  "input length and `max_tokens` exceed context limit" 也提到 max_tokens,但那是
 *  输入太长的复合表述,归超上下文才对(它的正则先命中,本函数不会被问到)。 */
export function classifyOutputCapError(err: unknown): string | null {
  const text = err instanceof Error ? err.message : String(err ?? "");
  if (!text) return null;
  if (!OUTPUT_CAP_PATTERNS.some((re) => re.test(text))) return null;
  return `${OUTPUT_CAP_MESSAGE}\n[原始错误] ${text}`;
}

export const OAUTH_CREDENTIAL_MESSAGE =
  "订阅登录凭证已失效或无法刷新，请到「设置 → 供应商」对该供应商重新登录";

// 订阅(OAuth)供应商的凭证解析失败——refresh token 被上游拒绝、或凭证缺失。
// pi 侧只抛不删(resolve.ts 的 refresh 失败不给 terminal 语义),故每轮请求都会重试并
// 失败;不分类的话用户只看到 "OAuth refresh failed for openai-codex: ..." 这种拿不到
// 出路的原文(前面还有 providerId 之类的内部键)。这些串只可能来自我们的 OAuth 路径,
// 误判面为零,故可安全命中。
const OAUTH_CREDENTIAL_PATTERNS: RegExp[] = [
  // pi auth/resolve.ts:`OAuth refresh failed for <id>` / `OAuth auth derivation failed for <id>`
  /OAuth (?:refresh|auth derivation) failed/i,
  // 宿主 model-providers/auth/resolve.ts:凭证不可用(`OAuth credential unavailable for <id>`)
  /OAuth credential unavailable/i,
  // pi coding-agent 的会话级文案(未走上面的 resolve 路径时)
  /Credentials may have expired or network is unavailable/i,
  // pi coding-agent 的「无凭据」形态(agent-session._getRequiredRequestAuth):登出后
  // 工作区回合在 pi 侧构造完会话才在取鉴权处抛出。pi id(kimi-coding 等)只可能来自
  // 我们的订阅登记表,不会与 apiKey 供应商的报错撞车。
  /No API key found for (?:kimi-coding|openai-codex|github-copilot|xai|anthropic)/i,
];

/** 命中"订阅凭证失效/无法刷新"类报错时返回人话文案(指路重新登录),否则 null。 */
export function classifyOAuthCredentialError(err: unknown): string | null {
  const text = err instanceof Error ? err.message : String(err ?? "");
  if (!text) return null;
  if (!OAUTH_CREDENTIAL_PATTERNS.some((re) => re.test(text))) return null;
  return `${OAUTH_CREDENTIAL_MESSAGE}\n[原始错误] ${text}`;
}
