import * as React from "react";

import {
  ArrowUp,
  File,
  FileDown,
  Image,
  LoaderCircle,
  Mic,
  Plus,
  Scissors,
  Send,
  Sparkles,
  Square,
  Undo2,
  Video,
  X,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useCurrentAssistant } from "~/hooks/use-current-assistant";
import { ModelList } from "~/components/input/model-list";
import { ReasoningPickerButton } from "~/components/input/reasoning-picker";
import { SearchPickerButton } from "~/components/input/search-picker";
import { McpPickerButton } from "~/components/input/mcp-picker";
import { MemoryBadge } from "~/components/memory/memory-badge";
import { ExtensionPickerButton } from "~/components/input/extension-picker";
import { useChatInputStore, useSettingsStore } from "~/stores";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Textarea } from "~/components/ui/textarea";
import { resolveFileUrl } from "~/lib/files";
import { normalizeImageForModelUpload } from "~/lib/image-normalize";
import { DOCUMENT_UPLOAD_ACCEPT, uploadFilesToDraft } from "~/lib/upload";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import type { UIMessagePart } from "~/types";

export interface ChatInputProps {
  value: string;
  attachments: UIMessagePart[];
  suggestions?: string[];
  ready?: boolean;
  disabled?: boolean;
  isGenerating?: boolean;
  isEditing?: boolean;
  onValueChange: (value: string) => void;
  onAddParts: (parts: UIMessagePart[]) => void;
  shouldDeleteFileOnRemove?: (part: UIMessagePart) => boolean;
  onRemovePart: (index: number, part: UIMessagePart) => Promise<void> | void;
  onSend: () => Promise<void> | void;
  onStop?: () => Promise<void> | void;
  onCancelEdit?: () => void;
  onSuggestionClick?: (suggestion: string) => void;
  onExportConversation?: (includeReasoning: boolean) => void;
  onCompressConversation?: () => void;
  // 提示词优化时,返回最近几轮对话的纯文本作为上下文(让优化模型理解模糊指代)。
  // 无对话(首条消息)时返回空串。只在用户点击"优化提示词"时调用。
  getOptimizeContext?: () => string;
  className?: string;
}

const IMAGE_UPLOAD_ACCEPT = "image/*";

const ASR_FRAME_SIZE = 4096;

function websocketApiUrl(path: string) {
  const base =
    typeof window === "undefined"
      ? "ws://localhost:8080"
      : window.location.origin.replace(/^http/i, "ws");
  return `${base}/api/${path.replace(/^\/+/, "")}`;
}

function resampleLinear(input: Float32Array, inputRate: number, outputRate: number) {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(input.length - 1, left + 1);
    const weight = sourceIndex - left;
    output[i] = input[left] * (1 - weight) + input[right] * weight;
  }
  return output;
}

function floatToPcm16(input: Float32Array) {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}

function partLabel(part: UIMessagePart, t: (key: string) => string): string {
  switch (part.type) {
    case "document":
      return part.fileName;
    case "image":
      return t("chat.attachment_image");
    case "video":
      return t("chat.attachment_video");
    case "audio":
      return t("chat.attachment_audio");
    default:
      return t("chat.attachment_file");
  }
}

function partIcon(part: UIMessagePart) {
  switch (part.type) {
    case "image":
      return <Image className="size-3.5" />;
    case "video":
      return <Video className="size-3.5" />;
    case "audio":
      return <Mic className="size-3.5" />;
    case "document":
      return <File className="size-3.5" />;
    default:
      return <File className="size-3.5" />;
  }
}

function getPartFileId(part: UIMessagePart): number | null {
  const value = part.metadata?.fileId;
  return typeof value === "number" ? value : null;
}

function ChatInputInner({
  value,
  attachments,
  suggestions = [],
  ready = true,
  disabled = false,
  isGenerating = false,
  isEditing = false,
  onValueChange,
  onAddParts,
  shouldDeleteFileOnRemove,
  onRemovePart,
  onSend,
  onStop,
  onCancelEdit,
  onSuggestionClick,
  onExportConversation,
  onCompressConversation,
  getOptimizeContext,
  className,
}: ChatInputProps) {
  const { t } = useTranslation("input");
  const sendOnEnter = useSettingsStore(
    (state) => state.settings?.displaySetting.sendOnEnter ?? true,
  );
  const pasteLongTextAsFile = useSettingsStore(
    (state) => state.settings?.displaySetting.pasteLongTextAsFile ?? false,
  );
  const pasteLongTextThreshold = useSettingsStore(
    (state) => state.settings?.displaySetting.pasteLongTextThreshold ?? 1000,
  );
  const { currentAssistant, settings } = useCurrentAssistant();

  const quickMessages = React.useMemo(() => {
    const ids = currentAssistant?.quickMessageIds;
    const allQuickMessages = settings?.quickMessages ?? [];
    if (!Array.isArray(ids) || ids.length === 0 || allQuickMessages.length === 0) {
      return [] as QuickMessageOption[];
    }
    const idSet = new Set(ids);
    return allQuickMessages
      .filter((qm) => idSet.has(qm.id))
      .map((qm) => ({
        title: qm.title.trim() || t("chat.quick_message_default_title"),
        content: qm.content.trim(),
      }))
      .filter((item): item is QuickMessageOption => item.content.length > 0);
  }, [currentAssistant?.quickMessageIds, settings?.quickMessages, t]);

  const imageInputRef = React.useRef<HTMLInputElement | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

  // ── 输入框高度拖拽 ──────────────────────────────────────────────────
  // 用户可上下拖动输入框上沿调整高度（左右不拖），高度持久化到 displaySetting，
  // 切换会话 / 重启后保留。拖拽过程中只改本地 dragHeight（流畅），松手才提交一次，
  // 避免 POST 风暴；store 由 SSE 推回更新，无需手动同步。
  const chatInputHeight = useSettingsStore(
    (state) => state.settings?.displaySetting.chatInputHeight ?? null,
  );
  const [dragHeight, setDragHeight] = React.useState<number | null>(null);
  const dragStartRef = React.useRef<{ startY: number; startHeight: number } | null>(null);
  // 拖拽中用 dragHeight，否则用持久化值；都为 null 时回退默认 60。
  const effectiveHeight = dragHeight ?? chatInputHeight;
  const inputMinHeight = effectiveHeight ?? 60;
  const inputMaxHeight = Math.max(
    inputMinHeight,
    typeof window !== "undefined" ? window.innerHeight * 0.7 : 600,
  );
  const onResizePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startHeight = effectiveHeight ?? 60;
    dragStartRef.current = { startY: event.clientY, startHeight };
    setDragHeight(startHeight);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start) return;
    // 向下拖（dy > 0）→ 高度减小；向上拖（dy < 0）→ 高度增大。
    const next = start.startHeight - (event.clientY - start.startY);
    const min = 60;
    const max = typeof window !== "undefined" ? window.innerHeight * 0.7 : 600;
    setDragHeight(Math.round(Math.min(Math.max(next, min), max)));
  };
  const onResizePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return;
    dragStartRef.current = null;
    const finalHeight = dragHeight;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (finalHeight != null && finalHeight !== chatInputHeight) {
      void api
        .post("settings/display", { chatInputHeight: finalHeight })
        .catch((err) => console.warn("[chat-input] save height failed", err));
    }
  };

  const [submitting, setSubmitting] = React.useState(false);
  const uploading = useChatInputStore((state) => state.uploading);
  const [uploadMenuOpen, setUploadMenuOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [asrListening, setAsrListening] = React.useState(false);
  const asrSocketRef = React.useRef<WebSocket | null>(null);
  const asrAudioContextRef = React.useRef<AudioContext | null>(null);
  const asrSourceRef = React.useRef<MediaStreamAudioSourceNode | null>(null);
  const asrProcessorRef = React.useRef<ScriptProcessorNode | null>(null);
  const asrStreamRef = React.useRef<MediaStream | null>(null);
  const asrFrameRef = React.useRef<Int16Array[]>([]);
  const asrFrameSamplesRef = React.useRef(0);
  // 提示词优化:点击后把输入框原文发给"提示词优化模型",返回的优化版直接替换输入框。
  // 优化成功后在优化按钮旁显示常驻"撤销"按钮(不走 toast —— toast 几秒就消失,用户来不及点
  // 或事后想反悔就没机会了)。originalBeforeOptimize 保存原文,点撤销即恢复;重新优化 / 发送
  // 消息时清空。optimizeHint:超过 8s 还在转时以小字内嵌在优化按钮旁显示"模型响应较慢"
  // (原方案放页面底部会把整个输入区往下挤,破坏布局)。
  const [optimizing, setOptimizing] = React.useState(false);
  const [optimizeHint, setOptimizeHint] = React.useState<string | null>(null);
  const [originalBeforeOptimize, setOriginalBeforeOptimize] = React.useState<string | null>(null);

  const isEmpty = value.trim().length === 0 && attachments.length === 0;

  const canStop = ready && Boolean(onStop) && isGenerating && !disabled;
  const canSend = ready && !isGenerating && !disabled && !isEmpty;
  // 生成中允许上传:用户常在模型输出时准备下一轮的 prompt 和附件,加文件到草稿和打字
  // 一样都不打断当前生成。submitting(发送的一瞬间)和 uploading 仍保留互斥。
  const canUpload = ready && !disabled && !uploading && !submitting;
  const canSwitchModel = ready && !disabled && !isGenerating && !uploading && !submitting;
  const canUseQuickMessage = ready && !disabled && !uploading && !submitting;
  const canUseAsr = ready && !disabled && !isGenerating && !uploading && !submitting;
  const actionDisabled = submitting || uploading || (!canStop && !canSend);

  const releaseAsrResources = React.useCallback(() => {
    asrProcessorRef.current?.disconnect();
    asrProcessorRef.current = null;
    asrSourceRef.current?.disconnect();
    asrSourceRef.current = null;
    void asrAudioContextRef.current?.close().catch(() => undefined);
    asrAudioContextRef.current = null;
    asrStreamRef.current?.getTracks().forEach((track) => track.stop());
    asrStreamRef.current = null;
    asrFrameRef.current = [];
    asrFrameSamplesRef.current = 0;
  }, []);

  React.useEffect(() => {
    if (!canUpload) {
      setUploadMenuOpen(false);
    }
  }, [canUpload]);

  const handlePrimaryAction = React.useCallback(async () => {
    if (actionDisabled) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      if (canStop) {
        await onStop?.();
        return;
      }

      if (canSend) {
        setOriginalBeforeOptimize(null);
        await onSend();
      }
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : t("chat.send_failed");
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }, [actionDisabled, canSend, canStop, onSend, onStop, t]);

  const handleOptimize = React.useCallback(async () => {
    const original = value.trim();
    if (!original || optimizing) return;
    setOptimizing(true);
    setOptimizeHint(null);
    // 8s 后还在转 → 显示"模型响应较慢",给用户感知(不然一直转圈不知道是卡死还是在想)。
    // 完成或出错时在 finally 里清掉。配合下方的 60s 超时,保证不会无限转。
    const slowTimer = setTimeout(() => setOptimizeHint("优化模型响应较慢,正在等待…"), 8_000);
    try {
      const context = getOptimizeContext?.() ?? "";
      const res = await api.post<{ text: string }>(
        "prompt/optimize",
        { text: value, context },
        { timeout: 60_000 },
      );
      const optimized = String(res.text ?? "").trim();
      if (!optimized) {
        toast.error("优化结果为空,请重试或更换优化模型");
        return;
      }
      onValueChange(optimized);
      setOriginalBeforeOptimize(original);
      toast.success("已优化提示词");
    } catch (err) {
      // 区分超时和其他错误,给更可操作的提示。AbortError/TimeoutError 是 ky 超时抛的。
      const isTimeout =
        err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
      toast.error(
        isTimeout
          ? "优化超时,请稍后重试或检查优化模型是否可用"
          : err instanceof Error
            ? err.message
            : "提示词优化失败",
      );
    } finally {
      clearTimeout(slowTimer);
      setOptimizeHint(null);
      setOptimizing(false);
    }
  }, [value, optimizing, onValueChange, getOptimizeContext]);

  const handleTextChange = React.useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      onValueChange(event.target.value);
      if (error) {
        setError(null);
      }
      // 用户开始编辑后,撤销入口就不再有意义(原文已和当前内容脱节)——收起撤销按钮。
      if (originalBeforeOptimize !== null) {
        setOriginalBeforeOptimize(null);
      }
    },
    [error, onValueChange, originalBeforeOptimize],
  );

  const handleQuickMessageSelect = React.useCallback(
    (content: string) => {
      if (!canUseQuickMessage || !content) {
        return;
      }

      const needLineBreak = value.length > 0 && !value.endsWith("\n");
      onValueChange(`${value}${needLineBreak ? "\n" : ""}${content}`);
      if (error) {
        setError(null);
      }
      textareaRef.current?.focus();
    },
    [canUseQuickMessage, error, onValueChange, value],
  );

  const stopAsr = React.useCallback(() => {
    asrSocketRef.current?.send(JSON.stringify({ type: "stop" }));
    asrSocketRef.current?.close(1000, "stop");
    asrSocketRef.current = null;
    releaseAsrResources();
    setAsrListening(false);
  }, [releaseAsrResources]);

  React.useEffect(() => () => stopAsr(), [stopAsr]);

  const toggleAsr = React.useCallback(async () => {
    if (!canUseAsr) return;
    if (asrListening) {
      stopAsr();
      return;
    }

    if (!settings?.selectedASRProviderId) {
      toast.error("请先在设置中配置并选择 ASR 服务");
      return;
    }

    try {
      const provider = settings.asrProviders?.find(
        (item) => item.id === settings.selectedASRProviderId,
      );
      if (!provider) {
        toast.error("请先在设置中配置并选择 ASR 服务");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const socket = new WebSocket(websocketApiUrl("asr/realtime"));
      socket.binaryType = "arraybuffer";
      asrSocketRef.current = socket;
      asrStreamRef.current = stream;
      const baseText = value;
      let latestTranscript = "";
      const applyTranscript = (transcript: string) => {
        latestTranscript = transcript.trim();
        if (!latestTranscript) return;
        const prefix =
          baseText.trim().length > 0 && !baseText.endsWith("\n") ? `${baseText}\n` : baseText;
        onValueChange(`${prefix}${latestTranscript}`.trimStart());
        if (error) setError(null);
      };
      socket.onopen = async () => {
        socket.send(JSON.stringify({ type: "start", providerId: provider.id }));
        const AudioContextCtor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        const audioContext = new AudioContextCtor();
        const source = audioContext.createMediaStreamSource(stream);
        const processor = audioContext.createScriptProcessor(4096, 1, 1);
        asrAudioContextRef.current = audioContext;
        asrSourceRef.current = source;
        asrProcessorRef.current = processor;
        const targetSampleRate = Math.max(
          8000,
          Number(provider.sampleRate || (provider.type === "openai_realtime" ? 24000 : 16000)),
        );
        processor.onaudioprocess = (event) => {
          if (socket.readyState !== WebSocket.OPEN) return;
          const channel = event.inputBuffer.getChannelData(0);
          const pcmBuffer = floatToPcm16(
            resampleLinear(channel, audioContext.sampleRate, targetSampleRate),
          );
          const chunk = new Int16Array(pcmBuffer);
          asrFrameRef.current.push(chunk);
          asrFrameSamplesRef.current += chunk.length;
          while (asrFrameSamplesRef.current >= ASR_FRAME_SIZE) {
            const frame = new Int16Array(ASR_FRAME_SIZE);
            let offset = 0;
            while (offset < ASR_FRAME_SIZE) {
              const head = asrFrameRef.current[0];
              const take = Math.min(head.length, ASR_FRAME_SIZE - offset);
              frame.set(head.subarray(0, take), offset);
              offset += take;
              if (take === head.length) {
                asrFrameRef.current.shift();
              } else {
                asrFrameRef.current[0] = head.subarray(take);
              }
              asrFrameSamplesRef.current -= take;
            }
            socket.send(frame.buffer);
          }
        };
        source.connect(processor);
        processor.connect(audioContext.destination);
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        const payload = JSON.parse(event.data) as {
          type?: string;
          transcript?: string;
          error?: string;
        };
        if (payload.type === "transcript") applyTranscript(payload.transcript ?? "");
        if (payload.type === "error") {
          const message = payload.error || "语音识别失败";
          setError(message);
          toast.error(message);
          stopAsr();
        }
      };
      socket.onerror = () => {
        toast.error("语音识别连接失败");
        stopAsr();
      };
      socket.onclose = () => {
        releaseAsrResources();
        asrSocketRef.current = null;
        setAsrListening(false);
      };
      setAsrListening(true);
    } catch (asrError) {
      const message = asrError instanceof Error ? asrError.message : "无法访问麦克风";
      setError(message);
      toast.error(message);
      stopAsr();
    }
  }, [
    asrListening,
    canUseAsr,
    error,
    onValueChange,
    releaseAsrResources,
    settings,
    stopAsr,
    value,
  ]);

  const handleSuggestionSelect = React.useCallback(
    (suggestion: string) => {
      if (!canUseQuickMessage || !suggestion) {
        return;
      }

      onSuggestionClick?.(suggestion);
      if (error) {
        setError(null);
      }
      textareaRef.current?.focus();
    },
    [canUseQuickMessage, error, onSuggestionClick],
  );

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter") return;
      if (isGenerating) return;
      if (event.nativeEvent.isComposing) return;

      // 镜像逻辑：
      // sendOnEnter = true: Enter 发送，Shift+Enter 换行
      // sendOnEnter = false: Shift+Enter 发送，Enter 换行
      const shouldSend = sendOnEnter ? !event.shiftKey : event.shiftKey;
      if (!shouldSend) return;

      event.preventDefault();
      void handlePrimaryAction();
    },
    [handlePrimaryAction, isGenerating, sendOnEnter],
  );

  const handleUploadInputChange = React.useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const result = await uploadFilesToDraft(event.target.files, onAddParts);
      if (result.error) setError(result.error);
      event.currentTarget.value = "";
    },
    [onAddParts],
  );

  const handlePaste = React.useCallback(
    async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!canUpload) return;

      // 粘贴长文本自动转换为文件
      if (pasteLongTextAsFile) {
        const text = event.clipboardData.getData("text/plain");
        if (text.length > pasteLongTextThreshold) {
          event.preventDefault();
          const file = new globalThis.File([text], "pasted_text.txt", {
            type: "text/plain",
          });
          toast.info(t("chat.long_text_as_file"));
          const result = await uploadFilesToDraft([file], onAddParts);
          if (result.error) setError(result.error);
          return;
        }
      }

      const files = Array.from(event.clipboardData.items)
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is globalThis.File => file !== null);

      if (files.length === 0) {
        return;
      }

      event.preventDefault();
      const result = await uploadFilesToDraft(files, onAddParts);
      if (result.error) setError(result.error);
    },
    [canUpload, onAddParts, pasteLongTextAsFile, pasteLongTextThreshold, t],
  );

  const sendHint = sendOnEnter ? t("chat.send_hint_enter") : t("chat.send_hint_newline");
  const placeholder = ready ? t("chat.placeholder_ready") : t("chat.placeholder_not_ready");

  return (
    <div
      className={cn(
        "bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60",
        className,
      )}
    >
      <div className="mx-auto w-full max-w-3xl px-4 py-4">
        {/* 可拖拽的上沿手柄：上下拖改变输入框高度（左右锁定）。对标微信等桌面聊天
            应用，让用户按需放大/收起输入区，尺寸跨会话与重启保留。 */}
        <div
          className="flex h-3 cursor-ns-resize touch-none items-center justify-center"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          role="separator"
          aria-orientation="horizontal"
          aria-label="拖动调整输入框大小"
        >
          <div className="h-1 w-10 rounded-full bg-border/70 transition-colors hover:bg-primary/50" />
        </div>
        <div className="relative flex flex-col gap-2 rounded-2xl border bg-card p-3 shadow-lg transition-shadow focus-within:shadow-elevated focus-within:ring-1 focus-within:ring-ring">
          {/* 待确认记忆提醒角标:浮在输入框右上角外沿,像消息提醒。仅有待确认项时渲染。 */}
          <div className="absolute -top-4 right-2 z-10">
            <MemoryBadge />
          </div>
          {isEditing ? (
            <div className="flex items-center justify-between rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
              <span className="text-primary">{t("chat.editing_tip")}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={onCancelEdit}
                disabled={submitting || uploading}
              >
                {t("chat.cancel_edit")}
              </Button>
            </div>
          ) : null}

          {suggestions.length > 0 ? (
            <div className="flex gap-2 overflow-x-auto rounded-lg px-1 py-1">
              {suggestions.map((suggestion, index) => (
                <button
                  key={`${suggestion}-${index}`}
                  type="button"
                  disabled={!canUseQuickMessage}
                  className={cn(
                    "shrink-0 rounded-lg border bg-background px-3 py-1 text-xs text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50",
                  )}
                  onClick={() => {
                    handleSuggestionSelect(suggestion);
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          ) : null}

          {attachments.length > 0 ? (
            <div className="flex flex-wrap gap-2 px-2 pt-1">
              {attachments.map((part, index) => {
                const key = `${part.type}-${index}`;
                return (
                  <div
                    key={key}
                    className="group inline-flex max-w-[220px] items-center gap-1 rounded-full border bg-background/80 px-2 py-1 text-xs"
                  >
                    {part.type === "image" ? (
                      <img
                        alt="upload"
                        className="size-5 rounded object-cover"
                        src={resolveFileUrl(part.url)}
                      />
                    ) : (
                      partIcon(part)
                    )}
                    <span className="truncate">{partLabel(part, t)}</span>
                    <button
                      className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={async () => {
                        if (!ready || disabled || isGenerating || submitting) return;

                        const fileId = getPartFileId(part);
                        if (fileId != null && (shouldDeleteFileOnRemove?.(part) ?? true)) {
                          try {
                            await api.delete<{ status: string }>(`files/${fileId}`);
                          } catch (deleteError) {
                            const message =
                              deleteError instanceof Error
                                ? deleteError.message
                                : t("chat.delete_attachment_failed");
                            setError(message);
                            return;
                          }
                        }

                        await onRemovePart(index, part);
                      }}
                      type="button"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}

          <Textarea
            ref={textareaRef}
            value={value}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            onPaste={(event) => {
              void handlePaste(event);
            }}
            placeholder={placeholder}
            disabled={!ready || disabled}
            className="resize-none border-0 bg-transparent dark:bg-transparent p-2 text-sm shadow-none focus-visible:ring-0"
            rows={2}
            style={{ minHeight: `${inputMinHeight}px`, maxHeight: `${inputMaxHeight}px` }}
          />
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1">
              <DropdownMenu open={uploadMenuOpen} onOpenChange={setUploadMenuOpen}>
                <input
                  ref={fileInputRef}
                  accept={DOCUMENT_UPLOAD_ACCEPT}
                  className="hidden"
                  multiple
                  onChange={handleUploadInputChange}
                  type="file"
                />
                <input
                  ref={imageInputRef}
                  accept={IMAGE_UPLOAD_ACCEPT}
                  className="hidden"
                  multiple
                  onChange={handleUploadInputChange}
                  type="file"
                />
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={!canUpload}
                    className="size-8 rounded-full text-muted-foreground hover:text-foreground"
                  >
                    <Plus
                      className={cn("size-4 transition-transform", uploadMenuOpen && "rotate-45")}
                    />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="min-w-36" side="top" align="start">
                  <DropdownMenuItem
                    onClick={() => {
                      imageInputRef.current?.click();
                    }}
                  >
                    <Image className="size-4" />
                    {t("chat.upload_image")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      fileInputRef.current?.click();
                    }}
                  >
                    <File className="size-4" />
                    {t("chat.upload_document")}
                  </DropdownMenuItem>
                  {onExportConversation && (
                    <DropdownMenuItem
                      onClick={() => {
                        onExportConversation(false);
                      }}
                    >
                      <FileDown className="size-4" />
                      {t("chat.export_conversation")}
                    </DropdownMenuItem>
                  )}
                  {onExportConversation && (
                    <DropdownMenuItem
                      onClick={() => {
                        onExportConversation(true);
                      }}
                    >
                      <FileDown className="size-4" />
                      {t("chat.export_conversation_with_reasoning")}
                    </DropdownMenuItem>
                  )}
                  {onCompressConversation && (
                    <DropdownMenuItem
                      onClick={() => {
                        onCompressConversation();
                      }}
                    >
                      <Scissors className="size-4" />
                      压缩对话历史
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <ModelList disabled={!canSwitchModel} className="max-w-64" />
              <SearchPickerButton disabled={!canSwitchModel} />
              <ReasoningPickerButton disabled={!canSwitchModel} />
              <McpPickerButton disabled={!canSwitchModel} />
              <ExtensionPickerButton disabled={!canSwitchModel} />
              <QuickMessageButton
                quickMessages={quickMessages}
                disabled={!canUseQuickMessage}
                onSelect={handleQuickMessageSelect}
              />
              <Button
                type="button"
                variant={asrListening ? "secondary" : "ghost"}
                size="icon"
                disabled={!canUseAsr && !asrListening}
                className={cn(
                  "size-8 rounded-full text-muted-foreground hover:text-foreground",
                  asrListening && "text-primary shadow-sm",
                )}
                title={asrListening ? "停止语音识别" : "语音识别"}
                onClick={toggleAsr}
              >
                {asrListening ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Mic className="size-4" />
                )}
              </Button>
            </div>
            <div className="relative flex items-center gap-1.5">
              {/* 优化较慢提示:浮在按钮组上方,绝对定位不挤占布局(原方案放底部会把整个输入区往下顶)。 */}
              {optimizeHint ? (
                <span className="animate-pulse absolute -top-8 right-0 z-10 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-[0.6875rem] text-muted-foreground shadow-sm">
                  {optimizeHint}
                </span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={isEmpty || optimizing || isGenerating || disabled}
                onClick={() => {
                  void handleOptimize();
                }}
                className="size-8 rounded-full text-muted-foreground hover:text-foreground"
                title="优化提示词"
              >
                {optimizing ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
              </Button>
              {originalBeforeOptimize !== null ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                  title="撤销本次优化,恢复原文"
                  onClick={() => {
                    onValueChange(originalBeforeOptimize);
                    setOriginalBeforeOptimize(null);
                  }}
                >
                  <Undo2 className="size-3.5" />
                  撤销
                </Button>
              ) : null}
              <Button
                onClick={() => {
                  void handlePrimaryAction();
                }}
                disabled={actionDisabled}
                size="icon"
                className={cn(
                  "size-9 rounded-full shadow-sm",
                  isGenerating && !submitting
                    ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    : "bg-primary text-primary-foreground hover:bg-primary/90",
                )}
              >
                {submitting || uploading ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : isGenerating ? (
                  <Square className="size-4" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </Button>
            </div>
          </div>
        </div>
        <p className="mt-2 text-center text-xs text-muted-foreground">{sendHint}</p>
        {error ? <p className="mt-1 text-center text-xs text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}

export const ChatInput = React.memo(ChatInputInner);
ChatInput.displayName = "ChatInput";

type QuickMessageOption = {
  title: string;
  content: string;
};

interface QuickMessageButtonProps {
  quickMessages: QuickMessageOption[];
  disabled?: boolean;
  onSelect: (content: string) => void;
}

function QuickMessageButton({
  quickMessages,
  disabled = false,
  onSelect,
}: QuickMessageButtonProps) {
  if (quickMessages.length === 0) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          className="size-8 rounded-full text-muted-foreground hover:text-foreground"
        >
          <Zap className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-72" side="top" align="start">
        {quickMessages.map((quickMessage, index) => {
          const key = `${quickMessage.title}-${index}`;
          return (
            <DropdownMenuItem
              key={key}
              className="items-start"
              onClick={() => {
                onSelect(quickMessage.content);
              }}
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{quickMessage.title}</div>
                <div className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
                  {quickMessage.content}
                </div>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
