// foundation/port-binding.ts — 服务端口绑定:候选端口顺延 + 回环名字整体占有(issue #62)
//
// 界面拨的是名字 UI_HOST(localhost),Windows/Chromium 把它解析为 [::1, 127.0.0.1]、先连 ::1,
// 被拒才回落 IPv4。Windows 默认套接字语义下,不同具体地址、具体地址与通配地址可在同一端口共存,
// 连接按「最具体绑定优先」分派——只占 127.0.0.1:p 时,任何在 p 上默认监听的普通程序(Node
// listen(p) 绑 ::、Go ":p"、绑 ::1/localhost 的服务)不论先开后开都能与我们共存并接走界面的新连接,
// 而 EADDRINUSE 驱动的顺延根本收不到冲突信号(#62:存在的路由被回 404、界面卡死)。
//
// 不变量:客户端拨出的名字解析到的每个地址,都必须是我们自己的套接字。故回环意图下 127.0.0.1 与
// ::1 作为一组绑定——全有或全无,任一成员被占整组顺延。占满后第三方的具体地址绑定一律 EADDRINUSE;
// 通配地址即便共存,也因具体地址优先分不到流量(Windows 实测:通配先开、我们后绑,两扇门仍归我们)。
//
// Bun 把一切 listen 失败(端口被占、地址不存在、主机名非法)都报成 EADDRINUSE、errno 0,分不清
// 「::1 端口被占」与「本机根本没有 IPv6 回环」——所以先用 OS 分配端口单独探一次 ::1,探得通才把它
// 编入绑定组;否则禁用 IPv6 的机器会把每个端口都误判成被占、一路顺延到失败。
//
// 本模块只管「怎么绑」,提示文案与退出码留在 server.ts。

import { LOOPBACK_GROUP, isLoopbackHostname } from "./loopback";

// 回环主机名判定收在 loopback.ts(纯模块,web-ui 可经 @server 打包);此处 re-export
// 保持「绑定策略」的既有导入面,server.ts / api/auth.ts 不必改导入路径。
export { isLoopbackHostname };

/** 界面拨号主机:Tauri 壳导航(web-ui/src-tauri/src/lib.rs 同名常量,契约测试锁一致)、便携模式
 *  自动打开的浏览器、启动日志都拨它。拨名字安全的前提是上方不变量(同样有测试锁定)。
 *  改拨字面 IP(RFC 8252 §8.3 的推荐)只需改这里与 lib.rs 两处,但页面 origin 随之改变——按 origin
 *  隔离的 localStorage(标签与分栏布局等)会整体重置,须先把这类持久数据迁出 localStorage。 */
export const UI_HOST = "localhost";

export function uiOrigin(port: number): string {
  return `http://${UI_HOST}:${port}`;
}

/** 本机能否绑 IPv6 回环。Bun.listen 同步,零点几毫秒。 */
export function probeIpv6Loopback(): boolean {
  try {
    Bun.listen({ hostname: "::1", port: 0, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    // 探不通即视为本机无 IPv6 回环(Bun 不透传真实错误,见头注);退回仅 IPv4 就是旧行为,吞错安全。
    return false;
  }
}

/** 实际要绑的地址组。回环意图 → 127.0.0.1 + ::1(本机无 IPv6 回环则仅 127.0.0.1);其余(0.0.0.0 /
 *  :: / 局域网 IP)原样单地址——那是用户有意识的暴露选择,不做改写。
 *  顺带修正:Bun 的 hostname "localhost" 只绑 ::1,旧的 --host localhost 会让 127.0.0.1 不可达
 *  (壳的优雅停机请求正走 127.0.0.1)。 */
export function resolveListenHostnames(bindHostname: string, probeIpv6: () => boolean = probeIpv6Loopback): string[] {
  if (!isLoopbackHostname(bindHostname)) return [bindHostname];
  return probeIpv6() ? [...LOOPBACK_GROUP] : [LOOPBACK_GROUP[0]];
}

/** 「换个端口就好」类错误(专题10-①)。除 EADDRINUSE 外,EACCES/EPERM(Windows 的 Hyper-V/WSL
 *  保留端口段 netsh excludedportrange、Linux 特权端口)同样顺延,否则应用会锁死在「起不来→进不了
 *  设置→改不了端口」。code 与文案都查:Bun 的文案不保证含错误码字样(如「Is port X in use?」),
 *  code 字段才是稳定契约。 */
export function isPortUnusableError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code ?? "";
  const message = err instanceof Error ? err.message : String(err);
  return /EADDRINUSE|EACCES|EPERM|address already in use|in use|permission denied|access permissions|10013/i.test(`${code} ${message}`);
}

export interface BindAttempt {
  /** 0 = 交给操作系统分配 */
  port: number;
  hostnames: readonly string[];
}

/** OS 分配端口时组内其余地址复用主地址拿到的号,这个号恰好在 ::1 上被占的概率极低,重试即可。 */
const OS_ASSIGNED_PAIRING_RETRIES = 3;

/** 候选序列:preferredPort 起顺延 walk 个(钳 65535),每个都绑完整地址组。osAssignedFallback 时追加
 *  OS 分配端口兜底(专题10-①:端口是启动期配置,起不来就永远进不了设置页改端口,必须保证应用总能
 *  起来);地址组有多个成员时先整组重试,最后退到只绑主地址收尾——宁可退回旧的单栈行为也要起来。 */
export function planBindAttempts(opts: {
  preferredPort: number;
  walk: number;
  osAssignedFallback: boolean;
  hostnames: readonly string[];
}): BindAttempt[] {
  const { preferredPort, walk, osAssignedFallback, hostnames } = opts;
  const attempts: BindAttempt[] = [];
  for (let offset = 0; offset < walk && preferredPort + offset <= 65535; offset += 1) {
    attempts.push({ port: preferredPort + offset, hostnames });
  }
  if (osAssignedFallback) {
    if (hostnames.length > 1) {
      for (let retry = 0; retry < OS_ASSIGNED_PAIRING_RETRIES; retry += 1) attempts.push({ port: 0, hostnames });
      attempts.push({ port: 0, hostnames: hostnames.slice(0, 1) });
    } else {
      attempts.push({ port: 0, hostnames });
    }
  }
  return attempts;
}

export interface StoppableListener {
  readonly port: number | undefined;
  stop(closeActiveConnections?: boolean): unknown;
}

export interface BindFailure {
  attempt: BindAttempt;
  /** 失败的那个地址 */
  hostname: string;
  /** 失败时的具体端口:OS 分配端口且主地址已取到号时是那个号,主地址本身失败时为 0 */
  port: number;
  error: unknown;
}

export type BindResult<L> =
  | { ok: true; listeners: L[]; port: number; attempt: BindAttempt }
  | { ok: false; kind: "fatal" | "exhausted"; failure: BindFailure };

/** 停掉一组监听器(回滚半截绑定、进程停服共用)。监听套接字在 stop 调用时同步释放,不必等待
 *  返回的 Promise(那是在途连接的收尾)。 */
export function stopListeners(listeners: readonly StoppableListener[]): void {
  for (const listener of listeners) {
    try {
      void Promise.resolve(listener.stop(true)).catch(() => {
        // 在途连接收尾失败:套接字已释放、进程要么继续试下一个端口要么即将退出,无可补救。
      });
    } catch {
      // 重复 stop(已在停止中),尽力而为的收尾。
    }
  }
}

/** 按序尝试,返回第一组完整绑上的监听器(顺序同 hostnames)。组内全有或全无:任一地址失败即回滚
 *  已绑成员,端口留给后续尝试;OS 分配端口时其余地址复用主地址拿到的号。端口不可用类错误顺延到
 *  下一次尝试(onUnusable 带出 next 供调用方打日志,next 为空即已耗尽);其余错误属配置问题,
 *  立即 fatal 不再顺延。 */
export function bindFirstUsable<L extends StoppableListener>(
  attempts: readonly BindAttempt[],
  listen: (hostname: string, port: number) => L,
  onUnusable?: (failure: BindFailure, next: BindAttempt | undefined) => void,
): BindResult<L> {
  if (attempts.length === 0) throw new Error("bindFirstUsable: 候选序列为空");
  for (let index = 0; ; index += 1) {
    const attempt = attempts[index]!;
    const listeners: L[] = [];
    let port = attempt.port;
    let failure: BindFailure | null = null;
    for (const hostname of attempt.hostnames) {
      try {
        const listener = listen(hostname, port);
        listeners.push(listener);
        if (port === 0) {
          if (!listener.port) throw new Error(`监听 ${hostname} 成功但未返回系统分配的端口号`);
          port = listener.port;
        }
      } catch (error) {
        failure = { attempt, hostname, port, error };
        break;
      }
    }
    if (!failure) return { ok: true, listeners, port, attempt };
    stopListeners(listeners);
    if (!isPortUnusableError(failure.error)) return { ok: false, kind: "fatal", failure };
    const next = attempts[index + 1];
    onUnusable?.(failure, next);
    if (!next) return { ok: false, kind: "exhausted", failure };
  }
}
