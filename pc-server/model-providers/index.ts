// pc-server/model-providers/index.ts — Provider/Model 配置与元数据
// 纪律：负责 Provider 和 Model 的默认值、能力推断、排序与迁移常量；不直接写 state.json。

import type { Assistant, JsonValue, Model, Provider } from "../foundation/types";
import { id, isRecord, mergeObjects, uniqueStrings } from "../foundation/utils";
import { hostOfProvider } from "../inference-engine/message-builder";
import { state } from "../persistence/json-store";
import { isKimiK3Model, isKimiReasoningModel } from "./request-dialect";

export const DEFAULT_AUTO_MODEL_ID = "b7055fb4-39f9-4042-a88a-0d80ed76cf08";

export function inferModelAbilities(modelId: string): string[] {
  const name = modelId.toLowerCase();
  const abilities: string[] = [];
  if (/(^|[/:_-])(gpt-[4-6]|o[134]|claude|gemini|deepseek|qwen|qwq|qvq|glm|kimi|moonshot|doubao|hunyuan|hy[3-9]|grok|llama|mistral|mixtral|command|sonar|perplexity|mimo|minimax|longcat|step|muse)/i.test(modelId) || isKimiK3Model(modelId)) {
    abilities.push("TOOL");
  }
  // Reasoning detection mirrors Android's ModelRegistry. Note that Claude family names like
  // `claude-opus-4-6` don't contain literal "claude-4" as a substring (there's `opus` between),
  // so we match either the legacy `claude-3.7 / claude-4` patterns OR any modern variant of
  // claude-{opus,sonnet,haiku}-X to catch all Anthropic models 3.5+ which all support thinking.
  // Kimi 代际走方言谓词(K2.5 起全系支持思考;正则无 kimi 模式曾致能力位缺失,
  // UI 推理选项不显示、两引擎思考链路未激活)。存量模型由启动时 enrichModel 并集自愈。
  if (
    /(gpt-[56]|^o[134]|[/:_-]o[134]|reason|reasoning|thinking|deepseek-r1|deepseek-reasoner|deepseek-v4|deepseek.*v4|deepseek-flash|qwq|qvq|qwen3|glm-[45]|glm-z1|hunyuan-a13b|[/:_-]hy[3-9]|^hy[3-9]|mimo-v2|mimo-v3|minimax[-/_]?m[-._]?3|longcat|step[-._]?3|muse|claude-3[.-]7|claude-4|claude-(opus|sonnet|haiku)-(3[.-]7|[4-9]|\d{2,})|gemini-2[.-]5|gemini-3|grok-4)/i.test(
      name,
    ) ||
    isKimiReasoningModel(name)
  ) {
    abilities.push("REASONING");
  }
  return uniqueStrings(abilities);
}

export function inferModelTools(_modelId: string): JsonValue[] {
  // Previously this auto-tagged many models (gemini-2/sonar/perplexity/grok/glm-4.5/etc.)
  // with the built-in search tool, so the chat input's "model built-in search" toggle
  // started ON by default for fresh users. That violated the principle of "no surprise
  // network calls" — users could send a message and unwittingly trigger search billing /
  // upstream rate limits. Built-in search must be opt-in, configured per-model in the
  // model edit dialog → 内置工具 tab. Returning empty here means new fetched models
  // arrive with no tools and the toggle defaults OFF.
  return [];
}

export function inferInputModalities(modelId: string, raw?: any): string[] {
  const declared = [
    ...(Array.isArray(raw?.input_modalities) ? raw.input_modalities : []),
    ...(Array.isArray(raw?.inputModalities) ? raw.inputModalities : []),
  ].map((item) => String(item).toUpperCase());
  if (declared.length) return uniqueStrings(declared);
  // 视觉(图像输入)登记,逐家对齐安卓 ModelRegistry 的 visionInput()(2026-09-17 核对行号):
  //   deepseek-flash/v4.1(多模态,L311/318)、step-3 系(L454/460)、minimax-m3(L528)、
  //   mimo-v2.5/v3 系(L544/555/561)、longcat-2.0(L582)、qwen3.7/3.8 非 Max(L362/368)、
  //   gpt-5.6/gpt-6(经 gpt-4o 同款 token 命中,补 gpt-5/gpt-6)、glm-4v/5.3-flash。
  //   纯文本(刻意不收):hy3/hy4、qwen3.7/3.8-max、glm-5.2/5.3 普通版——安卓同样无 visionInput。
  return /(vision|visual|vl|omni|gpt-4o|gpt-4\.1|gpt-5|gpt-6|gemini|claude-3|claude-4|qwen.*vl|qwen3[.-]?[78](?!.*max)|glm-4v|glm-5[.-]3[.-]?flash|deepseek.*(flash|v[-._]?4)|step[-._]?3|minimax[-._/]?m[-._]?3|longcat|mimo[-_./:]?v?2[-_./:]?5|mimo[-_./:]?v?2[-_./:]?omni|mimo[-_./:]?v?3|muse|grok-vision|llava|pixtral)/i.test(modelId) || isKimiK3Model(modelId)
    ? ["TEXT", "IMAGE"]
    : ["TEXT"];
}

export function inferOutputModalities(modelId: string, raw?: any): string[] {
  const declared = [
    ...(Array.isArray(raw?.output_modalities) ? raw.output_modalities : []),
    ...(Array.isArray(raw?.outputModalities) ? raw.outputModalities : []),
    ...(Array.isArray(raw?.modalities) ? raw.modalities : []),
  ].map((item) => String(item).toUpperCase());
  if (declared.length) return uniqueStrings(declared);
  return /(dall-e|gpt-image|image|imagen|flux|stable-diffusion|sd3|midjourney|recraft)/i.test(modelId)
    ? ["TEXT", "IMAGE"]
    : ["TEXT"];
}

export function enrichModel(input: Model, raw?: any): Model {
  const abilities = uniqueStrings([...(input.abilities ?? []), ...inferModelAbilities(input.modelId)]);
  const inputModalities = uniqueStrings([...(input.inputModalities ?? []), ...inferInputModalities(input.modelId, raw)]);
  const outputModalities = uniqueStrings([...(input.outputModalities ?? []), ...inferOutputModalities(input.modelId, raw)]);
  const tools = (input.tools?.length ? input.tools : inferModelTools(input.modelId)) as JsonValue[];
  return {
    ...input,
    abilities,
    inputModalities: inputModalities.length ? inputModalities : ["TEXT"],
    outputModalities: outputModalities.length ? outputModalities : ["TEXT"],
    tools,
  };
}

export function model(modelId: string, displayName = modelId): Model {
  return enrichModel({
    id: id(),
    modelId,
    displayName,
    type: "CHAT",
    inputModalities: ["TEXT"],
    outputModalities: ["TEXT"],
    abilities: [],
    tools: [],
  });
}

export function provider(input: Partial<Provider> & Pick<Provider, "id" | "name" | "baseUrl">): Provider {
  return {
    type: "openai",
    enabled: false,
    builtIn: true,
    shortDescription: "",
    description: "",
    apiKey: "",
    chatCompletionsPath: "/chat/completions",
    useResponseApi: false,
    // 对齐安卓 ProviderSetting.OpenAI.includeHistoryReasoning 默认值 (commit e63d017)
    includeHistoryReasoning: true,
    promptCaching: false,
    promptCacheTtl: "5m",
    promptCacheKey: false,
    // 出厂即视为连通、免手动测试的,只有 RikkaHub 内置供应商一条;它已下架(SUNSET),
    // 但条件保留——老用户 state 里若仍存着该内置供应商(配过 key 的),沿用出厂 testPassed。
    testPassed: input.id === "a8d2d463-e8c0-41f2-b89e-f5eb8e716cce",
    models: [],
    balanceOption: { enabled: false, apiPath: "/credits", resultPath: "data.total_usage" },
    ...input,
  };
}

// 一次性下架的预置供应商(合作终止)。它们已从 defaultProviders/defaultTtsProviders 移除,
// 但老用户 state 里可能还存着 —— normalize 时做一次清理:只删用户从未真正使用(未填
// apiKey)的;已配 key 的保留,避免静默删掉用户的接入凭据。
export const SUNSET_PROVIDER_IDS = new Set<string>([
  "1b1395ed-b702-4aeb-8bc1-b681c4456953", // AiHubMix
  "da020a90-f7b3-4c29-b90e-c511a0630630", // 小马算力
  "da93779f-3956-48cc-82ef-67bb482eaaf7", // 302.AI
  "53027b08-1b58-43d5-90ed-29173203e3d8", // AckAI
  "4da09554-8844-4cc8-a4a9-fe1b2515e91b", // UnifyLLM
  "a8d2d463-e8c0-41f2-b89e-f5eb8e716cce", // RikkaHub(内置模型,服务停维护下架;配过 key 的保留)
]);

// 1.1.1 供应商迁移用的固定 id。改名/补模型走 id 匹配,确保老用户 state 也生效。
export const TENCENT_PROVIDER_ID = "ef5d149b-8e34-404b-818c-6ec242e5c3c5";
export const NA_API_PROVIDER_ID = "e7a2b5c3-8f4d-4e6a-9b1c-3d5f7e8a2c04";
// 钠API 预置模型。仅当老用户从未配置过钠API(其 models 为空)时补上,已自定义的不覆盖。
export const NA_API_PRESET_MODELS = [
  "claude-opus-4-6",
  "gpt-5.5",
  "deepseek-ai/DeepSeek-V4-Flash",
  "deepseek-ai/DeepSeek-V4-Pro",
];

// 1.1.1 预置供应商期望顺序(按 id)。老用户也按此重排——内置(builtIn)供应商排到
// 对应位置,用户新增的自定义供应商不受影响,统一保留在内置供应商之后(保持其相对顺序)。
// 排序是幂等的:重复执行结果一致,不会反复改动已排好的 state。
const BUILTIN_PROVIDER_ORDER: readonly string[] = [
  "1eeea727-9ee5-4cae-93e6-6fb01a4d051e", // OpenAI
  "b2c7e1a4-9f3d-4a6e-8c1b-5d7f9e2a3b14", // Anthropic
  "6ab18148-c138-4394-a46f-1cd8c8ceaa6d", // Gemini
  "ff3cde7e-0f65-43d7-8fb2-6475c99f5990", // xAI
  "f099ad5b-ef03-446d-8e78-7e36787f780b", // DeepSeek
  "f76cae46-069a-4334-ab8e-224e4979e58c", // 阿里云百炼
  "3dfd6f9b-f9d9-417f-80c1-ff8d77184191", // 火山引擎
  "ef5d149b-8e34-404b-818c-6ec242e5c3c5", // 腾讯混元
  "3bc40dc1-b11a-46fa-863b-6306971223be", // 智谱AI开放平台
  "d6c4d8c6-3f62-4ca9-a6f3-7ade6b15ecc3", // 月之暗面
  "f4f8870e-82d3-495b-9b64-d58e508b3b2c", // 阶跃星辰
  "e7a2b5c3-8f4d-4e6a-9b1c-3d5f7e8a2c04", // 钠API
  "d5734028-d39b-4d41-9841-fd648d65440e", // OpenRouter
  "386e0f29-8228-4512-affe-8fd8add82d88", // Vercel AI Gateway
  "56a94d29-c88b-41c5-8e09-38a7612d6cf8", // 硅基流动
  // 对齐 APP 新增的 Claude 形 / OpenAI 形预置(APP 顺序追加在末尾,APP 的 MaruCode 赞助商不移植)。
  "b4deabea-20fb-4101-a74c-65679c7e4754", // MiniMax
  "a2bafe83-eaf8-47bf-a8c7-3dd82d89f637", // MIMO
];

export function builtinProviderRank(providerItem: Provider): number {
  const idx = BUILTIN_PROVIDER_ORDER.indexOf(providerItem.id);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

export function defaultProviders(): Provider[] {
  return [
    provider({
      id: "1eeea727-9ee5-4cae-93e6-6fb01a4d051e",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      shortDescription: "OpenAI 官方 API",
      models: [model("gpt-4.1"), model("gpt-4.1-mini"), model("gpt-4o-mini")],
    }),
    provider({
      id: "b2c7e1a4-9f3d-4a6e-8c1b-5d7f9e2a3b14",
      type: "claude",
      name: "Anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      shortDescription: "Anthropic Claude 原生 API",
      models: [model("claude-opus-4-6"), model("claude-sonnet-4-6"), model("claude-haiku-4-5-20251001")],
    }),
    provider({
      id: "6ab18148-c138-4394-a46f-1cd8c8ceaa6d",
      type: "google",
      name: "Gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      enabled: true,
      shortDescription: "谷歌官方 Gemini API",
      models: [model("gemini-2.5-flash"), model("gemini-2.5-pro")],
    }),
    provider({ id: "ff3cde7e-0f65-43d7-8fb2-6475c99f5990", name: "xAI", baseUrl: "https://api.x.ai/v1", useResponseApi: true }),
    provider({
      id: "f099ad5b-ef03-446d-8e78-7e36787f780b",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      shortDescription: "DeepSeek 官方 API",
      balanceOption: { enabled: true, apiPath: "/user/balance", resultPath: "balance_infos[0].total_balance" },
    }),
    provider({ id: "f76cae46-069a-4334-ab8e-224e4979e58c", name: "阿里云百炼", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }),
    provider({ id: "3dfd6f9b-f9d9-417f-80c1-ff8d77184191", name: "火山引擎", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" }),
    provider({ id: "ef5d149b-8e34-404b-818c-6ec242e5c3c5", name: "腾讯混元", baseUrl: "https://api.hunyuan.cloud.tencent.com/v1" }),
    provider({ id: "3bc40dc1-b11a-46fa-863b-6306971223be", name: "智谱AI开放平台", baseUrl: "https://open.bigmodel.cn/api/paas/v4" }),
    provider({
      id: "d6c4d8c6-3f62-4ca9-a6f3-7ade6b15ecc3",
      name: "月之暗面",
      baseUrl: "https://api.moonshot.cn/v1",
      balanceOption: { enabled: true, apiPath: "/users/me/balance", resultPath: "data.available_balance" },
    }),
    provider({ id: "f4f8870e-82d3-495b-9b64-d58e508b3b2c", name: "阶跃星辰", baseUrl: "https://api.stepfun.com/v1" }),
    provider({
      id: "e7a2b5c3-8f4d-4e6a-9b1c-3d5f7e8a2c04",
      name: "钠API",
      baseUrl: "https://naapi.cc/v1",
      shortDescription: "钠 API 提供 ChatGPT、Claude、Gemini 等 100+ 全球顶级模型接口",
      description: "钠 API 提供 ChatGPT、Claude、Gemini 等 100+ 全球顶级模型接口,Focusing on competitive pricing and superior stability.",
      balanceOption: { enabled: true, apiPath: "/credits", resultPath: "data.total_credits" },
      models: [
        model("claude-opus-4-6"),
        model("gpt-5.5"),
        model("deepseek-ai/DeepSeek-V4-Flash"),
        model("deepseek-ai/DeepSeek-V4-Pro"),
      ],
    }),
    provider({
      id: "d5734028-d39b-4d41-9841-fd648d65440e",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      shortDescription: "OpenRouter 中转站",
      balanceOption: { enabled: true, apiPath: "/credits", resultPath: "data.total_credits - data.total_usage" },
    }),
    provider({
      id: "386e0f29-8228-4512-affe-8fd8add82d88",
      name: "Vercel AI Gateway",
      baseUrl: "https://ai-gateway.vercel.sh/v1",
      shortDescription: "Vercel AI Gateway",
      balanceOption: { enabled: true, apiPath: "/credits", resultPath: "balance" },
    }),
    provider({
      id: "56a94d29-c88b-41c5-8e09-38a7612d6cf8",
      name: "硅基流动",
      baseUrl: "https://api.siliconflow.cn/v1",
      shortDescription: "SiliconFlow API",
      balanceOption: { enabled: true, apiPath: "/user/info", resultPath: "data.totalBalance" },
    }),
    // 对齐 APP 新增的两家内置供应商(APP 的 MaruCode 为赞助商位,不移植)。沿用 APP 的稳定
    // UUID,使未来 merge/reorder 与 APP 对齐;均无出厂预置模型,配 key 后由 /models 拉取。
    provider({
      id: "b4deabea-20fb-4101-a74c-65679c7e4754",
      type: "claude",
      name: "MiniMax",
      baseUrl: "https://api.minimaxi.com/anthropic/v1",
      shortDescription: "MiniMax 官方 Anthropic 兼容端点",
    }),
    provider({
      id: "a2bafe83-eaf8-47bf-a8c7-3dd82d89f637",
      name: "MIMO",
      baseUrl: "https://api.xiaomimimo.com/v1",
      shortDescription: "小米 MiMo 官方 OpenAI 兼容 API",
    }),
  ];
}

export function findModel(modelId: string | null | undefined) {
  const wanted = modelId || state.settings.chatModelId;
  for (const provider of state.settings.providers) {
    const modelItem = provider.models.find((item) => item.id === wanted || item.modelId === wanted);
    if (modelItem) {
      // Per-model provider override: if this model carries a `providerOverwrite` object,
      // it replaces the parent provider entirely for outbound requests (baseUrl, apiKey,
      // type, etc.). Mirrors Android's `Model.findProvider()` (PreferencesStore.kt:648):
      //   if (providerOverwrite != null) return providerOverwrite.copyProvider(models=[])
      // We spread the override on top of the parent so any fields the override omits
      // (like `enabled`, `id`, `testPassed`) fall through to the parent — these are
      // bookkeeping fields the override doesn't need to redefine. `models: []` is also
      // forced because the override carries its own (irrelevant) model list in Android;
      // we use the parent's `modelItem` regardless.
      const overwrite = modelItem.providerOverwrite;
      if (overwrite && typeof overwrite === "object" && overwrite.type) {
        const effectiveProvider = { ...provider, ...overwrite, id: provider.id, models: [] } as Provider;
        return { provider: effectiveProvider, model: modelItem };
      }
      return { provider, model: modelItem };
    }
  }
  return { provider: state.settings.providers.find((item) => item.enabled) ?? state.settings.providers[0], model: model("auto", "Auto") };
}

// 对齐移动端:日志存完整请求/响应体(供前端 JsonTree 展开),默认不再字符级截断。
// 可选 limit 仅保留给少数需要硬截断的场景(如错误摘要)。
export function jsonBody(value: unknown, limit?: number): string {
  const text = JSON.stringify(value, null, 2);
  if (limit !== undefined && text.length > limit) return `${text.slice(0, limit)}\n\n... [truncated ${text.length - limit} chars]`;
  return text;
}

export function textBody(value: string, limit?: number): string {
  if (limit !== undefined && value.length > limit) return `${value.slice(0, limit)}\n\n... [truncated ${value.length - limit} chars]`;
  return value;
}

export function modelsEndpointFor(providerItem: Provider) {
  const base = providerItem.baseUrl.replace(/\/+$/, "");
  if (providerItem.type === "google") return `${base}/models?pageSize=100`;
  // claude 拼接标准化(A):同 endpointFor,剥尾部 /v1 拼 /v1/models,带不带 /v1 都能工作。
  if (providerItem.type === "claude") return `${base.replace(/\/v1$/, "")}/v1/models`;
  return `${base}/models`;
}

export function providerHeaders(providerItem: Provider) {
  const headers: Record<string, string> = {};
  if (providerItem.type === "openai") headers.Authorization = `Bearer ${providerItem.apiKey}`;
  // issue10: Gemini 鉴权统一走 x-goog-api-key 头（与安卓非 Vertex 路径、Cherry Studio 一致）。
  // 之前用 ?key= query，官方 API 两者都收，但主流中转网关只解析 header，query 会被判 invalid key。
  if (providerItem.type === "google") headers["x-goog-api-key"] = providerItem.apiKey;
  if (providerItem.type === "claude") {
    headers["x-api-key"] = providerItem.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }
  return headers;
}

export function customHeaderRecords(assistant: Assistant, modelItem?: Model) {
  return [
    ...(Array.isArray(assistant.customHeaders) ? assistant.customHeaders : []),
    ...(Array.isArray(modelItem?.customHeaders) ? modelItem.customHeaders : []),
  ].filter(isRecord);
}

// 会话身份头(台账 §7.4,对齐安卓 configureSessionHeaders):给每条 LLM 请求带当前会话 ID,
// 让能识别的上游(网关/聚合商)做会话亲和——前缀缓存更可能命中(更省钱更快)、请求关联与
// 限流分桶;不识别的上游静默忽略,无害。安卓对全 provider 发 X-Session-ID、opencode 另发
// x-opencode-session。
//
// 注入纪律(三条,缺一不可):
//  ① 每条请求都注入:conversationId 缺省时兜底随机 UUID(单次调用内稳定),不再是"辅助
//     调用整条不发"——OpenCode Zen 对缺头请求直接 400 MissingSessionID(安卓 #1902,
//     标题/翻译/压缩/OCR/连通性测试全中招;它只要求非空且稳定,不校验内容)。有会话
//     上下文的辅助调用(标题/压缩)应传真实 conversationId,由调用方负责。
//  ② ??= 而非 =:用户在 助手/模型自定义头 里显式配的同名头优先(与下方 X-Title/HTTP-Referer
//     同纪律)——我们不静默覆盖用户意图。
//  ③ 这是唯一注入点:applyRequestHeaders(会话流)与 applyModelRequestHeaders(pi 引擎注册头 +
//     辅助/测试)都过它;新引擎只要复用这两个汇聚函数之一就自动继承,无需各自记得加。
function applySessionHeaders(
  headers: Record<string, string>,
  baseUrl: string,
  conversationId: string | null | undefined,
) {
  const sessionId = conversationId || crypto.randomUUID();
  headers["X-Session-ID"] ??= sessionId;
  if (hostOfProvider({ baseUrl } as Provider) === "opencode.ai") {
    headers["x-opencode-session"] ??= sessionId;
  }
}

export function modelCustomHeaderRecords(modelItem?: Model) {
  return (Array.isArray(modelItem?.customHeaders) ? modelItem.customHeaders : []).filter(isRecord);
}

// 主机特例(对齐安卓 configureReferHeaders):applyModelRequestHeaders/applyRequestHeaders
// 共用这一份,不再两处各写一遍。
function applyHostSpecialHeaders(headers: Record<string, string>, providerItem: Provider) {
  const host = hostOfProvider(providerItem);
  if (host === "aihubmix.com") headers["APP-Code"] ??= "DKHA9468";
  if (host === "openrouter.ai") {
    headers["X-Title"] ??= "RikkaHub";
    headers["HTTP-Referer"] ??= "https://rikka-ai.com";
  }
}

export function applyModelRequestHeaders(
  headers: Record<string, string>,
  providerItem: Provider,
  modelItem?: Model,
  sessionId?: string | null,
) {
  for (const header of modelCustomHeaderRecords(modelItem)) {
    const name = String(header.name ?? header.key ?? "").trim();
    if (name) headers[name] = String(header.value ?? "");
  }
  applyHostSpecialHeaders(headers, providerItem);
  applySessionHeaders(headers, providerItem.baseUrl, sessionId);
  return headers;
}

export function applyRequestHeaders(
  headers: Record<string, string>,
  assistant: Assistant,
  providerItem: Provider,
  modelItem?: Model,
  sessionId?: string | null,
) {
  for (const header of customHeaderRecords(assistant, modelItem)) {
    const name = String(header.name ?? header.key ?? "").trim();
    if (name) headers[name] = String(header.value ?? "");
  }
  applyHostSpecialHeaders(headers, providerItem);
  applySessionHeaders(headers, providerItem.baseUrl, sessionId);
  return headers;
}

export function decodeCustomBodyValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

export function applyCustomBody<T extends Record<string, any>>(body: T, assistant: Assistant, modelItem?: Model): T {
  const entries = [
    ...(Array.isArray(assistant.customBodies) ? assistant.customBodies : []),
    ...(Array.isArray(modelItem?.customBodies) ? modelItem.customBodies : []),
  ].filter(isRecord);
  if (entries.length === 0) return body;
  let next: Record<string, any> = { ...body };
  for (const entry of entries) {
    const key = String(entry.key ?? entry.name ?? "").trim();
    if (!key) continue;
    const value = decodeCustomBodyValue(entry.value);
    const existing = next[key];
    next[key] = isRecord(existing) && isRecord(value)
      ? mergeObjects(existing as Record<string, any>, value as Record<string, any>)
      : value;
  }
  return next as T;
}

export function applyModelCustomBody<T extends Record<string, any>>(body: T, modelItem?: Model): T {
  const entries = (Array.isArray(modelItem?.customBodies) ? modelItem.customBodies : []).filter(isRecord);
  if (entries.length === 0) return body;
  let next: Record<string, any> = { ...body };
  for (const entry of entries) {
    const key = String(entry.key ?? entry.name ?? "").trim();
    if (!key) continue;
    const value = decodeCustomBodyValue(entry.value);
    const existing = next[key];
    next[key] = isRecord(existing) && isRecord(value)
      ? mergeObjects(existing as Record<string, any>, value as Record<string, any>)
      : value;
  }
  return next as T;
}

export function customBodyEntriesForForm(modelItem?: Model) {
  return (Array.isArray(modelItem?.customBodies) ? modelItem.customBodies : [])
    .filter(isRecord)
    .map((entry: Record<string, JsonValue>) => ({
      key: String(entry.key ?? entry.name ?? "").trim(),
      value: decodeCustomBodyValue(entry.value),
    }))
    .filter((entry) => entry.key.length > 0);
}

export function customFormValue(value: unknown) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function normalizeFetchedModels(providerItem: Provider, raw: any): Model[] {
  const items = providerItem.type === "google" ? raw.models ?? [] : raw.data ?? raw.models ?? [];
  const models = (Array.isArray(items) ? items : [])
    .map((item: any) => {
      const rawId = String(item.id ?? item.name ?? item.model ?? "").trim();
      const modelId = rawId.replace(/^models\//, "");
      if (!modelId) return null;
      const displayName = String(item.display_name ?? item.displayName ?? item.name ?? modelId).replace(/^models\//, "");
      return enrichModel(model(modelId, displayName || modelId), item);
    })
    .filter(Boolean) as Model[];
  const byId = new Map<string, Model>();
  for (const item of models) byId.set(item.modelId, item);
  return [...byId.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
}

export function firstProviderModel(providerItem: Provider, preferredModelId?: string, fetchedModels: Model[] = []) {
  const preferred = preferredModelId?.trim();
  if (preferred && preferred !== "auto") return preferred;
  const configured = providerItem.models.find((item) => item.modelId && item.modelId !== "auto")?.modelId;
  if (configured) return configured;
  const fetched = fetchedModels.find((item) => item.modelId && item.modelId !== "auto")?.modelId;
  if (fetched) return fetched;
  const fallback = providerItem.models.find((item) => item.modelId)?.modelId;
  if (fallback && fallback !== "auto") return fallback;
  throw new Error("No test model is available. Fetch the provider model list or select a model first.");
}

export function providerTestModel(providerItem: Provider, selectedModel: string, fetchedModels: Model[] = []) {
  return (
    providerItem.models.find((item) => item.modelId === selectedModel || item.id === selectedModel)
    ?? fetchedModels.find((item) => item.modelId === selectedModel || item.id === selectedModel)
    ?? model(selectedModel, selectedModel)
  );
}

export function providerTestCorePassed(checks: Array<{ mode: string; ok: boolean }>) {
  const nonStream = checks.find((item) => item.mode === "non_stream");
  const stream = checks.find((item) => item.mode === "stream");
  return nonStream?.ok === true || stream?.ok === true;
}
