// model-providers/auth/shaping.ts — 各订阅供应商请求整形声明(方案 §2.4)。
// 只放「声明」:每家供应商在标准协议头/body 之上的增删改,引擎按声明应用。
// 实现端只有一个解释器,新增供应商 = 加一行声明,不新增引擎分支。

export interface ProviderShaping {
  /** 需要确保存在的请求头(??= 语义:引擎/用户已显式设置则不覆盖)。 */
  ensureHeaders?: Record<string, string>;
  /** 值来自凭证字段的请求头:header 名 → OAuthCredential 字段名(??= 语义;字段缺失则不发)。
   *  Codex 的 chatgpt-account-id 即此类——pi 每请求都发,后端据此定位账号。 */
  credentialHeaders?: Record<string, string>;
  /** 需要从 body 删除的字段名(如 Codex 的 max_output_tokens)。 */
  dropBodyFields?: string[];
  /** 需要强制附加的 body 字段(如 Codex 的 include 列表)。 */
  mergeBody?: Record<string, unknown>;
  /** 该端点只收 SSE(pi/Cherry 对 Codex 均全流式):宿主的非流式出站路径(标题/建议/
   *  提示词优化等辅助调用)必须改走流式收集,直发 stream:false 会被 400。 */
  streamingOnly?: boolean;
  /** 登录后是否自动启用供应商(方案 §4.3:登录成功即 enabled=true)。 */
  autoEnable?: boolean;
}

export const OAUTH_PROVIDER_SHAPING: Record<string, ProviderShaping> = {
  // Codex 后端:走 Responses API 实验通道,按官方客户端同款契约整形。
  "openai-codex": {
    ensureHeaders: {
      "OpenAI-Beta": "responses=experimental",
      originator: "rikkahub",
    },
    // pi openai-codex-responses.ts buildBaseCodexHeaders 同款:账号 id 来自登录时写进凭证的
    // accountId(pi 从 access JWT 的 chatgpt_account_id 声明提取)。
    credentialHeaders: { "chatgpt-account-id": "accountId" },
    dropBodyFields: ["max_output_tokens"],
    mergeBody: { include: ["reasoning.encrypted_content"] },
    streamingOnly: true,
    autoEnable: true,
  },
  // Kimi Coding:Anthropic 协议,Authorization: Bearer 而非 x-api-key。
  "kimi-coding": {
    autoEnable: true,
  },
  "github-copilot": { autoEnable: true },
  xai: { autoEnable: true },
  anthropic: { autoEnable: true },
};

export function shapingFor(flowId: string): ProviderShaping {
  return OAUTH_PROVIDER_SHAPING[flowId] ?? {};
}

/** 把声明应用到请求头与 body。headers 用 ??= 语义(用户/引擎显式设置的优先),
 *  body 字段直接增删。调用时机:body 定稿后、applyCustomBody 前。
 *  credential = 该供应商当前的 oauth.credential(凭证派生头用;apiKey 轨不传)。 */
export function applyShaping(
  flowId: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  credential?: Record<string, unknown> | null,
): void {
  const shaping = shapingFor(flowId);
  if (shaping.ensureHeaders) {
    for (const [key, value] of Object.entries(shaping.ensureHeaders)) {
      headers[key] ??= value;
    }
  }
  if (shaping.credentialHeaders && credential) {
    for (const [header, field] of Object.entries(shaping.credentialHeaders)) {
      const value = credential[field];
      if (typeof value === "string" && value) headers[header] ??= value;
    }
  }
  if (shaping.dropBodyFields) {
    for (const field of shaping.dropBodyFields) {
      delete body[field];
    }
  }
  if (shaping.mergeBody) {
    for (const [key, value] of Object.entries(shaping.mergeBody)) {
      // include 等数组字段:与已有数组合并去重,不覆盖。
      if (Array.isArray(value) && Array.isArray(body[key])) {
        body[key] = [...new Set([...(body[key] as unknown[]), ...value])];
      } else {
        body[key] ??= value;
      }
    }
  }
}
