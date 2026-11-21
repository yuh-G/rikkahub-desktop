// foundation/system-proxy.test.ts — 系统代理的缓存与探测线程(PF2.1,方案 §5.16.4):缓存过期后请求路径上不起子进程;
// 探测线程起不来时报一次警、在调用线程上照旧读;引擎宿主进程只用主程序推来的值,过期时限频提醒。
// 跨进程的那一段(启动行带值、推送、提醒)在 subprocess-engine/host-launch.test.ts 里用真子进程跑。
import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";

import { clearAppErrors, recentAppErrors } from "../observability/app-errors";
import {
  detectSystemPacUrl,
  detectSystemProxy,
  onSystemProxyChange,
  primeSystemProxyCache,
  readSystemProxy,
  resetSystemProxyCacheForTests,
  setExternalSystemProxy,
  settleSystemProxyRefreshForTests,
  SYSTEM_PROXY_TTL_MS,
  useExternalSystemProxy,
} from "./net";
import { RUNNING_IN_CONTAINER, RUNTIME_PLATFORM } from "./platform";
import { READS_SYSTEM_SETTINGS, readSystemSetting, resetSystemProxyProbeForTests } from "./system-proxy-probe";

const later = (ms: number) => setSystemTime(new Date(Date.now() + ms));

beforeEach(() => {
  resetSystemProxyCacheForTests();
  resetSystemProxyProbeForTests();
  clearAppErrors();
});
afterEach(() => {
  setSystemTime();
  resetSystemProxyCacheForTests();
  resetSystemProxyProbeForTests();
});

describe("主程序:探测线程", () => {
  test("经探测线程读到的与在调用线程上直接读的相同(系统代理、PAC)", async () => {
    expect(await detectSystemProxy()).toBe(await readSystemSetting("proxy", RUNTIME_PLATFORM, RUNNING_IN_CONTAINER));
    expect(await detectSystemPacUrl()).toBe(await readSystemSetting("pac", RUNTIME_PLATFORM, RUNNING_IN_CONTAINER));
  });

  // macOS 与容器里不读系统设置,也就不建探测线程
  test.if(READS_SYSTEM_SETTINGS)("缓存过期后的读取:返回旧值,刷新交给探测线程,调用线程上不调 Bun.spawn", async () => {
    await primeSystemProxyCache();
    const before = readSystemProxy();
    const spawn = spyOn(Bun, "spawn");
    const post = spyOn(Worker.prototype, "postMessage");
    try {
      later(SYSTEM_PROXY_TTL_MS + 1);
      expect(readSystemProxy()).toBe(before);
      // 一次只查一个:刷新在途时再读不再发
      readSystemProxy();
      expect(post).toHaveBeenCalledTimes(1);
      await settleSystemProxyRefreshForTests();
      readSystemProxy();
      expect(post).toHaveBeenCalledTimes(1);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
      post.mockRestore();
    }
  });

  test.if(READS_SYSTEM_SETTINGS)("探测线程起不来:报一次警,之后在调用线程上读,结果不变", async () => {
    const expected = await readSystemSetting("proxy", RUNTIME_PLATFORM, RUNNING_IN_CONTAINER);
    const ctor = spyOn(globalThis as unknown as { Worker: () => never }, "Worker").mockImplementation(() => {
      throw new Error("起不来");
    });
    const spawn = spyOn(Bun, "spawn");
    try {
      expect(await detectSystemProxy()).toBe(expected);
      expect(await detectSystemProxy()).toBe(expected);
      const reports = recentAppErrors().filter((entry) => entry.code === "system_proxy_probe_fallback");
      expect(reports).toHaveLength(1);
      expect(reports[0]!.severity).toBe("warn");
      expect(spawn).toHaveBeenCalled();
    } finally {
      ctor.mockRestore();
      spawn.mockRestore();
    }
  });

  test.if(READS_SYSTEM_SETTINGS)("探测线程中途没了:在途的查询改在调用线程上读完,报一次警,之后不再用线程", async () => {
    const expected = await readSystemSetting("proxy", RUNTIME_PLATFORM, RUNNING_IN_CONTAINER);
    const post = spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker) {
      this.terminate();
    });
    try {
      expect(await detectSystemProxy()).toBe(expected);
      expect(recentAppErrors().filter((entry) => entry.code === "system_proxy_probe_fallback")).toHaveLength(1);
      post.mockClear();
      expect(await detectSystemProxy()).toBe(expected);
      expect(post).not.toHaveBeenCalled();
    } finally {
      post.mockRestore();
    }
  });

  test("刷新到的值变了才通知(推给引擎宿主进程用)", async () => {
    const seen: Array<string | undefined> = [];
    const off = onSystemProxyChange((value) => void seen.push(value));
    try {
      await primeSystemProxyCache();
      const first = seen.length;
      later(SYSTEM_PROXY_TTL_MS + 1);
      readSystemProxy();
      await settleSystemProxyRefreshForTests();
      // 系统设置没变:刷新不通知
      expect(seen.length).toBe(first);
    } finally {
      off();
    }
  });
});

describe("引擎宿主进程:值从主程序来", () => {
  test("用推来的值;过期时提醒主程序、每个过期周期最多一次;自己不探测", () => {
    const reminders: number[] = [];
    const spawn = spyOn(Bun, "spawn");
    const post = spyOn(Worker.prototype, "postMessage");
    try {
      useExternalSystemProxy("http://127.0.0.1:7890", () => void reminders.push(Date.now()));
      expect(readSystemProxy()).toBe("http://127.0.0.1:7890");
      expect(reminders).toHaveLength(0);

      later(SYSTEM_PROXY_TTL_MS + 1);
      expect(readSystemProxy()).toBe("http://127.0.0.1:7890");
      expect(readSystemProxy()).toBe("http://127.0.0.1:7890");
      expect(reminders).toHaveLength(1);

      setExternalSystemProxy(undefined);
      expect(readSystemProxy()).toBeUndefined();
      later(SYSTEM_PROXY_TTL_MS - 1);
      readSystemProxy();
      expect(reminders).toHaveLength(1);
      later(2);
      readSystemProxy();
      expect(reminders).toHaveLength(2);

      expect(spawn).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
      post.mockRestore();
    }
  });
});
