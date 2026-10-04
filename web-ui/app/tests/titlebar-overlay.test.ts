// titlebar-overlay.test.ts — 设置模态「顶带替身」机制的行为锁。jsdom 不跑 Tailwind/层叠,
// 运行时渲染测不出,与 drag-reorder-projection.test.ts 同款:直接锁源码结构。
//
// 不变量(见 titlebar-overlay.tsx 与 app.css 头注):
//   1. 模态打开时,真实顶带(品牌行 + [-口×])随内容一起 backdrop-blur(遮罩全屏覆盖);
//      替身层在更高 z-index 复刻同一组 chrome 保持清晰。
//   2. 替身自身命中透明(不挡住视口点击);只有其中的拖拽区与按钮可见命中。
//   3. 替身的品牌行/窗控钮与真实顶带逐字同源(共享 SidebarBrandRow / WindowControlsBar),
//      不得在替身里另写一套 brand/window-controls 复制品(那会随主源漂移)。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const ROOT = join(import.meta.dir, ".."); // app/
const OVERLAY = readFileSync(join(ROOT, "components", "titlebar-overlay.tsx"), "utf8");
const DIALOG = readFileSync(join(ROOT, "components", "settings", "settings-dialog.tsx"), "utf8");
const WINDOW_CONTROLS = readFileSync(join(ROOT, "components", "window-controls.tsx"), "utf8");
const ROOT_TSX = readFileSync(join(ROOT, "root.tsx"), "utf8");
const CSS = readFileSync(join(ROOT, "app.css"), "utf8");

describe("设置模态顶带替身", () => {
  test("遮罩不再从顶带下缘起算(覆盖整屏让顶带毛玻璃)", () => {
    // 旧的「顶栏豁免」把遮罩 top 推到 --app-band-h 以下;替身方案要求遮罩盖住顶带。
    expect(DIALOG).not.toContain('style: { top: "var(--app-band-h)" }');
    expect(DIALOG).not.toContain("measureAppBandHeight");
    // data-settings-overlay 标记仍保留(替身方案沿用同一标记做识别,见 app.css)。
    expect(DIALOG).toContain('"data-settings-overlay": true');
  });

  test("替身常驻挂载于 root 且晚于 SettingsDialog(同层后挂载者居上)", () => {
    const idxSettings = ROOT_TSX.indexOf("<SettingsDialog />");
    const idxOverlay = ROOT_TSX.indexOf("<TitleBarOverlay />");
    expect(idxSettings, "root.tsx 需挂 SettingsDialog").toBeGreaterThan(-1);
    expect(idxOverlay, "root.tsx 需挂 TitleBarOverlay").toBeGreaterThan(-1);
    expect(idxOverlay, "替身须在 SettingsDialog 之后挂载,同 z 层时居上").toBeGreaterThan(idxSettings);
  });

  test("替身带显式高 z-index 且自身命中透明(靠 visibility 点亮子元素)", () => {
    // Radix Overlay/Content 是 z-50;替身必须明确高于它,否则替身内清晰的 chrome
    // 会被模态遮罩盖住(表现成「顶带跟着模糊、窗控点不动」)。
    expect(OVERLAY).toMatch(/z-\[\d{2,}\]/);
    // 替身壳自身命中透明(pointer-events:none,不挡视口点击),靠 visibility 让子元素
    // 可见命中;「替身壳又开回 pointer-events」会破坏这条红线。
    expect(OVERLAY).toContain("pointer-events-none");
    expect(OVERLAY).toContain("invisible");
  });

  test("替身内的拖拽区壳显式恢复命中(拖拽靠 mousedown 收,不能命中透明)", () => {
    // 替身壳是 invisible + pointer-events-none;拖拽区那层壳必须显式 pointer-events-auto,
    // 否则替身内的拖拽把手命中透明,窗口拖不动。
    expect(OVERLAY).toContain("pointer-events-auto");
  });

  test("替身复用真实顶带的 brand/window-controls(不另写复制品)", () => {
    // 替身必须 import 共享实现,而不是内联另一份 Logo/窗控钮。
    expect(OVERLAY).toContain('from "~/components/sidebar-brand"');
    expect(OVERLAY).toContain('from "~/components/window-controls"');
    expect(OVERLAY).toContain("<SidebarBrandRow");
    expect(OVERLAY).toContain("<WindowControlsBar");
    // 替身自身命中透明:容器始终是 invisible(靠 visibility 让子元素可见命中,
    // 替身壳自身不抢视口点击)。
    expect(OVERLAY).toContain("invisible");
  });

  test("替身坐标与主界面顶带逐字对齐(三页同源,不出现第二份魔法数)", () => {
    // 与 conversations.tsx 的顶带坐标同源:品牌行 ml-4 mt-1(左 16px / 距顶 4px),
    // 窗控 ml-auto mt-1.5 mr-2(右 8px)。替身与真实顶带共用组件,坐标也复刻同一组
    // 工具类——漂移风险点就在「替身的 Logo / [-口×] 与主界面错位」,这里锁住。
    expect(OVERLAY).toContain('className="ml-4 mt-1"');
    expect(OVERLAY).toContain('className="ml-auto mt-1.5 mr-2"');
    // 外层容器与主界面顶带同向(items-start:品牌行/窗控各带 mt-*,纵向对齐),
    // 不得回退成 items-center(那会让品牌行/窗控纵向居中带,与主界面错半个带高)。
    expect(OVERLAY).toContain("items-start");
    expect(OVERLAY).not.toContain("items-center");
  });

  test("替身拖拽区从 windowDragRegionProps 派生(同源),不另写拖拽逻辑", () => {
    expect(WINDOW_CONTROLS).toContain("titlebarOverlayDragRegionProps");
    // 替身专用派生必须把 windowDragRegionProps 摊开,不得另起一套 startDragging 调用。
    expect(WINDOW_CONTROLS).toContain("...windowDragRegionProps()");
  });

  test("CSS 给替身内的拖拽区与按钮可见命中(替身壳自身命中透明)", () => {
    // 替身内交互元素恢复 visibility(替身壳是 invisible,此处把命中的子元素点亮)。
    expect(CSS).toContain("[data-titlebar-overlay] [data-tauri-drag-region]");
    expect(CSS).toContain('[data-titlebar-overlay] :is(button, a, [role="button"])');
    // 旧的「body:has() 顶栏豁免」规则必须移除(替身方案不再需要恢复真实顶带的命中)。
    expect(CSS).not.toContain("body:has([data-settings-overlay]) [data-app-titlebar]");
  });

  test("WindowControlsBar 支持强制渲染(替身需要始终画出 [-口×])", () => {
    // alwaysVisible 让替身在非壳内也画出窗控钮(浏览器预览下点击静默为空)。
    expect(WINDOW_CONTROLS).toContain("alwaysVisible");
  });
});
