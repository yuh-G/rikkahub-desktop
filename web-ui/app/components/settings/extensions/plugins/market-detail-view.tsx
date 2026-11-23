// 市场条目(方案 P6.2「视图四」,还没装的包):版式同已安装的详情,只是标题栏右侧只有一个主按钮「安装」(已安装则是
// 「管理」→ 已安装详情),没有页签:左栏说明(registry 的 README;catalog 源没有说明时用条目简介),右栏信息卡。
import * as React from "react";
import { ArrowUpRight, Plus, RotateCw, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SettingsStack } from "~/components/settings/shared";
import { Button } from "~/components/ui/button";
import { Notice } from "~/components/ui/notice";
import { StatusBadge } from "~/components/ui/status-badge";
import { extractErrorMessage } from "~/lib/error";
import { openExternal } from "~/lib/external-link";
import { pluginsApi } from "~/lib/plugins-api";
import { formatRelativeTime } from "~/lib/relative-time";
import {
  backPluginView,
  cacheMarketDetail,
  marketBusyKey,
  marketResultKey,
  pushPluginView,
  usePluginsViewStore,
} from "~/stores/plugins-view-store";
import type { Settings } from "~/types";
import type { PluginMarketDetailDto, PluginMarketItemDto, PluginMarketSourceDto } from "~/types/plugins";

import { installFromMarket } from "./actions";
import { InstallProgressGlyph, InstallProgressTooltip } from "./install-progress";
import { formatMonthlyDownloads } from "./market-card";
import { marketInstalledRecord, stripRelativeImages } from "./model";
import { BackLink, InfoCard, InfoRow, PanelSkeleton, PluginIconTile, ReadmeBlock, ReadmeWithInfo } from "./parts";

export function PluginMarketDetailView({
  settings,
  sourceId,
  name,
  backLabel,
}: {
  settings: Settings;
  sourceId: string;
  name: string;
  backLabel: string;
}) {
  const { t } = useTranslation();
  const source = usePluginsViewStore((state) => state.marketSources?.find((item) => item.id === sourceId));
  const key = marketResultKey(sourceId, name);
  const detail = usePluginsViewStore((state) => state.marketDetails[key]);
  // 列表里那一条带月下载量(包文档里没有),先用它画标题栏。
  const listed = usePluginsViewStore((state) => findListedItem(state.marketResults, sourceId, name));
  const [error, setError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    if (detail) return;
    let alive = true;
    setError(null);
    pluginsApi
      .marketDetail(sourceId, name)
      .then((result) => alive && cacheMarketDetail(key, result))
      .catch((err: unknown) => alive && setError(extractErrorMessage(err, t("settings:plugins.action_failed"))));
    return () => {
      alive = false;
    };
  }, [key, attempt]);

  const item: PluginMarketItemDto | undefined = detail
    ? { ...detail.item, monthlyDownloads: detail.item.monthlyDownloads ?? listed?.monthlyDownloads }
    : listed;
  const record = source ? marketInstalledRecord(settings.enginePlugins ?? [], source.engine, name) : undefined;
  const readme = detail?.readme ? stripRelativeImages(detail.readme) : null;

  return (
    <SettingsStack>
      <BackLink label={backLabel} onClick={backPluginView} />
      <MarketDetailHeader name={name} item={item} source={source} installedId={record?.id} />
      {error ? (
        <Notice
          tone="danger"
          action={
            <Button type="button" variant="tertiary" size="compact" onClick={() => setAttempt((count) => count + 1)}>
              <RotateCw />
              {t("settings:plugins.retry")}
            </Button>
          }
        >
          {t("settings:plugins.market_error", { error })}
        </Notice>
      ) : null}
      <ReadmeWithInfo info={<MarketInfoCard item={item} detail={detail} />}>
        {readme ? (
          <ReadmeBlock content={readme} />
        ) : !detail && !error ? (
          <PanelSkeleton />
        ) : (
          <p className="text-sm text-[var(--ds-text-secondary)]">{item?.description ?? t("settings:plugins.no_readme")}</p>
        )}
      </ReadmeWithInfo>
    </SettingsStack>
  );
}

function findListedItem(results: Record<string, { items: PluginMarketItemDto[] }>, sourceId: string, name: string) {
  const prefix = marketResultKey(sourceId, "");
  for (const [key, result] of Object.entries(results)) {
    if (!key.startsWith(prefix)) continue;
    const hit = result.items.find((item) => item.name === name);
    if (hit) return hit;
  }
  return undefined;
}

function MarketDetailHeader({
  name,
  item,
  source,
  installedId,
}: {
  name: string;
  item: PluginMarketItemDto | undefined;
  source: PluginMarketSourceDto | undefined;
  installedId: string | undefined;
}) {
  const { t, i18n } = useTranslation();
  const installing = usePluginsViewStore((state) => Boolean(state.busy[marketBusyKey(source?.id ?? "", name)]));
  const meta = [
    item?.author,
    item?.monthlyDownloads !== undefined
      ? t("settings:plugins.monthly_downloads", { value: formatMonthlyDownloads(item.monthlyDownloads, i18n.language) })
      : null,
    item?.updatedAt && !Number.isNaN(Date.parse(item.updatedAt))
      ? t("settings:plugins.updated_at", { time: formatRelativeTime(item.updatedAt, t) })
      : null,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-3 @min-[40rem]:flex-row @min-[40rem]:items-start @min-[40rem]:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <PluginIconTile size="header" />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <h2 className="truncate text-base font-semibold text-[var(--ds-text-primary)]">{name}</h2>
            {item?.version ? <StatusBadge>{item.version}</StatusBadge> : null}
          </div>
          {meta.length > 0 ? <p className="mt-0.5 truncate text-xs text-[var(--ds-text-secondary)]">{meta.join(" · ")}</p> : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {installedId ? (
          <Button type="button" variant="tertiary" size="sm" onClick={() => pushPluginView({ kind: "detail", pluginId: installedId })}>
            <Settings2 />
            {t("settings:plugins.manage")}
          </Button>
        ) : (
          <InstallProgressTooltip busyKey={marketBusyKey(source?.id ?? "", name)} active={installing}>
            <Button
              type="button"
              size="sm"
              disabled={!item || !source || installing}
              onClick={() => item && source && void installFromMarket(item, source)}
            >
              {installing ? <InstallProgressGlyph busyKey={marketBusyKey(source?.id ?? "", name)} /> : <Plus />}
              {t(installing ? "settings:plugins.installing" : "settings:plugins.install")}
            </Button>
          </InstallProgressTooltip>
        )}
      </div>
    </div>
  );
}

function MarketInfoCard({ item, detail }: { item: PluginMarketItemDto | undefined; detail: PluginMarketDetailDto | undefined }) {
  const { t } = useTranslation();
  const resources = detail?.resources;
  const kinds = resources ? (["extensions", "skills", "prompts", "themes"] as const).filter((kind) => resources[kind]) : [];
  const links = [
    item?.links.homepage ? { key: "homepage", url: item.links.homepage } : null,
    item?.links.repository && item.links.repository !== item.links.homepage ? { key: "repository", url: item.links.repository } : null,
    item?.links.npm ? { key: "npm_page", url: item.links.npm } : null,
  ].filter((link): link is { key: string; url: string } => link !== null);
  return (
    <InfoCard>
      <InfoRow label={t("settings:plugins.info_contains")}>
        {detail ? (
          kinds.length > 0 ? (
            <>
              {kinds.map((kind) => t(`settings:plugins.resources.${kind}`)).join(" · ")}
              {kinds.some((kind) => kind !== "extensions") ? (
                <span className="mt-0.5 block text-[var(--ds-text-tertiary)]">{t("settings:plugins.resources_partial")}</span>
              ) : null}
            </>
          ) : (
            <span className="text-[var(--ds-text-tertiary)]">{t("settings:plugins.resources_unknown")}</span>
          )
        ) : (
          <span className="text-[var(--ds-text-tertiary)]">…</span>
        )}
      </InfoRow>
      {item?.version ? <InfoRow label={t("settings:plugins.info_version")}>{item.version}</InfoRow> : null}
      {detail?.license ? <InfoRow label={t("settings:plugins.info_license")}>{detail.license}</InfoRow> : null}
      {item?.updatedAt && !Number.isNaN(Date.parse(item.updatedAt)) ? (
        <InfoRow label={t("settings:plugins.info_published")}>{new Date(item.updatedAt).toLocaleDateString()}</InfoRow>
      ) : null}
      {links.length > 0 ? (
        <InfoRow label={t("settings:plugins.info_links")}>
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            {links.map((link) => (
              <button
                key={link.key}
                type="button"
                title={link.url}
                className="inline-flex items-center gap-0.5 text-[var(--ds-brand-primary)] hover:underline"
                onClick={() => void openExternal(link.url)}
              >
                {t(`settings:plugins.${link.key}`)}
                <ArrowUpRight className="size-3" />
              </button>
            ))}
          </span>
        </InfoRow>
      ) : null}
    </InfoCard>
  );
}
