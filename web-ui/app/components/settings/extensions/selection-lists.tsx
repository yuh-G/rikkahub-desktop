// components/settings/extensions/selection-lists.tsx — 「用哪些拓展」的逐类选择列表(D19,方案 §5.12)。
//
// 助手的「拓展管理」弹窗(写助手的默认)与输入框的「MCP 与拓展」选择器(写会话)共用:入参是一份选择与
// 变更回调,列表不知道结果写到哪里。每类只列全局可用的条目:有全局「启用」的(MCP、提示词注入)只列
// 已启用的;插件带来的 MCP 服务器跟随插件(「随插件」,开关只读)。按类别表的 id 做 Record,漏一类编译不过。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { SettingsLink } from "~/components/settings/settings-link";
import { SettingsEmpty } from "~/components/settings/shared";
import { ExpandChevron, ToolSwitch } from "~/components/settings/extensions/common";
import type { ExtensionCategoryId } from "~/components/settings/extensions/categories";
import { getDisplayName } from "~/lib/display";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import type { McpServerConfig, McpToolOption, Settings } from "~/types";
import {
  type ExtensionSelection,
  withMcpServerSelected,
  withMcpToolOverride,
} from "@server/assistants/extension-selection";
import { isMcpServerSelected, pluginMcpSource } from "@server/tools/mcp-source";

export interface SkillSummary {
  name: string;
  description?: string;
}

export interface SelectionListProps {
  settings: Settings;
  skills: readonly SkillSummary[];
  selection: ExtensionSelection;
  onChange: (patch: Partial<ExtensionSelection>) => void;
  disabled?: boolean;
  /** 空状态里点了「去拓展页添加」(调用方借此关掉自己的弹窗 / 弹层)。 */
  onNavigate?: () => void;
}

type CountInput = Pick<SelectionListProps, "settings" | "skills" | "selection">;

/** 技能目录(技能没有全局「启用」,装了就可选)。拉取失败按空列表处理:空状态里有去技能页的入口。 */
export function useSkillSummaries(enabled: boolean): SkillSummary[] {
  const [skills, setSkills] = React.useState<SkillSummary[]>([]);
  React.useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api
      .get<SkillSummary[]>("skills")
      .then((list) => alive && setSkills(list))
      .catch(() => alive && setSkills([]));
    return () => {
      alive = false;
    };
  }, [enabled]);
  return skills;
}

export function availableMcpServers(settings: Settings): McpServerConfig[] {
  return (settings.mcpServers ?? []).filter(
    (server) => server.commonOptions?.enable === true && (pluginMcpSource(server)?.active ?? true),
  );
}

function visibleTools(server: McpServerConfig): McpToolOption[] {
  return (server.commonOptions?.tools ?? []).filter((tool) => tool.enable !== false);
}

function enabledOnly<T extends { id: string; enabled?: boolean }>(items: readonly T[] | undefined): T[] {
  return (items ?? []).filter((item) => typeof item?.id === "string" && item.enabled !== false);
}

function sendableQuickMessages(settings: Settings) {
  return (settings.quickMessages ?? []).filter((item) => typeof item?.id === "string" && item.content?.trim());
}

function toggled(ids: readonly string[], id: string, on: boolean): string[] {
  if (on) return ids.includes(id) ? [...ids] : [...ids, id];
  return ids.filter((item) => item !== id);
}

function countIn(ids: readonly string[], available: readonly { id: string }[]): number {
  const known = new Set(available.map((item) => item.id));
  return ids.filter((id) => known.has(id)).length;
}

function SelectionGroup({ title, children }: { title?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      {title ? <h3 className="px-1 text-xs font-medium text-[var(--ds-text-secondary)]">{title}</h3> : null}
      <div className="divide-y divide-[var(--ds-divider)] rounded-[var(--ds-radius-md)] border">{children}</div>
    </section>
  );
}

function SelectionRow({
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
  trailing,
  after,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** 开关左侧的附注(如「随插件」)。 */
  trailing?: React.ReactNode;
  /** 开关右侧(如展开按钮)。 */
  after?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const id = React.useId();
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-3">
        <label htmlFor={id} className={cn("min-w-0 flex-1", !disabled && "cursor-pointer")}>
          <div className="truncate text-sm font-medium text-[var(--ds-text-primary)]">{title}</div>
          {description ? (
            <div className="mt-0.5 line-clamp-1 text-xs text-[var(--ds-text-secondary)]">{description}</div>
          ) : null}
        </label>
        {trailing}
        <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
        {after}
      </div>
      {children}
    </div>
  );
}

function SelectionEmpty({
  category,
  hint,
  onNavigate,
}: {
  category: ExtensionCategoryId;
  hint?: string;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingsEmpty size="md">
      <span>{t(`settings:extension_select.empty.${category}`)}</span>
      {hint ? <span className="text-xs text-[var(--ds-text-tertiary)]">{hint}</span> : null}
      <Button asChild variant="tertiary" size="compact" className="mt-1">
        <SettingsLink search={`?section=extensions&sub=${category}`} onClick={() => onNavigate?.()}>
          <ExternalLink />
          {t("settings:extension_select.go_add")}
        </SettingsLink>
      </Button>
    </SettingsEmpty>
  );
}

function McpSelectionList({ settings, selection, onChange, disabled, onNavigate }: SelectionListProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const servers = availableMcpServers(settings);
  if (servers.length === 0) {
    return <SelectionEmpty category="mcp" hint={t("settings:extension_select.enabled_only")} onNavigate={onNavigate} />;
  }
  const mcp = { mcpServers: selection.mcpServers, mcpToolOverrides: selection.mcpToolOverrides };
  return (
    <SelectionGroup>
      {servers.map((server) => {
        const fromPlugin = pluginMcpSource(server) !== null;
        const selected = isMcpServerSelected(selection, server);
        const tools = visibleTools(server);
        const overrides = selection.mcpToolOverrides[server.id] ?? {};
        const enabledCount = tools.filter((tool) => overrides[tool.name]?.enable !== false).length;
        const open = expanded === server.id && tools.length > 0;
        return (
          <SelectionRow
            key={server.id}
            title={getDisplayName(server.commonOptions?.name, t("settings:mcp.server.default_name"))}
            description={
              tools.length > 0
                ? t("settings:extension_select.mcp_tools", { enabled: enabledCount, total: tools.length })
                : t("settings:extension_select.mcp_no_tools")
            }
            checked={selected}
            // 插件带来的服务器跟随插件(在「插件」里选),这里只读。
            disabled={disabled || fromPlugin}
            onCheckedChange={(checked) => onChange(withMcpServerSelected(mcp, server.id, checked, settings.mcpServers))}
            trailing={
              fromPlugin ? (
                <span className="shrink-0 text-xs text-[var(--ds-text-tertiary)]">
                  {t("settings:extension_select.follows_plugin")}
                </span>
              ) : null
            }
            after={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                disabled={tools.length === 0}
                aria-expanded={open}
                aria-label={open ? t("settings:mcp.server.collapse") : t("settings:mcp.server.expand")}
                onClick={() => setExpanded(open ? null : server.id)}
              >
                <ExpandChevron expanded={open} />
              </Button>
            }
          >
            {open ? <McpToolOverrides server={server} tools={tools} selected={selected} {...{ settings, selection, onChange, disabled }} /> : null}
          </SelectionRow>
        );
      })}
    </SelectionGroup>
  );
}
/** 展开后的逐工具设置。总开关关着时只读置灰,但仍显示上次的偏好,重新打开后照此生效。 */
function McpToolOverrides({
  server,
  tools,
  selected,
  settings,
  selection,
  onChange,
  disabled,
}: Pick<SelectionListProps, "settings" | "selection" | "onChange" | "disabled"> & {
  server: McpServerConfig;
  tools: readonly McpToolOption[];
  selected: boolean;
}) {
  const { t } = useTranslation();
  const mcp = { mcpServers: selection.mcpServers, mcpToolOverrides: selection.mcpToolOverrides };
  const overrides = selection.mcpToolOverrides[server.id] ?? {};
  const update = (toolName: string, patch: { enable?: boolean | null; needsApproval?: boolean | null }) =>
    onChange(withMcpToolOverride(mcp, server.id, toolName, patch, settings.mcpServers));
  return (
    <div
      className={cn(
        "mt-2 divide-y divide-[var(--ds-divider)] rounded-[var(--ds-radius-sm)] bg-[var(--ds-on-surface)] px-2.5 animate-in fade-in-0 duration-(--ds-duration-fast) ease-(--ds-ease-swift) motion-reduce:animate-none",
        !selected && "opacity-60",
      )}
    >
      {tools.map((tool) => {
        const override = overrides[tool.name] ?? {};
        const globalApproval = tool.needsApproval === true;
        return (
          <div key={tool.name} className="flex items-center gap-3 py-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={tool.name}>
              {tool.name}
            </span>
            <ToolSwitch
              label={t("settings:mcp.server.needs_approval")}
              checked={override.needsApproval ?? globalApproval}
              disabled={disabled || !selected}
              // 与全局设置一致时清掉覆盖,跟着全局走。
              onCheckedChange={(checked) => update(tool.name, { needsApproval: checked === globalApproval ? null : checked })}
            />
            <ToolSwitch
              label={t("settings:mcp.enabled")}
              checked={override.enable !== false}
              disabled={disabled || !selected}
              onCheckedChange={(checked) => update(tool.name, { enable: checked ? null : false })}
            />
          </div>
        );
      })}
    </div>
  );
}

function SkillSelectionList({ skills, selection, onChange, disabled, onNavigate }: SelectionListProps) {
  if (skills.length === 0) return <SelectionEmpty category="skills" onNavigate={onNavigate} />;
  return (
    <SelectionGroup>
      {skills.map((skill) => (
        <SelectionRow
          key={skill.name}
          title={skill.name}
          description={skill.description}
          checked={selection.enabledSkills.includes(skill.name)}
          disabled={disabled}
          onCheckedChange={(checked) => onChange({ enabledSkills: toggled(selection.enabledSkills, skill.name, checked) })}
        />
      ))}
    </SelectionGroup>
  );
}
function InjectionSelectionList({ settings, selection, onChange, disabled, onNavigate }: SelectionListProps) {
  const { t } = useTranslation();
  const modes = enabledOnly(settings.modeInjections);
  const lorebooks = enabledOnly(settings.lorebooks);
  if (modes.length === 0 && lorebooks.length === 0) {
    return <SelectionEmpty category="injection" hint={t("settings:extension_select.enabled_only")} onNavigate={onNavigate} />;
  }
  return (
    <div className="space-y-4">
      {modes.length > 0 ? (
        <SelectionGroup title={t("settings:mcp.tab.mode")}>
          {modes.map((item) => (
            <SelectionRow
              key={item.id}
              title={getDisplayName(item.name, t("settings:mcp.tab.mode"))}
              checked={selection.modeInjectionIds.includes(item.id)}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onChange({ modeInjectionIds: toggled(selection.modeInjectionIds, item.id, checked) })
              }
            />
          ))}
        </SelectionGroup>
      ) : null}
      {lorebooks.length > 0 ? (
        <SelectionGroup title={t("settings:mcp.tab.lorebook")}>
          {lorebooks.map((item) => (
            <SelectionRow
              key={item.id}
              title={getDisplayName(item.name, t("settings:mcp.tab.lorebook"))}
              description={item.description}
              checked={selection.lorebookIds.includes(item.id)}
              disabled={disabled}
              onCheckedChange={(checked) => onChange({ lorebookIds: toggled(selection.lorebookIds, item.id, checked) })}
            />
          ))}
        </SelectionGroup>
      ) : null}
    </div>
  );
}

function QuickMessageSelectionList({ settings, selection, onChange, disabled, onNavigate }: SelectionListProps) {
  const { t } = useTranslation();
  const items = sendableQuickMessages(settings);
  if (items.length === 0) return <SelectionEmpty category="quick" onNavigate={onNavigate} />;
  return (
    <SelectionGroup>
      {items.map((item) => (
        <SelectionRow
          key={item.id}
          title={getDisplayName(item.title, t("settings:mcp.tab.quick"))}
          description={item.content}
          checked={selection.quickMessageIds.includes(item.id)}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onChange({ quickMessageIds: toggled(selection.quickMessageIds, item.id, checked) })
          }
        />
      ))}
    </SelectionGroup>
  );
}

export const SELECTION_LISTS: Record<ExtensionCategoryId, React.ComponentType<SelectionListProps>> = {
  mcp: McpSelectionList,
  skills: SkillSelectionList,
  injection: InjectionSelectionList,
  quick: QuickMessageSelectionList,
};

/** 各类已选、且此刻可用的条目数(页签角标、选择器按钮的徽标)。 */
export const SELECTION_COUNTS: Record<ExtensionCategoryId, (input: CountInput) => number> = {
  mcp: ({ settings, selection }) =>
    availableMcpServers(settings).filter((server) => isMcpServerSelected(selection, server)).length,
  skills: ({ skills, selection }) => countIn(selection.enabledSkills, skills.map((skill) => ({ id: skill.name }))),
  injection: ({ settings, selection }) =>
    countIn(selection.modeInjectionIds, enabledOnly(settings.modeInjections)) +
    countIn(selection.lorebookIds, enabledOnly(settings.lorebooks)),
  quick: ({ settings, selection }) => countIn(selection.quickMessageIds, sendableQuickMessages(settings)),
};
