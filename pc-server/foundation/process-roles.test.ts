// foundation/process-roles.test.ts — 进程角色表、唯一的启动自己、入口分流(P7.2.1,方案 §5.14.3)
// 锁定:①角色判定(含插件把本程序当 pi 命令行再启动、未知角色);②子进程角色先于数据目录锁分流——锁被占着,
// 文档提取与引擎宿主照常起来(实跑子进程);③入口与角色表不静态引用别的模块,子角色的导入闭包不含应用状态;
// ④别处不拿本程序的路径启动进程。
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { closureHitsUnder, runtimeImportClosure, staticRuntimeSpecifiers } from "../test-utils/import-closure";
import { PI_CLI_RELAUNCH_MESSAGE, resolveProcessLaunch, spawnSelf, unknownRoleMessage } from "./process-roles";

const serverRoot = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "rkh-process-roles-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("角色判定", () => {
  test("角色参数紧跟入口;没有就是主程序", () => {
    expect(resolveProcessLaunch(["bun", "server.ts", "--rikkahub-role=extract-worker"], {})).toEqual({ kind: "role", role: "extract-worker" });
    expect(resolveProcessLaunch(["bun", "B:/~BUN/root/rikkahub-pc.exe", "--rikkahub-role=engine-host"], {})).toEqual({ kind: "role", role: "engine-host" });
    expect(resolveProcessLaunch(["rikkahub-pc.exe"], {})).toEqual({ kind: "role", role: "server" });
    expect(resolveProcessLaunch(["bun", "server.ts", "--port", "17455", "--ui-shell", "--no-open"], {})).toEqual({ kind: "role", role: "server" });
    expect(resolveProcessLaunch(["bun", "server.ts", "--dev", "--rikkahub-role=engine-host"], {})).toEqual({ kind: "role", role: "server" });
  });

  test("不认识的角色单独报出来(运行期间程序文件被换成了别的版本)", () => {
    expect(resolveProcessLaunch(["bun", "server.ts", "--rikkahub-role=dsh-host"], {})).toEqual({ kind: "unknown-role", value: "dsh-host" });
    expect(unknownRoleMessage("dsh-host")).toContain("重启应用");
  });

  test("插件把本程序当 pi 命令行再启动:后台运行器的环境变量或 pi 命令行参数;照抄了角色参数也认出", () => {
    expect(resolveProcessLaunch(["rikkahub-pc.exe"], { PI_SUBAGENT_RUNNER_CONFIG: "C:\\tmp\\cfg.json" })).toEqual({ kind: "pi-cli-relaunch" });
    expect(resolveProcessLaunch(["rikkahub-pc.exe", "--no-session", "--mode", "rpc", "--extension", "x.js"], {})).toEqual({ kind: "pi-cli-relaunch" });
    expect(resolveProcessLaunch(["rikkahub-pc.exe", "--mode=json"], {})).toEqual({ kind: "pi-cli-relaunch" });
    expect(resolveProcessLaunch(["bun", "server.ts", "--rikkahub-role=engine-host"], { PI_SUBAGENT_RUNNER_CONFIG: "/tmp/cfg.json" })).toEqual({ kind: "pi-cli-relaunch" });
    expect(resolveProcessLaunch(["bun", "server.ts", "--rikkahub-role=engine-host", "--mode", "json"], {})).toEqual({ kind: "pi-cli-relaunch" });
  });
});

/** 一个被主程序锁住的数据目录(锁的持有者是本测试进程,活着)。 */
function lockedDataDir(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pc-server.lock"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  return dir;
}

describe("子进程角色(实跑,数据目录锁被占着)", () => {
  test("文档提取:spawnSelf 起来、写出旁车、以 0 退出;不碰锁,也不留启动黑匣子", async () => {
    const dataDir = lockedDataDir("extract");
    const source = join(scratch, "note.md");
    writeFileSync(source, "# 提取测试\n角色分流先于数据目录锁。\n");
    const child = spawnSelf("extract-worker", {
      env: { ...process.env, RIKKAHUB_PC_DATA_DIR: dataDir, RIKKAHUB_EXTRACT_FILE_ID: "42", RIKKAHUB_EXTRACT_PATH: source, RIKKAHUB_EXTRACT_NAME: "note.md", RIKKAHUB_EXTRACT_MIME: "text/markdown" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("EXTRACT_RESULT ok");
    expect(readFileSync(join(dataDir, "files", "42.extracted.txt"), "utf8")).toContain("角色分流先于数据目录锁");
    expect(JSON.parse(readFileSync(join(dataDir, "pc-server.lock"), "utf8")).pid).toBe(process.pid);
    expect(existsSync(join(dataDir, "logs"))).toBe(false);
  }, 30_000);

  test("文档提取的任务参数不对:以 1 退出", async () => {
    const child = spawnSelf("extract-worker", {
      env: { ...process.env, RIKKAHUB_PC_DATA_DIR: lockedDataDir("extract-bad"), RIKKAHUB_EXTRACT_FILE_ID: "x", RIKKAHUB_EXTRACT_PATH: "" },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
  }, 30_000);

  test("引擎宿主:spawnSelf 起来、在 stdout 发出 engine.ready;关掉 stdin 即以 0 退出", async () => {
    const child = spawnSelf("engine-host", { env: { ...process.env, RIKKAHUB_PC_DATA_DIR: lockedDataDir("host") }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("\n")) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    reader.releaseLock();
    const ready = JSON.parse(text.slice(0, text.indexOf("\n"))) as { method: string; params: unknown[] };
    expect(ready.method).toBe("engine.ready");
    expect(ready.params[0]).toBe("pi");
    child.stdin.end();
    expect(await child.exited).toBe(0);
  }, 30_000);
});

describe("入口(实跑 server.ts)", () => {
  const entry = join(serverRoot, "server.ts");
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const proc = Bun.spawn([process.execPath, entry, ...args], { env: { ...process.env, RIKKAHUB_PC_DATA_DIR: join(scratch, "entry"), ...env }, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { stderr, code };
  };

  test("当作 pi 命令行启动:报错、退出码 2、不建数据目录", async () => {
    const result = await run(["--mode", "json", "--no-session"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(PI_CLI_RELAUNCH_MESSAGE);
    expect(existsSync(join(scratch, "entry"))).toBe(false);
  }, 30_000);

  test("未知角色:报错、退出码 2", async () => {
    const result = await run(["--rikkahub-role=nope"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(unknownRoleMessage("nope"));
  }, 30_000);
});

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!["node_modules", "scripts", "test-utils", "pc-data"].includes(name)) out.push(...productionFiles(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}
const rel = (file: string) => relative(serverRoot, file).replaceAll("\\", "/");

describe("源码扫描", () => {
  test("入口只静态引用角色表,角色表不引用任何本地模块;入口动态加载的正是各角色的主体", () => {
    const entrySource = readFileSync(join(serverRoot, "server.ts"), "utf8");
    expect(staticRuntimeSpecifiers(entrySource)).toEqual(["./foundation/process-roles"]);
    expect(staticRuntimeSpecifiers(readFileSync(join(import.meta.dir, "process-roles.ts"), "utf8"))).toEqual([]);
    const dynamic = [...entrySource.matchAll(/\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']/g)].map((m) => m[1]);
    expect(dynamic.sort()).toEqual(["./files/extraction", "./observability/app-errors", "./pi-engine/host-process", "./server-main"]);
  });

  test("Windows 编译带 --splitting:不分块时全部代码打成一块,子进程起步也要解析整个程序", () => {
    const scripts = (JSON.parse(readFileSync(join(serverRoot, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts.compile).toMatch(/bun build --compile --splitting --target=bun-windows-x64 server\.ts/);
  });

  test("子角色的导入闭包不含应用状态(persistence / conversations / api)与主程序;文档提取也不含 pi", () => {
    const appState = ["persistence", "conversations", "api"].map((dir) => join(serverRoot, dir));
    const serverMain = join(serverRoot, "server-main.ts");
    const piRoots = [join(serverRoot, "pi-engine"), resolve(serverRoot, "..", "pi")];
    const extract = runtimeImportClosure([join(serverRoot, "files", "extraction.ts"), join(serverRoot, "observability", "app-errors.ts")]);
    expect(closureHitsUnder(extract, [...appState, serverMain, ...piRoots], serverRoot)).toEqual([]);
    const host = runtimeImportClosure([join(serverRoot, "pi-engine", "host-process.ts")], [resolve(serverRoot, "..", "pi")]);
    expect(closureHitsUnder(host, [...appState, serverMain], serverRoot)).toEqual([]);
  });

  test("引用 process.execPath 的只有登记的几处;启动本程序只经 spawnSelf", () => {
    const allowed: Record<string, string> = {
      "foundation/process-roles.ts": "spawnSelf",
      "engines/plugin-installer.ts": "把 exe 当 bun 用来装包(BUN_BE_BUN),不是进程角色",
      "foundation/paths.ts": "exe 所在目录(随包资源)",
      "api/handlers/update.ts": "Linux 原地更新时替换的目标文件",
    };
    const users = productionFiles(serverRoot).filter((file) => /\bprocess\.execPath\b/.test(readFileSync(file, "utf8"))).map(rel).sort();
    expect(users).toEqual(Object.keys(allowed).sort());
    const relaunchers = productionFiles(serverRoot).filter((file) => /process\.argv\.slice\(1\)/.test(readFileSync(file, "utf8"))).map(rel);
    expect(relaunchers).toEqual([]);
  });
});
