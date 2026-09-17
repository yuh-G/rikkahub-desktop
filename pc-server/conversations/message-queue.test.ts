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
import { generating } from "./generation-state";
import { configureWorkingSet, registerConversation } from "./working-set";
import { setState, state } from "../persistence/json-store";
import { handleConversationRoutes } from "../api/handlers/conversations";
import { openConversationsDb, loadConversationNodesFromDb, persistConversation } from "./index";
import { getConversationMeta } from "./read-queries";
import { generateAnswer } from "./orchestrator";
import {
  clearMessageQueue,
  editQueuedMessage,
  enqueueMessage,
  hasQueuedMessages,
  isQueuePaused,
  pauseMessageQueue,
  queueLength,
  queueSnapshotFor,
  removeQueuedMessage,
  resumeMessageQueue,
  shiftNextQueued,
} from "./message-queue";

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
});

describe("queue/* 端点(单飞门控)", () => {
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

  test("生成中 enqueue → 入队(queued:true),不追加历史节点,不打断在跑流", async () => {
    const conv = makeConversation("c-q-busy");
    registerConversation(conv);
    const controller = new AbortController();
    generating.set(conv.id, controller); // 模拟在跑流
    try {
      const res = await postJson(conv.id, "queue/enqueue", { parts: [{ type: "text", text: "补一句" }] });
      expect(res!.status).toBe(202);
      const payload = (await res!.json()) as { queued: boolean; id: string };
      expect(payload.queued).toBe(true);
      // 队列收到一条,且历史未预先追加(派发时才落库),在跑流未被中止。
      expect(queueLength(conv.id)).toBe(1);
      expect(conv.messages.length).toBe(0);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      generating.delete(conv.id);
      clearMessageQueue(conv.id);
    }
  });

  test("空闲 enqueue → 直发(queued:false),用户消息本体落库,不入队", async () => {
    const conv = makeConversation("c-q-idle");
    // 直发路径会 persistConversation(需会话行在库),再经 generateAnswer 点火。
    const { persistConversation } = await import("./index");
    persistConversation(conv);
    registerConversation(conv);
    const res = await postJson(conv.id, "queue/enqueue", { parts: [{ type: "text", text: "直接发" }] });
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

  test("压缩进行中 enqueue 返回 409(与 send 同互斥,防压缩落库覆盖吞消息)", async () => {
    const conv = makeConversation("c-q-mutex");
    registerConversation(conv);
    const { compressing } = await import("./generation-state");
    compressing.set(conv.id, Date.now());
    try {
      const res = await postJson(conv.id, "queue/enqueue", { parts: [{ type: "text", text: "x" }] });
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
  async function waitUntil(cond: () => boolean, timeoutMs = 8_000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

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
      next.settings.titleModelId = "";
      next.settings.suggestionModelId = "";
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
      next.settings.titleModelId = "";
      next.settings.suggestionModelId = "";
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
