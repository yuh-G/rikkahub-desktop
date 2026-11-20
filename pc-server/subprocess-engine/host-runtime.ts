// subprocess-engine/host-runtime.ts — 引擎宿主进程一侧的公共底座与连接(P7.2.2,方案 §5.14.5、§5.14.6)
//
// 宿主进程(进程角色 engine-host)起来后:
//   1. 开自己的启动黑匣子、装未捕获异常兜底;
//   2. 从 stdin 读第一行(主程序给的通道地址、令牌、单帧上限、网络配置);
//   3. 装网络壳——与主程序是同一个 installProxyFetchInterceptor,getter 读主程序推来的配置(握手带一份,
//      用户改代理时主程序推 runtime.proxyConfig,下一个请求即生效);
//   4. 把 reportError 的广播口接到通道上(runtime.appError),宿主进程里的错误回到主程序的错误中心;
//   5. 连通道、发问候,把契约的引擎侧(rpc-transport 的 serveDriverOverRpc)挂上去。
// 标准输出与标准错误不承载协议:插件往 stdout 写什么都不影响通道;console 输出改到 stderr,主程序摘录尾部归因。
// 主程序断开(通道关闭、stdin 关闭)即退出:主程序没了,宿主进程留着只会成孤儿。

import { installProxyFetchInterceptor, normalizeProxyConfig, primeSystemProxyCache } from "../foundation/net";
import type { ProxyConfig } from "../foundation/types";
import type { AppErrorDto } from "../foundation/types/dto";
import { initAppErrorBroadcast, installProcessSafetyNet, reportError } from "../observability/app-errors";
import { bootCleanExit, engineHostMilestone, engineHostTraceStartup } from "../observability/boot-trace";
import { APP_VERSION } from "../updates/index";
import type { EngineDriver, EngineHost } from "../engines/contract";
import { serveDriverOverRpc } from "../engines/rpc-transport";
import { connectEngineChannel, PEER_CLOSED } from "./channel";
import {
  ENGINE_HOST_MAX_FRAME_BYTES,
  ENGINE_HOST_PROTOCOL,
  RUNTIME_APP_ERROR,
  RUNTIME_PROXY_CONFIG,
  type EngineHostHello,
  type EngineHostLaunchLine,
} from "./host-protocol";

/** 读 stdin 的第一行;之后 stdin 不再读,关闭即视为主程序已退出。 */
function readLaunchLine(onStdinEnd: () => void): Promise<EngineHostLaunchLine> {
  return new Promise((resolve, reject) => {
    let text = "";
    let done = false;
    process.stdin.on("data", (chunk: Buffer) => {
      if (done) return;
      text += chunk.toString("utf8");
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      done = true;
      try {
        resolve(JSON.parse(text.slice(0, newline)) as EngineHostLaunchLine);
      } catch (err) {
        reject(new Error(`主程序交来的启动参数不是 JSON:${err instanceof Error ? err.message : String(err)}`));
      }
    });
    process.stdin.on("end", () => {
      if (done) onStdinEnd();
      else reject(new Error("主程序没有交来启动参数就关闭了 stdin"));
    });
  });
}

function exit(code: number, reason: string): never {
  engineHostMilestone(`退出(${code}):${reason}`);
  if (code === 0) bootCleanExit();
  process.exit(code);
}

/** 宿主进程的主体:装好底座、连上通道,把 createDriver 建的驱动挂到契约上。 */
export async function runEngineHost(createDriver: (host: EngineHost) => EngineDriver): Promise<void> {
  engineHostTraceStartup();
  engineHostMilestone("进程拉起");
  installProcessSafetyNet();
  // stdout 不承载任何东西;进程内的 console 输出改到 stderr(主程序摘录尾部用于归因)。
  console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);

  let stopping = false;
  const stop = (code: number, reason: string) => {
    if (stopping) return;
    stopping = true;
    exit(code, reason);
  };

  let launch: EngineHostLaunchLine;
  try {
    launch = await readLaunchLine(() => stop(0, "stdin 已关闭(主程序已退出)"));
  } catch (err) {
    console.error(`[engine-host] ${err instanceof Error ? err.message : String(err)}`);
    return stop(1, "没有拿到启动参数");
  }

  let proxyConfig: ProxyConfig = normalizeProxyConfig(launch.proxyConfig);
  installProxyFetchInterceptor(() => proxyConfig);

  const hello: EngineHostHello = {
    token: launch.token,
    role: "engine-host",
    protocol: ENGINE_HOST_PROTOCOL,
    appVersion: APP_VERSION,
    maxFrameBytes: ENGINE_HOST_MAX_FRAME_BYTES,
    pid: process.pid,
  };
  // 系统代理探测与连通道并行;驱动挂上之前探测必须完成,否则「跟随系统代理」时第一个请求会走直连。
  const [channel] = await Promise.all([
    connectEngineChannel(launch.address, hello).catch((err: unknown) => {
      console.error(`[engine-host] 连不上主程序的通道:${err instanceof Error ? err.message : String(err)}`);
      return null;
    }),
    primeSystemProxyCache(),
  ]);
  if (!channel) return stop(1, "连不上通道");
  channel.setMaxFrameBytes(ENGINE_HOST_MAX_FRAME_BYTES);
  channel.setPeerMaxFrameBytes(launch.maxFrameBytes);
  engineHostMilestone("已连上通道");

  // 驱动创建期间就可能 reportError:先攒着,通道上的服务建好后补发
  const early: AppErrorDto[] = [];
  let forward: ((entry: AppErrorDto) => void) | null = null;
  initAppErrorBroadcast((entry) => (forward ? forward(entry) : early.push(entry)));
  const server = serveDriverOverRpc(
    (text) => channel.send(text),
    createDriver,
    (reason) => console.error(`[engine-host] ${reason}`),
    {
      [RUNTIME_PROXY_CONFIG]: (next: ProxyConfig) => {
        proxyConfig = normalizeProxyConfig(next);
      },
    },
  );
  channel.onFrame((text) => server.receive(text));
  forward = (entry) => server.notify(RUNTIME_APP_ERROR, [entry]);
  for (const entry of early.splice(0)) forward(entry);
  engineHostMilestone("驱动就绪");
  channel.onClose((reason) => {
    server.close(reason);
    if (reason !== PEER_CLOSED) reportError("pi-engine", "warn", `引擎宿主进程的通道异常断开:${reason}`);
    stop(reason === PEER_CLOSED ? 0 : 1, `通道关闭:${reason}`);
  });
}
