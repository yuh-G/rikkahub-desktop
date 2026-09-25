// model-providers/auth/resolve.ts — 引擎/辅助调用统一取凭证入口(方案 §2.4)。
// 双轨:
//   apiKey 供应商 → providerHeaders(),与聊天引擎既有行为逐字节一致(不引入任何新口径);
//   oauth 供应商  → pi-ai resolveProviderAuth(读-改-写锁内刷新,5min 窗口) + toAuth,
//                   产出归一成 { headers, baseUrl } 供各引擎注入。
// 这是「刷新权唯一在核心」的落地:引擎永不自己刷新,只拿短命 access。

import { resolveProviderAuth } from "../../../pi/packages/ai/src/auth/resolve.ts";
import type { Provider } from "../../foundation/types";
import { providerHeaders } from "../index";
import { createPiCredentialStore } from "./credential-store";
import { OAUTH_FLOWS, loadOAuthFlow } from "./flows";

export interface ResolvedProviderAuth {
  /** 引擎注入用:apiKey 轨返回 providerHeaders() 原样;oauth 轨返回 toAuth 的
   *  {apiKey|headers} 归一成扁平 headers(Authorization: Bearer ... 或 x-api-key 等)。 */
  headers: Record<string, string>;
  /** toAuth 可能携带 per-credential baseUrl(如 Copilot)。仅 oauth 轨可能返回。 */
  baseUrl?: string;
  /** 登录账号标识(Codex 的 chatgpt_account_id 等),供 shaping/日志。 */
  accountId?: string;
}

const ambientEnv = {
  env: async (name: string) => process.env[name],
  fileExists: async (path: string) => {
    try {
      const { existsSync } = await import("node:fs");
      return existsSync(path.replace(/^~(?=$|\/|\\)/, process.env.USERPROFILE ?? process.env.HOME ?? "~"));
    } catch {
      return false;
    }
  },
};

export async function resolveProviderAuthForProvider(
  provider: Provider,
  opts?: { signal?: AbortSignal; minOAuthValidityMs?: number },
): Promise<ResolvedProviderAuth> {
  if (provider.authMode !== "oauth" || !provider.oauth) {
    return { headers: providerHeaders(provider) };
  }

  const flow = OAUTH_FLOWS[provider.oauth.flow];
  if (!flow) throw new Error(`OAuth flow not registered: ${provider.oauth.flow}`);
  // 仅工作区的订阅(chatCapable:false,Claude Pro/Max)在宿主全路径(对话/辅助/图像/
  // 连通性测试——它们的凭证都经本函数)统一拦下:它的凭证要求 Claude Code 全套伪装头
  // 与系统提示词首块(pi api/anthropic-messages.ts 内建),宿主引擎发裸请求必被上游拒绝。
  // pi 引擎经 createPiCredentialStore 直取凭证、不经过本函数,工作区不受影响。
  if (flow.chatCapable === false) {
    throw new Error("Claude 订阅(Claude Pro/Max)仅在工作区可用,不接入对话模型。请在工作区任务中使用该供应商的模型。");
  }
  const oauth = await loadOAuthFlow(flow.id);

  const result = await resolveProviderAuth(
    { id: flow.piProviderId, auth: { oauth } },
    createPiCredentialStore(),
    ambientEnv,
    { signal: opts?.signal, minOAuthValidityMs: opts?.minOAuthValidityMs },
  );

  if (!result) throw new Error(`OAuth credential unavailable for ${provider.id}`);
  const headers: Record<string, string> = {};
  if (result.auth.headers) {
    for (const [key, value] of Object.entries(result.auth.headers)) {
      if (typeof value === "string") headers[key] = value;
    }
  }
  if (result.auth.apiKey && !headers.Authorization) headers.Authorization = `Bearer ${result.auth.apiKey}`;
  return {
    headers,
    baseUrl: result.auth.baseUrl,
    accountId: typeof (result as { accountId?: unknown }).accountId === "string" ? (result as { accountId?: string }).accountId : undefined,
  };
}
