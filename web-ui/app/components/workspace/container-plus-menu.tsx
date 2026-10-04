import * as React from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Folder, FolderOpen, FolderSearch, MessageSquare, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { confirmDialog } from "~/stores/confirm-store";
import {
  CreateFolderWorkspaceDialog,
  WorkspaceTrustDialog,
} from "~/components/workspace/workspace-create-dialogs";
import api from "~/services/api";
import { CHAT_CONTAINER, useContainerTabsStore, type ContainerKey } from "~/stores/container-tabs-store";
import { useWorkspaceStore } from "~/stores/workspace-store";
import type { WorkspaceDto } from "~/types";

// "新建容器"入口(一级标签栏行尾):列出已有工作区(行尾悬浮重命名/删除)+ 三类新建。
// 分区模型(L 轮)下每组分栏各有一条一级标签栏,但新建入口只挂在全局焦点组 ——
// 新建出来的容器落在焦点组里,与用户"我正在这一组操作"的直觉一致。

/** 点击/循环切换容器:激活并导航到该容器上次停留的会话(无则回"新对话"首页)。 */
function navigateToContainer(key: ContainerKey, navigate: (to: string) => void) {
  const store = useContainerTabsStore.getState();
  store.activateContainer(key);
  const panes = store.panes[key] ?? [];
  const focused = Math.max(0, Math.min(store.focusedPane[key] ?? 0, panes.length - 1));
  const conversationId = panes[focused]?.active ?? null;
  navigate(conversationId ? `/c/${conversationId}` : "/");
}

export function ContainerPlusMenu() {
  const { t } = useTranslation("page");
  const navigate = useNavigate();
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const refresh = useWorkspaceStore((state) => state.refresh);
  const activeTab = useContainerTabsStore((state) => state.activeTab);
  const [folderDialogOpen, setFolderDialogOpen] = React.useState(false);
  // 信任门目标 + 拒绝语义:创建流拒绝=删除记录;重开已有未信任工作区拒绝=仅关门。
  const [trustTarget, setTrustTarget] = React.useState<{ workspace: WorkspaceDto; fromCreate: boolean } | null>(null);
  // R7 工作区管理:重命名对话框目标 + 输入值(提交 PATCH workspaces/:id)。
  const [renameTarget, setRenameTarget] = React.useState<WorkspaceDto | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [renameSaving, setRenameSaving] = React.useState(false);
  // B6-①b:编辑对话里 folder 型路径可重绑。renameRoot 是编辑中的路径草稿(初始=当前 root)。
  const [renameRoot, setRenameRoot] = React.useState("");

  const createManagedWorkspace = React.useCallback(async () => {
    try {
      const res = await api.post<{ workspace: WorkspaceDto }>("workspaces", { type: "managed" });
      await refresh();
      useContainerTabsStore.getState().openContainer(res.workspace.id);
      navigate("/");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("workspace.create.failed"));
    }
  }, [navigate, refresh, t]);

  // R7:从菜单激活已有工作区——folder 型未信任先过信任门,其余直接开标签并导航。
  const openWorkspaceFromMenu = React.useCallback(
    (workspace: WorkspaceDto) => {
      if (workspace.type === "folder" && workspace.trustedAt == null) {
        setTrustTarget({ workspace, fromCreate: false });
        return;
      }
      useContainerTabsStore.getState().openContainer(workspace.id);
      navigateToContainer(workspace.id, navigate);
    },
    [navigate],
  );

  // 删除仅移除工作区记录与会话索引,不碰磁盘文件(folder 型的真实目录保持原样)。
  const deleteWorkspace = React.useCallback(
    async (workspace: WorkspaceDto) => {
      const ok = await confirmDialog({
        title: t("workspace.menu.delete_confirm_title", { name: workspace.name }),
        description: t("workspace.menu.delete_confirm_desc"),
        danger: true,
      });
      if (!ok) return;
      try {
        await api.delete(`workspaces/${workspace.id}`);
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("workspace.menu.delete_failed"));
      }
    },
    [refresh, t],
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

  const openChatContainer = React.useCallback(() => {
    useContainerTabsStore.getState().openContainer(CHAT_CONTAINER);
    navigateToContainer(CHAT_CONTAINER, navigate);
  }, [navigate]);

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

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("workspace.tabs.new_container")}
            className="mb-[5px] flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--ds-icon)] transition-colors duration-150 hover:bg-[var(--ds-on-surface)] hover:text-foreground"
          >
            <Plus className="size-[18px]" strokeWidth={1.75} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {/* R7:已有工作区列表——点击激活;行尾悬浮出重命名/删除(阻断 item 选中) */}
          {workspaces.length > 0 ? (
            <>
              <DropdownMenuLabel>{t("workspace.menu.existing")}</DropdownMenuLabel>
              {workspaces.map((workspace) => {
                const WsIcon = workspace.type === "folder" ? FolderOpen : Folder;
                return (
                  <DropdownMenuItem
                    key={workspace.id}
                    className="group/ws"
                    data-active={workspace.id === activeTab || undefined}
                    onSelect={() => openWorkspaceFromMenu(workspace)}
                  >
                    <WsIcon className="size-4" strokeWidth={1.75} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-center gap-1.5 truncate">
                        <span className="truncate">{workspace.name}</span>
                        {workspace.status === "missing" ? (
                          <span className="flex shrink-0 items-center gap-0.5 rounded bg-warning/15 px-1 py-px text-micro font-medium text-warning">
                            <TriangleAlert className="size-2.5" strokeWidth={2} />
                            {t("workspace.menu.missing_badge")}
                          </span>
                        ) : null}
                      </span>
                      <span className="truncate text-mini leading-4 text-[var(--ds-text-tertiary)]">
                        {workspace.root}
                      </span>
                    </span>
                    <span
                      className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/ws:opacity-100"
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="flex size-6 items-center justify-center rounded-full text-[var(--ds-icon)] hover:bg-[var(--ds-on-surface-active)] hover:text-foreground"
                            onClick={() => openEditDialog(workspace)}
                          >
                            <Pencil className="size-3.5" strokeWidth={1.75} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>{t("workspace.menu.rename")}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="flex size-6 items-center justify-center rounded-full text-[var(--ds-icon)] hover:bg-[var(--ds-on-surface-active)] hover:text-destructive"
                            onClick={() => void deleteWorkspace(workspace)}
                          >
                            <Trash2 className="size-3.5" strokeWidth={1.75} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>{t("workspace.menu.delete")}</TooltipContent>
                      </Tooltip>
                    </span>
                  </DropdownMenuItem>
                );
              })}
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem onSelect={() => void createManagedWorkspace()}>
            <Folder className="size-4" />
            <div className="min-w-0">
              <div className="text-sm">{t("workspace.create.managed")}</div>
              <div className="truncate text-xs text-muted-foreground">
                {t("workspace.create.managed_hint")}
              </div>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setFolderDialogOpen(true)}>
            <FolderOpen className="size-4" />
            <div className="min-w-0">
              <div className="text-sm">{t("workspace.create.folder")}</div>
              <div className="truncate text-xs text-muted-foreground">
                {t("workspace.create.folder_hint")}
              </div>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={openChatContainer}>
            <MessageSquare className="size-4" />
            <div className="min-w-0">
              <div className="text-sm">{t("workspace.create.chat")}</div>
              <div className="truncate text-xs text-muted-foreground">
                {t("workspace.create.chat_hint")}
              </div>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

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
    </>
  );
}
