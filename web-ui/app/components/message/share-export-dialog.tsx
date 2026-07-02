import * as React from "react";
import { useTranslation } from "react-i18next";
import { FileDown, Image as ImageIcon, Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { ExportedImage } from "./exported-image";
import { captureNodeAsPng, downloadDataUrl } from "~/lib/capture";
import {
  convertMessagesToMarkdown,
  downloadMarkdown,
  safeMarkdownFilename,
} from "~/lib/export-markdown";
import type { MessageDto } from "~/types";

// 导出截图时排除: code-block 的复制/下载/预览按钮 (纯交互元素, 出现在图里是噪音),
// 以及显式标记 data-export-ignore 的节点、display:none 的节点。
function exportImageFilter(node: Node): boolean {
  if (!(node instanceof HTMLElement)) return true;
  if (node.closest(".code-block-actions")) return false;
  if (node.dataset.exportIgnore === "true") return false;
  if (window.getComputedStyle(node).display === "none") return false;
  return true;
}

interface ShareExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messages: MessageDto[];
  title: string;
}

export function ShareExportDialog({
  open,
  onOpenChange,
  messages,
  title,
}: ShareExportDialogProps) {
  const { t } = useTranslation("message");
  const [expandReasoning, setExpandReasoning] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [mdExporting, setMdExporting] = React.useState(false);
  const imageRef = React.useRef<HTMLDivElement>(null);

  const handleExportMarkdown = async () => {
    if (mdExporting) return;
    setMdExporting(true);
    const filename = safeMarkdownFilename(title || "conversation");
    try {
      // convertMessagesToMarkdown 会把每张图 fetch 成 base64 内联,图片多/大时可能要几秒
      const content = await convertMessagesToMarkdown(messages, expandReasoning, title);
      downloadMarkdown(content, filename);
      toast.success(t("chat_message.export_success_md"), {
        description: t("chat_message.export_success_desc", { filename }),
        duration: 7000,
      });
      onOpenChange(false);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("chat_message.export_image_failed", "导出失败"),
      );
    } finally {
      setMdExporting(false);
    }
  };

  const handleExportImage = async () => {
    if (!imageRef.current || exporting) return;
    setExporting(true);
    // CodeBlock 的 shiki 代码高亮靠 html.dark class 切换暗/亮 (dark:!bg-[var(--shiki-dark-bg)]),
    // 不是 CSS 变量 —— ExportedImage 根部的浅色变量覆盖不到它。截图前临时摘掉 html.dark,
    // 让代码块走浅色主题 (catppuccin-latte), 截完恢复。浅色模式用户无影响 (wasDark=false)。
    const root = document.documentElement;
    const wasDark = root.classList.contains("dark");
    if (wasDark) root.classList.remove("dark");
    try {
      // 等 CSS 重算 + shiki 浅色主题生效 + 远程图片加载。captureNodeAsPng 内部再等 fonts.ready。
      await new Promise((resolve) => setTimeout(resolve, 350));
      const dataUrl = await captureNodeAsPng(imageRef.current, {
        backgroundColor: "#ffffff",
        filter: exportImageFilter,
      });
      const filename = safeMarkdownFilename(title || "conversation").replace(/\.md$/, ".png");
      downloadDataUrl(dataUrl, filename);
      toast.success(t("chat_message.export_success_image"), {
        description: t("chat_message.export_success_desc", { filename }),
        duration: 7000,
      });
      onOpenChange(false);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("chat_message.export_image_failed", "导出图片失败"),
      );
    } finally {
      if (wasDark) root.classList.add("dark");
      setExporting(false);
    }
  };

  return (
    <>
      {/* 离屏渲染: 备截图。open 时挂载, 给 Markdown / shiki / 字体留渲染时间。
          放到视口外 (left: -99999px) 而非 display:none —— 后者会让节点无布局, html-to-image 拿不到尺寸。 */}
      {open ? (
        <div
          aria-hidden
          style={{ position: "fixed", left: -99999, top: 0, pointerEvents: "none" }}
        >
          <ExportedImage
            ref={imageRef}
            title={title}
            messages={messages}
            expandReasoning={expandReasoning}
          />
        </div>
      ) : null}

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("chat_message.share_dialog_title", "分享对话")}</DialogTitle>
            <DialogDescription>
              {t("chat_message.share_dialog_desc", "选择导出格式", {
                count: messages.length,
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 py-2">
            <Button
              variant="outline"
              className="justify-start"
              onClick={handleExportMarkdown}
              disabled={mdExporting}
            >
              {mdExporting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <FileDown className="size-4" />
              )}
              {t("chat_message.export_markdown", "导出为 Markdown")}
            </Button>

            <div className="rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <ImageIcon className="size-4" />
                  {t("chat_message.export_image", "导出为图片")}
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                  {t("chat_message.expand_reasoning", "展开思考")}
                  <Switch
                    checked={expandReasoning}
                    onCheckedChange={setExpandReasoning}
                  />
                </label>
              </div>
              <Button className="mt-3 w-full" onClick={handleExportImage} disabled={exporting}>
                {exporting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ImageIcon className="size-4" />
                )}
                {exporting
                  ? t("chat_message.exporting_image", "正在生成图片...")
                  : t("chat_message.export_image_btn", "导出图片")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
