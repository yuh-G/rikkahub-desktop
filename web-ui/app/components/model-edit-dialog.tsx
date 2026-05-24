import * as React from "react";
import { Plus, Trash2 } from "lucide-react";

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
// (pc-server/server.ts:9864) only routes "IMAGE" today — "EMBEDDING" is declared but unused.
// We surface it anyway because Android has it and the upstream JSON schema accepts it.
const TYPE_OPTIONS: { value: ModelType; label: string; hint?: string }[] = [
  { value: "CHAT", label: "聊天" },
  { value: "IMAGE", label: "图像生成" },
  { value: "EMBEDDING", label: "嵌入" },
];

// Android only has TEXT/IMAGE today; PC kept the wider list because some providers
// (Gemini, GPT-4o) advertise audio/video/document inputs. Server-side, only
// outputModalities="IMAGE" is acted on for OpenRouter; the rest is metadata-only —
// kept for forward-compat. See server.ts:5050.
const MODALITY_OPTIONS: { value: ModelModality; label: string }[] = [
  { value: "TEXT", label: "文本" },
  { value: "IMAGE", label: "图像" },
  { value: "AUDIO", label: "音频" },
  { value: "VIDEO", label: "视频" },
  { value: "DOCUMENT", label: "文档" },
];

const ABILITY_OPTIONS: { value: ModelAbility; label: string; hint: string }[] = [
  { value: "TOOL", label: "工具调用", hint: "启用后请求才会带 tools 字段（server.ts:6187 门控）" },
  { value: "REASONING", label: "推理输出", hint: "启用后请求才会带 thinking/reasoning 字段（server.ts:6192 门控）" },
];

// `url_context` is declared in Android but the PC server has no code path that maps it
// to a provider-specific tool — surfacing it would be a UI shell. Skipping for now.
const BUILTIN_TOOL_OPTIONS: { value: BuiltInToolType; label: string; hint: string }[] = [
  { value: "search", label: "联网搜索", hint: "Google: googleSearch；OpenAI Responses: web_search" },
  {
    value: "image_generation",
    label: "图像生成",
    hint: "OpenAI Responses 注入 image_generation 工具",
  },
];

const TAB_BASIC = "basic";
const TAB_ADVANCED = "advanced";
const TAB_TOOLS = "tools";
type TabId = typeof TAB_BASIC | typeof TAB_ADVANCED | typeof TAB_TOOLS;

const TABS: { id: TabId; label: string }[] = [
  { id: TAB_BASIC, label: "基础" },
  { id: TAB_ADVANCED, label: "高级" },
  { id: TAB_TOOLS, label: "内置工具" },
];

export interface ModelEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "add" | "edit";
  initialModel: ProviderModel;
  /**
   * Locks the modelId input. True for models that came from 获取模型列表 — editing the ID
   * would silently break upstream request routing because pc-server sends modelId verbatim
   * as the `model:` field in every request (server.ts:6158, 6168, 6313). For manually-added
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
  const [draft, setDraft] = React.useState<ProviderModel>(initialModel);
  const [tab, setTab] = React.useState<TabId>(TAB_BASIC);
  const [error, setError] = React.useState<string | null>(null);

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
      setTab(TAB_BASIC);
      setError(null);
    }
  }, [open, initialModel]);

  const update = <K extends keyof ProviderModel>(key: K, value: ProviderModel[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const handleSave = () => {
    const modelId = (draft.modelId ?? "").trim();
    const displayName = (draft.displayName ?? "").trim();

    if (mode === "add" && !modelId) {
      setError("请填写模型 ID（这是发送给上游 API 的 model 字段，不能为空）");
      setTab(TAB_BASIC);
      return;
    }
    if (!displayName) {
      setError("请填写显示名称");
      setTab(TAB_BASIC);
      return;
    }
    // Validate customHeaders/customBodies have non-empty keys — otherwise the merge code
    // (server.ts:5429, 5484) would push `headers[""] = …` which is a footgun.
    const headers = toArray<CustomHeader>(draft.customHeaders);
    if (headers.some((header) => !(header.name ?? "").trim())) {
      setError("自定义请求头有未填写的 name，请补全或删除该行");
      setTab(TAB_ADVANCED);
      return;
    }
    const bodies = toArray<CustomBody>(draft.customBodies);
    if (bodies.some((body) => !(body.key ?? "").trim())) {
      setError("自定义请求体有未填写的 key，请补全或删除该行");
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
          <DialogTitle>{mode === "add" ? "添加模型" : "编辑模型"}</DialogTitle>
          <DialogDescription>
            {mode === "add"
              ? "手动配置一个上游模型。模型 ID 必须与上游 API 期望的字符串一致。"
              : modelIdLocked
                ? "从供应商列表拉取的模型，模型 ID 不可修改（改了会破坏请求路由）。"
                : "手动添加的模型，所有字段都可编辑。"}
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
              {item.label}
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
              onClick={() => {
                if (window.confirm(`删除模型「${draft.displayName || draft.modelId}」？`)) {
                  onDelete();
                  onOpenChange(false);
                }
              }}
            >
              <Trash2 className="size-4" />
              删除
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="button" onClick={handleSave}>
              保存
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
  const inputModalities = toArray(draft.inputModalities);
  const outputModalities = toArray(draft.outputModalities);
  const abilities = toArray(draft.abilities);

  return (
    <div className="space-y-4 py-3">
      <Field
        label="模型 ID"
        hint={
          modelIdLocked
            ? "已锁定。这是发送给上游 API 的 model 字段，修改会导致请求失败。"
            : "上游 API 接收的 model 字符串（例如 gpt-4o-mini、claude-sonnet-4）。"
        }
      >
        <Input
          value={draft.modelId ?? ""}
          disabled={modelIdLocked}
          onChange={(event) => onUpdate("modelId", event.target.value.trim())}
          placeholder="例如：gpt-4o-mini"
        />
      </Field>

      <Field label="显示名称" hint="仅 UI 展示用，不会发到上游。">
        <Input
          value={draft.displayName ?? ""}
          onChange={(event) => onUpdate("displayName", event.target.value)}
          placeholder="例如：GPT-4o Mini"
        />
      </Field>

      <Field
        label="模型类型"
        hint="IMAGE 类型在测试图像端点会被作为默认模型挑选；EMBEDDING 目前未参与路由分发。"
      >
        <SegmentedRow
          options={TYPE_OPTIONS}
          value={[draft.type ?? "CHAT"]}
          onToggle={(value, _enabled) => onUpdate("type", value)}
          singleSelect
        />
      </Field>

      {isChat ? (
        <>
          <Field
            label="输入模态"
            hint="文本以外的模态今天仅作为元数据保存，不参与上游请求过滤。"
          >
            <SegmentedRow
              options={MODALITY_OPTIONS}
              value={inputModalities}
              onToggle={(value, enabled) => onSetModalities("input", value, enabled)}
            />
          </Field>

          <Field
            label="输出模态"
            hint="勾选 IMAGE 后，OpenRouter 路径会在请求体里加 modalities=['image','text']。"
          >
            <SegmentedRow
              options={MODALITY_OPTIONS}
              value={outputModalities}
              onToggle={(value, enabled) => onSetModalities("output", value, enabled)}
            />
          </Field>

          <Field label="能力">
            <div className="space-y-2">
              {ABILITY_OPTIONS.map((option) => (
                <div
                  key={option.value}
                  className="flex items-start justify-between gap-3 rounded-md border px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{option.label}</div>
                    <div className="text-xs text-muted-foreground">{option.hint}</div>
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
            ? "图像生成模型不使用模态/能力字段。"
            : "嵌入模型不使用模态/能力字段。"}
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

function AdvancedTab({ headers, bodies, providerOverwrite, onHeadersChange, onBodiesChange, onProviderOverwriteChange }: AdvancedTabProps) {
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
            <div className="text-sm font-medium">自定义请求头</div>
            <div className="text-xs text-muted-foreground">
              会注入到所有走这个模型的上游请求里（server.ts:5429）。
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addHeader}>
            <Plus className="size-4" />
            添加
          </Button>
        </div>
        {headers.length === 0 ? (
          <div className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
            没有自定义请求头
          </div>
        ) : (
          <div className="space-y-2">
            {headers.map((header, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  placeholder="Header 名"
                  className="flex-1"
                  value={header.name}
                  onChange={(event) => updateHeader(index, { name: event.target.value })}
                />
                <Input
                  placeholder="Header 值"
                  className="flex-[2]"
                  value={header.value}
                  onChange={(event) => updateHeader(index, { value: event.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeHeader(index)}
                  aria-label="删除"
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
            <div className="text-sm font-medium">自定义请求体</div>
            <div className="text-xs text-muted-foreground">
              会和上游请求 JSON 深合并（server.ts:5484）。值用 JSON 语法：字符串要带引号，数字直接写，对象/数组也支持。
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addBody}>
            <Plus className="size-4" />
            添加
          </Button>
        </div>
        {bodies.length === 0 ? (
          <div className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
            没有自定义请求体
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

const PROVIDER_OVERWRITE_TYPES: { value: ProviderOverwrite["type"]; label: string }[] = [
  { value: "openai", label: "OpenAI 兼容" },
  { value: "claude", label: "Anthropic Claude" },
  { value: "google", label: "Google Gemini" },
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
  const enable = () => {
    onChange({
      type: "openai",
      name: "供应商覆盖",
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
          <div className="text-sm font-medium">供应商覆盖</div>
          <div className="text-xs text-muted-foreground">
            为这一个模型单独指定 baseUrl 与 API Key。设置后该模型的请求会走这里的配置，不走当前供应商的默认配置——典型用途是把某个模型走自建 OpenAI 兼容网关。
          </div>
        </div>
        {overwrite ? (
          <Button type="button" variant="outline" size="sm" onClick={clear}>
            <Trash2 className="size-4" />
            清除覆盖
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={enable}>
            <Plus className="size-4" />
            配置覆盖
          </Button>
        )}
      </div>
      {overwrite ? (
        <div className="space-y-3 rounded-md border p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <div className="text-xs font-medium">协议类型</div>
              <Select
                value={overwrite.type}
                onValueChange={(value) => {
                  // Switching type also resets baseUrl to that protocol's default — saves
                  // the user from having to hand-clear an OpenAI URL when switching to Claude.
                  const defaultUrl = DEFAULT_BASE_URLS[value] ?? overwrite.baseUrl;
                  update({ type: value, baseUrl: overwrite.baseUrl === DEFAULT_BASE_URLS[overwrite.type] ? defaultUrl : overwrite.baseUrl });
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROVIDER_OVERWRITE_TYPES.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium">显示名称</div>
              <Input
                value={overwrite.name}
                onChange={(event) => update({ name: event.target.value })}
                placeholder="供应商覆盖"
              />
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium">Base URL</div>
            <Input
              value={overwrite.baseUrl}
              onChange={(event) => update({ baseUrl: event.target.value })}
              placeholder="例如 https://api.openai.com/v1"
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
      setParseError("无法解析为 JSON，保留为字符串。如需对象/数组，请检查格式。");
      onChange({ value: next });
    }
  };

  return (
    <div className="space-y-1 rounded-md border p-2">
      <div className="flex items-start gap-2">
        <Input
          placeholder="key（支持 a.b.c 嵌套）"
          className="flex-1"
          value={body.key}
          onChange={(event) => onChange({ key: event.target.value })}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          aria-label="删除"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
      <Textarea
        placeholder='JSON 值。例如：true、42、"hello"、{"foo":1}'
        className="font-mono text-xs"
        rows={2}
        value={rawValue}
        onChange={(event) => commit(event.target.value)}
      />
      {parseError ? (
        <div className="text-xs text-amber-600 dark:text-amber-400">{parseError}</div>
      ) : null}
    </div>
  );
}

function stringifyBodyValue(value: unknown): string {
  if (typeof value === "string") return value;
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
  if (!isChat) {
    return (
      <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground my-3">
        内置工具只对 CHAT 模型生效。
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
            <div className="text-sm font-medium">{option.label}</div>
            <div className="text-xs text-muted-foreground">{option.hint}</div>
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
  options: { value: T; label: string }[];
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
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => {
              if (singleSelect) onToggle(option.value, true);
              else onToggle(option.value, !active);
            }}
            className={cn(
              "rounded px-3 py-1 text-xs transition",
              active
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
