// lib/tts/text-filter.test.ts — 朗读前文本预处理（台账 §4.1）
// 用例逐字移植 Android StringUtilsTest.kt（引号/括号），另补 stripMarkdown、
// 叠加顺序（先抠引号再删括号）、开关全关闭直通、滤空退回原文的行为锁。

import { describe, expect, test } from "bun:test";
import {
  extractQuotedContentAsText,
  prepareSpeechText,
  removeBracketedContent,
  stripMarkdown,
} from "./text-filter";

describe("extractQuotedContentAsText（对齐 Android StringUtilsTest）", () => {
  test("中文双引号", () => {
    expect(extractQuotedContentAsText("他说“你好”")).toBe("你好");
  });
  test("中文单引号", () => {
    expect(extractQuotedContentAsText("标题是‘世界’")).toBe("世界");
  });
  test("英文双引号", () => {
    expect(extractQuotedContentAsText('he said "hello"')).toBe("hello");
  });
  test("英文单引号", () => {
    expect(extractQuotedContentAsText("title is 'world'")).toBe("world");
  });
  test("直角引号", () => {
    expect(extractQuotedContentAsText("他说「你好」")).toBe("你好");
  });
  test("白直角引号", () => {
    expect(extractQuotedContentAsText("标题是『世界』")).toBe("世界");
  });
  test("多种引号混合按出现顺序拼接（换行分隔）", () => {
    expect(extractQuotedContentAsText("“你好” 和 ‘世界’")).toBe("你好\n世界");
  });
  test("空白引号内容被忽略", () => {
    expect(extractQuotedContentAsText("“” \"\" '  '")).toBeNull();
  });
  test("没有任何引号返回 null（调用方退回原文）", () => {
    expect(extractQuotedContentAsText("没有引号")).toBeNull();
  });
});

describe("removeBracketedContent（对齐 Android StringUtilsTest）", () => {
  test("英文括号", () => {
    expect(removeBracketedContent("你好(旁白)世界")).toBe("你好世界");
  });
  test("中文括号", () => {
    expect(removeBracketedContent("你好（旁白）世界")).toBe("你好世界");
  });
  test("多个括号", () => {
    expect(removeBracketedContent("你好(注释)世界（备注）")).toBe("你好世界");
  });
  test("括号外文本去首尾空白", () => {
    expect(removeBracketedContent("(旁白) 你好 ")).toBe("你好");
  });
  test("不跨括号边界贪婪匹配", () => {
    expect(removeBracketedContent("a(b)c")).toBe("ac");
  });
  test("全是括号返回 null", () => {
    expect(removeBracketedContent("(全是旁白)")).toBeNull();
  });
  test("删完只剩空白返回 null", () => {
    expect(removeBracketedContent("（旁白） ")).toBeNull();
  });
  test("无括号原样返回", () => {
    expect(removeBracketedContent("没有括号")).toBe("没有括号");
  });
});

describe("stripMarkdown（对齐 Android MarkdownUtils.stripMarkdown）", () => {
  test("移除行内与围栏代码块", () => {
    expect(stripMarkdown("用 `npm run dev` 启动\n```\ncode block\n```\n完")).toBe("用  启动\n\n完");
  });
  test("链接与图片保留文字", () => {
    expect(stripMarkdown("看 [文档](https://x.com) 和 ![图](https://y.com/a.png)")).toBe(
      "看 文档 和 图",
    );
  });
  test("加粗斜体删除线剥壳", () => {
    expect(stripMarkdown("**加粗** *斜体* ~~删除~~")).toBe("加粗 斜体 删除");
  });
  test("标题与列表与引用去标记", () => {
    expect(stripMarkdown("## 标题\n- 项目一\n1. 第一项\n> 引用")).toBe("标题\n项目一\n第一项\n引用");
  });
  test("水平分割线移除、多余空行压缩", () => {
    expect(stripMarkdown("上\n\n\n\n---\n\n下")).toBe("上\n\n下");
  });
});

describe("prepareSpeechText 统一过滤链", () => {
  test("开关全关：仍过 stripMarkdown，但引号/括号原样保留", () => {
    expect(prepareSpeechText("他说“你好”(旁白)**加粗**", {})).toBe("他说“你好”(旁白)加粗");
  });
  test("只读引号：只念台词，跳过旁白", () => {
    expect(prepareSpeechText("*她微笑* “你猜带了什么？” （轻快）", { onlyReadQuoted: true })).toBe(
      "你猜带了什么？",
    );
  });
  test("不读括号：跳过中英括号注释", () => {
    expect(prepareSpeechText("开始吧（先深呼吸）(note) 继续", { readOutsideBrackets: true })).toBe(
      "开始吧 继续",
    );
  });
  test("叠加顺序：先抠引号再删括号（对齐 Android）", () => {
    // 引号内含括号注释：抠引号后括号仍在，再由删括号清掉。
    expect(
      prepareSpeechText("旁白 “台词(耳语) 继续”", { onlyReadQuoted: true, readOutsideBrackets: true }),
    ).toBe("台词 继续");
  });
  test("滤空退回原文：全文都在括号里也念原文不念空", () => {
    expect(prepareSpeechText("(全是旁白)", { readOutsideBrackets: true })).toBe("(全是旁白)");
  });
});
