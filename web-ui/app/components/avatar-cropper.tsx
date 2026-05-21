import * as React from "react";

import { Loader2, RotateCcw, RotateCw, Save, Upload } from "lucide-react";
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
import api from "~/services/api";
import type { AssistantAvatar } from "~/types";

export function AvatarCropper({
  value,
  fallbackName,
  onChange,
  size = "lg",
}: {
  value?: AssistantAvatar | null;
  fallbackName: string;
  onChange: (avatar: AssistantAvatar) => void | Promise<void>;
  size?: "default" | "lg";
}) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [open, setOpen] = React.useState(false);
  const [source, setSource] = React.useState<string | null>(null);
  const [image, setImage] = React.useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = React.useState(1);
  const [offset, setOffset] = React.useState({ x: 0, y: 0 });
  const [rotation, setRotation] = React.useState(0);
  const [dragging, setDragging] = React.useState<{ x: number; y: number } | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!source) return;
    const img = new Image();
    img.onload = () => setImage(img);
    img.src = source;
  }, [source]);

  const draw = React.useCallback((targetSize = 320) => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return null;
    canvas.width = targetSize;
    canvas.height = targetSize;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.clearRect(0, 0, targetSize, targetSize);
    ctx.fillStyle = "#f4f4f5";
    ctx.fillRect(0, 0, targetSize, targetSize);
    ctx.save();
    ctx.translate(targetSize / 2 + offset.x, targetSize / 2 + offset.y);
    ctx.rotate((rotation * Math.PI) / 180);
    const base = targetSize / Math.min(image.width, image.height);
    const scale = base * zoom;
    ctx.drawImage(image, -image.width * scale / 2, -image.height * scale / 2, image.width * scale, image.height * scale);
    ctx.restore();
    return canvas;
  }, [image, offset.x, offset.y, rotation, zoom]);

  React.useEffect(() => {
    draw();
  }, [draw]);

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
      if (!blob) throw new Error("头像处理失败");
      const form = new FormData();
      form.append("files", new File([blob], "avatar.png", { type: "image/png" }));
      const result = await api.postMultipart<{ files: Array<{ url: string }> }>("files/upload", form);
      const url = result.files[0]?.url;
      if (!url) throw new Error("头像上传失败");
      await onChange({ type: "url", url });
      setOpen(false);
      toast.success("头像已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "头像上传失败");
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    await onChange({ type: "dummy" });
  };

  return (
    <>
      <div className="flex items-center gap-4">
        <UIAvatar size={size} name={fallbackName} avatar={value} />
        <div className="space-y-2">
          <label>
            <input className="sr-only" type="file" accept="image/*" onChange={chooseFile} />
            <span className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm shadow-xs transition hover:bg-accent">
              <Upload className="size-4" />
              上传并裁剪
            </span>
          </label>
          <Button variant="ghost" size="sm" onClick={() => void reset()}>
            使用默认头像
          </Button>
        </div>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>裁剪头像</DialogTitle>
            <DialogDescription>拖动图片调整位置，使用缩放和旋转后保存为本地头像。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-5 md:grid-cols-[320px_1fr]">
            <div
              className="relative size-80 overflow-hidden rounded-full border bg-muted"
              onPointerDown={(event) => setDragging({ x: event.clientX, y: event.clientY })}
              onPointerMove={(event) => {
                if (!dragging) return;
                setOffset((old) => ({ x: old.x + event.clientX - dragging.x, y: old.y + event.clientY - dragging.y }));
                setDragging({ x: event.clientX, y: event.clientY });
              }}
              onPointerUp={() => setDragging(null)}
              onPointerLeave={() => setDragging(null)}
            >
              <canvas ref={canvasRef} className="size-full cursor-move" />
            </div>
            <div className="space-y-5">
              <label className="block space-y-2">
                <span className="text-sm font-medium">缩放</span>
                <Slider min={0.6} max={3} step={0.05} value={[zoom]} onValueChange={([value]) => setZoom(value ?? 1)} />
              </label>
              <label className="block space-y-2">
                <span className="text-sm font-medium">水平移动</span>
                <Slider min={-160} max={160} step={1} value={[offset.x]} onValueChange={([value]) => setOffset((old) => ({ ...old, x: value ?? 0 }))} />
              </label>
              <label className="block space-y-2">
                <span className="text-sm font-medium">垂直移动</span>
                <Slider min={-160} max={160} step={1} value={[offset.y]} onValueChange={([value]) => setOffset((old) => ({ ...old, y: value ?? 0 }))} />
              </label>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setRotation((old) => old - 90)}>
                  <RotateCcw className="size-4" />
                  左转
                </Button>
                <Button variant="outline" onClick={() => setRotation((old) => old + 90)}>
                  <RotateCw className="size-4" />
                  右转
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
            <Button onClick={confirm} disabled={saving || !image}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              保存头像
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
