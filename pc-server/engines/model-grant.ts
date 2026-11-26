// engines/model-grant.ts — 生效 provider/模型 → 契约 ModelGrant(应用侧组装,方案 §5.8)
//
// 引擎只翻译不加工,数值与请求头在这里一次定终值:
// - 上限:contextWindowFor(models.dev 真实窗口,查不到为 null,引擎用自己的保守默认)与
//   requiredOutputCap(单源四级,与聊天引擎 Claude 分支同一个函数)。
// - 请求头:applyModelRequestHeaders(供应商/模型自定义头 + 主机特例 + 会话身份头),
//   与聊天引擎同一个汇聚函数。
// - 凭据:API Key 直接给;订阅登录只给流程标识与登录状态,令牌由引擎经 host.models.credential 取。
// - 提示缓存:由供应商设置决定(promptCachePolicyFor),引擎只翻译。
// - User-Agent:调用方传生效 UA(resolveUserAgent(代理设置),与全局 fetch 壳同一口径);缺省品牌默认。
// 传入的 provider 必须是生效 provider(findModel 已展开 providerOverwrite)。

import type { Assistant, Model, Provider } from "../foundation/types";
import { getDefaultUserAgent } from "../foundation/net";
import { modelsDevCache } from "../inference-engine/providers";
import { applyModelRequestHeaders } from "../model-providers";
import { isOAuthProvider, oauthFlowFor } from "../model-providers/auth";
import { contextWindowFor, requiredOutputCap } from "../model-providers/model-limits";
import { claudePromptCacheWarmingEnabled, claudePromptCachingEnabled } from "../model-providers/prompt-cache-defaults";
import type { ModelGrant, ModelProtocol, PromptCachePolicy } from "./contract";

const DEFAULT_COMPLETIONS_PATH = "/chat/completions";

function protocolFor(provider: Provider): ModelProtocol | null {
  if (provider.type === "claude") return "anthropic-messages";
  if (provider.type === "google") return "google-generative-ai";
  if (provider.type === "openai") return provider.useResponseApi ? "openai-responses" : "openai-completions";
  return null;
}

/** 读的是聊天引擎请求构建读的同几个字段(promptCaching 经 claudePromptCachingEnabled 取生效值/promptCacheTtl/
 *  promptCacheKey),所以同一个开关对两个引擎含义一致。
 *  订阅登录行恒开、保留期取服务端默认:设置页对它们不显示缓存开关,字段从未被用户写过,
 *  照字面读会把订阅端点判成关;这些通道的缓存形态由引擎侧的内建供应商定义维护。
 *  google 没有缓存开关,恒关。
 *  预热(§5.17.3)只看「缓存预热」的生效值,资格(API Key 的 Claude 格式、Claude 订阅)在默认值模块里判;
 *  API Key 行缓存关着就不预热(没有缓存可续)。 */
export function promptCachePolicyFor(provider: Provider): PromptCachePolicy {
  if (isOAuthProvider(provider)) {
    return { enabled: true, retention: "short", warming: claudePromptCacheWarmingEnabled(provider, oauthFlowFor(provider)?.id) };
  }
  if (provider.type === "claude") {
    const enabled = claudePromptCachingEnabled(provider);
    return {
      enabled,
      retention: provider.promptCacheTtl === "1h" ? "long" : "short",
      warming: enabled && claudePromptCacheWarmingEnabled(provider),
    };
  }
  if (provider.type === "openai") return { enabled: provider.promptCacheKey === true, retention: "short", warming: false };
  return { enabled: false, retention: "short", warming: false };
}

/** null = provider 类型不在已知协议之内(状态损坏时的防御面,正常配置不可达)。
 *  assistant 提供用户配置的 maxTokens;不传(测试/冒烟)只按目录与兜底定上限。
 *  conversationId 进会话身份头,缺省兜底随机 UUID(applySessionHeaders 语义)。
 *  userAgent 是生效 UA(生产由编排器按当前代理设置解析);不传 = 品牌默认(测试/冒烟)。 */
export function modelGrantFor(
  provider: Provider,
  model: Model,
  assistant?: Pick<Assistant, "maxTokens"> | null,
  conversationId?: string,
  userAgent?: string,
): ModelGrant | null {
  const protocol = protocolFor(provider);
  if (!protocol) return null;
  const completionsPath = provider.chatCompletionsPath || DEFAULT_COMPLETIONS_PATH;
  const headers: Record<string, string> = {};
  applyModelRequestHeaders(headers, provider, model, conversationId);
  return {
    providerId: provider.id,
    providerName: provider.name,
    protocol,
    ...(protocol === "openai-completions" && completionsPath !== DEFAULT_COMPLETIONS_PATH ? { completionsPath } : {}),
    baseUrl: provider.baseUrl,
    modelId: model.modelId,
    displayName: model.displayName,
    reasoning: model.abilities.includes("REASONING"),
    imageInput: model.inputModalities.includes("IMAGE"),
    limits: {
      contextWindow: contextWindowFor(modelsDevCache, provider, model.modelId),
      maxTokens: requiredOutputCap(modelsDevCache, provider, model.modelId, assistant?.maxTokens),
    },
    headers,
    credential: isOAuthProvider(provider)
      ? { kind: "subscription", flow: oauthFlowFor(provider)?.id ?? null, signedIn: provider.oauth != null }
      : { kind: "api-key", apiKey: provider.apiKey },
    promptCache: promptCachePolicyFor(provider),
    userAgent: userAgent ?? getDefaultUserAgent(),
  };
}
