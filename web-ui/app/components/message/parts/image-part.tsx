import * as React from "react";
import { CheckCircle2, Download, ImageOff, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "~/components/ui/dialog";
import { resolveFileUrl } from "~/lib/files";
import { fileExtensionFromMime } from "~/lib/image-download";

interface ImagePartProps {
  url: string;
  metadata?: Record<string, unknown> | null;
}

function OcrStatus({ metadata }: { metadata?: Record<string, unknown> | null }) {
  const status = typeof metadata?.ocrStatus === "string" ? metadata.ocrStatus : "";
  if (!status) return null;
  if (status === "pending") {
    return (
      <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <LoaderCircle className="size-3 animate-spin" />
        <span>正在 OCR 识别图片...</span>
      </div>
    );
  }
  if (status === "done") {
    return (
      <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <CheckCircle2 className="size-3 text-emerald-500" />
        <span>OCR 已完成</span>
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className="mt-1 flex items-center gap-1.5 text-xs text-destructive">
        <TriangleAlert className="size-3" />
        <span>OCR 识别失败</span>
      </div>
    );
  }
  return null;
}

async function downloadImage(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载图片失败：${response.status}`);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = `rikkahub-image-${Date.now()}.${fileExtensionFromMime(blob.type)}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export function ImagePart({ url, metadata }: ImagePartProps) {
  const [error, setError] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const imageUrl = resolveFileUrl(url);

  if (!url) return null;

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <ImageOff className="h-4 w-4" />
        <span>Failed to load image: {resolveFileUrl(url)}</span>
      </div>
    );
  }

  return (
    <>
      <div className="relative my-2 max-w-md">
        {!loaded && (
          <div className="flex h-48 items-center justify-center rounded-md border border-muted bg-muted/30">
            <div className="text-sm text-muted-foreground">Loading image...</div>
          </div>
        )}
        <button
          type="button"
          className={loaded ? "block cursor-zoom-in rounded-md text-left transition hover:brightness-95" : "hidden"}
          onClick={() => setPreviewOpen(true)}
          aria-label="预览图片"
        >
          <img
            src={imageUrl}
            alt="Message attachment"
            className="rounded-md border border-muted object-contain"
            onLoad={() => setLoaded(true)}
            onError={() => setError(true)}
            style={{ maxHeight: "500px", width: "auto" }}
          />
        </button>
        {!loaded ? (
          <img
            src={imageUrl}
            alt="Message attachment"
            className="hidden"
            onLoad={() => setLoaded(true)}
            onError={() => setError(true)}
          />
        ) : null}
        <OcrStatus metadata={metadata} />
      </div>
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[92vh] max-w-[92vw] border-0 bg-background/95 p-0 shadow-2xl backdrop-blur">
          <DialogTitle className="sr-only">图片预览</DialogTitle>
          <div className="flex items-center justify-end gap-2 border-b px-3 py-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="下载图片"
              title="下载图片"
              onClick={() => {
                void downloadImage(imageUrl).catch((downloadError) => {
                  toast.error(downloadError instanceof Error ? downloadError.message : "下载图片失败");
                });
              }}
            >
              <Download className="size-4" />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭预览" title="关闭预览" onClick={() => setPreviewOpen(false)}>
              <X className="size-4" />
            </Button>
          </div>
          <div className="flex max-h-[calc(92vh-48px)] items-center justify-center overflow-auto bg-muted/20 p-3">
            <img src={imageUrl} alt="Message attachment preview" className="max-h-[calc(92vh-72px)] max-w-full object-contain" />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
