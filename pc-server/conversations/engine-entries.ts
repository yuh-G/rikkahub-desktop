// conversations/engine-entries.ts — 引擎私有条目(会话存储第二层,重构方案 §5.4 / P3.1)
//
// 中立记录(pc_conversation + pc_message_node)是跨引擎的会话事实;引擎为无损续聊需要的
// 原生数据(pi 的会话条目、DSH 的事件)住这里,应用只存取不解释 payload。三条约定:
// - 锚定:每条条目挂在一条中立消息上(anchor_message_id),粒度由驱动定——pi 逐条消息,
//   DSH 以一轮的用户消息为锚。分叉保留消息 id,所以条目按 (会话, 锚定消息) 寻址。
// - 封存自校验:一轮结束时用 engineVisibleDigest(锚定范围内的中立消息)封存该锚定的全部行;
//   装载方重算比对,不符(用户编辑过 / 选中分支变了)或未封存(生成中崩溃)即整组作废,
//   引擎从中立记录回退编码。所以这张表缺失、陈旧、来自别的机器,都只会退化为回退。
//   契约侧的读写与封存时机在 conversations/engine-session.ts。
// - 生命周期:外键级联随会话删除;消息删除留下的孤儿由 persistConversation 同事务清除。
//   会话头(pc_engine_session)每会话每引擎一行:DSH 的格式版本在头上而不在事件上(X1)。

import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type {
  Conversation,
  JsonValue,
  Message,
  MessagePart,
  PcEngineEntryRow,
  PcEngineSessionRow,
  PcEngineTablesRows,
  ToolOutputEntry,
} from "../foundation/types";
import type { EngineEntry, EngineEntryInput } from "../engines/contract";
import { reportError } from "../observability/app-errors";

type Db = InstanceType<typeof Database>;

const ENGINE_TABLE_COLUMNS = {
  pc_engine_session: "conversation_id, engine, format, header",
  pc_engine_entry: "conversation_id, engine, seq, format, anchor_message_id, entry_id, payload, digest",
} as const;
type EngineTable = keyof typeof ENGINE_TABLE_COLUMNS;
const ENGINE_TABLES = Object.keys(ENGINE_TABLE_COLUMNS) as EngineTable[];

function engineTablesDdl(schema: string, withForeignKeys: boolean): string {
  const fk = withForeignKeys ? ",\n      FOREIGN KEY (conversation_id) REFERENCES pc_conversation(id) ON DELETE CASCADE" : "";
  return `
    CREATE TABLE IF NOT EXISTS ${schema}.pc_engine_session (
      conversation_id TEXT NOT NULL,
      engine          TEXT NOT NULL,
      format          TEXT NOT NULL,
      header          TEXT NOT NULL,
      PRIMARY KEY (conversation_id, engine)${fk}
    );
    CREATE TABLE IF NOT EXISTS ${schema}.pc_engine_entry (
      conversation_id   TEXT NOT NULL,
      engine            TEXT NOT NULL,
      seq               INTEGER NOT NULL,
      format            TEXT NOT NULL,
      anchor_message_id TEXT NOT NULL,
      entry_id          TEXT,
      payload           TEXT NOT NULL,
      digest            TEXT,
      PRIMARY KEY (conversation_id, engine, seq)${fk}
    );`;
}

/** 活库建表(幂等),由 ensureConversationTables 调用,生产与测试同一份 schema。
 *  entry_id 唯一索引让对账重放幂等;DSH 条目无 id(NULL 互不冲突)。 */
export function ensureEngineEntryTables(db: Db): void {
  db.exec(engineTablesDdl("main", true));
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_pc_engine_entry_id ON pc_engine_entry(conversation_id, engine, entry_id)");
}

// ----- 引擎可见摘要 -----

// 版本前缀:摘要口径一变,旧封存值全部失配→整体回退一次,不会被新口径误判为有效。
const DIGEST_VERSION = "engine-visible-v1";

function visibleOutput(entry: ToolOutputEntry): JsonValue {
  if (entry.type === undefined) return "pending" in entry ? ["pending"] : ["error", entry.error];
  return visiblePart(entry);
}

// 只取进模型上下文的内容。刻意排除:part metadata(计时戳 / OCR / 工作区详情是应用侧标注,
// 封存后仍可能被补写)、approvalState(模型看到的是工具结果而不是审批态)、loading 占位。
function visiblePart(part: MessagePart): JsonValue {
  switch (part.type) {
    case "text": return ["text", part.text];
    case "reasoning": return ["reasoning", part.reasoning];
    case "image":
    case "video":
    case "audio": return [part.type, part.url];
    case "document": return ["document", part.url, part.fileName, part.mime];
    case "tool": return ["tool", part.toolCallId, part.toolName, part.input, part.output.map(visibleOutput)];
    case "loading": return null;
  }
}

/** 锚定范围(pi 一条消息,DSH 一轮)内中立消息的引擎可见摘要。含消息 id 与角色——
 *  换选中分支即失配;不含计时戳、用量、翻译、注解与 modelId。位置数组编码,与键序无关。
 *  附件 URL 计入:跨机恢复重写文件引用后,带附件的消息会回退一次(安全方向)。 */
export function engineVisibleDigest(messages: readonly Message[]): string {
  const visible = messages.map((message) => [
    message.id,
    message.role,
    message.parts.map(visiblePart).filter((part) => part !== null),
  ]);
  return createHash("sha256").update(`${DIGEST_VERSION}\n${JSON.stringify(visible)}`).digest("hex");
}

// ----- 存取 -----

/** 一个锚定的全部条目(seq 升序)。digest 只在整组行都封存且一致时非空,否则该组无效。 */
export interface EngineEntryGroup {
  anchorMessageId: string;
  digest: string | null;
  entries: EngineEntry[];
}

export interface EngineSessionHeader {
  format: string;
  header: JsonValue;
}

interface EntryDbRow {
  seq: number;
  format: string;
  anchor_message_id: string;
  entry_id: string | null;
  payload: string;
  digest: string | null;
}

/** 按锚定首次出现的顺序分组。payload 损坏的组记为未封存(整组回退),不抛。 */
export function loadEngineEntries(db: Db, conversationId: string, engine: string): EngineEntryGroup[] {
  const rows = db
    .prepare("SELECT seq, format, anchor_message_id, entry_id, payload, digest FROM pc_engine_entry WHERE conversation_id = ? AND engine = ? ORDER BY seq")
    .all(conversationId, engine) as EntryDbRow[];
  const groups = new Map<string, EngineEntryGroup & { sealed: Set<string | null> }>();
  for (const row of rows) {
    let group = groups.get(row.anchor_message_id);
    if (!group) {
      group = { anchorMessageId: row.anchor_message_id, digest: null, entries: [], sealed: new Set() };
      groups.set(row.anchor_message_id, group);
    }
    let payload: JsonValue;
    try {
      payload = JSON.parse(row.payload) as JsonValue;
    } catch (err) {
      reportError("persistence", "info", "引擎私有条目损坏，该组改由会话记录重建", err, "engine_entry_corrupt");
      group.sealed.add(null);
      continue;
    }
    group.sealed.add(row.digest);
    group.entries.push({ seq: row.seq, format: row.format, entryId: row.entry_id, payload });
  }
  return [...groups.values()].map(({ sealed, ...group }) => {
    const [only] = sealed;
    return { ...group, digest: sealed.size === 1 && typeof only === "string" ? only : null };
  });
}

/** 追加到会话末尾(seq 续号)。digest 缺省 = 未封存,由一轮结束时 sealEngineEntries 封存;给出则新行
 *  直接按它封存(内容已定的追加,如原生压缩)。entry_id 已存在的条目跳过——对账重放幂等。返回新增行数。 */
export function appendEngineEntries(
  db: Db,
  conversationId: string,
  engine: string,
  anchorMessageId: string,
  entries: readonly EngineEntryInput[],
  digest: string | null = null,
): number {
  if (entries.length === 0) return 0;
  const insert = db.prepare(
    "INSERT INTO pc_engine_entry (conversation_id, engine, seq, format, anchor_message_id, entry_id, payload, digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
  );
  return db.transaction(() => {
    const last = db.prepare("SELECT MAX(seq) AS n FROM pc_engine_entry WHERE conversation_id = ? AND engine = ?").get(conversationId, engine) as { n: number | null };
    let seq = (last.n ?? -1) + 1;
    let added = 0;
    for (const entry of entries) {
      const { changes } = insert.run(conversationId, engine, seq, entry.format, anchorMessageId, entry.entryId ?? null, JSON.stringify(entry.payload), digest);
      seq += changes;
      added += changes;
    }
    return added;
  })();
}

/** 封存一个锚定的全部行。返回封存的行数。 */
export function sealEngineEntries(db: Db, conversationId: string, engine: string, anchorMessageId: string, digest: string): number {
  return db
    .prepare("UPDATE pc_engine_entry SET digest = ? WHERE conversation_id = ? AND engine = ? AND anchor_message_id = ?")
    .run(digest, conversationId, engine, anchorMessageId).changes;
}

/** 删除一个锚定的全部行,返回删除的行数(锚定消息被新一次生成复用时,旧条目作废)。 */
export function clearEngineEntries(db: Db, conversationId: string, engine: string, anchorMessageId: string): number {
  return db
    .prepare("DELETE FROM pc_engine_entry WHERE conversation_id = ? AND engine = ? AND anchor_message_id = ?")
    .run(conversationId, engine, anchorMessageId).changes;
}

export function readEngineSessionHeader(db: Db, conversationId: string, engine: string): EngineSessionHeader | null {
  const row = db
    .prepare("SELECT format, header FROM pc_engine_session WHERE conversation_id = ? AND engine = ?")
    .get(conversationId, engine) as { format: string; header: string } | null;
  if (!row) return null;
  try {
    return { format: row.format, header: JSON.parse(row.header) as JsonValue };
  } catch (err) {
    reportError("persistence", "info", "引擎会话头损坏，按无头处理", err, "engine_session_header_corrupt");
    return null;
  }
}

export function writeEngineSessionHeader(db: Db, conversationId: string, engine: string, value: EngineSessionHeader): void {
  db.prepare(
    "INSERT INTO pc_engine_session (conversation_id, engine, format, header) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(conversation_id, engine) DO UPDATE SET format = excluded.format, header = excluded.header",
  ).run(conversationId, engine, value.format, JSON.stringify(value.header));
}

/** 删除锚定消息已不在会话里的条目(消息删除、截断重生成)。在 persistConversation 的事务里调用。 */
export function pruneOrphanEngineEntries(db: Db, conversationId: string, liveMessageIds: ReadonlySet<string>): void {
  const anchors = db
    .prepare("SELECT DISTINCT anchor_message_id AS id FROM pc_engine_entry WHERE conversation_id = ?")
    .all(conversationId) as { id: string }[];
  const remove = db.prepare("DELETE FROM pc_engine_entry WHERE conversation_id = ? AND anchor_message_id = ?");
  for (const { id } of anchors) {
    if (!liveMessageIds.has(id)) remove.run(conversationId, id);
  }
}

// ----- 桌面端转储与重灌(给 APP 的导出从不经过这里) -----

/** 在已 ATTACH 的转储库里建两表并整表复制。转储库不带外键,与它的节点表一致。 */
export function copyEngineTablesInto(db: Db, schema: string): void {
  db.exec(engineTablesDdl(schema, false));
  for (const table of ENGINE_TABLES) {
    const columns = ENGINE_TABLE_COLUMNS[table];
    db.exec(`INSERT INTO ${schema}.${table} (${columns}) SELECT ${columns} FROM main.${table}`);
  }
}

/** 两表原始行(payload / header 保持 JSON 文本)。任一表不存在(format 3 之前的转储)返回 null。 */
export function readEngineTables(db: Db): PcEngineTablesRows | null {
  for (const table of ENGINE_TABLES) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return null;
  }
  return {
    sessions: db.prepare(`SELECT ${ENGINE_TABLE_COLUMNS.pc_engine_session} FROM pc_engine_session`).all() as PcEngineSessionRow[],
    entries: db.prepare(`SELECT ${ENGINE_TABLE_COLUMNS.pc_engine_entry} FROM pc_engine_entry ORDER BY conversation_id, engine, seq`).all() as PcEngineEntryRow[],
  };
}

/** 活库重灌前的现有行。读失败(库损坏,bak 重灌的场景)按无行处理:私有条目可由中立记录重建。 */
export function snapshotLiveEngineTables(db: Db): PcEngineTablesRows | null {
  try {
    return readEngineTables(db);
  } catch (err) {
    reportError("persistence", "info", "引擎私有条目读取失败，重灌后改由会话记录重建", err, "engine_entries_unreadable");
    return null;
  }
}

/** 重灌活库后写回两表(resetConversationsDbTo 同事务):只留会话仍在、且锚定消息仍在的行——
 *  外键不允许指向不存在的会话,锚定已消失的条目没有用处。 */
export function refillEngineTables(db: Db, rows: PcEngineTablesRows, conversations: readonly Conversation[]): void {
  const liveMessageIds = new Map<string, Set<string>>();
  for (const conversation of conversations) {
    liveMessageIds.set(conversation.id, new Set((conversation.messages ?? []).flatMap((node) => node.messages.map((message) => message.id))));
  }
  const insertSession = db.prepare(
    `INSERT OR IGNORE INTO pc_engine_session (${ENGINE_TABLE_COLUMNS.pc_engine_session}) VALUES (?, ?, ?, ?)`,
  );
  for (const row of rows.sessions) {
    if (liveMessageIds.has(row.conversation_id)) insertSession.run(row.conversation_id, row.engine, row.format, row.header);
  }
  const insertEntry = db.prepare(
    `INSERT OR IGNORE INTO pc_engine_entry (${ENGINE_TABLE_COLUMNS.pc_engine_entry}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows.entries) {
    if (!liveMessageIds.get(row.conversation_id)?.has(row.anchor_message_id)) continue;
    insertEntry.run(row.conversation_id, row.engine, row.seq, row.format, row.anchor_message_id, row.entry_id, row.payload, row.digest);
  }
}
