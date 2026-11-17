// 插件页首页(方案 P6.2「视图一」):已安装的插件按引擎分组;右上是搜索 / 筛选 / 排序、去市场、添加。标题行吸顶,
// 滚离顶部后显出下缘细线。行整行可点进详情,快速启停与更新、重装、卸载走行尾「⋯」(行上不放开关,与 MCP 页一致)。
import * as React from "react";
import { ArrowUpDown, ChevronDown, Plus, Puzzle, SlidersHorizontal, Store, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SettingsEmpty, SettingsGroup, SettingsListRow, SettingsStack, type SettingsRowAction } from "~/components/settings/shared";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import {
  DEFAULT_PLUGIN_FILTERS,
  pushPluginView,
  setPluginFilters,
  usePluginsViewStore,
  type PluginShowFilter,
  type PluginSort,
} from "~/stores/plugins-view-store";
import type { Settings } from "~/types";

import { reinstallPlugin, setPluginEnabled, uninstallPlugin, updatePlugin } from "./actions";
import {
  groupPlugins,
  isPluginFilterActive,
  joinPluginRows,
  pluginSourceLabel,
  pluginStatuses,
  pluginSubtitle,
  showsEngineFilter,
  type PluginRowModel,
} from "./model";
import { PluginIconTile, PluginStatusBadges, RelativeTime, ToolbarIconButton, ToolbarSearch } from "./parts";

export function PluginsHomeView({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const filters = usePluginsViewStore((state) => state.filters);
  const list = usePluginsViewStore((state) => state.list);
  const updates = usePluginsViewStore((state) => state.updates);
  const records = settings.enginePlugins ?? [];
  const engines = list?.engines ?? [];
  const rows = joinPluginRows(records, list?.plugins, updates);
  const groups = groupPlugins(rows, engines, filters);
  const clearFilters = () => setPluginFilters({ query: "", show: DEFAULT_PLUGIN_FILTERS.show, engine: DEFAULT_PLUGIN_FILTERS.engine });

  return (
    <SettingsStack>
      <HomeHeader />
      {records.length === 0 ? (
        <SettingsEmpty size="md" icon={<Puzzle />}>
          <span>{t("settings:plugins.empty")}</span>
          <div className="mt-1 flex flex-wrap justify-center gap-2">
            <Button type="button" variant="tertiary" size="compact" onClick={() => pushPluginView({ kind: "market" })}>
              <Store />
              {t("settings:plugins.go_market")}
            </Button>
            <Button type="button" variant="tertiary" size="compact" onClick={() => pushPluginView({ kind: "upload" })}>
              <Upload />
              {t("settings:plugins.add_upload")}
            </Button>
          </div>
        </SettingsEmpty>
      ) : groups.length === 0 ? (
        <SettingsEmpty size="md">
          <span>{t("settings:plugins.no_match")}</span>
          <Button type="button" variant="tertiary" size="compact" className="mt-1" onClick={clearFilters}>
            {t("settings:plugins.clear_filters")}
          </Button>
        </SettingsEmpty>
      ) : (
        groups.map((group) => (
          <SettingsGroup key={group.engine.id} title={`${group.engine.label} · ${group.rows.length}`}>
            <div className="-mx-2 mt-1 space-y-0.5">
              {group.rows.map((row, index) => (
                <PluginRow key={row.record.id} row={row} index={index} />
              ))}
            </div>
          </SettingsGroup>
        ))
      )}
    </SettingsStack>
  );
}

function HomeHeader() {
  const { t } = useTranslation();
  const scrolled = usePluginsViewStore((state) => state.scrolled);
  return (
    // 吸顶:底色同设置面板,滚离顶部后才显出下缘细线。内容区窄于 40rem 时工具栏折到标题下一行。
    <div
      className={cn(
        "sticky top-0 z-10 -mt-1 flex flex-col gap-3 border-b bg-[var(--ds-surface-200)] pt-1 pb-3 transition-colors duration-(--ds-duration-fast) @min-[40rem]:flex-row @min-[40rem]:items-start @min-[40rem]:justify-between",
        scrolled ? "border-[var(--ds-divider)]" : "border-transparent",
      )}
    >
      <div className="min-w-0">
        <h2 className="truncate text-base font-semibold text-[var(--ds-text-primary)]">{t("settings:plugins.title")}</h2>
        <p className="mt-0.5 text-xs text-[var(--ds-text-secondary)]">{t("settings:plugins.description")}</p>
      </div>
      <HomeToolbar />
    </div>
  );
}

function HomeToolbar() {
  const { t } = useTranslation();
  const filters = usePluginsViewStore((state) => state.filters);
  const engines = usePluginsViewStore((state) => state.list?.engines ?? []);
  const onQuery = React.useCallback((query: string) => setPluginFilters({ query }), []);
  return (
    <div className="flex shrink-0 items-center gap-1">
      <ToolbarSearch
        value={filters.query}
        onValueChange={onQuery}
        label={t("settings:plugins.search")}
        placeholder={t("settings:plugins.search_placeholder")}
        clearLabel={t("settings:plugins.clear_search")}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ToolbarIconButton label={t("settings:plugins.filter")} active={isPluginFilterActive(filters, engines)}>
            <SlidersHorizontal />
          </ToolbarIconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuLabel className="text-xs text-[var(--ds-text-tertiary)]">{t("settings:plugins.filter_show")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={filters.show} onValueChange={(show) => setPluginFilters({ show: show as PluginShowFilter })}>
            <DropdownMenuRadioItem value="all">{t("settings:plugins.show_all")}</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="enabled">{t("settings:plugins.show_enabled")}</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="disabled">{t("settings:plugins.show_disabled")}</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          {showsEngineFilter(engines) ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-[var(--ds-text-tertiary)]">{t("settings:plugins.filter_engine")}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={filters.engine} onValueChange={(engine) => setPluginFilters({ engine })}>
                <DropdownMenuRadioItem value="all">{t("settings:plugins.engine_all")}</DropdownMenuRadioItem>
                {engines.map((engine) => (
                  <DropdownMenuRadioItem key={engine.id} value={engine.id}>
                    {engine.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ToolbarIconButton label={t("settings:plugins.sort")} active={filters.sort !== DEFAULT_PLUGIN_FILTERS.sort}>
            <ArrowUpDown />
          </ToolbarIconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuLabel className="text-xs text-[var(--ds-text-tertiary)]">{t("settings:plugins.sort")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={filters.sort} onValueChange={(sort) => setPluginFilters({ sort: sort as PluginSort })}>
            <DropdownMenuRadioItem value="added">{t("settings:plugins.sort_added")}</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="name">{t("settings:plugins.sort_name")}</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button type="button" variant="tertiary" size="sm" className="ml-1" onClick={() => pushPluginView({ kind: "market" })}>
        <Store />
        {t("settings:plugins.market")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="sm">
            <Plus />
            {t("settings:plugins.add")}
            <ChevronDown className="-mr-0.5 opacity-80" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={() => pushPluginView({ kind: "upload" })}>
            <Upload />
            {t("settings:plugins.add_upload")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function PluginRow({ row, index }: { row: PluginRowModel; index: number }) {
  const { t } = useTranslation();
  const { record, update } = row;
  const busy = usePluginsViewStore((state) => Boolean(state.busy[record.id]));
  const source = pluginSourceLabel(record.source);
  const subtitle = pluginSubtitle(record) ?? `${t(`settings:plugins.source.${source.kind}`)} · ${source.detail}`;
  const actions: SettingsRowAction[] = [
    {
      key: "enabled",
      label: t(record.enabled ? "settings:plugins.disable" : "settings:plugins.enable"),
      onSelect: () => setPluginEnabled(record, !record.enabled),
    },
    ...(update?.hasUpdate && update.latest && row.view?.installed !== false
      ? [{ key: "update", label: t("settings:plugins.update_to", { version: update.latest }), onSelect: () => updatePlugin(record) }]
      : []),
    { key: "reinstall", label: t("settings:plugins.reinstall"), onSelect: () => reinstallPlugin(record) },
    {
      key: "uninstall",
      label: t("settings:plugins.uninstall"),
      destructive: true,
      onSelect: () => uninstallPlugin(record),
    },
  ];
  return (
    <SettingsListRow
      id={record.id}
      index={index}
      onSelect={() => pushPluginView({ kind: "detail", pluginId: record.id })}
      // 重装 / 更新进行中不给菜单(后端同一引擎的安装是串行的),行尾转圈。
      actions={busy ? undefined : actions}
      badge={busy ? <Spinner className="size-3.5 text-[var(--ds-text-tertiary)]" /> : <RelativeTime at={record.installedAt} />}
    >
      <div className="flex min-w-0 items-center gap-3 text-left">
        <PluginIconTile />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium text-[var(--ds-text-primary)]">{record.name}</span>
            <PluginStatusBadges statuses={pluginStatuses(row)} />
          </div>
          <div className="mt-0.5 truncate text-xs text-[var(--ds-text-secondary)]">{subtitle}</div>
        </div>
      </div>
    </SettingsListRow>
  );
}
