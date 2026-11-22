// inference-engine/notices.test.ts — notice 片段发给模型的口径(照 APP 的 expandNotices 与 NoticesTest)
//
// 锁:①在原位置拆成一条只带 text 的用户消息,title 不发;②一轮开头的 notice 在回答之前;③只有 notice 的用户消息
// 拆成每条一条;④没有 notice 的消息原样返回(同一个对象);⑤拆出来的 id 确定,同一历史两次结果相同;⑥聊天引擎的
// 请求体里它在原位置、title 不出现;⑦工作区引擎的回退编码同一规则;⑧全文索引不收、引擎可见摘要收 text。
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-notices-"));

const jsonStore = await import("../persistence/json-store");
const { defaultState } = await import("../app-config/defaults");
const { expandNotices } = await import("./notices");
const { conversationMessagesForApi } = await import("./conversation-encoding");
const { engineVisibleDigest } = await import("../conversations/engine-entries");
const { createPiSessionFromView } = await import("../pi-engine/session-view");
const { sessionViewOf } = await import("../test-utils/engine-session-view");
const { message, textFromParts } = await import("../foundation/utils");

import type { Conversation, Message, MessagePart, Model, State, ToolPart } from "../foundation/types";

const notice = (title: string, text: string): MessagePart => ({ type: "notice", title, text });
const tool: ToolPart = { type: "tool", toolCallId: "c-1", toolName: "bash", input: "{}", output: [{ type: "text", text: "out" }], approvalState: { type: "auto" } };
const shape = (messages: Message[]) => messages.map((item) => [item.role, item.parts.map((part) => (part.type === "text" ? part.text : part.type))]);

describe("expandNotices", () => {
  test("一轮中途到达:在原位置拆开,只发 text", () => {
    const user = message("USER", [{ type: "text", text: "跑一下" }]);
    const answer = message("ASSISTANT", [{ type: "text", text: "开始" }, tool, notice("后台命令已退出", "<notice>exit 0</notice>"), { type: "text", text: "跑完了" }]);
    expect(shape(expandNotices([user, answer]))).toEqual([
      ["USER", ["跑一下"]],
      ["ASSISTANT", ["开始", "tool"]],
      ["USER", ["<notice>exit 0</notice>"]],
      ["ASSISTANT", ["跑完了"]],
    ]);
  });

  test("一轮开头的 notice 在回答之前;只有 notice 的用户消息每条拆成一条", () => {
    const answer = message("ASSISTANT", [notice("t", "先到的通知"), { type: "text", text: "回答" }]);
    expect(shape(expandNotices([answer]))).toEqual([["USER", ["先到的通知"]], ["ASSISTANT", ["回答"]]]);
    const only = message("USER", [notice("a", "第一条"), notice("b", "第二条")]);
    expect(shape(expandNotices([only]))).toEqual([["USER", ["第一条"]], ["USER", ["第二条"]]]);
  });

  test("没有 notice:原样返回;拆出来的 id 确定、沿用所在消息的时间", () => {
    const plain = [message("USER", [{ type: "text", text: "a" }])];
    expect(expandNotices(plain)).toBe(plain);
    const answer = message("ASSISTANT", [notice("t", "x"), { type: "text", text: "y" }]);
    const first = expandNotices([answer]);
    expect(first[0]!.id).toBe(`${answer.id}:notice:0`);
    expect(first[0]!.createdAt).toBe(answer.createdAt);
    expect(expandNotices([answer])).toEqual(first);
  });
});

describe("聊天引擎请求体", () => {
  test("notice 在原位置成为一条 user 消息,title 不出现", () => {
    const next = defaultState() as State;
    next.settings.enableWebSearch = false;
    jsonStore.setState(next);
    const assistant = next.settings.assistants[0]!;
    const nodes = [
      message("USER", [{ type: "text", text: "跑一下" }]),
      message("ASSISTANT", [{ type: "text", text: "在跑" }]),
      message("USER", [notice("后台命令已退出,退出码为 0", "<background_shell_notice>done</background_shell_notice>")]),
      message("ASSISTANT", [{ type: "text", text: "跑完了" }]),
    ].map((item, index) => ({ id: `n${index}`, messages: [item], selectIndex: 0 }));
    const conversation = { id: "notice-conv", assistantId: assistant.id, title: "", systemPrompt: null, messages: nodes, chatSuggestions: [], isPinned: false, createAt: 1, updateAt: 1 } as Conversation;
    const items = conversationMessagesForApi(conversation, assistant).filter((item) => item.role !== "system");
    expect(items.map((item) => [item.role, item.content])).toEqual([
      ["user", "跑一下"],
      ["assistant", "在跑"],
      ["user", "<background_shell_notice>done</background_shell_notice>"],
      ["assistant", "跑完了"],
    ]);
    expect(JSON.stringify(items)).not.toContain("后台命令已退出");
  });
});

describe("工作区引擎回退编码", () => {
  const model = { modelId: "test-model", inputModalities: ["TEXT"] } as unknown as Model;
  const contextOf = (history: Message[]) => {
    const seeded = createPiSessionFromView({ cwd: process.cwd(), conversationId: "notice-pi", view: sessionViewOf(history, { model }), fallbackModelId: "m" });
    return seeded.manager.buildSessionContext().messages.map((item) => {
      const content = (item as { content: unknown }).content;
      const text = Array.isArray(content) ? content.map((block: { type: string; text?: string; name?: string }) => block.text ?? block.name ?? block.type).join("|") : String(content);
      return [item.role, text];
    });
  };

  test("助手消息里的 notice 在原位置断开,成为一条用户消息", () => {
    const user = message("USER", [{ type: "text", text: "跑一下" }]);
    const answer = message("ASSISTANT", [{ type: "text", text: "开始" }, tool, notice("标题", "通知原文"), { type: "text", text: "跑完了" }]);
    expect(contextOf([user, answer])).toEqual([
      ["user", "跑一下"],
      ["assistant", "开始|bash"],
      ["toolResult", "out"],
      ["user", "通知原文"],
      ["assistant", "跑完了"],
    ]);
  });

  test("只有 notice 的用户消息:每条 text 进上下文,title 不进", () => {
    const only = message("USER", [notice("标题一", "原文一"), notice("标题二", "原文二")]);
    const answer = message("ASSISTANT", [{ type: "text", text: "好" }]);
    const context = contextOf([only, answer]);
    expect(context).toEqual([["user", "原文一\n\n原文二"], ["assistant", "好"]]);
  });
});

describe("全文索引与引擎可见摘要", () => {
  test("全文索引只收 text;引擎可见摘要收 notice 的 text,改了原文即失配", () => {
    const parts: MessagePart[] = [{ type: "text", text: "正文" }, notice("标题", "原文")];
    expect(textFromParts(parts)).toBe("正文");
    const row = message("ASSISTANT", parts);
    const edited = { ...row, parts: [{ type: "text", text: "正文" }, notice("标题", "原文改了")] as MessagePart[] };
    const retitled = { ...row, parts: [{ type: "text", text: "正文" }, notice("新标题", "原文")] as MessagePart[] };
    expect(engineVisibleDigest([edited])).not.toBe(engineVisibleDigest([row]));
    expect(engineVisibleDigest([retitled])).toBe(engineVisibleDigest([row]));
  });
});
