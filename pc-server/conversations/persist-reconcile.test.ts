// conversations/persist-reconcile.test.ts — 落库对账(PF.2)。
// 契约:①结果对等——随机一串操作之后,对账落库的节点表、索引内容、引擎私有条目与「删光重插」的旧写法逐行相同;
// ②写入量——只改最后一个节点时改动行数是常数,与会话长度、库里别的会话无关;什么都没改时节点表与索引零改动;
// ③流式——流式 flush 已写入最终内容后再对账,索引是最终内容;只做过流式 flush 就重开库,下次保存补上索引;
// ④引擎私有条目——消息离开会话时清孤儿,没有消息离开时不触发清理;⑤对账的查询走索引。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureConversationTables, loadConversationNodesFromDb, persistConversationInto, upsertConversationRowInto, upsertMessageNodeInto } from "./index";
import { ensureMessageFtsTable, replaceNodeFts, searchMessageFts } from "./fts";
import { appendEngineEntries, pruneOrphanEngineEntries } from "./engine-entries";
import { message } from "../foundation/utils";
import type { Conversation, Message, MessageNode } from "../foundation/types";

function realSchemaDb(path = ":memory:"): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  ensureConversationTables(db);
  ensureMessageFtsTable(db);
  return db;
}

function msg(text: string, role: "USER" | "ASSISTANT" = "ASSISTANT"): Message {
  return message(role, text ? [{ type: "text", text }] : []);
}
function node(idValue: string, ...texts: string[]): MessageNode {
  return { id: idValue, messages: texts.map((text) => msg(text)), selectIndex: 0 };
}
function conv(idValue: string, nodes: MessageNode[]): Conversation {
  return { id: idValue, assistantId: "a1", title: idValue, systemPrompt: null, messages: nodes, chatSuggestions: [], isPinned: false, createAt: 1000, updateAt: 2000 };
}

// PF.2 之前的 persistConversation(删掉这个会话的全部节点行,按顺序重插并重建索引,每次都清引擎条目孤儿)原样抄在这里,仅作对照。
function legacyPersist(db: Database, c: Conversation): void {
  db.transaction(() => {
    upsertConversationRowInto(db, c);
    db.prepare("DELETE FROM pc_message_node WHERE conversation_id = ?").run(c.id);
    const insertNode = db.prepare(
      "INSERT INTO pc_message_node (id, conversation_id, node_index, messages, select_index) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id, node_index = excluded.node_index, messages = excluded.messages, select_index = excluded.select_index",
    );
    for (let i = 0; i < (c.messages ?? []).length; i += 1) {
      const n = c.messages[i];
      if (!n?.id) continue;
      insertNode.run(n.id, c.id, i, JSON.stringify(n.messages ?? []), n.selectIndex ?? 0);
      replaceNodeFts(db, c.id, n);
    }
    pruneOrphanEngineEntries(db, c.id, new Set((c.messages ?? []).flatMap((n) => n.messages.map((m) => m.id))));
  })();
}

const totalChanges = (db: Database) => (db.query("SELECT total_changes() AS n").get() as { n: number }).n;
const hitNodes = (db: Database, q: string) => searchMessageFts(db, q).map((h) => h.nodeId).sort();
const snapshot = (db: Database) => ({
  nodes: db.query("SELECT id, conversation_id, node_index, messages, select_index FROM pc_message_node ORDER BY id").all(),
  fts: db.query("SELECT text, conversation_id, node_id, message_id FROM pc_message_fts ORDER BY node_id, message_id, text").all(),
  dir: db.query("SELECT d.node_id, f.message_id FROM pc_message_fts_dir d JOIN pc_message_fts f ON f.rowid = d.fts_rowid ORDER BY d.node_id, f.message_id").all(),
  dangling: (db.query("SELECT COUNT(*) AS n FROM pc_message_fts_docsize").get() as { n: number }).n - (db.query("SELECT COUNT(*) AS n FROM pc_message_fts_dir").get() as { n: number }).n,
  entries: db.query("SELECT conversation_id, engine, seq, anchor_message_id, entry_id FROM pc_engine_entry ORDER BY conversation_id, engine, seq").all(),
});

describe("结果对等:随机操作序列", () => {
  test("对账落库与删光重插逐行相同(节点表、索引、目录、引擎私有条目、搜索命中)", () => {
    const dbNew = realSchemaDb();
    const dbOld = realSchemaDb();
    let rng = 20261119;
    const rand = (n: number) => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff), rng % n);
    const WORDS = Array.from({ length: 40 }, (_, i) => `词条${String.fromCharCode(0x4e00 + i * 37)}${i}号`);
    const text = () => Array.from({ length: 2 + rand(2) }, () => WORDS[rand(WORDS.length)]).join(" ");
    let k = 0;
    const both = (fn: (db: Database) => void) => [dbNew, dbOld].forEach(fn);
    const other = conv("other", [node("o1", "别的会话不该被动"), node("o2", WORDS[0]!)]);
    persistConversationInto(dbNew, other);
    legacyPersist(dbOld, other);
    const c = conv("c1", [node(`n${k++}`, text())]);
    const persistBoth = () => {
      persistConversationInto(dbNew, c);
      legacyPersist(dbOld, c);
    };
    persistBoth();
    const pick = () => c.messages[rand(c.messages.length)]!;
    const ops: Array<[string, number, () => boolean]> = [
      ["append", 6, () => (c.messages.push({ id: `n${k++}`, messages: [msg(text(), rand(2) ? "USER" : "ASSISTANT")], selectIndex: 0 }), true)],
      ["edit", 5, () => {
        if (!c.messages.length) return false;
        const n = pick();
        n.messages[n.selectIndex]!.parts = [{ type: "text", text: text() }];
        return true;
      }],
      ["replace-message", 2, () => {
        if (!c.messages.length) return false;
        const n = pick();
        n.messages[n.selectIndex] = msg(text());
        return true;
      }],
      ["add-version", 3, () => {
        if (!c.messages.length) return false;
        const n = pick();
        n.messages.push(msg(text()));
        n.selectIndex = n.messages.length - 1;
        return true;
      }],
      ["select", 3, () => {
        const n = c.messages.find((x) => x.messages.length > 1);
        if (!n) return false;
        n.selectIndex = (n.selectIndex + 1) % n.messages.length;
        return true;
      }],
      ["delete", 3, () => (c.messages.length ? (c.messages.splice(rand(c.messages.length), 1), true) : false)],
      ["swap", 2, () => {
        if (c.messages.length < 2) return false;
        const a = rand(c.messages.length);
        const b = (a + 1 + rand(c.messages.length - 1)) % c.messages.length;
        [c.messages[a], c.messages[b]] = [c.messages[b]!, c.messages[a]!];
        return true;
      }],
      ["empty", 1, () => (c.messages.push({ id: `n${k++}`, messages: [msg("")], selectIndex: 0 }), true)],
      ["stream", 4, () => {
        if (!c.messages.length || rand(3) === 0) c.messages.push({ id: `n${k++}`, messages: [msg("")], selectIndex: 0 });
        const idx = c.messages.length - 1;
        const n = c.messages[idx]!;
        for (let i = 0; i < 2; i++) {
          n.messages[n.selectIndex]!.parts = [{ type: "text", text: text() }];
          both((db) => upsertMessageNodeInto(db, c.id, n, idx, false));
        }
        return rand(2) === 0;
      }],
      ["entries", 3, () => {
        const live = c.messages.flatMap((n) => n.messages.map((m) => m.id));
        if (!live.length) return false;
        const anchor = live[rand(live.length)]!;
        const entryId = `e${k++}`;
        both((db) => appendEngineEntries(db, c.id, "pi", anchor, [{ format: "pi-3", entryId, payload: { k } }]));
        return true;
      }],
      ["clear", 1, () => ((c.messages = []), true)],
    ];
    const weights = ops.reduce((s, [, w]) => s + w, 0);
    for (let step = 0; step < 400; step++) {
      let r = rand(weights);
      const [name, , run] = ops.find(([, w]) => (r -= w) < 0)!;
      if (run()) persistBoth();
      expect({ step, name, ...snapshot(dbNew) }).toEqual({ step, name, ...snapshot(dbOld) });
      if (step % 20 === 0) for (const w of WORDS.slice(0, 5)) expect(hitNodes(dbNew, w)).toEqual(hitNodes(dbOld, w));
    }
    expect(snapshot(dbNew).dangling).toBe(0);
    expect(loadConversationNodesFromDb(dbNew, "other")).toEqual(loadConversationNodesFromDb(dbOld, "other"));
  });
});

describe("写入量守卫(改动行数,不计时)", () => {
  function longConversation(idValue: string, turns: number): Conversation {
    return conv(idValue, Array.from({ length: turns * 2 }, (_, i) => ({ id: `${idValue}-n${i}`, messages: [msg(`第${i}条消息的正文 ` + "内容".repeat(50), i % 2 ? "ASSISTANT" : "USER")], selectIndex: 0 })));
  }
  function changesForLastNodeEdit(otherConversations: number, turns: number) {
    const db = realSchemaDb();
    for (let i = 0; i < otherConversations; i++) persistConversationInto(db, longConversation(`other${i}`, 20));
    const c = longConversation("target", turns);
    persistConversationInto(db, c);
    const last = c.messages.at(-1)!;
    last.messages[0]!.parts = [{ type: "text", text: "改过的最后一条回复" }];
    const before = totalChanges(db);
    persistConversationInto(db, c);
    const edited = totalChanges(db) - before;
    const idle = totalChanges(db);
    persistConversationInto(db, c);
    return { edited, unchanged: totalChanges(db) - idle };
  }

  test("只改最后一个节点:改动行数是常数,与会话长度、库里别的会话无关;没改时只写会话行", () => {
    const base = changesForLastNodeEdit(0, 20);
    expect(changesForLastNodeEdit(0, 300)).toEqual(base);
    expect(changesForLastNodeEdit(50, 300)).toEqual(base);
    // 会话行 1 行;节点行 1 行 + 旧目录行删 1 + 旧索引行删(触发器)+ 新索引行 + 新目录行——FTS5 内部结构的改动也计入,所以只断言是个小常数
    expect(base.edited).toBeLessThan(40);
    expect(base.unchanged).toBe(1);
  });

  test("重排与切换选中项只更新两列,不重写内容、不动索引", () => {
    const db = realSchemaDb();
    const c = conv("c1", [node("a", "第一条"), { id: "b", messages: [msg("版本一"), msg("版本二")], selectIndex: 0 }, node("c", "第三条")]);
    persistConversationInto(db, c);
    const ftsBefore = db.query("SELECT rowid, text FROM pc_message_fts ORDER BY rowid").all();
    [c.messages[0], c.messages[2]] = [c.messages[2]!, c.messages[0]!];
    c.messages[1]!.selectIndex = 1;
    const before = totalChanges(db);
    persistConversationInto(db, c);
    expect(totalChanges(db) - before).toBe(1 + 3); // 会话行 + 三个节点各一次 UPDATE
    expect(db.query("SELECT rowid, text FROM pc_message_fts ORDER BY rowid").all()).toEqual(ftsBefore);
    expect(loadConversationNodesFromDb(db, "c1").map((n) => [n.id, n.selectIndex])).toEqual([["c", 0], ["b", 1], ["a", 0]]);
  });

  test("对账的查询走索引,不扫节点表、目录表", () => {
    const db = realSchemaDb();
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail);
    const scans = (sql: string) => plan(sql).filter((d) => d.startsWith("SCAN"));
    expect(scans("SELECT id, node_index, messages, select_index FROM pc_message_node WHERE conversation_id = ?")).toEqual([]);
    expect(scans("SELECT DISTINCT node_id FROM pc_message_fts_dir WHERE node_id IN (SELECT id FROM pc_message_node WHERE conversation_id = ?)")).toEqual([]);
    expect(scans("UPDATE pc_message_node SET node_index = ?, select_index = ? WHERE id = ?")).toEqual([]);
  });
});


describe("流式回复的索引", () => {
  test("最后一次流式 flush 已写入最终内容,再对账:索引是最终内容,旧版本的索引不残留", () => {
    const db = realSchemaDb();
    const reply = node("r1", "重新生成之前的回答");
    const c = conv("c1", [node("q1", "用户的问题"), reply]);
    persistConversationInto(db, c);
    expect(hitNodes(db, "重新生成之前")).toEqual(["r1"]);
    reply.messages[0]!.parts = [{ type: "text", text: "流式写出的最终回答" }];
    upsertMessageNodeInto(db, c.id, reply, 1, false);
    expect(hitNodes(db, "重新生成之前")).toEqual([]);
    persistConversationInto(db, c);
    expect(hitNodes(db, "流式写出的最终")).toEqual(["r1"]);
    expect(hitNodes(db, "重新生成之前")).toEqual([]);
  });

  test("只做过流式 flush 就重新打开数据库(崩溃),下次保存这个会话补上索引", () => {
    const dir = mkdtempSync(join(tmpdir(), "rkh-persist-reconcile-"));
    try {
      const path = join(dir, "c.db");
      const c = conv("c1", [node("q1", "崩溃之前的问题")]);
      let db = realSchemaDb(path);
      persistConversationInto(db, c);
      const reply = node("r1", "崩溃时写到一半的回答");
      c.messages.push(reply);
      upsertMessageNodeInto(db, c.id, reply, 1, false);
      db.close();
      db = realSchemaDb(path);
      expect(hitNodes(db, "写到一半")).toEqual([]);
      const reloaded = conv("c1", loadConversationNodesFromDb(db, "c1"));
      persistConversationInto(db, reloaded);
      expect(hitNodes(db, "写到一半")).toEqual(["r1"]);
      db.close();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort:Windows 上 SQLite 句柄释放可能滞后,临时目录留给系统清理
      }
    }
  });

  test("没有正文的节点(空回复、只有图片)不反复补建索引", () => {
    const db = realSchemaDb();
    const c = conv("c1", [node("q1", "问题"), { id: "r1", messages: [msg("")], selectIndex: 0 }]);
    persistConversationInto(db, c);
    const before = totalChanges(db);
    persistConversationInto(db, c);
    expect(totalChanges(db) - before).toBe(1);
  });
});

describe("引擎私有条目", () => {
  const entriesOf = (db: Database) => (db.query("SELECT anchor_message_id FROM pc_engine_entry ORDER BY seq").all() as Array<{ anchor_message_id: string }>).map((r) => r.anchor_message_id);

  test("删掉带条目的节点:条目被清;改写节点时丢掉的消息版本,它的条目也被清", () => {
    const db = realSchemaDb();
    const reply = { id: "r1", messages: [msg("第一版"), msg("第二版")], selectIndex: 1 };
    const c = conv("c1", [node("q1", "问题"), reply, node("q2", "追问")]);
    persistConversationInto(db, c);
    const [v1, v2] = reply.messages.map((m) => m.id);
    const q2 = c.messages[2]!.messages[0]!.id;
    appendEngineEntries(db, c.id, "pi", v1!, [{ format: "pi-3", entryId: "a", payload: {} }]);
    appendEngineEntries(db, c.id, "pi", v2!, [{ format: "pi-3", entryId: "b", payload: {} }]);
    appendEngineEntries(db, c.id, "pi", q2, [{ format: "pi-3", entryId: "c", payload: {} }]);
    reply.messages.splice(0, 1);
    reply.selectIndex = 0;
    persistConversationInto(db, c);
    expect(entriesOf(db)).toEqual([v2, q2]);
    c.messages.splice(2, 1);
    persistConversationInto(db, c);
    expect(entriesOf(db)).toEqual([v2]);
  });

  test("没有消息离开会话时不触发清理(追加、改内容、重排)", () => {
    const db = realSchemaDb();
    const c = conv("c1", [node("q1", "问题"), node("r1", "回答")]);
    persistConversationInto(db, c);
    // 锚定在一条不存在的消息上的孤儿:清理一旦被触发就会删掉它,借它看清理有没有跑
    appendEngineEntries(db, c.id, "pi", "ghost-message", [{ format: "pi-3", entryId: "g", payload: {} }]);
    c.messages.push(node("q2", "新的问题"));
    persistConversationInto(db, c);
    c.messages[1]!.messages[0]!.parts = [{ type: "text", text: "改过的回答" }];
    persistConversationInto(db, c);
    [c.messages[0], c.messages[1]] = [c.messages[1]!, c.messages[0]!];
    persistConversationInto(db, c);
    expect(entriesOf(db)).toEqual(["ghost-message"]);
    c.messages.pop();
    persistConversationInto(db, c);
    expect(entriesOf(db)).toEqual([]);
  });
});
