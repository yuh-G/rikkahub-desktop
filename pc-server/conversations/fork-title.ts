// conversations/fork-title.ts — fork 会话标题的「(N) 序号 + 防叠加」纯函数(对齐 APP 458c16df/95fed05e)。
//
// 旧版 fork 标题是 "<源标题> Fork":中文界面观感差,且多次 fork 叠加出 "Chat Fork Fork"。
// 现改为「原标题 (N)」:N 从 1 起取同助手下首个空闲序号;源标题本身已带 (N) 尾缀时
// 剥离后递增(Chat(1) fork 出 Chat(2),不是 Chat(1)(1));字母后缀(Chat(abc))不误剥。
// 空标题(从未生成标题的会话)以 "Fork" 为基底,延续旧版空标题 fork 的命名血统。

const FORK_TITLE_SUFFIX_RE = /\((\d+)\)$/;
const EMPTY_TITLE_BASE = "Fork";

export function forkConversationTitle(sourceTitle: string, existingTitles: ReadonlySet<string>): string {
  const trimmed = sourceTitle.trim();
  const suffix = FORK_TITLE_SUFFIX_RE.exec(trimmed);
  const base = (suffix ? trimmed.slice(0, suffix.index) : trimmed).trim() || EMPTY_TITLE_BASE;
  // 现有标题有限,循环至多 existingTitles.size + 1 轮必然命中空闲序号。
  for (let n = suffix ? Number.parseInt(suffix[1]!, 10) + 1 : 1; ; n += 1) {
    const candidate = `${base}(${n})`;
    if (!existingTitles.has(candidate)) return candidate;
  }
}
