// components/settings/autosave-status.tsx — 自动保存状态行(域7-1,交互审查 3A)。
//
// 病史:设置各分区此前是二态 span("自动保存中"/"已自动保存"),失败静默——保存挂了
// 用户看到的仍是"已自动保存"(假已保存)。本组件统一按 status 渲染:
//   idle           → 不显示(从未编辑时常驻「已自动保存」像刚保存过)
//   pending/saving → "正在自动保存…"(muted + spinner)
//   saved          → "已自动保存",2s 后淡出(不改 hook 状态机,只是展示上的确认反馈)
//   failed         → "保存失败,点击重试"(危险色按钮,点击 saveNow),常驻直到重试
// 数据源是 useAutosaveDraft 返回的 status(状态机见 hook 文件头);所有设置分区一个模式。
import * as React from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { AutosaveStatus } from "~/hooks/use-autosave-draft";
import { cn } from "~/lib/utils";

const SAVED_VISIBLE_MS = 2000;

export function AutosaveStatusRow({
  status,
  onRetry,
  className,
}: {
  status: AutosaveStatus;
  /** 失败态点击重试(通常 = autosave.saveNow)。 */
  onRetry?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const [savedFaded, setSavedFaded] = React.useState(false);
  React.useEffect(() => {
    if (status !== "saved") {
      setSavedFaded(false);
      return;
    }
    const timer = window.setTimeout(() => setSavedFaded(true), SAVED_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

  if (status === "idle") return null;

  if (status === "failed") {
    return (
      <button
        type="button"
        onClick={onRetry}
        className={cn("flex items-center text-xs text-[var(--ds-danger)] transition-colors hover:underline", className)}
      >
        {t("settings:common.autosave_failed_retry")}
      </button>
    );
  }

  const busy = status === "pending" || status === "saving";
  return (
    <div
      role="status"
      aria-hidden={savedFaded || undefined}
      className={cn(
        "flex items-center gap-1.5 text-xs text-[var(--ds-text-tertiary)] transition-opacity duration-(--ds-duration-slow) ease-(--ds-ease-soft)",
        savedFaded && "opacity-0",
        className,
      )}
    >
      {busy ? <Loader2 className="size-3 animate-spin" /> : null}
      {busy ? t("settings:common.autosaving") : t("settings:common.autosaved")}
    </div>
  );
}
