import * as React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  Ellipsis,
  FileDown,
  Gauge,
  GitFork,
  Languages,
  Pencil,
  RefreshCw,
  Share2,
  Volume2,
  VolumeX,
  Trash2,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { useSettingsStore } from "~/stores";
import type {
  AssistantProfile,
  MessageDto,
  MessageNodeDto,
  ProviderProfile,
  ProviderModel,
  TokenUsage,
  UIMessageAnnotation,
  UIMessagePart,
} from "~/types";

import { copyTextToClipboard } from "~/lib/clipboard";
import { convertMessageToMarkdown, downloadMarkdown } from "~/lib/export-markdown";
import { openExternal } from "~/lib/external-link";
import { cn } from "~/lib/utils";
import {
  getAudioPlaybackKey,
  playAudio,
  playSpeechSynthesis,
  stopAudio,
  useAudioPlaybackKey,
} from "~/lib/global-audio";
import { ttsController, useIsTtsActiveForKey } from "~/lib/tts/tts-controller";
import { Button } from "~/components/ui/button";
import api from "~/services/api";
import { useCurrentModel } from "~/hooks/use-current-model";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { ChatMessageAnnotationsRow } from "./chat-message-annotations";
import { ChatMessageAvatarRow } from "./chat-message-avatar-row";
import { MessageParts } from "./message-part";
import Markdown from "~/components/markdown/markdown";

interface ChatMessageProps {
  node: MessageNodeDto;
  message: MessageDto;
  loading?: boolean;
  isLastMessage?: boolean;
  assistant?: AssistantProfile | null;
  model?: ProviderModel | null;
  onEdit?: (message: MessageDto) => void | Promise<void>;
  onRegenerate?: (messageId: string) => void | Promise<void>;
  onSelectBranch?: (nodeId: string, selectIndex: number) => void | Promise<void>;
  onDelete?: (messageId: string) => void | Promise<void>;
  onFork?: (messageId: string) => void | Promise<void>;
  onTranslate?: (messageId: string) => void | Promise<void>;
  onToolApproval?: (
    toolCallId: string,
    approved: boolean,
    reason: string,
    answer?: string,
  ) => void | Promise<void>;
}

function hasRenderablePart(part: UIMessagePart): boolean {
  switch (part.type) {
    case "text":
      return part.text.trim().length > 0;
    case "image":
    case "video":
    case "audio":
      return part.url.trim().length > 0;
    case "document":
      return part.url.trim().length > 0 || part.fileName.trim().length > 0;
    case "reasoning":
      return part.reasoning.trim().length > 0;
    case "tool":
      return true;
    case "loading":
      return false;
  }
}

function messageHasModelCallError(message: MessageDto): boolean {
  if (message.role !== "ASSISTANT") return false;
  return message.parts.some((part) => {
    if (part.type !== "text") return false;
    return /请求失败|request failed|network error|timeout|模型不存在|model.*not.*found|401|403|404|429|500/i.test(
      part.text,
    );
  });
}

function providerIdForMessageModel(
  modelId: string | null | undefined,
  providers: ProviderProfile[] | undefined,
): string | null {
  if (!modelId || !providers) return null;
  const provider = providers.find((item) =>
    item.models?.some((modelItem) => modelItem.id === modelId || modelItem.modelId === modelId),
  );
  return provider?.id ?? null;
}

function providerModelIdForMessageModel(
  modelId: string | null | undefined,
  providers: ProviderProfile[] | undefined,
): string | null {
  if (!modelId || !providers) return null;
  const model = providers
    .flatMap((provider) => provider.models ?? [])
    .find((modelItem) => modelItem.id === modelId || modelItem.modelId === modelId);
  return model?.modelId ?? null;
}

function formatPartForCopy(part: UIMessagePart, t: TFunction): string | null {
  switch (part.type) {
    case "text":
      return stripThinkTags(part.text);
    case "image":
      return `[${t("chat_message.copy_image")}] ${part.url}`;
    // Media references are kept in copy output because the user may want the URL/filename
    // to paste into a doc; speech output skips them via buildSpeechText.
    case "video":
      return `[${t("chat_message.copy_video")}] ${part.url}`;
    case "audio":
      return `[${t("chat_message.copy_audio")}] ${part.url}`;
    case "document":
      return `[${t("chat_message.copy_document")}] ${part.fileName}`;
    case "reasoning":
      // Thinking chain is the model's internal scratchpad — never useful in a copy/paste.
      // Returning null means buildCopyText.filter drops it.
      return null;
    case "tool":
      // Tool calls (web search, calculator, etc.) are conversation machinery, not body
      // content. The model's answer that follows is what the user wants to copy.
      return null;
    case "loading":
      return null;
  }
}

/**
 * Some upstream models stream inline `<think>...</think>` reasoning instead of using a
 * separate `reasoning` part. The PC `ThinkTagTransformer` should normally extract those
 * before they reach a text part, but stale conversations may still contain raw think
 * tags. Strip them here so they never leak into copy or speech output.
 */
function stripThinkTags(text: string): string {
  return (
    text
      .replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, "")
      // Open tag with no close (truncated stream): drop everything from the open onward.
      .replace(/<think\b[^>]*>[\s\S]*$/i, "")
      .trim()
  );
}

function buildCopyText(parts: UIMessagePart[], t: TFunction): string {
  return parts
    .map((part) => formatPartForCopy(part, t))
    .filter((value): value is string => Boolean(value && value.trim().length > 0))
    .join("\n\n")
    .trim();
}

/**
 * Like `buildCopyText`, but stricter — only `text` parts, no media references. Tailored
 * for TTS playback. Skips:
 *   - `reasoning` (思维链): users want the answer, not the model's internal scratchpad.
 *   - `tool` (网络搜索 / 工具调用): tool-name placeholders aren't useful spoken aloud.
 *   - Media references (`image` / `video` / `audio` / `document`): URLs are noise when
 *     read aloud (TTS engines turn "https://..." into a string of letters).
 *   - Inline `<think>` blocks: defense in depth in case a model streamed thinking inline.
 *
 * Matches Android's `message.toText()` behavior used by the chat-screen TTS button.
 */
function buildSpeechText(parts: UIMessagePart[]): string {
  return parts
    .map((part) => (part.type === "text" ? stripThinkTags(part.text) : null))
    .filter((value): value is string => Boolean(value && value.trim().length > 0))
    .join("\n\n")
    .trim();
}

function hasEditableContent(parts: UIMessagePart[]): boolean {
  return parts.some(
    (part) =>
      part.type === "text" ||
      part.type === "image" ||
      part.type === "video" ||
      part.type === "audio" ||
      part.type === "document",
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

// 当前选中模型的 context limit 缓存(按 "providerType/modelId" 键,值是 Promise)。
// 让统计行分母跟随"当前模型"而非"生成时模型"——切模型时分母立即更新,辅助用户判断
// "换成这个模型容量够不够"。缓存 Promise 而非解析后的值,是为了同 tick 去重:一条对话
// 50 条消息同时 mount 时只发 1 个请求(而不是 50 个),解析完的 Promise 复用即零开销。
const contextLimitCache = new Map<string, Promise<number | null>>();
function useCurrentContextLimit(): number | null | undefined {
  const { currentModel, currentProvider } = useCurrentModel();
  const modelId = currentModel?.modelId;
  // currentProvider.type 经 ProviderProfile 的索引签名返回 unknown,显式窄化为 string。
  const providerType = typeof currentProvider?.type === "string" ? currentProvider.type : "";
  const [limit, setLimit] = React.useState<number | null | undefined>(undefined);
  React.useEffect(() => {
    if (!modelId || !providerType) {
      setLimit(undefined);
      return;
    }
    const cacheKey = `${providerType}/${modelId}`;
    // 首次查才发请求,后续(含同 tick 其他消息)复用同一 Promise。后端 context-limit 路由
    // 会 await models.dev 加载完,所以 null 的语义是确定的"models.dev 里查不到"——可安全缓存。
    let p = contextLimitCache.get(cacheKey);
    if (!p) {
      p = api
        .get<{ contextLimit: number | null }>(
          `context-limit?modelId=${encodeURIComponent(modelId)}&providerType=${encodeURIComponent(providerType)}`,
        )
        .then((res) => res.contextLimit ?? null)
        .catch(() => null);
      contextLimitCache.set(cacheKey, p);
    }
    let cancelled = false;
    setLimit(undefined); // loading:此时 getNerdStats 回退到 usage.contextLimit(不闪烁)
    void p.then((v) => {
      if (!cancelled) setLimit(v);
    });
    return () => {
      cancelled = true;
    };
  }, [modelId, providerType]);
  return limit;
}

function getDurationMs(createdAt: string, finishedAt?: string | null): number | null {
  const start = Date.parse(createdAt);
  if (Number.isNaN(start)) return null;

  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (Number.isNaN(end) || end <= start) return null;

  return end - start;
}

interface NerdStatItem {
  key: string;
  icon: React.ReactNode;
  label: string;
}

// Context window 占用单独返回(渲染时推到行尾右对齐),与 token / 速度 / 时长那组左对齐分开。
interface NerdStats {
  items: NerdStatItem[];
  context: NerdStatItem | null;
}

function getNerdStats(
  usage: TokenUsage,
  createdAt: string,
  finishedAt: string | null | undefined,
  t: TFunction,
  liveContextLimit?: number | null,
): NerdStats {
  const items: NerdStatItem[] = [];

  items.push({
    key: "prompt",
    icon: <ArrowUp className="size-3" />,
    label:
      usage.cachedTokens > 0
        ? t("chat_message.prompt_tokens_with_cache", {
            promptTokens: formatNumber(usage.promptTokens),
            cachedTokens: formatNumber(usage.cachedTokens),
          })
        : t("chat_message.prompt_tokens", {
            promptTokens: formatNumber(usage.promptTokens),
          }),
  });

  items.push({
    key: "completion",
    icon: <ArrowDown className="size-3" />,
    label: t("chat_message.completion_tokens", {
      completionTokens: formatNumber(usage.completionTokens),
    }),
  });

  const durationMs = getDurationMs(createdAt, finishedAt);
  if (durationMs && usage.completionTokens > 0) {
    const durationSeconds = durationMs / 1000;
    const tps = usage.completionTokens / durationSeconds;

    items.push({
      key: "speed",
      icon: <Zap className="size-3" />,
      label: t("chat_message.tokens_per_second", {
        value: tps.toFixed(1),
      }),
    });

    items.push({
      key: "duration",
      icon: <Clock3 className="size-3" />,
      label: t("chat_message.duration_seconds", {
        value: durationSeconds.toFixed(1),
      }),
    });
  }

  // Context window 占用:分子 = 累积上下文 = promptTokens(本轮输入,含全部历史 + 系统提示)
  // + completionTokens(本轮输出)。这是"这条消息之后,对话窗口里一共有多少 token"——下一轮
  // 发送时 prompt 会包含的总量。单看 promptTokens 会漏掉刚生成的回复,显得偏小(例如 17 而非
  // 771)。分母 = 模型最大上下文(来自 models.dev 目录,后端按 modelId 匹配);匹配不到则只显示
  // 分子。分母优先用当前选中模型的 contextLimit(切模型即更新),loading / 查不到时回退到该消息
  // 生成时的快照(usage.contextLimit),避免切换瞬间分母闪烁/消失。
  const contextTokens = usage.promptTokens + usage.completionTokens;
  let context: NerdStatItem | null = null;
  if (contextTokens > 0) {
    const used =
      contextTokens >= 1000 ? `${(contextTokens / 1000).toFixed(1)}k` : String(contextTokens);
    const liveValue = liveContextLimit != null && liveContextLimit > 0 ? liveContextLimit : null;
    const snapValue = usage.contextLimit && usage.contextLimit > 0 ? usage.contextLimit : null;
    const limitValue = liveValue ?? snapValue;
    const limit =
      limitValue != null
        ? limitValue >= 1000
          ? `${(limitValue / 1000).toFixed(1)}k`
          : String(limitValue)
        : null;
    context = {
      key: "context",
      icon: <Gauge className="size-3" />,
      label: limit ? `${used} / ${limit}` : used,
    };
  }

  return { items, context };
}

function parseToolOutputJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Some models wrap JSON in fenced blocks.
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (!fenced) return null;
    try {
      return JSON.parse(fenced[1]);
    } catch {
      return null;
    }
  }
}

function addCitationUrlAlias(map: Map<string, string>, id: string, url: string) {
  const normalized = id.trim();
  if (!normalized || !url) return;
  const aliases = new Set([
    normalized,
    normalized.replace(/^s/i, ""),
    normalized.replace(/^#/, ""),
    normalized.replace(/^\[/, "").replace(/\]$/, ""),
  ]);
  const numeric = normalized.match(/\d+/)?.[0];
  if (numeric) {
    aliases.add(numeric);
    aliases.add(`s${numeric}`);
  }
  aliases.forEach((alias) => {
    if (alias && !map.has(alias)) map.set(alias, url);
  });
}

function buildCitationUrlMap(
  parts: UIMessagePart[],
  annotations?: UIMessageAnnotation[],
): Map<string, string> {
  const map = new Map<string, string>();

  annotations
    ?.filter((annotation) => annotation.type === "url_citation")
    .forEach((annotation, index) => {
      addCitationUrlAlias(map, `${index + 1}`, annotation.url);
      if (annotation.title) addCitationUrlAlias(map, annotation.title, annotation.url);
    });

  parts.forEach((part) => {
    if (part.type !== "tool" || part.toolName !== "search_web") return;
    const outputText = part.output
      .filter(
        (outputPart): outputPart is { type: "text"; text: string } => outputPart.type === "text",
      )
      .map((outputPart) => outputPart.text)
      .join("\n");
    const parsed = parseToolOutputJson(outputText);
    if (!parsed || typeof parsed !== "object") return;
    const items = (parsed as { items?: unknown }).items;
    if (!Array.isArray(items)) return;

    items.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const id = String((item as { id?: unknown }).id ?? "").trim();
      const url = String((item as { url?: unknown }).url ?? "").trim();
      if (!url) return;
      if (id) addCitationUrlAlias(map, id, url);
      addCitationUrlAlias(map, `${index + 1}`, url);
      const title = String((item as { title?: unknown }).title ?? "").trim();
      if (title) addCitationUrlAlias(map, title, url);
    });
  });

  return map;
}

/**
 * Maps citation identifiers (the value inside `[citation,domain](id)` Markdown links) to a
 * 1-based display ordinal. Both Android's search tool and PC's `search_web` tool tag each
 * source with an opaque id (Android uses a 6-char hex prefix; PC uses index-or-id). The
 * raw id is meaningless to users — they expect "[1] [2] [3]" — so the Markdown renderer
 * uses this map to substitute the badge label.
 *
 * Built in two passes (annotations first, then tool outputs) so an explicit
 * `url_citation` annotation takes precedence over the same source appearing inside a tool
 * result. A single ordinal is reused if the same id shows up multiple times.
 */
function buildCitationOrdinalMap(
  parts: UIMessagePart[],
  annotations?: UIMessageAnnotation[],
): Map<string, number> {
  const map = new Map<string, number>();
  let nextOrdinal = 1;
  const assign = (key: string) => {
    const trimmed = key.trim();
    if (!trimmed || map.has(trimmed)) return;
    map.set(trimmed, nextOrdinal++);
  };

  annotations
    ?.filter((annotation) => annotation.type === "url_citation")
    .forEach((annotation) => {
      // Annotations themselves don't carry an id on either platform — they're addressed by
      // position. We still register the numeric ordinal so `[citation,domain](1)` markers
      // (the format PC's preProcess emits) resolve to themselves.
      const idx = nextOrdinal;
      assign(`${idx}`);
      if (annotation.title) assign(annotation.title);
    });

  parts.forEach((part) => {
    if (part.type !== "tool" || part.toolName !== "search_web") return;
    const outputText = part.output
      .filter(
        (outputPart): outputPart is { type: "text"; text: string } => outputPart.type === "text",
      )
      .map((outputPart) => outputPart.text)
      .join("\n");
    const parsed = parseToolOutputJson(outputText);
    if (!parsed || typeof parsed !== "object") return;
    const items = (parsed as { items?: unknown }).items;
    if (!Array.isArray(items)) return;

    items.forEach((item) => {
      if (!item || typeof item !== "object") return;
      const id = String((item as { id?: unknown }).id ?? "").trim();
      const title = String((item as { title?: unknown }).title ?? "").trim();
      // The ordinal is assigned by registration order: each new item bumps the counter
      // once via the first `assign` call; subsequent assigns for the same item's aliases
      // (numeric position, title) hit the same ordinal because map.has gates the bump.
      const ordinalForThisItem = nextOrdinal;
      if (id) assign(id);
      // Numeric alias so `[citation,domain](2)` (PC's preProcess format) still resolves.
      assign(`${ordinalForThisItem}`);
      if (title) assign(title);
    });
  });

  return map;
}

const ChatMessageActionsRow = React.memo(
  ({
    node,
    message,
    loading,
    alignRight,
    onEdit,
    onRegenerate,
    onSelectBranch,
    onDelete,
    onFork,
    onTranslate,
  }: {
    node: MessageNodeDto;
    message: MessageDto;
    loading: boolean;
    alignRight: boolean;
    onEdit?: (message: MessageDto) => void | Promise<void>;
    onRegenerate?: (messageId: string) => void | Promise<void>;
    onSelectBranch?: (nodeId: string, selectIndex: number) => void | Promise<void>;
    onDelete?: (messageId: string) => void | Promise<void>;
    onFork?: (messageId: string) => void | Promise<void>;
    onTranslate?: (messageId: string) => void | Promise<void>;
  }) => {
    const { t } = useTranslation("message");
    const [regenerating, setRegenerating] = React.useState(false);
    const [translating, setTranslating] = React.useState(false);
    // `speaking` is now driven by the chunked TtsController (Android-parity, per-chunk billing).
    // The legacy `useAudioPlaybackKey()` is retained as a fallback for unrelated one-shot
    // audio plays (e.g. TTS-settings test sample) so their stop/play icons still toggle.
    const playingKey = useAudioPlaybackKey();
    const ttsActiveForThis = useIsTtsActiveForKey(message.id);
    const speaking = ttsActiveForThis || playingKey === message.id;
    const [switchingBranch, setSwitchingBranch] = React.useState(false);
    const [deleting, setDeleting] = React.useState(false);
    const [forking, setForking] = React.useState(false);
    const [copied, setCopied] = React.useState(false);
    const copyTimerRef = React.useRef<number | null>(null);

    const handleCopy = React.useCallback(async () => {
      const text = buildCopyText(message.parts, t);
      if (!text) return;

      try {
        await copyTextToClipboard(text);
        setCopied(true);
        if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = window.setTimeout(() => setCopied(false), 1400);
      } catch {
        // Ignore copy failures to keep action row interaction uninterrupted.
      }
    }, [message.parts, t]);

    React.useEffect(
      () => () => {
        if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
      },
      [],
    );

    const handleRegenerate = React.useCallback(async () => {
      if (!onRegenerate) return;

      if (message.role === "USER") {
        const confirmed = window.confirm(t("chat_message.regenerate_from_user_confirm"));
        if (!confirmed) return;
      }

      setRegenerating(true);
      try {
        await onRegenerate(message.id);
      } finally {
        setRegenerating(false);
      }
    }, [message.id, message.role, onRegenerate, t]);

    const handleSwitchBranch = React.useCallback(
      async (selectIndex: number) => {
        if (!onSelectBranch) return;
        if (selectIndex < 0 || selectIndex > node.messages.length - 1) return;
        if (selectIndex === node.selectIndex) return;

        setSwitchingBranch(true);
        try {
          await onSelectBranch(node.id, selectIndex);
        } finally {
          setSwitchingBranch(false);
        }
      },
      [node.id, node.messages.length, node.selectIndex, onSelectBranch],
    );

    const handleDelete = React.useCallback(async () => {
      if (!onDelete) return;

      const confirmed = window.confirm(t("chat_message.delete_confirm"));
      if (!confirmed) return;

      setDeleting(true);
      try {
        await onDelete(message.id);
      } finally {
        setDeleting(false);
      }
    }, [message.id, onDelete, t]);

    const handleFork = React.useCallback(async () => {
      if (!onFork) return;

      setForking(true);
      try {
        await onFork(message.id);
      } finally {
        setForking(false);
      }
    }, [message.id, onFork]);

    // When THIS row unmounts, only stop playback if WE were the active speaker. With a
    // virtualized list this fires whenever the message scrolls out of view; calling
    // stopAudio() unconditionally would interrupt unrelated playback (e.g. user scrolled
    // away while message A is being read aloud). We read the latest playback key via
    // getAudioPlaybackKey() at cleanup time rather than relying on the captured
    // `playingKey` — the captured value is stale (set when the effect was created, not
    // when the cleanup fires).
    React.useEffect(() => {
      return () => {
        // Stop the legacy single-blob playback (browser SpeechSynthesis / one-shot Audio)
        // because that path can't survive a re-render anyway.
        if (getAudioPlaybackKey() === message.id) stopAudio();
        // INTENTIONALLY do NOT tear down ttsController here. The chunked playback singleton
        // lives at app scope and the floating TtsPlayBar is the user's "stop" control.
        // Tearing it down on row unmount caused two user-visible bugs:
        //   - the last chunk of a long message would get cut off when the virtualized list
        //     scrolled the row off-screen mid-playback
        //   - switching to another conversation killed playback the user wanted to keep
        // The bar stays visible regardless of which row is mounted; users explicitly stop
        // via its ✕ button.
      };
    }, [message.id]);

    const handleSpeak = React.useCallback(async () => {
      // Toggle: if THIS message is currently playing, stop the chunked controller and bail.
      if (speaking) {
        ttsController.stop();
        // Also kill any legacy single-blob playback that might be live for this message
        // (e.g. SpeechSynthesis fallback from a previous failed attempt).
        stopAudio();
        return;
      }
      // buildSpeechText (not buildCopyText) so the reasoning chain is skipped — users want to
      // hear the answer, not the model's internal scratchpad.
      const text = buildSpeechText(message.parts);
      if (!text) return;
      // Hand off to the chunked controller. It will:
      //   1. split the text via TextChunker (≤160 chars, paragraph/punctuation aware)
      //   2. prefetch up to 4 chunks ahead via /api/tts/speech (one HTTP call per chunk)
      //   3. play them in order through HTMLAudioElement, surface state via the play-bar
      // If the user pauses or stops mid-stream, only the chunks already in flight are billed.
      // Per-chunk cache keeps re-plays free.
      ttsController.speak(text, message.id, true);
      // Note: we no longer fall back to window.speechSynthesis here. A synthesis failure
      // surfaces via ttsController's PlaybackState.errorMessage which the play-bar reads;
      // forcing a parallel SpeechSynthesis stream on failure would just talk over the
      // controller-driven retry.
    }, [message.id, message.parts, speaking]);

    const handleTranslate = React.useCallback(async () => {
      if (!onTranslate || translating) return;
      setTranslating(true);
      try {
        await onTranslate(message.id);
      } finally {
        setTranslating(false);
      }
    }, [message.id, onTranslate, translating]);

    const canSwitchBranch = Boolean(onSelectBranch) && node.messages.length > 1;
    const canEdit =
      Boolean(onEdit) &&
      (message.role === "USER" || message.role === "ASSISTANT") &&
      hasEditableContent(message.parts);
    const actionDisabled = loading || switchingBranch || regenerating || deleting || forking;
    const actionButtonClass = "transition-all hover:shadow-sm active:shadow-inner";

    return (
      <div
        className={cn(
          "flex w-full items-center gap-1 px-1",
          alignRight ? "justify-end" : "justify-start",
        )}
      >
        <Button
          aria-label={t("chat_message.copy_message")}
          disabled={actionDisabled}
          className={actionButtonClass}
          onClick={() => {
            void handleCopy();
          }}
          size="icon-xs"
          title={copied ? t("chat_message.copied", "已复制") : t("chat_message.copy")}
          type="button"
          variant="ghost"
        >
          {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
        </Button>

        {canEdit && (
          <Button
            aria-label={t("chat_message.edit_message")}
            disabled={actionDisabled}
            className={actionButtonClass}
            onClick={() => {
              void onEdit?.(message);
            }}
            size="icon-xs"
            title={t("chat_message.edit")}
            type="button"
            variant="ghost"
          >
            <Pencil className="size-3.5" />
          </Button>
        )}

        {onRegenerate && (
          <Button
            aria-label={t("chat_message.regenerate")}
            disabled={actionDisabled}
            className={actionButtonClass}
            onClick={() => {
              void handleRegenerate();
            }}
            size="icon-xs"
            title={t("chat_message.regenerate")}
            type="button"
            variant="ghost"
          >
            <RefreshCw className={cn("size-3.5", regenerating && "animate-spin")} />
          </Button>
        )}

        {message.role === "ASSISTANT" && (
          <>
            <Button
              aria-label={speaking ? t("chat_message.stop_reading") : t("chat_message.read_aloud")}
              disabled={actionDisabled}
              className={actionButtonClass}
              onClick={handleSpeak}
              size="icon-xs"
              title={speaking ? t("chat_message.stop_reading") : t("chat_message.read_aloud")}
              type="button"
              variant="ghost"
            >
              {speaking ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
            </Button>
            <Button
              aria-label={t("chat_message.translate")}
              disabled={actionDisabled || translating}
              className={actionButtonClass}
              onClick={() => {
                void handleTranslate();
              }}
              size="icon-xs"
              title={translating ? t("chat_message.translating") : t("chat_message.translate")}
              type="button"
              variant="ghost"
            >
              <Languages className={cn("size-3.5", translating && "animate-pulse")} />
            </Button>
          </>
        )}

        {canSwitchBranch && (
          <>
            <Button
              aria-label={t("chat_message.previous_branch")}
              disabled={actionDisabled || node.selectIndex <= 0}
              className={actionButtonClass}
              onClick={() => {
                void handleSwitchBranch(node.selectIndex - 1);
              }}
              size="icon-xs"
              title={t("chat_message.previous_branch")}
              type="button"
              variant="ghost"
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {node.selectIndex + 1}/{node.messages.length}
            </span>
            <Button
              aria-label={t("chat_message.next_branch")}
              disabled={actionDisabled || node.selectIndex >= node.messages.length - 1}
              className={actionButtonClass}
              onClick={() => {
                void handleSwitchBranch(node.selectIndex + 1);
              }}
              size="icon-xs"
              title={t("chat_message.next_branch")}
              type="button"
              variant="ghost"
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={t("chat_message.more_actions")}
              disabled={actionDisabled}
              className={actionButtonClass}
              size="icon-xs"
              title={t("chat_message.more_actions")}
              type="button"
              variant="ghost"
            >
              <Ellipsis className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align={alignRight ? "end" : "start"}>
            <DropdownMenuItem
              onSelect={() => {
                const content = convertMessageToMarkdown(message, false);
                downloadMarkdown(content, `message-${message.id}.md`);
              }}
            >
              <FileDown className="size-3.5" />
              {t("chat_message.export_markdown")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                const content = convertMessageToMarkdown(message, true);
                downloadMarkdown(content, `message-${message.id}.md`);
              }}
            >
              <FileDown className="size-3.5" />
              {t("chat_message.export_markdown_with_reasoning")}
            </DropdownMenuItem>
            {onFork && (
              <DropdownMenuItem
                disabled={actionDisabled}
                onSelect={() => {
                  void handleFork();
                }}
              >
                <GitFork className="size-3.5" />
                {t("chat_message.create_fork")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => {
                const text = buildCopyText(message.parts, t);
                void copyTextToClipboard(text)
                  .then(() =>
                    toast.success(t("chat_message.share_copied", "已复制，可粘贴到微信或其他应用")),
                  )
                  .catch((error) =>
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : t("chat_message.copy_failed", "复制失败"),
                    ),
                  );
              }}
            >
              <Share2 className="size-3.5" />
              {t("chat_message.share")}
            </DropdownMenuItem>
            {onDelete && (
              <DropdownMenuItem
                variant="destructive"
                disabled={actionDisabled}
                onSelect={() => {
                  void handleDelete();
                }}
              >
                <Trash2 className="size-3.5" />
                {t("chat_message.delete")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  },
);

const ChatMessageNerdLineRow = React.memo(
  ({ message, alignRight }: { message: MessageDto; alignRight: boolean }) => {
    const { t } = useTranslation("message");
    const displaySetting = useSettingsStore((state) => state.settings?.displaySetting);
    // 分母跟随当前选中模型:切模型时这条统计行的分母立即更新(产品意图是"当下决策依据",
    // 而非"生成时的历史快照")。loading/查不到时 getNerdStats 内部回退到 usage.contextLimit。
    const liveContextLimit = useCurrentContextLimit();

    if (!displaySetting?.showTokenUsage || !message.usage) {
      return null;
    }

    const { items, context } = getNerdStats(
      message.usage,
      message.createdAt,
      message.finishedAt,
      t,
      liveContextLimit,
    );
    if (items.length === 0 && !context) return null;

    const renderStat = (item: { key: string; icon: React.ReactNode; label: string }) => (
      <div key={item.key} className="inline-flex items-center gap-1">
        {item.icon}
        <span>{item.label}</span>
      </div>
    );

    // 上下文占用单独推到行尾右对齐,与 token / 速度 / 时长那组左对齐分开 —— 更易扫读"还剩多少额度"。
    // 无上下文项时(items 有但 context 为空)退化为单组,保持 alignRight 的左右贴边行为。
    if (!context) {
      return (
        <div
          className={cn(
            "flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-muted-foreground/50",
            alignRight ? "justify-end" : "justify-start",
          )}
        >
          {items.map(renderStat)}
        </div>
      );
    }

    return (
      <div className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 text-[11px] text-muted-foreground/50">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {items.map(renderStat)}
        </div>
        {renderStat(context)}
      </div>
    );
  },
);

export const ChatMessage = React.memo(
  ({
    node,
    message,
    loading = false,
    isLastMessage = false,
    assistant,
    model,
    onEdit,
    onRegenerate,
    onSelectBranch,
    onDelete,
    onFork,
    onTranslate,
    onToolApproval,
  }: ChatMessageProps) => {
    const isUser = message.role === "USER";
    const providers = useSettingsStore((state) => state.settings?.providers);
    const displaySetting = useSettingsStore((state) => state.settings?.displaySetting);
    const hasMessageContent = message.parts.some(hasRenderablePart);
    const hasModelCallError = messageHasModelCallError(message);
    const modelProviderId = providerIdForMessageModel(message.modelId, providers);
    const providerModelId = providerModelIdForMessageModel(message.modelId, providers);
    const modelSettingsHref = modelProviderId
      ? `/settings?section=providers&providerId=${encodeURIComponent(modelProviderId)}${providerModelId ? `&modelId=${encodeURIComponent(providerModelId)}` : ""}`
      : "/settings?section=providers";
    const showActions = isLastMessage ? !loading : hasMessageContent;
    const showAssistantBubble = !isUser && displaySetting?.showAssistantBubble === true;
    const citationUrlMap = React.useMemo(
      () => buildCitationUrlMap(message.parts, message.annotations),
      [message.annotations, message.parts],
    );
    const citationOrdinalMap = React.useMemo(
      () => buildCitationOrdinalMap(message.parts, message.annotations),
      [message.annotations, message.parts],
    );
    const handleClickCitation = React.useCallback(
      (citationId: string) => {
        const normalized = citationId.trim();
        const url =
          citationUrlMap.get(normalized) ??
          citationUrlMap.get(normalized.replace(/^s/i, "")) ??
          citationUrlMap.get(normalized.match(/\d+/)?.[0] ?? "");
        if (!url || typeof window === "undefined") return;
        void openExternal(url);
      },
      [citationUrlMap],
    );

    return (
      <div
        className={cn("group/message flex flex-col gap-4", isUser ? "items-end" : "items-start")}
        data-message-role={message.role.toLowerCase()}
        data-message-loading={loading || undefined}
      >
        <div className="flex w-full flex-col gap-2">
          <ChatMessageAvatarRow
            message={message}
            hasMessageContent={hasMessageContent}
            loading={loading}
            assistant={assistant}
            model={model}
          />

          <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}>
            <div
              data-message-bubble
              className={cn(
                "flex flex-col gap-2 text-sm leading-6 transition-all duration-200",
                isUser
                  ? "max-w-[85%] rounded-2xl rounded-tr-md border border-border/30 bg-muted px-4 py-3 text-foreground shadow-card hover:-translate-x-0.5 hover:shadow-elevated"
                  : showAssistantBubble
                    ? "w-fit max-w-[92%] rounded-2xl border border-border/40 bg-muted/40 px-3 py-2 shadow-sm hover:bg-muted/60"
                    : "w-full hover:bg-muted/20",
              )}
            >
              <MessageParts
                parts={message.parts}
                loading={loading}
                assistant={assistant}
                role={message.role as "USER" | "ASSISTANT" | "SYSTEM" | "TOOL"}
                onToolApproval={onToolApproval}
                onClickCitation={handleClickCitation}
                citationOrdinalMap={citationOrdinalMap}
              />
            </div>
          </div>
        </div>

        {showActions && (
          <div
            data-message-actions
            className="opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/message:opacity-100"
          >
            <ChatMessageActionsRow
              node={node}
              message={message}
              loading={loading}
              alignRight={isUser}
              onEdit={onEdit}
              onRegenerate={onRegenerate}
              onSelectBranch={onSelectBranch}
              onDelete={onDelete}
              onFork={onFork}
              onTranslate={onTranslate}
            />
          </div>
        )}

        {hasModelCallError ? (
          <a
            className="mx-1 inline-flex items-center gap-1 rounded-md border bg-card px-2 py-1 text-xs text-primary shadow-sm transition hover:bg-accent"
            href={modelSettingsHref}
          >
            <Zap className="size-3.5" />
            打开模型设置
          </a>
        ) : null}

        <ChatMessageAnnotationsRow annotations={message.annotations} alignRight={isUser} />

        {message.translation ? (
          <TranslationBlock
            content={message.translation}
            alignRight={isUser}
            onClickCitation={handleClickCitation}
            citationOrdinalMap={citationOrdinalMap}
          />
        ) : null}

        <ChatMessageNerdLineRow message={message} alignRight={isUser} />
      </div>
    );
  },
);

const TranslationBlock = React.memo(
  ({
    content,
    alignRight,
    onClickCitation,
    citationOrdinalMap,
  }: {
    content: string;
    alignRight: boolean;
    onClickCitation: (citationId: string) => void;
    citationOrdinalMap?: Map<string, number>;
  }) => {
    const [collapsed, setCollapsed] = React.useState(false);
    const isLoading = content.trim() === "" || content.trim() === "正在翻译...";

    return (
      <div className={cn("w-full px-1", alignRight ? "text-right" : "text-left")}>
        <div className="my-1 h-px w-full bg-border/70" />
        <div
          className={cn(
            "flex items-center gap-2 py-1",
            alignRight ? "justify-end" : "justify-start",
          )}
        >
          <Languages className="size-4 text-primary" />
          <button
            type="button"
            className="text-sm font-semibold text-primary"
            onClick={() => setCollapsed((current) => !current)}
          >
            译文
          </button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            onClick={() => setCollapsed((current) => !current)}
            aria-label={collapsed ? "展开译文" : "收起译文"}
            title={collapsed ? "展开译文" : "收起译文"}
          >
            {collapsed ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" />}
          </Button>
        </div>
        {!collapsed && (
          <div
            data-message-bubble
            className="rounded-md border bg-muted/40 px-3 py-2 text-left text-sm"
          >
            {isLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="size-3.5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
                正在翻译...
              </div>
            ) : null}
            {content.trim() && content.trim() !== "正在翻译..." ? (
              <Markdown
                content={content}
                className="message-markdown"
                onClickCitation={onClickCitation}
                citationOrdinalMap={citationOrdinalMap}
              />
            ) : null}
          </div>
        )}
      </div>
    );
  },
);
