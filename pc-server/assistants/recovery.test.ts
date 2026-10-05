// assistants/recovery.test.ts — 孤儿助手恢复的行为锁(对齐 APP b9c0d3b7)
// 钉住的语义:扫描=「会话引用但设置缺失」的助手 id 集合(会话数降序);
// 恢复=为缺失 id 建占位助手(defaultAssistant 形态,id 保真让会话重新可见),
// 幂等(恢复后再扫为空)、与助手选中态无关(不抢 assistantId)、活库不可用时安全空转。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-asst-recovery-"));

// json-store 的 state 是 export let(live binding),解构会在 undefined 期固化——
// 经命名空间对象逐点取值。
const jsonStore = await import("../persistence/json-store");
const { setState, flushSaveState } = jsonStore;
const { defaultState } = await import("../app-config/defaults");
const { openConversationsDb, ensureConversationTables, getConversationsDb } = await import("../conversations");
const { recoverMissingAssistants, scanMissingAssistants } = await import("./recovery");
const { defaultAssistant } = await import("./index");

import type { State } from "../foundation/types";

const priorState = jsonStore.state;

function seedState(assistantIds: string[]): void {
  const base = defaultState();
  const assistants = assistantIds.map((id) => ({ ...defaultAssistant(), id, name: `助手 ${id}` }));
  setState({
    ...base,
    settings: { ...base.settings, assistants, assistantId: assistantIds[0] ?? "" },
  } as unknown as State);
  openConversationsDb();
  const db = getConversationsDb()!;
  ensureConversationTables(db);
  db.exec("DELETE FROM pc_conversation");
}

afterAll(async () => {
  await flushSaveState();
  setState(priorState);
});

describe("scanMissingAssistants", () => {
  test("会话引用了已删助手 → 扫出缺失项,按会话数降序", () => {
    seedState(["alive-1"]);
    const db = getConversationsDb()!;
    const ins = db.prepare(
      "INSERT INTO pc_conversation (id, assistant_id, title, system_prompt, suggestions, is_pinned, create_at, update_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    ins.run("c1", "dead-2", "孤儿A", "", "[]", 0, 1000, 1000);
    ins.run("c2", "dead-2", "孤儿B", "", "[]", 0, 2000, 2000);
    ins.run("c3", "dead-1", "孤儿C", "", "[]", 0, 3000, 3000);
    ins.run("c4", "alive-1", "正常", "", "[]", 0, 4000, 4000);

    const missing = scanMissingAssistants();
    expect(missing).toEqual([
      { assistantId: "dead-2", conversationCount: 2 },
      { assistantId: "dead-1", conversationCount: 1 },
    ]);
  });

  test("全部会话都有在册助手 → 空", () => {
    seedState(["alive-1"]);
    const db = getConversationsDb()!;
    db.exec("DELETE FROM pc_conversation");
    db.prepare(
      "INSERT INTO pc_conversation (id, assistant_id, title, system_prompt, suggestions, is_pinned, create_at, update_at) VALUES ('c1', 'alive-1', '', '', '[]', 0, 1, 1)",
    ).run();
    expect(scanMissingAssistants()).toEqual([]);
  });
});

describe("recoverMissingAssistants", () => {
  test("为全部缺失助手建占位助手:id 保真、名字编号、不改当前选中;幂等", () => {
    seedState(["alive-1"]);
    const db = getConversationsDb()!;
    const ins = db.prepare(
      "INSERT INTO pc_conversation (id, assistant_id, title, system_prompt, suggestions, is_pinned, create_at, update_at) VALUES (?, ?, '', '', '[]', 0, ?, ?)",
    );
    ins.run("c1", "dead-2", 100, 100);
    ins.run("c2", "dead-2", 150, 150);
    ins.run("c3", "dead-1", 200, 200);

    const recovered = recoverMissingAssistants();
    expect(recovered).toBe(2);
    const ids = jsonStore.state.settings.assistants.map((a) => a.id);
    expect(ids).toContain("dead-1");
    expect(ids).toContain("dead-2");
    // 不抢当前选中:恢复只为让会话可见
    expect(jsonStore.state.settings.assistantId).toBe("alive-1");
    // 名字可读可改,形态走 defaultAssistant(无发明字段);会话数多的先编号
    const placeholder = jsonStore.state.settings.assistants.find((a) => a.id === "dead-2")!;
    expect(placeholder.name).toBe("恢复的助手 1");
    expect(placeholder.messageTemplate).toBe("{{ message }}");

    // 幂等:再扫再恢复都是零
    expect(scanMissingAssistants()).toEqual([]);
    expect(recoverMissingAssistants()).toBe(0);
  });
});
