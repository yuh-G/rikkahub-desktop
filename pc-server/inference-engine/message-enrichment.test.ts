// inference-engine/message-enrichment.test.ts — 引擎无关富化层契约测试
//
// 锁定四件套的共享裁决:模板渲染一次到位、时间提醒间隔语义、lorebook/模式注入
// 按位置分流(系统位文本 vs 聊天位插队)、窗口化(滞回截断 ∨ 压缩切点锚,P9)。
// 聊天引擎与 pi 引擎共用此层,行为必须逐字一致。

import { describe, expect, test, beforeAll } from "bun:test";
import type { Assistant, Conversation, Message, State } from "../foundation/types";
import { message } from "../foundation/utils";
import { setState } from "../persistence/json-store";
import { enrichMessages, encodableMessages, truncationStartFor, alignContextStart } from "./message-enrichment";

beforeAll(() => {
  setState({
    settings: {
      displaySetting: { userNickname: "Test User" },
      lorebooks: [
        {
          id: "book-1",
          enabled: true,
          entries: [
            { id: "entry-top", enabled: true, constantActive: true, position: "top_of_chat", role: "USER", content: "TOP_INJECTION_TEXT" },
            { id: "entry-bottom", enabled: true, constantActive: true, position: "bottom_of_chat", role: "USER", content: "BOTTOM_INJECTION_TEXT" },
          ],
        },
      ],
      modeInjections: [],
      chatModelId: "m1",
    },
  } as unknown as State);
});

function assistant(overrides: Partial<Assistant> = {}): Assistant {
  return {
    id: "a1",
    chatModelId: null,
    name: "Test Assistant",
    avatar: { type: "dummy" },
    useAssistantAvatar: false,
    tags: [],
    systemPrompt: "You are helpful.",
    temperature: null,
    topP: null,
    contextMessageLimit: 0,
    streamOutput: true,
    enableMemory: false,
    useGlobalMemory: false,
    enableRecentChatsReference: false,
    messageTemplate: "{{ message }}",
    presetMessages: [],
    quickMessageIds: [],
    regexes: [],
    reasoningLevel: "AUTO",
    maxTokens: null,
    customHeaders: [],
    customBodies: [],
    mcpServers: [],
    mcpToolOverrides: {},
    localTools: [],
    background: null,
    backgroundOpacity: 1,
    modeInjectionIds: [],
    lorebookIds: [],
    enabledSkills: [],
    enableTimeReminder: false,
    allowConversationSystemPrompt: false,
    allowConversationPromptInjection: false,
    ...overrides,
  };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    assistantId: "a1",
    systemPrompt: null,
    title: "",
    messages: [],
    chatSuggestions: [],
    isPinned: false,
    createAt: 1000,
    updateAt: 2000,
    modeInjectionIds: [],
    lorebookIds: [],
    workspaceId: null,
    workspaceCwd: null,
    engineCompactions: null,
    ...overrides,
  };
}

function userMessage(text: string, createdAt: string): Message {
  const msg = message("USER", [{ type: "text", text }]);
  msg.createdAt = createdAt;
  return msg;
}

function assistantMessage(text: string, createdAt: string): Message {
  const msg = message("ASSISTANT", [{ type: "text", text }], "m1");
  msg.createdAt = createdAt;
  return msg;
}

/** 工具消息:executed=true 表示"已执行"(带 output 的 result),false 表示"纯 call"(无 output)。
 *  与安卓 UIMessagePart.Tool.isExecuted = output.isNotEmpty() 对齐。 */
function toolMessage(executed: boolean, createdAt: string, role: "ASSISTANT" | "TOOL" = "ASSISTANT"): Message {
  const msg = message(role, [
    {
      type: "tool",
      toolCallId: `call-${createdAt}`,
      toolName: "get_weather",
      input: "{}",
      output: executed ? [{ type: "text", text: "晴 25°" }] : [],
      approvalState: { type: "auto" },
    },
  ]);
  msg.createdAt = createdAt;
  return msg;
}

const model = {
  id: "m1",
  modelId: "test-model",
  displayName: "Test Model",
  type: "CHAT" as const,
  inputModalities: ["TEXT"],
  outputModalities: ["TEXT"],
  abilities: [],
  tools: [],
};

describe("message-enrichment", () => {
  test("模板渲染:{{message}} 占位符在富化层一次到位,调用方不再二次包装", () => {
    const a = assistant({ messageTemplate: "User said: {{ message }}" });
    const result = enrichMessages([userMessage("hello", "2026-08-22T10:00:00Z")], {
      conversation: conversation(),
      assistant: a,
      model,
    });
    expect(result.messages[0].parts[0]).toMatchObject({ type: "text", text: "User said: hello" });
  });

  test("时间提醒:首条 USER 恒提醒,间隔 >10min 再提醒,<10min 不提醒", () => {
    const a = assistant({ enableTimeReminder: true });
    const base = [
      userMessage("first", "2026-08-22T10:00:00Z"),
      assistantMessage("reply", "2026-08-22T10:01:00Z"),
      userMessage("second", "2026-08-22T10:05:00Z"), // 5min 后,不提醒
      assistantMessage("reply2", "2026-08-22T10:06:00Z"),
      userMessage("third", "2026-08-22T10:30:00Z"), // 24min 后,提醒(分钟级文案)
      assistantMessage("reply3", "2026-08-22T10:31:00Z"),
      userMessage("fourth", "2026-08-22T12:00:00Z"), // 1.5h 后,提醒(小时级文案)
    ];
    const result = enrichMessages(base, { conversation: conversation(), assistant: a, model });
    const reminders = result.messages.filter((msg) => result.syntheticIds.has(msg.id));
    expect(reminders).toHaveLength(3);
    expect(String((reminders[0].parts[0] as { text: string }).text)).toContain("<time_reminder>");
    expect(String((reminders[0].parts[0] as { text: string }).text)).not.toContain("since last message");
    expect(String((reminders[1].parts[0] as { text: string }).text)).toContain("24 min since last message");
    expect(String((reminders[2].parts[0] as { text: string }).text)).toContain("1 h since last message");
  });

  test("滞回截断:contextMessageLimit 超限按步长量化前移", () => {
    expect(truncationStartFor(10, 0)).toBe(0); // 无限制
    expect(truncationStartFor(10, 10)).toBe(0); // 未超
    expect(truncationStartFor(11, 10)).toBe(0); // 超 1,step=2,floor(1/2)*2=0
    expect(truncationStartFor(12, 10)).toBe(2); // 超 2,起点=2
    expect(truncationStartFor(13, 10)).toBe(2); // 超 3,floor(3/2)*2=2
    expect(truncationStartFor(14, 10)).toBe(4); // 超 4,起点=4
    const a = assistant({ contextMessageLimit: 2 });
    const base = [
      userMessage("m1", "2026-08-22T10:00:00Z"),
      assistantMessage("r1", "2026-08-22T10:01:00Z"),
      userMessage("m2", "2026-08-22T10:02:00Z"),
      assistantMessage("r2", "2026-08-22T10:03:00Z"),
      userMessage("m3", "2026-08-22T10:04:00Z"),
    ];
    const result = enrichMessages(base, { conversation: conversation(), assistant: a, model });
    // limit=2,5 条 → step=ceil(2×0.2)=1,start = floor((5-2)/1)*1 = 3,保留 r2/m3
    expect(result.messages.map((msg) => (msg.parts[0] as { text?: string }).text)).toEqual(["r2", "m3"]);
  });

  test("窗口锚:锚在滞回截断起点之后 → 锚说了算,窗口内首条即锚消息", () => {
    const a = assistant({ contextMessageLimit: 2 });
    const base = Array.from({ length: 6 }, (_, i) => userMessage(`m${i}`, `2026-08-22T10:0${i}:00Z`));
    // 滞回起点=4(保留 4/5);锚=5(更晚)→ 窗口从 5 起(两种边界取 max)。
    const result = enrichMessages(base, {
      conversation: conversation(),
      assistant: a,
      model,
      windowStartMessageId: base[5].id,
    });
    expect(result.messages.map((msg) => (msg.parts[0] as { text?: string }).text)).toEqual(["m5"]);
  });

  test("窗口锚:锚在滞回截断起点之前 → 截断说了算(两种窗口边界取 max)", () => {
    const a = assistant({ contextMessageLimit: 2 });
    const base = Array.from({ length: 6 }, (_, i) => userMessage(`m${i}`, `2026-08-22T10:0${i}:00Z`));
    // 滞回起点=4(保留 4/5);锚=1(更早)→ 仍从 4 起(取 max)。
    const result = enrichMessages(base, {
      conversation: conversation(),
      assistant: a,
      model,
      windowStartMessageId: base[1].id,
    });
    expect(result.messages.map((msg) => (msg.parts[0] as { text?: string }).text)).toEqual(["m4", "m5"]);
  });

  test("窗口锚:锚 id 不在序列(陈旧压缩记录/消息被删)→ 视为无锚,行为不变", () => {
    const a = assistant({ contextMessageLimit: 2 });
    const base = Array.from({ length: 6 }, (_, i) => userMessage(`m${i}`, `2026-08-22T10:0${i}:00Z`));
    const result = enrichMessages(base, {
      conversation: conversation(),
      assistant: a,
      model,
      windowStartMessageId: "gone",
    });
    expect(result.messages.map((msg) => (msg.parts[0] as { text?: string }).text)).toEqual(["m4", "m5"]);
  });

  test("窗口锚下 top_of_chat 注入落在窗口首位,底位注入不晚于窗口末条(P9 灌注统一的富化侧保证)", () => {
    const a = assistant({ lorebookIds: ["book-1"] });
    const base = [
      userMessage("m0", "2026-08-22T10:00:00Z"),
      userMessage("m1", "2026-08-22T10:01:00Z"),
      userMessage("m2", "2026-08-22T10:02:00Z"),
    ];
    const result = enrichMessages(base, {
      conversation: conversation(),
      assistant: a,
      model,
      windowStartMessageId: base[1].id, // 切点=m1:窗口=[m1,m2]
    });
    // 注入行与窗口内真实行交错:top 在 m1 前、bottom 贴末条插入(插队语义是
    // "倒数第一前",末条是 USER 时落在它之前——与聊天引擎同一裁决,非新行为)。
    const texts = result.messages.map((msg) => (msg.parts[0] as { text?: string }).text);
    expect(texts).toEqual(["TOP_INJECTION_TEXT", "m1", "BOTTOM_INJECTION_TEXT", "m2"]);
    const syntheticTexts = result.messages
      .filter((msg) => result.syntheticIds.has(msg.id))
      .map((msg) => (msg.parts[0] as { text: string }).text);
    expect(syntheticTexts).toEqual(["TOP_INJECTION_TEXT", "BOTTOM_INJECTION_TEXT"]);
    // m0 在切点之前,被窗口锚排除(永不进被摘要吸收的旧历史)。
    expect(texts).not.toContain("m0");
  });

  test("encodableMessages:合成消息被剥除,真实消息保留(模板已渲染)", () => {
    const a = assistant({ enableTimeReminder: true, messageTemplate: "Q: {{ message }}" });
    const base = [userMessage("hello", "2026-08-22T10:00:00Z")];
    const enriched = enrichMessages(base, { conversation: conversation(), assistant: a, model });
    const encodable = encodableMessages(enriched.messages, enriched.syntheticIds);
    expect(encodable).toHaveLength(1);
    expect(encodable[0].parts[0]).toMatchObject({ type: "text", text: "Q: hello" });
    expect(encodableMessages(enriched.messages, new Set()).length).toBeGreaterThan(1); // 不剥则含提醒
  });
});

describe("alignContextStart(对齐安卓 limitContext 工具对对齐)", () => {
  const t = (s: number) => `2026-08-22T10:${String(s).padStart(2, "0")}:00Z`;

  test("起点落在已执行 tool(result)上 → 回退到对应的纯 call", () => {
    // m0 user | c1 纯call | r2 result | m3 user —— 起点=2 落在 result,会切出孤儿 result。
    const base = [
      userMessage("m0", t(0)),
      toolMessage(false, t(1)), // c1 纯 call
      toolMessage(true, t(2)), // r2 result(已执行)
      userMessage("m3", t(3)),
    ];
    // R1:从 2 回退到 1(纯 call);R2:1 是纯 call 再归并到 USER m0。
    expect(alignContextStart(base, 2)).toBe(0);
  });

  test("起点落在纯 call 上 → 归并到最近的 USER(工具链入口)", () => {
    const base = [
      userMessage("m0", t(0)),
      assistantMessage("a1", t(1)),
      toolMessage(false, t(2)), // 纯 call,起点落这里
      userMessage("m3", t(3)),
    ];
    // R2:纯 call → 归并到最近 USER m0(下标 0)。
    expect(alignContextStart(base, 2)).toBe(0);
  });

  test("起点在普通文本上 → 不动", () => {
    const base = [
      userMessage("m0", t(0)),
      assistantMessage("a1", t(1)),
      userMessage("m2", t(2)),
      assistantMessage("a3", t(3)),
    ];
    expect(alignContextStart(base, 2)).toBe(2);
    expect(alignContextStart(base, 0)).toBe(0);
  });

  test("已执行 tool 但更早处找不到纯 call → 不再回退(防御:不无限退)", () => {
    // 只有 result 没有 call(数据异常):R1 找不到纯 call,保持原起点。
    const base = [
      userMessage("m0", t(0)),
      assistantMessage("a1", t(1)),
      toolMessage(true, t(2)), // result,无对应纯 call
    ];
    expect(alignContextStart(base, 2)).toBe(2);
  });

  test("enrichMessages 集成:滞回起点劈开工具对时被回退,窗口不含孤儿 result", () => {
    // limit=3 → step=1;N=5 → 滞回起点=2,恰好落在 result(idx2)上。
    const a = assistant({ contextMessageLimit: 3 });
    const base = [
      userMessage("m0", t(0)), // idx0 USER(工具链入口)
      toolMessage(false, t(1)), // idx1 纯 call
      toolMessage(true, t(2)), // idx2 result(滞回起点算到这里)
      userMessage("m3", t(3)),
      assistantMessage("a4", t(4)),
    ];
    const result = enrichMessages(base, { conversation: conversation(), assistant: a, model });
    // R1:起点 2(result)→ 回退到纯 call idx1;R2:idx1 是纯 call → 归并到 USER idx0。
    // 最终从 idx0 起全保留,工具对完整。
    expect(alignContextStart(base, 2)).toBe(0);
    expect(result.messages).toHaveLength(5);
    // 关键不变量:窗口内每个 result 都有对应 call(无孤儿)。纯 call 与 result 各一。
    const toolParts = result.messages.flatMap((msg) => msg.parts.filter((p) => p.type === "tool"));
    const executed = toolParts.filter((p) => p.type === "tool" && Array.isArray(p.output) && p.output.length > 0);
    const calls = toolParts.filter((p) => p.type === "tool" && Array.isArray(p.output) && p.output.length === 0);
    expect(executed).toHaveLength(1);
    expect(calls).toHaveLength(1);
    // 窗口首条是 USER,不是孤儿 result。
    expect(result.messages[0].role).toBe("USER");
  });

  test("enrichMessages 集成:工具对完整落在窗口内时起点不回退", () => {
    // limit=3 → step=1;N=4 → 滞回起点=1,落在纯 call(idx1)。
    const a = assistant({ contextMessageLimit: 3 });
    const base = [
      userMessage("m0", t(0)),
      toolMessage(false, t(1)), // idx1 纯 call(起点)
      toolMessage(true, t(2)), // idx2 result
      userMessage("m3", t(3)),
    ];
    // 起点=1 是纯 call:R2 归并到 USER idx0(工具链入口),窗口全保留,call/result 成对。
    expect(alignContextStart(base, 1)).toBe(0);
    const result = enrichMessages(base, { conversation: conversation(), assistant: a, model });
    expect(result.messages).toHaveLength(4);
  });
});
