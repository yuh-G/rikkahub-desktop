// conversations/index.ts — 会话 SQLite 活库与持久化原语
// 纪律：负责 pc_conversation / pc_message_node 的读写、脏标记 flush、迁移灌库。
// 不处理 SSE 广播、不处理生成流程——那些留在 server.ts / api / inference-engine。

import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { Database } from "bun:sqlite";
import { conversationsDbPath, dataDir } from "../foundation/paths";
import { checkoutConversation, configureWorkingSet, peekConversation, releaseConversation, startWorkingSetSweep } from "./working-set";
import { hasQueuedMessages } from "./message-queue";
import { getConversationMeta } from "./read-queries";
import { generating } from "./generation-state";
import type { Conversation, ConversationListDto, JsonValue, Message, MessageNode, MessageNodeDto, PcConversationRow, PcMessageNodeRow, PcWorkspaceRow } from "../foundation/types";
import { clearAllFts, deleteConversationFts, ensureMessageFtsTable, ftsRowCount, rebuildFtsFromNodeTable, replaceNodeFts } from "./fts";
import { reportError } from "../observability/app-errors";
import { collectPcFileRefs } from "../backup/file-refs";

export const DEFAULT_ASSISTANT_ID = "0950e2dc-9bd5-4801-afa3-aa887aa36b4e";

let conversationsDb: InstanceType<typeof Database> | null = null;

export function getConversationsDb(): InstanceType<typeof Database> | null {
  return conversationsDb;
}

/** 打开/创建会话活库并建表(幂等)。每次启动调一次,返回长连接。 */
export function openConversationsDb(): InstanceType<typeof Database> {
  mkdirSync(dataDir, { recursive: true });
  try {
    conversationsDb = openConversationsDbUnsafe();
    return conversationsDb;
  } catch (err) {
    // 活库损坏(杀软隔离 / 磁盘错误 / 非 SQLite 文件 / 旧版残留)。1.2.5 前无 DB 依赖、服务
    // 总能起来;1.2.6 不能因活库损坏让整个服务起不来。保留坏文件供事后取证,清旁文件,重建
    // 空库。后续恢复:未迁移过 → migrateConversationsIfNeeded 从 state.json(方案 A 保住的
    // 重试源)或 pre-sqlite.bak(方案 B)重新灌库;已迁移过 → 空库起步,坏文件已留存,用户
    // 可用 sqlite3 .recover 手动 salvage。不自动用 stale 的 .bak 覆盖(已迁移后会话已变动,
    // 回滚到迁移前会静默丢新增/复活已删,比空库更迷惑)。
    console.error("[conv-db] 活库打开/建表失败,尝试隔离坏文件并重建:", err);
    try {
      if (existsSync(conversationsDbPath)) {
        const corruptPath = `${conversationsDbPath}.corrupt-${Date.now()}`;
        try { renameSync(conversationsDbPath, corruptPath); }
        catch { /* 文件锁/权限:尽力而为,继续清旁文件重建 */ }
      }
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = `${conversationsDbPath}${suffix}`;
        if (existsSync(sidecar)) { try { unlinkSync(sidecar); } catch { /* best-effort */ } }
      }
      conversationsDb = openConversationsDbUnsafe();
      return conversationsDb;
    } catch (err2) {
      console.error("[conv-db] 重建活库仍失败,会话持久化不可用", err2);
      throw err2;
    }
  }
}

/** 建表 + 索引(幂等)。生产(openConversationsDbUnsafe)与回归测试共用同一份 schema,
 *  防止测试库与真实库漂移(全面审查 2-0 的教训:级联行为必须在真实 schema 上验证)。 */
export function ensureConversationTables(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pc_conversation (
      id                 TEXT PRIMARY KEY NOT NULL,
      assistant_id       TEXT NOT NULL,
      title              TEXT NOT NULL DEFAULT '',
      system_prompt      TEXT NOT NULL DEFAULT '',
      suggestions        TEXT NOT NULL DEFAULT '[]',
      is_pinned          INTEGER NOT NULL DEFAULT 0,
      create_at          INTEGER NOT NULL,
      update_at          INTEGER NOT NULL,
      mode_injection_ids TEXT NOT NULL DEFAULT '[]',
      lorebook_ids       TEXT NOT NULL DEFAULT '[]',
      workspace_id       TEXT,
      workspace_cwd      TEXT,
      engine_compactions TEXT
    );
    CREATE TABLE IF NOT EXISTS pc_message_node (
      id              TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL,
      node_index      INTEGER NOT NULL,
      messages        TEXT NOT NULL DEFAULT '[]',
      select_index    INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (conversation_id) REFERENCES pc_conversation(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pc_msg_node_conv ON pc_message_node(conversation_id);
    -- J 族(专题2):列表分页的覆盖排序索引(assistant 过滤 + 置顶/更新时间倒序扫描)。
    CREATE INDEX IF NOT EXISTS idx_pc_conversation_list ON pc_conversation(assistant_id, is_pinned, update_at, create_at, id);
  `);
}

/** 1.5.0 跟进安卓 Migration_16_17:废弃"清除上下文"机制,删除 truncate_index 列。
 *  替代机制与安卓一致——助手级"上下文消息数量"(contextMessageLimit)+ 压缩对话历史。
 *  老库多这一列时一次性 DROP;失败仅告警(残留列有 DEFAULT,读写均不再引用,无害)。 */
/** 专题9:老库补加会话级注入绑定列(对齐安卓 mode_injection_ids/lorebook_ids)。幂等。 */
function ensureConversationInjectionColumns(db: InstanceType<typeof Database>): void {
  try {
    const cols = db.prepare("PRAGMA table_info(pc_conversation)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "mode_injection_ids")) {
      db.exec("ALTER TABLE pc_conversation ADD COLUMN mode_injection_ids TEXT NOT NULL DEFAULT '[]'");
    }
    if (!cols.some((c) => c.name === "lorebook_ids")) {
      db.exec("ALTER TABLE pc_conversation ADD COLUMN lorebook_ids TEXT NOT NULL DEFAULT '[]'");
    }
  } catch (err) {
    console.warn("[conv-db] 会话注入绑定列迁移失败(该功能暂不可用,下次启动重试)", err);
  }
}

/** 工作区篇章(feat/workspace):老库补加会话的工作区归属列。幂等,可空列旧数据天然兼容
 *  (NULL = 对话模式)。仅存 PC 自有库,跨端导出白名单不含这两列(§9.1)。 */
function ensureConversationWorkspaceColumns(db: InstanceType<typeof Database>): void {
  try {
    const cols = db.prepare("PRAGMA table_info(pc_conversation)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "workspace_id")) {
      db.exec("ALTER TABLE pc_conversation ADD COLUMN workspace_id TEXT");
    }
    if (!cols.some((c) => c.name === "workspace_cwd")) {
      db.exec("ALTER TABLE pc_conversation ADD COLUMN workspace_cwd TEXT");
    }
  } catch (err) {
    console.warn("[conv-db] 会话工作区列迁移失败(工作区功能暂不可用,下次启动重试)", err);
  }
}

/** 引擎压缩记录列(T3 物理改名,方案 B 原子 RENAME):会话级压缩记录引擎中性——
 *  压缩是引擎无关能力(任何 run-and-suspend 引擎都可压缩),列名不再绑死 pi。
 *  三段式幂等迁移(本工作区版未发版,无真实老库,但保留完整升级路径以保证幂等):
 *    ①已有 engine_compactions → 跳过;
 *    ②有 pi_compactions 无新列 → RENAME COLUMN(原子,零数据搬运);
 *    ③皆无 → ADD COLUMN engine_compactions。
 *  可空列旧数据天然兼容(NULL = 无压缩记录)。P2 的 pi_session_file 列不再读写,
 *  老库中留作死列(SQLite 删列代价不值当)。仅存 PC 自有库,跨端导出白名单不含此列。
 *  export 仅为回归测试(老库升级路径需在真实 ALTER 上验证)。 */
export function ensureConversationEngineCompactionsColumn(db: InstanceType<typeof Database>): void {
  try {
    const cols = db.prepare("PRAGMA table_info(pc_conversation)").all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    if (names.has("engine_compactions")) return; // ①已是新列
    if (names.has("pi_compactions")) {
      db.exec("ALTER TABLE pc_conversation RENAME COLUMN pi_compactions TO engine_compactions"); // ②原子改名
    } else {
      db.exec("ALTER TABLE pc_conversation ADD COLUMN engine_compactions TEXT"); // ③全新补列
    }
  } catch (err) {
    console.warn("[conv-db] 会话引擎压缩记录列迁移失败(压缩状态暂不持久,下次启动重试)", err);
  }
}

function dropTruncateIndexColumnIfPresent(db: InstanceType<typeof Database>): void {
  try {
    const cols = db.prepare("PRAGMA table_info(pc_conversation)").all() as { name: string }[];
    if (cols.some((c) => c.name === "truncate_index")) {
      db.exec("ALTER TABLE pc_conversation DROP COLUMN truncate_index");
      console.log("[conv-db] 已删除废弃列 pc_conversation.truncate_index(跟进安卓 Migration_16_17)");
    }
  } catch (err) {
    console.warn("[conv-db] truncate_index 列清理失败(残留无害,下次启动重试)", err);
  }
}

/** 实际打开 + PRAGMA + 建表。抛错时确保关闭句柄(Windows 文件锁),否则 rename 会失败。 */
function openConversationsDbUnsafe(): InstanceType<typeof Database> {
  const db = new Database(conversationsDbPath, { create: true, readwrite: true });
  try {
    // WAL:脏页进 -wal 旁文件,不重写主库——这是"增量写"的根本机制。
    // synchronous=NORMAL:WAL 下足够安全且更快(每次 commit 不强制 fsync)。
    // foreign_keys=ON:CASCADE 删除依赖它(删会话行自动带走其节点)。
    // busy_timeout:并发写竞争时等待而非立即报 SQLITE_BUSY。
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    ensureConversationTables(db);
    dropTruncateIndexColumnIfPresent(db);
    ensureConversationInjectionColumns(db);
    ensureConversationWorkspaceColumns(db);
    ensureConversationEngineCompactionsColumn(db);
    ensureMessageFtsTable(db);
    // FTS 自愈重建：老库首次升级（表刚建、空）或索引意外丢失时，从节点表全量重建。
    // 幂等：行数>0 时零成本跳过。
    try {
      const nodeCount = (db.prepare("SELECT COUNT(*) AS n FROM pc_message_node").get() as { n: number }).n;
      if (nodeCount > 0 && ftsRowCount(db) === 0) {
        const rebuilt = rebuildFtsFromNodeTable(db);
        console.log(`[conv-db] 消息全文索引重建完成：${rebuilt} 个节点`);
      }
    } catch (ftsErr) {
      console.warn("[conv-db] FTS 重建失败（搜索降级为空结果，不影响会话读写）:", ftsErr);
    }
    return db;
  } catch (err) {
    try { db.close(); } catch { /* best-effort:句柄随 GC 释放 */ }
    throw err;
  }
}

// 会话列表顺序 = createAt 倒序:旧架构数组只在新建/fork 时 unshift(unshift 时刻
// createAt = Date.now(),从不 sort/reorder/push),数组顺序严格等价于 createAt 倒序。
// DB-first 用 ORDER BY create_at DESC, id DESC 保持该顺序(read-queries.ts 同)。
/** 读取全部会话元数据(不 parse 节点 JSON,messages 置空)。迁移/合并路径用。 */
export function loadConversationMetasFromDb(db: InstanceType<typeof Database>): Conversation[] {
  // SELECT *:本函数也服务老 pc_conversations.db dump 的读回(备份 2.0),老 dump 没有
  // 后加的注入绑定列,显式列名会直接查询失败;缺列按空集容错。
  const convRows = db.prepare(
    "SELECT * FROM pc_conversation ORDER BY create_at DESC, id DESC",
  ).all() as PcConversationRow[];
  return convRows.map((row) => ({
    id: row.id,
    assistantId: row.assistant_id,
    systemPrompt: row.system_prompt || null,
    title: row.title ?? "",
    messages: [],
    chatSuggestions: safeParseStringArray(row.suggestions),
    isPinned: row.is_pinned === 1,
    createAt: row.create_at,
    updateAt: row.update_at,
    modeInjectionIds: safeParseStringArray(row.mode_injection_ids ?? "[]"),
    lorebookIds: safeParseStringArray(row.lorebook_ids ?? "[]"),
    workspaceId: row.workspace_id ?? null,
    workspaceCwd: row.workspace_cwd ?? null,
    engineCompactions: safeParseJsonArray(row.engine_compactions),
  }));
}

/** engine_compactions 列(JSON 数组)解析:空/损坏/非数组回 null(= 无压缩记录)。
 *  read-queries.ts 复用本函数(同口径),不再私有复制。 */
export function safeParseJsonArray(text: string | null | undefined): JsonValue[] | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as JsonValue[]) : null;
  } catch {
    return null;
  }
}

/** 读取单个会话的消息树(按 node_index 组装)。懒加载的按需读取原语。 */
export function loadConversationNodesFromDb(db: InstanceType<typeof Database>, conversationId: string): MessageNode[] {
  const nodeRows = db.prepare(
    "SELECT id, node_index, messages, select_index FROM pc_message_node WHERE conversation_id = ? ORDER BY node_index ASC",
  ).all(conversationId) as PcMessageNodeRow[];
  return nodeRows.map((nr) => ({
    id: nr.id,
    messages: safeParseMessageArray(nr.messages),
    selectIndex: nr.select_index ?? 0,
  }));
}

/** 读取全部会话(会话行 + 各自节点),组装成内存 Conversation[]。
 *  PC zip 恢复路径用:dump 读回须全量进内存当替换基底(backup/import.ts)。
 *  ⚠️ 安卓 zip 的「合并」基底改用 listAllConversationMetas + 逐会话 checkout 流式合并,
 *  不再走本函数全量驻留(B1:海量会话 + 全量节点 messages 会在导入时把 JS 堆打爆)。 */
export function loadAllConversationsFromDb(db: InstanceType<typeof Database>): Conversation[] {
  const conversations = loadConversationMetasFromDb(db);
  for (const conv of conversations) conv.messages = loadConversationNodesFromDb(db, conv.id);
  return conversations;
}

/** B1:收集消息节点里引用的文件 id。先用 SQL LIKE 把「含 /api/files/ 引用」的节点在库层
 *  筛掉(海量会话库里这类节点是极少数),再对命中行在 JS 侧用与导出端同一正则抽取 id。
 *  与旧「全库 messages 文本搬进 JS 堆」相比,常驻内存从「全库文本」降到「仅命中行」。
 *  注:Bun 的 SQLite 无 regexp_extract,故抽取仍在 JS——但只在 LIKE 命中的行上做。 */
export function collectConversationReferencedFileIds(db: InstanceType<typeof Database>, into: Set<number>): void {
  const rows = db
    .prepare("SELECT messages FROM pc_message_node WHERE messages LIKE '%/api/files/%'")
    .all() as { messages: string }[];
  for (const row of rows) collectPcFileRefs(row.messages, into);
}

// ----- DB-first:会话运行时权威 = 活库 + working set -----
//
// 数据角色终局:SQLite 活库 = 唯一持久权威,读路径直查(WAL 下亚毫秒,页缓存即热缓存);
// 内存只保留"正在被使用"的会话实例,由 working-set.ts 单一权威实例注册表管理
// (checkout/release 引用计数 + sweep 四条件清扫);state.json 不再涉会话。
// 写路径不变:脏标记 200ms 节流 flush + persistConversation 全量落库。

/** working set 的加载器:活库读元数据行 + 消息树,组装完整 Conversation。 */
function loadConversationForWorkingSet(convId: string): Conversation | undefined {
  if (!conversationsDb) return undefined;
  try {
    const meta = getConversationMeta(conversationsDb, convId);
    if (!meta) return undefined;
    meta.messages = loadConversationNodesFromDb(conversationsDb, convId);
    return meta;
  } catch (err) {
    console.warn("[conv-db] working set 加载会话失败", convId, err);
    return undefined;
  }
}

/** 该会话是否有未落库的脏标记(sweep 判据之一;脏集合毫秒级清空,遍历成本可忽略)。 */
function hasConvDirtyState(convId: string): boolean {
  if (dirtyConversationIds.has(convId)) return true;
  const prefix = convId + "::";
  for (const key of dirtyNodeKeys) if (key.startsWith(prefix)) return true;
  return false;
}

// 默认 guards(单测/工具脚本直接 import 本模块时即可用);bootstrap() 经 api/sse 的
// initSseWiring 注入真实的 SSE 客户端判据(避免 index→sse→index 循环导入)。
let hasSseClientsGuard: (convId: string) => boolean = () => false;

export function initWorkingSetSseGuard(hasSseClients: (convId: string) => boolean): void {
  hasSseClientsGuard = hasSseClients;
}

// 0-3:接线与清扫定时器由 bootstrap() 显式启动,不再是 import 副作用——
// 单测/工具脚本 import 本模块不会再拉起 30s 定时器;需要 working set 的测试
// 自行 configureWorkingSet(注入假判据)或调用本函数。
export function initConversationsRuntime(): void {
  configureWorkingSet({
    loadConversation: loadConversationForWorkingSet,
    isGenerating: (convId) => generating.has(convId),
    hasSseClients: (convId) => hasSseClientsGuard(convId),
    hasDirty: hasConvDirtyState,
    // 队列非空即驻留:生成派发链跨"当前流结束→下条点火"空窗持有会话,防 sweep 逐出致队列孤儿化。
    hasQueuedMessages: (convId) => hasQueuedMessages(convId),
  });
  startWorkingSetSweep();
}

/** 标题兜底专用:取第一个节点的第一条消息 parts。working set 命中读实例(含未 flush
 *  的最新数据),否则只读活库单行,不触发整树加载、不驻留。 */
export function peekFirstMessageParts(convId: string): Message["parts"] {
  const held = peekConversation(convId);
  if (held) return held.messages[0]?.messages[0]?.parts ?? [];
  if (!conversationsDb) return [];
  try {
    const row = conversationsDb.prepare(
      "SELECT messages FROM pc_message_node WHERE conversation_id = ? AND node_index = 0",
    ).get(convId) as { messages: string } | null;
    if (!row) return [];
    return safeParseMessageArray(row.messages)[0]?.parts ?? [];
  } catch {
    return [];
  }
}

function safeParseMessageArray(raw: string): Message[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Message[]) : [];
  } catch {
    return [];
  }
}
function safeParseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

// 全面审查 2-0(P0)修复:会话/节点 upsert 一律用 ON CONFLICT DO UPDATE,绝不可用
// INSERT OR REPLACE。SQLite 的 REPLACE = 隐式 DELETE+INSERT,而 foreign_keys=ON 时该隐式
// DELETE 会触发 pc_message_node 的 ON DELETE CASCADE——对已存在的会话行 REPLACE 一次,
// 该会话全部节点行被级联清空。流式期间每 200ms flush 都 upsert 会话行,等于整个流式期间
// 磁盘上只剩正在补写的脏节点;流式中途进程死亡 = 会话历史永久丢失。
const UPSERT_CONVERSATION_SQL =
  "INSERT INTO pc_conversation (id, assistant_id, title, system_prompt, suggestions, is_pinned, create_at, update_at, mode_injection_ids, lorebook_ids, workspace_id, workspace_cwd, engine_compactions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT(id) DO UPDATE SET assistant_id = excluded.assistant_id, title = excluded.title, system_prompt = excluded.system_prompt, " +
  "suggestions = excluded.suggestions, is_pinned = excluded.is_pinned, create_at = excluded.create_at, update_at = excluded.update_at, " +
  "mode_injection_ids = excluded.mode_injection_ids, lorebook_ids = excluded.lorebook_ids, workspace_id = excluded.workspace_id, workspace_cwd = excluded.workspace_cwd, " +
  "engine_compactions = excluded.engine_compactions";

const UPSERT_NODE_SQL =
  "INSERT INTO pc_message_node (id, conversation_id, node_index, messages, select_index) VALUES (?, ?, ?, ?, ?) " +
  "ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id, node_index = excluded.node_index, messages = excluded.messages, select_index = excluded.select_index";

/** upsert 单个会话行(不含节点),显式传 db——生产包装与回归测试共用。 */
export function upsertConversationRowInto(db: InstanceType<typeof Database>, conv: Conversation): void {
  db.prepare(UPSERT_CONVERSATION_SQL).run(
    conv.id,
    conv.assistantId || DEFAULT_ASSISTANT_ID,
    conv.title || "",
    conv.systemPrompt ?? "",
    JSON.stringify(conv.chatSuggestions ?? []),
    conv.isPinned ? 1 : 0,
    conv.createAt || Date.now(),
    conv.updateAt || Date.now(),
    JSON.stringify(conv.modeInjectionIds ?? []),
    JSON.stringify(conv.lorebookIds ?? []),
    conv.workspaceId ?? null,
    conv.workspaceCwd ?? null,
    conv.engineCompactions?.length ? JSON.stringify(conv.engineCompactions) : null,
  );
}

/** upsert 单个会话行(不含节点)。流式中 updateAt/title 变化、以及全量 reconcile 复用。 */
export function upsertConversationRow(conv: Conversation): void {
  if (!conversationsDb) throw new Error("conversationsDb not open");
  upsertConversationRowInto(conversationsDb, conv);
}

/** upsert 单个节点行(含 FTS 同步),显式传 db——生产包装与回归测试共用。
 *  syncFts=false(专题2 H-c):流式脏 flush 专用——流式期间每 200ms 对整节点做
 *  "删 FTS 行+全文 trigram 重分词"是纯无用功(半成品文本反复索引又删除,实测 100KB
 *  文本 1.1ms、300KB 3.2ms,5 次/秒,成本 O(全文) 随流长累积 O(N²)),且同步占用事件
 *  循环与 SSE 发送竞争。流结束的 persistConversation 全量 reconcile 会重建该会话全部
 *  FTS(stop 端点亦直接 persistConversation),搜索最多晚到流结束才可见——现状本就有
 *  200ms 滞后,语义可接受。唯一残余窗口:流式中进程被硬杀,该节点 FTS 缺最后一段,
 *  下次任何 persistConversation 该会话即自愈;数据本身(节点行)不受影响。 */
export function upsertMessageNodeInto(db: InstanceType<typeof Database>, convId: string, node: MessageNode, nodeIndex: number, syncFts = true): void {
  db.prepare(UPSERT_NODE_SQL).run(
    node.id,
    convId,
    nodeIndex,
    JSON.stringify(node.messages ?? []),
    node.selectIndex ?? 0,
  );
  if (!syncFts) return;
  try { replaceNodeFts(db, convId, node); }
  catch (err) { console.warn("[conv-db] FTS 节点同步失败", node.id, err); }
}

/** upsert 单个节点行。流式热路径用,nodeIndex 由调用方提供。 */
export function upsertMessageNode(convId: string, node: MessageNode, nodeIndex: number, syncFts = true): void {
  if (!conversationsDb) throw new Error("conversationsDb not open");
  upsertMessageNodeInto(conversationsDb, convId, node, nodeIndex, syncFts);
}

/**
 * 全量 reconcile:事务内 upsert 会话行 + 删除该会话全部旧节点 + 按当前顺序重插。
 * 给非流式一次性变更用(改名/置顶/编辑/分叉/导入/流结束)。处理节点增删/重排,显而易见
 * 地正确;一次用户动作调一次,可承受。
 */
export function persistConversation(conv: Conversation): void {
  if (!conversationsDb) throw new Error("conversationsDb not open");
  const db = conversationsDb;
  const deleteNodes = db.prepare("DELETE FROM pc_message_node WHERE conversation_id = ?");
  const insertNode = db.prepare(UPSERT_NODE_SQL);
  const txn = db.transaction(() => {
    upsertConversationRow(conv);
    deleteNodes.run(conv.id);
    deleteConversationFts(db, [conv.id]);
    for (let i = 0; i < (conv.messages ?? []).length; i += 1) {
      const node = conv.messages[i];
      if (!node?.id) continue;
      insertNode.run(node.id, conv.id, i, JSON.stringify(node.messages ?? []), node.selectIndex ?? 0);
      replaceNodeFts(db, conv.id, node);
    }
  });
  txn();
}

/** 删除会话(CASCADE 带走其节点行,依赖 foreign_keys=ON)。 */
export function deletePcConversations(ids: string[]): void {
  if (!conversationsDb || ids.length === 0) return;
  const stmt = conversationsDb.prepare("DELETE FROM pc_conversation WHERE id = ?");
  const db = conversationsDb;
  const txn = db.transaction(() => {
    for (const idValue of ids) stmt.run(idValue);
    deleteConversationFts(db, ids);
  });
  txn();
}

/** 会话总数。迁移校验/自测用。 */
export function countPcConversations(db: InstanceType<typeof Database>): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM pc_conversation").get() as { n: number } | null;
  return row?.n ?? 0;
}

// ----- 流式脏标记 + 节流 flush(仅会话活库用)-----
//
// 流式热路径不再走 scheduleThrottledSaveState(那会全量重写 state.json)。改成:每个 chunk
// 把"正在长的会话行 + 节点"标脏,200ms 合并后逐个 upsert 进活库。多路流式并发时,脏集合
// 累积各自 (convId, nodeId),flush 时从内存 state 算出正确 nodeIndex 逐行 upsert,SQLite
// WAL 自带写串行化。bun:sqlite 同步,但单行 upsert 亚毫秒,阻塞可忽略。

const dirtyConversationIds = new Set<string>();
const dirtyNodeKeys = new Set<string>(); // `${convId}::${nodeId}`
let pendingConvFlush: ReturnType<typeof setTimeout> | null = null;
let lastConvFlushMs = 0;
const CONV_FLUSH_INTERVAL_MS = 200;

export function markConversationRowDirty(convId: string): void {
  dirtyConversationIds.add(convId);
}
export function markMessageNodeDirty(convId: string, nodeId: string): void {
  dirtyNodeKeys.add(`${convId}::${nodeId}`);
}

/**
 * 遍历脏集合逐行 upsert,然后清空。从内存 state 解析 nodeIndex;若会话/节点已被并发删除
 * (如流式中删会话),跳过——避免 upsert 把已删的行又建回来。
 */
export function flushConvDirty(): void {
  if (!conversationsDb) return;
  lastConvFlushMs = Date.now();
  const convIds = Array.from(dirtyConversationIds);
  dirtyConversationIds.clear();
  const nodeKeys = Array.from(dirtyNodeKeys);
  dirtyNodeKeys.clear();
  for (const convId of convIds) {
    // 脏标记只可能来自 checkout 过的会话,working set 必命中;未命中 = 会话已被删除
    const conv = peekConversation(convId);
    if (!conv) continue;
    try {
      upsertConversationRow(conv);
    } catch (err) {
      console.warn("[conv-db] upsert conversation row failed", convId, err);
    }
  }
  for (const key of nodeKeys) {
    const sep = key.indexOf("::");
    if (sep < 0) continue;
    const convId = key.slice(0, sep);
    const nodeId = key.slice(sep + 2);
    const conv = peekConversation(convId);
    if (!conv) continue; // 删除正在流的会话竞态:会话已不在 working set,不重建行
    const idx = conv.messages.findIndex((n) => n.id === nodeId);
    if (idx < 0) continue; // 节点已被删除/替换
    try {
      // H-c:流式 flush 跳过 FTS(见 upsertMessageNodeInto 注释),流结束 reconcile 补索引。
      upsertMessageNode(convId, conv.messages[idx], idx, false);
    } catch (err) {
      console.warn("[conv-db] upsert message node failed", convId, nodeId, err);
    }
  }
}

/** 200ms 节流合并(镜像 scheduleThrottledSaveState 的结构,但同步执行——单行 upsert 亚毫秒)。 */
export function scheduleThrottledConvFlush(): void {
  const now = Date.now();
  const elapsed = now - lastConvFlushMs;
  if (elapsed >= CONV_FLUSH_INTERVAL_MS) {
    if (pendingConvFlush) {
      clearTimeout(pendingConvFlush);
      pendingConvFlush = null;
    }
    flushConvDirty();
    return;
  }
  if (pendingConvFlush) return;
  pendingConvFlush = setTimeout(() => {
    pendingConvFlush = null;
    flushConvDirty();
  }, CONV_FLUSH_INTERVAL_MS - elapsed);
}

/** 立即 flush 并取消 pending 定时器。关停/流结束/导入前用。 */
export function flushConvDirtyNow(): void {
  if (pendingConvFlush) {
    clearTimeout(pendingConvFlush);
    pendingConvFlush = null;
  }
  flushConvDirty();
}

/** 清空脏标记集合与 pending 定时器(不 flush)。导入前中止所有流后调用,避免脏集合被 flush 到刚重灌的库。 */
export function clearConvDirtyState(): void {
  if (pendingConvFlush) {
    clearTimeout(pendingConvFlush);
    pendingConvFlush = null;
  }
  dirtyConversationIds.clear();
  dirtyNodeKeys.clear();
}

/**
 * 批量灌库(单事务)。比逐个 persistConversation 快(1 个事务 vs N 个)。迁移用。
 * 幂等:每个会话先显式删旧节点再按当前顺序重插,中途失败重跑不重复/不冲突。
 * (历史上靠 INSERT OR REPLACE 会话行的隐式级联删节点实现幂等——那正是 2-0 P0 的根源,
 * 现改为显式 DELETE,语义相同且不再依赖 REPLACE 的删行副作用。)
 */
export function migrateConversationsIntoDb(db: InstanceType<typeof Database>, conversations: Conversation[]): void {
  const upsertConv = db.prepare(UPSERT_CONVERSATION_SQL);
  const deleteNodes = db.prepare("DELETE FROM pc_message_node WHERE conversation_id = ?");
  const insertNode = db.prepare(UPSERT_NODE_SQL);
  const txn = db.transaction(() => {
    for (const conv of conversations) {
      upsertConv.run(
        conv.id,
        conv.assistantId || DEFAULT_ASSISTANT_ID,
        conv.title || "",
        conv.systemPrompt ?? "",
        JSON.stringify(conv.chatSuggestions ?? []),
        conv.isPinned ? 1 : 0,
        conv.createAt || Date.now(),
        conv.updateAt || Date.now(),
        JSON.stringify(conv.modeInjectionIds ?? []),
        JSON.stringify(conv.lorebookIds ?? []),
        conv.workspaceId ?? null,
        conv.workspaceCwd ?? null,
        conv.engineCompactions?.length ? JSON.stringify(conv.engineCompactions) : null,
      );
      deleteNodes.run(conv.id);
      deleteConversationFts(db, [conv.id]);
      for (let i = 0; i < (conv.messages ?? []).length; i += 1) {
        const node = conv.messages[i];
        if (!node?.id) continue;
        insertNode.run(node.id, conv.id, i, JSON.stringify(node.messages ?? []), node.selectIndex ?? 0);
        replaceNodeFts(db, conv.id, node);
      }
    }
  });
  txn();
}

/** R1-1 ③:启动迁移专用的分批灌库。旧的单事务整库灌在巨量会话下把事件循环整段占死
 *  (迁移期 503/进度端点全部失灵),且中途断电=全部重来。migrateConversationsIntoDb
 *  对单个会话幂等(upsert+删旧节点重插),按批提交后崩溃重启只是重做,不会脏;
 *  批间让出事件循环,/api/startup/status 才能被响应。 */
export async function migrateConversationsIntoDbBatched(
  db: InstanceType<typeof Database>,
  conversations: Conversation[],
  batchSize = 200,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  for (let start = 0; start < conversations.length; start += batchSize) {
    migrateConversationsIntoDb(db, conversations.slice(start, start + batchSize));
    onProgress?.(Math.min(start + batchSize, conversations.length), conversations.length);
    await Bun.sleep(0);
  }
}

/** 备份 2.0:把活库会话表 ATTACH 复制成独立 dump(pc_conversations.db)。
 *  PC→PC 会话备份的权威载体,与安卓 schema 模板彻底解耦(纯 PC 用户从此有完整会话备份)。
 *  不带 FTS(导入侧 resetConversationsDbTo 重建),纯 SQL 复制零 JS 内存开销;
 *  pc_dump_meta 携带格式版本与导出时间,为未来格式演进留判别依据。
 *  返回导出的会话行数;活库未打开返回 -1。
 *
 *  B6-①a(format 1→2):增 pcdump.pc_workspace。工作区实体(权限档/信任态/类型)是
 *  PC→PC 恢复后必须回来的资产——此前 dump 只有会话两表,会话行的 workspace_id 恢复了
 *  却指向不存在的工作区(绑定悬空)。pc_workspace 与 pc_conversation 同驻一个活库,故
 *  此处一并 ATTACH 复制;导入侧在同库事务内重灌。硬约束:此表只进 pc dump,绝不进
 *  安卓 rikka_hub.db(安卓 workspaces 表同名不同构),PC→APP 边界不受影响。
 *  表按存在性探测(不读 format 号),老 dump(format 1,无该表)导入时跳过工作区重灌。 */
export function exportPcConversationsDump(targetPath: string): number {
  if (!conversationsDb) return -1;
  const db = conversationsDb;
  if (existsSync(targetPath)) unlinkSync(targetPath);
  const escaped = targetPath.replace(/'/g, "''");
  db.exec(`ATTACH DATABASE '${escaped}' AS pcdump`);
  try {
    db.exec(`
      CREATE TABLE pcdump.pc_dump_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      CREATE TABLE pcdump.pc_conversation (
        id                 TEXT PRIMARY KEY NOT NULL,
        assistant_id       TEXT NOT NULL,
        title              TEXT NOT NULL DEFAULT '',
        system_prompt      TEXT NOT NULL DEFAULT '',
        suggestions        TEXT NOT NULL DEFAULT '[]',
        is_pinned          INTEGER NOT NULL DEFAULT 0,
        create_at          INTEGER NOT NULL,
        update_at          INTEGER NOT NULL,
        mode_injection_ids TEXT NOT NULL DEFAULT '[]',
        lorebook_ids       TEXT NOT NULL DEFAULT '[]',
        workspace_id       TEXT,
        workspace_cwd      TEXT,
        engine_compactions TEXT
      );
      CREATE TABLE pcdump.pc_message_node (
        id              TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL,
        node_index      INTEGER NOT NULL,
        messages        TEXT NOT NULL DEFAULT '[]',
        select_index    INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE pcdump.pc_workspace (
        id                TEXT PRIMARY KEY NOT NULL,
        name              TEXT NOT NULL,
        type              TEXT NOT NULL,
        root              TEXT NOT NULL DEFAULT '',
        permission_preset TEXT NOT NULL,
        trusted_at        INTEGER,
        create_at         INTEGER NOT NULL,
        update_at         INTEGER NOT NULL,
        last_access_at    INTEGER NOT NULL
      );
      INSERT INTO pcdump.pc_dump_meta (key, value) VALUES ('format', '2'), ('exportedAt', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      INSERT INTO pcdump.pc_conversation SELECT id, assistant_id, title, system_prompt, suggestions, is_pinned, create_at, update_at, mode_injection_ids, lorebook_ids, workspace_id, workspace_cwd, engine_compactions FROM main.pc_conversation;
      INSERT INTO pcdump.pc_message_node SELECT id, conversation_id, node_index, messages, select_index FROM main.pc_message_node;
    `);
    // 工作区表在活库懒建(workspace/index.ts 的 db()):用户从未建过工作区时 main 侧该表
    // 不存在,SELECT 会让整个会话备份导出失败。按存在性探测——无则 dump 留空表(恢复侧
    // 重灌 0 行,语义等价"无工作区")。
    const hasWorkspaceTable = db.prepare(
      "SELECT name FROM main.sqlite_master WHERE type='table' AND name='pc_workspace'",
    ).get();
    if (hasWorkspaceTable) {
      db.exec("INSERT INTO pcdump.pc_workspace SELECT id, name, type, root, permission_preset, trusted_at, create_at, update_at, last_access_at FROM main.pc_workspace");
    }
    return (db.prepare("SELECT COUNT(*) AS n FROM pcdump.pc_conversation").get() as { n: number }).n;
  } finally {
    db.exec("DETACH DATABASE pcdump");
  }
}

/** 导入前安全网(收官审查 P0-1):活库非空时快照到 <活库>.pre-import.bak(单份滚动覆盖)。
 *  resetConversationsDbTo 是全表替换,备份损坏/缺库导致的导入灾难由此获得本地回退点。
 *  快照失败只告警不阻断导入(尽力而为的安全网,不是前置条件)。 */
export function snapshotConversationsDbBeforeImport(): void {
  if (!conversationsDb) return;
  try {
    const count = (conversationsDb.prepare("SELECT COUNT(*) AS n FROM pc_conversation").get() as { n: number }).n;
    if (count === 0) return;
    const bakPath = `${conversationsDbPath}.pre-import.bak`;
    if (existsSync(bakPath)) unlinkSync(bakPath);
    conversationsDb.exec(`VACUUM INTO '${bakPath.replace(/'/g, "''")}'`);
    console.log(`[conv-db] 导入前快照已写入 ${bakPath}(${count} 个会话)`);
  } catch (err) {
    reportError("backup", "warn", "导入前会话库快照失败，导入继续但无本地回退点", err, "live_db_snapshot_failed");
  }
}

/** 重灌活库为给定会话集:删除所有会话行(CASCADE 带走节点)+ 单事务灌入。
 *  导入备份/bak 恢复用——导入流程把替换/合并结果统一灌回活库(权威)。
 *
 *  B6-①a:可选 workspaces 形参(dump format 2 携带的 pc_workspace 行)。pc_workspace 与
 *  pc_conversation 同驻一个活库,工作区重灌必须与会话灌库同事务——否则会话灌失败回滚、
 *  工作区却写进库的半成品态。传入时先全清再重灌(与会话替换语义一致,绑定悬空由会话侧
 *  workspace_id 决定);未传(老 dump 无该表)不动现有工作区。表结构幂等懒建,与
 *  workspace/index.ts 同型。 */
export function resetConversationsDbTo(conversations: Conversation[], workspaces?: PcWorkspaceRow[]): void {
  if (!conversationsDb) throw new Error("conversationsDb not open");
  const db = conversationsDb;
  const txn = db.transaction(() => {
    db.exec("DELETE FROM pc_conversation");
    clearAllFts(db);
    migrateConversationsIntoDb(db, conversations);
    if (workspaces) {
      db.exec(`CREATE TABLE IF NOT EXISTS pc_workspace (
        id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, root TEXT NOT NULL DEFAULT '',
        permission_preset TEXT NOT NULL, trusted_at INTEGER, create_at INTEGER NOT NULL, update_at INTEGER NOT NULL, last_access_at INTEGER NOT NULL
      )`);
      db.exec("DELETE FROM pc_workspace");
      const ins = db.prepare(
        "INSERT INTO pc_workspace (id, name, type, root, permission_preset, trusted_at, create_at, update_at, last_access_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const w of workspaces) {
        ins.run(w.id, w.name, w.type, w.root, w.permission_preset, w.trusted_at, w.create_at, w.update_at, w.last_access_at);
      }
    }
  });
  txn();
}

/** 关停前做一次 WAL checkpoint,让 -wal 数据回写主库。 */
export function checkpointConversationsDb(): void {
  conversationsDb?.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

/** 按 id 取会话的权威实例(working set 命中或从活库装入)。
 *  checkout+立即 release:实例进注册表并刷新 lastAccess,60s 闲置宽限保证同步段安全;
 *  跨 await 修改会话的路径必须显式 checkout/release 持有引用(handlers 子路由块、
 *  generateAnswer),防 sweep 清出后另一处 checkout 装出第二实例并发互覆。 */
export function getConversation(idValue: string): Conversation | undefined {
  const conversation = checkoutConversation(idValue);
  if (conversation) releaseConversation(idValue);
  return conversation;
}

/** 领域 MessageNode → 线上 DTO。运行时同物零拷贝;领域 annotations/usage 在类型硬化
 *  收官前仍是 JsonValue,线上契约(foundation/types/dto.ts)已收窄为真实产出形状,
 *  这里是全工程唯一的显式窄化点。 */
export function toMessageNodeDtos(nodes: MessageNode[]): MessageNodeDto[] {
  return nodes as unknown as MessageNodeDto[];
}

/** 把 Conversation 转成列表项 DTO。 */
export function toListDto(conversation: Conversation, isGenerating: boolean): ConversationListDto {
  return {
    id: conversation.id,
    assistantId: conversation.assistantId,
    title: conversation.title,
    isPinned: conversation.isPinned,
    createAt: conversation.createAt,
    updateAt: conversation.updateAt,
    isGenerating,
    workspaceId: conversation.workspaceId ?? null,
  };
}

/** 按当前 selectIndex 取出每个节点的有效 message。 */
export function selectedConversationMessages(conversation: Conversation): Message[] {
  return conversation.messages
    .map((node) => node.messages[node.selectIndex] ?? node.messages[0])
    .filter(Boolean);
}

/** 重新生成前截断会话消息:
 * - 无 messageId:删除末尾 ASSISTANT 节点。
 * - 有 messageId:若目标消息是 USER,保留到该节点(含);若是 ASSISTANT,保留到该节点(不含)。
 */
export function truncateConversationForRegenerate(conversation: Conversation, messageId?: string): void {
  if (!messageId) {
    const last = conversation.messages[conversation.messages.length - 1];
    if (last?.messages[last.selectIndex]?.role === "ASSISTANT") conversation.messages.pop();
    return;
  }
  const nodeIndex = conversation.messages.findIndex((node) => node.messages.some((msg) => msg.id === messageId));
  if (nodeIndex < 0) return;
  const node = conversation.messages[nodeIndex];
  const msg = node.messages.find((item) => item.id === messageId);
  if (!msg) return;
  if (msg.role === "USER") {
    conversation.messages = conversation.messages.slice(0, nodeIndex + 1);
    return;
  }
  conversation.messages = conversation.messages.slice(0, nodeIndex);
}
