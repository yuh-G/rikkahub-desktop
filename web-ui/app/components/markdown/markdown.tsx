import * as React from "react";
import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import { cn } from "~/lib/utils";
import { getCodePreviewLanguage } from "~/components/workbench/code-preview-language";
import { useOptionalWorkbench } from "~/components/workbench/workbench-context";
import { useSettingsStore } from "~/stores";
import { CodeBlock } from "./code-block";
import "katex/dist/katex.min.css";
import "./markdown.css";
import "streamdown/styles.css";

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

  return result.replace(
    /(?<![A-Za-z0-9_])\[?\s*citation\s*[:：]?\s*([A-Za-z]?\d+)\s*\]?/gi,
    (match, id, offset) => {
      if (isInCodeBlock(offset)) return match;
      return `[citation,source](${String(id).replace(/^s/i, "")})`;
    },
  );
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
  allowCodePreview?: boolean;
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
  allowCodePreview = true,
  isAnimating = false,
}: MarkdownProps) {
  const { t } = useTranslation("markdown");
  const workbench = useOptionalWorkbench();
  const displaySetting = useSettingsStore((state) => state.settings?.displaySetting);
  const processedContent = React.useMemo(() => preProcess(content), [content]);
  const handlePreviewCode = React.useCallback(
    (language: string, code: string) => {
      if (!allowCodePreview || !workbench) return;

      const previewLanguage = getCodePreviewLanguage(language);
      if (!previewLanguage) return;

      workbench.openPanel({
        type: "code-preview",
        title: t("markdown.code_preview_title", {
          language: previewLanguage.toUpperCase(),
        }),
        payload: {
          language: previewLanguage,
          code,
        },
      });
    },
    [allowCodePreview, t, workbench],
  );

  // Streamdown 的 custom components 提到 useMemo:流式输出时 Markdown 每个 token delta 都会
  // re-render,内联的 components 对象每次都是新引用,Streamdown 内部 memo 失效、重建自定义
  // 组件实例。稳定引用后只在实际依赖(displaySetting/workbench/citation 等)变化时才重建。
  // 返回类型从 Streamdown 自身推断,避免函数参数失去上下文变成隐式 any。
  const components = React.useMemo<
    NonNullable<Parameters<typeof Streamdown>[0]["components"]>
  >(
    () => ({
      pre: ({ children }) => <>{children}</>,
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
              showLineNumbers={displaySetting?.showLineNumbers ?? false}
              wrapLines={displaySetting?.codeBlockAutoWrap ?? false}
              onPreview={
                allowCodePreview && workbench
                  ? () => {
                      handlePreviewCode(language, code);
                    }
                  : undefined
              }
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

        // Citation format: [citation,domain](id)
        if (childText.startsWith("citation,")) {
          const domain = childText.substring("citation,".length);
          const id = (href || "").trim().replace(/^s/i, "");
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
      workbench,
      allowCodePreview,
      handlePreviewCode,
      citationOrdinalMap,
      onClickCitation,
    ],
  );

  return (
    <div className={cn("markdown", className)}>
      <Streamdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeRaw]}
        plugins={{ cjk: cjk }}
        animated={false}
        isAnimating={isAnimating}
        controls={{ code: false, mermaid: false }}
        components={components}
      >
        {processedContent}
      </Streamdown>
    </div>
  );
}
