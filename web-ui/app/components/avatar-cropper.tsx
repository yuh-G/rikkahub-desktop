import * as React from "react";
import { useTranslation } from "react-i18next";

import { Camera, Loader2, RotateCcw, RotateCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Slider } from "~/components/ui/slider";
import { UIAvatar } from "~/components/ui/ui-avatar";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import type { AssistantAvatar } from "~/types";

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 3;

/**
 * 可点击更换的头像:头像本身就是按钮(悬停压暗 + 相机图标),选图后进裁剪框;当前不是默认头像
 * 时旁边给一颗「恢复默认」。avatarClassName 控制头像尺寸(默认 56px)。bare:只渲染头像本身
 * (嵌进详情标题行时用,「恢复默认」由调用方放在合适位置)。
 */
export function AvatarCropper({
  value,
  fallbackName,
  onChange,
  avatarClassName,
  hint = true,
  bare = false,
}: {
  value?: AssistantAvatar | null;
  fallbackName: string;
  onChange: (avatar: AssistantAvatar) => void | Promise<void>;
  avatarClassName?: string;
  /** 是否在头像旁显示「点击更换头像」说明(空间紧时关掉,悬停提示仍在)。 */
  hint?: boolean;
  bare?: boolean;
}) {
  const { t } = useTranslation("common");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const stageRef = React.useRef<HTMLDivElement>(null);
  const [open, setOpen] = React.useState(false);
  const [source, setSource] = React.useState<string | null>(null);
  const [image, setImage] = React.useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = React.useState(1);
  const [offset, setOffset] = React.useState({ x: 0, y: 0 });
  const [rotation, setRotation] = React.useState(0);
  const [dragging, setDragging] = React.useState<{ x: number; y: number } | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  const isDefault = !value || value.type === "dummy";

  React.useEffect(() => {
    if (!source) return;
    const img = new Image();
    img.onload = () => setImage(img);
    img.src = source;
  }, [source]);

  // 透明底:缩小到不满圆时露出的部分由舞台底色衬托,导出的 PNG 也不带写死的底色。
  const draw = React.useCallback(
    (targetSize = 320) => {
      const canvas = canvasRef.current;
      if (!canvas || !image) return null;
      canvas.width = targetSize;
      canvas.height = targetSize;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.clearRect(0, 0, targetSize, targetSize);
      ctx.save();
      // 拖拽偏移以 320px 舞台为单位,导出放大时等比换算。
      const ratio = targetSize / 320;
      ctx.translate(targetSize / 2 + offset.x * ratio, targetSize / 2 + offset.y * ratio);
      ctx.rotate((rotation * Math.PI) / 180);
      const scale = (targetSize / Math.min(image.width, image.height)) * zoom;
      ctx.drawImage(image, (-image.width * scale) / 2, (-image.height * scale) / 2, image.width * scale, image.height * scale);
      ctx.restore();
      return canvas;
    },
    [image, offset.x, offset.y, rotation, zoom],
  );

  React.useEffect(() => {
    draw();
  }, [draw]);

  // 滚轮缩放:React 的 onWheel 是被动监听,preventDefault 无效(会连带滚动对话框),故挂原生监听。
  React.useEffect(() => {
    const stage = stageRef.current;
    if (!open || !stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom((old) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, old * (event.deltaY < 0 ? 1.08 : 1 / 1.08))));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [open, image]);

  const chooseFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setSource(String(reader.result));
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      setRotation(0);
      setOpen(true);
    };
    reader.readAsDataURL(file);
  };

  const confirm = async () => {
    const canvas = draw(512);
    if (!canvas) return;
    setSaving(true);
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png", 0.95));
      if (!blob) throw new Error(t("avatar_cropper.process_failed"));
      const form = new FormData();
      form.append("files", new File([blob], "avatar.png", { type: "image/png" }));
      const result = await api.postMultipart<{ files: Array<{ url: string }> }>("files/upload", form);
      const url = result.files[0]?.url;
      if (!url) throw new Error(t("avatar_cropper.upload_failed"));
      await onChange({ type: "url", url });
      setOpen(false);
      toast.success(t("avatar_cropper.saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("avatar_cropper.upload_failed"));
    } finally {
      setSaving(false);
      draw();
    }
  };

  const reset = async () => {
    setResetting(true);
    try {
      await onChange({ type: "dummy" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("avatar_cropper.upload_failed"));
    } finally {
      setResetting(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          aria-label={t("avatar_cropper.click_to_change")}
          title={t("avatar_cropper.click_to_change")}
          className="group/avatar-pick relative shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <UIAvatar size="lg" name={fallbackName} avatar={value} className={cn("size-14", avatarClassName)} />
          <span
            aria-hidden
            className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 text-white opacity-0 transition-opacity duration-(--ds-duration-fast) ease-(--ds-ease-swift) group-hover/avatar-pick:opacity-100 group-focus-visible/avatar-pick:opacity-100"
          >
            <Camera className="size-4" />
          </span>
        </button>
        <input
          ref={inputRef}
          className="sr-only"
          type="file"
          tabIndex={-1}
          accept="image/jpeg,image/png,image/gif,image/webp"
          onChange={chooseFile}
        />
        {!bare && (hint || !isDefault) ? (
          <div className="flex min-w-0 flex-col items-start gap-0.5">
            {hint ? <span className="text-xs text-[var(--ds-text-tertiary)]">{t("avatar_cropper.click_to_change")}</span> : null}
            {!isDefault ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="-ml-2 text-[var(--ds-text-secondary)]"
                disabled={resetting}
                onClick={() => void reset()}
              >
                {t("avatar_cropper.reset")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("avatar_cropper.title")}</DialogTitle>
            <DialogDescription>{t("avatar_cropper.description")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-5">
            <div
              ref={stageRef}
              className="relative size-80 touch-none overflow-hidden rounded-full bg-[var(--ds-surface-300)] shadow-[var(--ds-input-shadow)]"
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                setDragging({ x: event.clientX, y: event.clientY });
              }}
              onPointerMove={(event) => {
                if (!dragging) return;
                setOffset((old) => ({ x: old.x + event.clientX - dragging.x, y: old.y + event.clientY - dragging.y }));
                setDragging({ x: event.clientX, y: event.clientY });
              }}
              onPointerUp={() => setDragging(null)}
              onPointerCancel={() => setDragging(null)}
            >
              <canvas ref={canvasRef} className={cn("size-full", dragging ? "cursor-grabbing" : "cursor-grab")} />
            </div>
            <div className="flex w-full items-center gap-3">
              <Slider
                min={ZOOM_MIN}
                max={ZOOM_MAX}
                step={0.01}
                value={[zoom]}
                aria-label={t("avatar_cropper.zoom")}
                onValueChange={([next]) => setZoom(next ?? 1)}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-[var(--ds-icon)]"
                aria-label={t("avatar_cropper.rotate_left")}
                title={t("avatar_cropper.rotate_left")}
                onClick={() => setRotation((old) => old - 90)}
              >
                <RotateCcw className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-[var(--ds-icon)]"
                aria-label={t("avatar_cropper.rotate_right")}
                title={t("avatar_cropper.rotate_right")}
                onClick={() => setRotation((old) => old + 90)}
              >
                <RotateCw className="size-4" />
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="tertiary" size="sm" onClick={() => setOpen(false)}>
              {t("avatar_cropper.cancel")}
            </Button>
            <Button size="sm" onClick={() => void confirm()} disabled={saving || !image}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              {t("avatar_cropper.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
