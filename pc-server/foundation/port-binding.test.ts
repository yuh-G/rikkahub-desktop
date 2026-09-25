// foundation/port-binding.test.ts — issue #62 回环整组占有的行为锁:纯函数、假监听器编排、
// 真实套接字共存语义,以及「界面拨号主机 ⊆ 我们占住的地址」与壳(lib.rs)的契约。
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  UI_HOST,
  bindFirstUsable,
  isLoopbackHostname,
  isPortUnusableError,
  planBindAttempts,
  probeIpv6Loopback,
  resolveListenHostnames,
  stopListeners,
  uiOrigin,
  type BindAttempt,
  type BindFailure,
  type StoppableListener,
} from "./port-binding";

const GROUP = ["127.0.0.1", "::1"] as const;

describe("isLoopbackHostname", () => {
  test("三种回环写法(含方括号与大小写)", () => {
    for (const host of ["localhost", "LocalHost", "127.0.0.1", "::1", "[::1]", " localhost "]) {
      expect(isLoopbackHostname(host)).toBe(true);
    }
  });
  test("通配、局域网与形似回环的名字都不是", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.5", "127.0.0.2", "localhost.example.com", "tauri.localhost", ""]) {
      expect(isLoopbackHostname(host)).toBe(false);
    }
  });
});

describe("resolveListenHostnames", () => {
  test("回环意图:有 IPv6 回环 → 整组;没有 → 仅 IPv4", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      expect(resolveListenHostnames(host, () => true)).toEqual([...GROUP]);
      expect(resolveListenHostnames(host, () => false)).toEqual(["127.0.0.1"]);
    }
  });
  test("非回环原样单地址,且不做 IPv6 探测", () => {
    let probed = 0;
    const probe = () => {
      probed += 1;
      return true;
    };
    for (const host of ["0.0.0.0", "::", "192.168.1.5"]) {
      expect(resolveListenHostnames(host, probe)).toEqual([host]);
    }
    expect(probed).toBe(0);
  });
});

describe("planBindAttempts", () => {
  test("桌面:顺延 walk 个整组 → OS 分配整组重试 3 次 → 仅主地址收尾", () => {
    const attempts = planBindAttempts({ preferredPort: 8080, walk: 20, osAssignedFallback: true, hostnames: GROUP });
    expect(attempts.slice(0, 20).map((a) => a.port)).toEqual(Array.from({ length: 20 }, (_, i) => 8080 + i));
    expect(attempts.slice(0, 23).every((a) => a.hostnames === GROUP)).toBe(true);
    expect(attempts.slice(20).map((a) => a.port)).toEqual([0, 0, 0, 0]);
    expect(attempts.at(-1)!.hostnames).toEqual(["127.0.0.1"]);
  });
  test("单地址组(无 IPv6 回环/非回环):OS 分配只试一次", () => {
    const attempts = planBindAttempts({ preferredPort: 8080, walk: 2, osAssignedFallback: true, hostnames: ["127.0.0.1"] });
    expect(attempts).toEqual([
      { port: 8080, hostnames: ["127.0.0.1"] },
      { port: 8081, hostnames: ["127.0.0.1"] },
      { port: 0, hostnames: ["127.0.0.1"] },
    ]);
  });
  test("容器:单端口、不兜底", () => {
    expect(planBindAttempts({ preferredPort: 8080, walk: 1, osAssignedFallback: false, hostnames: ["0.0.0.0"] }))
      .toEqual([{ port: 8080, hostnames: ["0.0.0.0"] }]);
  });
  test("顺延钳在 65535", () => {
    const attempts = planBindAttempts({ preferredPort: 65533, walk: 20, osAssignedFallback: false, hostnames: GROUP });
    expect(attempts.map((a) => a.port)).toEqual([65533, 65534, 65535]);
  });
});

describe("isPortUnusableError", () => {
  test("Bun 真实的端口冲突错误形态(code 稳定、文案不含错误码)", () => {
    const holder = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    let caught: unknown;
    try {
      Bun.serve({ hostname: "127.0.0.1", port: holder.port, fetch: () => new Response("") }).stop(true);
    } catch (err) {
      caught = err;
    } finally {
      holder.stop(true);
    }
    expect(caught).toBeDefined();
    expect(isPortUnusableError(caught)).toBe(true);
  });
  test("EACCES / Windows 10013 / 文案型", () => {
    expect(isPortUnusableError(Object.assign(new Error("listen failed"), { code: "EACCES" }))).toBe(true);
    expect(isPortUnusableError(new Error("An attempt was made to access a socket in a way forbidden by its access permissions (10013)"))).toBe(true);
    expect(isPortUnusableError(new Error("address already in use"))).toBe(true);
  });
  test("配置类错误不顺延", () => {
    expect(isPortUnusableError(new Error("Invalid TLS certificate"))).toBe(false);
    expect(isPortUnusableError(Object.assign(new Error("bad option"), { code: "ERR_INVALID_ARG_TYPE" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// bindFirstUsable 编排:假监听器(不碰真实套接字),精确断言回滚、取号传递与失败分类
// ---------------------------------------------------------------------------

const inUse = () => Object.assign(new Error("Failed to start server. Is port X in use?"), { code: "EADDRINUSE" });

interface FakeListener extends StoppableListener {
  hostname: string;
  stopped: boolean;
}

function fakeNetwork(opts: { busy?: Array<[string, number]>; fatalAt?: [string, number]; osPorts?: number[] }) {
  const busy = new Set((opts.busy ?? []).map(([h, p]) => `${h}|${p}`));
  const osPorts = [...(opts.osPorts ?? [])];
  const calls: Array<[string, number]> = [];
  const created: FakeListener[] = [];
  const listen = (hostname: string, port: number): FakeListener => {
    calls.push([hostname, port]);
    if (opts.fatalAt && opts.fatalAt[0] === hostname && opts.fatalAt[1] === port) throw new Error("Invalid TLS certificate");
    const concrete = port === 0 ? osPorts.shift() ?? 0 : port;
    if (busy.has(`${hostname}|${concrete}`)) throw inUse();
    const listener: FakeListener = {
      hostname,
      port: concrete,
      stopped: false,
      stop() {
        listener.stopped = true;
      },
    };
    created.push(listener);
    return listener;
  };
  return { listen, calls, created };
}

describe("bindFirstUsable", () => {
  test("首选端口整组绑上", () => {
    const net = fakeNetwork({});
    const result = bindFirstUsable(planBindAttempts({ preferredPort: 8080, walk: 20, osAssignedFallback: true, hostnames: GROUP }), net.listen);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.port).toBe(8080);
    expect(result.listeners.map((l) => l.hostname)).toEqual([...GROUP]);
    expect(net.created.every((l) => !l.stopped)).toBe(true);
  });

  test("#62:::1 被占 → 回滚已绑的 127.0.0.1,整组顺延", () => {
    const net = fakeNetwork({ busy: [["::1", 8080]] });
    const unusable: Array<[BindFailure, BindAttempt | undefined]> = [];
    const result = bindFirstUsable(
      planBindAttempts({ preferredPort: 8080, walk: 20, osAssignedFallback: true, hostnames: GROUP }),
      net.listen,
      (failure, next) => unusable.push([failure, next]),
    );
    expect(result.ok && result.port).toBe(8081);
    const rolledBack = net.created.find((l) => l.hostname === "127.0.0.1" && l.port === 8080)!;
    expect(rolledBack.stopped).toBe(true);
    expect(unusable).toHaveLength(1);
    expect(unusable[0]![0]).toMatchObject({ hostname: "::1", port: 8080 });
    expect(unusable[0]![1]?.port).toBe(8081);
  });

  test("127.0.0.1 被占 → 组内后续地址不再尝试,直接顺延(旧行为回归锁)", () => {
    const net = fakeNetwork({ busy: [["127.0.0.1", 8080]] });
    const result = bindFirstUsable(planBindAttempts({ preferredPort: 8080, walk: 20, osAssignedFallback: true, hostnames: GROUP }), net.listen);
    expect(result.ok && result.port).toBe(8081);
    expect(net.calls.filter(([, p]) => p === 8080)).toEqual([["127.0.0.1", 8080]]);
  });

  test("OS 分配端口:主地址取到的号传给组内其余地址;配对失败重试后成功", () => {
    const net = fakeNetwork({ busy: [["127.0.0.1", 9000], ["::1", 50001]], osPorts: [50001, 50002] });
    const result = bindFirstUsable(planBindAttempts({ preferredPort: 9000, walk: 1, osAssignedFallback: true, hostnames: GROUP }), net.listen);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.port).toBe(50002);
    expect(result.listeners.map((l) => l.port)).toEqual([50002, 50002]);
    expect(net.calls).toEqual([["127.0.0.1", 9000], ["127.0.0.1", 0], ["::1", 50001], ["127.0.0.1", 0], ["::1", 50002]]);
    expect(net.created.find((l) => l.port === 50001)!.stopped).toBe(true);
  });

  test("OS 分配整组次次配对失败 → 仅主地址收尾,应用必起", () => {
    const net = fakeNetwork({ busy: [["127.0.0.1", 9000], ["::1", 1], ["::1", 2], ["::1", 3]], osPorts: [1, 2, 3, 4] });
    const result = bindFirstUsable(planBindAttempts({ preferredPort: 9000, walk: 1, osAssignedFallback: true, hostnames: GROUP }), net.listen);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.port).toBe(4);
    expect(result.attempt.hostnames).toEqual(["127.0.0.1"]);
    expect(result.listeners).toHaveLength(1);
  });

  test("非端口类错误 → fatal,回滚且不再顺延", () => {
    const net = fakeNetwork({ fatalAt: ["::1", 8080] });
    const result = bindFirstUsable(planBindAttempts({ preferredPort: 8080, walk: 20, osAssignedFallback: true, hostnames: GROUP }), net.listen);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("fatal");
    expect(result.failure).toMatchObject({ hostname: "::1", port: 8080 });
    expect(net.calls).toEqual([["127.0.0.1", 8080], ["::1", 8080]]);
    expect(net.created[0]!.stopped).toBe(true);
  });

  test("容器单端口被占 → exhausted,onUnusable 的 next 为空", () => {
    const net = fakeNetwork({ busy: [["0.0.0.0", 8080]] });
    const nexts: Array<BindAttempt | undefined> = [];
    const result = bindFirstUsable(
      planBindAttempts({ preferredPort: 8080, walk: 1, osAssignedFallback: false, hostnames: ["0.0.0.0"] }),
      net.listen,
      (_failure, next) => nexts.push(next),
    );
    expect(result).toMatchObject({ ok: false, kind: "exhausted", failure: { hostname: "0.0.0.0", port: 8080 } });
    expect(nexts).toEqual([undefined]);
  });

  test("空候选序列是编程错误", () => {
    expect(() => bindFirstUsable([], fakeNetwork({}).listen)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 真实套接字:断言不变量「两扇门都由我们应答」而非具体端口号——Windows 上通配地址可与具体地址
// 共存,Linux 上会 EADDRINUSE 顺延,两种结局都正确。端口一律从 OS 分配端口派生,避免撞车。
// ---------------------------------------------------------------------------

const ipv6 = probeIpv6Loopback();
const cleanup: StoppableListener[] = [];
afterEach(() => stopListeners(cleanup.splice(0)));

function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

function occupy(hostname: string, port: number): StoppableListener {
  const listener = Bun.listen({ hostname, port, socket: { data() {} } });
  cleanup.push(listener);
  return listener;
}

function serveUs(hostname: string, port: number) {
  const server = Bun.serve({ hostname, port, fetch: () => new Response("US") });
  cleanup.push(server);
  return server;
}

async function answer(url: string): Promise<string> {
  try {
    return await (await fetch(url)).text();
  } catch {
    return "<unreachable>";
  }
}

function bindGroupFrom(port: number) {
  const result = bindFirstUsable(planBindAttempts({ preferredPort: port, walk: 5, osAssignedFallback: true, hostnames: GROUP }), serveUs);
  if (!result.ok) throw new Error(`绑定失败:${String(result.failure.error)}`);
  return result;
}

async function expectBothDoorsOurs(port: number) {
  expect(await answer(`http://127.0.0.1:${port}/`)).toBe("US");
  expect(await answer(`http://[::1]:${port}/`)).toBe("US");
}

describe.skipIf(!ipv6)("真实套接字(本机有 IPv6 回环)", () => {
  test("#62 方向 A:第三方先占 ::1:p → 我们顺延离开 p,且 127.0.0.1:p 已被回滚释放", async () => {
    const p = freePort();
    occupy("::1", p);
    const bound = bindGroupFrom(p);
    expect(bound.port).not.toBe(p);
    await expectBothDoorsOurs(bound.port);
    occupy("127.0.0.1", p); // 回滚没释放的话这里会抛 EADDRINUSE
  });

  test("第三方先占 127.0.0.1:p → 顺延(旧行为回归锁)", async () => {
    const p = freePort();
    occupy("127.0.0.1", p);
    const bound = bindGroupFrom(p);
    expect(bound.port).not.toBe(p);
    await expectBothDoorsOurs(bound.port);
  });

  test("第三方先占通配 :: → 无论共存还是顺延,落脚端口的两扇门都归我们", async () => {
    const p = freePort();
    occupy("::", p);
    const bound = bindGroupFrom(p);
    await expectBothDoorsOurs(bound.port);
  });

  test("#62 方向 B:我们先占满 → 第三方的 ::1 / localhost / 127.0.0.1 具体绑定一律失败", async () => {
    const bound = bindGroupFrom(freePort());
    for (const hostname of ["::1", "localhost", "127.0.0.1"]) {
      expect(() => occupy(hostname, bound.port)).toThrow();
    }
    await expectBothDoorsOurs(bound.port);
  });
});

// ---------------------------------------------------------------------------
// 契约:界面拨号主机解析到的每个地址都在回环绑定组内;壳的界面地址由服务端标记单源下发
// ---------------------------------------------------------------------------

describe("界面拨号契约", () => {
  test("UI_HOST 解析到的地址 ⊆ 回环意图下占住的地址(拨名字安全的前提)", () => {
    const dialed = UI_HOST === "localhost" ? ["127.0.0.1", "::1"] : [UI_HOST];
    expect(resolveListenHostnames("127.0.0.1", () => true)).toEqual(expect.arrayContaining(dialed));
    expect(uiOrigin(8080)).toBe(`http://${UI_HOST}:8080`);
  });

  test("壳:界面地址由服务端标记单源下发(--ui-shell + UI_* 解析),兜底主机与服务端 UI_HOST 一致", () => {
    const shell = readFileSync(join(import.meta.dir, "..", "..", "web-ui", "src-tauri", "src", "lib.rs"), "utf8");
    // 壳告知服务端「有界面消费者」,origin 接力只在此时启用
    expect(shell).toContain('.args(["--no-open", "--ui-shell"])');
    expect(shell).toContain('strip_prefix("RIKKAHUB_UI_ORIGIN:")');
    expect(shell).toContain('strip_prefix("RIKKAHUB_UI_ENTRY:")');
    // UI_* 缺失的兜底地址(理论不可能——origin-relay.e2e 锁服务端必打、UI_* 先于端口行)
    expect(shell).toContain(`format!("http://${UI_HOST}:{port}")`);
    expect(shell).toContain(`format!("http://${UI_HOST}:{port}/")`);
    // 壳不得再有自己的 UI_HOST 常量——界面地址的唯一来源是服务端标记
    expect(shell).not.toMatch(/const UI_HOST/);
  });

  test("壳守卫格式串:代入值在模拟 window/location 上执行,五种情形全部正确", () => {
    const shell = readFileSync(join(import.meta.dir, "..", "..", "web-ui", "src-tauri", "src", "lib.rs"), "utf8");
    const formatStr = /let js = format!\(\s*"([^"]+)"/.exec(shell)?.[1];
    expect(formatStr).toBeDefined();
    // 格式串不得写死主机——地址全部来自代入值(服务端单源)
    expect(formatStr!).not.toContain("localhost");

    const ENTRY = "http://localhost:9000/"; // 模拟接力首跳(旧 origin 上的接力页)
    const FINAL = "http://localhost:17455";
    const run = (env: { app?: boolean; relay?: boolean; nav?: boolean; splash?: boolean; origin: string }) => {
      // Rust format 串 → 可执行 JS:{{ }} 还原成字面量花括号,{e:?}/{f:?} 换成 JSON 字符串
      const source = formatStr!
        .replace(/\{\{/g, "{")
        .replace(/\}\}/g, "}")
        .replace(/\{e:\?\}/g, JSON.stringify(ENTRY))
        .replace(/\{f:\?\}/g, JSON.stringify(FINAL));
      const fakeWindow: Record<string, unknown> = {};
      if (env.app) fakeWindow.__RIKKAHUB_APP__ = 1;
      if (env.relay) fakeWindow.__RIKKAHUB_RELAY__ = 1;
      if (env.nav) fakeWindow.__RIKKAHUB_NAV__ = 1;
      if (env.splash) fakeWindow.__RIKKAHUB_SPLASH__ = 1;
      const replaces: string[] = [];
      const fakeLocation = { origin: env.origin, replace: (url: string) => replaces.push(url) };
      new Function("window", "location", source)(fakeWindow, fakeLocation);
      return { replaces, window: fakeWindow };
    };

    // ① SPA 已在最终 origin:不打扰,也不立 NAV 旗
    expect(run({ app: true, origin: FINAL }).replaces).toEqual([]);
    // ② 启动屏:去首跳(接力时 = 旧 origin 接力页),并立 NAV 旗防后续 eval 打断
    const splashRun = run({ splash: true, origin: "http://tauri.localhost" });
    expect(splashRun.replaces).toEqual([ENTRY]);
    expect(splashRun.window.__RIKKAHUB_NAV__).toBe(1);
    // ③ 接力页进行中:不打断(它自己会带凭证跳回最终 origin)
    expect(run({ relay: true, origin: "http://localhost:9000" }).replaces).toEqual([]);
    // ④ 同一文档已发起导航:不打断
    expect(run({ nav: true, splash: true, origin: "http://tauri.localhost" }).replaces).toEqual([]);
    // ⑤ 错误页(无旗标)与旧 origin 活页面(APP 在但 origin 不对):一律直达最终 origin
    expect(run({ origin: "http://localhost:17456" }).replaces).toEqual([FINAL]);
    expect(run({ app: true, origin: "http://localhost:8080" }).replaces).toEqual([FINAL]);
  });
});
