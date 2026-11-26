// conversations/tail-frame.test.ts — 一轮收尾时最后一段文字先出门(PF.5)。
// 契约:收尾(输出变换、对账落库、快照、克隆)是一整段同步代码;SSE 入队的字节要等事件循环转回来才写进套接字,
// 所以光把关键帧挪到落库前面不够,要在收尾之前把挂在合帧定时器里的帧发掉并让出一个宏任务。
// 判据:带最后一段文字的第一帧入队时排一个 setTimeout(0) 探针(实测 Bun 在定时器回调之间把入队的字节写进套接字,
// 微任务与 setImmediate 都不行)。探针跑的时候收尾还没开始:生成登记还在(收尾落库前才摘)、内存里的回答没盖终点戳
// (库里的不能用——新建回答节点时先按带终点戳的初值落过一次)。之后照旧以收尾关键帧(isGenerating=false)结束。
import { afterAll, expect, test } from "bun:test";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-tail-frame-test-"));

const conversations = await import("./index");
const { configureWorkingSet, registerConversation } = await import("./working-set");
const { getConversationMeta } = await import("./read-queries");
const { generating } = await import("./generation-state");
const { generateAnswer } = await import("./orchestrator");
const { conversationClients } = await import("../api/sse");
const { defaultAssistant } = await import("../assistants");
const { defaultState } = await import("../app-config/defaults");
const { setState, state } = await import("../persistence/json-store");
const { model, provider } = await import("../model-providers");

import type { Conversation, State } from "../foundation/types";

const priorState = state;
const db = conversations.openConversationsDb();
configureWorkingSet({
  loadConversation: (convId) => {
    const meta = getConversationMeta(db, convId);
    if (!meta) return undefined;
    meta.messages = conversations.loadConversationNodesFromDb(db, convId);
    return meta;
  },
  isGenerating: (id) => generating.has(id),
  hasSseClients: () => false,
  hasDirty: () => false,
});

const LAST = "最后一段[尾]";
// 两段正文紧挨着写出:第一段走开场关键帧,第二段落进 33ms 合帧定时器,流随即结束——最后一段文字正挂在定时器里。
const upstream = http.createServer(async (req, res) => {
  for await (const _ of req) void _;
  res.writeHead(200, { "content-type": "text/event-stream" });
  const frame = (delta: object, finish: string | null = null) =>
    res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  frame({ role: "assistant", content: "前半段。" });
  frame({ content: LAST });
  frame({}, "stop");
  res.end("data: [DONE]\n\n");
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");

afterAll(async () => {
  setState(priorState);
  upstream.close();
  await once(upstream, "close");
});

test("最后一段文字在收尾落库之前出门,随后照旧是收尾关键帧", async () => {
  const ourModel = model("fake-model", "Tail Frame Model");
  const next = defaultState();
  next.settings.assistantId = "a1";
  next.settings.assistants = [{ ...defaultAssistant(), id: "a1", name: "tail-frame" }];
  next.settings.providers = [provider({ id: crypto.randomUUID(), name: "Tail Frame Provider", baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, apiKey: "sk-test", enabled: true, models: [ourModel] })];
  next.settings.chatModelId = ourModel.id;
  next.settings.fastModelId = "";
  setState(next as State);

  const now = Date.now();
  const conversation = {
    id: "tail-frame-conv",
    assistantId: "a1",
    systemPrompt: null,
    title: "已命名",
    messages: [{ id: "tail-frame-n0", selectIndex: 0, messages: [{ id: "tail-frame-m0", role: "USER", parts: [{ type: "text", text: "说两句" }], annotations: [], createdAt: new Date(now).toISOString(), finishedAt: null, translation: null }] }],
    chatSuggestions: [],
    isPinned: false,
    createAt: now,
    updateAt: now,
  } as unknown as Conversation;
  conversations.persistConversation(conversation);
  registerConversation(conversation);

  const answer = () => conversation.messages.at(-1)!.messages.at(-1)!;
  const storedFinishedAt = () => {
    const nodeId = conversation.messages.at(-1)!.id;
    const node = conversations.loadConversationNodesFromDb(db, conversation.id).find((n) => n.id === nodeId);
    return node?.messages[node.selectIndex]?.finishedAt ?? null;
  };
  const frames: Array<{ event: string; isGenerating: unknown; hasLast: boolean }> = [];
  let probe = null as { generating: boolean; finishedAt: string | null } | null;
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
  const decoder = new TextDecoder();
  ctl.enqueue = ((chunk: Uint8Array) => {
    const text = decoder.decode(chunk);
    const event = /^event: (.+)$/m.exec(text)?.[1] ?? "";
    const payload = JSON.parse(/^data: (.+)$/m.exec(text)?.[1] ?? "{}");
    const hasLast = text.includes(LAST);
    if (hasLast && !frames.some((f) => f.hasLast)) setTimeout(() => (probe = { generating: generating.has(conversation.id), finishedAt: answer().finishedAt }), 0);
    frames.push({ event, isGenerating: payload.isGenerating ?? payload.conversation?.isGenerating, hasLast });
  }) as typeof ctl.enqueue;
  conversationClients.set(conversation.id, new Set([ctl]));
  try {
    await generateAnswer(conversation);
  } finally {
    conversationClients.delete(conversation.id);
  }

  const firstLast = frames.find((f) => f.hasLast)!;
  expect(firstLast.isGenerating).toBe(true);
  expect(probe).toEqual({ generating: true, finishedAt: null });
  const lastKeyframe = frames.filter((f) => f.event === "node_update").at(-1)!;
  expect(lastKeyframe).toEqual({ event: "node_update", isGenerating: false, hasLast: true });
  expect(frames.indexOf(firstLast)).toBeLessThan(frames.indexOf(lastKeyframe));
  expect(storedFinishedAt()).toBe(answer().finishedAt);
  expect(answer().finishedAt).not.toBeNull();
}, 30_000);
