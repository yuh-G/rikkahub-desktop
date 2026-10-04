// 设置模态打开时的「顶带替身」:一条常驻挂载的 invisible 层。设置模态的本体遮罩
// (Radix Overlay)以 z-index 压住真实顶带,其 backdrop-filter 让顶带随内容一起毛玻璃;
// 本替身在更高 z-index 复刻一遍品牌行与 [-口×](走共享的 SidebarBrandRow /
// WindowControlsBar,与真实顶带逐字同源),保持清晰、可点。
//
// 为什么用 invisible + visibility:visible(而非 pointer-events 剪裁):模态打开时 Radix
// 给 body 挂 pointer-events:none(连同后代继承)。替身用 visibility 让自身恢复可见、
// 但命中判定仍「全层透明」,只让其中的按钮/链接/拖拽区可见命中——拖拽区是 div(非交互
// 选择器覆盖对象),它的拖拽靠 mousedown 自己收,借 visibility 这层壳豁免遮罩即可,
// 无需给替身自身开 pointer-events(那样会挡死整片视口点击)。见 app.css 的规则组。
import * as React from "react";

import { SidebarBrandRow } from "~/components/sidebar-brand";
import { WindowControlsBar, titlebarOverlayDragRegionProps } from "~/components/window-controls";
import { useSettingsDialogStore } from "~/stores/settings-dialog-store";

export function TitleBarOverlay() {
  const open = useSettingsDialogStore((state) => state.open);
  if (!open) return null;

  return (
    <div
      data-titlebar-overlay=""
      className="invisible fixed inset-x-0 top-0 h-[var(--app-band-h)]"
    >
      <div className="flex h-full items-center px-4" {...titlebarOverlayDragRegionProps()}>
        <SidebarBrandRow />
        <WindowControlsBar className="ml-auto mt-1.5" alwaysVisible />
      </div>
    </div>
  );
}
