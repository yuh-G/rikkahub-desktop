// api/logs.ts — 请求日志与统计计数（addLog、stats 归一化）
// 纪律：只负责 state.logs / state.stats 的累加与归一化。

import type { RequestLog, RequestStats } from "../foundation/types";
import { id, isRecord } from "../foundation/utils";
import { scheduleThrottledSaveState, state } from "../persistence/json-store";

function classifyRequestGroup(kind: string, toolName: string): string {
  if (kind.startsWith("mcp:")) return "MCP 请求";
  if (kind.startsWith("search:") || kind.startsWith("tool:search") || kind.startsWith("tool:scrape") || toolName === "search_web" || toolName === "scrape_web") return "搜索引擎请求";
  return "模型请求";
}

export function defaultRequestStats(): RequestStats {
  return { totalRequests: 0, failedRequests: 0, byProvider: {}, byGroup: {} };
}

// 把一条请求日志的计数累加进 stats(既用于实时累加,也用于老用户一次性迁移)。
function bumpStatsCounters(stats: RequestStats, log: { ok: boolean; providerName: string; kind?: string; toolName?: string }): void {
  stats.totalRequests += 1;
  if (!log.ok) stats.failedRequests += 1;
  const prov = stats.byProvider[log.providerName] ?? { ok: 0, failed: 0 };
  if (log.ok) prov.ok += 1; else prov.failed += 1;
  stats.byProvider[log.providerName] = prov;
  const group = classifyRequestGroup(String(log.kind ?? ""), String(log.toolName ?? ""));
  const grp = stats.byGroup[group] ?? { ok: 0, failed: 0 };
  if (log.ok) grp.ok += 1; else grp.failed += 1;
  stats.byGroup[group] = grp;
}

// 老用户的 state.json 没有 stats 字段(统计以前藏在持久化 logs 里)。加载时把旧 logs
// 的统计一次性累加进 stats —— 之后 logs 改内存态会丢弃,但累计统计得以保留,老用户重启
// 后统计页不会归零。新版本已有 stats 字段时直接沿用,不重复迁移(避免双算)。
export function normalizeRequestStats(raw: unknown, legacyLogs: RequestLog[]): RequestStats {
  if (isRecord(raw) && (typeof raw.totalRequests === "number" || isRecord(raw.byProvider) || isRecord(raw.byGroup))) {
    const base = defaultRequestStats();
    base.totalRequests = typeof raw.totalRequests === "number" ? raw.totalRequests : 0;
    base.failedRequests = typeof raw.failedRequests === "number" ? raw.failedRequests : 0;
    if (isRecord(raw.byProvider)) {
      for (const [k, v] of Object.entries(raw.byProvider)) {
        if (isRecord(v) && typeof v.ok === "number" && typeof v.failed === "number") base.byProvider[k] = { ok: v.ok, failed: v.failed };
      }
    }
    if (isRecord(raw.byGroup)) {
      for (const [k, v] of Object.entries(raw.byGroup)) {
        if (isRecord(v) && typeof v.ok === "number" && typeof v.failed === "number") base.byGroup[k] = { ok: v.ok, failed: v.failed };
      }
    }
    return base;
  }
  const migrated = defaultRequestStats();
  for (const log of legacyLogs) bumpStatsCounters(migrated, log);
  return migrated;
}

// ── 6-1 日志脱敏 ──────────────────────────────────────────────
// 调用方把真实凭据放在 headers/URL 里传入(search 17 引擎的 Bearer/x-api-key、
// MCP 自定义 headers、Google 系 URL ?key=)。logs 虽是内存态,但 /api/logs 全量
// 暴露给 Web UI:截图求助、远程部署(--host 0.0.0.0)都会泄露。在 addLog 入口
// 统一打码,内存里就不留明文。打码规则与 search 的 maskSearchKey 一致(首尾保留)。

const SENSITIVE_HEADER_RE = /key|token|secret|auth|cookie|password/i;
const SENSITIVE_QUERY_RE = /^(key|api[_-]?key|token|access[_-]?token|auth|secret|password|sig|signature)$/i;

function maskSecret(value: string): string {
  const v = value.trim();
  if (v.length === 0) return "";
  if (v.length <= 4) return `${v[0]}***`;
  if (v.length <= 8) return `${v.slice(0, 2)}***${v.slice(-2)}`;
  return `${v.slice(0, 3)}***${v.slice(-3)}`;
}

/** Authorization 类值保留 scheme(Bearer/Basic/Token),仅打码凭据本体。 */
function maskHeaderValue(value: string): string {
  const m = value.match(/^(Bearer|Basic|Token)\s+(.+)$/i);
  if (m) return `${m[1]} ${maskSecret(m[2]!)}`;
  return maskSecret(value);
}

export function sanitizeLogHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SENSITIVE_HEADER_RE.test(name) ? maskHeaderValue(value) : value;
  }
  return out;
}

/** 打码 URL query 中的敏感参数与 userinfo 密码;非法 URL 原样返回。 */
export function sanitizeLogUrl(url: string): string {
  try {
    const u = new URL(url);
    let changed = false;
    for (const [name, value] of u.searchParams.entries()) {
      if (SENSITIVE_QUERY_RE.test(name) && value) {
        u.searchParams.set(name, maskSecret(value));
        changed = true;
      }
    }
    if (u.password) {
      u.password = "***";
      changed = true;
    }
    return changed ? u.toString() : url;
  } catch {
    return url;
  }
}

export function addLog(input: Omit<RequestLog, "id" | "at">) {
  bumpStatsCounters(state.stats, input);
  const entry: RequestLog = { id: id(), at: Date.now(), ...input, url: sanitizeLogUrl(input.url) };
  if (entry.requestHeaders) entry.requestHeaders = sanitizeLogHeaders(entry.requestHeaders);
  if (entry.responseHeaders) entry.responseHeaders = sanitizeLogHeaders(entry.responseHeaders);
  state.logs.unshift(entry);
  state.logs = state.logs.slice(0, 100);
  // R1-6:每条请求日志一次全量 state 序列化落盘是放大的 IO(高频工具调用期尤甚),
  // 改节流保存——日志/计数是可容忍秒级丢失的非关键数据,与流式期间的既有节流语义一致。
  scheduleThrottledSaveState();
}
