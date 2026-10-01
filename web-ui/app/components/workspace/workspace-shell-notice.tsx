import * as React from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, SquareTerminal } from "lucide-react";
import { toast } from "sonner";

import { SettingsLink } from "~/components/settings/settings-link";
import { Button } from "~/components/ui/button";
import { extractErrorMessage } from "~/lib/error";
import { openExternal } from "~/lib/external-link";
import api from "~/services/api";

// 工作区 shell 状态提醒(K3):bash 探测失败(典型:Windows 未装 Git Bash 或只有
// 未装发行版的 WSL 启动器)时,在工作区空态页给出修复引导 + 重探入口。
// bash 可用时组件不渲染任何内容——绝大多数用户永远不会见到它。
//
// 2026-08 内嵌兜底上线后,此通知只在"系统无 bash 且内嵌 bash 正在后台首次落地"的
// 短暂窗口出现(内嵌就绪后 getShellConfig 即命中,通知消失)。故引导重心从"下载 Git"
// 改为进阶逃生门——指定自有 bash 路径;Git 下载降为次级,重探保留。

const GIT_FOR_WINDOWS_URL = "https://git-scm.com/download/win";

interface ShellStatus {
  available: boolean;
  error: string | null;
  mountedTools: string[];
}

/** 服务端探测是进程级缓存,前端模块级镜像一份,避免每次进空态页都发请求。 */
let cachedStatus: ShellStatus | null = null;

export function WorkspaceShellNotice() {
  const { t } = useTranslation("page");
  const [status, setStatus] = React.useState<ShellStatus | null>(cachedStatus);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (cachedStatus) return;
    let cancelled = false;
    api
      .get<{ shell: ShellStatus }>("workspaces/shell-status")
      .then((res) => {
        cachedStatus = res.shell;
        if (!cancelled) setStatus(res.shell);
      })
      .catch(() => {
        /* 离线/后端重启窗口:静默,不打扰空态页 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status || status.available) return null;

  const recheck = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.post<{ shell: ShellStatus }>("workspaces/shell-status/refresh");
      cachedStatus = res.shell;
      setStatus(res.shell);
      if (res.shell.available) {
        toast.success(t("workspace.shell.recheck_ok"));
      } else {
        toast.error(t("workspace.shell.recheck_fail"));
      }
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workspace.shell.recheck_fail")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mb-4 max-w-md rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-left">
      <div className="flex items-center gap-2 font-medium text-warning text-xs">
        <SquareTerminal className="size-3.5 shrink-0" strokeWidth={2} />
        {t("workspace.shell.title")}
      </div>
      <p className="mt-1.5 text-muted-foreground text-xs leading-relaxed">{t("workspace.shell.desc")}</p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 rounded-full px-3 text-xs"
          asChild
        >
          <SettingsLink search="?section=general">{t("workspace.shell.set_path")}</SettingsLink>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 rounded-full px-3 text-muted-foreground text-xs"
          onClick={() => void openExternal(GIT_FOR_WINDOWS_URL)}
        >
          {t("workspace.shell.install")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 rounded-full px-3 text-muted-foreground text-xs"
          disabled={busy}
          onClick={() => void recheck()}
        >
          <RefreshCw className={`mr-1.5 size-3 ${busy ? "animate-spin" : ""}`} />
          {t("workspace.shell.recheck")}
        </Button>
      </div>
    </div>
  );
}
