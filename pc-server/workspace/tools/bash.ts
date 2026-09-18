// Adapted from pi (https://github.com/badlogic/pi-mono), MIT © Mario Zechner
// 来源:packages/coding-agent/src/core/tools/bash.ts(v0.85.1)。schema/description/execute
// 逐字保留(timeout 语义、OutputAccumulator 有界累积、100ms onUpdate 节流、截断落盘
// 提示文案、abort/timeout 错误文案、非零退出码报错);TUI 渲染弃用。
// PC 适配:
// - schema 从 TypeBox 转写为等价 OpenAI JSON Schema(字段/描述原文);
// - 删去 pi 私有 PI_* 会话环境变量注入与 spawnHook(pi CLI 私货);
// - details 增加 exitCode(§5.3:pi 靠报错文本传非零码,PC 渲染徽标需要结构化值);
// - tempFileDir 选项:截断落盘进工作区 tmp/ 而非系统 tmpdir(M1-5 接线)。

import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { spawn } from "node:child_process";
import { waitForChildProcess } from "./child-process";
import { OutputAccumulator } from "./output-accumulator";
import {
  getShellConfig,
  getShellEnv,
  killProcessTree,
  trackDetachedChildPid,
  untrackDetachedChildPid,
} from "./shell";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate";
import type { WorkspaceToolDefinition } from "./types";

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

export interface BashToolInput {
  command: string;
  timeout?: number;
}

export interface BashToolDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;
  /** PC 适配:结构化退出码(pi 只在报错文本里携带非零码) */
  exitCode?: number | null;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
  /**
   * Execute a command and stream output.
   * @param command The command to execute
   * @param cwd Working directory
   * @param options Execution options
   * @returns Promise resolving to exit code (null if killed)
   */
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 */
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

export interface BashToolOptions {
  /** Custom operations for command execution. Default: local shell */
  operations?: BashOperations;
  /** Optional explicit shell path from settings */
  shellPath?: string;
  /** 截断落盘目录(PC 适配:工作区 tmp/)。缺省系统 tmpdir(pi 原行为)。 */
  tempFileDir?: string;
}

const BASH_UPDATE_THROTTLE_MS = 100;

const BASH_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", description: "Shell command to execute" },
    timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" },
  },
  required: ["command"],
} as const;

export function createBashTool(
  cwd: string,
  options?: BashToolOptions,
): WorkspaceToolDefinition<BashToolInput, BashToolDetails | undefined> {
  const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
  return {
    name: "bash",
    description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
    parameters: BASH_SCHEMA as unknown as Record<string, unknown>,
    async execute({ command, timeout }, signal?, onUpdate?) {
      const output = new OutputAccumulator({ tempFilePrefix: "pi-bash", tempFileDir: options?.tempFileDir });
      let acceptingOutput = true;
      let updateTimer: NodeJS.Timeout | undefined;
      let updateDirty = false;
      let lastUpdateAt = 0;

      const emitOutputUpdate = () => {
        if (!onUpdate || !updateDirty) return;
        updateDirty = false;
        lastUpdateAt = Date.now();
        const snapshot = output.snapshot({ persistIfTruncated: true });
        onUpdate({
          content: [{ type: "text", text: snapshot.content || "" }],
          details: {
            truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
            fullOutputPath: snapshot.fullOutputPath,
          },
        });
      };

      const clearUpdateTimer = () => {
        if (updateTimer) {
          clearTimeout(updateTimer);
          updateTimer = undefined;
        }
      };

      const scheduleOutputUpdate = () => {
        if (!onUpdate) return;
        updateDirty = true;
        const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
        if (delay <= 0) {
          clearUpdateTimer();
          emitOutputUpdate();
          return;
        }
        updateTimer ??= setTimeout(() => {
          updateTimer = undefined;
          emitOutputUpdate();
        }, delay);
      };

      if (onUpdate) {
        onUpdate({ content: [], details: undefined });
      }

      const handleData = (data: Buffer) => {
        if (!acceptingOutput) return;
        output.append(data);
        scheduleOutputUpdate();
      };

      const finishOutput = async () => {
        acceptingOutput = false;
        output.finish();
        clearUpdateTimer();
        emitOutputUpdate();
        const snapshot = output.snapshot({ persistIfTruncated: true });
        await output.closeTempFile();
        return snapshot;
      };

      const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
        const truncation = snapshot.truncation;
        let text = snapshot.content || emptyText;
        let details: BashToolDetails | undefined;
        if (truncation.truncated) {
          details = { truncation, fullOutputPath: snapshot.fullOutputPath };
          const startLine = truncation.totalLines - truncation.outputLines + 1;
          const endLine = truncation.totalLines;
          if (truncation.lastLinePartial) {
            const lastLineSize = formatSize(output.getLastLineBytes());
            text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
          } else if (truncation.truncatedBy === "lines") {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
          } else {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
          }
        }
        return { text, details };
      };

      const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

      try {
        let exitCode: number | null;
        try {
          const result = await ops.exec(command, cwd, {
            onData: handleData,
            signal,
            timeout,
            env: getShellEnv(),
          });
          exitCode = result.exitCode;
        } catch (err) {
          const snapshot = await finishOutput();
          const { text } = formatOutput(snapshot, "");
          if (err instanceof Error && err.message === "aborted") {
            throw new Error(appendStatus(text, "Command aborted"));
          }
          if (err instanceof Error && err.message.startsWith("timeout:")) {
            const timeoutSecs = err.message.split(":")[1];
            throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
          }
          throw err;
        }

        const snapshot = await finishOutput();
        const { text: outputText, details } = formatOutput(snapshot);
        if (exitCode !== 0 && exitCode !== null) {
          throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
        }
        return { content: [{ type: "text" as const, text: outputText }], details: { ...details, exitCode } };
      } finally {
        clearUpdateTimer();
      }
    },
  };
}
