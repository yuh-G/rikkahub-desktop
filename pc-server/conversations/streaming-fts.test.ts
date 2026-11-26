// 专题2 H-c 回归测试:流式脏 flush 不建 FTS,流结束 persist 对账补建。
// 契约:
// - upsertMessageNodeInto(..., syncFts=false) 写节点行,并删掉这个节点已有的索引行(PF.2:
//   否则最后一次 flush 已写入最终内容时,对账因内容相同跳过,索引停在旧版本),不新建索引;
// - 默认(syncFts 省略/true)行为与历史一致:删旧 FTS 行 + 插新行;
// - 模拟完整流式生命周期:N 次 flush 后,一次带 FTS 的 upsert(对应流结束
//   persistConversation 对账时的补建)让索引恰好收敛到最终文本,无中间态残留。
// 对账本身的流式用例在 persist-reconcile.test.ts。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { ensureConversationTables, migrateConversationsIntoDb, upsertMessageNodeInto } from "./index";
import { ensureMessageFtsTable, replaceNodeFts, searchMessageFts } from "./fts";
import { message } from "../foundation/utils";
import type { Conversation, MessageNode } from "../foundation/types";

function realSchemaDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensureConversationTables(db);
  ensureMessageFtsTable(db);
  return db;
}

function node(idValue: string, text: string): MessageNode {
  return { id: idValue, messages: [message("ASSISTANT", [{ type: "text", text }])], selectIndex: 0 };
}

function conv(idValue: string, nodes: MessageNode[]): Conversation {
  return {
    id: idValue,
    assistantId: "a1",
    title: "会话",
    systemPrompt: null,
    messages: nodes,
    chatSuggestions: [],
    isPinned: false,
    createAt: 1000,
    updateAt: 2000,
  };
}

function ftsTexts(db: Database, nodeId: string): string[] {
  return (db.prepare("SELECT text FROM pc_message_fts WHERE node_id = ?").all(nodeId) as { text: string }[]).map((r) => r.text);
}

describe("H-c: 流式 flush 跳过 FTS", () => {
  test("syncFts=false 写节点行、删掉这个节点的旧索引行,不建新索引,别的节点不动", () => {
    const db = realSchemaDb();
    migrateConversationsIntoDb(db, [conv("c1", [node("n1", "初始"), node("n2", "旁边的节点")])]);
    expect(ftsTexts(db, "n1")).toEqual(["初始"]);

    upsertMessageNodeInto(db, "c1", node("n1", "初始加了新内容"), 0, false);
    // 节点行已更新
    const row = db.prepare("SELECT messages FROM pc_message_node WHERE id = ?").get("n1") as { messages: string };
    expect(row.messages).toContain("初始加了新内容");
    expect(ftsTexts(db, "n1")).toEqual([]);
    expect(ftsTexts(db, "n2")).toEqual(["旁边的节点"]);
  });

  test("默认 syncFts 行为不变:删旧行插新行", () => {
    const db = realSchemaDb();
    migrateConversationsIntoDb(db, [conv("c1", [node("n1", "旧")])]);
    upsertMessageNodeInto(db, "c1", node("n1", "新文本"), 0);
    expect(ftsTexts(db, "n1")).toEqual(["新文本"]);
  });

  test("完整流式生命周期:多次跳过 FTS 的 flush → 流结束 reconcile 收敛,无中间态残留", () => {
    const db = realSchemaDb();
    migrateConversationsIntoDb(db, [conv("c1", [node("n0", "用户提问")])]);

    // 流式:节点 n1 逐帧增长,每次 flush 跳过 FTS(生产路径 flushConvDirty → syncFts=false)
    const growing = node("n1", "");
    for (const text of ["答", "答案是", "答案是四十二"]) {
      growing.messages[0].parts = [{ type: "text", text }];
      upsertMessageNodeInto(db, "c1", growing, 1, false);
      expect(ftsTexts(db, "n1")).toEqual([]); // 流式期间索引静默
    }

    // 流结束:persistConversation 内部对每个节点 replaceNodeFts(此处直接调同一原语)
    replaceNodeFts(db, "c1", growing);
    expect(ftsTexts(db, "n1")).toEqual(["答案是四十二"]);
    // 搜索命中最终文本,且中间态("答案是"前缀行)没有残留重复行
    const hits = searchMessageFts(db, "四十二");
    expect(hits.length).toBe(1);
    expect(hits[0]!.nodeId).toBe("n1");
  });
});
