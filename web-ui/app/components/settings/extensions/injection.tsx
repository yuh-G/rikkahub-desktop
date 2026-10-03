// components/settings/extensions/injection.tsx — 拓展 › 提示词注入(模式注入 + 世界书)

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { SegmentedControl, SegmentedTabs } from "~/components/ui/segmented-tabs";
import { Textarea } from "~/components/ui/textarea";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import { cn } from "~/lib/utils";
import { createId } from "~/lib/id";
import api from "~/services/api";
import { confirmDialog } from "~/stores/confirm-store";
import { getSettingsParam } from "~/stores/settings-dialog-store";
import type { AssistantProfile, Settings } from "~/types";
import {
  clone,
  moveItem,
  numberText,
  SettingsAdvancedSection,
  SettingsDetailFooter,
  SettingsDetailHeader,
  SettingsField,
  SettingsGroup,
  SettingsRows,
  SettingsStack,
  SettingsSwitchRow,
  textValue,
} from "~/components/settings/shared";
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

const PROMPT_VARIABLES = [
  "{{cur_datetime}}",
  "{{date}}",
  "{{time}}",
  "{{locale}}",
  "{{timezone}}",
  "{{model_name}}",
  "{{user}}",
  "{{char}}",
] as const;

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

const INJECTION_POSITIONS = [
  ["before_system_prompt", "settings:mcp.pos.before"],
  ["after_system_prompt", "settings:mcp.pos.after"],
  ["top_of_chat", "settings:mcp.pos.top"],
  ["bottom_of_chat", "settings:mcp.pos.bottom"],
  ["at_depth", "settings:mcp.pos.depth"],
] as const;

/**
 * 注入落点三件套(模式注入与世界书条目共用):注入位置;落在对话里(独立消息)时再选角色,
 * 选「指定深度」时再填深度。与服务端 applyPromptInjectionsToMessages 同口径。
 */
function InjectionPlacementFields({
  value,
  onChange,
}: {
  value: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const position = textValue(value.position) || "after_system_prompt";
  const standalone = position === "top_of_chat" || position === "bottom_of_chat" || position === "at_depth";
  return (
    <>
      <SettingsField label={t("settings:mcp.position")}>
        <Select value={position} onValueChange={(next) => onChange({ position: next })}>
          <SelectTrigger className="w-full" aria-label={t("settings:mcp.position")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INJECTION_POSITIONS.map(([key, labelKey]) => (
              <SelectItem key={key} value={key}>
                {t(labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsField>
      {standalone ? (
        <div className="grid gap-5 @xl:grid-cols-2">
          <SettingsField label={t("settings:mcp.role")}>
            <SegmentedControl
              stretch
              aria-label={t("settings:mcp.role")}
              items={[
                { value: "USER", label: t("settings:assistants.role.user") },
                { value: "ASSISTANT", label: t("settings:assistants.role.assistant") },
              ]}
              value={textValue(value.role).toUpperCase() === "ASSISTANT" ? "ASSISTANT" : "USER"}
              onChange={(role) => onChange({ role })}
            />
          </SettingsField>
          {position === "at_depth" ? (
            <SettingsField label={t("settings:mcp.inject_depth")} hint={t("settings:mcp.inject_depth_hint")}>
              <Input
                type="number"
                min={1}
                className="w-32"
                value={numberText(value.injectDepth ?? 4)}
                onChange={(event) => onChange({ injectDepth: Math.max(1, Number(event.target.value) || 4) })}
                placeholder="4"
              />
            </SettingsField>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function PriorityField({ value, onChange }: { value: unknown; onChange: (priority: number) => void }) {
  const { t } = useTranslation();
  return (
    <SettingsField label={t("settings:mcp.priority")} hint={t("settings:mcp.priority_hint")}>
      <Input
        type="number"
        className="w-32"
        value={numberText(value)}
        onChange={(event) => onChange(Number(event.target.value))}
        placeholder="0"
      />
    </SettingsField>
  );
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
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const bodyId = React.useId();
  const patch = (next: Partial<Record<string, unknown>>) => onChange({ ...entry, ...next });
  const keywords = Array.isArray(entry.keywords) ? entry.keywords.map(String) : [];
  const constantActive = entry.constantActive === true;
  const enabled = entry.enabled !== false;
  const title = textValue(entry.name) || t("settings:mcp.entry_n", { n: index + 1 });
  const triggerSummary = constantActive
    ? t("settings:mcp.constant_active")
    : keywords.length > 0
      ? t("settings:mcp.keywords_count", { count: keywords.length })
      : t("settings:mcp.no_trigger");
  const advancedAttention =
    Number(entry.scanDepth ?? 4) !== 4 ||
    entry.useRegex === true ||
    entry.caseSensitive === true ||
    Number(entry.priority ?? 0) !== 0;
  return (
    <div className="rounded-[var(--ds-radius-md)] border">
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span
            aria-hidden
            className={cn("size-2 shrink-0 rounded-full", enabled ? "bg-success" : "bg-muted-foreground/40")}
          />
          <span className="truncate text-sm font-medium">{title}</span>
          <span className="shrink-0 text-xs text-[var(--ds-text-secondary)]">· {triggerSummary}</span>
        </button>
        <Switch
          checked={enabled}
          aria-label={t("settings:mcp.enable_entry")}
          onCheckedChange={(checked) => patch({ enabled: checked })}
        />
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={expanded ? t("settings:mcp.server.collapse") : t("settings:mcp.server.expand")}
          onClick={() => setExpanded((value) => !value)}
        >
          <ExpandChevron expanded={expanded} />
        </Button>
      </div>
      {expanded ? (
        <div id={bodyId} className="space-y-5 border-t border-[var(--ds-divider)] px-3 py-4">
          <SettingsField label={t("settings:mcp.name")}>
            <Input
              value={textValue(entry.name)}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder={t("settings:mcp.entry_name_ph")}
            />
          </SettingsField>
          <SettingsRows>
            <SettingsSwitchRow
              label={t("settings:mcp.constant_active")}
              description={t("settings:mcp.constant_active_desc")}
              checked={constantActive}
              onCheckedChange={(checked) => patch({ constantActive: checked })}
            />
          </SettingsRows>
          <SettingsField label={t("settings:mcp.keywords_label")} hint={t("settings:mcp.keywords_hint")}>
            <KeywordChipInput
              keywords={keywords}
              disabled={constantActive}
              onChange={(next) => patch({ keywords: next })}
            />
          </SettingsField>
          <SettingsField label={t("settings:mcp.inject_content")}>
            <Textarea
              value={textValue(entry.content)}
              onChange={(event) => patch({ content: event.target.value })}
              className="min-h-32 font-mono text-xs leading-relaxed"
              placeholder={t("settings:mcp.inject_content_ph")}
            />
          </SettingsField>
          <InjectionPlacementFields value={entry} onChange={patch} />
          <SettingsAdvancedSection open={advancedOpen} onOpenChange={setAdvancedOpen} attention={advancedAttention}>
            <div className="space-y-5 pt-2">
              <SettingsField label={t("settings:mcp.scan_depth")} hint={t("settings:mcp.scan_depth_hint")}>
                <Input
                  type="number"
                  min={1}
                  className="w-32"
                  value={numberText(entry.scanDepth ?? 4)}
                  onChange={(event) => patch({ scanDepth: Math.max(1, Number(event.target.value) || 4) })}
                  placeholder="4"
                />
              </SettingsField>
              <SettingsRows>
                <SettingsSwitchRow
                  label={t("settings:mcp.use_regex")}
                  checked={entry.useRegex === true}
                  disabled={constantActive}
                  onCheckedChange={(checked) => patch({ useRegex: checked })}
                />
                <SettingsSwitchRow
                  label={t("settings:mcp.case_sensitive")}
                  checked={entry.caseSensitive === true}
                  disabled={constantActive}
                  onCheckedChange={(checked) => patch({ caseSensitive: checked })}
                />
              </SettingsRows>
              <PriorityField value={entry.priority} onChange={(priority) => patch({ priority })} />
            </div>
          </SettingsAdvancedSection>
          <div className="flex justify-end">
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
        "flex min-h-9 flex-wrap items-center gap-1 rounded-[var(--ds-radius-md)] bg-[var(--ds-surface-input)] px-2 py-1.5 shadow-[var(--ds-input-shadow)] transition-shadow focus-within:shadow-[var(--ds-input-shadow-focus)]",
        disabled && "opacity-50",
      )}
    >
      {keywords.map((keyword) => (
        <span
          key={keyword}
          className="inline-flex items-center gap-0.5 rounded-full bg-[var(--ds-on-surface)] py-0.5 pr-1 pl-2 text-xs"
        >
          {keyword}
          <button
            type="button"
            className="rounded-full p-0.5 text-[var(--ds-icon)] hover:text-[var(--ds-text-primary)]"
            disabled={disabled}
            aria-label={t("settings:mcp.remove_keyword", { keyword })}
            onClick={() => onChange(keywords.filter((item) => item !== keyword))}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        className="min-w-32 flex-1 bg-transparent text-xs text-[var(--ds-text-primary)] outline-none placeholder:text-[var(--ds-text-tertiary)]"
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
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
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
  // 删除收口到列表行(右键/悬停「⋯」):按目标行 id 删,不再依赖右侧草稿。
  const removeLorebookById = async (targetId: string) => {
    const target = items.find((item) => String(item.id) === targetId);
    if (!target) return;
    if (!(await confirmDialog({ title: t("settings:mcp.lorebook.delete_confirm", { name: textValue(target.name) }), danger: true }))) return;
    // 防复活:仅当删的是正在编辑的那条才 discard;删除后显式选中下一条(复审 F1/F2)
    const removingActive = String(draft.id) === targetId;
    if (removingActive) await autosave.discard();
    const remaining = items.filter((item) => String(item.id) !== targetId);
    await api.delete(`settings/lorebook/${targetId}`);
    await pullSettings(onSettings);
    if (removingActive) {
      if (remaining.length) setSelectedId(String(remaining[0].id));
      else setDraft(clone(createLorebook()));
    }
  };
  return (
    <EditorShell
      items={items}
      selectedId={selectedId}
      emptyLabel={t("settings:mcp.lorebook.empty")}
      onSelect={setSelectedId}
      titleOf={(item) => textValue(item.name) || t("settings:mcp.tab.lorebook")}
      rowMenuOf={(item) => {
        const id = String(item.id ?? "");
        return id ? { onDelete: () => removeLorebookById(id) } : undefined;
      }}
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
      <div className="@container">
        <SettingsStack>
          <SettingsDetailHeader
            title={textValue(draft.name) || t("settings:mcp.tab.lorebook")}
            description={t("settings:mcp.lorebook.page_desc")}
            action={
              <BindingSwitch
                checked={(assistant.lorebookIds ?? []).includes(String(draft.id))}
                onCheckedChange={(checked) => void bind(checked)}
              />
            }
          />

          <SettingsGroup fields>
            <SettingsField label={t("settings:mcp.name")}>
              <Input
                value={textValue(draft.name)}
                onChange={(event) => patchDraft({ name: event.target.value })}
                placeholder={t("settings:mcp.lorebook.name_ph")}
              />
            </SettingsField>
            <SettingsField label={t("settings:mcp.lorebook.desc")}>
              <Input
                value={textValue(draft.description)}
                onChange={(event) => patchDraft({ description: event.target.value })}
                placeholder={t("settings:mcp.lorebook.desc_ph")}
              />
            </SettingsField>
          </SettingsGroup>

          <SettingsGroup
            title={t("settings:mcp.entries_count", { count: entries.length })}
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setEntries([...entries, createLorebookEntry()])}
              >
                <Plus className="size-4" />
                {t("settings:mcp.add_entry")}
              </Button>
            }
            fields
          >
            {entries.length === 0 ? (
              <div className="rounded-[var(--ds-radius-md)] border border-dashed px-3 py-8 text-center text-sm text-[var(--ds-text-secondary)]">
                {t("settings:mcp.no_entries")}
              </div>
            ) : (
              <div className="space-y-2">
                {entries.map((entry, index) => (
                  <LorebookEntryRow
                    key={String(entry.id ?? index)}
                    entry={entry}
                    index={index}
                    onChange={(next) => setEntries(entries.map((item, idx) => (idx === index ? next : item)))}
                    onDelete={() => setEntries(entries.filter((_, idx) => idx !== index))}
                  />
                ))}
              </div>
            )}
          </SettingsGroup>

          <SettingsAdvancedSection
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            attention={draft.enabled === false}
          >
            <SettingsRows>
              <SettingsSwitchRow
                label={t("settings:mcp.lorebook.enable")}
                description={t("settings:mcp.global_enable_desc")}
                checked={draft.enabled !== false}
                onCheckedChange={(checked) => patchDraft({ enabled: checked })}
              />
            </SettingsRows>
          </SettingsAdvancedSection>

          <SettingsDetailFooter
            status={<AutosaveStatusRow status={autosave.status} onRetry={() => void autosave.saveNow()} className="px-0" />}
          />
        </SettingsStack>
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
  // 「高级设置」展开态:切换条目不收起,离开本页(重挂载)复位为收起。
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
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
  // 删除收口到列表行(右键/悬停「⋯」):按目标行 id 删,不再依赖右侧草稿。
  const removeInjectionById = async (targetId: string) => {
    const target = items.find((item) => String(item.id) === targetId);
    if (!target) return;
    if (!(await confirmDialog({ title: t("settings:mcp.inject_delete_confirm", { name: textValue(target.name) }), danger: true }))) return;
    // 防复活:仅当删的是正在编辑的那条才 discard;删除后显式选中下一条(复审 F1/F2)
    const removingActive = String(draft.id) === targetId;
    if (removingActive) await autosave.discard();
    const remaining = items.filter((item) => String(item.id) !== targetId);
    await api.delete(`${deletePath}/${targetId}`);
    await pullSettings(onSettings);
    if (removingActive) {
      if (remaining.length) setSelectedId(String(remaining[0].id));
      else setDraft(clone(createItem()));
    }
  };
  return (
    <EditorShell
      items={items}
      selectedId={selectedId}
      emptyLabel={t("settings:mcp.empty_item", { title })}
      onSelect={setSelectedId}
      titleOf={(item) => textValue(item.name) || title}
      rowMenuOf={(item) => {
        const id = String(item.id ?? "");
        return id ? { onDelete: () => removeInjectionById(id) } : undefined;
      }}
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
      <div className="@container">
        <SettingsStack>
          <SettingsDetailHeader
            title={textValue(draft.name) || title}
            description={t("settings:mcp.mode_page_desc")}
            action={
              <BindingSwitch
                checked={(assistant[bindKey] ?? []).includes(String(draft.id))}
                onCheckedChange={(checked) => void bind(checked)}
              />
            }
          />

          <SettingsGroup fields>
            <SettingsField label={t("settings:mcp.name")}>
              <Input
                value={textValue(draft.name)}
                onChange={(event) => patchDraft({ name: event.target.value })}
                placeholder={title}
              />
            </SettingsField>
            <SettingsField label={t("settings:mcp.inject_content")}>
              <Textarea
                value={textValue(draft.content)}
                onChange={(event) => patchDraft({ content: event.target.value })}
                className="min-h-48 font-mono text-xs leading-relaxed"
                placeholder={t("settings:mcp.inject_content_template_ph", { cur_datetime: "{{cur_datetime}}" })}
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-[var(--ds-text-secondary)]">{t("settings:mcp.template_vars")}</span>
                {PROMPT_VARIABLES.map((variable) => (
                  <Button key={variable} type="button" size="xs" variant="outline" onClick={() => appendVariable(variable)}>
                    {variable}
                  </Button>
                ))}
              </div>
            </SettingsField>
            <InjectionPlacementFields value={draft} onChange={patchDraft} />
          </SettingsGroup>

          <SettingsAdvancedSection
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            attention={draft.enabled === false || Number(draft.priority ?? 0) !== 0}
          >
            <div className="space-y-5 pt-2">
              <PriorityField value={draft.priority} onChange={(priority) => patchDraft({ priority })} />
              <SettingsRows>
                <SettingsSwitchRow
                  label={t("settings:mcp.enabled")}
                  description={t("settings:mcp.global_enable_desc")}
                  checked={draft.enabled !== false}
                  onCheckedChange={(checked) => patchDraft({ enabled: checked })}
                />
              </SettingsRows>
            </div>
          </SettingsAdvancedSection>

          <SettingsDetailFooter
            status={<AutosaveStatusRow status={autosave.status} onRetry={() => void autosave.saveNow()} className="px-0" />}
          />
        </SettingsStack>
      </div>
    </EditorShell>
  );
}
