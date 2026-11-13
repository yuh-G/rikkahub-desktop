// pi-engine/session-store-roundtrip.test.ts — 会话存储整条链的往返(P3.7 清单 1–5)
//
// 一轮的 pi 条目经写路径(createPiEntrySync → 应用写入方)落进真实 schema 的活库并封存,再由应用
// 视图(buildEngineSessionView)装回 pi(createPiSessionFromView)。单元层的同类断言在 session-view /
// engine-session / engine-entries 的测试里,这里锁的是两侧接起来之后的结果。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { ensureConversationTables, upsertConversationRowInto } from "../conversations/index";
import { ensureMessageFtsTable } from "../conversations/fts";
import { appendEngineEntries, engineVisibleDigest, loadEngineEntries, sealEngineEntries } from "../conversations/engine-entries";
import { buildEngineSessionView, createEngineSessionWriter } from "../conversations/engine-session";
import type { Conversation, Message, ToolPart } from "../foundation/types";
import { message } from "../foundation/utils";
import { PI_ENTRY_FORMAT, createPiEntrySync, createPiSessionFromView, toPiEngineEntry, type PiSessionFromView } from "./session-view";

type PiMessage = Parameters<PiSessionFromView["manager"]["appendMessage"]>[0];

const CONVERSATION_ID = "5d0c2b1a-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const USER_TEXT = "查天气";
const usage = { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistantMeta = { api: "anthropic-messages", provider: "anthropic", model: "claude-x", usage, timestamp: 1 };

function realSchemaDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensureConversationTables(db);
  ensureMessageFtsTable(db);
  return db;
}

function load(db: Database, neutral: Message[], user: Message) {
  const view = buildEngineSessionView(db, {
    conversationId: CONVERSATION_ID,
    engine: "pi",
    neutral,
    enriched: neutral,
    syntheticIds: new Set(),
    userInputs: { [user.id]: { text: USER_TEXT, images: [] } },
    compactions: [],
  });
  return createPiSessionFromView({ cwd: process.cwd(), conversationId: CONVERSATION_ID, view, fallbackModelId: "m" });
}

/** 一轮:装载历史 → pi 追加本轮条目(redacted 与带签名的思考、工具调用、带 details 的工具结果、插件
 *  自定义条目、收尾回答)→ 事件边界与轮末对账交给应用写入方 → 正常结束才封存。 */
async function runRound(options: { seal: boolean }) {
  const db = realSchemaDb();
  const user = message("USER", [{ type: "text", text: USER_TEXT }]);
  const tool = { type: "tool", toolCallId: "tc-1", toolName: "lookup", input: JSON.stringify({ q: "天气" }), output: [{ type: "text", text: "晴" }], approvalState: { type: "auto" } } as ToolPart;
  const ai = message("ASSISTANT", [{ type: "reasoning", reasoning: "想一想" }, tool, { type: "text", text: "今天晴" }], "claude-x");
  const conversation: Conversation = {
    id: CONVERSATION_ID, assistantId: "a1", title: "会话", systemPrompt: null, chatSuggestions: [], isPinned: false, createAt: 1000, updateAt: 2000,
    messages: [user, ai].map((item, index) => ({ id: `n${index}`, messages: [item], selectIndex: 0 })),
  };
  upsertConversationRowInto(db, conversation);

  const { manager } = load(db, [user], user);
  const writer = createEngineSessionWriter(db, CONVERSATION_ID, "pi");
  const errors: unknown[] = [];
  const sync = createPiEntrySync(manager, async (entries) => writer.append(ai.id, entries), (error) => errors.push(error));
  manager.appendMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "enc-1", redacted: true },
      { type: "thinking", thinking: "想一想", thinkingSignature: "sig-1" },
      { type: "toolCall", id: "tc-1", name: "lookup", arguments: { q: "天气" } },
    ],
    stopReason: "toolUse",
    ...assistantMeta,
  } as PiMessage);
  await sync.flush();
  manager.appendMessage({ role: "toolResult", toolCallId: "tc-1", toolName: "lookup", content: [{ type: "text", text: "晴" }], details: { todos: 1 }, isError: false, timestamp: 2 } as PiMessage);
  manager.appendCustomEntry("todo-ext", { tasks: [{ id: 1, text: "RIKKA_TODO_ONE", done: false }] });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "今天晴" }], stopReason: "stop", ...assistantMeta } as PiMessage);
  await sync.flush();
  expect(errors).toEqual([]);
  if (options.seal) writer.seal(conversation);
  return { db, user, ai, original: manager };
}

const contextOf = (loaded: PiSessionFromView) => JSON.stringify(loaded.manager.buildSessionContext().messages);

describe("会话存储往返(P3.7)", () => {
  test("1 无损:封存后重新装载,条目与 pi 上下文和本轮会话内逐字节一致", async () => {
    const round = await runRound({ seal: true });
    const reloaded = load(round.db, [round.user, round.ai], round.user);
    expect(reloaded.degradedMessageIds).toEqual([]);
    expect(JSON.stringify(reloaded.manager.getEntries())).toBe(JSON.stringify(round.original.getEntries()));
    expect(contextOf(reloaded)).toBe(JSON.stringify(round.original.buildSessionContext().messages));
    expect(contextOf(reloaded)).toContain("enc-1");
    expect(contextOf(reloaded)).toContain("sig-1");
  });

  test("2 插件态:工具结果的 details 与插件自定义条目重载后仍在会话分支上", async () => {
    const round = await runRound({ seal: true });
    const reloaded = load(round.db, [round.user, round.ai], round.user);
    const branch = reloaded.manager.getBranch();
    expect(branch.find((entry) => entry.type === "custom")).toMatchObject({ customType: "todo-ext", data: { tasks: [{ id: 1, text: "RIKKA_TODO_ONE", done: false }] } });
    expect(reloaded.manager.buildSessionContext().messages.find((item) => item.role === "toolResult")).toMatchObject({ details: { todos: 1 } });
  });

  test("3 编辑退化:改了助手正文 → 摘要不符 → 整组回退编码,思考被剥,插件条目随之不在", async () => {
    const round = await runRound({ seal: true });
    const edited: Message = { ...round.ai, parts: round.ai.parts.map((part) => (part.type === "text" ? { ...part, text: "今天多云" } : part)) };
    const reloaded = load(round.db, [round.user, edited], round.user);
    expect(reloaded.degradedMessageIds).toEqual([edited.id]);
    expect(contextOf(reloaded)).toContain("今天多云");
    expect(contextOf(reloaded)).not.toContain('"type":"thinking"');
    expect(reloaded.manager.getEntries().some((entry) => entry.type === "custom")).toBe(false);
  });

  test("4 引擎标识不符 / 格式版本不识别:即使已封存也不取用,回退编码", async () => {
    const round = await runRound({ seal: false });
    const stored = round.original.getEntries().slice(1).map(toPiEngineEntry);
    for (const [engine, format] of [["dsh", PI_ENTRY_FORMAT], ["pi", "pi-session-v999"]] as const) {
      round.db.prepare("DELETE FROM pc_engine_entry").run();
      appendEngineEntries(round.db, CONVERSATION_ID, engine, round.ai.id, stored.map((entry) => ({ ...entry, format })));
      sealEngineEntries(round.db, CONVERSATION_ID, engine, round.ai.id, engineVisibleDigest([round.ai]));
      const reloaded = load(round.db, [round.user, round.ai], round.user);
      expect(reloaded.degradedMessageIds).toEqual([round.ai.id]);
      expect(contextOf(reloaded)).not.toContain("sig-1");
    }
  });

  test("5 崩溃中途:条目已写入但轮没正常结束(未封存)→ 回退编码", async () => {
    const round = await runRound({ seal: false });
    expect(loadEngineEntries(round.db, CONVERSATION_ID, "pi").map((group) => [group.anchorMessageId, group.digest, group.entries.length])).toEqual([[round.ai.id, null, 4]]);
    const reloaded = load(round.db, [round.user, round.ai], round.user);
    expect(reloaded.degradedMessageIds).toEqual([round.ai.id]);
    expect(contextOf(reloaded)).not.toContain("sig-1");
  });
});
