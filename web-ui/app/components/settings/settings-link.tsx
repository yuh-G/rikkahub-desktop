// 设置的统一入口链接。桌面端(md 及以上)普通左键点击直接打开设置模态、留在当前页;
// 窄屏、或带修饰键的点击(新标签页打开等)走真实的 /settings 路由。href 始终是真实地址,
// 所以右键复制链接、中键打开都保持可用。
import * as React from "react";
import { Link, type NavigateFunction } from "react-router";

import { isDesktopViewport } from "~/hooks/use-mobile";
import { openSettingsDialog } from "~/stores/settings-dialog-store";

/** 代码里打开设置(斜杠指令等没有链接可点的入口):与下面链接的普通左键点击同一套去处。 */
export function openSettings(navigate: NavigateFunction, search = ""): void {
  if (isDesktopViewport()) openSettingsDialog(search);
  else void navigate(`/settings${search}`);
}

type SettingsLinkProps = Omit<React.ComponentProps<typeof Link>, "to"> & {
  /** 深链查询串,如 "?section=models&sub=providers&providerId=…";省略则回到上次停留的位置。 */
  search?: string;
};

export function SettingsLink({ search = "", onClick, ...props }: SettingsLinkProps) {
  return (
    <Link
      {...props}
      to={`/settings${search}`}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (!isDesktopViewport()) return;
        event.preventDefault();
        openSettingsDialog(search);
      }}
    />
  );
}
