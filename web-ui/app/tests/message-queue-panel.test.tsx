// message-queue-panel 形态行为锁。
//
// 用户反馈两点,本测试锁住修复后的形态:
//   ①旧面板是横贯对话区的满宽横幅(与消息列宽度不一致)。修复后它作为 queueSlot 渲染进
//     输入卡内部,自身不再带任何宽度/边框/背景类——宽度完全由输入卡决定。这里锁"根节点
//     不自带 rounded-2xl/border/bg-* 外壳",破坏即红。
//   ②旧面板右上角有「暂停」「终止生成」两个图标钮,语义与输入框停止钮重复且令人疑惑。
//     修复后常态只有逐项「修改/撤回」;暂停态只是失败提示 + 「继续发送」。
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageQueuePanel } from "~/components/input/message-queue-panel";
import { TooltipProvider } from "~/components/ui/tooltip";
import type { MessageQueueSnapshotDto } from "~/types/dto";
import i18n from "~/i18n";

import zhInput from "~/locales/zh-CN/input.json";
import enInput from "~/locales/en-US/input.json";

function render(queue: MessageQueueSnapshotDto): string {
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(MessageQueuePanel, { conversationId: "c1", queue }),
    ),
  );
}

const ITEM = { id: "q1", preview: "这份目录有意思吗", hasAttachments: false, createdAt: 1 };

describe("消息队列面板形态", () => {
  test("队空/null 不渲染", () => {
    expect(render(null)).toBe("");
    expect(render({ items: [], paused: false })).toBe("");
  });

  test("不自带宽度/外壳类:宽度由输入卡决定(不再是满宽横幅)", () => {
    const html = render({ items: [ITEM], paused: false });
    const rootClass = html.match(/^<div class="([^"]*)"/)?.[1] ?? "";
    expect(rootClass).not.toContain("rounded-2xl");
    expect(rootClass).not.toContain("border");
    expect(rootClass).not.toContain("bg-");
    expect(rootClass).not.toContain("shadow");
  });

  test("常态:一句话说清排队语义,无「暂停」「停止生成」入口", () => {
    const html = render({ items: [ITEM], paused: false });
    expect(html).toContain(ITEM.preview);
    expect(html).toContain(i18n.t("input:queue.hint", { count: 1 }));
    // 旧形态的两个疑惑按钮的文案已从词表删除,此处再锁渲染产物不含它们。
    expect(html).not.toContain("暂停");
    expect(html).not.toContain("停止生成");
  });

  test("多条时显序号(FIFO 次序),单条时不显", () => {
    const single = render({ items: [ITEM], paused: false });
    expect(single).not.toContain(">1<");
    const multi = render({
      items: [ITEM, { ...ITEM, id: "q2", preview: "第二句" }],
      paused: false,
    });
    expect(multi).toContain(">1<");
    expect(multi).toContain(">2<");
  });

  test("暂停态=失败提示 + 继续发送(错误恢复,非常规操作)", () => {
    const html = render({ items: [ITEM], paused: true });
    expect(html).toContain(i18n.t("input:queue.paused_hint"));
    expect(html).toContain(i18n.t("input:queue.resume"));
    expect(html).not.toContain(i18n.t("input:queue.hint", { count: 1 }));
  });

  test("附件项隐藏编辑(编辑契约=替换正文,会丢附件),仍可撤回", () => {
    // 动作键的文案在 Tooltip 内(静态渲染时 tooltip 关闭、内容不出现),故按图标类名断言。
    const withAttachment = render({
      items: [{ ...ITEM, preview: "", hasAttachments: true }],
      paused: false,
    });
    expect(withAttachment).toContain(i18n.t("input:queue.attachment"));
    expect(withAttachment).not.toContain("lucide-pencil");
    expect(withAttachment).toContain("lucide-trash");

    // 纯文本项两个动作都在。
    const textOnly = render({ items: [ITEM], paused: false });
    expect(textOnly).toContain("lucide-pencil");
    expect(textOnly).toContain("lucide-trash");
  });
});

describe("queue 文案双语配对", () => {
  test("zh-CN 与 en-US 的 queue 键集合完全一致", () => {
    const zhKeys = Object.keys((zhInput as Record<string, Record<string, string>>).queue).sort();
    const enKeys = Object.keys((enInput as Record<string, Record<string, string>>).queue).sort();
    expect(zhKeys).toEqual(enKeys);
  });
});
