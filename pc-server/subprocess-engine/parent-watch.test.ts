// subprocess-engine/parent-watch.test.ts — 宿主进程里盯主程序的线程(P7.2.3,方案 §5.14.7「不留孤儿」第一层)
// 判定逻辑用假的探测与结束函数锁;实跑一次 X7 的场景(Linux CI 上同样跑):中间进程以 detached 起一个子进程(脱离 Windows
// 的作业对象,只剩这条线程能救),子进程主线程卡在同步死循环里,结束中间进程后子进程要在几秒内自己没了。
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { watchParent } from "./parent-watch";

const errno = (code: string) => Object.assign(new Error(code), { code });

function drive(outcomes: ("ok" | "ESRCH" | "EPERM")[]) {
  const killed: number[] = [];
  let i = 0;
  const timer = watchParent(
    10,
    20,
    1,
    () => {
      const outcome = outcomes[i++] ?? "ok";
      if (outcome !== "ok") throw errno(outcome);
    },
    (pid) => void killed.push(pid),
  );
  return { killed, timer, probes: () => i };
}

async function untilProbed(state: ReturnType<typeof drive>, count: number) {
  for (let n = 0; n < 200 && state.probes() < count; n++) await Bun.sleep(2);
  clearInterval(state.timer);
}

describe("盯主程序", () => {
  test("主程序在:不结束;主程序没了(ESRCH):下一次探测即结束自己", async () => {
    const alive = drive(["ok", "ok", "ok"]);
    await untilProbed(alive, 3);
    expect(alive.killed).toEqual([]);
    const gone = drive(["ok", "ESRCH"]);
    await untilProbed(gone, 2);
    expect(gone.killed).toEqual([20]);
  });

  test("EPERM 连续 3 次才算没了;中间探到一次在就重新数", async () => {
    const flaky = drive(["EPERM", "EPERM", "ok", "EPERM", "EPERM", "ok"]);
    await untilProbed(flaky, 6);
    expect(flaky.killed).toEqual([]);
    const denied = drive(["EPERM", "EPERM", "EPERM"]);
    await untilProbed(denied, 3);
    expect(denied.killed).toEqual([20]);
  });
});

const scratch = mkdtempSync(join(tmpdir(), "rkh-parent-watch-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

describe("实跑:主线程卡死时主程序被结束", () => {
  test("子进程在几秒内自己结束", async () => {
    const ready = join(scratch, "ready");
    const child = resolve(import.meta.dir, "..", "test-utils", "parent-watch-child.ts");
    const middle = `
      const { spawn } = require("node:child_process");
      const c = spawn(process.execPath, [${JSON.stringify(child)}, String(process.pid), ${JSON.stringify(ready)}], { detached: true, stdio: "ignore", windowsHide: true });
      c.unref();
      setInterval(() => {}, 1000);`;
    const parent = Bun.spawn([process.execPath, "-e", middle], { stdout: "ignore", stderr: "inherit" });
    let childPid = 0;
    try {
      for (let n = 0; n < 200 && !existsSync(ready); n++) await Bun.sleep(50);
      childPid = Number(readFileSync(ready, "utf8"));
      expect(childPid).toBeGreaterThan(0);
      // 父进程还在时不误杀
      await Bun.sleep(500);
      expect(alive(childPid)).toBe(true);
      parent.kill("SIGKILL");
      await parent.exited;
      const startedAt = performance.now();
      while (alive(childPid) && performance.now() - startedAt < 5_000) await Bun.sleep(50);
      expect(alive(childPid)).toBe(false);
    } finally {
      parent.kill("SIGKILL");
      if (childPid && alive(childPid)) process.kill(childPid, "SIGKILL");
    }
  }, 20_000);
});
