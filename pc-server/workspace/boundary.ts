// workspace/boundary.ts — 工作区路径边界与限额(M1-3,PC 自建安全壳)
//
// pi 的 resolveToCwd 没有任何边界校验(pi 信任 cwd,安全外包给终端用户)。消费级桌面
// 应用不能如此:所有文件工具的 Operations 注入点在此包裹——工具内核(pi 原样)算出
// 绝对路径后,每次文件系统操作前先过 assertInsideWorkspace。
//
// 校验语义(§5.3):
// - resolve + realpath 后必须以 workspace root(同样 realpath 化)为前缀,前缀必须带
//   分隔符(skills-import.ts 的盘符兄弟目录教训:C:\ws 不能放行 C:\ws2\x);
// - 目标不存在时(write 新文件/新目录)取"最深存在祖先"的 realpath 再拼回剩余段——
//   祖先链里的软链逃逸照样被抓;
// - Windows 大小写不敏感比较(realpath 已归一盘符大小写,双保险);
// - 软链本体在区内、指向区外 → realpath 后前缀不匹配 → 拒绝。
//
// 限额(两层中的硬上限层,取安卓数值;pi 截断器管单次输出 50KB/2000 行不动):
// - 读(read/edit 的 readFile):512KB——超限文件引导模型用 bash(sed/head)分段处理,
//   与安卓 WorkspaceTools 口径一致,同时防把大文件整读进内存;
// - 写(write 的 writeFile):2MB。

import { realpathSync } from "node:fs";
import { constants } from "node:fs";
import { access as fsAccess, mkdir as fsMkdir, readdir as fsReaddir, readFile as fsReadFile, stat as fsStat, writeFile as fsWriteFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isWindowsReservedName } from "../foundation/windows-names";
import type { ReadOperations } from "./tools/read";
import type { WriteOperations } from "./tools/write";
import type { EditOperations } from "./tools/edit";
import type { GrepOperations } from "./tools/grep";
import type { FindOperations } from "./tools/find";
import type { LsOperations } from "./tools/ls";
import { detectSupportedImageMimeTypeFromFile } from "./tools/mime";
import { formatSize } from "./tools/truncate";

export const READ_HARD_LIMIT_BYTES = 512 * 1024; // 安卓口径:读 512KB
export const WRITE_HARD_LIMIT_BYTES = 2 * 1024 * 1024; // 安卓口径:写 2MB

/** bash 超时硬上限(秒,§5.1):pi 无默认 timeout,应用加 30min 保护罩——
 *  模型没传或传了无效值 → 取硬上限;传了 → 夹到硬上限以内。 */
export const BASH_HARD_TIMEOUT_SECONDS = 30 * 60;

export function clampBashTimeoutSeconds(timeout: number | undefined): number {
  if (timeout === undefined || !Number.isFinite(timeout) || timeout <= 0) return BASH_HARD_TIMEOUT_SECONDS;
  return Math.min(timeout, BASH_HARD_TIMEOUT_SECONDS);
}

/** realpath 化;目标不存在时取最深存在祖先的 realpath 拼回剩余段(write 新文件场景)。 */
function canonicalizeWithNonexistentTail(path: string): string {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail.slice().reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        // 一路到文件系统根都不存在(不可能在合法工作区内),原样拼回交给前缀校验拒绝
        return tail.length === 0 ? current : join(current, ...tail.slice().reverse());
      }
      tail.push(basename(current));
      current = parent;
    }
  }
}

function comparablePath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export class WorkspaceBoundaryError extends Error {
  constructor(path: string, root: string) {
    // 文案面向模型:明确越界即止,不要重试变体
    super(`Access denied: path resolves outside the workspace boundary. Workspace root: ${root}. Requested: ${path}. Only paths inside the workspace can be accessed.`);
    this.name = "WorkspaceBoundaryError";
  }
}

/**
 * 断言绝对路径在工作区边界内,返回 realpath 化的安全路径。
 * @param absolutePath 工具内核 resolveToCwd 算出的绝对路径(可能含软链/不存在的尾段)
 * @param root 工作区边界根(绝对路径)
 */
export function assertInsideWorkspace(absolutePath: string, root: string): string {
  if (absolutePath.includes("\0")) throw new WorkspaceBoundaryError(absolutePath, root);
  const canonicalRoot = canonicalizeWithNonexistentTail(root);
  const canonicalTarget = canonicalizeWithNonexistentTail(absolutePath);
  const rootCmp = comparablePath(canonicalRoot);
  const targetCmp = comparablePath(canonicalTarget);
  // 前缀必须带分隔符:root 自身可放行(cwd=root 合法),兄弟目录(C:\ws vs C:\ws2)拒绝
  if (targetCmp !== rootCmp && !targetCmp.startsWith(rootCmp.endsWith(sep) ? rootCmp : rootCmp + sep)) {
    throw new WorkspaceBoundaryError(absolutePath, root);
  }
  return canonicalTarget;
}

/** 读取前的体积闸门:超限抛错引导模型分段处理(bash sed/head),防整读进内存。 */
async function readWithHardLimit(safePath: string, displayPath: string): Promise<Buffer> {
  const stat = await fsStat(safePath);
  if (stat.size > READ_HARD_LIMIT_BYTES) {
    throw new Error(
      `File is ${formatSize(stat.size)}, exceeds the ${formatSize(READ_HARD_LIMIT_BYTES)} read limit. Use bash to inspect it in slices, for example: sed -n '1,200p' ${displayPath} or head -c ${READ_HARD_LIMIT_BYTES} ${displayPath}`,
    );
  }
  return fsReadFile(safePath);
}

/** write 工具的有界 Operations:边界断言 + 2MB 写闸门;mkdir 同样受界。 */
export function createBoundedWriteOperations(root: string): WriteOperations {
  return {
    // async 包裹:边界断言的同步 throw 统一成 rejected promise(Operations 契约)
    writeFile: async (absolutePath, content) => writeWithHardLimit(assertInsideWorkspace(absolutePath, root), content, "Content"),
    mkdir: async (dir) => {
      await fsMkdir(assertNotWindowsReservedName(assertInsideWorkspace(dir, root)), { recursive: true });
    },
  };
}

/** edit 工具的有界 Operations:读走 512KB 闸门(编辑先整读),写走 2MB 闸门。 */
export function createBoundedEditOperations(root: string): EditOperations {
  return {
    readFile: (absolutePath) => readWithHardLimit(assertInsideWorkspace(absolutePath, root), absolutePath),
    writeFile: async (absolutePath, content) => {
      const safePath = assertInsideWorkspace(absolutePath, root);
      await writeWithHardLimit(safePath, content, "Edited content");
    },
    access: (absolutePath) => fsAccess(assertInsideWorkspace(absolutePath, root), constants.R_OK | constants.W_OK),
  };
}

// ----- 宽界 Operations(权限档位改版:经用户批准的区外写入 / full_access 档) -----
//
// 2026-08-23 改版(用户拍板):宽界不再对任何路径设黑名单——full_access 语义即"完全
// 访问",pc-data 应用数据目录不享特殊地位,操作系统目录也给审批机会(专业用户改 hosts、
// 研究应用配置的正当场景)。宽界 = 写到哪算哪,唯一保留的闸是 2MB 体积上限。
// systemDenyDirs() 仍保留:它同时服务"能否以系统目录为工作区根"的准入校验(index.ts)。

/** 平台系统目录黑名单(规范化绝对路径)。仅供"以系统目录为工作区根"的准入校验(index.ts)
 *  使用;宽界写入自 2026-08-23 起不再据此设限。 */
export function systemDenyDirs(): string[] {
  if (process.platform === "win32") {
    return [
      process.env.SystemRoot || String.raw`C:\Windows`,
      process.env.ProgramFiles || String.raw`C:\Program Files`,
      process.env["ProgramFiles(x86)"] || String.raw`C:\Program Files (x86)`,
      process.env.ProgramData || String.raw`C:\ProgramData`,
    ].map((dir) => resolve(dir));
  }
  return ["/etc", "/usr", "/bin", "/sbin", "/lib", "/boot", "/dev", "/proc", "/sys", "/var", "/System", "/Library"].map((dir) => resolve(dir));
}

/** 宽界写入断言:区内直通(managed 工作区根就在 dataDir/workspaces/ 下);区外/系统目录/
 *  应用数据目录一律放行——full_access 的"完全访问"不设黑名单,写坏的风险由用户在审批卡上
 *  自行权衡(审批矩阵对 full_access 免审,故实际是直接放行)。体积闸门照旧。 */
export function assertWideWritablePath(absolutePath: string, root: string): string {
  try {
    return assertInsideWorkspace(absolutePath, root);
  } catch (err) {
    if (!(err instanceof WorkspaceBoundaryError)) throw err;
  }
  return canonicalizeWithNonexistentTail(absolutePath);
}

/** Windows 保留设备名写入阻断(问题4,2.0.0 内测)。此类路径在 Win32 语义下是设备:
 *  写入内容会静默进入设备黑洞(工具却报成功),而经 NT 命名空间落盘的同名真实文件
 *  Explorer/cmd 无法删除。模型写它必属误用(通常把 nul 当 /dev/null),明确报错引导换名。
 *  仅 win32 生效:macOS/Linux 上这些是合法文件名。读不设限(读残留文件是合法诊断动作)。 */
function assertNotWindowsReservedName(safePath: string): string {
  if (process.platform === "win32") {
    const name = basename(safePath);
    if (isWindowsReservedName(name)) {
      throw new Error(
        `"${name}" is a reserved Windows device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9). Writing to it goes to a device, not a file. Choose a different name.`,
      );
    }
  }
  return safePath;
}

async function writeWithHardLimit(safePath: string, content: string, what: string): Promise<void> {
  assertNotWindowsReservedName(safePath);
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > WRITE_HARD_LIMIT_BYTES) {
    throw new Error(
      `${what} is ${formatSize(bytes)}, exceeds the ${formatSize(WRITE_HARD_LIMIT_BYTES)} write limit. Write the file in smaller pieces (write a first chunk, then append with bash >> redirection).`,
    );
  }
  await fsWriteFile(safePath, content, "utf-8");
}

/** read 工具的宽界 Operations(三档通用:读不具破坏性,区外读无需审批,2026-08-01 拍板):
 *  无路径限制,512KB 读闸门照旧。 */
export function createWideReadOperations(): ReadOperations {
  return {
    readFile: (absolutePath) => readWithHardLimit(canonicalizeWithNonexistentTail(absolutePath), absolutePath),
    access: (absolutePath) => fsAccess(absolutePath, constants.R_OK),
    detectImageMimeType: (absolutePath) => detectSupportedImageMimeTypeFromFile(absolutePath),
  };
}

/** write 工具的宽界 Operations(经批准的区外写入 / full_access):无路径黑名单,2MB 闸门照旧。 */
export function createWideWriteOperations(root: string): WriteOperations {
  return {
    writeFile: async (absolutePath, content) => writeWithHardLimit(assertWideWritablePath(absolutePath, root), content, "Content"),
    mkdir: async (dir) => {
      await fsMkdir(assertNotWindowsReservedName(assertWideWritablePath(dir, root)), { recursive: true });
    },
  };
}

/** edit 工具的宽界 Operations(经批准的区外编辑 / full_access)。 */
export function createWideEditOperations(root: string): EditOperations {
  return {
    readFile: (absolutePath) => readWithHardLimit(canonicalizeWithNonexistentTail(absolutePath), absolutePath),
    writeFile: async (absolutePath, content) => writeWithHardLimit(assertWideWritablePath(absolutePath, root), content, "Edited content"),
    access: (absolutePath) => fsAccess(absolutePath, constants.R_OK | constants.W_OK),
  };
}

// ----- 兜底搜索工具(grep/find/ls,bash 不可用时挂载)的有界 Operations -----
// 三者皆只读;遍历器(fs-walk)不跟符号链接,从界内根出发不会走出边界,
// 此处的断言管住模型直接传入的 path 参数(绝对路径/../ 逃逸)。

/** exists 语义:界内不存在 → false;越界 → 抛边界错误(模型该看到"越界"而非"不存在")。 */
async function boundedExists(absolutePath: string, root: string): Promise<boolean> {
  const safePath = assertInsideWorkspace(absolutePath, root);
  try {
    await fsAccess(safePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** ls 工具的有界 Operations:exists/stat/readdir 全部过边界断言。 */
export function createBoundedLsOperations(root: string): LsOperations {
  return {
    exists: (absolutePath) => boundedExists(absolutePath, root),
    stat: (absolutePath) => fsStat(assertInsideWorkspace(absolutePath, root)),
    readdir: (absolutePath) => fsReaddir(assertInsideWorkspace(absolutePath, root)),
  };
}

/** find 工具的有界 Operations:搜索根过边界断言即可(遍历自持在界内)。 */
export function createBoundedFindOperations(root: string): FindOperations {
  return {
    exists: (absolutePath) => boundedExists(absolutePath, root),
  };
}

/** grep 工具的有界 Operations:体积闸在引擎内(超限文件跳过而非报错),此处只管边界。 */
export function createBoundedGrepOperations(root: string): GrepOperations {
  return {
    isDirectory: async (absolutePath) => (await fsStat(assertInsideWorkspace(absolutePath, root))).isDirectory(),
    readFile: (absolutePath) => fsReadFile(assertInsideWorkspace(absolutePath, root)),
    statSize: async (absolutePath) => (await fsStat(assertInsideWorkspace(absolutePath, root))).size,
  };
}
