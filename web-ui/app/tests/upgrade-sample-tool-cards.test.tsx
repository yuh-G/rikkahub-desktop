// tests/upgrade-sample-tool-cards.test.tsx — 上一个发布版落库的工作区工具卡,新版照常显示(P7.4.1,D25)。
// 数据取自升级冒烟的样本 pc-server/scripts/upgrade-sample/v5/expected.json(上一个发布版返回的原样卡片);
// 新版返回的卡片与它逐字相同由 bun run smoke:upgrade 锁住,这里锁显示。
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkspaceActionStep } from "~/components/message/parts/workspace-tool-part";
import { TooltipProvider } from "~/components/ui/tooltip";
import i18n from "~/i18n";
import { buildWorkspaceActionModel, isFailedWorkspaceAction } from "~/lib/workspace-tool-model";
import type { ToolPart } from "~/types";
import sample from "@server/scripts/upgrade-sample/v5/expected.json";

const cards = sample.toolCards as unknown as ToolPart[];
const byName = (name: string) => cards.find((card) => card.toolName === name)!;
const step = (part: ToolPart) => renderToStaticMarkup(React.createElement(TooltipProvider, null, React.createElement(WorkspaceActionStep, { tool: part })));

describe("上一个发布版的工具卡", () => {
  test("样本里有写、读、改三张卡,都已完成、都不算失败", () => {
    expect(cards.map((card) => card.toolName)).toEqual(["write", "read", "edit"]);
    for (const card of cards) {
      expect(buildWorkspaceActionModel(card).finished).toBe(true);
      expect(isFailedWorkspaceAction(card)).toBe(false);
    }
  });

  test("写:标题带路径,字节数从老结果文本里读出", () => {
    const html = step(byName("write"));
    expect(html).toContain("notes.txt");
    expect(html).toContain(i18n.t("message:workspace_tool.bytes", { bytes: 11 }));
  });

  test("读:标题带路径", () => {
    expect(step(byName("read"))).toContain("notes.txt");
  });

  test("改:diff 统计 +1 -1", () => {
    const html = step(byName("edit"));
    expect(html).toContain("notes.txt");
    expect(html).toContain("+1");
    expect(html).toContain("-1");
  });
});
