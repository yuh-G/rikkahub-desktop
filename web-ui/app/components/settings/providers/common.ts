// components/settings/providers/common.ts — 供应商页的纯函数与常量(无 React):类型推断、端点预览、
// 格式切换换算。端点预览与服务端 model-providers/checks.ts 的 endpointFor 同款规则。

import { createId } from "~/lib/id";
import type { ProviderProfile } from "~/types";
import { textValue } from "~/components/settings/shared";

// API 格式切换的 base 换算(协议默认/出厂/登记三张表 + 机器地址判定 + 换算规则)独立在
// lib/provider-base-urls.ts——纯函数零依赖,行为锁在 pc-server/api/provider-base-urls.test.ts
// 的往返矩阵(核心不变量:往返不漂移、自定义不覆写)。御三家 URL 与登记端点只在那一个文件维护。
import { type ProviderKind, baseUrlForKindSwitch } from "~/lib/provider-base-urls";

// Best-effort model-type inference from model id; falls back to CHAT when nothing matches.
// Used to pre-fill the per-model type selector when the user toggles a model on. Users can
// always override in the model row (parity with Android, which makes this manual).
export function inferModelType(modelId: string): "CHAT" | "IMAGE" | "EMBEDDING" {
  const id = String(modelId ?? "").toLowerCase();
  if (!id) return "CHAT";
  if (
    /(text-embedding|^embedding|-embed(ding)?|bge|e5|gte|m3-embedding|nomic-embed|jina-embed)/.test(
      id,
    )
  )
    return "EMBEDDING";
  if (
    /(gpt-image|dall-e|dalle|imagen|stable-diffusion|sd[\d-]|flux|midjourney|kolors|qwen-image|wanx|hunyuan-dit|seedream|cogview|recraft)/.test(
      id,
    )
  )
    return "IMAGE";
  return "CHAT";
}

export function applyAutoModelType<M extends { modelId?: string; type?: string }>(model: M): M {
  if (model.type && model.type !== "CHAT") return model;
  const inferred = inferModelType(String(model.modelId ?? ""));
  if (inferred === "CHAT") return model;
  return { ...model, type: inferred };
}

export function providerKind(provider: ProviderProfile): string {
  return textValue(provider.type) || "openai";
}

export function balanceOptionOf(provider: ProviderProfile): Record<string, unknown> {
  return provider.balanceOption && typeof provider.balanceOption === "object"
    ? (provider.balanceOption as Record<string, unknown>)
    : {};
}

export function defaultPathForKind(kind: ProviderKind, responseApi = false): string {
  if (kind === "openai") return responseApi ? "/responses" : "/chat/completions";
  if (kind === "claude") return "/messages";
  return "/models/{model}:generateContent";
}

// 预置供应商的"获取 API Key"官网映射。按 baseUrl 子串匹配(大小写无关)。
// 供应商表单的 API Key 标签旁,命中即显示一个靠右的"获取 API Key"链接,跳转官网。
// 新增预置供应商时只需在这里加一行 { 子串: 官网 URL }。
const PROVIDER_GET_KEY_URLS: Array<{ match: RegExp; url: string }> = [
  { match: /naapi\.cc/i, url: "https://naapi.cc/" },
];
export function providerGetKeyUrl(baseUrl: string): string | null {
  for (const entry of PROVIDER_GET_KEY_URLS) {
    if (entry.match.test(baseUrl)) return entry.url;
  }
  return null;
}

export function endpointPreview(provider: ProviderProfile): string {
  const kind = providerKind(provider) as ProviderKind;
  const base = textValue(provider.baseUrl).replace(/\/+$/, "");
  if (!base) return defaultPathForKind(kind, provider.useResponseApi === true);
  if (kind === "openai")
    return `${base}${provider.useResponseApi === true ? textValue(provider.responsesPath) || "/responses" : textValue(provider.chatCompletionsPath) || "/chat/completions"}`;
  // claude 拼接标准化(A):与服务端 endpointFor 同款规则(剥尾部 /v1 拼 /v1/messages),
  // 预览即真实请求 URL,带不带 /v1 都能工作。
  if (kind === "claude") return `${base.replace(/\/v1$/, "")}/v1/messages`;
  // issue10:Gemini 鉴权已改走 x-goog-api-key 头,URL 不再带 ?key=,预览同步。
  return `${base}/models/{model}:generateContent`;
}

export function modelListEndpointPreview(provider: ProviderProfile): string {
  const kind = providerKind(provider) as ProviderKind;
  const base = textValue(provider.baseUrl).replace(/\/+$/, "");
  if (!base) return kind === "google" ? "/models?pageSize=100" : "/models";
  if (kind === "google") return `${base}/models?pageSize=100`;
  // claude 拼接标准化(A):与服务端 modelsEndpointFor 同款规则。
  if (kind === "claude") return `${base.replace(/\/v1$/, "")}/v1/models`;
  return `${base}/models`;
}

export function createProvider(): ProviderProfile {
  return {
    id: createId(),
    type: "openai",
    enabled: true,
    name: "自定义供应商",
    builtIn: false,
    shortDescription: "用户添加的 OpenAI-compatible API",
    description: "",
    apiKey: "",
    baseUrl: "https://api.example.com/v1",
    chatCompletionsPath: "/chat/completions",
    useResponseApi: false,
    responsesPath: "/responses",
    // 与安卓 OpenAI provider 默认值一致 (commit e63d017)
    includeHistoryReasoning: true,
    models: [],
    balanceOption: { enabled: false, apiPath: "/credits", resultPath: "data.total_credits" },
  };
}

export const KIND_LABEL_KEYS: Record<ProviderKind, string> = {
  openai: "settings:providers.kind.openai",
  claude: "settings:providers.kind.claude",
  google: "settings:providers.kind.google",
};
export const PROVIDER_KINDS = Object.keys(KIND_LABEL_KEYS) as ProviderKind[];

// OpenAI 格式的两种请求协议:点「OpenAI *」分段弹出选择。未选过即 Chat Completions(useResponseApi 缺省)。
export const OPENAI_FORMATS = [
  { responseApi: false, labelKey: "settings:providers.openai_format.chat" },
  { responseApi: true, labelKey: "settings:providers.openai_format.responses" },
] as const;

/** 详情页头的格式名:OpenAI 格式落到具体协议,不显示分段上的「OpenAI *」。 */
export function providerFormatLabelKey(kind: ProviderKind, provider: ProviderProfile): string {
  if (kind !== "openai") return KIND_LABEL_KEYS[kind];
  return OPENAI_FORMATS[provider.useResponseApi === true ? 1 : 0].labelKey;
}

/** 当前格式下请求端点尾缀是否被用户改过(只有 OpenAI 格式可改)。 */
export function hasCustomEndpointPath(provider: ProviderProfile): boolean {
  if (providerKind(provider) !== "openai") return false;
  const chat = textValue(provider.chatCompletionsPath) || "/chat/completions";
  const responses = textValue(provider.responsesPath) || "/responses";
  return chat !== "/chat/completions" || responses !== "/responses";
}

export function normalizeKindPatch(provider: ProviderProfile, kind: ProviderKind): ProviderProfile {
  return {
    ...provider,
    type: kind,
    baseUrl: baseUrlForKindSwitch(provider.id, textValue(provider.baseUrl), kind),
    useResponseApi: kind === "openai" ? provider.useResponseApi === true : false,
    // chatCompletionsPath 只承载 Chat Completions 尾缀;Responses 尾缀在 responsesPath,两者不混写。
    chatCompletionsPath: defaultPathForKind(kind),
    // kind 切换时把 responsesPath 一并归位默认,避免切到 openai+ResponseAPI 时残留旧自定义路径。
    responsesPath: "/responses",
  };
}
