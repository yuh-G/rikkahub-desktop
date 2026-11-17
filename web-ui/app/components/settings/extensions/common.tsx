// components/settings/extensions/common.tsx — 拓展各页共用件:列表/详情外壳、标题栏开关、
// settings 拉取小工具。拓展页不出现助手(D19):助手在自己的页面里选默认拓展。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import type { Settings } from "~/types";
import {
  type SettingsAddMenuItem,
  type SettingsRowAction,
  SettingsEmpty,
  SettingsListAddButton,
  SettingsListRow,
  SettingsSplit,
} from "~/components/settings/shared";

export type SectionProps = { settings: Settings; onSettings: (settings: Settings) => void };

/** 详情页头右侧的带标签开关(条目的全局「启用」):标签可点击切换。 */
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
  rowMenuOf,
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
  /** 提供则每行带右键/悬停「⋯」操作菜单;按该行条目返回动作列表(删除自带确认与落库)。 */
  rowMenuOf?: (item: Record<string, unknown>) => readonly SettingsRowAction[] | undefined;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    // scroll:左列表/右详情两栏各自独立滚动(窄容器堆叠时自动退回整页滚动,见 SettingsSplit)。
    <SettingsSplit
      scroll
      list={
      <div>
        {createMenu ? (
          <SettingsListAddButton label={t("settings:mcp.add_new")} items={createMenu} />
        ) : (
          <SettingsListAddButton label={t("settings:mcp.add_new")} onClick={() => void onCreate?.()} />
        )}
        <div className="space-y-1">
          {items.length === 0 ? (
            <SettingsEmpty size="md">
              {emptyLabel}
            </SettingsEmpty>
          ) : null}
          {items.map((item, index) => {
            const rowKey = String(item.id ?? item.name);
            return (
              <SettingsListRow
                key={rowKey}
                id={rowKey}
                index={index}
                active={rowKey === selectedId}
                onSelect={() => onSelect(rowKey)}
                onMove={onMove ? (from, to) => void onMove(from, to) : undefined}
                actions={rowMenuOf?.(item)}
              >
                {renderItem ? (
                  renderItem(item)
                ) : (
                  <div className="truncate text-left">{titleOf(item)}</div>
                )}
              </SettingsListRow>
            );
          })}
        </div>
      </div>
      }
    >
      {children}
    </SettingsSplit>
  );
}
