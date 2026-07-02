import React from "react";
import { useTranslation } from "react-i18next";
import { Bot, Globe, MessageSquare, Sparkles, Trash2 } from "lucide-react";

import api from "~/services/api";
import { useMemoryStore, useSettingsStore } from "~/stores";
import type { PendingEntry } from "~/types";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { cn } from "~/lib/utils";

// 单条 pending:元信息一行(弱) + 可编辑内容(主) + 两主一次的动作区。
// "存为助手"依赖入队时的 assistantId 快照(可能不是当前会话助手),后端按 pendingId 定位。
// 该助手已删除(I2)时"存为助手"灰掉——避免存出挂在"未知助手"下的孤儿记忆。
function PendingCard({ entry, globalEnabled, assistantExists }: {
  entry: PendingEntry;
  globalEnabled: boolean;
  assistantExists: boolean;
}) {
  const { t } = useTranslation();
  const [content, setContent] = React.useState(entry.content);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => setContent(entry.content), [entry.content]);

  const resolve = async (action: "global" | "assistant" | "discard") => {
    if (busy) return;
    setBusy(true);
    try {
      await api.post(`memory/pending/${entry.pendingId}`, { action, content: content.trim() });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="group rounded-xl border bg-card p-3 shadow-float transition-shadow hover:shadow-card">
      {/* 可编辑内容(主体):无边框贴底,像便签,聚焦时才描边 */}
      <Textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={2}
        className="min-h-0 resize-none border-0 bg-transparent p-0 text-sm leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent"
      />

      {/* 元信息:助手 · 来源会话 · 时间,单行弱化 */}
      <div className="mt-2 flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
        <Bot className="size-3 shrink-0" />
        <span className="shrink-0">{entry.assistantName}</span>
        {entry.conversationTitle && (
          <>
            <span className="text-muted-foreground/40">·</span>
            <MessageSquare className="size-3 shrink-0" />
            <span className="min-w-0 truncate" title={entry.conversationTitle}>
              {entry.conversationTitle}
            </span>
          </>
        )}
      </div>

      {/* 动作区:两主一次。长文案有足够横向空间,不溢出。 */}
      <div className="mt-2.5 flex items-center gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="h-8 flex-1"
          disabled={!globalEnabled || busy}
          onClick={() => void resolve("global")}
        >
          <Globe className="size-3.5" />
          {t("message:memory.save_global")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 flex-1"
          disabled={!assistantExists || busy}
          title={!assistantExists ? t("message:memory.save_assistant_disabled") : undefined}
          onClick={() => void resolve("assistant")}
        >
          <Bot className="size-3.5" />
          {t("message:memory.save_assistant")}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
          disabled={busy}
          title={t("message:memory.discard")}
          onClick={() => void resolve("discard")}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

/**
 * 会话页待确认记忆提醒。挂在输入框卡片右上角外沿,像现代应用的消息提醒。
 * 软胶囊卡片(白底 + 微阴影 + Sparkles + "N 条待确认"),信息明确又克制。
 * pendingCount > 0 时显示;点击弹出居中 Dialog(批量 + 逐条处理)。
 * 数据来自 memory SSE store,处理后后端 broadcast,store 自动刷新。
 */
export function MemoryBadge() {
  const { t } = useTranslation();
  const snapshot = useMemoryStore((s) => s.snapshot);
  const assistants = useSettingsStore((s) => s.settings?.assistants ?? []);
  const [open, setOpen] = React.useState(false);
  // 新增待确认时外圈光晕扩散(ping)~5s 后停,平时安静。仅追踪增加(减少 = 用户已处理)。
  const prevCount = React.useRef(snapshot?.pendingCount ?? 0);
  const [pulse, setPulse] = React.useState(false);
  React.useEffect(() => {
    const cur = snapshot?.pendingCount ?? 0;
    if (cur > prevCount.current) {
      setPulse(true);
      const timer = setTimeout(() => setPulse(false), 5000);
      prevCount.current = cur;
      return () => clearTimeout(timer);
    }
    prevCount.current = cur;
  }, [snapshot?.pendingCount]);

  if (!snapshot || snapshot.pendingCount === 0) return null;
  const globalEnabled = snapshot.globalEnabled;
  const assistantIds = new Set(assistants.map((a) => a.id));

  const batch = async (action: "global" | "assistant" | "discard") => {
    const items = snapshot.pending.map((p) => ({ pendingId: p.pendingId, action }));
    await api.post("memory/pending/batch", { items });
  };

  return (
    <>
      {/* 软胶囊提醒:白底 + 微阴影,新增时外圈光晕扩散一次。 */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t("message:memory.pending_tooltip", { n: snapshot.pendingCount })}
        className={cn(
          // 品牌色系软胶囊:淡品牌底 + 品牌描边 + 品牌文字,是工具栏区域里唯一带色的元素,
          // 天然吸睛保证不被忽略;但半透明淡底而非实心,仍然克制。
          "relative inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 py-1 pl-2 pr-2.5 text-xs font-semibold text-primary shadow-card backdrop-blur-sm transition-all hover:-translate-y-px hover:bg-primary/15 hover:shadow-elevated",
        )}
      >
        {/* 新增时:外圈光晕扩散一次(~5s)。平时:图标常驻轻微呼吸,保证任何时候瞥到都能注意到。 */}
        {pulse && (
          <span className="absolute -inset-1 animate-ping rounded-full bg-primary/25" aria-hidden />
        )}
        <span className="relative flex size-3.5 items-center justify-center">
          <Sparkles className={cn("size-3.5", !pulse && "animate-pulse")} />
        </span>
        <span className="leading-none">
          {t("message:memory.pending_tooltip", { n: snapshot.pendingCount })}
        </span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg gap-0 p-0">
          <DialogHeader className="space-y-1 border-b px-5 py-4">
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              {t("message:memory.pending_title")}
            </DialogTitle>
            <DialogDescription>
              {t("message:memory.pending_subtitle", { n: snapshot.pendingCount })}
            </DialogDescription>
          </DialogHeader>

          {/* 批量操作条:三个带图标的 ghost 按钮铺满一行,轻量,与逐条动作区分开。 */}
          <div className="flex items-center gap-1.5 border-b bg-muted/30 px-4 py-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-8 flex-1 text-xs text-muted-foreground hover:text-foreground"
              disabled={!globalEnabled}
              onClick={() => void batch("global")}
            >
              <Globe className="size-3.5" />
              {t("message:memory.batch_global")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 flex-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => void batch("assistant")}
            >
              <Bot className="size-3.5" />
              {t("message:memory.batch_assistant")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 flex-1 text-xs text-muted-foreground hover:text-destructive"
              onClick={() => void batch("discard")}
            >
              <Trash2 className="size-3.5" />
              {t("message:memory.batch_discard")}
            </Button>
          </div>

          {/* 逐条列表 */}
          <div className="max-h-[52vh] space-y-2.5 overflow-y-auto px-5 py-4">
            {snapshot.pending.map((p) => (
              <PendingCard
                key={p.pendingId}
                entry={p}
                globalEnabled={globalEnabled}
                assistantExists={assistantIds.has(p.assistantId)}
              />
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
