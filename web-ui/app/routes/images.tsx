import * as React from "react";

import { ImagePlus, Loader2, Plus, Trash2, WandSparkles, X } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";

import { AIIcon } from "~/components/ui/ai-icon";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { normalizeImageForModelUpload } from "~/lib/image-normalize";
import api from "~/services/api";
import { useSettingsStore } from "~/stores/app-store";
import type { ProviderModel } from "~/types";

interface UploadedFile {
  id: number;
  url: string;
  fileName: string;
  mime: string;
  size: number;
}

interface GeneratedImage {
  id: string;
  prompt: string;
  fileId: number;
  url: string;
  fileName: string;
  mime: string;
  model: string;
  modelId: string;
  type: "image_generation" | "image_edit";
  sourceFileIds: number[];
  sourcePaths?: string;
  createdAt: number;
}

type ImageModelOption = ProviderModel & {
  providerId: string;
  providerName: string;
  providerType?: string;
};

const ASPECT_RATIOS = [
  { value: "square", label: "1:1", description: "1024x1024" },
  { value: "landscape", label: "横向", description: "1536x1024 / 16:9" },
  { value: "portrait", label: "竖向", description: "1024x1536 / 9:16" },
];

export function meta() {
  return [{ title: "图像生成 - RikkaHub" }];
}

function modelLabel(model?: ProviderModel) {
  return model?.displayName || model?.modelId || "未选择";
}

export default function ImagesPage() {
  const settings = useSettingsStore((state) => state.settings);
  const setSettings = useSettingsStore((state) => state.setSettings);
  const [prompt, setPrompt] = React.useState("");
  const [numberOfImages, setNumberOfImages] = React.useState("1");
  const [aspectRatio, setAspectRatio] = React.useState("square");
  const [referenceImages, setReferenceImages] = React.useState<UploadedFile[]>([]);
  const [images, setImages] = React.useState<GeneratedImage[]>([]);
  const [generating, setGenerating] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const imageModels = React.useMemo<ImageModelOption[]>(() => {
    if (!settings) return [];
    return settings.providers
      .filter((provider) => provider.enabled !== false)
      .flatMap((provider) =>
        provider.models
          .filter((model) =>
            model.type === "IMAGE" ||
            model.outputModalities?.includes("IMAGE") ||
            model.tools?.some((tool) => String(tool.type ?? "").toLowerCase() === "image_generation"),
          )
          .map((model) => ({
            ...model,
            providerId: provider.id,
            providerName: provider.name,
            providerType: String(provider.type ?? ""),
          })),
      );
  }, [settings]);

  const selectedModel = imageModels.find((model) => model.id === settings?.imageGenerationModelId);
  const selectedModelCanEdit = selectedModel?.providerType === "openai";
  const editBlocked = referenceImages.length > 0 && selectedModel ? !selectedModelCanEdit : false;

  const refreshImages = React.useCallback(async () => {
    const response = await api.get<{ images: GeneratedImage[] }>("images");
    setImages(response.images);
  }, []);

  React.useEffect(() => {
    void refreshImages().catch((error: Error) => toast.error(error.message));
  }, [refreshImages]);

  const selectModel = React.useCallback(async (modelId: string) => {
    if (!settings) return;
    const next = { ...settings, imageGenerationModelId: modelId };
    setSettings(next);
    await api.post("settings/default-models", {
      chatModelId: settings.chatModelId,
      titleModelId: settings.titleModelId,
      translateModeId: settings.translateModeId,
      suggestionModelId: settings.suggestionModelId,
      imageGenerationModelId: modelId,
      ocrModelId: settings.ocrModelId,
      compressModelId: settings.compressModelId,
      titlePrompt: settings.titlePrompt,
      translatePrompt: settings.translatePrompt,
      suggestionPrompt: settings.suggestionPrompt,
      ocrPrompt: settings.ocrPrompt,
      compressPrompt: settings.compressPrompt,
    });
  }, [setSettings, settings]);

  const uploadReferenceImages = React.useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    const form = new FormData();
    for (const file of Array.from(files).slice(0, 16 - referenceImages.length)) {
      const normalized = await normalizeImageForModelUpload(file);
      form.append("files", normalized, normalized.name);
    }
    const response = await api.postMultipart<{ files: UploadedFile[] }>("files/upload", form, { timeout: false });
    setReferenceImages((current) => [...current, ...response.files].slice(0, 16));
  }, [referenceImages.length]);

  const generate = React.useCallback(async () => {
    if (!prompt.trim()) {
      toast.error("请输入图片提示词");
      return;
    }
    if (!settings?.imageGenerationModelId) {
      toast.error("请先选择图像生成模型");
      return;
    }
    if (editBlocked) {
      toast.error("当前模型不支持参考图编辑，请选择 OpenAI 兼容图像模型或移除参考图");
      return;
    }
    setGenerating(true);
    try {
      const response = await api.post<{ images: GeneratedImage[] }>("images/generate", {
        prompt: prompt.trim(),
        numberOfImages: Number(numberOfImages),
        aspectRatio,
        referenceFileIds: referenceImages.map((image) => image.id),
      }, { timeout: false });
      setImages((current) => [...response.images, ...current]);
      toast.success(referenceImages.length ? "图片编辑完成" : "图片生成完成");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "生成失败");
    } finally {
      setGenerating(false);
    }
  }, [aspectRatio, editBlocked, numberOfImages, prompt, referenceImages, settings?.imageGenerationModelId]);

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="hidden w-[340px] shrink-0 border-r bg-sidebar/80 p-4 md:block">
        <div className="flex items-center justify-between">
          <Link className="text-sm text-muted-foreground transition hover:text-foreground" to="/">返回聊天</Link>
          <Button asChild variant="outline" size="sm">
            <Link to="/settings?section=models">模型设置</Link>
          </Button>
        </div>
        <div className="mt-6 space-y-1">
          <div className="flex items-center gap-2 text-xl font-semibold">
            <WandSparkles className="size-5 text-primary" />
            图像生成
          </div>
          <div className="text-sm text-muted-foreground">支持文本到图像生成、上传参考图编辑，并保留历史参考图便于复用。</div>
        </div>
        <div className="mt-6 space-y-4">
          <div className="space-y-2">
            <div className="text-sm font-medium">模型</div>
            <Select value={settings?.imageGenerationModelId || ""} onValueChange={(value) => void selectModel(value)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择图像模型" />
              </SelectTrigger>
              <SelectContent>
                {imageModels.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    <span className="flex items-center gap-2">
                      <AIIcon name={model.providerName || model.displayName} className="size-4" />
                      {model.providerName ? `${model.providerName} / ` : ""}{modelLabel(model)}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {imageModels.length === 0 ? <div className="text-xs text-muted-foreground">请先在供应商中获取并勾选支持图像输出或 image_generation 工具的模型。</div> : null}
            {selectedModel && !selectedModelCanEdit ? (
              <div className="text-xs text-muted-foreground">当前模型可生成图片；参考图编辑仅支持 OpenAI 兼容图像模型。</div>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <div className="text-sm font-medium">数量</div>
              <Select value={numberOfImages} onValueChange={setNumberOfImages}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4].map((value) => <SelectItem key={value} value={String(value)}>{value}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium">比例</div>
              <Select value={aspectRatio} onValueChange={setAspectRatio}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ASPECT_RATIOS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="border-b px-4 py-3 md:hidden">
          <div className="flex items-center justify-between">
            <Link className="text-sm text-muted-foreground" to="/">返回聊天</Link>
            <Link className="text-sm text-muted-foreground" to="/settings?section=models">模型设置</Link>
          </div>
        </div>
        <ScrollArea className="flex-1">
          <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
            <section className="rounded-lg border bg-card p-4">
              <Textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="描述你想生成或编辑的图片"
                className="min-h-28 resize-y border-0 bg-transparent p-0 text-base shadow-none focus-visible:ring-0"
              />
              {referenceImages.length > 0 ? (
                <div className="mt-4 flex flex-wrap gap-3">
                  {referenceImages.map((image) => (
                    <div key={image.id} className="group relative size-24 overflow-hidden rounded-md border bg-muted">
                      <img src={image.url} alt={image.fileName} className="size-full object-cover" />
                      <button
                        type="button"
                        className="absolute top-1 right-1 rounded-full bg-background/90 p-1 opacity-0 shadow transition group-hover:opacity-100"
                        onClick={() => setReferenceImages((current) => current.filter((item) => item.id !== image.id))}
                        aria-label="移除参考图"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="mt-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <input ref={inputRef} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => void uploadReferenceImages(event.target.files)} />
                  <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={referenceImages.length >= 16 || generating || Boolean(selectedModel && !selectedModelCanEdit)}>
                    <ImagePlus className="size-4" />
                    参考图
                  </Button>
                  {referenceImages.length > 0 ? <span className="text-xs text-muted-foreground">{referenceImages.length}/16，生成后保留</span> : null}
                  {editBlocked ? <span className="text-xs text-destructive">当前模型不支持参考图编辑</span> : null}
                </div>
                <Button type="button" onClick={() => void generate()} disabled={generating || !settings?.imageGenerationModelId || editBlocked}>
                  {generating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  {referenceImages.length ? "编辑图片" : "生成图片"}
                </Button>
              </div>
            </section>

            <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {images.map((image) => (
                <article key={image.id} className="overflow-hidden rounded-lg border bg-card">
                  <a href={image.url} target="_blank" rel="noreferrer" className="block bg-muted">
                    <img src={image.url} alt={image.prompt} className="aspect-square w-full object-contain" />
                  </a>
                  <div className="space-y-3 p-3">
                    <div className="line-clamp-2 text-sm">{image.prompt}</div>
                    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span className="truncate">{image.model}</span>
                      <span>{image.type === "image_edit" ? "编辑" : "生成"}</span>
                    </div>
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={async () => {
                          await api.delete(`images/${image.id}`);
                          setImages((current) => current.filter((item) => item.id !== image.id));
                        }}
                        aria-label="删除"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                </article>
              ))}
            </section>
            {images.length === 0 ? (
              <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">暂无图片</div>
            ) : null}
          </div>
        </ScrollArea>
      </main>
    </div>
  );
}
