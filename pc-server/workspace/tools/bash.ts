// workspace/tools/bash.ts — 应用的本地 shell 执行后端(pi 内建 bash 工具的 BashOperations,见 pi-engine/builtin-tools.ts)
// Adapted from pi (https://github.com/badlogic/pi-mono), MIT © Mario Zechner
// 来源:packages/coding-agent/src/core/tools/bash.ts(v0.85.1)的 createLocalBashOperations。工具本体(描述 / 参数 /
// 输出截断与落盘 / 错误文案)用 pi 内建的;这里只是执行后端,接应用的 shell 层:shell 探测与内嵌 bash 兜底(./shell)、
// 杀进程树、跟踪分离的子进程、不挂起在被后代继承的 stdio 上(./child-process)。中止抛 "aborted"、超时抛
// "timeout:<秒>",pi 据此出文案。

import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { BashOperations } from "../../../pi/packages/coding-agent/src/core/tools/index.ts";
import { waitForChildProcess } from "./child-process";
import {
  getShellConfig,
  getShellEnv,
  killProcessTree,
  trackDetachedChildPid,
  untrackDetachedChildPid,
} from "./shell";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }

  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return timeoutMs;
}

export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const timeoutMs = resolveTimeoutMs(timeout);
      if (signal?.aborted) {
        throw new Error("aborted");
      }
      const shellConfig = getShellConfig(options?.shellPath);
      try {
        await fsAccess(cwd, constants.F_OK);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      }

      const commandFromStdin = shellConfig.commandTransport === "stdin";
      const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
        cwd,
        detached: process.platform !== "win32",
        env: env ?? getShellEnv(),
        stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      if (commandFromStdin) {
        child.stdin?.on("error", () => {});
        child.stdin?.end(command);
      }
      if (child.pid) trackDetachedChildPid(child.pid);
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      const onAbort = () => {
        if (child.pid) killProcessTree(child.pid);
      };

      try {
        // Set timeout if provided.
        if (timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) killProcessTree(child.pid);
          }, timeoutMs);
        }
        // Stream stdout and stderr.
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        // Handle abort signal by killing the entire process tree.
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
        // Handle shell spawn errors and wait for the process to terminate without hanging
        // on inherited stdio handles held by detached descendants.
        const exitCode = await waitForChildProcess(child);
        if (signal?.aborted) {
          throw new Error("aborted");
        }
        if (timedOut) {
          throw new Error(`timeout:${timeout}`);
        }
        return { exitCode };
      } finally {
        if (child.pid) untrackDetachedChildPid(child.pid);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
