// 设置的"内容"部分:一级导航列表、页头(一级标题 + 二级标签栏)、设置快照。整页
// (routes/settings.tsx)与模态(settings-dialog.tsx)是同一份内容的两套外壳,外壳只管
// 布局与开合,这里的东西两边共用。
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ProxyNavDot } from "~/components/settings/proxy";
import {
  SETTINGS_NAV,
  settingsNavItem,
  settingsSubItems,
  type SettingsTabId,
} from "~/components/settings/settings-nav";
import { SegmentedTabs } from "~/components/ui/segmented-tabs";
import { windowDragRegionProps } from "~/components/window-controls";
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
              // 选中/未选同字重同字色:只靠底色与阴影区分,选中时文字宽度不跳。
              "flex w-full items-center gap-3 rounded-[var(--ds-radius-md)] px-3 py-2 text-left text-sm font-medium text-[var(--ds-text-primary)] outline-none transition-all duration-200 focus-visible:ring-2 focus-visible:ring-ring/50",
              selected
                ? "bg-[var(--ds-surface-100)] shadow-[var(--ds-elevation-100)]"
                : "hover:bg-[var(--ds-on-surface)]",
            )}
            onClick={() => onSelect(item.id)}
          >
            <Icon
              className={cn(
                "size-[1.125rem] shrink-0 transition-colors",
                selected ? "text-[var(--ds-text-primary)]" : "text-[var(--ds-icon)]",
              )}
            />
            <span className="min-w-0 truncate">{t(item.labelKey)}</span>
            {/* 专题10-⑥:代理运行态小绿点——打开设置任意页即可看到,不必点进代理页 */}
            {item.id === "network" && <ProxyNavDot />}
          </button>
        );
      })}
    </nav>
  );
}

/** 内容区 tabpanel 的 id,二级标签的 aria-controls 指向它。 */
export const SETTINGS_PAGE_PANEL_ID = "settings-page-panel";

/**
 * 内容区固定头部:一级标题 + 二级标签栏(仅有二级时)。不随内容滚动。整个头部是窗口拖拽区
 * (含顶部留白,保证面板顶边可拖);标签项都是 <button>,拖拽放行选择器认得它们。
 * `leading` 放整页形态的返回键;`trailing` 放模态的关闭钮——都在标题行文档流内,标签栏
 * 一行可用满整个宽度,横滚不会被绝对定位的浮动控件截住。
 * 外壳须以 key={section} 挂载本组件:切一级时重挂,滑块不会从上一个一级的位置滑过来。
 */
export function SettingsPageHeader({
  section,
  sub,
  onSub,
  leading,
  trailing,
  className,
}: {
  section: SettingsTabId;
  sub: string | null;
  onSub: (sub: string) => void;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  const title = t(settingsNavItem(section).labelKey);
  const subs = settingsSubItems(section);
  return (
    <div className={cn("shrink-0 select-none px-6 pt-4", className)} {...windowDragRegionProps()}>
      <div className="flex min-h-8 items-center gap-2 pb-3">
        {leading}
        <h2 className="min-w-0 truncate text-lg font-semibold text-[var(--ds-text-primary)]">{title}</h2>
        {trailing != null && <div className="ml-auto flex shrink-0 items-center">{trailing}</div>}
      </div>
      {subs.length > 0 && (
        // 窄屏下标签总宽可能超出:横向滚动而不换行(负边距让滚动区贴边、焦点环不被裁)。
        <div className="-mx-1 overflow-x-auto px-1 pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <SegmentedTabs
            aria-label={title}
            items={subs.map((item) => ({ value: item.id, label: t(item.labelKey) }))}
            value={sub}
            onChange={onSub}
            controls={SETTINGS_PAGE_PANEL_ID}
          />
        </div>
      )}
    </div>
  );
}

/**
 * 页面所需的 settings。SSE 推送的全局快照即权威值;页面保存后的乐观更新也写回同一处
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
