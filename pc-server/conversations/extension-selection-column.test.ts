// conversations/extension-selection-column.test.ts — 会话层拓展选择列(P6a.4)的落库往返:写进 upsert、
// 两条读路径(全量加载、元数据查询)读回同一份;没固定过的会话列为 NULL、读回 null。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { ensureConversationTables, loadConversationMetasFromDb, upsertConversationRowInto } from "./index";
import { getConversationMeta } from "./read-queries";
import type { Conversation } from "../foundation/types";

function conv(idValue: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id: idValue,
    assistantId: "a1",
    title: "会话",
    systemPrompt: null,
    messages: [],
    chatSuggestions: [],
    isPinned: false,
    createAt: 1000,
    updateAt: 2000,
    ...extra,
  };
}

describe("extension_selection 列", () => {
  test("固定过的选择往返不变,没固定过的读回 null", () => {
    const db = new Database(":memory:");
    ensureConversationTables(db);
    const extensionSelection = {
      mcpServers: ["s1"],
      mcpToolOverrides: { s1: { a: { enable: false } } },
      enabledSkills: [],
      enginePluginIds: ["p1"],
      quickMessageIds: ["q1"],
    };
    upsertConversationRowInto(db, conv("pinned", { extensionSelection, modeInjectionIds: [], lorebookIds: ["l1"] }));
    upsertConversationRowInto(db, conv("fresh"));

    const loaded = Object.fromEntries(loadConversationMetasFromDb(db).map((item) => [item.id, item]));
    expect(loaded.pinned!.extensionSelection).toEqual(extensionSelection);
    expect(loaded.pinned!.lorebookIds).toEqual(["l1"]);
    expect(loaded.fresh!.extensionSelection).toBeNull();
    expect(getConversationMeta(db, "pinned")?.extensionSelection).toEqual(extensionSelection);
    expect(getConversationMeta(db, "fresh")?.extensionSelection).toBeNull();
  });

  test("列里是坏 JSON 时按没固定过处理", () => {
    const db = new Database(":memory:");
    ensureConversationTables(db);
    upsertConversationRowInto(db, conv("broken"));
    db.prepare("UPDATE pc_conversation SET extension_selection = ? WHERE id = ?").run("{oops", "broken");
    expect(getConversationMeta(db, "broken")?.extensionSelection).toBeNull();
  });
});
