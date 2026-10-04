// components/settings/data/web-service.tsx — 数据管理 › Web 服务:访问密码。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Notice } from "~/components/ui/notice";
import { StatusBadge } from "~/components/ui/status-badge";
import { clearWebAuthToken, fetchWebAuthStatus, requestWebAuthToken, setWebPassword, type WebAuthStatus } from "~/services/api";
import { patchSettingsLocal } from "~/lib/settings-patch";
import type { Settings } from "~/types";
import { PasswordInput, SettingsGroup, SettingsStack } from "~/components/settings/shared";

/** 数据管理 › Web 服务:访问密码。对外暴露(Docker/反代)时必备。 */
export function WebServiceSection({ settings }: { settings: Settings; onSettings: (settings: Settings) => void }) {
  const { t } = useTranslation();
  // —— 访问密码(P1):状态经独立端点 /api/web-auth/status(只回布尔,不含哈希)。——
  const [webAuthStatus, setWebAuthStatus] = React.useState<WebAuthStatus | null>(null);
  const [webPwCurrent, setWebPwCurrent] = React.useState("");
  const [webPwNew, setWebPwNew] = React.useState("");
  const [webPwBusy, setWebPwBusy] = React.useState(false);
  const refreshWebAuthStatus = React.useCallback(async () => {
    try {
      setWebAuthStatus(await fetchWebAuthStatus());
    } catch {
      // 状态探测失败(网络抖动)→ 保持现状,密码表单按已有 settings.webServerJwtEnabled 兜底显示。
    }
  }, []);
  React.useEffect(() => {
    void refreshWebAuthStatus();
  }, [refreshWebAuthStatus]);
  const webAuthConfigured = webAuthStatus?.configured ?? settings.webServerJwtEnabled === true;
  const submitWebPassword = React.useCallback(
    async (clear: boolean) => {
      if (webPwBusy) return;
      setWebPwBusy(true);
      try {
        await setWebPassword({
          currentPassword: webAuthConfigured ? webPwCurrent : undefined,
          newPassword: clear ? "" : webPwNew,
        });
        // 改/设密码后旧 token 已失效:立刻用新密码换发,避免下次请求 401 弹登录墙的假锁定。
        // 清密码则清掉本地 token。
        if (clear) clearWebAuthToken();
        else await requestWebAuthToken(webPwNew);
        setWebPwCurrent("");
        setWebPwNew("");
        await refreshWebAuthStatus();
        patchSettingsLocal({ webServerJwtEnabled: !clear });
        toast.success(t(clear ? "settings:data.web_password_cleared" : "settings:data.web_password_saved"));
      } catch (error) {
        toast.error((error as Error).message || t("settings:data.web_password_failed"));
      } finally {
        setWebPwBusy(false);
      }
    },
    [webPwBusy, webAuthConfigured, webPwCurrent, webPwNew, refreshWebAuthStatus, t],
  );

  return (
    <SettingsStack>
      <SettingsGroup
        title={t("settings:data.web_password_title")}
        description={t("settings:data.web_password_desc")}
        action={
          <StatusBadge tone={webAuthConfigured ? "success" : "neutral"}>
            {webAuthConfigured ? t("settings:data.enabled") : t("settings:data.disabled")}
          </StatusBadge>
        }
      >
        {/* 访问密码(P1):对外暴露(Docker/反代)时必备。部署者锁定(argv/env)时只读提示;
            否则就地设/改/清。密码存派生哈希,这里只见布尔状态。 */}
        {webAuthStatus?.lockedByDeployment ? (
          <Notice className="mt-3">{t("settings:data.web_password_locked")}</Notice>
        ) : (
          <div className="mt-3 max-w-md space-y-2">
            {webAuthConfigured ? (
              <PasswordInput
                value={webPwCurrent}
                onChange={setWebPwCurrent}
                placeholder={t("settings:data.web_password_current")}
                aria-label={t("settings:data.web_password_current")}
              />
            ) : null}
            <PasswordInput
              value={webPwNew}
              onChange={setWebPwNew}
              placeholder={
                webAuthConfigured
                  ? t("settings:data.web_password_new")
                  : t("settings:data.web_password_set")
              }
              aria-label={
                webAuthConfigured
                  ? t("settings:data.web_password_new")
                  : t("settings:data.web_password_set")
              }
            />
            <div className="flex items-center gap-2 pt-1">
              <Button
                size="compact"
                disabled={webPwBusy || (webAuthConfigured ? !webPwCurrent || !webPwNew : !webPwNew)}
                onClick={() => void submitWebPassword(false)}
              >
                {webAuthConfigured
                  ? t("settings:data.web_password_change")
                  : t("settings:data.web_password_set_action")}
              </Button>
              {webAuthConfigured ? (
                <Button
                  size="compact"
                  variant="danger"
                  disabled={webPwBusy || !webPwCurrent}
                  onClick={() => void submitWebPassword(true)}
                >
                  {t("settings:data.web_password_clear")}
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </SettingsGroup>
    </SettingsStack>
  );
}
