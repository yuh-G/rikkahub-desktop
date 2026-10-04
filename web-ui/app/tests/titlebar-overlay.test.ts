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
const SIDEBAR_BRAND = readFileSync(join(ROOT, "components", "sidebar-brand.tsx"), "utf8");
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

  test("设置模态打开时隐去真实顶带 chrome(消暗影环),替身副本豁免保持可见", () => {
    // 真实 chrome(品牌行/窗控条)若留着,其像素会被本体遮罩的 backdrop-filter 糊成鬼影,
    // 替身清晰版盖上去后鬼影向外晕开、在 Logo/品牌名外围裹出一圈暗影。故模态打开时
    // 隐去真实 chrome,让遮罩只采样顶带背景;替身副本经 [data-titlebar-overlay] 豁免保持可见。
    // ①两个共享组件根都带 chrome 标记(替身复用同组件,副本也带标记、走豁免)。
    expect(SIDEBAR_BRAND).toContain('data-titlebar-chrome=""');
    expect(WINDOW_CONTROLS).toContain('data-titlebar-chrome=""');
    // ②隐藏规则:模态打开时隐去所有 chrome。
    const hideBlock =
      /body:has\(\[data-settings-overlay\]\)\s+\[data-titlebar-chrome\]\s*\{([^}]*)\}/.exec(CSS);
    expect(hideBlock, "CSS 需有「隐去真实 chrome」规则").not.toBeNull();
    expect(hideBlock![1]).toContain("visibility: hidden");
    // ③替身豁免:替身作用域内的 chrome 副本保持可见。
    const exemptBlock =
      /body:has\(\[data-settings-overlay\]\)\s+\[data-titlebar-overlay\]\s+\[data-titlebar-chrome\]\s*\{([^}]*)\}/.exec(
        CSS,
      );
    expect(exemptBlock, "CSS 需有「替身副本豁免」规则").not.toBeNull();
    expect(exemptBlock![1]).toContain("visibility: visible");
    // ④替身自身不标 chrome(豁免只认组件共享根上的标记,替身壳不掺和)。
    //    只查 JSX 属性形态,避开 header 注释里对该词的文字引用。
    expect(OVERLAY).not.toContain('data-titlebar-chrome=""');
    expect(OVERLAY).not.toContain("data-titlebar-chrome=");
  });

  test("替身拖拽区壳背景透明(不透出遮罩的模糊/压暗)", () => {
    // 替身拖拽区壳只负责命中与坐标、不承载任何底色——它若被填上底色,
    // 会透出遮罩的模糊/压暗,在 Logo/品牌名外围裹出一圈暗影(品牌区像蒙了层灰)。
    // 替身组件与共享的 WindowControlsBar 都不允许给拖拽区壳上 bg(背景交给壳外、遮罩自己糊)。
    expect(OVERLAY).not.toMatch(/\[data-tauri-drag-region\][^}]*bg-/);
    expect(OVERLAY).not.toContain("bg-");
    // 替身拖拽区壳自身的 CSS 块里不得出现 background 声明(壳保持透明)。
    const shellBlock = /\[data-titlebar-overlay\]\s*\[data-tauri-drag-region\]\s*\{([^}]*)\}/.exec(CSS);
    expect(shellBlock, "替身需点亮拖拽区壳(visibility)").not.toBeNull();
    expect(shellBlock![1]).toContain("visibility: visible");
    expect(shellBlock![1]).not.toContain("background");
  });

  test("WindowControlsBar 支持强制渲染(替身需要始终画出 [-口×])", () => {
    // alwaysVisible 让替身在非壳内也画出窗控钮(浏览器预览下点击静默为空)。
    expect(WINDOW_CONTROLS).toContain("alwaysVisible");
  });
});
