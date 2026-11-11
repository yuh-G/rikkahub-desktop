// engines/model-grant.ts — 生效 provider/模型 → 契约 ModelGrant(应用侧组装,方案 §5.8)
//
// 引擎只翻译不加工,数值与请求头在这里一次定终值:
// - 上限:contextWindowFor(models.dev 真实窗口,查不到为 null,引擎用自己的保守默认)与
//   requiredOutputCap(单源四级,与聊天引擎 Claude 分支同一个函数)。
// - 请求头:applyModelRequestHeaders(供应商/模型自定义头 + 主机特例 + 会话身份头),
//   与聊天引擎同一个汇聚函数。
// - 凭据:API Key 直接给;订阅登录只给流程标识与登录状态,令牌由引擎经 host.models.credential 取。
// 传入的 provider 必须是生效 provider(findModel 已展开 providerOverwrite)。

import type { Assistant, Model, Provider } from "../foundation/types";
import { modelsDevCache } from "../inference-engine/providers";
import { applyModelRequestHeaders } from "../model-providers";
import { isOAuthProvider, oauthFlowFor } from "../model-providers/auth";
import { contextWindowFor, requiredOutputCap } from "../model-providers/model-limits";
import type { ModelGrant, ModelProtocol } from "./contract";

const DEFAULT_COMPLETIONS_PATH = "/chat/completions";

function protocolFor(provider: Provider): ModelProtocol | null {
  if (provider.type === "claude") return "anthropic-messages";
  if (provider.type === "google") return "google-generative-ai";
  if (provider.type === "openai") return provider.useResponseApi ? "openai-responses" : "openai-completions";
  return null;
}

/** null = provider 类型不在已知协议之内(状态损坏时的防御面,正常配置不可达)。
 *  assistant 提供用户配置的 maxTokens;不传(测试/冒烟)只按目录与兜底定上限。
 *  conversationId 进会话身份头,缺省兜底随机 UUID(applySessionHeaders 语义)。 */
export function modelGrantFor(
  provider: Provider,
  model: Model,
  assistant?: Pick<Assistant, "maxTokens"> | null,
  conversationId?: string,
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
  };
}
