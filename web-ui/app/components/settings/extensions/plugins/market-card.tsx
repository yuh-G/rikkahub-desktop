// 市场里的一张卡片(方案 P6.2「视图三」):整卡可点 → 市场条目;右上角的动作随状态变:未安装「+」→ 安装进度环(每段
// 各走一圈,悬停看是哪一段)→ 刚装好「✓」停约 1.2 秒 → 齿轮「管理」;已安装且有更新是向上箭头。悬停只变描边与底色,
// 不位移不加阴影。
import * as React from "react";
import { Check, CircleArrowUp, Plus, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { marketBusyKey, pushPluginView, usePluginsViewStore } from "~/stores/plugins-view-store";
import type { EnginePluginRecord, PluginMarketItemDto, PluginMarketSourceDto } from "~/types/plugins";

import { installFromMarket, updatePlugin } from "./actions";
import { InstallProgressRing } from "./install-progress";
import { PluginIconTile, ToolbarIconButton } from "./parts";

const JUST_INSTALLED_MS = 1200;

export function formatMonthlyDownloads(count: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(count);
}

export function MarketCard({
  item,
  source,
  record,
  update,
}: {
  item: PluginMarketItemDto;
  source: PluginMarketSourceDto;
  record: EnginePluginRecord | undefined;
  update: { latest: string | null; hasUpdate: boolean } | undefined;
}) {
  const { t, i18n } = useTranslation();
  const open = () => pushPluginView({ kind: "market-detail", sourceId: source.id, name: item.name });
  const meta = [
    item.author,
    item.monthlyDownloads !== undefined
      ? t("settings:plugins.monthly_downloads", { value: formatMonthlyDownloads(item.monthlyDownloads, i18n.language) })
      : null,
  ].filter(Boolean);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        open();
      }}
      className="flex cursor-pointer flex-col gap-3 rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] bg-[var(--ds-surface-100)] p-4 text-left outline-none transition-colors duration-(--ds-duration-fast) hover:border-[color-mix(in_srgb,var(--ds-text-primary)_18%,transparent)] focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <div className="flex items-start gap-3">
        <PluginIconTile size="card" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-[var(--ds-text-primary)]" title={item.name}>
            {item.name}
          </div>
          {meta.length > 0 ? <div className="mt-0.5 truncate text-xs text-[var(--ds-text-secondary)]">{meta.join(" · ")}</div> : null}
        </div>
        <MarketCardAction item={item} source={source} record={record} update={update} />
      </div>
      {item.description ? (
        <p className="line-clamp-2 text-xs leading-relaxed text-[var(--ds-text-secondary)]">{item.description}</p>
      ) : null}
    </div>
  );
}

/** 右上角的动作。点它不进条目(事件不冒泡到卡片)。 */
export function MarketCardAction({
  item,
  source,
  record,
  update,
}: {
  item: PluginMarketItemDto;
  source: PluginMarketSourceDto;
  record: EnginePluginRecord | undefined;
  update: { latest: string | null; hasUpdate: boolean } | undefined;
}) {
  const { t } = useTranslation();
  const installing = usePluginsViewStore((state) => Boolean(state.busy[marketBusyKey(source.id, item.name)]));
  const updating = usePluginsViewStore((state) => Boolean(record && state.busy[record.id]));
  const [justInstalled, setJustInstalled] = React.useState(false);
  React.useEffect(() => {
    if (!justInstalled) return;
    const timer = window.setTimeout(() => setJustInstalled(false), JUST_INSTALLED_MS);
    return () => window.clearTimeout(timer);
  }, [justInstalled]);

  const stop = { onClick: (event: React.MouseEvent) => event.stopPropagation(), onKeyDown: (event: React.KeyboardEvent) => event.stopPropagation() };
  if (installing || updating) {
    return <InstallProgressRing busyKey={installing ? marketBusyKey(source.id, item.name) : record!.id} />;
  }
  if (justInstalled) {
    return (
      <span className="flex size-8 shrink-0 items-center justify-center text-[var(--ds-success)]" {...stop}>
        <Check className="size-4 rikkahub-animate-scale-in motion-reduce:animate-none" />
      </span>
    );
  }
  if (record && update?.hasUpdate && update.latest) {
    const label = t("settings:plugins.update_to", { version: update.latest });
    return (
      <span className="shrink-0" {...stop}>
        <ToolbarIconButton label={label} className="text-[var(--ds-brand-primary)]" onClick={() => void updatePlugin(record)}>
          <CircleArrowUp />
        </ToolbarIconButton>
      </span>
    );
  }
  if (record) {
    return (
      <span className="shrink-0" {...stop}>
        <ToolbarIconButton label={t("settings:plugins.manage")} onClick={() => pushPluginView({ kind: "detail", pluginId: record.id })}>
          <Settings2 />
        </ToolbarIconButton>
      </span>
    );
  }
  return (
    <span className="shrink-0" {...stop}>
      <ToolbarIconButton
        label={t("settings:plugins.install")}
        className="text-[var(--ds-brand-primary)]"
        onClick={() => {
          void installFromMarket(item, source).then((plugin) => plugin && setJustInstalled(true));
        }}
      >
        <Plus />
      </ToolbarIconButton>
    </span>
  );
}
