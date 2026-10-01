import * as React from "react";
import type { ComponentProps, CSSProperties, HTMLAttributes } from "react";

import { Check, ChevronDown, Copy, Download, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  bundledLanguages,
  createHighlighter,
  type BundledLanguage,
  type BundledTheme,
  type HighlighterGeneric,
  type ThemedToken,
} from "shiki";

import { getCodePreviewLanguage } from "~/components/workbench/code-preview-language";
import {
  createStreamingTokenizer,
  type StreamingTokenizer,
  type TokenizedCode,
} from "./incremental-shiki";
import { Button } from "~/components/ui/button";
import { copyTextToClipboard } from "~/lib/clipboard";
import { isDesktopShell } from "~/lib/external-link";
import { openCodePreviewFile } from "~/services/api";
import { cn } from "~/lib/utils";

// 高亮的绝对上限只作为病态输入的保险丝。常规长代码不再"一刀切放弃高亮":静态块走
// 空闲分片渐进高亮(每片 ~8KB,主线程无长任务),流式块走行级增量分词(每帧只重算
// 尾行)——两条路径成本都与总长解耦,任意正常长度都能最终全彩。
const MAX_SHIKI_CODE_LENGTH = 200_000;
const HIGHLIGHT_CHUNK_CHARS = 8_000;
const SHIKI_CACHE_LIMIT = 200;
const SHIKI_THEME_LIGHT = "catppuccin-latte";
const SHIKI_THEME_DARK = "catppuccin-mocha";

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: string;
  isAnimating?: boolean;
  showLineNumbers?: boolean;
  wrapLines?: boolean;
};

interface CodeBlockContextType {
  code: string;
  language: string;
}

const ITALIC_STYLES = new Set([1, 3, 5, 7]);
const BOLD_STYLES = new Set([2, 3, 6, 7]);
const UNDERLINE_STYLES = new Set([4, 5, 6, 7]);

const CodeBlockContext = React.createContext<CodeBlockContextType>({
  code: "",
  language: "text",
});

const DEFAULT_DOWNLOAD_FILE_NAME = "code.txt";
const CODE_LANGUAGE_EXTENSION_MAP: Record<string, string> = {
  bash: "sh",
  csharp: "cs",
  javascript: "js",
  js: "js",
  jsx: "jsx",
  kotlin: "kt",
  markdown: "md",
  plaintext: "txt",
  python: "py",
  shell: "sh",
  typescript: "ts",
  tsx: "tsx",
};

function buildInlinePreviewDocument(code: string, language: string): string {
  if (language === "svg") {
    return `<!doctype html><html><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /></head><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:white;">${code}</body></html>`;
  }
  return code;
}

function toDownloadFileName(language: string): string {
  const normalized = language.trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_DOWNLOAD_FILE_NAME;
  }

  const mappedExtension = CODE_LANGUAGE_EXTENSION_MAP[normalized];
  if (mappedExtension) {
    return `code.${mappedExtension}`;
  }

  const safeExtension = normalized.replace(/[^a-z0-9]+/g, "");
  if (!safeExtension) {
    return DEFAULT_DOWNLOAD_FILE_NAME;
  }

  return `code.${safeExtension}`;
}

const highlighterCache = new Map<
  BundledLanguage,
  Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>
>();
const resolvedHighlighters = new Map<
  BundledLanguage,
  HighlighterGeneric<BundledLanguage, BundledTheme>
>();
const tokensCache = new Map<string, TokenizedCode>();
const subscribers = new Map<string, Set<(result: TokenizedCode) => void>>();

function resolveShikiLanguage(language: string): BundledLanguage | null {
  const normalized = language.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (!Object.prototype.hasOwnProperty.call(bundledLanguages, normalized)) {
    return null;
  }

  return normalized as BundledLanguage;
}

// NUL 分隔符(语言名/代码文本中都不可能出现)。用 fromCharCode 构造而非 U+0000
// 字面量:后者在部分编辑工具链下会被还原成真实 NUL 字节,把本源文件变成二进制。
const TOKENS_CACHE_KEY_SEPARATOR = String.fromCharCode(0);

function getTokensCacheKey(code: string, language: BundledLanguage): string {
  return `${language}${TOKENS_CACHE_KEY_SEPARATOR}${code}`;
}

function readTokensFromCache(cacheKey: string): TokenizedCode | null {
  const cached = tokensCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  tokensCache.delete(cacheKey);
  tokensCache.set(cacheKey, cached);
  return cached;
}

function writeTokensToCache(cacheKey: string, tokenized: TokenizedCode): void {
  if (tokensCache.size >= SHIKI_CACHE_LIMIT) {
    const oldest = tokensCache.keys().next().value;
    if (typeof oldest === "string") {
      tokensCache.delete(oldest);
    }
  }

  tokensCache.set(cacheKey, tokenized);
}

// 空闲期高亮调度:打开会话时若干代码块同帧挂载,同步全量分词会把 ~15-40ms/块的
// Shiki(oniguruma wasm)串成一个数百毫秒的主线程长任务,压在首开关键路径上
// (性能探针实测 ~180-230ms)。改为空闲期逐块执行:一个空闲片只处理一个代码块,
// 高亮完成前按原文渲染(行数/等宽字体不变 → 高度不变,无布局跳动)。
const pendingHighlightJobs: Array<() => void> = [];
let highlightDrainScheduled = false;

function drainOneHighlightJob(): void {
  const job = pendingHighlightJobs.shift();
  // B1(专题1/2复查):job 抛错也必须重调度/复位,否则 highlightDrainScheduled 永久卡 true,
  // 后续所有代码块只入队不消费,全局高亮静默失效。单个坏任务不得拖垮队列。
  try {
    job?.();
  } finally {
    if (pendingHighlightJobs.length > 0) {
      scheduleHighlightDrain();
    } else {
      highlightDrainScheduled = false;
    }
  }
}

function scheduleHighlightDrain(): void {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(drainOneHighlightJob, { timeout: 200 });
  } else {
    window.setTimeout(drainOneHighlightJob, 16);
  }
}

function scheduleIdleHighlight(job: () => void): void {
  pendingHighlightJobs.push(job);
  if (highlightDrainScheduled) return;
  highlightDrainScheduled = true;
  scheduleHighlightDrain();
}

function getHighlighter(
  language: BundledLanguage,
): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> {
  const cached = highlighterCache.get(language);
  if (cached) {
    return cached;
  }

  const highlighterPromise = createHighlighter({
    langs: [language],
    themes: [SHIKI_THEME_LIGHT, SHIKI_THEME_DARK],
  });
  highlighterCache.set(language, highlighterPromise);
  return highlighterPromise;
}

function createRawTokens(code: string): TokenizedCode {
  return {
    bg: "transparent",
    fg: "inherit",
    tokens: code.split("\n").map((line) =>
      line === ""
        ? []
        : [
            {
              color: "inherit",
              content: line,
            } as ThemedToken,
          ],
    ),
  };
}

function isItalic(fontStyle: number | undefined): boolean {
  return ITALIC_STYLES.has(fontStyle ?? 0);
}

function isBold(fontStyle: number | undefined): boolean {
  return BOLD_STYLES.has(fontStyle ?? 0);
}

function isUnderline(fontStyle: number | undefined): boolean {
  return UNDERLINE_STYLES.has(fontStyle ?? 0);
}

function highlightCode(
  code: string,
  language: BundledLanguage,
  callback?: (result: TokenizedCode) => void,
): TokenizedCode | null {
  const tokensCacheKey = getTokensCacheKey(code, language);
  const cached = readTokensFromCache(tokensCacheKey);
  if (cached) {
    return cached;
  }

  // Synchronous path: if the highlighter is already loaded, highlight immediately
  const resolved = resolvedHighlighters.get(language);
  if (resolved) {
    const tokenResult = resolved.codeToTokens(code, {
      lang: language,
      themes: {
        light: SHIKI_THEME_LIGHT,
        dark: SHIKI_THEME_DARK,
      },
    });

    const tokenized: TokenizedCode = {
      bg: tokenResult.bg ?? "transparent",
      fg: tokenResult.fg ?? "inherit",
      tokens: tokenResult.tokens,
    };

    writeTokensToCache(tokensCacheKey, tokenized);
    return tokenized;
  }

  // Async path: first time loading this language's highlighter
  if (callback) {
    if (!subscribers.has(tokensCacheKey)) {
      subscribers.set(tokensCacheKey, new Set());
    }
    subscribers.get(tokensCacheKey)?.add(callback);
  }

  void getHighlighter(language)
    .then((highlighter) => {
      resolvedHighlighters.set(language, highlighter);

      // 装载完成后的分词同样进空闲队列:多个代码块等同一高亮器时,promise 回调
      // 会在同一次微任务清空里连续执行,等于把 N 次分词又串成一个长任务。
      // 空闲片内先查缓存(同内容多次订阅只分词一次)。
      scheduleIdleHighlight(() => {
        const tokenized =
          readTokensFromCache(tokensCacheKey) ??
          (() => {
            const tokenResult = highlighter.codeToTokens(code, {
              lang: language,
              themes: {
                light: SHIKI_THEME_LIGHT,
                dark: SHIKI_THEME_DARK,
              },
            });
            const fresh: TokenizedCode = {
              bg: tokenResult.bg ?? "transparent",
              fg: tokenResult.fg ?? "inherit",
              tokens: tokenResult.tokens,
            };
            writeTokensToCache(tokensCacheKey, fresh);
            return fresh;
          })();
        const subs = subscribers.get(tokensCacheKey);
        if (subs) {
          for (const sub of subs) {
            sub(tokenized);
          }
          subscribers.delete(tokensCacheKey);
        }
      });
    })
    .catch(() => {
      const fallback = createRawTokens(code);
      writeTokensToCache(tokensCacheKey, fallback);
      const subs = subscribers.get(tokensCacheKey);
      if (subs) {
        for (const sub of subs) {
          sub(fallback);
        }
        subscribers.delete(tokensCacheKey);
      }
    });

  return null;
}

const LINE_NUMBER_CLASSES = cn(
  "block",
  "before:mr-4",
  "before:inline-block",
  "before:w-8",
  "before:text-right",
  "before:font-mono",
  "before:text-muted-foreground/50",
  "before:select-none",
  "before:content-[counter(line)]",
  "before:[counter-increment:line]",
);

function TokenSpan({ token }: { token: ThemedToken }) {
  return (
    <span
      className="dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)]"
      style={
        {
          backgroundColor: token.bgColor,
          color: token.color,
          fontStyle: isItalic(token.fontStyle) ? "italic" : undefined,
          fontWeight: isBold(token.fontStyle) ? "bold" : undefined,
          textDecoration: isUnderline(token.fontStyle) ? "underline" : undefined,
          ...token.htmlStyle,
        } as CSSProperties
      }
    >
      {token.content}
    </span>
  );
}

// 1.5.0 内测 bug3(思维链含代码块时流式极卡)根修之一:行级 memo。
// H-a 的增量分词器已让"分词"成本与代码总长解耦(已完成行的 token 数组引用稳定,
// 每帧只新建尾行),但旧渲染层 addKeysToTokens 每帧把所有行/token 重新包装成新对象,
// React 仍要逐帧协调整个代码块的全部 span(几百行 × 每行若干 token)——代码越长
// 每帧越贵,吃掉了增量分词攒下的全部预算。改为直接以行 token 数组为 prop 的 memo
// 组件:引用相等即跳过,每帧真正协调的只有正在生长的尾行。行号用索引作 key 与
// 语义一致(增量路径行只追加;全量重分词时引用全变,自然整体重画)。
const CodeLine = React.memo(function CodeLine({
  line,
  showLineNumbers,
}: {
  line: ThemedToken[];
  showLineNumbers: boolean;
}) {
  return (
    <span className={showLineNumbers ? LINE_NUMBER_CLASSES : "block"}>
      {line.length === 0
        ? "\n"
        : line.map((token, tokenIndex) => <TokenSpan key={tokenIndex} token={token} />)}
    </span>
  );
});

const CodeBlockBody = React.memo(
  ({
    className,
    showLineNumbers,
    tokenized,
    wrapLines,
  }: {
    className?: string;
    showLineNumbers: boolean;
    tokenized: TokenizedCode;
    wrapLines: boolean;
  }) => {
    const preStyle = React.useMemo(
      () => ({
        backgroundColor: tokenized.bg,
        color: tokenized.fg,
      }),
      [tokenized.bg, tokenized.fg],
    );

    return (
      <pre
        className={cn(
          "m-0 p-3 text-sm",
          wrapLines ? "whitespace-pre-wrap" : "whitespace-pre",
          className,
        )}
        style={preStyle}
      >
        <code
          className={cn(
            "font-mono leading-relaxed",
            showLineNumbers && "[counter-increment:line_0] [counter-reset:line]",
          )}
        >
          {tokenized.tokens.map((line, lineIndex) => (
            <CodeLine key={lineIndex} line={line} showLineNumbers={showLineNumbers} />
          ))}
        </code>
      </pre>
    );
  },
  (prevProps, nextProps) =>
    prevProps.className === nextProps.className &&
    prevProps.showLineNumbers === nextProps.showLineNumbers &&
    prevProps.wrapLines === nextProps.wrapLines &&
    prevProps.tokenized === nextProps.tokenized,
);

CodeBlockBody.displayName = "CodeBlockBody";

function CodeBlockContainer({
  className,
  language,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { language: string }) {
  return (
    <div
      className={cn("code-block group relative w-full overflow-hidden", className)}
      data-language={language}
      style={style}
      {...props}
    />
  );
}

// 无外壳高亮代码体:只渲染 shiki 高亮(字体/配色与正文代码块同源),不带头部
// 语言条/动作钮/卡片外观——整卡 CodeBlock 是正文组件,工具卡/抽屉等紧凑场景
// 复用此体。布局契约双轨:className 给包裹容器(限高/滚动/外距),preClassName
// 给 <pre> 本体(字号/内边距)——markdown.css 的 .code-block-content pre 是
// 非分层 CSS,preClassName 覆盖字号/内边距必须带 ! 前缀才压得过。
function CodeBlockContent({
  code,
  language,
  showLineNumbers = false,
  wrapLines = false,
  className,
  preClassName,
}: {
  code: string;
  language: BundledLanguage | null;
  showLineNumbers?: boolean;
  wrapLines?: boolean;
  className?: string;
  preClassName?: string;
}) {
  // bug3 根修之二:原文渲染路径(超长代码保险丝、高亮器装载期、渐进高亮的未上色尾部)
  // 的行数组按内容复用上一帧引用。旧实现每帧对全文重建所有行 → CodeLine 的引用 memo
  // 全部失效,超长代码块流式时仍是逐帧全量协调。复用后未变化的行引用稳定,与高亮
  // 路径享受同一条"每帧只协调尾行"的通道。(ref 在 useMemo 内更新:幂等,双调无害。)
  const rawLinesRef = React.useRef<{ source: string[]; lines: ThemedToken[][] }>({
    source: [],
    lines: [],
  });
  const rawTokens = React.useMemo<TokenizedCode>(() => {
    const source = code.split("\n");
    const previous = rawLinesRef.current;
    const lines = source.map((text, index) =>
      previous.source[index] === text
        ? previous.lines[index]!
        : text === ""
          ? []
          : [{ color: "inherit", content: text } as ThemedToken],
    );
    rawLinesRef.current = { source, lines };
    return { bg: "transparent", fg: "inherit", tokens: lines };
  }, [code]);
  const shouldHighlight = Boolean(language) && code.length <= MAX_SHIKI_CODE_LENGTH;

  // H-a(专题2):行级增量分词器,组件实例级。流式中的代码块每帧增长,全文缓存键
  // (lang+全文)永不命中,旧路径等于每帧全量重分词(12KB tsx 实测 ~40ms,单高亮一项
  // 超掉 33ms 帧预算)。增量器只重算未完成的尾行(实测 ~0.02ms),已完成行只分词一次。
  const tokenizerRef = React.useRef<{
    language: BundledLanguage;
    tokenizer: StreamingTokenizer;
  } | null>(null);
  const lastResultRef = React.useRef<{ cacheKey: string; result: TokenizedCode } | null>(null);

  // 同步高亮入口:全文缓存 → 增量分词器 → null(该语言高亮器尚未装载,走异步订阅)。
  const highlightSync = React.useCallback(
    (codeText: string, lang: BundledLanguage): TokenizedCode | null => {
      const cacheKey = getTokensCacheKey(codeText, lang);
      const cached = readTokensFromCache(cacheKey);
      if (cached) {
        // 命中全文缓存(静态块/Virtuoso 重挂载):无需增量器,也无需卸载时回写。
        tokenizerRef.current = null;
        lastResultRef.current = null;
        return cached;
      }
      const resolved = resolvedHighlighters.get(lang);
      if (!resolved) return null;
      let entry = tokenizerRef.current;
      if (!entry || entry.language !== lang) {
        entry = {
          language: lang,
          tokenizer: createStreamingTokenizer(resolved, lang, {
            light: SHIKI_THEME_LIGHT,
            dark: SHIKI_THEME_DARK,
          }),
        };
        tokenizerRef.current = entry;
      }
      const { result, wasFullTokenize } = entry.tokenizer.tokenize(codeText);
      // 只在"从零全量"时写全文缓存(静态块行为与旧实现一致)。增量帧不写——旧实现
      // 每帧写一条中间态条目,一次流式就把 200 条缓存全部挤掉(缓存污染)。
      if (wasFullTokenize) writeTokensToCache(cacheKey, result);
      lastResultRef.current = { cacheKey, result };
      return result;
    },
    [],
  );

  const [tokenized, setTokenized] = React.useState<TokenizedCode>(() => {
    if (!shouldHighlight || !language) {
      return rawTokens;
    }

    // 挂载首帧只读全文缓存(切回会话零闪烁);cache miss 不同步分词——由下方
    // effect 的空闲期调度完成,避免打开会话时多个代码块同帧串成长任务。
    return readTokensFromCache(getTokensCacheKey(code, language)) ?? rawTokens;
  });

  React.useEffect(() => {
    if (!shouldHighlight || !language) {
      setTokenized(rawTokens);
      return;
    }

    // 流式增量路径:实例级分词器已存在(该块正在逐帧增长),同步只重算尾行,
    // 逐帧高亮语义不变。
    if (tokenizerRef.current?.language === language) {
      const sync = highlightSync(code, language);
      if (sync) {
        setTokenized(sync);
        return;
      }
    } else {
      const cached = readTokensFromCache(getTokensCacheKey(code, language));
      if (cached) {
        tokenizerRef.current = null;
        lastResultRef.current = null;
        setTokenized(cached);
        return;
      }
    }

    // cache miss:分词推迟到空闲期,且大代码分片渐进——每个空闲片只喂一段前缀
    // (行边界对齐,~8KB)给增量分词器,已上色行立即可见、未处理尾部保持原文行。
    // 主线程不再出现整块分词长任务,任意长度代码都能最终全彩(取代旧的 12K 一刀
    // 切放弃高亮,也消灭了流式中途"彩色突然消失"的降级闪烁)。
    let cancelled = false;
    const tokensCacheKey = getTokensCacheKey(code, language);
    const onHighlighted = (result: TokenizedCode) => {
      if (!cancelled) {
        setTokenized(result);
      }
    };

    const feedChunk = (from: number) => {
      scheduleIdleHighlight(() => {
        if (cancelled) return;
        if (!resolvedHighlighters.get(language)) {
          // 高亮器未装载:走装载+订阅路径(装载完成后的分词依旧在空闲片里执行)。
          const nextTokenized = highlightCode(code, language, onHighlighted);
          if (nextTokenized) {
            setTokenized(nextTokenized);
          }
          return;
        }
        let end = code.length;
        if (from + HIGHLIGHT_CHUNK_CHARS < code.length) {
          const newline = code.indexOf("\n", from + HIGHLIGHT_CHUNK_CHARS);
          end = newline === -1 ? code.length : newline + 1;
        }
        const sync = highlightSync(code.slice(0, end), language);
        if (!sync) return;
        if (end >= code.length) {
          setTokenized(sync);
          return;
        }
        // 前缀以 \n 结尾:sync.tokens 的最后一项是空的"未完成行",丢弃它,
        // 用原文行补齐尾部,得到"上半彩色、下半原文"的渐进帧。
        const doneLines = sync.tokens.length - 1;
        setTokenized({
          bg: sync.bg,
          fg: sync.fg,
          tokens: [...sync.tokens.slice(0, doneLines), ...rawTokens.tokens.slice(doneLines)],
        });
        feedChunk(end);
      });
    };
    feedChunk(0);

    return () => {
      cancelled = true;
      const subs = subscribers.get(tokensCacheKey);
      subs?.delete(onHighlighted);
      if (subs && subs.size === 0) {
        subscribers.delete(tokensCacheKey);
      }
    };
  }, [code, language, rawTokens, shouldHighlight, highlightSync]);

  // 卸载时把最终 token 写回全文缓存:Virtuoso 滚动导致的卸载/重挂载零成本恢复高亮。
  React.useEffect(
    () => () => {
      const last = lastResultRef.current;
      if (last && tokenizerRef.current) {
        writeTokensToCache(last.cacheKey, last.result);
      }
    },
    [],
  );

  return (
    <div
      className={cn(
        "code-block-content relative",
        wrapLines ? "overflow-y-auto overflow-x-hidden" : "overflow-auto",
        className,
      )}
    >
      <CodeBlockBody
        className={cn("dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)]", preClassName)}
        showLineNumbers={showLineNumbers}
        tokenized={tokenized}
        wrapLines={wrapLines}
      />
    </div>
  );
}

// —— 头部动作按钮:纯图标、无文字(产品稿),悬停出 tooltip(title),操作成功短暂变对勾。——

type CodeBlockActionButtonProps = ComponentProps<typeof Button>;

function CodeBlockCopyButton({ className, ...props }: CodeBlockActionButtonProps) {
  const { t } = useTranslation("markdown");
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutRef = React.useRef<number>(0);
  const { code } = React.useContext(CodeBlockContext);

  const copyToClipboard = React.useCallback(async () => {
    if (isCopied) {
      return;
    }

    try {
      await copyTextToClipboard(code);
      setIsCopied(true);
      timeoutRef.current = window.setTimeout(() => {
        setIsCopied(false);
      }, 2000);
    } catch {
      toast.error(t("code_block.clipboard_not_available"));
    }
  }, [code, isCopied, t]);

  React.useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  return (
    <Button
      aria-label={t("code_block.copy_code")}
      title={t("code_block.copy_code")}
      className={cn("code-block-icon-button", className)}
      onClick={copyToClipboard}
      size="icon-xs"
      type="button"
      variant="ghost"
      {...props}
    >
      {isCopied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

function CodeBlockOpenButton({ className, ...props }: CodeBlockActionButtonProps) {
  const { t } = useTranslation("markdown");
  const { code, language } = React.useContext(CodeBlockContext);
  const [isOpened, setIsOpened] = React.useState(false);
  const timeoutRef = React.useRef<number>(0);

  const handleOpen = React.useCallback(async () => {
    if (isOpened) return;

    try {
      if (isDesktopShell()) {
        // 桌面壳:WebView2 吞掉 window.open(blob:),blob URL 也只在页面内有效。
        // 由后端把代码落盘为临时文件并用系统默认程序打开(.html → 默认浏览器)。
        await openCodePreviewFile(code, language);
      } else {
        const normalized = language.trim().toLowerCase();
        const mime =
          normalized === "html"
            ? "text/html;charset=utf-8"
            : normalized === "svg"
              ? "image/svg+xml;charset=utf-8"
              : "text/plain;charset=utf-8";
        const blob = new Blob([code], { type: mime });
        const url = window.URL.createObjectURL(blob);
        window.open(url, "_blank", "noopener,noreferrer");
        window.setTimeout(() => window.URL.revokeObjectURL(url), 60_000);
      }
      setIsOpened(true);
      timeoutRef.current = window.setTimeout(() => {
        setIsOpened(false);
      }, 2000);
    } catch {
      toast.error(t("code_block.open_failed"));
    }
  }, [code, isOpened, language, t]);

  React.useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  return (
    <Button
      aria-label={t("code_block.open_in_browser")}
      title={t("code_block.open_in_browser")}
      className={cn("code-block-icon-button", className)}
      onClick={handleOpen}
      size="icon-xs"
      type="button"
      variant="ghost"
      {...props}
    >
      {isOpened ? (
        <Check className="size-3.5 text-success" />
      ) : (
        <ExternalLink className="size-3.5" />
      )}
    </Button>
  );
}

function CodeBlockDownloadButton({ className, ...props }: CodeBlockActionButtonProps) {
  const { t } = useTranslation("markdown");
  const { code, language } = React.useContext(CodeBlockContext);
  const [isDownloaded, setIsDownloaded] = React.useState(false);
  const timeoutRef = React.useRef<number>(0);

  const handleDownload = React.useCallback(() => {
    if (isDownloaded) return;

    const fileName = toDownloadFileName(language);
    const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
    setIsDownloaded(true);
    timeoutRef.current = window.setTimeout(() => {
      setIsDownloaded(false);
    }, 2000);
    toast.success(t("code_block.downloaded_toast", { name: fileName }), {
      duration: 5000,
    });
  }, [code, isDownloaded, language, t]);

  React.useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  return (
    <Button
      aria-label={t("code_block.download_code")}
      title={t("code_block.download_code")}
      className={cn("code-block-icon-button", className)}
      onClick={handleDownload}
      size="icon-xs"
      type="button"
      variant="ghost"
      {...props}
    >
      {isDownloaded ? (
        <Check className="size-3.5 text-success" />
      ) : (
        <Download className="size-3.5" />
      )}
    </Button>
  );
}

// 预览/源码分段开关(产品稿右上角的胶囊切换)。生成中禁用:流式内容逐字增长,
// iframe 预览会疯狂重载。
function CodeBlockModeSwitch({
  mode,
  disabled,
  onModeChange,
}: {
  mode: "source" | "preview";
  disabled?: boolean;
  onModeChange: (mode: "source" | "preview") => void;
}) {
  const { t } = useTranslation("markdown");
  const options = [
    { value: "preview" as const, label: t("code_block.preview") },
    { value: "source" as const, label: t("code_block.source") },
  ];
  return (
    <div
      className={cn(
        "ml-1 flex shrink-0 items-center rounded-full bg-muted p-0.5",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          aria-pressed={mode === option.value}
          onClick={() => onModeChange(option.value)}
          className={cn(
            "rounded-full px-2 py-0.5 text-xs transition-colors",
            mode === option.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// Markdown 预览懒加载。必须是模块级单例:若在组件内 React.lazy,每个实例/每次
// 重挂载都是新的组件类型,Suspense 会重复走 fallback(预览闪加载态)。
const LazyMarkdown = React.lazy(() => import("./markdown"));

// 源码/预览共享同一固定块高(产品稿:无论内容多长,块最多这么大,内部滚动)。
// 两个字面量必须保持一致:body 是上限,iframe 撑满它。
const CODE_BLOCK_BODY_MAX_HEIGHT_CLASS = "max-h-[420px]";
const CODE_BLOCK_PREVIEW_IFRAME_HEIGHT_CLASS = "h-[420px]";

/** 高亮代码体(无头部/按钮/卡片外壳),供正文之外的紧凑场景(工具卡/抽屉)复用:
 *  字体与配色与正文代码块同源。布局双轨:className→包裹容器(限高/滚动),
 *  preClassName→<pre> 本体(字号/内边距,须 ! 前缀,见 CodeBlockContent 注)。 */
export function HighlightedCode({
  code,
  language,
  wrapLines = false,
  className,
  preClassName,
}: {
  code: string;
  language: string;
  wrapLines?: boolean;
  className?: string;
  preClassName?: string;
}) {
  const shikiLanguage = React.useMemo(() => resolveShikiLanguage(language), [language]);
  return (
    <CodeBlockContent
      code={code}
      language={shikiLanguage}
      wrapLines={wrapLines}
      className={className}
      preClassName={preClassName}
    />
  );
}

/** 正文代码块:卡片外壳+头部语言条+动作钮+高亮体(产品稿形态),消息正文专用。 */
export function CodeBlock({
  className,
  code,
  language,
  isAnimating = false,
  showLineNumbers = false,
  wrapLines = false,
  ...props
}: CodeBlockProps) {
  const { t } = useTranslation("markdown");
  const displayLanguage = language || "text";
  const previewLanguage = React.useMemo(() => getCodePreviewLanguage(language), [language]);
  const canPreview = Boolean(previewLanguage);
  const shikiLanguage = React.useMemo(() => resolveShikiLanguage(language), [language]);
  const contextValue = React.useMemo(
    () => ({ code, language: displayLanguage }),
    [code, displayLanguage],
  );

  // 生成中必须看源码(流式输出逐字增长,iframe/Markdown 预览会疯狂抖动/重载);
  // 可预览的块在非生成态默认直接呈现效果(产品语义:预览是完成态的常态)。初始值
  // 派生而非仅靠转换监听:citation/annotations 变化会让上游 components 换引用、
  // 本组件在生成结束瞬间被重挂载,新实例观察不到 isAnimating 的 true→false。
  const [mode, setMode] = React.useState<"source" | "preview">(() =>
    !isAnimating && canPreview ? "preview" : "source",
  );
  const prevAnimatingRef = React.useRef(isAnimating);
  React.useEffect(() => {
    if (isAnimating) {
      setMode("source");
    } else if (prevAnimatingRef.current && canPreview) {
      setMode("preview");
    }
    prevAnimatingRef.current = isAnimating;
  }, [isAnimating, canPreview]);

  const [collapsed, setCollapsed] = React.useState(false);

  // 流式贴底:和主对话一样,生成中的代码块内部滚动跟住最新输出。用户向上滚动即
  // 暂停跟随,滚回底部自动恢复(程序性 setScrollTop 触发的 scroll 事件会把 pinned
  // 重新算回 true,语义自洽)。
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const pinnedRef = React.useRef(true);
  const handleBodyScroll = React.useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 48;
  }, []);
  const showPreview = mode === "preview" && canPreview;
  React.useEffect(() => {
    if (!isAnimating || showPreview) return;
    const el = bodyRef.current;
    if (!el) return;
    const pin = () => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight;
    };
    pin();
    // 贴底时机必须跟着"内容实际长高"走:token 上色/新行插入发生在子组件自己的
    // effect 里,晚于本组件对 code 变化的感知一帧。ResizeObserver 在布局完成后
    // 回调,scrollHeight 已是最终值,不会永远差一截。
    const observer = new ResizeObserver(pin);
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, [isAnimating, showPreview]);

  const iframeDoc = React.useMemo(() => {
    if (!previewLanguage) return "";
    if (previewLanguage === "html" || previewLanguage === "svg") {
      return buildInlinePreviewDocument(code, previewLanguage);
    }
    if (previewLanguage === "mermaid") {
      const encodedCode = encodeURIComponent(code);
      return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      html, body { margin: 0; padding: 0; background: #ffffff; color: #1f2937; font-family: ui-sans-serif, system-ui, sans-serif; }
      #container { min-height: 100vh; box-sizing: border-box; padding: 16px; display: flex; justify-content: center; }
      #diagram { width: 100%; }
      #error { display: none; width: 100%; white-space: pre-wrap; color: #b91c1c; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 12px; font-size: 12px; }
    </style>
  </head>
  <body>
    <div id="container">
      <div id="diagram"></div>
      <pre id="error"></pre>
    </div>
    <script type="module">
      import mermaid from "https://esm.sh/mermaid@11";

      const source = decodeURIComponent("${encodedCode}");
      const diagram = document.getElementById("diagram");
      const errorEl = document.getElementById("error");

      mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
      try {
        const id = "mermaid-" + Math.random().toString(36).slice(2);
        const result = await mermaid.render(id, source.trim());
        if (diagram) diagram.innerHTML = result.svg;
      } catch (error) {
        if (errorEl) {
          errorEl.style.display = "block";
          errorEl.textContent = error instanceof Error ? error.message : String(error);
        }
      }
    </script>
  </body>
</html>`;
    }
    return "";
  }, [code, previewLanguage]);

  return (
    <CodeBlockContext.Provider value={contextValue}>
      <CodeBlockContainer className={className} language={displayLanguage} {...props}>
        <div className="code-block-header">
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-label={collapsed ? t("code_block.expand_code") : t("code_block.collapse_code")}
            title={collapsed ? t("code_block.expand_code") : t("code_block.collapse_code")}
            onClick={() => setCollapsed((current) => !current)}
            className="flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown
              data-export-ignore="true"
              className={cn("size-3.5 shrink-0 transition-transform duration-200", collapsed && "-rotate-90")}
            />
            <span className="code-block-language truncate">{displayLanguage}</span>
          </button>
          {/* code-block-actions:导出截图过滤器(share-export-dialog)按此类名排除交互按钮 */}
          <div className="code-block-actions flex shrink-0 items-center gap-0.5">
            <CodeBlockCopyButton />
            <CodeBlockOpenButton />
            <CodeBlockDownloadButton />
            {canPreview ? (
              <CodeBlockModeSwitch mode={mode} disabled={isAnimating} onModeChange={setMode} />
            ) : null}
          </div>
        </div>
        <div
          ref={bodyRef}
          onScroll={handleBodyScroll}
          className={cn(
            "code-block-body overflow-auto",
            CODE_BLOCK_BODY_MAX_HEIGHT_CLASS,
            collapsed && "hidden",
          )}
        >
          {showPreview ? (
            previewLanguage === "markdown" ? (
              <React.Suspense
                fallback={
                  <div className="flex h-[180px] items-center justify-center text-sm text-muted-foreground">
                    {t("code_block.preview_loading")}
                  </div>
                }
              >
                <div className="p-4">
                  <LazyMarkdown content={code} />
                </div>
              </React.Suspense>
            ) : (
              <iframe
                title={`${displayLanguage} preview`}
                sandbox="allow-scripts"
                srcDoc={iframeDoc}
                className={cn(
                  "block w-full border-0",
                  CODE_BLOCK_PREVIEW_IFRAME_HEIGHT_CLASS,
                )}
              />
            )
          ) : (
            <CodeBlockContent
              code={code}
              language={shikiLanguage}
              showLineNumbers={showLineNumbers}
              wrapLines={wrapLines}
            />
          )}
        </div>
      </CodeBlockContainer>
    </CodeBlockContext.Provider>
  );
}
