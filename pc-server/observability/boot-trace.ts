// observability/boot-trace.ts — 启动/崩溃取证黑匣子(R1 取证:issue 后端无声退出)。
//
// 设计哲学(产品纪律):日志不是流水账,是"出事时才存在的黑匣子"。全程不打扰用户——
// 没有"上次异常退出"警告;一切靠文件生灭表达,用户只有真碰上崩溃、主动去翻 logs/
// 或在错误中心看到那条 warn 时才会发现它。
//
// 状态机(与用户对齐,Firefox sessionstore / Chrome exit_type 同款"残留即异常"):
//   - pending 全程存在:应用一启用就诞生,标记本次会话 + 逐条里程碑。文件名带 pid
//     (server.boot.pending.{pid}.log):多实例(dev 与壳并跑)各写各的互不覆盖,pid 即
//     活性判据——扫描时该 pid 仍存活的 pending 是"邻居"不是"尸体",绝不误转存
//     (日志问题 2 修复之一:此前固定文件名,第二实例会把第一实例的活 pending 当崩溃报警)。
//   - 干净退出(SIGINT/SIGTERM/SIGHUP/shutdown 端点):删 pending + 删上次可能残留的
//     server.log —— "下次正常启动、正常退出,则日志被清除"。
//   - pending 残留到下次启动 = 上次非正常退出:转存成 server.log(遗言),附判读与等级:
//       abnormal — 里程碑没走完,或运行期记录过 uncaughtException/unhandledRejection/
//                  startupFatal:真故障,错误中心报 warn。
//       external — 里程碑全部完成且无异常记录:运行中被外力终止(直接关机/强制退出/
//                  任务管理器),对用户是正常操作,只留档不上报(日志问题 2 核心:托盘
//                  常驻用户"点 X→托盘→关机"是日常,此前每次开机都被误报"未正常退出")。
//   净效果:真崩溃 → server.log 残留且报警;关机/强退 → 留档静默,下次正常退出即清。
//
// 为什么全用同步 IO:段错误/强杀让进程瞬间蒸发,异步写会丢;同步写在每一步落盘后才往下走,
// 哪怕下一步就崩,文件里已留下"死前走到的最后一步"。只写几行,开销可忽略。
//
// 隐私边界:只写进程/版本/里程碑/错误摘要,绝不写会话内容、API key、消息文本。
//
// 可测性:核心是 *In(logsDir) 注入目录版(与 instance-lock 同构),生产路径用全局 logsDir
// 的薄包装;单测注入 mkdtemp 目录,不碰真实数据目录。

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { logsDir } from "../foundation/paths";

const PENDING_PREFIX = "server.boot.pending";
/** 旧版本的固定文件名(无 pid)。升级兼容:扫描时一并收编,无法判活一律视为尸体。 */
const LEGACY_PENDING_NAME = "server.boot.pending.log";
const LOG_NAME = "server.log";

/** 判读等级(机器可读,写入 server.log 供下次启动分流):
 *  abnormal=真故障报警;external=外力终止(关机/强退)留档静默。 */
export type CrashVerdictLevel = "abnormal" | "external";
const VERDICT_LEVEL_MARK = "# verdict-level:";

/** 启动里程碑序列(固定顺序)。判读时找"已成功完成的最后一项",死时它停在崩溃区间下沿。 */
const MILESTONES = [
  "进程拉起",
  "已拿数据目录锁",
  "端口已绑定",
  "bootstrap 完成",
] as const;
export type BootMilestone = (typeof MILESTONES)[number];

function isoNow(): string {
  return new Date().toISOString();
}

function pendingPathIn(dir: string, pid: number, prefix = PENDING_PREFIX): string {
  return join(dir, `${prefix}.${pid}.log`);
}

function logPathIn(dir: string): string {
  return join(dir, LOG_NAME);
}

/** pid 活性探测(signal 0 不发信号只查存在;EPERM=存在但无权限,也算活)。 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

/** 列出目录里的全部尸体 pending(排除仍存活实例的),按 mtime 升序。 */
function deadPendingFilesIn(dir: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => f.startsWith(PENDING_PREFIX) && f.endsWith(".log"));
  } catch {
    return [];
  }
  const dead: string[] = [];
  for (const name of names) {
    const match = name.match(/^server\.boot\.pending\.(\d+)\.log$/);
    if (match && isPidAlive(Number(match[1]))) continue; // 邻居实例活着:不是尸体
    dead.push(name); // 含旧固定名(无 pid 无从判活,视为尸体——升级后首启一次性收编)
  }
  return dead.sort((a, b) => {
    try {
      return statSync(join(dir, a)).mtimeMs - statSync(join(dir, b)).mtimeMs;
    } catch {
      return 0;
    }
  });
}

function header(): string {
  return (
    [
      `# Rikkahub 运行取证 —— 本文件在应用正常退出时自动删除;残留即上次未干净退出`,
      `启动时间: ${isoNow()}`,
      `pid: ${process.pid}`,
      `runtime: bun ${process.versions.bun ?? "?"} / ${process.platform} ${process.arch}`,
      ``,
      `里程碑:`,
    ].join("\n") + "\n"
  );
}

// ---------- 注入目录核心(纯函数式,可测) ----------

/** 为一次会话写 pending 头(pid 注入供测试;默认当前进程)。返回是否成功(失败=降级不取证)。 */
export function beginBootTraceIn(dir: string, pid: number = process.pid, prefix = PENDING_PREFIX): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(pendingPathIn(dir, pid, prefix), header(), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 往 pending 追加一行(里程碑 / 兜底异常)。文件不存在时静默跳过(如盘只读)。 */
export function appendBootTraceIn(dir: string, line: string, pid: number = process.pid, prefix = PENDING_PREFIX): void {
  try {
    appendFileSync(pendingPathIn(dir, pid, prefix), `  [${isoNow()}] ${line}\n`, "utf8");
  } catch {
    // 取证是锦上添花:盘写不进绝不反向阻塞启动/退出。
  }
}

/** 一具尸体的判读(文案 + 等级)。等级依据见文件头状态机注释。 */
function verdictOf(body: string): { text: string; level: CrashVerdictLevel } {
  const lastDone = lastReachedMilestone(body);
  const hasException = /\] (uncaughtException|unhandledRejection|startupFatal)[: ]/.test(body);
  if (lastDone === "bootstrap 完成" && !hasException) {
    return {
      level: "external",
      text: "判读: 里程碑全部完成且无异常记录 —— 上次会话在运行中被外力终止(直接关机/强制退出/任务管理器),属正常使用场景,留档不上报。",
    };
  }
  if (lastDone === null) {
    return {
      level: "abnormal",
      text: "判读: 未走到任何里程碑 —— 进程在“进程拉起”之前即被终止(极早期:运行时加载/反病毒拦截)。",
    };
  }
  return {
    level: "abnormal",
    text: `判读: 最后完成「${lastDone}」${hasException ? ",且运行期记录到异常" : ""} —— 上次会话非正常结束(崩溃或强制终止),进程死在这一步与下一步之间。`,
  };
}

/**
 * 上次残留的尸体 pending(未干净退出)→ 转存成 server.log,附判读与机器可读等级行,
 * 随后删除尸体。多具尸体(dev 与壳并跑后双亡,罕见)按时间合并,等级取最重(任一
 * abnormal 即 abnormal)。仍存活实例的 pending 绝不触碰。返回是否发生了转存。
 */
export function capturePreviousBootTraceIn(dir: string): boolean {
  try {
    const dead = deadPendingFilesIn(dir);
    if (!dead.length) return false;
    const sections: string[] = [];
    let worst: CrashVerdictLevel = "external";
    for (const name of dead) {
      let body = "";
      try {
        body = readFileSync(join(dir, name), "utf8");
      } catch {
        body = "# 上次会话的取证文件读取失败(可能已损坏)";
      }
      const verdict = verdictOf(body);
      if (verdict.level === "abnormal") worst = "abnormal";
      sections.push(`${body.trimEnd()}\n\n${verdict.text}`);
      rmSync(join(dir, name), { force: true });
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(logPathIn(dir), `${sections.join("\n\n---\n\n")}\n\n${VERDICT_LEVEL_MARK} ${worst}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

function lastReachedMilestone(pendingBody: string): string | null {
  let found: string | null = null;
  for (const m of MILESTONES) {
    if (pendingBody.includes(`] ${m}`)) found = m;
  }
  return found;
}

export type PreviousCrashLog = { content: string; level: CrashVerdictLevel };

/** 读取上次崩溃转存(server.log);不存在返回 null。level 供启动分流:abnormal 报 warn,
 *  external 静默留档。旧版本文件无等级行 → 按 abnormal(保守,保持旧行为一次)。 */
export function readPreviousCrashLogIn(dir: string): PreviousCrashLog | null {
  try {
    const p = logPathIn(dir);
    if (!existsSync(p)) return null;
    const content = readFileSync(p, "utf8");
    const level: CrashVerdictLevel = content.includes(`${VERDICT_LEVEL_MARK} external`) ? "external" : "abnormal";
    return { content, level };
  } catch {
    return null;
  }
}

/**
 * 干净退出时调用:删本次 pending(+旧版固定名残留) + 删上次的 server.log。
 * 后者即"下次正常退出则日志被清除"——关机/强退留下的档案随本次正常退出归零。
 * 只删自己 pid 的 pending:并跑的邻居实例(dev+壳)各自负责各自的。
 */
export function cleanExitIn(dir: string, pid: number = process.pid): void {
  try {
    rmSync(pendingPathIn(dir, pid), { force: true });
  } catch {
    // 删不掉(占用/权限)无害——下次 capturePrevious 会按尸体转存。
  }
  try {
    rmSync(join(dir, LEGACY_PENDING_NAME), { force: true });
  } catch {
    // 同上。
  }
  try {
    rmSync(logPathIn(dir), { force: true });
  } catch {
    // 同上,无害。
  }
}

// ---------- 引擎宿主进程的黑匣子(P7.2.2,方案 §5.14.5) ----------
// 宿主进程(进程角色 engine-host)写自己的 engine-host.pending.<pid>.log:连上通道、驱动就绪、兜底异常逐行落盘,
// 干净退出删掉。前缀与主程序不同,主程序启动时的转存不碰它;宿主进程退出后由监管器按 pid 读出来归因(P7.2.3)。

const ENGINE_HOST_PENDING_PREFIX = "engine-host.pending";

export function engineHostTracePathIn(dir: string, pid: number): string {
  return pendingPathIn(dir, pid, ENGINE_HOST_PENDING_PREFIX);
}

// ---------- 生产路径薄包装(全局 logsDir) ----------

/** 本进程正在写的 pending 前缀;null = 没开(或已干净退出)。 */
let activePrefix: string | null = null;

/** 启动最早期调用:先转存上次崩溃残留(若有),再为本次开 pending。 */
export function bootTraceStartup(): void {
  capturePreviousBootTraceIn(logsDir);
  activePrefix = beginBootTraceIn(logsDir) ? PENDING_PREFIX : null;
}

/** 宿主进程启动最早期调用。不转存任何东西(主程序的残留归主程序)。 */
export function engineHostTraceStartup(): void {
  activePrefix = beginBootTraceIn(logsDir, process.pid, ENGINE_HOST_PENDING_PREFIX) ? ENGINE_HOST_PENDING_PREFIX : null;
}

export function bootMilestone(milestone: BootMilestone, extra?: string): void {
  if (activePrefix !== PENDING_PREFIX) return;
  appendBootTraceIn(logsDir, `${milestone}${extra ? ` — ${extra}` : ""}`);
}

export function engineHostMilestone(step: string): void {
  if (activePrefix !== ENGINE_HOST_PENDING_PREFIX) return;
  appendBootTraceIn(logsDir, step, process.pid, ENGINE_HOST_PENDING_PREFIX);
}

/** 记录一条 JS 兜底异常(uncaughtException/unhandledRejection),stack 一并留证。 */
export function bootNote(kind: string, detail: string): void {
  if (!activePrefix) return;
  appendBootTraceIn(logsDir, `${kind}: ${detail}`, process.pid, activePrefix);
}

/** 干净退出时调用:主程序删 pending + 删上次残留的 server.log(假报警归零);宿主进程只删自己的 pending。幂等。 */
export function bootCleanExit(): void {
  const prefix = activePrefix;
  activePrefix = null;
  if (prefix === ENGINE_HOST_PENDING_PREFIX) {
    try {
      rmSync(engineHostTracePathIn(logsDir, process.pid), { force: true });
    } catch {
      // 删不掉无害:监管器或下次启动清扫时一并处理
    }
    return;
  }
  cleanExitIn(logsDir);
}

/** 错误中心启动时读:上次崩溃转存(不存在=上次干净退出)。level 供报警分流。 */
export function readPreviousCrashLog(): PreviousCrashLog | null {
  return readPreviousCrashLogIn(logsDir);
}
