import * as React from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import {
  Columns2,
  Folder,
  FolderOpen,
  FolderSearch,
  MessageSquare,
  PanelLeft,
  PanelRight,
  Pencil,
  TriangleAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import {
  CreateFolderWorkspaceDialog,
  WorkspaceTrustDialog,
} from "~/components/workspace/workspace-create-dialogs";
import api from "~/services/api";
import {
  CHAT_CONTAINER,
  MAX_PANES,
  useContainerTabsStore,
  type ContainerKey,
} from "~/stores/container-tabs-store";
import { useTabDragStore } from "~/stores/tab-drag-store";
import { useWorkspaceStore } from "~/stores/workspace-store";
import type { WorkspaceDto } from "~/types";

// 一层容器标签栏(工作区 M2-1;前端重构A1 复刻参考项目浏览器式页签):
// 本组焦点标签白底上圆角、与下方组内容面板连成一体;非焦点标签是画布上的 hover 胶囊。
// 中键/×关闭(仅收起);拖拽排序;Ctrl+Tab 循环;溢出横滚。
// L 轮分区模型:每个组分栏各挂一条本组件(group = 本组的标签列表),标签栏只渲染
// 自己组的成员 —— 与二级分栏"每列一条会话标签栏"完全同构。开着的幽灵容器(不在任何组)
// 由全局焦点组的条缀在尾部渲染(ghostTabs),点击 = 接替该组席位上屏。
// 拖拽:悬停标签 = 组内重排/跨组插入(方向感知);落进组的空白处 = 并入该组尾部;
// 落到组内容区边缘 = 拆出新组(落点区在 conversations.tsx)。

// 焦点标签与下方面板连体用的反圆角半径(参考项目同值):左右各溢出标签 13px,靠 radial-gradient
// 画出"面板顶边向标签收束"的那道曲线。两处几何都由它推导,故提到模块级共用。
const TAB_CORNER_R = 13;

// 首标签左位:左侧反圆角是在"面板顶边继续向左延伸"的前提下画的,必须落在面板的直边段上才贴合。
// 面板 rounded-t-[16px] 的圆角吃掉最左 16px,若首标签只右挪 13px(= 反圆角左端顶到面板 x=0),
// 曲线就压在面板自己的圆角上,两条弧之间夹出一道画布色薄片(用户报的"没自然贴合")。
  // 右挪到距组左缘 26px 后反圆角左端落在 x=13,那里面板顶边距平直只差 0.3px —— 与参考
// workspaceHeaderLeftPadding(26)同量。行外层已有 px-1(4px),故本值 = 26 - 4。
const FIRST_TAB_INSET = 22;

/** 点击/循环切换容器:激活并导航到该容器上次停留的会话(无则回"新对话"首页)。 */
function navigateToContainer(key: ContainerKey, navigate: (to: string) => void) {
  const store = useContainerTabsStore.getState();
  store.activateContainer(key);
  // 容器的"上次停留会话" = 聚焦窗格的激活会话。
  const panes = store.panes[key] ?? [];
  const focused = Math.max(0, Math.min(store.focusedPane[key] ?? 0, panes.length - 1));
  const conversationId = panes[focused]?.active ?? null;
  navigate(conversationId ? `/c/${conversationId}` : "/");
}

/** 组焦点容器被并入邻组(或换成别的容器)后,把路由/会话选择交还给全局焦点列。 */
function navigateToActiveContainer(navigate: (to: string) => void) {
  const store = useContainerTabsStore.getState();
  const key = store.activeTab;
  const panes = store.panes[key] ?? [];
  const focused = Math.max(0, Math.min(store.focusedPane[key] ?? 0, panes.length - 1));
  const conversationId = panes[focused]?.active ?? null;
  navigate(conversationId ? `/c/${conversationId}` : "/");
}

export function ContainerTabBar({
  group,
  groupIndex,
  ghostTabs = [],
  headerTrailing = null,
}: {
  /** 本标签栏所属组的标签列表(分区模型:每组分栏一条标签栏,只渲染本组成员)。 */
  group: ContainerKey[];
  /** 本组在 groups 里的下标(拖拽并入/移出按它寻址)。 */
  groupIndex: number;
  /** 缀在本组尾部的幽灵标签(开着的容器不在任何组;点击 = 接替本组席位上屏)。 */
  ghostTabs?: ContainerKey[];
  /** 行尾动作位(全局焦点组挂"新建"入口,其余组为 null)。 */
  headerTrailing?: React.ReactNode;
}) {
  const { t } = useTranslation("page");
  const navigate = useNavigate();
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const loaded = useWorkspaceStore((state) => state.loaded);
  const refresh = useWorkspaceStore((state) => state.refresh);
  const openTabsCount = useContainerTabsStore((state) => state.openTabs.length);
  const activeTab = useContainerTabsStore((state) => state.activeTab);
  const groupsCount = useContainerTabsStore((state) => state.groups.length);
  const [dragKey, setDragKey] = React.useState<ContainerKey | null>(null);
  const [folderDialogOpen, setFolderDialogOpen] = React.useState(false);
  // 信任门目标 + 拒绝语义:创建流拒绝=删除记录;重开已有未信任工作区拒绝=仅关门。
  const [trustTarget, setTrustTarget] = React.useState<{ workspace: WorkspaceDto; fromCreate: boolean } | null>(null);
  // R7 工作区管理:重命名对话框目标 + 输入值(提交 PATCH workspaces/:id)。
  const [renameTarget, setRenameTarget] = React.useState<WorkspaceDto | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [renameSaving, setRenameSaving] = React.useState(false);
  // B6-①b:编辑对话里 folder 型路径可重绑。renameRoot 是编辑中的路径草稿(初始=当前 root)。
  const [renameRoot, setRenameRoot] = React.useState("");

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // 工作区被删除(本端或其他窗口)后清理指向它的标签,activeTab 回落由 store 保证。
  React.useEffect(() => {
    if (!loaded) return;
    useContainerTabsStore
      .getState()
      .pruneWorkspaces(new Set(workspaces.map((workspace) => workspace.id)));
  }, [loaded, workspaces]);

  // Ctrl+Tab / Ctrl+Shift+Tab 循环切换容器(方案 §4.1)。
  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.key !== "Tab") return;
      event.preventDefault();
      const { openTabs: tabs, activeTab: active } = useContainerTabsStore.getState();
      if (tabs.length < 2) return;
      const index = tabs.indexOf(active);
      const next = tabs[(index + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length]!;
      navigateToContainer(next, navigate);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate]);

  const workspaceById = React.useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces],
  );
  const closeTab = React.useCallback(
    (key: ContainerKey) => {
      const store = useContainerTabsStore.getState();
      const wasActive = store.activeTab === key;
      store.closeContainer(key);
      if (wasActive) navigateToContainer(useContainerTabsStore.getState().activeTab, navigate);
    },
    [navigate],
  );

  // G4 右键菜单批量关闭:store 更新后按新 activeTab 导航(可能落回原容器,导航幂等)。
  const closeTabsBatch = React.useCallback(
    (scope: "others" | "right" | "all", anchor: ContainerKey) => {
      useContainerTabsStore.getState().closeContainersBatch(scope, anchor);
      navigateToContainer(useContainerTabsStore.getState().activeTab, navigate);
    },
    [navigate],
  );

  // L 轮分区模型:把容器拆到本组左/右侧成新组(右键菜单入口;拖拽入口在内容区落点区)。
  // 已在屏上的容器先脱离原位再落位(横移);拒绝 = 可见列已满,给出可行动提示。
  const splitContainerBeside = React.useCallback(
    (key: ContainerKey, side: "left" | "right") => {
      const store = useContainerTabsStore.getState();
      if (group.includes(key)) return;
      const anchor = group.includes(activeTab) ? activeTab : group[0]!;
      if (!store.splitContainerBeside(key, anchor, side)) {
        toast.error(t("workspace.tabs.split_full", { max: MAX_PANES }));
        return;
      }
      navigateToContainer(key, navigate);
    },
    [group, activeTab, navigate, t],
  );

  // 移出分栏:容器脱离本组、回到幽灵态,由焦点组接管显示(标签不关、二层状态保留)。
  const unsplitContainerTab = React.useCallback(
    (key: ContainerKey) => {
      if (useContainerTabsStore.getState().unsplitContainer(key)) {
        navigateToActiveContainer(navigate);
      }
    },
    [navigate],
  );

  // G4 在资源管理器中显示:path 空串 = 工作区根目录本身(explorer /select 选中)。
  const revealWorkspace = React.useCallback(
    (workspace: WorkspaceDto) => {
      void api
        .post(`workspaces/${workspace.id}/files/reveal`, { path: "" })
        .catch((err: unknown) => {
          toast.error(err instanceof Error ? err.message : t("workspace.menu.reveal_failed"));
        });
    },
    [t],
  );

  const submitRename = React.useCallback(async () => {
    if (!renameTarget) return;
    const name = renameValue.trim();
    // B6-①b:folder 型且路径被改动 → 一并提交 root(后端重绑 + 信任门重置)。
    const root = renameTarget.type === "folder" ? renameRoot.trim() : "";
    const nameChanged = !!name && name !== renameTarget.name;
    const rootChanged = renameTarget.type === "folder" && !!root && root !== renameTarget.root;
    if (!nameChanged && !rootChanged) {
      setRenameTarget(null);
      return;
    }
    setRenameSaving(true);
    try {
      await api.patch<{ workspace: WorkspaceDto }>(`workspaces/${renameTarget.id}`, {
        ...(nameChanged ? { name } : {}),
        ...(rootChanged ? { root } : {}),
      });
      await refresh();
      setRenameTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(rootChanged ? "workspace.menu.rebind_failed" : "workspace.menu.rename_failed"));
    } finally {
      setRenameSaving(false);
    }
  }, [refresh, renameTarget, renameValue, renameRoot, t]);

  // B6-①b:打开编辑对话时同步名称与路径草稿(folder 型路径可重绑)。
  const openEditDialog = React.useCallback((workspace: WorkspaceDto) => {
    setRenameValue(workspace.name);
    setRenameRoot(workspace.root);
    setRenameTarget(workspace);
  }, []);

  // B6-①b:目录选择器(Tauri);失败仅提示,不阻断手输路径。
  const browseRenameRoot = React.useCallback(async () => {
    try {
      const { open: openPicker } = await import("@tauri-apps/plugin-dialog");
      const picked = await openPicker({ directory: true, multiple: false });
      if (typeof picked === "string" && picked) setRenameRoot(picked);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("workspace.create.pick_failed"));
    }
  }, [t]);

  // 激活容器前的信任门(§3.3):folder 型未信任(含设置里撤销信任后)先过门,
  // 授权成功才真正进入;拒绝仅关门,不删已有工作区。
  const activateGuarded = React.useCallback(
    (key: ContainerKey) => {
      const workspace =
        key === CHAT_CONTAINER ? null : useWorkspaceStore.getState().workspaces.find((item) => item.id === key);
      if (workspace && workspace.type === "folder" && workspace.trustedAt == null) {
        setTrustTarget({ workspace, fromCreate: false });
        return;
      }
      navigateToContainer(key, navigate);
    },
    [navigate],
  );

  // 参考项目 getTabWidthCalc:页签宽度随数量在 58~172px 间按容器宽均分(容器查询 cqw),
  // 预留 64px 给 "+" 钮与边距、外加首标签左位——多开标签时像浏览器一样逐渐收窄。
  // 幽灵标签不占本组宽度预算(它是过客),只按本组成员数均分,免得把标签无谓拉宽。
  const tabWidthCalc = `clamp(58px, calc((100cqw - ${64 + FIRST_TAB_INSET + Math.max(0, group.length - 1) * 3}px) / ${Math.max(1, group.length)}), 172px)`;

  // 标签渲染只看 active 一个配色入参:本组焦点标签连体白底,其余(同组非焦点与画布
  // 幽灵)一律画布色 hover——与旧版一致,不再造"组内胶囊"这条第三视觉态。
  // 右键菜单的"移出分栏/分栏到左右"由 splitable/unsplitable 决定,与配色无关。
  const renderTab = (key: ContainerKey, opts: { indexInRow: number }) => (
    <ContainerTab
      key={key}
      containerKey={key}
      workspace={key === CHAT_CONTAINER ? null : (workspaceById.get(key) ?? null)}
      width={tabWidthCalc}
      active={key === activeTab}
      closable={openTabsCount > 1}
      hasOthers={openTabsCount > 1}
      hasRight={opts.indexInRow < group.length + ghostTabs.length - 1}
      splitable={!group.includes(key)}
      unsplitable={groupsCount > 1 && group.includes(key)}
      dragging={dragKey === key}
      onActivate={() => activateGuarded(key)}
      onClose={() => closeTab(key)}
      onCloseOthers={() => closeTabsBatch("others", key)}
      onCloseRight={() => closeTabsBatch("right", key)}
      onCloseAll={() => closeTabsBatch("all", key)}
      onSplitRight={() => splitContainerBeside(key, "right")}
      onSplitLeft={() => splitContainerBeside(key, "left")}
      onUnsplit={() => unsplitContainerTab(key)}
      onEdit={
        key === CHAT_CONTAINER
          ? undefined
          : () => {
              const workspace = workspaceById.get(key);
              if (workspace) openEditDialog(workspace);
            }
      }
      onReveal={
        key === CHAT_CONTAINER
          ? undefined
          : () => {
              const workspace = workspaceById.get(key);
              if (workspace) revealWorkspace(workspace);
            }
      }
      onDragStart={() => {
        setDragKey(key);
        // 载荷入内存 store(dataTransfer 在 dragover 阶段读不到):落到组内容区
        // 边缘 = 拆新组;落到组标签栏空白处 = 并入该组(见 conversations.tsx)。
        useTabDragStore.getState().setDragging({ kind: "container", container: key });
      }}
      onDragEnd={() => {
        setDragKey(null);
        useTabDragStore.getState().setDragging(null);
      }}
      onDragOverTab={(event) => {
        // 悬停标签 = 组内重排/跨组插入(方向感知)。事件就地消化,不冒泡成"并入本组"。
        if (!dragKey || dragKey === key) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        const side = event.clientX < rect.left + rect.width / 2 ? "left" : "right";
        useContainerTabsStore.getState().moveContainerBeside(dragKey, key, side);
      }}
    />
  );

  return (
    <div
      className="flex h-full min-w-0 flex-1 items-end gap-[3px]"
      style={{ containerType: "inline-size" }}
    >
      {/* 首标签右挪 FIRST_TAB_INSET:让激活态左侧反圆角落在面板直边段上(见常量注释) */}
      <div
        className="flex h-full min-w-0 items-end gap-[3px] overflow-x-auto [scrollbar-width:none]"
        style={{ paddingLeft: FIRST_TAB_INSET }}
        onDragOver={(event) => {
          // 落进本组空白处 = 并入本组尾部(组焦点换成它);等效于点标签,只是顺手一放。
          // 标签自身的 onDragOver 处理组内重排/跨组插入,已 stopPropagation 不会走到这里。
          const dragging = useTabDragStore.getState().dragging;
          if (dragging?.kind === "container" && !group.includes(dragging.container)) {
            event.preventDefault();
          }
        }}
        onDrop={(event) => {
          const dragging = useTabDragStore.getState().dragging;
          if (dragging?.kind !== "container" || group.includes(dragging.container)) return;
          event.preventDefault();
          useTabDragStore.getState().setDragging(null);
          setDragKey(null);
          const store = useContainerTabsStore.getState();
          // 并入本组尾部:已在别组 → 组间移动;幽灵态 → 直接并入(不用激活顶替席位)。
          if (store.moveContainerToGroup(dragging.container, groupIndex)) {
            navigateToActiveContainer(navigate);
          }
        }}
      >
        {group.map((key, index) => renderTab(key, { indexInRow: index }))}
        {/* 幽灵标签:开着的容器不在任何组。缀在全局焦点组尾部保持可见可点(画布色,
            点击 = 接替本组席位上屏);不挪进其它组的条,免得用户切焦点组时标签乱飞。 */}
        {ghostTabs.map((key, index) => renderTab(key, { indexInRow: group.length + index }))}
      </div>

      {headerTrailing}

      {/* G3 编辑工作区:名称可编辑,路径只读可点选(资源管理器中显示) */}
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("workspace.menu.edit_title")}</DialogTitle>
          </DialogHeader>
          {/* min-w-0:DialogContent 是 grid,不压住 auto 最小宽的话长路径会把格子撑出对话框 */}
          <div className="min-w-0 space-y-4">
            <div className="space-y-1.5">
              <label className="text-compact font-medium text-[var(--ds-text-secondary)]">
                {t("workspace.menu.name_label")}
              </label>
              <Input
                value={renameValue}
                autoFocus
                placeholder={t("workspace.menu.rename_placeholder")}
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitRename();
                }}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-compact font-medium text-[var(--ds-text-secondary)]">
                {t("workspace.menu.path_label")}
              </label>
              {renameTarget?.type === "folder" ? (
                <>
                  {/* B6-①b:folder 型路径可重绑。missing 态显示失效警告;改路径后提示需重新授权信任。 */}
                  {renameTarget.status === "missing" ? (
                    <div className="flex items-start gap-2 rounded-[var(--ds-radius-md)] bg-warning/10 px-3 py-2 text-xs text-warning">
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
                      <span>{t("workspace.menu.missing_hint")}</span>
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <Input
                      value={renameRoot}
                      onChange={(event) => setRenameRoot(event.target.value)}
                      placeholder={t("workspace.create.folder_path_placeholder")}
                      className="flex-1 font-mono text-compact"
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => void browseRenameRoot()}>
                      <FolderSearch className="mr-1 size-4" />
                      {t("workspace.create.browse")}
                    </Button>
                  </div>
                  {renameRoot.trim() && renameRoot.trim() !== renameTarget.root ? (
                    <div className="text-xs text-muted-foreground">{t("workspace.menu.rebind_notice")}</div>
                  ) : null}
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => renameTarget && revealWorkspace(renameTarget)}
                  aria-label={t("workspace.menu.reveal")}
                  className="flex h-9 w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-[var(--ds-radius-md)] bg-[var(--ds-surface-input)] px-3 text-left text-compact text-[var(--ds-text-secondary)] shadow-[var(--ds-input-shadow)] transition-shadow hover:shadow-[var(--ds-input-shadow-hover)]"
                >
                  <FolderOpen className="size-4 shrink-0 text-[var(--ds-icon)]" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1 truncate">{renameTarget?.root}</span>
                </button>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              {t("workspace.create.cancel")}
            </Button>
            <Button onClick={() => void submitRename()} disabled={renameSaving || !renameValue.trim()}>
              {t("workspace.menu.rename_confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CreateFolderWorkspaceDialog
        open={folderDialogOpen}
        onOpenChange={setFolderDialogOpen}
        onCreated={(workspace) => setTrustTarget({ workspace, fromCreate: true })}
      />
      <WorkspaceTrustDialog
        workspace={trustTarget?.workspace ?? null}
        onOpenChange={(open) => {
          if (!open) setTrustTarget(null);
        }}
        onDeclinedDelete={trustTarget?.fromCreate ?? false}
        onTrusted={(workspace) => {
          useContainerTabsStore.getState().openContainer(workspace.id);
          navigateToContainer(workspace.id, navigate);
        }}
      />
    </div>
  );
}

function ContainerTab({
  containerKey,
  workspace,
  width,
  active,
  closable,
  hasOthers,
  hasRight,
  splitable,
  unsplitable,
  dragging,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseRight,
  onCloseAll,
  onSplitLeft,
  onSplitRight,
  onUnsplit,
  onEdit,
  onReveal,
  onDragStart,
  onDragEnd,
  onDragOverTab,
}: {
  containerKey: ContainerKey;
  workspace: WorkspaceDto | null;
  width: string;
  /** 本组的焦点标签:与组内容面板连体。 */
  active: boolean;
  closable: boolean;
  hasOthers: boolean;
  hasRight: boolean;
  /** 可"分栏到左/右":不在本组(含幽灵态)。 */
  splitable: boolean;
  /** 可"移出分栏":分栏中且是本组成员(幽灵已不在组,无可退)。 */
  unsplitable: boolean;
  dragging: boolean;
  onActivate: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseRight: () => void;
  onCloseAll: () => void;
  onSplitLeft: () => void;
  onSplitRight: () => void;
  onUnsplit: () => void;
  onEdit?: () => void;
  onReveal?: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverTab: (event: React.DragEvent<HTMLElement>) => void;
}) {
  const { t } = useTranslation("page");
  const isChat = containerKey === CHAT_CONTAINER;
  const label = isChat
    ? t("workspace.tabs.chat")
    : (workspace?.name ?? t("workspace.tabs.missing"));
  const Icon = isChat ? MessageSquare : workspace?.type === "folder" ? FolderOpen : Folder;
  // 参考项目 WorkspaceTab 原样移植:28px 高页签,焦点标签与下方组面板(surface-200)连体——
  // 底部 3px 连接条 + 两侧 radial-gradient 反圆角(TAB_CORNER_R),白色顶内衬制造受光面。
  // 非焦点一律画布色 hover(与旧版一致),不再造"组内胶囊"第三视觉态。
  // 反圆角左右各溢 13px,不论左邻是谁都照画:非焦点标签本身是透明的(只有 hover 才着色),
  // 溢出盖住的是画布而非邻居内容——这就是"面板边缘收束进标签"的那道曲线,少了就成直角台阶。
  const cornerClip = active ? "inset(-2px -15px -2px -15px)" : undefined;
  return (
    <ContextMenu>
      <Tooltip delayDuration={800}>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>
    <button
      type="button"
      draggable
      ref={(node) => {
        // I3:激活标签滚入视野(超过容量收缩下限后靠横向滚动兜底)
        if (node && active) node.scrollIntoView({ inline: "nearest", block: "nearest" });
      }}
      onClick={onActivate}
      onAuxClick={(event) => {
        if (event.button === 1 && closable) onClose();
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        onDragOverTab(event);
      }}
      className={cn("relative shrink-0 select-none pb-[3px]", dragging && "opacity-60")}
      style={{
        width,
        ...(active
          ? {
              filter: "drop-shadow(rgba(0, 0, 0, 0.08) 0px 0px 0.5px)",
              clipPath: cornerClip,
            }
          : undefined),
      }}
    >
      <div
        className={cn(
          "group relative flex h-7 w-full items-center gap-1.5 pl-2.5 pr-1.5 text-compact font-medium transition-colors duration-150",
          active
            ? "rounded-t-[10px] bg-[var(--ds-surface-200)] text-[var(--ds-text-primary)]"
            : "rounded-[10px] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-on-surface)]",
        )}
      >
        <Icon className="size-4 shrink-0" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        {closable ? (
          <span
            role="button"
            aria-label={t("workspace.tabs.close")}
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
            className="flex h-5 w-0 shrink-0 items-center justify-center overflow-hidden rounded-full opacity-0 transition-all duration-150 group-hover:ml-0.5 group-hover:w-5 group-hover:opacity-100 hover:bg-[var(--ds-on-surface)]"
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </span>
        ) : null}
        {active ? (
          <span
            className="pointer-events-none absolute inset-0 rounded-t-[10px]"
            style={{ boxShadow: "inset 0 0.5px 0 0 rgba(255, 255, 255, 0.2)" }}
          />
        ) : null}
      </div>
      {active ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center">
          <div className="h-[3px] flex-1 bg-[var(--ds-surface-200)]" />
          <div
            className="absolute"
            style={{
              left: -TAB_CORNER_R,
              bottom: -2,
              width: TAB_CORNER_R,
              height: TAB_CORNER_R + 2,
              background: `radial-gradient(circle ${TAB_CORNER_R}px at 0 0, transparent ${TAB_CORNER_R - 0.5}px, var(--ds-surface-200) ${TAB_CORNER_R}px)`,
            }}
          />
          <div
            className="absolute"
            style={{
              right: -TAB_CORNER_R,
              bottom: -2,
              width: TAB_CORNER_R,
              height: TAB_CORNER_R + 2,
              background: `radial-gradient(circle ${TAB_CORNER_R}px at 100% 0, transparent ${TAB_CORNER_R - 0.5}px, var(--ds-surface-200) ${TAB_CORNER_R}px)`,
            }}
          />
        </div>
      ) : null}
    </button>
          </ContextMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="max-w-[380px]">
          <div className="font-medium">{label}</div>
          {workspace ? (
            <div className="mt-0.5 font-normal break-all text-[var(--ds-text-secondary)]">
              {workspace.root}
            </div>
          ) : null}
        </TooltipContent>
      </Tooltip>
      <ContextMenuContent className="min-w-44">
        {workspace && onEdit ? (
          <>
            <ContextMenuItem onSelect={onEdit}>
              <Pencil className="size-4" strokeWidth={1.75} />
              {t("workspace.menu.rename")}
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        ) : null}
        {/* L 轮分区模型:键鼠/无障碍等价路径(拖拽是主交互,但不能是唯一交互)。
            本组成员 → "移出分栏"(回幽灵态,标签仍开);其它标签(含幽灵)→
            "分栏到左/右",以本组焦点容器为锚点。 */}
        {unsplitable ? (
          <ContextMenuItem onSelect={onUnsplit}>
            <Columns2 className="size-4" strokeWidth={1.75} />
            {t("workspace.tabs.ctx_unsplit")}
          </ContextMenuItem>
        ) : (
          <>
            <ContextMenuItem disabled={!splitable} onSelect={onSplitLeft}>
              <PanelLeft className="size-4" strokeWidth={1.75} />
              {t("workspace.tabs.ctx_split_left")}
            </ContextMenuItem>
            <ContextMenuItem disabled={!splitable} onSelect={onSplitRight}>
              <PanelRight className="size-4" strokeWidth={1.75} />
              {t("workspace.tabs.ctx_split_right")}
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!closable} onSelect={onClose}>
          {t("workspace.tabs.ctx_close")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasOthers} onSelect={onCloseOthers}>
          {t("workspace.tabs.ctx_close_others")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasRight} onSelect={onCloseRight}>
          {t("workspace.tabs.ctx_close_right")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onCloseAll}>{t("workspace.tabs.ctx_close_all")}</ContextMenuItem>
        {workspace && onReveal ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onReveal}>
              <FolderOpen className="size-4" strokeWidth={1.75} />
              {t("workspace.menu.reveal")}
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
