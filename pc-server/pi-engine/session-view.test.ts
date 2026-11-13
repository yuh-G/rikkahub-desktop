// pi-engine/session-view.test.ts — 会话视图 → pi 会话(P3.3)与写路径对账(P3.4)的行为锁
//
// 断言面:manager.getEntries()(装载后的条目与父链)与 buildSessionContext().messages(pi 将看到什么)。
// 原生组原样取用(签名、工具结果 details、自定义条目);每轮重建的条目剔除;失配整组回退;
// 回退条目 id 确定性;pi 会话 id = 应用会话 id。
import { describe, expect, test } from "bun:test";

import type { EngineEntry, EngineEntryInput, EngineSessionItem, EngineSessionView, PromptInput } from "../engines/contract";
import type { JsonValue, Message, ToolPart } from "../foundation/types";
import { message } from "../foundation/utils";
import { PI_ENTRY_FORMAT, createPiEntrySync, createPiSessionFromView } from "./session-view";

const CONVERSATION_ID = "0b7a9f3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const usage = { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistantRow(): Message {
  const tool: ToolPart = {
    type: "tool",
    toolCallId: "tc-1",
    toolName: "lookup",
    input: JSON.stringify({ q: "天气" }),
    output: [{ type: "text", text: "中立结果" }],
    approvalState: { type: "auto" },
  } as ToolPart;
  return message("ASSISTANT", [{ type: "reasoning", reasoning: "想一想" }, tool, { type: "text", text: "今天晴" }], "claude-x");
}

function assistantEntry(id: string, content: JsonValue[], stopReason: string): JsonValue {
  return {
    type: "message",
    id,
    parentId: "stale-parent",
    timestamp: "2026-11-12T00:00:00.000Z",
    message: { role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "claude-x", usage, stopReason, timestamp: 1 },
  };
}

/** 一次生成落下的 pi 条目:含每轮重建的(用户、system、模型/档位)与要原样取用的(助手、工具结果、自定义)。 */
function nativeGroup(): EngineEntry[] {
  const payloads: JsonValue[] = [
    { type: "model_change", id: "mc", parentId: null, timestamp: "t", provider: "anthropic", modelId: "claude-x" },
    { type: "message", id: "sys", parentId: "mc", timestamp: "t", message: { role: "system", content: "", timestamp: 1 } },
    { type: "message", id: "usr", parentId: "sys", timestamp: "t", message: { role: "user", content: [{ type: "text", text: "原生用户" }], timestamp: 1 } },
    assistantEntry(
      "n1",
      [
        { type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "enc-1", redacted: true },
        { type: "thinking", thinking: "想一想", thinkingSignature: "sig-1" },
        { type: "toolCall", id: "tc-1", name: "lookup", arguments: { q: "天气" } },
      ],
      "toolUse",
    ),
    {
      type: "message",
      id: "n2",
      parentId: "n1",
      timestamp: "t",
      message: { role: "toolResult", toolCallId: "tc-1", toolName: "lookup", content: [{ type: "text", text: "原生结果" }], details: { plugin: 1 }, isError: false, timestamp: 1 },
    },
    { type: "custom", id: "n3", parentId: "n2", timestamp: "t", customType: "my-ext", data: { k: 1 } },
    assistantEntry("n4", [{ type: "text", text: "今天晴" }], "stop"),
  ];
  return payloads.map((payload, seq) => ({ seq, format: PI_ENTRY_FORMAT, entryId: (payload as { id: string }).id, payload }));
}

function userItem(text: string): EngineSessionItem {
  const input: PromptInput = { text, images: [] };
  return { message: message("USER", [{ type: "text", text }]), synthetic: false, input };
}

function load(items: EngineSessionItem[], extra: Partial<EngineSessionView> = {}, conversationId = CONVERSATION_ID) {
  const result = createPiSessionFromView({ cwd: process.cwd(), conversationId, view: { items, compactions: [], ...extra }, fallbackModelId: "m" });
  return { ...result, entries: result.manager.getEntries(), messages: result.manager.buildSessionContext().messages };
}

describe("createPiSessionFromView", () => {
  test("有效原生组原样取用,每轮重建的条目剔除,父链按视图顺序重连;会话 id = 应用会话 id", () => {
    const user = userItem("查天气");
    const ai = assistantRow();
    const { entries, messages, entryIdsByMessageId, degradedMessageIds, manager } = load([user, { message: ai, synthetic: false, native: nativeGroup() }]);

    expect(entries.map((entry) => entry.id)).toEqual([`${user.message.id}:0`, "n1", "n2", "n3", "n4"]);
    expect(entries.map((entry) => entry.parentId)).toEqual([null, `${user.message.id}:0`, "n1", "n2", "n3"]);
    expect(entryIdsByMessageId.get(ai.id)).toEqual(["n1", "n2", "n3", "n4"]);
    expect(degradedMessageIds).toEqual([]);
    expect(manager.getSessionId()).toBe(CONVERSATION_ID);
    expect(manager.getHeader()?.id).toBe(CONVERSATION_ID);

    // 原样:redacted 与普通思考的签名都在,工具结果取原生内容与 details(不由中立输出重编码)。
    const flat = JSON.stringify(messages);
    expect(flat).toContain("enc-1");
    expect(flat).toContain("sig-1");
    expect(flat).toContain("原生结果");
    expect(flat).not.toContain("中立结果");
    expect(flat).not.toContain("原生用户");
    expect(messages.find((item) => item.role === "toolResult")).toMatchObject({ details: { plugin: 1 } });
    expect(messages.some((item) => item.role === "system")).toBe(false);
  });

  test("整组回退:格式不识别 / 组里没有助手消息 / 原生文本与这一行不一致 / 合成行", () => {
    const variants: Array<(group: EngineEntry[]) => EngineEntry[]> = [
      (group) => group.map((entry) => ({ ...entry, format: "pi-session-v999" })),
      (group) => group.filter((entry) => !["n1", "n4"].includes(String(entry.entryId))),
      (group) => group,
    ];
    variants.forEach((variant, index) => {
      const ai = assistantRow();
      // 第三种:应用收尾改写了正文(输出变换),模型应看到改写后的内容。
      if (index === 2) ai.parts = ai.parts.map((part) => (part.type === "text" ? { ...part, text: "今天晴(已改写)" } : part));
      const { entries, messages, degradedMessageIds } = load([{ message: ai, synthetic: false, native: variant(nativeGroup()) }]);
      expect(entries.every((entry) => entry.id.startsWith(`${ai.id}:`))).toBe(true);
      expect(JSON.stringify(messages)).toContain("中立结果");
      expect(JSON.stringify(messages)).not.toContain("sig-1");
      expect(degradedMessageIds).toEqual([ai.id]);
    });

    const synthetic = assistantRow();
    const { entries, degradedMessageIds } = load([{ message: synthetic, synthetic: true, native: nativeGroup() }]);
    expect(entries.every((entry) => entry.id.startsWith(`${synthetic.id}:`))).toBe(true);
    expect(degradedMessageIds).toEqual([]);
  });

  test("回退编码确定性:两次装载的条目 id 与上下文逐字节一致", () => {
    const items = [userItem("第一问"), { message: assistantRow(), synthetic: false }, userItem("第二问")];
    const first = load(items);
    const second = load(items);
    expect(second.entries.map((entry) => entry.id)).toEqual(first.entries.map((entry) => entry.id));
    expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages));
  });

  test("压缩重放与原生组共存:切点前的原生内容被摘要取代", () => {
    const user1 = userItem("旧问");
    const ai1 = { message: assistantRow(), synthetic: false, native: nativeGroup() };
    const user2 = userItem("新问");
    const ai2 = message("ASSISTANT", [{ type: "text", text: "新答" }]);
    const { messages } = load([user1, ai1, user2, { message: ai2, synthetic: false }], {
      compactions: [{ cutMessageId: user2.message.id, summary: "旧史摘要", tokensBefore: 10 }],
    });
    const flat = JSON.stringify(messages);
    expect(flat).toContain("旧史摘要");
    expect(flat).not.toContain("原生结果");
    expect(flat).toContain("新问");
    expect(flat).toContain("新答");
  });

  test("应用会话 id 不合 pi 的 id 规则:退回随机 id,装载照常", () => {
    const { manager, entries } = load([userItem("你好")], {}, "bad id!");
    expect(manager.getSessionId()).not.toBe("bad id!");
    expect(manager.getSessionId()).toMatch(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
    expect(entries.length).toBe(1);
  });
});

describe("压缩:原生条目与会话级记录配对(P3.5)", () => {
  const nativeCompaction = (summary: string, tokensBefore: number): EngineEntry => ({
    seq: 99,
    format: PI_ENTRY_FORMAT,
    entryId: "cmp-native",
    payload: {
      type: "compaction",
      id: "cmp-native",
      parentId: "n4",
      timestamp: "2026-11-12T00:00:01.000Z",
      summary,
      firstKeptEntryId: "stale-first-kept",
      tokensBefore,
      details: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] },
    },
  });

  function compactedView(record: { summary: string; tokensBefore: number }, native: EngineEntry) {
    const user1 = userItem("旧问");
    const ai1 = { message: assistantRow(), synthetic: false, native: [...nativeGroup(), native] };
    const user2 = userItem("新问");
    return { user2, ...load([user1, ai1, user2], { compactions: [{ cutMessageId: user2.message.id, ...record }] }) };
  }

  test("配得上生效记录:原样取用(id / details / 时间戳在),接在序列末尾,firstKept 按记录重定", () => {
    const { user2, entries, messages } = compactedView({ summary: "旧史摘要", tokensBefore: 10 }, nativeCompaction("旧史摘要", 10));
    const compactions = entries.filter((entry) => entry.type === "compaction");
    expect(compactions.length).toBe(1);
    expect(entries.at(-1)).toMatchObject({
      type: "compaction",
      id: "cmp-native",
      parentId: `${user2.message.id}:0`,
      timestamp: "2026-11-12T00:00:01.000Z",
      firstKeptEntryId: `${user2.message.id}:0`,
      details: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] },
    });
    const flat = JSON.stringify(messages);
    expect(flat).toContain("旧史摘要");
    expect(flat).not.toContain("原生结果");
    expect(flat).toContain("新问");
  });

  test("配不上(摘要或用量不同):由记录重建,原生条目不进序列", () => {
    for (const native of [nativeCompaction("另一份摘要", 10), nativeCompaction("旧史摘要", 11)]) {
      const { user2, entries, messages } = compactedView({ summary: "旧史摘要", tokensBefore: 10 }, native);
      const compactions = entries.filter((entry) => entry.type === "compaction");
      expect(compactions.length).toBe(1);
      expect(compactions[0]).toMatchObject({ summary: "旧史摘要", tokensBefore: 10, firstKeptEntryId: `${user2.message.id}:0` });
      expect(compactions[0]!.id).not.toBe("cmp-native");
      expect(JSON.stringify(messages)).not.toContain("另一份摘要");
    }
  });

  test("没有生效记录(切点不在场):原生压缩条目不取用,不压缩", () => {
    const { entries, messages } = load([userItem("旧问"), { message: assistantRow(), synthetic: false, native: [...nativeGroup(), nativeCompaction("旧史摘要", 10)] }]);
    expect(entries.some((entry) => entry.type === "compaction")).toBe(false);
    expect(JSON.stringify(messages)).toContain("原生结果");
  });
});

describe("createPiEntrySync(写路径,P3.4)", () => {
  test("只交出装载之后的新条目;每轮重建的不写;重复对账不重发", async () => {
    const { manager } = load([userItem("旧问"), { message: assistantRow(), synthetic: false }]);
    const sent: EngineEntryInput[][] = [];
    const sync = createPiEntrySync(manager, async (entries) => void sent.push(entries), () => undefined);
    await sync.flush();
    expect(sent).toEqual([]);

    manager.appendModelChange("anthropic", "claude-x");
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "新问" }], timestamp: 1 });
    const answerId = manager.appendMessage({
      role: "assistant",
      content: [{ type: "thinking", thinking: "想", thinkingSignature: "sig-new" }, { type: "text", text: "新答" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-x",
      usage,
      stopReason: "stop",
      timestamp: 2,
    });
    const customId = manager.appendCustomEntry("my-ext", { k: 2 });
    await sync.flush();
    await sync.flush();

    expect(sent.length).toBe(1);
    expect(sent[0]!.map((entry) => entry.entryId)).toEqual([answerId, customId]);
    expect(sent[0]!.every((entry) => entry.format === PI_ENTRY_FORMAT)).toBe(true);
    // 载荷就是 pi 条目本身:下一轮装载原样取用(签名在)。
    expect(sent[0]![0]!.payload).toEqual(manager.getEntry(answerId) as unknown as JsonValue);
  });

  test("压缩条目要写,去掉系统提示词快照,其余原样", async () => {
    const { manager, entries } = load([userItem("旧问"), { message: assistantRow(), synthetic: false }]);
    // 模拟会话里有 system 消息时的压缩:appendCompaction 会把它快照进 systemMessage。
    manager.appendMessage({ role: "system", content: "系统提示词", timestamp: 1 } as never);
    const sent: EngineEntryInput[] = [];
    const sync = createPiEntrySync(manager, async (batch) => void sent.push(...batch), () => undefined);
    const compactionId = manager.appendCompaction("摘要", entries[0]!.id, 42, { readFiles: ["a.ts"], modifiedFiles: [] });
    expect(manager.getEntry(compactionId)).toHaveProperty("systemMessage");
    await sync.flush();

    expect(sent.map((entry) => entry.entryId)).toEqual([compactionId]);
    const payload = sent[0]!.payload as Record<string, JsonValue>;
    expect(payload).not.toHaveProperty("systemMessage");
    expect(payload).toMatchObject({ type: "compaction", summary: "摘要", tokensBefore: 42, details: { readFiles: ["a.ts"], modifiedFiles: [] } });
  });

  test("送达失败只报一次,flush 不拒绝", async () => {
    const { manager } = load([]);
    const errors: unknown[] = [];
    const sync = createPiEntrySync(manager, async () => {
      throw new Error("会话已不接收");
    }, (error) => errors.push(error));
    manager.appendCustomEntry("a", 1);
    await sync.flush();
    manager.appendCustomEntry("b", 2);
    await sync.flush();
    expect(errors.length).toBe(1);
  });
});
