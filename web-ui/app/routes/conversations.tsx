import * as React from "react";

import { useNavigate, useParams, useSearchParams } from "react-router";

import {
  ConversationQuickJump,
  getConversationMessageAnchorId,
} from "~/components/conversation-quick-jump";
import { ConversationSidebar } from "~/components/conversation-sidebar";
import { useTheme } from "~/components/theme-provider";
import { ConversationEmptyState } from "~/components/extended/conversation";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ChatInput } from "~/components/input/chat-input";
import { ChatMessage } from "~/components/message/chat-message";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Drawer, DrawerContent } from "~/components/ui/drawer";
import { Input } from "~/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "~/components/ui/resizable";
import { TypingIndicator } from "~/components/ui/typing-indicator";
import { Textarea } from "~/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "~/components/ui/sidebar";
import { useIsMobile } from "~/hooks/use-mobile";
import { toConversationSummaryUpdate, useConversationList } from "~/hooks/use-conversation-list";
import { useCurrentAssistant } from "~/hooks/use-current-assistant";
import { useCurrentModel } from "~/hooks/use-current-model";
import { getAssistantDisplayName, getModelDisplayName } from "~/lib/display";
import {
  convertConversationToMarkdown,
  downloadMarkdown,
  safeMarkdownFilename,
} from "~/lib/export-markdown";
import { refreshSettingsStore } from "~/lib/settings-sync";
import { cn } from "~/lib/utils";
import api, { sse } from "~/services/api";
import { useChatInputStore, useAppStore } from "~/stores";
import { WorkbenchHost } from "~/components/workbench/workbench-host";
import {
  useWorkbench,
  useWorkbenchController,
  WorkbenchProvider,
} from "~/components/workbench/workbench-context";
import {
  type ConversationDto,
  type MessageNodeDto,
  type MessageDto,
  type ConversationNodeUpdateEventDto,
  type ConversationErrorEventDto,
  type ConversationSnapshotEventDto,
  type ProviderModel,
  type Settings,
  type UIMessagePart,
} from "~/types";
import { ArrowDown, Loader2, MessageSquare, Moon, Pencil, Sun } from "lucide-react";
import Logo from "~/components/logo";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { v4 as uuidv4 } from "uuid";
import i18n from "~/i18n";
import { TtsPlayBar } from "~/components/tts-play-bar";

type ConversationStreamEvent =
  | ConversationSnapshotEventDto
  | ConversationNodeUpdateEventDto
  | ConversationErrorEventDto;

interface SelectedNodeMessage {
  node: MessageNodeDto;
  message: MessageNodeDto["messages"][number];
}

function ConversationSystemPromptButton({
  value,
  onSave,
}: {
  value: string | null | undefined;
  onSave: (value: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [draft, setDraft] = React.useState(value ?? "");
  const [saving, setSaving] = React.useState(false);
  const hasCustomPrompt = Boolean(value?.trim());
  const { t } = useTranslation("page");

  React.useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  const save = async (nextValue: string) => {
    setSaving(true);
    try {
      await onSave(nextValue);
      setExpanded(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex w-full flex-col items-center px-4 py-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 text-xs"
        onClick={() => setExpanded((current) => !current)}
      >
        <Pencil className="size-3.5" />
        <span>{hasCustomPrompt ? t("conversations.custom_prompt.button_active") : t("conversations.custom_prompt.button")}</span>
      </Button>
      {expanded ? (
        <div className="mt-2 w-full max-w-3xl space-y-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-28 resize-y"
            placeholder={t("conversations.custom_prompt.placeholder")}
          />
          <div className="flex justify-end gap-2">
            {hasCustomPrompt ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => void save("")}
              >
                {t("conversations.custom_prompt.clear")}
              </Button>
            ) : null}
            <Button type="button" size="sm" disabled={saving} onClick={() => void save(draft)}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("conversations.custom_prompt.save")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type ConversationSummaryUpdater = (update: ReturnType<typeof toConversationSummaryUpdate>) => void;

const EDIT_DRAFT_ATTACHMENT_MARK = "__from_message_attachment";
const EDIT_DRAFT_SOURCE_INDEX = "__from_message_source_index";
const EMPTY_INPUT_ATTACHMENTS: UIMessagePart[] = [];
const EMPTY_SUGGESTIONS: string[] = [];
const COMPRESS_TOKEN_OPTIONS = [500, 1000, 2000, 4000];
const COMPRESS_KEEP_OPTIONS = [0, 16, 32, 64];
const TRANSLATION_LANGUAGES = [
  { value: "zh-CN" },
  { value: "zh-TW" },
  { value: "en-US" },
  { value: "ja-JP" },
  { value: "ko-KR" },
  { value: "fr-FR" },
  { value: "de-DE" },
  { value: "es-ES" },
];

interface EditDraft {
  text: string;
  attachments: UIMessagePart[];
  sourceParts: UIMessagePart[];
  textPartIndex: number | null;
}

interface EditingSession {
  messageId: string;
  sourceParts: UIMessagePart[];
  textPartIndex: number | null;
}

function ThemeToggleButton() {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation("page");
  // Resolve "system" to a concrete light/dark, so the toggle always lands on the opposite mode.
  const isDark =
    theme === "dark" ||
    (theme === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? t("conversations.theme_toggle.to_light") : t("conversations.theme_toggle.to_dark")}
      title={isDark ? t("conversations.theme_toggle.to_light") : t("conversations.theme_toggle.to_dark")}
    >
      {isDark ? <Moon className="size-4" /> : <Sun className="size-4" />}
    </Button>
  );
}

function createHomeDraftId() {
  return `home-${uuidv4()}`;
}

function truncatePreviewText(value: string, maxLength = 48): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
}

function getQuickJumpPreview(
  message: MessageDto,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const textPreview = message.parts
    .filter((part): part is Extract<UIMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text.trim())
    .find((text) => text.length > 0);

  if (textPreview) {
    return truncatePreviewText(textPreview.replace(/\s+/g, " "));
  }

  const fallbackPart = message.parts.find(Boolean);
  if (!fallbackPart) return t("conversations.preview.empty_message");

  switch (fallbackPart.type) {
    case "image":
      return t("conversations.preview.image");
    case "video":
      return t("conversations.preview.video");
    case "audio":
      return t("conversations.preview.audio");
    case "document":
      return fallbackPart.fileName.trim().length > 0
        ? t("conversations.preview.document_with_name", {
            name: truncatePreviewText(fallbackPart.fileName.trim(), 32),
          })
        : t("conversations.preview.document");
    case "reasoning":
      return fallbackPart.reasoning.trim().length > 0
        ? truncatePreviewText(fallbackPart.reasoning.trim().replace(/\s+/g, " "))
        : t("conversations.preview.thinking");
    case "tool":
      return fallbackPart.toolName.trim().length > 0
        ? t("conversations.preview.tool_with_name", {
            name: truncatePreviewText(fallbackPart.toolName.trim(), 32),
          })
        : t("conversations.preview.tool_call");
    case "loading":
      return t("conversations.preview.thinking");
    case "text":
      return t("conversations.preview.empty_message");
  }
}

function isAttachmentPart(
  part: UIMessagePart,
): part is Extract<UIMessagePart, { type: "image" | "video" | "audio" | "document" }> {
  return (
    part.type === "image" ||
    part.type === "video" ||
    part.type === "audio" ||
    part.type === "document"
  );
}

function getLastTextPartIndex(parts: UIMessagePart[]): number | null {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.type === "text") {
      return index;
    }
  }

  return null;
}

function getDraftSourceIndex(part: UIMessagePart): number | null {
  const value = part.metadata?.[EDIT_DRAFT_SOURCE_INDEX];
  return typeof value === "number" ? value : null;
}

function toEditDraft(message: MessageDto): EditDraft | null {
  const textPartIndex = getLastTextPartIndex(message.parts);
  const text =
    textPartIndex !== null && message.parts[textPartIndex]?.type === "text"
      ? message.parts[textPartIndex].text
      : "";

  const attachments = message.parts.flatMap((part, index) => {
    if (!isAttachmentPart(part)) return [];

    return [
      {
        ...part,
        metadata: {
          ...part.metadata,
          [EDIT_DRAFT_ATTACHMENT_MARK]: true,
          [EDIT_DRAFT_SOURCE_INDEX]: index,
        },
      },
    ];
  });

  if (text.trim().length === 0 && attachments.length === 0) {
    return null;
  }

  return {
    text,
    attachments,
    sourceParts: message.parts,
    textPartIndex,
  };
}

function shouldDeleteAttachmentFileOnRemove(part: UIMessagePart): boolean {
  if (!part.metadata) return true;

  return part.metadata[EDIT_DRAFT_ATTACHMENT_MARK] !== true;
}

function stripEditDraftMetadata(parts: UIMessagePart[]): UIMessagePart[] {
  return parts.map((part) => {
    if (!part.metadata) {
      return part;
    }

    const hasEditMark =
      EDIT_DRAFT_ATTACHMENT_MARK in part.metadata || EDIT_DRAFT_SOURCE_INDEX in part.metadata;
    if (!hasEditMark) {
      return part;
    }

    const nextMetadata = { ...part.metadata };
    delete nextMetadata[EDIT_DRAFT_ATTACHMENT_MARK];
    delete nextMetadata[EDIT_DRAFT_SOURCE_INDEX];

    return {
      ...part,
      metadata: Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined,
    };
  });
}

function buildEditedParts(session: EditingSession, draftParts: UIMessagePart[]): UIMessagePart[] {
  const textPart = draftParts.find(
    (part): part is Extract<UIMessagePart, { type: "text" }> => part.type === "text",
  );
  const editedText = textPart?.text ?? "";

  const retainedAttachmentIndexes = new Set<number>();
  const appendedAttachments: UIMessagePart[] = [];

  draftParts.forEach((part) => {
    if (!isAttachmentPart(part)) return;

    if (part.metadata?.[EDIT_DRAFT_ATTACHMENT_MARK] === true) {
      const sourceIndex = getDraftSourceIndex(part);
      if (sourceIndex !== null) {
        retainedAttachmentIndexes.add(sourceIndex);
      }
      return;
    }

    appendedAttachments.push(part);
  });

  const preservedParts: UIMessagePart[] = [];

  session.sourceParts.forEach((part, index) => {
    if (session.textPartIndex !== null && index === session.textPartIndex && part.type === "text") {
      preservedParts.push({ ...part, text: editedText });
      return;
    }

    if (isAttachmentPart(part)) {
      if (retainedAttachmentIndexes.has(index)) {
        preservedParts.push(part);
      }
      return;
    }

    preservedParts.push(part);
  });

  if (session.textPartIndex === null && textPart && textPart.text.trim().length > 0) {
    return [textPart, ...preservedParts, ...appendedAttachments];
  }

  return [...preservedParts, ...appendedAttachments];
}

function applyNodeUpdate(
  conversation: ConversationDto,
  event: ConversationNodeUpdateEventDto,
): ConversationDto {
  if (conversation.id !== event.conversationId) {
    return conversation;
  }

  const nextNodes = [...conversation.messages];
  const indexById = nextNodes.findIndex((node) => node.id === event.nodeId);
  const targetIndex = indexById >= 0 ? indexById : event.nodeIndex;

  if (targetIndex < 0) {
    return conversation;
  }

  if (targetIndex < nextNodes.length) {
    nextNodes[targetIndex] = event.node;
  } else if (targetIndex === nextNodes.length) {
    nextNodes.push(event.node);
  } else {
    nextNodes.push(event.node);
  }

  return {
    ...conversation,
    messages: nextNodes,
    updateAt: event.updateAt,
    isGenerating: event.isGenerating,
  };
}

function useConversationDetail(activeId: string | null, updateSummary: ConversationSummaryUpdater) {
  const { t } = useTranslation("page");
  const [detail, setDetail] = React.useState<ConversationDto | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = React.useState(0);

  const resetDetail = React.useCallback(() => {
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
  }, []);

  const refreshDetail = React.useCallback(() => {
    setRefreshNonce((current) => current + 1);
  }, []);

  React.useEffect(() => {
    if (!activeId) {
      resetDetail();
      return;
    }

    let mounted = true;
    setDetailLoading(true);
    setDetailError(null);

    const abortController = new AbortController();

    api
      .get<ConversationDto>(`conversations/${activeId}`)
      .then((data) => {
        if (!mounted) return;
        setDetail(data);
        updateSummary(toConversationSummaryUpdate(data));
      })
      .catch((err: Error & { status?: number }) => {
        if (!mounted) return;
        // Treat 404 as "no conversation yet" rather than a hard error. This commonly happens
        // right after creating a new conversation on the home page: setActiveId is set before
        // the first POST /messages completes, so the immediate GET races and 404s.
        const status =
          (err as { status?: number }).status ??
          (err as { response?: { status?: number } }).response?.status;
        if (status === 404 || /Conversation not found/i.test(err.message ?? "")) {
          setDetail(null);
          setDetailError(null);
          return;
        }
        setDetailError(err.message || t("conversations.errors.load_detail_failed"));
        setDetail(null);
      })
      .finally(() => {
        if (!mounted) return;
        setDetailLoading(false);
      });

    void sse<ConversationStreamEvent>(
      `conversations/${activeId}/stream`,
      {
        onMessage: ({ event, data }) => {
          if (!mounted) return;

          if (event === "error" && data.type === "error") {
            toast.error(data.message);
            return;
          }

          if (event === "snapshot" && data.type === "snapshot") {
            useAppStore.getState().setClockOffset(data.serverTime);
            setDetail(data.conversation);
            updateSummary(toConversationSummaryUpdate(data.conversation));
            setDetailError(null);
            setDetailLoading(false);
            return;
          }

          if (event !== "node_update" || data.type !== "node_update") return;

          useAppStore.getState().setClockOffset(data.serverTime);
          setDetail((prev) => {
            if (!prev) {
              queueMicrotask(() => setRefreshNonce((current) => current + 1));
              return prev;
            }
            const next = applyNodeUpdate(prev, data);
            if (next === prev) return prev;
            updateSummary(toConversationSummaryUpdate(next));
            return next;
          });
          setDetailError(null);
          setDetailLoading(false);
        },
        onError: (streamError) => {
          if (!mounted) return;
          console.error("Conversation detail SSE error:", streamError);
        },
      },
      { signal: abortController.signal },
    );

    return () => {
      mounted = false;
      abortController.abort();
    };
  }, [activeId, refreshNonce, resetDetail, t, updateSummary]);

  React.useEffect(() => {
    if (!activeId || !detail?.isGenerating) return;
    // SSE 是主路径,这个轮询只是"丢帧兜底"。原 2s 全量快照拉取会与 SSE 增量打架
    // (旧快照可能覆盖新帧),且每轮反序列化整个对话在长会话上开销显著。降到 10s,
    // 既保留兜底,又把开销压到原来的 1/5。
    const timer = window.setInterval(() => {
      void api
        .get<ConversationDto>(`conversations/${activeId}`)
        .then((data) => {
          setDetail(data);
          updateSummary(toConversationSummaryUpdate(data));
        })
        .catch(() => {
          // SSE remains the primary path; polling is only a recovery path for missed stream frames.
        });
    }, 10000);
    return () => window.clearInterval(timer);
  }, [activeId, detail?.isGenerating, updateSummary]);

  const selectedNodeMessages = React.useMemo<SelectedNodeMessage[]>(() => {
    if (!detail) return [];
    return detail.messages.map((node) => ({
      node,
      message: node.messages[node.selectIndex] ?? node.messages[0],
    }));
  }, [detail]);

  return {
    detail,
    detailLoading,
    detailError,
    selectedNodeMessages,
    resetDetail,
    refreshDetail,
  };
}

function useDraftInputController({
  activeId,
  isHomeRoute,
  homeDraftId,
  setHomeDraftId,
  setActiveId,
  navigate,
  refreshList,
}: {
  activeId: string | null;
  isHomeRoute: boolean;
  homeDraftId: string;
  setHomeDraftId: React.Dispatch<React.SetStateAction<string>>;
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>;
  navigate: ReturnType<typeof useNavigate>;
  refreshList: () => void;
}) {
  const draftKey = activeId ?? (isHomeRoute ? homeDraftId : null);
  // 刻意不在这里订阅 drafts[draftKey] 的内容:本 hook 由 ConversationsPageInner 调用,
  // 一旦订阅草稿,每次打字都会让整个巨型组件(侧边栏/对话框/面板组)一起重渲染,造成
  // 输入卡顿。草稿内容订阅下沉到 ChatInputArea——只有输入区随打字重渲染。
  const setDraftText = useChatInputStore((state) => state.setText);
  const addDraftParts = useChatInputStore((state) => state.addParts);
  const getSubmitParts = useChatInputStore((state) => state.getSubmitParts);
  const clearDraft = useChatInputStore((state) => state.clearDraft);

  const handleSubmit = React.useCallback(async () => {
    if (!draftKey) return;

    const parts = getSubmitParts(draftKey);
    if (parts.length === 0) return;

    if (activeId) {
      await api.post<{ status: string }>(`conversations/${activeId}/messages`, { parts });
      clearDraft(draftKey);
      return;
    }

    const conversationId = uuidv4();
    setHomeDraftId(createHomeDraftId());

    // Send the message BEFORE setting activeId so the detail fetcher doesn't race
    // (`POST /messages` calls ensureConversation on the server; only then does the
    // subsequent `GET /api/conversations/{id}` succeed).
    await api.post<{ status: string }>(`conversations/${conversationId}/messages`, { parts });
    clearDraft(draftKey);

    setActiveId(conversationId);
    navigate(`/c/${conversationId}`);
    refreshList();
  }, [
    activeId,
    clearDraft,
    draftKey,
    getSubmitParts,
    navigate,
    refreshList,
    setActiveId,
    setHomeDraftId,
  ]);

  const replaceDraft = React.useCallback(
    (text: string, parts: UIMessagePart[]) => {
      if (!draftKey) return;
      clearDraft(draftKey);
      setDraftText(draftKey, text);
      addDraftParts(draftKey, parts);
    },
    [addDraftParts, clearDraft, draftKey, setDraftText],
  );

  const clearCurrentDraft = React.useCallback(() => {
    if (!draftKey) return;
    clearDraft(draftKey);
  }, [clearDraft, draftKey]);

  const getCurrentSubmitParts = React.useCallback(() => {
    if (!draftKey) return [];
    return getSubmitParts(draftKey);
  }, [draftKey, getSubmitParts]);

  return {
    draftKey,
    setDraftText,
    handleSubmit,
    replaceDraft,
    clearCurrentDraft,
    getCurrentSubmitParts,
  };
}

// 输入区渲染边界:把"草稿内容订阅"隔离在这里,这样打字时只有本组件重渲染,
// 而 ConversationsPageInner(侧边栏 / 顶栏 / 对话框 / 面板组 / 消息列表)全部不动。
// 父级传入的都是稳定引用(handlers / useCallback / 原始值),React.memo 让本组件在
// 父级因无关原因(如 SSE 推送)重渲染时也能跳过,只在草稿内容或真正变化的 prop 变化时重渲染。
interface ChatInputAreaProps {
  draftKey: string | null;
  isGenerating: boolean;
  disabled: boolean;
  isEditing: boolean;
  suggestions: string[];
  onSuggestionClick: (suggestion: string) => void;
  onCancelEdit?: () => void;
  shouldDeleteFileOnRemove?: (part: UIMessagePart) => boolean;
  onSend: () => Promise<void> | void;
  onStop?: () => Promise<void> | void;
  onExportConversation?: (includeReasoning: boolean) => void;
  onCompressConversation?: () => void;
  getOptimizeContext?: () => string;
}

const ChatInputArea = React.memo(function ChatInputArea({
  draftKey,
  isGenerating,
  disabled,
  isEditing,
  suggestions,
  onSuggestionClick,
  onCancelEdit,
  shouldDeleteFileOnRemove,
  onSend,
  onStop,
  onExportConversation,
  onCompressConversation,
  getOptimizeContext,
}: ChatInputAreaProps) {
  const setText = useChatInputStore((state) => state.setText);
  const addParts = useChatInputStore((state) => state.addParts);
  const removePartAt = useChatInputStore((state) => state.removePartAt);
  const draft = useChatInputStore(
    React.useCallback((state) => (draftKey ? state.drafts[draftKey] : undefined), [draftKey]),
  );
  const inputText = draft?.text ?? "";
  const inputAttachments = draft?.parts ?? EMPTY_INPUT_ATTACHMENTS;

  const handleValueChange = React.useCallback(
    (text: string) => {
      if (!draftKey) return;
      setText(draftKey, text);
    },
    [draftKey, setText],
  );
  const handleAddParts = React.useCallback(
    (parts: UIMessagePart[]) => {
      if (!draftKey || parts.length === 0) return;
      addParts(draftKey, parts);
    },
    [addParts, draftKey],
  );
  const handleRemovePart = React.useCallback(
    (index: number) => {
      if (!draftKey) return;
      removePartAt(draftKey, index);
    },
    [draftKey, removePartAt],
  );

  return (
    <ChatInput
      value={inputText}
      attachments={inputAttachments}
      ready={draftKey !== null}
      isGenerating={isGenerating}
      disabled={disabled}
      isEditing={isEditing}
      onValueChange={handleValueChange}
      onAddParts={handleAddParts}
      suggestions={suggestions}
      onSuggestionClick={onSuggestionClick}
      onCancelEdit={onCancelEdit}
      shouldDeleteFileOnRemove={shouldDeleteFileOnRemove}
      onRemovePart={handleRemovePart}
      onSend={onSend}
      onStop={onStop}
      onExportConversation={onExportConversation}
      onCompressConversation={onCompressConversation}
      getOptimizeContext={getOptimizeContext}
    />
  );
});

const ConversationTimeline = React.memo(
  ({
    activeId,
    isHomeRoute,
    detailLoading,
    detailError,
    selectedNodeMessages,
    isGenerating,
    settings,
    conversationAssistantId,
    contentClassName,
    onEdit,
    onDelete,
    onFork,
    onRegenerate,
    onSelectBranch,
    onTranslate,
    onToolApproval,
  }: {
    activeId: string | null;
    isHomeRoute: boolean;
    detailLoading: boolean;
    detailError: string | null;
    selectedNodeMessages: SelectedNodeMessage[];
    isGenerating: boolean;
    settings: Settings | null;
    conversationAssistantId: string | null;
    contentClassName?: string;
    onEdit: (message: MessageDto) => void | Promise<void>;
    onDelete: (messageId: string) => Promise<void>;
    onFork: (messageId: string) => Promise<void>;
    onRegenerate: (messageId: string) => Promise<void>;
    onSelectBranch: (nodeId: string, selectIndex: number) => Promise<void>;
    onTranslate: (messageId: string) => Promise<void>;
    onToolApproval: (
      toolCallId: string,
      approved: boolean,
      reason: string,
      answer?: string,
    ) => Promise<void>;
  }) => {
    const { t } = useTranslation("page");
    const canQuickJump =
      Boolean(activeId) && !detailLoading && !detailError && selectedNodeMessages.length > 1;
    const assistant = React.useMemo(() => {
      if (!settings) return null;
      return (
        settings.assistants.find((item) => item.id === conversationAssistantId) ??
        settings.assistants[0] ??
        null
      );
    }, [conversationAssistantId, settings]);
    const modelById = React.useMemo(() => {
      const map = new Map<string, ProviderModel>();
      if (!settings) return map;

      for (const provider of settings.providers) {
        for (const model of provider.models) {
          if (!map.has(model.id)) {
            map.set(model.id, model);
          }
        }
      }

      return map;
    }, [settings]);
    const fallbackModel = React.useMemo(() => {
      if (!settings) return null;
      const fallbackId = assistant?.chatModelId ?? settings.chatModelId;
      return (
        modelById.get(fallbackId) ??
        settings.providers.flatMap((provider) => provider.models)[0] ??
        null
      );
    }, [assistant?.chatModelId, modelById, settings]);

    // 仅对"进入会话(或切换会话)之后才新出现的消息"播放入场动画。首次加载的历史
    // 消息一律不动画——避免长会话进入时 N 条消息并发播 4 属性动画拖垮首屏 mount。
    // activeId 变化(切换会话)→ 重新锁定当前消息集为新会话的"历史";detail 延迟
    // 加载(锁定时为空、随后才有消息)的场景,在消息首次出现时补锁定一次。
    const knownIdsRef = React.useRef<{ activeId: string | null; ids: Set<string> } | null>(null);
    if (
      knownIdsRef.current === null ||
      knownIdsRef.current.activeId !== activeId ||
      (knownIdsRef.current.ids.size === 0 && selectedNodeMessages.length > 0)
    ) {
      knownIdsRef.current = {
        activeId,
        ids: new Set(selectedNodeMessages.map((item) => item.message.id)),
      };
    }
    const knownMessageIds = knownIdsRef.current.ids;

    const virtuosoRef = React.useRef<VirtuosoHandle>(null);
    const [isAtBottom, setIsAtBottom] = React.useState(true);
    const [isAtTop, setIsAtTop] = React.useState(false);
    const [topVisibleIndex, setTopVisibleIndex] = React.useState(0);
    const [topEndIndex, setTopEndIndex] = React.useState(0);
    const didInitialScrollRef = React.useRef<string | null>(null);

    // 搜索命中跳转时 URL 带 ?msg=<messageId>,用它定位到命中那条消息(对齐安卓)。
    const [searchParams] = useSearchParams();
    const focusMessageId = searchParams.get("msg");

    React.useEffect(() => {
      if (!activeId || detailLoading || detailError || selectedNodeMessages.length === 0) {
        return;
      }
      if (!focusMessageId) {
        // 无聚焦消息:进入/切换会话时滚底部一次。流式新消息的跟底交给 followOutput。
        const bottomKey = `${activeId}:bottom`;
        if (didInitialScrollRef.current === bottomKey) return;
        didInitialScrollRef.current = bottomKey;
        const lastIndex = selectedNodeMessages.length - 1;
        const frame = window.requestAnimationFrame(() => {
          virtuosoRef.current?.scrollToIndex({ index: lastIndex, behavior: "auto", align: "end" });
        });
        return () => window.cancelAnimationFrame(frame);
      }
      // 有聚焦消息(搜索命中):定位到它所在 node。后端 search 索引每个 node 的全部分支,命中可能
      // 是 selectIndex 之外的消息;只看渲染链会找不到,所以遍历所有分支定位到该消息所在轮次(对齐安卓)。
      // 配合下方 followOutput 读 focusMessageId:定位期间(URL 带 msg)不自动跟底,避免 Virtuoso 首次
      // data 填充时被 followOutput 拉到底部、覆盖 scrollToIndex 的居中定位。
      const nodeIdx = selectedNodeMessages.findIndex((item) =>
        item.node.messages.some((m) => m.id === focusMessageId),
      );
      if (nodeIdx < 0) return; // snapshot 是全量,极少走到;真发生则等下一次 effect 重试
      const focusKey = `${activeId}:focus:${focusMessageId}`;
      if (didInitialScrollRef.current === focusKey) return;
      didInitialScrollRef.current = focusKey;
      // Virtuoso 刚 mount / 数据刚填充时高度未稳定,立即 scrollToIndex 会被后续布局调整覆盖
      // (实测 rAF 连调多次无效,但布局稳定后手动调用有效)。改用递增延迟重试,跨过稳定窗口。
      let cancelled = false;
      const timers = [100, 300, 600].map((d) =>
        window.setTimeout(() => {
          if (cancelled) return;
          virtuosoRef.current?.scrollToIndex({ index: nodeIdx, behavior: "auto", align: "start" });
        }, d),
      );
      return () => {
        cancelled = true;
        timers.forEach((t) => window.clearTimeout(t));
      };
    }, [activeId, detailError, detailLoading, focusMessageId, selectedNodeMessages]);

    return (
      <div className="relative flex-1 min-h-0">
        {!activeId && !isHomeRoute ? (
          <ConversationEmptyState
            icon={<MessageSquare className="size-10" />}
            title={t("conversations.empty_state.select_title")}
            description={t("conversations.empty_state.select_description")}
          />
        ) : detailLoading ? (
          <ConversationEmptyState
            title={t("conversations.empty_state.loading_title")}
            description={t("conversations.empty_state.loading_description")}
          />
        ) : detailError ? (
          <ConversationEmptyState
            title={t("conversations.empty_state.error_title")}
            description={detailError}
          />
        ) : selectedNodeMessages.length === 0 ? (
          isGenerating ? (
            <div className="flex items-start px-4 py-2">
              <TypingIndicator className="px-1 py-2" />
            </div>
          ) : (
            <ConversationEmptyState
              icon={<MessageSquare className="size-10" />}
              title={t("conversations.empty_state.no_message_title")}
              description={t("conversations.empty_state.no_message_description")}
            />
          )
        ) : (
          <Virtuoso
            key={activeId ?? "home"}
            ref={virtuosoRef}
            className="h-full"
            data={selectedNodeMessages}
            computeItemKey={(_, item) => item.message.id}
            followOutput={(atBottom) => (focusMessageId ? false : atBottom ? "smooth" : false)}
            atBottomStateChange={setIsAtBottom}
            atTopStateChange={setIsAtTop}
            rangeChanged={({ startIndex, endIndex }) => {
              setTopVisibleIndex(startIndex);
              setTopEndIndex(endIndex);
            }}
            increaseViewportBy={800}
            components={{
              Header: () => <div className="h-4" />,
              Footer: () => <div className="h-4" />,
            }}
            itemContent={(index, { node, message }) => {
              const model = message.modelId
                ? (modelById.get(message.modelId) ?? fallbackModel)
                : fallbackModel;
              return (
                <div
                  id={getConversationMessageAnchorId(message.id)}
                  className={cn(
                    "mx-auto w-full max-w-3xl px-4 py-2 scroll-mt-24",
                    contentClassName,
                    !knownMessageIds.has(message.id) && "rikkahub-animate-fade-in-up",
                  )}
                >
                  <ChatMessage
                    node={node}
                    message={message}
                    loading={isGenerating && index === selectedNodeMessages.length - 1}
                    isLastMessage={index === selectedNodeMessages.length - 1}
                    assistant={assistant}
                    model={model}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onFork={onFork}
                    onRegenerate={onRegenerate}
                    onSelectBranch={onSelectBranch}
                    onTranslate={onTranslate}
                    onToolApproval={onToolApproval}
                  />
                </div>
              );
            }}
          />
        )}

        {!detailLoading && !detailError && activeId && selectedNodeMessages.length > 0 ? (
          <>
            {!isAtBottom ? (
              <Button
                aria-label={t("conversations.scroll_to_bottom", "滚动到底部")}
                className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-md transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg dark:bg-background dark:hover:bg-muted"
                onClick={() =>
                  virtuosoRef.current?.scrollToIndex({
                    index: selectedNodeMessages.length - 1,
                    behavior: "smooth",
                    align: "end",
                  })
                }
                size="icon"
                type="button"
                variant="outline"
              >
                <ArrowDown className="size-4" />
              </Button>
            ) : null}
            {canQuickJump ? (
              <ConversationQuickJump
                items={selectedNodeMessages.map(({ message }) => ({
                  id: message.id,
                  role: message.role,
                  preview: getQuickJumpPreview(message, t),
                }))}
                activeIndex={
                  isAtBottom
                    ? selectedNodeMessages.length - 1
                    : isAtTop
                      ? 0
                      : Math.round((topVisibleIndex + topEndIndex) / 2)
                }
                onItemClick={(index) =>
                  virtuosoRef.current?.scrollToIndex({ index, behavior: "smooth", align: "start" })
                }
              />
            ) : null}
          </>
        ) : null}
      </div>
    );
  },
);

export function meta() {
  return [
    { title: i18n.t("page:conversations.meta.title") },
    {
      name: "description",
      content: i18n.t("page:conversations.meta.description"),
    },
  ];
}

export default function ConversationsPage() {
  const workbench = useWorkbenchController();

  return (
    <WorkbenchProvider value={workbench}>
      <ConversationsPageInner />
    </WorkbenchProvider>
  );
}

function ConversationsPageInner() {
  const { t } = useTranslation("page");
  const navigate = useNavigate();
  const { id: routeId } = useParams();
  const isHomeRoute = !routeId;
  const isMobile = useIsMobile();
  const { panel, closePanel } = useWorkbench();

  const { settings, assistants, currentAssistantId, currentAssistant } = useCurrentAssistant();
  const { currentModel, currentProvider } = useCurrentModel();
  const {
    conversations,
    activeId,
    setActiveId,
    loading,
    error,
    hasMore,
    loadMore,
    refreshList,
    updateConversationSummary,
  } = useConversationList({ currentAssistantId, routeId, autoSelectFirst: !isHomeRoute });

  const [homeDraftId, setHomeDraftId] = React.useState(() => createHomeDraftId());
  const [editingSession, setEditingSession] = React.useState<EditingSession | null>(null);
  const [compressDialogOpen, setCompressDialogOpen] = React.useState(false);
  const [compressTargetTokens, setCompressTargetTokens] = React.useState(2000);
  const [compressKeepRecent, setCompressKeepRecent] = React.useState(32);
  const [compressAdditionalPrompt, setCompressAdditionalPrompt] = React.useState("");
  const [compressing, setCompressing] = React.useState(false);
  const [translationDialogMessageId, setTranslationDialogMessageId] = React.useState<string | null>(
    null,
  );
  const [translationLanguage, setTranslationLanguage] = React.useState(() =>
    i18n.language?.startsWith("zh") ? "zh-CN" : navigator.language || "en-US",
  );
  const [translatingMessage, setTranslatingMessage] = React.useState(false);
  const [systemPromptDialogOpen, setSystemPromptDialogOpen] = React.useState(false);
  const [systemPromptDraft, setSystemPromptDraft] = React.useState("");

  const { detail, detailLoading, detailError, selectedNodeMessages, resetDetail, refreshDetail } =
    useConversationDetail(activeId, updateConversationSummary);

  const {
    draftKey,
    setDraftText,
    handleSubmit,
    replaceDraft,
    clearCurrentDraft,
    getCurrentSubmitParts,
  } = useDraftInputController({
    activeId,
    isHomeRoute,
    homeDraftId,
    setHomeDraftId,
    setActiveId,
    navigate,
    refreshList,
  });

  const activeConversation = conversations.find((item) => item.id === activeId);
  const chatSuggestions = detail?.chatSuggestions ?? EMPTY_SUGGESTIONS;
  const activeAssistantForConversation = React.useMemo(() => {
    const assistantId =
      detail?.assistantId ?? activeConversation?.assistantId ?? currentAssistantId;
    return (
      settings?.assistants.find((assistant) => assistant.id === assistantId) ??
      currentAssistant ??
      null
    );
  }, [
    activeConversation?.assistantId,
    currentAssistant,
    currentAssistantId,
    detail?.assistantId,
    settings,
  ]);
  const canOverrideConversationSystemPrompt =
    activeAssistantForConversation?.allowConversationSystemPrompt === true;

  React.useEffect(() => {
    if (!systemPromptDialogOpen) return;
    setSystemPromptDraft(
      detail?.systemPrompt ?? activeAssistantForConversation?.systemPrompt ?? "",
    );
  }, [
    activeAssistantForConversation?.allowConversationSystemPrompt,
    activeAssistantForConversation?.systemPrompt,
    detail?.systemPrompt,
    systemPromptDialogOpen,
  ]);

  React.useEffect(() => {
    const base = t("conversations.meta.title");
    document.title = activeConversation?.title ? `${activeConversation.title} - ${base}` : base;
    return () => {
      document.title = base;
    };
  }, [activeConversation?.title, t]);
  const isNewChat = isHomeRoute && !activeId;
  const showSuggestions =
    Boolean(activeId) && !detailLoading && !detailError && chatSuggestions.length > 0;
  const displaySuggestions = showSuggestions ? chatSuggestions : EMPTY_SUGGESTIONS;

  const handleSelect = React.useCallback(
    (id: string, messageId?: string) => {
      setActiveId(id);
      // 搜索命中带 messageId 时通过 URL query 传给详情页,加载完成后滚到那条消息位置
      // (对齐安卓);普通点击不带 messageId,维持原"进入会话滚底部"行为。
      const target = messageId ? `/c/${id}?msg=${messageId}` : `/c/${id}`;
      // 同会话也要 navigate 以更新 query(搜索当前会话的某条消息)
      if (routeId !== id || messageId) {
        navigate(target);
      }
    },
    [navigate, routeId, setActiveId],
  );

  React.useEffect(() => {
    setEditingSession(null);
  }, [activeId]);

  const handleAssistantChange = React.useCallback(
    async (assistantId: string) => {
      await api.post<{ status: string }>("settings/assistant", { assistantId });
      await refreshSettingsStore();
      setActiveId(null);
      resetDetail();
      if (routeId) {
        navigate("/", { replace: true });
      }
      refreshList();
    },
    [navigate, refreshList, resetDetail, routeId, setActiveId],
  );

  const handleToolApproval = React.useCallback(
    async (toolCallId: string, approved: boolean, reason: string, answer?: string) => {
      if (!activeId) return;
      await api.post<{ status: string }>(`conversations/${activeId}/tool-approval`, {
        toolCallId,
        approved,
        reason,
        ...(answer != null ? { answer } : {}),
      });
    },
    [activeId],
  );

  const handleRegenerate = React.useCallback(
    async (messageId: string) => {
      if (!activeId) return;
      await api.post<{ status: string }>(`conversations/${activeId}/regenerate`, {
        messageId,
      });
      refreshList();
    },
    [activeId, refreshList],
  );

  const handleSelectBranch = React.useCallback(
    async (nodeId: string, selectIndex: number) => {
      if (!activeId) return;
      await api.post<{ status: string }>(`conversations/${activeId}/nodes/${nodeId}/select`, {
        selectIndex,
      });
    },
    [activeId],
  );

  const handleDeleteMessage = React.useCallback(
    async (messageId: string) => {
      if (!activeId) return;
      await api.delete<{ status: string }>(`conversations/${activeId}/messages/${messageId}`);
    },
    [activeId],
  );

  const handleForkMessage = React.useCallback(
    async (messageId: string) => {
      if (!activeId) return;
      const response = await api.post<{ conversationId: string }>(
        `conversations/${activeId}/fork`,
        {
          messageId,
        },
      );
      setActiveId(response.conversationId);
      navigate(`/c/${response.conversationId}`);
      refreshList();
    },
    [activeId, navigate, refreshList, setActiveId],
  );

  const handleTranslateMessage = React.useCallback(async (messageId: string) => {
    setTranslationDialogMessageId(messageId);
  }, []);

  const handleConfirmTranslateMessage = React.useCallback(async () => {
    if (!activeId || !translationDialogMessageId) return;
    setTranslatingMessage(true);
    try {
      await api.post<{ status: string; translation?: string }>(
        `conversations/${activeId}/messages/${translationDialogMessageId}/translate`,
        { targetLanguage: translationLanguage },
        { timeout: false },
      );
      setTranslationDialogMessageId(null);
      refreshDetail();
      refreshList();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("conversations.translate.failed"));
    } finally {
      setTranslatingMessage(false);
    }
  }, [activeId, refreshDetail, refreshList, translationDialogMessageId, translationLanguage]);

  const handleStartEdit = React.useCallback(
    (message: MessageDto) => {
      if (!activeId || (message.role !== "USER" && message.role !== "ASSISTANT")) return;

      const draft = toEditDraft(message);
      if (!draft) return;

      setEditingSession({
        messageId: message.id,
        sourceParts: draft.sourceParts,
        textPartIndex: draft.textPartIndex,
      });
      replaceDraft(draft.text, draft.attachments);
    },
    [activeId, replaceDraft],
  );

  const handleCancelEdit = React.useCallback(() => {
    setEditingSession(null);
    clearCurrentDraft();
  }, [clearCurrentDraft]);

  const handleClickSuggestion = React.useCallback(
    (suggestion: string) => {
      if (editingSession) {
        setEditingSession(null);
      }
      if (draftKey) setDraftText(draftKey, suggestion);
    },
    [draftKey, editingSession, setDraftText],
  );

  const handleSend = React.useCallback(async () => {
    if (!editingSession) {
      await handleSubmit();
      refreshList();
      return;
    }

    if (!activeId) return;

    const draftParts = getCurrentSubmitParts();
    if (draftParts.length === 0) return;

    const nextParts = buildEditedParts(editingSession, draftParts);

    await api.post<{ status: string }>(
      `conversations/${activeId}/messages/${editingSession.messageId}/edit`,
      { parts: stripEditDraftMetadata(nextParts) },
    );

    setEditingSession(null);
    clearCurrentDraft();
  }, [
    activeId,
    clearCurrentDraft,
    editingSession,
    getCurrentSubmitParts,
    handleSubmit,
    refreshList,
  ]);

  const handleTogglePinConversation = React.useCallback(
    async (conversationId: string) => {
      await api.post<{ status: string }>(`conversations/${conversationId}/pin`);
      refreshList();
    },
    [refreshList],
  );

  const handleRegenerateConversationTitle = React.useCallback(
    async (conversationId: string) => {
      await api.post<{ status: string }>(
        `conversations/${conversationId}/regenerate-title`,
        undefined,
        { timeout: false },
      );
      if (conversationId === activeId) {
        refreshDetail();
      }
      refreshList();
    },
    [activeId, refreshDetail, refreshList],
  );

  const handleMoveConversation = React.useCallback(
    async (conversationId: string, assistantId: string) => {
      await api.post<{ status: string }>(`conversations/${conversationId}/move`, { assistantId });
      if (conversationId === activeId) {
        setActiveId(null);
        resetDetail();
        setHomeDraftId(createHomeDraftId());
        if (routeId === conversationId) {
          navigate("/", { replace: true });
        }
      }
      refreshList();
    },
    [activeId, navigate, refreshList, resetDetail, routeId, setActiveId],
  );

  const handleUpdateConversationTitle = React.useCallback(
    async (conversationId: string, title: string) => {
      await api.post<{ status: string }>(`conversations/${conversationId}/title`, { title });
      refreshList();
    },
    [refreshList],
  );

  const handleDeleteConversation = React.useCallback(
    async (conversationId: string) => {
      await api.delete<Record<string, never>>(`conversations/${conversationId}`, {
        parseJson: (raw) => (raw ? JSON.parse(raw) : {}),
      });
      if (conversationId === activeId) {
        setActiveId(null);
        resetDetail();
        setHomeDraftId(createHomeDraftId());
        if (routeId === conversationId) {
          navigate("/", { replace: true });
        }
      }
      refreshList();
    },
    [activeId, navigate, refreshList, resetDetail, routeId, setActiveId],
  );

  const handleDeleteConversations = React.useCallback(
    async (conversationIds: string[]) => {
      await api.post<{ status: string; deleted: number }>("conversations/batch-delete", {
        ids: conversationIds,
      });
      if (activeId && conversationIds.includes(activeId)) {
        setActiveId(null);
        resetDetail();
        setHomeDraftId(createHomeDraftId());
        if (routeId && conversationIds.includes(routeId)) {
          navigate("/", { replace: true });
        }
      }
      refreshList();
    },
    [activeId, navigate, refreshList, resetDetail, routeId, setActiveId],
  );

  const handleCompressConversation = React.useCallback(() => {
    if (!activeId) return;
    setCompressDialogOpen(true);
  }, [activeId]);

  // 提示词优化时提取最近 3 轮对话(6 条消息)的纯文本,让优化模型理解"那个""上次的"等指代。
  // 只取 text part —— 图片(image)、文件(document)、工具调用(tool)、思维链(reasoning)全部被
  // filter 排除,不会发给优化模型。截断到 4000 字符避免吃掉 token 预算。首条消息时返回空。
  const getOptimizeContext = React.useCallback((): string => {
    if (selectedNodeMessages.length === 0) return "";
    const recent = selectedNodeMessages.slice(-6);
    const lines: string[] = [];
    for (const { message } of recent) {
      if (!message) continue;
      if (message.role !== "USER" && message.role !== "ASSISTANT") continue;
      const text = message.parts
        .filter((p) => p.type === "text")
        .map((p) => String((p as { text?: string }).text ?? ""))
        .join("")
        .trim();
      if (!text) continue;
      lines.push(`${message.role === "USER" ? t("conversations.optimize_context.user") : t("conversations.optimize_context.assistant")}: ${text}`);
    }
    return lines.join("\n\n").slice(0, 4000);
  }, [selectedNodeMessages]);

  const handleConfirmCompressConversation = React.useCallback(async () => {
    if (!activeId) return;
    setCompressing(true);
    try {
      await api.post<{ status: string }>(
        `conversations/${activeId}/compress`,
        {
          targetTokens: compressTargetTokens,
          additionalPrompt: compressAdditionalPrompt,
          keepRecentMessages: compressKeepRecent,
        },
        { timeout: false },
      );
      setCompressDialogOpen(false);
      await refreshDetail();
      refreshList();
      toast.success(t("conversations.compress.success"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("conversations.compress.failed"));
    } finally {
      setCompressing(false);
    }
  }, [
    activeId,
    compressAdditionalPrompt,
    compressKeepRecent,
    compressTargetTokens,
    refreshDetail,
    refreshList,
  ]);

  const handleCreateConversation = React.useCallback(() => {
    closePanel();
    setActiveId(null);
    resetDetail();
    setHomeDraftId(createHomeDraftId());

    if (routeId) {
      navigate("/");
    }
  }, [closePanel, navigate, resetDetail, routeId, setActiveId]);

  const handleStop = React.useCallback(async () => {
    if (!activeId) return;
    await api.post<{ status: string }>(`conversations/${activeId}/stop`);
  }, [activeId]);

  const handleSaveConversationSystemPrompt = React.useCallback(async () => {
    if (!activeId || activeAssistantForConversation?.allowConversationSystemPrompt !== true) return;
    await api.post<{ status: string }>(`conversations/${activeId}/system-prompt`, {
      systemPrompt: systemPromptDraft,
    });
    setSystemPromptDialogOpen(false);
    refreshDetail();
    refreshList();
    toast.success(t("conversations.custom_prompt.saved"));
  }, [
    activeAssistantForConversation?.allowConversationSystemPrompt,
    activeId,
    refreshDetail,
    refreshList,
    systemPromptDraft,
  ]);

  const handleSaveConversationSystemPromptValue = React.useCallback(
    async (systemPrompt: string) => {
      if (!activeId || activeAssistantForConversation?.allowConversationSystemPrompt !== true)
        return;
      await api.post<{ status: string }>(`conversations/${activeId}/system-prompt`, {
        systemPrompt,
      });
      setSystemPromptDraft(systemPrompt);
      refreshDetail();
      refreshList();
      toast.success(t("conversations.custom_prompt.saved"));
    },
    [
      activeAssistantForConversation?.allowConversationSystemPrompt,
      activeId,
      refreshDetail,
      refreshList,
    ],
  );

  const hasWorkbenchPanel = Boolean(panel);
  const workbenchPanelRef = React.useRef<PanelImperativeHandle | null>(null);

  React.useEffect(() => {
    if (isMobile) return;

    const workbenchPanel = workbenchPanelRef.current;
    if (!workbenchPanel) return;

    if (hasWorkbenchPanel) {
      workbenchPanel.expand();
    } else {
      workbenchPanel.collapse();
    }
  }, [hasWorkbenchPanel, isMobile]);

  const chatContent = (
    <div
      className={cn("flex flex-1 flex-col min-h-0 overflow-hidden", isNewChat && "justify-center")}
    >
      {!isNewChat && (
        <>
          {canOverrideConversationSystemPrompt && detail ? (
            <ConversationSystemPromptButton
              value={detail.systemPrompt}
              onSave={handleSaveConversationSystemPromptValue}
            />
          ) : null}
          <div className="relative flex min-h-0 flex-1">
            <ConversationTimeline
              activeId={activeId}
              isHomeRoute={isHomeRoute}
              detailLoading={detailLoading}
              detailError={detailError}
              selectedNodeMessages={selectedNodeMessages}
              isGenerating={detail?.isGenerating ?? false}
              settings={settings}
              conversationAssistantId={detail?.assistantId ?? null}
              onEdit={handleStartEdit}
              onDelete={handleDeleteMessage}
              onFork={handleForkMessage}
              onRegenerate={handleRegenerate}
              onSelectBranch={handleSelectBranch}
              onTranslate={handleTranslateMessage}
              onToolApproval={handleToolApproval}
            />
          </div>
        </>
      )}

      <div>
        {isNewChat && (
          <div className="mb-4 text-center">
            <div className="mb-4 flex justify-center">
              <div className="[animation:rikkahub-breathe_4s_ease-in-out_infinite] [&>svg]:size-16">
                <Logo className="size-16 text-primary" />
              </div>
            </div>
            <p className="text-xl font-medium leading-relaxed text-foreground">
              {t("conversations.welcome_prompt")}
            </p>
          </div>
        )}
        {/* Floating chunked-TTS play bar — pops in only while a message is being read out
            via the per-chunk pipeline (TtsController), shows the dual ring + transport. */}
        <TtsPlayBar />
        <ChatInputArea
          draftKey={draftKey}
          isGenerating={detail?.isGenerating ?? false}
          disabled={detailLoading || Boolean(detailError)}
          isEditing={Boolean(editingSession)}
          suggestions={displaySuggestions}
          onSuggestionClick={handleClickSuggestion}
          onCancelEdit={editingSession ? handleCancelEdit : undefined}
          shouldDeleteFileOnRemove={shouldDeleteAttachmentFileOnRemove}
          onSend={handleSend}
          onStop={activeId ? handleStop : undefined}
          onExportConversation={
            detail && detail.messages.length > 0
              ? (includeReasoning: boolean) => {
                  const content = convertConversationToMarkdown(detail, includeReasoning);
                  const filename = safeMarkdownFilename(detail.title || "conversation");
                  downloadMarkdown(content, filename);
                }
              : undefined
          }
          onCompressConversation={
            detail && detail.messages.length > 0 ? handleCompressConversation : undefined
          }
          getOptimizeContext={getOptimizeContext}
        />
      </div>
    </div>
  );

  return (
    <SidebarProvider defaultOpen className="h-svh overflow-hidden">
      <ConversationSidebar
        conversations={conversations}
        activeId={activeId}
        loading={loading}
        error={error}
        hasMore={hasMore}
        loadMore={loadMore}
        userName={
          settings?.displaySetting.userNickname?.trim() || t("conversations.user.default_name")
        }
        userAvatar={settings?.displaySetting.userAvatar}
        assistants={assistants}
        assistantTags={settings?.assistantTags ?? []}
        currentAssistantId={currentAssistantId}
        onSelect={handleSelect}
        onAssistantChange={handleAssistantChange}
        onPin={handleTogglePinConversation}
        onRegenerateTitle={handleRegenerateConversationTitle}
        onMoveToAssistant={handleMoveConversation}
        onUpdateTitle={handleUpdateConversationTitle}
        onDelete={handleDeleteConversation}
        onDeleteMany={handleDeleteConversations}
        onCreateConversation={handleCreateConversation}
        webAuthEnabled={settings?.webServerJwtEnabled === true}
      />
      <SidebarInset className="flex min-h-svh flex-col overflow-hidden">
        {/* pt-9 (36px) 让出沉浸式标题栏的高度,避免 SidebarTrigger / 标题被透明标题栏盖住。
            背景色仍由 SidebarInset 继承(--background),顶到窗口顶,和透明标题栏无缝衔接。
            border-divider:用比 --border 更淡的分界色,让区域分隔退到背景里。 */}
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-divider bg-background/95 px-4 pb-3 pt-9 shadow-sm backdrop-blur supports-backdrop-filter:bg-background/60">
          <SidebarTrigger />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-muted-foreground">
              {activeConversation
                ? activeConversation.title
                : t("conversations.header.select_conversation")}
            </div>
            {currentModel && currentProvider ? (
              <div className="truncate text-xs text-muted-foreground/70">
                {`${getAssistantDisplayName(currentAssistant?.name)} / ${getModelDisplayName(currentModel.displayName, currentModel.modelId)} (${currentProvider.name})`}
              </div>
            ) : null}
          </div>
          {canOverrideConversationSystemPrompt ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setSystemPromptDialogOpen(true)}
              disabled={!detail}
              aria-label={t("conversations.custom_prompt.edit_aria")}
              title={t("conversations.custom_prompt.edit_aria")}
            >
              <Pencil className="size-4" />
            </Button>
          ) : null}
          <ThemeToggleButton />
        </div>

        {!isMobile ? (
          <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
            <ResizablePanel
              defaultSize={hasWorkbenchPanel ? 64 : 100}
              minSize={40}
              className="flex min-h-0 flex-col"
            >
              {chatContent}
            </ResizablePanel>
            <ResizableHandle
              withHandle
              className={cn(!hasWorkbenchPanel && "pointer-events-none opacity-0")}
            />
            <ResizablePanel
              defaultSize={hasWorkbenchPanel ? 36 : 0}
              minSize={24}
              collapsible
              collapsedSize={0}
              panelRef={workbenchPanelRef}
              className="flex min-h-0 flex-col"
            >
              {panel ? (
                <WorkbenchHost panel={panel} onClose={closePanel} className="border-l-0" />
              ) : null}
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          chatContent
        )}

        {isMobile && panel ? (
          <Drawer
            open={hasWorkbenchPanel}
            onOpenChange={(open) => {
              if (!open) {
                closePanel();
              }
            }}
            direction="bottom"
          >
            <DrawerContent className="h-[85vh] max-h-[85vh]">
              <WorkbenchHost panel={panel} onClose={closePanel} className="border-l-0" />
            </DrawerContent>
          </Drawer>
        ) : null}
      </SidebarInset>

      <Dialog
        open={compressDialogOpen}
        onOpenChange={(open) => !compressing && setCompressDialogOpen(open)}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("conversations.compress.dialog_title")}</DialogTitle>
            <DialogDescription>
              {t("conversations.compress.dialog_description")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <div className="space-y-2">
              <div className="text-sm font-medium">{t("conversations.compress.target_tokens")}</div>
              <div className="grid grid-cols-4 gap-2">
                {COMPRESS_TOKEN_OPTIONS.map((value) => (
                  <Button
                    key={value}
                    type="button"
                    variant={compressTargetTokens === value ? "default" : "outline"}
                    onClick={() => setCompressTargetTokens(value)}
                  >
                    {value}
                  </Button>
                ))}
              </div>
              <Input
                type="number"
                min={256}
                value={compressTargetTokens}
                onChange={(event) =>
                  setCompressTargetTokens(Math.max(256, Number(event.target.value) || 2000))
                }
              />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium">{t("conversations.compress.keep_recent")}</div>
              <div className="grid grid-cols-4 gap-2">
                {COMPRESS_KEEP_OPTIONS.map((value) => (
                  <Button
                    key={value}
                    type="button"
                    variant={compressKeepRecent === value ? "default" : "outline"}
                    onClick={() => setCompressKeepRecent(value)}
                  >
                    {value}
                  </Button>
                ))}
              </div>
            </div>
            <label className="block space-y-2">
              <span className="text-sm font-medium">{t("conversations.compress.additional_prompt")}</span>
              <Textarea
                value={compressAdditionalPrompt}
                onChange={(event) => setCompressAdditionalPrompt(event.target.value)}
                placeholder={t("conversations.compress.additional_placeholder")}
                className="min-h-28"
              />
            </label>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={compressing}
              onClick={() => setCompressDialogOpen(false)}
            >
              {t("conversations.compress.cancel")}
            </Button>
            <Button
              type="button"
              disabled={compressing}
              onClick={() => void handleConfirmCompressConversation()}
            >
              {compressing ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("conversations.compress.start")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(translationDialogMessageId)}
        onOpenChange={(open) => {
          if (!open && !translatingMessage) setTranslationDialogMessageId(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("conversations.translate.dialog_title")}</DialogTitle>
            <DialogDescription>{t("conversations.translate.dialog_description")}</DialogDescription>
          </DialogHeader>
          <Select value={translationLanguage} onValueChange={setTranslationLanguage}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRANSLATION_LANGUAGES.map((language) => (
                <SelectItem key={language.value} value={language.value}>
                  {t(`conversations.translate.lang.${language.value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={translatingMessage}
              onClick={() => setTranslationDialogMessageId(null)}
            >
              {t("conversations.translate.cancel")}
            </Button>
            <Button
              type="button"
              disabled={translatingMessage}
              onClick={() => void handleConfirmTranslateMessage()}
            >
              {translatingMessage ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("conversations.translate.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={systemPromptDialogOpen} onOpenChange={setSystemPromptDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("conversations.custom_prompt.dialog_title")}</DialogTitle>
            <DialogDescription>
              {t("conversations.custom_prompt.dialog_description")}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={systemPromptDraft}
            onChange={(event) => setSystemPromptDraft(event.target.value)}
            className="min-h-72 font-mono text-xs leading-relaxed"
            placeholder={t("conversations.custom_prompt.dialog_placeholder")}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSystemPromptDialogOpen(false)}>
              {t("conversations.custom_prompt.cancel")}
            </Button>
            <Button onClick={() => void handleSaveConversationSystemPrompt()} disabled={!activeId}>
              {t("conversations.custom_prompt.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );
}
