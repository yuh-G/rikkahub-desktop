// 插件详情的三个页签内容(方案 P6.2「视图二」):概览(说明 + 在哪里用 + 高级设置 | 信息卡)、工具与指令、运行记录。
import * as React from "react";
import { ArrowUpRight, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ExpandChevron, ToolSwitch } from "~/components/settings/extensions/common";
import { SettingsAdvancedSection, SettingsEmpty, SettingsGroup, SettingsSwitchRow } from "~/components/settings/shared";
import { Button } from "~/components/ui/button";
import { StatusBadge } from "~/components/ui/status-badge";
import { openExternal } from "~/lib/external-link";
import { cn } from "~/lib/utils";
import { openSettingsDialog } from "~/stores/settings-dialog-store";
import type { Settings } from "~/types";
import type { EnginePluginDetailDto, EnginePluginRecord, EnginePluginViewDto, PluginAuditEntryDto } from "~/types/plugins";

import { setPluginToolCallHook, setPluginToolSwitch } from "./actions";
import { parseAuditSubject, pluginSourceLabel, registeredPluginMcpServer, stripRelativeImages } from "./model";
import { copyText, InfoRow, PanelSkeleton, ReadmeBlock, RelativeTime } from "./parts";

export function PluginOverviewPanel({
  record,
  view,
  detail,
  loading,
  onShowTools,
}: {
  record: EnginePluginRecord;
  view: EnginePluginViewDto | undefined;
  detail: EnginePluginDetailDto | undefined;
  loading: boolean;
  onShowTools: () => void;
}) {
  const { t } = useTranslation();
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const readme = detail?.readme ? stripRelativeImages(detail.readme) : null;
  return (
    <div className="flex flex-col gap-6 @min-[40rem]:flex-row @min-[40rem]:items-start">
      <div className="min-w-0 flex-1 space-y-6">
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-[var(--ds-text-secondary)]">{t("settings:plugins.readme_title")}</h3>
          {readme ? (
            <ReadmeBlock content={readme} />
          ) : loading ? (
            <PanelSkeleton />
          ) : (
            <p className="text-sm text-[var(--ds-text-secondary)]">{record.meta?.description ?? t("settings:plugins.no_readme")}</p>
          )}
        </section>
        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold text-[var(--ds-text-secondary)]">{t("settings:plugins.where_title")}</h3>
          <ul className="space-y-1 text-sm text-[var(--ds-text-primary)]">
            <li>{t("settings:plugins.where_conversation")}</li>
            <li>{t("settings:plugins.where_assistant")}</li>
          </ul>
          <p className="text-xs text-[var(--ds-text-tertiary)]">{t("settings:plugins.where_workspace")}</p>
        </section>
        <SettingsAdvancedSection open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <SettingsSwitchRow
            label={t("settings:plugins.hook_tool_call")}
            description={t("settings:plugins.hook_tool_call_desc")}
            checked={record.hookSwitches.toolCall}
            onCheckedChange={(checked) => void setPluginToolCallHook(record, checked)}
          />
        </SettingsAdvancedSection>
      </div>
      <InfoCard record={record} view={view} detail={detail} onShowTools={onShowTools} />
    </div>
  );
}

function InfoCard({
  record,
  view,
  detail,
  onShowTools,
}: {
  record: EnginePluginRecord;
  view: EnginePluginViewDto | undefined;
  detail: EnginePluginDetailDto | undefined;
  onShowTools: () => void;
}) {
  const { t } = useTranslation();
  const source = pluginSourceLabel(record.source);
  const contains = detail
    ? [
        detail.tools.length ? t("settings:plugins.contains_tools", { count: detail.tools.length }) : null,
        detail.commands.length ? t("settings:plugins.contains_commands", { count: detail.commands.length }) : null,
        detail.mcpServers.length ? t("settings:plugins.contains_mcp", { count: detail.mcpServers.length }) : null,
      ].filter(Boolean)
    : [];
  const links = [
    record.meta?.homepage ? { key: "homepage", url: record.meta.homepage } : null,
    record.meta?.repository && record.meta.repository !== record.meta.homepage
      ? { key: "repository", url: record.meta.repository }
      : null,
  ].filter((link): link is { key: "homepage" | "repository"; url: string } => link !== null);
  return (
    <aside className="w-full shrink-0 rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] bg-[var(--ds-surface-100)] px-4 py-3 @min-[40rem]:w-64">
      <h3 className="pb-1 text-xs font-semibold text-[var(--ds-text-secondary)]">{t("settings:plugins.info_title")}</h3>
      <dl className="divide-y divide-[var(--ds-divider)]">
        {contains.length > 0 ? (
          <InfoRow label={t("settings:plugins.info_contains")}>
            <button type="button" className="text-left hover:text-[var(--ds-brand-primary)]" onClick={onShowTools}>
              {contains.join(" · ")}
            </button>
          </InfoRow>
        ) : null}
        {record.version ? <InfoRow label={t("settings:plugins.info_version")}>{record.version}</InfoRow> : null}
        <InfoRow label={t("settings:plugins.info_source")}>
          {t(`settings:plugins.source.${source.kind}`)} · <span className="break-all">{source.detail}</span>
        </InfoRow>
        {record.meta?.license ? <InfoRow label={t("settings:plugins.info_license")}>{record.meta.license}</InfoRow> : null}
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
        {view?.path ? (
          <InfoRow label={t("settings:plugins.info_location")}>
            <button
              type="button"
              title={view.path}
              className="inline-flex items-center gap-1 text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]"
              onClick={() => void copyText(view.path)}
            >
              <Copy className="size-3" />
              {t("settings:plugins.copy_path")}
            </button>
          </InfoRow>
        ) : null}
      </dl>
    </aside>
  );
}

/** 工具与指令:三组(工具 / 指令 / MCP 服务),空的那组不显示。工具行的写法与 MCP 页的工具行一样。 */
export function PluginToolsPanel({
  record,
  detail,
  settings,
}: {
  record: EnginePluginRecord;
  detail: EnginePluginDetailDto;
  settings: Settings;
}) {
  const { t } = useTranslation();
  if (detail.tools.length === 0 && detail.commands.length === 0 && detail.mcpServers.length === 0) {
    return <SettingsEmpty size="md">{t("settings:plugins.tools_empty")}</SettingsEmpty>;
  }
  return (
    <div className="space-y-6">
      {detail.tools.length > 0 ? (
        <SettingsGroup title={t("settings:plugins.tools_title")} description={t("settings:plugins.tools_desc")}>
          <div className="mt-2 divide-y divide-[var(--ds-divider)] rounded-[var(--ds-radius-md)] border">
            {detail.tools.map((tool) => (
              <PluginToolRow key={tool.name} record={record} tool={tool} />
            ))}
          </div>
        </SettingsGroup>
      ) : null}
      {detail.commands.length > 0 ? (
        <SettingsGroup title={t("settings:plugins.commands_title")} description={t("settings:plugins.commands_desc")}>
          <div className="mt-2 divide-y divide-[var(--ds-divider)] rounded-[var(--ds-radius-md)] border">
            {detail.commands.map((command) => (
              <div key={command.name} className="flex items-baseline gap-3 px-3 py-2">
                <span className="shrink-0 font-mono text-sm text-[var(--ds-text-primary)]">/{command.name}</span>
                {command.description ? (
                  <span className="min-w-0 flex-1 truncate text-xs text-[var(--ds-text-secondary)]" title={command.description}>
                    {command.description}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </SettingsGroup>
      ) : null}
      {detail.mcpServers.length > 0 ? (
        <SettingsGroup title={t("settings:plugins.mcp_title")}>
          <div className="mt-2 divide-y divide-[var(--ds-divider)] rounded-[var(--ds-radius-md)] border">
            {detail.mcpServers.map((server) => (
              <PluginMcpRow key={server.name} record={record} name={server.name} detail={detail} settings={settings} />
            ))}
          </div>
        </SettingsGroup>
      ) : null}
    </div>
  );
}

/** 插件停用时开关只读、整行淡出。展开看说明。调用前问不问由工作区的权限档位决定(D32),这里没有审核开关。 */
function PluginToolRow({ record, tool }: { record: EnginePluginRecord; tool: { name: string; description?: string } }) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const sw = record.toolSwitches[tool.name] ?? {};
  return (
    <div className={cn("px-3 py-2", !record.enabled && "opacity-60")}>
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={tool.name}>
          {tool.name}
        </span>
        <ToolSwitch
          label={t("settings:mcp.enabled")}
          checked={sw.enabled !== false}
          disabled={!record.enabled}
          onCheckedChange={(checked) => void setPluginToolSwitch(record, tool.name, { enabled: checked })}
        />
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={!tool.description}
          aria-expanded={open}
          aria-label={open ? t("settings:mcp.server.collapse") : t("settings:mcp.server.expand")}
          onClick={() => setOpen(!open)}
        >
          <ExpandChevron expanded={open} />
        </Button>
      </div>
      {open && tool.description ? (
        <p className="mt-1.5 text-xs whitespace-pre-wrap text-[var(--ds-text-secondary)] animate-in fade-in-0 duration-(--ds-duration-fast) motion-reduce:animate-none">
          {tool.description}
        </p>
      ) : null}
    </div>
  );
}

function PluginMcpRow({
  record,
  name,
  detail,
  settings,
}: {
  record: EnginePluginRecord;
  name: string;
  detail: EnginePluginDetailDto;
  settings: Settings;
}) {
  const { t } = useTranslation();
  const registered = registeredPluginMcpServer(settings.mcpServers, record.id, name);
  const reason = detail.audit.find((entry) => entry.code === "pi_plugin_mcp_unsupported" && entry.subject === `mcp:${name}`)?.detail;
  const label = registered
    ? t("settings:plugins.mcp_registered")
    : reason
      ? t("settings:plugins.mcp_unregistered_reason", { reason })
      : t("settings:plugins.mcp_unregistered");
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <span className="min-w-0 truncate text-sm font-medium text-[var(--ds-text-primary)]">{name}</span>
      <StatusBadge tone={registered ? "success" : "warning"} className="min-w-0" title={reason}>
        <span className="truncate">{label}</span>
      </StatusBadge>
      <span className="flex-1" />
      {registered ? (
        <Button
          type="button"
          variant="ghost"
          size="compact"
          onClick={() => openSettingsDialog(`?section=extensions&sub=mcp&serverId=${encodeURIComponent(String(registered.id))}`)}
        >
          {t("settings:plugins.view_in_mcp")}
          <ArrowUpRight />
        </Button>
      ) : null}
    </div>
  );
}

/** 运行记录:一句人话 + 细节 + 右侧次数与最近时间,新的在上。码 → 文案在 settings:plugins.audit,认不出的码显示原码。 */
export function PluginAuditPanel({ audit }: { audit: readonly PluginAuditEntryDto[] }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--ds-text-tertiary)]">{t("settings:plugins.audit_hint")}</p>
      {audit.length === 0 ? (
        <SettingsEmpty size="md">{t("settings:plugins.audit_empty")}</SettingsEmpty>
      ) : (
        <div className="divide-y divide-[var(--ds-divider)] rounded-[var(--ds-radius-md)] border">
          {[...audit].reverse().map((entry) => {
            const subject = parseAuditSubject(entry);
            const subjectText = subject.name ? t(`settings:plugins.audit_subject.${subject.kind}`, { name: subject.name }) : "";
            return (
              <div key={`${entry.code}|${entry.subject}`} className="flex items-start gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-[var(--ds-text-primary)]">
                    {t(`settings:plugins.audit.${entry.code}`, { defaultValue: entry.code, subject: subjectText, name: subject.name })}
                  </div>
                  {entry.detail ? (
                    <div className="mt-0.5 line-clamp-3 text-xs break-words text-[var(--ds-text-secondary)]" title={entry.detail}>
                      {entry.detail}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2 pt-0.5">
                  {entry.count > 1 ? <span className="text-xs text-[var(--ds-text-tertiary)]">×{entry.count}</span> : null}
                  <RelativeTime at={entry.lastAt} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
