// lib/copy-name.ts — 设置条目复制的「(N) 序号后缀」纯函数。
//
// 命名纪律对齐会话 fork(conversations/fork-title.ts 的 forkConversationTitle,
// 方案出自安卓 458c16df/95fed05e):「原名 (N)」而非「原名 副本」——中文观感好且
// 多次复制不叠加("Chat 副本 副本")。源名已带 (N) 尾缀时剥离后递增(Chat(1) 复制出
// Chat(2),不是 Chat(1)(1));字母尾缀(Chat(abc))不误剥;N 从源序号 +1 起跳过已
// 占用名。技能页的目录名受 pi 命名规则约束(小写/数字/连字符),给它专用
// copySkillDirName——序号后缀用 "-n" 而非 "(n)"。
const NUMERIC_SUFFIX_RE = /\s*\((\d+)\)$/;

export function copyItemName(sourceName: string, existingNames: ReadonlySet<string>): string {
  const trimmed = sourceName.trim();
  const suffix = NUMERIC_SUFFIX_RE.exec(trimmed);
  const base = (suffix ? trimmed.slice(0, suffix.index) : trimmed).trim() || "Copy";
  for (let n = suffix ? Number.parseInt(suffix[1]!, 10) + 1 : 1; ; n += 1) {
    const candidate = `${base} (${n})`;
    if (!existingNames.has(candidate)) return candidate;
  }
}

/** 技能目录名变体:pi 规则禁括号/空格,序号后缀用 "-n",基名剥离旧 "-n" 尾缀。 */
export function copySkillDirName(sourceName: string, existingNames: ReadonlySet<string>): string {
  const trimmed = sourceName.trim();
  const match = /-(\d+)$/.exec(trimmed);
  const base = (match ? trimmed.slice(0, match.index) : trimmed).trim() || "skill";
  for (let n = match ? Number.parseInt(match[1]!, 10) + 1 : 1; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!existingNames.has(candidate)) return candidate;
  }
}
