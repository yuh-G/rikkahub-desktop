import * as React from "react";
import { useTranslation } from "react-i18next";
import i18n from "~/i18n";

import { ArrowLeft, Loader2 } from "lucide-react";
import { Link } from "react-router";

import { WindowControlsBar, windowDragRegionProps } from "~/components/window-controls";
import { SidebarBrandRow } from "~/components/sidebar-brand";
import { ProxyNavDot } from "~/components/settings/proxy";
import {
  SETTINGS_NAV,
  isSettingsTabId,
  type SettingsTabId,
} from "~/components/settings/settings-nav";
import { SETTINGS_SECTION_COMPONENTS } from "~/components/settings/settings-registry";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import { useSettingsStore } from "~/stores/app-store";
import type { Settings } from "~/types";

export function meta() {
  return [{ title: i18n.t("settings:nav.meta_title") }];
}

export default function SettingsPage() {
  const { t } = useTranslation();
  const streamedSettings = useSettingsStore((state) => state.settings);
  const setStreamedSettings = useSettingsStore((state) => state.setSettings);
  const [settings, setSettings] = React.useState<Settings | null>(streamedSettings);
  const [section, setSection] = React.useState<SettingsTabId>("general");
  // issue(1.4.1 反馈):手机浏览器访问时设置页只剩左栏可见——固定 w-64+flex-1 双栏
  // 在窄屏下内容区被挤出且 overflow-hidden 不可滑。窄屏改钻取式:先导航列表,
  // 点击进全屏内容并带返回;md 及以上被 md: 类覆盖,双栏行为不变。
  const [mobileContentOpen, setMobileContentOpen] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const querySection = params.get("section");
    if (querySection && isSettingsTabId(querySection)) {
      setSection(querySection);
      setMobileContentOpen(true);
    }
  }, []);

  React.useEffect(() => {
    if (streamedSettings) setSettings(streamedSettings);
  }, [streamedSettings]);

  React.useEffect(() => {
    if (settings) return;
    api
      .get<Settings>("settings")
      .then(setSettings)
      .catch((error: Error) => toast.error(error.message));
  }, [settings]);

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

  const updateLocal = (next: Settings) => {
    setSettings(next);
    setStreamedSettings(next);
  };

  const Section = SETTINGS_SECTION_COMPONENTS[section];

  return (
    <div className="flex h-svh overflow-hidden bg-background">
      {/* 问题7(2.0.0 内测):镶边结构与主界面对齐——侧栏通顶(品牌行兼窗口拖拽区),
          窗控条只嵌在右侧内容列顶部,不再横贯全宽把侧栏压下一条。 */}
      <aside
        data-sidebar-surface=""
        className={cn(
          "w-full flex-col border-r border-divider bg-sidebar text-sidebar-foreground md:w-64",
          mobileContentOpen ? "hidden md:flex" : "flex",
        )}
      >
        {/* border-divider:用比 --border 更淡的分界色,让区域分隔退到背景里。
            问题7回访:品牌行(Logo+RikkaHub,SidebarBrandRow 三页同源)延续主界面设计,
            pt-1 使品牌行距顶 4px——与主界面(SidebarHeader p-2 + -mt-1)同一几何;
            下方动作行放返回键+分区标题(text-sm font-semibold,与旧版大标题同级,
            勿降为小字)。两行都是拖拽区(放行选择器已覆盖 asChild Link 的 <a>)。 */}
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
        <nav className="space-y-1 p-2">
          {SETTINGS_NAV.map((item) => {
            const Icon = item.icon;
            const active = item.id === section;
            return (
              <button
                key={item.id}
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 rounded-[var(--ds-radius-md)] px-3 py-2 text-left text-sm transition-all duration-200",
                  active
                    ? "bg-[var(--ds-surface-100)] font-medium text-[var(--ds-text-primary)] shadow-[var(--ds-elevation-100)]"
                    : "text-sidebar-foreground hover:bg-[var(--ds-on-surface)]",
                )}
                onClick={() => {
                  setSection(item.id);
                  setMobileContentOpen(true);
                }}
              >
                <Icon
                  className={cn(
                    "size-4 transition-colors",
                    active ? "text-foreground" : "text-muted-foreground",
                  )}
                />
                {t(item.labelKey)}
                {/* 专题10-⑥:代理运行态小绿点——打开设置任意分区即可看到,不必点进代理页 */}
                {item.id === "proxy" && <ProxyNavDot />}
              </button>
            );
          })}
        </nav>
      </aside>
      <div
        className={cn(
          "min-w-0 flex-1 flex-col bg-[var(--ds-surface-200)] text-foreground",
          mobileContentOpen ? "flex" : "hidden md:flex",
        )}
      >
        {/* I1:无边框窗口拖拽区 + 窗控钮(仅内容列;侧栏顶部由品牌行承担)。
            mt-1.5/mr-2 对齐主界面 SidebarInset 的 pt-1.5/pr-2:窗控钮三页同一坐标。 */}
        <WindowControlsBar className="mt-1.5 mr-2" />
        <main className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="mx-auto w-full max-w-5xl px-6 py-6">
            {/* 窄屏内容页头:返回导航列表 + 当前分区名(md 起隐藏) */}
            <div className="mb-4 flex items-center gap-2 md:hidden">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("settings:nav.back")}
                onClick={() => setMobileContentOpen(false)}
              >
                <ArrowLeft className="size-4" />
              </Button>
              <span className="text-sm font-semibold">
                {t(SETTINGS_NAV.find((item) => item.id === section)?.labelKey ?? "")}
              </span>
            </div>
            <Section settings={settings} onSettings={updateLocal} />
          </div>
        </ScrollArea>
        </main>
      </div>
    </div>
  );
}
