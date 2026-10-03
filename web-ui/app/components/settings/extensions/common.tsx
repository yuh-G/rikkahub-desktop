// components/settings/extensions/common.tsx — 拓展四页共用件:列表/详情外壳、「作用于助手」
// 绑定(选择器 + 开关)、JSON 与 settings 拉取小工具。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import { setBindingAssistant, useExtensionBindingStore } from "~/stores/extension-binding-store";
import type { AssistantProfile, Settings } from "~/types";
import {
  type SettingsAddMenuItem,
  SettingsListAddButton,
  SettingsSplit,
  SortableRow,
} from "~/components/settings/shared";

export type SectionProps = { settings: Settings; onSettings: (settings: Settings) => void };

/**
 * 技能 / 提示词注入 / 快捷消息模板 三页的「作用于助手」:三页共享同一选择(模块级 store),
 * 未手动选过时跟随当前对话助手,直接推导不回写(无闪烁)。
 * issue #49(1.5.0):异常数据(Docker 卷手改 state、导入损坏备份、跨版本错配)可能让助手
 * 列表为空,渲染期裸解引用会把整页放大成错误边界白屏——空则返回 null,由调用方渲染空态。
 */
export function useBindingAssistant(settings: Settings): AssistantProfile | null {
  const stored = useExtensionBindingStore((state) => state.assistantId);
  const assistants = Array.isArray(settings.assistants) ? settings.assistants : [];
  return (
    assistants.find((item) => item.id === stored) ??
    assistants.find((item) => item.id === settings.assistantId) ??
    assistants[0] ??
    null
  );
}

/** 「作用于助手」选择器本体:label + Select。整行工具栏(注入页)与左栏列表头(技能/
 *  快捷消息页)共用;窄容器里 label 与下拉同排放不下时折行,label 仍读得清。 */
export function BindingAssistantSelect({
  settings,
  assistant,
  className,
}: {
  settings: Settings;
  assistant: AssistantProfile;
  className?: string;
}) {
  const { t } = useTranslation();
  const selectId = React.useId();
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <label htmlFor={selectId} className="text-xs text-[var(--ds-text-secondary)]" title={t("settings:mcp.binding_assistant_desc")}>
        {t("settings:mcp.binding_assistant")}
      </label>
      <Select value={assistant.id} onValueChange={setBindingAssistant}>
        <SelectTrigger id={selectId} className="h-8 w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {settings.assistants.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.name || t("settings:assistants.default_name")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** 提示词注入页的整行工具栏:分段切换器(模式注入/世界书)与「作用于助手」同排。 */
export function BindingAssistantToolbar({
  settings,
  assistant,
  leading,
}: {
  settings: Settings;
  assistant: AssistantProfile;
  leading?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">{leading}</div>
      <BindingAssistantSelect settings={settings} assistant={assistant} />
    </div>
  );
}

export function NoAssistantsState() {
  const { t } = useTranslation();
  return (
    <div className="rounded-[var(--ds-radius-md)] border border-dashed p-8 text-center text-sm text-[var(--ds-text-secondary)]">
      {t("settings:mcp.no_assistants")}
    </div>
  );
}

/** 详情页头右侧的带标签开关(条目「启用」、「对此助手启用」):标签可点击切换。 */
export function LabeledSwitch({
  label,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: React.ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = React.useId();
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-sm text-[var(--ds-text-secondary)]">
        {label}
      </label>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  );
}

/** 「对此助手启用」:绑定到当前「作用于助手」,与条目自身的「启用」区分开。 */
export function BindingSwitch({
  checked,
  onCheckedChange,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <LabeledSwitch
      label={t("settings:mcp.enable_for_assistant")}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
    />
  );
}

export function prettyJson(value: unknown) {
  return JSON.stringify(value ?? [], null, 2);
}

export function parseJson<T>(value: string, fallback: T, errorMsg = "Invalid JSON"): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    void fallback;
    throw new Error(errorMsg);
  }
}

export async function pullSettings(onSettings: (settings: Settings) => void) {
  const next = await api.get<Settings>("settings");
  onSettings(next);
  return next;
}

/** 卡片展开/收起指示。 */
export function ExpandChevron({ expanded }: { expanded: boolean }) {
  return (
    <ChevronDown
      aria-hidden
      className={cn(
        "size-4 text-[var(--ds-icon)] transition-transform duration-(--ds-duration-fast) ease-(--ds-ease-swift) motion-reduce:transition-none",
        expanded && "rotate-180",
      )}
    />
  );
}

export function EditorShell({
  items,
  selectedId,
  emptyLabel,
  onSelect,
  onMove,
  titleOf,
  renderItem,
  onCreate,
  createMenu,
  listHeader,
  children,
}: {
  items: Array<Record<string, unknown>>;
  selectedId: string;
  emptyLabel: string;
  onSelect: (id: string) => void;
  onMove?: (from: number, to: number) => void | Promise<void>;
  titleOf: (item: Record<string, unknown>) => string;
  renderItem?: (item: Record<string, unknown>) => React.ReactNode;
  /** 单一新增动作;与 createMenu 二选一。 */
  onCreate?: () => void | Promise<void>;
  /** 新增有多个来源/类型时:点开为下拉菜单。 */
  createMenu?: readonly SettingsAddMenuItem[];
  /** 左栏列表头部(「新增」钮与列表之间):技能/快捷消息页的「作用于助手」选择器。 */
  listHeader?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <SettingsSplit
      list={
      <div>
        {createMenu ? (
          <SettingsListAddButton label={t("settings:mcp.add_new")} items={createMenu} />
        ) : (
          <SettingsListAddButton label={t("settings:mcp.add_new")} onClick={() => void onCreate?.()} />
        )}
        {listHeader}
        <div className="space-y-1">
          {items.length === 0 ? (
            <div className="rounded-[var(--ds-radius-md)] border border-dashed p-6 text-center text-sm text-[var(--ds-text-secondary)]">
              {emptyLabel}
            </div>
          ) : null}
          {items.map((item, index) => (
            <SortableRow
              key={String(item.id ?? item.name)}
              id={String(item.id ?? item.name)}
              index={index}
              active={String(item.id ?? item.name) === selectedId}
              onSelect={() => onSelect(String(item.id ?? item.name))}
              onMove={onMove ? (from, to) => void onMove(from, to) : undefined}
            >
              {renderItem ? (
                renderItem(item)
              ) : (
                <div className="truncate text-left">{titleOf(item)}</div>
              )}
            </SortableRow>
          ))}
        </div>
      </div>
      }
    >
      {children}
    </SettingsSplit>
  );
}
