// engines/app-tools-general.test.ts — 通用工具/MCP 桥在应用侧的规格与执行(方案 §3.2/§4.9)
//
// 钉住三条语义:
//   1) 工具面枚举与聊天引擎同源同开关:enableWebSearch 关 → search 对不声明;
//      MCP 面跟随 assistant.mcpServers 选择 + 服务器/工具 enable;
//   2) 审批语义与聊天引擎同口径:MCP 工具 needsApproval → pending 卡 → 拒绝回灌
//      拒绝理由并抛错;auto 工具(save_memory)不产卡直通执行;
//   3) 执行路由走 executeToolCall(真跑 save_memory:进待确认队列,单文本结果
//      不带 display → 事件桥按 content 文本渲染)。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-generaltools-test-"));

const { createAppToolCaller, generalToolSpecs } = await import("./app-tools");
const { resolveToolApproval } = await import("../inference-engine/approval-gate");
const { defaultAssistant } = await import("../assistants");
const { defaultState } = await import("../app-config/defaults");
// 注意:store.state 是 live binding,解构成局部 const 会拿到 import 时的旧值(undefined)。
const store = await import("../persistence/json-store");

import type { Assistant, Conversation, Model, State } from "../foundation/types";
import type { GenerationEvent } from "../inference-engine/events";

const priorState = store.state;
store.setState(defaultState() as State);
store.state.settings.enableWebSearch = true;
store.state.settings.mcpServers = [
  {
    id: "srv1",
    commonOptions: {
      name: "Fake Server",
      enable: true,
      tools: [
        {
          name: "alpha",
          enable: true,
          needsApproval: true,
          description: "Alpha tool",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
        },
        { name: "beta", enable: true, needsApproval: false, description: "Beta tool" },
      ],
    },
  },
] as State["settings"]["mcpServers"];
afterAll(() => {
  store.setState(priorState);
});

let seq = 0;
function fixture(overrides: Partial<Assistant> = {}) {
  seq += 1;
  const assistant: Assistant = {
    ...defaultAssistant(),
    id: `gt-a-${seq}`,
    mcpServers: ["srv1"],
    enableMemory: true,
    ...overrides,
  };
  const conversation = {
    id: `gt-c-${seq}`,
    assistantId: assistant.id,
    title: "通用工具测试",
    messages: [],
  } as unknown as Conversation;
  const events: GenerationEvent[] = [];
  const ctx = { conversation, assistant, sink: (event: GenerationEvent) => void events.push(event) };
  return { assistant, conversation, events, ctx };
}

function approvalEvents(events: GenerationEvent[]) {
  return events.filter((event) => event.kind === "tool_approval_updated");
}

type Ctx = ReturnType<typeof fixture>["ctx"];

function specsOf(ctx: Ctx & { model?: Model | null }) {
  return generalToolSpecs(ctx.assistant, ctx.model);
}

/** 应用侧调用入口(生产 = host.tools.call 落到这里)。 */
function callerFor(ctx: Ctx) {
  const call = createAppToolCaller(ctx, specsOf(ctx));
  return (toolCallId: string, name: string, args: Record<string, unknown>) => call({ toolCallId, name, args: args as never });
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return String(result.content[0]?.text ?? "");
}

describe("工具面枚举", () => {
  test("search/save_memory/MCP 全在列,开关同聊天引擎同源", () => {
    const { ctx } = fixture();
    const names = specsOf(ctx).map((tool) => tool.name);
    expect(names).toEqual(["search_web", "scrape_web", "save_memory", "mcp__alpha", "mcp__beta"]);

    store.state.settings.enableWebSearch = false;
    try {
      const closed = specsOf(ctx).map((tool) => tool.name);
      expect(closed).toEqual(["save_memory", "mcp__alpha", "mcp__beta"]);
    } finally {
      store.state.settings.enableWebSearch = true;
    }
  });

  test("未选该 MCP 服务器的助手看不到其工具;声明面带 schema", () => {
    const { ctx } = fixture({ mcpServers: [] });
    const names = specsOf(ctx).map((tool) => tool.name);
    expect(names.every((name) => !name.startsWith("mcp__"))).toBe(true);

    const { ctx: withMcp } = fixture();
    const alpha = specsOf(withMcp).find((tool) => tool.name === "mcp__alpha");
    expect(alpha?.description).toBe("Alpha tool");
    expect((alpha?.parameters as { properties?: Record<string, unknown> }).properties).toHaveProperty("q");
  });

  // 防双搜(对齐安卓 shouldUseExternalWebSearch):pi 引擎经同一注入源 openAiSearchTools
  // 消费同一谓词。模型声明内置 search 时外挂 search_web/scrape_web 让位,与聊天引擎同闸。
  test("模型带内置 search → 外挂搜索让位(防双搜同闸)", () => {
    const { ctx } = fixture({ mcpServers: [] });
    const builtIn = { ...ctx, model: { tools: ["search"] } as unknown as Model };
    const names = specsOf(builtIn).map((tool) => tool.name);
    expect(names).not.toContain("search_web");
    expect(names).not.toContain("scrape_web");

    // 无内置搜索的模型(常态)→ 外挂照常,证明让位是内置 search 触发而非误伤。
    const plain = { ...ctx, model: { tools: [] } as unknown as Model };
    expect(specsOf(plain).map((tool) => tool.name)).toContain("search_web");
  });
});

describe("审批语义(同聊天引擎口径)", () => {
  test("needsApproval 的 MCP 工具:pending 卡 → 用户拒绝 → 拒绝理由回灌并抛错", async () => {
    const { ctx, conversation, events } = fixture();
    const running = callerFor(ctx)("call-1", "mcp__alpha", { q: "hi" });
    await Bun.sleep(10);
    expect(approvalEvents(events).map((event) => event.approvalState.type)).toEqual(["pending"]);

    expect(resolveToolApproval(conversation.id, "call-1", { approved: false, reason: "不允许" })).toBe(true);
    await expect(running).rejects.toThrow("Tool execution denied by user. Reason: 不允许");
    const states = approvalEvents(events).map((event) => event.approvalState);
    expect(states.at(-1)).toEqual({ type: "denied", reason: "不允许" });
  });

  test("needsApproval=false 的 MCP 工具与 save_memory 都是 auto:不产卡", async () => {
    const { ctx, events } = fixture();
    const result = await callerFor(ctx)("call-2", "save_memory", { content: "用户喜欢简洁回答" });
    expect(approvalEvents(events)).toEqual([]);
    expect(result.content[0]?.type).toBe("text");
    expect(textOf(result).length).toBeGreaterThan(0);
    // 单文本结果不带 display → 事件桥按 content 渲染
    expect(result.display).toBeUndefined();
  });
});

describe("调用入口", () => {
  test("只认本轮下发过的规格:未知工具名以错误拒绝", async () => {
    const { ctx } = fixture({ mcpServers: [] });
    await expect(callerFor(ctx)("call-x", "mcp__alpha", {})).rejects.toThrow("Unknown tool: mcp__alpha");
  });
});

describe("ask_user(run-and-suspend 提问)", () => {
  const withAskUser = { localTools: [{ type: "ask_user" }] };

  test("挂载随助手 localTools 开关;声明面含 selection_type 枚举", () => {
    const off = specsOf(fixture().ctx).map((tool) => tool.name);
    expect(off).not.toContain("ask_user");

    const { ctx } = fixture(withAskUser);
    const ask = specsOf(ctx).find((tool) => tool.name === "ask_user");
    if (!ask) throw new Error("ask_user missing");
    const items = (ask.parameters as { properties?: { questions?: { items?: { properties?: Record<string, unknown> } } } })
      .properties?.questions?.items?.properties;
    expect(items).toHaveProperty("selection_type");
  });

  test("作答:execute 挂起 → resolve 携 answer → 回灌文本为扁平契约(与聊天引擎逐字一致)", async () => {
    const { ctx, conversation, events } = fixture(withAskUser);
    const questions = [{ id: "q1", question: "选哪个?", selection_type: "multi", options: ["甲", "乙"] }];
    const running = callerFor(ctx)("call-q1", "ask_user", { questions });
    await Bun.sleep(10);
    expect(approvalEvents(events).map((e) => e.approvalState.type)).toEqual(["pending"]);

    const payload = JSON.stringify({ answers: { q1: "甲, 乙, 都要" } });
    expect(resolveToolApproval(conversation.id, "call-q1", { approved: true, answer: payload })).toBe(true);

    const result = await running;
    expect(textOf(result)).toBe(payload);
    // 单文本结果不带 display → 事件桥按 content 渲染(与聊天 answered 回放同字符串)。
    expect(result.display).toBeUndefined();
    expect(approvalEvents(events).at(-1)?.approvalState).toEqual({ type: "answered", answer: payload });
  });

  test("拒绝:抛历史契约文案(桥映射 {error})", async () => {
    const { ctx, conversation } = fixture(withAskUser);
    const running = callerFor(ctx)("call-q2", "ask_user", { questions: [{ id: "q", question: "?" }] });
    await Bun.sleep(10);
    expect(resolveToolApproval(conversation.id, "call-q2", { approved: false, reason: "跳过" })).toBe(true);
    await expect(running).rejects.toThrow("Tool execution denied by user. Reason: 跳过");
  });

  test("非法入参(零题/超上限)→ 抛错回灌模型重试,不挂卡", async () => {
    const { ctx, events } = fixture(withAskUser);
    await expect(callerFor(ctx)("call-q3", "ask_user", { questions: [] })).rejects.toThrow(/at least one valid question/);
    expect(approvalEvents(events)).toEqual([]);
  });
});
