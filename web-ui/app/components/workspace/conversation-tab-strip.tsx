import * as React from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useContainerTabsStore, type ContainerKey } from "~/stores/container-tabs-store";
import { useConversationStore } from "~/stores/conversation-store";
import { useTabDragStore } from "~/stores/tab-drag-store";
import type { ConversationListDto } from "~/types";

// 二层会话标签(工作区 M2-1;前端重构A1 复刻参考项目):白色内容面板的顶缘胶囊行,
// 激活项奶油底胶囊,非激活幽灵态。标签题目用会话自动标题;"＋"回到本列的"新对话"态。
// trailing 是行尾动作位(如会话级自定义提示词入口)。状态在 container-tabs-store,
// 路由 /c/:id 是权威,这里只发导航,由路由同步效应回写状态。
// G4:右键菜单五项(重命名/关闭/关闭其他/关闭右侧/关闭全部,参考项目对位);
// G5:悬停用自定义 Tooltip 展示完整标题(替代原生 title)。
// L 轮分区模型:一级分栏后同屏有多个容器的标签行,容器归属由 props 显式传入,
// 不读全局 activeTab —— 非聚焦列的标签行也要能正确寻址自己的窗格。

const EMPTY_TABS: string[] = [];

/** 域4-1(交互审查 2A):标签页审批等待点。琥珀脉冲 = 有工具审批挂起等待用户裁决;
    生成中但非等待态不显示(避免与激活态高亮叠加成常驻噪音)。独立组件 = 窄选择器
    只订阅本标签会话的瞬态状态,其它会话的 engine-status 帧不触发本组件重渲染。 */
function TabApprovalDot({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation();
  const awaiting = useConversationStore(
    (state) => state.engineStatus[conversationId]?.phase === "awaiting_approval",
  );
  if (!awaiting) return null;
  return (
    <span
      className="inline-block size-2 shrink-0 animate-pulse rounded-full bg-warning"
      aria-label={t("conversation_sidebar.awaiting_approval")}
      title={t("conversation_sidebar.awaiting_approval")}
    />
  );
}

/** 悬停卡内容(H4):标题 + 本会话累计缓存命中率(专题11-P1-3 的口径:已加载消息窗口内
    选中分支的 cached/prompt 总和;本地估算 usage 无缓存信息,计入会稀释命中率,跳过;
    厂商不回报命中数据时整行隐藏)。独立组件 = Tooltip 打开才挂载、才订阅 store。 */
function TabTooltipBody({ conversationId, title }: { conversationId: string; title: string }) {
  const { t } = useTranslation("page");
  const hitRate = useConversationStore((state) => {
    const nodes = state.entries[conversationId]?.detail?.messages;
    if (!nodes) return null;
    let promptTotal = 0;
    let cachedTotal = 0;
    for (const node of nodes) {
      const msg = node.messages[node.selectIndex] ?? node.messages[0];
      const usage = msg?.usage as Record<string, unknown> | null | undefined;
      if (!usage || typeof usage !== "object") continue;
      if (usage.estimated === true) continue;
      promptTotal += Number(usage.promptTokens ?? 0) || 0;
      cachedTotal += Number(usage.cachedTokens ?? 0) || 0;
    }
    if (promptTotal <= 0 || cachedTotal <= 0) return null;
    return Math.min(100, (cachedTotal / promptTotal) * 100).toFixed(2);
  });
  return (
    <>
      <div className="font-medium">{title}</div>
      {hitRate !== null ? (
        <div className="mt-0.5 font-normal text-[var(--ds-text-secondary)]">
          {t("workspace.tabs.cache_hit_rate", { rate: hitRate })}
        </div>
      ) : null}
    </>
  );
}

export function ConversationTabStrip({
  container,
  conversations,
  paneIndex,
  focused,
  trailing,
  onRename,
}: {
  /** 本标签行所属容器(L 轮分区模型:同屏可有多个容器)。 */
  container: ContainerKey;
  conversations: ConversationListDto[];
  /** 本标签行在所属容器内的窗格下标。 */
  paneIndex: number;
  /** 本列是否为焦点列(路由/侧栏跟随它)。 */
  focused: boolean;
  trailing?: React.ReactNode;
  /** 重命名会话(G4 右键菜单):由路由层注入 PATCH title 的实现。 */
  onRename?: (conversationId: string, title: string) => Promise<void>;
}) {
  const { t } = useTranslation("page");
  const navigate = useNavigate();
  const tabs = useContainerTabsStore(
    (state) => state.panes[container]?.[paneIndex]?.tabs ?? EMPTY_TABS,
  );
  const activeConversation = useContainerTabsStore(
    (state) => state.panes[container]?.[paneIndex]?.active ?? null,
  );

  const [renameTarget, setRenameTarget] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [renameSaving, setRenameSaving] = React.useState(false);

  const titleById = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const item of conversations) map.set(item.id, item.title);
    return map;
  }, [conversations]);

  const handleClose = (conversationId: string) => {
    const next = useContainerTabsStore.getState().closeConversation(container, conversationId);
    if (next !== undefined) navigate(next ? `/c/${next}` : "/");
  };

  const handleCloseBatch = (scope: "others" | "right" | "all", anchor: string) => {
    const next = useContainerTabsStore
      .getState()
      .closeConversationsBatch(container, scope, anchor);
    if (next !== undefined) navigate(next ? `/c/${next}` : "/");
  };

  const submitRename = async () => {
    if (!renameTarget || !onRename) return;
    const title = renameValue.trim();
    if (!title) {
      setRenameTarget(null);
      return;
    }
    setRenameSaving(true);
    try {
      await onRename(renameTarget, title);
      setRenameTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("workspace.tabs.rename_failed"));
    } finally {
      setRenameSaving(false);
    }
  };

  // 无标签 = 本列的"新对话"态:整行不渲染,首屏保持干净。
  if (tabs.length === 0) return null;

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-1 px-2"
      onDragOver={(event) => {
        // 只接同容器的会话标签:跨容器拖动等于改会话归属,不是布局操作。
        const dragging = useTabDragStore.getState().dragging;
        if (dragging?.kind === "conversation" && dragging.container === container) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        const dragging = useTabDragStore.getState().dragging;
        if (dragging?.kind !== "conversation" || dragging.container !== container) return;
        event.preventDefault();
        useTabDragStore.getState().setDragging(null);
        useContainerTabsStore
          .getState()
          .moveConversationToPane(container, dragging.conversationId, paneIndex);
        navigate(`/c/${dragging.conversationId}`);
      }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
      {tabs.map((conversationId, index) => {
        const active = conversationId === activeConversation;
        const title = titleById.get(conversationId)?.trim() || t("workspace.tabs.untitled");
        return (
          <ContextMenu key={conversationId}>
            <Tooltip delayDuration={800}>
              <TooltipTrigger asChild>
                <ContextMenuTrigger asChild>
                  <div
                    ref={(node) => {
                      // I3:激活标签滚入视野(inline nearest 幂等,可见时零开销)
                      if (node && active) node.scrollIntoView({ inline: "nearest", block: "nearest" });
                    }}
                    // 本元素自带"换焦点 + 改路由"语义,父级的"点非聚焦列即聚焦"捕获处理器
                    // 要让开它:否则 mousedown 先切到本列旧会话、click 再切到目标会话,
                    // 中间闪一帧别的内容。
                    data-tab-nav="1"
                    className={cn(
                      "group relative flex h-[26px] min-w-14 shrink basis-44 cursor-pointer select-none items-center gap-1 rounded-lg px-2.5 text-compact transition-colors duration-150",
                      active
                        ? "bg-[var(--ds-on-surface)] font-medium text-[var(--ds-text-primary)] shadow-[inset_0_0_0_0.5px_var(--ds-divider)]"
                        : "text-[var(--ds-text-secondary)] hover:bg-[var(--ds-on-surface)]",
                    )}
                    onClick={() => {
                      if (active && focused) return; // 已经在看它:不重复压历史栈
                      // 先夺焦(幂等):点标签 = "我要看这一栏的这个会话"。只靠 navigate
                      // 不够——若目标标签恰好就是当前路由会话,URL 不变则没有任何效应会把
                      // 焦点搬过来,点击就成了哑操作。
                      useContainerTabsStore.getState().focusPane(container, paneIndex);
                      navigate(`/c/${conversationId}`);
                    }}
                    onAuxClick={(event) => {
                      if (event.button === 1) handleClose(conversationId);
                    }}
                    draggable
                    onDragStart={(event) => {
                      // 拖会话标签 → 列的 drop 区分栏/移动(载荷走内存 store,
                      // dataTransfer 在 dragover 阶段读不到)。
                      event.dataTransfer.effectAllowed = "move";
                      useTabDragStore
                        .getState()
                        .setDragging({ kind: "conversation", conversationId, container });
                    }}
                    onDragEnd={() => useTabDragStore.getState().setDragging(null)}
                  >
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    <TabApprovalDot conversationId={conversationId} />
                    <span
                      role="button"
                      aria-label={t("workspace.tabs.close")}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleClose(conversationId);
                      }}
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-sm transition-opacity duration-150 hover:bg-[var(--ds-on-surface-active)]",
                        active ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60",
                      )}
                    >
                      <X className="size-3" strokeWidth={1.75} />
                    </span>
                  </div>
                </ContextMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="start" className="max-w-[380px]">
                <TabTooltipBody conversationId={conversationId} title={title} />
              </TooltipContent>
            </Tooltip>
            <ContextMenuContent className="min-w-44">
              {onRename ? (
                <>
                  <ContextMenuItem
                    onSelect={() => {
                      setRenameValue(titleById.get(conversationId) ?? "");
                      setRenameTarget(conversationId);
                    }}
                  >
                    <Pencil className="size-4" strokeWidth={1.75} />
                    {t("workspace.tabs.ctx_rename")}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              ) : null}
              <ContextMenuItem onSelect={() => handleClose(conversationId)}>
                {t("workspace.tabs.ctx_close")}
              </ContextMenuItem>
              <ContextMenuItem
                disabled={tabs.length < 2}
                onSelect={() => handleCloseBatch("others", conversationId)}
              >
                {t("workspace.tabs.ctx_close_others")}
              </ContextMenuItem>
              <ContextMenuItem
                disabled={index >= tabs.length - 1}
                onSelect={() => handleCloseBatch("right", conversationId)}
              >
                {t("workspace.tabs.ctx_close_right")}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => handleCloseBatch("all", conversationId)}>
                {t("workspace.tabs.ctx_close_all")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
      <button
        type="button"
        aria-label={t("workspace.tabs.new_conversation")}
        data-tab-nav="1"
        onClick={() => {
          // 先聚焦本列,"新对话"态才落在正确的列上。
          useContainerTabsStore.getState().focusPane(container, paneIndex);
          useContainerTabsStore.getState().clearActiveConversation(container);
          navigate("/");
        }}
        className="flex size-6 shrink-0 items-center justify-center rounded-full text-[var(--ds-icon)] transition-colors duration-150 hover:bg-[var(--ds-on-surface)] hover:text-foreground"
      >
        <Plus className="size-3.5" strokeWidth={1.75} />
      </button>
      </div>
      {trailing ? <div className="flex shrink-0 items-center">{trailing}</div> : null}

      {/* G4 重命名会话 */}
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("workspace.tabs.rename_title")}</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            autoFocus
            placeholder={t("workspace.tabs.rename_placeholder")}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitRename();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              {t("workspace.create.cancel")}
            </Button>
            <Button
              onClick={() => void submitRename()}
              disabled={renameSaving || !renameValue.trim()}
            >
              {t("workspace.menu.rename_confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
