import React from "react";
import { useTranslation } from "react-i18next";
import { Brain, Plus, Trash2, Pencil, Check, X } from "lucide-react";

import api from "~/services/api";
import { useMemoryStore } from "~/stores";
import type { Settings, MemoryEntry, WriteStrategy } from "~/types";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Switch } from "~/components/ui/switch";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";

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

  if (!snapshot) {
    return <div className="p-4 text-muted-foreground">{t("common:loading")}</div>;
  }

  return (
    <div className="space-y-4">
      {/* 卡片 0:AI 写入策略 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Brain className="size-4" />{t("settings:memory.write_strategy_title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Select value={ms.writeStrategy} onValueChange={(v) => void updateMemorySettings({ writeStrategy: v as WriteStrategy })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
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
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>{t("settings:memory.global_title")}</CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{t("settings:memory.enable_global")}</span>
            <Switch checked={ms.globalEnabled} onCheckedChange={(v) => void updateMemorySettings({ globalEnabled: v })} />
          </div>
        </CardHeader>
        <CardContent className={ms.globalEnabled ? "space-y-2" : "space-y-2 opacity-50"}>
          {snapshot.globalMemories.map((m) => (
            <MemoryItem key={m.id} entry={m} scope="global" />
          ))}
          {ms.globalEnabled && (
            <div className="flex gap-2">
              <Textarea value={newGlobal} onChange={(e) => setNewGlobal(e.target.value)} rows={1} placeholder={t("settings:memory.add_placeholder")} />
              <Button size="icon" onClick={() => void addGlobal()}><Plus className="size-4" /></Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 卡片 2:助手记忆 */}
      <Card>
        <CardHeader><CardTitle>{t("settings:memory.assistant_title")}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {settings.assistants.map((a) => {
            const group = snapshot.assistantMemories.find((g) => g.assistantId === a.id);
            const mems = group?.memories ?? [];
            return (
              <div key={a.id} className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="font-medium">{a.name || t("settings:memory.unnamed_assistant")}</div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">{t("settings:memory.enable_memory")}</span>
                    <Switch checked={a.enableMemory === true} onCheckedChange={(v) => void setAssistantMemory(a.id, v)} />
                  </div>
                </div>
                {a.enableMemory === true && (
                  <div className="space-y-1.5 pl-2">
                    {mems.map((m) => (
                      <MemoryItem key={m.id} entry={m} scope="assistant" assistantId={a.id} />
                    ))}
                    <div className="flex gap-2">
                      <Textarea
                        value={newByAssistant[a.id] ?? ""}
                        onChange={(e) => setNewByAssistant((m) => ({ ...m, [a.id]: e.target.value }))}
                        rows={1}
                        placeholder={t("settings:memory.add_placeholder")}
                      />
                      <Button size="icon" onClick={() => void addAssistant(a.id)}><Plus className="size-4" /></Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
