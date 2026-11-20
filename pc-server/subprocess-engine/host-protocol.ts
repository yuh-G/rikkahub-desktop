// subprocess-engine/host-protocol.ts — 主程序与引擎宿主进程的启动参数与问候(P7.2.2,方案 §5.14.6)
//
// 主程序一侧 host-launch.ts、宿主进程一侧 host-runtime.ts 各引一份。改了这里的形状,或改了契约消息的含义,就把
// ENGINE_HOST_PROTOCOL 加一。宿主进程是用到时才启动的:应用运行期间 exe 被换成新版本,后启动的宿主进程与旧的主程序
// 对不上——主程序核对问候,不一致即拒绝,并提示重启应用。

import type { ProxyConfig } from "../foundation/types";

export const ENGINE_HOST_PROTOCOL = 3;

/** 两端各自声明能收的单帧上限(都取这个值)。大块内容分块传、不包进 JSON 字符串在 P7.2.4 做。 */
export const ENGINE_HOST_MAX_FRAME_BYTES = 256 * 1024 * 1024;

/** 主程序经子进程 stdin 第一行交过去的启动参数。令牌不放环境变量:环境变量会传给插件起的孙进程。 */
export interface EngineHostLaunchLine {
  address: string;
  token: string;
  /** 主程序能收的单帧上限。 */
  maxFrameBytes: number;
  /** 网络壳(代理 / UA / 空闲定时器)的配置;之后用户改代理,主程序推 runtime.proxyConfig。 */
  proxyConfig: ProxyConfig;
  /** 主程序的 pid:宿主进程的独立线程盯它(不用 process.ppid:Linux 上父进程没了会改挂到别的进程)。 */
  parentPid: number;
}

/** 宿主进程连上通道后的第一帧。 */
export type EngineHostHello = {
  token: string;
  role: "engine-host";
  protocol: number;
  appVersion: string;
  /** 宿主进程能收的单帧上限。 */
  maxFrameBytes: number;
  pid: number;
};

/** 进程运维消息(契约之外):主程序 → 宿主进程推新的网络配置;宿主进程 → 主程序转发错误中心条目。 */
export const RUNTIME_PROXY_CONFIG = "runtime.proxyConfig";
export const RUNTIME_APP_ERROR = "runtime.appError";
/** 主程序 → 宿主进程的判活请求(监管器定期问,带期限;宿主进程的主线程被占住时答不了)。 */
export const RUNTIME_PING = "runtime.ping";

/** 核对问候;对不上返回原因(给用户看),对得上返回 null。 */
export function engineHostHelloMismatch(hello: Record<string, unknown>, expected: { protocol: number; appVersion: string }): string | null {
  if (hello.role !== "engine-host") return `连上通道的不是引擎宿主进程(身份 ${String(hello.role)})`;
  if (hello.protocol !== expected.protocol || hello.appVersion !== expected.appVersion) {
    return `引擎宿主进程(版本 ${String(hello.appVersion)},协议 ${String(hello.protocol)})与主程序(版本 ${expected.appVersion},协议 ${expected.protocol})不一致:程序文件可能在运行期间被换成了另一个版本,请重启应用。`;
  }
  if (typeof hello.maxFrameBytes !== "number" || !(hello.maxFrameBytes > 0)) return "引擎宿主进程的问候缺少单帧上限";
  return null;
}
