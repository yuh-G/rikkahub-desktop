import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMemoryStore, useSettingsStore } from "~/stores";
import { cn } from "~/lib/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { Brain, Globe, Bot, X, Check, Loader2 } from "lucide-react";
import { Textarea } from "~/components/ui/textarea";
import api from "~/services/api";
import { toast } from "sonner";

/** 待确认记忆徽章 + 确认弹窗。挂载在输入框卡片右上角(memory/stream SSE 推送的 snapshot)。
 *
 *  交互模型(多选 + 批量作用于选中项,避免"全有或全无"的粗糙):
 *  - 每条卡片左侧有 checkbox,顶部批量区有"全选/取消全选"快捷
 *  - 顶部三个批量按钮(顺序与单条一致:全局-助手-丢弃)仅对选中项生效;
 *    selected 为空时按钮 disabled —— 强制用户显式选择,防误操作
 *  - 单条卡片同样三个按钮,只作用于该条
 *  - 任何"丢弃"操作(单条或批量)执行前都弹 window.confirm 二次确认(不可逆)
 *  - 保存为助手记忆时,若来源助手已被删除,按钮 disabled + tooltip
 *  - 处理成功后该条从 SSE 推送的 snapshot 中自然消失;selected 会被 useEffect 清理 */
export function MemoryBadge() {
  const { t } = useTranslation("message");
  const snapshot = useMemoryStore((s) => s.snapshot);
  const assistants = useSettingsStore((s) => s.settings?.assistants) ?? [];

  const [isOpen, setIsOpen] = useState(false);
  // null=无操作;pendingId=正在处理的单条;"batch"=批量操作中。按钮据此 disabled + 显示 spinner。
  const [saving, setSaving] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // pending 列表变化时(某条被处理后消失、新提议入队),清理 selected 里已不存在的 id,避免残留。
  // 引用相等检查(size 不变则返回 prev)避免不必要的重渲染。
  React.useEffect(() => {
    if (!snapshot) return;
    const ids = new Set(snapshot.pending.map((p) => p.pendingId));
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (ids.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [snapshot?.pending]);

  if (!snapshot || snapshot.pendingCount === 0) return null;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allSelected = snapshot.pending.length > 0 && selected.size === snapshot.pending.length;
  const selectAll = () => setSelected(new Set(snapshot.pending.map((p) => p.pendingId)));
  const clearSelection = () => setSelected(new Set());

  const assistantExists = (assistantId: string) => assistants.some((a) => a.id === assistantId);

  // 单条处理。content 取 textarea 当前值(用户可能编辑过),fallback 到原 content。
  // discard 前二次确认(不可逆)。处理成功后从 selected 移除(防止后续批量重复处理)。
  const handleSave = async (
    pendingId: string,
    action: "global" | "assistant" | "discard",
    content: string,
  ) => {
    if (action === "discard" && !window.confirm(t("memory.discard_confirm", { n: 1 }))) return;
    setSaving(pendingId);
    try {
      await api.post(`memory/pending/${encodeURIComponent(pendingId)}`, { action, content });
      toast.success(t("memory.save_success"));
      setSelected((prev) => {
        if (!prev.has(pendingId)) return prev;
        const next = new Set(prev);
        next.delete(pendingId);
        return next;
      });
    } catch (e) {
      console.error("[MemoryBadge] Save failed:", e);
      toast.error(t("memory.save_failed"));
    } finally {
      setSaving(null);
    }
  };

  // 批量处理选中项。discard 前二次确认(带选中数)。成功后关弹窗 + 清空 selected。
  const handleBatchSave = async (action: "global" | "assistant" | "discard") => {
    if (selected.size === 0) return;
    if (action === "discard" && !window.confirm(t("memory.discard_confirm", { n: selected.size }))) return;
    setSaving("batch");
    try {
      const items = snapshot.pending
        .filter((p) => selected.has(p.pendingId))
        .map((p) => ({ pendingId: p.pendingId, action }));
      await api.post("memory/pending/batch", { items });
      toast.success(t("memory.batch_success"));
      setSelected(new Set());
      setIsOpen(false);
    } catch (e) {
      console.error("[MemoryBadge] Batch save failed:", e);
      toast.error(t("memory.batch_failed"));
    } finally {
      setSaving(null);
    }
  };

  // 批量按钮文案/状态,顺序统一为 全局-助手-丢弃(与单条一致)。
  // variant=secondary 与单条 default 区分,提示用户"这是批量操作"。
  const batchDisabled = selected.size === 0 || saving === "batch";
  const renderBatchButton = (
    action: "global" | "assistant" | "discard",
    Icon: typeof Globe,
    label: string,
    variant: "secondary" | "ghost",
  ) => (
    <Button
      variant={variant}
      size="sm"
      className="flex-1"
      disabled={batchDisabled}
      onClick={() => handleBatchSave(action)}
    >
      {saving === "batch" ? (
        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
      ) : (
        <Icon className="h-4 w-4 mr-1" />
      )}
      {label}
    </Button>
  );

  return (
    <>
      <TooltipProvider>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <Badge
              variant="default"
              className="h-6 min-w-6 cursor-pointer items-center justify-center rounded-full px-1.5 text-xs font-medium hover:bg-primary/90 transition-colors"
              onClick={() => setIsOpen(true)}
            >
              <Brain className="h-3 w-3 mr-0.5" />
              {snapshot.pendingCount}
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {t("memory.pending_tooltip", { n: snapshot.pendingCount })}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("memory.pending_title")}</DialogTitle>
            <DialogDescription>
              {t("memory.pending_subtitle", { n: snapshot.pendingCount })}
            </DialogDescription>
          </DialogHeader>

          {/* 批量操作区:独立带底色容器 + "批量处理" 标题,与下方单条卡片视觉分层。
              选中数实时显示,顺序 全局-助手-丢弃 与单条一致。 */}
          <div className="rounded-lg border bg-muted/30 p-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium text-muted-foreground">
                {t("memory.batch_label")}
                <span className="ml-1.5 text-primary">
                  ({selected.size}/{snapshot.pending.length})
                </span>
              </div>
              <Button
                variant="link"
                size="sm"
                className="h-auto px-1 py-0 text-xs"
                onClick={allSelected ? clearSelection : selectAll}
                disabled={snapshot.pending.length === 0}
              >
                {allSelected ? t("memory.clear_selection") : t("memory.select_all")}
              </Button>
            </div>
            <div className="flex gap-2">
              {renderBatchButton("global", Globe, t("memory.save_global"), "secondary")}
              {renderBatchButton("assistant", Bot, t("memory.save_assistant"), "secondary")}
              {renderBatchButton("discard", X, t("memory.discard"), "ghost")}
            </div>
          </div>

          <div className="max-h-[55vh] overflow-y-auto space-y-3">
            {snapshot.pending.map((entry) => {
              const isSelected = selected.has(entry.pendingId);
              const assistantGone = !assistantExists(entry.assistantId);
              return (
                <div
                  key={entry.pendingId}
                  className={cn(
                    "rounded-lg border p-3 space-y-2 transition-colors",
                    isSelected ? "border-primary bg-primary/5" : "border-border",
                  )}
                >
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={isSelected}
                      onClick={() => toggle(entry.pendingId)}
                      className={cn(
                        "mt-0.5 size-4 shrink-0 cursor-pointer rounded-[4px] border flex items-center justify-center transition-colors",
                        isSelected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input hover:border-primary/50",
                      )}
                    >
                      {isSelected && <Check className="size-3" strokeWidth={3} />}
                    </button>
                    <div className="flex-1 min-w-0 space-y-0.5">
                      <div className="text-xs text-muted-foreground">
                        {entry.assistantName} · {new Date(entry.proposedAt).toLocaleString()}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {t("memory.from_conversation")}:{" "}
                        {entry.conversationTitle || t("memory.untitled_conversation")}
                      </div>
                    </div>
                  </div>
                  <Textarea
                    defaultValue={entry.content}
                    rows={3}
                    className="w-full text-sm resize-none"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="default"
                      className="flex-1"
                      disabled={saving === entry.pendingId}
                      onClick={(e) => {
                        const textarea = e.currentTarget.parentElement?.parentElement?.querySelector("textarea");
                        handleSave(entry.pendingId, "global", textarea?.value || entry.content);
                      }}
                    >
                      {saving === entry.pendingId ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      ) : (
                        <Globe className="h-3 w-3 mr-1" />
                      )}
                      {t("memory.save_global")}
                    </Button>
                    <Button
                      size="sm"
                      variant="default"
                      className="flex-1"
                      disabled={saving === entry.pendingId || assistantGone}
                      title={assistantGone ? t("memory.save_assistant_disabled") : undefined}
                      onClick={(e) => {
                        const textarea = e.currentTarget.parentElement?.parentElement?.querySelector("textarea");
                        handleSave(entry.pendingId, "assistant", textarea?.value || entry.content);
                      }}
                    >
                      {saving === entry.pendingId ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      ) : (
                        <Bot className="h-3 w-3 mr-1" />
                      )}
                      {t("memory.save_assistant")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1"
                      disabled={saving === entry.pendingId}
                      onClick={() => handleSave(entry.pendingId, "discard", entry.content)}
                    >
                      {saving === entry.pendingId ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      ) : (
                        <X className="h-3 w-3 mr-1" />
                      )}
                      {t("memory.discard")}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
