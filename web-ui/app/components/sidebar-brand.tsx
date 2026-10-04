// components/sidebar-brand.tsx — 侧边栏品牌行(问题7回访:设计延续)。
// 主界面/设置页/图像生成页三处同源:Logo + "RikkaHub" 字样,行内即窗口拖拽区
// (双击最大化,行为与窗控条一致)。品牌形态改动只动这里,三页同步生效。

import { cn } from "~/lib/utils";
import Logo from "~/components/logo";
import { windowDragRegionProps } from "~/components/window-controls";

export function SidebarBrandRow({ className }: { className?: string }) {
  return (
    <div className={cn("flex h-7 items-center", className)} {...windowDragRegionProps()}>
      {/* data-titlebar-brand-content:设置模态的顶带替身只把这一条内容点亮可见
          (Logo+品牌名),不点亮整块拖拽区壳——替身拖拽区壳若可见,会透出遮罩的
          模糊/压暗,裹出一圈暗影(见 app.css 的 [data-titlebar-overlay] 规则组)。 */}
      <div data-titlebar-brand-content="" className="flex min-w-0 items-center gap-2">
        <Logo className="size-5 shrink-0 text-primary" />
        <span className="truncate text-sm font-semibold text-[var(--ds-text-primary)]">RikkaHub</span>
      </div>
    </div>
  );
}
