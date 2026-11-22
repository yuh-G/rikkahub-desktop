// tests/notice-part.test.tsx — notice 片段的界面口径(照 APP 的 ChatMessageNotices / ChatMessageCot)
//
// 锁:①助手消息里的 notice 归进思维链,作为一步,不切开工具链;②只有 notice 的消息判得出来(不当气泡);
// ③卡片收起时只显示标题,原文在展开后;④Markdown 导出跳过只有 notice 的消息,助手消息里的 notice 不出现;
// ⑤导出图片不画它。
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ExportedImage } from "~/components/message/exported-image";
import { NoticeCard } from "~/components/message/parts/notice-part";
import { convertMessagesToMarkdown } from "~/lib/export-markdown";
import { groupMessageParts } from "~/lib/message-grouping";
import { isNoticeOnly, type MessageDto, type NoticePart, type ToolPart, type UIMessagePart } from "~/types";

const notice = (title: string, text: string): NoticePart => ({ type: "notice", title, text });
const tool: ToolPart = { type: "tool", toolCallId: "c-1", toolName: "bash", input: "{}", output: [{ type: "text", text: "out" }], approvalState: { type: "auto" } };
const dto = (id: string, role: "USER" | "ASSISTANT", parts: UIMessagePart[]) =>
  ({ id, role, parts, annotations: [], createdAt: "2026-11-20T10:00:00Z", finishedAt: null, modelId: null }) as unknown as MessageDto;

describe("notice 的界面口径", () => {
  test("助手消息里的 notice 与工具调用同在一张思维链里,作为一步", () => {
    const blocks = groupMessageParts([{ type: "text", text: "开始" }, tool, notice("后台命令已退出", "原文"), { type: "text", text: "跑完了" }]);
    expect(blocks.map((block) => block.type)).toEqual(["content", "thinking", "content"]);
    const thinking = blocks[1] as Extract<(typeof blocks)[number], { type: "thinking" }>;
    expect(thinking.steps.map((step) => step.type)).toEqual(["tool", "notice"]);
  });

  test("只有 notice 的消息判得出来;空消息与混着正文的不算", () => {
    expect(isNoticeOnly([notice("a", "b")])).toBe(true);
    expect(isNoticeOnly([])).toBe(false);
    expect(isNoticeOnly([notice("a", "b"), { type: "text", text: "c" }])).toBe(false);
  });

  test("卡片收起时只显示每条的标题,原文不在", () => {
    const html = renderToStaticMarkup(React.createElement(NoticeCard, { notices: [notice("标题一", "原文一"), notice("标题二", "原文二")] }));
    expect(html).toContain("标题一");
    expect(html).toContain("标题二");
    expect(html).not.toContain("原文一");
  });

  test("Markdown 导出:只有 notice 的消息跳过,助手消息里的 notice 不出现", async () => {
    const markdown = await convertMessagesToMarkdown(
      [
        dto("u1", "USER", [{ type: "text", text: "跑一下" }]),
        dto("a1", "ASSISTANT", [{ type: "text", text: "在跑" }, notice("中途标题", "中途原文")]),
        dto("u2", "USER", [notice("空闲标题", "空闲原文")]),
        dto("a2", "ASSISTANT", [{ type: "text", text: "跑完了" }]),
      ],
      true,
    );
    expect(markdown).toContain("在跑");
    expect(markdown).toContain("跑完了");
    for (const hidden of ["中途标题", "中途原文", "空闲标题", "空闲原文"]) expect(markdown).not.toContain(hidden);
    expect(markdown.split("---").length).toBe(4);
  });

  test("导出图片不画 notice", () => {
    const html = renderToStaticMarkup(
      React.createElement(ExportedImage, {
        ref: undefined,
        title: "t",
        messages: [dto("u2", "USER", [notice("空闲标题", "空闲原文")]), dto("a2", "ASSISTANT", [{ type: "text", text: "跑完了" }, notice("中途标题", "中途原文")])],
        includeReasoning: true,
        expandReasoning: true,
      }),
    );
    expect(html).toContain("跑完了");
    for (const hidden of ["中途标题", "中途原文", "空闲标题", "空闲原文"]) expect(html).not.toContain(hidden);
  });
});
