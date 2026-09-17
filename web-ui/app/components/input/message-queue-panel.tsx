// components/input/message-queue-panel.tsx — 消息发送队列面板
//
// 生成中补发的消息在此排队(FIFO,服务端权威,经会话 SSE 快照直通)。面板提供
// 编辑/移除/暂停恢复/停止生成;队空不渲染。仅操作服务端队列,本地不持有队列副本——
// 编辑态(editingId/draft)是唯一本地状态,其余一律以 SSE 快照为准。
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Layers, Pause, Pencil, Play, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";

import api from "~/services/api";
import { cn } from "~/lib/utils";
import type { MessageQueueSnapshotDto } from "~/types/dto";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";

interface MessageQueuePanelProps {
  conversationId: string;
  /** 队列快照(后端派生,经会话详情 SSE 到达;队空为 null,本组件不渲染)。 */
  queue: MessageQueueSnapshotDto;
  /** 当前是否在生成(决定「停止生成」键显示与自动续跑语义)。 */
  isGenerating: boolean;
  onStop?: () => Promise<void> | void;
}

export const MessageQueuePanel = React.memo(function MessageQueuePanel({
  conversationId,
  queue,
  isGenerating,
  onStop,
}: MessageQueuePanelProps) {
  const { t } = useTranslation("input");
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const items = queue?.items ?? [];
  const paused = queue?.paused ?? false;

  // 队列被清空/目标项消失(派发走或被别处移除)时,收起悬挂的编辑态。
  React.useEffect(() => {
    if (editingId && !items.some((it) => it.id === editingId)) {
      setEditingId(null);
      setDraft("");
    }
  }, [editingId, items]);

  const run = React.useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("queue.save"));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const startEdit = (id: string, preview: string) => {
    setEditingId(id);
    setDraft(preview);
  };
  const commitEdit = () => {
    if (!editingId) return;
    const text = draft.trim();
    if (!text) {
      toast.info(t("queue.empty_message"));
      return;
    }
    const id = editingId;
    // 编辑契约:面板编辑针对文本正文(队列快照携带的是派生 preview),保存即替换为纯文本消息。
    // 附件项不允许进入编辑(下方按 item.hasAttachments 隐藏编辑键),故此处不会误丢附件。
    void run(async () => {
      await api.post(`conversations/${conversationId}/queue/${encodeURIComponent(id)}`, {
        parts: [{ type: "text", text }],
      });
      setEditingId(null);
      setDraft("");
    });
  };
  const cancelEdit = () => {
    setEditingId(null);
    setDraft("");
  };

  if (!queue || items.length === 0) return null;

  return (
    <div
      className="mb-2 overflow-hidden rounded-2xl border border-border/60 bg-[var(--ds-pill-bg)]/60 shadow-sm backdrop-blur-sm"
      data-testid="message-queue-panel"
    >
      {/* 头部:队列计数 + 全局控制(暂停/恢复 · 停止生成)。 */}
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <Layers className="size-3.5 shrink-0 text-[var(--ds-brand-primary)]" />
        <span className="text-xs font-medium text-foreground">
          {t("queue.count", { count: items.length })}
        </span>
        {paused ? (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
            {t("queue.paused")}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {isGenerating && onStop ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => void onStop()}
                  className="flex size-6 items-center justify-center rounded-md text-destructive transition-colors hover:bg-destructive/10"
                >
                  <Square className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{t("queue.stop_generating")}</TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    api.post(`conversations/${conversationId}/queue/${paused ? "resume" : "pause"}`),
                  )
                }
                className="flex size-6 items-center justify-center rounded-md text-[var(--ds-icon)] transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent>{paused ? t("queue.resume") : t("queue.pause")}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* 列表:严格 FIFO(下标即发送次序),逐项编辑/移除。 */}
      <ul className="max-h-44 overflow-y-auto">
        {items.map((item, index) => {
          const editing = editingId === item.id;
          return (
            <li
              key={item.id}
              className={cn(
                "group flex items-start gap-2.5 px-3 py-2 transition-colors",
                index !== items.length - 1 && "border-b border-border/40",
                !editing && "hover:bg-accent/40",
              )}
            >
              <span className="mt-0.5 w-4 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                {index + 1}
              </span>
              {editing ? (
                <div className="min-w-0 flex-1">
                  <textarea
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        commitEdit();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelEdit();
                      }
                    }}
                    rows={2}
                    className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring/40"
                  />
                  <div className="mt-1.5 flex justify-end gap-1.5">
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={cancelEdit}>
                      {t("queue.cancel")}
                    </Button>
                    <Button size="sm" className="h-6 px-2 text-xs" disabled={busy} onClick={commitEdit}>
                      {t("queue.save")}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm leading-5 text-foreground/90">
                      {item.preview || (
                        <span className="italic text-muted-foreground">{t("queue.attachment")}</span>
                      )}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    {/* 附件项不支持编辑(快照只带文本 preview,编辑契约=替换正文);只能移除。 */}
                    {!item.hasAttachments ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => startEdit(item.id, item.preview)}
                            className="flex size-6 items-center justify-center rounded-md text-[var(--ds-icon)] transition-colors hover:bg-accent hover:text-foreground"
                          >
                            <Pencil className="size-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>{t("queue.edit")}</TooltipContent>
                      </Tooltip>
                    ) : null}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(() =>
                              api.delete(`conversations/${conversationId}/queue/${encodeURIComponent(item.id)}`),
                            )
                          }
                          className="flex size-6 items-center justify-center rounded-md text-[var(--ds-icon)] transition-colors hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{t("queue.remove")}</TooltipContent>
                    </Tooltip>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
});
