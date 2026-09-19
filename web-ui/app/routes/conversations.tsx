import * as React from "react";

import { useNavigate, useParams, useSearchParams } from "react-router";

import {
  ConversationQuickJump,
  getConversationMessageAnchorId,
  type ConversationQuickJumpItem,
} from "~/components/conversation-quick-jump";
import { ConversationSidebar } from "~/components/conversation-sidebar";
import { ConversationEmptyState } from "~/components/extended/conversation";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ChatInput } from "~/components/input/chat-input";
import { VoiceModeBanner } from "~/components/input/voice-mode-banner";
import { useVoiceModeState, voiceMode } from "~/lib/voice/voice-mode";
import { MessageQueuePanel } from "~/components/input/message-queue-panel";
import { GlobalDropZone } from "~/components/global-drop-zone";
import { ChatMessage } from "~/components/message/chat-message";
import { CompactionDivider } from "~/components/message/compaction-divider";
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
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from "~/components/ui/sidebar";
import { useIsMobile } from "~/hooks/use-mobile";
import { useAvailableCommands } from "~/hooks/use-available-commands";
import { useConversationList } from "~/hooks/use-conversation-list";
import { onHotkeyAction, type HotkeyBusAction } from "~/lib/hotkey-events";
import { useCurrentAssistant } from "~/hooks/use-current-assistant";
import type { SlashCommandDto } from "~/lib/slash-commands";
import {
  convertConversationToMarkdown,
  safeMarkdownFilename,
} from "~/lib/export-markdown";
import { exportTextFile } from "~/lib/export-file";
import { refreshSettingsStore } from "~/lib/settings-sync";
import { cn } from "~/lib/utils";
import { isCompactionBoundaryMessage } from "~/lib/compaction";
import api, { ApiError } from "~/services/api";
import { useChatInputStore } from "~/stores";
import {
  evictConversations,
  useConversationEntry,
  useConversationStore,
} from "~/stores/conversation-store";
import {
  ensureFullConversationDetail,
  loadOlderConversationNodes,
  refreshConversation,
  setConversationStreamAttention,
  useConversationSubscription,
} from "~/stores/conversation-stream";
import { WorkbenchHost } from "~/components/workbench/workbench-host";
import { ContainerPlusMenu } from "~/components/workspace/container-plus-menu";
import { ContainerTabBar } from "~/components/workspace/container-tab-bar";
import { WindowControlsBar } from "~/components/window-controls";
import { ConversationTabStrip } from "~/components/workspace/conversation-tab-strip";
import { EngineStatusBar } from "~/components/workspace/engine-status-bar";
import { PaneContainerProvider } from "~/components/workspace/pane-container-context";
import { WorkspaceEmptyState } from "~/components/workspace/workspace-empty-state";
import { useCompressStore, useConversationCompressing } from "~/stores/compress-store";
import { useWorkspaceStore } from "~/stores/workspace-store";
import {
  CHAT_CONTAINER,
  MAX_PANES,
  flattenColumns,
  groupSiblingOf,
  type ContainerKey,
  type PaneColumn,
  useContainerTabsStore,
} from "~/stores/container-tabs-store";
import { useTabDragStore } from "~/stores/tab-drag-store";
import {
  useWorkbench,
  useWorkbenchController,
  WorkbenchProvider,
} from "~/components/workbench/workbench-context";
import {
  type ConversationListDto,
  type MessageNodeDto,
  type MessageDto,
  type ProviderModel,
  type Settings,
  type UIMessagePart,
} from "~/types";
import {
  ArrowDown,
  Check,
  ListChecks,
  Loader2,
  MessageSquare,
  Pencil,
  X,
} from "lucide-react";
import { EmptyGreeting } from "~/components/empty-greeting";
import type { GroupImperativeHandle, PanelImperativeHandle } from "react-resizable-panels";
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
        <span>
          {hasCustomPrompt
            ? t("conversations.custom_prompt.button_active")
            : t("conversations.custom_prompt.button")}
        </span>
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
// Virtuoso 的 components 必须引用稳定(官方文档明确要求):内联对象每次渲染都是
// 新的组件类型,Header/Footer 被反复卸载重挂 → 尺寸重测(skipAnimationFrameIn-
// ResizeObserver 下同帧同步)→ rangeChanged → setState → 再渲染 → 又是新类型……
// 嵌套更新超 50 次即 React #185 白屏(桌面端快速切换会话高发,崩溃栈实锤 rangeChanged)。
const VirtuosoListPadding = () => <div className="h-4" />;
const VIRTUOSO_COMPONENTS = { Header: VirtuosoListPadding, Footer: VirtuosoListPadding };
const COMPRESS_TOKEN_OPTIONS = [500, 1000, 2000, 4000];
// 工作台面板宽度(占横向组宽的百分比)。注意 react-resizable-panels v4 的数字按像素
// 解析,百分比必须传字符串(如 "36%")。
const WORKBENCH_DEFAULT_WIDTH_PCT = 36;
const WORKBENCH_MIN_WIDTH_PCT = 20;
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

// 侧栏收起(offcanvas 全隐)或移动端时,正文列顶行需要一个展开入口;
// 常态下折叠按钮在侧栏头部(前端重构A1,明暗切换同步迁往侧栏底部)。
function CollapsedSidebarTrigger() {
  const { isMobile, state } = useSidebar();
  if (!isMobile && state !== "collapsed") return null;
  return <SidebarTrigger className="pointer-events-auto relative z-50 mb-1" />;
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
  container,
  activeId,
  isHomeRoute,
  homeDraftId,
  isConversationGenerating,
  setHomeDraftId,
  setActiveId,
  navigate,
  refreshList,
}: {
  /** 本列所属容器:新会话的归属(workspaceId)由它决定,不读全局激活容器。 */
  container: ContainerKey;
  activeId: string | null;
  isHomeRoute: boolean;
  homeDraftId: string;
  /** 当前会话是否在生成(服务端权威,SSE 驱动)。生成中发送 = 走队列端点(FIFO 排队),
   *  而非 messages(后者会中止在跑流)。 */
  isConversationGenerating: boolean;
  setHomeDraftId: React.Dispatch<React.SetStateAction<string>>;
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>;
  navigate: ReturnType<typeof useNavigate>;
  refreshList: () => void;
}) {
  const draftKey = activeId ?? (isHomeRoute ? homeDraftId : null);
  // 刻意不在这里订阅 drafts[draftKey] 的内容:一旦订阅草稿,每次打字都会让整个窗格
  // (消息列表/对话框/工具条)一起重渲染,造成输入卡顿。草稿内容订阅下沉到
  // ChatInputArea——只有输入区随打字重渲染。
  const setDraftText = useChatInputStore((state) => state.setText);
  const addDraftParts = useChatInputStore((state) => state.addParts);
  const getSubmitParts = useChatInputStore((state) => state.getSubmitParts);
  const clearDraft = useChatInputStore((state) => state.clearDraft);

  const handleSubmit = React.useCallback(async () => {
    if (!draftKey) return;

    const parts = getSubmitParts(draftKey);
    if (parts.length === 0) return;

    if (activeId) {
      // 消息发送队列:生成中走队列端点(服务端 FIFO,当前流收尾后续跑),不打断在跑生成;
      // 空闲时走 messages 立即点火。两者服务端同源,队列端点在空闲时行为与 messages 一致。
      const endpoint = isConversationGenerating
        ? `conversations/${activeId}/queue/enqueue`
        : `conversations/${activeId}/messages`;
      await api.post<{ status: string }>(endpoint, { parts });
      clearDraft(draftKey);
      return;
    }

    const conversationId = uuidv4();
    setHomeDraftId(createHomeDraftId());

    // Send the message BEFORE setting activeId so the detail fetcher doesn't race
    // (`POST /messages` calls ensureConversation on the server; only then does the
    // subsequent `GET /api/conversations/{id}` succeed).
    // 双层标签(M2-1):新会话归属发起它的那一列的容器——工作区容器时把 workspaceId
    // 一并送给 ensureConversation,服务端据此挂载工作区工具与提示词段。并排后必须用
    // 列的容器而不是全局激活容器,否则在非聚焦列发第一句会挂到邻列的工作区上。
    await api.post<{ status: string }>(
      `conversations/${conversationId}/messages`,
      container !== CHAT_CONTAINER ? { parts, workspaceId: container } : { parts },
    );
    clearDraft(draftKey);
    useContainerTabsStore.getState().openConversation(container, conversationId);

    setActiveId(conversationId);
    navigate(`/c/${conversationId}`);
    refreshList();
  }, [
    activeId,
    clearDraft,
    container,
    draftKey,
    getSubmitParts,
    isConversationGenerating,
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
  /** 语音模式开关(仅当选中的 ASR 服务支持 server-VAD 时传入;否则输入区不显示入口)。 */
  onToggleVoiceMode?: () => void;
  voiceModeActive?: boolean;
  slashCommands?: SlashCommandDto[];
  onSlashCommand?: (name: string, argument: string) => Promise<boolean | void> | boolean | void;
  getOptimizeContext?: () => string;
  /** 提示词优化回退用的当前会话 id(未配置优化模型时后端用它回退会话模型)。 */
  conversationId?: string | null;
  /** 队列预览插槽(由父级构造,渲染进输入卡片内顶端)。 */
  queueSlot?: React.ReactNode;
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
  onToggleVoiceMode,
  voiceModeActive,
  slashCommands,
  onSlashCommand,
  getOptimizeContext,
  conversationId,
  queueSlot,
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
      onToggleVoiceMode={onToggleVoiceMode}
      voiceModeActive={voiceModeActive}
      slashCommands={slashCommands}
      onSlashCommand={onSlashCommand}
      getOptimizeContext={getOptimizeContext}
      conversationId={conversationId}
      queueSlot={queueSlot}
    />
  );
});

interface QuickJumpRangeHandle {
  setRange: (start: number, end: number) => void;
}

// 滚动范围状态的唯一消费者是快速跳转条,收进独立小组件:Virtuoso 的 rangeChanged
// 高频回调经命令式 ref 只重渲染本组件,巨型 ConversationTimeline(含 Virtuoso)完全
// 不在传播路径上。这不仅是滚动性能优化,更是白屏 bug 的根治:此前 rangeChanged →
// setState 重渲染整个 Timeline,Virtuoso 全套函数 props 换新引用,特定会话上范围
// 计算被扰动回摆,"rangeChanged→重渲染→范围又变"正反馈同步嵌套,直至击穿 React
// 50 层更新深度上限(#185),被 root ErrorBoundary 接住即 "Oops!" 白屏(桌面端快速
// 切换会话高发)。
const QuickJumpOverlay = React.forwardRef<
  QuickJumpRangeHandle,
  {
    seedKey: string;
    initialIndex: number;
    itemCount: number;
    isAtBottom: boolean;
    isAtTop: boolean;
    items: ConversationQuickJumpItem[];
    onItemClick: (index: number) => void;
  }
>(function QuickJumpOverlay(
  { seedKey, initialIndex, itemCount, isAtBottom, isAtTop, items, onItemClick },
  ref,
) {
  const [range, setRange] = React.useState({ start: initialIndex, end: initialIndex });
  // C 族闪动修复(播种逻辑随状态一起搬入):切换会话/详情迟到时在 render 期重置,
  // 避免挂载稳定期 rangeChanged 尚未回调时指示器闪指第 1 轮。
  const seedRef = React.useRef<string | null>(null);
  if (seedRef.current !== seedKey) {
    seedRef.current = seedKey;
    setRange({ start: initialIndex, end: initialIndex });
  }
  React.useImperativeHandle(
    ref,
    () => ({
      setRange: (start, end) =>
        setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end })),
    }),
    [],
  );
  const activeIndex = isAtBottom
    ? itemCount - 1
    : isAtTop
      ? 0
      : Math.round((range.start + range.end) / 2);
  return (
    <ConversationQuickJump items={items} activeIndex={activeIndex} onItemClick={onItemClick} />
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
    // bug1 兜底:react-virtuoso 不支持 firstItemIndex 原地增大(尺寸树错乱 → 底部
    // 幽灵空白/尾部条目消失)。数据层已尽力避免(mergeConversationSnapshot 前缀保留),
    // 但仍有合法缩窗路径(如离开期间新增消息超过一个快照窗口,本地前缀接不上)——
    // 此时唯一正确的处理是重挂载列表。render 期播种(与 knownIdsRef 同模式)。
    const offsetEpochRef = React.useRef({ activeId: null as string | null, offset: 0, epoch: 0 });
    if (offsetEpochRef.current.activeId !== activeId) {
      offsetEpochRef.current = { activeId, offset: nodesOffset, epoch: 0 };
    } else if (nodesOffset > offsetEpochRef.current.offset) {
      offsetEpochRef.current.epoch += 1;
      offsetEpochRef.current.offset = nodesOffset;
    } else if (nodesOffset < offsetEpochRef.current.offset) {
      offsetEpochRef.current.offset = nodesOffset; // 向上翻页(prepend)是受支持方向,只跟踪
    }
    const listRemountEpoch = offsetEpochRef.current.epoch;
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
    // "回到底部"按钮的滚动距离判定用(复现实测:平滑滚动跨越大段未测量的巨型条目时
    // 会因尺寸修正中途卡死,永远到不了底;远距离改瞬时跳转,近距离保留平滑动画)
    const scrollerElRef = React.useRef<HTMLElement | Window | null>(null);
    // I-2:滚到已加载顶部时向上翻页(去重/到头判断在 loadOlderConversationNodes 内)
    const handleStartReached = React.useCallback(() => {
      if (activeId) void loadOlderConversationNodes(activeId);
    }, [activeId]);
    const [isAtBottom, setIsAtBottom] = React.useState(true);
    // 1.5.0 内测 bug1:底部幽灵空白自愈。Virtuoso 的 followOutput 只在新数据到达时
    // 贴底,不追踪已有行的缩高(官方 issue #241 明确为设计取舍);贴底状态下最后一项
    // 大幅缩高(推理块生成结束自动折叠、用户手动折叠长卡片等)时,过期总高度偶发
    // 残留在滚动容器里,表现为"到底了还能继续下拉出大片空白"。对策:总高度变小且
    // 仍贴底时补一次显式贴底,强制 Virtuoso 重算并钳位;rAF 等布局提交后执行。
    // 高度增长(流式输出/向上翻页 prepend)不触发,不干扰正常滚动。
    const isAtBottomRef = React.useRef(true);
    const totalListHeightRef = React.useRef(0);
    React.useEffect(() => {
      // 切换会话时 Virtuoso 按 key 重挂,旧会话的总高度不应参与比较
      totalListHeightRef.current = 0;
    }, [activeId]);
    const handleAtBottomStateChange = React.useCallback((atBottom: boolean) => {
      isAtBottomRef.current = atBottom;
      setIsAtBottom(atBottom);
    }, []);
    // 流式注意力上报:贴底观看当前会话 -> 增量逐帧落地;滚离底部/切会话/卸载 -> 攒批
    // 250ms(根治"流式表格/大块时滚动看别处掉到十几帧",见 conversation-stream.ts)。
    React.useEffect(() => {
      if (!activeId || !isAtBottom) return;
      setConversationStreamAttention(activeId);
      return () => setConversationStreamAttention(null);
    }, [activeId, isAtBottom]);
    const handleTotalListHeightChanged = React.useCallback((height: number) => {
      const previous = totalListHeightRef.current;
      totalListHeightRef.current = height;
      if (previous === 0 || height >= previous || !isAtBottomRef.current) return;
      requestAnimationFrame(() => {
        if (!isAtBottomRef.current) return;
        virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
      });
    }, []);
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
    const quickJumpRangeRef = React.useRef<QuickJumpRangeHandle | null>(null);
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
    const [shareSelectedIds, setShareSelectedIds] = React.useState<Set<string>>(() => new Set());
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
    const scrollSeedRef = React.useRef<{ activeId: string | null; wasEmpty: boolean } | null>(null);
    if (
      scrollSeedRef.current === null ||
      scrollSeedRef.current.activeId !== activeId ||
      (scrollSeedRef.current.wasEmpty && selectedNodeMessages.length > 0)
    ) {
      scrollSeedRef.current = { activeId, wasEmpty: selectedNodeMessages.length === 0 };
      setIsAtBottom(!focusMessageId);
      setIsAtTop(false);
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
      // @container/timeline:消息区自身作为容器基准。分栏时窗格窄,右侧轮次跳转轨需要
      // 在消息列(max-w-3xl)之外留出 gutter 才不压正文——视口断点(lg:)判不出单个窗格
      // 的真实宽度,正是「轨道贴着消息叠在一起」的根因。
      <div className="@container/timeline relative flex-1 min-h-0">
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
            key={`${activeId ?? "home"}:${listRemountEpoch}`}
            ref={virtuosoRef}
            scrollerRef={(el) => {
              scrollerElRef.current = el;
            }}
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
            // 前提:rangeChanged 绝不重渲染本组件(见 QuickJumpOverlay),否则
            // "测量→回调→重渲染→再测量"同步嵌套会击穿 React 更新深度上限(#185)。
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
            atBottomStateChange={handleAtBottomStateChange}
            atTopStateChange={setIsAtTop}
            totalListHeightChanged={handleTotalListHeightChanged}
            rangeChanged={({ startIndex, endIndex }) => {
              // I-2:firstItemIndex 使回调下标携带全局偏移;轮次条用已加载数组的本地坐标。
              // 只走命令式通道更新快速跳转条,绝不 setState 重渲染本组件(根治 #185
              // 白屏正反馈,见 QuickJumpOverlay 注释)。
              quickJumpRangeRef.current?.setRange(startIndex - nodesOffset, endIndex - nodesOffset);
            }}
            increaseViewportBy={overscanExpanded ? 800 : 0}
            components={VIRTUOSO_COMPONENTS}
            itemContent={(index, { node, message }) => {
              const model = message.modelId
                ? (modelById.get(message.modelId) ?? fallbackModel)
                : fallbackModel;
              // I-2:index 携带 firstItemIndex 全局偏移,换算回已加载数组的本地下标
              const localIndex = index - nodesOffset;
              const isLastLoaded = localIndex === selectedNodeMessages.length - 1;
              // 压缩发生点分割线:压缩完成时服务端在"当时的最新消息"上落
              // compaction_boundary 注解,线画在该消息下方(两模式统一)。
              const dividerBelow = isCompactionBoundaryMessage(message);
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
                  {dividerBelow ? <CompactionDivider /> : null}
                </div>
              );
            }}
          />
        )}

        {!detailLoading && !detailError && activeId && selectedNodeMessages.length > 0 ? (
          <>
            {shareSelecting ? (
              <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-background/95 p-1 shadow-lg">
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
                onClick={() => {
                  // 距离超过 3 屏改瞬时:平滑滚动跨大段未测量条目会中途卡死(实测),
                  // 且长距离平滑动画本身也无导向价值
                  const el = scrollerElRef.current;
                  const far =
                    el instanceof HTMLElement &&
                    el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight * 3;
                  virtuosoRef.current?.scrollToIndex({
                    index: selectedNodeMessages.length - 1,
                    behavior: far ? "auto" : "smooth",
                    align: "end",
                  });
                }}
                size="icon"
                type="button"
                variant="outline"
              >
                <ArrowDown className="size-4" />
              </Button>
            ) : null}
            {canQuickJump ? (
              <QuickJumpOverlay
                ref={quickJumpRangeRef}
                seedKey={`${activeId ?? "home"}:${selectedNodeMessages.length === 0}`}
                initialIndex={initialLocation.index}
                itemCount={selectedNodeMessages.length}
                isAtBottom={isAtBottom}
                isAtTop={isAtTop}
                items={quickJumpItems}
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

// ===== 分栏:每列一份的会话视图 =====
// 订阅/选择器/草稿/编辑态/三个会话级对话框全部收进本组件,以 conversationId 为参数——
// 双栏/三栏 = 渲染多个实例。流订阅(entries 多路)与草稿(drafts 按会话键)天然隔离,
// 打字/流式只重渲染所属列。页面层只保留侧栏、容器标签、热键、工作台等全局职责。
// L 轮一级分栏:列 = (容器, 容器内窗格下标),故容器归属由 props 显式传入。

type CurrentAssistantValue = ReturnType<typeof useCurrentAssistant>["currentAssistant"];

interface ConversationPaneViewProps {
  /** 本列所属容器(一级并排:同屏可有多个容器)。 */
  container: ContainerKey;
  /** 本列在所属容器内的窗格下标。 */
  paneIndex: number;
  /** 本列是否为聚焦列(路由/侧栏跟随它)。 */
  focused: boolean;
  /** 本列的会话:焦点列由路由权威(null = "新对话"态);非焦点列 = 窗格激活标签。 */
  conversationId: string | null;
  isHomeRoute: boolean;
  homeDraftId: string;
  setHomeDraftId: React.Dispatch<React.SetStateAction<string>>;
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>;
  navigate: ReturnType<typeof useNavigate>;
  refreshList: () => void;
  settings: Settings | null;
  conversations: ConversationListDto[];
  activeWorkspace?: React.ComponentProps<typeof WorkspaceEmptyState>["workspace"];
  currentAssistantId: ReturnType<typeof useCurrentAssistant>["currentAssistantId"];
  currentAssistant: CurrentAssistantValue;
  onRenameConversation: (conversationId: string, title: string) => Promise<void>;
  onFocusPane: (container: ContainerKey, index: number) => void;
}

const ConversationPaneView = React.memo(function ConversationPaneView({
  container,
  paneIndex,
  focused,
  conversationId,
  isHomeRoute,
  homeDraftId,
  setHomeDraftId,
  setActiveId,
  navigate,
  refreshList,
  settings,
  conversations,
  activeWorkspace,
  currentAssistantId,
  currentAssistant,
  onRenameConversation,
  onFocusPane,
}: ConversationPaneViewProps) {
  const { t } = useTranslation("page");
  const activeId = conversationId;
  // 非聚焦列永远有会话(多窗格不变量:空窗格即收起),"新对话"态只属于聚焦列。
  const paneIsHome = focused && isHomeRoute;

  const [editingSession, setEditingSession] = React.useState<EditingSession | null>(null);
  const [compressDialogOpen, setCompressDialogOpen] = React.useState(false);
  const [compressTargetTokens, setCompressTargetTokens] = React.useState(2000);
  const [compressKeepRecent, setCompressKeepRecent] = React.useState(32);
  const [compressAdditionalPrompt, setCompressAdditionalPrompt] = React.useState("");
  // 压缩状态全局化(compress-store):压缩是长任务,状态不随本组件卸载而丢——切页回来
  // busy 互斥/spinner/取消句柄照常;取消语义(R7-4)不变,后端落库前查 request.signal。
  const compressing = useConversationCompressing(activeId);
  const [translationDialogMessageId, setTranslationDialogMessageId] = React.useState<string | null>(
    null,
  );
  const [translationLanguage, setTranslationLanguage] = React.useState(() =>
    i18n.language?.startsWith("zh") ? "zh-CN" : navigator.language || "en-US",
  );
  const [translatingMessage, setTranslatingMessage] = React.useState(false);
  const [systemPromptDialogOpen, setSystemPromptDialogOpen] = React.useState(false);
  const [systemPromptDraft, setSystemPromptDraft] = React.useState("");

  // 订阅生命周期挂在窗格顶层:窗格打开即持流,与消息面板的条件渲染解耦。
  // 分栏 = 每窗格各挂一份,同会话自动共享一条流。
  useConversationSubscription(activeId);
  // 窄选择器取标量/稳定引用 —— 流式增量期间这些值不变,窗格壳零重渲染。
  const conversationAssistantId = useConversationStore((state) =>
    activeId ? (state.entries[activeId]?.detail?.assistantId ?? null) : null,
  );
  const conversationSystemPrompt = useConversationStore((state) =>
    activeId ? (state.entries[activeId]?.detail?.systemPrompt ?? null) : null,
  );
  const conversationIsGenerating = useConversationStore((state) =>
    activeId ? (state.entries[activeId]?.detail?.isGenerating ?? false) : false,
  );
  // 消息发送队列快照(SSE 直通,队空为 null):队列面板据此渲染。
  const conversationMessageQueue = useConversationStore((state) =>
    activeId ? (state.entries[activeId]?.detail?.messageQueue ?? null) : null,
  );
  const hasDetail = useConversationStore((state) =>
    activeId ? state.entries[activeId]?.detail != null : false,
  );
  const hasMessages = useConversationStore((state) =>
    activeId ? (state.entries[activeId]?.detail?.messages.length ?? 0) > 0 : false,
  );
  // P5:工作区会话的手动压缩走 pi 原生 compaction(压引擎记忆,UI 历史不动)——
  // 压缩框隐藏"目标 Token/保留最近消息"(那是 UI 历史压缩的参数),文案换语义。
  const isWorkspaceConversation = useConversationStore((state) =>
    activeId ? Boolean(state.entries[activeId]?.detail?.workspaceId) : false,
  );
  const detailLoading = useConversationStore((state) => {
    if (!activeId) return false;
    const entry = state.entries[activeId];
    return (entry?.subscribing ?? false) && (entry?.detail ?? null) === null;
  });
  const detailError = useConversationStore((state) =>
    activeId ? (state.entries[activeId]?.error ?? null) : null,
  );
  const chatSuggestions =
    useConversationStore((state) =>
      activeId ? state.entries[activeId]?.detail?.chatSuggestions : undefined,
    ) ?? EMPTY_SUGGESTIONS;

  const {
    draftKey,
    setDraftText,
    handleSubmit,
    replaceDraft,
    clearCurrentDraft,
    getCurrentSubmitParts,
  } = useDraftInputController({
    container,
    activeId,
    isHomeRoute: paneIsHome,
    homeDraftId,
    isConversationGenerating: conversationIsGenerating,
    setHomeDraftId,
    setActiveId,
    navigate,
    refreshList,
  });

  const activeConversationMeta = conversations.find((item) => item.id === activeId);
  const activeAssistantForConversation = React.useMemo(() => {
    const assistantId =
      conversationAssistantId ?? activeConversationMeta?.assistantId ?? currentAssistantId;
    return (
      settings?.assistants.find((assistant) => assistant.id === assistantId) ??
      currentAssistant ??
      null
    );
  }, [
    activeConversationMeta?.assistantId,
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

  const isNewChat = paneIsHome && !activeId;
  const showSuggestions =
    Boolean(activeId) && !detailLoading && !detailError && chatSuggestions.length > 0;
  const displaySuggestions = showSuggestions ? chatSuggestions : EMPTY_SUGGESTIONS;

  React.useEffect(() => {
    setEditingSession(null);
  }, [activeId]);

  /** 交互改路由前先聚焦本列(fork/新建等依赖"路由同步进聚焦列"的语义)。 */
  const focusSelf = React.useCallback(() => {
    useContainerTabsStore.getState().focusPane(container, paneIndex);
  }, [container, paneIndex]);

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
      try {
        await api.post<{ status: string }>(`conversations/${activeId}/regenerate`, {
          messageId,
        });
        refreshList();
      } catch (error) {
        // 审计修复配套:压缩窗口内 regenerate 被服务端 409 挡下(写互斥,防压缩落库
        // 覆盖吞消息)。按业务码查 i18n,后端 message 兜底——否则用户点了没反应。
        const coded =
          error instanceof ApiError && error.errorCode
            ? t(`conversations.compress.error.${error.errorCode}`, { defaultValue: error.message })
            : undefined;
        toast.error(coded ?? (error instanceof Error ? error.message : String(error)));
      }
    },
    [activeId, refreshList, t],
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
      // fork 结果在本窗格打开:先聚焦,路由同步效应会把新会话挂进聚焦窗格。
      focusSelf();
      setActiveId(response.conversationId);
      navigate(`/c/${response.conversationId}`);
      refreshList();
    },
    [activeId, focusSelf, navigate, refreshList, setActiveId],
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
    // 域9-1(3B)防御层:发送门禁主判定在 chat-input(按钮灰+发送键短路),这里再兜一层
    // ——编辑会话/快捷键/程序化触发等绕开按钮的路径,也不会把"解析中"的附件发出去。
    const draftPartsForGate = getCurrentSubmitParts();
    const parsingIds = useChatInputStore.getState().parsingFileIds;
    if (
      parsingIds.length > 0 &&
      draftPartsForGate.some((part) => {
        const fileId = part.metadata?.fileId;
        return typeof fileId === "number" && parsingIds.includes(fileId);
      })
    ) {
      toast.info(t("input:chat.parsing_send_blocked"));
      return;
    }

    if (!editingSession) {
      await handleSubmit();
      refreshList();
      return;
    }

    if (!activeId) return;

    const draftParts = draftPartsForGate;
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
    t,
  ]);

  const handleCompressConversation = React.useCallback(() => {
    if (!activeId) return;
    setCompressDialogOpen(true);
  }, [activeId]);

  // 提示词优化时提取最近 3 轮对话(6 条消息)的纯文本,让优化模型理解"那个""上次的"等指代。
  // 只取 text part,截断到 4000 字符;首条消息时返回空。
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
      lines.push(
        `${message.role === "USER" ? t("conversations.optimize_context.user") : t("conversations.optimize_context.assistant")}: ${text}`,
      );
    }
    return lines.join("\n\n").slice(0, 4000);
  }, [activeId]);

  // 压缩执行共享通道:压缩框与 /compact 指令两个入口走同一函数、同一状态与反馈
  // (方案 §5.1,无平行逻辑)。指令路径不传 UI 历史压缩参数(走服务端默认),失败提示
  // 带指令名前缀(方案 §4.4)。
  const performCompress = React.useCallback(
    async (
      params: { additionalPrompt: string; targetTokens?: number; keepRecentMessages?: number },
      errorPrefix = "",
    ) => {
      if (!activeId) return;
      // 捕获发起时的会话 id:压缩期间用户可能切换会话,begin/end/刷新都要落在原会话上。
      const conversationId = activeId;
      const controller = new AbortController();
      useCompressStore.getState().begin(conversationId, controller);
      try {
        // status 契约:compressed / aborted(服务端收到取消后静默吞掉 AbortError 的确认,
        // 不带成功文案)。客户端 abort 路径抛 AbortError;服务端已停止但 fetch 尚未断时
        // 走这里——同一轻量确认文案,不弹成功。
        const result = await api.post<{ status: string }>(`conversations/${conversationId}/compress`, params, {
          timeout: false,
          signal: controller.signal,
        });
        setCompressDialogOpen(false);
        if (result.status === "aborted") {
          toast.info(t("conversations.compress.aborted"));
        } else {
          refreshConversation(conversationId);
          refreshList();
          toast.success(
            isWorkspaceConversation
              ? t("conversations.compress.workspace_success")
              : t("conversations.compress.success"),
          );
        }
      } catch (error) {
        // R7-4:用户主动取消不报错(取消不是失败)——给一条轻量确认,明确上下文未受影响
        // (内测反馈:中止后毫无反应,用户不确定压缩到底做没做)。
        if (controller.signal.aborted) {
          toast.info(t("conversations.compress.aborted"));
        } else {
          // 带业务码的错误按码查 i18n 文案(服务端 CodedError 通道;查不到用后端 message 兜底)。
          const coded =
            error instanceof ApiError && error.errorCode
              ? t(`conversations.compress.error.${error.errorCode}`, { defaultValue: error.message })
              : undefined;
          const message =
            coded ?? (error instanceof Error ? error.message : t("conversations.compress.failed"));
          toast.error(`${errorPrefix}${message}`);
        }
      } finally {
        useCompressStore.getState().end(conversationId);
      }
    },
    [activeId, isWorkspaceConversation, refreshList],
  );

  const handleConfirmCompressConversation = React.useCallback(async () => {
    await performCompress({
      targetTokens: compressTargetTokens,
      additionalPrompt: compressAdditionalPrompt,
      keepRecentMessages: compressKeepRecent,
    });
  }, [compressAdditionalPrompt, compressKeepRecent, compressTargetTokens, performCompress]);

  // ── 斜杠指令:清单(服务端权威)+ 执行分发表(实现池前端部分;方案 §3.4) ──────
  const availableSlashCommands = useAvailableCommands(activeId);
  // 域5-1(3F):执行器返回 false=未受理(如压缩占用),chat-input 据此回填原文;正常受理返回 void。
  const slashExecutors: Record<string, (argument: string) => Promise<boolean | void>> = React.useMemo(
    () => ({
      // /compact [额外指示] → 既有压缩链路;进行中再触发提示占用(复用现有互斥)并告知未受理。
      compact: async (argument: string) => {
        if (compressing) {
          toast.error(t("conversations.compress.busy"));
          return false;
        }
        await performCompress({ additionalPrompt: argument }, "/compact ");
      },
    }),
    [compressing, performCompress, t],
  );
  // 防两表漂移(方案 §3.1):服务端说可用但前端无执行器的指令不展示,并留痕便于排查。
  const slashCommands = React.useMemo(() => {
    const known = availableSlashCommands.filter((command) => command.name in slashExecutors);
    if (known.length !== availableSlashCommands.length) {
      const missing = availableSlashCommands.filter((c) => !(c.name in slashExecutors)).map((c) => c.name);
      console.warn("[slash-commands] 服务端清单存在前端未实现的指令,已隐藏:", missing);
    }
    return known;
  }, [availableSlashCommands, slashExecutors]);
  const handleSlashCommand = React.useCallback(
    async (name: string, argument: string) => {
      return await slashExecutors[name]?.(argument);
    },
    [slashExecutors],
  );

  const handleStop = React.useCallback(async () => {
    if (!activeId) return;
    await api.post<{ status: string }>(`conversations/${activeId}/stop`);
  }, [activeId]);

  // 语音模式(台账 §1.3):免提对话循环。入口在输入区,横幅在队列面板之上。
  // 仅当选中的 ASR 服务支持 server-VAD(realtime)时可用——一次性 HTTP 识别只能做输入框听写。
  const voiceState = useVoiceModeState();
  const voiceActive = voiceState.phase !== "off";
  const selectedAsrProvider = React.useMemo(
    () => settings?.asrProviders?.find((item) => item.id === settings?.selectedASRProviderId) ?? null,
    [settings],
  );
  const voiceCapable = Boolean(settings?.selectedASRProviderId && selectedAsrProvider);
  const handleToggleVoiceMode = React.useCallback(() => {
    if (voiceActive) {
      voiceMode.stop();
      return;
    }
    if (!activeId) return;
    if (!settings?.selectedASRProviderId || !selectedAsrProvider) {
      toast.error(t("input:voice.not_configured"));
      return;
    }
    const sampleRate = Number(
      selectedAsrProvider.sampleRate || (selectedAsrProvider.type === "openai_realtime" ? 24000 : 16000),
    );
    voiceMode.start(activeId, selectedAsrProvider.id, sampleRate);
  }, [voiceActive, activeId, settings?.selectedASRProviderId, selectedAsrProvider, t]);

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
    [activeAssistantForConversation?.allowConversationSystemPrompt, activeId, refreshList],
  );

  // 拖拽落点(J 轮二级 + L 轮一级统一到一套三分区):拖动标签悬停内容区时
  // 左/中/右 三区高亮 —— 左/右 = 在本列左/右侧拆出新列,中 = 并入本列。
  // 二级载荷(会话标签)在本容器内分栏/移动;一级载荷(容器)拆出/并入"组"——
  // 与二级完全同构:中区 = 并入本组(组焦点换成它),左右 = 带着自己的会话标签
  // 成独立新组。落点动作与高亮都读内存 store(dataTransfer 在 dragover 阶段读不到)。
  // 屏上的列都属于各组焦点容器,所以拖焦点标签时"目标列 = 自己的列"是常态,不是异常:
  // 落到自己列的左右缘 = 把自己从本组拆出去(与二级"把会话标签拖出本窗格"同构),
  // 少了这条,焦点标签就成了唯一拖不出分栏的标签。
  const dragPayload = useTabDragStore((state) => state.dragging);
  const [dropZone, setDropZone] = React.useState<"left" | "center" | "right" | null>(null);

  const resolveDropZone = (event: React.DragEvent<HTMLDivElement>): "left" | "center" | "right" => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / Math.max(1, rect.width);
    return ratio < 0.25 ? "left" : ratio > 0.75 ? "right" : "center";
  };

  const handleZoneDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const payload = useTabDragStore.getState().dragging;
    setDropZone(null);
    useTabDragStore.getState().setDragging(null);
    if (!payload) return;
    const store = useContainerTabsStore.getState();
    const zone = resolveDropZone(event);

    if (payload.kind === "container") {
      const selfDrag = payload.container === container;
      // 中区 = 并入本组;拖的是本组焦点容器时它已在本组,无动作。
      if (selfDrag && zone === "center") return;
      if (zone === "center") {
        // 并入本组 = 激活它(已在屏上 = 换本组焦点;不在屏上 = 接替本组席位)。
        // 激活前先聚焦本列:被接替的是本组,不是旧的全局焦点组。
        store.focusPane(container, paneIndex);
        store.activateContainer(payload.container);
      } else {
        // 拖出成新组:从原组移除(原组空了即消失)再落到本组左/右。
        // 拖本组焦点容器时锚点取同组另一成员 —— 屏上的列都属于各组焦点容器,单组时
        // 它悬停到的唯一目标就是自己的列,不接这一手它就成了唯一拆不出去的标签。
        const anchor = selfDrag ? groupSiblingOf(store.groups, container) : container;
        // 自锚/列满/本组只剩它自己(anchor 为 null)都会让 splitContainerBeside 返回 false:
        // 守卫收口在 store 一处,视图不重复校验,只在被拒时统一外显原因。
        if (
          anchor === null ||
          !store.splitContainerBeside(payload.container, anchor, zone === "left" ? "left" : "right")
        ) {
          toast.error(t("workspace.tabs.split_full", { max: MAX_PANES }));
          return;
        }
      }
      // 落定后按新状态取该容器的停留会话(state 已被 set 替换,须重新读)。
      const next = useContainerTabsStore.getState();
      const panes = next.panes[payload.container] ?? [];
      const focus = Math.max(
        0,
        Math.min(next.focusedPane[payload.container] ?? 0, panes.length - 1),
      );
      const target = panes[focus]?.active ?? null;
      navigate(target ? `/c/${target}` : "/");
      return;
    }

    // 会话标签只在自己的容器内挪(跨容器等于改会话归属,不是布局操作)。
    if (payload.container !== container) return;
    if (zone === "center") {
      store.moveConversationToPane(container, payload.conversationId, paneIndex);
    } else {
      const ok = store.splitConversation(
        container,
        payload.conversationId,
        zone === "left" ? paneIndex : paneIndex + 1,
      );
      // 分栏被拒(可见列已满 / 源窗格只剩一个标签)→ 退化为移入本列。
      if (!ok) store.moveConversationToPane(container, payload.conversationId, paneIndex);
    }
    navigate(`/c/${payload.conversationId}`);
  };

  // 本列是否接受当前拖拽:决定落点覆盖层挂不挂(不接受时不拦截指针、也不高亮)。
  // 一级载荷落到"自己这列"是常态而非异常(屏上的列都属于各组焦点容器),接与不接看
  // 本组是否还有别人接手这一组:有 = 可拆出去;只剩它自己 = 已是独立组,无处可拆。
  const selfContainerDrag = dragPayload?.kind === "container" && dragPayload.container === container;
  const selfSplittable = useContainerTabsStore(
    (state) => groupSiblingOf(state.groups, container) !== null,
  );
  const dropActive =
    dragPayload !== null &&
    (dragPayload.kind === "container"
      ? dragPayload.container !== container || selfSplittable
      : dragPayload.container === container);
  // 覆盖层的上边界:拖会话标签时让开标签行(它自己是"并入本列"的落点);拖容器时
  // 标签行对它没有语义,铺满整列免留死区。
  const hasTabStrip = useContainerTabsStore(
    (state) => (state.panes[container]?.[paneIndex]?.tabs.length ?? 0) > 0,
  );
  const overlayTop = dragPayload?.kind === "conversation" && hasTabStrip ? "top-9" : "top-0";

  return (
    <PaneContainerProvider container={container}>
    <div
      className="relative flex h-full min-h-0 flex-1 flex-col"
      // 点击非焦点列任意处 → 聚焦并把路由切到它的激活会话。会话标签自己会导航到它指定
      // 的会话(data-tab-nav),不能让这里先抢一次焦点切换,否则先跳本列旧会话、
      // 再跳目标会话,中间闪一帧。
      onMouseDownCapture={
        focused
          ? undefined
          : (event) => {
              if ((event.target as HTMLElement).closest("[data-tab-nav]")) return;
              onFocusPane(container, paneIndex);
            }
      }
    >
      <ConversationTabStrip
        container={container}
        paneIndex={paneIndex}
        focused={focused}
        conversations={conversations}
        onRename={onRenameConversation}
        trailing={
          canOverrideConversationSystemPrompt ? (
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
          ) : null
        }
      />

      <div
        className={cn(
          "flex flex-1 flex-col min-h-0 overflow-hidden",
          isNewChat && "justify-center",
        )}
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
                isHomeRoute={paneIsHome}
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
          {isNewChat &&
            (activeWorkspace ? (
              <WorkspaceEmptyState workspace={activeWorkspace} onPrompt={handleClickSuggestion} />
            ) : (
              <div className="mb-6 text-center">
                <EmptyGreeting />
              </div>
            ))}
          {/* 分块 TTS 播放条是全局单例状态,只挂在聚焦窗格,避免分栏时重复显示。 */}
          {focused ? <TtsPlayBar /> : null}
          {/* pi 引擎瞬态状态条(P5):按窗格各自订阅本会话状态,分栏互不串扰。 */}
          <EngineStatusBar conversationId={activeId} />
          {/* 语音模式横幅(免提对话循环;关闭时不渲染)。 */}
          {voiceActive && activeId ? (
            <VoiceModeBanner onEnd={() => voiceMode.stop()} onRetry={handleToggleVoiceMode} />
          ) : null}
          <ChatInputArea
            draftKey={draftKey}
            slashCommands={slashCommands}
            onSlashCommand={handleSlashCommand}
            /* 消息发送队列预览渲染进输入卡内顶端(与输入框同宽同圆角),不再是横贯
               对话区的独立横幅。队空/无会话时为 null,卡内不占位。 */
            queueSlot={
              activeId && conversationMessageQueue ? (
                <MessageQueuePanel conversationId={activeId} queue={conversationMessageQueue} />
              ) : null
            }
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
                    // 域10-1:桌面壳落盘 + 定位;浏览器维持下载(编排层分流)。
                    await exportTextFile(content, filename);
                  }
                : undefined
            }
            onCompressConversation={hasMessages ? handleCompressConversation : undefined}
            getOptimizeContext={getOptimizeContext}
            conversationId={activeId}
            onToggleVoiceMode={voiceCapable || voiceActive ? handleToggleVoiceMode : undefined}
            voiceModeActive={voiceActive}
          />
        </div>
      </div>

      {dropActive ? (
        // 落点提示层:三区等分,命中区亮起品牌色薄底 + 描边,并给一句"放手会发生什么"。
        // 只在本列接受当前拖拽时挂载 —— 不接受时既不拦指针也不亮,用户能看出此处不可放。
        <div
          className={cn("absolute inset-x-0 bottom-0 z-30", overlayTop)}
          onDragOver={(event) => {
            const zone = resolveDropZone(event);
            // 拖本组焦点容器落回自己的中区 = 并入它已在的组,什么都不会发生:既不亮也不
            // 拦指针(光标保持"不可放"),别承诺一个空动作。左右缘才是"拆出去"。
            if (selfContainerDrag && zone === "center") {
              setDropZone(null);
              return;
            }
            event.preventDefault();
            setDropZone(zone);
          }}
          onDragLeave={() => setDropZone(null)}
          onDrop={handleZoneDrop}
        >
          {(["left", "center", "right"] as const).map((zone) => (
            <div
              key={zone}
              className={cn(
                "pointer-events-none absolute inset-y-1 flex items-center justify-center rounded-xl transition-all duration-150",
                zone === "left" && "left-1 w-1/4",
                zone === "center" && "left-1/4 right-1/4",
                zone === "right" && "right-1 w-1/4",
                dropZone === zone
                  ? "bg-primary/10 ring-1 ring-primary/30"
                  : "ring-1 ring-transparent",
              )}
            >
              {dropZone === zone ? (
                <span className="rounded-full bg-[var(--ds-surface-100)] px-2.5 py-1 text-mini font-medium text-[var(--ds-text-secondary)] shadow-[var(--ds-elevation-100)]">
                  {t(
                    zone === "center"
                      ? "workspace.tabs.drop_hint_merge"
                      : "workspace.tabs.drop_hint_split",
                  )}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <Dialog
        open={compressDialogOpen}
        onOpenChange={(open) => !compressing && setCompressDialogOpen(open)}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("conversations.compress.dialog_title")}</DialogTitle>
            <DialogDescription>
              {isWorkspaceConversation
                ? t("conversations.compress.workspace_description")
                : t("conversations.compress.dialog_description")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            {/* P5:工作区会话走 pi 原生压缩,目标 Token/保留最近消息是 UI 历史压缩的
                参数(服务端忽略),隐藏以免误导;额外要求透传为压缩自定义指示。 */}
            {!isWorkspaceConversation ? (
              <>
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
              </>
            ) : null}
            <label className="block space-y-2">
              <span className="text-sm font-medium">
                {t("conversations.compress.additional_prompt")}
              </span>
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
                // 未压缩时就是普通关闭。取消句柄在全局 store,切页回来仍可取消。
                if (activeId) useCompressStore.getState().cancel(activeId);
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
    </div>
    </PaneContainerProvider>
  );
});

function ConversationsPageInner() {
  const { t } = useTranslation("page");
  const navigate = useNavigate();
  const { id: routeId } = useParams();
  const isHomeRoute = !routeId;
  const isMobile = useIsMobile();
  const { panel, closePanel } = useWorkbench();

  const { settings, assistants, currentAssistantId, currentAssistant } = useCurrentAssistant();
  const { conversations, activeId, setActiveId, loading, error, hasMore, loadMore, refreshList } =
    useConversationList({ currentAssistantId, routeId, autoSelectFirst: !isHomeRoute });

  const [homeDraftId, setHomeDraftId] = React.useState(() => createHomeDraftId());

  const activeConversation = conversations.find((item) => item.id === activeId);
  // ===== 双层标签页(工作区 M2-1) =====
  // 路由 /c/:id 是权威:会话的容器归属(列表 meta 或详情快照的 workspaceId)一旦可知,
  // 就把对应容器与会话标签打开——搜索跨容器命中、外部链接进入都自然切换容器。
  // J 轮分栏:openConversation 命中已开窗格时聚焦过去,否则进当前聚焦窗格。
  const detailWorkspaceId = useConversationStore((state) =>
    activeId ? state.entries[activeId]?.detail?.workspaceId : undefined,
  );
  React.useEffect(() => {
    if (!activeId) return;
    const workspaceId = activeConversation ? activeConversation.workspaceId : detailWorkspaceId;
    if (workspaceId === undefined) return; // 归属未知(列表/详情都未到),等下一拍
    useContainerTabsStore.getState().openConversation(workspaceId ?? CHAT_CONTAINER, activeId);
  }, [activeId, activeConversation, detailWorkspaceId]);
  const activeContainer = useContainerTabsStore((state) => state.activeTab);
  // M3-6:工作区容器的首屏空态需要工作区实体(名称/类型/root)。并排后按列取——
  // 每列显示自己容器的空态,而不是聚焦列容器的。
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const workspaceOf = React.useCallback(
    (container: ContainerKey) =>
      container === CHAT_CONTAINER
        ? undefined
        : workspaces.find((item) => item.id === container),
    [workspaces],
  );
  // 侧栏语义随容器切换(方案 §3.1):只列当前容器的会话;完整列表仍用于标题查找等。
  const containerConversations = React.useMemo(
    () =>
      conversations.filter((item) =>
        activeContainer === CHAT_CONTAINER
          ? item.workspaceId == null
          : item.workspaceId === activeContainer,
      ),
    [activeContainer, conversations],
  );

  // 分栏(L 轮分区模型):屏幕列 = 各组焦点容器 × 各自窗格,摊平后左→右渲染。焦点列的
  // 会话以路由为权威,其余列用各自窗格的激活标签。
  // 订阅整个 panes(而非只订阅激活容器的):分栏后同屏有多个容器的窗格,都要参与摊平。
  // 代价可忽略——panes 只在用户开/关/拖标签时变,那些动作本就伴随导航重渲染。
  const groups = useContainerTabsStore((state) => state.groups);
  const openTabs = useContainerTabsStore((state) => state.openTabs);
  const panesRecord = useContainerTabsStore((state) => state.panes);
  const columns = React.useMemo(
    () => flattenColumns(groups, panesRecord, activeContainer),
    [groups, panesRecord, activeContainer],
  );
  // 幽灵标签(开着的容器不在任何组):缀在全局焦点组的标签栏尾部渲染,保持可见可点;
  // 其它组的条不收容它们,免得用户切焦点组时标签跟着乱跳。
  const ghostTabs = React.useMemo(
    () => openTabs.filter((key) => !groups.some((group) => group.includes(key))),
    [openTabs, groups],
  );
  const focusedPaneIndex = useContainerTabsStore((state) => {
    const count = state.panes[state.activeTab]?.length ?? 1;
    return Math.max(0, Math.min(state.focusedPane[state.activeTab] ?? 0, count - 1));
  });

  const handleFocusPane = React.useCallback(
    (container: ContainerKey, index: number) => {
      const store = useContainerTabsStore.getState();
      const count = store.panes[container]?.length ?? 1;
      const current = Math.max(0, Math.min(store.focusedPane[container] ?? 0, count - 1));
      if (store.activeTab === container && current === index) return;
      const target = store.focusPane(container, index);
      setActiveId(target);
      navigate(target ? `/c/${target}` : "/");
    },
    [navigate, setActiveId],
  );

  React.useEffect(() => {
    const base = t("conversations.meta.title");
    document.title = activeConversation?.title ? `${activeConversation.title} - ${base}` : base;
    return () => {
      document.title = base;
    };
  }, [activeConversation?.title, t]);

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
      useContainerTabsStore.getState().forgetConversation(conversationId);
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
      for (const id of conversationIds) useContainerTabsStore.getState().forgetConversation(id);
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
    if (!activeId || containerConversations.length === 0) return;
    const index = containerConversations.findIndex((c) => c.id === activeId);
    if (index === -1) return;
    const target = containerConversations[index + direction];
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
    const offs = actions.map((action) =>
      onHotkeyAction(action, () => hotkeyHandlerRef.current(action)),
    );
    return () => offs.forEach((off) => off());
  }, []);

  const hasWorkbenchPanel = Boolean(panel);
  const workbenchPanelRef = React.useRef<PanelImperativeHandle | null>(null);
  // 用户上次调整的工作台宽度(占组宽百分比),关闭再打开时恢复。
  const workbenchWidthRef = React.useRef(WORKBENCH_DEFAULT_WIDTH_PCT);
  // 一级分栏的组面板组:新组成立即与它组等宽(用户抱怨"拆完两栏不对称")。
  const outerGroupRef = React.useRef<GroupImperativeHandle | null>(null);

  // 工作台开合的根治方案(用户反馈:关闭后空间不回收/拖到边缘后重开只剩一条缝):
  // react-resizable-panels v4 的三个坑一起踩过——
  //   1. 数字尺寸按"像素"解析(字符串才是百分比),原 defaultSize={36}/minSize={24}
  //      全是像素级碎宽,面板可被拖成任意残缝;
  //   2. 动态 defaultSize 在 Panel 的重注册依赖里,每次开关都触发 unregister/register,
  //      清空宽度记忆并与命令式调用竞态——关闭后 collapse() 的结果被重注册布局盖掉;
  //   3. expand() 仅在当前尺寸"恰好等于 collapsedSize"时动作,残缝宽度让它彻底失灵。
  // 因此:约束全部改为静态百分比字符串(杜绝重注册),开合一律用无前置条件的 resize()
  // 显式驱动,宽度记忆由 onResize 维护。
  React.useEffect(() => {
    if (isMobile) return;

    const workbenchPanel = workbenchPanelRef.current;
    if (!workbenchPanel) return;

    if (panel) {
      workbenchPanel.resize(`${workbenchWidthRef.current}%`);
    } else {
      workbenchPanel.resize("0%");
    }
  }, [panel, isMobile]);

  // 一级分栏对称初值(用户反馈:拖出一级分栏后两栏不是默认对称摆放):
  // v4 的动态面板仅保证 minSize 合规,新组会按比例摊薄既有宽度(如 95/5 拆成 90/5/5)。
  // 只在"组数变多"且用户没拖过分隔条(layout 仍全员等宽)时重铺等宽;用户已拖过的
  // 布局原样尊重。effect 里的 setLayout 已保证此刻所有面板都注册完毕。
  const groupsCountRef = React.useRef(groups.length);
  React.useEffect(() => {
    if (isMobile) return;
    const grew = groups.length > groupsCountRef.current;
    groupsCountRef.current = groups.length;
    if (!grew || groups.length < 2) return;
    const group = outerGroupRef.current;
    if (!group) return;
    const layout = group.getLayout();
    const workbench = hasWorkbenchPanel ? Math.max(0, layout["workbench-panel"] ?? 0) : 0;
    const ids = groups.map((_, gi) => `group-panel-${gi}`);
    const sizes = ids.map((id) => layout[id] ?? NaN);
    const alreadyEqual = sizes.every(
      (size) => Number.isFinite(size) && Math.abs(size - sizes[0]!) < 0.5,
    );
    // 面板可能尚未注册(组数刚变的第一帧):缺哪块就跳过,等下一次布局变化再说,
    // 绝不写半截布局(见下"5% 裂条"风险)。
    if (!sizes.every((size) => Number.isFinite(size))) return;
    if (!alreadyEqual) return;
    const share = (100 - workbench) / ids.length;
    group.setLayout(Object.fromEntries(ids.map((id) => [id, share])));
  }, [groups, isMobile, hasWorkbenchPanel]);

  // 全局拖放附件落进聚焦窗格的草稿(草稿键推导与窗格内 useDraftInputController 一致)。
  const focusedDraftKey = activeId ?? (isHomeRoute ? homeDraftId : null);
  const focusedDetailLoading = useConversationStore((state) => {
    if (!activeId) return false;
    const entry = state.entries[activeId];
    return (entry?.subscribing ?? false) && (entry?.detail ?? null) === null;
  });
  const focusedDetailError = useConversationStore((state) =>
    activeId ? (state.entries[activeId]?.error ?? null) : null,
  );

  // 路由会话属于哪一列(若它已在某列开着)。点非聚焦列的标签时,路由先变、下一拍才由
  // 同步效应把焦点挪过去;这一帧里旧聚焦列若无条件采用 activeId,就会闪一下别人的会话。
  // 反之,会话尚未落到任何列时(侧栏点击/新建)聚焦列必须立刻采用 activeId,否则每次
  // 切会话都慢一帧。二者的分界正是"是否已被别的列占着"。
  const routeColumnOwner = React.useMemo(() => {
    if (!activeId) return null;
    return columns.find((column) => column.pane.tabs.includes(activeId)) ?? null;
  }, [activeId, columns]);

  const renderColumn = (column: PaneColumn) => {
    const focused = column.container === activeContainer && column.paneIndex === focusedPaneIndex;
    const routeOwned =
      routeColumnOwner === null ||
      (routeColumnOwner.container === column.container &&
        routeColumnOwner.paneIndex === column.paneIndex);
    return (
      <ConversationPaneView
        container={column.container}
        paneIndex={column.paneIndex}
        focused={focused}
        conversationId={focused && routeOwned ? activeId : column.pane.active}
        isHomeRoute={isHomeRoute}
        homeDraftId={homeDraftId}
        setHomeDraftId={setHomeDraftId}
        setActiveId={setActiveId}
        navigate={navigate}
        refreshList={refreshList}
        settings={settings}
        conversations={conversations}
        activeWorkspace={workspaceOf(column.container)}
        currentAssistantId={currentAssistantId}
        currentAssistant={currentAssistant}
        onRenameConversation={handleUpdateConversationTitle}
        onFocusPane={handleFocusPane}
      />
    );
  };

  return (
    <SidebarProvider defaultOpen className="h-svh overflow-hidden">
      <GlobalDropZone
        draftKey={focusedDraftKey}
        disabled={focusedDetailLoading || Boolean(focusedDetailError)}
      />
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
        conversations={containerConversations}
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
      <SidebarInset className="flex min-h-svh flex-col overflow-hidden bg-transparent pt-1.5 pr-2 pb-2 pl-2">
        {/* I1 窗控带:与画布同色(透明露底),右缘窗控钮;I4 减高 1/3(pt-1.5+22=28px),
            与侧栏品牌行(h-7 上提 4px)垂直中心平齐。浏览器预览下组件返回 null。 */}
        <WindowControlsBar />
        {/* NewMax 内容列 = on-surface 着色 wrapper(撞色带):一级标签行浮在带顶,
            下方白面板盖住其余部分,于是"带"只在标签行处露出;四周 SidebarInset 的
            pt/pr/pb/pl 留出画布边距(左侧即侧栏与面板之间的 gap)。
            L 轮分区模型:分栏时每组是一块同款"撞色带 + 白面板"的独立单元(自己的一级
            标签栏只列本组成员 + 自己的内容列),与二级分栏"每列一条会话标签栏"同构;
            组间由画布色缝隙分隔 —— "两个组"是比"同组两列"更重的边界。 */}
        {groups.length === 1 || isMobile ? (
          <div className="relative isolate flex min-h-0 flex-1 flex-col rounded-[18px] bg-[var(--ds-on-surface)] pt-[2px]">
            {/* 一级容器标签行:窗控/拖拽由上方 WindowControlsBar 负责,本行纯交互。
                z-[3] 压过白面板的 elevation-100 外环阴影(NewMax 同款层级):否则那道
                0.5px 暗环会横穿焦点标签与面板的连接处,连体处凭空多出一条缝。 */}
            <div className="relative z-[3] flex h-[31px] shrink-0 items-end gap-1 px-1">
              <CollapsedSidebarTrigger />
              <div className="relative flex h-full min-w-0 flex-1 items-end">
                <ContainerTabBar
                  group={groups[0] ?? [CHAT_CONTAINER]}
                  groupIndex={0}
                  ghostTabs={ghostTabs}
                  headerTrailing={<ContainerPlusMenu />}
                />
              </div>
            </div>
            {/* 白色圆角内容面板:surface-200 底 + elevation-100,盖住撞色带主体,
                焦点页签经连接条与面板连体;底部圆角与 wrapper 的 18px 对齐。
                分栏:面板内是 1..MAX_PANES 个会话列(同容器的二级窗格)+ 工作台面板的横向可调组。 */}
            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-[16px] rounded-b-[18px] bg-[var(--ds-surface-200)] shadow-[var(--ds-elevation-100)]">
              {!isMobile ? (
                <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
                  {columns.map((column, index) => (
                    <React.Fragment key={`${column.container}:${column.paneIndex}`}>
                      {index > 0 ? <ResizableHandle /> : null}
                      <ResizablePanel
                        id={`conversation-column-${column.container}-${column.paneIndex}`}
                        minSize="18%"
                        className="flex min-h-0 flex-col"
                      >
                        {renderColumn(column)}
                      </ResizablePanel>
                    </React.Fragment>
                  ))}
                  <ResizableHandle
                    withHandle
                    className={cn(!hasWorkbenchPanel && "pointer-events-none opacity-0")}
                  />
                  <ResizablePanel
                    id="workbench-panel"
                    defaultSize="0%"
                    minSize={`${WORKBENCH_MIN_WIDTH_PCT}%`}
                    maxSize="60%"
                    collapsible
                    collapsedSize="0%"
                    panelRef={workbenchPanelRef}
                    onResize={(size) => {
                      // 只记有效宽度:关闭态/收起吸附产生的 0 不覆盖用户偏好。
                      if (size.asPercentage >= WORKBENCH_MIN_WIDTH_PCT) {
                        workbenchWidthRef.current = size.asPercentage;
                      }
                    }}
                    className="flex min-h-0 flex-col"
                  >
                    {panel ? (
                      <WorkbenchHost panel={panel} onClose={closePanel} className="border-l-0" />
                    ) : null}
                  </ResizablePanel>
                </ResizablePanelGroup>
              ) : (
                // 窄屏不分栏:只渲染焦点列(其它列的状态保留,回宽屏即恢复)。
                renderColumn(
                  columns.find(
                    (column) =>
                      column.container === activeContainer && column.paneIndex === focusedPaneIndex,
                  ) ?? columns[0]!,
                )
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
            </div>
          </div>
        ) : (
          // L 轮分区模型分栏:每组 = 撞色带 wrapper(自己的一级标签栏,渲染本组全部
          // 标签)+ 白面板(该组焦点容器的二级列);工作台面板与组并列可调。"新建容器"
          // 入口只在全局焦点组的标签栏上。
          <ResizablePanelGroup orientation="horizontal" className="relative isolate flex min-h-0 flex-1" groupRef={outerGroupRef}>
            {groups.map((group, groupIndex) => {
              const focus = group.includes(activeContainer) ? activeContainer : group[0]!;
              const groupColumns = columns.filter((column) => column.container === focus);
              return (
                // 面板 id 按下标而非焦点容器命名:焦点容器随用户点击切换,若 id 跟着换,
                // v4 视作新面板注册,宽度记忆全丢。
                <React.Fragment key={groupIndex}>
                  {groupIndex > 0 ? (
                    <ResizableHandle className="w-1.5 bg-transparent after:w-1.5" />
                  ) : null}
                  <ResizablePanel
                    id={`group-panel-${groupIndex}`}
                    minSize="18%"
                    className="flex min-h-0 flex-col"
                  >
                    <div className="relative isolate flex min-h-0 flex-1 flex-col rounded-[18px] bg-[var(--ds-on-surface)] pt-[2px]">
                      {/* z-[3] 同单组分支:压过面板阴影外环,连体处不出缝(见上方注释) */}
                      <div className="relative z-[3] flex h-[31px] shrink-0 items-end gap-1 px-1">
                        <div className="relative flex h-full min-w-0 flex-1 items-end">
                          <ContainerTabBar
                            group={group}
                            groupIndex={groupIndex}
                            ghostTabs={group.includes(activeContainer) ? ghostTabs : []}
                            headerTrailing={group.includes(activeContainer) ? <ContainerPlusMenu /> : null}
                          />
                        </div>
                      </div>
                      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-[16px] rounded-b-[18px] bg-[var(--ds-surface-200)] shadow-[var(--ds-elevation-100)]">
                        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
                          {groupColumns.map((column, index) => (
                            <React.Fragment key={`${column.container}:${column.paneIndex}`}>
                              {index > 0 ? <ResizableHandle /> : null}
                              <ResizablePanel
                                id={`conversation-column-${column.container}-${column.paneIndex}`}
                                minSize="18%"
                                className="flex min-h-0 flex-col"
                              >
                                {renderColumn(column)}
                              </ResizablePanel>
                            </React.Fragment>
                          ))}
                        </ResizablePanelGroup>
                      </div>
                    </div>
                  </ResizablePanel>
                </React.Fragment>
              );
            })}
            <ResizableHandle
              withHandle
              className={cn("w-1.5 bg-transparent after:w-1.5", !hasWorkbenchPanel && "pointer-events-none opacity-0")}
            />
            <ResizablePanel
              id="workbench-panel"
              defaultSize="0%"
              minSize={`${WORKBENCH_MIN_WIDTH_PCT}%`}
              maxSize="60%"
              collapsible
              collapsedSize="0%"
              panelRef={workbenchPanelRef}
              onResize={(size) => {
                // 只记有效宽度:关闭态/收起吸附产生的 0 不覆盖用户偏好。
                if (size.asPercentage >= WORKBENCH_MIN_WIDTH_PCT) {
                  workbenchWidthRef.current = size.asPercentage;
                }
              }}
              className="flex min-h-0 flex-col"
            >
              {panel ? (
                <WorkbenchHost panel={panel} onClose={closePanel} className="border-l-0" />
              ) : null}
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </SidebarInset>
    </SidebarProvider>
  );
}
