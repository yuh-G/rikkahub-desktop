import * as React from "react";
import { useTranslation } from "react-i18next";
import i18n from "~/i18n";

import { ArrowLeft, Loader2 } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router";

import { WindowControlsBar, windowDragRegionProps } from "~/components/window-controls";
import { SidebarBrandRow } from "~/components/sidebar-brand";
import {
  resolveSettingsLocation,
  resolveSettingsSub,
  settingsPageKey,
  type SettingsLocation,
  type SettingsTabId,
} from "~/components/settings/settings-nav";
import {
  SETTINGS_PAGE_PANEL_ID,
  SettingsNavList,
  SettingsPageHeader,
  useSettingsSnapshot,
} from "~/components/settings/settings-panel";
import { SETTINGS_PAGES } from "~/components/settings/settings-registry";

import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { useIsDesktop } from "~/hooks/use-mobile";
import { cn } from "~/lib/utils";
import {
  openSettingsDialog,
  rememberSettingsLocation,
  useSettingsDialogStore,
  withSettingsLocation,
} from "~/stores/settings-dialog-store";
import { resetBindingAssistant } from "~/stores/extension-binding-store";

export function meta() {
  return [{ title: i18n.t("settings:nav.meta_title") }];
}

/** 进入整页时的位置:地址栏有合法位置则用之(二级缺省时取记忆/默认),否则回到记忆的一级。纯读,不写 store。 */
function initialLocation(search: string): SettingsLocation {
  const fromUrl = resolveSettingsLocation(search);
  const state = useSettingsDialogStore.getState();
  const section = fromUrl?.section ?? state.section;
  return { section, sub: resolveSettingsSub(section, fromUrl?.sub ?? state.subBySection[section]) };
}

// /settings 路由在两种形态间分流:窄屏渲染整页钻取式;桌面端把深链交给设置模态,
// 自身让位回到上一页(直达或拉宽窗口时)。路由始终存在——深链、窄屏访问都依赖它。
export default function SettingsRoute() {
  const isDesktop = useIsDesktop();
  const location = useLocation();
  const [current, setCurrent] = React.useState<SettingsLocation>(() => initialLocation(location.search));
  // 深链带来的位置记进共用记忆(渲染期不写 store,放到提交后)。
  React.useEffect(() => {
    rememberSettingsLocation(current);
    resetBindingAssistant();
    // 只在进入时记一次;之后的切换由 SettingsPage 的 go() 负责写记忆。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return isDesktop ? (
    <SettingsRouteHandoff search={withSettingsLocation(location.search, current.section, current.sub)} />
  ) : (
    <SettingsPage
      location={current}
      onLocation={setCurrent}
      initialContentOpen={resolveSettingsLocation(location.search) !== null}
    />
  );
}

function SettingsRouteHandoff({ search }: { search: string }) {
  const navigate = useNavigate();
  React.useLayoutEffect(() => {
    openSettingsDialog(search);
    // 有站内上一页则退回(模态盖在用户原本所在的页面上),直达则落到首页。整页切位置时
    // 用 replace 改写过地址栏,location.key 不再可靠;React Router 在 history.state 记的
    // 栈序号 idx 才是"站内是否有上一页"的真值——误判会让 navigate(-1) 跳出应用。
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate("/", { replace: true });
    // 只在挂载时交接一次;search 随后的变化与本次交接无关。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div className="h-svh bg-background" />;
}

function SettingsPage({
  location,
  onLocation,
  initialContentOpen,
}: {
  location: SettingsLocation;
  onLocation: (location: SettingsLocation) => void;
  initialContentOpen: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { settings, setSettings } = useSettingsSnapshot();
  // issue(1.4.1 反馈):手机浏览器访问时设置页只剩左栏可见——固定 w-64+flex-1 双栏
  // 在窄屏下内容区被挤出且 overflow-hidden 不可滑。窄屏改钻取式:先导航列表,
  // 点击进全屏内容并带返回。
  const [contentOpen, setContentOpen] = React.useState(initialContentOpen);

  // 用户主动换位置:写进共用的二级记忆,并把地址栏改写成纯位置——刷新能回到当前页,
  // 页内一次性深链参数(providerId…)随之去掉,不会在页面重挂载时再次生效。replace 不进
  // 历史,返回手势仍是离开设置。
  const go = (section: SettingsTabId, sub: string | null) => {
    const resolved = rememberSettingsLocation({ section, sub });
    onLocation({ section, sub: resolved });
    navigate(`/settings${withSettingsLocation("", section, resolved)}`, { replace: true });
  };

  if (!settings) {
    return (
      <div className="flex h-svh flex-col overflow-hidden bg-background">
        <WindowControlsBar className="mt-1.5 mr-2" />
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          {t("settings:providers.loading")}
        </div>
      </div>
    );
  }

  const pageKey = settingsPageKey(location.section, location.sub);
  const Page = SETTINGS_PAGES[pageKey];

  return (
    <div className="flex h-svh overflow-hidden bg-background">
      <aside
        data-sidebar-surface=""
        className={cn(
          "w-full flex-col bg-sidebar text-sidebar-foreground",
          contentOpen ? "hidden" : "flex",
        )}
      >
        {/* 品牌行(SidebarBrandRow 三页同源)+ 返回键与设置标题;两行都是窗口拖拽区
            (放行选择器已覆盖 asChild Link 的 <a>)。 */}
        <div className="border-b border-divider px-4 pb-3 pt-1">
          <SidebarBrandRow />
          <div className="mt-2 flex items-center gap-2" {...windowDragRegionProps()}>
            <Button asChild size="icon-sm" variant="ghost">
              <Link to="/" aria-label={t("settings:nav.back")}>
                <ArrowLeft className="size-4" />
              </Link>
            </Button>
            <div className="text-sm font-semibold">{t("settings:nav.subtitle")}</div>
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <SettingsNavList
            active={location.section}
            onSelect={(next) => {
              go(next, useSettingsDialogStore.getState().subBySection[next] ?? null);
              setContentOpen(true);
            }}
            className="p-2"
          />
        </ScrollArea>
      </aside>
      <div
        className={cn(
          "min-w-0 flex-1 flex-col bg-[var(--ds-surface-200)] text-foreground",
          contentOpen ? "flex" : "hidden",
        )}
      >
        <WindowControlsBar className="mt-1.5 mr-2" />
        <SettingsPageHeader
          key={`header:${location.section}`}
          section={location.section}
          sub={location.sub}
          onSub={(sub) => go(location.section, sub)}
          className="pt-2"
          leading={
            <Button
              size="icon-sm"
              variant="ghost"
              className="-ml-2 shrink-0"
              aria-label={t("settings:nav.back")}
              onClick={() => setContentOpen(false)}
            >
              <ArrowLeft className="size-4" />
            </Button>
          }
        />
        <main className="min-h-0 flex-1">
          <ScrollArea key={pageKey} className="h-full">
            <div
              id={SETTINGS_PAGE_PANEL_ID}
              role={location.sub ? "tabpanel" : undefined}
              className="mx-auto w-full max-w-5xl px-6 pt-1 pb-8"
            >
              <Page settings={settings} onSettings={setSettings} />
            </div>
          </ScrollArea>
        </main>
      </div>
    </div>
  );
}
