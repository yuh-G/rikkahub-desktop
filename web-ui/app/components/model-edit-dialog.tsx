import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { getModelDisplayName } from "~/lib/display";
import { prettifyModelId } from "@server/model-providers/model-name-heuristic";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";
import { confirmDialog } from "~/stores/confirm-store";
import type {
  BuiltInTool,
  BuiltInToolType,
  CustomBody,
  CustomHeader,
  ModelAbility,
  ModelModality,
  ModelType,
  ProviderModel,
  ProviderOverwrite,
} from "~/types/settings";

// Mirrors Android's ModelType segmented selector (CHAT/IMAGE/EMBEDDING). Server-side audit
// (pc-server, api/handlers/settings.ts + model-providers) only routes "IMAGE" today — "EMBEDDING" is declared but unused.
// We surface it anyway because Android has it and the upstream JSON schema accepts it.
const TYPE_OPTIONS: { value: ModelType; labelKey: string }[] = [
  { value: "CHAT", labelKey: "model_edit.type_chat" },
  { value: "IMAGE", labelKey: "model_edit.type_image" },
  { value: "EMBEDDING", labelKey: "model_edit.type_embedding" },
];

// Android only has TEXT/IMAGE today; PC kept the wider list because some providers
// (Gemini, GPT-4o) advertise audio/video/document inputs. Server-side, only
// outputModalities="IMAGE" is acted on for OpenRouter; the rest is metadata-only —
// kept for forward-compat. See pc-server/model-providers/index.ts.
//
// Issue #11: 移动端 Modality 枚举只有 TEXT/IMAGE,PC 导出含 AUDIO/VIDEO/DOCUMENT 的备份
// 会让移动端反序列化崩溃。因此:
// - DOCUMENT 永久移除(LLM 体系不存在"文档"模态);
// - AUDIO/VIDEO 保留为灰显占位——保持 UI 一致性 + 为未来音视频对话能力留接口,当前不可勾选;
// - 导出时由后端 sanitizeModelModalitiesForExport 统一剥离这三个值,老数据里的脏值也不会
//   写进备份文件。
const MODALITY_OPTIONS: { value: ModelModality; labelKey: string; disabled?: boolean }[] = [
  { value: "TEXT", labelKey: "model_edit.modality_text" },
  { value: "IMAGE", labelKey: "model_edit.modality_image" },
  { value: "AUDIO", labelKey: "model_edit.modality_audio", disabled: true },
  { value: "VIDEO", labelKey: "model_edit.modality_video", disabled: true },
  // DOCUMENT 永久移除:LLM 无"文档"模态
];

const ABILITY_OPTIONS: { value: ModelAbility; labelKey: string; hintKey: string }[] = [
  { value: "TOOL", labelKey: "model_edit.ability_tool", hintKey: "model_edit.ability_tool_hint" },
  { value: "REASONING", labelKey: "model_edit.ability_reasoning", hintKey: "model_edit.ability_reasoning_hint" },
];

// `url_context` is declared in Android but the PC server has no code path that maps it
// to a provider-specific tool — surfacing it would be a UI shell. Skipping for now.
const BUILTIN_TOOL_OPTIONS: { value: BuiltInToolType; labelKey: string; hintKey: string }[] = [
  { value: "search", labelKey: "model_edit.tool_search", hintKey: "model_edit.tool_search_hint" },
  { value: "image_generation", labelKey: "model_edit.tool_image_generation", hintKey: "model_edit.tool_image_generation_hint" },
];

const TAB_BASIC = "basic";
const TAB_ADVANCED = "advanced";
const TAB_TOOLS = "tools";
type TabId = typeof TAB_BASIC | typeof TAB_ADVANCED | typeof TAB_TOOLS;

const TABS: { id: TabId; labelKey: string }[] = [
  { id: TAB_BASIC, labelKey: "model_edit.tab_basic" },
  { id: TAB_ADVANCED, labelKey: "model_edit.tab_advanced" },
  { id: TAB_TOOLS, labelKey: "model_edit.tab_tools" },
];

export interface ModelEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "add" | "edit";
  initialModel: ProviderModel;
  /**
   * Locks the modelId input. True for models that came from 获取模型列表 — editing the ID
   * would silently break upstream request routing because pc-server sends modelId verbatim
   * as the `model:` field in every request (pc-server/inference-engine/providers.ts). For manually-added
   * models the ID is editable; the user owns it.
   */
  modelIdLocked: boolean;
  onSave: (model: ProviderModel) => void;
  onDelete?: () => void;
}

function toArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

function normalizeBuiltInToolList(tools: BuiltInTool[] | undefined): BuiltInTool[] {
  if (!Array.isArray(tools)) return [];
  // Android stores BuiltInTools as `{ type: "search" | "url_context" | "image_generation" }`.
  // Keep the raw shape; only normalize the `type` to lowercase to be lenient with old data.
  return tools.map((tool) => ({
    ...tool,
    type: typeof tool.type === "string" ? tool.type.toLowerCase() : tool.type,
  }));
}

function isToolActive(tools: BuiltInTool[], target: BuiltInToolType): boolean {
  return tools.some((tool) => tool.type === target);
}

function toggleToolInList(
  tools: BuiltInTool[],
  target: BuiltInToolType,
  enabled: boolean,
): BuiltInTool[] {
  const without = tools.filter((tool) => tool.type !== target);
  return enabled ? [...without, { type: target }] : without;
}

function modalityToggle(
  values: ModelModality[],
  target: ModelModality,
  enabled: boolean,
): ModelModality[] {
  const set = new Set(values);
  if (enabled) set.add(target);
  else set.delete(target);
  // Preserve a canonical order so save → reload doesn't reshuffle for UI noise.
  return MODALITY_OPTIONS.map((opt) => opt.value).filter((value) => set.has(value));
}

function abilityToggle(
  values: ModelAbility[],
  target: ModelAbility,
  enabled: boolean,
): ModelAbility[] {
  const set = new Set(values);
  if (enabled) set.add(target);
  else set.delete(target);
  return ABILITY_OPTIONS.map((opt) => opt.value).filter((value) => set.has(value));
}

export function ModelEditDialog({
  open,
  onOpenChange,
  mode,
  initialModel,
  modelIdLocked,
  onSave,
  onDelete,
}: ModelEditDialogProps) {
  const { t } = useTranslation("settings");
  const [draft, setDraft] = React.useState<ProviderModel>(initialModel);
  const [tab, setTab] = React.useState<TabId>(TAB_BASIC);
  const [error, setError] = React.useState<string | null>(null);
  // displayName 是否被用户手动编辑过(add 模式的预填跟随开关):一旦触碰永久停止跟随
  // modelId 输入的预填,后续改 modelId 绝不覆盖用户输入的任何字符。
  const [displayNameDirty, setDisplayNameDirty] = React.useState(false);

  // Reset draft whenever the dialog opens with a new model — critical for the "click row → edit"
  // flow where the same dialog instance is reused across many different models.
  React.useEffect(() => {
    if (open) {
      setDraft({
        ...initialModel,
        inputModalities: toArray(initialModel.inputModalities),
        outputModalities: toArray(initialModel.outputModalities),
        abilities: toArray(initialModel.abilities),
        tools: normalizeBuiltInToolList(initialModel.tools),
        customHeaders: toArray<CustomHeader>(initialModel.customHeaders),
        customBodies: toArray<CustomBody>(initialModel.customBodies),
      });
      setDisplayNameDirty((initialModel.displayName ?? "").trim().length > 0);
      setTab(TAB_BASIC);
      setError(null);
    }
  }, [open, initialModel]);

  const update = <K extends keyof ProviderModel>(key: K, value: ProviderModel[K]) => {
    if (key === "displayName") setDisplayNameDirty(true);
    // add 模式的预填跟随:用户没动过名字框时,modelId 每次输入都把启发式规整名同步进
    // 名字框(所见即所得,保存的即规整名);用户一旦动手,跟随即永久关闭。
    if (key === "modelId" && mode === "add" && !displayNameDirty) {
      const suggested = prettifyModelId(String(value ?? ""));
      setDraft((current) => ({ ...current, modelId: String(value), displayName: suggested }));
      return;
    }
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const handleSave = () => {
    const modelId = (draft.modelId ?? "").trim();
    const displayName = (draft.displayName ?? "").trim();

    if (mode === "add" && !modelId) {
      setError(t("model_edit.error_model_id_required"));
      setTab(TAB_BASIC);
      return;
    }
    if (!displayName) {
      setError(t("model_edit.error_display_name_required"));
      setTab(TAB_BASIC);
      return;
    }
    // Validate customHeaders/customBodies have non-empty keys — otherwise the merge code
    // (pc-server/model-providers/index.ts) would push `headers[""] = …` which is a footgun.
    const headers = toArray<CustomHeader>(draft.customHeaders);
    if (headers.some((header) => !(header.name ?? "").trim())) {
      setError(t("model_edit.error_header_name_missing"));
      setTab(TAB_ADVANCED);
      return;
    }
    const bodies = toArray<CustomBody>(draft.customBodies);
    if (bodies.some((body) => !(body.key ?? "").trim())) {
      setError(t("model_edit.error_body_key_missing"));
      setTab(TAB_ADVANCED);
      return;
    }

    onSave({
      ...draft,
      modelId,
      displayName,
      inputModalities: toArray(draft.inputModalities),
      outputModalities: toArray(draft.outputModalities),
      abilities: toArray(draft.abilities),
      tools: normalizeBuiltInToolList(draft.tools),
      customHeaders: headers.map((header) => ({
        name: (header.name ?? "").trim(),
        value: header.value ?? "",
      })),
      customBodies: bodies.map((body) => ({
        key: (body.key ?? "").trim(),
        value: body.value,
      })),
    });
    onOpenChange(false);
  };

  const isChat = draft.type === "CHAT" || !draft.type;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{mode === "add" ? t("model_edit.title_add") : t("model_edit.title_edit")}</DialogTitle>
          <DialogDescription>
            {mode === "add"
              ? t("model_edit.desc_add")
              : modelIdLocked
                ? t("model_edit.desc_locked")
                : t("model_edit.desc_manual")}
          </DialogDescription>
        </DialogHeader>

        {/* Tab bar */}
        <div className="flex border-b">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={cn(
                "border-b-2 px-4 py-2 text-sm transition",
                tab === item.id
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </div>

        <ScrollArea className="max-h-[60vh]">
          <div className="pr-3">
            {tab === TAB_BASIC && (
              <BasicTab
                draft={draft}
                modelIdLocked={modelIdLocked}
                isChat={isChat}
                onUpdate={update}
                onSetModalities={(direction, modality, enabled) => {
                  const key = direction === "input" ? "inputModalities" : "outputModalities";
                  update(key, modalityToggle(toArray(draft[key]), modality, enabled));
                }}
                onSetAbility={(ability, enabled) => {
                  update("abilities", abilityToggle(toArray(draft.abilities), ability, enabled));
                }}
              />
            )}
            {tab === TAB_ADVANCED && (
              <AdvancedTab
                headers={toArray<CustomHeader>(draft.customHeaders)}
                bodies={toArray<CustomBody>(draft.customBodies)}
                providerOverwrite={draft.providerOverwrite ?? null}
                onHeadersChange={(headers) => update("customHeaders", headers)}
                onBodiesChange={(bodies) => update("customBodies", bodies)}
                onProviderOverwriteChange={(overwrite) => update("providerOverwrite", overwrite)}
              />
            )}
            {tab === TAB_TOOLS && (
              <ToolsTab
                tools={normalizeBuiltInToolList(draft.tools)}
                isChat={isChat}
                onToolToggle={(target, enabled) => {
                  update(
                    "tools",
                    toggleToolInList(normalizeBuiltInToolList(draft.tools), target, enabled),
                  );
                }}
              />
            )}
          </div>
        </ScrollArea>

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
          {mode === "edit" && onDelete ? (
            <Button
              type="button"
              variant="outline"
              className="text-destructive hover:bg-destructive/10"
              onClick={async () => {
                if (await confirmDialog({ title: t("model_edit.delete_confirm", { name: getModelDisplayName(draft.displayName, draft.modelId) }), danger: true })) {
                  onDelete();
                  onOpenChange(false);
                }
              }}
            >
              <Trash2 className="size-4" />
              {t("model_edit.delete")}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("model_edit.cancel")}
            </Button>
            <Button type="button" onClick={handleSave}>
              {t("model_edit.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface BasicTabProps {
  draft: ProviderModel;
  modelIdLocked: boolean;
  isChat: boolean;
  onUpdate: <K extends keyof ProviderModel>(key: K, value: ProviderModel[K]) => void;
  onSetModalities: (
    direction: "input" | "output",
    modality: ModelModality,
    enabled: boolean,
  ) => void;
  onSetAbility: (ability: ModelAbility, enabled: boolean) => void;
}

function BasicTab({
  draft,
  modelIdLocked,
  isChat,
  onUpdate,
  onSetModalities,
  onSetAbility,
}: BasicTabProps) {
  const { t } = useTranslation("settings");
  const inputModalities = toArray(draft.inputModalities);
  const outputModalities = toArray(draft.outputModalities);
  const abilities = toArray(draft.abilities);

  return (
    <div className="space-y-4 py-3">
      <Field
        label={t("model_edit.model_id")}
        hint={
          modelIdLocked
            ? t("model_edit.model_id_hint_locked")
            : t("model_edit.model_id_hint")
        }
      >
        <Input
          value={draft.modelId ?? ""}
          disabled={modelIdLocked}
          onChange={(event) => onUpdate("modelId", event.target.value.trim())}
          placeholder={t("model_edit.model_id_placeholder")}
        />
      </Field>

      <Field label={t("model_edit.display_name")} hint={t("model_edit.display_name_hint")}>
        <Input
          value={draft.displayName ?? ""}
          onChange={(event) => onUpdate("displayName", event.target.value)}
          placeholder={t("model_edit.display_name_placeholder")}
        />
      </Field>

      <Field
        label={t("model_edit.model_type")}
        hint={t("model_edit.model_type_hint")}
      >
        <SegmentedRow
          options={TYPE_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
          value={[draft.type ?? "CHAT"]}
          onToggle={(value, _enabled) => onUpdate("type", value)}
          singleSelect
        />
      </Field>

      {isChat ? (
        <>
          <Field label={t("model_edit.input_modalities")} hint={t("model_edit.input_modalities_hint")}>
            <SegmentedRow
              options={MODALITY_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey), disabled: option.disabled }))}
              value={inputModalities}
              onToggle={(value, enabled) => onSetModalities("input", value, enabled)}
            />
          </Field>

          <Field
            label={t("model_edit.output_modalities")}
            hint={t("model_edit.output_modalities_hint")}
          >
            <SegmentedRow
              options={MODALITY_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey), disabled: option.disabled }))}
              value={outputModalities}
              onToggle={(value, enabled) => onSetModalities("output", value, enabled)}
            />
          </Field>

          <Field label={t("model_edit.abilities")}>
            <div className="space-y-2">
              {ABILITY_OPTIONS.map((option) => (
                <div
                  key={option.value}
                  className="flex items-start justify-between gap-3 rounded-md border px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{t(option.labelKey)}</div>
                    <div className="text-xs text-muted-foreground">{t(option.hintKey)}</div>
                  </div>
                  <Switch
                    checked={abilities.includes(option.value)}
                    onCheckedChange={(checked) => onSetAbility(option.value, checked === true)}
                  />
                </div>
              ))}
            </div>
          </Field>
        </>
      ) : (
        <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          {draft.type === "IMAGE"
            ? t("model_edit.not_chat_image")
            : t("model_edit.not_chat_embedding")}
        </div>
      )}
    </div>
  );
}

interface AdvancedTabProps {
  headers: CustomHeader[];
  bodies: CustomBody[];
  providerOverwrite: ProviderOverwrite | null | undefined;
  onHeadersChange: (headers: CustomHeader[]) => void;
  onBodiesChange: (bodies: CustomBody[]) => void;
  onProviderOverwriteChange: (overwrite: ProviderOverwrite | null) => void;
}

function AdvancedTab({
  headers,
  bodies,
  providerOverwrite,
  onHeadersChange,
  onBodiesChange,
  onProviderOverwriteChange,
}: AdvancedTabProps) {
  const { t } = useTranslation("settings");
  const updateHeader = (index: number, patch: Partial<CustomHeader>) => {
    onHeadersChange(headers.map((header, i) => (i === index ? { ...header, ...patch } : header)));
  };
  const removeHeader = (index: number) => {
    onHeadersChange(headers.filter((_, i) => i !== index));
  };
  const addHeader = () => {
    onHeadersChange([...headers, { name: "", value: "" }]);
  };

  const updateBody = (index: number, patch: Partial<CustomBody>) => {
    onBodiesChange(bodies.map((body, i) => (i === index ? { ...body, ...patch } : body)));
  };
  const removeBody = (index: number) => {
    onBodiesChange(bodies.filter((_, i) => i !== index));
  };
  const addBody = () => {
    onBodiesChange([...bodies, { key: "", value: "" }]);
  };

  return (
    <div className="space-y-5 py-3">
      <ProviderOverwriteSection
        overwrite={providerOverwrite ?? null}
        onChange={onProviderOverwriteChange}
      />
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">{t("model_edit.custom_headers")}</div>
            <div className="text-xs text-muted-foreground">
              {t("model_edit.custom_headers_hint")}
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addHeader}>
            <Plus className="size-4" />
            {t("model_edit.add")}
          </Button>
        </div>
        {headers.length === 0 ? (
          <div className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
            {t("model_edit.no_custom_headers")}
          </div>
        ) : (
          <div className="space-y-2">
            {headers.map((header, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  placeholder={t("model_edit.header_name_placeholder")}
                  className="flex-1"
                  value={header.name}
                  onChange={(event) => updateHeader(index, { name: event.target.value })}
                />
                <Input
                  placeholder={t("model_edit.header_value_placeholder")}
                  className="flex-[2]"
                  value={header.value}
                  onChange={(event) => updateHeader(index, { value: event.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeHeader(index)}
                  aria-label={t("model_edit.remove")}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">{t("model_edit.custom_bodies")}</div>
            <div className="text-xs text-muted-foreground">
              {t("model_edit.custom_bodies_hint")}
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addBody}>
            <Plus className="size-4" />
            {t("model_edit.add")}
          </Button>
        </div>
        {bodies.length === 0 ? (
          <div className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
            {t("model_edit.no_custom_bodies")}
          </div>
        ) : (
          <div className="space-y-2">
            {bodies.map((body, index) => (
              <CustomBodyRow
                key={index}
                body={body}
                onChange={(patch) => updateBody(index, patch)}
                onRemove={() => removeBody(index)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

const PROVIDER_OVERWRITE_TYPES: { value: ProviderOverwrite["type"]; labelKey: string }[] = [
  { value: "openai", labelKey: "model_edit.overwrite_type_openai" },
  { value: "claude", labelKey: "model_edit.overwrite_type_claude" },
  { value: "google", labelKey: "model_edit.overwrite_type_google" },
];

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  claude: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
};

/**
 * UI for editing `Model.providerOverwrite`. Two-state widget:
 *   - When `overwrite` is null → show a "配置供应商覆盖" button to start using one.
 *   - When `overwrite` is set → show inline editable fields (type, name, baseUrl, apiKey)
 *     and a "清除覆盖" button to remove it.
 *
 * Mirrors Android's `ProviderOverrideSettings` composable
 * (SettingProviderDetailPage.kt:1423-1565). The override merge happens server-side in
 * `findModel()` (pc-server/server.ts) — when this object is non-null on a model, the
 * model's outbound request uses these credentials instead of the parent provider's.
 */
function ProviderOverwriteSection({
  overwrite,
  onChange,
}: {
  overwrite: ProviderOverwrite | null;
  onChange: (next: ProviderOverwrite | null) => void;
}) {
  const { t } = useTranslation("settings");
  const enable = () => {
    onChange({
      type: "openai",
      name: t("model_edit.provider_overwrite"),
      baseUrl: DEFAULT_BASE_URLS.openai,
      apiKey: "",
    });
  };
  const update = (patch: Partial<ProviderOverwrite>) => {
    if (!overwrite) return;
    onChange({ ...overwrite, ...patch });
  };
  const clear = () => onChange(null);

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">{t("model_edit.provider_overwrite")}</div>
          <div className="text-xs text-muted-foreground">
            {t("model_edit.provider_overwrite_hint")}
          </div>
        </div>
        {overwrite ? (
          <Button type="button" variant="outline" size="sm" onClick={clear}>
            <Trash2 className="size-4" />
            {t("model_edit.clear_overwrite")}
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={enable}>
            <Plus className="size-4" />
            {t("model_edit.configure_overwrite")}
          </Button>
        )}
      </div>
      {overwrite ? (
        <div className="space-y-3 rounded-md border p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <div className="text-xs font-medium">{t("model_edit.protocol_type")}</div>
              <Select
                value={overwrite.type}
                onValueChange={(value) => {
                  // Switching type also resets baseUrl to that protocol's default — saves
                  // the user from having to hand-clear an OpenAI URL when switching to Claude.
                  const defaultUrl = DEFAULT_BASE_URLS[value] ?? overwrite.baseUrl;
                  update({
                    type: value,
                    baseUrl:
                      overwrite.baseUrl === DEFAULT_BASE_URLS[overwrite.type]
                        ? defaultUrl
                        : overwrite.baseUrl,
                  });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_OVERWRITE_TYPES.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium">{t("model_edit.display_name")}</div>
              <Input
                value={overwrite.name}
                onChange={(event) => update({ name: event.target.value })}
                placeholder={t("model_edit.provider_overwrite")}
              />
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium">Base URL</div>
            <Input
              value={overwrite.baseUrl}
              onChange={(event) => update({ baseUrl: event.target.value })}
              placeholder={t("model_edit.base_url_placeholder")}
            />
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium">API Key</div>
            <Input
              type="password"
              value={overwrite.apiKey}
              onChange={(event) => update({ apiKey: event.target.value })}
              placeholder="sk-..."
              autoComplete="off"
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function CustomBodyRow({
  body,
  onChange,
  onRemove,
}: {
  body: CustomBody;
  onChange: (patch: Partial<CustomBody>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("settings");
  // The user types JSON; we store the parsed value so the merge code can deep-merge objects.
  // If parsing fails we keep the raw string and surface a hint — better than silently dropping.
  const [rawValue, setRawValue] = React.useState<string>(() => stringifyBodyValue(body.value));
  const [parseError, setParseError] = React.useState<string | null>(null);

  // Keep rawValue in sync if the upstream value resets (e.g. dialog reopened with new model).
  React.useEffect(() => {
    setRawValue(stringifyBodyValue(body.value));
    setParseError(null);
  }, [body.value]);

  const commit = (next: string) => {
    setRawValue(next);
    const trimmed = next.trim();
    if (trimmed === "") {
      setParseError(null);
      onChange({ value: "" });
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      setParseError(null);
      onChange({ value: parsed });
    } catch {
      // Keep raw string — at least the user's typing isn't lost. Surface error.
      setParseError(t("model_edit.json_parse_error"));
      onChange({ value: next });
    }
  };

  return (
    <div className="space-y-1 rounded-md border p-2">
      <div className="flex items-start gap-2">
        <Input
          placeholder={t("model_edit.body_key_placeholder")}
          className="flex-1"
          value={body.key}
          onChange={(event) => onChange({ key: event.target.value })}
        />
        <Button type="button" variant="ghost" size="icon" onClick={onRemove} aria-label={t("model_edit.remove")}>
          <Trash2 className="size-4" />
        </Button>
      </div>
      <Textarea
        placeholder={t("model_edit.body_value_placeholder")}
        className="font-mono text-xs"
        rows={2}
        value={rawValue}
        onChange={(event) => commit(event.target.value)}
      />
      {parseError ? (
        <div className="text-xs text-warning">{parseError}</div>
      ) : null}
    </div>
  );
}

function stringifyBodyValue(value: unknown): string {
  // 字符串要 JSON.stringify 回显成带引号的形式("max"),与占位符 "hello" 的语法提示自洽——
  // 否则用户输入带引号的字符串后被解析存成裸串,这里原样回显会把引号"吞掉",让人误以为没输进去。
  // 后端 decodeCustomBodyValue 对带/不带引号都解析成同一字符串,功能不变;回显带引号也仍能被 JSON.parse 回来。
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

interface ToolsTabProps {
  tools: BuiltInTool[];
  isChat: boolean;
  onToolToggle: (target: BuiltInToolType, enabled: boolean) => void;
}

function ToolsTab({ tools, isChat, onToolToggle }: ToolsTabProps) {
  const { t } = useTranslation("settings");
  if (!isChat) {
    return (
      <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground my-3">
        {t("model_edit.tools_chat_only")}
      </div>
    );
  }
  return (
    <div className="space-y-2 py-3">
      {BUILTIN_TOOL_OPTIONS.map((option) => (
        <div
          key={option.value}
          className="flex items-start justify-between gap-3 rounded-md border px-3 py-2"
        >
          <div className="min-w-0">
            <div className="text-sm font-medium">{t(option.labelKey)}</div>
            <div className="text-xs text-muted-foreground">{t(option.hintKey)}</div>
          </div>
          <Switch
            checked={isToolActive(tools, option.value)}
            onCheckedChange={(checked) => onToolToggle(option.value, checked === true)}
          />
        </div>
      ))}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-sm font-medium">{label}</div>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
      <div>{children}</div>
    </div>
  );
}

interface SegmentedRowProps<T extends string> {
  options: { value: T; label: string; disabled?: boolean }[];
  value: T[];
  onToggle: (value: T, enabled: boolean) => void;
  singleSelect?: boolean;
}

function SegmentedRow<T extends string>({
  options,
  value,
  onToggle,
  singleSelect,
}: SegmentedRowProps<T>) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-md border p-0.5">
      {options.map((option) => {
        const active = value.includes(option.value);
        const disabled = option.disabled === true;
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            onClick={() => {
              if (disabled) return;
              if (singleSelect) onToggle(option.value, true);
              else onToggle(option.value, !active);
            }}
            className={cn(
              "rounded px-3 py-1 text-xs transition",
              disabled
                ? "cursor-not-allowed text-muted-foreground/40"
                : active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
