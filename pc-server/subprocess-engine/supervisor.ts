// subprocess-engine/supervisor.ts — 引擎宿主进程的监管器(P7.2.3,方案 §5.14.7;与引擎无关,DSH 复用)
//
// 宿主进程的启动、停止、强杀、重启只在这里发生(好几处都能起或杀它,就会同时跑着两个,或一处在用、另一处把它杀了)。
// 编排器看到的仍是 EngineDriver:supervisedDriver 把每次调用转给当前的宿主进程,没有就先起一个。
//
// 判活:通道断即进程没了(exited);每隔 pingIntervalMs 问一句 runtime.ping,同一时刻只有一句在途。卡死分级:
//   不答超过 unresponsiveAfterMs → 状态「无响应」(调用方在会话上提示),不杀;
//   用户点停止 → abort 转过去,stopDeadlineMs 内这个会话的调用还没结束 → 强杀;
//   不答超过 restartAfterMs → 强杀并重启。
// 计时前先看主程序自己:两次检查的间隔(墙钟与单调时钟取大)比预定长出 lagToleranceMs,说明主程序卡过或电脑睡眠过,
// 这一轮不算,不答的计时从头起。
// 意外退出(崩溃、卡死被杀、停止时不配合被杀、启动失败)各算一次失败并立即重启;crashLoopWindowMs 内满 crashLoopLimit 次
// 就停止重启,提示当前启用的插件。没有调用在途且 idleReclaimMs 内没有新调用 → 正常停掉。
// 每起一个进程在 recordsDir 记下 pid 与启动时刻,退出即删;主程序启动时 sweepStaleEngineHosts 清扫上次留下的。

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EngineCapabilities, EngineDriver, EngineKind } from "../engines/contract";
import { EngineChannelClosedError } from "../engines/rpc-transport";
import { CodedError } from "../foundation/errors";
import { roleFlag } from "../foundation/process-roles";
import { reportError } from "../observability/app-errors";
import type { EngineHostProcess } from "./host-launch";
import { killProcessAndDescendants, processIdentities, type ProcessIdentity } from "./process-info";

export type SupervisedHost = Pick<EngineHostProcess, "driver" | "pid" | "ping" | "kill" | "stop" | "exited">;

/** idle = 未启动或已退出;failed = 连续失败到上限,已停止重启。 */
export type SupervisorState = "idle" | "starting" | "ready" | "unresponsive" | "stopping" | "failed";

/** 宿主进程意外没了的原因:自己崩溃、卡死被杀、用户停止时不配合被杀、启动失败。 */
export type UnplannedExitReason = "crashed" | "hung" | "stop-ignored" | "launch-failed";

export type SupervisorEvent =
  | { kind: "state"; state: SupervisorState }
  /** 一次意外退出(看板的重启次数按它计);restarting 为 false 表示已到崩溃循环上限。 */
  | { kind: "unplanned-exit"; reason: UnplannedExitReason; detail: string; restarting: boolean }
  | { kind: "gave-up"; message: string; failures: number; plugins: string[] };

export interface SupervisorTiming {
  pingIntervalMs: number;
  unresponsiveAfterMs: number;
  restartAfterMs: number;
  lagToleranceMs: number;
  stopDeadlineMs: number;
  /** 正常停掉时等它自己退出的限期,过了就强杀。 */
  stopTimeoutMs: number;
  crashLoopLimit: number;
  crashLoopWindowMs: number;
  idleReclaimMs: number;
}

export const SUPERVISOR_TIMING: SupervisorTiming = {
  pingIntervalMs: 2_000,
  // 首次加载一批插件、在大仓库里搜索都可能几秒不答,只提示不杀
  unresponsiveAfterMs: 5_000,
  restartAfterMs: 60_000,
  lagToleranceMs: 1_000,
  stopDeadlineMs: 5_000,
  stopTimeoutMs: 5_000,
  crashLoopLimit: 3,
  crashLoopWindowMs: 5 * 60_000,
  // 晚于 pi 长驻会话的 10 分钟空闲回收(pi-engine/session-host.ts):会话都收了,进程才收
  idleReclaimMs: 15 * 60_000,
};

export interface SupervisorClock {
  wall(): number;
  mono(): number;
}

const systemClock: SupervisorClock = { wall: () => Date.now(), mono: () => performance.now() };

export interface EngineHostSupervisorOptions<H extends SupervisedHost> {
  /** 引擎名,只用于提示文字。 */
  name: string;
  /** 起一个宿主进程并完成握手;onSpawn 在子进程一起来就调(早于握手)。生产里是 launchEngineHost。 */
  launch(hooks: { onSpawn(pid: number): void }): Promise<H>;
  /** 启动记录目录;不给就不记。 */
  recordsDir?: string;
  /** 当前启用的插件(停止重启时的提示用)。 */
  enabledPlugins?(): string[];
  onEvent?(event: SupervisorEvent): void;
  timing?: Partial<SupervisorTiming>;
  clock?: SupervisorClock;
}

type ExitInfo = Awaited<SupervisedHost["exited"]>;
/** ending:这个进程为什么结束;null = 还在正常服务。 */
type Live<H> = { host: H; ending: "planned" | UnplannedExitReason | null; exit: ExitInfo | null };

/** 进程意外没了、或已停止重启时,给当前这条回复的错误码。 */
export const ENGINE_HOST_EXITED = "engine_host_exited";
export const ENGINE_HOST_GAVE_UP = "engine_host_gave_up";

/** 在途的一次调用;live 为 null 表示还在等宿主进程就绪,这时中止就不发出去,直接以中止结束。 */
type CallRecord<H> = { conversationId: string | null; live: Live<H> | null; aborted: boolean; wake: (() => void) | null; done: boolean };

function exitDetail(info: ExitInfo | null): string {
  if (!info) return "退出原因未知";
  const how = info.signal ? `信号 ${info.signal}` : `退出码 ${String(info.exitCode)}`;
  const tail = info.stderrTail.trim().split("\n").slice(-3).join(" | ").slice(-500);
  return tail ? `${how};标准错误:${tail}` : how;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class EngineHostSupervisor<H extends SupervisedHost = SupervisedHost> {
  private readonly timing: SupervisorTiming;
  private readonly clock: SupervisorClock;
  private stateValue: SupervisorState = "idle";
  private live: Live<H> | null = null;
  private starting: Promise<Live<H>> | null = null;
  private stopping: Promise<void> | null = null;
  private readonly calls = new Set<CallRecord<H>>();
  /** 意外退出的时刻(单调时钟);有调用正常完成即清空——「连续」失败才算。 */
  private failures: number[] = [];
  private gaveUpMessage = "";
  private watchTimer: ReturnType<typeof setInterval> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly options: EngineHostSupervisorOptions<H>) {
    this.timing = { ...SUPERVISOR_TIMING, ...options.timing };
    this.clock = options.clock ?? systemClock;
  }

  get state(): SupervisorState {
    return this.stateValue;
  }

  /** 有在途调用的会话(宿主进程无响应时,界面给这些会话显示提示)。 */
  activeConversations(): string[] {
    return [...new Set([...this.calls].flatMap((call) => (call.conversationId === null ? [] : [call.conversationId])))];
  }

  /** 当前的宿主进程;没有就起一个(同一时刻只有一个启动在途)。 */
  async ensure(): Promise<H> {
    return (await this.ensureLive()).host;
  }

  /** 预热(用户打开要用这个引擎的会话时)。 */
  prewarm(): void {
    this.ensure().catch(() => {
      // 失败已记为一次意外退出并经 onEvent 通知;预热没有等结果的调用方
    });
  }

  /** 用户改了插件或手动重试:清掉失败记录,允许再起。 */
  reset(): void {
    this.failures = [];
    if (this.stateValue === "failed") this.setState("idle");
  }

  /** 在当前宿主进程上做一次调用(没有就先起一个)。进程中途没了 → 以带码的错误拒绝。 */
  async run<T>(conversationId: string | null, call: (host: H) => Promise<T>): Promise<T> {
    const record: CallRecord<H> = { conversationId, live: null, aborted: false, wake: null, done: false };
    this.calls.add(record);
    clearTimeout(this.idleTimer);
    try {
      const live = await new Promise<Live<H>>((resolve, reject) => {
        record.wake = () => reject(new DOMException("引擎调用已中止", "AbortError"));
        this.ensureLive().then(resolve, reject);
      });
      // 进程就绪与这里之间有一拍:这一拍里来的中止没有发给任何进程,在这里兑现
      if (record.aborted) throw new DOMException("引擎调用已中止", "AbortError");
      // 赋值与发出请求在同一拍:之后的中止经同一通道发出,按序排在这次调用之后
      record.live = live;
      try {
        const result = await call(live.host);
        this.failures = [];
        return result;
      } catch (err) {
        throw err instanceof EngineChannelClosedError ? await this.exitError(live) : err;
      }
    } finally {
      record.done = true;
      this.calls.delete(record);
      this.scheduleIdle();
    }
  }

  /** 用户点停止:转给宿主进程;stopDeadlineMs 内这个会话当时在途的调用还没结束,就强杀(依据是用户的明确意图)。 */
  async abort(conversationId: string, reason: string): Promise<void> {
    const targets = [...this.calls].filter((call) => call.conversationId === conversationId);
    for (const call of targets) {
      if (call.live) continue;
      call.aborted = true;
      call.wake?.();
    }
    const live = this.live;
    if (!live) return;
    const dispatched = targets.filter((call) => call.live === live);
    if (dispatched.length > 0) {
      const timer = setTimeout(() => {
        if (this.live === live && dispatched.some((call) => !call.done)) this.kill(live, "stop-ignored");
      }, this.timing.stopDeadlineMs);
      timer.unref?.();
    }
    try {
      await live.host.driver.abort(conversationId, reason);
    } catch (err) {
      // 进程已经没了:在途调用随之结束,中止已经达成
      if (!(err instanceof EngineChannelClosedError)) throw err;
    }
  }

  /** 有进程在跑才做(失效通知之类:新起的进程本来就是空的)。 */
  async whenRunning(call: (host: H) => Promise<void>): Promise<void> {
    const live = this.live;
    if (!live || live.ending !== null) return;
    try {
      await call(live.host);
    } catch (err) {
      // 进程恰在此时没了:新起的进程是空的,要做的事已不必做
      if (!(err instanceof EngineChannelClosedError)) throw err;
    }
  }

  /** 正常停掉(空闲回收、主程序退出、换配置)。不抛错。 */
  async stop(): Promise<void> {
    clearTimeout(this.idleTimer);
    if (this.starting) {
      await this.starting.catch(() => {
        // 启动失败:没有要停的进程
      });
    }
    if (this.stopping) return this.stopping;
    const live = this.live;
    if (!live) return;
    live.ending ??= "planned";
    this.stopWatch();
    this.setState("stopping");
    this.stopping = (async () => {
      const disposed = live.host.driver.dispose().catch(() => {
        // 进程卡住或已退出:下面限期停掉或强杀
      });
      await Promise.race([disposed, Bun.sleep(this.timing.stopTimeoutMs)]);
      await live.host.stop(this.timing.stopTimeoutMs);
    })().finally(() => {
      this.stopping = null;
      if (this.stateValue === "stopping") this.setState("idle");
    });
    return this.stopping;
  }

  /** 主程序退出时:停掉进程,之后不再起。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
  }

  private closedError(): CodedError {
    return new CodedError(`${this.options.name} 引擎已关闭`, ENGINE_HOST_EXITED);
  }

  private ensureLive(): Promise<Live<H>> {
    if (this.disposed) return Promise.reject(this.closedError());
    if (this.stateValue === "failed") return Promise.reject(new CodedError(this.gaveUpMessage, ENGINE_HOST_GAVE_UP));
    const live = this.live;
    if (live && live.ending === null) return Promise.resolve(live);
    this.starting ??= this.startWithRetries().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startWithRetries(): Promise<Live<H>> {
    // 上一个进程正在停或正在被强杀:等它没了再起,同一时刻只留一个
    if (this.stopping) await this.stopping;
    const previous = this.live;
    if (previous) await previous.host.exited;
    for (;;) {
      if (this.disposed) throw this.closedError();
      // 上一个进程的意外退出可能刚好用满了失败次数
      if (this.stateValue === "failed") throw new CodedError(this.gaveUpMessage, ENGINE_HOST_GAVE_UP);
      try {
        return await this.startOnce();
      } catch (err) {
        if (this.disposed) throw this.closedError();
        if (!this.unplanned("launch-failed", errorText(err))) throw new CodedError(this.gaveUpMessage, ENGINE_HOST_GAVE_UP);
      }
    }
  }

  private async startOnce(): Promise<Live<H>> {
    this.setState("starting");
    const spawned = { pid: 0 };
    let host: H;
    try {
      host = await this.options.launch({
        onSpawn: (pid) => {
          spawned.pid = pid;
          this.writeRecord(pid);
        },
      });
    } catch (err) {
      if (spawned.pid) this.removeRecord(spawned.pid);
      this.setState("idle");
      throw err;
    }
    const live: Live<H> = { host, ending: null, exit: null };
    this.live = live;
    void host.exited.then((info) => this.onExit(live, info));
    if (this.disposed) {
      live.ending = "planned";
      await host.stop(this.timing.stopTimeoutMs);
      this.setState("idle");
      throw this.closedError();
    }
    this.setState("ready");
    this.startWatch(live);
    this.scheduleIdle();
    return live;
  }

  private onExit(live: Live<H>, info: ExitInfo): void {
    live.exit = info;
    this.removeRecord(live.host.pid);
    if (this.live === live) {
      this.live = null;
      this.stopWatch();
    }
    if (live.ending === "planned") return;
    const reason = live.ending ?? "crashed";
    live.ending = reason;
    this.setState("idle");
    if (this.unplanned(reason, exitDetail(info))) this.prewarm();
  }

  /** 记一次意外退出;返回是否还要重启。 */
  private unplanned(reason: UnplannedExitReason, detail: string): boolean {
    const now = this.clock.mono();
    this.failures = [...this.failures.filter((at) => now - at < this.timing.crashLoopWindowMs), now];
    const restarting = !this.disposed && this.failures.length < this.timing.crashLoopLimit;
    this.options.onEvent?.({ kind: "unplanned-exit", reason, detail, restarting });
    if (!restarting && !this.disposed) {
      const plugins = this.options.enabledPlugins?.() ?? [];
      const hint = plugins.length > 0 ? `当前启用的插件:${plugins.join("、")},可以先停用它们再试。` : "";
      this.gaveUpMessage = `${this.options.name} 引擎进程短时间内连续 ${this.failures.length} 次意外退出,已停止重启(最后一次:${detail})。${hint}`;
      this.setState("failed");
      this.options.onEvent?.({ kind: "gave-up", message: this.gaveUpMessage, failures: this.failures.length, plugins });
    }
    return restarting;
  }

  private async exitError(live: Live<H>): Promise<Error> {
    // 通道先断、进程随后才退出:等到退出信息(退出码、标准错误尾部)。通道断了进程却不退,它已经没法再用,结束它
    await Promise.race([live.host.exited, Bun.sleep(3_000)]);
    if (!live.exit) {
      this.kill(live, "crashed");
      await Promise.race([live.host.exited, Bun.sleep(1_000)]);
    }
    const name = this.options.name;
    switch (live.ending) {
      case "hung":
        return new CodedError(`${name} 引擎长时间无响应,已重启`, ENGINE_HOST_EXITED);
      case "stop-ignored":
        return new CodedError(`${name} 引擎在用户停止生成时没有及时响应,已强制结束并重启`, ENGINE_HOST_EXITED);
      case "planned":
        return new CodedError(`${name} 引擎已停止`, ENGINE_HOST_EXITED);
      default:
        return new CodedError(`${name} 引擎进程意外退出(${exitDetail(live.exit)})`, ENGINE_HOST_EXITED);
    }
  }

  private kill(live: Live<H>, reason: Exclude<UnplannedExitReason, "launch-failed">): void {
    if (live.ending !== null) return;
    live.ending = reason;
    this.stopWatch();
    live.host.kill();
  }

  /** 判活:同一时刻只有一句 ping 在途,不答的时长从发出算起;主程序自己卡过或睡眠过的那一轮,计时从头起。 */
  private startWatch(live: Live<H>): void {
    this.stopWatch();
    let lastWall = this.clock.wall();
    let lastMono = this.clock.mono();
    let pending: { sentAt: number } | null = null;
    this.watchTimer = setInterval(() => {
      if (this.live !== live || live.ending !== null) return;
      const wall = this.clock.wall();
      const now = this.clock.mono();
      const gap = Math.max(wall - lastWall, now - lastMono);
      lastWall = wall;
      lastMono = now;
      if (gap - this.timing.pingIntervalMs > this.timing.lagToleranceMs) {
        if (pending) pending.sentAt = now;
        return;
      }
      if (pending) {
        const silentMs = now - pending.sentAt;
        if (silentMs >= this.timing.restartAfterMs) this.kill(live, "hung");
        else if (silentMs >= this.timing.unresponsiveAfterMs) this.setState("unresponsive");
        return;
      }
      const sent = { sentAt: now };
      pending = sent;
      live.host.ping().then(
        () => {
          if (pending !== sent) return;
          pending = null;
          if (this.live === live && this.stateValue === "unresponsive") this.setState("ready");
        },
        (err: unknown) => {
          // 通道断了:进程退出由 onExit 处理。别的错误也是对端回的包,说明它还在答
          if (!(err instanceof EngineChannelClosedError) && pending === sent) pending = null;
        },
      );
    }, this.timing.pingIntervalMs);
    this.watchTimer.unref?.();
  }

  private stopWatch(): void {
    clearInterval(this.watchTimer);
    this.watchTimer = undefined;
  }

  private scheduleIdle(): void {
    clearTimeout(this.idleTimer);
    if (this.calls.size > 0 || !this.live || this.disposed) return;
    this.idleTimer = setTimeout(() => {
      if (this.calls.size === 0) void this.stop();
    }, this.timing.idleReclaimMs);
    this.idleTimer.unref?.();
  }

  private setState(next: SupervisorState): void {
    if (this.stateValue === next) return;
    this.stateValue = next;
    this.options.onEvent?.({ kind: "state", state: next });
  }

  private writeRecord(pid: number): void {
    const dir = this.options.recordsDir;
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, startedAt: Date.now() } satisfies EngineHostRecord));
    } catch (err) {
      reportError("internal", "warn", `记不下 ${this.options.name} 引擎宿主进程的启动记录,它若成了孤儿,下次启动清扫不到`, err);
    }
  }

  private removeRecord(pid: number): void {
    const dir = this.options.recordsDir;
    if (dir) rmSync(join(dir, `${pid}.json`), { force: true });
  }
}

/** 启动记录:子进程一起来就写,退出即删。主程序非正常结束时留下的就是可能还活着的宿主进程。 */
export interface EngineHostRecord {
  pid: number;
  startedAt: number;
}

/** 记录的启动时刻与系统查到的进程启动时刻允许的偏差(Linux 的开机时刻只精确到秒,mac 的 lstart 也是秒)。 */
const START_TIME_TOLERANCE_MS = 5_000;

/** 记录里的进程还是不是当初那个宿主进程:pid 会被系统复用,命令行带角色标记、启动时刻对得上才算。 */
export function isRecordedEngineHost(record: EngineHostRecord, identity: ProcessIdentity | undefined): boolean {
  if (!identity || !identity.commandLine.includes(roleFlag("engine-host"))) return false;
  return identity.startedAt !== null && Math.abs(identity.startedAt - record.startedAt) <= START_TIME_TOLERANCE_MS;
}

function readRecords(dir: string): { file: string; record: EngineHostRecord | null }[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    // 目录不存在:上次没起过宿主进程
    return [];
  }
  return names.map((name) => {
    const file = join(dir, name);
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<EngineHostRecord>;
      const valid = Number.isInteger(parsed.pid) && (parsed.pid as number) > 0 && typeof parsed.startedAt === "number";
      return { file, record: valid ? (parsed as EngineHostRecord) : null };
    } catch {
      // 写到一半断电之类:当作无效记录删掉
      return { file, record: null };
    }
  });
}

/**
 * 主程序启动时清扫上次留下的宿主进程(防孤儿的第二层,不依赖任何特殊能力)。只在拿到数据目录锁之后调:
 * 同一数据目录不会有另一个主程序正用着这些进程。返回杀掉的 pid。
 */
export async function sweepStaleEngineHosts(dir: string): Promise<number[]> {
  const entries = readRecords(dir);
  if (entries.length === 0) return [];
  const records = entries.flatMap((entry) => (entry.record ? [entry.record] : []));
  let identities = new Map<number, ProcessIdentity>();
  try {
    identities = await processIdentities(records.map((record) => record.pid));
  } catch (err) {
    reportError("internal", "warn", "查不了上次留下的引擎宿主进程,这次不清扫", err);
    return [];
  }
  const killed: number[] = [];
  for (const record of records) {
    if (!isRecordedEngineHost(record, identities.get(record.pid))) continue;
    killProcessAndDescendants(record.pid);
    killed.push(record.pid);
  }
  for (const entry of entries) rmSync(entry.file, { force: true });
  if (killed.length > 0) reportError("internal", "info", `结束了上次留下的引擎宿主进程:${killed.join("、")}`);
  return killed;
}

/**
 * 编排器看到的驱动:种类与能力声明是静态的(选引擎时还没起进程),每次调用转给监管器当前的宿主进程。
 * 失效通知只发给正在跑的进程;dispose 停掉进程且之后不再起。
 */
export function supervisedDriver<H extends SupervisedHost>(supervisor: EngineHostSupervisor<H>, kind: EngineKind, capabilities: EngineCapabilities): EngineDriver {
  return {
    kind,
    capabilities,
    startTurn: (req) => supervisor.run(req.conversationId, (host) => host.driver.startTurn(req)),
    abort: (conversationId, reason) => supervisor.abort(conversationId, reason),
    ...(capabilities.nativeCompaction
      ? { compact: (req) => supervisor.run(req.conversationId, (host) => host.driver.compact!(req)) }
      : {}),
    invalidate: (conversationId) => supervisor.whenRunning((host) => host.driver.invalidate(conversationId)),
    ...(capabilities.commands
      ? {
          listCommands: (req) => supervisor.run(req.conversationId, (host) => host.driver.listCommands!(req)),
          runCommand: (req) => supervisor.run(req.conversationId, (host) => host.driver.runCommand!(req)),
        }
      : {}),
    // 不属于任何会话:中止会话不会打断它。
    ...(capabilities.plugins ? { inspectPlugin: (req) => supervisor.run(null, (host) => host.driver.inspectPlugin!(req)) } : {}),
    dispose: () => supervisor.dispose(),
  };
}
