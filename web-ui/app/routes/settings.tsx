import * as React from "react";
import { useTranslation } from "react-i18next";
import i18n from "~/i18n";

import { ArrowLeft, Loader2 } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router";

import { WindowControlsBar, windowDragRegionProps } from "~/components/window-controls";
import { SidebarBrandRow } from "~/components/sidebar-brand";
import { SETTINGS_NAV, isSettingsTabId, type SettingsTabId } from "~/components/settings/settings-nav";
import { SettingsNavList, useSettingsSnapshot } from "~/components/settings/settings-panel";
import { SETTINGS_SECTION_COMPONENTS } from "~/components/settings/settings-registry";

import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { useIsDesktop } from "~/hooks/use-mobile";
import { cn } from "~/lib/utils";
import { openSettingsDialog, withSettingsSection } from "~/stores/settings-dialog-store";

export function meta() {
  return [{ title: i18n.t("settings:nav.meta_title") }];
}

function sectionFromSearch(search: string): SettingsTabId | null {
  const value = new URLSearchParams(search).get("section");
  return value && isSettingsTabId(value) ? value : null;
}

// /settings 路由在两种形态间分流:窄屏渲染整页钻取式;桌面端把深链交给设置模态,
// 自身让位回到上一页(直达或拉宽窗口时)。路由始终存在——深链、窄屏访问都依赖它。
export default function SettingsRoute() {
  const isDesktop = useIsDesktop();
  const location = useLocation();
  const [section, setSection] = React.useState<SettingsTabId>(
    () => sectionFromSearch(location.search) ?? "general",
  );
  return isDesktop ? (
    <SettingsRouteHandoff search={withSettingsSection(location.search, section)} />
  ) : (
    <SettingsPage
      section={section}
      onSection={setSection}
      initialContentOpen={sectionFromSearch(location.search) !== null}
    />
  );
}

function SettingsRouteHandoff({ search }: { search: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  React.useLayoutEffect(() => {
    openSettingsDialog(search);
    // 有站内上一页则退回(模态盖在用户原本所在的页面上),直达则落到首页。
    if (location.key !== "default") navigate(-1);
    else navigate("/", { replace: true });
    // 只在挂载时交接一次;search 随后的变化与本次交接无关。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div className="h-svh bg-background" />;
}

function SettingsPage({
  section,
  onSection,
  initialContentOpen,
}: {
  section: SettingsTabId;
  onSection: (section: SettingsTabId) => void;
  initialContentOpen: boolean;
}) {
  const { t } = useTranslation();
  const { settings, setSettings } = useSettingsSnapshot();
  // issue(1.4.1 反馈):手机浏览器访问时设置页只剩左栏可见——固定 w-64+flex-1 双栏
  // 在窄屏下内容区被挤出且 overflow-hidden 不可滑。窄屏改钻取式:先导航列表,
  // 点击进全屏内容并带返回。
  const [contentOpen, setContentOpen] = React.useState(initialContentOpen);

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

  const Section = SETTINGS_SECTION_COMPONENTS[section];

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
            active={section}
            onSelect={(next) => {
              onSection(next);
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
        <main className="min-h-0 flex-1">
          <ScrollArea key={section} className="h-full">
            <div className="mx-auto w-full max-w-5xl px-6 py-6">
              <div className="mb-4 flex items-center gap-2">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("settings:nav.back")}
                  onClick={() => setContentOpen(false)}
                >
                  <ArrowLeft className="size-4" />
                </Button>
                <span className="text-sm font-semibold">
                  {t(SETTINGS_NAV.find((item) => item.id === section)?.labelKey ?? "")}
                </span>
              </div>
              <Section settings={settings} onSettings={setSettings} />
            </div>
          </ScrollArea>
        </main>
      </div>
    </div>
  );
}
