// components/settings/shared.tsx — 设置页各页共用的小组件与工具
//
// 版式纪律(无卡片行式):页面内容直接铺在面板底上,用「分组标题 + 行 + 分隔线 + 间距」
// 组织层次,不再用 `rounded border bg-card` 盒子去「分组」。判断一个带边框的容器该不该
// 留,问一句:它是在「分组」还是在「装载」?
//   - 分组的拆:改用 SettingsGroup / SettingsRows / SettingsRow,别再手写 flex justify-between。
//   - 装载的留:代码/JSON/日志预览、警示条、虚线空状态、可点击的列表项卡——内容需要边界才读得清。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Eye, EyeOff, GripVertical, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
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
  id,
  value,
  onChange,
  onBlur,
  placeholder,
  "aria-label": ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  "aria-label"?: string;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = React.useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        type={visible ? "text" : "password"}
        placeholder={placeholder}
        aria-label={ariaLabel}
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
 * 「高级设置」触发器:必须挂在常显位置——常显分组标题行右侧(SettingsGroup 的 action 槽),
 * 或页尾独立一节的标题行。展开/收起时自身位置不动——不会把被点的位置换成别的控件。
 * 受控:一个状态可同时控制页面上不相邻的多段(controls 列出它们的 id)。attention:收起时
 * 高级区里有非默认或需要注意的配置,旁边亮一个小圆点,避免默认折叠把用户自己的配置藏起来。
 */
export function SettingsAdvancedToggle({
  open,
  onOpenChange,
  controls,
  attention = false,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controls: string[];
  attention?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const showDot = attention && !open;
  return (
    <button
      type="button"
      data-settings-advanced=""
      aria-expanded={open}
      aria-controls={controls.join(" ")}
      title={showDot ? t("settings:common.advanced_attention") : undefined}
      className={cn(
        // ghost 胶囊 + 品牌色字:可点击的信号,但不是实底按钮,不抢眼;与分组小标题(secondary 色)区分开。
        "inline-flex h-7 items-center gap-1 rounded-[var(--ds-radius-pill)] px-2.5 text-xs font-medium text-[var(--ds-brand-primary)] outline-none transition-colors duration-(--ds-duration-fast) ease-(--ds-ease-swift) hover:bg-[var(--ds-on-surface)] focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
      onClick={() => onOpenChange(!open)}
    >
      {showDot ? <span aria-hidden className="size-1.5 rounded-full bg-[var(--ds-brand-primary)]" /> : null}
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

/**
 * 行内可编辑文字(昵称、详情页标题):平时是文字 + 旁边一颗低调的「修改」,点文字或「修改」原位
 * 换成输入框;Enter / 失焦提交,Esc 撤销。显式提交(而非逐键自动保存)——编辑中的值是本地状态,
 * 不会被设置回环覆盖。提交空串时由 allowEmpty 决定是否接受(不接受则撤销)。
 */
export function InlineEditText({
  value,
  onCommit,
  placeholder,
  ariaLabel,
  allowEmpty = false,
  className,
  inputClassName,
}: {
  value: string;
  onCommit: (next: string) => void | Promise<void>;
  /** 值为空时显示的文字(如类型默认名),也作为输入框 placeholder。 */
  placeholder?: string;
  ariaLabel: string;
  allowEmpty?: boolean;
  /** 文字的字号/字重(详情标题 text-base font-semibold,行内值 text-sm)。 */
  className?: string;
  /** 输入框宽度(默认 w-60)。 */
  inputClassName?: string;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(value);
  // Esc 撤销后输入框随即卸载会触发 blur;用 ref 标记让这次 blur 不提交。
  const cancelledRef = React.useRef(false);

  const start = () => {
    cancelledRef.current = false;
    setText(value);
    setEditing(true);
  };
  const finish = () => {
    if (cancelledRef.current) return;
    setEditing(false);
    const next = text.trim();
    if (next === value.trim() || (!next && !allowEmpty)) return;
    void onCommit(next);
  };

  if (editing) {
    return (
      <Input
        autoFocus
        value={text}
        aria-label={ariaLabel}
        placeholder={placeholder}
        className={cn("w-60 max-w-full", inputClassName)}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setText(event.target.value)}
        onBlur={finish}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            finish();
          } else if (event.key === "Escape") {
            // 只撤销编辑,不让 Esc 冒泡关掉整个设置模态。
            event.preventDefault();
            event.stopPropagation();
            cancelledRef.current = true;
            setEditing(false);
          }
        }}
      />
    );
  }

  const display = value.trim() || placeholder || "";
  return (
    <span className="inline-flex min-h-8 min-w-0 max-w-full items-center gap-1.5">
      <button
        type="button"
        onClick={start}
        aria-label={`${t("settings:common.edit")} ${ariaLabel}`}
        className={cn(
          "min-w-0 truncate rounded-[var(--ds-radius-sm)] text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          value.trim() ? "text-[var(--ds-text-primary)]" : "text-[var(--ds-text-tertiary)]",
          className,
        )}
      >
        {display}
      </button>
      <button
        type="button"
        onClick={start}
        tabIndex={-1}
        aria-hidden
        className="inline-flex h-6 shrink-0 items-center rounded-[var(--ds-radius-pill)] px-2 text-xs font-medium text-[var(--ds-text-tertiary)] outline-none transition-colors duration-(--ds-duration-fast) ease-(--ds-ease-swift) hover:bg-[var(--ds-on-surface)] hover:text-[var(--ds-brand-primary)]"
      >
        {t("settings:common.edit")}
      </button>
    </span>
  );
}

/** 页面内容的纵向骨架:各 SettingsGroup 之间统一 2rem 节奏。 */
export function SettingsStack({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("space-y-8", className)}>{children}</div>;
}

/**
 * 空状态:虚线框 + 居中灰字。sm 用于字段内的小列表(预设消息、请求头…),md 用于整栏/整页。
 * 各页不再各写一份 `border-dashed p-?`。
 */
export function SettingsEmpty({
  size = "sm",
  icon,
  children,
  className,
}: {
  size?: "sm" | "md";
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-[var(--ds-radius-md)] border border-dashed border-[var(--ds-divider)] text-center text-sm text-[var(--ds-text-secondary)]",
        size === "sm" ? "p-4" : "p-8",
        className,
      )}
    >
      {icon != null ? <span className="text-[var(--ds-icon)] opacity-60 [&>svg]:size-8">{icon}</span> : null}
      {children}
    </div>
  );
}

/**
 * 页尾的「高级设置」一节:触发器就是这一节的标题行(常显),内容收起时整段不渲染。
 * open/onOpenChange 由调用方持有——切换列表条目时不收起、离开页面(重挂载)才复位。
 */
export function SettingsAdvancedSection({
  open,
  onOpenChange,
  attention = false,
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  attention?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const id = React.useId();
  // 页尾独立一节:上方一条细线把它立成段落分界,而不是飘在字段后面的一行小字。
  return (
    <section className={cn("border-t border-[var(--ds-divider)] pt-3", className)}>
      <SettingsAdvancedToggle
        open={open}
        onOpenChange={onOpenChange}
        controls={[id]}
        attention={attention}
        className="-ml-2.5"
      />
      <SettingsAdvancedRegion id={id} open={open} className="pt-1">
        {children}
      </SettingsAdvancedRegion>
    </section>
  );
}

export interface SettingsAddMenuItem {
  key: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  onSelect: () => void;
}

/**
 * 列表/详情页左栏顶部的「新增」:整宽描边按钮。传 items 时点开是一个下拉菜单(选类型或
 * 选来源),不传则直接触发 onClick。各页一律用它,不再各写一遍按钮 + Select。
 */
export function SettingsListAddButton({
  label,
  onClick,
  items,
  icon,
  disabled,
}: {
  label: React.ReactNode;
  onClick?: () => void;
  items?: readonly SettingsAddMenuItem[];
  icon?: React.ReactNode;
  disabled?: boolean;
}) {
  const leading = icon ?? <Plus className="size-4" />;
  // 选中某项后焦点归该动作所有(打开对话框、弹文件选择框):菜单关闭动画结束时 Radix 默认把
  // 焦点还给触发按钮,会把刚打开的对话框里的焦点抢走,故此时不归还。
  const pickedRef = React.useRef(false);
  if (!items) {
    return (
      <Button className="mb-1 w-full justify-start" variant="tertiary" onClick={onClick} disabled={disabled}>
        {leading}
        {label}
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="mb-1 w-full justify-start" variant="tertiary" disabled={disabled}>
          {leading}
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          <ChevronDown aria-hidden className="size-4 text-[var(--ds-icon)]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-80 min-w-(--radix-dropdown-menu-trigger-width)"
        onCloseAutoFocus={(event) => {
          if (pickedRef.current) event.preventDefault();
          pickedRef.current = false;
        }}
      >
        {items.map((item) => (
          <DropdownMenuItem
            key={item.key}
            onSelect={() => {
              pickedRef.current = true;
              item.onSelect();
            }}
          >
            {item.icon ?? null}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 键值对的一行。 */
export interface SettingsKeyValue {
  key: string;
  value: string;
}

/**
 * 可增删的键值列表(请求头等):一行一条「名称 | 值 | 删除」,标题行右侧「添加」。
 * 只管形状为 {key,value} 的视图数据,持久化形状由调用方在读写边界换算。
 */
export function SettingsKeyValueList({
  label,
  description,
  items,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  emptyText,
  removeLabel,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  items: readonly SettingsKeyValue[];
  onChange: (items: SettingsKeyValue[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  emptyText: string;
  removeLabel: string;
}) {
  const { t } = useTranslation();
  const update = (index: number, patch: Partial<SettingsKeyValue>) =>
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  return (
    <SettingsField
      label={label}
      description={description}
      trailing={
        <Button type="button" size="compact" variant="tertiary" onClick={() => onChange([...items, { key: "", value: "" }])}>
          <Plus className="size-4" />
          {t("settings:common.add")}
        </Button>
      }
    >
      {items.length === 0 ? (
        <SettingsEmpty>
          {emptyText}
        </SettingsEmpty>
      ) : (
        <div className="space-y-2">
          {items.map((item, index) => (
            <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] items-center gap-2">
              <Input
                value={item.key}
                onChange={(event) => update(index, { key: event.target.value })}
                placeholder={keyPlaceholder}
                aria-label={keyPlaceholder}
              />
              <Input
                value={item.value}
                onChange={(event) => update(index, { value: event.target.value })}
                placeholder={valuePlaceholder}
                aria-label={valuePlaceholder}
              />
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={removeLabel}
                title={removeLabel}
                onClick={() => onChange(items.filter((_, i) => i !== index))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </SettingsField>
  );
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
        <div data-settings-item="" className="flex min-h-7 items-start justify-between gap-4">
          <div className="min-w-0">
            {title != null ? (
              <h2 data-settings-label="" className="text-xs font-semibold leading-7 text-[var(--ds-text-secondary)]">{title}</h2>
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
    <div data-settings-item="" className={cn("py-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-[min(12rem,100%)] flex-1">
          <Label
            data-settings-label=""
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
    <div data-settings-item="" className={cn("space-y-2", className)}>
      <div className="flex min-h-5 items-center justify-between gap-3">
        <div className="min-w-0">
          <Label data-settings-label="" htmlFor={htmlFor} className="block text-sm font-medium text-[var(--ds-text-primary)]">
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
 *
 * `scroll`:双栏各自独立滚动——鼠标在哪栏就只滚哪栏(overscroll-contain:栏内滚到头
 * 即止,不带动宿主)。前提:宿主是停靠页容器(settings-registry 的 SETTINGS_DOCKED_PAGES
 * 声明,两套外壳都是「定高 flex 列」,height:100% 才解析得到确定值)。两处类放法有讲究:
 * 根上用**普通** h-full(容器查询变体在 container 元素自己身上是死代码——@container 查询
 * 的是祖先容器,本组件正是断点容器,祖先没有容器则变体永不激活);@2xl: 变体全部下沉到
 * grid 层(grid 不是容器,查询容器=本组件根,断点语义与栏内类一致)。页面把 Split 包进
 * fragment 也无妨(h-full 在每个流内子项上各自解析,Dialog 走 portal 不占位)。Split 外
 * 还有整页级兄弟内容的页面(语音朗读页的「朗读过滤」)别开——兄弟内容与栏内滚动两套滚
 * 轴打架。堆叠形态(@2xl 以下)自动退回宿主整页滚动:窄栏里再塞根栏内滚动条只会裁内容。
 * 栏内滚动条不显示(滚轮仍有效)——双栏各自一根细条与宿主滚动观感重复,而堆叠形态下
 * 滚动权本就归宿主,栏内隐藏类不该在窄屏生效,故挂在无条件类位(无 @2xl: 前缀也无妨,
 * 堆叠时栏内 overflow 类本身不生效,隐藏滚动条无处生效)。
 */
export function SettingsSplit({
  list,
  children,
  scroll = false,
}: {
  list: React.ReactNode;
  children: React.ReactNode;
  /** 见上方注释:仅当本组件独占页面主区时开启。 */
  scroll?: boolean;
}) {
  return (
    <div className={cn("@container", scroll && "min-h-0 h-full")}>
      <div
        className={cn(
          "grid gap-6 @2xl:grid-cols-[17.5rem_minmax(0,1fr)] @2xl:gap-0",
          scroll && "@2xl:min-h-0 @2xl:h-full",
        )}
      >
        <div
          className={cn(
            "min-w-0 @2xl:border-r @2xl:border-[var(--ds-divider)] @2xl:pr-3",
            scroll &&
              "@2xl:min-h-0 @2xl:overflow-y-auto @2xl:overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          )}
        >
          {list}
        </div>
        <div
          className={cn(
            "min-w-0 @2xl:pl-6",
            scroll &&
              "@2xl:min-h-0 @2xl:overflow-y-auto @2xl:overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * 详情栏收尾行:左侧自动保存状态,右侧收尾动作。不画分隔线——删除已进列表行「⋯」菜单、
 * 自动保存 idle 态不渲染,多数时候这一行是空的,常驻细线会在页尾留下一条孤线。
 */
export function SettingsDetailFooter({ status, children }: { status?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">{status}</div>
      {children != null ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  );
}

/**
 * 详情栏的标题行:名称(+说明)+ 右侧动作。替代各详情卡顶部的手写 flex 头。
 * 传 onTitleCommit 则标题就地可改(取代紧跟在下面、把同一个名字再写一遍的「名称」输入框):
 * title 此时是原始名称串,titlePlaceholder 是空名时显示的兜底(类型默认名)。leading 放图标/头像。
 */
export function SettingsDetailHeader({
  title,
  description,
  action,
  leading,
  onTitleCommit,
  titlePlaceholder,
  titleLabel,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  leading?: React.ReactNode;
  onTitleCommit?: (next: string) => void;
  titlePlaceholder?: string;
  /** 可编辑标题的无障碍名(「名称」)。 */
  titleLabel?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        {leading}
        <div className="min-w-0">
          {onTitleCommit ? (
            <h2 className="flex min-w-0">
              <InlineEditText
                value={typeof title === "string" ? title : ""}
                placeholder={titlePlaceholder}
                ariaLabel={titleLabel ?? titlePlaceholder ?? ""}
                className="text-base font-semibold"
                inputClassName="w-72 text-base"
                onCommit={onTitleCommit}
              />
            </h2>
          ) : (
            <h2 className="truncate text-base font-semibold text-[var(--ds-text-primary)]">{title}</h2>
          )}
          {description != null ? (
            <p className="mt-0.5 text-xs text-[var(--ds-text-secondary)]">{description}</p>
          ) : null}
        </div>
      </div>
      {action != null ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

/**
 * 设置列表的一行(可排序 + 选择 + 右键/悬停「⋯」删除菜单)。
 *
 * 删除能力收口到行上,详情页不再放删除键——对齐主页会话列表的交互心智:
 *   - 右键任意一行 → 打开该行的操作菜单;
 *   - 悬停/聚焦某行 → 行尾浮现「⋯」钮,点开同一个菜单。
 * 两者打开的是**同一个受控 DropdownMenu**(菜单项就是「删除」),材质沿用 ds-menu。
 *
 * `badge` 是行尾的常驻徽标(如供应商的「订阅」):常态显示徽标,悬停/聚焦/菜单打开时
 * 让位给「⋯」钮——同位互换,不并排抢位。删除走 onDelete(按本行 id,而非详情草稿),
 * 确认对话框与各页的防复活时序由调用方的 onDelete 实现;disabled 时整条不弹菜单。
 */
export function SettingsListRow({
  id,
  index,
  active,
  children,
  onSelect,
  onMove,
  onDelete,
  badge,
}: {
  id: string;
  index: number;
  active?: boolean;
  children: React.ReactNode;
  onSelect?: () => void;
  onMove?: (from: number, to: number) => void;
  /** 提供则启用删除菜单(右键 + 悬停「⋯」);onDelete 内部应自行确认与落库。 */
  onDelete?: () => void | Promise<void>;
  /** 行尾常驻徽标(与「⋯」同位互换);不供删除菜单时也可单独用作纯展示徽标。 */
  badge?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [over, setOver] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const canMove = typeof onMove === "function";
  const canDelete = typeof onDelete === "function";
  const showTrigger = canDelete;

  const runDelete = React.useCallback(() => {
    // 菜单先关,删除动作(通常自带确认对话框)再执行,避免菜单与对话框焦点叠压。
    setMenuOpen(false);
    void onDelete?.();
  }, [onDelete]);

  // 徽标↔「⋯」互换的显隐:菜单打开态靠行根的 data-menu 标志兜底——徽标与「⋯」各自包了
  // span、不是兄弟,跨元素 peer 够不着;状态挂在共同祖先上,菜单开着时「⋯」不缩回、徽标让位。
  return (
    <DropdownMenu
      open={menuOpen}
      onOpenChange={(open) => {
        setMenuOpen(open);
        // 菜单关闭时 Radix 把焦点还给「⋯」触发钮:若该焦点是鼠标点按留下的(:focus 而非
        // :focus-visible),行根的 :focus-visible-within 命中会让「⋯」在菜单已关后仍滞留常显。
        // 主动 blur 收回焦点——键盘用户(:focus-visible)不受影响,仍保有焦点可见性。
        if (!open && triggerRef.current?.matches(":focus")) {
          triggerRef.current.blur();
        }
      }}
    >
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
        onContextMenu={(event) => {
          if (!canDelete) return;
          event.preventDefault();
          setMenuOpen(true);
        }}
        // group/settings-row:行尾的徽标↔「⋯」互换、悬停显隐都以它为作用域。
        // data-menu:菜单打开态挂在这个共同祖先上,徽标与「⋯」都按它显隐——它俩不是兄弟
        // (各包了 span),跨元素 peer 选择器够不着,菜单开着徽标不会隐、会重叠。
        data-menu={menuOpen ? "open" : undefined}
        className={[
          "group/settings-row flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition",
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

        {/* 行尾槽:常驻徽标与「⋯」触发钮同位(grid 叠放),悬停/聚焦/菜单打开时互换。
            「⋯」后渲染,叠在上层(网格同位后出者压先出者),保证始终可点——不被徽标挡住。 */}
        {badge != null || showTrigger ? (
          <span className="relative ml-auto grid shrink-0 place-items-center">
            {badge != null ? (
              <span
                className={cn(
                  // 徽标纯展示,永不参与命中:opacity<1 自成 stacking context,绘制在普通流之上
                  // (CSS 绘制顺序),让位中的徽标(视觉已隐)会盖住同格的「⋯」拦截点击——
                  // 不加 pointer-events-none 时订阅行的「⋯」点不到就是它。
                  "col-start-1 row-start-1 inline-flex items-center transition-opacity pointer-events-none",
                  // 有删除钮时:常态让位给「⋯」(悬停/键盘聚焦),打开态靠行根的数据标志(见下)。
                  showTrigger && "group-focus-visible-within/settings-row:opacity-0 group-hover/settings-row:opacity-0 group-data-[menu=open]/settings-row:opacity-0",
                )}
              >
                {badge}
              </span>
            ) : null}
            {showTrigger ? (
              <DropdownMenuTrigger asChild>
                <button
                  ref={triggerRef}
                  type="button"
                  aria-label={t("settings:common.item_actions")}
                  title={t("settings:common.item_actions")}
                  onClick={(event) => event.stopPropagation()}
                  className={cn(
                    "col-start-1 row-start-1 inline-flex size-6 items-center justify-center rounded-[var(--ds-radius-sm)] text-[var(--ds-text-secondary)] outline-none transition-opacity hover:bg-[var(--ds-on-surface)] hover:text-[var(--ds-text-primary)] focus-visible:ring-2 focus-visible:ring-ring/50",
                    // 悬停/键盘聚焦/菜单打开时浮现。用 focus-visible-within(非 focus-within):只认键盘
                    // 焦点——鼠标点按「⋯」留下的 :focus 不该让「⋯」常显,否则菜单关闭焦点还原后滞留。
                    // 菜单打开走行根的 data-menu(标志在共同祖先上,不依赖跨元素 peer——徽标与「⋯」
                    // 各自包了 span、非兄弟,peer 够不着)。
                    "opacity-0 group-focus-visible-within/settings-row:opacity-100 group-hover/settings-row:opacity-100 group-data-[menu=open]/settings-row:opacity-100",
                  )}
                >
                  <MoreHorizontal className="size-4" />
                </button>
              </DropdownMenuTrigger>
            ) : null}
          </span>
        ) : null}
      </div>

      {canDelete ? (
        <DropdownMenuContent side="right" align="start" className="w-44">
          <DropdownMenuItem variant="destructive" onSelect={runDelete}>
            <Trash2 className="size-4" />
            <span>{t("settings:common.delete")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      ) : null}
    </DropdownMenu>
  );
}
