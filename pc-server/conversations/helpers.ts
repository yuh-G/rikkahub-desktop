// conversations/helpers.ts — 会话与消息的领域辅助（建会话、预置消息、usage、工具审批状态、生成中止/删除）
// 纪律：纯搬迁自 server.ts（阶段 5.3f），行为不变；原私有函数为跨模块使用统一补 export。

import type { Assistant, Conversation, JsonValue, Message, MessageNode, MessagePart } from "../foundation/types";
import { estimateTokens, getStringArray, id, isRecord, message, reasoningFromParts, textFromParts } from "../foundation/utils";
import { state } from "../persistence/json-store";
import { broadcastList, dropConversationSse } from "../api/sse";
import { deletePcConversations, flushConvDirtyNow, getConversation, persistConversation, selectedConversationMessages } from "./index";
import { registerConversation, removeConversations } from "./working-set";
import { abortGeneration, generating } from "./generation-state";
import { clearMessageQueue } from "./message-queue";
import { findAssistant as findAssistantCore } from "../assistants";
import { fillContextLimit } from "../inference-engine/providers";

/** 删会话路径的中止(唯一调用方 deleteConversationsById):意图 deleted——队列随会话清除,
 *  旧流收尾无事可做。 */
export function abortConversationGeneration(conversationId: string) {
  const wasGenerating = abortGeneration(conversationId, "deleted");
  generating.delete(conversationId);
  // Mirror completeConversationGeneration: when the user manually stops generation,
  // the sidebar's per-conversation streaming indicator also needs to flip off, and
  // since broadcastNodeUpdateNow no longer calls broadcastList on every chunk we
  // have to refresh the list explicitly here.
  if (wasGenerating) broadcastList();
  // 1.2.6:用户中止也要 reconcile 活库——abort 提前 delete 了 generating,后续
  // completeConversationGeneration 的 if 会失败而跳过 reconcile,所以这里补一次全量
  // persistConversation。流式中删会话(deleteConversationsById 先调本函数)时
  // getConversation 仍返回会话(filter 删除在后),persist 后由 deletePcConversations 清掉,幂等无害。
  flushConvDirtyNow();
  const conv = getConversation(conversationId);
  if (conv) persistConversation(conv);
}

export function deleteConversationsById(ids: Set<string>) {
  for (const conversationId of ids) {
    abortConversationGeneration(conversationId);
    // R2-4+R2-6:close 详情流 + 清待发节点广播(见 dropConversationSse 注释)
    dropConversationSse(conversationId);
    // 会话删除即清其发送队列(纯内存态,孤儿队列只是泄漏,顺手清)。
    clearMessageQueue(conversationId);
  }
  // P7:引擎会话状态(压缩记录)在会话行内(engine_compactions 列),随行删除天然级联,
  // 无文件生命周期可管——P2 的 jsonl 收集/删除逻辑随层退役。
  // 先删 working set,再删活库——避免删活库后残余脏标记 flush 又把节点 upsert 回来
  // (flushConvDirty 经 peekConversation 查注册表,条目没了就跳过)。
  removeConversations(ids);
  deletePcConversations(Array.from(ids));
  broadcastList();
}

export function findAssistant(idValue = state.settings.assistantId) {
  return findAssistantCore(state.settings.assistants, idValue);
}

/** A1(专题9复查):开启"会话级注入绑定"的助手,新会话从助手级播种生效集。
 *  PC 会话在首条消息才创建(不提前建,防死会话),home 页的勾选只能落在助手级;
 *  而 override 语义是"会话集(含空集)完全取代助手级"(对齐安卓 collectInjections),
 *  不播种则新会话诞生即空集,用户在新聊天页的勾选静默失效。安卓无此窗口
 *  (ChatPage 始终持有会话对象,勾选从第一刻就写会话级)。 */
export function seedConversationInjectionBinding(conversation: Conversation, assistant: Assistant): void {
  if (assistant.allowConversationPromptInjection !== true) return;
  conversation.modeInjectionIds = getStringArray(assistant.modeInjectionIds);
  conversation.lorebookIds = getStringArray(assistant.lorebookIds);
}

/** init 仅在会话创建时刻生效(已存在的会话原样返回)——PC 会话首条消息才建档,
 *  工作区归属等创建期属性只能随首个建档请求进来,事后不可改绑。 */
export function ensureConversation(idValue: string, init?: { workspaceId?: string | null }) {
  let conversation = getConversation(idValue);
  if (!conversation) {
    const now = Date.now();
    const assistant = findAssistant(state.settings.assistantId);
    conversation = {
      id: idValue,
      assistantId: assistant.id,
      systemPrompt: null,
      title: "",
      messages: presetMessageNodes(assistant),
      chatSuggestions: [],
      isPinned: false,
      createAt: now,
      updateAt: now,
      workspaceId: init?.workspaceId ?? null,
      workspaceCwd: null,
      engineCompactions: null,
    };
    seedConversationInjectionBinding(conversation, assistant);
    registerConversation(conversation); // 新建:内存即权威,防 checkout 从活库读空树反向覆盖
    // 1.2.6:新建会话 persist 进活库(建会话行),否则后续流式 upsert 该会话的节点时
    // FK 失败(pc_message_node.conversation_id 引用 pc_conversation.id),且流式中崩溃
    // 会丢会话行。
    persistConversation(conversation);
  }
  return conversation;
}

export function roleFromPreset(value: unknown): Message["role"] {
  const role = String(value ?? "USER").toUpperCase();
  if (role === "ASSISTANT" || role === "SYSTEM" || role === "TOOL") return role;
  return "USER";
}

export function partsFromPreset(value: unknown): MessagePart[] {
  // 边界断言：preset 来自 settings JSON，契约即 UIMessagePart[]（与前端/安卓一致）
  if (Array.isArray(value)) return value as MessagePart[];
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (isRecord(value) && Array.isArray(value.parts)) return value.parts as MessagePart[];
  if (isRecord(value) && typeof value.content === "string") return [{ type: "text", text: value.content }];
  return [];
}

export function presetMessageNodes(assistant: Assistant): MessageNode[] {
  return (Array.isArray(assistant.presetMessages) ? assistant.presetMessages : [])
    .map((preset) => {
      if (!isRecord(preset)) return null;
      const msg = message(roleFromPreset(preset.role), partsFromPreset(preset), String(preset.modelId ?? "") || null);
      if (typeof preset.id === "string") msg.id = preset.id;
      if (typeof preset.createdAt === "string") msg.createdAt = preset.createdAt;
      if (typeof preset.finishedAt === "string" || preset.finishedAt === null) msg.finishedAt = preset.finishedAt as string | null;
      return { id: id(), messages: [msg], selectIndex: 0 };
    })
    .filter(Boolean) as MessageNode[];
}

export function finishMessage(msg: Message, parts: MessagePart[], usage: JsonValue | null = msg.usage) {
  msg.parts = parts;
  msg.finishedAt = new Date().toISOString();
  msg.usage = usage;
}

export function appendTextPart(msg: Message, text: string) {
  const last = msg.parts[msg.parts.length - 1];
  if (last && typeof last === "object" && !Array.isArray(last) && last.type === "text") {
    last.text = String(last.text ?? "") + text;
  } else {
    msg.parts.push({ type: "text", text });
  }
}

export function summaryAsText(msg: Message) {
  return `[${msg.role}]: ${textFromParts(msg.parts)}`;
}
/** 工具 part 的文本量(入参 JSON + 输出 text/error 条目)——工具往返在后续轮次全量进
 *  提示词,不计=agent/MCP 重度会话严重低估(影响压缩触发与用量显示,§9.8)。 */
function toolPartsTextVolume(parts: MessagePart[]) {
  let volume = "";
  for (const part of parts) {
    if (!isRecord(part) || part.type !== "tool") continue;
    volume += String(part.input ?? "");
    if (!Array.isArray(part.output)) continue;
    for (const entry of part.output) {
      if (!isRecord(entry)) continue;
      const errorText = (entry as { error?: unknown }).error;
      if (entry.type === "text") volume += String(entry.text ?? "");
      else if (typeof errorText === "string") volume += errorText;
    }
  }
  return volume;
}

export function estimatePromptTokensForConversation(conversation: Conversation) {
  return selectedConversationMessages(conversation).reduce((sum, msg) => {
    // 原口径保留:助手回答文本不计(历史近似),但挂在助手消息里的工具往返必须计。
    const textTokens = msg.role !== "ASSISTANT" ? estimateTokens(textFromParts(msg.parts)) : 0;
    return sum + textTokens + estimateTokens(toolPartsTextVolume(msg.parts));
  }, 0);
}

export function ensureUsage(msg: Message, conversation?: Conversation) {
  const existing = msg.usage as Record<string, unknown> | null | undefined;
  const usable = existing && typeof existing === "object" && !Array.isArray(existing);
  // 字段级兜底(内测实锤,Kimi anthropic 兼容端点):message_start 只回 input_tokens,
  // output_tokens 恒 0 且 message_delta 不带 usage——上游只回报一半。旧判定"任一字段
  // 非零就全信上游"被 promptTokens 挡住,completionTokens 恒 0:TPS 行消失/失真、
  // 输出统计恒 0。改为按字段兜底:真实值保留,缺失侧(0 值)单独估算补齐。
  // 全 0 载荷(流式骨架每轮下沉 generationMs 的纯时长对象)自然落双侧估算,行为不变。
  const promptReal = usable && Number(existing.promptTokens ?? 0) > 0;
  // completion 判 >1 而非 >0:anthropic 流式 message_start.usage.output_tokens 是起始
  // 计数(恒 1),最终值只来自 message_delta。Kimi coding 等兼容端点 message_delta 不带
  // usage,起始值 1 残留下沉——对话模式已在 mergeClaudeUsage 源头剥离(output 只认
  // message_delta),但工作区走 pi vendor 的 anthropic 客户端(message_start 照吸,
  // vendor 只跟上游不可改),残留的 1 会挡住估算兜底 → TPS≈0。此处按语义收紧:1 是
  // 协议起始计数的特征值,不是可信回报;真实回答恰为 1 token 的场景落估算后显示依旧
  // ≈1(标 estimated),零伤害。
  const completionReal = usable && Number(existing.completionTokens ?? 0) > 1;
  if (promptReal && completionReal) return;
  // 思考模型的输出=正文+思维链,两段都计(旧 || 短路曾把思维链整段丢掉,TPS 低估一个数量级)。
  // 空段跳过:estimateTokens 有 max(1,·) 下限,空串也计 1,相加会虚增。
  const visibleText = textFromParts(msg.parts);
  const reasoningText = reasoningFromParts(msg.parts);
  const estimatedCompletion =
    (visibleText ? estimateTokens(visibleText) : 0) + (reasoningText ? estimateTokens(reasoningText) : 0);
  const promptTokens = promptReal
    ? Number(existing.promptTokens)
    : conversation ? estimatePromptTokensForConversation(conversation) : 0;
  const completionTokens = completionReal ? Number(existing.completionTokens) : estimatedCompletion;
  msg.usage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    // 上游回报过的缓存命中数是真实值,保留(Kimi 场景 cache_read 正常回报)。
    cachedTokens: usable ? Number(existing.cachedTokens ?? 0) : 0,
    // 只要有估算成分就标 estimated(统计页照旧排除),不冒充全真实。
    estimated: true,
    // 估算只兜 token;骨架已累计的纯生成耗时是真实测量值,保留(速度=估算token/真实时长)。
    ...(usable && Number(existing.generationMs ?? 0) > 0 ? { generationMs: Number(existing.generationMs) } : {}),
  };
  fillContextLimit(msg);
}

export function toolApprovalType(part: JsonValue) {
  return isRecord(part) && isRecord(part.approvalState) ? String(part.approvalState.type ?? "auto") : "auto";
}

export function hasToolParts(msg: Message) {
  return msg.parts.some((part) => isRecord(part) && part.type === "tool");
}

export function hasPendingToolApproval(msg: Message) {
  return msg.parts.some((part) => isRecord(part) && part.type === "tool" && toolApprovalType(part) === "pending");
}

export function canResumeToolExecution(part: JsonValue) {
  const type = toolApprovalType(part);
  return type === "approved" || type === "denied" || type === "answered";
}

export function hasResumableToolParts(msg: Message) {
  return msg.parts.some((part) =>
    isRecord(part) &&
    part.type === "tool" &&
    (!Array.isArray(part.output) || part.output.length === 0) &&
    canResumeToolExecution(part)
  );
}

// 是否为"正在生成"的空 ASSISTANT 占位:没有任何可发送内容(文本/思维链/工具/媒体),
// 只有 loading 占位或完全为空。组装上下文时它不是历史消息,不应占用 contextMessageLimit
// 名额——否则 size=1 时 slice 只取到它(空内容随后被 appendAssistantApiMessages 过滤),
// 把用户真正的输入挤出上下文,模型只收到 system prompt(issue #16)。
// 注意:工具恢复场景下尾部 ASSISTANT 已带 tool 部分与结果(模型续轮必须看到),故必须靠
// "有无内容"判定,而不是 finishedAt——恢复消息 finishedAt 同样为 null 但不能剔除。

// 把上一条 ASSISTANT 消息里所有处于 pending 状态的工具（典型场景：ask_user
// 没等用户点选项，用户直接发了下一条消息或要求重生成）标记为"用户已取消"，
// 让本轮生成能干净地接续——对齐安卓 commit 05c12488 的 finishInterruptedPendingTools。
// 返回 true 表示发生了修改，调用方需要广播状态变更。
export function finishInterruptedPendingToolsInConversation(conversation: Conversation): boolean {
  const lastNode = conversation.messages[conversation.messages.length - 1];
  if (!lastNode) return false;
  const lastMessage = lastNode.messages[lastNode.selectIndex] ?? lastNode.messages[0];
  if (!lastMessage || lastMessage.role !== "ASSISTANT") return false;
  let changed = false;
  lastMessage.parts = lastMessage.parts.map((part) => {
    if (!isRecord(part) || part.type !== "tool") return part;
    if (toolApprovalType(part) !== "pending") return part;
    changed = true;
    return {
      ...part,
      approvalState: {
        type: "denied",
        reason: "User cancelled by sending a new message",
      },
      output: Array.isArray(part.output) && part.output.length > 0 ? part.output : [
        { type: "text", text: "Tool execution cancelled by user (new message sent)." },
      ],
    };
  });
  if (!changed) return false;
  if (!lastMessage.finishedAt) lastMessage.finishedAt = new Date().toISOString();
  // 清理 loading 占位符（如果旧 generation 留下了）
  lastMessage.parts = lastMessage.parts.filter((part) =>
    !(isRecord(part) && part.type === "loading"),
  );
  return true;
}
