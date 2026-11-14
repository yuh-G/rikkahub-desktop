// pi-engine/app-tools.test.ts — 应用工具规格 → pi customTools 的包装(结果标记)
//
// 包装语义:execute 只把调用交给应用;应用结果的两种形态(display / 纯 content)按约定打 details 标记,
// 事件桥据此还原工具卡;应用工具不带提示词摘要、全部顺序执行、带审批闸门标记。工作区工具是 pi 内建的,
// 包装见 builtin-tools.test.ts。
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-piapptools-test-"));

const { createPiAppTools } = await import("./app-tools");
const { isToolGated } = await import("./tool-gate");
import type { AppToolResult, AppToolSpec } from "../engines/contract";

type ExecFn = (toolCallId: string, params: unknown) => Promise<{ content: unknown[]; details: Record<string, unknown> }>;

function execOf(tool: { execute: unknown }): ExecFn {
  return tool.execute as ExecFn;
}

describe("包装语义", () => {
  const spec: AppToolSpec = { name: "mcp__x", description: "x", parameters: { type: "object", properties: {} } };

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

  test("结果标记:display → {app:{output}};没有 → 空 details,content 原样", async () => {
    const display = [{ type: "image" as const, url: "/api/files/1" }];
    expect((await run({ content: [{ type: "text", text: "t" }], display })).out.details).toEqual({ app: { output: display } });
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
