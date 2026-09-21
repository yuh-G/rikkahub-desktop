import * as React from "react";

import { ArrowLeft, CheckSquare, Download, ImagePlus, Loader2, Plus, Trash2, WandSparkles, X } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { WindowControlsBar, windowDragRegionProps } from "~/components/window-controls";
import { SidebarBrandRow } from "~/components/sidebar-brand";
import { motion } from "motion/react";

import { AIIcon } from "~/components/ui/ai-icon";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import { normalizeImageForModelUpload } from "~/lib/image-normalize";
import api, { appendWebAuthQuery } from "~/services/api";
import { cn } from "~/lib/utils";
import { useSettingsStore } from "~/stores/app-store";
import { confirmDialog } from "~/stores/confirm-store";
import { useElapsedSeconds } from "~/hooks/use-elapsed-since";
import { serverNow } from "~/lib/utils";
import type { ProviderModel } from "~/types";
import i18n from "~/i18n";

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
  { value: "square", labelKey: "common:image_page.ratio_square", description: "1024x1024" },
  {
    value: "landscape",
    labelKey: "common:image_page.ratio_landscape",
    description: "1536x1024 / 16:9",
  },
  {
    value: "portrait",
    labelKey: "common:image_page.ratio_portrait",
    description: "1024x1536 / 9:16",
  },
];

export function meta() {
  return [{ title: `${i18n.t("common:image_page.title")} - RikkaHub` }];
}

function modelLabel(model: ProviderModel, fallback: string) {
  return model?.displayName || model?.modelId || fallback;
}

/** 域10-2:生成中的占位卡——骨架 + 已等待秒数(每秒 tick)+ 取消按钮。
 *  从骨架屏里直接取消,比去输入区找按钮更符合"等待中的注意力就在这里"。 */
function GeneratingPlaceholderCard({
  startedAt,
  onCancel,
}: {
  startedAt: string;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const elapsedSeconds = useElapsedSeconds(startedAt, null);
  return (
    <article className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="relative">
        <Skeleton className="aspect-square w-full rounded-none" />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
          {elapsedSeconds !== null ? (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {t("image_page.waiting_seconds", { seconds: elapsedSeconds })}
            </span>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onCancel}
            className="mt-1"
          >
            <X className="size-3.5" />
            {t("image_page.cancel")}
          </Button>
        </div>
      </div>
      <div className="space-y-2 p-3">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </article>
  );
}

export default function ImagesPage() {
  const { t } = useTranslation();
  const settings = useSettingsStore((state) => state.settings);
  const setSettings = useSettingsStore((state) => state.setSettings);
  const [prompt, setPrompt] = React.useState("");
  const [numberOfImages, setNumberOfImages] = React.useState("1");
  const [aspectRatio, setAspectRatio] = React.useState("square");
  const [referenceImages, setReferenceImages] = React.useState<UploadedFile[]>([]);
  const [images, setImages] = React.useState<GeneratedImage[]>([]);
  const [generating, setGenerating] = React.useState(false);
  // 域10-2:取消与耗时。startedAt 用服务器对齐时钟(serverNow),与全站耗时口径一致。
  const [generatingStartedAt, setGeneratingStartedAt] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  // 图片多选(台账 §1.9):右键卡片进入选择模式,点选切换,Esc/取消退出。
  // selectedIds 存图片 id(string,与服务端 GeneratedImage.id 一致),选择态与数据解耦。
  const [selectionMode, setSelectionMode] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<ReadonlySet<string>>(new Set());
  const [batchBusy, setBatchBusy] = React.useState(false);

  const clearSelection = React.useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelect = React.useCallback((imageId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(imageId)) next.delete(imageId);
      else next.add(imageId);
      return next;
    });
  }, []);

  const beginSelection = React.useCallback((imageId: string) => {
    setSelectionMode(true);
    setSelectedIds(new Set([imageId]));
  }, []);

  // Esc 退出选择模式(对齐 Android BackHandler);选择数据随列表刷新自动剔除已删项。
  React.useEffect(() => {
    if (!selectionMode) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectionMode, clearSelection]);

  const deleteSelected = React.useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0 || batchBusy) return;
    if (!(await confirmDialog({
      title: t("image_page.delete_selected_confirm", { count: ids.length }),
      danger: true,
    }))) return;
    setBatchBusy(true);
    try {
      await api.post("images/batch-delete", { ids });
      setImages((current) => current.filter((item) => !selectedIds.has(item.id)));
      toast.success(t("image_page.delete_selected_done", { count: ids.length }));
      clearSelection();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("image_page.generate_failed"));
    } finally {
      setBatchBusy(false);
    }
  }, [selectedIds, batchBusy, t, clearSelection]);

  const downloadSelected = React.useCallback(() => {
    const chosen = images.filter((item) => selectedIds.has(item.id));
    if (chosen.length === 0) return;
    // 浏览器多文件下载:逐张触发 <a download>(同源 /api/files 走 web 鉴权,拼 access_token)。
    chosen.forEach((item, index) => {
      setTimeout(() => {
        const anchor = document.createElement("a");
        anchor.href = appendWebAuthQuery(item.url);
        anchor.download = item.fileName || `image-${item.id}`;
        anchor.rel = "noreferrer";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }, index * 150);
    });
    toast.success(t("image_page.download_started", { count: chosen.length }));
  }, [images, selectedIds, t]);

  const imageModels = React.useMemo<ImageModelOption[]>(() => {
    if (!settings) return [];
    return settings.providers
      .filter((provider) => provider.enabled !== false)
      .flatMap((provider) =>
        provider.models
          .filter(
            (model) =>
              model.type === "IMAGE" ||
              model.outputModalities?.includes("IMAGE") ||
              model.tools?.some(
                (tool) => String(tool.type ?? "").toLowerCase() === "image_generation",
              ),
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

  const selectModel = React.useCallback(
    async (modelId: string) => {
      if (!settings) return;
      const next = { ...settings, imageGenerationModelId: modelId };
      setSettings(next);
      await api.post("settings/default-models", {
        chatModelId: settings.chatModelId,
        fastModelId: settings.fastModelId,
        translateModeId: settings.translateModeId,
        imageGenerationModelId: modelId,
        ocrModelId: settings.ocrModelId,
        compressModelId: settings.compressModelId,
        titlePrompt: settings.titlePrompt,
        translatePrompt: settings.translatePrompt,
        suggestionPrompt: settings.suggestionPrompt,
        ocrPrompt: settings.ocrPrompt,
        compressPrompt: settings.compressPrompt,
      });
    },
    [setSettings, settings],
  );

  const uploadReferenceImages = React.useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      const form = new FormData();
      for (const file of Array.from(files).slice(0, 16 - referenceImages.length)) {
        const normalized = await normalizeImageForModelUpload(file);
        form.append("files", normalized, normalized.name);
      }
      const response = await api.postMultipart<{ files: UploadedFile[] }>("files/upload", form, {
        timeout: false,
      });
      setReferenceImages((current) => [...current, ...response.files].slice(0, 16));
    },
    [referenceImages.length],
  );

  const generate = React.useCallback(async () => {
    if (!prompt.trim()) {
      toast.error(t("image_page.no_prompt"));
      return;
    }
    if (!settings?.imageGenerationModelId) {
      toast.error(t("image_page.no_model"));
      return;
    }
    if (editBlocked) {
      toast.error(t("image_page.edit_blocked_msg"));
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setGeneratingStartedAt(new Date(serverNow()).toISOString());
    setGenerating(true);
    try {
      const response = await api.post<{ images: GeneratedImage[] }>(
        "images/generate",
        {
          prompt: prompt.trim(),
          numberOfImages: Number(numberOfImages),
          aspectRatio,
          referenceFileIds: referenceImages.map((image) => image.id),
        },
        { timeout: false, signal: controller.signal },
      );
      setImages((current) => [...response.images, ...current]);
      toast.success(
        referenceImages.length ? t("image_page.edit_done") : t("image_page.generate_done"),
      );
    } catch (error) {
      // 主动取消:ky 抛 AbortError / 后端回 499;其余错误照常 toast。root.tsx 的
      // unhandledrejection 已忽略 AbortError,这里再 toast.info 告诉用户取消了。
      const isAbort =
        (error instanceof DOMException && error.name === "AbortError") ||
        (error instanceof Error && error.name === "AbortError");
      if (isAbort || controller.signal.aborted) {
        toast.info(t("image_page.cancelled"));
      } else {
        toast.error(error instanceof Error ? error.message : t("image_page.generate_failed"));
      }
    } finally {
      abortRef.current = null;
      setGenerating(false);
      setGeneratingStartedAt(null);
    }
  }, [
    aspectRatio,
    editBlocked,
    numberOfImages,
    prompt,
    referenceImages,
    settings?.imageGenerationModelId,
    t,
  ]);

  const cancelGenerate = React.useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      {/* 问题7(2.0.0 内测):镶边结构与主界面对齐——侧栏通顶(顶行兼窗口拖拽区),
          窗控条只嵌在右侧内容列顶部,不再横贯全宽把侧栏压下一条。 */}
      <aside className="hidden w-[340px] shrink-0 border-r bg-sidebar/80 px-4 pb-4 pt-1 md:block">
        {/* 问题7回访:品牌行(Logo+RikkaHub,SidebarBrandRow 三页同源)延续主界面设计,
            pt-1 使品牌行距顶 4px——与主界面(SidebarHeader p-2 + -mt-1)同一几何;
            下方动作行放返回键+模型设置。两行都是拖拽区(drag props 放行交互元素,
            asChild Link 渲染的 <a> 已被放行选择器覆盖)。 */}
        <SidebarBrandRow />
        <div className="mt-2 flex items-center justify-between" {...windowDragRegionProps()}>
          <Button asChild size="icon-sm" variant="ghost">
            <Link
              to="/"
              aria-label={t("image_page.back_to_chat")}
              title={t("image_page.back_to_chat")}
            >
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/settings?section=models">{t("image_page.model_settings")}</Link>
          </Button>
        </div>
        <div className="mt-6 space-y-1">
          <div className="flex items-center gap-2 text-xl font-semibold">
            <WandSparkles className="size-5 text-primary" />
            {t("image_page.title")}
          </div>
          <div className="text-sm text-muted-foreground">{t("image_page.description")}</div>
        </div>
        <div className="mt-6 space-y-4">
          <div className="space-y-2">
            <div className="text-sm font-medium">{t("image_page.model")}</div>
            <Select
              value={settings?.imageGenerationModelId || ""}
              onValueChange={(value) => void selectModel(value)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("image_page.select_image_model")} />
              </SelectTrigger>
              <SelectContent>
                {imageModels.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    <span className="flex items-center gap-2">
                      <AIIcon name={model.providerName || model.displayName} className="size-4" />
                      {model.providerName ? `${model.providerName} / ` : ""}
                      {modelLabel(model, t("image_page.not_selected"))}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {imageModels.length === 0 ? (
              <div className="text-xs text-muted-foreground">
                {t("image_page.model_empty_hint")}
              </div>
            ) : null}
            {selectedModel && !selectedModelCanEdit ? (
              <div className="text-xs text-muted-foreground">
                {t("image_page.model_edit_only_hint")}
              </div>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <div className="text-sm font-medium">{t("image_page.count")}</div>
              <Select value={numberOfImages} onValueChange={setNumberOfImages}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4].map((value) => (
                    <SelectItem key={value} value={String(value)}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium">{t("image_page.ratio")}</div>
              <Select value={aspectRatio} onValueChange={setAspectRatio}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ASPECT_RATIOS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {t(item.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* I1:无边框窗口拖拽区 + 窗控钮(仅内容列;侧栏顶部由顶行承担)。
            mt-1.5/mr-2 对齐主界面 SidebarInset 的 pt-1.5/pr-2:窗控钮三页同一坐标。 */}
        <WindowControlsBar className="mt-1.5 mr-2" />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="border-b px-4 py-3 md:hidden">
          <div className="flex items-center justify-between">
            <Link className="text-sm text-muted-foreground" to="/">
              {t("image_page.back_to_chat")}
            </Link>
            <Link className="text-sm text-muted-foreground" to="/settings?section=models">
              {t("image_page.model_settings")}
            </Link>
          </div>
        </div>
        <ScrollArea className="flex-1">
          <div className="mx-auto max-w-6xl space-y-6 p-4 pb-8 md:pt-6">
            <section className="rounded-xl border bg-card p-4 shadow-card">
              <Textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={t("image_page.prompt_placeholder")}
                className="min-h-28 resize-y border-0 bg-transparent p-0 text-base shadow-none placeholder:text-muted-foreground/60 focus-visible:ring-0"
              />
              {referenceImages.length > 0 ? (
                <div className="mt-4 flex flex-wrap gap-3">
                  {referenceImages.map((image) => (
                    <div
                      key={image.id}
                      className="group relative size-24 overflow-hidden rounded-md border bg-muted"
                    >
                      <img
                        src={image.url}
                        alt={image.fileName}
                        className="size-full object-cover"
                      />
                      <button
                        type="button"
                        className="absolute top-1 right-1 rounded-full bg-background/90 p-1 opacity-0 shadow transition group-hover:opacity-100"
                        onClick={() =>
                          setReferenceImages((current) =>
                            current.filter((item) => item.id !== image.id),
                          )
                        }
                        aria-label={t("image_page.remove_image")}
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="mt-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <input
                    ref={inputRef}
                    className="sr-only"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    onChange={(event) => void uploadReferenceImages(event.target.files)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => inputRef.current?.click()}
                    disabled={
                      referenceImages.length >= 16 ||
                      generating ||
                      Boolean(selectedModel && !selectedModelCanEdit)
                    }
                  >
                    <ImagePlus className="size-4" />
                    {t("image_page.reference_image")}
                  </Button>
                  {referenceImages.length > 0 ? (
                    <span className="text-xs text-muted-foreground">
                      {t("image_page.reference_kept", { count: referenceImages.length })}
                    </span>
                  ) : null}
                  {editBlocked ? (
                    <span className="text-xs text-destructive">
                      {t("image_page.reference_edit_blocked")}
                    </span>
                  ) : null}
                </div>
                <Button
                  type="button"
                  onClick={() => (generating ? cancelGenerate() : void generate())}
                  variant={generating ? "outline" : "default"}
                  disabled={!generating && (!settings?.imageGenerationModelId || editBlocked)}
                >
                  {generating ? (
                    <X className="size-4" />
                  ) : (
                    <Plus className="size-4" />
                  )}
                  {generating
                    ? t("image_page.cancel")
                    : referenceImages.length
                      ? t("image_page.edit")
                      : t("image_page.generate")}
                </Button>
              </div>
            </section>

            {images.length > 0 ? (
              selectionMode ? (
                <div className="flex items-center gap-2 rounded-xl border bg-card px-3 py-2 shadow-card">
                  <Button type="button" variant="ghost" size="sm" onClick={clearSelection} disabled={batchBusy}>
                    <X className="size-4" />
                    {t("image_page.cancel")}
                  </Button>
                  <span className="text-sm font-medium tabular-nums">
                    {t("image_page.selected_count", { count: selectedIds.size })}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={batchBusy || selectedIds.size === images.length}
                      onClick={() => setSelectedIds(new Set(images.map((item) => item.id)))}
                    >
                      <CheckSquare className="size-4" />
                      {t("image_page.select_all")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={batchBusy || selectedIds.size === 0}
                      onClick={downloadSelected}
                    >
                      <Download className="size-4" />
                      {t("image_page.download_selected")}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={batchBusy || selectedIds.size === 0}
                      onClick={() => void deleteSelected()}
                    >
                      {batchBusy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                      {t("image_page.delete_selected")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {t("image_page.selected_count", { count: images.length })}
                  </span>
                  <Button type="button" variant="outline" size="sm" onClick={() => setSelectionMode(true)}>
                    <CheckSquare className="size-4" />
                    {t("image_page.select")}
                  </Button>
                </div>
              )
            ) : null}

            <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {generating &&
                generatingStartedAt &&
                Array.from({ length: Number(numberOfImages) }).map((_, index) => (
                  <GeneratingPlaceholderCard
                    key={`skeleton-${index}`}
                    startedAt={generatingStartedAt}
                    onCancel={cancelGenerate}
                  />
                ))}
              {images.map((image, index) => {
                const selected = selectedIds.has(image.id);
                return (
                <motion.article
                  key={image.id}
                  initial={{ opacity: 0, scale: 0.96, y: 8 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  transition={{
                    duration: 0.3,
                    delay: index * 0.05,
                    ease: [0.16, 1, 0.3, 1],
                  }}
                  className={cn(
                    "group overflow-hidden rounded-xl border bg-card shadow-sm transition-shadow hover:shadow-card",
                    selectionMode && "cursor-pointer",
                    selected && "border-primary ring-2 ring-primary/60",
                  )}
                  onContextMenu={(event) => {
                    // 桌面端「长按」等价物:右键进入选择模式并选中该张。
                    event.preventDefault();
                    if (!selectionMode) beginSelection(image.id);
                  }}
                  onClick={() => {
                    if (selectionMode) toggleSelect(image.id);
                  }}
                >
                  <div className="relative block bg-muted">
                    {selectionMode ? (
                      <div className="pointer-events-none absolute inset-0 z-10">
                        <Checkbox
                          checked={selected}
                          className="absolute right-2 top-2 size-5 bg-background/90 shadow"
                          aria-label={t("image_page.select")}
                        />
                      </div>
                    ) : null}
                    {selectionMode ? (
                      <img
                        src={image.url}
                        alt={image.prompt}
                        className="aspect-square w-full object-contain"
                      />
                    ) : (
                      <a href={image.url} target="_blank" rel="noreferrer" className="block">
                        <img
                          src={image.url}
                          alt={image.prompt}
                          className="aspect-square w-full object-contain transition-transform duration-300 group-hover:scale-[1.02]"
                        />
                      </a>
                    )}
                  </div>
                  <div className="space-y-3 p-3">
                    <div className="line-clamp-2 text-sm">{image.prompt}</div>
                    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span className="truncate">{image.model}</span>
                      <span>
                        {image.type === "image_edit"
                          ? t("image_page.badge_edit")
                          : t("image_page.badge_generate")}
                      </span>
                    </div>
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={async (event) => {
                          event.stopPropagation();
                          if (!(await confirmDialog({ title: t("image_page.delete_confirm"), danger: true }))) return;
                          await api.delete(`images/${image.id}`);
                          setImages((current) => current.filter((item) => item.id !== image.id));
                        }}
                        aria-label={t("image_page.delete")}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                </motion.article>
                );
              })}
            </section>
            {images.length === 0 ? (
              <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
                {t("image_page.empty")}
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </main>
      </div>
    </div>
  );
}
