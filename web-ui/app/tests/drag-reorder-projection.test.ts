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

  test("被拖行跟手:位移 = 纯指针位移(clientY - startY),无槽位修正项", () => {
    const move = bodyOf(/function dragMove\s*\([^)]*\)/);
    expect(move).toContain("clientY - s.startY");
    // translateY 模板里只有 pointerShift 一个变量(混入 step/槽位即偏离指针)。
    const writes = move.match(/translateY\(\$\{[^}]+\}px\)/g) ?? [];
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((w) => w.includes("pointerShift"))).toBe(true);
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
    expect(shiftRule![0]).toContain("transform var(--ds-motion-soft)");
    expect(SOURCE).toContain('"rk-drag-row"');
    expect(SOURCE).toContain('"rk-drag-shift"');
  });
});
