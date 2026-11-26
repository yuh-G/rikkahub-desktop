// foundation/utils.ts — 纯工具函数
// 纪律：不依赖业务状态，不引入副作用。

import type { JsonValue, Message, MessagePart, TextPart, ToolOutputEntry } from "./types";

export function compareSemver(a: string, b: string): number {
  const norm = (v: string) => v.replace(/^v/i, "").trim();
  const partsA = norm(a).split(".");
  const partsB = norm(b).split(".");
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const ap = partsA[i] ?? "0";
    const bp = partsB[i] ?? "0";
    const an = Number.parseInt(ap, 10);
    const bn = Number.parseInt(bp, 10);
    if (Number.isFinite(an) && Number.isFinite(bn) && String(an) === ap && String(bn) === bp) {
      if (an !== bn) return an > bn ? 1 : -1;
    } else {
      const cmp = ap.localeCompare(bp);
      if (cmp !== 0) return cmp > 0 ? 1 : -1;
    }
  }
  return 0;
}

export function id() {
  return crypto.randomUUID();
}

export function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function textFromParts(parts: ToolOutputEntry[]) {
  return parts
    .map((part) => {
      if (part && typeof part === "object" && !Array.isArray(part) && part.type === "text") return String((part as TextPart).text ?? "");
      return "";
    })
    .join("\n")
    .trim();
}

export function renderTemplate(template: string, variables: Record<string, string>) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => variables[key] ?? match);
}

export function applyPlaceholders(template: string, variables: Record<string, string>) {
  return template
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => variables[key] ?? match)
    .replace(/\{\s*([a-zA-Z0-9_]+)\s*\}/g, (match, key) => variables[key] ?? match);
}

export function localeDisplayName() {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(locale.split("-")[0]) ?? locale;
  } catch {
    return locale;
  }
}

export function estimateTokens(text: string) {
  const cjk = (text.match(/[㐀-鿿]/g) ?? []).length;
  const other = Math.max(0, text.length - cjk);
  return Math.max(1, Math.ceil(cjk * 0.9 + other / 4));
}

export function dateKey(timestamp: number | string) {
  return formatKeyLocal(new Date(timestamp));
}

export function formatKeyLocal(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function getStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function isRecord(value: unknown): value is Record<string, JsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** base64 data URL → { mime, data };其它形态返回 null。 */
export function parseDataUrl(url: string) {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/);
  return match ? { mime: match[1]!, data: match[2]! } : null;
}

export function mergeById<T extends { id: string }>(current: T[], defaults: T[]): T[] {
  const byId = new Set(current.map((item) => item.id));
  return [...current, ...defaults.filter((item) => !byId.has(item.id))];
}

export function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === "bigint") return Number(val);
    if (val !== null && typeof val === "object") {
      if (seen.has(val)) return undefined;
      seen.add(val);
    }
    return val;
  }, 2);
}

export function backupStamp(): string {
  // 对齐安卓 DateTimeFormatter.ofPattern("yyyyMMdd_HHmmss")——安卓用的是本地时区,
  // 此前 toISOString() 是 UTC,中国用户导出的文件名时间早 8 小时,跨端排序错位(1-9)。
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function stripHtml(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function domainOfUrl(targetUrl: string) {
  try {
    return new URL(targetUrl).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function faviconForUrl(targetUrl: string) {
  const domain = domainOfUrl(targetUrl);
  return domain ? `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico` : "";
}

export function guessMimeFromExt(ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(e)) return `image/${e === "jpg" ? "jpeg" : e}`;
  if (e === "pdf") return "application/pdf";
  if (e === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (e === "txt" || e === "md") return "text/plain";
  return "application/octet-stream";
}

export function extensionFromMime(mime: string) {
  const normalized = mime.toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return ".jpg";
  if (normalized.includes("webp")) return ".webp";
  if (normalized.includes("gif")) return ".gif";
  if (normalized.includes("svg")) return ".svg";
  if (normalized.includes("pdf")) return ".pdf";
  if (normalized.includes("json")) return ".json";
  if (normalized.includes("text")) return ".txt";
  return ".png";
}

export function mergeObjects(base: Record<string, any>, overlay: Record<string, any>): Record<string, any> {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = result[key];
    result[key] = isRecord(existing) && isRecord(value)
      ? mergeObjects(existing as Record<string, any>, value as Record<string, any>)
      : value;
  }
  return result;
}

export function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function visibleTextFromMessage(msg: Message | undefined) {
  return msg ? textFromParts(msg.parts) : "";
}

export function visibleReasoningFromMessage(msg: Message | undefined) {
  return msg
    ? msg.parts
        .map((part) => isRecord(part) && part.type === "reasoning" ? String(part.reasoning ?? "") : "")
        .filter(Boolean)
        .join("")
    : "";
}

export function reasoningFromParts(parts: MessagePart[]) {
  return parts
    .map((part) => (isRecord(part) && part.type === "reasoning" ? String(part.reasoning ?? "") : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function message(role: Message["role"], parts: MessagePart[], modelId: string | null = null): Message {
  const now = new Date().toISOString();
  return {
    id: id(),
    role,
    parts,
    annotations: [],
    createdAt: now,
    finishedAt: role === "ASSISTANT" ? now : null,
    modelId,
    usage: null,
    translation: null,
  };
}

function hasJsonItemId(items: unknown, idValue: string) {
  return Array.isArray(items) && items.some((item) => isRecord(item) && String(item.id ?? "") === idValue);
}

export function validateKnownJsonIds(items: unknown, ids: unknown, fieldName: string) {
  const requested = getStringArray(ids);
  const unknownId = requested.find((itemId) => !hasJsonItemId(items, itemId));
  if (unknownId) throw new Error(`${fieldName} contains unknown id: ${unknownId}`);
  return requested;
}

export function upsertById(items: JsonValue[], item: Record<string, JsonValue>) {
  const itemId = String(item.id ?? id());
  const nextItem = { ...item, id: itemId };
  const exists = items.some((entry) => isRecord(entry) && String(entry.id) === itemId);
  return {
    item: nextItem,
    items: exists ? items.map((entry) => (isRecord(entry) && String(entry.id) === itemId ? nextItem : entry)) : [...items, nextItem],
  };
}

export function deleteById(items: JsonValue[], idValue: string) {
  return items.filter((entry) => !(isRecord(entry) && String(entry["id"]) === idValue));
}

export function reorderByIds<T extends JsonValue>(items: T[], ids: string[]) {
  const byId = new Map(items.filter(isRecord).map((item) => [String((item as Record<string, JsonValue>)["id"]), item as T]));
  const ordered = ids.map((itemId) => byId.get(itemId)).filter(Boolean) as T[];
  const rest = items.filter((item) => !isRecord(item) || !ids.includes(String((item as Record<string, JsonValue>)["id"])));
  return [...ordered, ...rest];
}


/**
 * 首次升级到 SQLite 版:① 备份 .bak → ② 灌库 → ③ 写瘦 state.json。
 * @returns true=已迁移/迁移成功(从活库读);false=灌库失败(本次用 parsed.conversations 兜底,
 *          state.json 保持原样,下次启动重试)。
 */
