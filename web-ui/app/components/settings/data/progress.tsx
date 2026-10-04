// components/settings/data/progress.tsx — 备份长任务进度条(本地导出/导入、WebDAV/S3 备份/恢复共用)。

import * as React from "react";
import { Progress } from "~/components/ui/progress";

/** 长任务进度:标题行(阶段文案 + 读数)+ 细进度条;percent 为 null 时为不确定态。 */
export function BackupProgress({
  label,
  detail,
  percent,
  hint,
}: {
  label: React.ReactNode;
  detail?: React.ReactNode;
  percent: number | null;
  hint?: React.ReactNode;
}) {
  return (
    <div className="mt-3 space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-xs text-[var(--ds-text-secondary)]">
        <span className="min-w-0 truncate">{label}</span>
        {detail != null ? <span className="shrink-0 tabular-nums">{detail}</span> : null}
      </div>
      <Progress value={percent} />
      {hint != null ? <div className="text-mini text-[var(--ds-text-tertiary)]">{hint}</div> : null}
    </div>
  );
}
