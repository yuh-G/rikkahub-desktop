// 插件详情(方案 P6.2「视图二」,已安装模式):标题栏用设置里的记录立即画出;登记的工具 / 指令 / MCP 服务、运行记录与
// README 来自 GET plugins/detail(会加载一次插件代码),回来前页签内容显示骨架,结果按「插件 id + installedAt」缓存。
// 还没装的市场条目用同一套版式,另在 market-detail-view.tsx(数据来源与动作都不同,合在一起文件过长)。
import * as React from "react";
import { CircleArrowUp, MoreHorizontal, RotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { LabeledSwitch } from "~/components/settings/extensions/common";
import { SettingsEmpty, SettingsStack } from "~/components/settings/shared";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Notice } from "~/components/ui/notice";
import { SegmentedTabs } from "~/components/ui/segmented-tabs";
import { StatusBadge } from "~/components/ui/status-badge";
import { extractErrorMessage } from "~/lib/error";
import { openExternal } from "~/lib/external-link";
import { pluginsApi } from "~/lib/plugins-api";
import { formatRelativeTime } from "~/lib/relative-time";
import {
  backPluginView,
  cachePluginDetail,
  pluginDetailCacheKey,
  pushPluginView,
  usePluginsViewStore,
  type PluginDetailTab,
} from "~/stores/plugins-view-store";
import type { Settings } from "~/types";
import type { EnginePluginDetailDto, EnginePluginRecord } from "~/types/plugins";

import { checkPluginUpdate, reinstallPlugin, setPluginEnabled, uninstallPlugin, updatePlugin } from "./actions";
import { PluginAuditPanel, PluginOverviewPanel, PluginToolsPanel } from "./detail-panels";
import { InstallProgressGlyph, InstallProgressTooltip, PluginBusyIndicator } from "./install-progress";
import { joinPluginRows, pluginIssueCount, pluginSourceLabel, pluginStatuses, type PluginRowModel } from "./model";
import { BackLink, copyText, PanelSkeleton, PluginIconTile, PluginStatusBadges, ToolbarIconButton } from "./parts";

export function PluginDetailView({
  settings,
  pluginId,
  initialTab,
  backLabel,
}: {
  settings: Settings;
  pluginId: string;
  initialTab?: PluginDetailTab;
  backLabel: string;
}) {
  const { t } = useTranslation();
  const record = (settings.enginePlugins ?? []).find((item) => item.id === pluginId);
  const list = usePluginsViewStore((state) => state.list);
  const updates = usePluginsViewStore((state) => state.updates);
  const [tab, setTab] = React.useState<PluginDetailTab>(initialTab ?? "overview");
  const { detail, error, retry } = usePluginDetail(record);

  if (!record) {
    return (
      <SettingsStack>
        <BackLink label={backLabel} onClick={backPluginView} />
        <SettingsEmpty size="md">
          <span>{t("settings:plugins.not_found")}</span>
          <Button type="button" variant="tertiary" size="compact" className="mt-1" onClick={backPluginView}>
            {t("settings:plugins.back_home")}
          </Button>
        </SettingsEmpty>
      </SettingsStack>
    );
  }
  const row = joinPluginRows([record], list?.plugins, updates)[0]!;
  const view = list?.plugins.find((item) => item.id === record.id);
  const toolCount = detail ? detail.tools.length + detail.commands.length : null;
  const auditCount = detail?.audit.length ?? view?.auditCount ?? null;
  const tabs: Array<{ value: PluginDetailTab; label: React.ReactNode }> = [
    { value: "overview", label: t("settings:plugins.tab_overview") },
    { value: "tools", label: <TabLabel label={t("settings:plugins.tab_tools")} count={toolCount} /> },
    { value: "audit", label: <TabLabel label={t("settings:plugins.tab_audit")} count={auditCount} /> },
  ];

  return (
    <SettingsStack>
      <BackLink label={backLabel} onClick={backPluginView} />
      <DetailHeader row={row} />
      <DetailNotices row={row} detail={detail} onShowAudit={() => setTab("audit")} />
      <div className="space-y-4">
        <SegmentedTabs items={tabs} value={tab} onChange={setTab} aria-label={record.name} />
        <div role="tabpanel">
          {/* 读不出登记内容时概览照常显示(说明退回简介),另两个页签只剩这条提示。 */}
          {error ? (
            <Notice
              tone="danger"
              className="mb-4"
              action={
                <Button type="button" variant="tertiary" size="compact" onClick={retry}>
                  <RotateCw />
                  {t("settings:plugins.retry")}
                </Button>
              }
            >
              {t("settings:plugins.detail_load_failed", { error })}
            </Notice>
          ) : null}
          {tab === "overview" ? (
            <PluginOverviewPanel
              record={record}
              view={view}
              detail={detail}
              loading={!detail && !error}
              onShowTools={() => setTab("tools")}
            />
          ) : detail ? (
            tab === "tools" ? (
              <PluginToolsPanel record={record} detail={detail} settings={settings} />
            ) : (
              <PluginAuditPanel audit={detail.audit} />
            )
          ) : error ? null : (
            <PanelSkeleton />
          )}
        </div>
      </div>
    </SettingsStack>
  );
}

function TabLabel({ label, count }: { label: string; count: number | null }) {
  return (
    <>
      {label}
      {count ? <span className="ml-1 text-[var(--ds-text-tertiary)]">· {count}</span> : null}
    </>
  );
}

function usePluginDetail(record: EnginePluginRecord | undefined) {
  const { t } = useTranslation();
  const key = record ? pluginDetailCacheKey(record.id, record.installedAt) : "";
  const detail = usePluginsViewStore((state) => (key ? state.detailCache[key] : undefined));
  const [error, setError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    if (!record || detail) return;
    let alive = true;
    setError(null);
    pluginsApi
      .detail(record.id)
      .then((result) => alive && cachePluginDetail(result))
      .catch((err: unknown) => alive && setError(extractErrorMessage(err, t("settings:plugins.action_failed"))));
    return () => {
      alive = false;
    };
  }, [key, attempt]);
  return { detail, error, retry: () => setAttempt((count) => count + 1) };
}

function DetailHeader({ row }: { row: PluginRowModel }) {
  const { t } = useTranslation();
  const { record, update } = row;
  const busy = usePluginsViewStore((state) => Boolean(state.busy[record.id]));
  const source = pluginSourceLabel(record.source);
  const canUpdate = Boolean(update?.hasUpdate && update.latest && row.view?.installed !== false);
  const meta = [
    record.meta?.author,
    t(`settings:plugins.source.${source.kind}`),
    record.installedAt && !Number.isNaN(Date.parse(record.installedAt))
      ? t("settings:plugins.installed_at", { time: formatRelativeTime(record.installedAt, t) })
      : null,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-3 @min-[40rem]:flex-row @min-[40rem]:items-start @min-[40rem]:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <PluginIconTile size="header" />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <h2 className="truncate text-base font-semibold text-[var(--ds-text-primary)]">{record.name}</h2>
            {record.version ? <StatusBadge>{record.version}</StatusBadge> : null}
            <PluginStatusBadges statuses={pluginStatuses(row)} />
          </div>
          <p className="mt-0.5 truncate text-xs text-[var(--ds-text-secondary)]">{meta.join(" · ")}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <DetailMenu row={row} disabled={busy} />
        {canUpdate ? (
          <InstallProgressTooltip busyKey={record.id} active={busy}>
            <Button type="button" variant="tertiary" size="compact" disabled={busy} onClick={() => void updatePlugin(record)}>
              {busy ? <InstallProgressGlyph busyKey={record.id} /> : <CircleArrowUp />}
              {t(busy ? "settings:plugins.updating" : "settings:plugins.update_to", { version: update!.latest })}
            </Button>
          </InstallProgressTooltip>
        ) : busy ? (
          <PluginBusyIndicator busyKey={record.id} />
        ) : null}
        <LabeledSwitch
          label={t("settings:plugins.enable")}
          checked={record.enabled}
          disabled={busy}
          onCheckedChange={(checked) => void setPluginEnabled(record, checked)}
        />
      </div>
    </div>
  );
}

function DetailMenu({ row, disabled }: { row: PluginRowModel; disabled: boolean }) {
  const { t } = useTranslation();
  const { record } = row;
  const homepage = record.meta?.homepage ?? record.meta?.repository;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ToolbarIconButton label={t("settings:common.item_actions")} disabled={disabled}>
          <MoreHorizontal />
        </ToolbarIconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {/* 更新表里只有能检查更新的记录(npm 来源且没钉版本)。 */}
        {row.update ? (
          <DropdownMenuItem onSelect={() => void checkPluginUpdate(record)}>{t("settings:plugins.check_updates")}</DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => void reinstallPlugin(record)}>{t("settings:plugins.reinstall")}</DropdownMenuItem>
        {homepage ? (
          <DropdownMenuItem onSelect={() => void openExternal(homepage)}>{t("settings:plugins.open_homepage")}</DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => void copyText(record.name)}>{t("settings:plugins.copy_name")}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => void uninstallPlugin(record, backPluginView)}
        >
          {t("settings:plugins.uninstall")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 有情况才出现的提示条,按严重程度最多两条。 */
function DetailNotices({
  row,
  detail,
  onShowAudit,
}: {
  row: PluginRowModel;
  detail: EnginePluginDetailDto | undefined;
  onShowAudit: () => void;
}) {
  const { t } = useTranslation();
  const [fullError, setFullError] = React.useState(false);
  const { record, view } = row;
  const busy = usePluginsViewStore((state) => Boolean(state.busy[record.id]));
  const reinstall = (
    <Button type="button" variant="tertiary" size="compact" disabled={busy} onClick={() => void reinstallPlugin(record)}>
      {t("settings:plugins.reinstall")}
    </Button>
  );
  const notices: React.ReactNode[] = [];
  if (view && !view.installed) {
    const upload = record.source.kind === "upload";
    notices.push(
      <Notice
        key="missing"
        tone="danger"
        action={
          upload ? (
            <Button type="button" variant="tertiary" size="compact" onClick={() => pushPluginView({ kind: "upload" })}>
              {t("settings:plugins.reupload")}
            </Button>
          ) : (
            reinstall
          )
        }
      >
        {t(upload ? "settings:plugins.notice_missing_upload" : "settings:plugins.notice_missing")}
      </Notice>,
    );
  } else if (view?.loadFailed) {
    const message =
      detail?.audit.find((entry) => entry.code === "pi_plugin_load_failed")?.detail ?? detail?.errors[0] ?? "";
    const [firstLine = "", ...rest] = message.split("\n");
    notices.push(
      <Notice key="load" tone="danger" action={reinstall}>
        <div>{firstLine ? t("settings:plugins.notice_load_failed", { error: firstLine }) : t("settings:plugins.status.load_failed")}</div>
        {rest.length > 0 ? (
          <>
            {fullError ? <pre className="mt-1 max-h-48 overflow-auto font-mono text-[11px] whitespace-pre-wrap">{rest.join("\n")}</pre> : null}
            <button type="button" className="mt-0.5 underline-offset-2 hover:underline" onClick={() => setFullError(!fullError)}>
              {t(fullError ? "settings:plugins.hide_full" : "settings:plugins.show_full")}
            </button>
          </>
        ) : null}
      </Notice>,
    );
  }
  const issues = detail ? pluginIssueCount(detail.audit) : 0;
  if (issues > 0) {
    notices.push(
      <Notice
        key="issues"
        tone="warning"
        action={
          <Button type="button" variant="tertiary" size="compact" onClick={onShowAudit}>
            {t("settings:plugins.view")}
          </Button>
        }
      >
        {t("settings:plugins.notice_partial", { count: issues })}
      </Notice>,
    );
  }
  if (!record.enabled) notices.push(<Notice key="disabled">{t("settings:plugins.notice_disabled")}</Notice>);
  if (notices.length === 0) return null;
  return <div className="space-y-2">{notices.slice(0, 2)}</div>;
}
