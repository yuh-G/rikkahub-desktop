// api/sse.ts — SSE 基础设施（客户端集合、事件帧、33ms 合并节流广播）
// 纪律：只负责 SSE 推送；不做持久化、不改会话数据。
// generating Map 从 conversations/generation-state 导入(生成控制已收敛到会话域)。

import type { EngineStatus, StreamHooksWithSink } from "../inference-engine/events";
import { initWorkingSetSseGuard, markConversationRowDirty, markMessageNodeDirty, scheduleThrottledConvFlush } from "../conversations";
import { initAppErrorBroadcast } from "../observability/app-errors";
import { initProviderAuthBroadcast } from "../model-providers/auth";
import type { Conversation, ConversationListInvalidateEventDto, ConversationNodeUpdateEventDto, ConversationSnapshotEventDto, ConversationTextDeltaEventDto, EngineStatusEventDto, JsonValue, MessageNode } from "../foundation/types";
import { diffFingerprints, fingerprintNode, type NodeBroadcastFingerprint } from "./node-delta";
import { conversationNegotiationToken } from "./snapshot-negotiation";
import { stripAuthSecrets } from "./auth";
import { nodeStamp, toSnapshotConversationDto } from "./snapshot-window";
import { state } from "../persistence/json-store";
import { sseHeaders } from "./request";
import { toMessageNodeDtos } from "../conversations";
import { memoryStore } from "../memory/index";
import { generating } from "../conversations/generation-state";

// Streaming clients receive a node_update per chunk. Since each update carries the full growing
// MessageNode (cumulative text), naive per-chunk broadcasts turn into O(N^2) bytes over SSE and
// browsers fall behind — the user sees "stuck then dump" instead of smooth streaming, and the stop
// button feels laggy because old events keep flushing. We coalesce broadcasts to ~30 fps while
// always flushing the final state at end-of-generation.
const STREAM_BROADCAST_INTERVAL_MS = 33;
const pendingBroadcasts = new Map<string, { conversation: Conversation; node: MessageNode; timer: ReturnType<typeof setTimeout> | null; lastFlush: number }>();
function flushNodeBroadcast(key: string) {
  const entry = pendingBroadcasts.get(key);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  entry.lastFlush = Date.now();
  broadcastNodeStreamFrame(entry.conversation, entry.node);
}
export function scheduleNodeBroadcast(conversation: Conversation, node: MessageNode) {
  const key = `${conversation.id}::${node.id}`;
  const now = Date.now();
  const existing = pendingBroadcasts.get(key);
  if (!existing) {
    pendingBroadcasts.set(key, { conversation, node, timer: null, lastFlush: now });
    broadcastNodeUpdateNow(conversation, node);
    return;
  }
  // Always keep the freshest references — the node object identity can stay but the parts mutate.
  existing.conversation = conversation;
  existing.node = node;
  const elapsed = now - existing.lastFlush;
  if (elapsed >= STREAM_BROADCAST_INTERVAL_MS) {
    flushNodeBroadcast(key);
    return;
  }
  if (existing.timer) return;
  existing.timer = setTimeout(() => flushNodeBroadcast(key), STREAM_BROADCAST_INTERVAL_MS - elapsed);
}
function clearNodeBroadcast(conversation: Conversation, node: MessageNode) {
  const key = `${conversation.id}::${node.id}`;
  const entry = pendingBroadcasts.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  pendingBroadcasts.delete(key);
}

/** R2-4+R2-6:删除会话时的 SSE 侧收尾。
 *  ① 逐 controller close 已打开的详情流——此前只摘集合,连接悬挂只收心跳直到客户端自行
 *  切走(close 后连接内建心跳在下一跳 enqueue 抛错自清,无定时器泄漏)。
 *  ② 按 `convId::` 前缀清待发节点广播——流式中删会话时 orchestrator finally 见会话已删
 *  提前 return,跳过唯一的 clearNodeBroadcast 终态点,条目连同整棵已删会话树永久驻留;
 *  挂着的 33ms 定时器若稍后触发,还会把已删会话的陈旧帧广播出去。 */
export function dropConversationSse(conversationId: string): void {
  const clients = conversationClients.get(conversationId);
  if (clients) {
    conversationClients.delete(conversationId);
    for (const client of clients) {
      try { client.close(); } catch { /* 已死连接 */ }
    }
  }
  const prefix = `${conversationId}::`;
  for (const [key, entry] of pendingBroadcasts) {
    if (key.startsWith(prefix)) {
      if (entry.timer) clearTimeout(entry.timer);
      pendingBroadcasts.delete(key);
    }
  }
}

/** R2-4:导入清库(clearWorkingSet)配对调用——全部旧实例作废,待发广播里挂着旧会话
 *  引用,定时器触发会把陈旧帧广播出去,必须整表清空。 */
export function clearAllPendingBroadcasts(): void {
  for (const entry of pendingBroadcasts.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  pendingBroadcasts.clear();
}

// ===== 连接预算纪律(1.5.0) =====
// WebView2 对同源 HTTP/1.1 仅 6 并发连接,常驻长连接每多一条,图片/上传/API 的可用
// 名额就少一个。1.0.4 前的"连接池饥饿"(多图会话/多路流式轻易打满)在重构新增
// 错误/记忆/设置三条流后复活(5 常驻 + 1 请求 = 顶满)。因此设置/记忆/错误/列表失效
// 四个应用级域合并为单一 /api/events 通道(事件名命名空间化:settings/memory/
// app_error/invalidate),全应用常驻连接固定为 2:events + 当前会话流。
// 【纪律】新增服务端推送一律并入本通道,禁止再开新的常驻 SSE 端点。
export const appClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
export const conversationClients = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();

// 0-3:两处回调注入由 bootstrap() 显式接线,不再是 import 副作用。
// - working set 驻留判据:某会话有打开的 SSE 流(界面正开着)时不清扫。在此注入而非
//   conversations/index 直接 import sse,避免 index→sse→index 循环导入。
// - 错误中心广播:通道模块(observability)不依赖 api 层,由这里把 SSE 出口喂给它。
export function initSseWiring(): void {
  initWorkingSetSseGuard((convId) => (conversationClients.get(convId)?.size ?? 0) > 0);
  initAppErrorBroadcast((entry) => {
    broadcastTo(appClients, sseFrame("app_error", { type: "app_error", error: entry }));
  });
  // 订阅供应商登录进度(方案 §4.3 三态卡片):select_method/waiting_browser/
  // waiting_device_code/exchanging/success/error/cancelled 全经此通道推给前端。
  initProviderAuthBroadcast((event) => {
    broadcastTo(appClients, sseFrame("provider_auth", event));
  });
}
const encoder = new TextEncoder();

export function sseFrame(event: string, data: JsonValue | object) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** 全面审查 4-1(P1):对集合内每个客户端安全 enqueue。死 controller(客户端已断开、
 *  cancel 回调尚未摘除的窗口内)上 enqueue 会抛 "Controller is already closed"——若发生在
 *  setTimeout 回调(33ms 节点广播)里,未捕获异常直接杀死整个 Bun 进程;发生在同步广播里
 *  则中断遍历,后续存活客户端静默丢事件。这里统一 try/catch 并把死 controller 从集合
 *  摘除(只吞不摘会让它永久驻留反复抛),对齐 heartbeat 既有的"抛错即清理"模式。 */
/** 4-6:慢客户端背压上限。enqueue 不阻塞,卡顿客户端在长流式期间会把节点帧无限堆进
 *  内存(33ms 合并只限速率不限积压)。desiredSize 每积压一帧减 1,低于 -256(约 25MB 级
 *  未消费节点帧)判定为死连接,主动 close 断开——所有 SSE 通道连接即推快照/invalidate,
 *  客户端重连后自愈,不丢终态。 */
const MAX_SSE_BACKLOG_FRAMES = 256;

function broadcastTo(
  clients: Set<ReadableStreamDefaultController<Uint8Array>> | undefined,
  frame: Uint8Array,
): void {
  if (!clients) return;
  for (const client of clients) {
    try {
      if ((client.desiredSize ?? 0) <= -MAX_SSE_BACKLOG_FRAMES) {
        clients.delete(client); // Set 迭代中 delete 是安全的
        try { client.close(); } catch { /* 已死 */ }
        continue;
      }
      client.enqueue(frame);
    } catch {
      clients.delete(client);
    }
  }
}

export function openSse(
  initial: () => Array<[string, JsonValue | object]>,
  register: (controller: ReadableStreamDefaultController<Uint8Array>) => () => void,
) {
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      cleanup = register(controller);
      for (const [event, payload] of initial()) {
        controller.enqueue(sseFrame(event, payload));
      }
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);
      cleanup = ((old) => () => {
        clearInterval(heartbeat);
        old();
      })(cleanup);
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: sseHeaders() });
}

export function broadcastSettings() {
  // 剥认证敏感字段(webPasswordHash):SSE 是下发前端的暴露面,与 settings GET 同一净化纪律。
  broadcastTo(appClients, sseFrame("settings", stripAuthSecrets(state.settings)));
}

// memory 事件(1.3.2):推送 MemorySnapshot 给前端记忆管理 UI + 待确认徽章。与 settings
// 事件分开(记忆运行时数据不属于配置,混在一起会让每次记忆变化触发全量 settings 重渲染,
// §10.3)。触发时机:任何记忆增删改 / pending 入队/解决。
export function broadcastMemoryUpdate() {
  broadcastTo(appClients, sseFrame("memory", memoryStore.getSnapshot()));
}

// mcp_health 事件(7.2):推送 MCP 连接健康快照(McpHealthSnapshot)给前端设置页状态灯。
// 与 settings 分开——健康是内存态运行时数据,不属于配置(混入会让每次探活触发全量
// settings 重渲染 + saveState 全量落盘)。快照由 mcp-health Supervisor 注入(见 initSseWiring
// 同款注入模式),避免 sse → tools/mcp-health 的反向依赖。
let mcpHealthSnapshotProvider: () => JsonValue = () => ({});
export function initMcpHealthBroadcast(provider: () => JsonValue): void {
  mcpHealthSnapshotProvider = provider;
}
export function broadcastMcpHealth() {
  broadcastTo(appClients, sseFrame("mcp_health", mcpHealthSnapshotProvider()));
}
export function mcpHealthSnapshotFrame(): [string, JsonValue | object] {
  return ["mcp_health", mcpHealthSnapshotProvider()];
}

export function broadcastList() {
  const payload: ConversationListInvalidateEventDto = { type: "invalidate", assistantId: state.settings.assistantId, timestamp: Date.now() };
  broadcastTo(appClients, sseFrame("invalidate", payload));
}

export function broadcastConversation(conversation: Conversation, event = "snapshot") {
  const payload: ConversationSnapshotEventDto = {
    type: "snapshot",
    seq: Date.now(),
    // I-2(专题2):广播快照窗口化——大会话每轮生成结束不再整体重播,见 snapshot-window.ts
    conversation: toSnapshotConversationDto(conversation, generating.has(conversation.id)),
    serverTime: Date.now(),
    negotiationToken: conversationNegotiationToken(conversation),
  };
  broadcastTo(conversationClients.get(conversation.id), sseFrame(event, payload));
  broadcastList();
}

// P5(pi 引擎):会话级瞬态引擎状态(压缩中/自动重试中)直通会话 SSE 状态条。
// 不落库、不产 part、不触碰会话列表——只在订阅该会话的前端内存里短暂存在;
// SSE 重连即重置(瞬态语义,崩溃残帧不会挂死)。低频事件,无需合帧。
export function broadcastEngineStatus(conversationId: string, status: EngineStatus) {
  const payload: EngineStatusEventDto = status; // 编译期契约:EngineStatus ≡ 线上 DTO
  broadcastTo(conversationClients.get(conversationId), sseFrame("engine-status", payload));
}

// ===== H-b(专题2):流式增量帧 =====
// "上次已广播状态"的指纹(conv::node → 指纹)。流式 flush 据此判定发 text_delta 还是
// node_update 关键帧;每个关键帧(含生成开场帧)都刷新指纹。指纹持有 O(文本) 字符串
// 引用,设上限防泄漏(超出淘汰最旧;淘汰的代价只是下一帧退化为一次关键帧)。
const MAX_NODE_FINGERPRINTS = 64;
const lastBroadcastFingerprints = new Map<string, NodeBroadcastFingerprint>();

function rememberFingerprint(key: string, fp: NodeBroadcastFingerprint | null) {
  lastBroadcastFingerprints.delete(key);
  if (!fp) return;
  if (lastBroadcastFingerprints.size >= MAX_NODE_FINGERPRINTS) {
    const oldest = lastBroadcastFingerprints.keys().next().value;
    if (typeof oldest === "string") lastBroadcastFingerprints.delete(oldest);
  }
  lastBroadcastFingerprints.set(key, fp);
}

/** 流式热路径(33ms flush)专用:能增量就发 text_delta,否则退回全量关键帧。
 *  非流式调用点一律直接走 broadcastNodeUpdate(关键帧),不经过这里。 */
function broadcastNodeStreamFrame(conversation: Conversation, node: MessageNode) {
  const key = conversation.id + "::" + node.id;
  const prev = lastBroadcastFingerprints.get(key);
  const cur = fingerprintNode(node);
  if (prev && cur) {
    const deltas = diffFingerprints(prev, cur);
    if (deltas) {
      rememberFingerprint(key, cur);
      if (deltas.length === 0) return; // 与上次广播完全一致:不发空帧
      const payload: ConversationTextDeltaEventDto = {
        type: "text_delta",
        seq: Date.now(),
        serverTime: Date.now(),
        conversationId: conversation.id,
        nodeId: node.id,
        messageId: cur.messageId,
        deltas,
        updateAt: conversation.updateAt,
        isGenerating: generating.has(conversation.id),
      };
      broadcastTo(conversationClients.get(conversation.id), sseFrame("text_delta", payload));
      return;
    }
  }
  broadcastNodeUpdateNow(conversation, node);
}

function broadcastNodeUpdateNow(conversation: Conversation, node: MessageNode) {
  // 关键帧即新基线:之后的 flush 相对它算增量。
  rememberFingerprint(conversation.id + "::" + node.id, fingerprintNode(node));
  const payload: ConversationNodeUpdateEventDto = {
    type: "node_update",
    seq: Date.now(),
    serverTime: Date.now(),
    conversationId: conversation.id,
    nodeId: node.id,
    nodeIndex: conversation.messages.findIndex((item) => item.id === node.id),
    node: toMessageNodeDtos([node])[0]!,
    stamp: nodeStamp(node),
    updateAt: conversation.updateAt,
    isGenerating: generating.has(conversation.id),
  };
  broadcastTo(conversationClients.get(conversation.id), sseFrame("node_update", payload));
  // NOTE: deliberately NOT calling broadcastList() here. This used to fire on every chunk
  // during streaming (~30 times/sec via scheduleNodeBroadcast), which made the conversation
  // list SSE issue an `invalidate` event 30x/sec, which made the frontend re-fetch
  // `/api/conversations/p?offset=0&limit=30` 30x/sec. With Chrome's 6-connection-per-host
  // limit, that storm was rapidly exhausting the frontend's HTTP connection pool, queuing
  // any other request (including the conversation-detail GET) past ky's 30s timeout. That
  // matches the user-reported "even fresh conversations stall" + "list also times out"
  // pattern that the saveState-blocking fix alone couldn't explain.
  //
  // The conversation list only needs to refresh when the metadata it actually displays
  // changes (title, isPinned, isGenerating-state-transition, last-message-preview). Per-
  // chunk content updates don't change any of those. We now call broadcastList() at
  // generation start/end (conversations/orchestrator.ts, via broadcastList /
  // broadcastConversation) and on explicit mutations (rename, pin, delete) — not on
  // every streamed chunk.
}

// Non-streaming call sites (final flush, tool approval, etc.) flush immediately so callers see
// the authoritative state without delay. Streaming hot paths go through scheduleNodeBroadcast.
export function broadcastNodeUpdate(conversation: Conversation, node: MessageNode) {
  clearNodeBroadcast(conversation, node);
  broadcastNodeUpdateNow(conversation, node);
}

export function touchStream(hooks?: StreamHooksWithSink) {
  if (!hooks?.conversation || !hooks.node) return;
  // 事件流模式下，副作用（updateAt、标脏、SSE、持久化）由协调器统一处理，
  // 这里直接返回，避免推理引擎直接触发广播/SQLite 写入。
  if (hooks.sink) return;
  hooks.conversation.updateAt = Date.now();
  // 1.2.6:流式增量写活库——只标脏当前在长的会话行(updateAt)+ 节点,200ms 合并 upsert
  // 进 SQLite。不再全量重写 state.json(会话已迁出 state.json)。N 路流式并发时各自标脏,
  // flush 时逐行 upsert,SQLite WAL 串行化。流式结束(complete/abort)再全量 reconcile。
  markConversationRowDirty(hooks.conversation.id);
  markMessageNodeDirty(hooks.conversation.id, hooks.node.id);
  scheduleThrottledConvFlush();
  scheduleNodeBroadcast(hooks.conversation, hooks.node);
}

/** 从 StreamHooks 抽取 save_memory 等工具需要的会话上下文(透传给 pending 队列做来源追溯)。
 *  hooks 在非流式路径(如 executeApprovedToolPart)可能缺失 → 返回 undefined,runSaveMemoryTool
 *  入队时降级为空 conversationId(仅丧失来源追溯,不影响核心流程)。
 *  conversationTitle 取入队时快照(与会话后续改名/删除解耦),空标题不传。 */
