// conversations/engine-interaction.ts — 插件界面请求的应用侧(方案 §5.11,P5.5)
//
// 每次驱动调用(生成 / 压缩)建一份,经本轮绑定接到 host.interaction;调用结束 close。
// - 对话框:登记进会话的界面状态并广播(engine-ui),等待复用审批门的等待者登记表(键 = requestId),
//   用户经 POST /ui-response 回答。中止、轮次收尾的兜底清扫(clearToolApprovalWaiters)都按取消回答。
//   等待期间与审批同一个「等待用户」状态(侧栏点、状态条、桌面通知),摘要是对话框标题。
// - 通知单发(engine-notify);状态条目 / 挂件按 (来源, key) 覆盖,进行中提示单值,变化即广播整份状态。
// 全部瞬态:只在内存,不落库、不进快照与备份;会话流连接时补发当前状态,close 时整份清掉。

import type { EngineUiStateEventDto } from "../foundation/types";
import type { GenerationEventSink } from "../inference-engine/events";
import { resolveToolApproval, waitForToolApproval, type ToolApprovalDecision } from "../inference-engine/approval-gate";
import type { EngineDialogAnswer, EngineDialogRequest, EngineHost } from "../engines/contract";
import { broadcastEngineNotify, broadcastEngineUi } from "../api/sse";
import { awaitingApproval } from "./generation-state";

interface UiState {
  dialogs: Map<string, { source: string; request: EngineDialogRequest; startedAt: number }>;
  statuses: Map<string, { source: string; key: string; text: string }>;
  widgets: Map<string, { source: string; key: string; lines: string[] }>;
  working: string | null;
}

const live = new Map<string, UiState>();

function snapshotOf(conversationId: string, ui: UiState): EngineUiStateEventDto {
  return {
    conversationId,
    dialogs: [...ui.dialogs].map(([requestId, dialog]) => ({ requestId, ...dialog })),
    statuses: [...ui.statuses.values()],
    widgets: [...ui.widgets.values()],
    working: ui.working,
  };
}

const isEmpty = (ui: UiState) => !ui.dialogs.size && !ui.statuses.size && !ui.widgets.size && ui.working === null;

/** 会话流连接时补发。没有任何插件界面时为 null。 */
export function engineUiSnapshot(conversationId: string): EngineUiStateEventDto | null {
  const ui = live.get(conversationId);
  return ui && !isEmpty(ui) ? snapshotOf(conversationId, ui) : null;
}

/** 对话框的答案按类型校验(select / input 是字符串,confirm 是布尔)。查不到在等的对话框返回 null。 */
export function pendingEngineDialogKind(conversationId: string, requestId: string): EngineDialogRequest["kind"] | null {
  return live.get(conversationId)?.dialogs.get(requestId)?.request.kind ?? null;
}

/** 回答被 approval-gate 送达时的编码:cancelled = 未放行;答案放在 answer 里(JSON)。 */
export function engineDialogDecision(answer: EngineDialogAnswer): ToolApprovalDecision {
  return answer.cancelled ? { approved: false } : { approved: true, answer: JSON.stringify(answer.value) };
}

function answerOf(decision: ToolApprovalDecision): EngineDialogAnswer {
  if (!decision.approved || decision.answer === undefined) return { cancelled: true };
  const value: unknown = JSON.parse(decision.answer);
  return typeof value === "string" || typeof value === "boolean" ? { cancelled: false, value } : { cancelled: true };
}

const summaryOf = (request: EngineDialogRequest) => request.title.trim().slice(0, 120);

export interface EngineInteractionSession extends Pick<EngineHost, "interaction"> {
  close(): void;
}

/** sink 不给 = 不进「等待用户」状态(压缩:状态条正显示「压缩中」,不能被它清掉)。 */
export function createEngineInteraction(conversationId: string, sink: GenerationEventSink | null, signal?: AbortSignal): EngineInteractionSession {
  const ui: UiState = { dialogs: new Map(), statuses: new Map(), widgets: new Map(), working: null };
  live.set(conversationId, ui);
  let closed = false;
  const publish = () => {
    if (!closed) broadcastEngineUi(snapshotOf(conversationId, ui));
  };
  const entryKey = (source: string, key: string) => JSON.stringify([source, key]);

  function setAwaiting(summary: string | null): void {
    if (!sink) return;
    if (summary === null) {
      awaitingApproval.delete(conversationId);
      sink({ kind: "engine_status", status: { busy: false } });
      return;
    }
    const startedAt = Date.now();
    awaitingApproval.set(conversationId, { startedAt, ...(summary ? { summary } : {}) });
    sink({ kind: "engine_status", status: { busy: true, phase: "awaiting_approval", startedAt, ...(summary ? { summary } : {}) } });
  }

  return {
    interaction: {
      async dialog(call) {
        if (closed || signal?.aborted) return { cancelled: true };
        ui.dialogs.set(call.requestId, { source: call.source, request: call.request, startedAt: Date.now() });
        publish();
        setAwaiting(summaryOf(call.request));
        try {
          return answerOf(await waitForToolApproval(conversationId, call.requestId, signal));
        } catch {
          // 等待只会以中止 / 收尾清扫 / 同键顶替被拒绝,三者对插件都是「取消」。
          return { cancelled: true };
        } finally {
          if (ui.dialogs.delete(call.requestId)) publish();
          const next = [...ui.dialogs.values()].at(-1);
          if (!closed) setAwaiting(next ? summaryOf(next.request) : null);
        }
      },
      dismiss(call) {
        if (!ui.dialogs.has(call.requestId)) return;
        // 引擎侧已按取消回答了插件;唤醒这边的等待,收起对话框。
        resolveToolApproval(conversationId, call.requestId, { approved: false });
      },
      show(call) {
        if (closed) return;
        const { notice, source } = call;
        switch (notice.kind) {
          case "notify":
            broadcastEngineNotify({ conversationId, source, message: notice.message, level: notice.level });
            return;
          case "status":
            if (notice.text === null) ui.statuses.delete(entryKey(source, notice.key));
            else ui.statuses.set(entryKey(source, notice.key), { source, key: notice.key, text: notice.text });
            break;
          case "widget":
            if (notice.lines === null) ui.widgets.delete(entryKey(source, notice.key));
            else ui.widgets.set(entryKey(source, notice.key), { source, key: notice.key, lines: notice.lines });
            break;
          case "working":
            ui.working = notice.text;
            break;
        }
        publish();
      },
    },
    close() {
      if (closed) return;
      const hadContent = !isEmpty(ui);
      closed = true;
      if (live.get(conversationId) === ui) live.delete(conversationId);
      // 还开着的对话框按取消回答(等待的续体在 closed 之后才跑,不再广播)。
      if (ui.dialogs.size && sink) awaitingApproval.delete(conversationId);
      for (const requestId of ui.dialogs.keys()) resolveToolApproval(conversationId, requestId, { approved: false });
      if (hadContent) broadcastEngineUi({ conversationId, dialogs: [], statuses: [], widgets: [], working: null });
    },
  };
}
