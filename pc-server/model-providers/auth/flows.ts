// model-providers/auth/flows.ts — OAuth flow 登记表(方案 §2.4)。
// 唯一触碰 pi-ai auth 协议层(load/resolve 及各 flow 实现)的宿主模块:其余文件只面向
// 这里的声明式元数据。新增订阅供应商 = 在 OAUTH_FLOWS 登记一行 + shaping/catalog 补声明。

import type { OAuthCredential } from "../../../pi/packages/ai/src/auth/types.ts";
import type { OAuthFlowId, Provider } from "../../foundation/types";

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
  /** pi-ai 内置 provider id(resolveProviderAuth / 内置模型目录 / pi 引擎模型身份用)。 */
  piProviderId: string;
  /** 宿主预置订阅供应商的固定 UUID——一经发布不可改(老用户 state/备份引用它)。
   *  是「宿主 provider 行 ↔ flow」在未登录(尚无 oauth 行)时的唯一反查键:登录起流、
   *  pi 引擎取内建身份、restore 端点判定都经 oauthFlowFor 走这里,不得在别处复制表。 */
  presetProviderId: string;
  /** 是否可进对话引擎(缺省 true)。Claude Pro/Max 的凭证要求 Claude Code 全套伪装
   *  (pi api/anthropic-messages.ts 内建),宿主聊天引擎不接:resolve 处闸门拦宿主全路径,
   *  前端据此隐藏聊天选择器入口、登录卡挂「仅工作区 + 合规」提示。 */
  chatCapable?: boolean;
}

export const OAUTH_FLOWS: Record<OAuthFlowId, OAuthFlowMeta> = {
  "openai-codex": {
    id: "openai-codex",
    loader: "loadOpenAICodexOAuth",
    loginMethods: [
      { id: "browser", labelKey: "settings:providers.oauth.method.browser" },
      { id: "device_code", labelKey: "settings:providers.oauth.method.device_code" },
    ],
    piProviderId: "openai-codex",
    presetProviderId: "98d0557b-0700-41e5-b1d6-ee875a53ae5a", // ChatGPT(Codex 订阅)
  },
  "kimi-coding": {
    id: "kimi-coding",
    loader: "loadKimiCodingOAuth",
    loginMethods: null,
    piProviderId: "kimi-coding",
    presetProviderId: "f9622c8b-5037-4540-b875-3d301521367b", // Kimi Code
  },
  "github-copilot": {
    id: "github-copilot",
    loader: "loadGitHubCopilotOAuth",
    loginMethods: null,
    piProviderId: "github-copilot",
    presetProviderId: "55bff930-76fb-47e4-a19c-6b48e201bf48", // P2
  },
  xai: {
    id: "xai",
    loader: "loadXaiOAuth",
    loginMethods: null,
    piProviderId: "xai",
    presetProviderId: "5ec4bda4-5511-4e86-9c3f-b08d37d23dc1", // xAI SuperGrok,P2
  },
  anthropic: {
    id: "anthropic",
    loader: "loadAnthropicOAuth",
    loginMethods: null,
    piProviderId: "anthropic",
    presetProviderId: "d4f86913-80d5-45e4-84ea-3e652ac63cda", // Claude Pro/Max,P3(仅工作区)
    chatCapable: false,
  },
};

/** 宿主 provider 行 → 所属 OAuth flow。已登录的行以 oauth.flow 为准;未登录的预置订阅
 *  供应商(还没有 oauth 行)按固定 UUID 反查。非订阅供应商返回 undefined。 */
export function oauthFlowFor(provider: Pick<Provider, "id" | "oauth">): OAuthFlowMeta | undefined {
  const byRow = provider.oauth?.flow ? OAUTH_FLOWS[provider.oauth.flow] : undefined;
  if (byRow) return byRow;
  return Object.values(OAUTH_FLOWS).find((flow) => flow.presetProviderId === provider.id);
}

/** 该 id 是否为预置订阅供应商的固定 UUID。 */
export function isPresetOAuthProviderId(providerId: string): boolean {
  return Object.values(OAUTH_FLOWS).some((flow) => flow.presetProviderId === providerId);
}

const cache = new Map<OAuthFlowId, Promise<PiOAuthAuth>>();

/** 测试注入点:替换 flow 的 pi-ai 实现(如锁 toAuth 不触网)。生产代码不调。 */
export function overrideOAuthFlow(flowId: OAuthFlowId, impl: PiOAuthAuth): void {
  cache.set(flowId, Promise.resolve(impl));
}

/** 清除测试注入,恢复懒加载真实实现。生产代码不调。 */
export function clearOAuthFlowOverride(flowId: OAuthFlowId): void {
  cache.delete(flowId);
}

// 静态 import 所有 loader 与实现文件——bun --compile 只能打包静态引用。
// pi 的 load.ts 已预留 registerBundledOAuthFlowLoaders 接口给 standalone 二进制使用。
import {
  loadOpenAICodexOAuth,
  loadKimiCodingOAuth,
  loadGitHubCopilotOAuth,
  loadXaiOAuth,
  loadAnthropicOAuth,
  registerBundledOAuthFlowLoaders,
} from "../../../pi/packages/ai/src/auth/oauth/load.ts";
import { openaiCodexOAuth } from "../../../pi/packages/ai/src/auth/oauth/openai-codex.ts";
import { kimiCodingOAuth } from "../../../pi/packages/ai/src/auth/oauth/kimi-coding.ts";
import { githubCopilotOAuth } from "../../../pi/packages/ai/src/auth/oauth/github-copilot.ts";
import { xaiOAuth } from "../../../pi/packages/ai/src/auth/oauth/xai.ts";
import { anthropicOAuth } from "../../../pi/packages/ai/src/auth/oauth/anthropic.ts";

// Bun standalone 模式(编译为 exe)下注册静态打包的 oauth 实现,绕过 load.ts 的动态 import。
if (Bun.isStandaloneExecutable) {
  registerBundledOAuthFlowLoaders({
    openaiCodex: () => openaiCodexOAuth,
    kimiCoding: () => kimiCodingOAuth,
    githubCopilot: () => githubCopilotOAuth,
    xai: () => xaiOAuth,
    anthropic: () => anthropicOAuth,
    openrouter: () => {
      throw new Error("OpenRouter OAuth not implemented in this build");
    },
    radius: () => {
      throw new Error("Radius OAuth not implemented in this build");
    },
  });
}

const loaderRegistry = {
  loadOpenAICodexOAuth,
  loadKimiCodingOAuth,
  loadGitHubCopilotOAuth,
  loadXaiOAuth,
  loadAnthropicOAuth,
} as const;

/** 懒加载 flow 的 pi-ai OAuthAuth 实现(首次调用时执行 loader,结果缓存)。 */
export function loadOAuthFlow(flowId: OAuthFlowId): Promise<PiOAuthAuth> {
  let cached = cache.get(flowId);
  if (!cached) {
    const loaderName = OAUTH_FLOWS[flowId].loader;
    const loader = loaderRegistry[loaderName];
    if (!loader) throw new Error(`pi-ai OAuth loader missing: ${loaderName}`);
    cached = loader();
    cache.set(flowId, cached);
  }
  return cached;
}
