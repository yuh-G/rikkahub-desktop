// conversations/read-queries.ts — DB-first 只读查询原语（方案见 项目重构方案.md「DB-first 方案」批1）
//
// 设计：
// - 全部函数收 db 参数（不依赖单例），独立可单测；调用方从 getConversationsDb() 取句柄。
// - 只返回元数据行（不 parse 节点 JSON）；需要消息树时配合 loadConversationNodesFromDb 瞬时读。
// - 端点侧的过滤/排序/分页尽量留在 JS 逐字复刻旧内存实现：SQLite lower()/LIKE 只处理
//   ASCII 大小写，与 JS toLowerCase() 的 Unicode 语义有差异；元数据 SELECT 亚毫秒，
//   JS 侧处理换来与旧行为的逐字等价。SQL 只负责 WHERE assistant_id 与基准排序。
// - 返回的对象是一次性快照，**不得修改**——它们不在 working set 里，改了既不持久化也不广播。
import type { Database } from "bun:sqlite";
import type { Conversation } from "../foundation/types";
import { safeParseJsonArray } from "./index";

/** 会话元数据（messages 恒为空数组）。形状与 Conversation 一致以复用 toListDto 等既有转换。 */
export type ConversationMeta = Conversation;

interface MetaRow {
  id: string;
  assistant_id: string;
  title: string;
  system_prompt: string;
  suggestions: string;
  is_pinned: number;
  create_at: number;
  update_at: number;
  mode_injection_ids: string;
  lorebook_ids: string;
  workspace_id: string | null;
  workspace_cwd: string | null;
  engine_compactions: string | null;
}

function parseIdArray(raw: string | undefined): string[] {
  try {
    const parsed = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

function rowToMeta(row: MetaRow): ConversationMeta {
  let chatSuggestions: string[] = [];
  try {
    const parsed = JSON.parse(row.suggestions);
    if (Array.isArray(parsed)) chatSuggestions = parsed.map((v) => String(v));
  } catch { /* 损坏字段容错为空 */ }
  return {
    id: row.id,
    assistantId: row.assistant_id,
    systemPrompt: row.system_prompt || null,
    title: row.title ?? "",
    messages: [],
    chatSuggestions,
    isPinned: row.is_pinned === 1,
    createAt: row.create_at,
    updateAt: row.update_at,
    modeInjectionIds: parseIdArray(row.mode_injection_ids),
    lorebookIds: parseIdArray(row.lorebook_ids),
    workspaceId: row.workspace_id ?? null,
    workspaceCwd: row.workspace_cwd ?? null,
    engineCompactions: safeParseJsonArray(row.engine_compactions),
  };
}

const META_COLUMNS = "id, assistant_id, title, system_prompt, suggestions, is_pinned, create_at, update_at, mode_injection_ids, lorebook_ids, workspace_id, workspace_cwd, engine_compactions";

/**
 * 某助手的全部会话元数据，ORDER BY create_at DESC, id DESC——
 * 与旧内存数组顺序的等价还原（数组只在新建/fork 时 unshift，顺序严格等于
 * createAt 倒序，见 index.ts loadConversationMetasFromDb 上方注释）。
 */
export function listConversationMetas(db: Database, assistantId: string): ConversationMeta[] {
  const rows = db.prepare(
    `SELECT ${META_COLUMNS} FROM pc_conversation WHERE assistant_id = ? ORDER BY create_at DESC, id DESC`,
  ).all(assistantId) as MetaRow[];
  return rows.map(rowToMeta);
}

/** 单会话元数据（导出/搜索 join 等零散场景）。 */
export function getConversationMeta(db: Database, conversationId: string): ConversationMeta | null {
  const row = db.prepare(
    `SELECT ${META_COLUMNS} FROM pc_conversation WHERE id = ?`,
  ).get(conversationId) as MetaRow | null;
  return row ? rowToMeta(row) : null;
}

/** 全部会话元数据（不分助手；stats/export 全量遍历用），排序同 listConversationMetas。 */
export function listAllConversationMetas(db: Database): ConversationMeta[] {
  const rows = db.prepare(
    `SELECT ${META_COLUMNS} FROM pc_conversation ORDER BY create_at DESC, id DESC`,
  ).all() as MetaRow[];
  return rows.map(rowToMeta);
}

/** 某助手最近会话元数据（buildRecentChatsPrompt 用）：updateAt 倒序，并列时保持 createAt 倒序稳定性。 */
export function recentConversationMetas(db: Database, assistantId: string, excludeId: string | undefined, limit: number): ConversationMeta[] {
  const rows = db.prepare(
    `SELECT ${META_COLUMNS} FROM pc_conversation WHERE assistant_id = ? AND id != ? ORDER BY update_at DESC, create_at DESC, id DESC LIMIT ?`,
  ).all(assistantId, excludeId ?? "", limit) as MetaRow[];
  return rows.map(rowToMeta);
}

/** 列表展示排序(J 族):置顶优先、更新时间倒序;并列回退 create_at DESC, id DESC——
 *  与旧 JS 管线(createAt 倒序基序 + 稳定排序 isPinned/updateAt)逐元素等价,单测对照。 */
const LIST_ORDER = "ORDER BY is_pinned DESC, update_at DESC, create_at DESC, id DESC";

/**
 * 会话列表分页(专题2 J 族):排序与分页全在 SQL 侧完成(走 idx_pc_conversation_list
 * 复合索引),单次成本 O(页大小),与会话总数彻底解耦——数千会话时列表刷新与
 * invalidate 风暴不再每次全表读入 JS。total 供端点算 hasMore/nextOffset。
 */
export function pagedConversationMetas(db: Database, assistantId: string, offset: number, limit: number): { items: ConversationMeta[]; total: number } {
  const rows = db.prepare(
    `SELECT ${META_COLUMNS} FROM pc_conversation WHERE assistant_id = ? ${LIST_ORDER} LIMIT ? OFFSET ?`,
  ).all(assistantId, limit, offset) as MetaRow[];
  const total = (db.prepare("SELECT COUNT(*) AS n FROM pc_conversation WHERE assistant_id = ?").get(assistantId) as { n: number }).n;
  return { items: rows.map(rowToMeta), total };
}

export function countConversations(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM pc_conversation").get() as { n: number } | null;
  return row?.n ?? 0;
}

/** 会话记录引用的助手 id → 会话数(数据恢复页扫描用)。行内 assistant_id 恒非空
 *  (建会话必填),无需过滤;排序按会话数降序让"恢复哪个"的优先级一目了然。 */
export function countConversationsByAssistant(db: Database): { assistantId: string; count: number }[] {
  const rows = db.prepare(
    "SELECT assistant_id AS assistantId, COUNT(*) AS count FROM pc_conversation GROUP BY assistant_id ORDER BY count DESC",
  ).all() as Array<{ assistantId: string; count: number }>;
  return rows.map((row) => ({ assistantId: row.assistantId, count: row.count }));
}

export function conversationExistsInDb(db: Database, conversationId: string): boolean {
  return db.prepare("SELECT 1 FROM pc_conversation WHERE id = ? LIMIT 1").get(conversationId) !== null;
}
