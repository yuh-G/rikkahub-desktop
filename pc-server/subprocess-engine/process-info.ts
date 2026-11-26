// subprocess-engine/process-info.ts — 按 pid 查别的进程:命令行与启动时刻、后代进程、连同后代一起杀(P7.2.3,方案 §5.14.7)
//
// 监管器两处要用:①主程序启动时清扫上次留下的宿主进程,要先认准「这个 pid 还是那个宿主进程」(pid 会被系统复用);
// ②卡死时强杀宿主进程,它起的命令行要一起结束。Windows 上非 detached 启动的子进程在「关闭即杀」的作业对象里,杀掉
// 宿主进程它起的命令行随之结束(P7.1 X7 实测);Linux / mac 没有这层,而工作区命令行以独立进程组启动(便于按组杀),
// 宿主进程没了它们会留下,所以先列出后代再逐个按组杀。
// 各平台的查法:Windows 用 PowerShell 查 Win32_Process(约 0.5 s,只在清扫时、有残留记录才查);Linux 读 /proc
// (容器镜像里没有 ps);mac 用 ps。

import { readdirSync, readFileSync } from "node:fs";
import { killProcessTree } from "../workspace/tools/shell";

export interface ProcessIdentity {
  commandLine: string;
  /** 进程的启动时刻(毫秒时间戳);查不到为 null。 */
  startedAt: number | null;
  parentPid: number | null;
}

/** Linux /proc/<pid>/stat:进程名在括号里、可能含空格,字段从最后一个右括号之后数。 */
function parseProcStat(text: string): { ppid: number; startTicks: number } | null {
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(fields[1]);
  const startTicks = Number(fields[19]);
  return Number.isFinite(ppid) && Number.isFinite(startTicks) ? { ppid, startTicks } : null;
}

function linuxBootTimeMs(): number | null {
  const match = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"));
  return match ? Number(match[1]) * 1000 : null;
}

/** 时钟节拍按 100 Hz(Linux 各主流架构的用户态 CLK_TCK)。 */
const LINUX_TICKS_PER_SECOND = 100;

function linuxIdentity(pid: number, bootMs: number | null): ProcessIdentity | null {
  try {
    const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
    const commandLine = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
    return {
      commandLine,
      startedAt: stat && bootMs !== null ? bootMs + (stat.startTicks * 1000) / LINUX_TICKS_PER_SECOND : null,
      parentPid: stat?.ppid ?? null,
    };
  } catch {
    // 进程已不在(读到一半退出也算)
    return null;
  }
}

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", windowsHide: true });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out;
}

async function windowsIdentities(pids: number[]): Promise<Map<number, ProcessIdentity>> {
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(" OR ");
  const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; @(Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { @{ pid = $_.ProcessId; ppid = $_.ParentProcessId; cmd = $_.CommandLine; start = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } }) | ConvertTo-Json -Compress`;
  const out = (await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script])).trim();
  const result = new Map<number, ProcessIdentity>();
  if (!out) return result;
  const rows = JSON.parse(out) as { pid: number; ppid: number; cmd: string | null; start: number }[] | { pid: number; ppid: number; cmd: string | null; start: number };
  for (const row of Array.isArray(rows) ? rows : [rows]) result.set(row.pid, { commandLine: row.cmd ?? "", startedAt: row.start, parentPid: row.ppid });
  return result;
}

async function macIdentities(pids: number[]): Promise<Map<number, ProcessIdentity>> {
  const out = await run(["ps", "-o", "pid=,ppid=,lstart=,command=", "-p", pids.join(",")]);
  const result = new Map<number, ProcessIdentity>();
  for (const line of out.split("\n")) {
    // lstart 是定宽的五段:「Thu Nov 20 10:00:00 2026」
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+ \S+\s+\d+ \S+ \d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const startedAt = Date.parse(match[3]!);
    result.set(Number(match[1]), { commandLine: match[4]!, startedAt: Number.isFinite(startedAt) ? startedAt : null, parentPid: Number(match[2]) });
  }
  return result;
}

/** 查一批进程的命令行与启动时刻;不在的进程不出现在结果里。 */
export async function processIdentities(pids: number[]): Promise<Map<number, ProcessIdentity>> {
  if (pids.length === 0) return new Map();
  if (process.platform === "win32") return windowsIdentities(pids);
  if (process.platform === "darwin") return macIdentities(pids);
  const bootMs = linuxBootTimeMs();
  const result = new Map<number, ProcessIdentity>();
  for (const pid of pids) {
    const identity = linuxIdentity(pid, bootMs);
    if (identity) result.set(pid, identity);
  }
  return result;
}

/** 列出 pid 的全部后代(Linux / mac;Windows 不需要,返回空)。 */
export function listDescendantPids(pid: number): number[] {
  if (process.platform === "win32") return [];
  const parentOf = new Map<number, number>();
  if (process.platform === "darwin") {
    const out = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
    for (const line of out.split("\n")) {
      const [child, parent] = line.trim().split(/\s+/).map(Number);
      if (child && parent !== undefined) parentOf.set(child, parent);
    }
  } else {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = parseProcStat(readFileSync(`/proc/${name}/stat`, "utf8"));
        if (stat) parentOf.set(Number(name), stat.ppid);
      } catch {
        // 列目录与读文件之间进程退出了
      }
    }
  }
  const out: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const [child, ppid] of parentOf) {
      if (ppid === parent && !out.includes(child)) {
        out.push(child);
        queue.push(child);
      }
    }
  }
  return out;
}

/** 杀掉进程连同它的后代。Windows 用 taskkill /T;其余平台先列后代(父进程一死它们就改挂别处、查不到了),再逐个按组杀。 */
export function killProcessAndDescendants(pid: number): void {
  if (process.platform === "win32") {
    killProcessTree(pid);
    return;
  }
  const descendants = listDescendantPids(pid);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 已经退出
  }
  for (const child of descendants) killProcessTree(child);
}
