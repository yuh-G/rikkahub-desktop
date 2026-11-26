// R1 取证:boot-trace 启动/崩溃黑匣子(行业标准"残留即异常退出"状态机)。
// 日志问题 2 扩展:pid 活性(多实例不互踩)+ 判读分级(abnormal 报警 / external 静默留档)。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendBootTraceIn,
  beginBootTraceIn,
  capturePreviousBootTraceIn,
  cleanExitIn,
  engineHostTracePathIn,
  readPreviousCrashLogIn,
} from "./boot-trace";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rikka-boot-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 必死 pid:2^30 超出各平台实际 pid 范围,kill(pid,0) 稳定 ESRCH。 */
const DEAD_PID = 1 << 30;
const DEAD_PID_2 = (1 << 30) + 1;

const PENDING = (pid: number) => join(dir, `server.boot.pending.${pid}.log`);
const LEGACY_PENDING = () => join(dir, "server.boot.pending.log");
const LOG = () => join(dir, "server.log");

/** 模拟一次(将亡的)完整会话:启动 → 打里程碑。返回后 pending 在场(会话进行中)。 */
function startSession(milestones: string[], pid: number = DEAD_PID): void {
  capturePreviousBootTraceIn(dir); // 启动最早期:转存上次残留(若有)
  beginBootTraceIn(dir, pid);
  for (const m of milestones) appendBootTraceIn(dir, m, pid);
}

describe("boot-trace 取证黑匣子", () => {
  test("正常路径:启动 → 干净退出 → 不留任何文件", () => {
    startSession(["进程拉起", "已拿数据目录锁", "端口已绑定", "bootstrap 完成"], DEAD_PID);
    expect(existsSync(PENDING(DEAD_PID))).toBe(true); // 会话进行中 pending 在场

    cleanExitIn(dir, DEAD_PID); // 干净退出
    expect(existsSync(PENDING(DEAD_PID))).toBe(false);
    expect(existsSync(LOG())).toBe(false);

    // 下次启动:无残留,capture 不转存
    expect(capturePreviousBootTraceIn(dir)).toBe(false);
    expect(readPreviousCrashLogIn(dir)).toBeNull();
  });

  test("启动期崩溃(issue1):pending 残留 → 转存判读区间,等级 abnormal(错误中心报警)", () => {
    // 上一次:只走到"已拿数据目录锁",随后进程蒸发(没 cleanExitIn)
    startSession(["进程拉起", "已拿数据目录锁"]);

    expect(capturePreviousBootTraceIn(dir)).toBe(true);
    expect(existsSync(PENDING(DEAD_PID))).toBe(false); // 旧 pending 已转存清除
    const log = readPreviousCrashLogIn(dir);
    expect(log).not.toBeNull();
    expect(log!.content).toContain("已拿数据目录锁");
    expect(log!.content).toContain("最后完成「已拿数据目录锁」");
    expect(log!.level).toBe("abnormal");
  });

  test("日志问题 2 核心:运行中被外力终止(关机/强退)→ 留档但等级 external(不再误报警)", () => {
    // 上一次:里程碑全部完成、运行期无异常记录,随后关机硬杀
    startSession(["进程拉起", "已拿数据目录锁", "端口已绑定", "bootstrap 完成"]);

    expect(capturePreviousBootTraceIn(dir)).toBe(true);
    const log = readPreviousCrashLogIn(dir);
    expect(log).not.toBeNull();
    expect(log!.content).toContain("外力终止");
    expect(log!.level).toBe("external"); // server-main.ts 据此静默:托盘用户"点X→关机"不再被骚扰
  });

  test("运行期记录到异常(uncaughtException)→ 即使里程碑全完成也是 abnormal", () => {
    startSession(["进程拉起", "已拿数据目录锁", "端口已绑定", "bootstrap 完成"]);
    appendBootTraceIn(dir, "uncaughtException: TypeError: x is not a function", DEAD_PID);

    expect(capturePreviousBootTraceIn(dir)).toBe(true);
    const log = readPreviousCrashLogIn(dir);
    expect(log!.level).toBe("abnormal");
    expect(log!.content).toContain("uncaughtException");
  });

  test("pid 活性(多实例):仍存活实例的 pending 绝不转存,只收尸体", () => {
    // 邻居实例(本测试进程自己,必活)+ 一具真尸体
    beginBootTraceIn(dir, process.pid);
    appendBootTraceIn(dir, "进程拉起", process.pid);
    startSessionCorpse();

    expect(capturePreviousBootTraceIn(dir)).toBe(true);
    expect(existsSync(PENDING(process.pid))).toBe(true); // 活实例的 pending 原封不动
    expect(existsSync(PENDING(DEAD_PID))).toBe(false); // 尸体被转存
    const log = readPreviousCrashLogIn(dir)!;
    expect(log.content).toContain("端口已绑定");

    function startSessionCorpse(): void {
      beginBootTraceIn(dir, DEAD_PID);
      for (const m of ["进程拉起", "已拿数据目录锁", "端口已绑定"]) appendBootTraceIn(dir, m, DEAD_PID);
    }
  });

  test("引擎宿主进程的黑匣子另用前缀:主程序启动时的转存与干净退出都不碰它(归监管器按 pid 读)", () => {
    beginBootTraceIn(dir, DEAD_PID, "engine-host.pending");
    appendBootTraceIn(dir, "已连上通道", DEAD_PID, "engine-host.pending");
    expect(existsSync(engineHostTracePathIn(dir, DEAD_PID))).toBe(true);
    expect(capturePreviousBootTraceIn(dir)).toBe(false);
    cleanExitIn(dir, DEAD_PID);
    expect(existsSync(engineHostTracePathIn(dir, DEAD_PID))).toBe(true);
    expect(existsSync(LOG())).toBe(false);
  });

  test("多尸体合并转存:等级取最重(任一 abnormal 即 abnormal)", () => {
    // 尸体1:外力终止(external);尸体2:启动期夭折(abnormal)
    beginBootTraceIn(dir, DEAD_PID);
    for (const m of ["进程拉起", "已拿数据目录锁", "端口已绑定", "bootstrap 完成"]) appendBootTraceIn(dir, m, DEAD_PID);
    beginBootTraceIn(dir, DEAD_PID_2);
    appendBootTraceIn(dir, "进程拉起", DEAD_PID_2);
    // 保证 mtime 有序性可控(排序仅影响拼接顺序,不影响等级)
    utimesSync(PENDING(DEAD_PID), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

    expect(capturePreviousBootTraceIn(dir)).toBe(true);
    const log = readPreviousCrashLogIn(dir)!;
    expect(log.level).toBe("abnormal");
    expect(log.content).toContain("---"); // 两段合并分隔
    expect(existsSync(PENDING(DEAD_PID))).toBe(false);
    expect(existsSync(PENDING(DEAD_PID_2))).toBe(false);
  });

  test("升级兼容:旧版固定名 pending(无 pid)被当尸体收编转存", () => {
    writeFileSync(
      LEGACY_PENDING(),
      "# Rikkahub 运行取证\npid: 12345\n\n里程碑:\n  [2026-01-01T00:00:00.000Z] 进程拉起\n",
      "utf8",
    );
    expect(capturePreviousBootTraceIn(dir)).toBe(true);
    expect(existsSync(LEGACY_PENDING())).toBe(false);
    expect(readPreviousCrashLogIn(dir)!.level).toBe("abnormal"); // 只走到"进程拉起"
  });

  test("关键 corner:直接关机 → server.log 短暂残留;下次正常启动+正常退出 → 日志归零", () => {
    startSession(["进程拉起", "已拿数据目录锁", "端口已绑定", "bootstrap 完成"]);
    // (关机 = 进程蒸发,没 cleanExitIn)

    expect(capturePreviousBootTraceIn(dir)).toBe(true);
    expect(readPreviousCrashLogIn(dir)).not.toBeNull();

    // 本次正常跑、正常退出
    beginBootTraceIn(dir, DEAD_PID_2);
    appendBootTraceIn(dir, "进程拉起", DEAD_PID_2);
    cleanExitIn(dir, DEAD_PID_2); // 干净退出连带清掉 server.log
    expect(existsSync(PENDING(DEAD_PID_2))).toBe(false);
    expect(existsSync(LOG())).toBe(false); // 档案归零

    expect(capturePreviousBootTraceIn(dir)).toBe(false);
    expect(readPreviousCrashLogIn(dir)).toBeNull();
  });

  test("旧版 server.log(无等级行)按 abnormal 保守处理", () => {
    writeFileSync(LOG(), "老版本转存的遗言,没有等级标记\n", "utf8");
    expect(readPreviousCrashLogIn(dir)!.level).toBe("abnormal");
  });

  test("极早期崩溃:pending 无任何里程碑 → 判读为“进程拉起之前”,abnormal", () => {
    beginBootTraceIn(dir, DEAD_PID); // 只写了头
    expect(capturePreviousBootTraceIn(dir)).toBe(true);
    const log = readPreviousCrashLogIn(dir)!;
    expect(log.content).toContain("进程拉起”之前");
    expect(log.level).toBe("abnormal");
  });

  test("幂等与边界:重复 cleanExit / 从未 begin 的 capture 都不报错", () => {
    cleanExitIn(dir, DEAD_PID);
    cleanExitIn(dir, DEAD_PID);
    expect(capturePreviousBootTraceIn(dir)).toBe(false);
    expect(readPreviousCrashLogIn(dir)).toBeNull();
  });

  test("隐私边界:日志只含里程碑/进程元信息,不含会话内容/密钥字段", () => {
    startSession(["进程拉起", "端口已绑定"]);
    capturePreviousBootTraceIn(dir);
    const log = readPreviousCrashLogIn(dir)!;
    expect(log.content).not.toMatch(/apiKey|api_key|messages|conversation|prompt/i);
  });
});
