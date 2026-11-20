// subprocess-engine/host-launch.test.ts — 主程序启动引擎宿主进程:握手、网络壳与配置推送、错误回传、版本不一致、退出(P7.2.2)
// 宿主进程用测试替身 test-utils/fake-engine-host.ts(真实的公共底座与通道 + 假驱动);真 pi 驱动的跨进程证明在
// smoke:engine-contract,入口分流在 foundation/process-roles.test.ts。
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { EngineHost, TurnRef } from "../engines/contract";
import type { ProxyConfig } from "../foundation/types";
import type { AppErrorDto } from "../foundation/types/dto";
import { engineHostTracePathIn } from "../observability/boot-trace";
import { launchEngineHost } from "./host-launch";

const fakeHost = resolve(import.meta.dir, "..", "test-utils", "fake-engine-host.ts");
const scratch = mkdtempSync(join(tmpdir(), "rkh-host-launch-"));
const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => new Response(`上游:${new URL(req.url).pathname}`) });

/** 一个只记下请求再转给上游的 HTTP 代理(Bun fetch 对 http 目标发绝对地址形式的请求行)。 */
async function startProxy() {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? "");
    const target = new URL(req.url ?? "/", "http://placeholder");
    const forward = http.request({ host: "127.0.0.1", port: upstream.port, path: target.pathname, method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    req.pipe(forward);
  });
  server.listen(0, "127.0.0.1");
  await new Promise((done) => server.once("listening", done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => server.close() };
}
const proxyA = await startProxy();
const proxyB = await startProxy();
afterAll(() => {
  proxyA.close();
  proxyB.close();
  void upstream.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

const manual = (url: string): ProxyConfig => ({ mode: "manual", url, username: "", password: "", bypassRules: "", userAgent: "" });
const host = (events: string[]): EngineHost => ({
  emit: (_turn, event) => void events.push(event.kind === "text_delta" ? event.text : event.kind),
  session: { load: async () => ({ items: [], compactions: [] }), append: async () => undefined },
  tools: { call: async () => ({ content: [] }) },
  permission: { check: async () => ({ scope: "default" }) },
  interaction: { dialog: async () => ({ cancelled: true }), dismiss: () => undefined, show: () => undefined },
  steer: { take: async () => [] },
  turn: { request: () => undefined },
  models: { credential: async () => ({}), log: () => undefined },
  report: () => undefined,
});
const env = (dataDir: string) => {
  const out: Record<string, string | undefined> = { ...process.env, RIKKAHUB_PC_DATA_DIR: dataDir };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]) delete out[key];
  return out;
};

describe("启动引擎宿主进程(实跑测试替身)", () => {
  test("握手后经通道跑一轮;请求走主程序给的代理,改代理推过去下一个请求即生效;错误回到主程序;stdout 的杂音不影响通道", async () => {
    const dataDir = join(scratch, "normal");
    const events: string[] = [];
    const appErrors: AppErrorDto[] = [];
    const protocolErrors: string[] = [];
    const proc = await launchEngineHost({
      host: host(events),
      proxyConfig: manual(proxyA.url),
      onAppError: (entry) => void appErrors.push(entry),
      onProtocolError: (reason) => void protocolErrors.push(reason),
      env: env(dataDir),
      spawnHost: (options) => Bun.spawn([process.execPath, fakeHost, "normal"], options),
    });
    expect(proc.driver.kind).toBe("fake-host");
    expect(existsSync(engineHostTracePathIn(join(dataDir, "logs"), proc.pid))).toBe(true);

    const turn1: TurnRef = { conversationId: "c", turnId: "t1" };
    const target = (path: string) => `http://rikkahub-host-test.invalid:${upstream.port}${path}`;
    const input = (path: string) => ({ prompt: { text: target(path), images: [] } }) as never;
    expect((await proc.driver.startTurn({ ...turn1, input: input("/first") })).text).toBe("上游:/first");
    expect(proxyA.seen).toEqual([target("/first")]);

    proc.pushProxyConfig(manual(proxyB.url));
    expect((await proc.driver.startTurn({ conversationId: "c", turnId: "t2", input: input("/second") })).text).toBe("上游:/second");
    expect(proxyB.seen).toEqual([target("/second")]);
    expect(proxyA.seen).toHaveLength(1);

    expect(events).toEqual(["上游:/first", "上游:/second"]);
    for (let i = 0; i < 50 && appErrors.length < 2; i++) await Bun.sleep(10);
    expect(appErrors.map((entry) => entry.message)).toEqual(["宿主进程里的错误:t1", "宿主进程里的错误:t2"]);
    expect(protocolErrors).toEqual([]);

    await proc.stop();
    expect((await proc.exited).exitCode).toBe(0);
    expect(existsSync(engineHostTracePathIn(join(dataDir, "logs"), proc.pid))).toBe(false);
  }, 30_000);

  test("问候里的版本对不上:拒绝、杀掉子进程,提示重启应用", async () => {
    const launching = launchEngineHost({
      host: host([]),
      proxyConfig: manual(proxyA.url),
      onAppError: () => undefined,
      onProtocolError: () => undefined,
      env: env(join(scratch, "wrong")),
      spawnHost: (options) => Bun.spawn([process.execPath, fakeHost, "wrong-version"], options),
    });
    await expect(launching).rejects.toThrow("请重启应用");
  }, 30_000);

  test("子进程还没连上通道就退出:以错误拒绝,带标准错误尾部", async () => {
    const launching = launchEngineHost({
      host: host([]),
      proxyConfig: manual(proxyA.url),
      onAppError: () => undefined,
      onProtocolError: () => undefined,
      env: env(join(scratch, "dies")),
      spawnHost: (options) => Bun.spawn([process.execPath, "-e", "console.error('宿主进程起不来'); process.exit(3)"], options),
    });
    await expect(launching).rejects.toThrow(/还没连上通道就退出了(?:.|\n)*宿主进程起不来/);
  }, 30_000);
});
