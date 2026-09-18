/**
 * TTS 朗读前文本预处理（台账 §4.1）。
 *
 * 逐字移植 Android 的三个工具，过滤链顺序与 ChatMessageActions.kt:143-149 /
 * VoiceMode.kt:89-94 完全一致：抠引号 → 删括号 → stripMarkdown → 交给 chunker。
 *
 * 三个函数都以「处理后为空则退回原文」为契约（Kotlin 版返回 null，这里用 null 一致表达），
 * 由 prepareSpeechText 统一兜底 —— 用户开了过滤但全文都被滤掉时，宁可念原文也不念空。
 */

/** 引号对：中文双/单、英文双/单、直角「」、白直角『』。顺序即匹配优先级，与 Kotlin 版一致。 */
const QUOTE_PATTERNS: readonly RegExp[] = [
  /“([^”]*?)”/g, // 中文双引号
  /‘([^’]*?)’/g, // 中文单引号
  /"([^"]*?)"/g, // 英文双引号
  /'([^']*?)'/g, // 英文单引号
  /「([^」]*?)」/g, // 直角引号
  /『([^』]*?)』/g, // 白直角引号
];

/** 提取所有引号内的内容并合并；没有任何引号内容时返回 null（调用方退回原文）。 */
export function extractQuotedContentAsText(text: string, separator = "\n"): string | null {
  const contents: string[] = [];
  for (const pattern of QUOTE_PATTERNS) {
    // g 标志的正则跨多次 exec/matchAll 复用会带上次 lastIndex，每次用新实例避免串扰。
    for (const match of text.matchAll(new RegExp(pattern.source, "g"))) {
      const content = match[1];
      if (content && content.trim().length > 0) contents.push(content);
    }
  }
  return contents.length > 0 ? contents.join(separator) : null;
}

/** 移除中英文括号及其内容；全被删空时返回 null（调用方退回原文）。 */
export function removeBracketedContent(text: string): string | null {
  const result = text.replace(/\([^)]*?\)|（[^）]*?）/g, "").trim();
  return result.length > 0 ? result : null;
}

/**
 * 移除 Markdown 格式，保留纯文本。逐条对应 Android MarkdownUtils.kt:7-33。
 * TTS 引擎会把 "**"、"#"、"```" 逐字符念出来，所以这是过滤链最后一步（必经）。
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```|`[^`]*?`/g, "") // 代码块与行内代码
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1") // 图片/链接，保留文字
    .replace(/\*\*([^*]+?)\*\*/g, "$1") // 加粗
    .replace(/\*([^*]+?)\*/g, "$1") // 斜体
    .replace(/__([^_]+?)__/g, "$1") // 下划线加粗
    .replace(/_([^_]+?)_/g, "$1") // 下划线斜体
    .replace(/~~([^~]+?)~~/g, "$1") // 删除线
    .replace(/^#+\s*/gm, "") // 标题
    .replace(/^\s*[-*+]\s+/gm, "") // 无序列表
    .replace(/^\s*\d+\.\s+/gm, "") // 有序列表
    .replace(/^>\s*/gm, "") // 引用
    .replace(/^(\s*[-*_]){3,}\s*$/gm, "") // 水平分割线
    .replace(/\n{3,}/g, "\n\n") // 压缩多余空行
    .trim();
}

export interface SpeechFilterOptions {
  /** 只读引号内容（角色扮演只念台词，跳过旁白）。 */
  onlyReadQuoted?: boolean;
  /** 不读括号内容（跳过中英括号里的注释/语气说明）。 */
  readOutsideBrackets?: boolean;
}

/**
 * 朗读前统一过滤入口。两个开关可叠加，顺序固定为先抠引号再删括号（对齐 Android），
 * 最后无条件 stripMarkdown。任何一步滤空都退回上一步文本，保证不会念空。
 */
export function prepareSpeechText(text: string, options: SpeechFilterOptions): string {
  let out = text;
  if (options.onlyReadQuoted) out = extractQuotedContentAsText(out) ?? out;
  if (options.readOutsideBrackets) out = removeBracketedContent(out) ?? out;
  return stripMarkdown(out);
}
