import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Card } from "~/components/ui/card";
import { cn } from "~/lib/utils";

interface ChainOfThoughtProps<T> extends React.ComponentProps<typeof Card> {
  steps: T[];
  collapsedVisibleCount?: number;
  /** 注意:返回的元素必须自带稳定 key(如 toolCallId)——步骤直接按数组渲染,
   *  不再用窗口内下标包 key,滑动窗口移动时已有步骤实例才能存活(状态不丢)。 */
  renderStep: (
    step: T,
    index: number,
    info: { isFirst: boolean; isLast: boolean },
  ) => React.ReactNode;
  collapseLabel?: React.ReactNode;
  showMoreLabel?: (hiddenCount: number) => React.ReactNode;
  /** 受控展开态(可选):传入后展开状态完全归调用方所有(配合会话级 store 实现
   *  "用户展开的大卡不被任何系统自动行为重置");不传则退回组件内部 state。 */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

interface ChainOfThoughtStepBaseProps {
  icon?: React.ReactNode;
  label: React.ReactNode;
  extra?: React.ReactNode;
  onClick?: () => void;
  children?: React.ReactNode;
  contentVisible?: boolean;
  className?: string;
  active?: boolean;
  isFirst?: boolean;
  isLast?: boolean;
}

interface ChainOfThoughtStepProps extends ChainOfThoughtStepBaseProps {
  defaultExpanded?: boolean;
}

interface ControlledChainOfThoughtStepProps extends ChainOfThoughtStepBaseProps {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

function ChainOfThought<T>({
  steps,
  collapsedVisibleCount = 2,
  renderStep,
  collapseLabel = "Collapse",
  showMoreLabel,
  className,
  expanded: controlledExpanded,
  onExpandedChange,
  ...props
}: ChainOfThoughtProps<T>) {
  const [innerExpanded, setInnerExpanded] = React.useState(false);
  const expanded = controlledExpanded ?? innerExpanded;
  const toggleExpanded = () => {
    const next = !expanded;
    onExpandedChange?.(next);
    if (controlledExpanded === undefined) setInnerExpanded(next);
  };
  const canCollapse = steps.length > collapsedVisibleCount;
  const visibleSteps = expanded || !canCollapse ? steps : steps.slice(-collapsedVisibleCount);
  const hiddenCount = Math.max(steps.length - collapsedVisibleCount, 0);

  return (
    <Card
      className={cn(
        "gap-0 rounded-2xl border-border/70 bg-card/85 px-2 py-2 shadow-sm",
        className,
      )}
      {...props}
    >
      {canCollapse && (
        <button
          type="button"
          className={cn(
            "text-primary hover:bg-muted/60 focus-visible:ring-ring/50 mb-1 flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-xs outline-none focus-visible:ring-[3px]",
          )}
          onClick={toggleExpanded}
        >
          <span className="flex w-6 items-center justify-center">
            <ChevronDown
              className={cn("size-4 transition-transform duration-200", expanded && "-rotate-180")}
            />
          </span>
          <span>
            {expanded
              ? collapseLabel
              : (showMoreLabel?.(hiddenCount) ?? `Show ${hiddenCount} more steps`)}
          </span>
        </button>
      )}

      <div>
        {/* 不用窗口内下标当 key:renderStep 返回的元素自带稳定 key(toolCallId 等),
            滑动窗口前移时已有步骤按身份匹配存活,运行中步骤的内部状态不被重建清空。 */}
        {visibleSteps.map((step, index) =>
          renderStep(step, index, {
            isFirst: index === 0,
            isLast: index === visibleSteps.length - 1,
          }),
        )}
      </div>
    </Card>
  );
}

function ChainOfThoughtStep({
  defaultExpanded = false,
  contentVisible,
  ...props
}: ChainOfThoughtStepProps) {
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  return (
    <ChainOfThoughtStepContent
      {...props}
      expanded={expanded}
      onExpandedChange={setExpanded}
      contentVisible={contentVisible ?? expanded}
    />
  );
}

function ControlledChainOfThoughtStep({
  expanded,
  onExpandedChange,
  contentVisible,
  ...props
}: ControlledChainOfThoughtStepProps) {
  return (
    <ChainOfThoughtStepContent
      {...props}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      contentVisible={contentVisible ?? expanded}
    />
  );
}

interface ChainOfThoughtStepContentProps extends ChainOfThoughtStepBaseProps {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  contentVisible: boolean;
}

function ChainOfThoughtStepContent({
  icon,
  label,
  extra,
  onClick,
  children,
  expanded,
  onExpandedChange,
  contentVisible,
  className,
  active,
  isFirst,
  isLast,
}: ChainOfThoughtStepContentProps) {
  const hasContent = Boolean(children);
  const clickable = Boolean(onClick || hasContent);

  const handleActivate = () => {
    if (onClick) {
      onClick();
      return;
    }
    if (hasContent) {
      onExpandedChange(!expanded);
    }
  };

  const rowClassName = cn(
    "relative flex w-full items-center gap-2 overflow-hidden rounded-xl px-2 py-2 text-left",
    clickable && "cursor-pointer outline-none",
    active && "rikkahub-step-shimmer bg-muted/60",
    className,
  );

  const stepClassName = cn(
    "flex w-full gap-2 rounded-xl",
    clickable && "hover:bg-muted/60 focus-within:ring-ring/50 focus-within:ring-[3px]",
  );

  const iconContent = icon ? (
    <div className="size-3.5">{icon}</div>
  ) : (
    <div className="bg-muted-foreground size-2 rounded-full" />
  );

  const indicator = onClick ? (
    <ChevronRight
      className={cn(
        "text-muted-foreground size-4 transition-transform duration-200",
        expanded && "rotate-90",
      )}
    />
  ) : hasContent ? (
    <ChevronDown
      className={cn(
        "text-muted-foreground size-4 transition-transform duration-200",
        expanded && "-rotate-180",
      )}
    />
  ) : null;

  return (
    <div className={stepClassName}>
      <div
        className={cn("flex w-6 shrink-0 flex-col items-center", clickable && "cursor-pointer")}
        onClick={clickable ? handleActivate : undefined}
      >
        <div className={cn("h-2 w-px shrink-0", isFirst === false && "bg-border/80")} />
        <div className="flex h-5 shrink-0 items-center justify-center">{iconContent}</div>
        <div className={cn("w-px flex-1", isLast === false && "bg-border/80")} />
      </div>

      <div className="min-w-0 flex-1">
        {clickable ? (
          <button type="button" className={rowClassName} onClick={handleActivate}>
            <span className="min-w-0 flex-1">{label}</span>
            {extra}
            {indicator}
          </button>
        ) : (
          <div className={rowClassName}>
            <span className="min-w-0 flex-1">{label}</span>
            {extra}
            {indicator}
          </div>
        )}

        {hasContent && (
          <div
            className="grid w-full transition-all duration-200 ease-out"
            style={{ gridTemplateRows: contentVisible ? "1fr" : "0fr" }}
          >
            <div className="overflow-hidden">
              <div className="px-1 pb-2 pt-1">{children}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export { ChainOfThought, ChainOfThoughtStep, ControlledChainOfThoughtStep };

export type { ChainOfThoughtProps, ChainOfThoughtStepProps, ControlledChainOfThoughtStepProps };
