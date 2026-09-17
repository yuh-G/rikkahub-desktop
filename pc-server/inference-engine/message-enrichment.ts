// inference-engine/message-enrichment.ts — 会话消息 → 模型视野的引擎无关富化层
//
// 定位:把"DB 里用户写的消息"变成"模型该看到的消息"的全部文本加工集中在一处,
// 聊天引擎(conversation-encoding)与 pi 工作区引擎(orchestrator → context-encoder)
// 共用同一份裁决——四件套(消息模板/时间提醒/lorebook+模式注入/上下文窗口化)
// 从此与"谁跑 agent 循环"无关。新增引擎接进来的唯一义务:先过 enrichMessages,
// 再按自己的协议编码。窗口化 = 滞回截断 ∨ 压缩切点锚(P9:pi 的压缩切点经
// windowStartMessageId 接入同一入口——注入行恒在窗口内、恒在切点之后,聊天位
// 注入/时间提醒在两种模式下逐字生效)。
//
// 幂等纪律(双引擎分层的接缝):注入/提醒产生的是合成消息,不写 DB——pi 每轮从
// DB 原文重新富化,注入语义"每次生成重新裁决"不变(安卓 PromptInjectionTransformer
// 同语义),DB 里永远不会沉淀出第二条 lorebook 正文。EnrichResult 用 syntheticIds
// 显式列出它们的 id——pi 生成路径把富化全序列(含合成行)灌进引擎,编码器据 id
// 把合成行挡在压缩切点映射与退化诊断之外(context-encoder 头注);手动压缩则经
// encodableMessages 剥回纯真实行(注入是配置不是对话,不进用户策展的摘要)。
// 消息对象本身零改动(不挂 metadata 标记,不扩 Message 类型)。
//
// 稳定→易变排序的缓存哲学与 conversationTransformedMessages 一致:系统位注入
// (before/after_system_prompt)不进本层消息序列,由调用方并入各自的系统提示词面
// (聊天引擎:internalMessages[0];pi:appendSystemPrompt 条目),保证聊天位序列稳定。

import type { Assistant, Conversation, JsonValue, Message, MessagePart, Model } from "../foundation/types";
import { applyPlaceholders, cloneJson, getStringArray, message, textFromParts } from "../foundation/utils";
import { state } from "../persistence/json-store";
import {
  activePromptInjections as activePromptInjectionsCore,
  applyMessageTemplateToParts,
  applyPromptInjectionsToMessages,
  templateVariables as templateVariablesCore,
} from "../assistants";

// ---- 模板变量(与 conversation-encoding.templateVariables 同一装配,集中到此) ----

export function templateVariables(messageText: string, role: string, assistant: Assistant, modelItem: Model, at?: Date) {
  return templateVariablesCore(
    messageText,
    role,
    assistant,
    modelItem,
    String(state.settings.displaySetting.userNickname ?? "").trim() || "User",
    at,
  );
}

// ---- 时间提醒(逐字搬迁自 conversation-encoding.timeReminderContent) ----

function messageTimestamp(msg: Message): Date | undefined {
  const parsed = Date.parse(String(msg.createdAt ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed) : undefined;
}

// 间隔超过该阈值才在 USER 消息前补时间提醒(首条恒提醒)。刻意硬编码不开放给用户:
// 这是感知类节奏阈值,用户无需感知;10min 对齐桌面 IM 场景(APP 出厂默认 60min 偏久,
// 间隔 10min~1h 的回来接着聊才是桌面高频)。可调则必须补分钟级文案分支。
const TIME_REMINDER_GAP_THRESHOLD_SECONDS = 10 * 60;

function timeReminderContent(current: Message, previous?: Message) {
  const currentTime = new Date(current.createdAt);
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(currentTime);
  const timeText = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(currentTime);
  if (!previous) return `<time_reminder>Current time: ${weekday}, ${timeText}</time_reminder>`;
  const gapSeconds = Math.floor((Date.parse(current.createdAt) - Date.parse(previous.createdAt)) / 1000);
  // createdAt 不可解析时 gapSeconds 为 NaN(NaN<=阈值 为 false),原实现会输出 "NaN d",
  // 用否定式条件一并挡掉。三档文案与 APP TimeReminderTransformer.formatGap 一致(min/h/d)。
  if (!(gapSeconds > TIME_REMINDER_GAP_THRESHOLD_SECONDS)) return "";
  const gapText =
    gapSeconds < 3600
      ? `${Math.floor(gapSeconds / 60)} min`
      : gapSeconds < 86400
        ? `${Math.floor(gapSeconds / 3600)} h`
        : `${Math.floor(gapSeconds / 86400)} d`;
  return `<time_reminder>Current time: ${weekday}, ${timeText} (${gapText} since last message)</time_reminder>`;
}

/** 在 USER 消息前插时间提醒(首条 USER 恒提醒,后续间隔 >10min 提醒)。
 *  previousUserMessage: 调用方若已把 system 等前缀拼在序列前,传最后一条非 USER
 *  消息作为"首条 USER 的前一条"基准,保持与聊天引擎原语义(首条提醒看 gap)一致。
 *  返回新数组;提醒消息是新对象,调用方经 EnrichResult.syntheticIds 识别。 */
export function applyTimeReminders(
  messages: Message[],
  assistant: Assistant,
  previousUserMessage?: Message,
): { messages: Message[]; syntheticIds: Set<string> } {
  if (!assistant.enableTimeReminder) return { messages, syntheticIds: new Set() };
  const out: Message[] = [];
  const syntheticIds = new Set<string>();
  let firstUserReminderInjected = false;
  let previous = previousUserMessage;
  for (const selected of messages) {
    if (selected.role === "USER") {
      const reminder = timeReminderContent(selected, firstUserReminderInjected ? previous : undefined);
      if (reminder) {
        const reminderMessage = message("USER", [{ type: "text", text: reminder }]);
        syntheticIds.add(reminderMessage.id);
        out.push(reminderMessage);
      }
      firstUserReminderInjected = true;
    }
    out.push(selected);
    previous = selected;
  }
  return { messages: out, syntheticIds };
}

// ---- lorebook / 模式注入 ----

export interface ConversationInjectionOverride {
  modeInjectionIds: string[];
  lorebookIds: string[];
}

/** 生效注入集合(专题9:助手允许会话级绑定时,生效 id 集完全来自会话)。 */
export function activePromptInjections(
  conversation: Conversation,
  assistant: Assistant,
  messages: Message[],
): Array<Record<string, JsonValue>> {
  const override = assistant.allowConversationPromptInjection === true
    ? {
        modeInjectionIds: getStringArray(conversation.modeInjectionIds),
        lorebookIds: getStringArray(conversation.lorebookIds),
      }
    : undefined;
  return activePromptInjectionsCore(assistant, messages, state.settings.lorebooks, state.settings.modeInjections, override);
}

/** 注入按位置分两路:系统位(before/after_system_prompt)返回文本,由调用方并入
 *  系统提示词面;聊天位(top/bottom/at_depth)走 applyPromptInjectionsToMessages
 *  插队,插队消息带 enrich:synthetic 标记。 */
export function splitInjectionsByPlacement(injections: Array<Record<string, JsonValue>>) {
  const system = injections.filter((injection) => {
    const position = String(injection.position ?? "").toLowerCase();
    return position === "before_system_prompt" || position === "after_system_prompt";
  });
  const chat = injections.filter((injection) => {
    const position = String(injection.position ?? "").toLowerCase();
    return position !== "before_system_prompt" && position !== "after_system_prompt";
  });
  return { system, chat };
}

// ---- 消息模板(占位符 + 模板包装,逐消息应用) ----

/** 对单条消息应用占位符(非 ASSISTANT 的 {{message}} 等)与模板包装。
 *  与 conversation-encoding 里两条消费路径(OpenAI messages / Responses input)
 *  共用的 per-message 加工,抽出来供 pi 编码器复用。 */
export function applyTemplateToMessage(
  selected: Message,
  template: string,
  role: string,
  assistant: Assistant,
  modelItem: Model,
): MessagePart[] {
  const rawContent = textFromParts(selected.parts);
  const messageAt = messageTimestamp(selected);
  if (selected.role === "ASSISTANT") {
    // 助手消息无占位符展开(rawContent 不进模板变量),只套模板。
    return applyMessageTemplateToParts(selected.parts, "assistant", template, messageAt);
  }
  const placeholderParts = selected.parts.map((part) =>
    part.type === "text"
      ? { ...part, text: applyPlaceholders(String(part.text ?? ""), templateVariables(rawContent, role, assistant, modelItem, messageAt)) }
      : part,
  );
  return applyMessageTemplateToParts(placeholderParts, role, template, messageAt);
}

// ---- 上下文滞回截断(专题11-P2-1) ----

/** 滞回窗口起点:limit>0 且超长时,起点按步长 S=ceil(limit×0.2) 量化前移。
 *  与 conversationTransformedMessages 同一公式,抽出来供两引擎共用。 */
export function truncationStartFor(messageCount: number, contextLimit: number): number {
  if (!(contextLimit > 0) || messageCount <= contextLimit) return 0;
  const step = Math.max(1, Math.ceil(contextLimit * 0.2));
  return Math.floor((messageCount - contextLimit) / step) * step;
}

// ---- 主编排:富化管线(两引擎共用) ----

export interface EnrichOptions {
  conversation: Conversation;
  assistant: Assistant;
  model: Model;
  /** 窗口锚(P9):从这条消息(含)起保留,与滞回截断起点取 max。生产侧唯一传法是
   *  引擎压缩切点(effectiveEngineCompaction 的 cutMessageId)——压缩重放会隐藏切点之前
   *  的条目,把切点接入窗口边界后,注入行/提醒恒在切点之后:既进模型视野,又永不
   *  落进被摘要吸收的旧历史。id 不在序列中(陈旧压缩记录/消息被删)时视为无锚。 */
  windowStartMessageId?: string;
  /** 时间提醒的"首条 USER 前一条"基准(聊天引擎传 system 消息,pi 路径无此前缀)。 */
  timeReminderAnchor?: Message;
}

export interface EnrichResult {
  /** 富化后的消息序列(系统位注入不在内——那是系统提示词面的事)。 */
  messages: Message[];
  /** 系统位注入文本(before/after 已按序拼接;调用方并入系统提示词面)。 */
  systemInjectionBefore: string;
  systemInjectionAfter: string;
  /** 命中的注入条目(诊断/测试断言用)。 */
  injections: Array<Record<string, JsonValue>>;
  /** 本轮产生的合成消息 id(时间提醒/聊天位注入);生成路径随全序列灌进 pi 编码器
   *  (挡在切点映射/退化诊断之外),手动压缩路径经 encodableMessages 剥除。 */
  syntheticIds: Set<string>;
}

/** 消息富化主管线:窗口化(滞回截断 ∨ 压缩切点锚) → 模板/占位符 → 时间提醒 →
 *  注入(聊天位)。系统位注入单列返回。产物 messages 已完成模板渲染——调用方(聊天
 *  编码器/pi 编码器)直接消费,不得再套 applyMessageTemplateToParts,否则 {{message}}
 *  会被双重包装。纯函数:不改 conversation/assistant,合成消息 id 经 syntheticIds
 *  显式返回。 */
export function enrichMessages(baseMessages: Message[], options: EnrichOptions): EnrichResult {
  const { conversation, assistant, model } = options;
  const template = assistant.messageTemplate?.trim() || "{{ message }}";

  // 1. 窗口化:滞回截断与压缩切点锚取 max(锚不在序列中视为无锚)。与聊天引擎
  //    "先截断、后提醒/注入"同序——合成行天然落在窗口内、压缩切点之后。
  const hysteresisStart = truncationStartFor(baseMessages.length, assistant.contextMessageLimit);
  const anchorIndex = options.windowStartMessageId
    ? baseMessages.findIndex((msg) => msg.id === options.windowStartMessageId)
    : -1;
  const start = Math.max(hysteresisStart, anchorIndex >= 0 ? anchorIndex : 0);
  const windowed = start > 0 ? baseMessages.slice(start) : baseMessages;

  // 2. 模板/占位符逐消息渲染(一次到位:pi 编码器与聊天编码器吃同一份渲染产物)。
  const templated = windowed.map((msg) => {
    const role = msg.role === "SYSTEM" ? "system" : msg.role === "TOOL" ? "tool" : msg.role === "ASSISTANT" ? "assistant" : "user";
    return { ...msg, parts: applyTemplateToMessage(msg, template, role, assistant, model) };
  });

  // 3. 时间提醒(在模板之后、注入之前——提醒本身不套模板,与聊天引擎现状一致)。
  const { messages: withReminders, syntheticIds: reminderIds } = applyTimeReminders(
    templated,
    assistant,
    options.timeReminderAnchor,
  );

  // 4. lorebook/模式注入:系统位文本抽出,聊天位消息插队(合成 id 并入返回集)。
  const injections = activePromptInjections(conversation, assistant, withReminders);
  const { system, chat } = splitInjectionsByPlacement(injections);
  const withRemindersIds = new Set(withReminders.map((msg) => msg.id));
  const injected = applyPromptInjectionsToMessages(withReminders, chat);
  const syntheticIds = new Set(reminderIds);
  for (const msg of injected) {
    if (!withRemindersIds.has(msg.id)) syntheticIds.add(msg.id);
  }

  const systemTextOf = (position: string) =>
    system
      .filter((injection) => String(injection.position ?? "").toLowerCase() === position)
      .map((injection) => String(injection.content ?? "").trim())
      .filter(Boolean)
      .join("\n");

  return {
    messages: injected,
    systemInjectionBefore: systemTextOf("before_system_prompt"),
    systemInjectionAfter: systemTextOf("after_system_prompt"),
    injections,
    syntheticIds,
  };
}

/** 手动压缩路径专用:把富化产物剥回"可编码"的纯真实行(P9 起生成路径不再剥——
 *  合成消息随全序列灌进 pi 引擎,聊天位注入/时间提醒在工作区会话同样生效)。
 *  手动压缩的摘要应只覆盖真实对话:注入是配置不是对话,提醒只描述节奏,均不进
 *  用户策展的摘要。 */
export function encodableMessages(enriched: Message[], syntheticIds: Set<string>): Message[] {
  return enriched.filter((msg) => !syntheticIds.has(msg.id)).map((msg) => cloneJson(msg));
}
