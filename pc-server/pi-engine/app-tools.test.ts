// pi-engine/app-tools.test.ts — 应用工具规格 → pi customTools 的包装(契约对照 + 结果标记)
//
// 两类保障:
// 1) 升级回归门:移植工具(聊天引擎侧的工作区工具,P4b.4 随移植层删除)与 pi 原版工厂的 name/description/
//    parameters 必须语义全等(键序无关;TypeBox 先 required 后 properties,纯序差)。pi 内建工具本身的
//    包装见 builtin-tools.test.ts。
// 2) 包装语义:execute 只把调用交给应用;应用结果的三种形态(display / details / 纯 content)
//    按约定打 details 标记,事件桥据此还原工具卡;应用工具不带提示词摘要、全部顺序执行、带审批闸门标记。
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-piapptools-test-"));

const { createPiAppTools } = await import("./app-tools");
const { isToolGated } = await import("./tool-gate");
const ourTools = {
  read: (await import("../workspace/tools/read")).createReadTool,
  bash: (await import("../workspace/tools/bash")).createBashTool,
  edit: (await import("../workspace/tools/edit")).createEditTool,
  write: (await import("../workspace/tools/write")).createWriteTool,
  grep: (await import("../workspace/tools/grep")).createGrepTool,
  find: (await import("../workspace/tools/find")).createFindTool,
  ls: (await import("../workspace/tools/ls")).createLsTool,
};
const pi = await import("../../pi/packages/coding-agent/src/core/sdk.ts");
import type { AppToolResult, AppToolSpec } from "../engines/contract";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) out[key] = canonical((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

type AnyTool = { name: string; description: string; parameters: unknown };
type ExecFn = (toolCallId: string, params: unknown) => Promise<{ content: unknown[]; details: Record<string, unknown> }>;

function execOf(tool: { execute: unknown }): ExecFn {
  return tool.execute as ExecFn;
}

describe("契约对照(pi 升级回归门)", () => {
  test("七工具 name/description/parameters 与 pi 原版语义全等(键序无关)", () => {
    const cwd = process.cwd();
    const piFactories: Record<string, AnyTool> = {
      read: pi.createReadTool(cwd) as AnyTool,
      bash: pi.createBashTool(cwd) as AnyTool,
      edit: pi.createEditTool(cwd) as AnyTool,
      write: pi.createWriteTool(cwd) as AnyTool,
      grep: pi.createGrepTool(cwd) as AnyTool,
      find: pi.createFindTool(cwd) as AnyTool,
      ls: pi.createLsTool(cwd) as AnyTool,
    };
    for (const [name, factory] of Object.entries(ourTools)) {
      const mine = factory(cwd) as unknown as AnyTool;
      const theirs = piFactories[name];
      expect(mine.name).toBe(theirs.name);
      expect(mine.description).toBe(theirs.description);
      expect(canonical(JSON.parse(JSON.stringify(mine.parameters)))).toEqual(
        canonical(JSON.parse(JSON.stringify(theirs.parameters))),
      );
    }
    // bash 是唯一在 pi 工厂产物上暴露 promptSnippet 的工具,顺带钉住镜像文案。
    const piBash = piFactories.bash as AnyTool & { promptSnippet?: string };
    expect(piBash.promptSnippet).toBe("Execute bash commands (ls, grep, find, etc.)");
  });

});

describe("包装语义", () => {
  const spec: AppToolSpec = { name: "mcp__x", description: "x", parameters: { type: "object", properties: {} }, group: "general" };

  async function run(result: AppToolResult) {
    const calls: unknown[] = [];
    const [tool] = createPiAppTools([spec], async (call) => {
      calls.push(call);
      return result;
    });
    const out = await execOf(tool!)("call-1", { q: "hi" });
    return { calls, out };
  }

  test("形状:不带提示词摘要、不挂 prepareArguments、顺序执行、带审批闸门标记", () => {
    const [tool] = createPiAppTools([spec], undefined);
    expect(tool?.promptSnippet).toBeUndefined();
    expect(tool?.promptGuidelines).toBeUndefined();
    expect(tool?.prepareArguments).toBeUndefined();
    expect(tool?.executionMode).toBe("sequential");
    expect(tool?.label).toBe("mcp__x");
    expect(isToolGated(tool)).toBe(true);
  });

  test("调用原样交给应用:toolCallId/name/args", async () => {
    const { calls } = await run({ content: [{ type: "text", text: "ok" }] });
    expect(calls).toEqual([{ toolCallId: "call-1", name: "mcp__x", args: { q: "hi" } }]);
  });

  test("结果标记:display → {app:{output}};details → {workspace};都没有 → 空 details", async () => {
    const display = [{ type: "image" as const, url: "/api/files/1" }];
    expect((await run({ content: [{ type: "text", text: "t" }], display })).out.details).toEqual({ app: { output: display } });
    const details = { tool: "bash", details: { exitCode: 0 } };
    expect((await run({ content: [{ type: "text", text: "t" }], details })).out.details).toEqual({ workspace: details });
    const plain = await run({ content: [{ type: "text", text: "t" }] });
    expect(plain.out.details).toEqual({});
    expect(plain.out.content).toEqual([{ type: "text", text: "t" }]);
  });

  test("应用以错误拒绝 → execute 抛同一错误(pi 记 error tool result,错误文本即模型可见结果)", async () => {
    const [tool] = createPiAppTools([spec], async () => {
      throw new Error("Tool execution denied by user. Reason: 不允许");
    });
    await expect(execOf(tool!)("call-2", {})).rejects.toThrow("Tool execution denied by user. Reason: 不允许");
  });

  test("通道未接线:执行即报错,不静默成功", async () => {
    const [tool] = createPiAppTools([spec], undefined);
    await expect(execOf(tool!)("call-3", {})).rejects.toThrow("应用工具通道未接线");
  });
});
