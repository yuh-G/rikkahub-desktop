// conversations/message-queue 行为锁 + queue/* 端点(台账 §1.2 消息发送队列)。
// 语义锚点:队列只压「待触发的生成」(纯内存态);消息本体在派发时落库。跨引擎统一——
// 派发只调 generateAnswer,引擎无感。此处锁定状态机的 FIFO/暂停/编辑/快照契约,与端点的
// 单飞(空闲直发 / 生成中入队)门控;不驱动真实 generateAnswer(那是平价回归测试的职责)。
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-mqueue-test-"));

import type { Conversation, State } from "../foundation/types";
import { textFromParts } from "../foundation/utils";
import { abortGeneration, generating } from "./generation-state";
import { configureWorkingSet, registerConversation } from "./working-set";
import { setState, state } from "../persistence/json-store";
import { handleConversationRoutes } from "../api/handlers/conversations";
import { openConversationsDb, loadConversationNodesFromDb, persistConversation } from "./index";
import { getConversationMeta } from "./read-queries";
import { generateAnswer } from "./orchestrator";
import {
  clearMessageQueue,
  deliverQueuedReply,
  editQueuedMessage,
  enqueueMessage,
  hasQueuedMessages,
  holdMessageQueue,
  isQueueHeldByInterrupt,
  isQueuePaused,
  pauseMessageQueue,
  queueLength,
  queueSnapshotFor,
  releaseMessageQueueHold,
  removeQueuedMessage,
  resumeMessageQueue,
  shiftNextQueued,
  waitForQueuedReply,
} from "./message-queue";
import {
  clearSteeringChannel,
  drainSteeringMessages,
  pushSteeringMessage,
  removeSteeringMessage,
} from "./steering-channel";

const priorState = state;

beforeAll(() => {
  const db = openConversationsDb();
  setState({
    settings: {
      assistantId: "a1",
      assistants: [{ id: "a1", chatModelId: "m1" }],
      chatModelId: "m1",
      providers: [{ id: "p1", type: "openai", baseUrl: "http://127.0.0.1:0", models: [{ id: "m1" }] }],
    },
  } as unknown as State);
  configureWorkingSet({
    loadConversation: (convId) => {
      const meta = getConversationMeta(db, convId);
      if (!meta) return undefined;
      meta.messages = loadConversationNodesFromDb(db, convId);
      return meta;
    },
    isGenerating: (id) => generating.has(id),
    hasSseClients: () => false,
    hasDirty: () => false,
  });
});

function makeConversation(id: string): Conversation {
  const now = Date.now();
  return {
    id,
    assistantId: "a1",
    title: "queue-test",
    messages: [],
    isPinned: false,
    createAt: now,
    updateAt: now,
    chatSuggestions: [],
  } as unknown as Conversation;
}

/** 轮询等待条件成立(E2E 派发/收尾的确定性同步点;超时即失败信号)。模块级供多个 describe 复用。 */
async function waitUntil(cond: () => boolean, timeoutMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("message-queue 状态机", () => {
  test("FIFO:入队顺序即出队顺序;队空快照为 null", () => {
    const cid = "q-fifo";
    expect(queueSnapshotFor(cid)).toBeNull();
    const a = enqueueMessage(cid, [{ type: "text", text: "甲" }]);
    const b = enqueueMessage(cid, [{ type: "text", text: "乙" }]);
    expect(queueLength(cid)).toBe(2);
    expect(shiftNextQueued(cid)?.id).toBe(a.id);
    expect(shiftNextQueued(cid)?.id).toBe(b.id);
    expect(shiftNextQueued(cid)).toBeUndefined();
    expect(queueSnapshotFor(cid)).toBeNull();
  });

  test("入队对 parts 做不可变快照:调用方后续改草稿不污染队列", () => {
    const cid = "q-snapshot";
    const parts = [{ type: "text", text: "原文" }] as { type: "text"; text: string }[];
    const item = enqueueMessage(cid, parts);
    parts[0]!.text = "改过的草稿";
    expect(shiftNextQueued(cid)?.parts[0]).toMatchObject({ text: "原文" });
    expect(item.id).toBeTruthy();
  });

  test("暂停门控:pause 保留全部项,resume 恢复;纯内存语义", () => {
    const cid = "q-pause";
    enqueueMessage(cid, [{ type: "text", text: "x" }]);
    pauseMessageQueue(cid);
    expect(isQueuePaused(cid)).toBe(true);
    expect(queueLength(cid)).toBe(1); // 暂停不丢项
    resumeMessageQueue(cid);
    expect(isQueuePaused(cid)).toBe(false);
  });

  test("编辑只换内容不动 FIFO 位次;移除返回被删项", () => {
    const cid = "q-edit";
    const a = enqueueMessage(cid, [{ type: "text", text: "1" }]);
    const b = enqueueMessage(cid, [{ type: "text", text: "2" }]);
    expect(editQueuedMessage(cid, b.id, [{ type: "text", text: "2改" }])).toBe(true);
    // 位次不变:a 仍在队首。
    expect(shiftNextQueued(cid)?.id).toBe(a.id);
    expect(shiftNextQueued(cid)?.parts[0]).toMatchObject({ text: "2改" });
    // 移除不存在的 id 幂等返回 null。
    expect(removeQueuedMessage(cid, "nope")).toBeNull();
    const c = enqueueMessage(cid, [{ type: "text", text: "3" }]);
    expect(removeQueuedMessage(cid, c.id)?.id).toBe(c.id);
    expect(hasQueuedMessages(cid)).toBe(false);
  });

  test("快照派生 preview/hasAttachments:文本截断,纯附件回退占位", () => {
    const cid = "q-preview";
    enqueueMessage(cid, [{ type: "text", text: "  多空格\n  归并  " }]);
    enqueueMessage(cid, [{ type: "image", url: "file://x.png" } as never]);
    const snap = queueSnapshotFor(cid)!;
    expect(snap.items[0]!.preview).toBe("多空格 归并");
    expect(snap.items[0]!.hasAttachments).toBe(false);
    expect(snap.items[1]!.preview).toBe("");
    expect(snap.items[1]!.hasAttachments).toBe(true);
    clearMessageQueue(cid);
  });

  test("clearMessageQueue 幂等清空(会话删除路径)", () => {
    const cid = "q-clear";
    enqueueMessage(cid, [{ type: "text", text: "x" }]);
    pauseMessageQueue(cid);
    clearMessageQueue(cid);
    expect(queueSnapshotFor(cid)).toBeNull();
    expect(isQueuePaused(cid)).toBe(false);
    clearMessageQueue(cid); // 幂等
  });

  test("语音回复通道:等待方在交付时收到文本;移除/清队列兜底 null", async () => {
    const cid = "q-reply";
    const item = enqueueMessage(cid, [{ type: "text", text: "语音一句" }], { waitingReply: true });
    expect(item.waitingReply).toBe(true);
    // 交付正常文本。
    const p1 = waitForQueuedReply(cid, item.id);
    deliverQueuedReply(cid, item.id, "回复文本");
    await expect(p1).resolves.toBe("回复文本");
    // 重复交付/未注册项幂等空操作。
    deliverQueuedReply(cid, item.id, "again");
    deliverQueuedReply(cid, "nonexistent", "x");
    // 移除排队项 → 等待方 resolve null(消息被撤回,无可播报)。
    const item2 = enqueueMessage(cid, [{ type: "text", text: "将被移除" }], { waitingReply: true });
    const p2 = waitForQueuedReply(cid, item2.id);
    removeQueuedMessage(cid, item2.id);
    await expect(p2).resolves.toBeNull();
    // 清队列 → 挂起等待 resolve null。
    const item3 = enqueueMessage(cid, [{ type: "text", text: "清队列" }], { waitingReply: true });
    const p3 = waitForQueuedReply(cid, item3.id);
    clearMessageQueue(cid);
    await expect(p3).resolves.toBeNull();
  });
});

describe("messages StartOrSteer + queue/* 端点", () => {
  async function postJson(conversationId: string, subPath: string, body: object): Promise<Response | null> {
    const url = new URL(`http://127.0.0.1/api/conversations/${conversationId}/${subPath}`);
    const request = new Request(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    return handleConversationRoutes(request, url, `conversations/${conversationId}/${subPath}`);
  }
  async function del(conversationId: string, subPath: string): Promise<Response | null> {
    const url = new URL(`http://127.0.0.1/api/conversations/${conversationId}/${subPath}`);
    return handleConversationRoutes(new Request(url, { method: "DELETE" }), url, `conversations/${conversationId}/${subPath}`);
  }

  test("生成中 messages → 入队(queued:true),不追加历史节点,不中止在跑流(StartOrSteer 的 Steer 支)", async () => {
    // 2026-09-20 用户测试 1 的治本:占用裁决在服务端,前端不再按滞后的 isGenerating 选端点。
    // 此前 messages 在生成中会 abort 在跑流——快速连发把自己刚点火的生成掐掉。
    const conv = makeConversation("c-q-busy");
    registerConversation(conv);
    const controller = new AbortController();
    generating.set(conv.id, controller); // 模拟在跑流
    try {
      const res = await postJson(conv.id, "messages", { parts: [{ type: "text", text: "补一句" }] });
      expect(res!.status).toBe(202);
      const payload = (await res!.json()) as { queued: boolean; id: string };
      expect(payload.queued).toBe(true);
      // 队列收到一条,且历史未预先追加(注入/派发时才落库),在跑流未被中止、登记未被顶掉。
      expect(queueLength(conv.id)).toBe(1);
      expect(conv.messages.length).toBe(0);
      expect(controller.signal.aborted).toBe(false);
      expect(generating.get(conv.id)).toBe(controller);
    } finally {
      generating.delete(conv.id);
      clearMessageQueue(conv.id);
    }
  });

  test("空闲 messages → 直发(queued:false),用户消息本体落库,不入队(Start 支)", async () => {
    const conv = makeConversation("c-q-idle");
    // 直发路径会 persistConversation(需会话行在库),再经 generateAnswer 点火。
    const { persistConversation } = await import("./index");
    persistConversation(conv);
    registerConversation(conv);
    const res = await postJson(conv.id, "messages", { parts: [{ type: "text", text: "直接发" }] });
    expect(res!.status).toBe(202);
    const payload = (await res!.json()) as { queued: boolean };
    expect(payload.queued).toBe(false);
    // 空闲路径与 send 同构:用户节点立即进历史(可能已被 generateAnswer 追加 assistant 占位),
    // 队列保持空。
    const userNode = conv.messages.find((n) => n.messages[0]?.role === "USER");
    expect(userNode?.messages[0]?.parts[0]).toMatchObject({ type: "text", text: "直接发" });
    expect(hasQueuedMessages(conv.id)).toBe(false);
  });

  test("pause/resume 切换暂停位;resume 在生成中不点火(等收尾续跑)", async () => {
    const conv = makeConversation("c-q-pr");
    registerConversation(conv);
    const controller = new AbortController();
    generating.set(conv.id, controller);
    try {
      enqueueMessage(conv.id, [{ type: "text", text: "等" }]);
      await postJson(conv.id, "queue/pause", {});
      expect(isQueuePaused(conv.id)).toBe(true);
      // 生成中 resume:清暂停位但不抢占在跑流(generating 仍占用,不派发)。
      await postJson(conv.id, "queue/resume", {});
      expect(isQueuePaused(conv.id)).toBe(false);
      expect(queueLength(conv.id)).toBe(1);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      generating.delete(conv.id);
      clearMessageQueue(conv.id);
    }
  });

  test("编辑/删除排队项;删除未知 id 返回 404", async () => {
    const conv = makeConversation("c-q-crud");
    registerConversation(conv);
    const controller = new AbortController();
    generating.set(conv.id, controller);
    try {
      const item = enqueueMessage(conv.id, [{ type: "text", text: "旧" }]);
      const edit = await postJson(conv.id, `queue/${item.id}`, { parts: [{ type: "text", text: "新" }] });
      expect(edit!.status).toBe(200);
      expect(queueSnapshotFor(conv.id)!.items[0]!.preview).toBe("新");
      const missing = await del(conv.id, "queue/does-not-exist");
      expect(missing!.status).toBe(404);
      const removed = await del(conv.id, `queue/${item.id}`);
      expect(removed!.status).toBe(200);
      expect(hasQueuedMessages(conv.id)).toBe(false);
    } finally {
      generating.delete(conv.id);
      clearMessageQueue(conv.id);
    }
  });

  test("压缩进行中 messages 返回 409(防压缩落库覆盖吞消息)", async () => {
    const conv = makeConversation("c-q-mutex");
    registerConversation(conv);
    const { compressing } = await import("./generation-state");
    compressing.set(conv.id, Date.now());
    try {
      const res = await postJson(conv.id, "messages", { parts: [{ type: "text", text: "x" }] });
      expect(res!.status).toBe(409);
      expect(((await res!.json()) as { errorCode?: string }).errorCode).toBe("compress_in_progress");
      expect(hasQueuedMessages(conv.id)).toBe(false);
    } finally {
      compressing.delete(conv.id);
    }
  });
});

// 派发 E2E:当前流收尾后,队首待生成被点火、其用户消息本体落库进历史(跨引擎平价的最小证据:
// 派发只调 generateAnswer,引擎无感)。用假 OpenAI SSE 上游精确控轮,第一轮响应前注入排队项,
// 断言它在第一轮收尾后被接力点火。
describe("消息发送队列派发(收尾续跑)", () => {
  test("第一轮进行中入队 → 收尾后自动点火第二轮,队首消息落库进历史", async () => {
    const { startFakeOpenAiSse } = await import("../test-utils/fake-openai-sse");
    const { model, provider } = await import("../model-providers");
    const { defaultState } = await import("../app-config/defaults");
    const { defaultAssistant } = await import("../assistants");

    const conv = makeConversation("c-q-dispatch");
    persistConversation(conv);
    registerConversation(conv);
    // 第一条用户消息落库(队列派发的是「第二条」)。
    conv.messages.push({
      id: "c-q-dispatch-n1",
      selectIndex: 0,
      messages: [{
        id: "c-q-dispatch-m1",
        role: "USER",
        parts: [{ type: "text", text: "第一轮" }],
        annotations: [],
        createdAt: new Date().toISOString(),
        finishedAt: null,
        translation: null,
      }],
    } as never);
    persistConversation(conv);

    // 假上游两轮:第一轮 beforeRespond 注入排队项(模拟「生成中补发」),第二轮作答。
    const server = await startFakeOpenAiSse([
      { content: "回答一", beforeRespond: () => { enqueueMessage(conv.id, [{ type: "text", text: "第二轮问题" }]); } },
      { content: "回答二" },
    ]);
    try {
      const ourModel = model("fake-model", "Dispatch Test");
      const ourProvider = provider({
        id: crypto.randomUUID(), name: "Dispatch Provider", baseUrl: server.baseUrl,
        apiKey: "sk-test", enabled: true, models: [ourModel],
      });
      const next = defaultState();
      next.settings.assistantId = "a1";
      next.settings.assistants = [{ ...defaultAssistant(), id: "a1" }];
      next.settings.providers = [ourProvider];
      next.settings.chatModelId = ourModel.id;
      next.settings.fastModelId = "";
      setState(next as State);

      await generateAnswer(conv); // 第一轮(期间入队)
      await waitUntil(() => server.requests.length >= 2); // 等第二轮被派发点火

      // 硬证据:上游收到两次请求 = 当前流收尾触发了队列派发;第二条用户消息已落库进历史。
      expect(server.requests.length).toBe(2);
      const queuedUserNode = conv.messages.find((n) =>
        n.messages.some((m) => m.role === "USER" && JSON.stringify(m.parts).includes("第二轮问题")),
      );
      expect(queuedUserNode).toBeTruthy();
      expect(hasQueuedMessages(conv.id)).toBe(false); // 队列已排空
    } finally {
      await server.close();
      clearMessageQueue(conv.id);
      setState(priorState);
    }
  });

  test("失败自动暂停:首轮失败后队列保留且 paused,不再自动续跑", async () => {
    const { startFakeOpenAiSse } = await import("../test-utils/fake-openai-sse");
    const { model, provider } = await import("../model-providers");
    const { defaultState } = await import("../app-config/defaults");
    const { defaultAssistant } = await import("../assistants");

    const conv = makeConversation("c-q-fail");
    persistConversation(conv);
    registerConversation(conv);
    conv.messages.push({
      id: "c-q-fail-n1", selectIndex: 0,
      messages: [{
        id: "c-q-fail-m1", role: "USER", parts: [{ type: "text", text: "会失败" }],
        annotations: [], createdAt: new Date().toISOString(), finishedAt: null, translation: null,
      }],
    } as never);
    persistConversation(conv);

    // 剧本只给一轮,但让它失败:第二轮 turn 不存在则假上游 500 → 走失败分支。
    const server = await startFakeOpenAiSse([{ content: "x", beforeRespond: () => { enqueueMessage(conv.id, [{ type: "text", text: "待续" }]); } }]);
    try {
      const ourModel = model("fake-model", "Fail Test");
      const ourProvider = provider({
        id: crypto.randomUUID(), name: "Fail Provider", baseUrl: server.baseUrl,
        apiKey: "sk-test", enabled: true, models: [ourModel],
      });
      const next = defaultState();
      next.settings.assistantId = "a1";
      next.settings.assistants = [{ ...defaultAssistant(), id: "a1" }];
      next.settings.providers = [ourProvider];
      next.settings.chatModelId = ourModel.id;
      next.settings.fastModelId = "";
      setState(next as State);

      // 首轮正常返回,但收尾时队列派发会请求第二轮——假上游剧本耗尽返回 500 → 失败分支 pause。
      await generateAnswer(conv);
      await waitUntil(() => server.requests.length >= 2);
      await waitUntil(() => isQueuePaused(conv.id));
      // 失败保留队列项(待用户 resume),不自动清空。
      expect(isQueuePaused(conv.id)).toBe(true);
    } finally {
      await server.close();
      clearMessageQueue(conv.id);
      setState(priorState);
    }
  });
});

// ── 终局三态(用户问题①,对齐 Codex ThreadIdleCause)──────────────────────
// Interrupted(用户 stop/打断) → 队列冻结不点火;Failed(失败) → pause;Completed → 续跑。
// 上述派发测试已锁 Completed/Failed,此处锁 Interrupted 的状态机与端到端行为。
describe("终局三态:打断冻结", () => {
  test("hold 保留全部项且快照分态呈现 interrupted;resume 一并解除", () => {
    const cid = "q-hold";
    enqueueMessage(cid, [{ type: "text", text: "待命" }]);
    holdMessageQueue(cid);
    expect(isQueueHeldByInterrupt(cid)).toBe(true);
    expect(isQueuePaused(cid)).toBe(false); // 与失败暂停是两个标志位
    expect(queueLength(cid)).toBe(1); // 冻结不丢项
    // 快照分态:打断冻结 = interrupted(用户自己的决定,前端中性提示 + 继续);
    // 失败暂停 = failed(错误恢复,警示色);两者并存时 failed 优先(用户需要知道出了错)。
    expect(queueSnapshotFor(cid)?.held).toBe("interrupted");
    pauseMessageQueue(cid);
    expect(queueSnapshotFor(cid)?.held).toBe("failed");
    resumeMessageQueue(cid);
    expect(isQueueHeldByInterrupt(cid)).toBe(false);
    expect(isQueuePaused(cid)).toBe(false);
    expect(queueSnapshotFor(cid)?.held).toBeNull();
    clearMessageQueue(cid);
  });

  test("hold 后再入队的新消息也被冻结住;release(直发入口)才解冻", () => {
    const cid = "q-hold-2";
    holdMessageQueue(cid);
    enqueueMessage(cid, [{ type: "text", text: "后来的" }]);
    expect(isQueueHeldByInterrupt(cid)).toBe(true);
    // 显式解冻(空闲直发入口/voice 直发入口同款)。
    releaseMessageQueueHold(cid);
    expect(isQueueHeldByInterrupt(cid)).toBe(false);
    clearMessageQueue(cid);
  });

  test("端到端:stop 打断在跑流 → 队列不接棒点火;resume 后才续跑", async () => {
    const { startFakeOpenAiSse } = await import("../test-utils/fake-openai-sse");
    const { model, provider } = await import("../model-providers");
    const { defaultState } = await import("../app-config/defaults");
    const { defaultAssistant } = await import("../assistants");

    const conv = makeConversation("c-q-stop");
    persistConversation(conv);
    registerConversation(conv);
    conv.messages.push({
      id: "c-q-stop-n1", selectIndex: 0,
      messages: [{
        id: "c-q-stop-m1", role: "USER", parts: [{ type: "text", text: "在跑" }],
        annotations: [], createdAt: new Date().toISOString(), finishedAt: null, translation: null,
      }],
    } as never);
    persistConversation(conv);

    // 剧本:第一轮带工具调用,beforeRespond 挂起(生成确在进行、流未回)期间入队并
    // 模拟用户停止——确定性制造「模型正在工作被打断」的窗口;之后的轮次若被请求到
    // = 队列错误点火,是测试的失败信号。
    const firstRespondGate = new Promise<void>(() => {});
    let releaseFirstRespond = (_: void) => {};
    void new Promise<void>((resolve) => { releaseFirstRespond = resolve; });
    const server = await startFakeOpenAiSse([
      {
        content: "正在工作",
        toolCalls: [{ id: "t1", name: "no_such_tool", arguments: "{}" }],
        beforeRespond: async () => {
          enqueueMessage(conv.id, [{ type: "text", text: "排队别跑" }]);
          await firstRespondGate; // 等测试侧完成 stop 三连后才放行第一轮流
        },
      },
      { content: "不该出现的第二轮" },
    ]);
    try {
      const ourModel = model("fake-model", "Stop Test");
      const ourProvider = provider({
        id: crypto.randomUUID(), name: "Stop Provider", baseUrl: server.baseUrl,
        apiKey: "sk-test", enabled: true, models: [ourModel],
      });
      const next = defaultState();
      next.settings.assistantId = "a1";
      next.settings.assistants = [{ ...defaultAssistant(), id: "a1" }];
      next.settings.providers = [ourProvider];
      next.settings.chatModelId = ourModel.id;
      next.settings.fastModelId = "";
      setState(next as State);

      const gen = generateAnswer(conv); // 第一轮启动(卡在 beforeRespond 门上)
      // 等首个请求抵达(生成确在进行),随后模拟用户按停止:stop 端点同款三连
      // (abort → delete 登记 → holdMessageQueue)。
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (server.requests.length >= 1) { clearInterval(timer); resolve(); }
        }, 10);
      });
      abortGeneration(conv.id, "interrupted");
      generating.delete(conv.id);
      holdMessageQueue(conv.id);
      releaseFirstRespond(); // 放行第一轮流——应立即被 abort 截断
      await gen; // 中止分支收尾:hold 已就位,finally 的派发被门控拦下

      // 队列原封不动:仍在、且被冻结。
      expect(hasQueuedMessages(conv.id)).toBe(true);
      expect(isQueueHeldByInterrupt(conv.id)).toBe(true);
      // 上游没有收到第二个请求 = 队列没有接棒点火(核心断言)。
      expect(server.requests.length).toBe(1);

      // resume 解冻:用户显式继续,队首派发点火。
      resumeMessageQueue(conv.id);
      const { dispatchMessageQueue } = await import("./orchestrator");
      dispatchMessageQueue(conv.id);
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (server.requests.length >= 2) { clearInterval(timer); resolve(); }
        }, 10);
      });
      expect(hasQueuedMessages(conv.id)).toBe(false); // 队首已派发出队
    } finally {
      await server.close();
      clearMessageQueue(conv.id);
      setState(priorState);
    }
  });

  test("端到端:接管中止(replaced)不冻结队列——即使旧流收尾抢在新流登记之前", async () => {
    const { startFakeOpenAiSse } = await import("../test-utils/fake-openai-sse");
    const { model, provider } = await import("../model-providers");
    const { defaultState } = await import("../app-config/defaults");
    const { defaultAssistant } = await import("../assistants");

    const conv = makeConversation("c-q-replaced");
    persistConversation(conv);
    registerConversation(conv);
    conv.messages.push({
      id: "c-q-replaced-n1", selectIndex: 0,
      messages: [{
        id: "c-q-replaced-m1", role: "USER", parts: [{ type: "text", text: "第一条" }],
        annotations: [], createdAt: new Date().toISOString(), finishedAt: null, translation: null,
      }],
    } as never);
    persistConversation(conv);

    // 事故窗口(2026-09-20 用户测试 1):messages 入口 abort 旧流后先 await OCR,再登记新流。
    // 旧流的 catch 若抢先执行,旧实现按「注册表里没有别的 controller」推断成打断 → 冻结
    // 队列,之后所有入队都显示「已暂停」且永不自动派发。锁定:意图 replaced 不冻结。
    let releaseFirstRespond = (_: void) => {};
    const firstRespondGate = new Promise<void>((resolve) => { releaseFirstRespond = resolve; });
    const server = await startFakeOpenAiSse([
      { content: "旧流", beforeRespond: () => firstRespondGate },
    ]);
    try {
      const ourModel = model("fake-model", "Replaced Test");
      const ourProvider = provider({
        id: crypto.randomUUID(), name: "Replaced Provider", baseUrl: server.baseUrl,
        apiKey: "sk-test", enabled: true, models: [ourModel],
      });
      const next = defaultState();
      next.settings.assistantId = "a1";
      next.settings.assistants = [{ ...defaultAssistant(), id: "a1" }];
      next.settings.providers = [ourProvider];
      next.settings.chatModelId = ourModel.id;
      next.settings.fastModelId = "";
      setState(next as State);

      const gen = generateAnswer(conv);
      await waitUntil(() => server.requests.length >= 1);
      // 写入口同款:声明 replaced 并清登记,但「新流」迟迟不登记(模拟慢 OCR 窗口)。
      abortGeneration(conv.id, "replaced");
      generating.delete(conv.id);
      enqueueMessage(conv.id, [{ type: "text", text: "接管期间入队" }]);
      releaseFirstRespond();
      await gen;

      expect(isQueueHeldByInterrupt(conv.id)).toBe(false);
      expect(isQueuePaused(conv.id)).toBe(false);
      expect(queueSnapshotFor(conv.id)?.held).toBeNull();
      // 续跑归接管方:被 replaced 的旧流收尾不派发队首(否则会抢在接管方登记之前点火,
      // 把排队消息排到用户刚发的消息之前)。排队项原地等待,上游没有第二个请求。
      expect(hasQueuedMessages(conv.id)).toBe(true);
      expect(server.requests.length).toBe(1);
    } finally {
      await server.close();
      clearMessageQueue(conv.id);
      setState(priorState);
    }
  });
});

// ── steering(用户问题②,对齐 Codex pending_input)──────────────────────
// 生成中补发的消息在「下一模型请求边界」(当前工具批结束)注入,不等整轮完成。
describe("steering 轮边界注入", () => {
  test("通道:push 幂等、drain 只取仍在 FIFO 的项、remove 按 id 剔除", () => {
    const cid = "s-chan";
    const a = enqueueMessage(cid, [{ type: "text", text: "a" }]);
    const b = enqueueMessage(cid, [{ type: "text", text: "b" }]);
    pushSteeringMessage(cid, a.id, [{ type: "text", text: "a" }]);
    pushSteeringMessage(cid, b.id, [{ type: "text", text: "b" }]);
    // 同 id 重复推送只留最新。
    pushSteeringMessage(cid, a.id, [{ type: "text", text: "a改" }]);
    // 撤回 b:drain 的 isStillQueued 过滤把它滤掉。
    removeQueuedMessage(cid, b.id);
    const drained = drainSteeringMessages(cid, (itemId) =>
      (queueSnapshotFor(cid)?.items.some((it) => it.id === itemId)) ?? false);
    expect(drained.map((it) => it.id)).toEqual([a.id]);
    expect(drained[0]!.parts[0]).toMatchObject({ text: "a改" });
    // 排水后通道为空(重复 drain 返回空)。
    expect(drainSteeringMessages(cid, () => true)).toEqual([]);
    // 编辑路径:push 后 remove 按 id 剔除。
    const c = enqueueMessage(cid, [{ type: "text", text: "c" }]);
    pushSteeringMessage(cid, c.id, [{ type: "text", text: "c" }]);
    removeSteeringMessage(cid, c.id);
    expect(drainSteeringMessages(cid, () => true)).toEqual([]);
    clearMessageQueue(cid);
    clearSteeringChannel(cid);
  });

  test("端到端:工具轮边界注入——第二个请求体里出现补发文本,队列同步移除", async () => {
    const { startFakeOpenAiSse } = await import("../test-utils/fake-openai-sse");
    const { model, provider } = await import("../model-providers");
    const { defaultState } = await import("../app-config/defaults");
    const { defaultAssistant } = await import("../assistants");

    const conv = makeConversation("c-q-steer");
    persistConversation(conv);
    registerConversation(conv);
    conv.messages.push({
      id: "c-q-steer-n1", selectIndex: 0,
      messages: [{
        id: "c-q-steer-m1", role: "USER", parts: [{ type: "text", text: "开始" }],
        annotations: [], createdAt: new Date().toISOString(), finishedAt: null, translation: null,
      }],
    } as never);
    persistConversation(conv);

    // 剧本:第一轮发一个工具调用 → 工具批执行完后循环到达 steering 边界(注入发生),
    // 第二轮作答。beforeRespond 在第一轮请求前入队+推送 steering(模拟生成中补发)。
    const server = await startFakeOpenAiSse([
      {
        content: "先查一下",
        toolCalls: [{ id: "t1", name: "no_such_tool", arguments: "{}" }],
        beforeRespond: () => {
          const item = enqueueMessage(conv.id, [{ type: "text", text: "补充:记得看最新版" }]);
          pushSteeringMessage(conv.id, item.id, [{ type: "text", text: "补充:记得看最新版" }]);
        },
      },
      { content: "好的,已结合补充看完" },
    ]);
    try {
      const ourModel = model("fake-model", "Steer Test");
      const ourProvider = provider({
        id: crypto.randomUUID(), name: "Steer Provider", baseUrl: server.baseUrl,
        apiKey: "sk-test", enabled: true, models: [ourModel],
      });
      const next = defaultState();
      next.settings.assistantId = "a1";
      next.settings.assistants = [{ ...defaultAssistant(), id: "a1" }];
      next.settings.providers = [ourProvider];
      next.settings.chatModelId = ourModel.id;
      next.settings.fastModelId = "";
      setState(next as State);

      await generateAnswer(conv); // 全程跑完(两轮请求)

      // 硬证据 1:第二个请求体的 messages 末尾有补发文本的 user turn(注入发生)。
      expect(server.requests.length).toBe(2);
      const secondBody = server.requests[1]! as { messages?: Array<{ role: string; content: string }> };
      const messages = secondBody.messages ?? [];
      const steerTurn = messages.find((m) => m.role === "user" && String(m.content).includes("记得看最新版"));
      expect(steerTurn).toBeTruthy();
      // 注入位:在工具结果(role:"tool")之后。
      const lastToolIdx = messages.map((m) => m.role).lastIndexOf("tool");
      const steerIdx = messages.indexOf(steerTurn!);
      expect(steerIdx).toBeGreaterThan(lastToolIdx);

      // 硬证据 2:补发消息已落库为 user 节点(对用户可见)。
      const steerNode = conv.messages.find((n) =>
        n.messages.some((m) => m.role === "USER" && JSON.stringify(m.parts).includes("记得看最新版")),
      );
      expect(steerNode).toBeTruthy();
      // 硬证据 3:队列已移除该项(已注入≠待触发,收尾不再派发第三轮)。
      expect(hasQueuedMessages(conv.id)).toBe(false);
      expect(server.requests.length).toBe(2); // 没有第三轮
    } finally {
      await server.close();
      clearMessageQueue(conv.id);
      clearSteeringChannel(conv.id);
      setState(priorState);
    }
  });

  test("端到端:纯文本流的最终轮也是边界——同一生成内续采样,不走收尾派发(Codex needs_follow_up)", async () => {
    const { startFakeOpenAiSse } = await import("../test-utils/fake-openai-sse");
    const { model, provider } = await import("../model-providers");
    const { defaultState } = await import("../app-config/defaults");
    const { defaultAssistant } = await import("../assistants");

    const conv = makeConversation("c-q-steer-final");
    persistConversation(conv);
    registerConversation(conv);
    conv.messages.push({
      id: "c-q-steer-final-n1", selectIndex: 0,
      messages: [{
        id: "c-q-steer-final-m1", role: "USER", parts: [{ type: "text", text: "直接回答" }],
        annotations: [], createdAt: new Date().toISOString(), finishedAt: null, translation: null,
      }],
    } as never);
    persistConversation(conv);

    const server = await startFakeOpenAiSse([
      { content: "一轮答完", beforeRespond: () => {
        const item = enqueueMessage(conv.id, [{ type: "text", text: "接着这条" }]);
        pushSteeringMessage(conv.id, item.id, [{ type: "text", text: "接着这条" }]);
      } },
      { content: "续采样的第二轮" },
    ]);
    try {
      const ourModel = model("fake-model", "FinalBoundary Test");
      const ourProvider = provider({
        id: crypto.randomUUID(), name: "FinalBoundary Provider", baseUrl: server.baseUrl,
        apiKey: "sk-test", enabled: true, models: [ourModel],
      });
      const next = defaultState();
      next.settings.assistantId = "a1";
      next.settings.assistants = [{ ...defaultAssistant(), id: "a1" }];
      next.settings.providers = [ourProvider];
      next.settings.chatModelId = ourModel.id;
      next.settings.fastModelId = "";
      setState(next as State);

      await generateAnswer(conv);
      // 第一轮请求体不含补发(它在第一轮响应期间才到达)。
      const firstBody = server.requests[0]! as { messages?: Array<{ role: string; content: string }> };
      expect((firstBody.messages ?? []).some((m) => String(m.content).includes("接着这条"))).toBe(false);
      // 同一次 generateAnswer 内发出了第二个请求(await 已返回,两轮都在其中),且第二轮
      // 请求体回放了第一轮 assistant 正文、其后紧跟补发 user turn——模型知道自己刚说过什么。
      expect(server.requests.length).toBe(2);
      const second = server.requests[1]! as { messages: Array<{ role: string; content: string; tool_calls?: unknown }> };
      const replayIdx = second.messages.findIndex((m) => m.role === "assistant" && String(m.content).includes("一轮答完"));
      const steerIdx = second.messages.findIndex((m) => m.role === "user" && String(m.content).includes("接着这条"));
      expect(replayIdx).toBeGreaterThan(-1);
      expect(steerIdx).toBe(replayIdx + 1);
      expect("tool_calls" in second.messages[replayIdx]!).toBe(false); // 无工具的回放不带 tool_calls 键
      // 数据序 [user_1, ai_1(定格), steer_user, ai_2],ai_2 正文恰为第二轮,队列已清,不再派发第三轮。
      const roles = conv.messages.map((n) => n.messages[n.selectIndex]?.role);
      expect(roles).toEqual(["USER", "ASSISTANT", "USER", "ASSISTANT"]);
      expect(textFromParts(conv.messages[1]!.messages[0]!.parts)).toBe("一轮答完");
      expect(textFromParts(conv.messages[3]!.messages[0]!.parts)).toBe("续采样的第二轮");
      expect(conv.messages[1]!.messages[0]!.finishedAt).toBeTruthy();
      expect(conv.messages[3]!.messages[0]!.finishedAt).toBeTruthy();
      expect(hasQueuedMessages(conv.id)).toBe(false);
      await new Promise((r) => setTimeout(r, 50));
      expect(server.requests.length).toBe(2);
    } finally {
      await server.close();
      clearMessageQueue(conv.id);
      clearSteeringChannel(conv.id);
      setState(priorState);
    }
  });

  test("端到端:steer 边界节点分裂——ai_1 定格 + steer user + ai_2 接管,与 Codex transcript 同构", async () => {
    const { startFakeOpenAiSse } = await import("../test-utils/fake-openai-sse");
    const { model, provider } = await import("../model-providers");
    const { defaultState } = await import("../app-config/defaults");
    const { defaultAssistant } = await import("../assistants");

    const conv = makeConversation("c-q-steer-split");
    persistConversation(conv);
    registerConversation(conv);
    conv.messages.push({
      id: "c-q-steer-split-n1", selectIndex: 0,
      messages: [{
        id: "c-q-steer-split-m1", role: "USER", parts: [{ type: "text", text: "开始" }],
        annotations: [], createdAt: new Date().toISOString(), finishedAt: null, translation: null,
      }],
    } as never);
    persistConversation(conv);

    // 剧本:第一轮带工具调用(在轮边界触发 steerBoundary 分裂),第二轮作答进 ai_2。
    const server = await startFakeOpenAiSse([
      {
        content: "先查一下",
        toolCalls: [{ id: "t1", name: "no_such_tool", arguments: "{}" }],
        beforeRespond: () => {
          const item = enqueueMessage(conv.id, [{ type: "text", text: "插话补充" }]);
          pushSteeringMessage(conv.id, item.id, [{ type: "text", text: "插话补充" }]);
        },
      },
      { content: "结合插话继续作答" },
    ]);
    try {
      const ourModel = model("fake-model", "Split Test");
      const ourProvider = provider({
        id: crypto.randomUUID(), name: "Split Provider", baseUrl: server.baseUrl,
        apiKey: "sk-test", enabled: true, models: [ourModel],
      });
      const next = defaultState();
      next.settings.assistantId = "a1";
      next.settings.assistants = [{ ...defaultAssistant(), id: "a1" }];
      next.settings.providers = [ourProvider];
      next.settings.chatModelId = ourModel.id;
      next.settings.fastModelId = "";
      setState(next as State);

      await generateAnswer(conv); // 全程跑完(两轮请求,steer 在轮边界被吸收并分裂)
      await waitUntil(() => server.requests.length >= 2);
      // 等收尾(队列已移除 steer 项,不再派发第三轮)。
      await waitUntil(() => !generating.has(conv.id));

      // 核心断言:数据序是 [user_1, ai_1, steer_user, ai_2](逐项同构 Codex
      // [assistant_r1, user_steer, assistant_r2])。延续输出落在 steer user 之后。
      const roles = conv.messages.map((n) => n.messages[n.selectIndex]?.role);
      expect(roles).toEqual(["USER", "ASSISTANT", "USER", "ASSISTANT"]);

      const ai1 = conv.messages[1]!.messages[conv.messages[1]!.selectIndex]!;
      const steerUser = conv.messages[2]!.messages[conv.messages[2]!.selectIndex]!;
      const ai2 = conv.messages[3]!.messages[conv.messages[3]!.selectIndex]!;

      // ai_1 已定格(finishedAt 落上),内容恰是分裂前的产出:首轮正文 + 工具卡。
      // 分裂后一个字节都不再进来——2026-09-20 实测事故形态就是第二轮正文继续写进
      // 已定格的 ai_1(应用器创建时解构缓存了落点),这里锁死。
      expect(ai1.role).toBe("ASSISTANT");
      expect(ai1.finishedAt).toBeTruthy();
      expect(ai1.parts.some((p) => (p as { type?: string }).type === "tool")).toBe(true);
      expect(textFromParts(ai1.parts)).toBe("先查一下");

      // steer user 是完整气泡,带 steered 注解(可选元数据)。
      expect(steerUser.role).toBe("USER");
      expect(JSON.stringify(steerUser.parts)).toContain("插话补充");
      expect((steerUser.annotations as Array<{ type?: string }>).some((a) => a.type === "steered")).toBe(true);

      // ai_2 接管后续流式:正文恰等于第二轮产出(不是跨轮累积的整段回填),已定格,
      // 无 loading 残留,不携带 ai_1 的工具 part(分裂干净)。
      expect(ai2.role).toBe("ASSISTANT");
      expect(textFromParts(ai2.parts)).toBe("结合插话继续作答");
      expect(ai2.finishedAt).toBeTruthy();
      expect(ai2.parts.some((p) => (p as { type?: string }).type === "loading")).toBe(false);
      expect(ai2.parts.some((p) => (p as { type?: string }).type === "tool")).toBe(false);

      // 队列已移除 steer 项(已注入≠待触发),没有第三轮。
      expect(hasQueuedMessages(conv.id)).toBe(false);
      expect(server.requests.length).toBe(2);
    } finally {
      await server.close();
      clearMessageQueue(conv.id);
      clearSteeringChannel(conv.id);
      setState(priorState);
    }
  });

  test("端到端:steer 落在「有工具卡但无正文」轮次——ai_1 定格保留工具足迹,延续进 ai_2", async () => {
    const { startFakeOpenAiSse } = await import("../test-utils/fake-openai-sse");
    const { model, provider } = await import("../model-providers");
    const { defaultState } = await import("../app-config/defaults");
    const { defaultAssistant } = await import("../assistants");

    const conv = makeConversation("c-q-steer-toolonly");
    persistConversation(conv);
    registerConversation(conv);
    conv.messages.push({
      id: "c-q-steer-toolonly-n1", selectIndex: 0,
      messages: [{
        id: "c-q-steer-toolonly-m1", role: "USER", parts: [{ type: "text", text: "开始" }],
        annotations: [], createdAt: new Date().toISOString(), finishedAt: null, translation: null,
      }],
    } as never);
    persistConversation(conv);

    // 剧本:第一轮直接调工具、无正文文本(content 省略)。工具卡由循环层在轮边界前建好,
    // ai_1 非空(isEmptyAssistantPlaceholder 判 false)——定格保留工具足迹,延续进 ai_2。
    // (空占位剔除那条 C2 分支在工具循环里不可达:工具卡必然先于 steerBoundary 落上,
    //  它是真实工作足迹,理应定格保留,不制造「空气泡」。)
    const server = await startFakeOpenAiSse([
      {
        toolCalls: [{ id: "t1", name: "no_such_tool", arguments: "{}" }],
        beforeRespond: () => {
          const item = enqueueMessage(conv.id, [{ type: "text", text: "抢先插话" }]);
          pushSteeringMessage(conv.id, item.id, [{ type: "text", text: "抢先插话" }]);
        },
      },
      { content: "收到插话,直接作答" },
    ]);
    try {
      const ourModel = model("fake-model", "ToolOnlySplit Test");
      const ourProvider = provider({
        id: crypto.randomUUID(), name: "ToolOnlySplit Provider", baseUrl: server.baseUrl,
        apiKey: "sk-test", enabled: true, models: [ourModel],
      });
      const next = defaultState();
      next.settings.assistantId = "a1";
      next.settings.assistants = [{ ...defaultAssistant(), id: "a1" }];
      next.settings.providers = [ourProvider];
      next.settings.chatModelId = ourModel.id;
      next.settings.fastModelId = "";
      setState(next as State);

      await generateAnswer(conv);
      await waitUntil(() => server.requests.length >= 2);
      await waitUntil(() => !generating.has(conv.id));

      // ai_1 定格(含工具卡),数据序 [user_1, ai_1(定格), steer_user, ai_2]。
      const roles = conv.messages.map((n) => n.messages[n.selectIndex]?.role);
      expect(roles).toEqual(["USER", "ASSISTANT", "USER", "ASSISTANT"]);
      const ai1 = conv.messages[1]!.messages[conv.messages[1]!.selectIndex]!;
      const steerUser = conv.messages[2]!.messages[conv.messages[2]!.selectIndex]!;
      const ai2 = conv.messages[3]!.messages[conv.messages[3]!.selectIndex]!;
      expect(ai1.finishedAt).toBeTruthy();
      expect(ai1.parts.some((p) => (p as { type?: string }).type === "tool")).toBe(true);
      expect(textFromParts(ai1.parts)).toBe(""); // 分裂后第二轮正文不得回流进 ai_1
      expect(JSON.stringify(steerUser.parts)).toContain("抢先插话");
      expect((steerUser.annotations as Array<{ type?: string }>).some((a) => a.type === "steered")).toBe(true);
      expect(textFromParts(ai2.parts)).toBe("收到插话,直接作答");
      expect(ai2.finishedAt).toBeTruthy();
    } finally {
      await server.close();
      clearMessageQueue(conv.id);
      clearSteeringChannel(conv.id);
      setState(priorState);
    }
  });
});
