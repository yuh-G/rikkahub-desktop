// subprocess-engine/host-launch.test.ts — 主程序启动引擎宿主进程:握手、网络壳与配置推送、系统代理由主程序给、错误回传、版本不一致、
// 退出(P7.2.2、PF2.1)
// 宿主进程用测试替身 test-utils/fake-engine-host.ts(真实的公共底座与通道 + 假驱动);真 pi 驱动的跨进程证明在
// smoke:engine-contract,入口分流在 foundation/process-roles.test.ts。
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { EngineHost, TurnRef } from "../engines/contract";
import { SYSTEM_PROXY_TTL_MS } from "../foundation/net";
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
  test("握手后经通道跑一轮;请求走主程序给的代理,改代理推过去下一个请求即生效;错误回到主程序;插件与它起的子命令往 stdout 写的杂音不影响通道", async () => {
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

  test("系统代理:宿主进程用主程序给的值、自己不探测;缓存过期时提醒主程序且每个过期周期一条;主程序推来新值,下一个请求即生效", async () => {
    const stale: number[] = [];
    const proc = await launchEngineHost({
      host: host([]),
      proxyConfig: { ...manual(""), mode: "auto" },
      systemProxy: proxyA.url,
      onSystemProxyStale: () => void stale.push(Date.now()),
      onAppError: () => undefined,
      onProtocolError: () => undefined,
      env: env(join(scratch, "system-proxy")),
      spawnHost: (options) => Bun.spawn([process.execPath, fakeHost, "normal"], options),
    });
    const target = (path: string) => `http://rikkahub-host-test.invalid:${upstream.port}${path}`;
    const run = async (path: string) => (await proc.driver.startTurn({ conversationId: "s", turnId: path, input: { prompt: { text: target(path), images: [] } } as never })).text;

    expect(await run("/sys1")).toBe("上游:/sys1");
    expect(proxyA.seen).toContain(target("/sys1"));
    // 机器慢时启动到第一轮可能已超过 2 s,那一轮就会提醒一次;只数之后的
    const before = stale.length;

    // 过期以后:旧值照用(自己探测的话,值会换成本机真实的系统设置),并提醒主程序;紧接着的请求不再提醒
    await Bun.sleep(SYSTEM_PROXY_TTL_MS + 200);
    expect(await run("/sys2")).toBe("上游:/sys2");
    expect(await run("/sys3")).toBe("上游:/sys3");
    expect(proxyA.seen).toEqual(expect.arrayContaining([target("/sys2"), target("/sys3")]));
    for (let i = 0; i < 100 && stale.length === before; i++) await Bun.sleep(10);
    await Bun.sleep(50);
    expect(stale.length - before).toBe(1);

    proc.pushSystemProxy(proxyB.url);
    expect(await run("/sys4")).toBe("上游:/sys4");
    expect(proxyB.seen).toContain(target("/sys4"));
    expect(proxyA.seen).not.toContain(target("/sys4"));

    await proc.stop();
    expect((await proc.exited).exitCode).toBe(0);
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

  test("契约的每个方法在真实通道上各走一次:驱动侧七个、宿主侧十三个,参数与回答原样往返", async () => {
    const calls: string[] = [];
    const seen = (name: string, value: unknown) => void calls.push(`${name} ${JSON.stringify(value)}`);
    const recording: EngineHost = {
      emit: (_turn, event) => seen("emit", event),
      session: {
        load: async (turn) => (seen("session.load", turn.turnId), { items: [], compactions: [] }),
        append: async (_turn, entries) => seen("session.append", entries),
      },
      tools: { call: async (call) => (seen("tools.call", call.args), { content: [{ type: "text", text: "工具结果" }] }) },
      permission: { check: async (req) => (seen("permission.check", [req.category, req.target, req.summary]), { scope: "unrestricted" }) },
      interaction: {
        dialog: async (call) => (seen("interaction.dialog", call.request.kind), { cancelled: false, value: true }),
        dismiss: (call) => seen("interaction.dismiss", call.requestId),
        show: (call) => seen("interaction.show", call.notice),
      },
      steer: { take: async () => (seen("steer.take", null), ["补发"]) },
      turn: { request: (req) => seen("turn.request", req.requestId) },
      models: {
        credential: async (req) => (seen("models.credential", req.providerId), { access: "令牌" }),
        log: (_turn, record) => seen("models.log", record.url),
      },
      report: (report) => seen("report", report.code),
    };
    const protocolErrors: string[] = [];
    const proc = await launchEngineHost({
      host: recording,
      proxyConfig: manual(proxyA.url),
      onAppError: () => undefined,
      onProtocolError: (reason) => void protocolErrors.push(reason),
      env: env(join(scratch, "contract")),
      spawnHost: (options) => Bun.spawn([process.execPath, fakeHost, "contract"], options),
    });
    const { driver } = proc;
    expect(driver.capabilities).toMatchObject({ nativeCompaction: true, commands: true, plugins: true });
    const input = { workspace: { cwd: "/w", root: "/w" }, plugins: [], prompt: { text: "", images: [] } } as never;
    const result = await driver.startTurn({ conversationId: "c", turnId: "t1", input });
    expect(JSON.parse(result.text)).toEqual({
      items: 0,
      tool: { content: [{ type: "text", text: "工具结果" }] },
      grant: { scope: "unrestricted" },
      answer: { cancelled: false, value: true },
      steer: ["补发"],
      credential: { access: "令牌" },
      workspace: "/w",
    });
    // 单向通知与请求的回答不保证谁先到;等最后一条通知到了再比
    for (let i = 0; i < 100 && !calls.some((line) => line.startsWith("report ")); i++) await Bun.sleep(10);
    expect(calls.map((line) => line.slice(0, line.indexOf(" "))).sort()).toEqual(
      ["emit", "session.load", "session.append", "tools.call", "permission.check", "interaction.dialog", "interaction.dismiss", "interaction.show", "steer.take", "turn.request", "models.credential", "models.log", "report"].sort(),
    );
    expect(calls).toContain(`permission.check ${JSON.stringify(["write", { path: "/w/a.txt" }, "a.txt"])}`);
    expect(calls).toContain(`models.log "http://model.invalid/v1"`);

    expect((await driver.compact!({ conversationId: "c", turnId: "t2", customInstructions: "只留结论" } as never)).summary).toBe("摘要:只留结论");
    expect(await driver.listCommands!({ conversationId: "c", plugins: [], workspace: null })).toEqual([{ id: "c1", name: "hello", source: "engine", description: "会话 c" }]);
    expect((await driver.runCommand!({ conversationId: "c", turnId: "t3", input, commandId: "c1", args: "世界" })).compactions[0]!.summary).toBe("指令 c1 世界");
    expect((await driver.inspectPlugin!({ plugin: { id: "dev:x", path: "/p" } })).tools).toEqual([{ name: "dev:x-tool" }]);
    await driver.abort("c", "user");
    await driver.invalidate("c");
    await driver.dispose();
    expect(protocolErrors).toEqual([]);
    await proc.stop();
    expect((await proc.exited).exitCode).toBe(0);
  }, 30_000);
});
