import * as React from "react";
import { useTranslation } from "react-i18next";

import { cn } from "~/lib/utils";

export function getConversationMessageAnchorId(messageId: string): string {
  return `message-anchor-${messageId}`;
}

export interface ConversationQuickJumpItem {
  id: string;
  role: string;
  preview?: string;
}

interface ConversationQuickJumpProps {
  items: ConversationQuickJumpItem[];
  /** 当前视口顶部消息的下标(由虚拟列表的 rangeChanged 提供)。虚拟化后无法用 DOM anchor
   * 精确算"滚动线上方最后一条",用视口顶部 startIndex 近似,语义足够定位。 */
  activeIndex: number;
  /** 点击某条时跳转;由父组件桥接到虚拟列表的 scrollToIndex。 */
  onItemClick: (index: number) => void;
}

function getRoleLineClass(role: string): string {
  const normalizedRole = role.toUpperCase();
  if (normalizedRole === "USER") {
    return "bg-primary/35 hover:bg-primary/60";
  }

  if (normalizedRole === "ASSISTANT") {
    return "bg-foreground/25 hover:bg-foreground/50";
  }

  return "bg-muted hover:bg-foreground/40";
}

function getRoleDotClass(role: string): string {
  const normalizedRole = role.toUpperCase();
  if (normalizedRole === "USER") {
    return "bg-primary";
  }

  if (normalizedRole === "ASSISTANT") {
    return "bg-foreground";
  }

  return "bg-foreground/80";
}

function getRoleLabel(
  role: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const normalizedRole = role.toUpperCase();
  if (normalizedRole === "USER") return t("quick_jump.role_user");
  if (normalizedRole === "ASSISTANT") return t("quick_jump.role_assistant");
  return t("quick_jump.role_message");
}

// C 族闪动/大会话性能修复:行组件 memo 化。此前每轮包一个 Radix Tooltip(带
// context/state 的真组件),数千轮会话 = 数千个实例,挂载即卡数百 ms,且父组件
// 每次重渲染(如流式期间)全量重画。现在行是纯展示按钮,预览浮层收敛为组件级
// 单例(见下方 hover 面板):实例数 O(n)→O(1),active 变化只重画新旧两行。
const QuickJumpRow = React.memo(function QuickJumpRow({
  item,
  index,
  isActive,
  onItemClick,
  onHover,
  onLeave,
}: {
  item: ConversationQuickJumpItem;
  index: number;
  isActive: boolean;
  onItemClick: (index: number) => void;
  onHover: (index: number, el: HTMLElement) => void;
  onLeave: () => void;
}) {
  const { t } = useTranslation();
  const roleLabel = getRoleLabel(item.role, t);

  return (
    <button
      type="button"
      data-jump-index={index}
      className="flex w-8 items-center justify-start gap-1 transition-colors"
      aria-label={t("quick_jump.jump_to_message", {
        index: index + 1,
        role: roleLabel,
      })}
      onClick={() => {
        onItemClick(index);
      }}
      onMouseEnter={(event) => onHover(index, event.currentTarget)}
      onFocus={(event) => onHover(index, event.currentTarget)}
      onMouseLeave={onLeave}
      onBlur={onLeave}
    >
      <span
        className={cn(
          "h-1.5 w-5 rounded-full transition-colors",
          getRoleLineClass(item.role),
          isActive && "bg-foreground/80",
        )}
      />
      <span
        className={cn(
          "size-1.5 rounded-full transition-opacity duration-200",
          getRoleDotClass(item.role),
          isActive ? "animate-pulse opacity-100" : "opacity-0",
        )}
      />
    </button>
  );
});

export const ConversationQuickJump = React.memo(function ConversationQuickJump({
  items,
  activeIndex,
  onItemClick,
}: ConversationQuickJumpProps) {
  const { t } = useTranslation();
  const canQuickJump = items.length > 1;
  const safeActiveIndex = Math.max(0, Math.min(activeIndex, items.length - 1));
  const listRef = React.useRef<HTMLDivElement>(null);
  const [fixedStyle, setFixedStyle] = React.useState<React.CSSProperties | null>(null);


  // 用 ResizeObserver 监听消息容器尺寸变化,动态计算 fixed 定位位置。
  // 消息在 Virtuoso 内以 max-w-3xl mx-auto 居中,滚动条出现时消息内容区会缩窄,
  // 但本组件用 position:fixed 定位,不依赖外层容器的坐标系,因此不受滚动条影响。
  React.useLayoutEffect(() => {
    const updatePosition = () => {
      // 找外层容器:position:relative 且 flex-1 且 min-h-0 的父级
      // (就是原来 QuickJump 的 absolute 定位参考的那个容器)
      const anchor = document.querySelector('[id^="message-anchor-"]');
      if (!anchor) return;
      let outer: HTMLElement | null = anchor.parentElement;
      for (let i = 0; i < 15 && outer; i++) {
        if (outer.classList.contains("flex-1") && outer.classList.contains("min-h-0")) {
          break;
        }
        outer = outer.parentElement;
      }
      if (!outer) return;

      const outerRect = outer.getBoundingClientRect();
      // 消息内容 max-w-3xl = 768px,在 outer 内 mx-auto 居中
      const contentWidth = Math.min(outerRect.width, 768);
      // 内容的右边缘(视口坐标系,不含 padding——因为 px-4 是 padding,内容的实际右边缘)
      const contentRight = outerRect.left + (outerRect.width + contentWidth) / 2;
      // 水平:内容右边缘向右偏移(根据视觉拖拽校正,+72.5px)
      const right = window.innerWidth - contentRight - 67.5;
      // 垂直:消息区域的上下边界各留一些内边距
      const top = outerRect.top + 16;
      const bottom = window.innerHeight - outerRect.bottom + 16;
      setFixedStyle({ right, top, bottom });
    };

    // 若消息尚未渲染(首次 mount 时 items 为空),几帧内重试
    let retries = 0;
    const tryUpdate = () => {
      if (document.querySelector('[id^="message-anchor-"]')) {
        updatePosition();
      } else if (retries < 10) {
        retries++;
        requestAnimationFrame(tryUpdate);
      }
    };
    tryUpdate();

    window.addEventListener("resize", updatePosition);

    const ro = new ResizeObserver(updatePosition);
    const anchor = document.querySelector('[id^="message-anchor-"]');
    if (anchor) {
      ro.observe(anchor);
      let scrollParent: HTMLElement | null = anchor.parentElement;
      for (let i = 0; i < 10 && scrollParent; i++) {
        const style = window.getComputedStyle(scrollParent);
        if (style.overflowY === "auto" || style.overflowY === "scroll") {
          ro.observe(scrollParent);
          break;
        }
        scrollParent = scrollParent.parentElement;
      }
    }

    return () => {
      window.removeEventListener("resize", updatePosition);
      ro.disconnect();
    };
  }, [items]);

  // 单例悬停预览面板(替代逐行 Radix Tooltip):记录悬停行下标与锚点坐标,渲染一个
  // fixed 定位的浮层。视觉样式对齐 ui/tooltip.tsx 的 TooltipContent(去箭头)。
  const [hovered, setHovered] = React.useState<{
    index: number;
    left: number;
    top: number;
  } | null>(null);

  const handleHover = React.useCallback((index: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    setHovered({ index, left: rect.left - 8, top: rect.top + rect.height / 2 });
  }, []);

  const clearHover = React.useCallback(() => setHovered(null), []);

  // 条目区是一个独立可滚动列表(滚轮在其上自由浏览任意轮次)。active-follow 用 nearest 语义:
  // 当前轮次已可见就不动,只有要滑出可见区时才贴边滚入,绝不强居中。因此"滚轮自由浏览段数条"
  // (不改 active)完全不被打扰——可一路滚到第一条;"会话滚动让 active 变化"时贴边跟随,
  // 当前轮次始终可见。只动 list.scrollTop,不触发会话主区滚动。
  React.useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const activeEl = list.querySelector<HTMLElement>(`[data-jump-index="${safeActiveIndex}"]`);
    if (!activeEl) return;
    const listRect = list.getBoundingClientRect();
    const activeRect = activeEl.getBoundingClientRect();
    const activeTop = activeRect.top - listRect.top;
    const activeBottom = activeTop + activeRect.height;
    if (activeTop < 0) {
      list.scrollTop += activeTop;
    } else if (activeBottom > list.clientHeight) {
      list.scrollTop += activeBottom - list.clientHeight;
    }
  }, [safeActiveIndex]);

  if (!canQuickJump) {
    return null;
  }

  const hoveredItem = hovered ? items[hovered.index] : undefined;

  return (
    <div
      className="pointer-events-none fixed z-30 hidden lg:block"
      style={fixedStyle ?? { display: "none" }}
    >
      <div className="pointer-events-auto flex h-full flex-col justify-center">
        <div
          ref={listRef}
          className="flex min-h-0 flex-col items-start gap-1 overflow-y-auto"
          onMouseLeave={clearHover}
        >
          {items.map((item, index) => (
            <QuickJumpRow
              key={`quick-jump-${item.id}`}
              item={item}
              index={index}
              isActive={index === safeActiveIndex}
              onItemClick={onItemClick}
              onHover={handleHover}
              onLeave={clearHover}
            />
          ))}
          <div className="mt-1 w-5 text-center text-[0.625rem] text-muted-foreground/80 tabular-nums">
            {safeActiveIndex + 1}/{items.length}
          </div>
        </div>
      </div>
      {hovered && hoveredItem ? (
        <div
          className="pointer-events-none fixed z-50 max-w-64 -translate-x-full -translate-y-1/2 rounded-md bg-foreground px-3 py-1.5 text-left text-xs text-balance text-background shadow-elevated"
          style={{ left: hovered.left, top: hovered.top }}
        >
          <div className="space-y-0.5">
            <div className="text-[0.6875rem] text-background/75">
              {hovered.index + 1}/{items.length} · {getRoleLabel(hoveredItem.role, t)}
            </div>
            <div>{hoveredItem.preview?.trim() || t("quick_jump.no_preview")}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
});
