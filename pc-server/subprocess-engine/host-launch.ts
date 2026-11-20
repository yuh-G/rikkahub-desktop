// subprocess-engine/host-launch.ts — 主程序一侧:启动引擎宿主进程、连上专用通道、核对问候(P7.2.2,方案 §5.14.6)
//
// 顺序:先以随机名监听 → spawnSelf("engine-host") → 经 stdin 第一行交过去地址、令牌、单帧上限、网络配置 → 等第一个令牌对的
// 连接 → 核对问候(身份、协议版本、应用版本;不一致即拒绝并提示重启应用)→ 把契约的应用侧(connectDriverOverRpc)挂上去,
// 等 engine.ready。之后用户改代理,调用方经 pushProxyConfig 推给宿主进程;宿主进程转来的错误中心条目交给 onAppError。
// 子进程的 stdout 不读(插件随便写),stderr 只留尾部用于归因。启停、判活、重启归监管器(supervisor.ts),这里只管一次启动。

import type { Subprocess } from "bun";

import type { EngineDriver, EngineHost } from "../engines/contract";
import { connectDriverOverRpc } from "../engines/rpc-transport";
import { spawnSelf } from "../foundation/process-roles";
import type { ProxyConfig } from "../foundation/types";
import type { AppErrorDto } from "../foundation/types/dto";
import { APP_VERSION } from "../updates/index";
import { listenEngineChannel, type FrameChannel } from "./channel";
import {
  ENGINE_HOST_MAX_FRAME_BYTES,
  ENGINE_HOST_PROTOCOL,
  engineHostHelloMismatch,
  RUNTIME_APP_ERROR,
  RUNTIME_PING,
  RUNTIME_PROXY_CONFIG,
  type EngineHostLaunchLine,
} from "./host-protocol";
import { createTailBuffer } from "./process";
import { killProcessAndDescendants } from "./process-info";

export interface LaunchEngineHostOptions {
  host: EngineHost;
  proxyConfig: ProxyConfig;
  /** 宿主进程里 reportError 的条目(由调用方并入主程序的错误中心)。 */
  onAppError(entry: AppErrorDto): void;
  /** 通道上的协议问题(非 JSON、无主响应等)。 */
  onProtocolError(reason: string): void;
  /** 宿主进程的环境变量;不给就继承主程序的。 */
  env?: Record<string, string | undefined>;
  /** 从启动到 engine.ready 的限时。 */
  timeoutMs?: number;
  /** 子进程一起来就告诉调用方 pid(监管器据此记下,主程序下次启动清扫用),早于握手。 */
  onSpawn?(pid: number): void;
  /** 测试用:换成起测试替身的入口。生产只用 spawnSelf("engine-host")。 */
  spawnHost?: (options: HostSpawnOptions) => Subprocess<"pipe", "ignore", "pipe">;
}

type HostSpawnOptions = { env?: Record<string, string | undefined>; stdin: "pipe"; stdout: "ignore"; stderr: "pipe"; windowsHide: true };

export interface EngineHostProcess {
  driver: EngineDriver;
  pid: number;
  pushProxyConfig(config: ProxyConfig): void;
  /** 问一句 runtime.ping;宿主进程主线程被占住时一直不回(期限由监管器把握)。 */
  ping(): Promise<unknown>;
  /** 立即强杀宿主进程连同它起的命令行。 */
  kill(): void;
  /** 宿主进程退出:退出码、信号、标准错误尾部。 */
  exited: Promise<{ exitCode: number | null; signal: string | null; stderrTail: string }>;
  /** 关掉通道与 stdin,宿主进程自己退出;timeoutMs 内没退就强杀。 */
  stop(timeoutMs?: number): Promise<void>;
}

/** 启动一个引擎宿主进程并完成握手;任何一步失败都会杀掉子进程再抛错(错误带标准错误尾部)。 */
export async function launchEngineHost(options: LaunchEngineHostOptions): Promise<EngineHostProcess> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const listener = await listenEngineChannel({ timeoutMs });
  const stderrTail = createTailBuffer();
  let child: Subprocess<"pipe", "ignore", "pipe">;
  try {
    const spawnOptions: HostSpawnOptions = { env: options.env, stdin: "pipe", stdout: "ignore", stderr: "pipe", windowsHide: true };
    child = options.spawnHost ? options.spawnHost(spawnOptions) : spawnSelf("engine-host", spawnOptions);
  } catch (err) {
    listener.close();
    throw err;
  }
  options.onSpawn?.(child.pid);
  // Windows 上它起的命令行在作业对象里随它结束;其余平台命令行自成进程组,要连后代一起杀
  const kill = () => (process.platform === "win32" ? child.kill("SIGKILL") : killProcessAndDescendants(child.pid));
  const stderrDrained = (async () => {
    const reader = child.stderr.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      stderrTail.push(value);
    }
  })().catch(() => {
    // 子进程退出时 stderr 可能以错误结束;尾部已收到的部分照样可用
  });
  // 退出后再等一小会儿把 stderr 读完;插件起的孙进程继承了 stderr 还活着时,管道不会结束,不能一直等
  const exited = child.exited.then(async (exitCode) => {
    await Promise.race([stderrDrained, Bun.sleep(300)]);
    return { exitCode: child.signalCode ? null : exitCode, signal: child.signalCode, stderrTail: stderrTail.text() };
  });

  const fail = async (message: string): Promise<never> => {
    listener.close();
    kill();
    const info = await exited;
    throw new Error(info.stderrTail ? `${message}\n引擎宿主进程的标准错误尾部:\n${info.stderrTail}` : message);
  };

  const launchLine: EngineHostLaunchLine = {
    address: listener.address,
    token: listener.token,
    maxFrameBytes: ENGINE_HOST_MAX_FRAME_BYTES,
    proxyConfig: options.proxyConfig,
    parentPid: process.pid,
  };
  child.stdin.write(`${JSON.stringify(launchLine)}\n`);
  child.stdin.flush();

  let channel: FrameChannel;
  try {
    const accepted = await Promise.race([
      listener.accepted,
      exited.then((info) => {
        throw new Error(`引擎宿主进程还没连上通道就退出了(退出码 ${String(info.exitCode ?? info.signal)})`);
      }),
    ]);
    const mismatch = engineHostHelloMismatch(accepted.hello, { protocol: ENGINE_HOST_PROTOCOL, appVersion: APP_VERSION });
    if (mismatch) {
      accepted.channel.close("问候不一致");
      return await fail(mismatch);
    }
    channel = accepted.channel;
    channel.setMaxFrameBytes(ENGINE_HOST_MAX_FRAME_BYTES);
    channel.setPeerMaxFrameBytes(accepted.hello.maxFrameBytes as number);
  } catch (err) {
    return await fail(err instanceof Error ? err.message : String(err));
  }

  const connection = connectDriverOverRpc((text) => channel.send(text), options.host, options.onProtocolError, {
    [RUNTIME_APP_ERROR]: (entry: AppErrorDto) => options.onAppError(entry),
  });
  channel.onFrame((text) => connection.receive(text));
  channel.onClose((reason) => connection.close(reason));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let driver: EngineDriver;
  try {
    driver = await Promise.race([
      connection.ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`引擎宿主进程 ${timeoutMs} ms 内没有就绪`)), timeoutMs);
      }),
    ]);
  } catch (err) {
    channel.close("握手失败");
    return await fail(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }

  return {
    driver,
    pid: child.pid,
    pushProxyConfig: (config) => connection.notify(RUNTIME_PROXY_CONFIG, [config]),
    ping: () => connection.request(RUNTIME_PING, []),
    kill,
    exited,
    async stop(stopTimeoutMs = 5_000) {
      channel.close("主程序停止引擎宿主进程");
      child.stdin.end();
      const done = await Promise.race([exited.then(() => true), Bun.sleep(stopTimeoutMs).then(() => false)]);
      if (!done) {
        kill();
        await exited;
      }
    },
  };
}
