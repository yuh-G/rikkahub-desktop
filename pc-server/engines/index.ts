// engines/index.ts — 引擎注册表与路由(P2.7 定稿;P7.2.6 pi 改走引擎宿主进程)
//
// 注册表是驱动数组,顺序即优先级。路由只读驱动的声明式能力,不按引擎种类特判:会话工作区可用
// (workspaceRuntimeForConversation 的三道闸)→ 首个 workspace:"required" 的驱动;否则 → 首个
// workspace:"none" 的驱动(聊天引擎,排在最后兜底)。路由在生成/压缩入口判定一次并贯穿本次调用,
// 工作区运行时随判定结果带出(cwd/root 进 TurnInput),执行时不再重判。
//
// pi 驱动跑在引擎宿主进程里(方案 §5.14,D22:发布版只有这一条路,没有同进程开关):这里只有监管器
// (subprocess-engine/supervisor)和它给的驱动外壳,能力声明取自纯模块 pi-engine/capabilities,主程序不加载 pi。
// 宿主是应用唯一的 appEngineHost。同进程的 pi 驱动只给测试用(test-utils/in-process-pi 经
// replaceEngineDriverForTests 换上)。聊天引擎直连(上游错误要以原对象到达编排器的错误归类)。
// 具体驱动只在本模块实例化,编排器只认契约(engines/engine-agnostic-guard.test.ts 锁定)。新增引擎 = 契约里追加
// 种类字面量 + 一个驱动 + 本数组一行。
//
// 宿主进程的意外退出、放弃重启经错误中心提示(带码,中英文案在前端);状态变化交给编排器(无响应时给卡住的
// 会话亮状态条)。记录目录 engineHostRecordsDir 供下次启动清扫(sweepStaleEngines,bootstrap 在就绪前调)。

import { bumpAnalyticsEngineRestartCount } from "../app-config/analytics";
import { engineHostRecordsDir } from "../foundation/paths";
import { onSystemProxyChange, readSystemProxy } from "../foundation/net";
import type { Conversation, ProxyConfig } from "../foundation/types";
import { getStringArray } from "../foundation/utils";
import { reportError } from "../observability/app-errors";
import { state } from "../persistence/json-store";
import { PI_CAPABILITIES } from "../pi-engine/capabilities";
import { launchEngineHost, type EngineHostProcess } from "../subprocess-engine/host-launch";
import {
  EngineHostSupervisor,
  supervisedDriver,
  sweepStaleEngineHosts,
  type SupervisorEvent,
  type SupervisorState,
  type UnplannedExitReason,
} from "../subprocess-engine/supervisor";
import { workspaceRuntimeForConversation, type WorkspaceRuntime } from "../workspace/runtime";
import { createChatDriver } from "./chat-driver";
import type { EngineDriver, EnginePlugin, EnginePluginInspectionDto } from "./contract";
import { appEngineHost } from "./host";
import { STRICT_CONTRACT_TRANSPORT } from "./loopback";
import { pluginNameFromPath } from "./plugins";

const UNPLANNED_EXIT_CODES: Record<UnplannedExitReason, string> = {
  crashed: "engine_host_crashed",
  hung: "engine_host_hung",
  "stop-ignored": "engine_host_stop_ignored",
  "launch-failed": "engine_host_launch_failed",
};

const UNPLANNED_EXIT_TEXT: Record<UnplannedExitReason, string> = {
  crashed: "pi 引擎进程意外退出,已自动重启",
  hung: "pi 引擎长时间无响应,已强制结束并重启",
  "stop-ignored": "pi 引擎在停止生成时没有及时响应,已强制结束并重启",
  "launch-failed": "pi 引擎启动失败,正在重试",
};

let hostStateHandler: ((hostState: SupervisorState, conversationIds: string[]) => void) | null = null;

/** 编排器登记:宿主进程状态变了(带上有调用卡在它上面的会话)。 */
export function setEngineHostStateHandler(handler: (hostState: SupervisorState, conversationIds: string[]) => void): void {
  hostStateHandler = handler;
}

/** 监管器的状态事件转给编排器(各引擎的监管器共用;测试里自建的监管器也经它)。 */
export function notifyEngineHostState(hostState: SupervisorState, conversationIds: string[]): void {
  hostStateHandler?.(hostState, conversationIds);
}

/** 「放弃重启」提示里列的插件:pi 的已启用插件记录与开发者路径。 */
function enabledPiPlugins(): string[] {
  const records = (state.settings.enginePlugins ?? []).filter((record) => record.engine === "pi" && record.enabled);
  return [...records.map((record) => record.name), ...getStringArray(state.settings.devPiPluginPaths).map(pluginNameFromPath)];
}

function onPiHostEvent(event: SupervisorEvent): void {
  if (event.kind === "state") notifyEngineHostState(event.state, piHosts.activeConversations());
  else reportEngineHostTrouble(event);
}

/** 宿主进程的意外退出、放弃重启 → 错误中心(带码,前端按界面语言渲染)。 */
export function reportEngineHostTrouble(event: Exclude<SupervisorEvent, { kind: "state" }>): void {
  if (event.kind === "unplanned-exit") {
    // 不再重启的那次由 gave-up 提示;主程序退出途中的不提示。看板的「引擎进程重启次数」(D24)也只数真的重启了的
    if (event.restarting) {
      bumpAnalyticsEngineRestartCount();
      reportError("pi-engine", "warn", UNPLANNED_EXIT_TEXT[event.reason], event.detail, UNPLANNED_EXIT_CODES[event.reason]);
    }
  } else if (event.plugins.length > 0) {
    reportError("pi-engine", "error", event.message, undefined, "engine_host_gave_up_plugins", {
      count: event.failures,
      plugins: event.plugins.join("、"),
    });
  } else {
    reportError("pi-engine", "error", event.message, undefined, "engine_host_gave_up", { count: event.failures });
  }
}

/** 最近一次交给宿主进程的代理配置(启动行里那份或之后推的),没变就不推。 */
let pushedProxy = "";

function pushProxyIfChanged(host: EngineHostProcess, config: ProxyConfig): void {
  const text = JSON.stringify(config);
  if (text === pushedProxy) return;
  pushedProxy = text;
  host.pushProxyConfig(config);
}

/** 同上,系统代理(主程序探测,宿主进程不自己探测)。 */
let pushedSystemProxy: string | null = null;

function pushSystemProxyIfChanged(host: EngineHostProcess, value: string | null): void {
  if (value === pushedSystemProxy) return;
  pushedSystemProxy = value;
  host.pushSystemProxy(value);
}

const piHosts: EngineHostSupervisor<EngineHostProcess> = new EngineHostSupervisor<EngineHostProcess>({
  name: "pi",
  recordsDir: engineHostRecordsDir,
  enabledPlugins: enabledPiPlugins,
  onEvent: onPiHostEvent,
  async launch({ onSpawn }) {
    const proxyConfig = state.settings.proxyConfig;
    const systemProxy = readSystemProxy() ?? null;
    const host = await launchEngineHost({
      host: appEngineHost,
      proxyConfig,
      systemProxy,
      onAppError: (entry) => reportError(entry.domain, entry.severity, entry.message, entry.detail, entry.code, entry.params),
      onProtocolError: (reason) => reportError("pi-engine", "info", `pi 引擎通道上有协议问题:${reason}`),
      onSpawn,
    });
    // 握手期间用户改了代理、系统代理变了:那时还没有进程可推(whenRunning 跳过),这里补推
    pushedProxy = JSON.stringify(proxyConfig);
    pushProxyIfChanged(host, state.settings.proxyConfig);
    pushedSystemProxy = systemProxy;
    pushSystemProxyIfChanged(host, readSystemProxy() ?? null);
    return host;
  },
});

onSystemProxyChange((value) => {
  piHosts.whenRunning(async (host) => pushSystemProxyIfChanged(host, value ?? null)).catch((err: unknown) => {
    reportError("pi-engine", "info", "系统代理没能推给 pi 引擎宿主进程", err);
  });
});

const piDriver = supervisedDriver(piHosts, "pi", PI_CAPABILITIES);

const ENGINE_DRIVERS: EngineDriver[] = [piDriver, createChatDriver()];

/** 仅测试:按种类换掉一个驱动(同进程的 pi 驱动、带假宿主进程的监管器),返回换回去的函数。 */
export function replaceEngineDriverForTests(driver: EngineDriver): () => void {
  if (!STRICT_CONTRACT_TRANSPORT) throw new Error("replaceEngineDriverForTests 只在测试里用");
  const index = ENGINE_DRIVERS.findIndex((item) => item.kind === driver.kind);
  if (index < 0) throw new Error(`没有 ${driver.kind} 引擎`);
  const previous = ENGINE_DRIVERS[index]!;
  ENGINE_DRIVERS[index] = driver;
  return () => {
    ENGINE_DRIVERS[index] = previous;
  };
}

export interface EngineRoute {
  driver: EngineDriver;
  /** 驱动需要工作区时为判定时刻的工作区运行时;否则 null。 */
  workspace: WorkspaceRuntime | null;
}

export function resolveEngine(conversation: Conversation): EngineRoute {
  const runtime = workspaceRuntimeForConversation(conversation);
  const wanted = runtime ? "required" : "none";
  const driver = ENGINE_DRIVERS.find((item) => item.capabilities.workspace === wanted) ?? ENGINE_DRIVERS.at(-1)!;
  return { driver, workspace: driver.capabilities.workspace === "required" ? runtime : null };
}

/** 用户打开了一个会话:要用 pi 引擎就先把宿主进程起起来,首轮不必等启动。 */
export function prewarmEngineFor(conversation: Conversation): void {
  if (resolveEngine(conversation).driver === piDriver) piHosts.prewarm();
}

/** 用户手动重试(重新生成):清掉连续失败记录,放弃重启之后允许再起。 */
export function resetEngineHosts(): void {
  piHosts.reset();
}

/** 用户改了插件(装、卸、停用、开发者路径):同上,并且正在跑的宿主进程空下来就换一个——停用的插件已经加载过的代码
 *  和它对进程全局的改动(换掉 fetch、泄漏的内存)只有换进程才清得掉。 */
export function enginePluginsChanged(): void {
  piHosts.recycle();
}

/** 设置变了:代理配置变了就推给正在跑的宿主进程(它的网络壳读这份)。 */
export function syncEngineProxyConfig(config: ProxyConfig): void {
  piHosts.whenRunning(async (host) => pushProxyIfChanged(host, config)).catch((err: unknown) => {
    reportError("pi-engine", "info", "代理配置没能推给 pi 引擎宿主进程", err);
  });
}

/** 启动时清扫上次留下的宿主进程。只在拿到数据目录锁之后、起新宿主进程之前调。不抛错:清扫失败不该挡住启动。 */
export async function sweepStaleEngines(): Promise<void> {
  try {
    await sweepStaleEngineHosts(engineHostRecordsDir);
  } catch (err) {
    reportError("internal", "warn", "清扫上次留下的引擎宿主进程失败", err);
  }
}

/** 主程序退出:停掉宿主进程,最多等 2 秒(主程序没了它也会自己结束,见 subprocess-engine/parent-watch)。 */
export async function disposeEngineHosts(): Promise<void> {
  await Promise.race([piHosts.dispose(), Bun.sleep(2_000)]);
}

/** 一个插件登记了什么(插件页详情、安装 / 上传后的校验)。要执行插件代码,所以交给有插件运行时的那个驱动(P7.2.5)。 */
export function inspectEnginePlugin(engine: string, plugin: EnginePlugin): Promise<EnginePluginInspectionDto> {
  const driver = ENGINE_DRIVERS.find((item) => item.kind === engine && item.capabilities.plugins);
  if (!driver?.inspectPlugin) return Promise.reject(new Error(`引擎 ${engine} 没有插件运行时`));
  return driver.inspectPlugin({ plugin });
}

/** 让各引擎丢掉该会话的长驻状态(会话删除时)。失败只上报:删除本身不受影响。 */
export function invalidateEngineSessions(conversationId: string): void {
  for (const driver of ENGINE_DRIVERS) {
    driver.invalidate(conversationId).catch((err: unknown) => reportError("internal", "info", "引擎会话状态清理失败", err));
  }
}
