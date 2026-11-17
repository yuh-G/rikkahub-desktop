// 设置 → 拓展 → 插件(D20,方案 §5.13 / P6.2):页内视图栈的宿主。按栈顶渲染视图,换视图时重放进入动画(前进从右、
// 返回从左;只做进入、不做退出,点了立刻有反应);记住与恢复各视图的滚动位置;接住深链 `?plugin=<id>[&tab=]`(新开的
// 页面没有内存里的栈)。列表与更新两份补充数据在这里取,首页与详情共用。
import * as React from "react";
import { useTranslation } from "react-i18next";

import type { SectionProps } from "~/components/settings/extensions/common";
import { SETTINGS_PAGE_PANEL_ID } from "~/components/settings/settings-panel";
import { SettingsDetailHeader, SettingsStack } from "~/components/settings/shared";
import { refreshPluginList, refreshPluginUpdates } from "~/lib/plugins-api";
import { cn } from "~/lib/utils";
import { getSettingsParam } from "~/stores/settings-dialog-store";
import {
  backPluginView,
  parsePluginDetailTab,
  pluginViewKey,
  rememberPluginScroll,
  resetPluginsView,
  setPluginsScrolled,
  showPluginDetail,
  topPluginView,
  usePluginsViewStore,
  type PluginView,
} from "~/stores/plugins-view-store";
import type { Settings } from "~/types";

import { PluginDetailView } from "./detail-view";
import { PluginsHomeView } from "./home-view";
import { BackLink } from "./parts";

export function PluginsSection({ settings }: SectionProps) {
  const stack = usePluginsViewStore((state) => state.stack);
  const direction = usePluginsViewStore((state) => state.direction);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const view = topPluginView(stack);
  const viewKey = pluginViewKey(view);
  const backLabel = usePluginViewTitle(stack.length > 1 ? stack[stack.length - 2] : null, settings);

  // 布局副作用:深链在首帧之前换好栈,不先闪一帧首页。
  React.useLayoutEffect(() => {
    const pluginId = getSettingsParam("plugin");
    if (pluginId) showPluginDetail(pluginId, parsePluginDetailTab(getSettingsParam("tab")));
    return resetPluginsView;
  }, []);
  usePluginViewScroll(rootRef, viewKey, direction);
  usePluginSupplements(settings);

  return (
    // overflow-x-clip:滑入的 8px 不撑出横向滚动条(clip 不成为滚动容器,吸顶仍相对设置的内容面板)。
    <div ref={rootRef} className="@container overflow-x-clip">
      <div
        key={viewKey}
        className={cn(
          "animate-in fade-in-0 duration-(--ds-duration-base) ease-(--ds-ease-soft) motion-reduce:animate-none",
          direction === "forward" && "slide-in-from-right-2",
          direction === "back" && "slide-in-from-left-2",
        )}
      >
        <PluginViewOutlet view={view} settings={settings} backLabel={backLabel} />
      </div>
    </div>
  );
}

export interface PluginViewProps {
  settings: Settings;
  /** 「← 上一视图的标题」;首页没有。 */
  backLabel: string | null;
}

function PluginViewOutlet({ view, settings, backLabel }: PluginViewProps & { view: PluginView }) {
  const title = usePluginViewTitle(view, settings);
  if (view.kind === "home") return <PluginsHomeView settings={settings} />;
  if (view.kind === "detail") {
    return <PluginDetailView settings={settings} pluginId={view.pluginId} initialTab={view.tab} backLabel={backLabel ?? ""} />;
  }
  // 市场、市场条目、上传在 P6.2.6–P6.2.7 落地;这里先给出标题与返回,栈与动画可以先走通。
  return (
    <SettingsStack>
      {backLabel ? <BackLink label={backLabel} onClick={backPluginView} /> : null}
      <SettingsDetailHeader title={title} />
    </SettingsStack>
  );
}

/** 视图的标题(也是下一层「返回」按钮上的字)。 */
function usePluginViewTitle(view: PluginView | null, settings: Settings): string | null {
  const { t } = useTranslation();
  if (!view) return null;
  switch (view.kind) {
    case "home":
      return t("settings:plugins.title");
    case "market":
      return t("settings:plugins.market");
    case "upload":
      return t("settings:plugins.upload_title");
    case "market-detail":
      return view.name;
    case "detail":
      return (settings.enginePlugins ?? []).find((record) => record.id === view.pluginId)?.name ?? view.pluginId;
  }
}

/**
 * 滚动容器是设置的内容面板(插件页登记为停靠页,面板是普通的定高滚动块)。滚动时记下当前位置并标出「滚离了顶部」;
 * 换视图时把离开那一页的位置存进仓库,前进归零,返回恢复。用布局副作用:新视图首帧就在对的位置上。
 */
function usePluginViewScroll(
  rootRef: React.RefObject<HTMLDivElement | null>,
  viewKey: string,
  direction: "forward" | "back" | null,
) {
  const lastTop = React.useRef(0);
  const shownKey = React.useRef(viewKey);
  const panelOf = () => rootRef.current?.closest<HTMLElement>(`#${SETTINGS_PAGE_PANEL_ID}`) ?? null;

  React.useEffect(() => {
    const panel = panelOf();
    if (!panel) return;
    const onScroll = () => {
      lastTop.current = panel.scrollTop;
      setPluginsScrolled(panel.scrollTop > 0);
    };
    onScroll();
    panel.addEventListener("scroll", onScroll, { passive: true });
    return () => panel.removeEventListener("scroll", onScroll);
  }, []);

  React.useLayoutEffect(() => {
    if (shownKey.current === viewKey) return;
    rememberPluginScroll(shownKey.current, lastTop.current);
    shownKey.current = viewKey;
    const panel = panelOf();
    if (!panel) return;
    panel.scrollTop = direction === "back" ? (usePluginsViewStore.getState().scrollByView[viewKey] ?? 0) : 0;
    lastTop.current = panel.scrollTop;
    setPluginsScrolled(panel.scrollTop > 0);
  }, [viewKey]);
}

/** 记录的增删与重装会改 id / installedAt:那时重取列表(包在不在、加载失败);更新检查只在进页时取一次(后端缓存 10 分钟)。 */
function usePluginSupplements(settings: Settings) {
  const signature = (settings.enginePlugins ?? []).map((record) => `${record.id}@${record.installedAt}`).join("|");
  React.useEffect(() => {
    void refreshPluginList();
  }, [signature]);
  React.useEffect(() => {
    void refreshPluginUpdates();
  }, []);
}
