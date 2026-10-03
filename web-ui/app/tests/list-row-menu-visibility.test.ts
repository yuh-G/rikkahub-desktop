// list-row-menu-visibility.test.ts — 列表行尾「⋯」菜单钮显隐的回归锁(交互审查:菜单与徽标
// 显隐/重叠/点不到事故)。两侧实现不同但同病,各锁各的关键类与结构不变量:
//
//   设置列表(SettingsListRow,shared.tsx):徽标↔「⋯」同位 grid 叠放互换。
//     - 「⋯」必须在徽标之后渲染(网格同位后出者压先出者),否则被徽标压在底下点不到。
//     - 菜单打开态靠行根的 data-menu 标志(共同祖先),不用跨元素 peer——徽标与「⋯」各自
//       包了 span、非兄弟,peer-data 够不着会让菜单开着徽标不隐、两者重叠。
//   会话列表(SidebarMenuAction,ui/sidebar.tsx):
//     - 悬停/聚焦/菜单打开/激活行时浮现,桌面常态隐藏(md:opacity-0 须在最后压过其余)。
//     - 悬停底色用中性晕染 --ds-on-surface,不用 --sidebar-accent——有的主题(mx-brutalist)
//       把它定义成不透明实色,「⋯」一悬停就成实心色块。
//
// 与 cn-theme-scale.test.ts 同款思路:显隐全靠 className 串,运行时渲染测试(jsdom 不跑
// Tailwind 变体)测不出,直接锁源码里的类与结构顺序。改坏了这些类,本测试即变红。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const SHARED = readFileSync(join(import.meta.dir, "..", "components", "settings", "shared.tsx"), "utf8");
const SIDEBAR = readFileSync(join(import.meta.dir, "..", "components", "ui", "sidebar.tsx"), "utf8");

/** 抽出 SidebarMenuAction 组件函数体(别误伤 GroupAction/SubButton 等其它组件里的同名类)。 */
function menuActionBody(): string {
  const start = SIDEBAR.indexOf("function SidebarMenuAction(");
  expect(start).toBeGreaterThan(-1);
  const end = SIDEBAR.indexOf("function SidebarMenuBadge(", start);
  expect(end).toBeGreaterThan(start);
  return SIDEBAR.slice(start, end);
}

describe("设置列表 SettingsListRow", () => {
  test("菜单打开态走行根 data-menu,不用断裂的跨元素 peer-data", () => {
    expect(SHARED).toContain('data-menu={menuOpen ? "open" : undefined}');
    expect(SHARED).toContain("group-data-[menu=open]/settings-row:opacity-100"); // 「⋯」开菜单浮现
    expect(SHARED).toContain("group-data-[menu=open]/settings-row:opacity-0"); // 徽标开菜单让位
    expect(SHARED).not.toContain("peer-data-[state=open]");
  });

  test("「⋯」渲染在徽标之后(同位叠放时压在上层、可点)", () => {
    const badgeIdx = SHARED.indexOf("{badge}");
    const triggerIdx = SHARED.indexOf("<MoreHorizontal");
    expect(badgeIdx).toBeGreaterThan(-1);
    expect(triggerIdx).toBeGreaterThan(-1);
    expect(triggerIdx).toBeGreaterThan(badgeIdx);
  });

  test("徽标永不参与命中测试(pointer-events-none)", () => {
    // opacity<1 自成 stacking context,绘制在普通文档流之上:让位中的徽标(视觉已隐)
    // 会盖住同格的「⋯」拦截点击——opacity:0 不摘除命中测试,订阅行的「⋯」点不到就是它。
    const badgeWrapIdx = SHARED.indexOf('col-start-1 row-start-1 inline-flex items-center transition-opacity');
    expect(badgeWrapIdx).toBeGreaterThan(-1);
    expect(SHARED.slice(badgeWrapIdx, badgeWrapIdx + 90)).toContain("pointer-events-none");
  });

  test("「⋯」桌面常态隐藏、悬停/键盘聚焦浮现(焦点态用 focus-visible,鼠标点按不劫持)", () => {
    expect(SHARED).toContain("opacity-0 group-focus-visible-within/settings-row:opacity-100 group-hover/settings-row:opacity-100");
    // 鼠标点按留下的 :focus 不该让「⋯」常显(菜单关闭焦点还原滞留的根因),故禁用 focus-within 常显类。
    expect(SHARED).not.toContain("group-focus-within/settings-row:opacity-100");
  });
});

describe("会话列表 SidebarMenuAction", () => {
  test("悬停底色是中性晕染 --ds-on-surface,不是主题实色 --sidebar-accent", () => {
    const body = menuActionBody();
    expect(body).toContain("hover:bg-[var(--ds-on-surface)]");
    // 菜单钮自身的悬停色不得再用 sidebar-accent(实心色块根因)。
    expect(body).not.toContain("hover:bg-sidebar-accent");
  });

  test("showOnHover:悬停/键盘聚焦/菜单打开/激活行浮现,桌面常态隐藏", () => {
    const showOnHover = menuActionBody().split("showOnHover &&")[1] ?? "";
    expect(showOnHover).toContain("group-hover/menu-item:opacity-100");
    expect(showOnHover).toContain("group-focus-visible-within/menu-item:opacity-100");
    expect(showOnHover).not.toContain("group-focus-within/menu-item:opacity-100"); // 鼠标焦点不劫持
    expect(showOnHover).toContain("data-[state=open]:opacity-100");
    expect(showOnHover).toContain("peer-data-[active=true]/menu-button:opacity-100"); // 激活行常显
    expect(showOnHover).toContain("md:opacity-0"); // 桌面常态隐藏(压轴)
  });
});
