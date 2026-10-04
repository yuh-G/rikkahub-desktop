// 设置模态打开时的「顶带替身」:一条常驻挂载的 fixed 层。设置模态的本体遮罩
// (Radix Overlay,z-50)以 z-index 压住真实顶带,其 backdrop-filter 让顶带随内容一起
// 毛玻璃;本替身在更高层复刻一遍品牌行与 [-口×](走共享的 SidebarBrandRow /
// WindowControlsBar,与真实顶带逐字同源),保持清晰、可点。
//
// 为什么替身要自带高 z-index(z-[90])而非靠「后挂载赢同层」:替身走的是
// 「自身命中透明、子元素可见命中」的细剪裁——替身壳始终 pointer-events:none,
// 只靠 visibility 把拖拽区/按钮点亮。它必须明确叠在 Radix Overlay(z-50)之上,
// 否则替身内的清晰 chrome 会被模态遮罩盖住(z 层低时),表现成「顶带跟着模糊、
// 窗控点不动」。z-[90] 高于 z-50,替身清晰层稳定居上。
//
// 为什么替身自身要 invisible(而非靠 pointer-events 剪裁到子元素):模态打开时 Radix
// 给 body 挂 pointer-events:none(连同后代继承)。替身壳自身保持 pointer-events:none
// (命中对整层透明、不挡视口点击),只把「拖拽区 + 按钮」点亮可见——拖拽区是 div
// (非交互选择器覆盖对象),它的拖拽靠 mousedown 自己收,借替身壳豁免遮罩即可。
// 见 app.css 的 [data-titlebar-overlay] 规则组。
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
      className="pointer-events-none invisible fixed inset-x-0 top-0 h-[var(--app-band-h)] z-[90]"
    >
      {/* 三页同源坐标与主界面顶带逐字对齐(conversations.tsx):外层 items-start,
          品牌行 ml-4 mt-1(左 16px / 距顶 4px),窗控 ml-auto mt-1.5 mr-2(右 8px)。
          替身与真实顶带共用 SidebarBrandRow / WindowControlsBar,坐标也复刻同一组
          工具类——主界面顶带坐标若调,这里跟着改,不出现第二份魔法数。 */}
      <div
        className="pointer-events-auto flex h-full items-start"
        {...titlebarOverlayDragRegionProps()}
      >
        <SidebarBrandRow className="ml-4 mt-1" />
        <WindowControlsBar className="ml-auto mt-1.5 mr-2" alwaysVisible />
      </div>
    </div>
  );
}
