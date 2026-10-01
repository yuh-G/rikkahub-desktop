import * as React from "react";
import { useTranslation } from "react-i18next";
import i18n from "~/i18n";

import { ArrowLeft, Bot, CheckCircle2, CopyPlus, Database, FileClock, Globe, Heart, KeyRound, Loader2, Mic, Search, Settings2, UserRound, Brain } from "lucide-react";
import { Link } from "react-router";

import { WindowControlsBar, windowDragRegionProps } from "~/components/window-controls";
import { SidebarBrandRow } from "~/components/sidebar-brand";
import { MemorySection } from "~/components/memory/memory-section";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { AboutSection, DonateSection } from "~/components/settings/about";
import { AssistantsSection } from "~/components/settings/assistants";
import { McpExtensionsSection } from "~/components/settings/extensions";
import { ProvidersSection } from "~/components/settings/providers";
import { DataSection } from "~/components/settings/data";
import { GeneralSection } from "~/components/settings/general";
import { LogsSection, type RequestLog } from "~/components/settings/logs";
import { ProxyNavDot, ProxySection } from "~/components/settings/proxy";
import { DefaultModelsSection } from "~/components/settings/default-models";
import { SearchSection } from "~/components/settings/search";
import { SpeechSection } from "~/components/settings/speech";
import { StatsSection, type StatsPayload } from "~/components/settings/stats";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import { useSettingsStore } from "~/stores/app-store";
import { confirmDialog } from "~/stores/confirm-store";
import type { Settings } from "~/types";

type Section =
  | "general"
  | "providers"
  | "models"
  | "assistants"
  | "search"
  | "mcp"
  | "speech"
  | "memory"
  | "data"
  | "stats"
  | "logs"
  | "proxy"
  | "donate"
  | "about";

const navItems: Array<{
  id: Section;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: "general", labelKey: "settings:nav.general", icon: UserRound },
  { id: "assistants", labelKey: "settings:nav.assistants", icon: Bot },
  { id: "providers", labelKey: "settings:nav.providers", icon: KeyRound },
  { id: "models", labelKey: "settings:nav.models", icon: Settings2 },
  { id: "search", labelKey: "settings:nav.search", icon: Search },
  { id: "mcp", labelKey: "settings:nav.mcp", icon: CopyPlus },
  { id: "speech", labelKey: "settings:nav.speech", icon: Mic },
  { id: "memory", labelKey: "settings:nav.memory", icon: Brain },
  { id: "data", labelKey: "settings:nav.data", icon: Database },
  { id: "stats", labelKey: "settings:nav.stats", icon: Database },
  { id: "logs", labelKey: "settings:nav.logs", icon: FileClock },
  { id: "proxy", labelKey: "settings:nav.proxy", icon: Globe },
  { id: "donate", labelKey: "settings:nav.donate", icon: Heart },
  { id: "about", labelKey: "settings:nav.about", icon: CheckCircle2 },
];

export function meta() {
  return [{ title: i18n.t("settings:nav.meta_title") }];
}

export default function SettingsPage() {
  const { t } = useTranslation();
  const streamedSettings = useSettingsStore((state) => state.settings);
  const setStreamedSettings = useSettingsStore((state) => state.setSettings);
  const [settings, setSettings] = React.useState<Settings | null>(streamedSettings);
  const [section, setSection] = React.useState<Section>("general");
  // issue(1.4.1 反馈):手机浏览器访问时设置页只剩左栏可见——固定 w-64+flex-1 双栏
  // 在窄屏下内容区被挤出且 overflow-hidden 不可滑。窄屏改钻取式:先导航列表,
  // 点击进全屏内容并带返回;md 及以上被 md: 类覆盖,双栏行为不变。
  const [mobileContentOpen, setMobileContentOpen] = React.useState(false);
  const [logs, setLogs] = React.useState<RequestLog[]>([]);
  const [stats, setStats] = React.useState<StatsPayload | null>(null);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const querySection = params.get("section");
    if (querySection && navItems.some((item) => item.id === querySection)) {
      setSection(querySection as Section);
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

  React.useEffect(() => {
    if (section !== "logs") return;
    api
      .get<RequestLog[]>("logs")
      .then(setLogs)
      .catch((error: Error) => toast.error(error.message));
  }, [section]);

  // 日志问题 3:二次确认收口到 LogsSection.clearVisible(一次确认管请求+错误两类);
  // 本回调退化为纯删除动作,绝不能再各自弹确认(双弹窗)或先删后问。
  const clearLogs = React.useCallback(async () => {
    try {
      await api.delete("logs");
      setLogs([]);
      toast.success(t("settings:logs.cleared"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [t]);

  React.useEffect(() => {
    if (section !== "stats") return;
    api
      .get<StatsPayload>("stats")
      .then(setStats)
      .catch((error: Error) => toast.error(error.message));
  }, [section]);

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
          {navItems.map((item) => {
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
                {t(navItems.find((item) => item.id === section)?.labelKey ?? "")}
              </span>
            </div>
            {section === "general" && (
              <GeneralSection settings={settings} onSettings={updateLocal} />
            )}
            {section === "providers" && (
              <ProvidersSection settings={settings} onSettings={updateLocal} />
            )}
            {section === "models" && (
              <DefaultModelsSection settings={settings} onSettings={updateLocal} />
            )}
            {section === "assistants" && (
              <AssistantsSection settings={settings} onSettings={updateLocal} />
            )}
            {section === "search" && <SearchSection settings={settings} onSettings={updateLocal} />}
            {section === "mcp" && (
              <McpExtensionsSection settings={settings} onSettings={updateLocal} />
            )}
            {section === "speech" && <SpeechSection settings={settings} onSettings={updateLocal} />}
            {section === "memory" && <MemorySection settings={settings} onSettings={updateLocal} />}
            {section === "data" && <DataSection settings={settings} onSettings={updateLocal} />}
            {section === "stats" && <StatsSection stats={stats} />}
            {section === "logs" && (
              <>
                <LogsSection logs={logs} onClear={clearLogs} />
              </>
            )}
            {section === "proxy" && <ProxySection settings={settings} onSettings={updateLocal} />}
            {section === "donate" && <DonateSection />}
            {section === "about" && <AboutSection />}
          </div>
        </ScrollArea>
        </main>
      </div>
    </div>
  );
}

