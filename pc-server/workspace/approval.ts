// workspace/approval.ts — 工作区的词法路径判定与危险命令识别(纯函数层,不碰文件系统)
// 审批判定不在这里:三档矩阵读「类别 + 对象」,在 tools/permission.ts;工作区工具(pi 内建)名 → 类别的知识在
// pi-engine/builtin-tools.ts。本模块给两边供料:词法越界判定与 cwd 解析(审批与执行同口径),
// 危险命令清单(审批缘由与执行层兜底拦截共用)。

import { isAbsolute, resolve, sep } from "node:path";

/** 词法越界判定:与 boundary.ts 同前缀语义(Windows 大小写不敏感),但不做 realpath。 */
export function isLexicallyOutsideRoot(absolutePath: string, root: string): boolean {
  const cmp = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const target = cmp(resolve(absolutePath));
  const rootCmp = cmp(resolve(root));
  return target !== rootCmp && !target.startsWith(rootCmp.endsWith(sep) ? rootCmp : rootCmp + sep);
}

/** 会话 cwd 的词法解析(与 runtime.resolveCwd 同语义,少一步存在性自愈——审批判定不碰 fs)。 */
export function lexicalWorkspaceCwd(root: string, workspaceCwd: string | null | undefined): string {
  const raw = String(workspaceCwd ?? "").trim();
  if (!raw) return root;
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  return isLexicallyOutsideRoot(absolute, root) ? root : absolute;
}

// 危险命令静态拦截清单。目标是灾难性、不可逆的系统级破坏(整盘/设备/系统目录),
// 不是细粒度沙箱(shell 天然可越界是全行业现状,§七-1 已向用户明示)。
// 每项 [正则, 人话说明];说明会出现在拦截错误文案里,模型与用户都看得懂。
// 目标 token 结束判定:后随空白/行尾/命令分隔符(允许 rm -rf / --no-preserve-root 这种带尾部旗标的形态)。
// 命令位判定:mkfs/diskpart 等裸命令要求出现在行首、分隔符后或 sudo 后,避免误伤 grep 'mkfs' 之类字面量引用。
const DANGEROUS_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // rm -rf 指向根/家目录/盘符根(允许 rm -rf ./build 这类区内清理)
  [/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*)\s+(["']?)(\/|~|\$HOME)\2(?=\s|$|[;&|)])/, "recursive force-delete of the filesystem root or home directory"],
  [/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*)\s+(["']?)\/(bin|boot|dev|etc|lib|proc|sys|usr|var)\b/, "recursive force-delete of a system directory"],
  [/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*)\s+(["']?)[A-Za-z]:[\\/]?\2(?=\s|$|[;&|)])/, "recursive force-delete of a drive root"],
  // Windows 整盘/系统目录删除(Git Bash 下也可能调 cmd /c del)
  [/\bdel\s+(\/[a-zA-Z]\s+)*\/s\b.*\s(["']?)[A-Za-z]:[\\/]?\2(?=\s|$|[;&|)])/i, "recursive delete of a drive root (del /s)"],
  [/\b(rd|rmdir)\s+\/s\b.*\s(["']?)[A-Za-z]:[\\/]?\2(?=\s|$|[;&|)])/i, "recursive removal of a drive root (rd /s)"],
  // 磁盘/文件系统毁灭(命令位判定)
  [/(?:^|[;&|(]\s*|\bsudo\s+)mkfs(\.\w+)?\b/, "filesystem format (mkfs)"],
  [/\bformat(\.com)?\s+[A-Za-z]:/i, "drive format"],
  [/(?:^|[;&|(]\s*|\bsudo\s+)diskpart\b/i, "disk partitioning tool (diskpart)"],
  [/\bdd\b[^;&|]*\bof=\/dev\/(sd[a-z]|hd[a-z]|nvme\d+n\d+|disk\d+)\b/, "raw write to a block device (dd)"],
  [/>\s*\/dev\/(sd[a-z]|hd[a-z]|nvme\d+n\d+)\b/, "raw write to a block device"],
  // 系统级权限破坏 / 注册表删除
  [/\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?[0-7]{3,4}\s+\/\s*(?:$|[;&|)])/, "recursive permission change on filesystem root"],
  [/\breg\s+delete\s+(["']?)HK(LM|EY_LOCAL_MACHINE)\b/i, "registry hive deletion (HKLM)"],
  // fork 炸弹
  [/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, "fork bomb"],
];

/** 命中返回人话说明(进拦截文案),未命中返回 null。 */
export function findDangerousCommandReason(command: string): string | null {
  const normalized = command.trim();
  if (!normalized) return null;
  for (const [pattern, reason] of DANGEROUS_PATTERNS) {
    if (pattern.test(normalized)) return reason;
  }
  return null;
}
