// tools/mcp-health.ts — MCP 连接健康：故障分类（模型可读诊断）+ 健康 Supervisor（后台探活/主动重连）。
//
// 单一事实源 = McpHealthDiagnosis。一份判定、两处渲染：
//   渲染 A（模型）：format.ts 把它渲染成结构化诊断单条回灌 tool_result（决策④）。
//   渲染 B（UI）  ：supervisor 状态经 /api/events 通道推给 extensions.tsx 状态灯（决策①）。
//
// 纪律：
//   - 健康状态是【内存态运行时数据】，不落盘、不进 settings、不进备份——与 state.logs 同类
//     （重启 = 干净 idle 重新探活）。写 settings 会让 saveState 每次探活都全量重写 state.json。
//   - 推送并入既有 /api/events 通道（事件名 mcp_health），【禁止新开常驻 SSE 端点】
//     （连接预算纪律，sse.ts:101）。
//   - 不推翻惰性握手模型，Supervisor 是叠加层：探活复用真实 tools/list（不依赖可选的 ping），
//     重连成功预填 mcp 的 session 缓存，让用户的下一次真实调用是热的。

import { isRecord } from "../foundation/utils";
import type { JsonValue } from "../foundation/types";
import { mcpJsonRpc } from "./mcp";
import { broadcastMcpHealth } from "../api/sse";

// ---------------------------------------------------------------------------
// 故障分类（决策④的翻译层：把开发者向报错升级为机器可读判定）
// ---------------------------------------------------------------------------

export type McpFailureKind =
  | "network_transient"   // 网络抖动/超时 —— 模型可重试
  | "auth_expired"        // 授权过期/鉴权失败 —— 只有用户重新授权能救
  | "server_unavailable"  // 服务器持续不可用（后台重连失败达上限）—— 换路
  | "config_error"        // 配置错误（URL 非法等）—— 用户改配置
  | "unknown";

export interface McpFailureClassification {
  kind: McpFailureKind;
  /** 模型能否自救（重试/换工具）。auth_expired / config_error 恒 false。 */
  retryable: boolean;
  /** 给模型的机器可读建议动作。 */
  action: "retry_with_backoff" | "inform_user_reauthorize" | "try_alternative_tool" | "inform_user_fix_config" | "inform_user";
}

/** 从 exception 归一到故障分类。message 扫描与安卓 needsAuthorization / looksUnauthorized 同族，
 *  但面向"可自救性"而非仅"是否需要授权"。 */
export function classifyMcpFailure(err: unknown): McpFailureClassification {
  const message = collectMessage(err).toLowerCase();

  // 授权过期：401 / invalid_token / unauthorized。模型无法自救，须告知用户重新授权。
  if (
    message.includes("401") ||
    message.includes("unauthorized") ||
    message.includes("invalid_token") ||
    message.includes("invalid access token") ||
    message.includes("missing or invalid") && message.includes("token")
  ) {
    return { kind: "auth_expired", retryable: false, action: "inform_user_reauthorize" };
  }

  // 配置错误：URL 非法 / 服务器 URL 缺失。重试无意义，须用户改配置。
  if (message.includes("must be http") || message.includes("url") && (message.includes("invalid") || message.includes("为空") || message.includes("非法"))) {
    return { kind: "config_error", retryable: false, action: "inform_user_fix_config" };
  }

  // 网络瞬态：超时 / 连接重置 / 连接拒绝 / DNS。可自救（重试或换工具）。
  if (
    message.includes("timed out") || message.includes("timeout") ||
    message.includes("econnreset") || message.includes("econnrefused") ||
    message.includes("etimedout") || message.includes("enotfound") ||
    message.includes("socket") || message.includes("network") ||
    message.includes("fetch failed") || message.includes("connection")
  ) {
    return { kind: "network_transient", retryable: true, action: "retry_with_backoff" };
  }

  // HTTP 5xx：服务器侧问题，可能瞬态也可能持续。标可重试，交给重连退避兜底。
  if (/\b5\d\d\b/.test(message)) {
    return { kind: "network_transient", retryable: true, action: "retry_with_backoff" };
  }

  return { kind: "unknown", retryable: true, action: "try_alternative_tool" };
}

function collectMessage(err: unknown): string {
  if (err instanceof Error) {
    const parts: string[] = [err.message];
    let cause: unknown = err.cause;
    let depth = 0;
    while (cause instanceof Error && depth < 5) {
      parts.push(cause.message);
      cause = cause.cause;
      depth += 1;
    }
    return parts.join(" ");
  }
  return String(err);
}

// ---------------------------------------------------------------------------
// 结构化诊断回灌（决策④的模型侧渲染）
// ---------------------------------------------------------------------------

/** 取服务器显示名（诊断标注用，容错）。 */
function serverNameOf(server: Record<string, JsonValue> | null, toolName: string): string {
  if (!server) return toolName;
  const common = isRecord(server.commonOptions) ? server.commonOptions : {};
  const name = String(common.name ?? "").trim();
  return name || toolName;
}

/** 把 MCP 调用失败渲染成机器可读的结构化诊断 Error（回灌模型的 tool_result 文本本体）。
 *  格式：单行头（kind/retryable/action）+ 尾部 cause 保留原始细节。模型靠头做决策，
 *  不再对救不活的故障（授权过期等）死磕重试。
 *  解析方（前端失败卡）按 MCP_TOOL_FAILURE 前缀识别并还原结构化字段。 */
export function mcpToolFailureError(
  server: Record<string, JsonValue> | null,
  toolName: string,
  err: unknown,
): Error {
  const cls = classifyMcpFailure(err);
  const serverName = serverNameOf(server, toolName);
  const cause = collectMessage(err).trim() || "unknown error";
  const text =
    `MCP_TOOL_FAILURE server=${JSON.stringify(serverName)} kind=${cls.kind} ` +
    `retryable=${cls.retryable} action=${cls.action}\ncause=${JSON.stringify(cause.slice(0, 500))}`;
  return new Error(text);
}

// ---------------------------------------------------------------------------
// 健康 Supervisor（决策①③的后台探活/主动重连层）
// ---------------------------------------------------------------------------

/** 单台 MCP 服务器的健康快照（前端状态灯的唯一数据源）。形状即线上契约 McpHealthEntryDto。 */
export type McpHealthEntry =
  | { status: "ready" }
  | { status: "reconnecting"; attempt: number; maxAttempts: number }
  | { status: "failed"; kind: McpFailureKind; retryable: boolean; message: string; consecutiveFailures: number; checkedAt: number };

/** 推给前端的整体快照：只含"被启用且被至少一个助手选中"的服务器（决策①：闲置服务器不探活、不出现在状态面）。 */
export type McpHealthSnapshot = Record<string, McpHealthEntry>;

/** 决策①的探活门槛：服务器被启用 且 被至少一个助手选中。闲置服务器永不探活、状态面永不标红。 */
export function isServerInUse(
  server: Record<string, JsonValue>,
  assistants: ReadonlyArray<{ mcpServers?: JsonValue }>,
): boolean {
  const common = isRecord(server.commonOptions) ? server.commonOptions : {};
  if (common.enable === false) return false;
  const id = String(server.id ?? "");
  if (!id) return false;
  return assistants.some((a) => Array.isArray(a.mcpServers) && (a.mcpServers as JsonValue[]).map(String).includes(id));
}

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;

interface ServerRuntime {
  entry: McpHealthEntry;
  consecutiveFailures: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  probing: boolean;
}

/** 由 Supervisor 注入的依赖（bootstrap 显式接线，避免 tools → persistence/api 的反向硬依赖）。 */
export interface McpHealthDeps {
  getServers: () => Array<Record<string, JsonValue>>;
  getAssistants: () => ReadonlyArray<{ mcpServers?: JsonValue }>;
  /** 探活执行体：默认真实 tools/list；测试注入桩。返回 = 健康；抛错 = 故障。 */
  probe: (server: Record<string, JsonValue>) => Promise<unknown>;
}

/** 后台探活 + 主动重连 Supervisor。
 *  - 引擎无关：管的是"这台 MCP 服务器连没连上"，与"哪个引擎在用它"解耦。
 *    bootstrap 启动一次、监听配置变化 reconcile，对话/pi/未来引擎经 executeToolCall 自动继承。
 *  - 不推翻惰性握手：探活复用真实 tools/list；失败按指数退避主动重连（对齐 APP 1s→30s、5 次）。
 *  - 资源自律（连接预算）：同一时刻只探一台、单服务器失败退避封顶、闲置服务器不探。 */
export class McpHealthSupervisor {
  private readonly runtimes = new Map<string, ServerRuntime>();
  private readonly deps: McpHealthDeps;
  private disposed = false;

  constructor(deps: McpHealthDeps) {
    this.deps = deps;
  }

  /** 当前快照（/api/events 初始帧 + 增量广播共用）。 */
  snapshot(): McpHealthSnapshot {
    const out: McpHealthSnapshot = {};
    for (const [id, rt] of this.runtimes) out[id] = rt.entry;
    return out;
  }

  /** 决策①：某服务器当前是否应被探活。 */
  private inUse(server: Record<string, JsonValue>): boolean {
    return isServerInUse(server, this.deps.getAssistants());
  }

  /** 配置变化时 reconcile：新上线服务器立即探一次，下线/失用服务器清态。 */
  reconcile(): void {
    if (this.disposed) return;
    const servers = this.deps.getServers();
    const inUseIds = new Set(servers.filter((s) => this.inUse(s)).map((s) => String(s.id ?? "")));

    // 清掉不再 in-use 的（禁用/取消选中/删除）——状态面跟着消失，不留孤儿。
    for (const [id, rt] of this.runtimes) {
      if (!inUseIds.has(id)) {
        if (rt.reconnectTimer) clearTimeout(rt.reconnectTimer);
        this.runtimes.delete(id);
      }
    }
    // 新出现的 in-use 服务器：登记并立即探一次。
    for (const server of servers) {
      const id = String(server.id ?? "");
      if (!inUseIds.has(id) || this.runtimes.has(id)) continue;
      this.runtimes.set(id, {
        entry: { status: "reconnecting", attempt: 0, maxAttempts: MAX_RECONNECT_ATTEMPTS },
        consecutiveFailures: 0,
        reconnectTimer: null,
        probing: false,
      });
      void this.probe(server);
    }
    broadcastMcpHealth();
  }

  /** 探活一台服务器（同一时间一台，probing 守卫防重入）。 */
  private async probe(server: Record<string, JsonValue>): Promise<void> {
    const id = String(server.id ?? "");
    const rt = this.runtimes.get(id);
    if (!rt || rt.probing || this.disposed) return;
    rt.probing = true;
    try {
      await this.deps.probe(server);
      // 成功：清零失败计数、回到 ready、停掉任何挂起的重连。
      rt.consecutiveFailures = 0;
      if (rt.reconnectTimer) { clearTimeout(rt.reconnectTimer); rt.reconnectTimer = null; }
      rt.entry = { status: "ready" };
      broadcastMcpHealth();
    } catch (err) {
      this.onProbeFailure(server, rt, err);
    } finally {
      rt.probing = false;
    }
  }

  private onProbeFailure(server: Record<string, JsonValue>, rt: ServerRuntime, err: unknown): void {
    rt.consecutiveFailures += 1;
    const cls = classifyMcpFailure(err);
    // auth/config 类不可自救——直接 failed 并停止重连（重试无意义，须用户介入）；
    // 其余按指数退避主动重连，达到上限转 failed(server_unavailable)。
    const fatal = cls.kind === "auth_expired" || cls.kind === "config_error";
    const exhausted = rt.consecutiveFailures >= MAX_RECONNECT_ATTEMPTS;
    if (fatal || exhausted) {
      const kind: McpFailureKind = fatal ? cls.kind : "server_unavailable";
      rt.entry = {
        status: "failed",
        kind,
        retryable: cls.retryable && !fatal,
        message: collectMessage(err).slice(0, 300),
        consecutiveFailures: rt.consecutiveFailures,
        checkedAt: Date.now(),
      };
      if (rt.reconnectTimer) { clearTimeout(rt.reconnectTimer); rt.reconnectTimer = null; }
      broadcastMcpHealth();
      return;
    }
    // 退避重连：1s/2s/4s/8s/16s（封顶 30s）。
    const attempt = rt.consecutiveFailures;
    rt.entry = { status: "reconnecting", attempt, maxAttempts: MAX_RECONNECT_ATTEMPTS };
    broadcastMcpHealth();
    const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** (attempt - 1), MAX_RECONNECT_DELAY_MS);
    if (rt.reconnectTimer) clearTimeout(rt.reconnectTimer);
    rt.reconnectTimer = setTimeout(() => {
      rt.reconnectTimer = null;
      if (this.disposed) return;
      // 重连前重读最新配置（探活期间可能被改/禁用）。
      const fresh = this.deps.getServers().find((s) => String(s.id ?? "") === String(server.id ?? ""));
      if (fresh && this.inUse(fresh)) void this.probe(fresh);
    }, delay);
  }

  /** 用户手动触发重连（设置页"立即重连"按钮）：清失败计数、立即探一次。 */
  retryNow(serverId: string): void {
    const server = this.deps.getServers().find((s) => String(s.id ?? "") === serverId);
    if (!server || !this.inUse(server)) return;
    let rt = this.runtimes.get(serverId);
    if (!rt) {
      rt = { entry: { status: "reconnecting", attempt: 0, maxAttempts: MAX_RECONNECT_ATTEMPTS }, consecutiveFailures: 0, reconnectTimer: null, probing: false };
      this.runtimes.set(serverId, rt);
    }
    rt.consecutiveFailures = 0;
    if (rt.reconnectTimer) { clearTimeout(rt.reconnectTimer); rt.reconnectTimer = null; }
    rt.entry = { status: "reconnecting", attempt: 0, maxAttempts: MAX_RECONNECT_ATTEMPTS };
    broadcastMcpHealth();
    void this.probe(server);
  }

  dispose(): void {
    this.disposed = true;
    for (const rt of this.runtimes.values()) {
      if (rt.reconnectTimer) clearTimeout(rt.reconnectTimer);
    }
    this.runtimes.clear();
  }
}

/** 默认探活执行体：真实 tools/list（一次性 JSON-RPC，mcpJsonRpc 内部已带惰性重握手兜底）。 */
export const defaultMcpProbe: McpHealthDeps["probe"] = (server) => mcpJsonRpc(server, "tools/list");

// ---------------------------------------------------------------------------
// 进程级单例 + 启动接线（引擎无关层，bootstrap 启动一次）
// ---------------------------------------------------------------------------

let singleton: McpHealthSupervisor | null = null;

/** bootstrap 启动一次：实例化 Supervisor 并立刻 reconcile（对当前配置探活一轮）。
 *  引擎无关——不挂在任何引擎编排器上，对话/pi/未来引擎经 executeToolCall 自动继承健康面。 */
export function startMcpHealthSupervisor(deps: Omit<McpHealthDeps, "probe"> & { probe?: McpHealthDeps["probe"] }): McpHealthSupervisor {
  if (singleton) return singleton;
  singleton = new McpHealthSupervisor({ probe: defaultMcpProbe, ...deps });
  singleton.reconcile();
  return singleton;
}

/** 配置变化时调用（updateSettings 后）：重评探活集合。 */
export function reconcileMcpHealth(): void {
  singleton?.reconcile();
}

/** 前端"立即重连"按钮。 */
export function retryMcpServerNow(serverId: string): void {
  singleton?.retryNow(serverId);
}

/** 测试用：重置单例（避免跨用例泄漏定时器）。 */
export function __resetMcpHealthForTest(): void {
  singleton?.dispose();
  singleton = null;
}
