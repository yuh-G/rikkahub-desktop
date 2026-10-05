// memory/copy-memories.test.ts — copyAssistantMemories 行为锁(复制助手时的「同时复制记忆」)。
// 纪律:逐条分配新 id、内容保留(对齐 APP copyMemories)——副本与源各自演化,互不影响。
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-memcopy-test-"));

const { setState, state } = await import("../persistence/json-store");
// addMemory 建新组时反查 state.settings.assistants 取助手名;测试环境没有完整启动
// 流程,喂最小 State(state 是 live binding 的命名导出,须经 setState 写)。
setState({ ...state, settings: { assistants: [] } } as unknown as typeof state);

const { memoryStore } = await import("./index");

describe("copyAssistantMemories(复制助手记忆)", () => {
  test("逐条复制、分配新 id、内容保留;源与副本互不影响", () => {
    memoryStore.clearAll();
    memoryStore.addMemory({ scope: "assistant", assistantId: "a1", content: "喜欢简洁回复", source: "ai" }, false);
    memoryStore.addMemory({ scope: "assistant", assistantId: "a1", content: "常用 Python", source: "manual" }, false);

    const copied = memoryStore.copyAssistantMemories("a1", "a2", false);
    expect(copied).toBe(2);
    const source = memoryStore.getAssistantMemories("a1");
    const target = memoryStore.getAssistantMemories("a2");
    expect(target.map((m) => m.content)).toEqual(source.map((m) => m.content));
    // 新 id:副本 id 与源 id 无一重合(删源不连带删副本)。
    expect(target.map((m) => m.id).some((id) => source.some((m) => m.id === id))).toBe(false);
    // 源保留(复制非移动)。
    expect(memoryStore.getAssistantMemories("a1")).toHaveLength(2);
  });

  test("源无记忆时是 no-op,返回 0,不建空组", () => {
    const count = memoryStore.copyAssistantMemories("no-such-assistant", "a3", false);
    expect(count).toBe(0);
    expect(memoryStore.getAssistantMemories("a3")).toEqual([]);
  });
});
