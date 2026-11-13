// tools/plugin-approval.test.ts — 插件工具审批(P4.3):默认询问;审批卡「此会话内总是允许」只记在本会话、
// 只对带免问键的审批生效;会话删除即忘。
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerationEvent } from "../inference-engine/events";

// paths.ts 在 import 时刻固化 dataDir——必须先设环境变量再动态加载被测模块。
process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-plugin-approval-test-"));

const { pluginToolApprovalState, pluginToolSessionKey } = await import("./approval");
const { gateToolApproval } = await import("../inference-engine/approval-flow");
const gate = await import("../inference-engine/approval-gate");

async function approveOnce(conversationId: string, toolCallId: string, alwaysAllowInSession: boolean, sessionAllowKey?: string) {
  const events: GenerationEvent[] = [];
  const run = gateToolApproval(pluginToolApprovalState(conversationId, "demo-plugin", "lookup"), {
    conversationId,
    toolCallId,
    sink: (event) => void events.push(event),
    ...(sessionAllowKey ? { sessionAllowKey } : {}),
  });
  expect(gate.resolveToolApproval(conversationId, toolCallId, { approved: true, alwaysAllowInSession })).toBe(true);
  expect(await run).toBe(true);
  return events;
}

describe("插件工具审批", () => {
  test("默认询问;待审卡不附缘由", () => {
    expect(pluginToolApprovalState("conv-p0", "demo-plugin", "lookup")).toEqual({ type: "pending" });
  });

  test("只批准一次不记;选了「此会话内总是允许」后本会话免问,别的会话、别的工具、别的插件照问", async () => {
    const key = pluginToolSessionKey("demo-plugin", "lookup");
    await approveOnce("conv-p1", "call-1", false, key);
    expect(pluginToolApprovalState("conv-p1", "demo-plugin", "lookup").type).toBe("pending");

    await approveOnce("conv-p1", "call-2", true, key);
    expect(pluginToolApprovalState("conv-p1", "demo-plugin", "lookup")).toEqual({ type: "auto" });
    expect(pluginToolApprovalState("conv-p2", "demo-plugin", "lookup").type).toBe("pending");
    expect(pluginToolApprovalState("conv-p1", "demo-plugin", "other").type).toBe("pending");
    expect(pluginToolApprovalState("conv-p1", "other-plugin", "lookup").type).toBe("pending");
  });

  test("不带免问键的审批(工作区 / MCP 工具)即使带了「总是允许」也不记", async () => {
    await approveOnce("conv-p3", "call-3", true);
    expect(gate.isToolAllowedForSession("conv-p3", pluginToolSessionKey("demo-plugin", "lookup"))).toBe(false);
  });

  test("会话删除即忘", async () => {
    await approveOnce("conv-p4", "call-4", true, pluginToolSessionKey("demo-plugin", "lookup"));
    expect(pluginToolApprovalState("conv-p4", "demo-plugin", "lookup").type).toBe("auto");
    gate.forgetSessionToolAllowances("conv-p4");
    expect(pluginToolApprovalState("conv-p4", "demo-plugin", "lookup").type).toBe("pending");
  });
});
