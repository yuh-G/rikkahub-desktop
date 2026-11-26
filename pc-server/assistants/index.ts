// assistants/index.ts — 助手配置与提示词注入
// 纪律：负责 defaultAssistant、findAssistant、模板变量、正则变换、Lorebook/Mode 注入。
// 不直接读写 state；调用方传入 assistants / lorebooks / modeInjections 等集合。

import type { Assistant, JsonValue, Message, MessagePart, Model, TextPart } from "../foundation/types";
import {
  cloneJson,
  getStringArray,
  isRecord,
  message,
  reasoningFromParts,
  renderTemplate,
  textFromParts,
} from "../foundation/utils";
import { osType } from "../foundation/platform";
import { DEFAULT_ASSISTANT_ID } from "../conversations";

export function defaultAssistant(): Assistant {
  return {
    id: DEFAULT_ASSISTANT_ID,
    chatModelId: null,
    name: "",
    avatar: { type: "dummy" },
    useAssistantAvatar: false,
    tags: [],
    systemPrompt: "",
    temperature: null,
    topP: null,
    contextMessageLimit: 0,
    streamOutput: true,
    enableMemory: false,
    useGlobalMemory: false,
    enableRecentChatsReference: false,
    messageTemplate: "{{ message }}",
    presetMessages: [],
    quickMessageIds: [],
    regexes: [],
    reasoningLevel: "AUTO",
    maxTokens: null,
    customHeaders: [],
    customBodies: [],
    mcpServers: [],
    mcpToolOverrides: {},
    localTools: [{ type: "time_info" }],
    background: null,
    backgroundOpacity: 1,
    modeInjectionIds: [],
    lorebookIds: [],
    enabledSkills: [],
    enginePluginIds: [],
    enableTimeReminder: false,
    allowConversationSystemPrompt: false,
    allowConversationPromptInjection: false,
  };
}

export function findAssistant(assistants: Assistant[], idValue: string): Assistant {
  return assistants.find((assistant) => assistant.id === idValue) ?? assistants[0];
}

const DATE_FULL: Intl.DateTimeFormatOptions = { dateStyle: "full" };
const TIME_MEDIUM: Intl.DateTimeFormatOptions = { timeStyle: "medium" };
const DATETIME_FULL: Intl.DateTimeFormatOptions = { dateStyle: "full", timeStyle: "medium" };

/** 一次请求的模板渲染上下文(PF.3):日期格式化器按 options 各建一次、时区与语言只取一次,整个请求里的
 *  所有消息共用,而且都是用到才建——默认消息模板 {{ message }} 一个都不建。新建 Intl.DateTimeFormat
 *  比格式化本身贵得多,原先每条历史消息、每段文字都要建好几个,开销随会话长度增长。不做进程级缓存:
 *  用户改了系统时区或语言,下一次请求自然用新的。不传上下文的调用方各自得到一个新的,结果相同。 */
export interface TemplateContext {
  /** options 传模块级常量,按对象身份缓存格式化器。 */
  format(options: Intl.DateTimeFormatOptions, date: Date): string;
  readonly timezone: string;
  readonly locale: string;
}

export function createTemplateContext(): TemplateContext {
  const formatters = new Map<Intl.DateTimeFormatOptions, Intl.DateTimeFormat>();
  let resolved: Intl.ResolvedDateTimeFormatOptions | null = null;
  const resolvedOptions = () => (resolved ??= Intl.DateTimeFormat().resolvedOptions());
  return {
    format(options, date) {
      let formatter = formatters.get(options);
      if (!formatter) formatters.set(options, (formatter = new Intl.DateTimeFormat(undefined, options)));
      return formatter.format(date);
    },
    get timezone() {
      return resolvedOptions().timeZone;
    },
    get locale() {
      return resolvedOptions().locale;
    },
  };
}

/** 时间、时区、语言几项是取值时才算的 getter(模板里用到才格式化);调用方只按键取值,不展开、不序列化。 */
export function templateVariables(
  messageText: string,
  role: string,
  assistant: Assistant,
  modelItem: Model,
  userNickname: string,
  // 专题11-P1-1:历史消息的时间类变量按消息自身 createdAt 渲染(调用方传 at),而不是
  // 每次请求都用“此刻”——否则含 {{time}} 等字面量的历史消息内容随请求时刻漂移:
  // 语义错误(昨天的消息声称今天的时间)且从该消息起前缀缓存全部失效。
  // 不传 at(系统提示词/辅助调用)保持“此刻”。
  at?: Date,
  context: TemplateContext = createTemplateContext(),
): Record<string, string> {
  const now = at ?? new Date();
  const user = userNickname.trim() || "User";
  return {
    message: messageText,
    role,
    get time() {
      return context.format(TIME_MEDIUM, now);
    },
    get date() {
      return context.format(DATE_FULL, now);
    },
    get cur_time() {
      return context.format(TIME_MEDIUM, now);
    },
    get cur_date() {
      return context.format(DATE_FULL, now);
    },
    get cur_datetime() {
      return context.format(DATETIME_FULL, now);
    },
    get timezone() {
      return context.timezone;
    },
    get locale() {
      return context.locale;
    },
    user,
    nickname: user,
    char: assistant.name?.trim() || "Assistant",
    model_id: modelItem.modelId,
    model_name: modelItem.displayName?.trim() || modelItem.modelId,
    system_version: `${osType()} PC (${process.platform})`,
    device_info: "RikkaHub PC",
    battery_level: "unknown",
  };
}

export function renderAssistantMessageTemplate(template: string, messageText: string, role: string, at?: Date, context: TemplateContext = createTemplateContext()) {
  const now = at ?? new Date();
  const variables = {
    message: messageText,
    role: role.toLowerCase(),
    get time() {
      return context.format(TIME_MEDIUM, now);
    },
    get date() {
      return context.format(DATE_FULL, now);
    },
  };
  return renderTemplate(template || "{{ message }}", variables);
}

function transformedTextPart(part: TextPart, text: string): TextPart {
  return { ...part, text };
}

export function applyMessageTemplateToParts(parts: MessagePart[], role: string, template: string, at?: Date, context: TemplateContext = createTemplateContext()) {
  return parts.map((part) => {
    if (!isRecord(part) || part.type !== "text") return part;
    return transformedTextPart(part, renderAssistantMessageTemplate(template, String(part.text ?? ""), role, at, context));
  });
}

function regexScopes(value: unknown) {
  return new Set(getStringArray(value).map((item) => item.toUpperCase()));
}

function activeRegexesForScope(assistant: Assistant, scope: "USER" | "ASSISTANT") {
  return Array.isArray(assistant.regexes)
    ? assistant.regexes.filter((regex) =>
        isRecord(regex) &&
        regex.enabled !== false &&
        regex.visualOnly !== true &&
        regexScopes(regex.affectingScope).has(scope) &&
        String(regex.findRegex ?? "").trim(),
      )
    : [];
}

export function applyRegexesToText(text: string, regexes: JsonValue[]) {
  let value = text;
  for (const regex of regexes) {
    if (!isRecord(regex)) continue;
    try {
      value = value.replace(new RegExp(String(regex.findRegex ?? ""), "g"), String(regex.replaceString ?? ""));
    } catch {
      // Match Android's fault tolerance: invalid regex leaves content unchanged.
    }
  }
  return value;
}

export function applyInputRegexTransformParts(parts: MessagePart[], assistant: Assistant) {
  const activeRegexes = activeRegexesForScope(assistant, "USER");
  if (activeRegexes.length === 0) return parts;
  return parts.map((part) =>
    isRecord(part) && part.type === "text"
      ? { ...part, text: applyRegexesToText(String(part.text ?? ""), activeRegexes) }
      : part,
  );
}

export function applyRegexOutputTransform(msg: Message, assistant: Assistant) {
  if (msg.role !== "ASSISTANT" || !Array.isArray(assistant.regexes) || assistant.regexes.length === 0) return;
  const activeRegexes = activeRegexesForScope(assistant, "ASSISTANT");
  if (activeRegexes.length === 0) return;
  msg.parts = msg.parts.map((part) => {
    if (!isRecord(part) || (part.type !== "text" && part.type !== "reasoning")) return part;
    if (part.type === "reasoning") return { ...part, reasoning: applyRegexesToText(String(part.reasoning ?? ""), activeRegexes) };
    return { ...part, text: applyRegexesToText(String(part.text ?? ""), activeRegexes) };
  });
}

function applyThinkTagTransform(msg: Message) {
  if (msg.role !== "ASSISTANT") return;
  const now = new Date().toISOString();
  const transformed: MessagePart[] = [];
  const thinkRegex = /<think>([\s\S]*?)(?:<\/think>|$)/gi;
  for (const part of msg.parts) {
    if (!isRecord(part) || part.type !== "text") {
      transformed.push(part);
      continue;
    }
    const text = String(part.text ?? "");
    if (!/<think>/i.test(text)) {
      transformed.push(part);
      continue;
    }
    let reasoning = "";
    const stripped = text.replace(thinkRegex, (_match, capture) => {
      reasoning += `${reasoning ? "\n" : ""}${String(capture ?? "").trim()}`;
      return "";
    }).replace(/<\/think>/gi, "");
    if (reasoning.trim()) {
      transformed.push({
        type: "reasoning",
        reasoning: reasoning.trim(),
        createdAt: msg.createdAt,
        finishedAt: now,
      });
    }
    if (stripped.trim()) transformed.push({ ...part, text: stripped });
  }
  msg.parts = transformed;
}

export function applyOutputTransforms(msg: Message, assistant: Assistant) {
  applyThinkTagTransform(msg);
  applyRegexOutputTransform(msg, assistant);
}

function normalizeInjectionPosition(value: unknown) {
  return String(value ?? "").toLowerCase();
}

function roleForInjection(value: unknown) {
  return String(value ?? "USER").toLowerCase() === "assistant" ? "assistant" : "user";
}

function regexMatches(injection: Record<string, JsonValue>, context: string) {
  if (injection.enabled === false) return false;
  if (injection.constantActive === true) return true;
  const keywords = getStringArray(injection.keywords);
  if (keywords.length === 0) return false;
  const useRegex = injection.useRegex === true;
  const caseSensitive = injection.caseSensitive === true;
  return keywords.some((keyword) => {
    if (useRegex) {
      try {
        return new RegExp(keyword, caseSensitive ? "" : "i").test(context);
      } catch {
        return false;
      }
    }
    return caseSensitive ? context.includes(keyword) : context.toLowerCase().includes(keyword.toLowerCase());
  });
}

function contextForMatchingMessages(messages: Message[], scanDepth: number) {
  return messages
    .filter((message) => message.role !== "SYSTEM")
    .slice(-Math.max(1, scanDepth || 4))
    .map((message) => textFromParts(message.parts) || reasoningFromParts(message.parts))
    .filter(Boolean)
    .join("\n");
}

export function activeModeInjections(assistant: Assistant, modeInjections: JsonValue[]) {
  const selected = new Set(getStringArray(assistant.modeInjectionIds));
  return (modeInjections as Array<Record<string, JsonValue>>)
    .filter((item) => item.enabled !== false && selected.has(String(item.id ?? "")))
    .sort((left, right) => Number(right.priority ?? 0) - Number(left.priority ?? 0));
}

export function activeLorebookInjections(assistant: Assistant, messages: Message[], lorebooks: JsonValue[]) {
  const selected = new Set(getStringArray(assistant.lorebookIds));
  return (lorebooks as Array<Record<string, JsonValue>>)
    .filter((book) => book.enabled !== false && selected.has(String(book.id ?? "")))
    .flatMap((book) => (Array.isArray(book.entries) ? book.entries : []))
    .filter(isRecord)
    .filter((entry) => regexMatches(entry, contextForMatchingMessages(messages, Number(entry.scanDepth ?? 4))))
    .sort((left, right) => Number(right.priority ?? 0) - Number(left.priority ?? 0));
}

export function activePromptInjections(
  assistant: Assistant,
  messages: Message[],
  lorebooks: JsonValue[],
  modeInjections: JsonValue[],
) {
  return [...activeModeInjections(assistant, modeInjections), ...activeLorebookInjections(assistant, messages, lorebooks)]
    .filter((item) => item.enabled !== false)
    .sort((left, right) => Number(right.priority ?? 0) - Number(left.priority ?? 0));
}

// 系统位注入拼接(before/after_system_prompt)已归 message-enrichment 富化管线
// (EnrichResult.systemInjectionBefore/After,P8);本层只剩聊天位插队。

function mergedInjectionMessages(injections: Array<Record<string, JsonValue>>): Message[] {
  const grouped = new Map<string, string[]>();
  for (const injection of injections) {
    const content = String(injection.content ?? "").trim();
    if (!content) continue;
    const role = roleForInjection(injection.role).toUpperCase();
    grouped.set(role, [...(grouped.get(role) ?? []), content]);
  }
  return [...grouped.entries()].map(([role, content]) =>
    message(role === "ASSISTANT" ? "ASSISTANT" : "USER", [{ type: "text", text: content.join("\n") }]),
  );
}

function hasAssistantToolsForSafeInsert(messageValue: Message | undefined) {
  return messageValue?.role === "ASSISTANT" && messageValue.parts.some((part) => isRecord(part) && part.type === "tool");
}

function findSafeInsertIndex(messages: Message[], targetIndex: number) {
  let index = Math.max(0, Math.min(targetIndex, messages.length));
  while (index > 0) {
    const prev = messages[index - 1];
    const current = messages[index];
    if (prev?.role === "USER" && hasAssistantToolsForSafeInsert(current)) index -= 1;
    else break;
  }
  return index;
}

function insertInjectionMessages(items: Message[], targetIndex: number, injections: Array<Record<string, JsonValue>>) {
  const messages = mergedInjectionMessages(injections);
  if (messages.length === 0) return;
  const insertIndex = findSafeInsertIndex(items, targetIndex);
  items.splice(insertIndex, 0, ...messages);
}

/** 聊天位注入插队(P9 收窄后唯一职责):top_of_chat/bottom_of_chat/at_depth 三种
 *  位置的注入按序插进消息序列。系统位注入(before/after_system_prompt)已归
 *  message-enrichment 的富化管线(EnrichResult.systemInjectionBefore/After)——
 *  本函数不再碰 SYSTEM 行。 */
export function applyPromptInjectionsToMessages(
  messages: Message[],
  injections: Array<Record<string, JsonValue>>,
) {
  const result = messages.map((item) => cloneJson(item));

  const firstUserIndex = result.findIndex((item) => item.role === "USER");
  insertInjectionMessages(
    result,
    firstUserIndex >= 0 ? firstUserIndex : result.length,
    injections.filter((injection) => normalizeInjectionPosition(injection.position) === "top_of_chat"),
  );
  insertInjectionMessages(
    result,
    Math.max(0, result.length - 1),
    injections.filter((injection) => normalizeInjectionPosition(injection.position) === "bottom_of_chat"),
  );
  for (const depth of [...new Set(injections
    .filter((injection) => normalizeInjectionPosition(injection.position) === "at_depth")
    .map((injection) => Math.max(1, Number(injection.injectDepth ?? 4))))].sort((left, right) => right - left)) {
    insertInjectionMessages(
      result,
      Math.max(0, result.length - depth),
      injections.filter((injection) =>
        normalizeInjectionPosition(injection.position) === "at_depth" &&
        Math.max(1, Number(injection.injectDepth ?? 4)) === depth,
      ),
    );
  }
  return result;
}
