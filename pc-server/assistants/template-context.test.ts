// assistants/template-context.test.ts — 模板变量按请求建一次、用到才算(PF.3)。
// 契约:①输出逐字不变——历史消息的渲染结果一变,上游的前缀缓存就失效;把改前的 templateVariables /
// renderAssistantMessageTemplate / applyTemplateToMessage / 时间提醒原样抄进来当参照物,固定时间与一组模板、
// 消息对照;②构造次数——默认模板 {{ message }} 下一个日期格式化器都不建,模板含 {{time}} 时次数与消息条数无关。
import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import type { Assistant, Message, Model, State } from "../foundation/types";
import { applyPlaceholders, message, renderTemplate, textFromParts } from "../foundation/utils";
import { osType } from "../foundation/platform";
import { setState } from "../persistence/json-store";
import { createTemplateContext, renderAssistantMessageTemplate, templateVariables } from "./index";
import { applyTemplateToMessage, applyTimeReminders, enrichMessages } from "../inference-engine/message-enrichment";

beforeAll(() => {
  setState({ settings: { displaySetting: { userNickname: "测试用户" }, lorebooks: [], modeInjections: [] } } as unknown as State);
});

// ---- 改前实现(PF.3 之前原样抄来,仅作对照) ----
const legacyDate = (d: Date) => new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(d);
const legacyTime = (d: Date) => new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(d);
function legacyTemplateVariables(messageText: string, role: string, assistant: Assistant, modelItem: Model, userNickname: string, at?: Date): Record<string, string> {
  const now = at ?? new Date();
  const user = userNickname.trim() || "User";
  return {
    message: messageText,
    role,
    time: legacyTime(now),
    date: legacyDate(now),
    cur_time: legacyTime(now),
    cur_date: legacyDate(now),
    cur_datetime: new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "medium" }).format(now),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
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
function legacyRender(template: string, messageText: string, role: string, at?: Date) {
  const now = at ?? new Date();
  return renderTemplate(template || "{{ message }}", { message: messageText, role: role.toLowerCase(), time: legacyTime(now), date: legacyDate(now) });
}
function legacyApplyTemplateToMessage(selected: Message, template: string, role: string, assistant: Assistant, modelItem: Model) {
  const rawContent = textFromParts(selected.parts);
  const parsed = Date.parse(String(selected.createdAt ?? ""));
  const at = Number.isFinite(parsed) ? new Date(parsed) : undefined;
  const wrap = (parts: Message["parts"], r: string) => parts.map((part) => (part.type === "text" ? { ...part, text: legacyRender(template, String(part.text ?? ""), r, at) } : part));
  if (selected.role === "ASSISTANT") return wrap(selected.parts, "assistant");
  return wrap(
    selected.parts.map((part) => (part.type === "text" ? { ...part, text: applyPlaceholders(String(part.text ?? ""), legacyTemplateVariables(rawContent, role, assistant, modelItem, "测试用户", at)) } : part)),
    role,
  );
}

const MODEL = { modelId: "fake-model", displayName: "Fake Model" } as Model;
function assistant(overrides: Partial<Assistant> = {}): Assistant {
  return { id: "a1", name: "测试助手", messageTemplate: "{{ message }}", contextMessageLimit: 0, enableTimeReminder: false, modeInjectionIds: [], lorebookIds: [], ...overrides } as unknown as Assistant;
}
function msgAt(role: "USER" | "ASSISTANT", text: string, iso: string, extraParts: Message["parts"] = []): Message {
  const m = message(role, [{ type: "text", text }, ...extraParts]);
  m.createdAt = iso;
  return m;
}

const AT = new Date("2026-03-04T05:06:07.000Z");
const VARIABLE_KEYS = ["message", "role", "time", "date", "cur_time", "cur_date", "cur_datetime", "timezone", "locale", "user", "nickname", "char", "model_id", "model_name", "system_version", "device_info", "battery_level"];
const ALL_VARIABLES_TEXT = VARIABLE_KEYS.map((k) => `[${k}={{ ${k} }}|{${k}}]`).join(" ") + " {{unknown_var}} {unknown}";
const TEMPLATES = ["{{ message }}", "", "[{{role}} @ {{ time }} / {{date}}] {{ message }}", "{{message}} {{ cur_time }} {{nope}}"];

describe("输出逐字不变", () => {
  test("templateVariables 每个键与改前相同(固定时间,也测「此刻」)", () => {
    for (const at of [AT, undefined]) {
      const fresh = templateVariables("正文", "user", assistant(), MODEL, "测试用户", at);
      const old = legacyTemplateVariables("正文", "user", assistant(), MODEL, "测试用户", at);
      expect(Object.fromEntries(VARIABLE_KEYS.map((k) => [k, fresh[k]]))).toEqual(old);
    }
  });

  test("renderAssistantMessageTemplate 与改前相同", () => {
    for (const template of TEMPLATES) for (const role of ["USER", "ASSISTANT"]) {
      expect(renderAssistantMessageTemplate(template, "一句话", role, AT)).toBe(legacyRender(template, "一句话", role, AT));
    }
  });

  test("applyTemplateToMessage:用户消息(双花括号、单花括号、未知变量、图片段)与助手消息,共用一个上下文时与改前相同", () => {
    const image = { type: "image", url: "file://x.png" } as unknown as Message["parts"][number];
    const messages = [
      msgAt("USER", ALL_VARIABLES_TEXT, "2026-01-02T03:04:05.000Z", [image, { type: "text", text: "第二段 {{time}}" }]),
      msgAt("ASSISTANT", "助手的回答 {{time}} 不展开占位符", "2026-01-02T03:05:00.000Z"),
      msgAt("USER", "没有合法时间戳", "not-a-date"),
    ];
    for (const template of TEMPLATES) {
      const context = createTemplateContext();
      for (const m of messages) {
        const role = m.role === "ASSISTANT" ? "assistant" : "user";
        expect(applyTemplateToMessage(m, template, role, assistant(), MODEL, context)).toEqual(legacyApplyTemplateToMessage(m, template, role, assistant(), MODEL));
      }
    }
  });

  test("时间提醒的文字与改前相同", () => {
    const messages = [msgAt("USER", "早上好", "2026-01-02T03:04:05.000Z"), msgAt("ASSISTANT", "早", "2026-01-02T03:04:30.000Z"), msgAt("USER", "两小时后", "2026-01-02T05:10:00.000Z")];
    const texts = applyTimeReminders(messages, assistant({ enableTimeReminder: true })).messages.filter((m) => !messages.includes(m)).map((m) => textFromParts(m.parts));
    const weekday = (iso: string) => new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(new Date(iso));
    const stamp = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(iso));
    expect(texts).toEqual([
      `<time_reminder>Current time: ${weekday(messages[0]!.createdAt)}, ${stamp(messages[0]!.createdAt)}</time_reminder>`,
      `<time_reminder>Current time: ${weekday(messages[2]!.createdAt)}, ${stamp(messages[2]!.createdAt)} (2 h since last message)</time_reminder>`,
    ]);
  });
});

describe("构造次数(给 Intl.DateTimeFormat 包一层计数)", () => {
  const RealFormat = Intl.DateTimeFormat;
  let constructed = 0;
  const Counting = function (this: unknown, ...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
    constructed += 1;
    return new RealFormat(...args);
  } as unknown as typeof Intl.DateTimeFormat;
  Object.assign(Counting, RealFormat);
  const countDuring = (fn: () => void) => {
    constructed = 0;
    (Intl as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat = Counting;
    try {
      fn();
    } finally {
      (Intl as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat = RealFormat;
    }
    return constructed;
  };
  afterEach(() => {
    (Intl as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat = RealFormat;
  });

  const history = (turns: number) =>
    Array.from({ length: turns }, (_, i) => [
      msgAt("USER", `第${i}个问题,带两段`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), [{ type: "text", text: "第二段" }]),
      msgAt("ASSISTANT", `第${i}个回答`, new Date(Date.UTC(2026, 0, 1, 0, i, 30)).toISOString()),
    ]).flat();
  const enrich = (messages: Message[], a: Assistant) =>
    enrichMessages(messages, { conversation: { id: "c1", messages: [] } as never, assistant: a, model: MODEL });

  test("默认模板 {{ message }}、300 条消息:一个都不建", () => {
    const messages = history(150);
    expect(countDuring(() => enrich(messages, assistant()))).toBe(0);
  });

  test("模板含 {{time}} 与 {{date}}:次数是常数,与消息条数无关", () => {
    const a = assistant({ messageTemplate: "[{{ time }} {{ date }}] {{ message }}" });
    const small = countDuring(() => enrich(history(5), a));
    const large = countDuring(() => enrich(history(150), a));
    expect(small).toBeGreaterThan(0);
    expect(large).toBe(small);
  });

  test("开了时间提醒:次数同样是常数", () => {
    const a = assistant({ enableTimeReminder: true });
    const spaced = (turns: number) => history(turns).map((m, i) => ({ ...m, createdAt: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString() }));
    expect(countDuring(() => enrich(spaced(150), a))).toBe(countDuring(() => enrich(spaced(5), a)));
  });

  test("用户消息里写了 {{cur_datetime}} 与 {timezone}:也是常数", () => {
    const withVars = (turns: number) => history(turns).map((m) => (m.role === "USER" ? { ...m, parts: [{ type: "text" as const, text: "现在 {{cur_datetime}} {timezone} {locale}" }] } : m));
    expect(countDuring(() => enrich(withVars(150), assistant()))).toBe(countDuring(() => enrich(withVars(5), assistant())));
  });
});
