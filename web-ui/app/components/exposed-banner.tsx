// components/exposed-banner.tsx — 对外暴露无密码警示横幅(P1,2026-09-19)
//
// Docker/反代把服务暴露到本机之外时,若未设访问密码,同网络任何人都能读全部会话与 API Key
// (容器默认绑 0.0.0.0,server.ts)。唯一旧提示是容器日志里一条没人看的 warn。这里在 UI 顶部
// 弹醒目横幅把风险摆到用户面前,附「去设置密码」直达。
//
// 显示判据(克制,不误伤桌面/localhost 用户):
//   - 未启用鉴权(web-auth/status.enabled === false),且
//   - 当前是非安全上下文(http 裸 IP)或 hostname 非 localhost —— 即服务确可被本机之外访问。
// localhost + HTTPS/桌面形态不弹。可本次会话关闭(不重弹),不写入持久偏好——风险仍在,
// 不该让用户「永久忽略」。

import * as React from "react";
import { TriangleAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { fetchWebAuthStatus } from "~/services/api";
import { Button } from "~/components/ui/button";

function isLocalhostHost(): boolean {
  if (typeof window === "undefined") return true;
  const host = window.location.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** 服务是否可能被本机之外访问:非安全上下文(http 裸 IP)或 hostname 已是局域网/公网地址。 */
function isPotentiallyExposed(): boolean {
  if (typeof window === "undefined") return false;
  return window.isSecureContext === false || !isLocalhostHost();
}

export function ExposedBanner() {
  const { t } = useTranslation();
  const [visible, setVisible] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);

  React.useEffect(() => {
    if (!isPotentiallyExposed()) return;
    let cancelled = false;
    fetchWebAuthStatus()
      .then((status) => {
        if (!cancelled && !status.enabled) setVisible(true);
      })
      .catch(() => {
        // 探测失败(网络抖动等)→ 不弹,宁缺毋滥;风险横幅不该误报。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!visible || dismissed) return null;

  return (
    <div className="flex items-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
      <TriangleAlert className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{t("exposed_banner.message")}</span>
      <Button asChild size="sm" variant="outline" className="shrink-0">
        <Link to="/settings">{t("exposed_banner.action")}</Link>
      </Button>
      <button
        type="button"
        aria-label={t("exposed_banner.dismiss")}
        title={t("exposed_banner.dismiss")}
        className="shrink-0 rounded p-1 hover:bg-amber-200/60 dark:hover:bg-amber-900/60"
        onClick={() => setDismissed(true)}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
