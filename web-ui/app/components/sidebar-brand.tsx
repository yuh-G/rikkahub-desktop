// components/sidebar-brand.tsx — 侧边栏品牌行(问题7回访:设计延续)。
// 主界面/设置页/图像生成页三处同源:Logo + "RikkaHub" 字样,行内即窗口拖拽区
// (双击最大化,行为与窗控条一致)。品牌形态改动只动这里,三页同步生效。

import { cn } from "~/lib/utils";
import Logo from "~/components/logo";
import { windowDragRegionProps } from "~/components/window-controls";

export function SidebarBrandRow({ className }: { className?: string }) {
  return (
    <div className={cn("flex h-7 items-center", className)} {...windowDragRegionProps()}>
      <div className="flex min-w-0 items-center gap-2">
        <Logo className="size-5 shrink-0 text-primary" />
        <span className="truncate text-sm font-semibold text-[var(--ds-text-primary)]">RikkaHub</span>
      </div>
    </div>
  );
}
