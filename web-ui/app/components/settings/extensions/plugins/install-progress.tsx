// 插件安装的进度环:每一段各走一圈(下载 → 安装 → 检查),进入新的一段环从零重新走;悬停(或键盘聚焦)看是哪一段、
// 数到多少。计数是包管理器自己报的(engines/bun-install-progress.ts)。下载段的总数边解析边涨,所以同一段里环只进不退:
// 新的总数让比例变小时停在原处等计数追上。没有计数(刚开始、检查段、不经包管理器的安装)时是一小段弧在转。
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { usePluginsViewStore } from "~/stores/plugins-view-store";
import type { PluginInstallProgressDto } from "~/types/plugins";

const PHASES: PluginInstallProgressDto["phase"][] = ["download", "install", "check"];
const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** 这一段的比例(0–1);没有计数为 null。 */
export function progressFraction(progress: PluginInstallProgressDto | undefined): number | null {
  if (!progress || progress.total <= 0) return null;
  return Math.min(1, Math.max(0, progress.done / progress.total));
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 悬停说明:第几步、在做什么、数到多少;下载段另起一行写正在取的包。 */
export function progressLabel(progress: PluginInstallProgressDto | undefined, t: Translate): string {
  if (!progress) return t("settings:plugins.progress.starting");
  const step = t("settings:plugins.progress.step", { step: PHASES.indexOf(progress.phase) + 1, total: PHASES.length });
  const counted = progress.total > 0 && progress.phase !== "check";
  const what = counted
    ? t(`settings:plugins.progress.${progress.phase}_count`, { done: progress.done, total: progress.total })
    : t(`settings:plugins.progress.${progress.phase}`);
  return progress.phase === "download" && progress.item ? `${step} · ${what}\n${progress.item}` : `${step} · ${what}`;
}

function useInstallProgress(busyKey: string) {
  return usePluginsViewStore((state) => state.installProgress[busyKey]);
}

/** 同一段里只前进;换段从零开始。 */
function useShownFraction(progress: PluginInstallProgressDto | undefined): number | null {
  const shown = React.useRef<{ phase: string; value: number } | null>(null);
  const fraction = progressFraction(progress);
  if (fraction === null || !progress) {
    shown.current = progress ? { phase: progress.phase, value: 0 } : null;
    return null;
  }
  const value = Math.max(shown.current?.phase === progress.phase ? shown.current.value : 0, fraction);
  shown.current = { phase: progress.phase, value };
  return value;
}

/** 环本身(跟随文字颜色),可以放进按钮里。 */
export function InstallProgressGlyph({ busyKey, className }: { busyKey: string; className?: string }) {
  return <ProgressGlyph progress={useInstallProgress(busyKey)} className={className} />;
}

export function ProgressGlyph({ progress, className }: { progress: PluginInstallProgressDto | undefined; className?: string }) {
  const fraction = useShownFraction(progress);
  return (
    <svg viewBox="0 0 16 16" className={cn("size-4 shrink-0 -rotate-90", className)} aria-hidden>
      <circle cx="8" cy="8" r={RADIUS} fill="none" stroke="currentColor" strokeWidth="2" opacity={0.2} />
      <circle
        // 换段时换一个元素:环从零开始走,而不是从满圈倒着退回去。
        key={progress?.phase ?? "start"}
        data-fraction={fraction ?? undefined}
        cx="8"
        cy="8"
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={fraction === null ? `${CIRCUMFERENCE * 0.25} ${CIRCUMFERENCE}` : `${CIRCUMFERENCE} ${CIRCUMFERENCE}`}
        strokeDashoffset={fraction === null ? 0 : CIRCUMFERENCE * (1 - fraction)}
        className={cn(
          "origin-center",
          fraction === null ? "animate-spin motion-reduce:animate-none" : "transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none",
        )}
      />
    </svg>
  );
}

/** 给进行中的东西(环、停用的按钮)加上悬停说明与进度语义;能用键盘聚焦。点它不冒泡(市场卡片整卡可点)。
 *  active = false 时原样渲染 children(按钮还没开始安装)。 */
export function InstallProgressTooltip({
  busyKey,
  active = true,
  className,
  children,
}: {
  busyKey: string;
  active?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const progress = useInstallProgress(busyKey);
  if (!active) return <>{children}</>;
  const fraction = progressFraction(progress);
  const label = progressLabel(progress, t as Translate);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
          tabIndex={0}
          className={cn("inline-flex shrink-0 items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/40", className)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="whitespace-pre-line">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** 图标位上的进度环(市场卡片的「+」、列表行尾)。 */
export function InstallProgressRing({ busyKey, className }: { busyKey: string; className?: string }) {
  return (
    <InstallProgressTooltip busyKey={busyKey} className={cn("size-8 justify-center text-[var(--ds-brand-primary)]", className)}>
      <InstallProgressGlyph busyKey={busyKey} />
    </InstallProgressTooltip>
  );
}

/** 同一个忙碌键也用于不经包管理器的动作(卸载、检查更新):有进度时是进度环,没有时是原来的转圈。 */
export function PluginBusyIndicator({ busyKey, className }: { busyKey: string; className?: string }) {
  const progress = useInstallProgress(busyKey);
  return progress ? <InstallProgressRing busyKey={busyKey} className={className} /> : <Spinner className="size-4 text-[var(--ds-text-tertiary)]" />;
}
