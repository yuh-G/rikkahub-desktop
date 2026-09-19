// markdown/table.tsx — 表格覆盖组件(issue #58 治本)
//
// Streamdown 内置表格的复制走 navigator.clipboard.write(text/plain + text/html 富表格),
// 非安全上下文(Docker 裸 IP http://<host>:8080)该 API 是 undefined,复制按钮点了没反应、
// success 态永久卡住;其 toolbar 绝对定位在表格无 <pre> 包裹时漂移(「按钮文字错位」)。
// 这里整体覆盖 components.table(内置 toolbar 随之一并不渲染),复制改走 copyTextToClipboard
// (自动回退 execCommand),粘贴形态取纯文本 TSV——Excel/Sheets/聊天框直接成表,且在非安全
// 上下文也能复制。thead/tbody/tr/th/td 不覆盖,沿用 markdown.css 的元素选择器样式。
//
// 从渲染后的 DOM 提文本(而非原始 markdown):DOM 是 markdown 解析/消毒/rehype 后的唯一真值,
// 流式中的残缺表格也按当前所见复制,无需重解析。

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import { copyTextToClipboard } from "~/lib/clipboard";
import { cn } from "~/lib/utils";

/** 把 <table> 元素序列化成 TSV(单元格 \t 连、行 \n 连)。 */
function tableToTsv(table: HTMLTableElement): string {
  const rows: string[] = [];
  for (const tr of Array.from(table.querySelectorAll("tr"))) {
    const cells = Array.from(tr.querySelectorAll("th, td")).map((cell) =>
      // 单元格内换行/制表符会撞 TSV 结构,压成空格(与 Streamdown 内置序列化同策略)。
      (cell.textContent ?? "").replace(/\s+/g, " ").trim(),
    );
    if (cells.length > 0) rows.push(cells.join("\t"));
  }
  return rows.join("\n");
}

type MarkdownTableProps = React.ComponentProps<"table">;

export function MarkdownTable({ children, className, ...props }: MarkdownTableProps) {
  const { t } = useTranslation("markdown");
  const tableRef = React.useRef<HTMLTableElement | null>(null);
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutRef = React.useRef<number>(0);

  const handleCopy = React.useCallback(async () => {
    const table = tableRef.current;
    if (!table || isCopied) return;
    try {
      await copyTextToClipboard(tableToTsv(table));
      setIsCopied(true);
      timeoutRef.current = window.setTimeout(() => setIsCopied(false), 2000);
    } catch {
      toast.error(t("code_block.clipboard_not_available"));
    }
  }, [isCopied, t]);

  React.useEffect(() => () => window.clearTimeout(timeoutRef.current), []);

  return (
    <div className="my-4 flex flex-col gap-1.5">
      <div className="flex items-center justify-end">
        <Button
          aria-label={t("table.copy")}
          title={t("table.copy")}
          className="code-block-icon-button"
          onClick={handleCopy}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          {isCopied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
      <div className="overflow-x-auto">
        {/* markdown.css 的 `.markdown table` 元素选择器已带 my-4/边框/圆角;覆盖层去掉自身
            my-4 以免与外层 wrapper 的间距叠加,其余样式不变。 */}
        <table ref={tableRef} className={cn("!my-0", className)} {...props}>
          {children}
        </table>
      </div>
    </div>
  );
}
