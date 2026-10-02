// 桌面端(md 及以上)的设置承载形态:盖在当前页面上的模态,背后主界面压暗虚化但不卸载
// (会话、输入框草稿原样保留)。root 常驻挂载,由 settings-dialog-store 开合。
// 窄屏不渲染模态,开着时被拉窄则把同一位置交接给 /settings 整页(反向交接见 routes/settings.tsx)。
import * as React from "react";
import { Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { settingsPageKey } from "~/components/settings/settings-nav";
import { SETTINGS_PAGES } from "~/components/settings/settings-registry";
import {
  SETTINGS_PAGE_PANEL_ID,
  SettingsNavList,
  SettingsPageHeader,
  useSettingsSnapshot,
} from "~/components/settings/settings-panel";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog";
import { ScrollArea } from "~/components/ui/scroll-area";
import { windowDragRegionProps } from "~/components/window-controls";
import { useIsDesktop } from "~/hooks/use-mobile";
import { areHotkeysPaused } from "~/lib/hotkey-events";
import { DEFAULT_KEYBINDINGS, formatToken, normalizeTokens } from "~/lib/hotkeys";
import { onStartupPending, onWebAuthRequired } from "~/services/api";
import { useSettingsStore } from "~/stores/app-store";
import {
  closeSettingsDialog,
  currentSettingsSub,
  setSettingsDialogSection,
  setSettingsDialogSub,
  useSettingsDialogStore,
  withSettingsLocation,
} from "~/stores/settings-dialog-store";

export function SettingsDialog() {
  const open = useSettingsDialogStore((state) => state.open);
  const isDesktop = useIsDesktop();
  const navigate = useNavigate();

  React.useEffect(() => {
    if (!open || isDesktop) return;
    const state = useSettingsDialogStore.getState();
    closeSettingsDialog();
    navigate(`/settings${withSettingsLocation(state.search, state.section, currentSettingsSub(state))}`);
  }, [open, isDesktop, navigate]);

  // 登录墙与启动迁移屏是 root 里的普通 fixed 层,排在模态 portal 之下;它们出现时必须让位,
  // 否则模态会压在登录墙上继续可操作(请求全 401)。
  React.useEffect(() => {
    const disposeAuth = onWebAuthRequired(() => closeSettingsDialog());
    const disposeStartup = onStartupPending(() => closeSettingsDialog());
    return () => {
      disposeAuth();
      disposeStartup();
    };
  }, []);

  return (
    <Dialog
      open={open && isDesktop}
      onOpenChange={(next) => {
        if (!next) closeSettingsDialog();
      }}
    >
      <DialogContent
        showCloseButton={false}
        overlayClassName="backdrop-blur-sm"
        // 快捷键录制中 Esc 是"取消录制",由录制按钮自己消费;此时不能顺带关掉整个设置。
        onEscapeKeyDown={(event) => {
          if (areHotkeysPaused()) event.preventDefault();
        }}
        // Radix 默认聚焦第一个可聚焦元素(侧栏首项「通用」):停在别的分区时,焦点环落在一个
        // 并未选中的项上,像是选错了位置。改为聚焦当前分区的导航项,焦点与选中态一致。
        onOpenAutoFocus={(event) => {
          const active = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>(
            'nav [aria-current="page"]',
          );
          if (!active) return;
          event.preventDefault();
          active.focus({ preventScroll: true });
        }}
        className="flex h-[min(720px,calc(100svh-48px))] w-[min(1060px,calc(100vw-32px))] max-w-none gap-0 overflow-hidden bg-[var(--ds-surface-200)] p-0 duration-(--ds-duration-fast) ease-(--ds-ease-swift) data-[state=closed]:zoom-out-[0.985] data-[state=open]:zoom-in-[0.985] sm:max-w-none motion-reduce:animate-none"
      >
        <SettingsDialogBody />
      </DialogContent>
    </Dialog>
  );
}

function SettingsDialogBody() {
  const { t } = useTranslation();
  const section = useSettingsDialogStore((state) => state.section);
  const sub = useSettingsDialogStore(currentSettingsSub);
  const { settings, setSettings } = useSettingsSnapshot();
  const pageKey = settingsPageKey(section, sub);
  const Page = SETTINGS_PAGES[pageKey];

  return (
    <>
      <aside className="flex w-56 shrink-0 flex-col bg-[var(--ds-surface-300)]">
        <div
          className="flex shrink-0 select-none items-center gap-1.5 px-4 pt-4 pb-2"
          {...windowDragRegionProps()}
        >
          <DialogTitle className="text-sm font-medium text-[var(--ds-text-secondary)]">
            {t("settings:nav.dialog_title")}
          </DialogTitle>
          <OpenSettingsShortcut />
          <DialogDescription className="sr-only">{t("settings:nav.subtitle")}</DialogDescription>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <SettingsNavList active={section} onSelect={setSettingsDialogSection} className="px-2 pb-3" />
        </ScrollArea>
      </aside>
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* 页头兼作窗口拖拽区:无边框窗口被遮罩盖住后,它与左栏标题行是仅有的拖拽把手。 */}
        <SettingsPageHeader key={section} section={section} sub={sub} onSub={setSettingsDialogSub} reserveEnd />
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute top-4 right-4 z-10 text-muted-foreground hover:text-foreground"
          aria-label={t("settings:nav.close")}
          title={t("settings:nav.close")}
          onClick={closeSettingsDialog}
        >
          <X className="size-4" />
        </Button>
        {settings ? (
          // key=页键:切一级或二级时滚动位置归零并重放淡入,"新页从顶部开始"。
          <ScrollArea key={pageKey} className="min-h-0 flex-1">
            <div
              id={SETTINGS_PAGE_PANEL_ID}
              role={sub ? "tabpanel" : undefined}
              className="animate-in fade-in-0 px-6 pt-1 pb-8 duration-(--ds-duration-fast) ease-(--ds-ease-swift) motion-reduce:animate-none"
            >
              <Page settings={settings} onSettings={setSettings} />
            </div>
          </ScrollArea>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            {t("settings:providers.loading")}
          </div>
        )}
      </div>
    </>
  );
}

/** 标题旁的打开快捷键提示,显示用户当前生效的绑定;绑定被禁用则不显示。 */
function OpenSettingsShortcut() {
  const binding = useSettingsStore((state) => state.settings?.keybindings?.openSettings) ??
    DEFAULT_KEYBINDINGS.openSettings;
  if (!binding.enabled || !binding.keys?.length) return null;
  return (
    <span className="flex items-center gap-0.5" aria-hidden="true">
      {normalizeTokens(binding.keys).map((token) => (
        <kbd
          key={token}
          className="rounded-[4px] border border-border bg-[var(--ds-surface-100)] px-1 font-mono text-mini leading-4 text-muted-foreground"
        >
          {formatToken(token)}
        </kbd>
      ))}
    </span>
  );
}
