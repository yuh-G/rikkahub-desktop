// conversations/fts-directory.test.ts — 全文索引行号目录（PF.1）。
// 契约：目录与 FTS 行一一对应；改写节点只按目录删旧行；删节点 / 删会话只删节点行或会话行，索引顺着外键与触发器消失；
// 整表操作后两边行数相等；第一次升级与老版本写过之后，打开时的自检能发现并修复；触发器核对节点，不误删别人的行。
// 守卫：删除路径走索引不扫全表；conversations/ 的生产代码不再按 node_id / conversation_id 直接删 FTS 行。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { deletePcConversations, ensureConversationTables, loadAllConversationsFromDb, openConversationsDb, persistConversation, resetConversationsDbTo, upsertConversationRowInto, upsertMessageNodeInto } from "./index";
import { clearAllFts, ensureFtsDirectory, ensureMessageFtsTable, rebuildFtsFromNodeTable, replaceNodeFts, searchMessageFts } from "./fts";
import { message, textFromParts } from "../foundation/utils";
import type { Conversation, MessageNode } from "../foundation/types";

function realSchemaDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensureConversationTables(db);
  ensureMessageFtsTable(db);
  return db;
}

function node(idValue: string, ...texts: string[]): MessageNode {
  return { id: idValue, messages: texts.map((text) => message("ASSISTANT", [{ type: "text", text }])), selectIndex: 0 };
}

function conv(idValue: string, nodes: MessageNode[]): Conversation {
  return { id: idValue, assistantId: "a1", title: idValue, systemPrompt: null, messages: nodes, chatSuggestions: [], isPinned: false, createAt: 1000, updateAt: 2000 };
}

function write(db: Database, c: Conversation): void {
  upsertConversationRowInto(db, c);
  c.messages.forEach((n, i) => upsertMessageNodeInto(db, c.id, n, i));
}

const count = (db: Database, sql: string) => (db.query(sql).get() as { n: number }).n;
function counts(db: Database) {
  return {
    fts: count(db, "SELECT COUNT(*) AS n FROM pc_message_fts_docsize"),
    dir: count(db, "SELECT COUNT(*) AS n FROM pc_message_fts_dir"),
    dangling: count(db, "SELECT COUNT(*) AS n FROM pc_message_fts_dir d WHERE NOT EXISTS (SELECT 1 FROM pc_message_fts_docsize s WHERE s.id = d.fts_rowid)"),
  };
}
const consistent = (db: Database) => {
  const c = counts(db);
  return c.fts === c.dir && c.dangling === 0;
};

// 改前（v5 起到 PF.1 之前）的写法原样抄在这里当「老版本」：只写 FTS 不写目录，按节点 / 按会话直接删 FTS 行。仅作对照。
function legacyReplaceNodeFts(db: Database, conversationId: string, n: MessageNode): void {
  db.prepare("DELETE FROM pc_message_fts WHERE node_id = ?").run(n.id);
  const insert = db.prepare("INSERT INTO pc_message_fts (text, conversation_id, node_id, message_id) VALUES (?, ?, ?, ?)");
  for (const m of n.messages ?? []) {
    if (!m?.id) continue;
    const text = textFromParts(m.parts ?? []);
    if (text) insert.run(text, conversationId, n.id, m.id);
  }
}
function legacyPersistConversation(db: Database, c: Conversation): void {
  db.transaction(() => {
    upsertConversationRowInto(db, c);
    db.prepare("DELETE FROM pc_message_node WHERE conversation_id = ?").run(c.id);
    db.prepare("DELETE FROM pc_message_fts WHERE conversation_id = ?").run(c.id);
    c.messages.forEach((n, i) => {
      db.prepare("INSERT INTO pc_message_node (id, conversation_id, node_index, messages, select_index) VALUES (?, ?, ?, ?, ?)").run(n.id, c.id, i, JSON.stringify(n.messages), n.selectIndex ?? 0);
      legacyReplaceNodeFts(db, c.id, n);
    });
  })();
}

const hitNodes = (db: Database, q: string) => searchMessageFts(db, q).map((h) => h.nodeId).sort();

describe("行号目录：日常读写", () => {
  test("改写节点：旧行随目录删掉，新行可搜，两边一一对应", () => {
    const db = realSchemaDb();
    write(db, conv("c1", [node("n1", "旧的第一段", "旧的第二段"), node("n2", "别的节点")]));
    expect(counts(db)).toEqual({ fts: 3, dir: 3, dangling: 0 });
    replaceNodeFts(db, "c1", node("n1", "新写的内容"));
    expect(hitNodes(db, "旧的第")).toEqual([]);
    expect(hitNodes(db, "新写的内容")).toEqual(["n1"]);
    expect(hitNodes(db, "别的节点")).toEqual(["n2"]);
    expect(counts(db)).toEqual({ fts: 2, dir: 2, dangling: 0 });
  });

  test("删节点只删节点行：目录行与索引行顺着外键与触发器消失", () => {
    const db = realSchemaDb();
    write(db, conv("c1", [node("n1", "要删掉的节点"), node("n2", "留下的节点")]));
    db.query("DELETE FROM pc_message_node WHERE id = ?").run("n1");
    expect(hitNodes(db, "要删掉的")).toEqual([]);
    expect(hitNodes(db, "留下的节点")).toEqual(["n2"]);
    expect(counts(db)).toEqual({ fts: 1, dir: 1, dangling: 0 });
  });

  test("删会话只删会话行：该会话的索引全部消失，别的会话不动", () => {
    const db = realSchemaDb();
    write(db, conv("c1", [node("a1", "第一个会话的话"), node("a2", "第一个会话的回答")]));
    write(db, conv("c2", [node("b1", "第二个会话的话")]));
    db.query("DELETE FROM pc_conversation WHERE id = ?").run("c1");
    expect(hitNodes(db, "第一个会话")).toEqual([]);
    expect(hitNodes(db, "第二个会话")).toEqual(["b1"]);
    expect(counts(db)).toEqual({ fts: 1, dir: 1, dangling: 0 });
  });

  test("clearAllFts 与 rebuildFtsFromNodeTable 之后两边行数相等", () => {
    const db = realSchemaDb();
    write(db, conv("c1", [node("n1", "一段话"), node("n2", "两段话", "三段话")]));
    clearAllFts(db);
    expect(counts(db)).toEqual({ fts: 0, dir: 0, dangling: 0 });
    expect(rebuildFtsFromNodeTable(db)).toBe(2);
    expect(counts(db)).toEqual({ fts: 3, dir: 3, dangling: 0 });
    expect(hitNodes(db, "三段话")).toEqual(["n2"]);
    expect(ensureFtsDirectory(db)).toBeNull();
  });

  test("触发器核对节点：目录行指错节点时不误删别人的行", () => {
    const db = realSchemaDb();
    write(db, conv("c1", [node("n1", "属于第一个节点"), node("n2", "属于第二个节点")]));
    const rowOfN1 = (db.query("SELECT fts_rowid AS id FROM pc_message_fts_dir WHERE node_id = 'n1'").get() as { id: number }).id;
    // 造出「n1 的索引行被登记在 n2 名下」：摘掉触发器改目录，再装回
    db.exec("DROP TRIGGER pc_message_fts_dir_ad");
    db.query("UPDATE pc_message_fts_dir SET node_id = 'n2' WHERE fts_rowid = ?").run(rowOfN1);
    ensureMessageFtsTable(db);
    db.query("DELETE FROM pc_message_fts_dir WHERE node_id = 'n2'").run();
    expect(hitNodes(db, "属于第一个节点")).toEqual(["n1"]);
    expect(hitNodes(db, "属于第二个节点")).toEqual([]);
  });
  test("自检没修好时新行号撞上旧登记：覆盖登记、保存不回滚，刚插入的索引行还在", () => {
    const db = realSchemaDb();
    write(db, conv("c1", [node("n1", "第一个节点"), node("n2", "第二个节点")]));
    const rowOfN2 = (db.query("SELECT fts_rowid AS id FROM pc_message_fts_dir WHERE node_id = 'n2'").get() as { id: number }).id;
    // 老版本按节点直接删 FTS 行，目录里留下指向空行号的登记；FTS5 下一行会复用这个最大行号
    db.query("DELETE FROM pc_message_fts WHERE rowid = ?").run(rowOfN2);
    upsertConversationRowInto(db, conv("c1", []));
    db.query("INSERT INTO pc_message_node (id, conversation_id, node_index, messages, select_index) VALUES ('n3', 'c1', 2, '[]', 0)").run();
    expect(() => replaceNodeFts(db, "c1", node("n3", "第三个节点的新内容"))).not.toThrow();
    expect((db.query("SELECT node_id FROM pc_message_fts_dir WHERE fts_rowid = ?").get(rowOfN2) as { node_id: string }).node_id).toBe("n3");
    expect(hitNodes(db, "第三个节点")).toEqual(["n3"]);
    expect(consistent(db)).toBe(true);
  });
});

describe("行号目录：打开时自检", () => {
  test("第一次升级：FTS 有行、目录是空的 → 自检按 FTS 建出目录，不重新分词", () => {
    const db = realSchemaDb();
    const c = conv("c1", [node("n1", "升级前写的话"), node("n2", "升级前的回答", "第二个版本")]);
    legacyPersistConversation(db, c);
    expect(counts(db)).toEqual({ fts: 3, dir: 0, dangling: 0 });
    expect(ensureFtsDirectory(db)).toEqual({ directoryRows: 3, orphanRows: 0 });
    expect(counts(db)).toEqual({ fts: 3, dir: 3, dangling: 0 });
    expect(ensureFtsDirectory(db)).toBeNull();
    // 建好之后改写与删除照常走目录
    replaceNodeFts(db, "c1", node("n2", "升级后改写"));
    db.query("DELETE FROM pc_message_node WHERE id = 'n1'").run();
    expect(hitNodes(db, "升级前")).toEqual([]);
    expect(hitNodes(db, "升级后改写")).toEqual(["n2"]);
    expect(consistent(db)).toBe(true);
  });

  test("降级到老版本写过一轮再升回来：老写法在新库上不报错，自检发现不一致并修复", () => {
    const db = realSchemaDb();
    const c = conv("c1", [node("n1", "新版本写的话"), node("n2", "新版本的回答")]);
    write(db, c);
    write(db, conv("c2", [node("x1", "另一个会话不受影响")]));
    expect(consistent(db)).toBe(true);
    // 老版本：删节点行（级联带走目录行与索引行）、按会话删 FTS（已空）、重插节点与 FTS（不写目录）
    c.messages[1] = node("n2", "老版本改过的回答");
    c.messages.push(node("n3", "老版本新加的一轮"));
    expect(() => legacyPersistConversation(db, c)).not.toThrow();
    expect(consistent(db)).toBe(false);
    // 目录按整个库重建：c1 的三个节点 + c2 的一个
    expect(ensureFtsDirectory(db)).toEqual({ directoryRows: 4, orphanRows: 0 });
    expect(consistent(db)).toBe(true);
    expect(hitNodes(db, "老版本改过")).toEqual(["n2"]);
    expect(hitNodes(db, "新版本的回答")).toEqual([]);
    expect(hitNodes(db, "另一个会话")).toEqual(["x1"]);
    // 修复后新写法能正常替换老版本写下的行
    replaceNodeFts(db, "c1", node("n3", "再升回来改写"));
    expect(hitNodes(db, "老版本新加")).toEqual([]);
    expect(consistent(db)).toBe(true);
  });

  test("老版本删会话留下的孤儿索引行：自检时一并清掉", () => {
    const db = realSchemaDb();
    write(db, conv("c1", [node("n1", "会话一的内容")]));
    // 老版本按会话删 FTS 之前就被杀掉的残局：节点没了、FTS 行还在、目录里没有它
    db.exec("DROP TRIGGER pc_message_fts_dir_ad");
    db.query("DELETE FROM pc_conversation WHERE id = 'c1'").run();
    ensureMessageFtsTable(db);
    expect(counts(db)).toEqual({ fts: 1, dir: 0, dangling: 0 });
    expect(ensureFtsDirectory(db)).toEqual({ directoryRows: 0, orphanRows: 1 });
    expect(counts(db)).toEqual({ fts: 0, dir: 0, dangling: 0 });
  });

  test("修复不误删：重建目录的过程中触发器已摘掉，FTS 行一行不少", () => {
    const db = realSchemaDb();
    write(db, conv("c1", Array.from({ length: 20 }, (_, i) => node(`n${i}`, `第${i}条消息的正文`))));
    db.exec("DELETE FROM pc_message_fts_dir WHERE fts_rowid % 2 = 0"); // 触发器在：这些行连同索引行一起删掉
    db.exec("DROP TRIGGER pc_message_fts_dir_ad; DELETE FROM pc_message_fts_dir");
    ensureMessageFtsTable(db);
    const before = counts(db).fts;
    expect(ensureFtsDirectory(db)).toEqual({ directoryRows: before, orphanRows: 0 });
    expect(counts(db)).toEqual({ fts: before, dir: before, dangling: 0 });
  });
});

describe("行号目录：生产入口（活库单例，用测试沙箱的数据目录）", () => {
  test("打开活库时自检：目录被清空后再次打开即重建", () => {
    const db = openConversationsDb();
    persistConversation(conv("fts-dir-open", [node("fts-dir-open-n1", "打开时自检的内容")]));
    db.exec("DROP TRIGGER pc_message_fts_dir_ad; DELETE FROM pc_message_fts_dir");
    expect(consistent(db)).toBe(false);
    // 不关旧句柄：同一测试进程里别的文件可能还拿着它（WAL 下两个连接同时可用）
    const reopened = openConversationsDb();
    expect(consistent(reopened)).toBe(true);
    expect(hitNodes(reopened, "打开时自检")).toEqual(["fts-dir-open-n1"]);
    deletePcConversations(["fts-dir-open"]);
    expect(hitNodes(reopened, "打开时自检")).toEqual([]);
  });

  test("resetConversationsDbTo 之后两边行数相等，搜索照常", () => {
    const db = openConversationsDb();
    persistConversation(conv("fts-dir-reset", [node("fts-dir-reset-n1", "恢复备份之前"), node("fts-dir-reset-n2", "恢复之后还在")]));
    resetConversationsDbTo(loadAllConversationsFromDb(db));
    expect(consistent(db)).toBe(true);
    expect(hitNodes(db, "恢复之后还在")).toEqual(["fts-dir-reset-n2"]);
    deletePcConversations(["fts-dir-reset"]);
    expect(consistent(db)).toBe(true);
  });
});

describe("守卫", () => {
  test("删除路径走索引：按节点删目录、删节点行都不扫全表", () => {
    const db = realSchemaDb();
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail);
    expect(plan("DELETE FROM pc_message_fts_dir WHERE node_id = ?")).toEqual([expect.stringContaining("USING COVERING INDEX idx_pc_message_fts_dir_node")]);
    const nodeDelete = plan("DELETE FROM pc_message_node WHERE id = ?");
    expect(nodeDelete.some((d) => d.includes("pc_message_fts_dir") && d.includes("idx_pc_message_fts_dir_node"))).toBe(true);
    expect(nodeDelete.filter((d) => d.startsWith("SCAN"))).toEqual([]);
    // 触发器里那条按行号删：虚拟表的计划里带「=」是行号定位；改前按 node_id 删的那条没有，是全表扫描
    expect(plan("DELETE FROM pc_message_fts WHERE rowid = ? AND node_id = ?")).toEqual([expect.stringMatching(/VIRTUAL TABLE INDEX \d+:=/)]);
    expect(plan("DELETE FROM pc_message_fts WHERE node_id = ?")).toEqual([expect.stringMatching(/VIRTUAL TABLE INDEX \d+:$/)]);
  });

  test("conversations/ 的生产代码不再按 node_id / conversation_id 直接删 FTS 行", () => {
    const dir = import.meta.dir;
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => /FROM pc_message_fts WHERE (node_id|conversation_id)/.test(readFileSync(join(dir, f), "utf-8")));
    expect(offenders).toEqual([]);
  });
});
