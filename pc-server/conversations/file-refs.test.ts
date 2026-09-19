// B1 回归:collectConversationReferencedFileIds 把附件引用收集下推到 SQLite 层,
// 与原「JS 全量读 messages 再正则」口径一致(同一捕获组正则)。用真实建表 + 真实数据
// 验证等价性,防 SQL 拼写/正则漂移漏收引用 → 误删被引用附件。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { collectConversationReferencedFileIds, ensureConversationTables } from "./index";
import { collectPcFileRefs } from "../backup/file-refs";

function seedDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  ensureConversationTables(db);
  const insertNode = db.prepare(
    "INSERT INTO pc_message_node (id, conversation_id, node_index, messages, select_index) VALUES (?, ?, ?, ?, ?)",
  );
  db.prepare("INSERT INTO pc_conversation (id, assistant_id, title, system_prompt, suggestions, is_pinned, create_at, update_at, mode_injection_ids, lorebook_ids) VALUES ('c1','a','t','','[]',0,1,1,'[]','[]')").run();
  // 含两种引用形态 + 无关文本 + 跨多节点重复引用
  insertNode.run("n1", "c1", 0, JSON.stringify([{ type: "image", url: "/api/files/12/content" }]), 0);
  insertNode.run("n2", "c1", 1, JSON.stringify([{ type: "text", text: "见 /api/files/34/content 与 /api/files/12/content" }]), 0);
  insertNode.run("n3", "c1", 2, JSON.stringify([{ type: "text", text: "没有任何引用" }]), 0);
  return db;
}

describe("collectConversationReferencedFileIds(B1 SQL 侧引用收集)", () => {
  test("与 JS 全量正则口径一致:同一批节点产出同一 id 集合", () => {
    const db = seedDb();
    const viaSql = new Set<number>();
    collectConversationReferencedFileIds(db, viaSql);

    // 对照组:旧口径——逐行读 messages 进 JS 再正则
    const viaJs = new Set<number>();
    for (const row of db.prepare("SELECT messages FROM pc_message_node").all() as { messages: string }[]) {
      collectPcFileRefs(row.messages, viaJs);
    }

    expect(viaSql).toEqual(viaJs);
    expect([...viaSql].sort((a, b) => a - b)).toEqual([12, 34]);
    db.close();
  });

  test("空库 / 无引用时不报错、产出空集", () => {
    const db = new Database(":memory:");
    ensureConversationTables(db);
    const ids = new Set<number>();
    collectConversationReferencedFileIds(db, ids);
    expect(ids.size).toBe(0);
    db.close();
  });
});
