// SharedWorker:跨标签页共享 /api/events 连接(连接预算纪律,对照 services/app-events.ts)。
//
// 每个页面(标签页/多窗口)连接本 worker 的 MessagePort;worker 持有全浏览器唯一的一条
// events SSE 连接,把事件帧分发给所有活着的页面。N 个页面 = 1 条连接(此前每页一条,
// 6 连接预算在两个标签页时就只剩 2 个活动名额)。最后一个页面断开后停止连接,
// worker 随后被浏览器回收。
//
// 【自包含纪律】本文件零 import:worker 里没有 window/localStorage,页内模块(ky 鉴权、
// 401 闸门)不可用也不需要——鉴权 token 由页面 hello 时传入,401 回报页面弹闸门。
//
// 协议:
//   页面→worker:{type:"hello", token}  连接即发(解锁后整页 reload 自然携新 token 重发)
//               {type:"ping"}          每 15s 心跳,worker 以此判活
//               {type:"bye"}           pagehide 时显式注销
//   worker→页面:{type:"event", event, data}          事件帧(含新页面接入时的快照重放)
//               {type:"auth_required", message, code}  401(页面按既有流程弹密码闸门)
//
// 快照重放:与页内 app-events 一致,快照类事件缓存最新一帧;新页面(或 bfcache 复活的
// 页面)接入时立即补发,消除"晚接入错过首帧"的时序耦合。
const REPLAY_EVENTS = new Set(["settings", "memory", "app_errors_snapshot", "invalidate", "mcp_health"]);
/** 页面判死阈值。真实死页(崩溃/被杀,pagehide 没来得及发 bye)靠它摘除;必须显著
 *  大于 Chromium 后台节流后的最坏心跳间隔:intensive throttling(页面隐藏且静默 ≥5min,
 *  恰是登录时用户切去浏览器授权的形态)把 15s 心跳压到 1/min——45s 阈值会把活着的
 *  页面误判死,端口摘空即停连,success/settings 帧发给已死的连接;用户回来后 ping 恢复
 *  只触发"重接纳+补旧快照",连接永不重启,面板永久卡在进行中(2026-09-26 实测)。
 *  120s = 两个节流心跳周期 + 裕量。 */
const PORT_STALE_MS = 120_000;
/** R6-1:SSE 连接活性看门狗。服务端每 15s 发 `: heartbeat` 注释帧;45s(3×心跳)无字节
 *  判连接已死(合盖睡眠/换网产生的半开 TCP 会让 reader.read() 永久挂起,不抛错不重连),
 *  abort 本次连接走既有退避重连。与页内 services/api.ts sse() 口径一致。 */
const SSE_IDLE_TIMEOUT_MS = 45_000;

const ports = new Map<MessagePort, { lastSeen: number }>();
const lastSnapshot = new Map<string, unknown>();

let token: string | null = null;
let abort: AbortController | null = null;
let running = false;

function post(port: MessagePort, message: unknown): void {
  try {
    port.postMessage(message);
  } catch {
    ports.delete(port);
  }
}

function broadcast(message: unknown): void {
  for (const port of ports.keys()) post(port, message);
}

function replaySnapshots(port: MessagePort): void {
  for (const [event, data] of lastSnapshot) post(port, { type: "event", event, data });
}

function stop(): void {
  running = false;
  abort?.abort();
  abort = null;
}

/** 401 停连窗口:服务端要密码但页面还没解锁(解锁后整页 reload 重新 hello)。窗口内
 *  ping/来信不得重启连接,否则密码闸门打开前就裸连 401 死循环。仅 hello(可能携新
 *  token)解除——stop() 不碰它,否则 401 分支"先标记后 stop"会被自己冲掉。 */
let authHalted = false;

function sweepPorts(): void {
  const now = Date.now();
  for (const [port, state] of ports) {
    if (now - state.lastSeen > PORT_STALE_MS) ports.delete(port);
  }
  if (ports.size === 0) stop();
}
setInterval(sweepPorts, PORT_STALE_MS);

/** 唯一的 SSE 连接循环。解析逻辑与页内 services/api.ts sse() 一致(行级解析,
 *  data: 后只剥一个前导空格);指数退避重连 1s→30s,收到完整帧即复位。 */
async function run(): Promise<void> {
  if (running) return;
  running = true;
  abort = new AbortController();
  const signal = abort.signal;
  let attempt = 0;

  while (running && !signal.aborted) {
    // R6-1:每次连接一个独立 controller:全局 stop 桥接进来(fatal),看门狗也从这里
    // abort(但全局 signal 未动,循环尾的检查放行 → 走既有退避重连)。
    const connAbort = new AbortController();
    const onStop = () => connAbort.abort();
    signal.addEventListener("abort", onStop, { once: true });
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdleWatchdog = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => connAbort.abort(), SSE_IDLE_TIMEOUT_MS);
    };
    try {
      const headers: Record<string, string> = { Accept: "text/event-stream" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch("/api/events", { headers, signal: connAbort.signal });
      if (response.status === 401) {
        // 停连等待:密码闸门解锁后页面整页 reload,重新 hello 携新 token 再启动
        broadcast({ type: "auth_required", message: "Unauthorized", code: 401 });
        authHalted = true;
        stop();
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Response body is not readable");

      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "message";
      let currentData = "";
      armIdleWatchdog(); // 连上即起看门狗
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdleWatchdog(); // 收到任何字节(含 `: heartbeat` 注释帧)即重置
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const rawLine of lines) {
          const line = rawLine.replace(/\r$/, "");
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            const dataValue = line.slice(5);
            currentData += (currentData ? "\n" : "") + (dataValue.startsWith(" ") ? dataValue.slice(1) : dataValue);
          } else if (line === "") {
            if (currentData) {
              try {
                const parsed = JSON.parse(currentData) as unknown;
                attempt = 0;
                if (REPLAY_EVENTS.has(currentEvent)) lastSnapshot.set(currentEvent, parsed);
                broadcast({ type: "event", event: currentEvent, data: parsed });
              } catch {
                // 坏帧忽略,与页内 sse() 一致
              }
            }
            currentEvent = "message";
            currentData = "";
          }
        }
      }
      // 服务端正常关流(如后端重启)→ 退避重连
    } catch {
      // 网络错/中断/看门狗 abort → 退避重连
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      signal.removeEventListener("abort", onStop);
    }
    if (!running || signal.aborted) return;
    const delay = Math.min(1000 * 2 ** attempt, 30_000);
    attempt += 1;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

(self as unknown as { onconnect: (event: MessageEvent) => void }).onconnect = (event) => {
  const port = (event as MessageEvent & { ports: readonly MessagePort[] }).ports[0];
  if (!port) return;
  ports.set(port, { lastSeen: Date.now() });

  port.onmessage = (message: MessageEvent) => {
    const data = message.data as { type?: string; token?: string | null } | null;
    // 未注册的 port(bfcache 复活、或曾被判死摘除)在任何来信时重新接纳并补快照。
    // 端口曾摘除 = 判死期间 sweepPorts 已因 ports 清空停掉 SSE 连接(stop),此刻必须
    // 重启连接——只补旧快照不重连,页面会永远错过摘除窗口内广播的增量帧(登录 success
    // 帧就是这么丢的);401 停连窗口除外(authHalted,见其声明)。run 幂等(running 守卫)。
    if (!ports.has(port)) {
      ports.set(port, { lastSeen: Date.now() });
      replaySnapshots(port);
      if (!authHalted) void run();
    } else {
      ports.get(port)!.lastSeen = Date.now();
    }

    if (data?.type === "hello") {
      token = data.token ?? null;
      authHalted = false;
      replaySnapshots(port);
      void run();
      return;
    }
    if (data?.type === "bye") {
      ports.delete(port);
      if (ports.size === 0) stop();
    }
    // ping:上面已刷新 lastSeen,无需其他处理
  };
};
