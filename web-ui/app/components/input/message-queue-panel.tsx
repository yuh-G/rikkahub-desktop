// components/input/message-queue-panel.tsx — 消息发送队列预览
//
// 形态(Codex `PendingInputPreview` 同构):嵌在输入框卡片内部顶端的轻量预览行,与输入框
// 共享同一张卡的宽度/圆角/阴影——视觉上是「输入框长出来的一截」,而不是横贯对话区的独立
// 横幅(旧形态满宽横幅把界面左右占满,与消息列宽度不一致)。
//
// 操作语义(用户反馈「暂停/终止让人疑惑」后重定):
//   - 排队项只有两个动作:改(就地编辑正文)、撤(移出队列)。这是用户对「我刚补的那句话」
//     唯一会有的两种意图。
//   - 不提供手动「暂停队列」:排队即「当前回复结束后自动依次发送」,一句话说得清;要停就撤。
//   - 不提供「终止生成」:那是输入框右下角发送键在空输入时的职责(红色停止钮),同一动作
//     不该有两个入口。
//   - 「已暂停」仍会出现,但只作为失败后的状态提示 + 一键「继续发送」——它是错误恢复,
//     不是常规操作(服务端在生成失败时自动暂停,保住剩余排队项不被连带丢弃)。
//
// 数据面不变:服务端权威,经会话 SSE 快照直通;本地只持有编辑态。
import * as React from "react";
import { useTranslation } from "react-i18next";
import { CornerDownRight, Pencil, Play, Trash2, TriangleAlert } from "lucide-react";
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
}

export const MessageQueuePanel = React.memo(function MessageQueuePanel({
  conversationId,
  queue,
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
    <div className="flex flex-col gap-0.5" data-testid="message-queue-panel">
      {/* 状态行:常态一句话说清排队语义;暂停(=上一条失败)才升格为警示 + 继续按钮。 */}
      {paused ? (
        <div className="flex items-center gap-1.5 px-1 text-mini text-amber-600 dark:text-amber-400">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t("queue.paused_hint")}</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={busy}
            className="h-5 shrink-0 gap-1 px-1.5 text-mini text-amber-600 hover:text-amber-700 dark:text-amber-400"
            onClick={() => void run(() => api.post(`conversations/${conversationId}/queue/resume`))}
          >
            <Play className="size-3" />
            {t("queue.resume")}
          </Button>
        </div>
      ) : (
        <div className="px-1 text-mini text-muted-foreground/80">
          {t("queue.hint", { count: items.length })}
        </div>
      )}

      {/* 列表:严格 FIFO(下标即发送次序)。单条时不显序号——没有次序歧义时序号是噪音。 */}
      <ul className="flex max-h-32 flex-col overflow-y-auto">
        {items.map((item, index) => {
          const editing = editingId === item.id;
          return (
            <li
              key={item.id}
              className={cn(
                "group flex items-start gap-1.5 rounded-lg px-1 py-1 transition-colors",
                !editing && "hover:bg-[var(--ds-on-surface)]",
              )}
            >
              <CornerDownRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60" />
              {items.length > 1 ? (
                <span className="mt-px w-3 shrink-0 text-right text-mini tabular-nums text-muted-foreground/60">
                  {index + 1}
                </span>
              ) : null}
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
                    className="w-full resize-none rounded-md border border-border bg-background px-2 py-1 text-compact outline-none focus:ring-2 focus:ring-ring/40"
                  />
                  <div className="mt-1 flex justify-end gap-1">
                    <Button size="xs" variant="ghost" className="text-mini" onClick={cancelEdit}>
                      {t("queue.cancel")}
                    </Button>
                    <Button size="xs" className="text-mini" disabled={busy} onClick={commitEdit}>
                      {t("queue.save")}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="min-w-0 flex-1 truncate text-compact leading-5 text-muted-foreground">
                    {item.preview || (
                      <span className="italic">{t("queue.attachment")}</span>
                    )}
                  </p>
                  {/* 动作只在悬停显示(常态是安静的预览);触屏/键盘经 focus-within 也能露出。 */}
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    {/* 附件项不支持编辑(快照只带文本 preview,编辑契约=替换正文);只能撤回。 */}
                    {!item.hasAttachments ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => startEdit(item.id, item.preview)}
                            className="flex size-5 items-center justify-center rounded text-[var(--ds-icon)] transition-colors hover:bg-accent hover:text-foreground"
                          >
                            <Pencil className="size-3" />
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
                          className="flex size-5 items-center justify-center rounded text-[var(--ds-icon)] transition-colors hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="size-3" />
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
