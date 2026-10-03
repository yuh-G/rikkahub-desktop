// 胶囊分段控件:底槽 + 滑块。两个兄弟原语共用同一套外观与滑块测量,只在交互语义上分家——
//  · SegmentedTabs:导航语义(role=tablist)。切换无副作用,方向键"移动即选中"。
//  · SegmentedControl:表单值语义(role=radiogroup)。切换可能有代价(换算、提示、置脏),
//    方向键只移动焦点,Space/Enter/点击才提交。
// 尺寸一律用 rem:界面字号靠改根字号实现,px 字面量不随缩放,比例会失调。
import * as React from "react";

import { cn } from "~/lib/utils";

export interface SegmentedItem<T extends string> {
  value: T;
  label: React.ReactNode;
  disabled?: boolean;
  /**
   * 把该项的按钮包一层(仅 SegmentedControl 生效),典型用法是 `<DropdownMenuTrigger asChild>`,
   * 让一个分段同时是下拉菜单的触发器。按钮的 ref/事件经 asChild 合并,滑块测量不受影响。
   * 包裹后点击不再直接提交该项:提交交给包裹者(菜单里选定才算数,点开又关掉不改值)。
   */
  wrap?: (button: React.ReactElement) => React.ReactNode;
}

type SegmentedSize = "sm" | "default";

const CONTAINER_SIZE: Record<SegmentedSize, string> = {
  sm: "h-7 p-[0.125rem]",
  default: "h-8 p-[0.1875rem]",
};
const ITEM_SIZE: Record<SegmentedSize, string> = {
  sm: "h-6 px-2.5",
  default: "h-[1.625rem] px-3",
};

interface Indicator {
  left: number;
  top: number;
  width: number;
  height: number;
  animated: boolean;
}

/**
 * 量选中项的位置画滑块。首帧不动画(否则从 0 滑入);之后切换走过渡;容器尺寸变化
 * (字号缩放、语言切换)只重量不动画。
 */
function useSegmentIndicator(selectedIndex: number) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const itemRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const selectedRef = React.useRef(selectedIndex);
  selectedRef.current = selectedIndex;
  const [indicator, setIndicator] = React.useState<Indicator | null>(null);

  const measure = React.useCallback((animate: boolean) => {
    const item = itemRefs.current[selectedRef.current];
    if (!item) {
      setIndicator(null);
      return;
    }
    setIndicator((prev) => ({
      left: item.offsetLeft,
      top: item.offsetTop,
      width: item.offsetWidth,
      height: item.offsetHeight,
      animated: animate && prev !== null,
    }));
  }, []);

  React.useLayoutEffect(() => measure(true), [selectedIndex, measure]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure(false));
    observer.observe(container);
    return () => observer.disconnect();
  }, [measure]);

  return { containerRef, itemRefs, indicator };
}

function SegmentedTrack({
  size,
  stretch,
  className,
  indicator,
  containerRef,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  size: SegmentedSize;
  stretch: boolean;
  indicator: Indicator | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={containerRef}
      className={cn(
        "relative items-center rounded-[var(--ds-radius-pill)] bg-[var(--ds-on-surface)]",
        stretch ? "flex w-full" : "inline-flex",
        CONTAINER_SIZE[size],
        className,
      )}
      {...props}
    >
      {indicator && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute rounded-[var(--ds-radius-pill)] bg-[var(--ds-surface-100)] shadow-[var(--ds-elevation-100)]",
            indicator.animated &&
              "transition-[left,width] duration-(--ds-duration-base) ease-(--ds-ease-soft) motion-reduce:transition-none",
          )}
          style={{ left: indicator.left, top: indicator.top, width: indicator.width, height: indicator.height }}
        />
      )}
      {children}
    </div>
  );
}

function itemClassName(size: SegmentedSize, stretch: boolean, selected: boolean) {
  return cn(
    "relative z-[1] inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-[var(--ds-radius-pill)] text-xs font-medium leading-none outline-none",
    "transition-colors duration-(--ds-duration-fast) ease-(--ds-ease-swift) focus-visible:ring-2 focus-visible:ring-ring/50",
    "disabled:cursor-not-allowed disabled:opacity-40",
    ITEM_SIZE[size],
    stretch && "flex-1",
    selected
      ? "text-[var(--ds-text-primary)]"
      : "text-[var(--ds-icon)] hover:text-[var(--ds-text-secondary)]",
  );
}

/** 从 from 起按方向找下一个可用项(循环);全部禁用时返回 from。 */
function stepIndex<T extends string>(items: readonly SegmentedItem<T>[], from: number, key: string): number | null {
  const count = items.length;
  if (count === 0) return null;
  const enabled = (index: number) => !items[index]?.disabled;
  const scan = (start: number, delta: number) => {
    for (let i = 0, index = start; i < count; i += 1, index = (index + delta + count) % count) {
      if (enabled(index)) return index;
    }
    return from;
  };
  switch (key) {
    case "ArrowRight":
      return scan((from + 1) % count, 1);
    case "ArrowLeft":
      return scan((from - 1 + count) % count, -1);
    case "Home":
      return scan(0, 1);
    case "End":
      return scan(count - 1, -1);
    default:
      return null;
  }
}

interface SegmentedBaseProps<T extends string> {
  items: readonly SegmentedItem<T>[];
  value: T | null;
  onChange: (value: T) => void;
  size?: SegmentedSize;
  /** 撑满父容器宽度,各项等分。 */
  stretch?: boolean;
  className?: string;
  "aria-label"?: string;
}

/** 导航用的分段标签(二级标签栏、页内板块切换)。方向键移动即选中。 */
export function SegmentedTabs<T extends string>({
  items,
  value,
  onChange,
  size = "default",
  stretch = false,
  className,
  controls,
  ...aria
}: SegmentedBaseProps<T> & {
  /** 受本组标签控制的内容区 id(其上应标 role="tabpanel"),写进选中项的 aria-controls。 */
  controls?: string;
}) {
  const selectedIndex = items.findIndex((item) => item.value === value);
  const { containerRef, itemRefs, indicator } = useSegmentIndicator(selectedIndex);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const next = stepIndex(items, Math.max(0, selectedIndex), event.key);
    if (next === null) return;
    event.preventDefault();
    itemRefs.current[next]?.focus();
    if (next !== selectedIndex) onChange(items[next].value);
  };

  return (
    <SegmentedTrack
      role="tablist"
      aria-label={aria["aria-label"]}
      size={size}
      stretch={stretch}
      indicator={indicator}
      containerRef={containerRef}
      className={className}
      onKeyDown={onKeyDown}
    >
      {items.map((item, index) => {
        const selected = index === selectedIndex;
        return (
          <button
            key={item.value}
            ref={(element) => {
              itemRefs.current[index] = element;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={selected ? controls : undefined}
            tabIndex={selected || (selectedIndex < 0 && index === 0) ? 0 : -1}
            disabled={item.disabled}
            className={itemClassName(size, stretch, selected)}
            onClick={() => {
              if (!selected) onChange(item.value);
            }}
          >
            {item.label}
          </button>
        );
      })}
    </SegmentedTrack>
  );
}

/** 表单值用的分段单选。方向键只移焦点,Space/Enter/点击才提交——提交有代价时不会一键连环触发。 */
export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  size = "default",
  stretch = false,
  className,
  disabled = false,
  ...aria
}: SegmentedBaseProps<T> & { disabled?: boolean }) {
  const selectedIndex = items.findIndex((item) => item.value === value);
  const { containerRef, itemRefs, indicator } = useSegmentIndicator(selectedIndex);
  // 焦点所在项(roving tabindex);离开整组即复位,Tab 回来时落在选中项上。
  const [focusIndex, setFocusIndex] = React.useState<number | null>(null);
  const tabStop = focusIndex ?? (selectedIndex >= 0 ? selectedIndex : 0);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const next = stepIndex(items, tabStop, event.key);
    if (next === null) return;
    event.preventDefault();
    setFocusIndex(next);
    itemRefs.current[next]?.focus();
  };

  return (
    <SegmentedTrack
      role="radiogroup"
      aria-label={aria["aria-label"]}
      aria-disabled={disabled || undefined}
      size={size}
      stretch={stretch}
      indicator={indicator}
      containerRef={containerRef}
      className={className}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusIndex(null);
      }}
    >
      {items.map((item, index) => {
        const selected = index === selectedIndex;
        const button = (
          <button
            key={item.value}
            ref={(element) => {
              itemRefs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={index === tabStop ? 0 : -1}
            disabled={disabled || item.disabled}
            className={itemClassName(size, stretch, selected)}
            onFocus={() => setFocusIndex(index)}
            onClick={() => {
              if (!selected && !item.wrap) onChange(item.value);
            }}
          >
            {item.label}
          </button>
        );
        return item.wrap ? <React.Fragment key={item.value}>{item.wrap(button)}</React.Fragment> : button;
      })}
    </SegmentedTrack>
  );
}
