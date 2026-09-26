// model-providers/auth/index.ts — barrel 导出 + 判定守卫。
// 前端/后端都靠 isOAuthProvider 走「订阅供应商」分支,不直接散读 authMode/oauth 字段。
// 只导出有外部消费者的符号;模块内独占的(loadOAuthFlow/isPresetOAuthProviderId/
// OAUTH_PROVIDER_SHAPING)由各自文件直接 import,不从 barrel 绕。

import type { Provider } from "../../foundation/types";

export { createPiCredentialStore } from "./credential-store";
export { OAUTH_FLOWS, oauthFlowFor } from "./flows";
export { activeLoginEvents, cancelLogin, currentLoginEvent, initProviderAuthBroadcast, loginInProgress, logoutProvider, resumePrompt, startLogin } from "./login";
export { resolveProviderAuthForProvider } from "./resolve";
export { applyShaping, shapingFor } from "./shaping";
export { bundledModelsFor } from "./catalog";

/** 该 provider 是否为订阅制登录(authMode=oauth)。 */
export function isOAuthProvider(provider: Provider): boolean {
  return provider.authMode === "oauth";
}
