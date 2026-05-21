import * as React from "react";

import { useNavigate, useParams } from "react-router";

import {
  ConversationQuickJump,
  getConversationMessageAnchorId,
} from "~/components/conversation-quick-jump";
import { ConversationSidebar } from "~/components/conversation-sidebar";
import { useTheme } from "~/components/theme-provider";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "~/components/extended/conversation";
import { useStickToBottomContext } from "use-stick-to-bottom";
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
import { convertConversationToMarkdown, downloadMarkdown, safeMarkdownFilename } from "~/lib/export-markdown";
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
import { Loader2, MessageSquare, Moon, Pencil, Sun } from "lucide-react";
import Logo from "~/components/logo";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { v4 as uuidv4 } from "uuid";
import i18n from "~/i18n";

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
      <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setExpanded((current) => !current)}>
        <Pencil className="size-3.5" />
        <span>{hasCustomPrompt ? "会话系统提示词 ✎" : "会话系统提示词"}</span>
      </Button>
      {expanded ? (
        <div className="mt-2 w-full max-w-3xl space-y-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-28 resize-y"
            placeholder="覆盖当前会话的 system prompt"
          />
          <div className="flex justify-end gap-2">
            {hasCustomPrompt ? (
              <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => void save("")}>
                清除
              </Button>
            ) : null}
            <Button type="button" size="sm" disabled={saving} onClick={() => void save(draft)}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type ConversationSummaryUpdater = (update: ReturnType<typeof toConversationSummaryUpdate>) => void;

function ConversationAutoScroll({
  conversationId,
  messageCount,
}: {
  conversationId: string | null;
  messageCount: number;
}) {
  const { scrollToBottom } = useStickToBottomContext();

  React.useEffect(() => {
    if (!conversationId) return;
    window.requestAnimationFrame(() => scrollToBottom("instant"));
  }, [conversationId, messageCount, scrollToBottom]);

  return null;
}

const EDIT_DRAFT_ATTACHMENT_MARK = "__from_message_attachment";
const EDIT_DRAFT_SOURCE_INDEX = "__from_message_source_index";
const EMPTY_INPUT_ATTACHMENTS: UIMessagePart[] = [];
const EMPTY_SUGGESTIONS: string[] = [];
const COMPRESS_TOKEN_OPTIONS = [500, 1000, 2000, 4000];
const COMPRESS_KEEP_OPTIONS = [0, 16, 32, 64];
const TRANSLATION_LANGUAGES = [
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁体中文" },
  { value: "en-US", label: "English" },
  { value: "ja-JP", label: "日本語" },
  { value: "ko-KR", label: "한국어" },
  { value: "fr-FR", label: "Français" },
  { value: "de-DE", label: "Deutsch" },
  { value: "es-ES", label: "Español" },
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
  // Resolve "system" to a concrete light/dark, so the toggle always lands on the opposite mode.
  const isDark = theme === "dark"
    || (theme === "system" && typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "切换到浅色模式" : "切换到深色模式"}
      title={isDark ? "切换到浅色模式" : "切换到深色模式"}
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
        const status = (err as { status?: number }).status ?? (err as { response?: { status?: number } }).response?.status;
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
    }, 2000);
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
  const draft = useChatInputStore(
    React.useCallback((state) => (draftKey ? state.drafts[draftKey] : undefined), [draftKey]),
  );

  const setDraftText = useChatInputStore((state) => state.setText);
  const addDraftParts = useChatInputStore((state) => state.addParts);
  const removeDraftPart = useChatInputStore((state) => state.removePartAt);
  const getSubmitParts = useChatInputStore((state) => state.getSubmitParts);
  const clearDraft = useChatInputStore((state) => state.clearDraft);

  const inputText = draft?.text ?? "";
  const inputAttachments = draft?.parts ?? EMPTY_INPUT_ATTACHMENTS;

  const handleInputTextChange = React.useCallback(
    (text: string) => {
      if (!draftKey) return;
      setDraftText(draftKey, text);
    },
    [draftKey, setDraftText],
  );

  const handleAddInputParts = React.useCallback(
    (parts: UIMessagePart[]) => {
      if (!draftKey || parts.length === 0) return;
      addDraftParts(draftKey, parts);
    },
    [addDraftParts, draftKey],
  );

  const handleRemoveInputPart = React.useCallback(
    (index: number) => {
      if (!draftKey) return;
      removeDraftPart(draftKey, index);
    },
    [draftKey, removeDraftPart],
  );

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
  }, [activeId, clearDraft, draftKey, getSubmitParts, navigate, refreshList, setActiveId, setHomeDraftId]);

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
    inputText,
    inputAttachments,
    handleInputTextChange,
    handleAddInputParts,
    handleRemoveInputPart,
    handleSubmit,
    replaceDraft,
    clearCurrentDraft,
    getCurrentSubmitParts,
  };
}

const ConversationTimeline = React.memo(({
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
  onToolApproval: (toolCallId: string, approved: boolean, reason: string, answer?: string) => Promise<void>;
}) => {
  const { t } = useTranslation("page");
  const canQuickJump =
    Boolean(activeId) && !detailLoading && !detailError && selectedNodeMessages.length > 1;
  const assistant = React.useMemo(() => {
    if (!settings) return null;
    return settings.assistants.find((item) => item.id === conversationAssistantId) ?? settings.assistants[0] ?? null;
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
    return modelById.get(fallbackId) ?? settings.providers.flatMap((provider) => provider.models)[0] ?? null;
  }, [assistant?.chatModelId, modelById, settings]);
  const lastMessageId = selectedNodeMessages.at(-1)?.message.id ?? null;

  React.useEffect(() => {
    if (!activeId || detailLoading || detailError || !lastMessageId) return;
    const frame = window.requestAnimationFrame(() => {
      document
        .getElementById(getConversationMessageAnchorId(lastMessageId))
        ?.scrollIntoView({ block: "end", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeId, detailError, detailLoading, lastMessageId]);

  return (
    <Conversation key={activeId ?? "home"} className="flex-1 min-h-0">
      <ConversationAutoScroll conversationId={activeId} messageCount={selectedNodeMessages.length} />
      <ConversationContent
        className={cn("mx-auto w-full max-w-3xl gap-4 px-4 py-6", contentClassName)}
      >
        {!activeId && !isHomeRoute && (
          <ConversationEmptyState
            icon={<MessageSquare className="size-10" />}
            title={t("conversations.empty_state.select_title")}
            description={t("conversations.empty_state.select_description")}
          />
        )}
        {activeId && detailLoading && (
          <ConversationEmptyState
            title={t("conversations.empty_state.loading_title")}
            description={t("conversations.empty_state.loading_description")}
          />
        )}
        {activeId && detailError && (
          <ConversationEmptyState
            title={t("conversations.empty_state.error_title")}
            description={detailError}
          />
        )}
        {!detailLoading && !detailError && activeId && selectedNodeMessages.length === 0 && (
          <ConversationEmptyState
            icon={<MessageSquare className="size-10" />}
            title={t("conversations.empty_state.no_message_title")}
            description={t("conversations.empty_state.no_message_description")}
          />
        )}
        {!detailLoading &&
          !detailError &&
          activeId &&
          selectedNodeMessages.map(({ node, message }, index) => {
            const model = message.modelId ? (modelById.get(message.modelId) ?? fallbackModel) : fallbackModel;

            return (
              <div
                key={message.id}
                id={getConversationMessageAnchorId(message.id)}
                className="scroll-mt-24"
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
          })}
        {!detailLoading && !detailError && activeId && isGenerating && selectedNodeMessages.length === 0 && (
          <div className="flex items-start py-2">
            <TypingIndicator className="px-1 py-2" />
          </div>
        )}
      </ConversationContent>

      {canQuickJump ? (
        <ConversationQuickJump
          items={selectedNodeMessages.map(({ message }) => ({
            id: message.id,
            role: message.role,
            preview: getQuickJumpPreview(message, t),
          }))}
        />
      ) : null}

      <ConversationScrollButton />
    </Conversation>
  );
});

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
  const [translationDialogMessageId, setTranslationDialogMessageId] = React.useState<string | null>(null);
  const [translationLanguage, setTranslationLanguage] = React.useState(() =>
    i18n.language?.startsWith("zh") ? "zh-CN" : (navigator.language || "en-US"),
  );
  const [translatingMessage, setTranslatingMessage] = React.useState(false);
  const [systemPromptDialogOpen, setSystemPromptDialogOpen] = React.useState(false);
  const [systemPromptDraft, setSystemPromptDraft] = React.useState("");

  const { detail, detailLoading, detailError, selectedNodeMessages, resetDetail, refreshDetail } =
    useConversationDetail(activeId, updateConversationSummary);

  const {
    draftKey,
    inputText,
    inputAttachments,
    handleInputTextChange,
    handleAddInputParts,
    handleRemoveInputPart,
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
    const assistantId = detail?.assistantId ?? activeConversation?.assistantId ?? currentAssistantId;
    return settings?.assistants.find((assistant) => assistant.id === assistantId) ?? currentAssistant ?? null;
  }, [activeConversation?.assistantId, currentAssistant, currentAssistantId, detail?.assistantId, settings]);
  const canOverrideConversationSystemPrompt =
    activeAssistantForConversation?.allowConversationSystemPrompt === true;

  React.useEffect(() => {
    if (!systemPromptDialogOpen) return;
    setSystemPromptDraft(detail?.systemPrompt ?? activeAssistantForConversation?.systemPrompt ?? "");
  }, [activeAssistantForConversation?.allowConversationSystemPrompt, activeAssistantForConversation?.systemPrompt, detail?.systemPrompt, systemPromptDialogOpen]);

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
    (id: string) => {
      setActiveId(id);
      if (routeId !== id) {
        navigate(`/c/${id}`);
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

  const handleTranslateMessage = React.useCallback(
    async (messageId: string) => {
      setTranslationDialogMessageId(messageId);
    },
    [],
  );

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
      toast.error(error instanceof Error ? error.message : "翻译失败");
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
      handleInputTextChange(suggestion);
    },
    [editingSession, handleInputTextChange],
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
  }, [activeId, clearCurrentDraft, editingSession, getCurrentSubmitParts, handleSubmit, refreshList]);

  const handleTogglePinConversation = React.useCallback(
    async (conversationId: string) => {
      await api.post<{ status: string }>(`conversations/${conversationId}/pin`);
      refreshList();
    },
    [refreshList],
  );

  const handleRegenerateConversationTitle = React.useCallback(
    async (conversationId: string) => {
      await api.post<{ status: string }>(`conversations/${conversationId}/regenerate-title`, undefined, { timeout: false });
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

  const handleConfirmCompressConversation = React.useCallback(async () => {
    if (!activeId) return;
    setCompressing(true);
    try {
      await api.post<{ status: string }>(`conversations/${activeId}/compress`, {
        targetTokens: compressTargetTokens,
        additionalPrompt: compressAdditionalPrompt,
        keepRecentMessages: compressKeepRecent,
      }, { timeout: false });
      setCompressDialogOpen(false);
      await refreshDetail();
      refreshList();
      toast.success("对话历史已压缩");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "压缩失败");
    } finally {
      setCompressing(false);
    }
  }, [activeId, compressAdditionalPrompt, compressKeepRecent, compressTargetTokens, refreshDetail, refreshList]);

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
    toast.success("会话系统提示词已保存");
  }, [activeAssistantForConversation?.allowConversationSystemPrompt, activeId, refreshDetail, refreshList, systemPromptDraft]);

  const handleSaveConversationSystemPromptValue = React.useCallback(async (systemPrompt: string) => {
    if (!activeId || activeAssistantForConversation?.allowConversationSystemPrompt !== true) return;
    await api.post<{ status: string }>(`conversations/${activeId}/system-prompt`, {
      systemPrompt,
    });
    setSystemPromptDraft(systemPrompt);
    refreshDetail();
    refreshList();
    toast.success("会话系统提示词已保存");
  }, [activeAssistantForConversation?.allowConversationSystemPrompt, activeId, refreshDetail, refreshList]);

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
            <ConversationSystemPromptButton value={detail.systemPrompt} onSave={handleSaveConversationSystemPromptValue} />
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
            <div className="mb-3 flex justify-center">
              <div className="[&>svg]:size-16">
                <Logo className="size-16 text-primary"/>
              </div>
            </div>
            <p className="text-lg text-muted-foreground">{t("conversations.welcome_prompt")}</p>
          </div>
        )}
        <ChatInput
          value={inputText}
          attachments={inputAttachments}
          ready={draftKey !== null}
          isGenerating={detail?.isGenerating ?? false}
          disabled={detailLoading || Boolean(detailError)}
          onValueChange={handleInputTextChange}
          onAddParts={handleAddInputParts}
          suggestions={displaySuggestions}
          onSuggestionClick={handleClickSuggestion}
          isEditing={Boolean(editingSession)}
          onCancelEdit={editingSession ? handleCancelEdit : undefined}
          shouldDeleteFileOnRemove={shouldDeleteAttachmentFileOnRemove}
          onRemovePart={handleRemoveInputPart}
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
          onCompressConversation={detail && detail.messages.length > 0 ? handleCompressConversation : undefined}
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
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <SidebarTrigger />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-muted-foreground">
              {activeConversation
                ? activeConversation.title
                : t("conversations.header.select_conversation")}
            </div>
            {currentModel && currentProvider ? (
              <div className="truncate text-xs text-muted-foreground/80">
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
              aria-label="编辑会话系统提示词"
              title="编辑会话系统提示词"
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

      <Dialog open={compressDialogOpen} onOpenChange={(open) => !compressing && setCompressDialogOpen(open)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>压缩对话历史</DialogTitle>
            <DialogDescription>
              使用默认模型与提示词中的上下文压缩模型，将较早消息压缩成摘要并保留最近消息。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <div className="space-y-2">
              <div className="text-sm font-medium">目标 Token</div>
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
                onChange={(event) => setCompressTargetTokens(Math.max(256, Number(event.target.value) || 2000))}
              />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium">保留最近消息</div>
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
              <span className="text-sm font-medium">额外要求</span>
              <Textarea
                value={compressAdditionalPrompt}
                onChange={(event) => setCompressAdditionalPrompt(event.target.value)}
                placeholder="可留空，例如：保留人物关系、关键参数和待办事项"
                className="min-h-28"
              />
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={compressing} onClick={() => setCompressDialogOpen(false)}>
              取消
            </Button>
            <Button type="button" disabled={compressing} onClick={() => void handleConfirmCompressConversation()}>
              {compressing ? <Loader2 className="size-4 animate-spin" /> : null}
              开始压缩
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
            <DialogTitle>选择翻译语言</DialogTitle>
            <DialogDescription>
              译文会保存在当前回复下方，不会进入下一轮上下文。
            </DialogDescription>
          </DialogHeader>
          <Select value={translationLanguage} onValueChange={setTranslationLanguage}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRANSLATION_LANGUAGES.map((language) => (
                <SelectItem key={language.value} value={language.value}>
                  {language.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={translatingMessage} onClick={() => setTranslationDialogMessageId(null)}>
              取消
            </Button>
            <Button type="button" disabled={translatingMessage} onClick={() => void handleConfirmTranslateMessage()}>
              {translatingMessage ? <Loader2 className="size-4 animate-spin" /> : null}
              翻译
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={systemPromptDialogOpen} onOpenChange={setSystemPromptDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>会话系统提示词</DialogTitle>
            <DialogDescription>
              仅对当前会话生效。留空时会回退到助手默认系统提示词。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={systemPromptDraft}
            onChange={(event) => setSystemPromptDraft(event.target.value)}
            className="min-h-72 font-mono text-xs leading-relaxed"
            placeholder="在这里覆盖当前会话的 system prompt"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSystemPromptDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void handleSaveConversationSystemPrompt()} disabled={!activeId}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );
}
