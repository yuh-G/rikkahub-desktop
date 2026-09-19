import * as React from "react";
import { Streamdown, type PluginConfig } from "streamdown";
import { cjk } from "@streamdown/cjk";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { cn } from "~/lib/utils";
import { useSettingsStore } from "~/stores";
import { CodeBlock } from "./code-block";
import { MarkdownTable } from "./table";
import {
  advanceFrozenPrefix,
  EMPTY_FROZEN_PREFIX,
  tailRenderIntervalMs,
  type FrozenPrefix,
} from "./frozen-prefix";
import "katex/dist/katex.min.css";
import "./markdown.css";
import "streamdown/styles.css";

// 批次二 R7-1(P1):不再覆盖 rehypePlugins。Streamdown 默认管线 = raw → sanitize
// (defaultSchema)→ harden,是它专为"渲染不可信 LLM 输出"内置的消毒防线;此前传入
// [rehypeKatex, rehypeRaw] 把整条防线替换掉了——正文里的原始 HTML 解析后既不消毒也不
// 加固,<img onerror>/<iframe>/javascript: 链接直通(消息正文、翻译块、跨端导入/分享
// 的会话都经此渲染)。数学改走官方 plugins.math 口子:remarkPlugin 追加在 remark 链末
// 解析 $..$;rehypePlugin 追加在 sanitize/harden 之后渲染 KaTeX。数学节点以
// <code class="language-math">(defaultSchema 放行 language-* 类)穿过消毒,块级公式由
// pre>code 结构判定 display,KaTeX 产物(span/MathML/内联 style)生成于消毒之后不会被
// 剥。remark 默认已含 gfm,无需再传。
// 对象须为模块级常量:Streamdown 的 memo 按引用比较 plugins,内联字面量会让流式渲染
// 每个 token delta 都重建整棵 Markdown 树。
const STREAMDOWN_PLUGINS: PluginConfig = {
  cjk,
  math: { name: "katex", type: "math", remarkPlugin: remarkMath, rehypePlugin: rehypeKatex },
};

// controls/linkSafety 会进 Streamdown 的内部 context;内联字面量每次渲染都是新引用,
// context 值恒变会穿透其块级 memo,逼所有 context 消费者(表格包装等)逐帧重渲。
// linkSafety 必须显式传稳定引用:不传时上游用默认参数 {enabled:true},每次渲染同样
// 新建对象,一样击穿 context memo(已核实 dist 实现)。
const STREAMDOWN_CONTROLS = { code: false, mermaid: false } as const;
const STREAMDOWN_LINK_SAFETY = { enabled: true } as const;

// Regex patterns for preprocessing
const INLINE_LATEX_REGEX = /\\\((.+?)\\\)/g;
const BLOCK_LATEX_REGEX = /\\\[(.+?)\\\]/gs;
const CODE_BLOCK_REGEX = /```[\s\S]*?```|`[^`\n]*`/g;
// 块级 LaTeX 内部换行会让 KaTeX 渲染失败。对齐安卓
// commit 95bef6de，把块公式里的换行（含周围空白）压成单个空格。
const LATEX_BLOCK_LINE_BREAK_REGEX = /[ \t]*\r?\n[ \t]*/g;

// Preprocess markdown content
function preProcess(content: string): string {
  // Find all code block positions
  const codeBlocks: { start: number; end: number }[] = [];
  let match;
  const codeBlockRegex = new RegExp(CODE_BLOCK_REGEX.source, "g");
  while ((match = codeBlockRegex.exec(content)) !== null) {
    codeBlocks.push({ start: match.index, end: match.index + match[0].length });
  }

  // Check if position is inside a code block
  const isInCodeBlock = (position: number): boolean => {
    return codeBlocks.some((range) => position >= range.start && position < range.end);
  };

  // Replace inline formulas \( ... \) to $ ... $, skip code blocks
  let result = content.replace(
    new RegExp(INLINE_LATEX_REGEX.source, "g"),
    (match, group1, offset) => {
      if (isInCodeBlock(offset)) {
        return match;
      }
      return `$${group1}$`;
    },
  );

  // Replace block formulas \[ ... \] to $$ ... $$, skip code blocks
  result = result.replace(new RegExp(BLOCK_LATEX_REGEX.source, "gs"), (match, group1, offset) => {
    if (isInCodeBlock(offset)) {
      return match;
    }
    const formula = String(group1).trim().replace(LATEX_BLOCK_LINE_BREAK_REGEX, " ");
    return `$$${formula}$$`;
  });

  result = result.replace(
    /(?<![A-Za-z0-9_])\[?\s*citation\s*[:：]?\s*([A-Za-z]?\d+)\s*\]?/gi,
    (match, id, offset) => {
      if (isInCodeBlock(offset)) return match;
      return `[citation,source](#${String(id).replace(/^s/i, "")})`;
    },
  );

  // 批次二 R7-1:citation 链接统一改写成 fragment 形态(#id)。默认管线末端的
  // rehype-harden 只放行可解析的 URL,citation 的 href 是内部 id(如 "42"/"8905cd"),
  // 裸相对形态会被替换成 "[blocked]" 占位节点,a 组件根本收不到。fragment 是 harden
  // 显式放行的形态。除上面刚生成的以外,还要覆盖 LLM 按搜索提示词直接输出在正文里的
  // [citation,domain](id);(?!#) 保证幂等。
  return result.replace(
    /\[citation,([^\]]*)\]\((?!#)([^)\s]+)\)/g,
    (match, domain, id, offset) =>
      isInCodeBlock(offset) ? match : `[citation,${domain}](#${id})`,
  );
}

// 巨型活动尾部的自适应重渲节奏:档位与依据见 frozen-prefix.ts tailRenderIntervalMs。
// 逐帧档(间隔 0)直接透传 prop,不经 state;节流档把最新尾部暂存 ref,按间隔批量
// 提交——生成结束(isAnimating=false)或尾部缩回小体量(块晋升)即回到透传。
function useAdaptiveTail(tail: string, isAnimating: boolean): string {
  const [displayed, setDisplayed] = React.useState(tail);
  const tailRef = React.useRef(tail);
  tailRef.current = tail;
  const lastCommitRef = React.useRef(0);
  const timerRef = React.useRef<number | null>(null);

  const intervalMs = isAnimating ? tailRenderIntervalMs(tail.length) : 0;

  React.useEffect(() => {
    if (intervalMs === 0) return;
    const commit = () => {
      timerRef.current = null;
      lastCommitRef.current = performance.now();
      setDisplayed(tailRef.current);
    };
    const sinceLast = performance.now() - lastCommitRef.current;
    if (sinceLast >= intervalMs) {
      commit();
      return;
    }
    if (timerRef.current === null) {
      timerRef.current = window.setTimeout(commit, intervalMs - sinceLast);
    }
  }, [tail, intervalMs]);
  React.useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return intervalMs === 0 ? tail : displayed;
}

// 流式前缀冻结:每帧渲染成本从 O(全文) 降到 O(活动尾部)。纯函数核心与保守锚点见
// frozen-prefix.ts,此处只做 ref 载体。渲染期推进 ref 是幂等推导((旧值, content) →
// 新值),StrictMode 双调安全(同 code-block.tsx rawLinesRef 先例)。
function useFrozenPrefix(content: string, isAnimating: boolean): FrozenPrefix {
  const ref = React.useRef<FrozenPrefix>(EMPTY_FROZEN_PREFIX);
  if (!isAnimating) {
    ref.current = EMPTY_FROZEN_PREFIX;
    return EMPTY_FROZEN_PREFIX;
  }
  ref.current = advanceFrozenPrefix(ref.current, content, preProcess);
  return ref.current;
}

type MarkdownProps = {
  content: string;
  className?: string;
  onClickCitation?: (id: string) => void;
  /**
   * Optional map of citation id → 1-based display ordinal. When set, `[citation,domain](id)`
   * badges show the ordinal (e.g. `[1]`) instead of the raw id (e.g. `8905cd`). Built by
   * the message renderer from the message's annotations + search tool outputs.
   */
  citationOrdinalMap?: Map<string, number>;
  isAnimating?: boolean;
};

function getNodeText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(getNodeText).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return getNodeText(node.props.children);
  }
  return "";
}

export default function Markdown({
  content,
  className,
  onClickCitation,
  citationOrdinalMap,
  isAnimating = false,
}: MarkdownProps) {
  const displaySetting = useSettingsStore((state) => state.settings?.displaySetting);
  const frozenPrefix = useFrozenPrefix(content, isAnimating);
  const rawTail = frozenPrefix.raw ? content.slice(frozenPrefix.raw.length) : content;
  // 巨型尾部(无增量通道的生长大块)自适应降频;小尾部与完成态原样逐帧透传
  const activeTail = useAdaptiveTail(rawTail, isAnimating);
  // 流式中只预处理活动尾部(前缀的预处理产物随晋升增量累积,见 frozen-prefix.ts);
  // 完成态前缀恒为空,此处即整文,与旧管线逐字节一致。
  const processedTail = React.useMemo(() => preProcess(activeTail), [activeTail]);

  // Streamdown 的 custom components 提到 useMemo:流式输出时 Markdown 每个 token delta 都会
  // re-render,内联的 components 对象每次都是新引用,Streamdown 内部 memo 失效、重建自定义
  // 组件实例。稳定引用后只在实际依赖(displaySetting/isAnimating/citation 等)变化时才重建。
  // 返回类型从 Streamdown 自身推断,避免函数参数失去上下文变成隐式 any。
  const components = React.useMemo<
    NonNullable<Parameters<typeof Streamdown>[0]["components"]>
  >(
    () => ({
      pre: ({ children }) => <>{children}</>,
      // 表格覆盖(issue #58):替换 Streamdown 内置表格(其复制走 navigator.clipboard.write,
      // 非安全上下文不可用且无回退)。thead/tbody/tr/th/td 不覆盖,沿用 markdown.css 样式。
      table: ({ children, className }) => <MarkdownTable className={className}>{children}</MarkdownTable>,
      code: ({ className, children, ...props }) => {
        const match = /language-([A-Za-z0-9_-]+)/.exec(className || "");
        const code = String(children).replace(/\n$/, "");
        const isBlock = code.includes("\n");

        if (match || isBlock) {
          const language = match?.[1] || "";
          return (
            <CodeBlock
              language={language}
              code={code}
              isAnimating={isAnimating}
              showLineNumbers={displaySetting?.showLineNumbers ?? false}
              wrapLines={displaySetting?.codeBlockAutoWrap ?? false}
            />
          );
        }

        return (
          <code className="inline-code" {...props}>
            {children}
          </code>
        );
      },
      a: ({ href, children, ...props }) => {
        const childText = getNodeText(children).trim();

        // Citation format: [citation,domain](#id) —— preProcess 统一改写成 fragment
        // 形态以穿过 rehype-harden,这里剥掉 # 还原内部 id。
        if (childText.startsWith("citation,")) {
          const domain = childText.substring("citation,".length);
          const id = (href || "").trim().replace(/^#/, "").replace(/^s/i, "");
          // Prefer the ordinal (1-based position) from the message's annotation/tool-output
          // list — that's the user-facing "[1]" / "[2]" label they expect. Falls back to
          // the raw id (e.g. Android's 6-char hex `8905cd`) if no mapping is available.
          const ordinal = citationOrdinalMap?.get(id);
          const displayId = ordinal !== undefined ? String(ordinal) : id.replace(/^s/i, "");

          if (id && onClickCitation) {
            return (
              <button
                type="button"
                className="citation-badge"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onClickCitation?.(id);
                }}
                title={domain}
              >
                {displayId || domain.replace(/^s/i, "")}
              </button>
            );
          }

          if (href) {
            return (
              <a
                className="citation-badge"
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                title={domain}
                {...props}
              >
                {displayId || domain}
              </a>
            );
          }
        }

        return (
          <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
            {children}
          </a>
        );
      },
    }),
    [
      displaySetting,
      isAnimating,
      citationOrdinalMap,
      onClickCitation,
    ],
  );

  return (
    <div className={cn("markdown", className)}>
      {frozenPrefix.raw ? (
        <Streamdown
          plugins={STREAMDOWN_PLUGINS}
          animated={false}
          isAnimating={isAnimating}
          // 冻结前缀走 streaming 形态的块级 memo 通道、关掉 remend(前缀只含完整块):
          // 晋升时仅新增块真正解析(Block 按 content+index 命中);其余帧前缀字符串不变,
          // Streamdown 自身 memo 整树跳过。不用 static 形态——它是整文单次 ReactMarkdown,
          // 每次晋升都会重解析整个前缀。
          mode="streaming"
          parseIncompleteMarkdown={false}
          controls={STREAMDOWN_CONTROLS}
          linkSafety={STREAMDOWN_LINK_SAFETY}
          components={components}
        >
          {frozenPrefix.processed}
        </Streamdown>
      ) : null}
      <Streamdown
        plugins={STREAMDOWN_PLUGINS}
        animated={false}
        isAnimating={isAnimating}
        // 完成态消息走 static 模式:跳过 remend(流式截断修补,每次渲染对全文扫描,
        // 实测占单条消息渲染成本的 ~60%)与 useTransition 状态机。历史消息批量挂载
        // (打开会话首帧 ~10 条)直接受益;流式中的消息保持 streaming 语义不变。
        // 中途终止的残破 markdown(未闭合围栏等)从“静默修补”变为按原文渲染——与安卓
        // 端完成态渲染行为一致。
        mode={isAnimating ? "streaming" : "static"}
        controls={STREAMDOWN_CONTROLS}
        linkSafety={STREAMDOWN_LINK_SAFETY}
        components={components}
      >
        {processedTail}
      </Streamdown>
    </div>
  );
}
