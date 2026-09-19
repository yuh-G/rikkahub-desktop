// 流式前缀冻结的渲染级不变式:用真实管线(preProcess → 前缀/尾部双 Streamdown 实例)
// 静态渲染,断言"分裂渲染的可见文本 == 完成态整文渲染"。纯函数契约见 frozen-prefix.test.ts。
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import Markdown from "~/components/markdown/markdown";
import { TooltipProvider } from "~/components/ui/tooltip";

// G7 后 Button 的 title 渲染 Radix Tooltip(如代码块复制按钮),脱离应用根的
// TooltipProvider 静态渲染会抛错,测试自己挂一个。
function render(content: string, isAnimating: boolean): string {
  return renderToStaticMarkup(
    React.createElement(TooltipProvider, null, React.createElement(Markdown, { content, isAnimating })),
  );
}

// 可见文本(剥标签、压空白):前缀/尾部分属两棵 DOM 树,标签结构允许不同,文本必须一致
function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, "");
}

// Streamdown 根容器的特征类(每个实例一个根)
const STREAMDOWN_ROOT = "space-y-4 whitespace-normal";
const countRoots = (html: string) => html.split(STREAMDOWN_ROOT).length - 1;

const paragraphs = (n: number) =>
  Array.from({ length: n }, (_, i) => `第${i}段 ${"内容文字".repeat(100)}`).join("\n\n");

describe("流式前缀冻结(渲染级)", () => {
  test("短内容流式不分裂:单实例,与旧行为一致", () => {
    const html = render("你好 **世界**", true);
    expect(countRoots(html)).toBe(1);
    expect(html).toContain('data-streamdown="strong"');
    expect(html).toContain("世界");
  });

  test("长流式内容分裂为前缀+尾部双实例,可见文本与完成态整文渲染一致", () => {
    const content = `${paragraphs(10)}\n\n| 列A | 列B |\n| --- | --- |\n| 甲 | 乙 |`;
    const streaming = render(content, true);
    const done = render(content, false);
    expect(countRoots(streaming)).toBe(2);
    expect(countRoots(done)).toBe(1);
    expect(visibleText(streaming)).toBe(visibleText(done));
  });

  test("流式中的未闭合围栏整体留在尾部实例,代码块只渲染一份", () => {
    const content = `${paragraphs(6)}\n\n\`\`\`ts\n${"const x = 1;\n".repeat(200)}`;
    const html = render(content, true);
    expect(countRoots(html)).toBe(2);
    expect(html.split('data-language="ts"').length - 1).toBe(1);
    expect(html).toContain("const x = 1;");
  });

  test("完成态(isAnimating=false)始终单实例,不受内容长度影响", () => {
    const html = render(paragraphs(20), false);
    expect(countRoots(html)).toBe(1);
    expect(visibleText(html)).toContain("第19段");
  });
});

describe("表格覆盖(issue #58 治本)", () => {
  const TABLE = "| 列A | 列B |\n| --- | --- |\n| 甲 | 乙 |";

  test("表格走 MarkdownTable 覆盖:自带复制按钮在,Streamdown 内置 toolbar 不渲染", () => {
    const html = render(TABLE, false);
    // 内容仍在(可见文本含表头与单元格)
    expect(visibleText(html)).toContain("列A");
    expect(visibleText(html)).toContain("甲");
    // 我们的覆盖组件用 code-block-icon-button 复制按钮…
    expect(html).toContain("code-block-icon-button");
    // …且 Streamdown 内置表格 toolbar(其复制走无回退的 navigator.clipboard.write)不再出现
    expect(html).not.toContain('data-streamdown="table-wrapper"');
  });

  test("表格复制按钮在流式与完成态都存在", () => {
    expect(render(TABLE, true)).toContain("code-block-icon-button");
    expect(render(TABLE, false)).toContain("code-block-icon-button");
  });
});
