// ===== 会话详情订阅生命周期(conversation-store 的命令式搭档) =====
//
// 引用计数的按会话 SSE 订阅:refCount 0→1 开流,1→0 关流(带 50ms 微延迟,容忍
// StrictMode 双挂载的 acquire→release→acquire,避免开发模式断连重连抖动;生产无
// 行为差异)。分栏下两个窗格打开同一会话时共享一条流。传输被隔离在
// acquire/release 之后 —— 届时若因 WebView2 六连接预算改走多路复用通道,只动本
// 模块,不触碰任何组件。
//
// 元数据桥(D 族写侧分类):快照/增量/轮询落地后,仅当**列表展示字段**
// (title/isPinned/isGenerating)变化才向监听方(会话列表)广播摘要 —— 纯内容增量
// (每 33ms 一帧的流式 chunk)不再打到侧边栏,列表重建从 30Hz 降到"开始/结束/
// 标题生成"各一次。广播携带最新 createAt/updateAt,流式结束帧照常修正排序依据。
//
// SSE 消息/错误语义逐条继承自原 routes/conversations.tsx 的 useConversationDetail,
// 行为保真清单见 tmp_doc/专题1-D族-细粒度订阅store方案。
import * as React from "react";

import { toast } from "sonner";

import i18n from "~/i18n";
import api, { ApiError, sse } from "~/services/api";
import { useAppStore } from "~/stores/app-store";
import {
  applyConversationNodesPage,
  applyConversationNodesRangeReplace,
  applyConversationNodeUpdate,
  applyConversationSnapshot,
  applyConversationSnapshotMeta,
  applyConversationTextDelta,
  applyPolledConversationSnapshot,
  releaseConversationEntry,
  retainConversationEntry,
  setConversationEngineStatus,
  setConversationError,
  setConversationSubscribing,
  useConversationStore,
} from "~/stores/conversation-store";
import type {
  ConversationDto,
  ConversationErrorEventDto,
  ConversationNodesPageDto,
  ConversationNodeUpdateEventDto,
  ConversationSnapshotEventDto,
  ConversationSnapshotMetaEventDto,
  ConversationTextDeltaEventDto,
  EngineStatusEventDto,
} from "~/types";

export type ConversationStreamEvent =
  | ConversationSnapshotEventDto
  | ConversationSnapshotMetaEventDto
  | ConversationNodeUpdateEventDto
  | ConversationTextDeltaEventDto
  | ConversationErrorEventDto;

export interface ConversationSummaryUpdate {
  id: string;
  title: string;
  isPinned: boolean;
  createAt: number;
  updateAt: number;
  isGenerating: boolean;
}

export function toConversationSummaryUpdate(
  conversation: ConversationDto,
): ConversationSummaryUpdate {
  return {
    id: conversation.id,
    title: conversation.title,
    isPinned: conversation.isPinned,
    createAt: conversation.createAt,
    updateAt: conversation.updateAt,
    isGenerating: conversation.isGenerating,
  };
}

/**
 * 元数据桥的广播闸门:只看列表展示字段。纯内容增量(仅 messages/updateAt 变)返回
 * false —— 流式期间列表位次本就不该抖动,更新时间在下一次真广播(生成结束帧
 * isGenerating 跳变)时一并带到。标题生成的打字机效果(每帧 title 变化)照常放行。
 */
export function shouldBroadcastConversationSummary(
  prev: ConversationDto | null,
  next: ConversationDto,
): boolean {
  if (!prev) return true;
  if (prev === next) return false;
  return (
    prev.title !== next.title ||
    prev.isPinned !== next.isPinned ||
    prev.isGenerating !== next.isGenerating
  );
}

const summaryListeners = new Set<(update: ConversationSummaryUpdate) => void>();

/** 会话列表注册摘要监听(对齐 services/app-events.ts 的监听器集合模式)。 */
export function onConversationSummaryChange(
  listener: (update: ConversationSummaryUpdate) => void,
): () => void {
  summaryListeners.add(listener);
  return () => {
    summaryListeners.delete(listener);
  };
}

function emitSummaryChange(update: ConversationSummaryUpdate): void {
  for (const listener of summaryListeners) {
    // 故障隔离:单个监听方抛错不得中断流处理(同 app-events 的 dispatch)。
    try {
      listener(update);
    } catch (error) {
      console.error("Conversation summary listener error:", error);
    }
  }
}

function getDetail(id: string): ConversationDto | null {
  return useConversationStore.getState().entries[id]?.detail ?? null;
}

/** 包裹一次写入:落地前后对比展示字段,通过闸门才广播;透传写入结果。 */
function withSummaryBridge<T>(id: string, write: () => T): T {
  const prev = getDetail(id);
  const result = write();
  const next = getDetail(id);
  if (next && shouldBroadcastConversationSummary(prev, next)) {
    emitSummaryChange(toConversationSummaryUpdate(next));
  }
  return result;
}

interface StreamRecord {
  refCount: number;
  /** 当前连接;重启即换新 AbortController,迟到回调按引用比对丢弃。 */
  controller: AbortController | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  closeTimer: ReturnType<typeof setTimeout> | null;
  /** 注意力节奏:无人贴底观看时攒批的流式增量帧(见 records 下方注释)。 */
  pendingDeltas: ConversationTextDeltaEventDto[];
  deltaFlushTimer: ReturnType<typeof setTimeout> | null;
}

const records = new Map<string, StreamRecord>();

// ===== 流式增量的注意力节奏(用户反馈:流式输出表格/大块时滚动看别处掉到 ~15fps)=====
// 根因:text_delta 每帧(服务端 33ms 节流)同步落地,正在生长的巨型块(表格没有
// 代码块那样的增量渲染通道)整块重渲 + 整表重排,30Hz 持续占用主线程;贴底观看时
// 掉帧不可感,一旦滚动查看其他位置,滚动处理与条目挂载抢不到帧预算,卡顿立现。
// 对策:只有"当前会话且贴底"的观看者需要逐帧;其余(滚离底部、后台生成中的会话)
// 攒批 250ms 按序一次性落地——同一宏任务内的多次 setState 被 React 自动合批,巨型
// 块每 250ms 只重渲一次。正确性锚点:node_update(节点级权威帧)与轮询快照落地前
// 先 flush 攒批保序;snapshot(连接首帧全量权威)直接作废攒批;重启/关闭清空。
const UNFOCUSED_DELTA_FLUSH_MS = 250;
let attentionConversationId: string | null = null;

/** 路由上报"贴底观看中"的会话;null = 无人贴底。回到贴底立即补齐攒批。 */
export function setConversationStreamAttention(id: string | null): void {
  attentionConversationId = id;
  if (!id) return;
  const record = records.get(id);
  if (record) flushPendingDeltas(id, record);
}

function clearPendingDeltas(record: StreamRecord): void {
  record.pendingDeltas.length = 0;
  if (record.deltaFlushTimer !== null) {
    clearTimeout(record.deltaFlushTimer);
    record.deltaFlushTimer = null;
  }
}

/** 按序落地攒批;任何一帧分叉/无快照即重启流(重启清空攒批,重连首帧拿全量)。 */
function flushPendingDeltas(id: string, record: StreamRecord): void {
  if (record.deltaFlushTimer !== null) {
    clearTimeout(record.deltaFlushTimer);
    record.deltaFlushTimer = null;
  }
  if (record.pendingDeltas.length === 0) return;
  const batch = record.pendingDeltas.splice(0);
  for (const frame of batch) {
    const outcome = withSummaryBridge(id, () => applyConversationTextDelta(frame));
    if (outcome === "no_detail" || outcome === "resync") {
      queueMicrotask(() => {
        if (records.get(id) === record) restartStream(id, record);
      });
      return;
    }
  }
  syncPolling(id, record);
}

// I-1(专题2)快照协商:snapshot 帧携带的不透明令牌,与其对应的 updateAt 成对缓存。
// 重开流时仅当缓存 detail 的 updateAt 仍等于成对 updateAt(其间没有增量帧推进)才
// 回传令牌;服务端命中则首帧只发轻量 snapshot_meta,大会话"切走再切回"不再整体重传。
// 强制刷新(refreshConversation)与分叉重同步(resync)一律跳过协商,保证拿到全量。
const MAX_NEGOTIATION_TOKENS = 64;
const negotiationTokens = new Map<string, { updateAt: number; token: string }>();

function rememberNegotiationToken(id: string, updateAt: number, token: string): void {
  negotiationTokens.delete(id);
  if (negotiationTokens.size >= MAX_NEGOTIATION_TOKENS) {
    const oldest = negotiationTokens.keys().next().value;
    if (typeof oldest === "string") negotiationTokens.delete(oldest);
  }
  negotiationTokens.set(id, { updateAt, token });
}

function negotiationTokenFor(id: string): string | null {
  const pair = negotiationTokens.get(id);
  const detail = getDetail(id);
  if (!pair || !detail || detail.updateAt !== pair.updateAt) return null;
  return pair.token;
}

const RELEASE_GRACE_MS = 50;
// SSE 是主路径,轮询只是"丢帧兜底"。原 2s 全量快照拉取会与 SSE 增量打架
// (旧快照可能覆盖新帧,现由 R7-3 单调守卫拦截),且每轮反序列化整个对话在长会话
// 上开销显著;10s 既保留兜底,又把开销压到可忽略。
const GENERATING_POLL_INTERVAL_MS = 10_000;

// 测试注入缝:默认走真实 sse/api,单测替换为脚本化传输(不 mock 全局模块,
// 避免污染同进程的其它测试文件)。
const defaultFetchSnapshot = (id: string): Promise<ConversationDto> =>
  api.get<ConversationDto>(`conversations/${id}`);
const defaultFetchNodesPage = (id: string, before: number, beforeId: string, limit?: number): Promise<ConversationNodesPageDto> =>
  api.get<ConversationNodesPageDto>(`conversations/${id}/nodes`, {
    searchParams: limit ? { before, beforeId, limit } : { before, beforeId },
  });
let transport: typeof sse = sse;
let fetchConversationSnapshot = defaultFetchSnapshot;
let fetchConversationNodesPage = defaultFetchNodesPage;

/** 流式期间起 10s 轮询兜底;isGenerating 结束或流关闭即停(幂等,可反复调用)。 */
function syncPolling(id: string, record: StreamRecord): void {
  const generating = record.controller !== null && getDetail(id)?.isGenerating === true;
  if (generating && record.pollTimer === null) {
    record.pollTimer = setInterval(() => {
      void fetchConversationSnapshot(id)
        .then((data) => {
          if (records.get(id) !== record) return;
          // 先补齐攒批:本地 updateAt 才是当前值,R7-3 单调守卫的陈旧判定不失真
          flushPendingDeltas(id, record);
          withSummaryBridge(id, () => {
            applyPolledConversationSnapshot(data);
          });
          syncPolling(id, record);
        })
        .catch(() => {
          // SSE remains the primary path; polling is only a recovery path for missed frames.
        });
    }, GENERATING_POLL_INTERVAL_MS);
    return;
  }
  if (!generating && record.pollTimer !== null) {
    clearInterval(record.pollTimer);
    record.pollTimer = null;
  }
}

function openStream(id: string, record: StreamRecord, options?: { negotiate?: boolean }): void {
  const controller = new AbortController();
  record.controller = controller;
  setConversationSubscribing(id, true);
  setConversationError(id, null);
  // 引擎状态以"最新帧覆盖"为准:重连时清掉旧残影(断连期间错过 busy:false 帧
  // 不能让"压缩中"挂死),但连接建立与 openSse 入队连接期快照帧(压缩/审批注册表
  // 补发,域4-1)天然有先后——快照帧一到达即覆盖回真实状态,无竞态窗口。
  setConversationEngineStatus(id, { busy: false });

  // 唯一数据路径:SSE 连接首帧即全量快照(服务端 openSse 保证),不发并行 GET
  // (连接预算纪律,见 services/app-events.ts 顶部注释)。
  const token = options?.negotiate === false ? null : negotiationTokenFor(id);
  void transport<ConversationStreamEvent>(
    token ? `conversations/${id}/stream?token=${encodeURIComponent(token)}` : `conversations/${id}/stream`,
    {
      onMessage: ({ event, data }) => {
        if (record.controller !== controller) return;

        if (event === "error" && data.type === "error") {
          toast.error(data.message);
          return;
        }

        // pi 引擎瞬态状态(P5):载荷无 type 字段(非快照/增量协议成员),按事件名分流。
        // 只进 engineStatus 侧栈,不触碰 detail/协商/轮询。
        if (event === "engine-status") {
          setConversationEngineStatus(id, data as unknown as EngineStatusEventDto);
          return;
        }

        if (event === "snapshot" && data.type === "snapshot") {
          useAppStore.getState().setClockOffset(data.serverTime);
          clearPendingDeltas(record); // 全量权威快照已包含增量,攒批作废(防御性)
          const staleRange = withSummaryBridge(id, () => applyConversationSnapshot(data.conversation));
          rememberNegotiationToken(id, data.conversation.updateAt, data.negotiationToken);
          if (staleRange) void repairStaleNodes(id, staleRange.from, staleRange.to);
          syncPolling(id, record);
          return;
        }

        if (event === "snapshot_meta" && data.type === "snapshot_meta") {
          useAppStore.getState().setClockOffset(data.serverTime);
          const metaOutcome = withSummaryBridge(id, () => applyConversationSnapshotMeta(data));
          if (metaOutcome === "no_detail") {
            // 缓存在协商发出后被淘汰(理论窗口):重启流拿全量。
            queueMicrotask(() => {
              if (record.controller === controller) restartStream(id, record);
            });
            return;
          }
          rememberNegotiationToken(id, data.updateAt, data.negotiationToken);
          syncPolling(id, record);
          return;
        }

        if (event === "text_delta" && data.type === "text_delta") {
          useAppStore.getState().setClockOffset(data.serverTime);
          // 注意力节奏:无人贴底观看本会话 -> 只攒批,定时器到点统一按序落地
          if (attentionConversationId !== id) {
            record.pendingDeltas.push(data);
            if (record.deltaFlushTimer === null) {
              record.deltaFlushTimer = setTimeout(() => {
                record.deltaFlushTimer = null;
                const run = () => {
                  if (records.get(id) === record) flushPendingDeltas(id, record);
                };
                // 到点后再让一个空闲片:落地渲染(巨型块整块重渲)避开正在进行的
                // 滚动帧,消除有节奏的顿挫;浏览器持续无空闲则按同长兜底强刷。
                if (typeof requestIdleCallback === "function") {
                  requestIdleCallback(run, { timeout: UNFOCUSED_DELTA_FLUSH_MS });
                } else {
                  run();
                }
              }, UNFOCUSED_DELTA_FLUSH_MS);
            }
            return;
          }
          const deltaOutcome = withSummaryBridge(id, () => applyConversationTextDelta(data));
          if (deltaOutcome === "no_detail" || deltaOutcome === "resync") {
            // 无快照可打增量 / 与服务端分叉(丢帧、结构漂移):重启流拿全量快照,
            // 增量协议的正确性锚点(见 lib/conversation-sync.ts applyTextDelta)。
            queueMicrotask(() => {
              if (record.controller === controller) restartStream(id, record);
            });
            return;
          }
          syncPolling(id, record);
          return;
        }

        if (event !== "node_update" || data.type !== "node_update") return;

        useAppStore.getState().setClockOffset(data.serverTime);
        // 保序:攒批增量比本权威帧旧,先放后补会 baseLen 失配误判分叉
        flushPendingDeltas(id, record);
        const outcome = withSummaryBridge(id, () => applyConversationNodeUpdate(data));
        if (outcome === "no_detail") {
          // 本地尚无快照可打增量:重启流拿全量(原 useConversationDetail 的
          // refreshNonce 重订阅语义;服务端连接首帧必推快照)。
          queueMicrotask(() => {
            if (record.controller === controller) restartStream(id, record);
          });
          return;
        }
        syncPolling(id, record);
      },
      onError: (streamError) => {
        if (record.controller !== controller) return;
        // sse() 对 4xx(除 408/429)停止重连:404 = 会话尚不存在,按"暂无会话"处理;
        // 其余致命 4xx 呈现错误(否则断流后界面永远停在加载态)。
        // 可自愈的网络错/5xx 由 sse() 内建重连兜底,不打扰用户。
        const fatal =
          streamError instanceof ApiError &&
          streamError.code >= 400 &&
          streamError.code < 500 &&
          streamError.code !== 408 &&
          streamError.code !== 429;
        if (fatal && streamError instanceof ApiError && streamError.code === 404) {
          setConversationSubscribing(id, false);
          return;
        }
        if (fatal) {
          setConversationError(
            id,
            streamError.message || i18n.t("page:conversations.errors.load_detail_failed"),
          );
          setConversationSubscribing(id, false);
          return;
        }
        console.error("Conversation detail SSE error:", streamError);
      },
    },
    { signal: controller.signal },
  );
}

function restartStream(id: string, record: StreamRecord): void {
  record.controller?.abort();
  clearPendingDeltas(record); // 重连首帧全量快照已包含一切,攒批作废
  // 重启都是"本地状态存疑"场景(no_detail/resync/强制刷新):跳过协商拿全量快照。
  openStream(id, record, { negotiate: false });
}

function closeStream(id: string, record: StreamRecord): void {
  records.delete(id);
  if (record.closeTimer !== null) {
    clearTimeout(record.closeTimer);
    record.closeTimer = null;
  }
  record.controller?.abort();
  record.controller = null;
  clearPendingDeltas(record);
  if (record.pollTimer !== null) {
    clearInterval(record.pollTimer);
    record.pollTimer = null;
  }
  setConversationEngineStatus(id, { busy: false }); // 无订阅即无来源,不留残影
  releaseConversationEntry(id);
}

function releaseStream(id: string, record: StreamRecord): void {
  record.refCount -= 1;
  if (record.refCount > 0 || record.closeTimer !== null) return;
  // StrictMode 双挂载容忍:微延迟真正关闭,期间再 acquire 则取消关闭。
  record.closeTimer = setTimeout(() => {
    record.closeTimer = null;
    if (record.refCount > 0) return;
    closeStream(id, record);
  }, RELEASE_GRACE_MS);
}

/**
 * 持有一个会话的详情流:首个引用开 SSE,同会话后续引用共享;返回幂等的 release。
 * 有活跃引用期间该会话 entry 不参与 store 的 LRU 淘汰。
 */
export function acquireConversationStream(id: string): () => void {
  let record = records.get(id);
  if (record) {
    record.refCount += 1;
    if (record.closeTimer !== null) {
      clearTimeout(record.closeTimer);
      record.closeTimer = null;
    }
  } else {
    record = {
      refCount: 1,
      controller: null,
      pollTimer: null,
      closeTimer: null,
      pendingDeltas: [],
      deltaFlushTimer: null,
    };
    records.set(id, record);
    retainConversationEntry(id);
    openStream(id, record);
  }
  const held = record;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseStream(id, held);
  };
}

/**
 * 强制重取(等价原 refreshDetail):重启流,重连首帧即全量快照。
 * 用于翻译/压缩/系统提示词保存/标题重生成等"后端已改,立即要新快照"的场景;
 * 无活跃订阅时为空操作(所有调用点都在会话打开期间)。
 */
export function refreshConversation(id: string): void {
  const record = records.get(id);
  if (!record) return;
  restartStream(id, record);
}

// ===== I-2(专题2)窗口化快照的两个命令式入口 =====

const olderNodesInFlight = new Set<string>();

/**
 * 向上翻页:拉取当前窗口之前的一片节点并拼接(Virtuoso startReached 触发)。
 * 已在拉取中/已到头(nodesOffset=0)则空操作。分片与本地窗口不再紧邻("stale")
 * 或服务端报结构漂移(409)时重开流自愈——拿新窗口化快照与清单,永不硬拼。
 */
export async function loadOlderConversationNodes(id: string): Promise<void> {
  const detail = getDetail(id);
  const offset = detail?.nodesOffset ?? 0;
  const beforeId = detail?.messages[0]?.id;
  if (!detail || offset === 0 || !beforeId || olderNodesInFlight.has(id)) return;
  olderNodesInFlight.add(id);
  try {
    const page = await fetchConversationNodesPage(id, offset, beforeId);
    const outcome = applyConversationNodesPage(id, page);
    if (outcome === "stale") refreshConversation(id);
  } catch (loadError) {
    if (loadError instanceof ApiError && loadError.code === 409) {
      refreshConversation(id);
    } else {
      // 网络类失败静默:用户继续滚动会自然重试
      console.error("Load older conversation nodes failed:", loadError);
    }
  } finally {
    olderNodesInFlight.delete(id);
  }
}

const staleRepairInFlight = new Set<string>();

/**
 * 陈旧前缀修复(bug1 根修,与 lib/conversation-sync.ts mergeConversationSnapshot 配套):
 * 窗口化快照合并时发现 [from, to) 的本地节点与服务端分叉,但为了不让 react-virtuoso
 * 遭遇 firstItemIndex 原地增大(尺寸树错乱 → 底部幽灵空白),旧内容被原样保留。
 * 这里从 `to` 锚点向下逐分片拉权威版本原地替换。任何失配(409/越界/窗口漂移)都
 * 直接放弃——下一次快照合并会重新报脏,永不硬拼。
 */
async function repairStaleNodes(id: string, from: number, to: number): Promise<void> {
  if (staleRepairInFlight.has(id)) return;
  staleRepairInFlight.add(id);
  try {
    let cursor = to;
    while (cursor > from) {
      const detail = getDetail(id);
      if (!detail) return;
      const anchorId = detail.messages[cursor - (detail.nodesOffset ?? 0)]?.id;
      if (!anchorId) return;
      // limit 夹在待修区间内,分片不越过已加载窗口下界(replaceNodesRange 越界即拒)
      const page = await fetchConversationNodesPage(id, cursor, anchorId, Math.min(cursor - from, 200));
      if (page.nodes.length === 0) return;
      const outcome = withSummaryBridge(id, () => applyConversationNodesRangeReplace(id, page));
      if (outcome !== "applied") return;
      cursor = page.offset;
    }
  } catch (repairError) {
    // 网络失败静默:内容仍是可读的旧版,下一次快照会重新触发修复
    console.error("Repair stale conversation nodes failed:", repairError);
  } finally {
    staleRepairInFlight.delete(id);
  }
}

/**
 * 需要完整历史的场景(导出/分享/搜索定位未加载节点)按需拉全量:REST 详情端点
 * 保持全量语义(见服务端注释)。返回拉取后的 detail;拿不到完整历史(网络失败)
 * 返回 null,调用方必须放弃操作而不是拿窗口截断的数据继续——数据完整性红线。
 */
export async function ensureFullConversationDetail(id: string): Promise<ConversationDto | null> {
  const detail = getDetail(id);
  if (detail && (detail.nodesOffset ?? 0) === 0) return detail;
  try {
    const data = await fetchConversationSnapshot(id);
    withSummaryBridge(id, () => {
      applyPolledConversationSnapshot(data);
    });
    // A2(专题2复查):生成期间 SSE 每帧(33ms)推进本地 updateAt,上面的全量快照在
    // GET 在途的几十 ms 内几乎必被 R7-3 单调守卫判陈旧拒收 → 旧实现直接返回 null,
    // 窗口化会话的导出/分享/搜索定位在生成中稳定失败。本函数的目的只是补全
    // [0, nodesOffset) 的历史前缀——前缀不随生成变化,守卫拒收后从(整体上"陈旧"的)
    // 全量快照切出前缀,按翻页分片语义拼接(applyConversationNodesPage 内部复检
    // 紧邻性,窗口在途漂移则 stale 空操作)。缝合点 id 对不上说明窗口结构变了,
    // 维持失败语义,调用方按数据完整性红线放弃操作。
    const current = getDetail(id);
    const offset = current?.nodesOffset ?? 0;
    if (current && offset > 0 && data.messages[offset]?.id === current.messages[0]?.id) {
      applyConversationNodesPage(id, {
        nodes: data.messages.slice(0, offset),
        stamps: (data.nodeStamps ?? []).slice(0, offset),
        offset: 0,
        updateAt: data.updateAt,
      });
    }
  } catch (fetchError) {
    console.error("Ensure full conversation detail failed:", fetchError);
    return null;
  }
  const next = getDetail(id);
  return next && (next.nodesOffset ?? 0) === 0 ? next : null;
}

/** React 侧订阅:挂载期间持有该会话的流(分栏 = 每窗格各挂一份,同会话自动共享)。 */
export function useConversationSubscription(id: string | null): void {
  React.useEffect(() => {
    if (!id) return;
    return acquireConversationStream(id);
  }, [id]);
}

/** 测试专用:注入脚本化传输/快照拉取。 */
export function installConversationStreamTestSeam(seam: {
  transport?: typeof sse;
  fetchConversationSnapshot?: (id: string) => Promise<ConversationDto>;
  fetchConversationNodesPage?: (id: string, before: number, beforeId: string, limit?: number) => Promise<ConversationNodesPageDto>;
}): void {
  if (seam.transport) transport = seam.transport;
  if (seam.fetchConversationSnapshot) fetchConversationSnapshot = seam.fetchConversationSnapshot;
  if (seam.fetchConversationNodesPage) fetchConversationNodesPage = seam.fetchConversationNodesPage;
}

/** 测试专用:关断全部流、清空监听与注入。 */
export function resetConversationStreamForTest(): void {
  // closeStream 会从 records 删除自身条目,按首元素消费直到清空
  while (records.size > 0) {
    const [id, record] = records.entries().next().value!;
    closeStream(id, record);
  }
  summaryListeners.clear();
  negotiationTokens.clear();
  attentionConversationId = null;
  transport = sse;
  fetchConversationSnapshot = defaultFetchSnapshot;
  fetchConversationNodesPage = defaultFetchNodesPage;
}
