// tests/workspace-tool-card-compat.test.tsx — 工作区工具卡对两代数据形状照常渲染(P4b.2)
//
// 工作区引擎的工具 P4b 起是 pi 内建定义。两代数据的差别只有一处:write 的结果文本——移植版是
// 「Successfully wrote N bytes to …」,pi 内建版是「Successfully wrote to …」,字节数改由结构化细节
// metadata.workspace.details.bytes 给出。edit 的 diff / patch、bash 的 exitCode、失败的 {error} 载荷两代相同。
// 锁定:老会话(移植版形状,已落库)与新会话(pi 内建形状)渲染出同样的标题、字节徽标、diff 统计、退出码与成败。
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkspaceActionCard, WorkspaceActionStep, workspaceToolExportLabel } from "~/components/message/parts/workspace-tool-part";
import { TooltipProvider } from "~/components/ui/tooltip";
import i18n from "~/i18n";
import { buildWorkspaceActionModel, isFailedWorkspaceAction } from "~/lib/workspace-tool-model";
import type { ToolPart } from "~/types";

const DIFF = " 1 one\n-2 two\n+2 TWO\n 3 three\n-4 four\n+4 FOUR";
const PATCH = "--- a.txt\n+++ a.txt\n@@ -1,4 +1,4 @@\n one\n-two\n+TWO\n three\n-four\n+FOUR\n";

function tool(toolName: string, input: Record<string, unknown>, output: ToolPart["output"]): ToolPart {
  return { type: "tool", toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input), output, approvalState: { type: "auto" } };
}

function workspaceMeta(name: string, details: Record<string, unknown>) {
  return { workspace: { tool: name, details } };
}

const WRITE_INPUT = { path: "new.txt", content: "hello\n" };
const EDIT_INPUT = { path: "a.txt", edits: [{ oldText: "two", newText: "TWO" }, { oldText: "four", newText: "FOUR" }] };
const EDIT_OUTPUT: ToolPart["output"] = [
  { type: "text", text: "Successfully replaced 2 block(s) in a.txt.", metadata: workspaceMeta("edit", { diff: DIFF, patch: PATCH, firstChangedLine: 2 }) },
];
const BASH_INPUT = { command: "echo hi" };
const BASH_OK: ToolPart["output"] = [{ type: "text", text: "hi\n", metadata: workspaceMeta("bash", { exitCode: 0 }) }];
const BASH_FAILED: ToolPart["output"] = [{ error: "out\n\n\nCommand exited with code 3" }];

/** 两代数据:同一组调用在移植版与 pi 内建版下落库的工具卡 output。 */
const generations: Record<"ported" | "builtin", Record<"write" | "edit" | "bashOk" | "bashFailed", ToolPart>> = {
  ported: {
    write: tool("write", WRITE_INPUT, [{ type: "text", text: "Successfully wrote 6 bytes to new.txt" }]),
    edit: tool("edit", EDIT_INPUT, EDIT_OUTPUT),
    bashOk: tool("bash", BASH_INPUT, BASH_OK),
    bashFailed: tool("bash", { command: "echo out; exit 3" }, BASH_FAILED),
  },
  builtin: {
    write: tool("write", WRITE_INPUT, [{ type: "text", text: "Successfully wrote to new.txt", metadata: workspaceMeta("write", { bytes: 6 }) }]),
    edit: tool("edit", EDIT_INPUT, EDIT_OUTPUT),
    bashOk: tool("bash", BASH_INPUT, BASH_OK),
    bashFailed: tool("bash", { command: "echo out; exit 3" }, BASH_FAILED),
  },
};

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(React.createElement(TooltipProvider, null, element));
}

const step = (part: ToolPart) => render(React.createElement(WorkspaceActionStep, { tool: part }));
const card = (part: ToolPart) => render(React.createElement(WorkspaceActionCard, { tool: part }));

describe.each(["ported", "builtin"] as const)("工具卡渲染(%s 形状)", (generation) => {
  const parts = generations[generation];

  test("write:标题带路径,字节徽标 6 字节,成功", () => {
    const html = step(parts.write);
    expect(html).toContain("new.txt");
    expect(html).toContain(i18n.t("message:workspace_tool.bytes", { bytes: 6 }));
    expect(isFailedWorkspaceAction(parts.write)).toBe(false);
    expect(buildWorkspaceActionModel(parts.write).finished).toBe(true);
  });

  test("edit:diff 统计 +2 -2,导出标签同", () => {
    const html = step(parts.edit);
    expect(html).toContain("+2");
    expect(html).toContain("-2");
    expect(workspaceToolExportLabel(parts.edit, i18n.t)).toContain("(+2 -2)");
  });

  test("bash 成功:已完成、exitCode 0、不抽出", () => {
    const model = buildWorkspaceActionModel(parts.bashOk);
    expect(model.finished).toBe(true);
    expect(model.exitCode).toBe(0);
    expect(isFailedWorkspaceAction(parts.bashOk)).toBe(false);
    expect(step(parts.bashOk)).toContain("echo hi");
  });

  test("bash 非零退出:{error} 载荷 → 失败卡,展开后可见错误文本", () => {
    expect(isFailedWorkspaceAction(parts.bashFailed)).toBe(true);
    const html = card(parts.bashFailed);
    expect(html).toContain("echo out; exit 3");
    expect(buildWorkspaceActionModel(parts.bashFailed).error).toContain("Command exited with code 3");
  });
});

test("两代形状的视图模型逐项相同(字节数之外)", () => {
  for (const key of ["edit", "bashOk", "bashFailed"] as const) {
    const ported = buildWorkspaceActionModel(generations.ported[key]);
    const builtin = buildWorkspaceActionModel(generations.builtin[key]);
    expect(builtin).toEqual(ported);
  }
  const ported = buildWorkspaceActionModel(generations.ported.write);
  const builtin = buildWorkspaceActionModel(generations.builtin.write);
  expect({ ...builtin, details: null, text: "" }).toEqual({ ...ported, details: null, text: "" });
});
