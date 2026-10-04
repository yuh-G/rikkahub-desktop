import * as React from "react";
import { useTranslation } from "react-i18next";
import { FolderGit2, FolderOpen, FolderSearch, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { EmptyGreeting } from "~/components/empty-greeting";
import { WorkspaceShellNotice } from "~/components/workspace/workspace-shell-notice";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import api from "~/services/api";
import { useWorkspaceStore } from "~/stores/workspace-store";
import { extractErrorMessage } from "~/lib/error";
import type { WorkspaceDto } from "~/types";

// 工作区容器首屏空态(M3-6;前端重构A3 复刻参考项目首页):顶部工作区上下文胶囊 +
// 时段问候大标题 + 示例提示词 chip(点击即填入输入框)。
// folder 型的信任门已在创建流完成首次引导,这里不再二次打扰。
//
// B6-①b:folder 型根目录丢失(status=missing)时,空态改为"警告 + 失效路径 + 重绑表单"——
// 工作区实体与项目文件夹解耦,缺失不等于降级成普通对话;用户在此直接绑定到新文件夹,
// 底下会话原样跟着。重绑后信任门重置(后端 trusted_at 置空),下次激活过信任门。

const EXAMPLE_KEYS = ["example_1", "example_2", "example_3"] as const;

/** folder 型 missing 态的重绑面板:内嵌路径输入 + 浏览,提交 PATCH root。 */
function MissingRebindPanel({ workspace }: { workspace: WorkspaceDto }) {
  const { t } = useTranslation("page");
  const refresh = useWorkspaceStore((state) => state.refresh);
  const [root, setRoot] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  const browse = async () => {
    try {
      const { open: openPicker } = await import("@tauri-apps/plugin-dialog");
      const picked = await openPicker({ directory: true, multiple: false });
      if (typeof picked === "string" && picked) setRoot(picked);
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workspace.create.pick_failed")));
    }
  };

  const submit = async () => {
    const trimmed = root.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await api.patch<{ workspace: WorkspaceDto }>(`workspaces/${workspace.id}`, { root: trimmed });
      await refresh();
      toast.success(t("workspace.menu.rebind") + " ✓");
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workspace.menu.rebind_failed")));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mb-6 flex flex-col items-center">
      <div className="w-full max-w-md rounded-[var(--ds-radius-lg)] border border-warning/30 bg-warning/5 px-4 py-4 text-left">
        <div className="flex items-start gap-2.5">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={2} />
          <div className="min-w-0 flex-1">
            <div className="text-compact font-medium text-foreground">{t("workspace.empty.missing_title")}</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">{t("workspace.empty.missing_desc")}</div>
            <div className="mt-1.5 truncate font-mono text-mini text-[var(--ds-text-tertiary)]" title={workspace.root}>
              {workspace.root}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Input
                value={root}
                onChange={(event) => setRoot(event.target.value)}
                placeholder={t("workspace.create.folder_path_placeholder")}
                className="h-8 flex-1 font-mono text-xs"
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submit();
                }}
              />
              <Button type="button" variant="outline" size="sm" className="h-8 shrink-0" onClick={() => void browse()}>
                <FolderSearch className="mr-1 size-3.5" />
                {t("workspace.create.browse")}
              </Button>
            </div>
            <Button
              type="button"
              size="sm"
              className="mt-2.5 h-8"
              disabled={!root.trim() || submitting}
              onClick={() => void submit()}
            >
              {t("workspace.empty.missing_rebind")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function WorkspaceEmptyState({
  workspace,
  onPrompt,
}: {
  workspace: WorkspaceDto;
  onPrompt: (text: string) => void;
}) {
  const { t } = useTranslation("page");
  const Icon = workspace.type === "folder" ? FolderOpen : FolderGit2;

  // folder 型根目录丢失:不再渲染示例提示词(AI 此时无法读写文件),改呈现重绑面板。
  if (workspace.type === "folder" && workspace.status === "missing") {
    return (
      <div className="mb-6">
        <WorkspaceShellNotice />
        <MissingRebindPanel workspace={workspace} />
      </div>
    );
  }

  return (
    <div className="mb-6 text-center">
      {/* 工作区上下文胶囊:名称 + 类型说明(folder 型 hover 展示真实路径),
          对应参考项目首页大标题上方的提示胶囊位。 */}
      <div className="mb-4 flex justify-center">
        <span
          className="inline-flex max-w-md items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-xs text-muted-foreground"
          title={workspace.type === "folder" && workspace.root ? workspace.root : undefined}
        >
          <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="truncate font-medium text-foreground/80">{workspace.name}</span>
          <span className="shrink-0">
            {workspace.type === "folder"
              ? t("workspace.empty.folder_intro")
              : t("workspace.empty.managed_intro")}
          </span>
        </span>
      </div>
      <WorkspaceShellNotice />
      <EmptyGreeting />
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        {EXAMPLE_KEYS.map((key) => (
          <Button
            key={key}
            type="button"
            variant="outline"
            size="sm"
            className="h-auto rounded-full px-3 py-1.5 font-normal text-muted-foreground text-xs hover:text-foreground"
            onClick={() => onPrompt(t(`workspace.empty.${key}`))}
          >
            {t(`workspace.empty.${key}`)}
          </Button>
        ))}
      </div>
    </div>
  );
}
