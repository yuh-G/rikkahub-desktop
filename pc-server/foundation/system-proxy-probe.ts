// foundation/system-proxy-probe.ts — 读系统代理设置的那条线程(PF2.1,方案 §5.16.4)
//
// 系统代理设置要起子进程才读得到(Windows 的 reg query、GNOME 的 gsettings)。Bun.spawn 建进程这一步在调用线程上同步执行
// (实测中位 5.5 ms,堆大时更久),放在主线程上,缓存过期后的第一个出站请求正好被它挡住 20–50 ms。所以读设置放进一条
// Worker 线程:主线程只发「查一次」、收结果;一次只查一个由调用方(net.ts 的缓存)保证。
// Worker 的代码经 blob 地址起(同 subprocess-engine/parent-watch.ts:编译版里按文件路径起 Worker 要把文件列为额外入口):
// readSystemSetting 的源码原样拼进 Worker,所以它必须自成一体,不能引用外层的任何名字。
// Worker 建不起来或中途没了:报一次警,之后在调用线程上照旧读(请求前会被挡一下,但「跟随系统代理」不失效)。
// 只有主程序用它;引擎宿主进程的系统代理由主程序推过去(net.ts 的 useExternalSystemProxy)。

import { reportError } from "../observability/app-errors";
import { RUNNING_IN_CONTAINER, RUNTIME_PLATFORM } from "./platform";

/** proxy = 当前生效的系统代理(只认 http/https);pac = 自动配置脚本地址(只给「检测系统代理」按钮作提示,不进代理解析)。 */
export type SystemSetting = "proxy" | "pac";

/** 起子进程读一次;读不到、出错都返回 undefined。自成一体(源码会拼进 Worker)。 */
export async function readSystemSetting(
  kind: SystemSetting,
  platform: "win" | "mac" | "linux",
  inContainer: boolean,
): Promise<string | undefined> {
  const run = async (cmd: string[]) => {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const stdout = await new Response(proc.stdout).text();
    return { exitCode: await proc.exited, stdout };
  };
  // ProxyServer 可以是单个地址("127.0.0.1:7890"),也可以按协议分("http=127.0.0.1:7890;https=127.0.0.1:7891;ftp=...")。
  // 出站 API 请求优先用 https=,其次 http=。不退到 socks=:Bun fetch 只认 http/https 代理,把 SOCKS 端口当 HTTP 代理用
  // 会让 CONNECT 握手挂住;只有 socks= 时按没有系统代理处理。
  const parseProxyServer = (value: string): string | undefined => {
    if (!value) return undefined;
    if (value.includes("=")) {
      const map = new Map<string, string>();
      for (const piece of value.split(";")) {
        const [k, v] = piece.split("=");
        if (k && v) map.set(k.trim().toLowerCase(), v.trim());
      }
      const target = map.get("https") ?? map.get("http");
      if (!target) return undefined;
      return /^https?:\/\//i.test(target) ? target : `http://${target}`;
    }
    return /^https?:\/\//i.test(value) ? value : `http://${value}`;
  };
  const internetSettings = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  const gsettings = async (...args: string[]) => (await run(["gsettings", "get", ...args])).stdout.trim();
  try {
    if (platform === "win") {
      if (kind === "pac") {
        const res = await run(["reg", "query", internetSettings, "/v", "AutoConfigURL"]);
        if (res.exitCode !== 0) return undefined;
        return res.stdout.match(/AutoConfigURL\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim() || undefined;
      }
      const enable = await run(["reg", "query", internetSettings, "/v", "ProxyEnable"]);
      if (enable.exitCode !== 0 || !/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enable.stdout)) return undefined;
      const server = await run(["reg", "query", internetSettings, "/v", "ProxyServer"]);
      if (server.exitCode !== 0) return undefined;
      const value = server.stdout.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1];
      return value ? parseProxyServer(value.trim()) : undefined;
    }
    // GNOME 只认 mode='manual'(明确的主机端口);'auto' 是 PAC,不解析,只在 pac 查询里报告存在。KDE 不支持,用户可手动填。
    if (platform === "linux" && !inContainer) {
      const mode = await gsettings("org.gnome.system.proxy", "mode");
      if (kind === "pac") {
        if (mode !== "'auto'") return undefined;
        // url 为空是 WPAD 自动发现,仍算有 PAC
        return (await gsettings("org.gnome.system.proxy", "autoconfig-url")).replace(/^'|'$/g, "") || "wpad";
      }
      if (mode !== "'manual'") return undefined;
      const host = (await gsettings("org.gnome.system.proxy.http", "host")).replace(/^'|'$/g, "");
      const port = await gsettings("org.gnome.system.proxy.http", "port");
      if (!host || !port || host === "''" || port === "0") return undefined;
      return `http://${host}:${port}`;
    }
  } catch {
    // 读不到系统设置(命令不存在、被拦下)与没设代理同样处理:直连
  }
  return undefined;
}

type ProbeWorker = Worker & { ref(): void; unref(): void };

let worker: ProbeWorker | null = null;
let broken = false;
let nextId = 1;
const pending = new Map<number, { kind: SystemSetting; resolve: (value: string | undefined) => void }>();

const readHere = (kind: SystemSetting) => readSystemSetting(kind, RUNTIME_PLATFORM, RUNNING_IN_CONTAINER);
/** macOS 与容器里不读系统设置(readSystemSetting 直接返回 undefined、不起子进程),不必为它建线程。 */
export const READS_SYSTEM_SETTINGS = RUNTIME_PLATFORM === "win" || (RUNTIME_PLATFORM === "linux" && !RUNNING_IN_CONTAINER);

function fallBack(reason: string, cause?: unknown): void {
  const dead = worker;
  worker = null;
  broken = true;
  dead?.terminate();
  reportError("network", "warn", `系统代理检测线程${reason},改在主线程上检测`, cause, "system_proxy_probe_fallback");
  for (const [id, query] of pending) {
    pending.delete(id);
    void readHere(query.kind).then(query.resolve);
  }
}

function ensureWorker(): ProbeWorker | null {
  if (worker || broken) return worker;
  // 读的代码在线程里抛错(源码拼接出了问题,不是「没设代理」)要报回来:当成没有代理会让「跟随系统代理」悄悄失效
  const source = `const read = ${readSystemSetting.toString()};
self.onmessage = async (event) => {
  const { id, kind } = event.data;
  try { postMessage({ id, value: await read(kind, ${JSON.stringify(RUNTIME_PLATFORM)}, ${String(RUNNING_IN_CONTAINER)}) }); }
  catch (err) { postMessage({ id, failed: String(err && err.stack || err) }); }
};`;
  try {
    const created = new Worker(URL.createObjectURL(new Blob([source], { type: "application/javascript" })), { smol: true }) as ProbeWorker;
    created.addEventListener("message", (event) => {
      const { id, value, failed } = (event as MessageEvent<{ id: number; value?: string; failed?: string }>).data;
      if (failed !== undefined) {
        if (worker === created) fallBack("出错", failed);
        return;
      }
      const query = pending.get(id);
      if (!query) return;
      pending.delete(id);
      if (pending.size === 0) created.unref();
      query.resolve(value);
    });
    created.addEventListener("error", (event) => {
      if (worker === created) fallBack("出错", (event as ErrorEvent).message);
    });
    created.addEventListener("close", () => {
      if (worker === created) fallBack("意外退出");
    });
    // 空闲时不拖住进程退出;有查询在途时 ref 住,等它回来
    created.unref();
    worker = created;
  } catch (err) {
    fallBack("起不来", err);
  }
  return worker;
}

/** 查一次系统设置:经探测线程,线程不可用时在调用线程上读。 */
export function probeSystemSetting(kind: SystemSetting): Promise<string | undefined> {
  const target = READS_SYSTEM_SETTINGS ? ensureWorker() : null;
  if (!target) return readHere(kind);
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, { kind, resolve });
    target.ref();
    target.postMessage({ id, kind });
  });
}

/** 仅测试:结束探测线程(在途的查询按没有代理答),忘掉「线程不可用」,下一次查询重新建。 */
export function resetSystemProxyProbeForTests(): void {
  const dead = worker;
  worker = null;
  broken = false;
  dead?.terminate();
  for (const [id, query] of pending) {
    pending.delete(id);
    query.resolve(undefined);
  }
}
