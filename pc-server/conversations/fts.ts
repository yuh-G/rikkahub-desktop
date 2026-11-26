// conversations/fts.ts — 消息全文搜索（FTS5 trigram，P1-2）
//
// 设计（方案见 项目重构方案.md「P1-2 方案」条目）：
// - pc_message_fts 与 pc_conversation/pc_message_node 同库；text 为纯文本
//   （textFromParts 提取），conversation_id/node_id/message_id 为 UNINDEXED 载荷列。
// - trigram tokenizer：中文/英文统一按 3-gram 子串索引，大小写不敏感，
//   与旧实现 toLowerCase().includes() 的子串语义对齐。
// - 查询策略：≥3 字符走 MATCH（双引号短语转义，防连字符等被解析为 FTS 语法）；
//   1-2 字符走 LIKE（trigram 表的 LIKE/GLOB 自动使用索引优化；中文 2 字词是高频查询）。
// - 所有函数收 db 参数（不依赖模块单例），便于用临时库单测。
// - 行号目录 pc_message_fts_dir 记 FTS 的每一行属于哪个节点（PF.1）：node_id 有索引并外键级联到
//   pc_message_node，目录行被删时触发器按行号删掉对应的索引行（并核对节点，不误删别人的行）。所以改写
//   一个节点只走索引找到它的几行；删节点、删会话由数据库顺着外键把索引带走，不需要显式清理。
//   FTS 表本身的形状不变，老版本仍能直接用同一个库；老版本只写 FTS 不写目录，打开时由
//   ensureFtsDirectory 自检发现并重建目录。整表操作一律删表重建（逐行删每行都要重新分词）。
import type { Database } from "bun:sqlite";
import type { MessageNode } from "../foundation/types";
import { textFromParts } from "../foundation/utils";

export interface MessageFtsHit {
  conversationId: string;
  nodeId: string;
  messageId: string;
  snippet: string;
}

const FTS_TABLE_SQL =
  "CREATE VIRTUAL TABLE IF NOT EXISTS pc_message_fts USING fts5(text, conversation_id UNINDEXED, node_id UNINDEXED, message_id UNINDEXED, tokenize='trigram')";
const FTS_DIR_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS pc_message_fts_dir (
    fts_rowid INTEGER PRIMARY KEY,
    node_id   TEXT NOT NULL REFERENCES pc_message_node(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_pc_message_fts_dir_node ON pc_message_fts_dir(node_id);`;
const FTS_DIR_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS pc_message_fts_dir_ad AFTER DELETE ON pc_message_fts_dir BEGIN
    DELETE FROM pc_message_fts WHERE rowid = old.fts_rowid AND node_id = old.node_id;
  END;`;

export function ensureMessageFtsTable(db: Database): void {
  db.exec(FTS_TABLE_SQL);
  db.exec(FTS_DIR_TABLE_SQL);
  db.exec(FTS_DIR_TRIGGER_SQL);
}

/** 重建单节点的 FTS 行：按目录删掉该节点的旧行（触发器带走索引行），再逐消息插入非空文本并登记目录。
 *  登记用 OR REPLACE：只有目录与 FTS 已经不一致（老版本写过、打开时的自检又失败了）新行号才会撞上旧登记，
 *  那时宁可覆盖也不能让整次保存回滚。没开 recursive_triggers，REPLACE 不触发删除触发器，刚插入的行不受影响。 */
export function replaceNodeFts(db: Database, conversationId: string, node: MessageNode): void {
  db.query("DELETE FROM pc_message_fts_dir WHERE node_id = ?").run(node.id);
  const insertFts = db.query("INSERT INTO pc_message_fts (text, conversation_id, node_id, message_id) VALUES (?, ?, ?, ?)");
  const insertDir = db.query("INSERT OR REPLACE INTO pc_message_fts_dir (fts_rowid, node_id) VALUES (?, ?)");
  for (const message of node.messages ?? []) {
    if (!message?.id) continue;
    const text = textFromParts(message.parts ?? []);
    if (!text) continue;
    const { lastInsertRowid } = insertFts.run(text, conversationId, node.id, message.id);
    insertDir.run(lastInsertRowid, node.id);
  }
}

/** 清空索引与目录：删表重建。逐行 DELETE 时 FTS5 要把每行重新分词一遍才能从倒排里摘掉。 */
export function clearAllFts(db: Database): void {
  db.exec("DROP TRIGGER IF EXISTS pc_message_fts_dir_ad; DROP TABLE IF EXISTS pc_message_fts_dir; DROP TABLE IF EXISTS pc_message_fts");
  ensureMessageFtsTable(db);
}

function countRows(db: Database, sql: string): number {
  return (db.query(sql).get() as { n: number } | null)?.n ?? 0;
}

/**
 * 打开数据库时核对目录与 FTS 行一一对应：行数相等，且没有指向不存在行的目录行。不一致就在一个事务里按
 * FTS 现有内容重建目录（一次扫描，不重新分词），顺带删掉节点已不存在的孤儿索引行。第一次升级（目录是空的）、
 * 老版本写过这个库（只写 FTS 不写目录、按节点直接删 FTS 行）都落在这条路径上，不需要版本标记。
 * 看不出来的窄缝：老版本删掉某节点的行之后，新插入的行恰好复用了同一个行号——触发器的节点核对保证不误删，
 * 最多是一条过期的搜索命中，下次重建目录时消失。一致时返回 null。
 */
export function ensureFtsDirectory(db: Database): { directoryRows: number; orphanRows: number } | null {
  const ftsRows = ftsRowCount(db);
  const dirRows = countRows(db, "SELECT COUNT(*) AS n FROM pc_message_fts_dir");
  const dangling = countRows(
    db,
    "SELECT COUNT(*) AS n FROM pc_message_fts_dir d WHERE NOT EXISTS (SELECT 1 FROM pc_message_fts_docsize s WHERE s.id = d.fts_rowid)",
  );
  if (ftsRows === dirRows && dangling === 0) return null;
  let directoryRows = 0;
  let orphanRows = 0;
  db.transaction(() => {
    const rows = db.query("SELECT rowid AS id, node_id FROM pc_message_fts").all() as Array<{ id: number; node_id: string | null }>;
    const liveNodes = new Set((db.query("SELECT id FROM pc_message_node").all() as Array<{ id: string }>).map((row) => row.id));
    // 先摘触发器再清目录，否则清目录会把 FTS 行一起删光
    db.exec("DROP TRIGGER IF EXISTS pc_message_fts_dir_ad; DELETE FROM pc_message_fts_dir");
    const deleteOrphan = db.query("DELETE FROM pc_message_fts WHERE rowid = ?");
    const insertDir = db.query("INSERT INTO pc_message_fts_dir (fts_rowid, node_id) VALUES (?, ?)");
    for (const row of rows) {
      if (row.node_id && liveNodes.has(row.node_id)) {
        insertDir.run(row.id, row.node_id);
        directoryRows += 1;
      } else {
        deleteOrphan.run(row.id);
        orphanRows += 1;
      }
    }
    db.exec(FTS_DIR_TRIGGER_SQL);
  })();
  return { directoryRows, orphanRows };
}

/** FTS 行数：数 FTS5 的 docsize 影子表（每个索引行一行；建表没关 columnsize，所以它一定在），不读正文。 */
export function ftsRowCount(db: Database): number {
  return countRows(db, "SELECT COUNT(*) AS n FROM pc_message_fts_docsize");
}

/**
 * 从 pc_message_node 表全量重建索引。老库首次升级（无 FTS 表数据）与索引意外丢失
 * 都走这条自愈路径；openConversationsDb 在行数=0 且节点表非空时调用。
 * 逐节点 JSON.parse，与启动全量加载同量级，可接受。先删表重建、再只插不删，耗时与条数成正比。
 */
export function rebuildFtsFromNodeTable(db: Database): number {
  const nodes = db.query("SELECT id, conversation_id, messages, select_index FROM pc_message_node").all() as Array<{
    id: string;
    conversation_id: string;
    messages: string;
    select_index: number;
  }>;
  let rebuilt = 0;
  const txn = db.transaction(() => {
    clearAllFts(db);
    for (const row of nodes) {
      let messages: MessageNode["messages"];
      try {
        messages = JSON.parse(row.messages);
      } catch {
        continue; // 损坏节点跳过：搜索少一条命中优于重建失败
      }
      if (!Array.isArray(messages) || messages.length === 0) continue;
      replaceNodeFts(db, row.conversation_id, { id: row.id, messages, selectIndex: row.select_index });
      rebuilt += 1;
    }
  });
  txn();
  return rebuilt;
}

/** MATCH 查询串转义：整体作为双引号短语，内部双引号翻倍。子串语义与旧 includes 对齐。 */
function ftsPhrase(query: string): string {
  return `"${query.replaceAll('"', '""')}"`;
}

/** LIKE 模式转义（% _ \\）。 */
function likePattern(query: string): string {
  return `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

/** 无标记高亮：LIKE 分支手动构造 [匹配] 片段，与 snippet() 输出形状一致（前端 SnippetText 契约）。 */
function manualSnippet(text: string, query: string, window = 24): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx < 0) return text.slice(0, window * 2);
  const start = Math.max(0, idx - window);
  const end = Math.min(text.length, idx + query.length + window);
  return `${start > 0 ? "…" : ""}${text.slice(start, idx)}[${text.slice(idx, idx + query.length)}]${text.slice(idx + query.length, end)}${end < text.length ? "…" : ""}`;
}

export function searchMessageFts(db: Database, rawQuery: string, limit = 200): MessageFtsHit[] {
  const query = rawQuery.trim();
  if (!query) return [];
  if (query.length >= 3) {
    const rows = db.prepare(
      "SELECT conversation_id, node_id, message_id, snippet(pc_message_fts, 0, '[', ']', '…', 16) AS snip FROM pc_message_fts WHERE pc_message_fts MATCH ? LIMIT ?",
    ).all(ftsPhrase(query), limit) as Array<{ conversation_id: string; node_id: string; message_id: string; snip: string }>;
    return rows.map((row) => ({
      conversationId: row.conversation_id,
      nodeId: row.node_id,
      messageId: row.message_id,
      snippet: row.snip,
    }));
  }
  // 1-2 字符：LIKE 兜底（trigram 表的 LIKE 有索引优化；ESCAPE 显式声明反斜杠）
  const rows = db.prepare(
    "SELECT text, conversation_id, node_id, message_id FROM pc_message_fts WHERE text LIKE ? ESCAPE '\\' LIMIT ?",
  ).all(likePattern(query), limit) as Array<{ text: string; conversation_id: string; node_id: string; message_id: string }>;
  return rows.map((row) => ({
    conversationId: row.conversation_id,
    nodeId: row.node_id,
    messageId: row.message_id,
    snippet: manualSnippet(row.text, query),
  }));
}
