// lib/approval-notification.ts — 域4-1(专题-交互审查 2A):审批等待桌面通知。
//
// 触发链:审批挂起 → 后端 approval-flow 发 engine_status(awaiting_approval)帧 →
// conversation-store.engineStatus 记录该会话 → 本模块订阅其跳变。仅当满足全部条件才发
// 系统通知:进入等待(busy:false→awaiting_approval 跳变)且窗口失焦/最小化/隐藏——
// 用户正盯着会话时审批卡就在眼前,发通知是打扰。点击通知聚焦主窗口。
//
// 环境:Tauri 桌面走 plugin-notification(原生 toast,可点击聚焦);浏览器兜底 Web
// Notification API(需授权,拒绝则静默跳过——通知是增强不是必需)。非 Tauri 且 Web
// 通知不可用时整体不动作,功能降级为仅靠侧栏/标签琥珀态点外显。
//
// 防重复:startedAt 是去重键——同一次审批等待(SSE 重连补发的快照帧 startedAt 不变)
// 只通知一次;新一次等待(startedAt 变)才再次评估。
import * as React from "react";

import { pluginDisplayName } from "~/components/settings/extensions/plugins/model";
import i18n from "~/i18n";
import { useAppStore } from "~/stores/app-store";
import { useConversationStore } from "~/stores/conversation-store";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 聚焦主窗口(通知点击/兜底):显示 → 取消最小化 → 聚焦。 */
async function focusMainWindow(): Promise<void> {
  if (!isTauri()) {
    window.focus();
    return;
  }
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.show();
    if (await win.isMinimized()) await win.unminimize();
    await win.setFocus();
  } catch {
    // 窗口聚焦失败不阻断通知主流程(尽力而为)。
  }
}

/** 窗口是否处于"用户看不到审批卡"的状态(失焦/最小化/页面隐藏)。 */
async function windowNotVisible(): Promise<boolean> {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return true;
  if (!isTauri()) return !document.hasFocus();
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    if (await win.isMinimized()) return true;
    return !(await win.isFocused());
  } catch {
    return !document.hasFocus();
  }
}

/** 发一条"等待审批"系统通知。title/body 已本地化;点击聚焦主窗口。 */
async function sendApprovalNotification(title: string, body: string): Promise<void> {
  if (isTauri()) {
    try {
      const notification = await import("@tauri-apps/plugin-notification");
      let granted = await notification.isPermissionGranted();
      if (!granted) {
        granted = (await notification.requestPermission()) === "granted";
      }
      if (!granted) return;
      // Tauri 通知无前端点击回调通道——点击行为由 plugin 配置/系统默认(聚焦 app)。
      // 前置一次 focus 订阅不可行,故点击聚焦依赖系统默认激活;Windows toast 点击默认
      // 唤起应用窗口,满足"点击回来审批"的核心诉求。
      notification.sendNotification({ title, body });
    } catch {
      // 插件未注册/旧版本壳:静默降级(审批外显仍有琥珀态点兜底)。
    }
    return;
  }
  // 浏览器兜底:Web Notification。授权被拒/不支持时静默跳过。
  if (typeof Notification === "undefined") return;
  try {
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission !== "granted") return;
    const n = new Notification(title, { body, tag: "rikkahub-awaiting-approval" });
    n.onclick = () => {
      void focusMainWindow();
      n.close();
    };
  } catch {
    // 浏览器通知构造失败(部分环境需用户手势):静默降级。
  }
}

/** AppContent 挂载一次:订阅 engineStatus,审批等待出现且窗口不可见时发桌面通知。 */
export function useApprovalNotifications(): void {
  React.useEffect(() => {
    let disposed = false;
    // 已通知的"会话:startedAt"键——同一次等待不重复打扰。
    const notified = new Set<string>();
    const unsubscribe = useConversationStore.subscribe((state, prev) => {
      if (disposed) return;
      const current = state.engineStatus;
      if (current === prev.engineStatus) return;
      for (const [id, status] of Object.entries(current)) {
        if (status.phase !== "awaiting_approval") continue;
        const key = `${id}:${status.startedAt}`;
        if (notified.has(key)) continue;
        notified.add(key);
        void (async () => {
          if (!(await windowNotVisible())) return;
          const conversationTitle =
            useConversationStore.getState().entries[id]?.detail?.title?.trim() || "";
          // 等的是插件的对话框(P6.3):标题写哪个插件在等,正文是对话框标题。
          const plugin = status.dialog?.source
            ? pluginDisplayName(useAppStore.getState().settings?.enginePlugins, status.dialog.source)
            : "";
          const title = status.dialog
            ? plugin
              ? i18n.t("page:conversations.awaiting_approval.plugin_status", { plugin })
              : i18n.t("page:conversations.awaiting_approval.plugin_status_unknown")
            : i18n.t("page:conversations.awaiting_approval.notification_title");
          const bodyParts = [
            conversationTitle,
            status.summary
              ? status.dialog
                ? i18n.t("page:conversations.awaiting_approval.plugin_notification_body", { summary: status.summary })
                : i18n.t("page:conversations.awaiting_approval.notification_body", { summary: status.summary })
              : null,
          ].filter(Boolean);
          await sendApprovalNotification(title, bodyParts.join(" · "));
        })();
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
}
