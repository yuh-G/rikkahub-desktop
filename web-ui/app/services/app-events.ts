// 单一应用事件通道(连接预算纪律,服务端对照 pc-server/api/sse.ts 顶部注释)。
//
// WebView2 对同源 HTTP/1.1 仅 6 并发连接。此前设置/记忆/错误/列表失效各占一条常驻
// SSE,加上会话详情流共 5 条,只给图片/上传/API 留 1 个名额——多图会话一打开就连接
// 池饥饿(1.0.4 前的老问题在重构后复活)。现在四域共用一条 /api/events,且该连接由
// SharedWorker 持有、全浏览器所有标签页/窗口共享:N 个页面 = 1 条 events 连接。
// 每页常驻连接:1 条会话详情流 + 全局共享的 1 条 events。
//
// 【纪律】新增服务端推送一律在此注册事件名,禁止再开新的常驻 SSE 端点。
//
// 传输选择:支持 SharedWorker 的环境(WebView2/Chromium/Firefox/Safari 16+)走 worker
// 共享连接;构造失败或不支持(如个别精简 WebView)自动回退页内直连,行为等价、仅失去
// 跨页共享。协议与 worker 侧实现见 workers/app-events-worker.ts。
//
// 快照重放:服务端连接即推各域完整快照,但订阅方(React effect)可能晚于首帧注册;
// 通道缓存各快照事件的最新一帧,注册时立即补发,消除时序耦合。增量事件(app_error)
// 不重放——重放会造成重复 toast/计数。
import { getWebAuthToken, notifyWebAuthRequired, sse } from "./api";
import type {
  AppErrorPushEventDto,
  AppErrorSnapshotEventDto,
  ConversationListInvalidateEventDto,
  McpHealthSnapshotDto,
  MemorySnapshot,
  Settings,
} from "~/types";

export interface AppEventMap {
  settings: Settings;
  memory: MemorySnapshot;
  app_errors_snapshot: AppErrorSnapshotEventDto;
  app_error: AppErrorPushEventDto;
  invalidate: ConversationListInvalidateEventDto;
  mcp_health: McpHealthSnapshotDto;
}

type AppEventName = keyof AppEventMap;

const REPLAY_EVENTS: ReadonlySet<AppEventName> = new Set([
  "settings",
  "memory",
  "app_errors_snapshot",
  "invalidate",
  "mcp_health",
]);

/** 与 worker 心跳判活(PORT_STALE_MS = 3 × 心跳间隔)保持一致,改动需两处同步。 */
const WORKER_PING_INTERVAL_MS = 15_000;

const listeners = new Map<AppEventName, Set<(data: never) => void>>();
const lastSnapshot = new Map<AppEventName, unknown>();
let started = false;

function dispatch(event: string, data: unknown): void {
  const name = event as AppEventName;
  if (REPLAY_EVENTS.has(name)) lastSnapshot.set(name, data);
  const set = listeners.get(name);
  if (!set) return;
  for (const listener of set) {
    // 故障隔离:单个订阅方抛错不得外溢——异常若传进通道读循环会被当作连接错误,
    // 触发整条共享通道重连,一个域的 bug 连累四个域抖动。
    try {
      (listener as (d: unknown) => void)(data);
    } catch (error) {
      console.error(`App event listener error (${name}):`, error);
    }
  }
}

interface WorkerToPageMessage {
  type: "event" | "auth_required";
  event?: string;
  data?: unknown;
  message?: string;
  code?: number;
}

/** SharedWorker 共享连接。返回 false 表示环境不支持/构造失败,调用方回退直连。 */
function startViaSharedWorker(): boolean {
  if (typeof SharedWorker === "undefined") return false;
  try {
    const worker = new SharedWorker(new URL("../workers/app-events-worker.ts", import.meta.url), {
      type: "module",
      name: "rikkahub-app-events",
    });
    const port = worker.port;
    // R6-2:try/catch 只兜得住 new SharedWorker() 的同步抛错;worker 脚本异步加载/求值
    // 失败(支持 SharedWorker 但不支持 module worker 的 WebView、脚本 404 等)只会触发
    // worker.onerror——此前未监听,返回 true 后通道永远无消息,事件面静默死亡。
    // 处理:未收到任何消息前出错 → 一次性切页内直连;已有消息后的运行期错误不回退
    // (通道已建立,再开直连会造成事件双份分发)。
    let receivedAnyMessage = false;
    let fellBackToDirect = false;
    worker.onerror = (errorEvent) => {
      if (receivedAnyMessage || fellBackToDirect) return;
      fellBackToDirect = true;
      console.error('SharedWorker failed before first message, falling back to direct SSE:', errorEvent);
      startDirect();
    };
    port.onmessage = (message: MessageEvent) => {
      receivedAnyMessage = true;
      if (fellBackToDirect) return; // 已回退直连,迟到的 worker 消息丢弃,防双份分发
      const payload = message.data as WorkerToPageMessage;
      if (payload.type === "event" && payload.event) {
        dispatch(payload.event, payload.data);
        return;
      }
      if (payload.type === "auth_required") {
        // 走既有密码闸门流程(解锁后整页 reload,重新 hello 自然携新 token)
        notifyWebAuthRequired({ message: payload.message ?? "Unauthorized", code: payload.code ?? 401 });
      }
    };
    port.postMessage({ type: "hello", token: getWebAuthToken() });
    // 心跳跑满页面生命周期,故不持句柄清理;若页面从 bfcache 复活,持续的 ping 会让
    // worker 重新接纳并补发快照(见 worker 侧"未注册 port 来信即重纳")。
    window.setInterval(() => port.postMessage({ type: "ping" }), WORKER_PING_INTERVAL_MS);
    // 显式注销让 worker 立即摘除本页,不等 45s 判死。
    window.addEventListener("pagehide", () => {
      try {
        port.postMessage({ type: "bye" });
      } catch {
        // 页面正在销毁,尽力而为
      }
    });
    return true;
  } catch (error) {
    console.error("SharedWorker unavailable, falling back to direct SSE:", error);
    return false;
  }
}

/** 页内直连回退:行为与 worker 路径等价(重连由 sse() 内建,连接即重推全部快照)。 */
function startDirect(): void {
  void sse<unknown>("events", {
    onMessage: ({ event, data }) => dispatch(event, data),
    onError: (error) => {
      console.error("App events SSE error:", error);
    },
  });
}

/** 建立通道(幂等)。 */
export function startAppEvents(): void {
  if (started) return;
  started = true;
  if (!startViaSharedWorker()) startDirect();
}

/** 注册事件监听并确保通道已建立。返回反注册函数(不断开共享通道)。 */
export function onAppEvent<K extends AppEventName>(
  event: K,
  listener: (data: AppEventMap[K]) => void,
): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(listener as (data: never) => void);
  if (REPLAY_EVENTS.has(event) && lastSnapshot.has(event)) {
    listener(lastSnapshot.get(event) as AppEventMap[K]);
  }
  startAppEvents();
  return () => {
    set.delete(listener as (data: never) => void);
  };
}
