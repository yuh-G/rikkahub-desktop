import * as React from "react";

import { useNavigate, useParams, useSearchParams } from "react-router";

import {
  ConversationQuickJump,
  getConversationMessageAnchorId,
  type ConversationQuickJumpItem,
} from "~/components/conversation-quick-jump";
import { ConversationSidebar } from "~/components/conversation-sidebar";
import { useTheme } from "~/components/theme-provider";
import { ConversationEmptyState } from "~/components/extended/conversation";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ChatInput } from "~/components/input/chat-input";
import { GlobalDropZone } from "~/components/global-drop-zone";
import { ChatMessage } from "~/components/message/chat-message";
import { ShareExportDialog } from "~/components/message/share-export-dialog";
import { RenameConversationDialog } from "~/components/rename-conversation-dialog";
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
import { useConversationList } from "~/hooks/use-conversation-list";
import { onHotkeyAction, type HotkeyBusAction } from "~/lib/hotkey-events";
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
import api from "~/services/api";
import { useChatInputStore } from "~/stores";
import {
  evictConversations,
  useConversationEntry,
  useConversationStore,
} from "~/stores/conversation-store";
import { ensureFullConversationDetail, loadOlderConversationNodes, refreshConversation, useConversationSubscription } from "~/stores/conversation-stream";
import { WorkbenchHost } from "~/components/workbench/workbench-host";
import {
  useWorkbench,
  useWorkbenchController,
  WorkbenchProvider,
} from "~/components/workbench/workbench-context";
import {
  type MessageNodeDto,
  type MessageDto,
  type ProviderModel,
  type Settings,
  type UIMessagePart,
} from "~/types";
import { ArrowDown, Check, ListChecks, Loader2, MessageSquare, Pencil, X } from "lucide-react";
import Logo from "~/components/logo";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { v4 as uuidv4 } from "uuid";
import i18n from "~/i18n";
import { TtsPlayBar } from "~/components/tts-play-bar";

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
      clearDraft(draftKey);
      await api.post<{ status: string }>(`conversations/${activeId}/messages`, { parts });
      return;
    }

    const conversationId = uuidv4();
    setHomeDraftId(createHomeDraftId());

    // Send the message BEFORE setting activeId so the detail fetcher doesn't race
    // (`POST /messages` calls ensureConversation on the server; only then does the
    // subsequent `GET /api/conversations/{id}` succeed).
    clearDraft(draftKey);
    await api.post<{ status: string }>(`conversations/${conversationId}/messages`, { parts });

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
    settings,
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
    settings: Settings | null;
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
    // colocation(D 族支柱②):详情状态在消息面板本地订阅、本地派生 —— 流式增量
    // 只重渲染本子树,顶层(侧边栏/顶栏/输入区)不在传播路径上。切换会话时 store
    // 按 id 直读,缓存命中则首帧就是新会话完整内容(原 render 阶段换内容语义天然满足,
    // 下游 knownIdsRef/滚动播种依赖这一点)。
    const entry = useConversationEntry(activeId);
    const detail = entry?.detail ?? null;
    // I-2(专题2):窗口化快照——detail.messages 是绝对下标 [nodesOffset, total) 的已
    // 加载后缀。Virtuoso 用 firstItemIndex=nodesOffset 做顶部插入的滚动锚定;本组件内
    // 一律使用"已加载数组的本地下标",只在 itemContent/rangeChanged(回调携带全局
    // 偏移)处换算。scrollToIndex/initialTopMostItemIndex 本就是本地坐标,无需换算。
    const nodesOffset = detail?.nodesOffset ?? 0;
    // 缓存命中时即使订阅尚未建立也不进加载态 —— 内容已在屏上,快照到达后静默校正
    const detailLoading = (entry?.subscribing ?? false) && detail === null;
    const detailError = entry?.error ?? null;
    const isGenerating = detail?.isGenerating ?? false;
    const conversationTitle = detail?.title ?? "";
    const conversationAssistantId = detail?.assistantId ?? null;
    const selectedNodeMessages = React.useMemo<SelectedNodeMessage[]>(() => {
      if (!detail) return [];
      return detail.messages.map((node) => ({
        node,
        message: node.messages[node.selectIndex] ?? node.messages[0],
      }));
    }, [detail]);
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

    // I-2:向上翻页 prepend 的老节点不是"新消息",不播入场动画——offset 变小即 prepend,
    // 把新出现的前缀 id 并入已知集合(含"分享/导出拉全量"一次性展开的场景)。
    const prevOffsetRef = React.useRef<{ activeId: string | null; offset: number }>({
      activeId,
      offset: nodesOffset,
    });
    if (prevOffsetRef.current.activeId !== activeId) {
      prevOffsetRef.current = { activeId, offset: nodesOffset };
    } else if (nodesOffset !== prevOffsetRef.current.offset) {
      if (nodesOffset < prevOffsetRef.current.offset) {
        const prepended = prevOffsetRef.current.offset - nodesOffset;
        for (const item of selectedNodeMessages.slice(0, prepended)) {
          knownIdsRef.current.ids.add(item.message.id);
        }
      }
      prevOffsetRef.current = { activeId, offset: nodesOffset };
    }

    const virtuosoRef = React.useRef<VirtuosoHandle>(null);
    // I-2:滚到已加载顶部时向上翻页(去重/到头判断在 loadOlderConversationNodes 内)
    const handleStartReached = React.useCallback(() => {
      if (activeId) void loadOlderConversationNodes(activeId);
    }, [activeId]);
    const [isAtBottom, setIsAtBottom] = React.useState(true);
    // 打开会话的首帧渲染批量控制(专题2 加餐):increaseViewportBy=800 会让 Virtuoso
    // 挂载时连滚动缓冲区一并渲染,每条长消息的 markdown 管线(remark+KaTeX)要
    // 4-20ms,叠加 DOM 提交与布局就是用户看到的“空白/加载中”。改成两阶段:首帧只
    // 渲染视口内(overscan=0),首次内容绘制后的浏览器空闲期再扩回 800px 滚动预渲染
    // 缓冲——首开耗时与缓冲大小解耦,滚动体验不变。切换会话时重置。
    const [overscanExpanded, setOverscanExpanded] = React.useState(false);
    React.useEffect(() => {
      setOverscanExpanded(false);
    }, [activeId]);
    const hasRenderedContent = !detailLoading && !detailError && selectedNodeMessages.length > 0;
    React.useEffect(() => {
      if (overscanExpanded || !hasRenderedContent) return;
      const expand = () => setOverscanExpanded(true);
      if (typeof window.requestIdleCallback === "function") {
        const handle = window.requestIdleCallback(expand, { timeout: 1500 });
        return () => window.cancelIdleCallback(handle);
      }
      const timer = window.setTimeout(expand, 300);
      return () => window.clearTimeout(timer);
    }, [overscanExpanded, hasRenderedContent]);
    const [isAtTop, setIsAtTop] = React.useState(false);
    const [topVisibleIndex, setTopVisibleIndex] = React.useState(0);
    const [topEndIndex, setTopEndIndex] = React.useState(0);
    const didInitialScrollRef = React.useRef<string | null>(null);
    const ensureFullForFocusRef = React.useRef<string | null>(null);

    // C 族闪动修复:"回到底部"按钮延迟出现 —— Virtuoso 挂载稳定期可能瞬时回调
    // atBottom=false→true,立即渲染按钮就是闪现一帧(与加载提示的 250ms 延迟同理)。
    // 150ms 内恢复贴底则全程不可见;真离底(用户上滚)时延迟不可感知。
    const [showJumpToBottom, setShowJumpToBottom] = React.useState(false);
    React.useEffect(() => {
      if (isAtBottom) {
        setShowJumpToBottom(false);
        return;
      }
      const timer = window.setTimeout(() => setShowJumpToBottom(true), 150);
      return () => window.clearTimeout(timer);
    }, [isAtBottom]);

    // 会话内分享: 点消息"分享"进入选择模式, 默认选中该消息及之前所有(对齐 APP).
    // 确认后弹出导出格式选择 (Markdown / 图片). 切换会话时清理, 避免残留选中态.
    const [shareSelecting, setShareSelecting] = React.useState(false);
    const [shareSelectedIds, setShareSelectedIds] = React.useState<Set<string>>(
      () => new Set(),
    );
    const [shareDialogOpen, setShareDialogOpen] = React.useState(false);

    const handleShare = React.useCallback(
      async (messageId: string) => {
        // I-2:默认选中"该消息及之前所有"需要完整历史;窗口化时先拉全量。拿不到完整
        // 历史(网络失败)则放弃进入选择模式——绝不拿截断的数据当作全部内容分享。
        let source = selectedNodeMessages;
        if (activeId && nodesOffset > 0) {
          const full = await ensureFullConversationDetail(activeId);
          if (!full) return;
          source = full.messages.map((node) => ({
            node,
            message: node.messages[node.selectIndex] ?? node.messages[0],
          }));
        }
        const idx = source.findIndex((item) => item.message.id === messageId);
        if (idx < 0) return;
        const ids = new Set<string>();
        for (let i = 0; i <= idx; i++) {
          ids.add(source[i].message.id);
        }
        setShareSelectedIds(ids);
        setShareSelecting(true);
      },
      [activeId, nodesOffset, selectedNodeMessages],
    );

    const handleToggleSelect = React.useCallback((messageId: string) => {
      setShareSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(messageId)) {
          next.delete(messageId);
        } else {
          next.add(messageId);
        }
        return next;
      });
    }, []);

    const handleCancelShare = React.useCallback(() => {
      setShareSelecting(false);
      setShareSelectedIds(new Set());
    }, []);

    const handleSelectAllToggle = React.useCallback(() => {
      setShareSelectedIds((prev) => {
        if (prev.size >= selectedNodeMessages.length) return new Set();
        return new Set(selectedNodeMessages.map((item) => item.message.id));
      });
    }, [selectedNodeMessages]);

    const handleConfirmShare = React.useCallback(() => {
      if (shareSelectedIds.size === 0) {
        setShareSelecting(false);
        return;
      }
      setShareSelecting(false);
      setShareDialogOpen(true);
    }, [shareSelectedIds.size]);

    React.useEffect(() => {
      setShareSelecting(false);
      setShareSelectedIds(new Set());
      setShareDialogOpen(false);
    }, [activeId]);

    // 搜索命中跳转时 URL 带 ?msg=<messageId>,用它定位到命中那条消息(对齐安卓)。
    const [searchParams] = useSearchParams();
    const focusMessageId = searchParams.get("msg");

    // 加载指示延迟出现:本地请求通常几十 ms 内返回,"加载中"只闪一帧反而像故障。
    // 250ms 内完成则全程只见空白→内容;真慢(远端大会话)才浮现文案。
    const [showLoadingHint, setShowLoadingHint] = React.useState(false);
    React.useEffect(() => {
      if (!detailLoading) {
        setShowLoadingHint(false);
        return;
      }
      const timer = window.setTimeout(() => setShowLoadingHint(true), 250);
      return () => window.clearTimeout(timer);
    }, [detailLoading]);

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
      if (nodeIdx < 0) {
        // I-2:命中的可能是窗口之外的老消息——按需拉全量,detail 更新后本 effect 重跑定位。
        // 每个 focusMessageId 只拉一次,拉不到(已删)则维持现状不空转。
        if (nodesOffset > 0 && activeId && ensureFullForFocusRef.current !== focusMessageId) {
          ensureFullForFocusRef.current = focusMessageId;
          void ensureFullConversationDetail(activeId);
        }
        return;
      }
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
    }, [activeId, detailError, detailLoading, focusMessageId, nodesOffset, selectedNodeMessages]);

    // 首帧定位:Virtuoso 缺省从 index 0 开始渲染,挂载后再 scrollToIndex 会先画出
    // 列表中部、布局稳定后又跳一次(用户看到"中间→闪→末尾")。initialTopMostItemIndex
    // 让首帧就渲染在目标处,不产生滚动动作;上面的 scrollToIndex effect 保留,作为
    // 图片/代码块异步撑高后的兜底修正(同位置重滚不可见)。
    const initialLocation = React.useMemo(() => {
      if (focusMessageId) {
        const idx = selectedNodeMessages.findIndex((item) =>
          item.node.messages.some((m) => m.id === focusMessageId),
        );
        if (idx >= 0) return { index: idx, align: "start" as const };
      }
      return { index: Math.max(0, selectedNodeMessages.length - 1), align: "end" as const };
      // 仅挂载时被 Virtuoso 读取(key=activeId 保证每次切会话重挂载),依赖变化无副作用
    }, [focusMessageId, selectedNodeMessages]);

    // C 族闪动修复:滚动指示状态随会话切换在 render 阶段播种(与上方 knownIdsRef 同模式)。
    // Virtuoso 以 key=activeId 重挂载并按 initialTopMostItemIndex 定位首帧,但这几个状态
    // 属于本组件、不随之重置:挂载稳定期 rangeChanged/atBottomStateChange 尚未回调时,
    // 旧值/初值(0)会让轮次条瞬间指向第 1 轮、"回到底部"按钮闪现 —— 即用户报告的
    // "轮次条刚进来指第一轮,闪动后跳末轮"。播种值与 initialLocation 同源:无聚焦消息
    // = 末条+贴底;有聚焦消息 = 该条+非贴底。详情延迟到达(切换时列表为空、快照后才有
    // 消息)的场景在消息首次出现时补播种一次(wasEmpty 分支,同 knownIdsRef 第三条件)。
    const scrollSeedRef = React.useRef<{ activeId: string | null; wasEmpty: boolean } | null>(
      null,
    );
    if (
      scrollSeedRef.current === null ||
      scrollSeedRef.current.activeId !== activeId ||
      (scrollSeedRef.current.wasEmpty && selectedNodeMessages.length > 0)
    ) {
      scrollSeedRef.current = { activeId, wasEmpty: selectedNodeMessages.length === 0 };
      setIsAtBottom(!focusMessageId);
      setIsAtTop(false);
      setTopVisibleIndex(initialLocation.index);
      setTopEndIndex(initialLocation.index);
    }

    // 轮次条条目身份保持(D 族支柱③):以消息对象为键的 WeakMap 缓存 ——
    // applyNodeUpdate 保持未变节点的引用稳定,流式期间只有正在打字那条未命中、
    // 重算 preview 并重建条目;其余条目引用原样复用,行级 memo 得以生效,
    // 也免掉了每 chunk 对全量消息重跑 preview 提取。语言切换(t 变)整表作废重建。
    const quickJumpCacheRef = React.useRef<{
      t: unknown;
      map: WeakMap<MessageDto, ConversationQuickJumpItem>;
    } | null>(null);
    if (quickJumpCacheRef.current === null || quickJumpCacheRef.current.t !== t) {
      quickJumpCacheRef.current = { t, map: new WeakMap() };
    }
    const quickJumpCache = quickJumpCacheRef.current.map;
    const quickJumpItems = React.useMemo(
      () =>
        selectedNodeMessages.map(({ message }) => {
          const hit = quickJumpCache.get(message);
          if (hit) return hit;
          const item: ConversationQuickJumpItem = {
            id: message.id,
            role: message.role,
            preview: getQuickJumpPreview(message, t),
          };
          quickJumpCache.set(message, item);
          return item;
        }),
      [quickJumpCache, selectedNodeMessages, t],
    );

    return (
      <div className="relative flex-1 min-h-0">
        {!activeId && !isHomeRoute ? (
          <ConversationEmptyState
            icon={<MessageSquare className="size-10" />}
            title={t("conversations.empty_state.select_title")}
            description={t("conversations.empty_state.select_description")}
          />
        ) : detailLoading ? (
          showLoadingHint ? (
            <ConversationEmptyState
              title={t("conversations.empty_state.loading_title")}
              description={t("conversations.empty_state.loading_description")}
            />
          ) : null
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
            // I-2:顶部插入的滚动锚定。prepend 时 store 原子地同步减小 offset 与增长
            // messages,Virtuoso 保持视口稳定;offset=0(绝大多数会话)时行为与旧版一致。
            firstItemIndex={nodesOffset}
            startReached={handleStartReached}
            initialTopMostItemIndex={initialLocation}
            // 未测量条目的高度估算基准。首帧挂载条数 ≈ 视口高 ÷ 估算值,它直接决定
            // 打开会话的首帧渲染量:旧值 120 在 900px 视口下首帧挂 ~8 条,而长消息
            // 会话单条实测 1500px+,等于首帧多画 4-8 倍——"打开卡 0.5-1s"的主因之一。
            // 取偏大的 600:长消息会话首帧只挂 1-2 条;短消息会话低估的部分由实测后
            // 同帧渐进补挂(见下方 skipAnimationFrameInResizeObserver),两类会话都
            // 不吃亏。真实高度测得后照常精确修正。
            defaultItemHeight={600}
            // 尺寸测量不等下一帧(官方对新浏览器的推荐配置):Virtuoso 缺省把
            // ResizeObserver 回调推迟到 rAF,挂载稳定期的"渲染→测量"要迭代多轮,
            // 每轮至少一帧,纯帧等待就 100-200ms(性能探针实测)。关掉后同帧完成。
            skipAnimationFrameInResizeObserver
            computeItemKey={(_, item) => item.message.id}
            // "auto" 瞬时贴底(D 族支柱④):流式每 chunk 都触发 followOutput,"smooth"
            // 会让上一帧尚未完成的平滑滚动被反复打断重启,视觉上持续抖动;瞬时贴底
            // 无动画可打断。点击"回到底部"按钮的平滑滚动不受影响(走 scrollToIndex)。
            // 专题9:enableAutoScroll 关闭时不跟底(对齐安卓 ChatList 的同名开关);
            // 进入会话的一次性滚底与"回到底部"按钮不受影响,只停生成期间的强制跟随。
            followOutput={(atBottom) =>
              focusMessageId || settings?.displaySetting.enableAutoScroll === false
                ? false
                : atBottom
                  ? "auto"
                  : false
            }
            atBottomStateChange={setIsAtBottom}
            atTopStateChange={setIsAtTop}
            rangeChanged={({ startIndex, endIndex }) => {
              // I-2:firstItemIndex 使回调下标携带全局偏移;轮次条等用已加载数组的本地坐标
              setTopVisibleIndex(startIndex - nodesOffset);
              setTopEndIndex(endIndex - nodesOffset);
            }}
            increaseViewportBy={overscanExpanded ? 800 : 0}
            components={{
              Header: () => <div className="h-4" />,
              Footer: () => <div className="h-4" />,

            }}
            itemContent={(index, { node, message }) => {
              const model = message.modelId
                ? (modelById.get(message.modelId) ?? fallbackModel)
                : fallbackModel;
              // I-2:index 携带 firstItemIndex 全局偏移,换算回已加载数组的本地下标
              const isLastLoaded = index - nodesOffset === selectedNodeMessages.length - 1;
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
                    loading={isGenerating && isLastLoaded}
                    isLastMessage={isLastLoaded}
                    assistant={assistant}
                    model={model}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onFork={onFork}
                    onRegenerate={onRegenerate}
                    onSelectBranch={onSelectBranch}
                    onTranslate={onTranslate}
                    onToolApproval={onToolApproval}
                    selecting={shareSelecting}
                    selected={shareSelectedIds.has(message.id)}
                    onToggleSelect={handleToggleSelect}
                    onShare={handleShare}
                  />
                </div>
              );
            }}
          />
        )}

        {!detailLoading && !detailError && activeId && selectedNodeMessages.length > 0 ? (
          <>
            {shareSelecting ? (
              <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-background/95 p-1 shadow-lg backdrop-blur">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleCancelShare}
                  title={t("conversations.share.cancel", "取消选择")}
                >
                  <X className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="px-2"
                  onClick={handleSelectAllToggle}
                  title={t("conversations.share.select_all", "全选 / 取消全选")}
                >
                  <ListChecks className="size-4" />
                  <span className="ml-1 text-xs tabular-nums">{shareSelectedIds.size}</span>
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  className="px-2"
                  disabled={shareSelectedIds.size === 0}
                  onClick={handleConfirmShare}
                  title={t("conversations.share.confirm", "导出选中消息")}
                >
                  <Check className="size-4" />
                </Button>
              </div>
            ) : null}
            {showJumpToBottom ? (
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
                items={quickJumpItems}
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
        <ShareExportDialog
          open={shareDialogOpen}
          onOpenChange={setShareDialogOpen}
          messages={selectedNodeMessages
            .filter((item) => shareSelectedIds.has(item.message.id))
            .map((item) => item.message)}
          title={conversationTitle ?? ""}
        />
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
  } = useConversationList({ currentAssistantId, routeId, autoSelectFirst: !isHomeRoute });

  const [homeDraftId, setHomeDraftId] = React.useState(() => createHomeDraftId());
  const [editingSession, setEditingSession] = React.useState<EditingSession | null>(null);
  const [compressDialogOpen, setCompressDialogOpen] = React.useState(false);
  const [compressTargetTokens, setCompressTargetTokens] = React.useState(2000);
  const [compressKeepRecent, setCompressKeepRecent] = React.useState(32);
  const [compressAdditionalPrompt, setCompressAdditionalPrompt] = React.useState("");
  const [compressing, setCompressing] = React.useState(false);
  // R7-4:压缩可中途取消——中止本次请求;后端在落库前检查 request.signal,取消后不改写会话。
  const compressAbortRef = React.useRef<AbortController | null>(null);
  const [translationDialogMessageId, setTranslationDialogMessageId] = React.useState<string | null>(
    null,
  );
  const [translationLanguage, setTranslationLanguage] = React.useState(() =>
    i18n.language?.startsWith("zh") ? "zh-CN" : navigator.language || "en-US",
  );
  const [translatingMessage, setTranslatingMessage] = React.useState(false);
  const [systemPromptDialogOpen, setSystemPromptDialogOpen] = React.useState(false);
  const [systemPromptDraft, setSystemPromptDraft] = React.useState("");

  // 订阅生命周期挂在顶层:会话打开即持流,与消息面板的条件渲染解耦
  // (未来多标签页 = 每个页签容器各挂一份,同会话自动共享一条流)。
  useConversationSubscription(activeId);
  // 顶层只用窄选择器取标量/稳定引用 —— zustand 按 Object.is 比较选择值,流式内容
  // 增量期间这些值不变,顶层(侧边栏/顶栏/对话框)零重渲染(D 族根治的另一半)。
  const conversationAssistantId = useConversationStore((state) =>
    activeId ? (state.entries[activeId]?.detail?.assistantId ?? null) : null,
  );
  const conversationSystemPrompt = useConversationStore((state) =>
    activeId ? (state.entries[activeId]?.detail?.systemPrompt ?? null) : null,
  );
  const conversationIsGenerating = useConversationStore((state) =>
    activeId ? (state.entries[activeId]?.detail?.isGenerating ?? false) : false,
  );
  const hasDetail = useConversationStore((state) =>
    activeId ? state.entries[activeId]?.detail != null : false,
  );
  // 专题11-P1-3:本会话累计缓存命中率(已加载消息窗口内 cached/prompt 总和,取选中分支)。
  // selector 直接归约成整数百分比:流式 chunk 不改 usage 时结果不变,顶层零重渲染;
  // 无任何命中数据(厂商不回报)时返回 null,副标题该段隐藏。
  const conversationCacheHitRate = useConversationStore((state) => {
    const nodes = activeId ? state.entries[activeId]?.detail?.messages : undefined;
    if (!nodes) return null;
    let promptTotal = 0;
    let cachedTotal = 0;
    for (const node of nodes) {
      const msg = node.messages[node.selectIndex] ?? node.messages[0];
      const usage = msg?.usage as Record<string, unknown> | null | undefined;
      if (!usage || typeof usage !== "object") continue;
      // 本地估算的 usage 无缓存信息(cached 恒 0),计入会稀释命中率
      if (usage.estimated === true) continue;
      promptTotal += Number(usage.promptTokens ?? 0) || 0;
      cachedTotal += Number(usage.cachedTokens ?? 0) || 0;
    }
    if (promptTotal <= 0 || cachedTotal <= 0) return null;
    return Math.min(100, Math.round((cachedTotal / promptTotal) * 100));
  });
  // 节点增删才变(流式 chunk 只改节点内部),导出/压缩入口的可用性开关
  const hasMessages = useConversationStore((state) =>
    activeId ? (state.entries[activeId]?.detail?.messages.length ?? 0) > 0 : false,
  );
  const detailLoading = useConversationStore((state) => {
    if (!activeId) return false;
    const entry = state.entries[activeId];
    return (entry?.subscribing ?? false) && (entry?.detail ?? null) === null;
  });
  const detailError = useConversationStore((state) =>
    activeId ? (state.entries[activeId]?.error ?? null) : null,
  );

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
  // 快照整体替换时才换引用;node_update 展开会话对象时该字段引用原样带过,流式期间稳定
  const chatSuggestions =
    useConversationStore((state) =>
      activeId ? state.entries[activeId]?.detail?.chatSuggestions : undefined,
    ) ?? EMPTY_SUGGESTIONS;
  const activeAssistantForConversation = React.useMemo(() => {
    const assistantId =
      conversationAssistantId ?? activeConversation?.assistantId ?? currentAssistantId;
    return (
      settings?.assistants.find((assistant) => assistant.id === assistantId) ??
      currentAssistant ??
      null
    );
  }, [
    activeConversation?.assistantId,
    conversationAssistantId,
    currentAssistant,
    currentAssistantId,
    settings,
  ]);
  const canOverrideConversationSystemPrompt =
    activeAssistantForConversation?.allowConversationSystemPrompt === true;

  React.useEffect(() => {
    if (!systemPromptDialogOpen) return;
    setSystemPromptDraft(
      conversationSystemPrompt ?? activeAssistantForConversation?.systemPrompt ?? "",
    );
  }, [
    activeAssistantForConversation?.allowConversationSystemPrompt,
    activeAssistantForConversation?.systemPrompt,
    conversationSystemPrompt,
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
      if (routeId) {
        navigate("/", { replace: true });
      }
      refreshList();
    },
    [navigate, refreshList, routeId, setActiveId],
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
      // R7-4:翻译端点立即返回 202,翻译在后端异步进行并经 SSE 推送——无需禁用超时。
      await api.post<{ status: string; translation?: string }>(
        `conversations/${activeId}/messages/${translationDialogMessageId}/translate`,
        { targetLanguage: translationLanguage },
      );
      setTranslationDialogMessageId(null);
      refreshConversation(activeId);
      refreshList();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("conversations.translate.failed"));
    } finally {
      setTranslatingMessage(false);
    }
  }, [activeId, refreshList, translationDialogMessageId, translationLanguage]);

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
      // R7-4:标题生成设 120s 客户端上限(原 timeout:false 会让侧栏 spinner 跟着卡死的
      // 后端无限转)。ky 超时会 abort 底层请求;后端在落库前检查 request.signal,
      // 超时后的迟到结果不落库。
      await api.post<{ status: string }>(
        `conversations/${conversationId}/regenerate-title`,
        undefined,
        { timeout: 120_000 },
      );
      // 有活跃订阅(当前打开/未来其它页签)才需要重取,refreshConversation 对未订阅 id 空操作
      refreshConversation(conversationId);
      refreshList();
    },
    [refreshList],
  );

  const handleMoveConversation = React.useCallback(
    async (conversationId: string, assistantId: string) => {
      await api.post<{ status: string }>(`conversations/${conversationId}/move`, { assistantId });
      if (conversationId === activeId) {
        setActiveId(null);
        setHomeDraftId(createHomeDraftId());
        if (routeId === conversationId) {
          navigate("/", { replace: true });
        }
      }
      refreshList();
    },
    [activeId, navigate, refreshList, routeId, setActiveId],
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
      evictConversations([conversationId]);
      if (conversationId === activeId) {
        setActiveId(null);
        setHomeDraftId(createHomeDraftId());
        if (routeId === conversationId) {
          navigate("/", { replace: true });
        }
      }
      refreshList();
    },
    [activeId, navigate, refreshList, routeId, setActiveId],
  );

  const handleDeleteConversations = React.useCallback(
    async (conversationIds: string[]) => {
      await api.post<{ status: string; deleted: number }>("conversations/batch-delete", {
        ids: conversationIds,
      });
      evictConversations(conversationIds);
      if (activeId && conversationIds.includes(activeId)) {
        setActiveId(null);
        setHomeDraftId(createHomeDraftId());
        if (routeId && conversationIds.includes(routeId)) {
          navigate("/", { replace: true });
        }
      }
      refreshList();
    },
    [activeId, navigate, refreshList, routeId, setActiveId],
  );

  const handleCompressConversation = React.useCallback(() => {
    if (!activeId) return;
    setCompressDialogOpen(true);
  }, [activeId]);

  // 提示词优化时提取最近 3 轮对话(6 条消息)的纯文本,让优化模型理解"那个""上次的"等指代。
  // 只取 text part —— 图片(image)、文件(document)、工具调用(tool)、思维链(reasoning)全部被
  // filter 排除,不会发给优化模型。截断到 4000 字符避免吃掉 token 预算。首条消息时返回空。
  const getOptimizeContext = React.useCallback((): string => {
    // 点击优化时按需读取(不订阅):事件处理器拿最新值即可,不为它拉宽重渲染面
    const detail = activeId ? useConversationStore.getState().entries[activeId]?.detail : null;
    if (!detail || detail.messages.length === 0) return "";
    const recent = detail.messages
      .slice(-6)
      .map((node) => node.messages[node.selectIndex] ?? node.messages[0]);
    const lines: string[] = [];
    for (const message of recent) {
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
  }, [activeId]);

  const handleConfirmCompressConversation = React.useCallback(async () => {
    if (!activeId) return;
    setCompressing(true);
    const controller = new AbortController();
    compressAbortRef.current = controller;
    try {
      await api.post<{ status: string }>(
        `conversations/${activeId}/compress`,
        {
          targetTokens: compressTargetTokens,
          additionalPrompt: compressAdditionalPrompt,
          keepRecentMessages: compressKeepRecent,
        },
        { timeout: false, signal: controller.signal },
      );
      setCompressDialogOpen(false);
      refreshConversation(activeId);
      refreshList();
      toast.success(t("conversations.compress.success"));
    } catch (error) {
      // R7-4:用户主动取消不报错(取消不是失败)。
      if (!controller.signal.aborted) {
        toast.error(error instanceof Error ? error.message : t("conversations.compress.failed"));
      }
    } finally {
      compressAbortRef.current = null;
      setCompressing(false);
    }
  }, [
    activeId,
    compressAdditionalPrompt,
    compressKeepRecent,
    compressTargetTokens,
    refreshList,
  ]);

  const handleCreateConversation = React.useCallback(() => {
    closePanel();
    setActiveId(null);
    setHomeDraftId(createHomeDraftId());

    if (routeId) {
      navigate("/");
    }
  }, [closePanel, navigate, routeId, setActiveId]);

  // 切换到上/下个会话(按侧边栏列表顺序:置顶优先,然后按更新时间降序,与展示一致)。
  const switchConversation = (direction: -1 | 1) => {
    if (!activeId || conversations.length === 0) return;
    const index = conversations.findIndex((c) => c.id === activeId);
    if (index === -1) return;
    const target = conversations[index + direction];
    if (!target) return;
    setActiveId(target.id);
    navigate(`/c/${target.id}`);
  };

  // 重命名当前会话:打开自定义 Dialog(替代 WebView2 原生 prompt —— 其标题栏硬编码
  // "localhost:8080 显示",无法定制、样式与应用割裂)。Dialog 内部处理输入校验与确认。
  const [renameOpen, setRenameOpen] = React.useState(false);
  const renameActiveConversation = () => {
    if (!activeId) return;
    if (!conversations.some((c) => c.id === activeId)) return;
    setRenameOpen(true);
  };

  // 快捷键事件接入:ref 每次 render 更新最新闭包,useEffect 只挂一次监听,避免重建与陈旧。
  const hotkeyHandlerRef = React.useRef<(action: HotkeyBusAction) => void>(() => {});
  hotkeyHandlerRef.current = (action: HotkeyBusAction) => {
    switch (action) {
      case "newConversation":
        handleCreateConversation();
        break;
      case "prevConversation":
        switchConversation(-1);
        break;
      case "nextConversation":
        switchConversation(1);
        break;
      case "renameConversation":
        renameActiveConversation();
        break;
      case "searchConversations":
        break;
    }
  };

  React.useEffect(() => {
    const actions: HotkeyBusAction[] = [
      "newConversation",
      "prevConversation",
      "nextConversation",
      "renameConversation",
    ];
    const offs = actions.map((action) => onHotkeyAction(action, () => hotkeyHandlerRef.current(action)));
    return () => offs.forEach((off) => off());
  }, []);

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
    refreshConversation(activeId);
    refreshList();
    toast.success(t("conversations.custom_prompt.saved"));
  }, [
    activeAssistantForConversation?.allowConversationSystemPrompt,
    activeId,
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
      refreshConversation(activeId);
      refreshList();
      toast.success(t("conversations.custom_prompt.saved"));
    },
    [
      activeAssistantForConversation?.allowConversationSystemPrompt,
      activeId,
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
          {canOverrideConversationSystemPrompt && hasDetail ? (
            <ConversationSystemPromptButton
              value={conversationSystemPrompt}
              onSave={handleSaveConversationSystemPromptValue}
            />
          ) : null}
          <div className="relative flex min-h-0 flex-1">
            <ConversationTimeline
              activeId={activeId}
              isHomeRoute={isHomeRoute}
              settings={settings}
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
          isGenerating={conversationIsGenerating}
          disabled={detailLoading || Boolean(detailError)}
          isEditing={Boolean(editingSession)}
          suggestions={displaySuggestions}
          onSuggestionClick={handleClickSuggestion}
          onCancelEdit={editingSession ? handleCancelEdit : undefined}
          shouldDeleteFileOnRemove={shouldDeleteAttachmentFileOnRemove}
          onSend={handleSend}
          onStop={activeId ? handleStop : undefined}
          onExportConversation={
            hasMessages
              ? async (includeReasoning: boolean) => {
                  // 导出需要完整历史:窗口化(I-2)时先拉全量;拿不到完整历史则报错
                  // 放弃,绝不导出被窗口截断的部分内容。
                  const detail = activeId ? await ensureFullConversationDetail(activeId) : null;
                  if (!detail) {
                    if (activeId) toast.error(t("conversations.errors.load_detail_failed"));
                    return;
                  }
                  const content = await convertConversationToMarkdown(detail, includeReasoning);
                  const filename = safeMarkdownFilename(detail.title || "conversation");
                  downloadMarkdown(content, filename);
                }
              : undefined
          }
          onCompressConversation={hasMessages ? handleCompressConversation : undefined}
          getOptimizeContext={getOptimizeContext}
        />
      </div>
    </div>
  );

  return (
    <SidebarProvider defaultOpen className="h-svh overflow-hidden">
      <GlobalDropZone draftKey={draftKey} disabled={detailLoading || Boolean(detailError)} />
    <RenameConversationDialog
      open={renameOpen}
      onOpenChange={setRenameOpen}
      currentTitle={conversations.find((c) => c.id === activeId)?.title ?? ""}
      onConfirm={(nextTitle) => {
        if (!activeId) return;
        void handleUpdateConversationTitle(activeId, nextTitle);
      }}
    />
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
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-divider bg-background/95 px-4 pb-2 pt-2 shadow-sm backdrop-blur supports-backdrop-filter:bg-background/60">
          <SidebarTrigger />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-muted-foreground">
              {activeConversation
                ? activeConversation.title
                : t("conversations.header.select_conversation")}
            </div>
            {currentModel && currentProvider ? (
              <div className="truncate text-xs text-muted-foreground/70">
                {`${getAssistantDisplayName(currentAssistant?.name)} / ${getModelDisplayName(currentModel.displayName, currentModel.modelId)} (${currentProvider.name})${
                  conversationCacheHitRate !== null
                    ? ` / ${t("conversations.header.cache_hit_rate", { rate: conversationCacheHitRate })}`
                    : ""
                }`}
              </div>
            ) : null}
          </div>
          {canOverrideConversationSystemPrompt ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setSystemPromptDialogOpen(true)}
              disabled={!hasDetail}
              aria-label={t("conversations.custom_prompt.edit_aria")}
              title={t("conversations.custom_prompt.edit_aria")}
            >
              <Pencil className="size-4" />
            </Button>
          ) : null}
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
              onClick={() => {
                // R7-4:压缩中点取消 = 中止请求并关框(后端保证取消后不改写会话);
                // 未压缩时就是普通关闭。
                compressAbortRef.current?.abort();
                setCompressDialogOpen(false);
              }}
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
