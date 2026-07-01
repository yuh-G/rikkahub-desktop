import * as React from "react";
import { useTranslation } from "react-i18next";

import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
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

export function ConversationQuickJump({ items, activeIndex, onItemClick }: ConversationQuickJumpProps) {
  const { t } = useTranslation();
  const canQuickJump = items.length > 1;
  const safeActiveIndex = Math.max(0, Math.min(activeIndex, items.length - 1));
  const listRef = React.useRef<HTMLDivElement>(null);

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

  return (
    <div className="pointer-events-none absolute inset-y-0 left-1/2 z-20 hidden w-full max-w-3xl -translate-x-1/2 lg:block">
      <div className="pointer-events-auto absolute inset-y-4 -right-5 flex flex-col justify-center">
        <div
          ref={listRef}
          className="flex min-h-0 flex-col items-start gap-1 overflow-y-auto"
        >
          {items.map((item, index) => {
            const isActive = index === safeActiveIndex;
            const roleLabel = getRoleLabel(item.role, t);

            return (
              <Tooltip key={`quick-jump-${item.id}`}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    data-jump-index={index}
                    className="flex w-8 items-center justify-start gap-1 transition-colors"
                    aria-label={t("quick_jump.jump_to_message", {
                      index: index + 1,
                      role: roleLabel,
                    })}
                    title={t("quick_jump.message_title", { index: index + 1, role: roleLabel })}
                    onClick={() => {
                      onItemClick(index);
                    }}
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
                </TooltipTrigger>
                <TooltipContent side="left" sideOffset={8} className="max-w-64 text-left">
                  <div className="space-y-0.5">
                    <div className="text-[0.6875rem] text-background/75">
                      {index + 1}/{items.length} · {roleLabel}
                    </div>
                    <div>{item.preview?.trim() || t("quick_jump.no_preview")}</div>
                  </div>
                </TooltipContent>
              </Tooltip>
            );
          })}
          <div className="mt-1 w-5 text-center text-[0.625rem] text-muted-foreground/80 tabular-nums">
            {safeActiveIndex + 1}/{items.length}
          </div>
        </div>
      </div>
    </div>
  );
}
