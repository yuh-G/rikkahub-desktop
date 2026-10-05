// tests/exported-image.test.tsx — 导出图双开关语义(对齐 APP b2d73a65 / 9023945 的行为锁)
//
// 「包含思考过程」(includeReasoning)管思考段落去留,「展开思考」(expandReasoning)只管
// 保留下来卡片的形态(展开全文 vs 折叠头)。此前实现把两档压成一个 prop(&& 折叠),
// include=开/expand=关 时思考在图里完全消失——第二档形同虚设,与安卓
// ExportedReasoningStep(expanded=false) 渲染折叠卡的语义不符。此测试钉住三层语义:
//   include=false → 无思考痕迹;include=true+expand=false → 折叠头(有标题无正文);
//   include=true+expand=true → 折叠头+正文。
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ExportedImage } from "~/components/message/exported-image";
import type { MessageDto } from "~/types";

const messages: MessageDto[] = [
  {
    id: "m1",
    role: "ASSISTANT",
    modelId: "test-model",
    parts: [
      { type: "reasoning", reasoning: "先想想结构", createdAt: "2026-10-05T00:00:00Z", finishedAt: "2026-10-05T00:00:02Z" },
      { type: "text", text: "答案在这里" },
    ],
  } as unknown as MessageDto,
];

function render(includeReasoning: boolean, expandReasoning: boolean): string {
  return renderToStaticMarkup(
    React.createElement(ExportedImage, {
      ref: undefined,
      title: "t",
      messages,
      includeReasoning,
      expandReasoning,
    }),
  );
}

// 折叠头的可见特征:深度思考标题行(测试进程 i18n 已初始化,渲染中文文案)。
const HEADER_MARK = "深度思考";

describe("导出图双开关(包含思考/展开思考)", () => {
  test("include=false:思考段落整体消失——既无折叠头也无正文", () => {
    const html = render(false, true);
    expect(html).not.toContain(HEADER_MARK);
    expect(html).not.toContain("先想想结构");
    expect(html).toContain("答案在这里");
  });

  test("include=true + expand=false:折叠头形态——标题在、正文不在", () => {
    const html = render(true, false);
    expect(html).toContain(HEADER_MARK);
    expect(html).not.toContain("先想想结构");
    expect(html).toContain("答案在这里");
  });

  test("include=true + expand=true:展开形态——标题与正文都在", () => {
    const html = render(true, true);
    expect(html).toContain(HEADER_MARK);
    expect(html).toContain("先想想结构");
    expect(html).toContain("答案在这里");
  });
});
