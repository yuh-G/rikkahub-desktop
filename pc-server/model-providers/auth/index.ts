// model-providers/auth/index.ts — barrel 导出 + 判定守卫。
// 前端/后端都靠这两个谓词走「订阅供应商」分支,不直接散读 authMode/oauth 字段。

import type { Provider } from "../../foundation/types";

export { createPiCredentialStore } from "./credential-store";
export { loadOAuthFlow, OAUTH_FLOWS } from "./flows";
export { cancelLogin, initProviderAuthBroadcast, loginInProgress, logoutProvider, resumePrompt, startLogin } from "./login";
export { resolveProviderAuthForProvider } from "./resolve";
export { OAUTH_PROVIDER_SHAPING, applyShaping, shapingFor } from "./shaping";
export { bundledModelsFor } from "./catalog";

/** 该 provider 是否为订阅制登录(authMode=oauth)。 */
export function isOAuthProvider(provider: Provider): boolean {
  return provider.authMode === "oauth";
}

/** 该 provider 当前是否有可用凭据(apiKey 非空 或 oauth 已登录)。前端/引擎的启用闸门。 */
export function hasUsableCredential(provider: Provider): boolean {
  if (isOAuthProvider(provider)) return provider.oauth != null;
  return typeof provider.apiKey === "string" && provider.apiKey.trim() !== "";
}
