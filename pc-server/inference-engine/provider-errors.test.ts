// provider-errors.test.ts — provider 报错人话映射的回归防线(专题4 超上下文 + 专题7 限流)。
// 正例取自三家 provider 的真实报文形状(providers.ts 抛错格式:`名字 状态码: 正文`);
// 负例确保鉴权/普通网络错误不会被误分类。

import { describe, expect, test } from "bun:test";
import {
  CONTEXT_OVERFLOW_MESSAGE,
  OAUTH_CREDENTIAL_MESSAGE,
  OUTPUT_CAP_MESSAGE,
  RATE_LIMIT_MESSAGE,
  classifyContextOverflowError,
  classifyOAuthCredentialError,
  classifyOutputCapError,
  classifyRateLimitError,
} from "./provider-errors";

describe("classifyContextOverflowError", () => {
  const overflowSamples = [
    // OpenAI 官方
    'OpenAI 400: {"error":{"message":"This model\'s maximum context length is 128000 tokens. However, your messages resulted in 152340 tokens.","type":"invalid_request_error","code":"context_length_exceeded"}}',
    // DeepSeek(OpenAI 兼容,同文案不同 code)
    "DeepSeek 400: This model's maximum context length is 65536 tokens. However, you requested 90000 tokens.",
    // Claude
    'Claude 400: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210145 tokens > 200000 maximum"}}',
    'Claude 400: {"type":"error","error":{"type":"invalid_request_error","message":"input length and `max_tokens` exceed context limit: 195000 + 8192 > 200000"}}',
    // Gemini
    "Gemini 400: The input token count (1189529) exceeds the maximum number of tokens allowed (1048576).",
    // OpenAI 兼容网关的通用表述
    "OpenRouter 400: This request exceeds the context window of the model.",
  ];
  test.each(overflowSamples)("命中:%s", (sample) => {
    expect(classifyContextOverflowError(new Error(sample))).toBe(CONTEXT_OVERFLOW_MESSAGE);
  });

  const normalSamples = [
    "OpenAI 401: Incorrect API key provided",
    "OpenAI 429: Rate limit reached for tokens per min (TPM): Limit 30000, Used 29000",
    "Claude 529: overloaded_error",
    "Gemini 400: User location is not supported for the API use.",
    "fetch failed: ECONNRESET",
    // 正常回答里讨论 token 的内容不该进这里(本函数只吃 Error),但防御性验证普通提及不命中
    "some response mentioning tokens and context in passing",
  ];
  test.each(normalSamples)("不命中:%s", (sample) => {
    expect(classifyContextOverflowError(new Error(sample))).toBeNull();
  });

  test("非 Error 输入不炸", () => {
    expect(classifyContextOverflowError(null)).toBeNull();
    expect(classifyContextOverflowError(undefined)).toBeNull();
    expect(classifyContextOverflowError("prompt is too long: 1 > 0")).toBe(CONTEXT_OVERFLOW_MESSAGE);
  });
});

describe("classifyRateLimitError", () => {
  const rateLimitSamples = [
    // OpenAI 429(限流)与 insufficient_quota(欠费,同为 429)
    'OpenAI 429: {"error":{"message":"Rate limit reached for tokens per min (TPM): Limit 30000, Used 29000","type":"tokens","code":"rate_limit_exceeded"}}',
    'OpenAI 429: {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}',
    // Claude 429 与 529 过载
    'Claude 429: {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
    'Claude 529: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    // Gemini 429
    'Gemini 429: {"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}',
    // 只回 HTTP status text 的网关
    "SomeGateway 429: Too Many Requests",
  ];
  test.each(rateLimitSamples)("命中:%s", (sample) => {
    const result = classifyRateLimitError(new Error(sample));
    expect(result).toStartWith(RATE_LIMIT_MESSAGE);
    // 原始错误要附带(常含可等待秒数/配额信息)
    expect(result).toContain(sample);
  });

  const normalSamples = [
    "OpenAI 401: Incorrect API key provided",
    "OpenAI 400: context_length_exceeded",
    "Gemini 400: User location is not supported for the API use.",
    "fetch failed: ECONNRESET",
    "响应头超时:600s 内未收到上游响应",
  ];
  test.each(normalSamples)("不命中:%s", (sample) => {
    expect(classifyRateLimitError(new Error(sample))).toBeNull();
  });

  test("非 Error 输入不炸", () => {
    expect(classifyRateLimitError(null)).toBeNull();
    expect(classifyRateLimitError(undefined)).toBeNull();
  });
});

// 2026-09-09 用户实测:智谱 GLM-5.3 两个模式都发出 100 万级 max_tokens 被拒。修因之外
// 还要修"看不懂":原文只有一串错误码,用户无从判断该改哪个设置项。
describe("classifyOutputCapError", () => {
  const capSamples = [
    // 智谱(报障原文,Anthropic 兼容口)
    'Claude 400: {"type":"error","error":{"type":"invalid_request_error","code":"1210","message":"[1210][max_tokens参数非法：限制数值范围[1,131072]][202609092146352c28dbfec858417b]"}}',
    // Anthropic 官方
    'Claude 400: {"type":"error","error":{"message":"max_tokens: 200000 > 64000, which is the maximum allowed number of output tokens"}}',
    // OpenAI 系
    "OpenAI 400: max_tokens is too large: 200000. This model supports at most 128000 completion tokens",
    'OpenAI 400: {"error":{"message":"Invalid value for \'max_output_tokens\': must be between 16 and 128000"}}',
    // 国内生态的其他中文变体
    "Ark 400: max_tokens 参数错误,取值范围为 [1, 32768]",
  ];
  test.each(capSamples)("命中:%s", (sample) => {
    const result = classifyOutputCapError(new Error(sample));
    expect(result).toStartWith(OUTPUT_CAP_MESSAGE);
    // 原文要附带——上游通常在报文里给出合法区间,那是用户填新值的依据。
    expect(result).toContain(sample);
  });

  const normalSamples = [
    "OpenAI 401: Incorrect API key provided",
    "OpenAI 429: Rate limit reached for tokens per min (TPM)",
    "OpenAI 400: context_length_exceeded",
    "fetch failed: ECONNRESET",
    // 正常讨论 max_tokens 的文本不该命中(本函数只吃 Error,防御性验证)
    "assistant explaining what max_tokens means in an answer",
  ];
  test.each(normalSamples)("不命中:%s", (sample) => {
    expect(classifyOutputCapError(new Error(sample))).toBeNull();
  });

  test("不抢超上下文的归类:含 max_tokens 的复合超限表述归超上下文", () => {
    // Anthropic 的这条同时提到 max_tokens,但根因是输入太长(该压缩/换模型),
    // 不是上限数值非法(该改设置项)。orchestrator 的分类链顺序保证超上下文先命中;
    // 这里锁住"顺序不可换"这件事本身。
    const compound =
      'Claude 400: {"type":"error","error":{"message":"input length and `max_tokens` exceed context limit: 195000 + 8192 > 200000"}}';
    expect(classifyContextOverflowError(new Error(compound))).toBe(CONTEXT_OVERFLOW_MESSAGE);
    const chained = classifyContextOverflowError(new Error(compound)) ?? classifyOutputCapError(new Error(compound));
    expect(chained).toBe(CONTEXT_OVERFLOW_MESSAGE);
  });

  test("非 Error 输入不炸", () => {
    expect(classifyOutputCapError(null)).toBeNull();
    expect(classifyOutputCapError(undefined)).toBeNull();
    expect(classifyOutputCapError("max_tokens参数非法：限制数值范围[1,131072]")).toStartWith(OUTPUT_CAP_MESSAGE);
  });
});

describe("classifyOAuthCredentialError", () => {
  const positives = [
    // pi auth/resolve.ts:`OAuth refresh failed for <piId>: <cause>`
    "OAuth refresh failed for openai-codex: Kimi Code token refresh unauthorized (status 401)",
    "OAuth auth derivation failed for anthropic: boom",
    // 宿主 model-providers/auth/resolve.ts
    "OAuth credential unavailable for 98d0557b-0700-41e5-b1d6-ee875a53ae5a",
    // pi coding-agent 会话级文案
    'Authentication failed for "openai-codex". Credentials may have expired or network is unavailable. Run \'/login openai-codex\' to re-authenticate.',
    // pi coding-agent 无凭据形态(2026-09-26 实测:登出 Kimi 后工作区回合原文报错)
    "No API key found for kimi-coding.\n\nUse /login to log into a provider via OAuth or API key.",
  ];
  test.each(positives)("命中凭证失效文案:%s", (sample) => {
    expect(classifyOAuthCredentialError(new Error(sample))).toStartWith(OAUTH_CREDENTIAL_MESSAGE);
  });

  test("不误伤:普通鉴权/网络错误与 apiKey 供应商缺 key 不归此类", () => {
    for (const sample of [
      "401 Unauthorized: invalid api key",
      "fetch failed: ECONNREFUSED",
      // pi 的 ModelRegistry 同款句式但 provider 是 apiKey 型(带引号、id 不在订阅登记表)
      'No API key found for "some-api-key-provider"',
      "No API key found for provider openai",
      "429 Too Many Requests",
    ]) {
      expect(classifyOAuthCredentialError(new Error(sample))).toBeNull();
    }
  });

  test("非 Error 输入不炸", () => {
    expect(classifyOAuthCredentialError(null)).toBeNull();
    expect(classifyOAuthCredentialError(undefined)).toBeNull();
    expect(classifyOAuthCredentialError("OAuth refresh failed for kimi-coding")).toStartWith(OAUTH_CREDENTIAL_MESSAGE);
  });
});
