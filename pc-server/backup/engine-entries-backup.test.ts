// backup/engine-entries-backup.test.ts — 引擎私有条目的备份面(P3.1):桌面端 dump 带两表与行,
// 给 APP 的 rikka_hub.db 没有表也没有 payload。走隔离数据目录直调导出(同 global-agents-roundtrip)。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-engine-entries-bak-"));

const jsonStore = await import("../persistence/json-store");
const { defaultState } = await import("../app-config/defaults");
const conversations = await import("../conversations");
const { appendEngineEntries, engineVisibleDigest, sealEngineEntries, writeEngineSessionHeader } = await import("../conversations/engine-entries");
const { createSettingsBackupZipToPath } = await import("./export");
const { readZipEntries } = await import("../files/index");
const { message } = await import("../foundation/utils");

import type { Conversation, State } from "../foundation/types";

const priorState = jsonStore.state;
jsonStore.setState(defaultState() as unknown as State);
const scratch = mkdtempSync(join(tmpdir(), "rkh-engine-entries-zip-"));
const CONVERSATION_ID = "engine-entries-backup-conv";
const PAYLOAD_MARKER = "engine-private-payload-marker";

afterAll(async () => {
  conversations.deletePcConversations([CONVERSATION_ID]);
  await jsonStore.flushSaveState().catch(() => {});
  jsonStore.setState(priorState);
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // best-effort:Windows 上 SQLite 只读句柄的文件锁释放可能滞后,临时目录留给系统清理
  }
});

function tableNames(db: Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
}

describe("引擎私有条目备份面", () => {
  test("桌面端 dump(format 3)带两表与原行;APP 端 rikka_hub.db 不含表也不含 payload", () => {
    conversations.openConversationsDb();
    const db = conversations.getConversationsDb()!;
    const user = message("USER", [{ type: "text", text: "问" }]);
    const ai = message("ASSISTANT", [{ type: "text", text: "答" }], "m");
    const conv: Conversation = {
      id: CONVERSATION_ID,
      assistantId: conversations.DEFAULT_ASSISTANT_ID,
      title: "备份面",
      systemPrompt: null,
      messages: [user, ai].map((m, i) => ({ id: `${CONVERSATION_ID}-n${i}`, messages: [m], selectIndex: 0 })),
      chatSuggestions: [],
      isPinned: false,
      createAt: 1000,
      updateAt: 2000,
    };
    conversations.persistConversation(conv);
    appendEngineEntries(db, CONVERSATION_ID, "pi", ai.id, [{ format: "pi-3", entryId: "e1", payload: { marker: PAYLOAD_MARKER } }]);
    sealEngineEntries(db, CONVERSATION_ID, "pi", ai.id, engineVisibleDigest([ai]));
    writeEngineSessionHeader(db, CONVERSATION_ID, "pi", { format: "pi-3", header: { marker: PAYLOAD_MARKER } });

    const zipPath = join(scratch, "backup.zip");
    createSettingsBackupZipToPath(zipPath);
    const entries = readZipEntries(readFileSync(zipPath));
    const extract = (name: string) => {
      const data = entries.find((entry) => entry.name === name)?.data;
      expect(data).toBeDefined();
      const path = join(scratch, name);
      writeFileSync(path, data!);
      return new Database(path, { readonly: true });
    };

    const dump = extract("pc_conversations.db");
    expect((dump.prepare("SELECT value FROM pc_dump_meta WHERE key = 'format'").get() as { value: string }).value).toBe("3");
    expect(dump.prepare("SELECT anchor_message_id, entry_id, payload, digest FROM pc_engine_entry WHERE conversation_id = ?").all(CONVERSATION_ID)).toEqual([
      { anchor_message_id: ai.id, entry_id: "e1", payload: JSON.stringify({ marker: PAYLOAD_MARKER }), digest: engineVisibleDigest([ai]) },
    ]);
    expect(dump.prepare("SELECT COUNT(*) AS n FROM pc_engine_session WHERE conversation_id = ?").get(CONVERSATION_ID)).toEqual({ n: 1 });
    dump.close();

    const app = extract("rikka_hub.db");
    expect(tableNames(app).filter((name) => name.startsWith("pc_"))).toEqual([]);
    const nodeJson = (app.prepare("SELECT messages FROM message_node").all() as { messages: string }[]).map((row) => row.messages).join("");
    expect(nodeJson).toContain("答");
    expect(nodeJson).not.toContain(PAYLOAD_MARKER);
    app.close();
  });

  test("resetConversationsDbTo:未给暂存行则保留现有条目(不被会话行 DELETE 级联清空);给了则替换", () => {
    const db = conversations.getConversationsDb()!;
    const all = conversations.loadAllConversationsFromDb(db);
    const rowsOf = () => db.prepare("SELECT entry_id, digest FROM pc_engine_entry WHERE conversation_id = ?").all(CONVERSATION_ID);
    const before = rowsOf();
    expect(before).toHaveLength(1);
    conversations.resetConversationsDbTo(all);
    expect(rowsOf()).toEqual(before);
    conversations.resetConversationsDbTo(all, undefined, { sessions: [], entries: [] });
    expect(rowsOf()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pc_engine_session WHERE conversation_id = ?").get(CONVERSATION_ID)).toEqual({ n: 0 });
  });
});
