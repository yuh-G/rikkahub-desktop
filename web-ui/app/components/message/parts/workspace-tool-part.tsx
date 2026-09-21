import * as React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react";
import {
  Check,
  ChevronDown,
  CircleCheck,
  CircleX,
  FilePen,
  FilePlus2,
  FileText,
  Loader2,
  Maximize2,
  SquareTerminal,
  X,
} from "lucide-react";

import { DetailDrawer } from "~/components/detail-drawer";
import { DenyReasonDialog } from "~/components/message/deny-reason-dialog";
import { Button } from "~/components/ui/button";
import { CopyButton } from "~/components/ui/copy-button";
import { DiffView, parseDiffStats } from "~/components/workspace/diff-view";
import { TerminalOutput } from "~/components/workspace/terminal-output";
import { useToolElapsedSeconds } from "~/hooks/use-elapsed-since";
import { cn } from "~/lib/utils";
import {
  buildWorkspaceActionModel,
  numField as num,
  parseArgs,
  strField as str,
  workspaceDetails,
  workspaceToolKind,
  type WorkspaceActionModel,
} from "~/lib/workspace-tool-model";
import type { ToolPart as UIToolPart } from "~/types";

import { ControlledChainOfThoughtStep } from "../chain-of-thought";

// 工作区工具渲染器(M2-3,方案 §4.3;2026-09-05 抽屉合并修订)。可见性分层:
// - read(只读侦察)留在思维链折叠组(tool-part.tsx 只借本模块的标题/图标);
// - write/edit/bash 运行中/成功:思维链折叠组内的动作步骤(WorkspaceActionStep),
//   连续调用共享一张大卡,靠滑动窗口收敛纵向空间;
// - write/edit/bash 终局失败(被拒/错误/非零退出):由 message-part.tsx 抽出为
//   顶层动作卡(WorkspaceActionCard),红色状态常驻——"抽出"=需要用户注意。
// 渲染 100% 由 part 数据驱动(input/output/metadata.workspace),无前端私有状态;
// 纯数据模型(kind 注册表/args/details 抽取/失败判定)在 lib/workspace-tool-model.ts。

/** read 徽标文案:offset/limit 存在时标注读取窗口。 */
export function readRangeBadge(args: Record<string, unknown>, t: TFunction): string | null {
  const offset = num(args, "offset");
  const limit = num(args, "limit");
  if (offset !== undefined && limit !== undefined) return t("workspace_tool.read_range_both", { offset, limit });
  if (offset !== undefined) return t("workspace_tool.read_range_offset", { offset });
  if (limit !== undefined) return t("workspace_tool.read_range_limit", { limit });
  return null;
}

/** 兜底检索工具(grep/find/ls,bash 不可用时挂载,恒只读)的步骤标题;
 *  不注册进 KIND_BY_TOOL_NAME——它们与 read 同属侦察类,留在思维链折叠组,
 *  只需要标题/图标定制(tool-part.tsx 调用)。非这三个工具返回 null。 */
export function workspaceReconTitle(toolName: string, input: string, t: TFunction): string | null {
  if (toolName === "grep") {
    const pattern = str(parseArgs(input), "pattern") ?? "";
    return pattern ? t("workspace_tool.grep_title", { pattern }) : t("workspace_tool.grep");
  }
  if (toolName === "find") {
    const pattern = str(parseArgs(input), "pattern") ?? "";
    return pattern ? t("workspace_tool.find_title", { pattern }) : t("workspace_tool.find");
  }
  if (toolName === "ls") {
    const path = str(parseArgs(input), "path") ?? ".";
    return t("workspace_tool.ls_title", { path });
  }
  return null;
}

/** 思维链折叠组里 read 步骤的标题(tool-part.tsx getToolTitle 调用)。 */
export function workspaceReadTitle(toolName: string, input: string, t: TFunction): string | null {
  if (workspaceToolKind(toolName) !== "read") return null;
  const args = parseArgs(input);
  const path = str(args, "path") ?? "";
  const range = readRangeBadge(args, t);
  const base = path ? t("workspace_tool.read_title", { path }) : t("workspace_tool.read");
  return range ? `${base} (${range})` : base;
}

/** 导出图/分享的工具卡可读标签(§9.8:至少 $ 命令与 diff 摘要)。 */
export function workspaceToolExportLabel(tool: UIToolPart, t: TFunction): string | null {
  const kind = workspaceToolKind(tool.toolName);
  if (!kind) return null;
  const args = parseArgs(tool.input);
  if (kind === "read") return workspaceReadTitle(tool.toolName, tool.input, t);
  if (kind === "bash") return `$ ${str(args, "command") ?? ""}`.trim();
  const path = str(args, "path") ?? "";
  if (kind === "write") return path ? t("workspace_tool.write_title_with_path", { path }) : t("workspace_tool.write_title");
  const details = workspaceDetails(tool);
  const diff = details && typeof details.diff === "string" ? details.diff : "";
  const stats = diff ? parseDiffStats(diff) : null;
  const base = path ? t("workspace_tool.edit_title_with_path", { path }) : t("workspace_tool.edit_title");
  return stats ? `${base} (+${stats.added} -${stats.removed})` : base;
}

// ===== 动作卡/动作步骤共享的视图模型(同一动作两种容器,派生值必须同源) =====

interface WorkspaceActionView {
  t: TFunction;
  model: WorkspaceActionModel;
  running: boolean;
  elapsedSeconds: number | null;
  expanded: boolean;
  setUserExpanded: (next: boolean) => void;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  path: string;
  command: string;
  diff: string;
  patch: string;
  stats: ReturnType<typeof parseDiffStats> | null;
  writtenBytes: number | null;
  title: string;
  TitleIcon: LucideIcon;
}

function useWorkspaceActionView(
  tool: UIToolPart,
  loading: boolean | undefined,
  messageCreatedAt?: string,
  messageFinishedAt?: string | null,
): WorkspaceActionView {
  const { t } = useTranslation("message");
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  const model = React.useMemo(() => buildWorkspaceActionModel(tool), [tool]);
  const running = Boolean(loading) && !model.finished;
  // 域3-1:运行耗时。起点=工具卡自己的建卡戳(终局戳=结果落地,issue #59:不再随
  // 整条消息的流式墙钟涨),无戳的历史数据回退消息级 createdAt→finishedAt 旧口径。
  // live=running(消息级 loading,不带 output 门——bash 流式中已有输出仍在跑)。
  const elapsedSeconds = useToolElapsedSeconds(tool, messageCreatedAt, messageFinishedAt, running);
  // 自动折叠(2.0.0 内测,与思维链一致):执行中保持展开,终局后自动收起,压住长会话
  // 纵向空间;历史消息挂载时 running=false 直接收起。用户点过 chevron 后(userExpanded
  // 非 null)以用户选择为准,不再自动干预。
  const [userExpanded, setUserExpanded] = React.useState<boolean | null>(null);
  const expanded = userExpanded ?? running;

  const path = str(model.args, "path") ?? "";
  const command = str(model.args, "command") ?? "";
  const diff = model.details && typeof model.details.diff === "string" ? model.details.diff : "";
  const patch = model.details && typeof model.details.patch === "string" ? (model.details.patch as string) : "";
  const stats = React.useMemo(() => (diff ? parseDiffStats(diff) : null), [diff]);
  const writtenBytes = React.useMemo(() => {
    const match = model.text.match(/Successfully wrote (\d+) bytes/);
    return match ? Number(match[1]) : null;
  }, [model.text]);

  // H7:标题遵循全应用"工具名:操作对象"规则(同 联网搜索:词 / 加载技能:名)。
  const title =
    model.kind === "bash"
      ? command
      : path
        ? t(
            model.kind === "write"
              ? "workspace_tool.write_title_with_path"
              : "workspace_tool.edit_title_with_path",
            { path },
          )
        : model.kind === "write"
          ? t("workspace_tool.write_title")
          : t("workspace_tool.edit_title");
  const TitleIcon = model.kind === "bash" ? SquareTerminal : model.kind === "write" ? FilePlus2 : FilePen;

  return {
    t,
    model,
    running,
    elapsedSeconds,
    expanded,
    setUserExpanded,
    drawerOpen,
    setDrawerOpen,
    path,
    command,
    diff,
    patch,
    stats,
    writtenBytes,
    title,
    TitleIcon,
  };
}

/** 展开区正文(卡/步骤共用):denied/error 分支仅失败卡可达(失败即抽出,不进链)。 */
function WorkspaceActionBody({ view }: { view: WorkspaceActionView }) {
  const { t, model, running, diff } = view;
  if (model.denied) {
    return (
      <div className="px-3 py-2 text-xs text-destructive">
        {model.deniedReason
          ? t("tool_part.denied_with_reason", { reason: model.deniedReason })
          : t("tool_part.denied")}
      </div>
    );
  }
  if (model.error !== null) {
    return (
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-xs text-destructive">
        {model.error}
      </pre>
    );
  }
  if (model.kind === "edit") return <DiffView diff={diff} />;
  if (model.kind === "bash") {
    return model.text || running ? (
      <TerminalOutput text={model.text} running={running} />
    ) : (
      <div className="px-3 py-2 text-xs text-muted-foreground">{t("workspace_tool.no_output")}</div>
    );
  }
  return <WriteBodyPreview content={str(model.args, "content") ?? ""} t={t} />;
}

/** 全量详情抽屉(卡/步骤共用):参数/DiffView/写入正文/结果/错误/patch。 */
function WorkspaceActionDrawer({ view, toolName }: { view: WorkspaceActionView; toolName: string }) {
  const { t, model, drawerOpen, setDrawerOpen, path, command, diff, patch, title } = view;
  const writeContent = model.kind === "write" ? (str(model.args, "content") ?? "") : null;
  return (
    <DetailDrawer
      open={drawerOpen}
      onOpenChange={setDrawerOpen}
      title={model.kind === "bash" ? `$ ${command}` : title}
      description={t("tool_part.tool_name_label", { toolName })}
    >
      <div className="space-y-4">
        {model.kind !== "bash" && path ? (
          <div className="break-all font-mono text-xs text-muted-foreground">{path}</div>
        ) : null}
        {model.kind === "edit" && diff ? <DiffView diff={diff} className="rounded-md border" /> : null}
        {writeContent !== null ? (
          <div className="group/drawer-pre relative">
            <pre className="overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/20 p-3 font-mono text-xs">
              {writeContent}
            </pre>
            <CopyButton
              text={writeContent}
              label={t("tool_part.copy")}
              copiedLabel={t("tool_part.copied")}
              className="absolute right-1.5 top-1.5 bg-background/80 opacity-0 shadow-sm backdrop-blur transition-opacity group-hover/drawer-pre:opacity-100"
            />
          </div>
        ) : null}
        {model.text ? (
          <div>
            <div className="mb-1 text-xs text-muted-foreground">{t("tool_part.result")}</div>
            <div className="group/drawer-pre relative">
              <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/20 p-3 font-mono text-xs">
                {model.text}
              </pre>
              <CopyButton
                text={model.text}
                label={t("tool_part.copy")}
                copiedLabel={t("tool_part.copied")}
                className="absolute right-1.5 top-1.5 bg-background/80 opacity-0 shadow-sm backdrop-blur transition-opacity group-hover/drawer-pre:opacity-100"
              />
            </div>
          </div>
        ) : null}
        {model.error !== null ? (
          <pre className="overflow-auto whitespace-pre-wrap break-all rounded-md border border-destructive/30 bg-destructive/5 p-3 font-mono text-xs text-destructive">
            {model.error}
          </pre>
        ) : null}
        {patch ? (
          <div>
            <div className="mb-1 text-xs text-muted-foreground">{t("workspace_tool.patch")}</div>
            <div className="group/drawer-pre relative">
              <pre className="max-h-64 overflow-auto whitespace-pre rounded-md border bg-muted/20 p-3 font-mono text-xs">
                {patch}
              </pre>
              <CopyButton
                text={patch}
                label={t("tool_part.copy")}
                copiedLabel={t("tool_part.copied")}
                className="absolute right-1.5 top-1.5 bg-background/80 opacity-0 shadow-sm backdrop-blur transition-opacity group-hover/drawer-pre:opacity-100"
              />
            </div>
          </div>
        ) : null}
      </div>
    </DetailDrawer>
  );
}

/** 详情入口(卡/步骤头部共用):停止冒泡,不触发行开合。 */
function OpenDetailsButton({ view }: { view: WorkspaceActionView }) {
  return (
    <span
      role="button"
      aria-label={view.t("workspace_tool.open_details")}
      onClick={(event) => {
        event.stopPropagation();
        view.setDrawerOpen(true);
      }}
      className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors duration-150 hover:bg-muted hover:text-foreground"
    >
      <Maximize2 className="size-3" />
    </span>
  );
}

/** 耗时徽章(域3-1):与思维链"思考了 xx 秒"同一枚小字徽章,tabular-nums 防数字抖动。 */
export function ElapsedBadge({ seconds, running }: { seconds: number; running: boolean }) {
  const { t } = useTranslation("message");
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 font-mono text-mini tabular-nums",
        running ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
      )}
    >
      {t(running ? "message_parts.elapsed_running_seconds" : "message_parts.elapsed_done_seconds", { seconds })}
    </span>
  );
}

function ActionStatBadges({ view }: { view: WorkspaceActionView }) {
  const { t, stats, writtenBytes, elapsedSeconds, running } = view;
  return (
    <>
      {stats ? (
        <span className="shrink-0 font-mono text-xs">
          <span className="text-[oklch(0.5_0.12_150)] dark:text-[oklch(0.75_0.12_150)]">+{stats.added}</span>{" "}
          <span className="text-[oklch(0.5_0.14_25)] dark:text-[oklch(0.75_0.14_25)]">-{stats.removed}</span>
        </span>
      ) : null}
      {writtenBytes !== null ? (
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-mini text-muted-foreground">
          {t("workspace_tool.bytes", { bytes: writtenBytes })}
        </span>
      ) : null}
      {elapsedSeconds !== null ? <ElapsedBadge seconds={elapsedSeconds} running={running} /> : null}
    </>
  );
}

// ===== 顶层动作卡(抽屉合并修订后仅终局失败的动作到达;红色状态常驻,收起也可见) =====

const WRITE_PREVIEW_LINES = 12;

export function WorkspaceActionCard({
  tool,
  loading,
  messageCreatedAt,
  messageFinishedAt,
}: {
  tool: UIToolPart;
  loading?: boolean;
  messageCreatedAt?: string;
  messageFinishedAt?: string | null;
}) {
  const view = useWorkspaceActionView(tool, loading, messageCreatedAt, messageFinishedAt);
  const { t, model, running, expanded, setUserExpanded, title, TitleIcon } = view;

  const statusIcon = running ? (
    <Loader2 className="size-4 animate-spin text-primary" />
  ) : model.failed ? (
    <CircleX className="size-4 text-[oklch(0.55_0.18_25)] dark:text-[oklch(0.7_0.16_25)]" />
  ) : (
    <CircleCheck className="size-4 text-[oklch(0.55_0.14_150)] dark:text-[oklch(0.72_0.13_150)]" />
  );

  return (
    <>
      <div className="relative my-2 overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm">
        {/* 运行中:左侧细进度条脉动(方案 §4.3);完成后收敛为头部图标状态 */}
        {running ? <span className="absolute inset-y-0 left-0 w-0.5 animate-pulse bg-primary" aria-hidden /> : null}
        <button
          type="button"
          onClick={() => setUserExpanded(!expanded)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors duration-150 hover:bg-muted/40"
        >
          <span className="shrink-0">{statusIcon}</span>
          <TitleIcon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {model.kind === "bash" ? (
              <>
                {t("workspace_tool.bash_prefix")}
                <span className="font-mono text-compact font-normal">{title}</span>
              </>
            ) : (
              title
            )}
          </span>
          <ActionStatBadges view={view} />
          {model.exitCode !== null ? (
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 font-mono text-mini",
                model.exitCode === 0
                  ? "bg-muted text-muted-foreground"
                  : "bg-[oklch(0.95_0.05_25)] text-[oklch(0.5_0.14_25)] dark:bg-[oklch(0.3_0.05_25)] dark:text-[oklch(0.75_0.14_25)]",
              )}
            >
              exit {model.exitCode}
            </span>
          ) : null}
          <OpenDetailsButton view={view} />
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-200",
              !expanded && "-rotate-90",
            )}
          />
        </button>

        {expanded ? (
          <div className="border-t border-border/50">
            <WorkspaceActionBody view={view} />
          </div>
        ) : null}
      </div>

      <WorkspaceActionDrawer view={view} toolName={tool.toolName} />
    </>
  );
}

// ===== 思维链折叠组内的动作步骤(运行中/成功;失败由分组层抽出成顶层卡) =====

/** 与动作卡同一视图模型:行=类型图标+标题+diff/bytes 徽标+详情入口;行点击开合
 *  内容区(edit=DiffView/bash=实时终端/write=正文预览)。自动开合与动作卡一致:
 *  运行中展开(链尾实时可见),终局自动收起,用户点过以用户选择为准。 */
export function WorkspaceActionStep({
  tool,
  loading,
  messageCreatedAt,
  messageFinishedAt,
  isFirst,
  isLast,
}: {
  tool: UIToolPart;
  loading?: boolean;
  messageCreatedAt?: string;
  messageFinishedAt?: string | null;
  isFirst?: boolean;
  isLast?: boolean;
}) {
  const view = useWorkspaceActionView(tool, loading, messageCreatedAt, messageFinishedAt);
  const { t, model, running, expanded, setUserExpanded, title, TitleIcon } = view;

  const hasBody =
    model.kind === "bash"
      ? Boolean(model.text) || running
      : model.kind === "edit"
        ? Boolean(view.diff)
        : Boolean(str(model.args, "content"));

  return (
    <>
      <ControlledChainOfThoughtStep
        expanded={expanded}
        onExpandedChange={setUserExpanded}
        isFirst={isFirst}
        isLast={isLast}
        active={running}
        icon={
          running ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : (
            <TitleIcon className="h-4 w-4 text-primary" />
          )
        }
        label={
          model.kind === "bash" ? (
            <span className="text-foreground line-clamp-2 text-sm font-medium">
              {t("workspace_tool.bash_prefix")}
              <span className="font-mono text-compact font-normal">{title}</span>
            </span>
          ) : (
            <span className="text-foreground line-clamp-2 text-sm font-medium">{title}</span>
          )
        }
        extra={
          <span className="flex shrink-0 items-center gap-2">
            <ActionStatBadges view={view} />
            <OpenDetailsButton view={view} />
          </span>
        }
      >
        {hasBody ? (
          <div className="overflow-hidden rounded-lg border border-border/50 bg-card">
            <WorkspaceActionBody view={view} />
          </div>
        ) : null}
      </ControlledChainOfThoughtStep>

      <WorkspaceActionDrawer view={view} toolName={tool.toolName} />
    </>
  );
}

function WriteBodyPreview({ content, t }: { content: string; t: TFunction }) {
  const { preview, hidden } = React.useMemo(() => {
    const lines = content.split("\n");
    if (lines.length <= WRITE_PREVIEW_LINES) return { preview: content, hidden: 0 };
    return { preview: lines.slice(0, WRITE_PREVIEW_LINES).join("\n"), hidden: lines.length - WRITE_PREVIEW_LINES };
  }, [content]);
  if (!content) return <div className="px-3 py-2 text-xs text-muted-foreground">{t("workspace_tool.no_output")}</div>;
  return (
    <div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-xs leading-5 text-foreground/90">
        {preview}
      </pre>
      {hidden > 0 ? (
        <div className="border-t border-border/40 bg-muted/30 px-3 py-1 text-mini text-muted-foreground">
          {t("workspace_tool.write_preview_more", { count: hidden })}
        </div>
      ) : null}
    </div>
  );
}

// ===== 审批卡片(琥珀色左边条,完整展示将执行的命令/写入路径,方案 §4.3) =====

export function WorkspaceApprovalCard({
  tool,
  onToolApproval,
}: {
  tool: UIToolPart;
  onToolApproval?: (
    toolCallId: string,
    approved: boolean,
    reason: string,
    answer?: string,
  ) => void | Promise<void>;
}) {
  const { t } = useTranslation("message");
  const kind = workspaceToolKind(tool.toolName) ?? "bash";
  const args = React.useMemo(() => parseArgs(tool.input), [tool.input]);
  const command = str(args, "command");
  const path = str(args, "path");
  // 审批缘由(后端 workspace/approval.ts 终局判定给出:危险命令说明/区外写入目标)。
  // "默认权限"档下用户只会在不安全操作时见到审批卡,必须告诉他为什么被拦。
  const pendingReason = tool.approvalState.type === "pending" ? (tool.approvalState.reason ?? "") : "";

  // 域4-2(3E):拒绝改走应用内 Dialog,理由可空;理由回传链路(denied approvalState.reason
  //  → 模型)不变。open 状态挂在卡片上,onConfirm 收到理由才真正下发 denied。
  const [denyDialogOpen, setDenyDialogOpen] = React.useState(false);

  const handleApprove = async () => {
    if (!onToolApproval) return;
    await onToolApproval(tool.toolCallId, true, "");
  };
  const handleDenyConfirm = async (reason: string) => {
    if (!onToolApproval) return;
    await onToolApproval(tool.toolCallId, false, reason);
  };

  return (
    <div
      className="my-2 overflow-hidden rounded-xl border border-warning/30 border-l-4 border-l-warning bg-warning/5 shadow-sm"
      role="region"
      aria-live="polite"
    >
      <div className="flex items-start gap-2.5 px-4 pt-3">
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning">
          {kind === "bash" ? (
            <SquareTerminal className="size-4" />
          ) : kind === "read" ? (
            <FileText className="size-4" />
          ) : (
            <FilePen className="size-4" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">
              {t(`workspace_tool.approval_${kind}`)}
            </span>
            <span className="size-1.5 animate-pulse rounded-full bg-warning" aria-hidden />
          </div>
          <p className="text-xs text-muted-foreground">{t("workspace_tool.approval_hint")}</p>
          {pendingReason ? (
            <p className="break-all text-xs font-medium text-warning">
              {t("workspace_tool.approval_reason", { reason: pendingReason })}
            </p>
          ) : null}
        </div>
      </div>

      {/* 完整展示将执行的命令/路径:审批决策必须基于完整信息,不截断关键载荷 */}
      <pre className="mx-4 mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/50 bg-background/70 px-3 py-2 font-mono text-xs">
        {kind === "bash" ? `$ ${command ?? ""}` : (path ?? "")}
      </pre>

      <div className="flex justify-end gap-2 px-4 py-3">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setDenyDialogOpen(true)}
          disabled={!onToolApproval}
        >
          <X className="mr-1.5 size-3.5" />
          {t("tool_part.pending_deny")}
        </Button>
        <Button size="sm" onClick={handleApprove} disabled={!onToolApproval}>
          <Check className="mr-1.5 size-3.5" />
          {t("tool_part.pending_approve")}
        </Button>
      </div>

      <DenyReasonDialog
        open={denyDialogOpen}
        onOpenChange={setDenyDialogOpen}
        onConfirm={(reason) => void handleDenyConfirm(reason)}
      />
    </div>
  );
}
