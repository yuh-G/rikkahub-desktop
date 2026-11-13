// conversations/engine-entries.test.ts — 引擎私有条目存储(P3.1)的行为锁。
// 建表走生产同款 ensureConversationTables(foreign_keys=ON),级联与重灌在真实 schema 上验证。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { ensureConversationTables, migrateConversationsIntoDb, upsertConversationRowInto } from "./index";
import { ensureMessageFtsTable } from "./fts";
import {
  appendEngineEntries,
  copyEngineEntries,
  copyEngineTablesInto,
  engineVisibleDigest,
  loadEngineEntries,
  pruneOrphanEngineEntries,
  readEngineSessionHeader,
  readEngineTables,
  refillEngineTables,
  sealEngineEntries,
  writeEngineSessionHeader,
} from "./engine-entries";
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

function assistantWithTool(): Message {
  const m = message("ASSISTANT", [
    { type: "reasoning", reasoning: "想一想", createdAt: "2026-11-12T00:00:00Z", finishedAt: "2026-11-12T00:00:01Z" },
    { type: "text", text: "答案" },
    { type: "tool", toolCallId: "call_1", toolName: "read", input: '{"path":"a"}', output: [{ type: "text", text: "内容" }], approvalState: { type: "auto" } },
  ], "model-a");
  m.id = "ai-1";
  return m;
}

function countRows(db: Database, conversationId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM pc_engine_entry WHERE conversation_id = ?").get(conversationId) as { n: number }).n;
}

describe("engineVisibleDigest:只认引擎可见内容", () => {
  test("计时戳 / 用量 / 翻译 / modelId / 注解 / part metadata / 审批态 / loading 占位不影响摘要", () => {
    const base = assistantWithTool();
    const digest = engineVisibleDigest([base]);
    const noisy = structuredClone(base);
    noisy.createdAt = "2030-01-01T00:00:00Z";
    noisy.finishedAt = null;
    noisy.modelId = "model-b";
    noisy.usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 } as Message["usage"];
    noisy.translation = "translated";
    noisy.annotations = [{ type: "steered" }];
    noisy.parts[0] = { type: "reasoning", reasoning: "想一想" };
    noisy.parts[1] = { type: "text", text: "答案", metadata: { ocrText: "x" } };
    const tool = noisy.parts[2];
    if (tool.type !== "tool") throw new Error("unreachable");
    tool.approvalState = { type: "approved" };
    tool.metadata = { toolFinishedAt: "2026-11-12T00:00:02Z" };
    noisy.parts.push({ type: "loading" });
    expect(engineVisibleDigest([noisy])).toBe(digest);
  });

  test("文本 / 思考 / 工具入参 / 工具输出 / 消息 id / 角色 任一变化都失配", () => {
    const base = assistantWithTool();
    const digest = engineVisibleDigest([base]);
    const mutations: Array<(m: Message) => void> = [
      (m) => { m.parts[1] = { type: "text", text: "答案(改)" }; },
      (m) => { m.parts[0] = { type: "reasoning", reasoning: "另一种想法" }; },
      (m) => { const t = m.parts[2]; if (t.type === "tool") t.input = '{"path":"b"}'; },
      (m) => { const t = m.parts[2]; if (t.type === "tool") t.output = [{ error: "失败" }]; },
      (m) => { m.id = "ai-2"; },
      (m) => { m.role = "USER"; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(base);
      mutate(changed);
      expect(engineVisibleDigest([changed])).not.toBe(digest);
    }
  });

  test("一轮多条消息:顺序参与摘要", () => {
    const user = message("USER", [{ type: "text", text: "问" }]);
    const ai = assistantWithTool();
    expect(engineVisibleDigest([user, ai])).not.toBe(engineVisibleDigest([ai, user]));
  });
});

describe("装载 / 追加 / 封存", () => {
  test("未封存的组无效;封存后有效;组内一行未封存则整组无效", () => {
    const db = realSchemaDb();
    upsertConversationRowInto(db, conv("c1", []));
    appendEngineEntries(db, "c1", "pi", "m1", [{ format: "pi-3", entryId: "e1", payload: { a: 1 } }]);
    expect(loadEngineEntries(db, "c1", "pi")).toEqual([
      { anchorMessageId: "m1", digest: null, entries: [{ seq: 0, format: "pi-3", entryId: "e1", payload: { a: 1 } }] },
    ]);
    expect(sealEngineEntries(db, "c1", "pi", "m1", "d1")).toBe(1);
    expect(loadEngineEntries(db, "c1", "pi")[0]?.digest).toBe("d1");
    appendEngineEntries(db, "c1", "pi", "m1", [{ format: "pi-3", entryId: "e2", payload: { b: 2 } }]);
    expect(loadEngineEntries(db, "c1", "pi")[0]?.digest).toBeNull();
    expect(sealEngineEntries(db, "c1", "pi", "m1", "d2")).toBe(2);
    expect(loadEngineEntries(db, "c1", "pi")[0]?.digest).toBe("d2");
  });

  test("seq 跨锚定续号,组按锚定首次出现排序;按引擎隔离", () => {
    const db = realSchemaDb();
    upsertConversationRowInto(db, conv("c1", []));
    appendEngineEntries(db, "c1", "pi", "m1", [{ format: "f", payload: 1 }, { format: "f", payload: 2 }]);
    appendEngineEntries(db, "c1", "pi", "m2", [{ format: "f", payload: 3 }]);
    appendEngineEntries(db, "c1", "dsh", "m1", [{ format: "dsh-4", payload: "x" }]);
    const groups = loadEngineEntries(db, "c1", "pi");
    expect(groups.map((g) => [g.anchorMessageId, g.entries.map((e) => e.seq)])).toEqual([["m1", [0, 1]], ["m2", [2]]]);
    expect(loadEngineEntries(db, "c1", "dsh")[0]?.entries.map((e) => e.seq)).toEqual([0]);
  });

  test("entry_id 重复的条目跳过(对账重放幂等),无 id 的条目照常追加", () => {
    const db = realSchemaDb();
    upsertConversationRowInto(db, conv("c1", []));
    expect(appendEngineEntries(db, "c1", "pi", "m1", [{ format: "f", entryId: "e1", payload: 1 }])).toBe(1);
    expect(appendEngineEntries(db, "c1", "pi", "m1", [{ format: "f", entryId: "e1", payload: 1 }, { format: "f", entryId: "e2", payload: 2 }])).toBe(1);
    expect(appendEngineEntries(db, "c1", "pi", "m1", [{ format: "f", payload: 3 }, { format: "f", payload: 3 }])).toBe(2);
    expect(loadEngineEntries(db, "c1", "pi")[0]?.entries.map((e) => [e.seq, e.entryId])).toEqual([[0, "e1"], [1, "e2"], [2, null], [3, null]]);
  });

  test("payload 损坏 → 该组无效,其他组不受影响", () => {
    const db = realSchemaDb();
    upsertConversationRowInto(db, conv("c1", []));
    appendEngineEntries(db, "c1", "pi", "m1", [{ format: "f", payload: 1 }]);
    appendEngineEntries(db, "c1", "pi", "m2", [{ format: "f", payload: 2 }]);
    sealEngineEntries(db, "c1", "pi", "m1", "d1");
    sealEngineEntries(db, "c1", "pi", "m2", "d2");
    db.prepare("UPDATE pc_engine_entry SET payload = '{broken' WHERE anchor_message_id = 'm1'").run();
    const groups = loadEngineEntries(db, "c1", "pi");
    expect(groups.map((g) => g.digest)).toEqual([null, "d2"]);
  });

  test("会话头:写入覆盖、按引擎隔离、损坏按无头", () => {
    const db = realSchemaDb();
    upsertConversationRowInto(db, conv("c1", []));
    expect(readEngineSessionHeader(db, "c1", "dsh")).toBeNull();
    writeEngineSessionHeader(db, "c1", "dsh", { format: "dsh-4", header: { version: 4 } });
    writeEngineSessionHeader(db, "c1", "dsh", { format: "dsh-4", header: { version: 4, cwd: "/w" } });
    expect(readEngineSessionHeader(db, "c1", "dsh")).toEqual({ format: "dsh-4", header: { version: 4, cwd: "/w" } });
    expect(readEngineSessionHeader(db, "c1", "pi")).toBeNull();
    db.prepare("UPDATE pc_engine_session SET header = 'nope'").run();
    expect(readEngineSessionHeader(db, "c1", "dsh")).toBeNull();
  });
});

describe("生命周期:级联 / 孤儿 / 转储 / 重灌", () => {
  test("删会话 → 条目与会话头级联删除", () => {
    const db = realSchemaDb();
    upsertConversationRowInto(db, conv("c1", []));
    appendEngineEntries(db, "c1", "pi", "m1", [{ format: "f", payload: 1 }]);
    writeEngineSessionHeader(db, "c1", "pi", { format: "f", header: {} });
    db.prepare("DELETE FROM pc_conversation WHERE id = 'c1'").run();
    expect(countRows(db, "c1")).toBe(0);
    expect(readEngineSessionHeader(db, "c1", "pi")).toBeNull();
  });

  test("会话行 upsert(ON CONFLICT DO UPDATE)不级联清条目", () => {
    const db = realSchemaDb();
    upsertConversationRowInto(db, conv("c1", []));
    appendEngineEntries(db, "c1", "pi", "m1", [{ format: "f", payload: 1 }]);
    upsertConversationRowInto(db, { ...conv("c1", []), title: "改名" });
    expect(countRows(db, "c1")).toBe(1);
  });

  test("清孤儿:只删锚定消息已不在会话里的条目,不跨会话", () => {
    const db = realSchemaDb();
    upsertConversationRowInto(db, conv("c1", []));
    upsertConversationRowInto(db, conv("c2", []));
    appendEngineEntries(db, "c1", "pi", "keep", [{ format: "f", payload: 1 }]);
    appendEngineEntries(db, "c1", "pi", "gone", [{ format: "f", payload: 2 }, { format: "f", payload: 3 }]);
    appendEngineEntries(db, "c2", "pi", "gone", [{ format: "f", payload: 4 }]);
    pruneOrphanEngineEntries(db, "c1", new Set(["keep"]));
    expect(loadEngineEntries(db, "c1", "pi").map((g) => g.anchorMessageId)).toEqual(["keep"]);
    expect(countRows(db, "c2")).toBe(1);
  });

  test("分叉复制:只复制锚定在给定消息上的条目,seq / 封存 / 各引擎原样;会话头不复制,源会话不动", () => {
    const db = realSchemaDb();
    upsertConversationRowInto(db, conv("c1", []));
    upsertConversationRowInto(db, conv("c2", []));
    appendEngineEntries(db, "c1", "pi", "m1", [{ format: "f", entryId: "e1", payload: 1 }]);
    sealEngineEntries(db, "c1", "pi", "m1", "d1");
    appendEngineEntries(db, "c1", "pi", "m2", [{ format: "f", entryId: "e2", payload: 2 }]);
    appendEngineEntries(db, "c1", "pi", "m3", [{ format: "f", entryId: "e3", payload: 3 }]);
    appendEngineEntries(db, "c1", "dsh", "m1", [{ format: "g", payload: 4 }]);
    writeEngineSessionHeader(db, "c1", "pi", { format: "f", header: { id: "c1" } });
    const rowsOf = (conversationId: string) =>
      db.prepare("SELECT engine, seq, anchor_message_id, entry_id, payload, digest FROM pc_engine_entry WHERE conversation_id = ? ORDER BY engine, seq").all(conversationId);
    const before = rowsOf("c1");

    expect(copyEngineEntries(db, "c1", "c2", new Set(["m1", "m2"]))).toBe(3);
    expect(rowsOf("c2")).toEqual((before as Array<{ anchor_message_id: string }>).filter((row) => row.anchor_message_id !== "m3"));
    expect(loadEngineEntries(db, "c2", "pi").map((g) => [g.anchorMessageId, g.digest])).toEqual([["m1", "d1"], ["m2", null]]);
    expect(readEngineSessionHeader(db, "c2", "pi")).toBeNull();
    expect(rowsOf("c1")).toEqual(before);
  });

  test("转储:ATTACH 库里两表逐行一致;无两表的库读出 null", () => {
    const db = realSchemaDb();
    upsertConversationRowInto(db, conv("c1", []));
    appendEngineEntries(db, "c1", "pi", "m1", [{ format: "f", entryId: "e1", payload: { k: "v" } }]);
    sealEngineEntries(db, "c1", "pi", "m1", "d1");
    writeEngineSessionHeader(db, "c1", "dsh", { format: "dsh-4", header: { version: 4 } });
    db.exec("ATTACH DATABASE ':memory:' AS pcdump");
    copyEngineTablesInto(db, "pcdump");
    const dumped = {
      sessions: db.prepare("SELECT * FROM pcdump.pc_engine_session").all(),
      entries: db.prepare("SELECT * FROM pcdump.pc_engine_entry").all(),
    };
    expect(dumped).toEqual(readEngineTables(db)!);
    expect(dumped.entries).toEqual([{ conversation_id: "c1", engine: "pi", seq: 0, format: "f", anchor_message_id: "m1", entry_id: "e1", payload: '{"k":"v"}', digest: "d1" }]);
    db.exec("DETACH DATABASE pcdump");
    expect(readEngineTables(new Database(":memory:"))).toBeNull();
  });

  test("重灌:只写回会话仍在、锚定消息仍在的行,封存值原样", () => {
    const db = realSchemaDb();
    const user = message("USER", [{ type: "text", text: "问" }]);
    const ai = assistantWithTool();
    const c1 = conv("c1", [user, ai]);
    migrateConversationsIntoDb(db, [c1, conv("c2", [])]);
    appendEngineEntries(db, "c1", "pi", ai.id, [{ format: "f", entryId: "e1", payload: 1 }]);
    appendEngineEntries(db, "c1", "pi", "deleted-msg", [{ format: "f", entryId: "e2", payload: 2 }]);
    appendEngineEntries(db, "c2", "pi", "x", [{ format: "f", payload: 3 }]);
    sealEngineEntries(db, "c1", "pi", ai.id, "d-ai");
    writeEngineSessionHeader(db, "c1", "dsh", { format: "dsh-4", header: {} });
    writeEngineSessionHeader(db, "c2", "dsh", { format: "dsh-4", header: {} });
    const snapshot = readEngineTables(db)!;
    db.transaction(() => {
      db.exec("DELETE FROM pc_conversation");
      migrateConversationsIntoDb(db, [c1]);
      refillEngineTables(db, snapshot, [c1]);
    })();
    expect(loadEngineEntries(db, "c1", "pi")).toEqual([
      { anchorMessageId: ai.id, digest: "d-ai", entries: [{ seq: 0, format: "f", entryId: "e1", payload: 1 }] },
    ]);
    expect(readEngineSessionHeader(db, "c1", "dsh")).not.toBeNull();
    expect(readEngineSessionHeader(db, "c2", "dsh")).toBeNull();
    expect(countRows(db, "c2")).toBe(0);
  });
});
