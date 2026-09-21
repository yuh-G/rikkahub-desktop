// app-config/index.ts — 应用级 UI/主题/快捷键/端口/JWT 配置切片
// 纪律：只依赖 foundation/types/settings，不依赖 server.ts 或全局 state。

import { saveState, state } from "../persistence/json-store";
import { broadcastList, broadcastSettings } from "../api/sse";
import { applyEffectiveProxy, resolveEffectiveProxy } from "../foundation/net";
import { reconcileMcpHealth } from "../tools/mcp-health";
import type { AppConfig, Settings } from "../foundation/types/settings";

export type { AppConfig } from "../foundation/types/settings";

export function selectAppConfig(settings: Settings): AppConfig {
  return {
    dynamicColor: settings.dynamicColor,
    themeId: settings.themeId,
    developerMode: settings.developerMode,
    displaySetting: settings.displaySetting,
    preferredPort: settings.preferredPort,
    workspaceLastPermissionPreset: settings.workspaceLastPermissionPreset,
    keybindings: settings.keybindings,
    webServerJwtEnabled: settings.webServerJwtEnabled,
  };
}

export function patchAppConfig(settings: Settings, patch: Partial<AppConfig>): Settings {
  return { ...settings, ...patch };
}

export function updateSettings(next: Settings) {
  // 代理配置变化时记一条日志。实际生效由 fetch 拦截器 per-request 现读 resolveEffectiveProxy 保证,
  // 无需手动刷新 env / 探测 —— 配置变化下一次请求自动跟上。
  const prevProxyUrl = resolveEffectiveProxy(state.settings.proxyConfig).url;
  state.settings = next;
  saveState();
  broadcastSettings();
  broadcastList();
  // MCP 健康 Supervisor(7.2):配置/助手选中变化后重评探活集合(新启用的服务器立即探活,
  // 禁用/取消选中的清出状态面)。reconcile 幂等且只在集合变化时探活,普通设置保存零开销。
  reconcileMcpHealth();
  const newProxyUrl = resolveEffectiveProxy(state.settings.proxyConfig).url;
  if (newProxyUrl !== prevProxyUrl) {
    applyEffectiveProxy(state.settings.proxyConfig);
  }
}
