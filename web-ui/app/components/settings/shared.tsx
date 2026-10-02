// components/settings/shared.tsx — 设置页各页共用的小组件与工具
//
// 版式纪律(无卡片行式):页面内容直接铺在面板底上,用「分组标题 + 行 + 分隔线 + 间距」
// 组织层次,不再用 `rounded border bg-card` 盒子去「分组」。判断一个带边框的容器该不该
// 留,问一句:它是在「分组」还是在「装载」?
//   - 分组的拆:改用 SettingsGroup / SettingsRows / SettingsRow,别再手写 flex justify-between。
//   - 装载的留:代码/JSON/日志预览、警示条、虚线空状态、可点击的列表项卡——内容需要边界才读得清。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Eye, EyeOff, GripVertical } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";

export function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return items;
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  if (item === undefined) return items;
  next.splice(toIndex, 0, item);
  return next;
}

export function numberText(value: unknown): string {
  return typeof value === "number" || typeof value === "string" ? String(value) : "";
}

export function PasswordInput({
  value,
  onChange,
  onBlur,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = React.useState(false);
  return (
    <div className="relative">
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        type={visible ? "text" : "password"}
        placeholder={placeholder}
        className="pr-10"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="absolute top-1/2 right-1 -translate-y-1/2"
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? t("settings:common.hide_key") : t("settings:common.show_key")}
        title={visible ? t("settings:common.hide_key") : t("settings:common.show_key")}
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </Button>
    </div>
  );
}

/**
 * 「高级设置」触发器:挂在常显区第一个分组的标题行右侧(SettingsGroup 的 action 槽),
 * 展开/收起时自身位置不动——不会把被点的位置换成别的控件。受控:一个状态可同时控制页面上
 * 不相邻的多段(controls 列出它们的 id)。attention:收起时高级区里有非默认或需要注意的
 * 配置,旁边亮一个小圆点,避免默认折叠把用户自己的配置藏起来。
 */
export function SettingsAdvancedToggle({
  open,
  onOpenChange,
  controls,
  attention = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controls: string[];
  attention?: boolean;
}) {
  const { t } = useTranslation();
  const showDot = attention && !open;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls.join(" ")}
      title={showDot ? t("settings:common.advanced_attention") : undefined}
      className="inline-flex h-7 items-center gap-1 rounded-[var(--ds-radius-sm)] px-2 text-xs font-medium text-[var(--ds-text-secondary)] outline-none transition-colors duration-(--ds-duration-fast) ease-(--ds-ease-swift) hover:bg-[var(--ds-on-surface)] hover:text-[var(--ds-text-primary)] focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={() => onOpenChange(!open)}
    >
      {showDot ? <span aria-hidden className="size-1.5 rounded-full bg-[var(--ds-text-secondary)]" /> : null}
      {t("settings:common.advanced")}
      <ChevronDown
        aria-hidden
        className={cn(
          "size-3.5 transition-transform duration-(--ds-duration-fast) ease-(--ds-ease-swift) motion-reduce:transition-none",
          open && "rotate-180",
        )}
      />
    </button>
  );
}

/**
 * 「高级设置」展开出的一段内容:收起时整段不渲染(放在 SettingsRows 里也不会留下多余分隔线),
 * 展开时淡入(多段同时出现,不做高度动画)。
 */
export function SettingsAdvancedRegion({
  id,
  open,
  children,
  className,
}: {
  id: string;
  open: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  if (!open) return null;
  return (
    <div
      id={id}
      className={cn(
        "animate-in fade-in-0 duration-(--ds-duration-fast) ease-(--ds-ease-swift) motion-reduce:animate-none",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** 页面内容的纵向骨架:各 SettingsGroup 之间统一 2rem 节奏。 */
export function SettingsStack({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("space-y-8", className)}>{children}</div>;
}

/**
 * 一组设置:小号分组标题(+ 可选说明、右侧动作)+ 内容。取代"一组设置包进一张卡"——
 * 层次靠标题与间距,而非边框。内容是 SettingsRows 时行自带上下留白;是纵向字段时
 * 用 `fields` 让字段之间与标题之下拉开同样的节奏。
 */
export function SettingsGroup({
  title,
  description,
  action,
  fields = false,
  children,
  className,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** 标题行右侧的次要动作(如「全部恢复默认」)。 */
  action?: React.ReactNode;
  /** 内容是 SettingsField 等纵向字段(而非行列表)。 */
  fields?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const hasHeader = title != null || description != null || action != null;
  return (
    <section className={className}>
      {hasHeader ? (
        <div className="flex min-h-7 items-start justify-between gap-4">
          <div className="min-w-0">
            {title != null ? (
              <h2 className="text-xs font-semibold leading-7 text-[var(--ds-text-secondary)]">{title}</h2>
            ) : null}
            {description != null ? (
              <p className="text-xs text-[var(--ds-text-tertiary)]">{description}</p>
            ) : null}
          </div>
          {action != null ? <div className="flex shrink-0 items-center gap-1">{action}</div> : null}
        </div>
      ) : null}
      {fields ? <div className={cn("space-y-5", hasHeader && "pt-3")}>{children}</div> : children}
    </section>
  );
}

/** 行列表:相邻行之间一条 --ds-divider 细线(条件渲染为 null 的行不占线)。 */
export function SettingsRows({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("divide-y divide-[var(--ds-divider)]", className)}>{children}</div>;
}

/**
 * 设置行:左标题(+说明)、右控件;children 是挂在行下方的附属内容(如展开的子表单)。
 * 各页一律用它,不再各写一遍 flex justify-between。
 */
export function SettingsRow({
  label,
  description,
  control,
  htmlFor,
  children,
  className,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  control?: React.ReactNode;
  /** 标题点击聚焦/切换的目标控件 id(开关行由 SettingsSwitchRow 自动接好)。 */
  htmlFor?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const Label = htmlFor ? "label" : "div";
  // flex-wrap:窄屏整页里宽控件(下拉框)放不下时整体折到标题下方,而不是把标题挤成一列字。
  return (
    <div className={cn("py-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-[min(12rem,100%)] flex-1">
          <Label
            htmlFor={htmlFor}
            className="block text-sm font-medium text-[var(--ds-text-primary)]"
          >
            {label}
          </Label>
          {description != null ? (
            <div className="mt-0.5 text-xs text-[var(--ds-text-secondary)]">{description}</div>
          ) : null}
        </div>
        {control != null ? <div className="flex shrink-0 items-center gap-2">{control}</div> : null}
      </div>
      {children != null ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}

/** 开关行:标题可点击切换(label↔switch 经 useId 绑定)。 */
export function SettingsSwitchRow({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  children,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  const id = React.useId();
  return (
    <SettingsRow
      label={label}
      description={description}
      htmlFor={id}
      control={<Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />}
    >
      {children}
    </SettingsRow>
  );
}

/**
 * 纵向表单字段:标题在上、控件在下、提示在控件下方。description 是标题下方的说明(先读后填),
 * hint 是控件下方的补充。trailing 挂在标题行右侧(如数值读数、「恢复默认」「添加」)。
 * htmlFor 指向控件 id 时标题可点击聚焦。
 */
export function SettingsField({
  label,
  description,
  hint,
  trailing,
  htmlFor,
  children,
  className,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  hint?: React.ReactNode;
  trailing?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const Label = htmlFor ? "label" : "div";
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex min-h-5 items-center justify-between gap-3">
        <div className="min-w-0">
          <Label htmlFor={htmlFor} className="block text-sm font-medium text-[var(--ds-text-primary)]">
            {label}
          </Label>
          {description != null ? (
            <p className="mt-0.5 text-xs text-[var(--ds-text-secondary)]">{description}</p>
          ) : null}
        </div>
        {trailing != null ? <div className="flex shrink-0 items-center gap-2">{trailing}</div> : null}
      </div>
      {children}
      {hint != null ? <p className="text-xs text-[var(--ds-text-secondary)]">{hint}</p> : null}
    </div>
  );
}

/**
 * 列表/详情双栏(助手、供应商、搜索、语音、拓展)。断点按**自身宽度**(容器查询)而非视口:
 * 同一页在模态里与整页里可用宽度不同,视口断点会在模态里过早或过晚换栏。
 * 两栏之间是一条竖分隔线,不再是两张并排的卡。
 */
export function SettingsSplit({
  list,
  children,
  listClassName,
}: {
  list: React.ReactNode;
  children: React.ReactNode;
  listClassName?: string;
}) {
  return (
    <div className="@container">
      <div className="grid gap-6 @2xl:grid-cols-[17.5rem_minmax(0,1fr)] @2xl:gap-0">
        <div
          className={cn(
            "min-w-0 @2xl:border-r @2xl:border-[var(--ds-divider)] @2xl:pr-3",
            listClassName,
          )}
        >
          {list}
        </div>
        <div className="min-w-0 @2xl:pl-6">{children}</div>
      </div>
    </div>
  );
}

/** 详情栏收尾行:左侧自动保存状态,右侧删除等危险/收尾动作。与上方内容以一条细线分开。 */
export function SettingsDetailFooter({ status, children }: { status?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-[var(--ds-divider)] pt-5">
      <div className="min-w-0">{status}</div>
      {children != null ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  );
}

/** 详情栏的标题行:名称(+说明)+ 右侧动作。替代各详情卡顶部的手写 flex 头。 */
export function SettingsDetailHeader({
  title,
  description,
  action,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="truncate text-base font-semibold text-[var(--ds-text-primary)]">{title}</h2>
        {description != null ? (
          <p className="mt-0.5 text-xs text-[var(--ds-text-secondary)]">{description}</p>
        ) : null}
      </div>
      {action != null ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

export function SortableRow({
  id,
  index,
  active,
  children,
  onSelect,
  onMove,
}: {
  id: string;
  index: number;
  active?: boolean;
  children: React.ReactNode;
  onSelect?: () => void;
  onMove?: (from: number, to: number) => void;
}) {
  const [over, setOver] = React.useState(false);
  const canMove = typeof onMove === "function";
  return (
    <div
      draggable={canMove}
      onDragStart={(event) => {
        if (!canMove) return;
        event.dataTransfer.setData("text/plain", String(index));
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(event) => {
        if (!canMove) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => {
        if (canMove) setOver(false);
      }}
      onDrop={(event) => {
        if (!canMove) return;
        event.preventDefault();
        setOver(false);
        const from = Number(event.dataTransfer.getData("text/plain"));
        if (Number.isFinite(from)) onMove?.(from, index);
      }}
      className={[
        "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition",
        // 选中行别用 bg-accent 实填:部分主题把 accent 登记成满饱和点缀色
        // (mx-brutalist 的橙),整行橙块砸在列表里;中性晕染任何主题都成立。
        active ? "bg-[var(--ds-on-surface-active)]" : "hover:bg-[var(--ds-on-surface)]",
        over ? "ring-2 ring-primary/40" : "",
      ].join(" ")}
      data-sort-id={id}
    >
      {canMove ? (
        <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground" />
      ) : null}
      <button type="button" className="min-w-0 flex-1" onClick={onSelect}>
        {children}
      </button>
    </div>
  );
}
