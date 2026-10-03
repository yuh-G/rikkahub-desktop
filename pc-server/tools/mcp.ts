// tools/mcp.ts — MCP 客户端实现
// 纪律：负责 MCP SSE/streamable_http 会话、tools/list 同步、tools/call 调用；
//       不直接读写 state，日志与 mcpServers 通过参数注入。

import { id, isRecord } from "../foundation/utils";
import { oauthStateOf } from "./mcp-oauth";
import { readMcpHeaders } from "./mcp-headers";
import { jsonBody, textBody } from "../model-providers";
import type { Assistant, JsonValue, RequestLog } from "../foundation/types";
import { getStringArray } from "../foundation/utils";
import { isMcpToolEnabledForAssistant } from "./approval";

export type McpLogCallback = (log: RequestLog) => void;

function headersFromMcpServer(server: Record<string, JsonValue>) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const common = isRecord(server.commonOptions) ? server.commonOptions : {};
  for (const header of readMcpHeaders(common.headers)) {
    const key = header.name.trim();
    if (key) headers[key] = header.value;
  }
  // 专题9 MCP OAuth 2.1:已授权的服务器注入 Bearer 令牌(对齐安卓 transport requestBuilder)。
  // 用户手配的 Authorization 头优先——不覆盖显式配置。
  const oauth = oauthStateOf(server);
  if (oauth?.enabled === true && oauth.accessToken && !Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) {
    headers.Authorization = `Bearer ${oauth.accessToken}`;
  }
  return headers;
}

function parseMcpResponseText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const dataLines = trimmed
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.replace(/^data:\s?/, "").trim())
      .filter((line) => line && line !== "[DONE]");
    for (const line of dataLines.reverse()) {
      try {
        return JSON.parse(line);
      } catch {
        // Continue scanning older SSE data frames.
      }
    }
    return { text };
  }
}

function resolveMcpSseEndpoint(baseUrl: string, endpoint: string) {
  const trimmed = endpoint.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return new URL(trimmed, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

const mcpSessionCache = new Map<string, { sessionId: string; protocolVersion?: string }>();
// R3-3:SSE 型 MCP 的 POST endpoint 是运行时会话产物(常带 sessionId),不应持久化进
// settings——服务器重启后旧 endpoint 失效,持久化会让重启 PC 也救不回来。改为与
// mcpSessionCache 同级的内存 Map,与 session 同生命周期(清 session 时一并清)。
const mcpSsePostEndpointCache = new Map<string, string>();
const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// R3-10:tools/call 是唯一还卡在 30s 的慢任务通道(本地生图 300s、ASR/TTS 120s、辅助流
// 600s 都已放宽)。生成/爬取型 MCP 工具常 >30s,超时后模型反复重试烧轮次。tools/call 放宽
// 到 300s,握手/list 等控制面仍用 30s(它们本应秒级返回,长挂即异常)。
const MCP_DEFAULT_TIMEOUT_MS = 30_000;
const MCP_TOOL_CALL_TIMEOUT_MS = 300_000;

function mcpSessionCacheKey(server: Record<string, JsonValue>) {
  const common = isRecord(server.commonOptions) ? server.commonOptions : {};
  const headers = Array.isArray(common.headers) ? common.headers : [];
  return JSON.stringify({
    id: String(server.id ?? ""),
    type: String(server.type ?? "streamable_http"),
    url: String(server.url ?? ""),
    headers,
  });
}

export async function readMcpSseUntilEndpoint(response: Response, timeoutMs = 15000) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE MCP response has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  // R3-2:握手预算以外层 timeoutMs(15s)为准。原实现把每次 read 包一个 1s reject,服务器
  // 静默超 1 秒即抛出"endpoint event timeout",15s 预算永远达不到——SSE 型 MCP 冷启动/跨洋
  // 高延迟时用户配置正确却永远"连接失败"。改为 1s tick 唤醒:定时器只用于周期性复查外层
  // 预算(resolve 一个哨兵后 continue),不再判失败。关键:必须复用同一个 pending read——
  // Web Streams 不允许对同一 reader 并发 read(),tick 后重新 read() 会抛"already reading"。
  let pendingRead: ReturnType<typeof reader.read> | null = null;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`SSE MCP endpoint event timeout after ${Math.round(timeoutMs / 1000)}s`);
      const read = pendingRead ?? (pendingRead = reader.read());
      let tick: ReturnType<typeof setTimeout> | null = null;
      const raced = await Promise.race([
        read.then((r) => ({ kind: "read" as const, r })),
        new Promise<{ kind: "tick" }>((resolve) => {
          tick = setTimeout(() => resolve({ kind: "tick" }), Math.min(1000, remaining));
        }),
      ]).finally(() => { if (tick) clearTimeout(tick); });
      if (raced.kind === "tick") continue; // 醒来复查外层预算,继续等同一个 read
      pendingRead = null; // 本次 read 已消费,下轮再发起新的
      if (raced.r.done) break;
      buffer += decoder.decode(raced.r.value, { stream: true });
      const events = buffer.split(/\n\n+/);
      buffer = events.pop() ?? "";
      for (const eventBlock of events) {
        const eventName = eventBlock.split(/\r?\n/).find((line) => line.startsWith("event:"))?.replace(/^event:\s*/, "").trim() ?? "";
        const data = eventBlock
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.replace(/^data:\s?/, ""))
          .join("\n")
          .trim();
        if (eventName === "endpoint" && data) return data;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors from the long-lived SSE stream.
    }
  }
  throw new Error("SSE MCP endpoint event was not received");
}

async function mcpSsePostEndpoint(server: Record<string, JsonValue>, log?: McpLogCallback) {
  const cacheKey = mcpSessionCacheKey(server);
  const cached = mcpSsePostEndpointCache.get(cacheKey);
  if (cached) return cached;
  const target = String(server.url ?? "").trim();
  if (!/^https?:\/\//i.test(target)) throw new Error("MCP SSE server URL must be http(s)");
  const started = Date.now();
  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(target, { headers: headersFromMcpServer(server), signal: ac.signal });
  } catch (err) {
    clearTimeout(timeoutId);
    const aborted = err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
    throw new Error(aborted ? "MCP SSE handshake timed out after 30s" : err instanceof Error ? err.message : String(err));
  }
  clearTimeout(timeoutId);
  const endpoint = resolveMcpSseEndpoint(target, await readMcpSseUntilEndpoint(response));
  log?.({
    id: id(),
    at: Date.now(),
    providerId: String(server.id ?? "mcp"),
    providerName: String(isRecord(server.commonOptions) ? server.commonOptions.name ?? "MCP Server" : "MCP Server"),
    url: target,
    ok: true,
    status: response.status,
    kind: "mcp:sse:endpoint",
    durationMs: Date.now() - started,
    responseBody: endpoint,
    toolName: "endpoint",
  });
  mcpSsePostEndpointCache.set(cacheKey, endpoint);
  return endpoint;
}

async function postMcpJsonRpc(
  server: Record<string, JsonValue>,
  method: string,
  params: Record<string, JsonValue> | undefined,
  extraHeaders: Record<string, string> = {},
  options: { notification?: boolean; timeoutMs?: number } = {},
  log?: McpLogCallback,
) {
  const timeoutMs = options.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
  const target = String(server.type ?? "streamable_http") === "sse"
    ? await mcpSsePostEndpoint(server, log)
    : String(server.url ?? "").trim();
  if (!/^https?:\/\//i.test(target)) throw new Error("MCP server URL must be http(s)");
  const body = options.notification
    ? { jsonrpc: "2.0", method, params: params ?? {} }
    : { jsonrpc: "2.0", id: id(), method, params: params ?? {} };
  const started = Date.now();
  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(), timeoutMs);
  let response: Response;
  let text: string;
  const requestHeaders = { ...headersFromMcpServer(server), ...extraHeaders };
  try {
    response = await fetch(target, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    text = await response.text();
  } catch (err) {
    clearTimeout(timeoutId);
    const aborted = err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
    const reason = aborted ? `MCP request timed out after ${Math.round(timeoutMs / 1000)}s` : err instanceof Error ? err.message : String(err);
    log?.({
      id: id(),
      at: Date.now(),
      providerId: String(server.id ?? "mcp"),
      providerName: String(isRecord(server.commonOptions) ? server.commonOptions.name ?? "MCP Server" : "MCP Server"),
      url: target,
      ok: false,
      status: 0,
      kind: `mcp:${method}`,
      durationMs: Date.now() - started,
      method: "POST",
      requestHeaders,
      requestBody: jsonBody(body),
      responseBody: "",
      toolName: method,
      error: reason,
    });
    throw new Error(reason);
  }
  clearTimeout(timeoutId);
  const raw: any = parseMcpResponseText(text);
  log?.({
    id: id(),
    at: Date.now(),
    providerId: String(server.id ?? "mcp"),
    providerName: String(isRecord(server.commonOptions) ? server.commonOptions.name ?? "MCP Server" : "MCP Server"),
    url: target,
    ok: response.ok && !raw.error,
    status: response.status,
    kind: `mcp:${method}`,
    durationMs: Date.now() - started,
    method: "POST",
    requestHeaders,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    requestBody: jsonBody(body),
    responseBody: textBody(text),
    toolName: method,
    error: response.ok && !raw.error ? undefined : jsonBody(raw.error ?? text),
  });
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 500)}`);
  if (raw.error) throw new Error(jsonBody(raw.error, 500));
  return {
    result: raw.result ?? raw,
    sessionId: response.headers.get("mcp-session-id") ?? response.headers.get("Mcp-Session-Id") ?? undefined,
    protocolVersion: typeof raw.result?.protocolVersion === "string" ? raw.result.protocolVersion : undefined,
  };
}

async function mcpSessionHeaders(server: Record<string, JsonValue>, log?: McpLogCallback) {
  const cacheKey = mcpSessionCacheKey(server);
  const cached = mcpSessionCache.get(cacheKey);
  if (cached?.sessionId) {
    return {
      "mcp-session-id": cached.sessionId,
      ...(cached.protocolVersion ? { "mcp-protocol-version": cached.protocolVersion } : {}),
    };
  }
  let init: Awaited<ReturnType<typeof postMcpJsonRpc>> | null = null;
  let lastError: unknown = null;
  for (const protocolVersion of MCP_PROTOCOL_VERSIONS) {
    try {
      init = await postMcpJsonRpc(server, "initialize", {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "RikkaHub PC", version: "pc-dev" },
      }, {}, {}, log);
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!init) {
    // R3-3:initialize 全数失败可能是 SSE POST endpoint 已失效(服务器重启)。清掉运行时
    // 缓存,让下一次调用重新握手拿新 endpoint,而不是永远卡在旧值上。
    mcpSsePostEndpointCache.delete(cacheKey);
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "MCP initialize failed"));
  }
  if (init.sessionId) mcpSessionCache.set(cacheKey, { sessionId: init.sessionId, protocolVersion: init.protocolVersion });
  const headers = init.sessionId
    ? {
      "mcp-session-id": init.sessionId,
      ...(init.protocolVersion ? { "mcp-protocol-version": init.protocolVersion } : {}),
    }
    : {};
  await postMcpJsonRpc(server, "notifications/initialized", {}, headers, { notification: true }, log);
  return headers;
}

export async function mcpJsonRpc(
  server: Record<string, JsonValue>,
  method: string,
  params?: Record<string, JsonValue>,
  log?: McpLogCallback,
) {
  const cacheKey = mcpSessionCacheKey(server);
  // R3-10:tools/call 走放宽后的超时;控制面(list 等)仍用默认。
  const timeoutMs = method === "tools/call" ? MCP_TOOL_CALL_TIMEOUT_MS : MCP_DEFAULT_TIMEOUT_MS;
  const headers = await mcpSessionHeaders(server, log);
  try {
    const response = await postMcpJsonRpc(server, method, params, headers, { timeoutMs }, log);
    return response.result;
  } catch (err) {
    // R3-3:重试前把 session 与 SSE endpoint 一并作废——服务器重启后二者同时失效,只换
    // session 不换 endpoint 救不回来。两个缓存任一命中即说明此前握手过,值得重握手一次。
    const hadCache = mcpSessionCache.has(cacheKey) || mcpSsePostEndpointCache.has(cacheKey);
    if (!hadCache) throw err;
    mcpSessionCache.delete(cacheKey);
    mcpSsePostEndpointCache.delete(cacheKey);
    const retryHeaders = await mcpSessionHeaders(server, log);
    const response = await postMcpJsonRpc(server, method, params, retryHeaders, { timeoutMs }, log);
    return response.result;
  }
}

export async function fetchMcpTools(server: Record<string, JsonValue>, log?: McpLogCallback) {
  const result = await mcpJsonRpc(server, "tools/list", undefined, log);
  const tools: JsonValue[] = Array.isArray(result.tools) ? result.tools : [];
  return tools.map((tool: any) => ({
    enable: true,
    name: String(tool.name ?? ""),
    description: tool.description ? String(tool.description) : null,
    inputSchema: tool.inputSchema ?? tool.input_schema ?? { type: "object", properties: {} },
    needsApproval: tool.needsApproval === true,
  })).filter((tool) => tool.name)
    // 专题11-P3:按名字序排序后再入库。部分 MCP 服务器 tools/list 返回顺序不稳定,
    // 同步后工具在请求体里的顺序跳动会让工具定义段之后的前缀缓存失效;
    // 用码点比较而非 localeCompare,保证跨机器/跨语言环境稳定。
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export async function syncMcpServerTools(server: Record<string, JsonValue>, log?: McpLogCallback) {
  const common = isRecord(server.commonOptions) ? server.commonOptions : {};
  const existingTools = Array.isArray(common.tools) ? common.tools.filter(isRecord) : [];
  const prefs = new Map<string, { enable: boolean; needsApproval: boolean }>();
  for (const t of existingTools) {
    const n = String(t.name ?? "");
    if (!n) continue;
    prefs.set(n, {
      enable: t.enable !== false,
      needsApproval: t.needsApproval === true,
    });
  }
  try {
    const fetched = await fetchMcpTools(server, log);
    const tools = fetched.map((tool) => {
      const pref = prefs.get(tool.name);
      return pref ? { ...tool, enable: pref.enable, needsApproval: pref.needsApproval } : tool;
    });
    return {
      ...server,
      commonOptions: {
        ...common,
        tools,
        lastSyncAt: Date.now(),
        lastSyncError: "",
        connected: true,
      },
    };
  } catch (err) {
    return {
      ...server,
      commonOptions: {
        ...common,
        lastSyncAt: Date.now(),
        lastSyncError: err instanceof Error ? err.message : String(err),
        connected: false,
      },
    };
  }
}

/** 解析工具名归属的服务器与原始工具名。D13(复查):调用前只补新目标服务器的令牌,
 *  需要先知道目标是谁;与 callMcpTool 共用同一筛选口径(助手选中/服务器启用/工具级
 *  开关放行),两处判定永不漂移。 */
export function resolveMcpToolServer(
  assistant: Assistant,
  toolName: string,
  mcpServers: JsonValue[],
): { server: Record<string, JsonValue>; rawToolName: string } | null {
  const selected = new Set(getStringArray(assistant.mcpServers));
  const servers = (mcpServers as Array<Record<string, JsonValue>>)
    .filter((server) => selected.has(String(server.id ?? "")) && isRecord(server.commonOptions) && server.commonOptions.enable !== false);
  for (const server of servers) {
    const common = server.commonOptions as Record<string, JsonValue>;
    const tools = Array.isArray(common.tools) ? common.tools.filter(isRecord) : [];
    const matched = tools.find((tool) =>
      isMcpToolEnabledForAssistant(assistant, String(server.id ?? ""), tool)
      && `mcp__${String(tool.name ?? "").replace(/[^a-zA-Z0-9_-]/g, "_")}` === toolName,
    );
    if (matched) return { server, rawToolName: String(matched.name) };
  }
  return null;
}

export async function callMcpTool(
  assistant: Assistant,
  toolName: string,
  args: Record<string, JsonValue>,
  mcpServers: JsonValue[],
  log?: McpLogCallback,
) {
  const resolved = resolveMcpToolServer(assistant, toolName, mcpServers);
  if (!resolved) throw new Error(`MCP tool '${toolName}' is not available for this assistant`);
  return mcpJsonRpc(resolved.server, "tools/call", { name: resolved.rawToolName, arguments: args }, log);
}
