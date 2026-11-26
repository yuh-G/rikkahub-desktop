// conversations/fts 单元测试（P1-2）。
// 契约：中英文子串匹配（与旧 includes 语义对齐）、短查询 LIKE 兜底、
// 节点级增量同步、清空、从节点表重建自愈、[匹配] 高亮片段形状。
// 行号目录（删节点 / 删会话靠外键级联、自检与修复、老版本写过之后）在 fts-directory.test.ts。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  clearAllFts,
  ensureMessageFtsTable,
  ftsRowCount,
  rebuildFtsFromNodeTable,
  replaceNodeFts,
  searchMessageFts,
} from "./fts";
import type { MessageNode } from "../foundation/types";
import { message } from "../foundation/utils";

function freshDb(): Database {
  const db = new Database(":memory:");
  ensureMessageFtsTable(db);
  return db;
}

function node(id: string, texts: string[]): MessageNode {
  return {
    id,
    messages: texts.map((text) => message("USER", [{ type: "text", text }])),
    selectIndex: 0,
  } as MessageNode;
}

describe("replaceNodeFts / searchMessageFts", () => {
  test("中文长查询走 MATCH，命中返回载荷与高亮片段", () => {
    const db = freshDb();
    replaceNodeFts(db, "c1", node("n1", ["今天天气真好，我们去公园散步吧"]));
    const hits = searchMessageFts(db, "天气真好");
    expect(hits).toHaveLength(1);
    expect(hits[0].conversationId).toBe("c1");
    expect(hits[0].nodeId).toBe("n1");
    expect(hits[0].snippet).toContain("[");
    expect(hits[0].snippet).toContain("天气真好");
  });

  test("英文大小写不敏感（与旧 toLowerCase().includes() 对齐）", () => {
    const db = freshDb();
    replaceNodeFts(db, "c1", node("n1", ["The Quick Brown Fox"]));
    expect(searchMessageFts(db, "quick brown")).toHaveLength(1);
  });

  test("中文 2 字查询走 LIKE 兜底，同样命中并带 [匹配] 标记", () => {
    const db = freshDb();
    replaceNodeFts(db, "c1", node("n1", ["今天天气真好"]));
    const hits = searchMessageFts(db, "天气");
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain("[天气]");
  });

  test("连字符等特殊字符按字面匹配（短语转义，不解析为 FTS 语法）", () => {
    const db = freshDb();
    replaceNodeFts(db, "c1", node("n1", ["marker unique-search-12345 end"]));
    expect(searchMessageFts(db, "unique-search-12345")).toHaveLength(1);
    expect(searchMessageFts(db, "unique-nomatch-99999")).toHaveLength(0);
  });

  test("LIKE 通配符按字面处理（% 不是通配）", () => {
    const db = freshDb();
    replaceNodeFts(db, "c1", node("n1", ["discount 5% off"]));
    replaceNodeFts(db, "c1", node("n2", ["five percent"]));
    const hits = searchMessageFts(db, "5%");
    expect(hits).toHaveLength(1);
    expect(hits[0].nodeId).toBe("n1");
  });

  test("节点重写是替换语义：旧文本不再命中", () => {
    const db = freshDb();
    const n = node("n1", ["old content here"]);
    replaceNodeFts(db, "c1", n);
    expect(searchMessageFts(db, "old content")).toHaveLength(1);
    replaceNodeFts(db, "c1", node("n1", ["new words entirely"]));
    expect(searchMessageFts(db, "old content")).toHaveLength(0);
    expect(searchMessageFts(db, "new words")).toHaveLength(1);
  });

  test("空查询与空文本消息不产生行", () => {
    const db = freshDb();
    replaceNodeFts(db, "c1", node("n1", [""]));
    expect(ftsRowCount(db)).toBe(0);
    expect(searchMessageFts(db, "  ")).toEqual([]);
  });
});

describe("clearAllFts", () => {
  test("删表重建：索引与目录都清空，之后照常可写可搜", () => {
    const db = freshDb();
    replaceNodeFts(db, "c1", node("n1", ["alpha text"]));
    replaceNodeFts(db, "c2", node("n2", ["beta text"]));
    clearAllFts(db);
    expect(ftsRowCount(db)).toBe(0);
    expect((db.query("SELECT COUNT(*) AS n FROM pc_message_fts_dir").get() as { n: number }).n).toBe(0);
    replaceNodeFts(db, "c2", node("n2", ["beta again"]));
    expect(searchMessageFts(db, "beta")).toHaveLength(1);
  });
});

describe("rebuildFtsFromNodeTable", () => {
  test("从 pc_message_node 全量重建，损坏 JSON 跳过", () => {
    const db = freshDb();
    db.exec(`CREATE TABLE pc_message_node (
      id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL,
      node_index INTEGER NOT NULL, messages TEXT NOT NULL DEFAULT '[]', select_index INTEGER NOT NULL DEFAULT 0
    )`);
    const good = JSON.stringify(node("n1", ["rebuild target text"]).messages);
    db.prepare("INSERT INTO pc_message_node VALUES (?, ?, ?, ?, ?)").run("n1", "c1", 0, good, 0);
    db.prepare("INSERT INTO pc_message_node VALUES (?, ?, ?, ?, ?)").run("n2", "c1", 1, "{corrupt", 0);
    const rebuilt = rebuildFtsFromNodeTable(db);
    expect(rebuilt).toBe(1);
    expect(searchMessageFts(db, "rebuild target")).toHaveLength(1);
  });
});
