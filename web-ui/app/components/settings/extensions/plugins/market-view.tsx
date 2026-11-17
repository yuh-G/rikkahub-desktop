// 插件市场(方案 P6.2「视图三」):常驻搜索框 + 市场源页签 + 刷新 / 展示筛选 / 市场源;两列卡片,滚到底取下一页。
// 搜索停 300ms 发请求(回车立即);结果按「源 + 搜索词」留在视图仓库,从条目返回时列表与滚动位置都在。
import * as React from "react";
import { Plus, RotateCw, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SettingsEmpty, SettingsStack } from "~/components/settings/shared";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Notice } from "~/components/ui/notice";
import { SearchInput } from "~/components/ui/search-input";
import { SegmentedTabs } from "~/components/ui/segmented-tabs";
import { Skeleton } from "~/components/ui/skeleton";
import { extractErrorMessage } from "~/lib/error";
import { pluginsApi, refreshMarketSources } from "~/lib/plugins-api";
import { cn } from "~/lib/utils";
import {
  backPluginView,
  marketResultKey,
  setPluginMarketState,
  storeMarketPage,
  usePluginsViewStore,
  type MarketShowFilter,
} from "~/stores/plugins-view-store";
import type { Settings } from "~/types";
import type { PluginMarketSourceDto } from "~/types/plugins";

import { InstallDialog } from "./install-dialog";
import { MarketSourcesDialog } from "./market-sources-dialog";
import { MarketCard } from "./market-card";
import { marketInstalledRecord } from "./model";
import { BackLink, ToolbarIconButton } from "./parts";

const RESULT_TTL_MS = 10 * 60 * 1000;

export function PluginMarketView({ settings, backLabel }: { settings: Settings; backLabel: string }) {
  const { t } = useTranslation();
  const market = usePluginsViewStore((state) => state.market);
  const sources = usePluginsViewStore((state) => state.marketSources);
  const [sourcesError, setSourcesError] = React.useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(market.query);

  const loadSources = React.useCallback(() => {
    setSourcesError(null);
    refreshMarketSources().catch((err: unknown) => setSourcesError(extractErrorMessage(err, t("settings:plugins.action_failed"))));
  }, [t]);
  React.useEffect(loadSources, [loadSources]);

  // 停 300ms 才把输入交给查询;回车立即交。
  React.useEffect(() => {
    if (draft === market.query) return;
    const timer = window.setTimeout(() => setPluginMarketState({ query: draft }), 300);
    return () => window.clearTimeout(timer);
  }, [draft, market.query]);

  const source = sources?.find((item) => item.id === market.sourceId) ?? sources?.[0] ?? null;

  return (
    <SettingsStack>
      <BackLink label={backLabel} onClick={backPluginView} />
      <MarketHeader
        draft={draft}
        onDraft={setDraft}
        onSubmit={() => setPluginMarketState({ query: draft })}
        sources={sources}
        source={source}
        onOpenSources={() => setSourcesOpen(true)}
      />
      {sourcesError ? (
        <Notice
          tone="danger"
          action={
            <Button type="button" variant="tertiary" size="compact" onClick={loadSources}>
              <RotateCw />
              {t("settings:plugins.retry")}
            </Button>
          }
        >
          {t("settings:plugins.sources_failed", { error: sourcesError })}
        </Notice>
      ) : source ? (
        <MarketResults
          key={marketResultKey(source.id, market.query)}
          settings={settings}
          source={source}
          query={market.query}
          show={market.show}
        />
      ) : (
        <CardSkeletons />
      )}
      <MarketSourcesDialog
        open={sourcesOpen}
        onOpenChange={setSourcesOpen}
        sources={sources ?? []}
        onAdded={(added) => setPluginMarketState({ sourceId: added.id })}
      />
    </SettingsStack>
  );
}

function MarketHeader({
  draft,
  onDraft,
  onSubmit,
  sources,
  source,
  onOpenSources,
}: {
  draft: string;
  onDraft: (value: string) => void;
  onSubmit: () => void;
  sources: PluginMarketSourceDto[] | null;
  source: PluginMarketSourceDto | null;
  onOpenSources: () => void;
}) {
  const { t } = useTranslation();
  const show = usePluginsViewStore((state) => state.market.show);
  const scrolled = usePluginsViewStore((state) => state.scrolled);
  const [refreshing, setRefreshing] = React.useState(false);
  const query = usePluginsViewStore((state) => state.market.query);
  const refresh = async () => {
    if (!source) return;
    setRefreshing(true);
    try {
      storeMarketPage(marketResultKey(source.id, query), await pluginsApi.market(source.id, query, 0, true));
    } catch {
      // 刷新失败保留原来的列表;列表自己的出错提示在下一次正常加载时出现。
    } finally {
      setRefreshing(false);
    }
  };
  return (
    // 吸顶同首页:滚离顶部后显出下缘细线。
    <div
      className={cn(
        "sticky top-0 z-10 -mt-1 space-y-3 border-b bg-[var(--ds-surface-200)] pt-1 pb-3 transition-colors duration-(--ds-duration-fast)",
        scrolled ? "border-[var(--ds-divider)]" : "border-transparent",
      )}
    >
      <h2 className="text-base font-semibold text-[var(--ds-text-primary)]">{t("settings:plugins.market")}</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <SearchInput
          value={draft}
          onValueChange={onDraft}
          placeholder={t("settings:plugins.market_search_placeholder")}
          aria-label={t("settings:plugins.search")}
          clearLabel={t("settings:plugins.clear_search")}
        />
      </form>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 overflow-x-auto">
          {sources ? (
            <SegmentedTabs
              items={sources.map((item) => ({
                value: item.id,
                label: <span title={item.url}>{item.name}</span>,
              }))}
              value={source?.id ?? null}
              onChange={(sourceId) => setPluginMarketState({ sourceId })}
              aria-label={t("settings:plugins.market_sources")}
            />
          ) : (
            <Skeleton className="h-8 w-24" />
          )}
        </div>
        <ToolbarIconButton label={t("settings:plugins.refresh")} disabled={!source || refreshing} onClick={() => void refresh()}>
          <RotateCw className={cn(refreshing && "animate-spin")} />
        </ToolbarIconButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolbarIconButton label={t("settings:plugins.filter")} active={show !== "all"}>
              <SlidersHorizontal />
            </ToolbarIconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuLabel className="text-xs text-[var(--ds-text-tertiary)]">{t("settings:plugins.filter_show")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={show} onValueChange={(value) => setPluginMarketState({ show: value as MarketShowFilter })}>
              <DropdownMenuRadioItem value="all">{t("settings:plugins.market_show_all")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="not_installed">{t("settings:plugins.market_show_not_installed")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="installed">{t("settings:plugins.market_show_installed")}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <ToolbarIconButton label={t("settings:plugins.market_sources")} onClick={onOpenSources}>
          <Plus />
        </ToolbarIconButton>
      </div>
    </div>
  );
}

function MarketResults({
  settings,
  source,
  query,
  show,
}: {
  settings: Settings;
  source: PluginMarketSourceDto;
  query: string;
  show: MarketShowFilter;
}) {
  const { t } = useTranslation();
  const key = marketResultKey(source.id, query);
  const result = usePluginsViewStore((state) => state.marketResults[key]);
  const updates = usePluginsViewStore((state) => state.updates);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [installOpen, setInstallOpen] = React.useState(false);
  const busyRef = React.useRef(false);
  const sentinelRef = React.useRef<HTMLDivElement>(null);

  const load = React.useCallback(
    async (page: number) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setLoading(true);
      setError(null);
      try {
        storeMarketPage(key, await pluginsApi.market(source.id, query, page));
      } catch (err) {
        setError(extractErrorMessage(err, t("settings:plugins.action_failed")));
      } finally {
        busyRef.current = false;
        setLoading(false);
      }
    },
    [key, source.id, query, t],
  );

  React.useEffect(() => {
    const cached = usePluginsViewStore.getState().marketResults[key];
    if (!cached || Date.now() - cached.fetchedAt > RESULT_TTL_MS) void load(0);
  }, [key, load]);

  // 底部哨兵进入视口即取下一页(出错后停下,等用户点重试)。
  const canLoadMore = Boolean(result?.hasMore) && !loading && !error;
  React.useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !canLoadMore || !result) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void load(result.nextPage);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [canLoadMore, load, result]);

  const retry = (
    <Button type="button" variant="tertiary" size="compact" onClick={() => void load(result?.nextPage ?? 0)}>
      <RotateCw />
      {t("settings:plugins.retry")}
    </Button>
  );
  if (!result) {
    return error ? (
      <Notice tone="danger" action={retry}>
        {t("settings:plugins.market_error", { error })}
      </Notice>
    ) : (
      <CardSkeletons />
    );
  }
  const records = settings.enginePlugins ?? [];
  const cards = result.items.map((item) => ({ item, record: marketInstalledRecord(records, source.engine, item.name) }));
  const visible = cards.filter(({ record }) => show === "all" || (show === "installed") === Boolean(record));

  return (
    <div className="space-y-3">
      {result.staleError ? <Notice tone="warning">{t("settings:plugins.market_stale", { error: result.staleError })}</Notice> : null}
      {result.items.length === 0 ? (
        <SettingsEmpty size="md">
          <span>{query ? t("settings:plugins.market_empty", { query }) : t("settings:plugins.market_empty_all")}</span>
          {query ? (
            <Button type="button" variant="tertiary" size="compact" className="mt-1" onClick={() => setInstallOpen(true)}>
              {t("settings:plugins.market_empty_hint")}
            </Button>
          ) : null}
          <InstallDialog kind={installOpen ? "package" : null} initialSpec={query} onOpenChange={setInstallOpen} />
        </SettingsEmpty>
      ) : visible.length === 0 ? (
        <SettingsEmpty size="md">{t("settings:plugins.market_filtered_empty")}</SettingsEmpty>
      ) : (
        <div className="grid grid-cols-1 gap-3 @min-[40rem]:grid-cols-2">
          {visible.map(({ item, record }) => (
            <MarketCard key={item.name} item={item} source={source} record={record} update={record ? updates[record.id] : undefined} />
          ))}
        </div>
      )}
      {loading ? <CardSkeletons /> : null}
      {error ? (
        <Notice tone="danger" action={retry}>
          {t("settings:plugins.market_error", { error })}
        </Notice>
      ) : null}
      {result.hasMore ? (
        <div ref={sentinelRef} aria-hidden className="h-px" />
      ) : result.items.length > 0 ? (
        <p className="py-2 text-center text-xs text-[var(--ds-text-tertiary)]">{t("settings:plugins.no_more")}</p>
      ) : null}
    </div>
  );
}

/** 首屏与翻页的占位:一页的前 6 张。 */
function CardSkeletons() {
  return (
    <div className="grid grid-cols-1 gap-3 @min-[40rem]:grid-cols-2" aria-hidden>
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="space-y-3 rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] bg-[var(--ds-surface-100)] p-4">
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-[var(--ds-radius-sm)]" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ))}
    </div>
  );
}
