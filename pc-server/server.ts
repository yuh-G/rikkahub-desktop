import { dataDir } from "./foundation/paths";
import { RUNNING_IN_CONTAINER } from "./foundation/platform";
import { setActualServingPort } from "./foundation/net";
import { flushSaveState, peekPreferredPort, saveState } from "./persistence/json-store";
import { asrRealtimeSessions, sendAsrAudio, startAsrRealtimeSession, stopAsrRealtimeSession } from "./media/asr";
import { error, json } from "./api/request";
import { startAnalytics } from "./app-config/analytics";
import { bootstrap } from "./bootstrap";
import { getStartupStatus, isStartupReady, markStartupFailed, markStartupReady } from "./foundation/startup-gate";
import { DataDirLockedError, acquireDataDirLock, releaseDataDirLock } from "./persistence/instance-lock";
import { runDataDirHygiene } from "./persistence/data-dir-hygiene";
import { generating } from "./conversations/generation-state";
import { handleAuthTokenRequest, handleWebAuthStatus, isWebAuthAuthorized, warnIfExposedWithoutAuth } from "./api/auth";
import { routeStatic } from "./api/static";
import { routeApi } from "./api/router";
import { hasProxyForwardHeaders, isLoopbackAddress, markRequestNetworkContext } from "./api/net-context";
import { loadModelsDev } from "./inference-engine/providers";
import { checkpointConversationsDb, flushConvDirtyNow, getConversation, persistConversation } from "./conversations";

import process from "node:process";
import { installProcessSafetyNet, reportError } from "./observability/app-errors";
import { bootCleanExit, bootMilestone, bootNote, bootTraceStartup, readPreviousCrashLog } from "./observability/boot-trace";
import { killTrackedDetachedChildren } from "./workspace/tools/shell";
import { maybeRunExtractionWorker } from "./files/extraction";

// 全面审查 4-2:进程级异常兜底必须最早安装,罩住后续启动期与运行期的一切
// 定时器/游离 Promise 顶层抛错(SIGINT/SIGTERM 的优雅停机在文件尾另行注册)。
installProcessSafetyNet();

// 专题4:文档提取 worker 分支——本进程被父进程以 RIKKAHUB_EXTRACT_WORKER=1 自孵化
// 时只做单次提取即退出,必须在数据目录锁与端口绑定之前拐走,否则会跟正主抢锁。
if (await maybeRunExtractionWorker()) {
  process.exit(process.exitCode ?? 0);
}

// R1 取证:启动/崩溃黑匣子。尽早开——worker 分支已拐走,此处是正常实例的真正起点。
// 内部先把上次可能残留的崩溃 pending 转存成 server.log,再为本次会话开 pending 标记;
// 任何 IO 失败都静默降级(取证绝不阻塞启动)。干净退出时由 bootCleanExit 删净,正常用下来
// logs/ 里什么都不留。
bootTraceStartup();
bootMilestone("进程拉起");

// R1-4:壳(lib.rs)在 stdout 解析的单行诊断标记。release 壳下 stderr 不可见,启动失败
// 的真实原因全靠它带出去;消息压成单行,壳原样弹窗展示。code 对齐 process.exit 码,
// 当前仅供壳侧日志/未来分诊。
function emitStartupFatal(code: number, message: string): void {
  console.log(`RIKKAHUB_FATAL:${code}:${message.replace(/\s*\r?\n\s*/g, " ")}`);
  // R1 取证:JS 启动失败点也往 pending 落一行——进程即便在退出前来不及走干净路径,
  // 这句也已留在 pending 里,下次启动 capture 转存后能看到真实原因。
  bootNote("startupFatal", `[code ${code}] ${message}`);
}

// 1-5/R1-1:dataDir 单实例互斥必须先于绑端口——若后到实例先绑了端口再发现锁被占,
// 壳已拿到端口标记并导航,只会看到一扇死窗口。锁是纯文件操作,不拖慢端口标记。
// bootstrap(状态装载+迁移链)则移到 Bun.serve 之后异步执行,见文件尾。
try {
  acquireDataDirLock();
  bootMilestone("已拿数据目录锁");
} catch (err) {
  if (err instanceof DataDirLockedError) {
    emitStartupFatal(3, err.message);
    console.error(`[rikkahub-server] ${err.message}`);
    process.exit(3);
  }
  throw err;
}

const args = new Set(Bun.argv.slice(1));
const portIndex = Bun.argv.findIndex((arg) => arg === "--port");
const portEqualsArg = Bun.argv.find((arg) => arg.startsWith("--port="));
const portValue = portEqualsArg?.split("=")[1] ?? (portIndex >= 0 ? Bun.argv[portIndex + 1] : undefined);

if (process.platform === "linux") {
  const missing: string[] = [];
  const has = (cmd: string) => Bun.which(cmd) !== null;
  if (!has("unzip")) missing.push("unzip  (backup restore from ZIP)");
  if (!has("zip")) missing.push("zip  (backup export)");
  if (!has("wl-copy") && !has("xclip")) missing.push("wl-clipboard or xclip  (clipboard tool)");
  if (!has("espeak-ng")) missing.push("espeak-ng  (system TTS)");
  if (missing.length > 0) {
    console.warn("[startup] Missing optional Linux tools — some features will not work:");
    for (const dep of missing) console.warn(`  - ${dep}`);
  }
}

// Resolve the preferred port by priority: explicit `--port` flag > `PORT` env > user setting
// > 8080. Containerized deploys skip the user setting — inside a container the port is fixed
// by the image / `docker -p` mapping, so honoring a UI change there would be misleading.
function resolvePreferredPort(): number {
  if (portValue) {
    const cli = Number(portValue);
    if (cli > 0 && cli <= 65535) return cli;
  }
  if (process.env.PORT) {
    const envPort = Number(process.env.PORT);
    if (envPort > 0 && envPort <= 65535) return envPort;
  }
  if (!RUNNING_IN_CONTAINER) {
    // R1-1:state 此刻尚未装载(迁移后置到绑端口之后),对 state.json 做轻量端口窥探。
    const peeked = peekPreferredPort();
    if (peeked) return peeked;
  }
  return 8080;
}

// 绑定地址：默认只监听 127.0.0.1，局域网内其他设备无法直接访问（服务器目前没有鉴权，
// 全网卡监听等于把全部会话与 API Key 暴露给同一网络的任何人）。容器场景必须 0.0.0.0
// 否则宿主机端口映射不通。确有局域网访问需求的用户可用 --host 0.0.0.0 或 RIKKAHUB_HOST
// 环境变量显式放开——这是有意识的选择，而不是默认暴露。
function resolveBindHostname(): string {
  const hostIndex = Bun.argv.findIndex((arg) => arg === "--host");
  const hostEqualsArg = Bun.argv.find((arg) => arg.startsWith("--host="));
  const cli = hostEqualsArg?.split("=")[1] ?? (hostIndex >= 0 ? Bun.argv[hostIndex + 1] : undefined);
  if (cli) return cli;
  if (process.env.RIKKAHUB_HOST) return process.env.RIKKAHUB_HOST;
  if (RUNNING_IN_CONTAINER) return "0.0.0.0";
  return "127.0.0.1";
}

const bindHostname = resolveBindHostname();
// warnIfExposedWithoutAuth 读 state.settings(是否已设访问密码),在 bootstrap 就绪后执行。

// Origin 白名单：拦截恶意网页对本机服务的跨站请求（浏览器会自动带上 Origin，
// 而 localhost 服务默认不受同源策略保护——任意网页都能 fetch http://127.0.0.1:8080）。
// 规则：
// - 无 Origin 头 → 放行（同源导航/EventSource、curl、Tauri 原生请求都不带 Origin）
// - localhost / 127.0.0.1 / ::1 / tauri.localhost / tauri: 协议 → 放行（本机 UI、Vite dev、Tauri WebView）
// - Origin 与请求 Host 完全一致 → 放行（--host 放开局域网后用 IP 访问的同源请求）
// - 其余 → 403。只保护 /api（含 WebSocket 升级），静态资源无状态不拦。
function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  // 沙箱 iframe / file:// 页面发 "null"，一律拒绝
  if (origin === "null") return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol === "tauri:") return true;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "tauri.localhost") return true;
  const requestHost = request.headers.get("host");
  if (requestHost && parsed.host.toLowerCase() === requestHost.trim().toLowerCase()) return true;
  return false;
}
const preferredPort = resolvePreferredPort();
// Try the preferred port first; on a port-unusable error walk upward. Containers don't walk — a
// port collision inside a container is unexpected, and silently hopping would hide a real problem.
const MAX_PORT_ATTEMPTS = RUNNING_IN_CONTAINER ? 1 : 20;

// 专题10-①:候选端口序列。非容器部署在顺延耗尽后追加 0(交给操作系统分配随机空闲端口)
// 兜底——端口是启动期配置,启动失败意味着用户永远进不了设置页改端口(死锁),必须保证应用
// 总能起来;实际端口经 RIKKAHUB_PORT 标记交给壳导航,UI 的"当前运行端口"照常显示。
// 容器不顺延不兜底:端口由镜像/-p 映射约定,漂移只会掩盖真问题。
const candidatePorts: number[] = [];
for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
  const p = preferredPort + attempt;
  if (p <= 65535) candidatePorts.push(p);
}
if (!RUNNING_IN_CONTAINER) candidatePorts.push(0);

const { server, port } = (() => {
  for (const tryPort of candidatePorts) {
    if (tryPort === 0) {
      console.warn(
        `[startup] Ports ${preferredPort}-${candidatePorts[candidatePorts.length - 2]} all unusable; falling back to an OS-assigned random port.`,
      );
    }
    try {
      const bound = Bun.serve({
          hostname: bindHostname,
          port: tryPort,
          idleTimeout: 0,
          // Default is 128 MB — way too small. Users have reported backup zips of 10+ GB
          // (months of conversations + image attachments). The streaming `data/import` path
          // never holds the full body in memory anyway (pipes request.body directly to disk),
          // so this just acts as a sanity-check ceiling against truly absurd uploads.
          maxRequestBodySize: 64 * 1024 * 1024 * 1024,
          async fetch(request, server) {
            server.timeout(request, 0);
            const url = new URL(request.url);
            try {
              if (url.pathname.startsWith("/api/") && !isAllowedOrigin(request)) {
                return error("Forbidden: cross-origin request blocked", 403);
              }
              // R1-1 启动闸门:端口已绑定但 bootstrap(装载+迁移)还在后台跑。状态端点
              // 始终可达且免鉴权(不含机密;state 未装载时也评估不了鉴权),供前端迁移
              // 进度页轮询。未就绪时其余 /api 一律 503(shutdown 除外——壳可能在迁移中
              // 退出,flushAllStateBeforeExit 内部有未就绪守卫);静态资源照常放行,
              // 前端才有页面可渲染进度。
              if (url.pathname === "/api/startup/status") {
                return json(getStartupStatus());
              }
              if (!isStartupReady() && url.pathname.startsWith("/api/") && url.pathname !== "/api/app/shutdown") {
                return error("服务端正在启动(数据装载/迁移进行中),请稍候重试", 503);
              }
              // 全面审查 8-2/1-1:优雅停机端点。Windows 上 Tauri 壳 kill=TerminateProcess,
              // SIGTERM 钩子不运行——壳退出前先 POST 本端点,服务端把全部状态刷盘后才返回
              // 200,壳收到即可放心硬杀,数据零丢失。仅接受本机回环调用(先于 Web 鉴权:
              // 壳不持有 token;局域网/远程客户端被 IP 拦住,不能停别人的服务)。
              if (url.pathname === "/api/app/shutdown" && request.method === "POST") {
                // 批次二 R5-1:本机架 nginx/caddy 反代时,远程请求到达 Bun 的 remote address
                // 也是 127.0.0.1,裸回环判定会被穿透——任何互联网客户端 POST 本端点即可无鉴权
                // 停服。Tauri 壳直连本端口、绝不经代理,故带任一代理转发头的请求一定不是壳
                // 发的,直接拒绝;回环判定继续拦真正的远程直连。
                const ip = server.requestIP(request)?.address ?? "";
                if (hasProxyForwardHeaders(request) || !isLoopbackAddress(ip)) {
                  return error("Forbidden: shutdown is loopback-only", 403);
                }
                await flushAllStateBeforeExit();
                // 响应发出后再停服自退;100ms 让 200 先落到壳侧。
                setTimeout(() => {
                  try { server.stop(true); } catch { /* already stopping */ }
                  process.exit(0);
                }, 100);
                return json({ ok: true });
              }
              // Web 鉴权（阶段 5.2）：仅在配置了访问密码时生效。auth/token 端点先于
              // 鉴权检查处理（它就是换 token 的入口）；其余 /api/* 一律要求有效 token。
              if (url.pathname === "/api/auth/token" && request.method === "POST") {
                return await handleAuthTokenRequest(request);
              }
              // web-auth/status 只回布尔(enabled/configured/lockedByDeployment),不含机密;
              // 暴露横幅在"无密码(无 token)"时必须能拿到它——放进鉴权闸内会永远 401,横幅失效。
              if (url.pathname === "/api/web-auth/status" && request.method === "GET") {
                return handleWebAuthStatus();
              }
              if (url.pathname.startsWith("/api/") && !isWebAuthAuthorized(request, url)) {
                return error("Unauthorized", 401);
              }
              if (url.pathname === "/api/asr/realtime" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
                const upgraded = server.upgrade(request, { data: { kind: "asr" } as any });
                return upgraded ? undefined : error("WebSocket upgrade failed", 400);
              }
              if (url.pathname.startsWith("/api/")) {
                // 回环上下文标记:"仅限本机"端点(如 data/export/to-path 向宿主路径写文件)
                // 在 handler 层经 net-context 查询;判定语义与上方 shutdown 闸同源。
                markRequestNetworkContext(request, server.requestIP(request)?.address ?? "");
                return await routeApi(request, url);
              }
              return await routeStatic(url);
            } catch (err) {
              console.error(err);
              // 9-1:此前只进 stdout(Tauri release 下无处可看)。请求方拿到 500,
              // 错误中心同步留痕,支持自查。
              reportError("internal", "error", `接口处理异常：${url.pathname}`, err, "api_exception", { path: url.pathname });
              return error(err instanceof Error ? err.message : String(err), 500);
            }
          },
          websocket: {
            message(ws, data) {
              if ((ws.data as { kind?: string } | undefined)?.kind !== "asr") return;
              if (typeof data === "string") {
                // 批次二 R5-6:裸 JSON.parse 会让恶意/损坏的文本帧抛进 uncaughtException
                // 安全网(进程不死但每帧一条错误中心记录)。解析失败静默丢帧即可——
                // 合法客户端只发 start/stop 两种 JSON。
                let payload: { type?: string; providerId?: string };
                try {
                  payload = JSON.parse(data || "{}") as { type?: string; providerId?: string };
                } catch {
                  return;
                }
                if (payload.type === "start") startAsrRealtimeSession(ws, payload.providerId);
                if (payload.type === "stop") stopAsrRealtimeSession(ws);
                return;
              }
              const session = asrRealtimeSessions.get(ws);
              if (!session) return;
              const buffer = data instanceof ArrayBuffer
                ? data
                : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
              sendAsrAudio(session, buffer);
            },
            close(ws) {
              if ((ws.data as { kind?: string } | undefined)?.kind === "asr") stopAsrRealtimeSession(ws);
            },
          },
      });
      return { server: bound, port: bound.port ?? tryPort };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 专题10-①:"端口不可用"类错误一律顺延。除 EADDRINUSE 外,EACCES/EPERM(Windows 的
      // Hyper-V/WSL 保留端口段 netsh excludedportrange、Linux 特权端口)对用户同样是
      // "换个端口就好",旧逻辑直接 fatal 会把应用锁死在"起不来→进不了设置→改不了端口"。
      // 其余错误(非法 hostname 等配置问题)与 port 0 兜底也失败的情况仍立即暴露。
      // 同时检查 err.code 与 message:Bun 的报错文案不保证含错误码字样(如 EADDRINUSE 的文案是
      // "Is port X in use?"),而 code 字段才是稳定契约。
      const errCode = (err as NodeJS.ErrnoException | null)?.code ?? "";
      const portUnusable = /EADDRINUSE|EACCES|EPERM|address already in use|in use|permission denied|access permissions|10013/i.test(`${errCode} ${message}`);
      if (!portUnusable || tryPort === 0) {
        emitStartupFatal(1, `本地服务无法在端口 ${tryPort === 0 ? "(系统分配)" : tryPort} 启动:${message}`);
        console.error(`[rikkahub-server] Failed to start on port ${tryPort}: ${message}`);
        process.exit(1);
      }
      if (tryPort === preferredPort && candidatePorts.length > 1) {
        console.warn(
          `[startup] Port ${tryPort} unusable (${message}), trying alternatives up to ${Math.min(preferredPort + MAX_PORT_ATTEMPTS - 1, 65535)}...`,
        );
      }
    }
  }
  // 候选端口全部耗尽。R1-4:打出壳解析的 RIKKAHUB_FATAL 标记弹出真实原因
  // (旧 port_in_use: 标记是从未被壳解析过的死契约,已废除)。
  const top = Math.min(preferredPort + MAX_PORT_ATTEMPTS - 1, 65535);
  // D6(复查):容器分支单端口不重试,且"到设置里换端口"在容器内是死路(端口固定、启动时
  // 跳过该设置)——正确出路是排查镜像内进程或调整宿主机 docker -p 映射,文案必须指对方向。
  const exhaustedMessage = RUNNING_IN_CONTAINER
    ? `容器内端口 ${preferredPort} 被占用(容器端口固定,不做重试)。请检查镜像内是否有其他进程占用;如需换宿主机端口,用 docker run -p <宿主机端口>:${preferredPort} 调整映射即可,无需改容器内端口。`
    : `端口 ${preferredPort}-${top} 全部被其他程序占用。请关闭占用这些端口的程序,或在 设置 → 网络 中更换端口后重新启动。`;
  emitStartupFatal(2, exhaustedMessage);
  console.error(`[rikkahub-server] ${exhaustedMessage}`);
  process.exit(2);
})();

// Machine-readable marker parsed by the Tauri shell (src-tauri/src/lib.rs) to learn which port
// the sidecar actually bound to — the shell navigates the webview here when 8080 was taken.
// Keep it a single line with the exact `RIKKAHUB_PORT:<port>` prefix.
setActualServingPort(port);
bootMilestone("端口已绑定", `port=${port}`);
console.log(`RIKKAHUB_PORT:${port}`);

console.log(`RikkaHub PC server running at http://localhost:${port}`);
console.log(`Data directory: ${dataDir}`);

// R1-1:bootstrap(状态装载+全部一次性迁移)在端口标记打出之后异步执行。此前它在
// Bun.serve 之前同步跑,重数据老用户的首启迁移超过壳的 20s 就绪超时即被连坐击杀,
// 形成"每次启动都超时被杀重来"的死循环。现在壳立刻拿到端口,迁移期启动闸门把
// /api 挡成 503,前端渲染进度页。
// 引导失败不退进程:保持 failed 状态由前端呈现原因(release 壳下 stderr 不可见,
// exit 只会留下一扇死窗口);错误中心与 stdout 各留痕,FATAL 标记供壳侧日志。
void (async () => {
  try {
    await bootstrap();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitStartupFatal(1, `状态装载/迁移失败:${message}`);
    console.error("[startup] bootstrap 失败,/api 保持 503:", err);
    reportError("internal", "error", "启动引导失败，应用不可用，重启会自动重试", err, "startup_failed");
    markStartupFailed(message);
    return;
  }
  markStartupReady();
  bootMilestone("bootstrap 完成");
  // R1 取证:上次未干净退出会留下 server.log。启动成功后按判读等级分流(日志问题 2):
  //   abnormal(启动期夭折/运行期记录到异常)→ 错误中心浮 warn,用户应该知道;
  //   external(里程碑全完成、无异常记录 → 外力终止:直接关机/强退/任务管理器)→ 静默留档,
  //   这是托盘常驻用户的日常("点 X→托盘→关机"),报警只会制造"我明明正常关的"困惑。
  // 两种等级的 server.log 都随"下次正常退出"被清,与"重启清零"天然一致,绝不弹窗打扰。
  const previousCrash = readPreviousCrashLog();
  if (previousCrash?.level === "abnormal") {
    reportError(
      "internal",
      "warn",
      "上次应用未正常退出(可能是异常崩溃或强制终止)。诊断信息见 数据目录/logs/server.log。",
      undefined,
      "previous_unclean_exit",
    );
  }
  warnIfExposedWithoutAuth(bindHostname);
  // R1-13:数据目录卫生(超龄 corrupt 隔离、过时安装包、化石快照、孤儿附件统计)。
  // 就绪后台执行,内部自捕获,绝不影响运行。
  void runDataDirHygiene();
  // 懒加载 models.dev 模型目录(用于 context window 显示)。fire-and-forget,失败不影响启动。
  void loadModelsDev();
  console.log("Press Ctrl+C to stop RikkaHub PC.");

  // Start anonymous analytics (DAU tracking).  Fire-and-forget — a failed ping
  // must never block or crash the server.  The endpoint resolves to a Cloudflare
  // Worker that stores only an anonymous device UUID + date + version.
  startAnalytics();
})();

let shutdownStarted = false;

/** 全面审查 1-1/8-11/2-0b:关停前的完整刷盘链。信号路径与 /api/app/shutdown 端点共用,
 *  幂等(双触发只跑一次)。顺序:state.json(saveState 清节流定时器并立即起写 +
 *  flushSaveState 循环追到最后一笔尾随写)→ 活库脏行 → 生成中会话全量 reconcile(2-0b)
 *  → WAL checkpoint(TRUNCATE 把 -wal 并入主库并截断)。 */
async function flushAllStateBeforeExit(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  // R1-1:未就绪 = state 从未装载、/api 一直 503,没有任何用户变更可刷;此时 saveState
  // 会对未初始化的 state 抛错。迁移链本身崩溃安全(完成标记后置+逐会话幂等),直接
  // 放行退出,只释放实例锁。
  if (!isStartupReady()) {
    releaseDataDirLock();
    bootCleanExit(); // R1 取证:未就绪干净退出(启动即被关)也算正常,删 pending 不留假报警。
    return;
  }
  try {
    saveState();
    await flushSaveState();
  } catch (err) {
    console.warn("[shutdown] state.json 刷盘失败", err);
  }
  try {
    flushConvDirtyNow();
    // 全面审查 2-0b:生成中的会话再做一次全量 reconcile——流式增量 flush 只补写脏节点,
    // 结构性变更(新增节点/截断/重排)要靠 persistConversation 的"删旧节点+按序重插"
    // 才完整落盘。生成中会话通常 0~2 个,同步全量写可承受。
    for (const convId of generating.keys()) {
      const conv = getConversation(convId);
      if (conv) persistConversation(conv);
    }
    checkpointConversationsDb();
  } catch (err) {
    console.warn("[conv-db] 关停刷库失败", err);
  }
  // 1-5:全部刷盘完成后释放 dataDir 锁(只删自己的;崩溃残留的陈旧锁由下次启动接管)。
  releaseDataDirLock();
  // R1 取证:干净退出收尾——删本次 pending + 上次可能残留的 server.log("下次正常退出则
  // 日志清除",关机/强退的假报警就此归零)。此后进程才 exit,文件生灭即"是否干净退出"的判据。
  bootCleanExit();
}

async function shutdown() {
  server.stop(true);
  // 工作区 bash 残留子进程清扫(M1-5)：detached 进程组不随宿主退出，不杀会变孤儿。
  killTrackedDetachedChildren();
  await flushAllStateBeforeExit();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// SIGHUP:Windows 关闭终端窗口(libuv 把 CTRL_CLOSE_EVENT 映射为 SIGHUP,~5s 宽限)、
// Unix 终端断开。dev 形态下"直接关终端"是高频操作,不挂就走硬杀留假崩溃档(日志问题 2)。
process.on("SIGHUP", shutdown);

if (!args.has("--dev") && !args.has("--no-open")) {
  const opener = process.platform === "win32" ? "cmd" : "sh";
  const command = process.platform === "win32"
    ? ["/c", "start", `http://localhost:${port}`]
    : ["-c", `open http://localhost:${port} || xdg-open http://localhost:${port}`];
  Bun.spawn([opener, ...command], { stdout: "ignore", stderr: "ignore" });
}

