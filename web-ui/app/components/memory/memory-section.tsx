import React from "react";
import { useTranslation } from "react-i18next";
import { Brain, Plus, Trash2, Pencil, Check, X, FileJson } from "lucide-react";

import api from "~/services/api";
import { useMemoryStore } from "~/stores";
import type { Settings, MemoryEntry, WriteStrategy } from "~/types";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Switch } from "~/components/ui/switch";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Input } from "~/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "~/components/ui/dialog";

// 单条记忆:展示 + 行内编辑/删除。变更后后端 broadcast memory SSE,store 自动刷新(无需回调)。
function MemoryItem({ entry, scope, assistantId }: {
  entry: MemoryEntry;
  scope: "global" | "assistant";
  assistantId?: string;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(entry.content);
  React.useEffect(() => setDraft(entry.content), [entry.content]);

  const save = async () => {
    const content = draft.trim();
    if (!content) return;
    const path = scope === "global" ? "memory/global" : `memory/assistant/${assistantId}`;
    await api.post(path, { id: entry.id, content });
    setEditing(false);
  };
  const remove = async () => {
    const path = scope === "global"
      ? `memory/global/${entry.id}`
      : `memory/assistant/${assistantId}/${entry.id}`;
    await api.delete(path);
  };

  return (
    <div className="rounded-md border p-2 text-sm">
      {editing ? (
        <div className="space-y-2">
          <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} />
          <div className="flex gap-1">
            <Button size="sm" onClick={() => void save()}><Check className="size-3.5" /></Button>
            <Button size="sm" variant="outline" onClick={() => { setEditing(false); setDraft(entry.content); }}><X className="size-3.5" /></Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 whitespace-pre-wrap break-words">{entry.content}</div>
          <div className="flex shrink-0 gap-1">
            <Button size="icon" variant="ghost" className="size-6" onClick={() => setEditing(true)}><Pencil className="size-3" /></Button>
            <Button size="icon" variant="ghost" className="size-6" onClick={() => void remove()}><Trash2 className="size-3" /></Button>
          </div>
        </div>
      )}
      {editing === false && entry.source === "ai" && (
        <div className="mt-1 text-xs text-muted-foreground">{t("settings:memory.source_ai")}</div>
      )}
    </div>
  );
}

export function MemorySection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const snapshot = useMemoryStore((s) => s.snapshot);
  const ms = settings.memorySettings ?? { globalEnabled: false, writeStrategy: "ask" as WriteStrategy };
  const [newGlobal, setNewGlobal] = React.useState("");
  const [newByAssistant, setNewByAssistant] = React.useState<Record<string, string>>({});
  const [assistantQuery, setAssistantQuery] = React.useState("");

  const updateMemorySettings = async (patch: Partial<{ globalEnabled: boolean; writeStrategy: WriteStrategy }>) => {
    const next = { ...ms, ...patch };
    onSettings({ ...settings, memorySettings: next });
    await api.post("settings/memory-settings", patch);
  };

  const addGlobal = async () => {
    const content = newGlobal.trim();
    if (!content) return;
    await api.post("memory/global", { content });
    setNewGlobal("");
  };
  const addAssistant = async (assistantId: string) => {
    const content = (newByAssistant[assistantId] ?? "").trim();
    if (!content) return;
    await api.post(`memory/assistant/${assistantId}`, { content });
    setNewByAssistant((m) => ({ ...m, [assistantId]: "" }));
  };

  // 助手 enableMemory 开关:更新助手配置(POST settings/assistant/detail 触发 settings SSE)
  const setAssistantMemory = async (assistantId: string, enabled: boolean) => {
    const assistants = settings.assistants.map((a) => (a.id === assistantId ? { ...a, enableMemory: enabled } : a));
    onSettings({ ...settings, assistants });
    const updated = assistants.find((x) => x.id === assistantId);
    if (updated) await api.post("settings/assistant/detail", updated);
  };

  // 批量编辑(高级用户直接编辑原始 JSON,§9.3)。实时 JSON.parse 校验;提交前二次确认;
  // 后端带 schema 校验 + .bak 备份,失败可从 .bak 恢复。
  const [batchTarget, setBatchTarget] = React.useState<"global" | "assistant" | null>(null);
  const [batchText, setBatchText] = React.useState("");
  const [batchError, setBatchError] = React.useState<string | null>(null);
  const openBatch = (target: "global" | "assistant") => {
    const data = target === "global" ? snapshot!.globalMemories : snapshot!.assistantMemories;
    setBatchTarget(target);
    setBatchText(JSON.stringify(data, null, 2));
    setBatchError(null);
  };
  const saveBatch = async () => {
    if (!batchTarget) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(batchText);
    } catch (e) {
      setBatchError(t("settings:memory.batch_json_error", { msg: e instanceof Error ? e.message : String(e) }));
      return;
    }
    if (!window.confirm(t("settings:memory.batch_confirm"))) return;
    const batchPath = batchTarget === "global" ? "memory/batch/global" : "memory/batch/assistant";
    const body = batchTarget === "global" ? { memories: parsed } : { assistants: parsed };
    try {
      await api.post(batchPath, body);
      setBatchTarget(null);
    } catch (e) {
      setBatchError(t("settings:memory.batch_save_error", { msg: e instanceof Error ? e.message : String(e) }));
    }
  };

  if (!snapshot) {
    return <div className="p-4 text-muted-foreground">{t("common:loading")}</div>;
  }
  // U4:助手名搜索过滤(助手多时快速定位)
  const filteredAssistants = settings.assistants.filter((a) =>
    (a.name || "").toLowerCase().includes(assistantQuery.trim().toLowerCase()),
  );

  return (
    <div className="space-y-4">
      {/* 板块头部:与其它设置板块同构(图标框 + 大标题 + 副标题),统一设计语言。 */}
      <div className="mb-6 flex items-start gap-3">
        <div className="rounded-md border bg-card p-2">
          <Brain className="size-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">{t("settings:memory.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("settings:memory.subtitle")}</p>
        </div>
      </div>

      {/* 卡片 0:AI 写入策略 */}
      <Card>
        <CardHeader>
          <CardTitle>{t("settings:memory.write_strategy_title")}</CardTitle>
          <CardDescription>{t("settings:memory.write_strategy_subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={ms.writeStrategy} onValueChange={(v) => void updateMemorySettings({ writeStrategy: v as WriteStrategy })}>
            <SelectTrigger className="w-full sm:w-72"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ask">{t("settings:memory.strategy_ask")}</SelectItem>
              <SelectItem value="always_assistant">{t("settings:memory.strategy_always_assistant")}</SelectItem>
              <SelectItem value="always_global" disabled={!ms.globalEnabled}>{t("settings:memory.strategy_always_global")}</SelectItem>
              <SelectItem value="readonly">{t("settings:memory.strategy_readonly")}</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* 卡片 1:全局记忆 */}
      <Card>
        <CardHeader>
          <CardTitle>{t("settings:memory.global_title")}</CardTitle>
          <CardDescription>{t("settings:memory.global_subtitle")}</CardDescription>
          <CardAction>
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="size-8 text-muted-foreground"
                title={t("settings:memory.batch_edit_hint")}
                onClick={() => openBatch("global")}
              >
                <FileJson className="size-4" />
              </Button>
              <Switch checked={ms.globalEnabled} onCheckedChange={(v) => void updateMemorySettings({ globalEnabled: v })} />
            </div>
          </CardAction>
        </CardHeader>
        <CardContent className={ms.globalEnabled ? "space-y-2" : "space-y-2 opacity-50"}>
          {snapshot.globalMemories.length === 0 && (
            <div className="py-1 text-sm text-muted-foreground">{t("settings:memory.empty_global")}</div>
          )}
          {snapshot.globalMemories.map((m) => (
            <MemoryItem key={m.id} entry={m} scope="global" />
          ))}
          {ms.globalEnabled && (
            <div className="flex gap-2 pt-1">
              <Textarea value={newGlobal} onChange={(e) => setNewGlobal(e.target.value)} rows={1} placeholder={t("settings:memory.add_placeholder")} className="resize-none" />
              <Button size="icon" onClick={() => void addGlobal()}><Plus className="size-4" /></Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 卡片 2:助手记忆 */}
      <Card>
        <CardHeader>
          <CardTitle>{t("settings:memory.assistant_title")}</CardTitle>
          <CardDescription>{t("settings:memory.assistant_subtitle")}</CardDescription>
          <CardAction>
            <Button
              size="icon"
              variant="ghost"
              className="size-8 text-muted-foreground"
              title={t("settings:memory.batch_edit_hint")}
              onClick={() => openBatch("assistant")}
            >
              <FileJson className="size-4" />
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            value={assistantQuery}
            onChange={(e) => setAssistantQuery(e.target.value)}
            placeholder={t("settings:memory.search_assistant")}
            className="text-sm"
          />
          {filteredAssistants.map((a) => {
            const group = snapshot.assistantMemories.find((g) => g.assistantId === a.id);
            const mems = group?.memories ?? [];
            return (
              <div key={a.id} className="space-y-2 border-t pt-3 first:border-t-0 first:pt-0">
                <div className="flex items-center justify-between">
                  <div className="font-medium">{a.name || t("settings:memory.unnamed_assistant")}</div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">{t("settings:memory.enable_memory")}</span>
                    <Switch checked={a.enableMemory === true} onCheckedChange={(v) => void setAssistantMemory(a.id, v)} />
                  </div>
                </div>
                {a.enableMemory === true && (
                  <div className="space-y-1.5 pl-2">
                    {mems.length === 0 && (
                      <div className="text-sm text-muted-foreground">{t("settings:memory.empty_assistant")}</div>
                    )}
                    {mems.map((m) => (
                      <MemoryItem key={m.id} entry={m} scope="assistant" assistantId={a.id} />
                    ))}
                    <div className="flex gap-2">
                      <Textarea
                        value={newByAssistant[a.id] ?? ""}
                        onChange={(e) => setNewByAssistant((m) => ({ ...m, [a.id]: e.target.value }))}
                        rows={1}
                        placeholder={t("settings:memory.add_placeholder")}
                        className="resize-none"
                      />
                      <Button size="icon" onClick={() => void addAssistant(a.id)}><Plus className="size-4" /></Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {/* 孤儿记忆:assistant_memory.json 里有但 settings.assistants 已删除的(M4 保留,可编辑/删除) */}
          {snapshot.assistantMemories
            .filter((g) => !settings.assistants.some((a) => a.id === g.assistantId))
            .map((g) => (
              <div key={g.assistantId} className="space-y-2 rounded-md border border-dashed p-2">
                <div className="text-xs text-muted-foreground">
                  {t("settings:memory.orphan_group", { name: g.assistantName, n: g.memories.length })}
                </div>
                {g.memories.map((m) => (
                  <MemoryItem key={m.id} entry={m} scope="assistant" assistantId={g.assistantId} />
                ))}
              </div>
            ))}
        </CardContent>
      </Card>

      {/* 批量编辑对话框(高级用户直接编辑原始 JSON,实时校验 + 二次确认)*/}
      <Dialog open={batchTarget !== null} onOpenChange={(o) => !o && setBatchTarget(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("settings:memory.batch_edit_title")}</DialogTitle>
          </DialogHeader>
          <Textarea
            value={batchText}
            onChange={(e) => setBatchText(e.target.value)}
            className="min-h-96 font-mono text-xs"
          />
          {batchError && <div className="text-sm text-destructive">{batchError}</div>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchTarget(null)}>{t("settings:memory.cancel")}</Button>
            <Button onClick={() => void saveBatch()}>{t("settings:memory.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
