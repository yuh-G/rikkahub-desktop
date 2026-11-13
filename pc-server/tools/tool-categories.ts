// tools/tool-categories.ts — 应用工具的「工具名 → 类别 + 对象提取」映射表(方案 §5.6)
//
// 应用工具(工作区七个 + 本地工具 + ask_user + MCP)由应用执行、应用审批,两个引擎都经它判定;
// 将来 pi 内建工具与 DSH 工具各由自己的驱动带一张表。审批判定(tools/permission.ts)只认这里给出的
// 类别与对象,工具名的知识只在本表。
//
// 行为与按工具名判定时逐项相同:联网搜索 / 抓取与本地工具免审,ask_user 恒待答,MCP 读逐工具设置;
// 不认识的名字不挂审批(执行层报 Unknown tool 回灌模型)。

import type { JsonValue } from "../foundation/types";
import { isWorkspaceToolName, type WorkspaceToolName } from "../workspace/approval";
import { ASK_USER_TOOL_NAME } from "./ask-user";
import type { PermissionTarget, ToolCategory } from "./permission";

type ToolArgs = Record<string, JsonValue>;

interface ToolCategoryEntry {
  category: ToolCategory;
  target: (args: ToolArgs) => PermissionTarget;
}

const NO_TARGET = (): PermissionTarget => ({});
const pathTarget = (args: ToolArgs): PermissionTarget => (typeof args.path === "string" ? { path: args.path } : {});
const commandTarget = (args: ToolArgs): PermissionTarget => ({ command: String(args.command ?? "") });
const urlTarget = (args: ToolArgs): PermissionTarget => (typeof args.url === "string" ? { url: args.url } : {});

/** 工作区工具(bash 不可用时 grep/find/ls 顶上,读语义与 read 同类)。 */
const WORKSPACE_TOOL_CATEGORIES: Record<WorkspaceToolName, ToolCategoryEntry> = {
  read: { category: "read", target: pathTarget },
  grep: { category: "read", target: pathTarget },
  find: { category: "read", target: pathTarget },
  ls: { category: "read", target: pathTarget },
  write: { category: "write", target: pathTarget },
  edit: { category: "write", target: pathTarget },
  bash: { category: "execute", target: commandTarget },
};

/** 应用自己的通用工具(tools/definitions.ts 声明)。 */
const GENERAL_TOOL_CATEGORIES: Readonly<Record<string, ToolCategoryEntry>> = {
  search_web: { category: "network", target: NO_TARGET },
  scrape_web: { category: "network", target: urlTarget },
  use_skill: { category: "local", target: NO_TARGET },
  save_memory: { category: "local", target: NO_TARGET },
  get_time_info: { category: "local", target: NO_TARGET },
  clipboard_tool: { category: "local", target: NO_TARGET },
  text_to_speech: { category: "local", target: NO_TARGET },
  [ASK_USER_TOOL_NAME]: { category: "ask", target: NO_TARGET },
};

const MCP_TOOL_ENTRY: ToolCategoryEntry = { category: "mcp", target: NO_TARGET };

/** 查表;null = 不是应用工具。 */
export function classifyAppTool(toolName: string): ToolCategoryEntry | null {
  if (isWorkspaceToolName(toolName)) return WORKSPACE_TOOL_CATEGORIES[toolName];
  if (Object.hasOwn(GENERAL_TOOL_CATEGORIES, toolName)) return GENERAL_TOOL_CATEGORIES[toolName]!;
  if (toolName.startsWith("mcp__")) return MCP_TOOL_ENTRY;
  return null;
}
