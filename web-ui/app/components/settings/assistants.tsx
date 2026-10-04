// components/settings/assistants.tsx — 助手页:左列表,右配置(基础设定 → 对话行为 → 高级)。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { CopyPlus, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AvatarCropper } from "~/components/avatar-cropper";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Notice } from "~/components/ui/notice";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Slider } from "~/components/ui/slider";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { UIAvatar } from "~/components/ui/ui-avatar";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { createId } from "~/lib/id";
import { getModelDisplayName } from "~/lib/display";
import { patchSettingsLocal, upsertById } from "~/lib/settings-patch";
import { cn } from "~/lib/utils";
import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import api from "~/services/api";
import { confirmDialog } from "~/stores/confirm-store";
import type { AssistantProfile, ProviderModel, Settings } from "~/types";
import {
  clone,
  moveItem,
  numberText,
  SettingsAdvancedRegion,
  SettingsAdvancedToggle,
  SettingsDetailFooter,
  SettingsDetailHeader,
  SettingsEmpty,
  SettingsField,
  SettingsGroup,
  SettingsKeyValueList,
  SettingsListAddButton,
  SettingsListRow,
  SettingsRows,
  SettingsSplit,
  SettingsStack,
  SettingsSwitchRow,
  textValue,
} from "~/components/settings/shared";

const DEFAULT_MESSAGE_TEMPLATE = "{{ message }}";
// 与服务端同口径:变量按 \{\{\s*message\s*\}\} 替换,空模板(trim 后)回退默认模板。
// 只有真正"填了模板却没有 message 变量"才会让用户消息发不出去。
const MESSAGE_VARIABLE = /\{\{\s*message\s*\}\}/;

/** 常显的两项开关;其余开关在「高级设置」里,展开后接在同一张行列表之后。 */
const BASIC_SWITCHES = [
  ["useAssistantAvatar", "settings:assistants.opt.use_avatar"],
  ["streamOutput", "settings:assistants.opt.stream_output"],
] as const;
const ADVANCED_SWITCHES = [
  ["enableTimeReminder", "settings:assistants.opt.time_reminder"],
  ["allowConversationSystemPrompt", "settings:assistants.opt.allow_conv_prompt"],
  ["allowConversationPromptInjection", "settings:assistants.opt.allow_conv_injection"],
  ["enableRecentChatsReference", "settings:assistants.opt.recent_chats"],
] as const;

const LOCAL_TOOLS = [
  ["time_info", "settings:assistants.tools.time_info"],
  ["clipboard", "settings:assistants.tools.clipboard"],
  // 语音播报(tts)暂不展示:后端工具与定义保留(预备),只是不在设置里开放开关。
  // 若未来要把 AI 主动朗读做成卖点再恢复此行,i18n key(tools.tts)仍在。
  ["ask_user", "settings:assistants.tools.ask_user"],
] as const;

const ROLE_KEYS = {
  SYSTEM: "settings:assistants.role.system",
  USER: "settings:assistants.role.user",
  ASSISTANT: "settings:assistants.role.assistant",
} as const;
const ROLE_VALUES = Object.keys(ROLE_KEYS) as (keyof typeof ROLE_KEYS)[];

const TEMPLATE_VARIABLES = ["role", "message", "time", "date", "cur_datetime", "user", "char", "model_name"];

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
    model_name: getModelDisplayName(model?.displayName, model?.modelId) || "GPT-4o",
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

type AssistantAutosave = ReturnType<typeof useAutosaveDraft>;

export function AssistantsSection({
  settings,
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
  // 「高级设置」展开态:切换助手不收起,离开本页(重挂载)复位为收起。
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  // R8-2:防抖自动保存统一走共享三件套 hook(保存窗口内键击不丢,语义见 hook 文件头)。
  const autosave = useAutosaveDraft(
    async () => {
      if (!draft) return;
      await api.post("settings/assistant/detail", draft);
      patchSettingsLocal((current) => ({
        assistants: current.assistants.map((item) => (item.id === draft.id ? draft : item)),
      }));
    },
    { onSaveError: (error) => toast.error((error as Error).message || t("settings:assistants.autosave_failed")) },
  );

  // assistantsRef:重对齐只在切换助手(assistantId)时重载表单。settings.assistants 不能
  // 作为依赖——否则每次 autosave → 回环都会重触发,把保存窗口内新敲的字符当场清掉
  // (McpServerEditor 点名的旧病根,同模式见 providers/search)。
  // 列表从空变为非空(首个助手被创建)时同样要对齐,故 hasAssistants 也是依赖。
  const assistantsRef = React.useRef(settings.assistants);
  assistantsRef.current = settings.assistants;
  const hasAssistants = settings.assistants.length > 0;
  React.useEffect(() => {
    const next =
      assistantsRef.current.find((item) => item.id === assistantId) ?? assistantsRef.current[0];
    autosave.reset();
    setDraft(next ? clone(next) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantId, hasAssistants]);

  const patchDraft = React.useCallback(
    (patch: Partial<AssistantProfile>) => {
      autosave.markDirty();
      setDraft((current) => (current ? { ...current, ...patch } : current));
    },
    [autosave],
  );

  const addAssistant = async () => {
    // issue #49 连带:assistants 意外为空时 clone(undefined) 会 throw(JSON.parse(undefined)),
    // 把"新建助手"这条自愈路径堵死。模板缺省给最小合法体(tags 是唯一未被下方显式覆盖的
    // 必填字段):后端 detail 接口以 defaultAssistant() 展开兜底,其余缺省由服务端补全。
    const template = settings.assistants[0] as AssistantProfile | undefined;
    const created = {
      ...(template ? clone(template) : { tags: [] }),
      id: createId(),
      name: t("settings:assistants.new_assistant_name"),
      avatar: { type: "dummy" },
      useAssistantAvatar: true,
      systemPrompt: "",
      chatModelId: null,
      allowConversationSystemPrompt: false,
    } as AssistantProfile;
    try {
      await api.post("settings/assistant/detail", created);
    } catch (error) {
      toast.error((error as Error).message || t("settings:assistants.autosave_failed"));
      return;
    }
    patchSettingsLocal((current) => ({
      assistantId: created.id,
      assistants: upsertById(current.assistants, created),
    }));
    setAssistantId(created.id);
    toast.success(t("settings:assistants.added"));
  };
  const moveAssistant = async (from: number, to: number) => {
    const assistants = moveItem(settings.assistants, from, to);
    patchSettingsLocal({ assistants });
    await api.post("settings/assistants/reorder", { ids: assistants.map((item) => item.id) });
  };
  // 删除收口到列表行(右键/悬停「⋯」):按目标行 id 删,不再依赖右侧草稿。至少保留一个助手。
  const removeAssistantById = async (targetId: string) => {
    if (settings.assistants.length <= 1) return;
    const target = settings.assistants.find((item) => item.id === targetId);
    if (!target) return;
    const nameLabel = target.name || t("settings:assistants.default_name");
    // M4:先查该助手记忆数,有记忆则让用户选"同时删除 / 保留为孤儿"(默认保留,防误删助手连带丢记忆)
    let memoryCount = 0;
    try {
      const result = await api.get<{ memories: unknown[] }>(`memory/assistant/${encodeURIComponent(targetId)}`);
      memoryCount = result.memories?.length ?? 0;
    } catch { /* 记忆查询失败按 0 处理 */ }
    let deleteMemories = false;
    if (memoryCount > 0) {
      if (!(await confirmDialog({ title: t("settings:assistants.delete_confirm_with_memories", { name: nameLabel, n: memoryCount }), danger: true }))) return;
      // 第二步:确定=同时删记忆,取消=保留为孤儿(记忆页可管理)
      deleteMemories = await confirmDialog({
        title: t("settings:assistants.delete_memories_title", { n: memoryCount }),
        description: t("settings:assistants.delete_memories_desc"),
        confirmLabel: t("settings:assistants.delete_memories_label"),
        cancelLabel: t("settings:assistants.keep_memories_label"),
        danger: true,
      });
    } else {
      if (!(await confirmDialog({ title: t("settings:assistants.delete_confirm", { name: nameLabel }), danger: true }))) return;
    }
    // 防复活:丢弃待保存脏编辑并等在飞保存收尾,DELETE 不与迟到 POST 乱序(复审 F1)。
    // 仅当删的是正在编辑的那条才需要 discard(其余行的草稿与本编辑会话无关)。
    const removingActive = draft?.id === targetId;
    if (removingActive) await autosave.discard();
    await api.delete(`settings/assistant/${encodeURIComponent(targetId)}${deleteMemories ? "?deleteMemories=true" : ""}`);
    let nextId = "";
    patchSettingsLocal((current) => {
      const assistants = current.assistants.filter((item) => item.id !== targetId);
      nextId = assistants[0]?.id ?? "";
      return {
        assistants,
        assistantId: current.assistantId === targetId ? nextId : current.assistantId,
      };
    });
    // 删的是当前编辑行:选中下一个;删的是别的行:选中保持不动。
    if (removingActive) setAssistantId(nextId);
    toast.success(t("settings:assistants.deleted"));
  };

  const list = (
    <div className="space-y-1">
      <SettingsListAddButton
        label={t("settings:assistants.add")}
        icon={<CopyPlus className="size-4" />}
        onClick={() => void addAssistant()}
      />
      {settings.assistants.map((item, index) => (
        <SettingsListRow
          key={item.id}
          id={item.id}
          index={index}
          active={item.id === draft?.id}
          onSelect={() => setAssistantId(item.id)}
          onMove={moveAssistant}
          // 至少保留一个助手:只剩一个时不给删除菜单(否则菜单在、点了却没有反应)。
          onDelete={settings.assistants.length > 1 ? () => removeAssistantById(item.id) : undefined}
        >
          <span className="flex items-center gap-2">
            <UIAvatar size="sm" name={item.name || t("settings:assistants.default_name")} avatar={item.avatar} />
            <span className="truncate">{item.name || t("settings:assistants.default_name")}</span>
          </span>
        </SettingsListRow>
      ))}
    </div>
  );

  return (
    <SettingsSplit scroll list={list}>
      {draft ? (
        <AssistantEditor
          draft={draft}
          setDraft={setDraft}
          patchDraft={patchDraft}
          autosave={autosave}
          settings={settings}
          advancedOpen={advancedOpen}
          onAdvancedOpenChange={setAdvancedOpen}
        />
      ) : (
        <SettingsEmpty size="md">
          {t("settings:assistants.empty")}
        </SettingsEmpty>
      )}
    </SettingsSplit>
  );
}

function AssistantEditor({
  draft,
  setDraft,
  patchDraft,
  autosave,
  settings,
  advancedOpen,
  onAdvancedOpenChange,
}: {
  draft: AssistantProfile;
  setDraft: React.Dispatch<React.SetStateAction<AssistantProfile | null>>;
  patchDraft: (patch: Partial<AssistantProfile>) => void;
  autosave: AssistantAutosave;
  settings: Settings;
  advancedOpen: boolean;
  onAdvancedOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const switchesId = React.useId();
  const advancedId = React.useId();

  const messageTemplateValue =
    typeof draft.messageTemplate === "string" ? draft.messageTemplate : DEFAULT_MESSAGE_TEMPLATE;
  const messageTemplateMissingMessage =
    messageTemplateValue.trim() !== "" && !MESSAGE_VARIABLE.test(messageTemplateValue);
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
        role: "USER" as const,
        text: renderMessageTemplatePreview(
          messageTemplateValue.trim() || DEFAULT_MESSAGE_TEMPLATE,
          t("settings:assistants.preview_user_input"),
          "user",
          draft,
          previewModel,
        ),
      },
      { role: "ASSISTANT" as const, text: t("settings:assistants.preview_assistant_response") },
    ],
    [draft, messageTemplateValue, previewModel, t],
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
  const updateAt = <K extends "presetMessages" | "regexes" | "customBodies">(
    key: K,
    items: Array<Record<string, unknown>>,
    index: number,
    patch: Record<string, unknown>,
  ) => {
    patchDraft({
      [key]: items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
    } as Partial<AssistantProfile>);
  };
  const removeAt = <K extends "presetMessages" | "regexes" | "customBodies">(
    key: K,
    items: Array<Record<string, unknown>>,
    index: number,
  ) => {
    patchDraft({ [key]: items.filter((_, itemIndex) => itemIndex !== index) } as Partial<AssistantProfile>);
  };

  // 温度 / Top P:未设置(null)= 不发送,用模型默认值。滑块需要一个位置,未设置时停在 1 并淡化
  // 已选段,数字框留空显示「默认」——显示值与实际发送一致;「恢复默认」写回 null。
  const parameterControl = (key: "temperature" | "topP", label: string, max: number, step: number) => {
    const unset = typeof draft[key] !== "number";
    const value = unset ? 1 : (draft[key] as number);
    const commit = (raw: string) => {
      if (raw.trim() === "") {
        if (!unset) patchDraft({ [key]: null } as Partial<AssistantProfile>);
        return;
      }
      const next = Number(raw);
      if (!Number.isFinite(next)) return;
      patchDraft({ [key]: Math.min(max, Math.max(0, next)) } as Partial<AssistantProfile>);
    };
    return (
      <SettingsField
        label={label}
        hint={unset ? t("settings:assistants.param_default_desc") : undefined}
        trailing={
          <Button
            type="button"
            variant="ghost"
            size="compact"
            disabled={unset}
            onClick={() => patchDraft({ [key]: null } as Partial<AssistantProfile>)}
          >
            {t("settings:assistants.param_reset")}
          </Button>
        }
      >
        <div className="flex items-center gap-3">
          <Slider
            min={0}
            max={max}
            step={step}
            value={[value]}
            aria-label={label}
            className={cn(unset && "[&_[data-slot=slider-thumb]]:before:opacity-25")}
            onValueChange={([next]) => patchDraft({ [key]: next ?? null } as Partial<AssistantProfile>)}
          />
          <Input
            key={`${key}-${unset ? "unset" : value}`}
            className="w-20 shrink-0"
            inputMode="decimal"
            aria-label={label}
            defaultValue={unset ? "" : numberText(value)}
            placeholder={t("settings:assistants.param_default")}
            onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit(event.currentTarget.value);
            }}
          />
        </div>
      </SettingsField>
    );
  };

  // 头像立即保存并强制在聊天中使用助手头像(换了头像却不显示没有意义);恢复默认同走这里。
  const saveAvatar = async (avatar: AssistantProfile["avatar"]) => {
    const nextDraft = { ...draft, avatar, useAssistantAvatar: avatar?.type !== "dummy" || draft.useAssistantAvatar };
    setDraft(nextDraft);
    await api.post("settings/assistant/detail", nextDraft);
    patchSettingsLocal((current) => ({
      assistantId: nextDraft.id,
      assistants: upsertById(current.assistants, nextDraft),
    }));
  };

  const switchRow = ([key, labelKey]: readonly [keyof AssistantProfile, string]) => (
    <SettingsSwitchRow
      key={key}
      label={t(labelKey)}
      checked={draft[key] === true}
      onCheckedChange={(checked) => patchDraft({ [key]: checked } as Partial<AssistantProfile>)}
    />
  );

  const isTool = (tool: unknown, type: string) => (isPlainRecord(tool) ? tool.type === type : tool === type);
  const localTools = Array.isArray(draft.localTools) ? draft.localTools : [];
  const setLocalTool = (type: string, enabled: boolean) => {
    const others = localTools.filter((tool) => !isTool(tool, type));
    patchDraft({ localTools: enabled ? [...others, { type }] : others });
  };

  const emptyHint = (text: string) => (
    <SettingsEmpty>
      {text}
    </SettingsEmpty>
  );
  const addButton = (onClick: () => void) => (
    <Button type="button" size="sm" variant="outline" onClick={onClick}>
      <Plus className="size-4" />
      {t("settings:assistants.add_button")}
    </Button>
  );
  const deleteButton = (label: string, onClick: () => void, className?: string) => (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      className={className}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Trash2 className="size-4" />
    </Button>
  );

  return (
    <div className="@container">
      <SettingsStack>
        {/* 首行即身份:点头像换图、点名字改名,不再分两个字段把同一个助手写两遍。 */}
        <SettingsDetailHeader
          leading={
            <AvatarCropper
              bare
              value={draft.avatar}
              avatarClassName="size-12"
              fallbackName={draft.name || t("settings:assistants.default_name")}
              onChange={saveAvatar}
            />
          }
          title={draft.name}
          titlePlaceholder={t("settings:assistants.default_name")}
          titleLabel={t("settings:assistants.name")}
          onTitleCommit={(name) => patchDraft({ name })}
          description={
            draft.avatar && draft.avatar.type !== "dummy" ? (
              <button
                type="button"
                className="rounded-[var(--ds-radius-sm)] text-[var(--ds-text-tertiary)] outline-none transition-colors hover:text-[var(--ds-brand-primary)] focus-visible:ring-2 focus-visible:ring-ring/50"
                onClick={() => void saveAvatar({ type: "dummy" })}
              >
                {t("common:avatar_cropper.reset")}
              </button>
            ) : (
              t("common:avatar_cropper.click_to_change")
            )
          }
        />
        <SettingsGroup title={t("settings:assistants.basic_title")} fields>
          <SettingsField
            label={t("settings:assistants.system_prompt")}
            hint={
              // 专题11-P0:秒级时间变量每次请求都变,提示词前缀缓存全灭,就地提醒改天级
              /\{\{\s*(cur_time|cur_datetime|time)\s*\}\}/.test(textValue(draft.systemPrompt)) ? (
                <span className="text-warning">{t("settings:assistants.system_prompt_cache_hint")}</span>
              ) : undefined
            }
          >
            <Textarea
              className="min-h-52 font-mono text-xs"
              value={textValue(draft.systemPrompt)}
              onChange={(event) => patchDraft({ systemPrompt: event.target.value })}
            />
          </SettingsField>
        </SettingsGroup>

        <SettingsGroup
          title={t("settings:assistants.switches_title")}
          action={
            <SettingsAdvancedToggle
              open={advancedOpen}
              onOpenChange={onAdvancedOpenChange}
              controls={[switchesId, advancedId]}
              attention={messageTemplateMissingMessage}
            />
          }
        >
          <SettingsRows>
            {BASIC_SWITCHES.map(switchRow)}
            <SettingsAdvancedRegion id={switchesId} open={advancedOpen} className="divide-y divide-[var(--ds-divider)]">
              {ADVANCED_SWITCHES.map(switchRow)}
            </SettingsAdvancedRegion>
          </SettingsRows>
        </SettingsGroup>

        <SettingsAdvancedRegion id={advancedId} open={advancedOpen} className="space-y-8">
          <SettingsGroup
            title={t("settings:assistants.local_tools_title")}
            description={t("settings:assistants.local_tools_desc")}
          >
            <SettingsRows>
              {LOCAL_TOOLS.map(([type, key]) => (
                <SettingsSwitchRow
                  key={type}
                  label={t(`${key}.title`)}
                  description={t(`${key}.desc`)}
                  checked={localTools.some((tool) => isTool(tool, type))}
                  onCheckedChange={(checked) => setLocalTool(type, checked)}
                />
              ))}
            </SettingsRows>
          </SettingsGroup>

          <SettingsGroup title={t("settings:assistants.request_params_title")} fields>
            <div className="grid gap-5 @xl:grid-cols-2">
              {parameterControl("temperature", t("settings:assistants.temperature"), 2, 0.05)}
              {parameterControl("topP", t("settings:assistants.top_p"), 1, 0.01)}
            </div>
            <SettingsField label={t("settings:assistants.max_tokens")} hint={t("settings:assistants.max_tokens_desc")}>
              <Input
                className="max-w-60"
                inputMode="numeric"
                aria-label={t("settings:assistants.max_tokens")}
                value={numberText(draft.maxTokens)}
                placeholder={t("settings:assistants.max_tokens_ph")}
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  patchDraft({ maxTokens: raw === "" ? null : Math.max(1, Number(raw) || 1) });
                }}
              />
            </SettingsField>
            <SettingsField
              label={t("settings:assistants.context_message_size")}
              hint={t("settings:assistants.context_message_desc")}
            >
              <div className="flex items-center gap-3">
                <Slider
                  min={0}
                  max={512}
                  step={1}
                  aria-label={t("settings:assistants.context_message_size")}
                  value={[typeof draft.contextMessageLimit === "number" ? draft.contextMessageLimit : 0]}
                  onValueChange={([next]) => patchDraft({ contextMessageLimit: next ?? 0 })}
                />
                <Input
                  className="w-24"
                  inputMode="numeric"
                  aria-label={t("settings:assistants.context_message_size")}
                  value={
                    typeof draft.contextMessageLimit === "number" && draft.contextMessageLimit > 0
                      ? String(draft.contextMessageLimit)
                      : ""
                  }
                  placeholder={t("settings:assistants.context_message_unlimited")}
                  onChange={(event) => {
                    const raw = event.target.value.trim();
                    if (raw === "") {
                      patchDraft({ contextMessageLimit: 0 });
                      return;
                    }
                    const parsed = Math.floor(Number(raw));
                    patchDraft({
                      contextMessageLimit: Number.isFinite(parsed) && parsed > 0 ? Math.min(512, parsed) : 0,
                    });
                  }}
                />
              </div>
            </SettingsField>
          </SettingsGroup>

          <SettingsGroup title={t("settings:assistants.content_title")} fields>
            <SettingsField
              label={t("settings:assistants.message_template_title")}
              description={t("settings:assistants.message_template_desc")}
              trailing={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={messageTemplateValue === DEFAULT_MESSAGE_TEMPLATE}
                  onClick={() => patchDraft({ messageTemplate: DEFAULT_MESSAGE_TEMPLATE })}
                >
                  <RefreshCw className="size-4" />
                  {t("settings:assistants.reset")}
                </Button>
              }
            >
              <Textarea
                className="min-h-32 font-mono text-xs"
                value={messageTemplateValue}
                onChange={(event) => patchDraft({ messageTemplate: event.target.value })}
              />
              {messageTemplateMissingMessage ? (
                <Notice tone="danger">
                  {t("settings:assistants.template_missing_warn", { token: DEFAULT_MESSAGE_TEMPLATE })}
                </Notice>
              ) : null}
              <div className="rounded-md border bg-muted/30 p-3">
                <div className="mb-2 text-sm font-medium">{t("settings:assistants.template_preview")}</div>
                <div className="space-y-2">
                  {messageTemplatePreview.map((item) => (
                    <div key={item.role} className="rounded-md bg-background p-3 text-xs">
                      <div className="mb-1 text-muted-foreground">{t(ROLE_KEYS[item.role])}</div>
                      <pre className="whitespace-pre-wrap font-sans leading-relaxed">{item.text}</pre>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                  <span>{t("settings:assistants.available_vars")}</span>
                  {TEMPLATE_VARIABLES.map((variable) => (
                    <code key={variable} className="rounded bg-muted px-1.5 py-0.5 font-mono">
                      {`{{ ${variable} }}`}
                    </code>
                  ))}
                </div>
              </div>
            </SettingsField>

            <SettingsField
              label={t("settings:assistants.preset_messages_title")}
              description={t("settings:assistants.preset_messages_desc")}
              trailing={addButton(() =>
                patchDraft({ presetMessages: [...presetMessages, { role: "ASSISTANT", content: "" }] }),
              )}
            >
              <div className="space-y-3">
                {presetMessages.length === 0 ? emptyHint(t("settings:assistants.no_preset")) : null}
                {presetMessages.map((message, index) => (
                  <div key={String(message.id ?? index)} className="rounded-md border bg-muted/20 p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <Select
                        value={textValue(message.role).toUpperCase() || "ASSISTANT"}
                        onValueChange={(role) => updateAt("presetMessages", presetMessages, index, { role })}
                      >
                        <SelectTrigger className="w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLE_VALUES.map((role) => (
                            <SelectItem key={role} value={role}>
                              {t(ROLE_KEYS[role])}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {deleteButton(
                        t("settings:assistants.delete_preset"),
                        () => removeAt("presetMessages", presetMessages, index),
                        "ml-auto",
                      )}
                    </div>
                    <Textarea
                      className="min-h-24"
                      value={textValue(message.content)}
                      onChange={(event) =>
                        updateAt("presetMessages", presetMessages, index, { content: event.target.value })
                      }
                    />
                  </div>
                ))}
              </div>
            </SettingsField>

            <SettingsField
              label={t("settings:assistants.regex_title")}
              description={t("settings:assistants.regex_desc")}
              trailing={addButton(() =>
                patchDraft({
                  regexes: [
                    ...assistantRegexes,
                    {
                      id: createId(),
                      name: "",
                      enabled: true,
                      findRegex: "",
                      replaceString: "",
                      affectingScope: ["ASSISTANT"],
                      visualOnly: false,
                    },
                  ],
                }),
              )}
            >
              <div className="space-y-3">
                {assistantRegexes.length === 0 ? emptyHint(t("settings:assistants.no_regex")) : null}
                {assistantRegexes.map((regex, index) => {
                  const scopes = Array.isArray(regex.affectingScope) ? regex.affectingScope.map(String) : [];
                  const toggleScope = (scope: "USER" | "ASSISTANT", checked: boolean) => {
                    const nextScopes = new Set(scopes);
                    if (checked) nextScopes.add(scope);
                    else nextScopes.delete(scope);
                    updateAt("regexes", assistantRegexes, index, { affectingScope: [...nextScopes] });
                  };
                  return (
                    <div key={String(regex.id ?? index)} className="rounded-md border bg-muted/20 p-3">
                      <div className="mb-3 flex items-center gap-2">
                        <Switch
                          checked={regex.enabled !== false}
                          aria-label={t("settings:assistants.regex_enabled")}
                          onCheckedChange={(checked) => updateAt("regexes", assistantRegexes, index, { enabled: checked })}
                        />
                        <Input
                          className="h-8"
                          value={textValue(regex.name)}
                          onChange={(event) => updateAt("regexes", assistantRegexes, index, { name: event.target.value })}
                          placeholder={t("settings:assistants.regex_name_ph")}
                        />
                        {deleteButton(t("settings:assistants.delete_regex"), () =>
                          removeAt("regexes", assistantRegexes, index),
                        )}
                      </div>
                      <div className="grid gap-3 @xl:grid-cols-2">
                        <label className="space-y-1">
                          <span className="text-xs text-muted-foreground">{t("settings:assistants.regex_find")}</span>
                          <Input
                            value={textValue(regex.findRegex)}
                            onChange={(event) =>
                              updateAt("regexes", assistantRegexes, index, { findRegex: event.target.value })
                            }
                          />
                        </label>
                        <label className="space-y-1">
                          <span className="text-xs text-muted-foreground">{t("settings:assistants.regex_replace")}</span>
                          <Input
                            value={textValue(regex.replaceString)}
                            onChange={(event) =>
                              updateAt("regexes", assistantRegexes, index, { replaceString: event.target.value })
                            }
                          />
                        </label>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
                        {(["USER", "ASSISTANT"] as const).map((scope) => (
                          <label key={scope} className="flex items-center gap-2">
                            <Checkbox
                              checked={scopes.includes(scope)}
                              onCheckedChange={(checked) => toggleScope(scope, checked === true)}
                            />
                            {t(ROLE_KEYS[scope])}
                          </label>
                        ))}
                        <label className="flex items-center gap-2">
                          <Checkbox
                            checked={regex.visualOnly === true}
                            onCheckedChange={(checked) =>
                              updateAt("regexes", assistantRegexes, index, { visualOnly: checked === true })
                            }
                          />
                          {t("settings:assistants.visual_only")}
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
            </SettingsField>
          </SettingsGroup>

          <SettingsGroup title={t("settings:assistants.custom_request_title")} fields>
            <SettingsKeyValueList
              label={t("settings:assistants.headers")}
              description={t("settings:assistants.headers_desc")}
              items={customHeaders.map((header) => ({
                key: textValue(header.name ?? header.key),
                value: textValue(header.value),
              }))}
              onChange={(next) =>
                patchDraft({ customHeaders: next.map((item) => ({ name: item.key, value: item.value })) })
              }
              keyPlaceholder={t("settings:common.header_name")}
              valuePlaceholder={t("settings:common.header_value")}
              emptyText={t("settings:common.no_headers")}
              removeLabel={t("settings:common.delete_header")}
            />
            <SettingsField
              label={t("settings:assistants.bodies")}
              description={t("settings:assistants.bodies_desc")}
              trailing={addButton(() => patchDraft({ customBodies: [...customBodies, { key: "", value: '""' }] }))}
            >
              <div className="space-y-2">
                {customBodies.length === 0 ? emptyHint(t("settings:assistants.no_body")) : null}
                {customBodies.map((body, index) => (
                  <div key={index} className="rounded-md border bg-muted/20 p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <Input
                        value={textValue(body.key ?? body.name)}
                        onChange={(event) => updateAt("customBodies", customBodies, index, { key: event.target.value })}
                        placeholder={t("settings:assistants.body_key_ph")}
                        aria-label={t("settings:assistants.body_key_ph")}
                      />
                      {deleteButton(t("settings:assistants.delete_body"), () =>
                        removeAt("customBodies", customBodies, index),
                      )}
                    </div>
                    <Textarea
                      className="min-h-24 font-mono text-xs"
                      value={typeof body.value === "string" ? body.value : JSON.stringify(body.value ?? "", null, 2)}
                      onChange={(event) => updateAt("customBodies", customBodies, index, { value: event.target.value })}
                      placeholder={t("settings:assistants.body_value_ph")}
                    />
                  </div>
                ))}
              </div>
            </SettingsField>
          </SettingsGroup>
        </SettingsAdvancedRegion>

        <SettingsDetailFooter
          status={<AutosaveStatusRow status={autosave.status} onRetry={() => void autosave.saveNow()} />}
        />
      </SettingsStack>
    </div>
  );
}
