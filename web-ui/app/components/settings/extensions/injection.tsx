// components/settings/extensions/injection.tsx — 拓展 › 提示词注入(模式注入 + 世界书)

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { SegmentedTabs } from "~/components/ui/segmented-tabs";
import { Textarea } from "~/components/ui/textarea";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import { cn } from "~/lib/utils";
import { createId } from "~/lib/id";
import api from "~/services/api";
import { confirmDialog } from "~/stores/confirm-store";
import { getSettingsParam } from "~/stores/settings-dialog-store";
import type { AssistantProfile, Settings } from "~/types";
import { clone, moveItem, numberText, SettingsSwitchRow, textValue } from "~/components/settings/shared";
import {
  BindingAssistantToolbar,
  BindingSwitch,
  EditorShell,
  ExpandChevron,
  NoAssistantsState,
  pullSettings,
  type SectionProps,
  useBindingAssistant,
} from "~/components/settings/extensions/common";

type InjectionPanel = "mode" | "lorebook";

/**
 * 拓展 › 提示词注入:模式注入与世界书两个板块,页内分段切换,一次只显示一个。两个编辑器都
 * 挂载、用 hidden 切换:编辑器挂载时从 settings 取草稿、之后只在切换条目时同步,来回切换若
 * 重挂载,"防抖窗口内编辑 → 切走 → 保存往返未完成就切回"会显示改之前的内容,再改一笔即
 * 覆盖已保存值;常驻挂载同时保留各自列表的选中项。
 */
export function PromptInjectionSection({ settings, onSettings }: SectionProps) {
  const { t } = useTranslation();
  // 深链 tab 只在进入时读一次(切页即清空,见 settings-dialog-store),之后由页内状态决定。
  const [panel, setPanel] = React.useState<InjectionPanel>(() =>
    getSettingsParam("tab") === "lorebook" ? "lorebook" : "mode",
  );
  const assistant = useBindingAssistant(settings);
  if (!assistant) return <NoAssistantsState />;
  return (
    <>
      <BindingAssistantToolbar
        settings={settings}
        assistant={assistant}
        leading={
          <SegmentedTabs
            size="sm"
            aria-label={t("settings:subnav.extensions.injection")}
            items={[
              { value: "mode", label: t("settings:mcp.tab.mode") },
              { value: "lorebook", label: t("settings:mcp.tab.lorebook") },
            ]}
            value={panel}
            onChange={setPanel}
          />
        }
      />
      <div hidden={panel !== "mode"}>
        <ModeInjectionEditor settings={settings} assistant={assistant} onSettings={onSettings} />
      </div>
      <div hidden={panel !== "lorebook"}>
        <LorebookEditor settings={settings} assistant={assistant} onSettings={onSettings} />
      </div>
    </>
  );
}

function ModeInjectionEditor({
  settings,
  assistant,
  onSettings,
}: {
  settings: Settings;
  assistant: AssistantProfile;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const items = (settings.modeInjections ?? []) as Array<Record<string, unknown>>;
  const [selectedId, setSelectedId] = React.useState(textValue(items[0]?.id));
  const selected =
    items.find((item) => String(item.id) === selectedId) ?? items[0] ?? createModeInjection();
  const [draft, setDraft] = React.useState<Record<string, unknown>>(clone(selected));
  // itemsRef: avoid re-running this effect after every autosave → pullSettings round-trip
  // (would overwrite mid-flight keystrokes). See McpServerEditor for rationale.
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  React.useEffect(() => {
    const next = itemsRef.current.find((item) => String(item.id) === selectedId) ?? itemsRef.current[0];
    if (next) {
      setSelectedId(String(next.id));
      setDraft(clone(next));
    }
  }, [selectedId]);
  return (
    <PromptItemEditor
      settings={settings}
      assistant={assistant}
      onSettings={onSettings}
      items={items}
      selectedId={selectedId}
      setSelectedId={setSelectedId}
      draft={draft}
      setDraft={setDraft}
      bindKey="modeInjectionIds"
      savePath="settings/mode-injection/detail"
      deletePath="settings/mode-injection"
      reorderPath="settings/mode-injection/reorder"
      createItem={createModeInjection}
      title={t("settings:mcp.tab.mode")}
    />
  );
}

function createModeInjection(): Record<string, unknown> {
  return {
    id: createId(),
    type: "mode",
    name: "",
    enabled: true,
    priority: 0,
    position: "after_system_prompt",
    role: "USER",
    injectDepth: 4,
    content: "",
  };
}

function createLorebookEntry(): Record<string, unknown> {
  return {
    id: createId(),
    name: "",
    enabled: true,
    priority: 0,
    position: "after_system_prompt",
    role: "USER",
    injectDepth: 4,
    scanDepth: 4,
    keywords: [],
    useRegex: false,
    caseSensitive: false,
    constantActive: false,
    content: "",
  };
}

function LorebookEntryRow({
  entry,
  index,
  onChange,
  onDelete,
}: {
  entry: Record<string, unknown>;
  index: number;
  onChange: (next: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState(false);
  const patch = (next: Partial<Record<string, unknown>>) => onChange({ ...entry, ...next });
  const keywords = Array.isArray(entry.keywords) ? entry.keywords.map(String) : [];
  const position = textValue(entry.position) || "after_system_prompt";
  const usesStandaloneMessage =
    position === "top_of_chat" || position === "bottom_of_chat" || position === "at_depth";
  const constantActive = entry.constantActive === true;
  const triggerSummary = constantActive
    ? t("settings:mcp.constant_active")
    : keywords.length > 0
      ? t("settings:mcp.keywords_count", { count: keywords.length })
      : t("settings:mcp.no_trigger");
  return (
    <div className="rounded-md border bg-background">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={cn(
              "size-2 rounded-full",
              entry.enabled === false ? "bg-muted-foreground/40" : "bg-success",
            )}
          />
          <span className="truncate text-sm font-medium">
            {textValue(entry.name) || t("settings:mcp.entry_n", { n: index + 1 })}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">· {triggerSummary}</span>
        </span>
        <ExpandChevron expanded={expanded} />
      </button>
      {expanded ? (
        <div className="space-y-3 border-t px-3 py-3">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.name")}</span>
              <Input
                value={textValue(entry.name)}
                onChange={(event) => patch({ name: event.target.value })}
                placeholder={t("settings:mcp.entry_name_ph")}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.priority")}</span>
              <Input
                type="number"
                value={numberText(entry.priority)}
                onChange={(event) => patch({ priority: Number(event.target.value) })}
                placeholder="0"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.position")}</span>
              <Select value={position} onValueChange={(value) => patch({ position: value })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="before_system_prompt">{t("settings:mcp.pos.before")}</SelectItem>
                  <SelectItem value="after_system_prompt">{t("settings:mcp.pos.after")}</SelectItem>
                  <SelectItem value="top_of_chat">{t("settings:mcp.pos.top")}</SelectItem>
                  <SelectItem value="bottom_of_chat">{t("settings:mcp.pos.bottom")}</SelectItem>
                  <SelectItem value="at_depth">{t("settings:mcp.pos.depth")}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {usesStandaloneMessage ? (
              <label className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.role")}</span>
                <Select
                  value={textValue(entry.role) || "USER"}
                  onValueChange={(value) => patch({ role: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USER">{t("settings:assistants.role.user")}</SelectItem>
                    <SelectItem value="ASSISTANT">{t("settings:assistants.role.assistant")}</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            ) : null}
            {position === "at_depth" ? (
              <label className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.inject_depth")}</span>
                <Input
                  type="number"
                  min={1}
                  value={numberText(entry.injectDepth ?? 4)}
                  onChange={(event) =>
                    patch({ injectDepth: Math.max(1, Number(event.target.value) || 4) })
                  }
                  placeholder="4"
                />
              </label>
            ) : null}
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t("settings:mcp.scan_depth")}
              </span>
              <Input
                type="number"
                min={1}
                value={numberText(entry.scanDepth ?? 4)}
                onChange={(event) =>
                  patch({ scanDepth: Math.max(1, Number(event.target.value) || 4) })
                }
                placeholder="4"
              />
            </label>
          </div>
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t("settings:mcp.keywords_label")}
            </span>
            <KeywordChipInput
              keywords={keywords}
              disabled={constantActive}
              onChange={(next) => patch({ keywords: next })}
            />
          </label>
          <div className="grid gap-2 md:grid-cols-3">
            <label className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <span>{t("settings:mcp.use_regex")}</span>
              <Switch
                checked={entry.useRegex === true}
                onCheckedChange={(checked) => patch({ useRegex: checked })}
                disabled={constantActive}
              />
            </label>
            <label className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <span>{t("settings:mcp.case_sensitive")}</span>
              <Switch
                checked={entry.caseSensitive === true}
                onCheckedChange={(checked) => patch({ caseSensitive: checked })}
                disabled={constantActive}
              />
            </label>
            <label className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <span>{t("settings:mcp.constant_active")}</span>
              <Switch
                checked={constantActive}
                onCheckedChange={(checked) => patch({ constantActive: checked })}
              />
            </label>
          </div>
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.inject_content")}</span>
            <Textarea
              value={textValue(entry.content)}
              onChange={(event) => patch({ content: event.target.value })}
              className="min-h-32 font-mono text-xs leading-relaxed"
              placeholder={t("settings:mcp.inject_content_ph")}
            />
          </label>
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={entry.enabled !== false}
                onCheckedChange={(checked) => patch({ enabled: checked })}
              />
              <span>{t("settings:mcp.enable_entry")}</span>
            </label>
            <Button type="button" variant="ghost" size="sm" onClick={onDelete}>
              <Trash2 className="size-4" />
              {t("settings:mcp.delete_entry")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function KeywordChipInput({
  keywords,
  disabled,
  onChange,
}: {
  keywords: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = React.useState("");
  const commit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (keywords.includes(trimmed)) {
      setValue("");
      return;
    }
    onChange([...keywords, trimmed]);
    setValue("");
  };
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1 rounded-md border bg-background px-2 py-1.5",
        disabled && "opacity-50",
      )}
    >
      {keywords.map((keyword) => (
        <span
          key={keyword}
          className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
        >
          {keyword}
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            disabled={disabled}
            onClick={() => onChange(keywords.filter((item) => item !== keyword))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="min-w-32 flex-1 bg-transparent text-xs outline-none"
        placeholder={disabled ? t("settings:mcp.keywords_disabled_ph") : t("settings:mcp.keywords_ph")}
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            commit();
          } else if (event.key === "Backspace" && !value && keywords.length > 0) {
            onChange(keywords.slice(0, -1));
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}

function LorebookEditor({
  settings,
  assistant,
  onSettings,
}: {
  settings: Settings;
  assistant: AssistantProfile;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const items = (settings.lorebooks ?? []) as Array<Record<string, unknown>>;
  const [selectedId, setSelectedId] = React.useState(textValue(items[0]?.id));
  const selected =
    items.find((item) => String(item.id) === selectedId) ?? items[0] ?? createLorebook();
  const [draft, setDraft] = React.useState<Record<string, unknown>>(clone(selected));
  // R8-2:防抖自动保存统一走共享三件套 hook(保存窗口内键击不丢,语义见 hook 文件头)。
  const autosave = useAutosaveDraft(
    async () => {
      await api.post("settings/lorebook/detail", draft);
      await pullSettings(onSettings);
    },
    { delayMs: 800, errorLabel: t("settings:mcp.tab.lorebook") },
  );
  // itemsRef: avoid re-running this effect after every autosave → pullSettings round-trip
  // (would overwrite mid-flight keystrokes). See McpServerEditor for rationale.
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  React.useEffect(() => {
    const next = itemsRef.current.find((item) => String(item.id) === selectedId) ?? itemsRef.current[0];
    if (!next) return;
    setSelectedId(String(next.id));
    setDraft(clone(next));
    autosave.reset();
  }, [selectedId]);
  const entries = Array.isArray(draft.entries)
    ? (draft.entries as Array<Record<string, unknown>>)
    : [];
  const patchDraft = (patch: Record<string, unknown>) => {
    autosave.markDirty();
    setDraft({ ...draft, ...patch });
  };
  const setEntries = (next: Array<Record<string, unknown>>) => {
    autosave.markDirty();
    setDraft({ ...draft, entries: next });
  };
  const bind = async (checked: boolean) => {
    const ids = new Set(assistant.lorebookIds ?? []);
    if (checked) ids.add(String(draft.id));
    else ids.delete(String(draft.id));
    await api.post("settings/assistant/injections", {
      assistantId: assistant.id,
      lorebookIds: [...ids],
    });
    await pullSettings(onSettings);
  };
  return (
    <EditorShell
      items={items}
      selectedId={selectedId}
      emptyLabel={t("settings:mcp.lorebook.empty")}
      onSelect={setSelectedId}
      titleOf={(item) => textValue(item.name) || t("settings:mcp.tab.lorebook")}
      onMove={async (from, to) => {
        const next = moveItem(items, from, to);
        onSettings({ ...settings, lorebooks: next as unknown as Settings["lorebooks"] });
        await api.post("settings/lorebook/reorder", { ids: next.map((item) => String(item.id)) });
      }}
      onCreate={async () => {
        // Eager-save pattern — same race-condition rationale as MCP and ModeInjection
        // (see settings.tsx:3515 and the PromptItemEditor onCreate comment). The original
        // setState + markDirty approach loses the new lorebook because the
        // `[selectedId, settings.lorebooks]` realignment effect at line 3857 fires when
        // selectedId changes, doesn't find the new id in settings (not saved yet), and
        // snaps the user back to lorebooks[0] — silently dropping the new entry.
        const next = createLorebook();
        next.name = t("settings:mcp.tab.lorebook");
        try {
          await api.post("settings/lorebook/detail", next);
          await pullSettings(onSettings);
          setSelectedId(String(next.id));
          setDraft(next);
          autosave.reset();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : t("settings:mcp.lorebook.create_failed"));
        }
      }}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">{t("settings:mcp.lorebook.detail")}</div>
          <BindingSwitch
            checked={(assistant.lorebookIds ?? []).includes(String(draft.id))}
            onCheckedChange={(checked) => void bind(checked)}
          />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.name")}</span>
            <Input
              value={textValue(draft.name)}
              onChange={(event) => patchDraft({ name: event.target.value })}
              placeholder={t("settings:mcp.lorebook.name_ph")}
            />
          </label>
          <label className="flex items-end gap-2">
            <span className="flex-1 space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.lorebook.enable")}</span>
              <div className="rounded-md border px-3 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span>{draft.enabled === false ? t("settings:mcp.disabled") : t("settings:mcp.enabled")}</span>
                  <Switch
                    checked={draft.enabled !== false}
                    onCheckedChange={(checked) => patchDraft({ enabled: checked })}
                  />
                </div>
              </div>
            </span>
          </label>
        </div>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.lorebook.desc")}</span>
          <Input
            value={textValue(draft.description)}
            onChange={(event) => patchDraft({ description: event.target.value })}
            placeholder={t("settings:mcp.lorebook.desc_ph")}
          />
        </label>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">{t("settings:mcp.entries_count", { count: entries.length })}</div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEntries([...entries, createLorebookEntry()])}
            >
              <Plus className="size-4" />
              {t("settings:mcp.add_entry")}
            </Button>
          </div>
          <div className="space-y-2">
            {entries.length === 0 ? (
              <div className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
                {t("settings:mcp.no_entries")}
              </div>
            ) : null}
            {entries.map((entry, index) => (
              <LorebookEntryRow
                key={String(entry.id ?? index)}
                entry={entry}
                index={index}
                onChange={(next) =>
                  setEntries(entries.map((item, idx) => (idx === index ? next : item)))
                }
                onDelete={() => setEntries(entries.filter((_, idx) => idx !== index))}
              />
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <AutosaveStatusRow
            className="mr-auto"
            status={autosave.status}
            onRetry={() => void autosave.saveNow()}
          />
          <Button
            variant="destructive"
            onClick={async () => {
              if (!(await confirmDialog({ title: t("settings:mcp.lorebook.delete_confirm", { name: textValue(draft.name) }), danger: true }))) return;
              // 防复活:丢弃待保存脏编辑并等在飞保存收尾,DELETE 不与迟到 POST 乱序(复审 F1)
              // 删除后显式选中下一条:重对齐 effect 只随 selectedId 触发,不选中会让草稿
              // 停留在已删实体上,再编辑一笔就经自动保存复活它(复审 F2)。
              const remaining = items.filter((item) => String(item.id) !== String(draft.id));
              await autosave.discard();
              await api.delete(`settings/lorebook/${draft.id}`);
              await pullSettings(onSettings);
              if (remaining.length) setSelectedId(String(remaining[0].id));
              else setDraft(clone(createLorebook()));
            }}
          >
            <Trash2 className="size-4" />
            {t("settings:mcp.lorebook.delete")}
          </Button>
        </div>
      </div>
    </EditorShell>
  );
}

function createLorebook(): Record<string, unknown> {
  return {
    id: createId(),
    name: "",
    description: "",
    enabled: true,
    entries: [
      {
        id: createId(),
        name: "",
        enabled: true,
        priority: 0,
        position: "after_system_prompt",
        role: "USER",
        injectDepth: 4,
        scanDepth: 4,
        keywords: [],
        useRegex: false,
        caseSensitive: false,
        content: "",
      },
    ],
  };
}

function PromptItemEditor({
  settings,
  assistant,
  onSettings,
  items,
  selectedId,
  setSelectedId,
  draft,
  setDraft,
  bindKey,
  savePath,
  deletePath,
  reorderPath,
  createItem,
  title,
}: {
  settings: Settings;
  assistant: AssistantProfile;
  onSettings: (settings: Settings) => void;
  items: Array<Record<string, unknown>>;
  selectedId: string;
  setSelectedId: (id: string) => void;
  draft: Record<string, unknown>;
  setDraft: (draft: Record<string, unknown>) => void;
  bindKey: "modeInjectionIds";
  savePath: string;
  deletePath: string;
  reorderPath: string;
  createItem: () => Record<string, unknown>;
  title: string;
}) {
  const { t } = useTranslation();
  // R8-2:防抖自动保存统一走共享三件套 hook(保存窗口内键击不丢,语义见 hook 文件头)。
  const autosave = useAutosaveDraft(
    async () => {
      await api.post(savePath, draft);
      await pullSettings(onSettings);
    },
    { errorLabel: title },
  );
  const promptVariables = [
    "{{cur_datetime}}",
    "{{date}}",
    "{{time}}",
    "{{locale}}",
    "{{timezone}}",
    "{{model_name}}",
    "{{user}}",
    "{{char}}",
  ];
  const position = textValue(draft.position) || "after_system_prompt";
  const usesStandaloneMessage =
    position === "top_of_chat" || position === "bottom_of_chat" || position === "at_depth";
  React.useEffect(() => {
    // 只在切换条目时复位;items 不能作依赖——autosave → pullSettings 回环会把保存窗口内
    // 的编辑冲掉(R8-2 病根,同 McpServerEditor 的 serversRef 说明)。
    autosave.reset();
  }, [selectedId]);
  const patchDraft = (patch: Record<string, unknown>) => {
    autosave.markDirty();
    setDraft({ ...draft, ...patch });
  };
  const appendVariable = (variable: string) => {
    const content = textValue(draft.content);
    const separator = content && !content.endsWith("\n") ? "\n" : "";
    patchDraft({ content: `${content}${separator}${variable}` });
  };
  const bind = async (checked: boolean) => {
    const ids = new Set(assistant[bindKey] ?? []);
    if (checked) ids.add(String(draft.id));
    else ids.delete(String(draft.id));
    await api.post("settings/assistant/injections", {
      assistantId: assistant.id,
      [bindKey]: [...ids],
    });
    await pullSettings(onSettings);
  };
  return (
    <EditorShell
      items={items}
      selectedId={selectedId}
      emptyLabel={t("settings:mcp.empty_item", { title })}
      onSelect={setSelectedId}
      titleOf={(item) => textValue(item.name) || title}
      onMove={async (from, to) => {
        const next = moveItem(items, from, to);
        onSettings({ ...settings, modeInjections: next as unknown as Settings["modeInjections"] });
        await api.post(reorderPath, { ids: next.map((item) => String(item.id)) });
      }}
      onCreate={async () => {
        // Eager save — same pattern as McpServerEditor.onCreate. The original code relied
        // on the 700 ms debounce, but two race conditions guaranteed the save never fired:
        //   1. The `[selectedId, items]` effect at line 4108 unconditionally reset
        //      the dirty flag when selectedId changed, cancelling the pending
        //      save.
        //   2. The wrapper component's `[selectedId, settings.modeInjections]` effect
        //      (e.g. line 3600) couldn't find the new id in settings and snapped
        //      selectedId back to items[0], silently overwriting the draft.
        // Saving first removes both races: by the time we touch any state, the new item
        // is already in settings, so both effects behave correctly.
        const next = createItem();
        next.name = title;
        try {
          await api.post(savePath, next);
          await pullSettings(onSettings);
          setSelectedId(String(next.id));
          setDraft(next);
          autosave.reset();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : t("settings:mcp.item_create_failed", { title }));
        }
      }}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">{t("settings:mcp.item_detail", { title })}</div>
          <BindingSwitch
            checked={(assistant[bindKey] ?? []).includes(String(draft.id))}
            onCheckedChange={(checked) => void bind(checked)}
          />
        </div>
        <Input
          value={textValue(draft.name)}
          onChange={(event) => patchDraft({ name: event.target.value })}
          placeholder={t("settings:mcp.name_ph")}
        />
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.priority")}</span>
            <Input
              type="number"
              value={numberText(draft.priority)}
              onChange={(event) => patchDraft({ priority: Number(event.target.value) })}
              placeholder="0"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.position")}</span>
            <Select value={position} onValueChange={(value) => patchDraft({ position: value })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="before_system_prompt">{t("settings:mcp.pos.before")}</SelectItem>
                <SelectItem value="after_system_prompt">{t("settings:mcp.pos.after")}</SelectItem>
                <SelectItem value="top_of_chat">{t("settings:mcp.pos.top")}</SelectItem>
                <SelectItem value="bottom_of_chat">{t("settings:mcp.pos.bottom")}</SelectItem>
                <SelectItem value="at_depth">{t("settings:mcp.pos.depth")}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {usesStandaloneMessage ? (
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.role")}</span>
              <Select
                value={textValue(draft.role) || "USER"}
                onValueChange={(value) => patchDraft({ role: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USER">{t("settings:assistants.role.user")}</SelectItem>
                  <SelectItem value="ASSISTANT">{t("settings:assistants.role.assistant")}</SelectItem>
                </SelectContent>
              </Select>
            </label>
          ) : null}
          {position === "at_depth" ? (
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t("settings:mcp.inject_depth_msg")}
              </span>
              <Input
                type="number"
                min={1}
                value={numberText(draft.injectDepth ?? 4)}
                onChange={(event) =>
                  patchDraft({ injectDepth: Math.max(1, Number(event.target.value) || 4) })
                }
                placeholder="4"
              />
            </label>
          ) : null}
        </div>
        <SettingsSwitchRow
          label={t("settings:mcp.enabled")}
          checked={draft.enabled !== false}
          onCheckedChange={(checked) => patchDraft({ enabled: checked })}
        />
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("settings:mcp.template_vars")}</span>
            {promptVariables.map((variable) => (
              <Button
                key={variable}
                type="button"
                size="xs"
                variant="outline"
                onClick={() => appendVariable(variable)}
              >
                {variable}
              </Button>
            ))}
          </div>
          <Textarea
            value={textValue(draft.content)}
            onChange={(event) => patchDraft({ content: event.target.value })}
            className="min-h-64 font-mono text-xs leading-relaxed"
            placeholder={t("settings:mcp.inject_content_template_ph", { cur_datetime: "{{cur_datetime}}" })}
          />
        </div>
        <div className="flex justify-end gap-2">
          <AutosaveStatusRow
            className="mr-auto"
            status={autosave.status}
            onRetry={() => void autosave.saveNow()}
          />
          <Button
            variant="destructive"
            onClick={async () => {
              if (!(await confirmDialog({ title: t("settings:mcp.inject_delete_confirm", { name: textValue(draft.name) }), danger: true }))) return;
              // 防复活:丢弃待保存脏编辑并等在飞保存收尾,DELETE 不与迟到 POST 乱序(复审 F1);同 Lorebook,删除后显式选中下一条(复审 F2)
              const remaining = items.filter((item) => String(item.id) !== String(draft.id));
              await autosave.discard();
              await api.delete(`${deletePath}/${draft.id}`);
              await pullSettings(onSettings);
              if (remaining.length) setSelectedId(String(remaining[0].id));
              else setDraft(clone(createItem()));
            }}
          >
            <Trash2 className="size-4" />
            {t("settings:mcp.delete")}
          </Button>
        </div>
      </div>
    </EditorShell>
  );
}
