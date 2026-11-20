// subprocess-engine/supervisor.test.ts — 引擎宿主进程的监管器(P7.2.3,方案 §5.14.7)
// 状态机、判活分级、主程序卡过或睡眠过不算、停止不配合即强杀、崩溃循环上限、空闲回收、启动记录与清扫,用假的宿主进程
// (计时调短)锁;最后用测试替身 test-utils/fake-engine-host.ts 实跑卡死与加载即崩溃两种进程。
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { EngineDriver, EngineHost, TurnRequest } from "../engines/contract";
import { EngineChannelClosedError } from "../engines/rpc-transport";
import { CodedError } from "../foundation/errors";
import { roleFlag } from "../foundation/process-roles";
import { launchEngineHost } from "./host-launch";
import {
  ENGINE_HOST_EXITED,
  ENGINE_HOST_GAVE_UP,
  EngineHostSupervisor,
  supervisedDriver,
  sweepStaleEngineHosts,
  type SupervisedHost,
  type SupervisorEvent,
  type SupervisorTiming,
} from "./supervisor";

const scratch = mkdtempSync(join(tmpdir(), "rkh-supervisor-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const capabilities = { resumeSemantics: "run-and-suspend", steering: "boundary", nativeCompaction: false, workspace: "none", placement: "portable", commands: false, plugins: false } as const;
const turn = (conversationId = "c"): TurnRequest => ({ conversationId, turnId: "t" });

type FakeOptions = {
  /** startTurn 的行为;默认立即完成。 */
  startTurn?: (host: FakeHost) => Promise<{ text: string }>;
  /** ping 不回。 */
  silent?: boolean;
  /** driver.abort 时让在途调用以中止结束(配合的进程)。 */
  honorsAbort?: boolean;
};

let nextPid = 1000;

class FakeHost implements SupervisedHost {
  readonly pid = nextPid++;
  readonly calls: string[] = [];
  private finish!: (info: Awaited<SupervisedHost["exited"]>) => void;
  readonly exited = new Promise<Awaited<SupervisedHost["exited"]>>((done) => (this.finish = done));
  private readonly inflight = new Set<(err: unknown) => void>();
  gone = false;
  readonly driver: EngineDriver;

  constructor(private readonly options: FakeOptions = {}) {
    const self = this;
    this.driver = {
      kind: "fake",
      capabilities,
      startTurn: () => (this.calls.push("startTurn"), this.track(options.startTurn ? options.startTurn(self) : Promise.resolve({ text: `来自 ${self.pid}` }))) as never,
      abort: async (conversationId) => {
        this.calls.push(`abort:${conversationId}`);
        if (options.honorsAbort) for (const reject of this.inflight) reject(new DOMException("stopped", "AbortError"));
      },
      invalidate: async (conversationId) => void this.calls.push(`invalidate:${conversationId}`),
      dispose: async () => void this.calls.push("dispose"),
    };
  }

  /** 进程没了时,在途调用与通道一样以 EngineChannelClosedError 拒绝。 */
  private track<T>(work: Promise<T>): Promise<T> {
    if (this.gone) return Promise.reject(new EngineChannelClosedError("通道已关闭"));
    return new Promise<T>((resolve, reject) => {
      this.inflight.add(reject);
      work.then(resolve, reject).finally(() => this.inflight.delete(reject));
    });
  }

  ping = () => (this.options.silent ? new Promise(() => {}) : this.track(Promise.resolve(true)));

  exit(info: Partial<Awaited<SupervisedHost["exited"]>> = {}): void {
    if (this.gone) return;
    this.gone = true;
    for (const reject of this.inflight) reject(new EngineChannelClosedError("通道已关闭"));
    this.finish({ exitCode: 0, signal: null, stderrTail: "", ...info });
  }

  kill = () => {
    this.calls.push("kill");
    this.exit({ exitCode: null, signal: "SIGKILL" });
  };

  stop = async () => {
    this.calls.push("stop");
    this.exit();
  };
}

const fast: Partial<SupervisorTiming> = {
  pingIntervalMs: 10,
  unresponsiveAfterMs: 40,
  restartAfterMs: 150,
  lagToleranceMs: 1_000,
  stopDeadlineMs: 60,
  stopTimeoutMs: 100,
  crashLoopWindowMs: 60_000,
  idleReclaimMs: 60_000,
};

function supervise(make: () => FakeHost | Promise<FakeHost>, extra: Partial<ConstructorParameters<typeof EngineHostSupervisor<FakeHost>>[0]> = {}) {
  const hosts: FakeHost[] = [];
  const events: SupervisorEvent[] = [];
  const supervisor = new EngineHostSupervisor<FakeHost>({
    name: "测试",
    launch: async ({ onSpawn }) => {
      const host = await make();
      onSpawn(host.pid);
      hosts.push(host);
      return host;
    },
    onEvent: (event) => void events.push(event),
    timing: fast,
    ...extra,
  });
  const states = () => events.flatMap((event) => (event.kind === "state" ? [event.state] : []));
  const exits = () => events.flatMap((event) => (event.kind === "unplanned-exit" ? [`${event.reason}:${event.restarting}`] : []));
  return { supervisor, hosts, events, states, exits };
}

async function until(check: () => boolean, ms = 3_000) {
  const startedAt = performance.now();
  while (!check() && performance.now() - startedAt < ms) await Bun.sleep(5);
  return check();
}

const codeOf = (err: unknown) => (err instanceof CodedError ? err.errorCode : err instanceof Error ? err.name : String(err));

describe("启动与转发", () => {
  test("按需启动;同时来的调用只起一个进程;状态 idle → starting → ready", async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const { supervisor, hosts, states } = supervise(async () => (await gate, new FakeHost()));
    expect(supervisor.state).toBe("idle");
    const a = supervisor.run("c1", (host) => host.driver.startTurn(turn("c1")));
    const b = supervisor.run("c2", (host) => host.driver.startTurn(turn("c2")));
    expect(supervisor.state).toBe("starting");
    release();
    expect((await a).text).toBe((await b).text);
    expect(hosts).toHaveLength(1);
    expect(states()).toEqual(["starting", "ready"]);
    await supervisor.dispose();
  });

  test("supervisedDriver:种类与能力是静态的;失效通知不为它起进程;dispose 之后的调用以带码的错误拒绝", async () => {
    const { supervisor, hosts } = supervise(() => new FakeHost());
    const driver = supervisedDriver(supervisor, "fake", capabilities);
    expect(driver.kind).toBe("fake");
    expect(driver.compact).toBeUndefined();
    await driver.invalidate("c");
    expect(hosts).toHaveLength(0);
    expect((await driver.startTurn(turn())).text).toBe(`来自 ${hosts[0]!.pid}`);
    await driver.invalidate("c");
    expect(hosts[0]!.calls).toEqual(["startTurn", "invalidate:c"]);
    await driver.dispose();
    expect(hosts[0]!.calls).toEqual(["startTurn", "invalidate:c", "dispose", "stop"]);
    expect(codeOf(await driver.startTurn(turn()).catch((err) => err))).toBe(ENGINE_HOST_EXITED);
    expect(hosts).toHaveLength(1);
  });

  test("预热:先起好进程,之后的调用直接用它", async () => {
    const { supervisor, hosts } = supervise(() => new FakeHost());
    supervisor.prewarm();
    expect(await until(() => supervisor.state === "ready")).toBe(true);
    await supervisor.run("c", (host) => host.driver.startTurn(turn()));
    expect(hosts).toHaveLength(1);
    await supervisor.dispose();
  });
});

describe("判活与卡死分级", () => {
  test("几十毫秒不答 → 无响应(不杀);主线程缓过来、答上那一句 → 回到就绪", async () => {
    const held: (() => void)[] = [];
    let stuck = true;
    const { supervisor, hosts, states } = supervise(() => {
      const host = new FakeHost();
      // 主线程被占住时请求排着队,缓过来按序答复
      host.ping = () => new Promise((done) => (stuck ? held.push(() => done(true)) : done(true)));
      return host;
    }, { timing: { ...fast, restartAfterMs: 60_000 } });
    await supervisor.ensure();
    expect(await until(() => supervisor.state === "unresponsive")).toBe(true);
    expect(hosts[0]!.calls).not.toContain("kill");
    expect(held).toHaveLength(1);
    stuck = false;
    for (const answer of held.splice(0)) answer();
    expect(await until(() => supervisor.state === "ready")).toBe(true);
    await supervisor.dispose();
    expect(states()).toEqual(["starting", "ready", "unresponsive", "ready", "stopping", "idle"]);
  });

  test("一直不答 → 强杀并重启;在途调用以带码的错误结束,提示已重启;算一次意外退出", async () => {
    let first = true;
    const { supervisor, hosts, exits } = supervise(() => {
      const host = new FakeHost({ silent: first, startTurn: () => new Promise(() => {}) });
      first = false;
      return host;
    });
    const call = supervisor.run("c", (host) => host.driver.startTurn(turn()));
    const err = await call.catch((e) => e);
    expect(codeOf(err)).toBe(ENGINE_HOST_EXITED);
    expect(String(err.message)).toContain("无响应");
    expect(hosts[0]!.calls).toContain("kill");
    expect(exits()).toEqual(["hung:true"]);
    expect(await until(() => supervisor.state === "ready" && hosts.length === 2)).toBe(true);
    await supervisor.dispose();
  });
});

describe("主程序自己卡过、用户点停止", () => {
  test("主程序卡过或电脑睡眠过(两次检查的间隔远超预定):这一轮不算,不答的计时从头起", async () => {
    // 每次检查,墙钟都往前跳一大截(睡眠醒来);单调时钟正常走
    let jump = 0;
    const clock = { wall: () => Date.now() + (jump += 5_000), mono: () => performance.now() };
    const { supervisor, hosts, states } = supervise(() => new FakeHost({ silent: true }), { clock, timing: { ...fast, restartAfterMs: 80 } });
    await supervisor.ensure();
    await Bun.sleep(300);
    expect(hosts[0]!.calls).not.toContain("kill");
    expect(states()).toEqual(["starting", "ready"]);
    await supervisor.dispose();
  });

  test("用户点停止:中止转过去;进程配合 → 不杀", async () => {
    const { supervisor, hosts } = supervise(() => new FakeHost({ honorsAbort: true, startTurn: () => new Promise(() => {}) }));
    const call = supervisor.run("c", (host) => host.driver.startTurn(turn()));
    await until(() => hosts[0]?.calls.includes("startTurn") ?? false);
    await supervisor.abort("c", "user");
    expect(codeOf(await call.catch((e) => e))).toBe("AbortError");
    await Bun.sleep(100);
    expect(hosts[0]!.calls).toEqual(["startTurn", "abort:c"]);
    await supervisor.dispose();
  });

  test("用户点停止:进程限期内不配合 → 强杀并重启;这条回复以中止之外的带码错误结束,算一次意外退出", async () => {
    const { supervisor, hosts, exits } = supervise(() => new FakeHost({ startTurn: () => new Promise(() => {}) }));
    const call = supervisor.run("c", (host) => host.driver.startTurn(turn()));
    await until(() => hosts[0]?.calls.includes("startTurn") ?? false);
    await supervisor.abort("c", "user");
    const err = await call.catch((e) => e);
    expect(codeOf(err)).toBe(ENGINE_HOST_EXITED);
    expect(hosts[0]!.calls).toEqual(["startTurn", "abort:c", "kill"]);
    expect(exits()).toEqual(["stop-ignored:true"]);
    expect(await until(() => hosts.length === 2 && supervisor.state === "ready")).toBe(true);
    await supervisor.dispose();
  });

  test("别的会话的停止不牵连:只等被停的那个会话的调用", async () => {
    const { supervisor, hosts } = supervise(() => new FakeHost({ startTurn: () => new Promise(() => {}) }));
    void supervisor.run("other", (host) => host.driver.startTurn(turn("other"))).catch(() => undefined);
    await until(() => hosts[0]?.calls.includes("startTurn") ?? false);
    await supervisor.abort("c", "user");
    await Bun.sleep(150);
    expect(hosts[0]!.calls).not.toContain("kill");
    await supervisor.dispose();
  });

  test("还在启动时点停止:这次调用直接以中止结束,不发给进程", async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const { supervisor, hosts } = supervise(async () => (await gate, new FakeHost()));
    const call = supervisor.run("c", (host) => host.driver.startTurn(turn()));
    await supervisor.abort("c", "user");
    expect(codeOf(await call.catch((e) => e))).toBe("AbortError");
    release();
    expect(await until(() => supervisor.state === "ready")).toBe(true);
    expect(hosts[0]!.calls).toEqual([]);
    await supervisor.dispose();
  });
});

describe("崩溃、崩溃循环、空闲回收", () => {
  test("进程中途崩溃:在途调用以带码的错误结束(带退出码与标准错误尾部),立即起新进程", async () => {
    const { supervisor, hosts, exits } = supervise(() => new FakeHost({ startTurn: () => new Promise(() => {}) }));
    const call = supervisor.run("c", (host) => host.driver.startTurn(turn()));
    await until(() => hosts[0]?.calls.includes("startTurn") ?? false);
    hosts[0]!.exit({ exitCode: 3, stderrTail: "插件抛了异常\n" });
    const err = await call.catch((e) => e);
    expect(codeOf(err)).toBe(ENGINE_HOST_EXITED);
    expect(String(err.message)).toContain("退出码 3");
    expect(String(err.message)).toContain("插件抛了异常");
    expect(exits()).toEqual(["crashed:true"]);
    expect(await until(() => hosts.length === 2 && supervisor.state === "ready")).toBe(true);
    await supervisor.dispose();
  });

  test("短时间内连续 3 次意外退出 → 停止重启,提示启用的插件;之后的调用立即拒绝;reset 后可再起", async () => {
    let failing = true;
    const { supervisor, hosts, events, exits } = supervise(
      async () => {
        if (failing) throw new Error("插件加载时崩溃");
        return new FakeHost();
      },
      { enabledPlugins: () => ["dev:counter", "dev:todo"] },
    );
    const err = await supervisor.run("c", (host) => host.driver.startTurn(turn())).catch((e) => e);
    expect(codeOf(err)).toBe(ENGINE_HOST_GAVE_UP);
    expect(exits()).toEqual(["launch-failed:true", "launch-failed:true", "launch-failed:false"]);
    expect(supervisor.state).toBe("failed");
    const gaveUp = events.find((event) => event.kind === "gave-up");
    expect(gaveUp?.kind === "gave-up" && gaveUp.message).toContain("dev:counter、dev:todo");
    expect(codeOf(await supervisor.run("c", (host) => host.driver.startTurn(turn())).catch((e) => e))).toBe(ENGINE_HOST_GAVE_UP);
    failing = false;
    supervisor.reset();
    expect((await supervisor.run("c", (host) => host.driver.startTurn(turn()))).text).toBe(`来自 ${hosts[0]!.pid}`);
    await supervisor.dispose();
  });

  test("「连续」才算:中间有一次调用正常完成,失败次数清零;窗口外的失败不计", async () => {
    const { supervisor, hosts, exits } = supervise(() => new FakeHost());
    const crashOnce = async () => {
      await supervisor.ensure();
      hosts.at(-1)!.exit({ exitCode: 1 });
      await until(() => supervisor.state === "ready" && !hosts.at(-1)!.gone);
    };
    await crashOnce();
    await crashOnce();
    await supervisor.run("c", (host) => host.driver.startTurn(turn()));
    await crashOnce();
    await crashOnce();
    expect(exits()).toEqual(["crashed:true", "crashed:true", "crashed:true", "crashed:true"]);
    await supervisor.dispose();

    const windowed = supervise(() => new FakeHost(), { timing: { ...fast, crashLoopWindowMs: 30 } });
    for (let i = 0; i < 4; i++) {
      await windowed.supervisor.ensure();
      windowed.hosts.at(-1)!.exit({ exitCode: 1 });
      await Bun.sleep(40);
    }
    expect(windowed.exits().every((exit) => exit.endsWith(":true"))).toBe(true);
    await windowed.supervisor.dispose();
  });

  test("空闲回收:没有调用在途、限期内没有新调用 → 正常停掉(不算意外退出);下一次调用再起", async () => {
    const { supervisor, hosts, exits } = supervise(() => new FakeHost(), { timing: { ...fast, idleReclaimMs: 50 } });
    await supervisor.run("c", (host) => host.driver.startTurn(turn()));
    expect(await until(() => hosts[0]!.gone)).toBe(true);
    expect(hosts[0]!.calls).toEqual(["startTurn", "dispose", "stop"]);
    expect(supervisor.state).toBe("idle");
    await supervisor.run("c", (host) => host.driver.startTurn(turn()));
    expect(hosts).toHaveLength(2);
    expect(exits()).toEqual([]);
    await supervisor.dispose();
  });

  test("有调用在途时不回收", async () => {
    let finish!: () => void;
    const { supervisor, hosts } = supervise(() => new FakeHost({ startTurn: () => new Promise((done) => (finish = () => done({ text: "完" }))) }), {
      timing: { ...fast, idleReclaimMs: 30 },
    });
    const call = supervisor.run("c", (host) => host.driver.startTurn(turn()));
    await Bun.sleep(120);
    expect(hosts[0]!.gone).toBe(false);
    finish();
    await call;
    expect(await until(() => hosts[0]!.gone)).toBe(true);
    await supervisor.dispose();
  });
});

describe("启动记录与清扫", () => {
  test("子进程一起来就记下,退出即删", async () => {
    const recordsDir = join(scratch, "records");
    const { supervisor, hosts } = supervise(() => new FakeHost(), { recordsDir });
    await supervisor.ensure();
    expect(readdirSync(recordsDir)).toEqual([`${hosts[0]!.pid}.json`]);
    hosts[0]!.exit({ exitCode: 1 });
    await until(() => hosts.length === 2);
    expect(await until(() => readdirSync(recordsDir).join() === `${hosts[1]!.pid}.json`)).toBe(true);
    await supervisor.dispose();
    expect(readdirSync(recordsDir)).toEqual([]);
  });

  test("清扫:只杀命令行带宿主进程标记、启动时刻对得上的;pid 被复用的、已不在的、坏记录只删记录", async () => {
    const dir = join(scratch, "sweep");
    mkdirSync(dir, { recursive: true });
    const spawnMarked = (flag: string) =>
      Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)", flag], { stdout: "ignore", stderr: "ignore" });
    const stale = spawnMarked(roleFlag("engine-host"));
    const reused = spawnMarked(roleFlag("engine-host"));
    const unrelated = spawnMarked("--not-ours");
    const now = Date.now();
    try {
      const write = (name: string, body: unknown) => writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
      write(`${stale.pid}.json`, { pid: stale.pid, startedAt: now });
      // 同一个 pid 换成了别的进程:启动时刻对不上
      write(`${reused.pid}.json`, { pid: reused.pid, startedAt: now - 3_600_000 });
      write(`${unrelated.pid}.json`, { pid: unrelated.pid, startedAt: now });
      write("999999999.json", { pid: 999_999_999, startedAt: now });
      write("broken.json", "{半截");
      expect(await sweepStaleEngineHosts(dir)).toEqual([stale.pid]);
      expect(await Promise.race([stale.exited.then(() => true), Bun.sleep(5_000).then(() => false)])).toBe(true);
      expect(reused.exitCode).toBeNull();
      expect(unrelated.exitCode).toBeNull();
      expect(readdirSync(dir)).toEqual([]);
      expect(await sweepStaleEngineHosts(join(scratch, "never-created"))).toEqual([]);
    } finally {
      for (const proc of [stale, reused, unrelated]) proc.kill("SIGKILL");
    }
  }, 30_000);
});

const fakeHostEntry = resolve(import.meta.dir, "..", "test-utils", "fake-engine-host.ts");
const noopHost: EngineHost = {
  emit: () => undefined,
  session: { load: async () => ({ items: [], compactions: [] }), append: async () => undefined },
  tools: { call: async () => ({ content: [] }) },
  permission: { check: async () => ({ scope: "default" }) },
  interaction: { dialog: async () => ({ cancelled: true }), dismiss: () => undefined, show: () => undefined },
  steer: { take: async () => [] },
  turn: { request: () => undefined },
  models: { credential: async () => ({}), log: () => undefined },
  report: () => undefined,
};

function realSupervisor(mode: "hang" | "crash", timing: Partial<SupervisorTiming>) {
  const dataDir = join(scratch, `real-${mode}`);
  const env: Record<string, string | undefined> = { ...process.env, RIKKAHUB_PC_DATA_DIR: dataDir };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[key];
  const pids: number[] = [];
  const events: SupervisorEvent[] = [];
  const recordsDir = join(dataDir, "engine-hosts");
  const supervisor = new EngineHostSupervisor({
    name: "测试",
    recordsDir,
    enabledPlugins: () => ["dev:crasher"],
    onEvent: (event) => void events.push(event),
    timing: { ...fast, ...timing },
    launch: ({ onSpawn }) =>
      launchEngineHost({
        host: noopHost,
        proxyConfig: { mode: "direct", url: "", username: "", password: "", bypassRules: "", userAgent: "" },
        onAppError: () => undefined,
        onProtocolError: () => undefined,
        env,
        onSpawn: (pid) => (pids.push(pid), onSpawn(pid)),
        spawnHost: (options) => Bun.spawn([process.execPath, fakeHostEntry, mode], options),
      }),
  });
  return { supervisor, pids, events, recordsDir };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

describe("实跑测试替身", () => {
  test("插件卡死主线程:先报无响应,再强杀并重启;回复以带码的错误结束,进程不残留", async () => {
    const { supervisor, pids, events, recordsDir } = realSupervisor("hang", { pingIntervalMs: 50, unresponsiveAfterMs: 300, restartAfterMs: 1_500 });
    const err = await supervisor.run("c", (host) => host.driver.startTurn({ ...turn(), input: { prompt: { text: "", images: [] } } as never })).catch((e) => e);
    expect(codeOf(err)).toBe(ENGINE_HOST_EXITED);
    const states = events.flatMap((event) => (event.kind === "state" ? [event.state] : []));
    expect(states.slice(0, 3)).toEqual(["starting", "ready", "unresponsive"]);
    expect(events.some((event) => event.kind === "unplanned-exit" && event.reason === "hung" && event.restarting)).toBe(true);
    expect(await until(() => supervisor.state === "ready" && pids.length === 2, 15_000)).toBe(true);
    expect(alive(pids[0]!)).toBe(false);
    await supervisor.dispose();
    expect(await until(() => !alive(pids[1]!), 5_000)).toBe(true);
    expect(existsSync(recordsDir) ? readdirSync(recordsDir) : []).toEqual([]);
  }, 30_000);

  test("插件加载即崩溃:连续 3 次后停止重启,提示里有启用的插件与标准错误尾部", async () => {
    const { supervisor, pids, events } = realSupervisor("crash", {});
    const err = await supervisor.ensure().catch((e) => e);
    expect(codeOf(err)).toBe(ENGINE_HOST_GAVE_UP);
    expect(pids).toHaveLength(3);
    expect(String(err.message)).toContain("dev:crasher");
    expect(String(err.message)).toContain("插件加载时崩溃");
    expect(events.filter((event) => event.kind === "unplanned-exit").map((event) => event.kind === "unplanned-exit" && event.reason)).toEqual([
      "launch-failed",
      "launch-failed",
      "launch-failed",
    ]);
    expect(pids.every((pid) => !alive(pid))).toBe(true);
    await supervisor.dispose();
  }, 30_000);
});
