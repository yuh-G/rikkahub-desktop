// tools/permission-guard.test.ts — P4 出口:审批不再按工具名分支(源码扫描)
//
// 审批判定只读「类别 + 对象」(tools/permission.ts);工具名 → 类别的知识只在映射表
// (tools/tool-categories.ts)。执行分派仍要认名字(执行内核与聊天引擎的分派器),那不是审批,单独登记。
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const serverRoot = resolve(import.meta.dir, "..");
const SKIP_DIRS = new Set(["node_modules", "pc-data", "pi"]);

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...productionFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const rel = (file: string) => relative(serverRoot, file).split(sep).join("/");
const sources = productionFiles(serverRoot).map((file) => ({ path: rel(file), src: readFileSync(file, "utf-8") }));

/** 审批链上的模块:判定、接线、生命周期、等待表。 */
const APPROVAL_MODULES = [
  "tools/permission.ts",
  "tools/approval.ts",
  "inference-engine/approval-flow.ts",
  "inference-engine/approval-gate.ts",
];

describe("审批不按工具名分支", () => {
  test("旧的按名判定函数已删除", () => {
    const legacy = /\b(toolNeedsApproval|initialApprovalState|workspaceToolNeedsApproval|workspaceCallApprovalReason)\b/;
    expect(sources.filter(({ src }) => legacy.test(src)).map(({ path }) => path)).toEqual([]);
  });

  test("工作区工具名单只出现在定义处、映射表与执行分派", () => {
    const users = sources.filter(({ src }) => /\b(isWorkspaceToolName|WORKSPACE_TOOL_NAMES)\b/.test(src)).map(({ path }) => path);
    expect(users.sort()).toEqual([
      "tools/execution.ts", // 聊天引擎执行分派 → runWorkspaceTool
      "tools/tool-categories.ts", // 映射表
      "workspace/approval.ts", // 定义
      "workspace/runtime.ts", // 执行内核的未知名守卫与挂载名单
    ]);
  });

  test("审批链上的模块不认工具名(MCP 设置按名查找除外,那是取设置不是分支)", () => {
    for (const path of APPROVAL_MODULES) {
      const src = sources.find((source) => source.path === path)?.src;
      expect(src).toBeDefined();
      expect({ path, hits: src!.match(/\b(isWorkspaceToolName|WORKSPACE_TOOL_NAMES|ASK_USER_TOOL_NAME)\b/g) }).toEqual({ path, hits: null });
      expect({ path, hits: src!.match(/\b(toolName|name)\s*[!=]==\s*["'`]|\b(toolName|name)\.startsWith\(/g) }).toEqual({ path, hits: null });
    }
  });

  test("判定纯函数不读工具名", () => {
    const src = sources.find((source) => source.path === "tools/permission.ts")!.src;
    expect(src.match(/\breq\.toolName\b/g)).toBeNull();
  });
});
