// inference-engine/parts.ts — 流式消息 part 操作辅助
// 纪律：只负责单个 Message 的 part 增删/改写，不直接写 state.json、不广播 SSE。
// 调用方通过 hooks.sink 把事件交给协调器处理。

import type { JsonValue, Message, ReasoningPart, ToolPart } from "../foundation/types";
import { isRecord } from "../foundation/utils";

export function setMessageLoading(msg: Message, label = "正在生成回复") {
  if (msg.parts.length > 0) return;
  msg.parts = [{ type: "loading", label }];
}

/** 摘除 loading 占位(setMessageLoading 的逆操作)。生成终局与 stop 端点共用:占位的
 *  渲染不依赖 isGenerating,不摘就会在已完结消息上永久残留打字点。幂等。 */
export function stripLoadingPlaceholder(msg: Message) {
  if (!msg.parts.some((part) => isRecord(part) && part.type === "loading")) return;
  msg.parts = msg.parts.filter((part) => !(isRecord(part) && part.type === "loading"));
}

export function finishReasoningParts(msg: Message) {
  const now = new Date().toISOString();
  msg.parts = msg.parts.map((part) => {
    if (part && typeof part === "object" && !Array.isArray(part) && part.type === "reasoning" && !part.finishedAt) {
      return { ...part, finishedAt: now };
    }
    return part;
  });
}

export function hasOpenReasoningPart(msg: Message) {
  return msg.parts.some((part) =>
    part && typeof part === "object" && !Array.isArray(part) && part.type === "reasoning" && !part.finishedAt
  );
}

/** 工具卡终局收口(finishReasoningParts 的对称物,#59 补完):已有输出而未落终点戳的
 *  工具卡在此补 metadata.toolFinishedAt。覆盖"终局时刻已知、戳却缺失"的窗口——用户
 *  点停止/发新消息打断待审批/审批恢复直写 output——有 output 即该工具已执行完毕,
 *  此刻就是终点的最近真值。只补不覆盖(已有戳=更早的真实终点);pending 待审批卡
 *  跳过(等待期间秒数照走是 #59 的刻意语义)。 */
export function finishToolParts(msg: Message) {
  const now = new Date().toISOString();
  msg.parts = msg.parts.map((part) => {
    if (!isRecord(part) || part.type !== "tool") return part;
    if (!Array.isArray(part.output) || part.output.length === 0) return part;
    if (isRecord(part.approvalState) && String(part.approvalState.type ?? "") === "pending") return part;
    if (isRecord(part.metadata) && typeof part.metadata.toolFinishedAt === "string") return part;
    return { ...part, metadata: { ...(isRecord(part.metadata) ? part.metadata : {}), toolFinishedAt: now } };
  });
}

/** 把 loading / 占位 reasoning 替换成工具 part（协调器应用 tool_call_created 事件时调用）。 */
export function replaceLoadingReasoningWithTool(msg: Message, toolPart: ToolPart) {
  markStreamFirstContent(msg);
  msg.parts = msg.parts.filter((part) => !(
    part &&
    typeof part === "object" &&
    !Array.isArray(part) &&
    (part.type === "loading" || (part.type === "reasoning" && part.reasoning === "正在生成回复"))
  ));
  msg.parts.push(toolPart);
}

const streamStartedMessages = new WeakSet<Message>();

export { streamStartedMessages };

export function markStreamFirstContent(msg: Message | undefined) {
  if (!msg) return;
  if (streamStartedMessages.has(msg)) return;
  streamStartedMessages.add(msg);
  msg.createdAt = new Date().toISOString();
}

export function ensureReasoningPart(hooks: { message?: Message }, metadata?: Record<string, JsonValue>) {
  if (!hooks.message) return null;
  hooks.message.parts = hooks.message.parts.filter((part) => !(
    part &&
    typeof part === "object" &&
    !Array.isArray(part) &&
    (part.type === "loading" || (part.type === "reasoning" && part.reasoning === "正在生成回复"))
  ));
  const last = hooks.message.parts[hooks.message.parts.length - 1];
  if (last && typeof last === "object" && !Array.isArray(last) && last.type === "reasoning") {
    if (metadata && Object.keys(metadata).length > 0) {
      last.metadata = { ...(isRecord(last.metadata) ? last.metadata : {}), ...metadata };
    }
    return last;
  }
  const next: ReasoningPart = {
    type: "reasoning",
    reasoning: "",
    createdAt: new Date().toISOString(),
    finishedAt: null,
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
  hooks.message.parts.push(next);
  return next;
}

export function appendReasoningDelta(hooks: { message?: Message; sink?: (event: any) => void }, text: string, metadata?: Record<string, JsonValue>) {
  if (!hooks.message) return;
  if (hooks.sink) {
    hooks.sink({ kind: "reasoning_delta", text, metadata });
    return;
  }
  markStreamFirstContent(hooks.message);
  const part = ensureReasoningPart(hooks, metadata);
  if (part && text) part.reasoning = String(part.reasoning ?? "") + text;
}

export function normalizeGeneratedImageUrl(value: string) {
  const text = value.trim();
  if (!text || text.startsWith("data:") || /^https?:\/\//i.test(text)) return text;
  return `data:image/png;base64,${text}`;
}

export function addStreamImage(hooks: { message?: Message; sink?: (event: any) => void } | undefined, url: string, metadata: Record<string, JsonValue> = {}) {
  if (!hooks?.message) return;
  if (hooks.sink) {
    hooks.sink({ kind: "image_delta", url, metadata });
    return;
  }
  const normalized = normalizeGeneratedImageUrl(url);
  if (!normalized) return;
  markStreamFirstContent(hooks.message);
  hooks.message.parts.push({ type: "image", url: normalized, metadata });
}

export function addStreamText(hooks: { message?: Message; sink?: (event: any) => void } | undefined, text: string) {
  if (!hooks?.message || !text) return;
  if (hooks.sink) {
    hooks.sink({ kind: "text_delta", text });
    return;
  }
  markStreamFirstContent(hooks.message);
  const hadOpenReasoning = hasOpenReasoningPart(hooks.message);
  hooks.message.parts = hooks.message.parts.filter((part) => !(
    part &&
    typeof part === "object" &&
    !Array.isArray(part) &&
    (part.type === "loading" || (part.type === "reasoning" && part.reasoning === "正在生成回复"))
  ));
  if (hadOpenReasoning) {
    finishReasoningParts(hooks.message);
  }
  const last = hooks.message.parts[hooks.message.parts.length - 1];
  if (last && isRecord(last) && last.type === "text") {
    last.text = String(last.text ?? "") + text;
  } else {
    hooks.message.parts.push({ type: "text", text });
  }
}

export function isEmptyAssistantPlaceholder(msg: Message | undefined): boolean {
  if (!msg || msg.role !== "ASSISTANT") return false;
  return !msg.parts.some((part) => {
    if (!isRecord(part)) return false;
    const t = part.type;
    if (t === "tool" || t === "image" || t === "document" || t === "audio" || t === "video") return true;
    if (t === "text") return String(part.text ?? "").trim().length > 0;
    if (t === "reasoning") return String(part.reasoning ?? "").trim().length > 0;
    return false;
  });
}
