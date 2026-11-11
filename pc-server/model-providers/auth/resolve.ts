// model-providers/auth/resolve.ts — 引擎/辅助调用统一取凭证入口(方案 §2.4)。
// 双轨:
//   apiKey 供应商 → providerHeaders(),与聊天引擎既有行为逐字节一致(不引入任何新口径);
//   oauth 供应商  → pi-ai resolveProviderAuth(读-改-写锁内刷新,5min 窗口) + toAuth,
//                   产出归一成 { headers, baseUrl } 供各引擎注入。
// 这是「刷新权唯一在核心」的落地:引擎永不自己刷新,只拿短命 access。

import { defaultProviderAuthContext } from "../../../pi/packages/ai/src/auth/context.ts";
import { refreshStoredOAuthCredential, resolveProviderAuth } from "../../../pi/packages/ai/src/auth/resolve.ts";
import type { OAuthAuth, OAuthCredential } from "../../../pi/packages/ai/src/auth/types.ts";
import type { Provider } from "../../foundation/types";
import { providerHeaders } from "../index";
import { createPiCredentialStore } from "./credential-store";
import { OAUTH_FLOWS, loadOAuthFlow, oauthFlowFor } from "./flows";

export interface ResolvedProviderAuth {
  /** 引擎注入用:apiKey 轨返回 providerHeaders() 原样;oauth 轨返回 toAuth 的
   *  {apiKey|headers} 归一成扁平 headers(Authorization: Bearer ... 或 x-api-key 等)。 */
  headers: Record<string, string>;
  /** toAuth 可能携带 per-credential baseUrl(如 Copilot)。仅 oauth 轨可能返回。 */
  baseUrl?: string;
  /** 登录账号标识(Codex 的 chatgpt_account_id 等),供 shaping/日志。 */
  accountId?: string;
}

// 环境/文件探测上下文复用 pi 的 defaultProviderAuthContext():不重抄一份,避免空串环境变量
// 过滤与 ~ 展开(os.homedir)等语义随上游演进时宿主副本悄悄漂移。该 context 只服务 oauth 轨的
// apiKey 型凭据解析(env 引用),oauth 凭据自身不经它。
const ambientEnv = defaultProviderAuthContext();

export async function resolveProviderAuthForProvider(
  provider: Provider,
  opts?: { signal?: AbortSignal; minOAuthValidityMs?: number },
): Promise<ResolvedProviderAuth> {
  if (provider.authMode !== "oauth" || !provider.oauth) {
    // 订阅供应商已登出(oauth 行被剥)却仍被宿主路径选中:不能落回 providerHeaders()
    // 轨——那会拿空 apiKey 拼出裸 `Authorization: Bearer`(把"重新登录"的信号伪装成
    // "上游 401 鉴权失败",上游 400/401 文案各异且不进分类链)。快速失败,错误形态
    // 归 classifyOAuthCredentialError(「请重新登录」)。apiKey 供应商恒走原轨。
    if (provider.authMode === "oauth" && oauthFlowFor(provider)) {
      throw new Error(`OAuth credential unavailable for ${provider.id}`);
    }
    return { headers: providerHeaders(provider) };
  }

  const flow = OAUTH_FLOWS[provider.oauth.flow];
  if (!flow) throw new Error(`OAuth flow not registered: ${provider.oauth.flow}`);
  // 仅工作区的订阅(chatCapable:false,Claude Pro/Max)在宿主全路径(对话/辅助/图像/
  // 连通性测试——它们的凭证都经本函数)统一拦下:它的凭证要求 Claude Code 全套伪装头
  // 与系统提示词首块(pi api/anthropic-messages.ts 内建),宿主引擎发裸请求必被上游拒绝。
  // 工作区引擎经 freshSubscriptionCredential 取令牌、不经过本函数,工作区不受影响。
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

const OAUTH_MIN_VALIDITY_MS = 5 * 60 * 1000;

/** 引擎取订阅令牌的应用侧实现(契约 host.models.credential):剩余有效期不足
 *  max(5 分钟, minValidityMs) 时在应用侧锁内刷新(pi refreshStoredOAuthCredential,跑在
 *  createPiCredentialStore 的串行队列上,与聊天轨同一把锁),返回原样凭据。
 *  不设 chatCapable 闸门:取令牌的只有工作区引擎,Claude Pro/Max 正是为它登录的。
 *  错误文案沿用 pi/宿主既有形态(OAuth refresh failed / credential unavailable),
 *  classifyOAuthCredentialError 照常归类为「请重新登录」。 */
export async function freshSubscriptionCredential(
  provider: Provider,
  opts?: { minValidityMs?: number },
): Promise<OAuthCredential> {
  const flow = provider.oauth ? OAUTH_FLOWS[provider.oauth.flow] : undefined;
  if (!flow) throw new Error(`OAuth credential unavailable for ${provider.id}`);
  const store = createPiCredentialStore();
  const minimum = Math.max(OAUTH_MIN_VALIDITY_MS, opts?.minValidityMs ?? 0);
  const expiresSoon = (credential: OAuthCredential) => Date.now() + minimum >= credential.expires;
  const stored = await store.read(flow.piProviderId);
  if (!stored) throw new Error(`OAuth credential unavailable for ${provider.id}`);
  if (!expiresSoon(stored)) return stored;
  const oauth = await loadOAuthFlow(flow.id);
  // 取消只作用于等锁(pi 语义:刷新一旦开始就不可中断,否则可能丢掉唯一有效的 refresh token)。
  const refreshed = await refreshStoredOAuthCredential(
    store,
    flow.piProviderId,
    oauth as unknown as OAuthAuth,
    expiresSoon,
    new AbortController().signal,
  );
  if (!refreshed) throw new Error(`OAuth credential unavailable for ${provider.id}`);
  return refreshed;
}
