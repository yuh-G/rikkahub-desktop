// pi-engine/app-tools.test.ts — 应用工具规格 → pi customTools 的包装(契约对照 + 结果标记)
//
// 两类保障:
// 1) 升级回归门:我们移植工具(工作区工具声明来源)与 pi 原版工厂的 name/description/
//    parameters 必须语义全等(键序无关;TypeBox 先 required 后 properties,纯序差);
//    promptSnippet/promptGuidelines 逐字镜像 pi 常量。pi 升级改工具面 → 本测试红,倒逼重新
//    对齐移植层(方案 §〇 升级纪律)。
// 2) 包装语义:execute 只把调用交给应用;应用结果的三种形态(display / details / 纯 content)
//    按约定打 details 标记,事件桥据此还原工具卡。
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-piapptools-test-"));

const conversations = await import("../conversations");
const { configureWorkingSet } = await import("../conversations/working-set");
const { getConversationMeta } = await import("../conversations/read-queries");
const ws = await import("../workspace");
const runtime = await import("../workspace/runtime");
const { workspaceToolSpecs } = await import("../engines/app-tools");
const { createPiAppTools } = await import("./app-tools");
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
const piPromptContributions: Record<string, { snippet: string; guidelines: readonly string[] }> = {
  read: (await import("../../pi/packages/coding-agent/src/core/tools/read.ts")).readToolSystemPromptContribution,
  bash: (await import("../../pi/packages/coding-agent/src/core/tools/bash.ts")).bashToolSystemPromptContribution,
  edit: (await import("../../pi/packages/coding-agent/src/core/tools/edit.ts")).editToolSystemPromptContribution,
  write: (await import("../../pi/packages/coding-agent/src/core/tools/write.ts")).writeToolSystemPromptContribution,
  grep: (await import("../../pi/packages/coding-agent/src/core/tools/grep.ts")).grepToolSystemPromptContribution,
  find: (await import("../../pi/packages/coding-agent/src/core/tools/find.ts")).findToolSystemPromptContribution,
  ls: (await import("../../pi/packages/coding-agent/src/core/tools/ls.ts")).lsToolSystemPromptContribution,
};
import type { AppToolResult, AppToolSpec } from "../engines/contract";

const db = conversations.openConversationsDb();

function installWorkingSet() {
  configureWorkingSet({
    loadConversation: (convId) => {
      const meta = getConversationMeta(db, convId);
      if (!meta) return undefined;
      meta.messages = conversations.loadConversationNodesFromDb(db, convId);
      return meta;
    },
    isGenerating: () => false,
    hasSseClients: () => false,
    hasDirty: () => false,
  });
}
installWorkingSet();
beforeAll(installWorkingSet);

let seq = 0;
function workspaceSpecs(): AppToolSpec[] {
  seq += 1;
  const workspace = ws.createWorkspace({ type: "managed", name: `pi-app-tools-${seq}` });
  const conversation = {
    id: `piapptools-conv-${seq}`,
    assistantId: "a1",
    systemPrompt: null,
    title: `t-${seq}`,
    messages: [],
    chatSuggestions: [],
    isPinned: false,
    createAt: 1000,
    updateAt: 2000,
    workspaceId: workspace.id,
    workspaceCwd: null,
  };
  conversations.persistConversation(conversation);
  return workspaceToolSpecs(conversation as never);
}

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

  test("工作区规格包装:挂载矩阵 + sequential + snippet + edit prepareArguments", () => {
    const tools = createPiAppTools(workspaceSpecs(), undefined);
    expect(tools.map((tool) => tool.name)).toEqual(runtime.mountedWorkspaceToolNames());
    for (const tool of tools) {
      expect(tool.executionMode).toBe("sequential");
      expect(typeof tool.promptSnippet).toBe("string");
      expect((tool.promptSnippet ?? "").length).toBeGreaterThan(0);
      expect(tool.label).toBe(tool.name);
      if (tool.name === "edit") expect(typeof tool.prepareArguments).toBe("function");
      else expect(tool.prepareArguments).toBeUndefined();
    }
  });

  test("promptSnippet/promptGuidelines 逐字镜像 pi 各工具的 SystemPromptContribution 常量(bash 不镜像 PI_* 条目)", () => {
    for (const tool of createPiAppTools(workspaceSpecs(), undefined)) {
      const contribution = piPromptContributions[tool.name];
      expect(contribution).toBeDefined();
      expect(tool.promptSnippet).toBe(contribution!.snippet);
      const expectedGuidelines = tool.name === "bash" || contribution!.guidelines.length === 0 ? undefined : [...contribution!.guidelines];
      expect(tool.promptGuidelines).toEqual(expectedGuidelines);
    }
  });

  test("通用工具(group general)不带 snippet/guidelines,同名也不挂 prepareArguments", () => {
    const [tool] = createPiAppTools(
      [{ name: "edit", description: "d", parameters: { type: "object", properties: {} }, group: "general" }],
      undefined,
    );
    expect(tool?.promptSnippet).toBeUndefined();
    expect(tool?.promptGuidelines).toBeUndefined();
    expect(tool?.prepareArguments).toBeUndefined();
    expect(tool?.executionMode).toBe("sequential");
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
