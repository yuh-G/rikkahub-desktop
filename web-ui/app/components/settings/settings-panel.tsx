// 设置的"内容"部分:导航列表 + 设置快照。整页(routes/settings.tsx)与模态
// (settings-dialog.tsx)是同一份内容的两套外壳,外壳只管布局与开合,这里的东西两边共用。
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ProxyNavDot } from "~/components/settings/proxy";
import { SETTINGS_NAV, type SettingsTabId } from "~/components/settings/settings-nav";
import { refreshSettingsStore } from "~/lib/settings-sync";
import { cn } from "~/lib/utils";
import { useSettingsStore } from "~/stores/app-store";

export function SettingsNavList({
  active,
  onSelect,
  className,
}: {
  active: SettingsTabId;
  onSelect: (section: SettingsTabId) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <nav className={cn("space-y-1", className)}>
      {SETTINGS_NAV.map((item) => {
        const Icon = item.icon;
        const selected = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            aria-current={selected ? "page" : undefined}
            className={cn(
              "flex w-full items-center gap-2 rounded-[var(--ds-radius-md)] px-3 py-2 text-left text-sm outline-none transition-all duration-200 focus-visible:ring-2 focus-visible:ring-ring/50",
              selected
                ? "bg-[var(--ds-surface-100)] font-medium text-[var(--ds-text-primary)] shadow-[var(--ds-elevation-100)]"
                : "text-sidebar-foreground hover:bg-[var(--ds-on-surface)]",
            )}
            onClick={() => onSelect(item.id)}
          >
            <Icon
              className={cn(
                "size-4 shrink-0 transition-colors",
                selected ? "text-foreground" : "text-muted-foreground",
              )}
            />
            <span className="min-w-0 truncate">{t(item.labelKey)}</span>
            {/* 专题10-⑥:代理运行态小绿点——打开设置任意分区即可看到,不必点进代理页 */}
            {item.id === "proxy" && <ProxyNavDot />}
          </button>
        );
      })}
    </nav>
  );
}

/**
 * 分区所需的 settings。SSE 推送的全局快照即权威值;分区保存后的乐观更新也写回同一处
 * (setSettings 是全应用唯一写入点)。快照尚未到达(冷启动直达设置)时主动拉一次。
 */
export function useSettingsSnapshot() {
  const settings = useSettingsStore((state) => state.settings);
  const setSettings = useSettingsStore((state) => state.setSettings);
  React.useEffect(() => {
    if (settings) return;
    refreshSettingsStore().catch((error: Error) => toast.error(error.message));
  }, [settings]);
  return { settings, setSettings };
}
