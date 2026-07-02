import React from "react";
import { useTranslation } from "react-i18next";
import { Brain, Trash2, Globe, Bot } from "lucide-react";

import api from "~/services/api";
import { useMemoryStore } from "~/stores";
import type { PendingEntry } from "~/types";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";

// 单条 pending:可编辑 textarea + 三按钮(存全局/存助手/丢弃)。
// "存为助手"显式依赖入队时的 assistantId 快照(可能不是当前会话助手),由后端按 pendingId 定位。
function PendingCard({ entry, globalEnabled }: { entry: PendingEntry; globalEnabled: boolean }) {
  const { t } = useTranslation();
  const [content, setContent] = React.useState(entry.content);
  React.useEffect(() => setContent(entry.content), [entry.content]);

  const resolve = async (action: "global" | "assistant" | "discard") => {
    await api.post(`memory/pending/${entry.pendingId}`, { action, content: content.trim() });
  };
  return (
    <div className="space-y-2 rounded-md border p-2">
      <div className="text-xs text-muted-foreground">
        {entry.assistantName} · {new Date(entry.proposedAt).toLocaleString()}
      </div>
      <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={2} className="text-sm" />
      <div className="flex gap-1">
        <Button size="sm" variant="outline" disabled={!globalEnabled} onClick={() => void resolve("global")}>
          <Globe className="size-3" />{t("message:memory_save_global")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => void resolve("assistant")}>
          <Bot className="size-3" />{t("message:memory_save_assistant")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void resolve("discard")}>
          <Trash2 className="size-3" />
        </Button>
      </div>
    </div>
  );
}

/**
 * 会话页待确认记忆徽章。pendingCount > 0 时显示;点击展开确认面板(批量 + 逐条处理)。
 * 样式参考方案 §11.3:品牌色数字气泡(非红,记忆确认非危险),脉冲暂未实现(v1 简化)。
 * 数据来自 memory SSE store,处理后后端 broadcast,store 自动刷新。
 */
export function MemoryBadge() {
  const { t } = useTranslation();
  const snapshot = useMemoryStore((s) => s.snapshot);
  const [open, setOpen] = React.useState(false);
  // U1:pendingCount 增加时短暂脉冲(~2s 后停),不持续打扰。仅追踪增加(减少 = 用户已处理)。
  const prevCount = React.useRef(snapshot?.pendingCount ?? 0);
  const [pulse, setPulse] = React.useState(false);
  React.useEffect(() => {
    const cur = snapshot?.pendingCount ?? 0;
    if (cur > prevCount.current) {
      setPulse(true);
      const timer = setTimeout(() => setPulse(false), 2000);
      prevCount.current = cur;
      return () => clearTimeout(timer);
    }
    prevCount.current = cur;
  }, [snapshot?.pendingCount]);

  if (!snapshot || snapshot.pendingCount === 0) return null;
  const globalEnabled = snapshot.globalEnabled;

  const batch = async (action: "global" | "assistant" | "discard") => {
    const items = snapshot.pending.map((p) => ({ pendingId: p.pendingId, action }));
    await api.post("memory/pending/batch", { items });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "relative inline-flex h-8 items-center rounded-md border bg-background px-2 text-foreground transition-colors hover:bg-accent",
            pulse && "animate-pulse ring-2 ring-primary ring-offset-1",
          )}
          title={t("message:memory_pending_tooltip", { n: snapshot.pendingCount })}
        >
          <Brain className="size-4 text-primary" />
          <span className="ml-1 text-xs font-medium">{snapshot.pendingCount}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-96" align="end">
        <div className="space-y-2">
          <div className="text-sm font-medium">{t("message:memory_pending_title", { n: snapshot.pendingCount })}</div>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" className="flex-1" onClick={() => void batch("assistant")}>
              {t("message:memory_batch_assistant")}
            </Button>
            <Button size="sm" variant="outline" className="flex-1" disabled={!globalEnabled} onClick={() => void batch("global")}>
              {t("message:memory_batch_global")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void batch("discard")}>
              {t("message:memory_batch_discard")}
            </Button>
          </div>
          <div className="max-h-96 space-y-2 overflow-auto">
            {snapshot.pending.map((p) => (
              <PendingCard key={p.pendingId} entry={p} globalEnabled={globalEnabled} />
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
