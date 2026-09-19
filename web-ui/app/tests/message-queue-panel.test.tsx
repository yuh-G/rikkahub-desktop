// message-queue-panel 形态行为锁。
//
// 用户反馈三点,本测试锁住修复后的形态:
//   ①旧面板是横贯对话区的满宽横幅(与消息列宽度不一致)。修复后它作为 queueSlot 渲染进
//     输入卡内部,自身不再带任何宽度/边框/背景类——宽度完全由输入卡决定。这里锁"根节点
//     不自带 rounded-2xl/border/bg-* 外壳",破坏即红。
//   ②旧面板右上角有「暂停」「终止生成」两个图标钮,语义与输入框停止钮重复且令人疑惑。
//     修复后常态只有逐项「修改/撤回」;暂停态只是失败提示 + 「继续发送」。
//   ③「与输入框合为一体、看不出是队列」。最终形态:贴片在输入卡**外面**上沿——左右
//     内缩(mx-2)、下沿探到卡片背后(-mb-3),读作「卡片上方压了一张便签」;叠色
//     --ds-queue-surface 负责与卡片/对话区的色差。贴片外壳属输入卡(chat-input.tsx),
//     故用源级断言锁(下方 describe),面板本体维持无壳。
//   ④「贴片太长」。删掉常态提示行(「本次回复结束后依次发送」,i18n 键 queue.hint 一并
//     删除);每条消息 truncate 成单行(超长 ... 省略);行距收紧(leading-4.5 + py-0.5)。
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

  test("常态:无提示行(省竖向空间),无「暂停」「停止生成」入口", () => {
    const html = render({ items: [ITEM], paused: false });
    expect(html).toContain(ITEM.preview);
    // 常态提示行已删(用户拍板:贴片太长),i18n 键 queue.hint 一并删除——锁文案不再出现。
    expect(html).not.toContain("本次回复结束后");
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
  });

  test("每条排队消息单行省略(truncate)且行距收紧", () => {
    const html = render({ items: [ITEM], paused: false });
    // truncate = nowrap + ellipsis:超出贴片宽度的 prompt 以 ... 收尾,保证只占一行。
    expect(html).toContain("truncate");
    expect(html).toContain("leading-4.5");
    expect(html).toContain("py-0.5");
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

  test("动作常态可见(不靠悬停发现),悬停只是加强", () => {
    const html = render({ items: [ITEM], paused: false });
    // opacity-0 = 完全隐藏,用户不知道排队项能改/能撤(Codex 的动作是常态露出的)。
    expect(html).not.toContain("opacity-0 ");
    expect(html).toContain("group-hover:opacity-100");
  });
});

describe("queue 文案双语配对", () => {
  test("zh-CN 与 en-US 的 queue 键集合完全一致", () => {
    const zhKeys = Object.keys((zhInput as Record<string, Record<string, string>>).queue).sort();
    const enKeys = Object.keys((enInput as Record<string, Record<string, string>>).queue).sort();
    expect(zhKeys).toEqual(enKeys);
  });
});

// 贴片外壳在 chat-input 一侧(队列面板不该知道自己被贴在哪),故锁源码。卡外探出三件套
// 缺一件就退回"与输入框合为一体":贴片排在输入卡**之前**(卡外而非卡内)、左右内缩
// (mx-2) + 下沿探到卡片背后(-mb-3)、叠色(queue-surface)负责色差。同时锁"空队列
// 不给贴片":queueSlot 为 null 时不能渲染空壳。
describe("队列贴片形态(卡外探出,附着在输入卡上沿)", () => {
  const SOURCE = readFileSync(
    join(import.meta.dir, "..", "components", "input", "chat-input.tsx"),
    "utf8",
  );
  const WRAPPER = SOURCE.match(/\{queueSlot \? \(\s*<div className="([^"]*)"/)?.[1] ?? "";

  test("条件渲染:队空(queueSlot=null)不留空贴片", () => {
    expect(SOURCE).toContain("{queueSlot ? (");
  });

  test("贴片在输入卡外、排在卡片之前(卡外探出而非卡内融合)", () => {
    expect(SOURCE.indexOf("{queueSlot ? (")).toBeGreaterThan(-1);
    expect(SOURCE.indexOf("{queueSlot ? (")).toBeLessThan(SOURCE.indexOf("chat-input-box"));
  });

  test("左右内缩(mx-2) + 下沿探到卡片背后(-mb-3),不再是卡内满宽负 margin", () => {
    expect(WRAPPER).toContain("mx-2");
    expect(WRAPPER).not.toContain("-mx-2");
    expect(WRAPPER).toContain("-mb-3");
    expect(WRAPPER).not.toContain("-mx-3");
    expect(WRAPPER).not.toContain("-mt-3");
  });

  test("上沿圆角与输入卡同值 + 叠色色差(读作附着的一层,而非输入框自身)", () => {
    expect(WRAPPER).toContain("rounded-t-[var(--ds-chat-composer-radius)]");
    expect(WRAPPER).toContain("bg-[var(--ds-queue-surface)]");
  });

  test("--ds-queue-surface 在明暗两套主题令牌里都有定义", () => {
    const css = readFileSync(join(import.meta.dir, "..", "app.css"), "utf8");
    const hits = [...css.matchAll(/--ds-queue-surface:/g)];
    expect(hits.length).toBeGreaterThanOrEqual(2);
    // 半透明叠色(混入 transparent)而非实色:实色在暗色/花色主题下会闷掉,且不透底色。
    for (const m of css.matchAll(/--ds-queue-surface:([^;]*);/g)) {
      expect(m[1]).toContain("transparent");
    }
  });
});
