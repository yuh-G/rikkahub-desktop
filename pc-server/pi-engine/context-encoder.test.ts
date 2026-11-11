// pi-engine/context-encoder.test.ts — DB→pi 编码器单测(P7 会话数据统一)
//
// 断言面刻意选 manager.buildSessionContext().messages:这是 createAgentSession 构造点
// 真正消费的产物(sdk.ts 的 buildSessionContext 调用),测"pi 将看到什么",不测编码器
// 中间形。压缩用例同理,锁的是 pi buildContextEntries 对灌注 CompactionEntry 的真实语义。
// USER 行输入按生产路径由应用侧物化(userInputsFor),编码器只消费契约数据。

import { describe, expect, test } from "bun:test";

import { SessionManager } from "../../pi/packages/coding-agent/src/core/session-manager.ts";
import type { EngineCompactionRecord } from "../engines/contract";
import type { JsonValue, Message, Model, ToolPart } from "../foundation/types";
import { message } from "../foundation/utils";
import { effectiveEngineCompaction } from "../conversations/engine-compactions";
import { userInputsFor } from "../inference-engine/prompt-input";
import { seedPiSessionFromHistory } from "./context-encoder";

const model = { modelId: "test-model", inputModalities: ["TEXT", "IMAGE"] } as unknown as Model;

function seed(history: Message[], compactions?: EngineCompactionRecord[], syntheticIds?: Set<string>) {
  const manager = SessionManager.inMemory(process.cwd());
  const result = seedPiSessionFromHistory({
    manager,
    history,
    userInputs: userInputsFor(history, model),
    fallbackModelId: model.modelId,
    compactions,
    syntheticIds,
  });
  return { manager, result, messages: manager.buildSessionContext().messages };
}

function toolPart(partial: Partial<ToolPart> & Pick<ToolPart, "toolCallId" | "toolName">): ToolPart {
  return {
    type: "tool",
    input: "{}",
    output: [],
    approvalState: { type: "auto" },
    ...partial,
  } as ToolPart;
}

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fidelity(messages: JsonValue): JsonValue {
  return {
    type: "pi-fidelity",
    v: 1,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-x",
    messages,
  };
}

describe("DB→pi 编码器:用户行", () => {
  test("文本+data 图 → prompt 同形 UserMessage(text 块恒首位,图片后置)", () => {
    const user = message("USER", [
      { type: "text", text: "看看这个图" },
      { type: "image", url: "data:image/png;base64,QUJD" },
    ]);
    const { messages } = seed([user]);
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "看看这个图" },
          { type: "image", data: "QUJD", mimeType: "image/png" },
        ],
        timestamp: Date.parse(user.createdAt),
      },
    ]);
  });

  test("空内容用户行不进上下文(与生成入口拒发条件同源)", () => {
    const { messages } = seed([message("USER", [])]);
    expect(messages).toEqual([]);
  });
});

describe("DB→pi 编码器:保真路径", () => {
  test("签名/分组/工具结果往返:一行 parts 还原为 assistant→toolResult→assistant", () => {
    const call = toolPart({
      toolCallId: "call-a",
      toolName: "read",
      input: '{"path":"a.txt"}',
      output: [{ type: "text", text: "文件内容" }],
    });
    const row = message("ASSISTANT", [
      { type: "reasoning", reasoning: "先看文件" },
      call,
      { type: "text", text: "结论:OK" },
    ]);
    row.annotations = [
      fidelity([
        [
          { type: "thinking", len: 4, sig: "sig-1" },
          { type: "toolCall", toolCallId: "call-a" },
        ],
        [{ type: "text", len: 5 }],
      ]),
    ];
    const { messages, result } = seed([row]);
    const ts = Date.parse(row.createdAt);
    expect(messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先看文件", thinkingSignature: "sig-1" },
          { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.txt" } },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-x",
        usage: zeroUsage,
        stopReason: "toolUse",
        timestamp: ts,
      },
      {
        role: "toolResult",
        toolCallId: "call-a",
        toolName: "read",
        content: [{ type: "text", text: "文件内容" }],
        isError: false,
        timestamp: ts,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "结论:OK" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-x",
        usage: zeroUsage,
        stopReason: "stop",
        timestamp: ts,
      },
    ]);
    expect(result.degradedMessageIds).toEqual([]);
  });

  test("跨引擎消息并入同一 text part:len 游标精确切回原块", () => {
    const row = message("ASSISTANT", [{ type: "text", text: "AB" }]);
    row.annotations = [fidelity([[{ type: "text", len: 1 }], [{ type: "text", len: 1 }]])];
    const { messages } = seed([row]);
    expect(messages.map((m) => (m as { content: unknown }).content)).toEqual([
      [{ type: "text", text: "A" }],
      [{ type: "text", text: "B" }],
    ]);
  });

  test("redacted 思维链(len 0 无对应 part)原位还原,签名载荷保留", () => {
    const row = message("ASSISTANT", [{ type: "text", text: "好" }]);
    row.annotations = [
      fidelity([
        [
          { type: "thinking", len: 0, sig: "enc-payload", redacted: true },
          { type: "text", len: 1 },
        ],
      ]),
    ];
    const { messages } = seed([row]);
    expect((messages[0] as { content: unknown[] }).content).toEqual([
      { type: "thinking", thinking: "", thinkingSignature: "enc-payload", redacted: true },
      { type: "text", text: "好" },
    ]);
  });

  test("注解失配(编辑过历史)→ 整行退化 legacy:剥 thinking,行入 degraded 名单", () => {
    const row = message("ASSISTANT", [
      { type: "reasoning", reasoning: "推理过" },
      { type: "text", text: "编辑后的正文" },
    ]);
    row.annotations = [fidelity([[{ type: "thinking", len: 999, sig: "sig-stale" }, { type: "text", len: 2 }]])];
    const { messages, result } = seed([row]);
    expect(messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "编辑后的正文" }],
        stopReason: "stop",
      }),
    ]);
    expect(result.degradedMessageIds).toEqual([row.id]);
  });
});

describe("DB→pi 编码器:legacy 路径(P2-P6 存量行,无注解)", () => {
  test("启发式分组:连续 tool 段结束遇非 tool 即断消息;thinking 剥除", () => {
    const t1 = toolPart({ toolCallId: "c-1", toolName: "bash", output: [{ type: "text", text: "out-1" }] });
    const t2 = toolPart({ toolCallId: "c-2", toolName: "read", output: [{ type: "text", text: "out-2" }] });
    const row = message("ASSISTANT", [
      { type: "reasoning", reasoning: "该剥除的思维链" },
      { type: "text", text: "先说明" },
      t1,
      t2,
      { type: "text", text: "收尾" },
    ]);
    const { messages, result } = seed([row]);
    expect(result.degradedMessageIds).toEqual([row.id]);
    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult", "toolResult", "assistant"]);
    expect((messages[0] as { content: unknown[] }).content).toEqual([
      { type: "text", text: "先说明" },
      { type: "toolCall", id: "c-1", name: "bash", arguments: {} },
      { type: "toolCall", id: "c-2", name: "read", arguments: {} },
    ]);
    expect((messages[3] as { content: unknown[] }).content).toEqual([{ type: "text", text: "收尾" }]);
  });
});

describe("DB→pi 编码器:工具结果反向通道", () => {
  function seededToolResults(tools: ToolPart[]) {
    const row = message("ASSISTANT", [...tools, { type: "text", text: "完" }]);
    const { messages } = seed([row]);
    return messages.filter((m) => m.role === "toolResult");
  }

  test("{error} 载荷 → isError + 原文;空输出 → 确定性中断占位", () => {
    const [errored, interrupted] = seededToolResults([
      toolPart({ toolCallId: "c-e", toolName: "bash", output: [{ error: "boom" } as never] }),
      toolPart({ toolCallId: "c-i", toolName: "bash", output: [] }),
    ]);
    expect(errored).toMatchObject({ isError: true, content: [{ type: "text", text: "boom" }] });
    expect(interrupted).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Tool execution was interrupted before producing a result." }],
    });
  });

  test("app 通道(来源标记)→ openAiToolOutput 再计算;逐字通道 → data 图解回字节,空载体跳过", () => {
    const [app, workspace] = seededToolResults([
      toolPart({
        toolCallId: "c-app",
        toolName: "search_web",
        output: [
          { type: "text", text: "1. Result", metadata: { pi: { src: "app" } } },
          { type: "image", url: "/api/files/img-1.png" },
        ],
      }),
      toolPart({
        toolCallId: "c-ws",
        toolName: "read",
        output: [
          { type: "text", text: "", metadata: { workspace: { kind: "read" } } },
          { type: "image", url: "data:image/png;base64,QUJD" },
        ],
      }),
    ]);
    // app 通道:模型面 = openAiToolOutput(entries) 单 text(运行时 general-tools 同源口径)
    expect(app).toMatchObject({ isError: false, content: [{ type: "text", text: "1. Result" }] });
    // 逐字通道:空 text 载体条目跳过,data 图还原为 ImageContent
    expect(workspace).toMatchObject({
      isError: false,
      content: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
    });
  });
});

describe("DB→pi 编码器:压缩与确定性", () => {
  function compactionFixture() {
    const user1 = message("USER", [{ type: "text", text: "第一问" }]);
    const asst1 = message("ASSISTANT", [{ type: "text", text: "旧回答一" }]);
    asst1.annotations = [fidelity([[{ type: "text", len: 4 }]])];
    const user2 = message("USER", [{ type: "text", text: "第二问" }]);
    const asst2 = message("ASSISTANT", [{ type: "text", text: "新回答二" }]);
    asst2.annotations = [fidelity([[{ type: "text", len: 4 }]])];
    return { history: [user1, asst1, user2, asst2], user2 };
  }

  test("压缩记录:切点起保留原文,之前历史被 summary 取代(pi buildContextEntries 真实语义)", () => {
    const { history, user2 } = compactionFixture();
    const { messages } = seed(history, [
      { cutMessageId: user2.id, summary: "此前:用户问了第一问,回答完毕。", tokensBefore: 1234 },
    ]);
    const flat = JSON.stringify(messages);
    expect(flat).toContain("此前:用户问了第一问,回答完毕。");
    expect(flat).not.toContain("旧回答一");
    expect(flat).toContain("第二问");
    expect(flat).toContain("新回答二");
  });

  test("切点消息已被删(编辑/截断)→ 压缩记录失效跳过,回落全量历史", () => {
    const { history } = compactionFixture();
    const { messages } = seed(history, [{ cutMessageId: "gone", summary: "失效摘要", tokensBefore: 9 }]);
    const flat = JSON.stringify(messages);
    expect(flat).not.toContain("失效摘要");
    expect(flat).toContain("旧回答一");
  });

  test("缓存不变量:同一历史两次灌注,上下文逐字节一致", () => {
    const { history, user2 } = compactionFixture();
    const records: EngineCompactionRecord[] = [{ cutMessageId: user2.id, summary: "摘要", tokensBefore: 42 }];
    const first = seed(history, records).messages;
    const second = seed(history, records).messages;
    // pi 的 appendCompaction 给条目打墙钟时间戳(new Date()),跨毫秒边界即字节漂移
    // (曾致本测试偶发红)——时间戳不属于"内容一致"不变量,剔除后比较。
    const stripClock = (messages: unknown) => JSON.stringify(messages, (key, value) => (key === "timestamp" ? undefined : value));
    expect(stripClock(second)).toBe(stripClock(first));
  });
});

describe("DB→pi 编码器:P9 合成行灌注", () => {
  /** P9 形状:窗口 = [top 注入(合成 USER), 切点 user2, asst2, bottom 注入(合成 USER)]。 */
  function syntheticFixture() {
    const user1 = message("USER", [{ type: "text", text: "旧问" }]);
    const asst1 = message("ASSISTANT", [{ type: "text", text: "旧答" }]);
    const user2 = message("USER", [{ type: "text", text: "新问" }]);
    const asst2 = message("ASSISTANT", [{ type: "text", text: "新答" }]);
    const topInjection = message("USER", [{ type: "text", text: "TOP_INJECTION" }]);
    const assistantInjection = message("ASSISTANT", [{ type: "text", text: "ASSISTANT_INJECTION" }]);
    const bottomInjection = message("USER", [{ type: "text", text: "BOTTOM_INJECTION" }]);
    const history = [topInjection, user2, assistantInjection, asst2, bottomInjection];
    const syntheticIds = new Set([topInjection.id, assistantInjection.id, bottomInjection.id]);
    const compactions: EngineCompactionRecord[] = [{ cutMessageId: user2.id, summary: "旧史摘要", tokensBefore: 100 }];
    return { user1, asst1, user2, asst2, history, syntheticIds, compactions };
  }

  test("合成 USER/ASSISTANT 行照常编码进上下文,但不进切点映射与退化名单", () => {
    const { history, syntheticIds, compactions, user2, asst2 } = syntheticFixture();
    const { messages, result } = seed(history, compactions, syntheticIds);
    const flat = JSON.stringify(messages);
    // 全序列进模型视野(P9 核心:注入不再被剥除)。
    expect(flat).toContain("TOP_INJECTION");
    expect(flat).toContain("ASSISTANT_INJECTION");
    expect(flat).toContain("BOTTOM_INJECTION");
    // 登记排除:切点映射只认真实行,退化名单不含合成行(legacy 是其设计路径)。
    expect([...result.entryIdsByMessageId.keys()]).toEqual([user2.id, asst2.id]);
    expect(result.degradedMessageIds).toEqual([asst2.id]);
  });

  test("压缩重放 + 合成行:窗口锚保证合成行在切点之后(appendCompaction 不再盖住 top 注入)", () => {
    const { history, syntheticIds, compactions } = syntheticFixture();
    const { messages } = seed(history, compactions, syntheticIds);
    const flat = JSON.stringify(messages);
    // 摘要在场,切点前的旧史被取代——但窗口锚已把切点前条目挡在序列外,这里只剩
    // "摘要吸收旧史"与"合成行在场"两件事同时成立。
    expect(flat).toContain("旧史摘要");
    expect(flat).not.toContain("旧问");
    expect(flat).toContain("TOP_INJECTION");
    expect(flat).toContain("新问");
  });

  test("effectiveEngineCompaction:切点在场且可编 → 生效;零条目行/被删消息 → 不生效;取最新一条", () => {
    const { user1, asst1, user2 } = syntheticFixture();
    const emptyRow = message("USER", []); // 编码后零条目(拒发条件)
    const history = [user1, asst1, emptyRow, user2];
    const valid = { cutMessageId: user2.id, summary: "s1", tokensBefore: 1 };
    expect(effectiveEngineCompaction([valid], history, model)).toBe(valid);
    // 切点指向零条目行 → 不生效(与编码器内部重放过滤同一谓词)。
    expect(effectiveEngineCompaction([{ cutMessageId: emptyRow.id, summary: "s2", tokensBefore: 1 }], history, model)).toBeNull();
    // 切点不在序列(被删/编辑分支)→ 不生效。
    expect(effectiveEngineCompaction([{ cutMessageId: "gone", summary: "s3", tokensBefore: 1 }], history, model)).toBeNull();
    // 多条记录取最新一条生效。
    const older = { cutMessageId: user1.id, summary: "older", tokensBefore: 1 };
    expect(effectiveEngineCompaction([older, valid], history, model)).toBe(valid);
  });

  test("effectiveEngineCompaction 与编码器重放口径一致:判定生效的记录,编码器必重放", () => {
    const { user1, asst1, user2, asst2, history, syntheticIds, compactions } = syntheticFixture();
    const effective = effectiveEngineCompaction(compactions, [user1, asst1, user2, asst2], model);
    expect(effective?.cutMessageId).toBe(user2.id);
    const { messages } = seed(history, compactions, syntheticIds);
    // 编码器内部过滤没有把 effectiveEngineCompaction 判生效的记录再丢掉。
    expect(JSON.stringify(messages)).toContain("旧史摘要");
  });
});
