// 桌面端(md 及以上)的设置承载形态:盖在当前页面上的模态,背后主界面压暗虚化但不卸载
// (会话、输入框草稿原样保留)。root 常驻挂载,由 settings-dialog-store 开合。
// 窄屏不渲染模态,开着时被拉窄则把同一位置交接给 /settings 整页(反向交接见 routes/settings.tsx)。
import * as React from "react";
import { Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { settingsPageKey } from "~/components/settings/settings-nav";
import { SETTINGS_DOCKED_PAGES, SETTINGS_PAGES } from "~/components/settings/settings-registry";
import {
  SETTINGS_PAGE_PANEL_ID,
  SettingsPageHeader,
  useSettingsSnapshot,
} from "~/components/settings/settings-panel";
import { SettingsSidebarNav, useSettingsSearchFocus } from "~/components/settings/settings-search";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog";
import { Kbd } from "~/components/ui/kbd";
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
  setSettingsDialogLocation,
  setSettingsDialogSection,
  setSettingsDialogSub,
  setSettingsNavQuery,
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
        // 顶带毛玻璃方案:遮罩改为覆盖整屏,让真实顶带(品牌行 + [-口×])随内容一起
        // backdrop-blur;清晰可点的顶带由替身层复刻(见 titlebar-overlay.tsx 头注)。
        // 替身与真实顶带逐字同源(共享 SidebarBrandRow / WindowControlsBar),模态开合
        // 无缝衔接——打开时顶带不变色、不位移,只是从「原生 chrome」换成「替身」。
        overlayProps={{
          "data-settings-overlay": true,
        } as React.HTMLAttributes<HTMLDivElement>}
        // 快捷键录制中 Esc 是"取消录制",由录制按钮自己消费;此时不能顺带关掉整个设置。
        // 侧栏搜索有输入时 Esc 先清空搜索,再按一次才关闭。
        onEscapeKeyDown={(event) => {
          if (areHotkeysPaused()) {
            event.preventDefault();
            return;
          }
          if (useSettingsDialogStore.getState().navQuery) {
            event.preventDefault();
            setSettingsNavQuery("");
          }
        }}
        // Radix 默认聚焦第一个可聚焦元素(侧栏首项「通用」):停在别的一级时,焦点环落在一个
        // 并未选中的项上,像是选错了位置。改为聚焦当前一级的导航项,焦点与选中态一致。
        onOpenAutoFocus={(event) => {
          const active = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>(
            'nav [aria-current="page"]',
          );
          if (!active) return;
          event.preventDefault();
          active.focus({ preventScroll: true });
        }}
        className="flex h-[min(720px,calc(100svh-48px))] w-[min(1060px,calc(100vw-32px))] max-w-none gap-0 overflow-hidden bg-[var(--ds-surface-200)] p-0 duration-(--ds-duration-fast) ease-(--ds-ease-swift) data-[state=closed]:zoom-out-[0.985] data-[state=open]:zoom-in-[0.985] sm:max-w-none motion-reduce:animate-none"
        style={{
          // 居中基准 = 整视口(遮罩全屏覆盖后,面板不再从顶带下缘起算,回到标准视口居中)。
          // 居中偏移交给基础类的 translate-x/y-[-50%](tailwind v4 是独立 translate 属性,
          // 这里若再写 transform 会与之叠加成双重 -50%)。
          top: "50%",
        }}
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
  const docked = SETTINGS_DOCKED_PAGES.has(pageKey);
  useSettingsSearchFocus(pageKey);

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
        <SettingsSidebarNav
          active={section}
          onSelect={setSettingsDialogSection}
          onLocate={setSettingsDialogLocation}
          focusShortcut
          listClassName="px-2 pb-3"
        />
      </aside>
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* 页头兼作窗口拖拽区:无边框窗口被遮罩盖住后,它与左栏标题行是仅有的拖拽把手。
            关闭钮在标题行文档流内(拖拽放行选择器认得 button,不会误触拖拽)。 */}
        <SettingsPageHeader
          key={`header:${section}`}
          section={section}
          sub={sub}
          onSub={setSettingsDialogSub}
          trailing={
            <Button
              variant="ghost"
              size="icon-sm"
              className="-mr-2 text-muted-foreground hover:text-foreground"
              aria-label={t("settings:nav.close")}
              title={t("settings:nav.close")}
              onClick={closeSettingsDialog}
            >
              <X className="size-4" />
            </Button>
          }
        />
        {settings ? (
          // key=页键:切一级或二级时滚动位置归零并重放淡入,"新页从顶部开始"。
          // 停靠页(SETTINGS_DOCKED_PAGES,双栏各自内滚)不走 Radix ScrollArea:其内容
          // 包裹层是 display:table(table 的子元素拿不到受约束高度,栏内滚动链必断),
          // 改用普通定高容器,栏内滚动自己管;普通页维持 Radix 整页滚动。overflow-y-auto
          // 双栏形态下无溢出(栏内精确占满),仅堆叠形态(面板主区 <42rem,Split 退单栏时)
          // 接管滚动——与窄屏整页外壳的停靠分支同款,否则堆叠内容会被 hidden 裁死滚不动。
          docked ? (
            <div
              key={pageKey}
              id={SETTINGS_PAGE_PANEL_ID}
              role={sub ? "tabpanel" : undefined}
              className="flex min-h-0 flex-1 animate-in fade-in-0 flex-col overflow-x-hidden overflow-y-auto px-6 pt-1 pb-8 duration-(--ds-duration-fast) ease-(--ds-ease-swift) motion-reduce:animate-none"
            >
              <Page settings={settings} onSettings={setSettings} />
            </div>
          ) : (
            <ScrollArea key={pageKey} className="min-h-0 flex-1">
              <div
                id={SETTINGS_PAGE_PANEL_ID}
                role={sub ? "tabpanel" : undefined}
                className="min-h-full px-6 pt-1 pb-8 animate-in fade-in-0 duration-(--ds-duration-fast) ease-(--ds-ease-swift) motion-reduce:animate-none"
              >
                <Page settings={settings} onSettings={setSettings} />
              </div>
            </ScrollArea>
          )
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            {t("settings:common.loading")}
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
        <Kbd key={token}>{formatToken(token)}</Kbd>
      ))}
    </span>
  );
}
