// subprocess-engine/process-info.test.ts — 按 pid 查进程身份、连同后代一起杀(P7.2.3;三个平台各一种查法,CI 上跑 Linux)
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";

import { killProcessAndDescendants, listDescendantPids, processIdentities } from "./process-info";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

async function until(check: () => boolean, ms = 5_000) {
  const startedAt = performance.now();
  while (!check() && performance.now() - startedAt < ms) await Bun.sleep(50);
  return check();
}

describe("进程身份", () => {
  test("查到命令行(带启动参数)与启动时刻;不在的 pid 不出现在结果里", async () => {
    const before = Date.now();
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)", "--rikkahub-role=probe-marker"], { stdout: "ignore", stderr: "ignore" });
    try {
      await Bun.sleep(200);
      const identities = await processIdentities([child.pid, 999_999_999]);
      const identity = identities.get(child.pid);
      expect(identity?.commandLine).toContain("--rikkahub-role=probe-marker");
      expect(Math.abs((identity?.startedAt ?? 0) - before)).toBeLessThan(5_000);
      expect(identity?.parentPid).toBe(process.pid);
      expect(identities.has(999_999_999)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  }, 20_000);

  test("连同后代一起杀:子进程起的另一个进程组里的孙进程也结束", async () => {
    // 孙进程以 detached 起(自成进程组,与工作区命令行同样的起法),pid 经 stdout 交回来
    const middle = `
      const { spawn } = require("node:child_process");
      const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: "ignore", windowsHide: true });
      console.log(c.pid);
      setInterval(() => {}, 1000);`;
    const parent = spawn(process.execPath, ["-e", middle], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const grandchild = await new Promise<number>((done) => parent.stdout.once("data", (chunk: Buffer) => done(Number(chunk.toString().trim()))));
    try {
      if (process.platform !== "win32") expect(listDescendantPids(parent.pid!)).toContain(grandchild);
      killProcessAndDescendants(parent.pid!);
      expect(await until(() => !alive(parent.pid!) && !alive(grandchild))).toBe(true);
    } finally {
      for (const pid of [parent.pid!, grandchild]) if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  }, 20_000);
});
