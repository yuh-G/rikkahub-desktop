// subprocess-engine/process.ts — 子进程引擎的 spawn 生命周期管理(T4 骨架)。
//
// 职责:把"拉起一个引擎子进程并管住它的生死"收敛成一处。各子进程引擎(dsh/codex/
// claude-code)只给 cmd/args/cwd,其余(启动失败归因、stderr 摘录、退出分类、取消杀树)
// 全在这里统一,不在每个 adapter 里重写一遍。
//
// 关键决策:
//  - 用 node:child_process.spawn 而非 Bun.spawn:需要 detached 进程组 + 跨平台杀树
//    (killProcessTree 复用 workspace/tools/shell.ts 的成熟实现——Windows taskkill /T,
//    POSIX 负 pid 杀进程组),这是 Bun.spawn 目前给不了的。
//  - stderr 全程摘录成尾部缓冲(默认留最后几 KB),供崩溃时归因展示;不管 stdout——
//    stdout 是协议帧通道,经 protocol.ts 的行切分器另走,与本模块解耦(本模块只管生死)。
//  - 取消 = 杀进程树(用户中止/超时),不是发 SIGINT 等它礼貌退出——引擎可能卡在工具里,
//    礼貌退出不可依赖。取消语义经 AbortSignal 传入,与 pi 引擎 runner 的 signal 契约对齐。

import { spawn } from "node:child_process";
import { killProcessTree } from "../workspace/tools/shell";
import { classifyExit, classifySpawnError, describeExit, type SubprocessExitInfo } from "./errors";

/** stderr 摘录缓冲上限(字节)。只留尾部,防长日志撑内存。 */
const STDERR_TAIL_BYTES = 8 << 10; // 8 KiB

export interface SpawnSubprocessOptions {
  /** 可执行命令(如 "dsh" / "codex")。ENOENT 时归类 spawn_not_found。 */
  cmd: string;
  args?: string[];
  /** 工作目录(引擎在其内解析相对路径/配置)。 */
  cwd?: string;
  /** 追加环境变量(与 process.env 合并)。 */
  env?: Record<string, string>;
  /** 取消信号:abort 即杀进程树。 */
  signal?: AbortSignal;
  /** 引擎显示名(错误归因文案用)。 */
  displayName?: string;
  /** stdout 帧回调:行切分交由调用方接 protocol.createLineFramer。 */
  onStdoutChunk?: (chunk: Uint8Array) => void;
  /** stderr 摘录回调(可选,除尾部缓冲外实时转发,供调试日志)。 */
  onStderrChunk?: (chunk: Uint8Array) => void;
}

export interface SubprocessHandle {
  /** 进程 pid(未成功启动为 undefined)。 */
  readonly pid: number | undefined;
  /** 向 stdin 写一行(自动补 \n)。子进程已死/未启动时静默丢弃(返回 false)。 */
  writeLine(line: string): boolean;
  /** 主动杀进程树(幂等)。标记 cancelled=true,等 exited 结算。 */
  kill(): void;
  /** 进程终局:resolve 退出分类(含 stderr 尾部)。只 resolve 一次。 */
  readonly exited: Promise<SubprocessExitInfo>;
}

/** 只留最后 STDERR_TAIL_BYTES 字节的缓冲(子进程标准错误的尾部,退出归因用)。 */
export function createTailBuffer(): { push(chunk: Uint8Array): void; text(): string } {
  const parts: Buffer[] = [];
  let total = 0;
  return {
    push(chunk: Uint8Array) {
      const buf = Buffer.from(chunk);
      parts.push(buf);
      total += buf.byteLength;
      // 从头部丢到不超限(留尾部)。
      while (total > STDERR_TAIL_BYTES && parts.length > 0) {
        const head = parts[0]!;
        if (total - head.byteLength >= STDERR_TAIL_BYTES) {
          parts.shift();
          total -= head.byteLength;
        } else {
          const overflow = total - STDERR_TAIL_BYTES;
          parts[0] = head.subarray(overflow);
          total -= overflow;
          break;
        }
      }
    },
    text() {
      return Buffer.concat(parts).toString("utf8").trim();
    },
  };
}

/** 拉起子进程并返回句柄。spawn 同步/异步错误(ENOENT/EPERM)不抛——统一经 exited
 *  结算成分类 info,让调用方走单一的"归因→上报→给用户看"路径,不分叉 try/catch。 */
export function spawnSubprocess(options: SpawnSubprocessOptions): SubprocessHandle {
  const { cmd, args = [], cwd, env, signal } = options;
  const stderrTail = createTailBuffer();
  let cancelled = false;
  let killed = false;
  let settled = false;

  let resolveExited!: (info: SubprocessExitInfo) => void;
  const exited = new Promise<SubprocessExitInfo>((resolve) => {
    resolveExited = resolve;
  });
  const settle = (info: SubprocessExitInfo) => {
    if (settled) return;
    settled = true;
    resolveExited(info);
  };

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cmd, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      // detached: POSIX 下让子进程自成进程组,杀树时按组杀(killProcessTree 负 pid);
      // Windows 下 detached 不影响(taskkill /T 按树杀),但保持一致无害。
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    // spawn 同步抛(极少见,通常 error 事件异步来)。归类后立刻结算。
    settle({ kind: classifySpawnError(err), exitCode: null, signal: null, stderrTail: "", cancelled: false });
    return {
      pid: undefined,
      writeLine: () => false,
      kill: () => undefined,
      exited,
    };
  }

  const killInternal = () => {
    if (killed || settled) return;
    killed = true;
    if (child.pid !== undefined) killProcessTree(child.pid);
  };

  const onAbort = () => {
    cancelled = true;
    killInternal();
  };

  // spawn 异步错误(ENOENT/EPERM 走这里)。此时 close 不会再来,直接结算。
  child.once("error", (err) => {
    settle({ kind: classifySpawnError(err), exitCode: null, signal: null, stderrTail: stderrTail.text(), cancelled });
  });

  child.stdout?.on("data", (chunk: Buffer) => options.onStdoutChunk?.(chunk));
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail.push(chunk);
    options.onStderrChunk?.(chunk);
  });

  child.once("close", (exitCode, signalName) => {
    settle(
      classifyExit({
        exitCode,
        signal: (signalName as NodeJS.Signals | null) ?? null,
        cancelled,
        stderrTail: stderrTail.text(),
      }),
    );
  });

  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    // 进程终局后摘掉监听,防 signal 长存泄漏句柄。
    void exited.finally(() => signal.removeEventListener("abort", onAbort));
  }

  return {
    pid: child.pid,
    writeLine(line: string): boolean {
      if (settled || killed || !child.stdin || child.stdin.destroyed) return false;
      try {
        child.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
        return true;
      } catch {
        // stdin 已断(子进程刚死)——静默丢弃,不算故障。
        return false;
      }
    },
    kill: () => {
      cancelled = true;
      killInternal();
    },
    exited,
  };
}

/** 便捷封装:拉起进程跑到底,把终局翻译成一句给用户看的话(错误归因文案)。
 *  只适合"跑一次收集结果"的短任务;长驻流式引擎请用 spawnSubprocess 自持句柄,
 *  在 onStdoutChunk 里接 protocol/bridge。 */
export async function runSubprocessToExit(options: SpawnSubprocessOptions): Promise<{
  info: SubprocessExitInfo;
  message: string;
}> {
  const handle = spawnSubprocess(options);
  const info = await handle.exited;
  return { info, message: describeExit(info, options.displayName ?? options.cmd, options.cmd) };
}
