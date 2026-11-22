// backup/notice-roundtrip.test.ts — APP 备份里的 notice 片段:导入后原样在、不进全文索引,导出给 APP 时原样带回(PA.2)
//
// 照 APP 3.1.2 的落库形态造一份 rikka_hub.db:一条只有 notice 的用户消息(空闲时收到通知开的那一轮)和一条中途带 notice
// 的助手消息。走隔离数据目录直调导入与导出(同 engine-entries-backup)。导出走上次导入留下的缓存库作基底,与真实往返同路。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-notice-roundtrip-"));

const jsonStore = await import("../persistence/json-store");
const { defaultState } = await import("../app-config/defaults");
const conversations = await import("../conversations");
const { searchMessageFts } = await import("../conversations/fts");
const { applyAndroidZipBackupFromPath } = await import("./import");
const { createSettingsBackupZipToPath } = await import("./export");
const { readZipEntries } = await import("../files/index");
const { buildZip } = await import("../test-utils/build-zip");
const schema = (await import("./android-schema-v24.json")).default as {
  database: { entities: Array<{ tableName: string; createSql: string }> };
};

import type { State } from "../foundation/types";

const priorState = jsonStore.state;
jsonStore.setState(defaultState() as unknown as State);
const scratch = mkdtempSync(join(tmpdir(), "rkh-notice-roundtrip-zip-"));
const CONVERSATION_ID = "5b0c6c2e-1f7a-4d0e-9a51-3c2f8e7d6a10";

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

const SHELL_NOTICE = {
  type: "notice",
  title: "后台命令已退出,退出码为 0:bun test",
  text: "<background_shell_notice>\nBackground command `bg-1` exited with code 0 after 12s: `bun test`\n(It produced no output.)\n</background_shell_notice>",
};
const MID_TURN_NOTICE = { type: "notice", title: "后台命令已被你停止:sleep 99", text: "<background_shell_notice>stopped</background_shell_notice>" };

const appMessages = [
  { id: "aaaaaaaa-0000-4000-8000-000000000001", role: "user", parts: [{ type: "text", text: "跑一下测试" }], createdAt: "2026-11-20T10:00:00" },
  {
    id: "aaaaaaaa-0000-4000-8000-000000000002",
    role: "assistant",
    parts: [{ type: "text", text: "在后台跑了" }, MID_TURN_NOTICE, { type: "text", text: "停掉了" }],
    createdAt: "2026-11-20T10:00:01",
  },
  { id: "aaaaaaaa-0000-4000-8000-000000000003", role: "user", parts: [SHELL_NOTICE], createdAt: "2026-11-20T10:00:13" },
  { id: "aaaaaaaa-0000-4000-8000-000000000004", role: "assistant", parts: [{ type: "text", text: "测试通过" }], createdAt: "2026-11-20T10:00:14" },
];

function appBackupZip(): string {
  const dbPath = join(scratch, "app-rikka_hub.db");
  const db = new Database(dbPath);
  for (const entity of schema.database.entities.filter((item) => item.tableName === "ConversationEntity" || item.tableName === "message_node")) {
    db.exec(entity.createSql.replaceAll("${TABLE_NAME}", entity.tableName));
  }
  db.prepare("INSERT INTO ConversationEntity (id, title, nodes, create_at, update_at) VALUES (?, ?, '[]', ?, ?)").run(CONVERSATION_ID, "后台命令", 1000, 2000);
  const insertNode = db.prepare("INSERT INTO message_node (id, conversation_id, node_index, messages, select_index) VALUES (?, ?, ?, ?, 0)");
  appMessages.forEach((item, index) => insertNode.run(`bbbbbbbb-0000-4000-8000-00000000000${index}`, CONVERSATION_ID, index, JSON.stringify([item])));
  const bytes = db.serialize();
  db.close();
  const zipPath = join(scratch, "backup_app.zip");
  writeFileSync(zipPath, buildZip([{ name: "rikka_hub.db", data: Buffer.from(bytes) }]));
  return zipPath;
}

describe("notice 片段的备份往返", () => {
  test("APP 导入:片段原样在、不进全文索引;导出给 APP:原样带回,不降级", () => {
    conversations.openConversationsDb();
    const result = applyAndroidZipBackupFromPath(appBackupZip());
    expect(result.dbReadError).toBeNull();
    expect(result.conversationsImported).toBe(1);

    const db = conversations.getConversationsDb()!;
    const parts = conversations.loadConversationNodesFromDb(db, CONVERSATION_ID).map((node) => node.messages[0]!.parts as unknown[]);
    expect(parts[1]).toEqual([{ type: "text", text: "在后台跑了" }, MID_TURN_NOTICE, { type: "text", text: "停掉了" }]);
    expect(parts[2]).toEqual([SHELL_NOTICE]);
    expect(searchMessageFts(db, "停掉了").length).toBe(1);
    expect(searchMessageFts(db, "background_shell_notice")).toEqual([]);
    expect(searchMessageFts(db, "后台命令已退出")).toEqual([]);

    const zipPath = join(scratch, "export.zip");
    createSettingsBackupZipToPath(zipPath);
    const entry = readZipEntries(readFileSync(zipPath)).find((item) => item.name === "rikka_hub.db");
    expect(entry).toBeDefined();
    const exportedPath = join(scratch, "exported-rikka_hub.db");
    writeFileSync(exportedPath, entry!.data);
    const exported = new Database(exportedPath, { readonly: true });
    const rows = exported.prepare("SELECT messages FROM message_node WHERE conversation_id = ? ORDER BY node_index").all(CONVERSATION_ID) as { messages: string }[];
    exported.close();
    const exportedParts = rows.map((row) => (JSON.parse(row.messages) as Array<{ parts: unknown[] }>)[0]!.parts);
    expect(exportedParts[1]).toEqual([{ type: "text", text: "在后台跑了" }, MID_TURN_NOTICE, { type: "text", text: "停掉了" }]);
    expect(exportedParts[2]).toEqual([SHELL_NOTICE]);
    expect(JSON.stringify(exportedParts)).not.toContain("暂不支持在 APP端显示");
  });
});
