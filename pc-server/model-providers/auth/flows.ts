// model-providers/auth/flows.ts — OAuth flow 登记表(方案 §2.4)。
// 唯一触碰 pi-ai auth 协议层(load/resolve 及各 flow 实现)的宿主模块:其余文件只面向
// 这里的声明式元数据。新增订阅供应商 = 在 OAUTH_FLOWS 登记一行 + shaping/catalog 补声明。

import type { OAuthCredential } from "../../../pi/packages/ai/src/auth/types.ts";
import type { OAuthFlowId } from "../../foundation/types";

export type PiOAuthAuth = {
  name: string;
  isSubscription?: boolean;
  loginLabel?: string;
  login(interaction: any): Promise<OAuthCredential>;
  refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential>;
  toAuth(credential: OAuthCredential): Promise<{ apiKey?: string; headers?: Record<string, string>; baseUrl?: string }>;
};

export interface OAuthFlowMeta {
  id: OAuthFlowId;
  /** pi-ai load.ts 中对应的 loader 函数名。 */
  loader: "loadOpenAICodexOAuth" | "loadKimiCodingOAuth" | "loadGitHubCopilotOAuth" | "loadXaiOAuth" | "loadAnthropicOAuth";
  /** 登录方式:null = 直接走流程(如 Kimi 仅设备码);数组 = 先经 select 提示让用户选。 */
  loginMethods: ReadonlyArray<{ id: string; labelKey: string }> | null;
  /** pi-ai 内置 provider id(resolveProviderAuth / 内置模型目录用)。 */
  piProviderId: string;
}

export const OAUTH_FLOWS: Record<OAuthFlowId, OAuthFlowMeta> = {
  "openai-codex": {
    id: "openai-codex",
    loader: "loadOpenAICodexOAuth",
    loginMethods: [
      { id: "browser", labelKey: "providers:oauth.method.browser" },
      { id: "device_code", labelKey: "providers:oauth.method.device_code" },
    ],
    piProviderId: "openai-codex",
  },
  "kimi-coding": {
    id: "kimi-coding",
    loader: "loadKimiCodingOAuth",
    loginMethods: null,
    piProviderId: "kimi-coding",
  },
  "github-copilot": {
    id: "github-copilot",
    loader: "loadGitHubCopilotOAuth",
    loginMethods: null,
    piProviderId: "github-copilot",
  },
  xai: { id: "xai", loader: "loadXaiOAuth", loginMethods: null, piProviderId: "xai" },
  anthropic: { id: "anthropic", loader: "loadAnthropicOAuth", loginMethods: null, piProviderId: "anthropic" },
};

const cache = new Map<OAuthFlowId, Promise<PiOAuthAuth>>();

/** 懒加载 flow 的 pi-ai OAuthAuth 实现(动态 import 经变量 specifier,bundler 不可静态
 *  跟进——openai-codex.ts 用 node:http/node:crypto,顶层 import 会炸浏览器构建)。 */
export function loadOAuthFlow(flowId: OAuthFlowId): Promise<PiOAuthAuth> {
  let cached = cache.get(flowId);
  if (!cached) {
    cached = (async () => {
      const mod = (await import("../../../pi/packages/ai/src/auth/oauth/load.ts")) as unknown as Record<
        string,
        () => Promise<PiOAuthAuth>
      >;
      const loader = mod[OAUTH_FLOWS[flowId].loader];
      if (!loader) throw new Error(`pi-ai OAuth loader missing: ${OAUTH_FLOWS[flowId].loader}`);
      return loader();
    })();
    cache.set(flowId, cached);
  }
  return cached;
}
