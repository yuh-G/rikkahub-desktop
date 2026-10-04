// drag-reorder-projection.test.ts — 拖拽排序投影架构的行为锁(上一版 FLIP 的两个用户实测
// 事故:不跟手 + 挤动剧烈,commit 96f5bd6 换投影式后的架构不变量)。jsdom 不跑 Tailwind/
// 布局,运行时渲染测不出,与 list-row-menu-visibility.test.ts 同款:直接锁源码结构。
//
// 不变量(见 drag-reorder.ts 头注):
//   1. 拖动全程不得有 insertBefore/appendChild(实时 DOM 重排 = 上一版「不跟手」根因:
//      被拖行布局位每越一行跳一格,行在指针下抽动);DOM 重排只允许出现在 finish 的
//      提交分支里(松手一次性落位)。
//   2. 被拖行位移必须是纯指针位移(clientY - startY),不得混入槽位修正。
//   3. 兄弟行让位 = projectShifts 的 ±step 投影(不得回退成 FLIP 两拍:transition:none
//      + 回流清零的写法回来了就是架构回退)。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const SOURCE = readFileSync(
  join(import.meta.dir, "..", "components", "settings", "drag-reorder.ts"),
  "utf8",
);

/**
 * 抠出函数体(顶层 function 或嵌套 const 箭头均可):从声明头到函数体配平的右花括号。
 * 注释/字符串里的括号按字符跳过——源码注释含中文括号与代码示例,纯缩进启发式在嵌套
 * 声明(finish/begin 在 startRowDrag 内)上不可靠,配平是唯一稳的。
 */
function bodyOf(decl: RegExp): string {
  const hit = decl.exec(SOURCE);
  expect(hit, `找不到声明 ${decl.source}`).not.toBeNull();
  let i = hit!.index + hit![0].length;
  while (SOURCE[i] !== "{") i++;
  const end = matchBracket(SOURCE, i, "{", "}");
  return SOURCE.slice(hit!.index, end + 1);
}

/** 从 open 字符处配平到对应的 close(跳过字符串与行/块注释)。 */
function matchBracket(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

describe("拖拽排序投影架构", () => {
  test("拖动路径(dragMove/projectShifts/dropSlotAt/autoScrollTick)零 DOM 重排", () => {
    // 实时 insertBefore 是上一版「不跟手」的根因:被拖行布局位每越一行跳一格。
    for (const fn of [
      "dropSlotAt",
      "projectShifts",
      "dragMove",
      "autoScrollTick",
    ] as const) {
      const body = bodyOf(new RegExp(`function ${fn}\\s*\\(`));
      expect(body, `${fn} 不得重排 DOM`).not.toContain("insertBefore");
      expect(body, `${fn} 不得搬移节点`).not.toContain("appendChild");
    }
  });

  test("DOM 重排只在松手提交分支(finish 内、真换位时)", () => {
    const finish = bodyOf(/const finish = /);
    expect(finish).toContain("insertBefore");
    // 提交前置守卫:只有真换位才搬 DOM。
    expect(finish).toContain("toIndex !== s.from");
  });

  test("被拖行跟手:位移 = 纯指针位移(clientY - startY),经 CSS translate 逐帧直写", () => {
    const move = bodyOf(/function dragMove\s*\([^)]*\)/);
    expect(move).toContain("clientY - s.startY");
    // 跟手写法 = CSS `translate` 合成层属性(dnd-kit 同款),与兄弟行 transform 过渡不纠缠;
    // 写回 `transform: translateY()` 即回退(会和行根 transition 打架)。模板只有 pointerShift 一个变量。
    expect(move).toContain(".translate =");
    const writes = move.match(/translate\s*=\s*`0 \$\{[^}]+\}px`/g) ?? [];
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((w) => w.includes("pointerShift"))).toBe(true);
    expect(move).not.toContain("style.transform = `translateY(");
  });

  test("兄弟行让位是投影位移(±step),不得回退成 FLIP 两拍写法", () => {
    const shifts = bodyOf(/function projectShifts\s*\([^)]*\)/);
    expect(shifts).toContain("-step");
    // FLIP 的标志:内联 transition:"none" + 强制回流。出现在源码里即为架构回退。
    expect(SOURCE).not.toContain('style.transition = "none"');
    expect(SOURCE).not.toContain("offsetHeight;");
  });

  test("挤动节奏走 CSS 缓动(app.css 的 soft motion),拖行材质类常名不变", () => {
    const css = readFileSync(join(import.meta.dir, "..", "app.css"), "utf8");
    const shiftRule = /\.rk-drag-shift\s*\{[^}]*\}/.exec(css);
    expect(shiftRule).not.toBeNull();
    // 兄弟行让位用 slow+soft 渐变成熟感(弱化「瞬间交换」);回退成无缓动/硬切即变脆。
    expect(shiftRule![0]).toContain("transform var(--ds-duration-slow) var(--ds-ease-soft)");
    expect(SOURCE).toContain('"rk-drag-row"');
    expect(SOURCE).toContain('"rk-drag-shift"');
  });

  test("被拖行跟手:drag 规则与 Tailwind transition 同层(utilities),且 transform 不进 transition", () => {
    // 「不跟手」实测根因(live trace 实锤):行根带 Tailwind 的 `transition` 工具类
    // (transition-property 含 transform,~150ms),而 Tailwind v4 把它放进 @layer utilities。
    // drag 规则若在更早的层(components/base),utilities 层靠后必赢、**与特异性无关**——
    // 双类也压不过层序,transform 仍被缓动,行在指针后面追(lag 随拖动累积、松手再补几百 ms)。
    // 修法:整组放 @layer utilities 与 `transition` 同层,双类才比特异性胜出、排除 transform。
    const css = readFileSync(join(import.meta.dir, "..", "app.css"), "utf8");
    const utilBlock = /@layer\s+utilities\s*\{/.exec(css);
    expect(utilBlock, "drag 规则必须在 @layer utilities(与 transition 工具类同层)").not.toBeNull();
    // 双类规则必须出现在 @layer utilities 之内(层序才压得过)。
    const after = css.slice(utilBlock!.index);
    const rowRule = /\.rk-drag-row\.rk-drag-row\s*\{[^}]*\}/.exec(after);
    expect(rowRule, "utilities 层内需要双类特异性压过 .transition 单类").not.toBeNull();
    expect(rowRule![0]).toContain("transition-property");
    // 跟手红线:transform 与 translate 都不得进 transition(逐帧直写被缓动 = 行追指针)。
    expect(rowRule![0]).not.toMatch(/transition-property:[^;}]*(transform|translate)/);
    // 观感对齐成熟库(dnd-kit isDragging):被拖行变淡不浮起(opacity,而非 box-shadow 浮起卡)。
    expect(rowRule![0]).toContain("opacity");
    expect(rowRule![0]).not.toContain("box-shadow");
  });

  test("拖动全程禁止文本选中(蓝底高亮):preventDefault + 会话期 user-select none", () => {
    // 不拦 pointerdown 默认手势、不在会话期压 user-select,指针一移动 Chromium 就在
    // 兄弟行里圈选文本(用户实测拖拽时其他文字变蓝)。
    expect(SOURCE).toContain("event.preventDefault()");
    expect(SOURCE).toContain('document.body.style.userSelect = "none"');
    // 清理必须还原 user-select(否则整页永久禁选)。
    const cleanup = bodyOf(/s\.cleanup = \(\) => /);
    expect(cleanup).toContain("document.body.style.userSelect = previousUserSelect");
  });
});
