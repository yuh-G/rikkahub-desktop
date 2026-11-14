// pi-engine/builtin-tools.ts — 工作区工具 = pi 内建工具定义 + 应用后端与执行前审批(方案 D12 / P4b)
//
// 名称、描述、参数、执行逻辑、提示词摘要都来自 pi 的工具工厂(升级 pi 即跟随上游);应用只换掉两样东西:
// - 后端(*Operations):文件读写过工作区边界与读写体积闸门(workspace/boundary),命令经应用的 shell 层
//   (用户指定路径 / 内嵌 bash 兜底、杀进程树、30 分钟超时上限、执行后清扫 Windows 保留设备名残留);
//   grep / find 不用 pi 默认的外部程序 rg / fd(pi 会联网下载),find 走 pi 的自定义 glob 口子,grep 覆盖执行体,
//   两者都用应用的纯 TS 实现。
// - execute 外包一层执行前审批(host.permission.check,来源 engine):类别与对象来自本文件的映射表(§5.6,
//   pi 这张表归 pi 驱动;路径给的是 pi 实际要操作的绝对路径)。放行结果决定这次调用的范围:默认写入走严界、
//   危险命令不执行;用户在审批卡上批准了或档位是完全访问,写入走宽界、危险命令放行。
// pi 先把 tool_call 发给插件钩子(可改参数 / 否决)再调 execute,所以审批看到的是插件改过之后的最终参数。
//
// 挂载:有可用 bash 时 read / bash / edit / write(pi 默认四件);没有时 read / edit / write / grep / find / ls。
// 全部顺序执行:审批卡逐个弹、命令输出不交错(批内任一 sequential 即整批顺序)。
// 结果的结构化细节打成 {workspace:{tool,details}} 标记,事件桥还原成工具卡(与应用工具时期的形状相同,
// 老会话照常渲染);bash 终局补 exitCode(工具卡据此判定完成与成败),write 补写入字节数(工具卡的字节徽标)。

import type { ToolDefinition } from "../../pi/packages/coding-agent/src/core/extensions/types.ts";
import {
  allToolNames,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type BashOperations,
  type ToolDef,
} from "../../pi/packages/coding-agent/src/core/tools/index.ts";
import { resolveToCwd } from "../../pi/packages/coding-agent/src/core/tools/path-utils.ts";
import type { PermissionCheck, PermissionGrant } from "../engines/contract";
import type { JsonValue } from "../foundation/types";
import { jsonSafeDetails } from "../tools/format";
import type { PermissionTarget, ToolCategory } from "../tools/permission";
import { findDangerousCommandReason } from "../workspace/approval";
import {
  clampBashTimeoutSeconds,
  createBoundedEditOperations,
  createBoundedFindOperations,
  createBoundedGrepOperations,
  createBoundedLsOperations,
  createBoundedWriteOperations,
  createWideEditOperations,
  createWideReadOperations,
  createWideWriteOperations,
} from "../workspace/boundary";
import { sweepWorkspaceReservedNameArtifacts } from "../workspace/files";
import { createLocalBashOperations } from "../workspace/tools/bash";
import { collectFindMatches } from "../workspace/tools/find";
import { createGrepSearch, type GrepToolInput } from "../workspace/tools/grep";
import { markToolGated } from "./tool-gate";

type PiToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;
type ToolArgs = Record<string, JsonValue>;

export type PiBuiltinToolApproval = Pick<PermissionCheck, "toolCallId" | "toolName" | "args"> & {
  category: ToolCategory;
  target: PermissionTarget;
};

/** 放行时返回放行结果;拒绝 / 中止时以错误拒绝,错误文本即给模型的工具结果。 */
export type PiBuiltinToolApprover = (req: PiBuiltinToolApproval) => Promise<PermissionGrant>;

export interface PiBuiltinToolsOptions {
  /** 会话工作目录(边界内绝对路径)。 */
  cwd: string;
  /** 工作区边界根。 */
  root: string;
  /** 可用 bash 的路径;缺省 = 没有 bash,挂 grep / find / ls 兜底。 */
  shell?: string;
  approve: PiBuiltinToolApprover;
}

interface ToolEntry {
  category: ToolCategory;
  target: (args: ToolArgs, cwd: string) => PermissionTarget;
}

const pathTarget = (args: ToolArgs, cwd: string): PermissionTarget =>
  typeof args.path === "string" && args.path.trim() ? { path: resolveToCwd(args.path, cwd) } : {};

/** pi 内建工具 → 类别 + 对象。 */
const TOOL_CATEGORIES: Readonly<Record<string, ToolEntry>> = {
  read: { category: "read", target: pathTarget },
  grep: { category: "read", target: pathTarget },
  find: { category: "read", target: pathTarget },
  ls: { category: "read", target: pathTarget },
  write: { category: "write", target: pathTarget },
  edit: { category: "write", target: pathTarget },
  bash: { category: "execute", target: (args) => ({ command: String(args.command ?? "") }) },
};

export function piBuiltinToolNames(shell: string | undefined): string[] {
  return shell ? ["read", "bash", "edit", "write"] : ["read", "edit", "write", "grep", "find", "ls"];
}

/** pi 内建工具里本轮不提供的那些:会话里连登记都不要有(否则插件可经 setActiveTools 激活 pi 默认后端的版本)。 */
export function excludedPiBuiltinToolNames(shell: string | undefined): string[] {
  const provided = new Set(piBuiltinToolNames(shell));
  return [...allToolNames].filter((name) => !provided.has(name));
}

function withDetailsMarker(name: string, result: PiToolResult, final: boolean, extra?: Record<string, JsonValue>): PiToolResult {
  const raw = (result.details ?? {}) as Record<string, unknown>;
  const exitCode = name === "bash" && final ? (result.isError ? exitCodeOf(result) : 0) : undefined;
  const details = jsonSafeDetails({ ...raw, ...extra, ...(exitCode === undefined ? {} : { exitCode }) });
  return { ...result, details: details ? { workspace: { tool: name, details } } : {} } as PiToolResult;
}

/** 工具卡要的、pi 结果里没有的细节。write:写入字节数(pi 的结果文本不再带字节数,工具卡的字节徽标读这里)。 */
function cardExtras(name: string, args: ToolArgs): Record<string, JsonValue> | undefined {
  if (name === "write" && typeof args.content === "string") return { bytes: Buffer.byteLength(args.content, "utf-8") };
  return undefined;
}

function exitCodeOf(result: PiToolResult): number | null {
  const structured = result.structuredContent as { exit_code?: unknown } | undefined;
  return typeof structured?.exit_code === "number" ? structured.exit_code : null;
}

/** 有宽界变体的工具(write / edit)按放行范围选定义;其余只有一个。 */
interface Variants {
  default: ToolDef;
  unrestricted?: ToolDef;
}

function gate(variants: Variants, options: PiBuiltinToolsOptions): ToolDefinition {
  const base = variants.default;
  const name = base.name;
  const entry = TOOL_CATEGORIES[name];
  if (!entry) throw new Error(`pi 内建工具 ${name} 没有登记类别`);
  return markToolGated({
    ...base,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const args = (params ?? {}) as ToolArgs;
      const grant = await options.approve({ toolCallId, toolName: name, category: entry.category, target: entry.target(args, options.cwd), args });
      if (name === "bash") {
        const danger = findDangerousCommandReason(String(args.command ?? ""));
        // 执行层兜底:危险命令在审批里就会待审;没经用户批准(也不是完全访问)却走到这里,按档位拒绝。
        if (danger && grant.scope !== "unrestricted") {
          throw new Error(
            `Command blocked by safety policy: it matches a destructive pattern (${danger}) and was NOT executed. ` +
              `Ask the user to approve it explicitly, or ask them to run it manually.`,
          );
        }
      }
      const definition = grant.scope === "unrestricted" && variants.unrestricted ? variants.unrestricted : base;
      const update = onUpdate ? (partial: PiToolResult) => onUpdate(withDetailsMarker(name, partial, false)) : undefined;
      return withDetailsMarker(name, await definition.execute(toolCallId, params, signal, update, ctx), true, cardExtras(name, args));
    },
  } as ToolDefinition);
}

function bashOperations(shell: string): BashOperations {
  const local = createLocalBashOperations({ shellPath: shell });
  return {
    exec: async (command, cwd, execOptions) => {
      try {
        return await local.exec(command, cwd, { ...execOptions, timeout: clampBashTimeoutSeconds(execOptions.timeout) });
      } finally {
        // 命令或其派生的原生进程可能在 cwd 落下 Windows 保留设备名残留(nul 等),成功 / 失败 / 超时 / 中止都清扫。
        sweepWorkspaceReservedNameArtifacts(cwd);
      }
    },
  };
}

function grepDefinition(cwd: string, root: string): ToolDef {
  const search = createGrepSearch(cwd, { operations: createBoundedGrepOperations(root) });
  return {
    ...(createGrepToolDefinition(cwd) as ToolDef),
    execute: async (_toolCallId, params, signal) => (await search(params as GrepToolInput, signal)) as PiToolResult,
  };
}

function findDefinition(cwd: string, root: string): ToolDef {
  return createFindToolDefinition(cwd, {
    operations: {
      ...createBoundedFindOperations(root),
      glob: (pattern, searchPath, { limit }) => collectFindMatches(pattern, searchPath, limit).matches,
    },
  });
}

function variantsFor(name: string, options: PiBuiltinToolsOptions): Variants {
  const { cwd, root, shell } = options;
  switch (name) {
    case "read":
      // 图片原样交给模型(不缩放,与用户发图同一口径,方案 D4)。
      return { default: createReadToolDefinition(cwd, { operations: createWideReadOperations(), autoResizeImages: false }) };
    case "write":
      return {
        default: createWriteToolDefinition(cwd, { operations: createBoundedWriteOperations(root) }),
        unrestricted: createWriteToolDefinition(cwd, { operations: createWideWriteOperations(root) }),
      };
    case "edit":
      return {
        default: createEditToolDefinition(cwd, { operations: createBoundedEditOperations(root) }),
        unrestricted: createEditToolDefinition(cwd, { operations: createWideEditOperations(root) }),
      };
    case "bash":
      if (!shell) throw new Error("没有可用的 bash,不挂载 bash 工具");
      // 不暴露 pi 的会话环境变量(PI_SESSION_ID 等是 pi 自己的会话身份,与应用会话无关)。
      return { default: createBashToolDefinition(cwd, { operations: bashOperations(shell), shellPath: shell, exposeSessionEnvironment: false }) };
    case "grep":
      return { default: grepDefinition(cwd, root) };
    case "find":
      return { default: findDefinition(cwd, root) };
    case "ls":
      return { default: createLsToolDefinition(cwd, { operations: createBoundedLsOperations(root) }) };
    default:
      throw new Error(`未知的 pi 内建工具:${name}`);
  }
}

export function createPiBuiltinTools(options: PiBuiltinToolsOptions): ToolDefinition[] {
  return piBuiltinToolNames(options.shell).map((name) => gate(variantsFor(name, options), options));
}
