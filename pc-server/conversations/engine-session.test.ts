// conversations/engine-session.test.ts — 契约 host.session 应用侧(P3.2)的行为锁。
// 视图:原生条目只在已封存且摘要与富化前的中立消息一致时给出;写入方:锚定、复用消息不封存、
// 会话已删则丢弃;host 口:按 turnId 路由,解绑后 load 拒绝、append 丢弃。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { ensureConversationTables, upsertConversationRowInto } from "./index";
import { ensureMessageFtsTable } from "./fts";
import { appendEngineEntries, engineVisibleDigest, loadEngineEntries, sealEngineEntries } from "./engine-entries";
import { buildEngineSessionView, createEngineSessionWriter, type EngineSessionSource } from "./engine-session";
import { appEngineHost, bindEngineTurn } from "../engines/host";
import { message } from "../foundation/utils";
import type { Conversation, Message, MessageNode } from "../foundation/types";

function realSchemaDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensureConversationTables(db);
  ensureMessageFtsTable(db);
  return db;
}

function conv(id: string, messages: Message[]): Conversation {
  const nodes: MessageNode[] = messages.map((m, i) => ({ id: `${id}-n${i}`, messages: [m], selectIndex: 0 }));
  return { id, assistantId: "a1", title: "会话", systemPrompt: null, messages: nodes, chatSuggestions: [], isPinned: false, createAt: 1000, updateAt: 2000 };
}

function msg(id: string, role: Message["role"], text: string): Message {
  const m = message(role, [{ type: "text", text }]);
  m.id = id;
  return m;
}

/** 富化的效果:模板改写正文(id 不变),外加一条合成行。 */
function enrich(neutral: Message[]): { enriched: Message[]; syntheticIds: Set<string> } {
  const rendered = neutral.map((m) => ({ ...m, parts: m.parts.map((p) => (p.type === "text" ? { ...p, text: `[模板]${p.text}` } : p)) }));
  const reminder = msg("syn-1", "USER", "现在是 10:00");
  return { enriched: [reminder, ...rendered], syntheticIds: new Set([reminder.id]) };
}

function source(neutral: Message[], extra: Partial<EngineSessionSource> = {}): EngineSessionSource {
  const { enriched, syntheticIds } = enrich(neutral);
  return { conversationId: "c1", engine: "pi", neutral, enriched, syntheticIds, userInputs: {}, compactions: [], ...extra };
}

const entry = (payload: string) => ({ format: "pi-3", entryId: payload, payload: { v: payload } });

describe("buildEngineSessionView", () => {
  test("项序 = 富化产物;封存且摘要相符的组挂在消息上;合成行与无条目的行没有 native", () => {
    const db = realSchemaDb();
    const user = msg("u1", "USER", "问");
    const ai = msg("ai1", "ASSISTANT", "答");
    upsertConversationRowInto(db, conv("c1", [user, ai]));
    appendEngineEntries(db, "c1", "pi", "ai1", [entry("e1"), entry("e2")]);
    sealEngineEntries(db, "c1", "pi", "ai1", engineVisibleDigest([ai]));
    const view = buildEngineSessionView(db, source([user, ai], {
      userInputs: { u1: { text: "问", images: [] } },
      compactions: [{ cutMessageId: "u1", summary: "摘要", tokensBefore: 10 }],
    }));
    expect(view.items.map((item) => [item.message.id, item.synthetic, item.native?.map((e) => e.entryId) ?? null])).toEqual([
      ["syn-1", true, null],
      ["u1", false, null],
      ["ai1", false, ["e1", "e2"]],
    ]);
    // 摘要取富化前的中立消息:模板改写了正文也不失配;视图里给的是富化后的消息。
    expect(view.items[2]?.message.parts).toEqual([{ type: "text", text: "[模板]答" }]);
    expect(view.items[1]?.input).toEqual({ text: "问", images: [] });
    expect(view.compactions).toEqual([{ cutMessageId: "u1", summary: "摘要", tokensBefore: 10 }]);
  });

  test("编辑过(摘要失配)/ 未封存 / 别的引擎的条目 → 不给 native", () => {
    const db = realSchemaDb();
    const a1 = msg("a1", "ASSISTANT", "原文");
    const a2 = msg("a2", "ASSISTANT", "未封存");
    const a3 = msg("a3", "ASSISTANT", "dsh 的");
    upsertConversationRowInto(db, conv("c1", [a1, a2, a3]));
    appendEngineEntries(db, "c1", "pi", "a1", [entry("e1")]);
    sealEngineEntries(db, "c1", "pi", "a1", engineVisibleDigest([a1]));
    appendEngineEntries(db, "c1", "pi", "a2", [entry("e2")]);
    appendEngineEntries(db, "c1", "dsh", "a3", [{ format: "dsh-4", payload: 1 }]);
    sealEngineEntries(db, "c1", "dsh", "a3", engineVisibleDigest([a3]));
    const edited = { ...a1, parts: [{ type: "text" as const, text: "改过" }] };
    const view = buildEngineSessionView(db, source([edited, a2, a3]));
    expect(view.items.filter((item) => item.native)).toEqual([]);
  });

  test("活库未打开:视图照常,只是没有 native", () => {
    const ai = msg("ai1", "ASSISTANT", "答");
    const view = buildEngineSessionView(null, source([ai]));
    expect(view.items.map((item) => item.message.id)).toEqual(["syn-1", "ai1"]);
    expect(view.items.some((item) => item.native)).toBe(false);
  });
});

describe("createEngineSessionWriter", () => {
  test("追加锚定到传入的落点;封存按收尾后的内容,装载即有效", () => {
    const db = realSchemaDb();
    const ai1 = msg("ai1", "ASSISTANT", "");
    const c1 = conv("c1", [msg("u1", "USER", "问"), ai1]);
    upsertConversationRowInto(db, c1);
    const writer = createEngineSessionWriter(db, "c1", "pi");
    writer.append("ai1", [entry("e1")]);
    // 补发分裂:落点换到续写消息,同一写入方继续写。
    const ai2 = msg("ai2", "ASSISTANT", "");
    c1.messages.push({ id: "c1-n9", messages: [ai2], selectIndex: 0 });
    writer.append("ai2", [entry("e2")]);
    writer.append("ai2", [entry("e2"), entry("e3")]);
    expect(loadEngineEntries(db, "c1", "pi").map((g) => [g.anchorMessageId, g.digest, g.entries.map((e) => e.entryId)])).toEqual([
      ["ai1", null, ["e1"]],
      ["ai2", null, ["e2", "e3"]],
    ]);
    // 应用收尾改写了正文(输出变换),封存取改写后的内容。
    ai1.parts = [{ type: "text", text: "收尾后 1" }];
    ai2.parts = [{ type: "text", text: "收尾后 2" }];
    writer.seal(c1);
    const view = buildEngineSessionView(db, { ...source(selected(c1)), enriched: selected(c1), syntheticIds: new Set() });
    expect(view.items.map((item) => item.native?.map((e) => e.entryId) ?? null)).toEqual([null, ["e1"], ["e2", "e3"]]);
  });

  test("一次生成第一次写某锚定时清掉更早的条目;入口复用的已有内容消息不封存", () => {
    const db = realSchemaDb();
    const ai = msg("ai1", "ASSISTANT", "上一次的回答");
    const c1 = conv("c1", [ai]);
    upsertConversationRowInto(db, c1);
    appendEngineEntries(db, "c1", "pi", "ai1", [entry("old")]);
    sealEngineEntries(db, "c1", "pi", "ai1", engineVisibleDigest([ai]));
    const writer = createEngineSessionWriter(db, "c1", "pi", { reusedMessageId: "ai1" });
    writer.append("ai1", [entry("new")]);
    writer.seal(c1);
    expect(loadEngineEntries(db, "c1", "pi").map((g) => [g.anchorMessageId, g.digest, g.entries.map((e) => e.entryId)])).toEqual([
      ["ai1", null, ["new"]],
    ]);
  });

  test("会话已删除:追加丢弃;锚定消息已不在会话里:封存跳过;空批次不动库", () => {
    const db = realSchemaDb();
    const c1 = conv("c1", [msg("ai1", "ASSISTANT", "答")]);
    upsertConversationRowInto(db, c1);
    const writer = createEngineSessionWriter(db, "c1", "pi");
    writer.append("ai1", []);
    writer.append("gone", [entry("e1")]);
    writer.seal(c1);
    expect(loadEngineEntries(db, "c1", "pi")[0]?.digest).toBeNull();
    db.prepare("DELETE FROM pc_conversation WHERE id = 'c1'").run();
    writer.append("ai1", [entry("e2")]);
    expect(loadEngineEntries(db, "c1", "pi")).toEqual([]);
  });

  test("写入失败:照常抛出,这个锚定本次不封存(组里可能缺条目)", () => {
    const db = realSchemaDb();
    const ai1 = msg("ai1", "ASSISTANT", "答");
    const c1 = conv("c1", [ai1]);
    upsertConversationRowInto(db, c1);
    const writer = createEngineSessionWriter(db, "c1", "pi");
    writer.append("ai1", [entry("e1")]);
    // BigInt 无法序列化:模拟写库失败。
    expect(() => writer.append("ai1", [{ format: "f", entryId: "e2", payload: 1n as never }])).toThrow();
    writer.seal(c1);
    expect(loadEngineEntries(db, "c1", "pi").map((g) => [g.digest, g.entries.map((e) => e.entryId)])).toEqual([[null, ["e1"]]]);
  });
});

describe("appEngineHost.session", () => {
  const view = { items: [], compactions: [] };
  const binding = (append?: (entries: unknown[]) => void) => ({ sink: () => undefined, providers: [], session: { view, ...(append ? { append } : {}) } });

  test("按 turnId 路由;解绑后 load 拒绝、append 丢弃", async () => {
    const turn = { conversationId: "c-host", turnId: "t-host" };
    const got: unknown[][] = [];
    const unbind = bindEngineTurn(turn, binding((entries) => void got.push(entries)));
    expect(await appEngineHost.session.load(turn)).toBe(view);
    await appEngineHost.session.append(turn, [entry("e1")]);
    expect(got).toEqual([[entry("e1")]]);
    unbind();
    await expect(appEngineHost.session.load(turn)).rejects.toThrow("会话视图通道未接线");
    await appEngineHost.session.append(turn, [entry("e2")]);
    expect(got.length).toBe(1);
  });

  test("不接收条目的调用(压缩):append 以错误拒绝", async () => {
    const turn = { conversationId: "c-host", turnId: "t-compact" };
    const unbind = bindEngineTurn(turn, binding());
    await expect(appEngineHost.session.append(turn, [entry("e1")])).rejects.toThrow("本次调用不接收原生条目");
    unbind();
  });
});

function selected(conversation: Conversation): Message[] {
  return conversation.messages.map((node) => node.messages[node.selectIndex]!);
}
