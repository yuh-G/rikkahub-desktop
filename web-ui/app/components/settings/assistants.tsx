// components/settings/assistants.tsx — 助手分区（助手配置/模板预览，纯搬迁自 routes/settings.tsx）

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Bot, CopyPlus, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AvatarCropper } from "~/components/avatar-cropper";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import { Slider } from "~/components/ui/slider";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { UIAvatar } from "~/components/ui/ui-avatar";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import api from "~/services/api";
import { confirmDialog } from "~/stores/confirm-store";
import type { AssistantProfile, ProviderModel, Settings } from "~/types";
import {
  clone,
  moveItem,
  numberText,
  SectionHeader,
  SortableRow,
  textValue,
} from "~/components/settings/shared";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function formatTemplatePreviewDate(date = new Date()) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(date);
}

function formatTemplatePreviewTime(date = new Date()) {
  return new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(date);
}

function renderMessageTemplatePreview(
  template: string,
  message: string,
  role: string,
  assistant: AssistantProfile,
  model?: ProviderModel | null,
) {
  const now = new Date();
  const values: Record<string, string> = {
    message,
    role,
    time: formatTemplatePreviewTime(now),
    date: formatTemplatePreviewDate(now),
    cur_time: formatTemplatePreviewTime(now),
    cur_date: formatTemplatePreviewDate(now),
    cur_datetime: new Intl.DateTimeFormat(undefined, {
      dateStyle: "full",
      timeStyle: "medium",
    }).format(now),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    user: "User",
    nickname: "User",
    char: assistant.name?.trim() || "Assistant",
    model_id: model?.modelId || "gpt-4o",
    model_name: model?.displayName || model?.modelId || "GPT-4o",
    system_version: `${(() => {
      const p = navigator.platform || "web";
      const n = /Win/i.test(p)
        ? "Windows"
        : /Linux/i.test(p)
          ? "Linux"
          : /Mac/i.test(p)
            ? "macOS"
            : "";
      return n ? `${n} PC` : "PC";
    })()} (${navigator.platform || "web"})`,
  };
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => values[key] ?? match);
}

export function AssistantsSection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const [assistantId, setAssistantId] = React.useState(settings.assistantId);
  const assistant = (settings.assistants.find((item) => item.id === assistantId) ??
    settings.assistants[0]) as AssistantProfile | undefined;
  const [draft, setDraft] = React.useState<AssistantProfile | null>(
    assistant ? clone(assistant) : null,
  );
  // R8-2:防抖自动保存统一走共享三件套 hook(保存窗口内键击不丢,语义见 hook 文件头)。
  const autosave = useAutosaveDraft(
    async () => {
      if (!draft) return;
      await api.post("settings/assistant/detail", draft);
      onSettings({
        ...settings,
        assistants: settings.assistants.map((item) => (item.id === draft.id ? draft : item)),
      });
    },
    { onSaveError: (error) => toast.error((error as Error).message || t("settings:assistants.autosave_failed")) },
  );

  // assistantsRef:重对齐只在切换助手(assistantId)时重载表单。settings.assistants 不能
  // 作为依赖——否则每次 autosave → onSettings 回环都会重触发,把保存窗口内新敲的字符
  // 当场清掉(McpServerEditor 点名的旧病根,同模式见 providers/search)。
  const assistantsRef = React.useRef(settings.assistants);
  assistantsRef.current = settings.assistants;
  React.useEffect(() => {
    const next =
      assistantsRef.current.find((item) => item.id === assistantId) ?? assistantsRef.current[0];
    autosave.reset();
    setDraft(next ? clone(next) : null);
  }, [assistantId]);

  if (!draft) return null;

  const patchDraft = (patch: Partial<AssistantProfile>) => {
    autosave.markDirty();
    setDraft({ ...draft, ...patch });
  };

  const addAssistant = async () => {
    // issue #49 连带:assistants 意外为空时 clone(undefined) 会 throw(JSON.parse(undefined)),
    // 把"新建助手"这条自愈路径堵死。模板缺省给最小合法体(tags 是唯一未被下方显式覆盖的
    // 必填字段):后端 detail 接口以 defaultAssistant() 展开兜底,其余缺省由服务端补全。
    const template = settings.assistants[0] as AssistantProfile | undefined;
    const created = {
      ...(template ? clone(template) : { tags: [] }),
      id: crypto.randomUUID(),
      name: t("settings:assistants.new_assistant_name"),
      avatar: { type: "dummy" },
      useAssistantAvatar: true,
      systemPrompt: "",
      chatModelId: null,
      allowConversationSystemPrompt: false,
    };
    await api.post("settings/assistant/detail", created);
    onSettings({
      ...settings,
      assistantId: created.id,
      assistants: [...settings.assistants, created],
    });
    setAssistantId(created.id);
    toast.success(t("settings:assistants.added"));
  };
  const moveAssistant = async (from: number, to: number) => {
    const assistants = moveItem(settings.assistants, from, to);
    onSettings({ ...settings, assistants });
    await api.post("settings/assistants/reorder", { ids: assistants.map((item) => item.id) });
  };
  const removeAssistant = async () => {
    const nameLabel = draft.name || t("settings:assistants.default_name");
    // M4:先查该助手记忆数,有记忆则让用户选"同时删除 / 保留为孤儿"(默认保留,防误删助手连带丢记忆)
    let memoryCount = 0;
    try {
      const result = await api.get<{ memories: unknown[] }>(`memory/assistant/${encodeURIComponent(draft.id)}`);
      memoryCount = result.memories?.length ?? 0;
    } catch { /* 记忆查询失败按 0 处理 */ }
    let deleteMemories = false;
    if (memoryCount > 0) {
      if (!(await confirmDialog({ title: t("settings:assistants.delete_confirm_with_memories", { name: nameLabel, n: memoryCount }), danger: true }))) return;
      // 第二步:确定=同时删记忆,取消=保留为孤儿(记忆板块可管理)
      deleteMemories = await confirmDialog({ title: t("settings:assistants.delete_memories_confirm", { n: memoryCount }), danger: true });
    } else {
      if (!(await confirmDialog({ title: t("settings:assistants.delete_confirm", { name: nameLabel }), danger: true }))) return;
    }
    // 防复活:丢弃待保存脏编辑并等在飞保存收尾,DELETE 不与迟到 POST 乱序(复审 F1)
    await autosave.discard();
    await api.delete(`settings/assistant/${encodeURIComponent(draft.id)}${deleteMemories ? "?deleteMemories=true" : ""}`);
    const assistants = settings.assistants.filter((item) => item.id !== draft.id);
    onSettings({
      ...settings,
      assistants,
      assistantId:
        settings.assistantId === draft.id ? (assistants[0]?.id ?? "") : settings.assistantId,
    });
    setAssistantId(assistants[0]?.id ?? "");
    toast.success(t("settings:assistants.deleted"));
  };
  const parameterControl = (
    key: "temperature" | "topP",
    label: string,
    max: number,
    step: number,
  ) => {
    const value = typeof draft[key] === "number" ? draft[key] : key === "temperature" ? 1 : 1;
    const commit = (raw: string) => {
      if (raw.trim() === "") return;
      const next = Number(raw);
      if (!Number.isFinite(next)) return;
      patchDraft({ [key]: Math.min(max, Math.max(0, next)) } as Partial<AssistantProfile>);
    };
    return (
      <label className="space-y-2">
        <span className="text-sm font-medium">{label}</span>
        <div className="flex items-center gap-3">
          <Slider
            min={0}
            max={max}
            step={step}
            value={[value]}
            onValueChange={([next]) =>
              patchDraft({ [key]: next ?? null } as Partial<AssistantProfile>)
            }
          />
          <Input
            key={`${key}-${value}`}
            className="w-24"
            defaultValue={numberText(value)}
            onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit(event.currentTarget.value);
            }}
          />
        </div>
      </label>
    );
  };
  const messageTemplateValue =
    typeof draft.messageTemplate === "string" ? draft.messageTemplate : "{{ message }}";
  const messageTemplateMissingMessage = !messageTemplateValue.includes("{{ message }}");
  const previewModel = React.useMemo(() => {
    const wanted = draft.chatModelId ?? settings.chatModelId;
    return (
      settings.providers
        .flatMap((provider) => provider.models)
        .find((modelItem) => modelItem.id === wanted || modelItem.modelId === wanted) ?? null
    );
  }, [draft.chatModelId, settings.chatModelId, settings.providers]);
  const messageTemplatePreview = React.useMemo(
    () => [
      {
        role: "user",
        text: renderMessageTemplatePreview(
          messageTemplateValue,
          t("settings:assistants.preview_user_input"),
          "user",
          draft,
          previewModel,
        ),
      },
      {
        role: "assistant",
        text: t("settings:assistants.preview_assistant_response"),
      },
    ],
    [draft, messageTemplateValue, previewModel],
  );
  const presetMessages = Array.isArray(draft.presetMessages)
    ? (draft.presetMessages as Array<Record<string, unknown>>)
    : [];
  const assistantRegexes = Array.isArray(draft.regexes)
    ? (draft.regexes as Array<Record<string, unknown>>)
    : [];
  const customHeaders = Array.isArray(draft.customHeaders)
    ? (draft.customHeaders as Array<Record<string, unknown>>)
    : [];
  const customBodies = Array.isArray(draft.customBodies)
    ? (draft.customBodies as Array<Record<string, unknown>>)
    : [];
  const updatePresetMessage = (index: number, patch: Record<string, unknown>) => {
    patchDraft({
      presetMessages: presetMessages.map((message, itemIndex) =>
        itemIndex === index ? { ...message, ...patch } : message,
      ),
    });
  };
  const updateRegex = (index: number, patch: Record<string, unknown>) => {
    patchDraft({
      regexes: assistantRegexes.map((regex, itemIndex) =>
        itemIndex === index ? { ...regex, ...patch } : regex,
      ),
    });
  };
  const updateCustomHeader = (index: number, patch: Record<string, unknown>) => {
    patchDraft({
      customHeaders: customHeaders.map((header, itemIndex) =>
        itemIndex === index ? { ...header, ...patch } : header,
      ),
    });
  };
  const updateCustomBody = (index: number, patch: Record<string, unknown>) => {
    patchDraft({
      customBodies: customBodies.map((body, itemIndex) =>
        itemIndex === index ? { ...body, ...patch } : body,
      ),
    });
  };
  return (
    <>
      <SectionHeader
        icon={Bot}
        title={t("settings:assistants.title")}
        subtitle={t("settings:assistants.subtitle")}
      />
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="rounded-lg border bg-card p-2">
          <Button className="mb-2 w-full justify-start" variant="outline" onClick={addAssistant}>
            <CopyPlus className="size-4" />
            {t("settings:assistants.add")}
          </Button>
          {settings.assistants.map((item, index) => (
            <SortableRow
              key={item.id}
              id={item.id}
              index={index}
              active={item.id === draft.id}
              onSelect={() => setAssistantId(item.id)}
              onMove={moveAssistant}
            >
              <span className="flex items-center gap-2">
                <UIAvatar size="sm" name={item.name || "Assistant"} avatar={item.avatar} />
                <span className="truncate">
                  {item.name || t("settings:assistants.default_name")}
                </span>
              </span>
            </SortableRow>
          ))}
        </div>
        <div className="space-y-5 rounded-lg border bg-card p-5">
          <AvatarCropper
            value={draft.avatar}
            fallbackName={draft.name || "Assistant"}
            onChange={async (avatar) => {
              const nextDraft = { ...draft, avatar, useAssistantAvatar: true };
              setDraft(nextDraft);
              await api.post("settings/assistant/detail", nextDraft);
              onSettings({
                ...settings,
                assistantId: nextDraft.id,
                assistants: settings.assistants.map((item) =>
                  item.id === nextDraft.id ? nextDraft : item,
                ),
              });
            }}
          />
          <Separator />
          <label className="block space-y-2">
            <span className="text-sm font-medium">{t("settings:assistants.name")}</span>
            <Input
              value={draft.name}
              onChange={(event) => patchDraft({ name: event.target.value })}
            />
          </label>
          <label className="block space-y-2">
            <span className="text-sm font-medium">{t("settings:assistants.system_prompt")}</span>
            <Textarea
              className="min-h-52 font-mono text-xs"
              value={textValue(draft.systemPrompt)}
              onChange={(event) => patchDraft({ systemPrompt: event.target.value })}
            />
            {/* 专题11-P0:秒级时间变量每次请求都变,提示词前缀缓存全灭,就地提醒改天级 */}
            {/\{\{\s*(cur_time|cur_datetime|time)\s*\}\}/.test(textValue(draft.systemPrompt)) ? (
              <p className="text-xs text-warning">
                {t("settings:assistants.system_prompt_cache_hint")}
              </p>
            ) : null}
          </label>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">
                  {t("settings:assistants.message_template_title")}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {t("settings:assistants.message_template_desc")}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={messageTemplateValue === "{{ message }}"}
                onClick={() => patchDraft({ messageTemplate: "{{ message }}" })}
              >
                <RefreshCw className="size-4" />
                {t("settings:assistants.reset")}
              </Button>
            </div>
            <Textarea
              className="min-h-32 font-mono text-xs"
              value={messageTemplateValue}
              onChange={(event) => patchDraft({ messageTemplate: event.target.value })}
            />
            {messageTemplateMissingMessage ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {t("settings:assistants.template_missing_warn", { token: "{{ message }}" })}
              </div>
            ) : null}
            <div className="rounded-md border bg-muted/30 p-3">
              <div className="mb-2 text-sm font-medium">
                {t("settings:assistants.template_preview")}
              </div>
              <div className="space-y-2">
                {messageTemplatePreview.map((item) => (
                  <div key={item.role} className="rounded-md bg-background p-3 text-xs">
                    <div className="mb-1 text-muted-foreground">{item.role}</div>
                    <pre className="whitespace-pre-wrap font-sans leading-relaxed">{item.text}</pre>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                <span>{t("settings:assistants.available_vars")}</span>
                {[
                  "role",
                  "message",
                  "time",
                  "date",
                  "cur_datetime",
                  "user",
                  "char",
                  "model_name",
                ].map((variable) => (
                  <code key={variable} className="rounded bg-muted px-1.5 py-0.5 font-mono">
                    {`{{ ${variable} }}`}
                  </code>
                ))}
              </div>
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">
                  {t("settings:assistants.preset_messages_title")}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {t("settings:assistants.preset_messages_desc")}
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  patchDraft({
                    presetMessages: [...presetMessages, { role: "ASSISTANT", content: "" }],
                  })
                }
              >
                <Plus className="size-4" />
                {t("settings:assistants.add_button")}
              </Button>
            </div>
            <div className="space-y-3">
              {presetMessages.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                  {t("settings:assistants.no_preset")}
                </div>
              ) : null}
              {presetMessages.map((message, index) => (
                <div
                  key={String(message.id ?? index)}
                  className="rounded-md border bg-muted/20 p-3"
                >
                  <div className="mb-2 flex items-center gap-2">
                    <Select
                      value={textValue(message.role).toUpperCase() || "ASSISTANT"}
                      onValueChange={(role) => updatePresetMessage(index, { role })}
                    >
                      <SelectTrigger className="h-8 w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="SYSTEM">System</SelectItem>
                        <SelectItem value="USER">User</SelectItem>
                        <SelectItem value="ASSISTANT">Assistant</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      className="ml-auto"
                      onClick={() =>
                        patchDraft({
                          presetMessages: presetMessages.filter(
                            (_, itemIndex) => itemIndex !== index,
                          ),
                        })
                      }
                      title={t("settings:assistants.delete_preset")}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                  <Textarea
                    className="min-h-24"
                    value={textValue(message.content)}
                    onChange={(event) =>
                      updatePresetMessage(index, { content: event.target.value })
                    }
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">{t("settings:assistants.regex_title")}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {t("settings:assistants.regex_desc")}
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  patchDraft({
                    regexes: [
                      ...assistantRegexes,
                      {
                        id: crypto.randomUUID(),
                        name: "",
                        enabled: true,
                        findRegex: "",
                        replaceString: "",
                        affectingScope: ["ASSISTANT"],
                        visualOnly: false,
                      },
                    ],
                  })
                }
              >
                <Plus className="size-4" />
                {t("settings:assistants.add_button")}
              </Button>
            </div>
            <div className="space-y-3">
              {assistantRegexes.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                  {t("settings:assistants.no_regex")}
                </div>
              ) : null}
              {assistantRegexes.map((regex, index) => {
                const scopes = Array.isArray(regex.affectingScope)
                  ? regex.affectingScope.map(String)
                  : [];
                const toggleScope = (scope: "USER" | "ASSISTANT", checked: boolean) => {
                  const nextScopes = new Set(scopes);
                  if (checked) nextScopes.add(scope);
                  else nextScopes.delete(scope);
                  updateRegex(index, { affectingScope: [...nextScopes] });
                };
                return (
                  <div
                    key={String(regex.id ?? index)}
                    className="rounded-md border bg-muted/20 p-3"
                  >
                    <div className="mb-3 flex items-center gap-2">
                      <Switch
                        checked={regex.enabled !== false}
                        onCheckedChange={(checked) => updateRegex(index, { enabled: checked })}
                      />
                      <Input
                        className="h-8"
                        value={textValue(regex.name)}
                        onChange={(event) => updateRegex(index, { name: event.target.value })}
                        placeholder={t("settings:assistants.regex_name_ph")}
                      />
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        onClick={() =>
                          patchDraft({
                            regexes: assistantRegexes.filter((_, itemIndex) => itemIndex !== index),
                          })
                        }
                        title={t("settings:assistants.delete_regex")}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="space-y-1">
                        <span className="text-xs text-muted-foreground">Find Regex</span>
                        <Input
                          value={textValue(regex.findRegex)}
                          onChange={(event) =>
                            updateRegex(index, { findRegex: event.target.value })
                          }
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-xs text-muted-foreground">Replace String</span>
                        <Input
                          value={textValue(regex.replaceString)}
                          onChange={(event) =>
                            updateRegex(index, { replaceString: event.target.value })
                          }
                        />
                      </label>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
                      <label className="flex items-center gap-2">
                        <Checkbox
                          checked={scopes.includes("USER")}
                          onCheckedChange={(checked) => toggleScope("USER", checked === true)}
                        />
                        User
                      </label>
                      <label className="flex items-center gap-2">
                        <Checkbox
                          checked={scopes.includes("ASSISTANT")}
                          onCheckedChange={(checked) => toggleScope("ASSISTANT", checked === true)}
                        />
                        Assistant
                      </label>
                      <label className="flex items-center gap-2">
                        <Checkbox
                          checked={regex.visualOnly === true}
                          onCheckedChange={(checked) =>
                            updateRegex(index, { visualOnly: checked === true })
                          }
                        />
                        {t("settings:assistants.visual_only")}
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {parameterControl("temperature", "Temperature", 2, 0.05)}
            {parameterControl("topP", "Top P", 1, 0.01)}
            <label className="space-y-2">
              <span className="text-sm font-medium">Max Tokens</span>
              <Input
                value={numberText(draft.maxTokens)}
                placeholder={t("settings:assistants.max_tokens_ph")}
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  setDraft({
                    ...draft,
                    maxTokens: raw === "" ? null : Math.max(1, Number(raw) || 1),
                  });
                }}
              />
              <div className="text-xs text-muted-foreground">
                {t("settings:assistants.max_tokens_desc")}
              </div>
            </label>
          </div>
          <label className="space-y-2">
            <span className="text-sm font-medium">
              {t("settings:assistants.context_message_size")}
            </span>
            <div className="flex items-center gap-3">
              <Slider
                min={0}
                max={512}
                step={1}
                value={[
                  typeof draft.contextMessageLimit === "number"
                    ? draft.contextMessageLimit
                    : 0,
                ]}
                onValueChange={([next]) =>
                  patchDraft({ contextMessageLimit: next ?? 0 })
                }
              />
              <Input
                className="w-24"
                inputMode="numeric"
                value={
                  typeof draft.contextMessageLimit === "number" &&
                  draft.contextMessageLimit > 0
                    ? String(draft.contextMessageLimit)
                    : ""
                }
                placeholder={t(
                  "settings:assistants.context_message_unlimited",
                )}
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  if (raw === "") {
                    patchDraft({ contextMessageLimit: 0 });
                    return;
                  }
                  const parsed = Math.floor(Number(raw));
                  patchDraft({
                    contextMessageLimit:
                      Number.isFinite(parsed) && parsed > 0
                        ? Math.min(512, parsed)
                        : 0,
                  });
                }}
              />
            </div>
            <div className="text-xs text-muted-foreground">
              {t("settings:assistants.context_message_desc")}
            </div>
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            {[
              ["enableRecentChatsReference", t("settings:assistants.opt.recent_chats")],
              ["streamOutput", t("settings:assistants.opt.stream_output")],
              ["enableTimeReminder", t("settings:assistants.opt.time_reminder")],
              ["useAssistantAvatar", t("settings:assistants.opt.use_avatar")],
              ["allowConversationSystemPrompt", t("settings:assistants.opt.allow_conv_prompt")],
              ["allowConversationPromptInjection", t("settings:assistants.opt.allow_conv_injection")],
            ].map(([key, label]) => (
              <label
                key={key}
                className="flex items-center justify-between rounded-md border px-3 py-2"
              >
                <span className="text-sm">{label}</span>
                <Switch
                  checked={draft[key] === true}
                  onCheckedChange={(checked) =>
                    patchDraft({ [key]: checked } as Partial<AssistantProfile>)
                  }
                />
              </label>
            ))}
          </div>
          {/* 1.3.2 记忆管理(含 enableMemory 开关)已移至独立的「记忆」板块,见 nav.memory */}
          <div className="rounded-md border p-3">
            <div className="text-sm font-medium">{t("settings:assistants.local_tools_title")}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t("settings:assistants.local_tools_desc")}
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {[
                ["time_info", t("settings:assistants.tools.time_info.title"), t("settings:assistants.tools.time_info.desc")],
                ["clipboard", t("settings:assistants.tools.clipboard.title"), t("settings:assistants.tools.clipboard.desc")],
                // 语音播报(tts)暂不展示:后端工具与定义保留(预备),只是不在设置里开放开关。
                // 若未来要把 AI 主动朗读做成卖点再恢复此卡片,i18n key(tools.tts)仍在。
                ["ask_user", t("settings:assistants.tools.ask_user.title"), t("settings:assistants.tools.ask_user.desc")],
              ].map(([type, label, desc]) => {
                const enabled =
                  Array.isArray(draft.localTools) &&
                  draft.localTools.some((tool) =>
                    isPlainRecord(tool) ? tool.type === type : tool === type,
                  );
                return (
                  <label
                    key={type}
                    className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                  >
                    <span>
                      <span className="block text-sm">{label}</span>
                      <span className="block text-xs text-muted-foreground">{desc}</span>
                    </span>
                    <Switch
                      checked={enabled}
                      onCheckedChange={(checked) => {
                        const current = Array.isArray(draft.localTools) ? draft.localTools : [];
                        const next = checked
                          ? [
                              ...current.filter(
                                (tool) =>
                                  !(isPlainRecord(tool) ? tool.type === type : tool === type),
                              ),
                              { type },
                            ]
                          : current.filter(
                              (tool) => !(isPlainRecord(tool) ? tool.type === type : tool === type),
                            );
                        patchDraft({ localTools: next });
                      }}
                    />
                  </label>
                );
              })}
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="mb-3 text-sm font-medium">{t("settings:assistants.custom_request_title")}</div>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm">Headers</div>
                    <div className="text-xs text-muted-foreground">
                      {t("settings:assistants.headers_desc")}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      patchDraft({ customHeaders: [...customHeaders, { name: "", value: "" }] })
                    }
                  >
                    <Plus className="size-4" />
                    {t("settings:assistants.add_button")}
                  </Button>
                </div>
                {customHeaders.length === 0 ? (
                  <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                    {t("settings:assistants.no_header")}
                  </div>
                ) : null}
                {customHeaders.map((header, index) => (
                  <div
                    key={index}
                    className="grid gap-2 rounded-md border bg-muted/20 p-3 md:grid-cols-[1fr_1fr_auto]"
                  >
                    <Input
                      value={textValue(header.name ?? header.key)}
                      onChange={(event) => updateCustomHeader(index, { name: event.target.value })}
                      placeholder="Header name"
                    />
                    <Input
                      value={textValue(header.value)}
                      onChange={(event) => updateCustomHeader(index, { value: event.target.value })}
                      placeholder="Header value"
                    />
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      onClick={() =>
                        patchDraft({
                          customHeaders: customHeaders.filter(
                            (_, itemIndex) => itemIndex !== index,
                          ),
                        })
                      }
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm">Bodies</div>
                    <div className="text-xs text-muted-foreground">
                      {t("settings:assistants.bodies_desc")}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      patchDraft({ customBodies: [...customBodies, { key: "", value: '""' }] })
                    }
                  >
                    <Plus className="size-4" />
                    {t("settings:assistants.add_button")}
                  </Button>
                </div>
                {customBodies.length === 0 ? (
                  <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                    {t("settings:assistants.no_body")}
                  </div>
                ) : null}
                {customBodies.map((body, index) => (
                  <div key={index} className="rounded-md border bg-muted/20 p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <Input
                        value={textValue(body.key ?? body.name)}
                        onChange={(event) => updateCustomBody(index, { key: event.target.value })}
                        placeholder="Body key"
                      />
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        onClick={() =>
                          patchDraft({
                            customBodies: customBodies.filter(
                              (_, itemIndex) => itemIndex !== index,
                            ),
                          })
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    <Textarea
                      className="min-h-24 font-mono text-xs"
                      value={
                        typeof body.value === "string"
                          ? body.value
                          : JSON.stringify(body.value ?? "", null, 2)
                      }
                      onChange={(event) => updateCustomBody(index, { value: event.target.value })}
                      placeholder={t("settings:assistants.body_value_ph")}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="text-sm font-medium">{t("settings:assistants.ext_summary_title")}</div>
            <div className="mt-2 grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
              <div>{t("settings:assistants.ext_injection")}: {(draft.modeInjectionIds ?? []).length}</div>
              <div>{t("settings:assistants.ext_lorebook")}: {(draft.lorebookIds ?? []).length}</div>
              <div>MCP: {(draft.mcpServers ?? []).length}</div>
              <div>
                Local tools: {Array.isArray(draft.localTools) ? draft.localTools.length : 0}
              </div>
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              variant="outline"
              onClick={removeAssistant}
              disabled={settings.assistants.length <= 1}
            >
              <Trash2 className="size-4" />
              {t("settings:assistants.delete")}
            </Button>
            <AutosaveStatusRow
              status={autosave.status}
              onRetry={() => void autosave.saveNow()}
            />
          </div>
        </div>
      </div>
    </>
  );
}
