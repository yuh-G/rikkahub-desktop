import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  ArrowLeft,
  Bot,
  Check,
  CheckCircle2,
  CopyPlus,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileImage,
  FileClock,
  Globe,
  Github,
  GripVertical,
  Heart,
  KeyRound,
  Loader2,
  MessageSquareText,
  Mic,
  NotebookText,
  Smartphone,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Trash2,
  Upload,
  UserRound,
  Volume2,
  Square,
  Sparkles,
  WandSparkles,
  Zap,
  Brain,
  X,
  XCircle,
} from "lucide-react";
import { Link } from "react-router";
import { MemorySection } from "~/components/memory/memory-section";
import { toast } from "sonner";

import { AvatarCropper } from "~/components/avatar-cropper";
import { FontPickerPair } from "~/components/font-picker";
import { AIIcon } from "~/components/ui/ai-icon";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { JsonTree, tryParseJson } from "~/components/ui/json-tree";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import { Slider } from "~/components/ui/slider";
import { Switch } from "~/components/ui/switch";
import { KeybindingSettings } from "~/components/keybinding-settings";
import { Textarea } from "~/components/ui/textarea";
import { UIAvatar } from "~/components/ui/ui-avatar";
import { cn } from "~/lib/utils";
import { openExternal } from "~/lib/external-link";
import { getSystemInfo } from "~/lib/system-info";
import api, { appendWebAuthQuery } from "~/services/api";
import { useSettingsStore } from "~/stores/app-store";
import type {
  AsrProviderProfile,
  AsrProviderType,
  AssistantAvatar,
  AssistantProfile,
  ProviderModel,
  ProviderProfile,
  SearchServiceOption,
  Settings,
  TtsProviderProfile,
  TtsProviderType,
} from "~/types";
import { ModelEditDialog } from "~/components/model-edit-dialog";
import Markdown from "~/components/markdown/markdown";
import { playAudio, stopAudio, useAudioPlaybackKey } from "~/lib/global-audio";
import { UpdateDialog, type UpdateInfo } from "~/components/update-dialog";

type Section =
  | "general"
  | "providers"
  | "models"
  | "assistants"
  | "search"
  | "mcp"
  | "speech"
  | "memory"
  | "data"
  | "stats"
  | "logs"
  | "proxy"
  | "donate"
  | "about"
  | "plan";
type ProviderKind = "openai" | "claude" | "google";

type ProviderTestMode = "non_stream" | "stream" | "tools";

interface ProviderTestCheck {
  mode: ProviderTestMode;
  ok: boolean;
  status: number;
  endpoint: string;
  preview: string;
}

interface ProviderTestInfo {
  endpoint: string;
  responseApiEndpoint: string;
  testModelId: string;
  modelCount: number;
  preview: string;
  checks?: ProviderTestCheck[];
}

interface RequestLog {
  id: string;
  at: number;
  providerName: string;
  url: string;
  ok: boolean;
  status: number;
  error?: string;
  kind?: string;
  durationMs?: number;
  method?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  responseHeaders?: Record<string, string>;
  toolName?: string;
}

interface StatsPayload {
  totals: {
    conversations: number;
    messages: number;
    userMessages: number;
    assistantMessages: number;
    characters: number;
    inputTokens: number;
    outputTokens: number;
    launchCount: number;
    requests: number;
    failedRequests: number;
  };
  daily: Array<{ date: string; messages: number; conversations: number; characters: number }>;
  models: Array<{ id: string; name?: string; providerName?: string; count: number }>;
  requestGroups?: Array<{ name: string; ok: number; failed: number }>;
  providers: Array<{ name: string; ok: number; failed: number }>;
}

interface SkillFileInfo {
  path: string;
  size: number;
  type: "file" | "directory";
}

interface SkillProfile {
  name: string;
  description: string;
  compatibility?: string;
  allowedTools?: string[];
  content?: string;
}

interface WebDavConfig {
  url: string;
  username: string;
  password: string;
  path: string;
  items: string[];
}

interface S3Config {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  pathStyle: boolean;
  items: string[];
}

interface S3BackupItem {
  href: string;
  displayName: string;
  size: number;
  lastModified: string;
}

interface WebDavBackupItem {
  href: string;
  displayName: string;
  size: number;
  lastModified: string;
}

interface AssistantMemoryInfo {
  id: number;
  assistantId: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

const navItems: Array<{
  id: Section;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: "general", labelKey: "settings:nav.general", icon: UserRound },
  { id: "assistants", labelKey: "settings:nav.assistants", icon: Bot },
  { id: "providers", labelKey: "settings:nav.providers", icon: KeyRound },
  { id: "models", labelKey: "settings:nav.models", icon: Settings2 },
  { id: "search", labelKey: "settings:nav.search", icon: Search },
  { id: "mcp", labelKey: "settings:nav.mcp", icon: CopyPlus },
  { id: "speech", labelKey: "settings:nav.speech", icon: Mic },
  { id: "memory", labelKey: "settings:nav.memory", icon: Brain },
  { id: "data", labelKey: "settings:nav.data", icon: Database },
  { id: "stats", labelKey: "settings:nav.stats", icon: Database },
  { id: "logs", labelKey: "settings:nav.logs", icon: FileClock },
  { id: "proxy", labelKey: "settings:nav.proxy", icon: Globe },
  { id: "donate", labelKey: "settings:nav.donate", icon: Heart },
  { id: "about", labelKey: "settings:nav.about", icon: CheckCircle2 },
];

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Best-effort model-type inference from model id; falls back to CHAT when nothing matches.
// Used to pre-fill the per-model type selector when the user toggles a model on. Users can
// always override in the model row (parity with Android, which makes this manual).
function inferModelType(modelId: string): "CHAT" | "IMAGE" | "EMBEDDING" {
  const id = String(modelId ?? "").toLowerCase();
  if (!id) return "CHAT";
  if (
    /(text-embedding|^embedding|-embed(ding)?|bge|e5|gte|m3-embedding|nomic-embed|jina-embed)/.test(
      id,
    )
  )
    return "EMBEDDING";
  if (
    /(gpt-image|dall-e|dalle|imagen|stable-diffusion|sd[\d-]|flux|midjourney|kolors|qwen-image|wanx|hunyuan-dit|seedream|cogview|recraft)/.test(
      id,
    )
  )
    return "IMAGE";
  return "CHAT";
}

// Canonical labels for search services. Used in both the settings dropdown and as the
// AIIcon lookup key so the logo follows the type, not the user-entered display name.
const SEARCH_SERVICE_TYPE_LABELS: Record<string, string> = {
  bing_local: "Bing",
  rikkahub: "RikkaHub",
  tavily: "Tavily",
  exa: "Exa",
  zhipu: "智谱",
  tinyfish: "Tinyfish",
  brave: "Brave",
  perplexity: "Perplexity",
  bocha: "博查",
  linkup: "LinkUp",
  metaso: "秘塔",
  ollama: "Ollama",
  jina: "Jina",
  firecrawl: "Firecrawl",
  grok: "Grok",
  searxng: "SearXNG",
  custom_js: "Custom JS",
};

function searchServiceLabelForType(type: string | null | undefined): string {
  const key = String(type ?? "")
    .trim()
    .toLowerCase();
  if (!key) return "Search";
  return SEARCH_SERVICE_TYPE_LABELS[key] ?? key;
}

function applyAutoModelType<M extends { modelId?: string; type?: string }>(model: M): M {
  if (model.type && model.type !== "CHAT") return model;
  const inferred = inferModelType(String(model.modelId ?? ""));
  if (inferred === "CHAT") return model;
  return { ...model, type: inferred };
}

// ── Manual-models cache (in-memory, per provider) ────────────────────────────
// Only manually-added models (manuallyAdded === true) are cached here — fetched models are
// NOT. The point: a manual model has no upstream source to re-fetch from, so once the user
// creates it we must never let it vanish from the list just because they toggled it off (or
// navigated away and back, which clears the in-memory fetchedModels state). Toggling a
// manual model off removes it from draft.models (the enabled list) but it stays here, so the
// row remains visible with a dimmed checkbox. Fetched models keep their original behavior:
// off + a page switch → gone (the user can just re-fetch).
//
// Module scope ⇒ survives component unmount (page/provider switches) but not an app restart.
// On restart we fall back to draft.models; a manual model that was toggled off (and thus not
// in draft.models) is lost — accepted, since this is an in-memory-only convenience.
const manualModelsByProvider = new Map<string, Map<string, ProviderModel>>();

function rememberManualModel(providerId: string, model: ProviderModel): void {
  let bucket = manualModelsByProvider.get(providerId);
  if (!bucket) {
    bucket = new Map();
    manualModelsByProvider.set(providerId, bucket);
  }
  // Keep the identity-stable id on update; refresh everything else from the incoming model
  // so edits (display name, abilities, …) propagate to the cached copy too.
  const existing = bucket.get(model.modelId);
  bucket.set(model.modelId, existing ? { ...existing, ...model, id: existing.id } : model);
}

function forgetManualModel(providerId: string, modelId: string): void {
  manualModelsByProvider.get(providerId)?.delete(modelId);
}

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return items;
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  if (item === undefined) return items;
  next.splice(toIndex, 0, item);
  return next;
}

function providerKind(provider: ProviderProfile): string {
  return textValue(provider.type) || "openai";
}

function numberText(value: unknown): string {
  return typeof value === "number" || typeof value === "string" ? String(value) : "";
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

function PasswordInput({
  value,
  onChange,
  onBlur,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = React.useState(false);
  return (
    <div className="relative">
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        type={visible ? "text" : "password"}
        placeholder={placeholder}
        className="pr-10"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="absolute top-1/2 right-1 -translate-y-1/2"
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? t("settings:common.hide_key") : t("settings:common.show_key")}
        title={visible ? t("settings:common.hide_key") : t("settings:common.show_key")}
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </Button>
    </div>
  );
}

// 分隔符与后端 splitSearchApiKeys / APP KeyRoulette 一字一致(/[\s,]+/)。前端把字符串拆成多框编辑,
// 写回时再 join 成单字符串——数据结构不变,备份/APP 兼容零感知。
const SEARCH_KEY_SPLIT = /[\s,]+/;

/** 搜索服务多 Key 编辑器:每框一个 key,框尾「×」删除,底部「+」追加。
 *  测试结果按 key 精确匹配后内联显示绿勾/红叉(汇总区另有保留)。
 *
 *  数据流:父组件存字符串(后端 splitSearchApiKeys 契约,APP 兼容),但字符串往返
 *  (split/join)无法稳定表示"空框"——filter(Boolean) 会吃掉空串,点「+」追加的空框
 *  在 value 往返后消失(曾导致+号无反应)。故本地用 state 维护框数组,onChange 只回写
 *  非空 key 序列;外部 value 变化(切换服务/父重置)经 useEffect 比对非空序列后才同步,
 *  防覆盖编辑中的空框、也防 commit→onChange→value 往返触发循环。 */
function SearchApiKeyList({
  value,
  onChange,
  testEntries,
}: {
  value: string;
  onChange: (value: string) => void;
  testEntries: Array<{ key: string; status: "ok" | "fail"; failCode?: string }>;
}) {
  const { t } = useTranslation();
  const [keys, setKeys] = React.useState<string[]>(() => {
    const parts = value.split(SEARCH_KEY_SPLIT).map((k) => k.trim()).filter(Boolean);
    return parts.length > 0 ? parts : [""];
  });

  // 外部 value 变化时同步。只在"非空 key 序列"不一致时才 setKeys——既覆盖切换服务/
  // 父重置,又避免覆盖编辑中的空框/中间状态,还阻断 commit→onChange→value 往返循环。
  React.useEffect(() => {
    const parts = value.split(SEARCH_KEY_SPLIT).map((k) => k.trim()).filter(Boolean);
    const external = parts.length > 0 ? parts : [""];
    const localNonEmpty = keys.filter((k) => k.trim()).map((k) => k.trim());
    if (localNonEmpty.join("\n") !== external.join("\n")) setKeys(external);
    // 故意不依赖 keys:commit 时本地已 setKeys,不需要 value 回来再同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // 本地立即更新(保留空框);onChange 只回写非空 key(换行 join——换行属于 \s,
  // 与后端 /[\s,]+/ 兼容,key 不含换行,比逗号/空格更不易和 key 本身冲突)。
  const commit = (next: string[]) => {
    setKeys(next);
    onChange(next.filter((k) => k.trim()).join("\n"));
  };
  const update = (index: number, val: string) => {
    const next = [...keys];
    next[index] = val;
    commit(next);
  };
  const add = () => commit([...keys, ""]);
  const remove = (index: number) => {
    if (keys.length <= 1) {
      commit([""]); // 唯一框:删 = 清空,仍保留一个可编辑框
      return;
    }
    commit(keys.filter((_, i) => i !== index));
  };
  // 失焦时收掉尾部连续空框(点 + 又没填)。中间空框不动——用户可能还要填。
  const trimTrailingEmpty = () => {
    let next = [...keys];
    while (next.length > 1 && next[next.length - 1].trim() === "") next.pop();
    if (next.length !== keys.length) commit(next);
  };

  return (
    <div className="space-y-2">
      {keys.map((key, index) => {
        // 改了 key 后字符串变化,旧测试结果自动对不上、图标消失——符合预期。
        const entry = key ? testEntries.find((e) => e.key === key) : undefined;
        return (
          <div key={index} className="flex items-center gap-2">
            <div className="flex-1">
              <PasswordInput value={key} onChange={(v) => update(index, v)} onBlur={trimTrailingEmpty} />
            </div>
            {entry ? (
              entry.status === "ok" ? (
                <CheckCircle2
                  className="size-4 shrink-0 text-emerald-500"
                  aria-label={t("settings:search.key_ok")}
                />
              ) : (
                <XCircle
                  className="size-4 shrink-0 text-destructive"
                  aria-label={t(`settings:search.key_fail_${entry.failCode ?? "other"}`)}
                />
              )
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => remove(index)}
              aria-label={t("settings:search.key_remove")}
              title={t("settings:search.key_remove")}
            >
              <X className="size-4" />
            </Button>
          </div>
        );
      })}
      {/* +号独立放底部:所有 key 框只有 input+叉号,等宽;末框不再被+号挤窄。 */}
      <Button type="button" variant="outline" size="sm" onClick={add} className="w-full justify-center">
        <Plus className="size-4" />
        {t("settings:search.key_add")}
      </Button>
    </div>
  );
}

const DEFAULT_PROMPTS = {
  titlePrompt: `I will give you some dialogue content in the \`<content>\` block.
You need to summarize the conversation between user and assistant into a short title.
1. The title language should be consistent with the user's primary language
2. Do not use punctuation or other special symbols
3. Reply directly with the title
4. Summarize using {locale} language
5. The title should not exceed 15 characters

<content>
{content}
</content>`,
  translatePrompt: `You are a translation expert, skilled in translating various languages, and maintaining accuracy, faithfulness, and elegance in translation.
Next, I will send you text. Please translate it into {target_lang}, and return the translation result directly, without adding any explanations or other content.

Please translate the <source_text> section:

<source_text>
{source_text}
</source_text>`,
  suggestionPrompt: `I will provide you with some chat content in the \`<content>\` block, including conversations between the User and the AI assistant.
You need to act as the **User** to reply to the assistant, generating 3~5 appropriate and contextually relevant responses to the assistant.

Rules:
1. Reply directly with suggestions, do not add any formatting, and separate suggestions with newlines, no need to add markdown list formats.
2. Use {locale} language.
3. Ensure each suggestion is valid.
4. Each suggestion should not exceed 18 characters.
5. Imitate the user's previous conversational style.
6. Act as a User, not an Assistant!

<content>
{content}
</content>`,
  ocrPrompt: `You are an OCR assistant.

Extract all visible text from the image and also describe any non-text elements (icons, shapes, arrows, objects, symbols, or emojis).

For each element, specify:
- The exact text (for text) or a short description (for non-text).
- For document-type content, please use markdown and latex format.
- If there are objects like buildings or characters, try to identify who they are.
- Its approximate position in the image (e.g., 'top left', 'center right', 'bottom middle').
- Its spatial relationship to nearby elements (e.g., 'above', 'below', 'next to', 'on the left of').

Keep the original reading order and layout structure as much as possible.
Do not interpret or translate-only transcribe and describe what is visually present.`,
  compressPrompt: `You are a conversation compression assistant. Compress the following conversation into a concise summary.

Requirements:
1. Preserve key facts, decisions, and important context that would be needed to continue the conversation
2. Keep the summary in the same language as the original conversation
3. Target approximately {target_tokens} tokens
4. Output the summary directly without any explanations or meta-commentary
5. Format the summary as context information that can be used to continue the conversation
6. Use {locale} language
7. Start the output with a clear indicator that this is a summary (e.g., "[Summary of previous conversation]" or equivalent in the target language)

{additional_context}

<conversation>
{content}
</conversation>`,
  promptOptimizePrompt: `你是一位资深的提示词优化专家。下面会给你一段用户准备发给 AI 助手的话(提示词草稿),你的任务是把它打磨成清晰、得体、表达专业的版本,让 AI 更容易准确理解、给出更好的回复。这段话可能是提问、写作请求、修改要求、闲聊,或任何日常诉求——不限于某个领域。

## 优化原则

1. **严格保留原意,不要无中生有** —— 只能基于用户实际写出的内容来优化,不增加用户没有提出的诉求,不删减已表达的内容,不擅自改变核心意图。不要替用户补充他没有提供的具体信息(比如他说"帮我写封邮件",你不能擅自编造收件人、事由、语气);某处信息缺失或含糊时,就让表达更清楚、更有条理,但不要凭空捏造细节。你的职责是打磨表达,不是替用户重新定义需求。如果原文已经清晰得体,原样输出即可,不要为了优化而画蛇添足。

2. **消除歧义** —— 用户常用模糊或笼统的表述("弄一下""优化一下""帮我处理那个")。如果下方附带了对话背景、且提示词明显在承接它(出现"那个""上面说的""再…一下"等指代),请结合背景理解这些指代具体指向什么;如果没有背景或仍无法确定,保留原表述,不要凭空猜测后替换——错误的猜测比模糊更糟。

3. **让表达更清楚、更有条理** —— 把口语化、啰嗦、跳跃的表述梳理得通顺连贯。如果诉求包含多个要点(背景、需求、约束、期望的输出格式或语气),用分节或编号列表清晰组织;如果只是一句话的简单请求,保持简洁,不要用多余的框架稀释重点——简洁本身就是专业。

4. **用词得体专业** —— 在不改变原意的前提下,把模糊、随意的说法换成更准确、更得体的表达,让模糊的动词变成具体的动作。例如:"帮我弄个东西" → 点明具体要做什么;"写个东西给老板" → 明确是邮件 / 汇报 / 请示中的哪一种;"弄好看点" → 指明是调整措辞 / 优化排版 / 精简结构;"翻译一下" → 点明源语言、目标语言、要保留的风格。注意保持原文的语域——正式的保持规整,轻松的别写得僵硬。

5. **必要时点明隐含期望** —— 如果提示词隐含了目标读者、语气、篇幅、输出格式(如希望分点回答、举例、简短)或希望 AI 扮演的角色,且能从上下文或常识中合理推断,将其显式写出。无法合理推断的不要编造,也不要强加用户没有暗示的要求。

6. **保持原文语言** —— 中文保持中文,英文保持英文,不要翻译,不要自行添加用户未要求的外语。

7. **原样保留特殊内容** —— 原文中的模板占位符(如 {{name}}、{topic}、<url>、[日期])、代码块、数据、公式、引用原样保留,不修改、不"改进"。只优化这些固定内容之外的说明性文字。

## 输出要求

只输出优化后的那段话本身。不要写任何前言、解释、"以下是优化版本"之类的引导语,不要用引号包裹结果,不要在末尾追加说明。用户会把你的输出直接读进输入框——任何提示词以外的文字都是干扰。`,
};

function balanceOptionOf(provider: ProviderProfile): Record<string, unknown> {
  return provider.balanceOption && typeof provider.balanceOption === "object"
    ? (provider.balanceOption as Record<string, unknown>)
    : {};
}

function defaultPathForKind(kind: ProviderKind, responseApi = false): string {
  if (kind === "openai") return responseApi ? "/responses" : "/chat/completions";
  if (kind === "claude") return "/messages";
  return "/models/{model}:generateContent";
}

// 预置供应商的"获取 API Key"官网映射。按 baseUrl 子串匹配(大小写无关)。
// 供应商表单的 API Key 标签旁,命中即显示一个靠右的"获取 API Key"链接,跳转官网。
// 新增预置供应商时只需在这里加一行 { 子串: 官网 URL }。
const PROVIDER_GET_KEY_URLS: Array<{ match: RegExp; url: string }> = [
  { match: /naapi\.cc/i, url: "https://naapi.cc/" },
];
function providerGetKeyUrl(baseUrl: string): string | null {
  for (const entry of PROVIDER_GET_KEY_URLS) {
    if (entry.match.test(baseUrl)) return entry.url;
  }
  return null;
}

function endpointPreview(provider: ProviderProfile): string {
  const kind = providerKind(provider) as ProviderKind;
  const base = textValue(provider.baseUrl).replace(/\/+$/, "");
  if (!base) return defaultPathForKind(kind, provider.useResponseApi === true);
  if (kind === "openai")
    return `${base}${provider.useResponseApi === true ? "/responses" : textValue(provider.chatCompletionsPath) || "/chat/completions"}`;
  if (kind === "claude") return `${base}/messages`;
  return `${base}/models/{model}:generateContent?key=${textValue(provider.apiKey) ? "***" : "<API_KEY>"}`;
}

function modelListEndpointPreview(provider: ProviderProfile): string {
  const kind = providerKind(provider) as ProviderKind;
  const base = textValue(provider.baseUrl).replace(/\/+$/, "");
  if (!base) return kind === "google" ? "/models?pageSize=100&key=<API_KEY>" : "/models";
  if (kind === "google")
    return `${base}/models?pageSize=100&key=${textValue(provider.apiKey) ? "***" : "<API_KEY>"}`;
  return `${base}/models`;
}

function createProvider(): ProviderProfile {
  return {
    id: crypto.randomUUID(),
    type: "openai",
    enabled: true,
    name: "自定义供应商",
    builtIn: false,
    shortDescription: "用户添加的 OpenAI-compatible API",
    description: "",
    apiKey: "",
    baseUrl: "https://api.example.com/v1",
    chatCompletionsPath: "/chat/completions",
    useResponseApi: false,
    // 与安卓 OpenAI provider 默认值一致 (commit e63d017)
    includeHistoryReasoning: true,
    models: [],
    balanceOption: { enabled: false, apiPath: "/credits", resultPath: "data.total_credits" },
  };
}

const DEFAULT_CUSTOM_JS_SEARCH_SCRIPT = `async function search(query, resultSize) {
  const encoded = encodeURIComponent(query);
  const res = await fetch("https://example.com/search?q=" + encoded + "&limit=" + resultSize);
  const data = await res.json();
  return {
    items: data.results.map(function(r) {
      return { title: r.title, url: r.url, text: r.snippet };
    })
  };
}`;

const DEFAULT_CUSTOM_JS_SCRAPE_SCRIPT = `async function scrape(urls) {
  return {
    urls: await Promise.all(urls.map(async function(url) {
      const res = await fetch(url);
      const body = await res.text();
      return { url: url, content: body };
    }))
  };
}`;

function createSearchService(): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    type: "tavily",
    name: "Tavily",
    apiKey: "",
    depth: "advanced",
  };
}

function toSearchService(value: Record<string, unknown>): SearchServiceOption {
  return { ...value, id: String(value.id ?? crypto.randomUUID()) } as SearchServiceOption;
}

function normalizeKindPatch(provider: ProviderProfile, kind: ProviderKind): ProviderProfile {
  const nextBaseUrl =
    kind === "claude"
      ? "https://api.anthropic.com/v1"
      : kind === "google"
        ? "https://generativelanguage.googleapis.com/v1beta"
        : textValue(provider.baseUrl) || "https://api.openai.com/v1";
  return {
    ...provider,
    type: kind,
    baseUrl: nextBaseUrl,
    useResponseApi: kind === "openai" ? provider.useResponseApi === true : false,
    chatCompletionsPath: defaultPathForKind(
      kind,
      kind === "openai" && provider.useResponseApi === true,
    ),
  };
}

export function meta() {
  return [{ title: "RikkaHub PC 设置" }];
}

export default function SettingsPage() {
  const { t } = useTranslation();
  const streamedSettings = useSettingsStore((state) => state.settings);
  const setStreamedSettings = useSettingsStore((state) => state.setSettings);
  const [settings, setSettings] = React.useState<Settings | null>(streamedSettings);
  const [section, setSection] = React.useState<Section>("general");
  const [logs, setLogs] = React.useState<RequestLog[]>([]);
  const [stats, setStats] = React.useState<StatsPayload | null>(null);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const querySection = params.get("section");
    if (querySection && navItems.some((item) => item.id === querySection)) {
      setSection(querySection as Section);
    }
  }, []);

  React.useEffect(() => {
    if (streamedSettings) setSettings(streamedSettings);
  }, [streamedSettings]);

  React.useEffect(() => {
    if (settings) return;
    api
      .get<Settings>("settings")
      .then(setSettings)
      .catch((error: Error) => toast.error(error.message));
  }, [settings]);

  React.useEffect(() => {
    if (section !== "logs") return;
    api
      .get<RequestLog[]>("logs")
      .then(setLogs)
      .catch((error: Error) => toast.error(error.message));
  }, [section]);

  const clearLogs = React.useCallback(async () => {
    if (!window.confirm(t("settings:logs.clear_confirm"))) return;
    try {
      await api.delete("logs");
      setLogs([]);
      toast.success(t("settings:logs.cleared"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [t]);

  React.useEffect(() => {
    if (section !== "stats") return;
    api
      .get<StatsPayload>("stats")
      .then(setStats)
      .catch((error: Error) => toast.error(error.message));
  }, [section]);

  if (!settings) {
    return (
      <div className="flex h-svh items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        {t("settings:providers.loading")}
      </div>
    );
  }

  const updateLocal = (next: Settings) => {
    setSettings(next);
    setStreamedSettings(next);
  };

  return (
    <div className="flex h-svh overflow-hidden bg-background">
      <aside className="flex w-64 flex-col border-r border-divider bg-sidebar text-sidebar-foreground">
        {/* pt-9 让出沉浸式标题栏高度,标题栏透明后内容仍顶到窗口顶但不会被盖住。
            border-divider:用比 --border 更淡的分界色,让区域分隔退到背景里。 */}
        <div className="flex items-center gap-2 border-b border-divider px-4 pb-3 pt-9">
          <Button asChild size="icon-sm" variant="ghost">
            <Link to="/">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <div>
            <div className="text-sm font-semibold">RikkaHub PC</div>
            <div className="text-xs text-muted-foreground">{t("settings:nav.subtitle")}</div>
          </div>
        </div>
        <nav className="space-y-1 p-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = item.id === section;
            return (
              <button
                key={item.id}
                type="button"
                className={cn(
                  "relative flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-all duration-200",
                  active
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/70",
                  active &&
                    "before:absolute before:left-0 before:top-1/2 before:h-5 before:w-[3px] before:-translate-y-1/2 before:rounded-r-full before:bg-sidebar-primary",
                )}
                onClick={() => setSection(item.id)}
              >
                <Icon
                  className={cn(
                    "size-4 transition-colors",
                    active ? "text-sidebar-primary" : "text-muted-foreground",
                  )}
                />
                {t(item.labelKey)}
              </button>
            );
          })}
        </nav>
      </aside>
      <main className="min-w-0 flex-1">
        <ScrollArea className="h-svh">
          <div className="mx-auto w-full max-w-5xl px-6 pb-6 pt-9">
            {/* pt-9 与左侧 aside 顶部对齐,让出沉浸式透明标题栏高度,避免各板块内容贴顶。 */}
            {section === "general" && (
              <GeneralSection settings={settings} onSettings={updateLocal} />
            )}
            {section === "providers" && (
              <ProvidersSection settings={settings} onSettings={updateLocal} />
            )}
            {section === "models" && (
              <DefaultModelsSection settings={settings} onSettings={updateLocal} />
            )}
            {section === "assistants" && (
              <AssistantsSection settings={settings} onSettings={updateLocal} />
            )}
            {section === "search" && <SearchSection settings={settings} onSettings={updateLocal} />}
            {section === "mcp" && (
              <McpExtensionsSection settings={settings} onSettings={updateLocal} />
            )}
            {section === "speech" && <SpeechSection settings={settings} onSettings={updateLocal} />}
            {section === "memory" && <MemorySection settings={settings} onSettings={updateLocal} />}
            {section === "data" && <DataSection settings={settings} onSettings={updateLocal} />}
            {section === "stats" && <StatsSection stats={stats} />}
            {section === "logs" && <LogsSection logs={logs} onClear={clearLogs} />}
            {section === "proxy" && <ProxySection settings={settings} onSettings={updateLocal} />}
            {section === "donate" && <DonateSection />}
            {section === "about" && <AboutSection />}
          </div>
        </ScrollArea>
      </main>
    </div>
  );
}

function SectionHeader({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mb-6 flex items-start gap-3">
      <div className="rounded-md border bg-card p-2">
        <Icon className="size-5" />
      </div>
      <div>
        <h1 className="text-2xl font-semibold tracking-normal">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}

function SortableRow({
  id,
  index,
  active,
  children,
  onSelect,
  onMove,
}: {
  id: string;
  index: number;
  active?: boolean;
  children: React.ReactNode;
  onSelect?: () => void;
  onMove?: (from: number, to: number) => void;
}) {
  const [over, setOver] = React.useState(false);
  const canMove = typeof onMove === "function";
  return (
    <div
      draggable={canMove}
      onDragStart={(event) => {
        if (!canMove) return;
        event.dataTransfer.setData("text/plain", String(index));
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(event) => {
        if (!canMove) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => {
        if (canMove) setOver(false);
      }}
      onDrop={(event) => {
        if (!canMove) return;
        event.preventDefault();
        setOver(false);
        const from = Number(event.dataTransfer.getData("text/plain"));
        if (Number.isFinite(from)) onMove?.(from, index);
      }}
      className={[
        "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition",
        active ? "bg-accent" : "hover:bg-accent/60",
        over ? "ring-2 ring-primary/40" : "",
      ].join(" ")}
      data-sort-id={id}
    >
      {canMove ? (
        <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground" />
      ) : null}
      <button type="button" className="min-w-0 flex-1" onClick={onSelect}>
        {children}
      </button>
    </div>
  );
}

function GeneralSection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const display = settings.displaySetting;
  const [name, setName] = React.useState(textValue(display.userNickname));
  const [avatar, setAvatar] = React.useState<AssistantAvatar>(
    display.userAvatar ?? { type: "dummy" },
  );
  const [saving, setSaving] = React.useState(false);
  const profileDirtyRef = React.useRef(false);

  // --- 窗口行为(最小化到托盘 / 退出)—— 仅 Tauri 桌面端渲染 ---
  // 该设置存在 Rust 侧的 user-config.json(跟数据目录同处),不走后端 API/SSE,
  // 因为窗口关闭的瞬间需要 Rust 直接读到它,而不是等前端回传。
  const [tauriReady, setTauriReady] = React.useState(false);
  const [minimizeToTray, setMinimizeToTray] = React.useState(true);
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
      setTauriReady(true);
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const v = await invoke<boolean>("get_minimize_to_tray");
        if (!cancelled) setMinimizeToTray(v);
      } catch (err) {
        console.warn("[tray] get_minimize_to_tray failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 界面字号滑块的本地镜像值。受控 Slider 的 value 若等 POST→SSE 往返才更新,松手时 thumb 会
  // 被旧 value 弹回(用户体验为"拖过去又弹回来")。改用:onValueChange 只动本地(立即跟随),
  // onValueCommit(松手)才提交后端。display 变化时(重置按钮 / SSE 推送)同步回本地。
  const uiFontSizeValue = display.uiFontSize ?? 1;
  const [uiFontSlider, setUiFontSlider] = React.useState(uiFontSizeValue);
  React.useEffect(() => {
    setUiFontSlider(uiFontSizeValue);
  }, [uiFontSizeValue]);

  React.useEffect(() => {
    setName(textValue(display.userNickname));
    setAvatar(display.userAvatar ?? { type: "dummy" });
    profileDirtyRef.current = false;
  }, [display.userNickname, display.userAvatar]);

  const patchDisplay = async (patch: Record<string, unknown>) => {
    const nextDisplay = { ...settings.displaySetting, ...patch };
    await api.post("settings/display", nextDisplay);
    onSettings({ ...settings, displaySetting: nextDisplay });
  };

  const save = async (announce = false) => {
    if (!announce && !profileDirtyRef.current) return;
    setSaving(true);
    try {
      await patchDisplay({ userNickname: name.trim(), userAvatar: avatar });
      profileDirtyRef.current = false;
      if (announce) toast.success(t("settings:general.profile_saved"));
    } catch (error) {
      if (announce)
        toast.error(error instanceof Error ? error.message : t("settings:common.save_failed"));
      else console.warn("Profile auto-save failed", error);
    } finally {
      setSaving(false);
    }
  };

  React.useEffect(() => {
    if (!profileDirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void save(false);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [name, avatar]);

  return (
    <>
      <SectionHeader
        icon={UserRound}
        title={t("settings:general.title")}
        subtitle={t("settings:general.subtitle")}
      />
      <div className="grid gap-6">
        <div className="space-y-4 rounded-lg border bg-card p-5">
          <AvatarCropper
            value={avatar}
            fallbackName={name || "User"}
            onChange={async (nextAvatar) => {
              setAvatar(nextAvatar);
              const nextDisplay = {
                ...settings.displaySetting,
                userNickname: name.trim(),
                userAvatar: nextAvatar,
              };
              await api.post("settings/display", nextDisplay);
              onSettings({ ...settings, displaySetting: nextDisplay });
            }}
          />
          <Separator />
          <label className="block space-y-2">
            <span className="text-sm font-medium">{t("settings:general.nickname")}</span>
            <Input
              value={name}
              onChange={(event) => {
                profileDirtyRef.current = true;
                setName(event.target.value);
              }}
            />
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            <FontPickerPair
              label={t("settings:general.ui_font")}
              enValue={textValue(display.uiFontFamily)}
              cjkValue={textValue(display.uiFontFamilyCjk)}
              fallbackFamily={
                '"Noto Sans SC", "Microsoft YaHei", ui-sans-serif, system-ui, sans-serif'
              }
              onChangeEn={(value, family) =>
                void patchDisplay({ uiFontFamily: value, uiFontFamilyCss: family })
              }
              onChangeCjk={(value, family) =>
                void patchDisplay({ uiFontFamilyCjk: value, uiFontFamilyCjkCss: family })
              }
            />
            <FontPickerPair
              label={t("settings:general.chat_font")}
              enValue={textValue(display.chatFontFamily)}
              cjkValue={textValue(display.chatFontFamilyCjk)}
              fallbackFamily={
                textValue(display.uiFontFamilyCss) ||
                '"Noto Sans SC", "Microsoft YaHei", ui-sans-serif, system-ui, sans-serif'
              }
              onChangeEn={(value, family) =>
                void patchDisplay({ chatFontFamily: value, chatFontFamilyCss: family })
              }
              onChangeCjk={(value, family) =>
                void patchDisplay({ chatFontFamilyCjk: value, chatFontFamilyCjkCss: family })
              }
            />
          </div>
          <div className="block space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{t("settings:general.ui_font_size")}</span>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs tabular-nums">
                  {Math.round(uiFontSlider * 100)}%
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  disabled={(display.uiFontSize ?? null) === null}
                  onClick={() => void patchDisplay({ uiFontSize: null })}
                >
                  {t("settings:general.reset")}
                </Button>
              </div>
            </div>
            <Slider
              value={[uiFontSlider]}
              min={0.85}
              max={1.2}
              step={0.01}
              aria-label={t("settings:general.ui_font_size")}
              onValueChange={(value) => setUiFontSlider(value[0])}
              onValueCommit={(value) => {
                const next = value[0];
                // 1.00 视为"默认",存 null 以保持根字号完全等同于浏览器默认,
                // 避免任何浮点误差引入的默认态视觉偏差。
                const normalized = Math.abs(next - 1) < 0.001 ? null : Number(next.toFixed(2));
                void patchDisplay({ uiFontSize: normalized });
              }}
            />
            <p className="text-muted-foreground text-xs">
              {t("settings:general.ui_font_size_hint")}
            </p>
          </div>
          <div className="rounded-md border px-3 py-3">
            <KeybindingSettings />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {[
              ["showUserAvatar", "settings:general.opt.show_user_avatar"],
              ["showAssistantBubble", "settings:general.opt.show_assistant_bubble"],
              ["showModelIcon", "settings:general.opt.show_model_icon"],
              ["showModelName", "settings:general.opt.show_model_name"],
              ["showTokenUsage", "settings:general.opt.show_token_usage"],
              ["showThinkingContent", "settings:general.opt.show_thinking"],
              ["sendOnEnter", "settings:general.opt.send_on_enter"],
              ["enableAutoScroll", "settings:general.opt.auto_scroll"],
            ].map(([key, labelKey]) => (
              <label
                key={key}
                className="flex items-center justify-between rounded-md border px-3 py-2"
              >
                <span className="text-sm">{t(labelKey)}</span>
                <Switch
                  checked={display[key] !== false}
                  onCheckedChange={(checked) => void patchDisplay({ [key]: checked })}
                />
              </label>
            ))}
          </div>
          <div className="flex justify-end text-xs text-muted-foreground">
            {saving ? t("settings:common.autosaving") : t("settings:common.autosaved")}
          </div>
        </div>
        {tauriReady && (
          <div className="space-y-4 rounded-lg border bg-card p-5">
            <div>
              <h2 className="text-base font-medium">{t("settings:general.tray_title")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t("settings:general.tray_desc")}</p>
            </div>
            <label className="flex items-start justify-between gap-4 rounded-md border px-3 py-3">
              <div className="min-w-0">
                <div className="text-sm">{t("settings:general.minimize_to_tray")}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {t("settings:general.minimize_to_tray_hint")}
                </div>
              </div>
              <Switch
                checked={minimizeToTray}
                onCheckedChange={async (checked) => {
                  // 乐观更新:先改 UI,失败回滚。invoke 走 Tauri command 写 user-config.json。
                  const prev = minimizeToTray;
                  setMinimizeToTray(checked);
                  try {
                    const { invoke } = await import("@tauri-apps/api/core");
                    await invoke("set_minimize_to_tray", { enabled: checked });
                  } catch (err) {
                    setMinimizeToTray(prev);
                    toast.error(t("settings:common.save_failed"));
                    console.warn("[tray] set_minimize_to_tray failed", err);
                  }
                }}
              />
            </label>
            <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-3">
              <div className="min-w-0">
                <div className="text-sm">{t("settings:general.quit_app")}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {t("settings:general.quit_app_hint")}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    const { exit } = await import("@tauri-apps/plugin-process");
                    await exit(0);
                  } catch (err) {
                    toast.error(t("settings:general.quit_failed"));
                    console.warn("[tray] exit failed", err);
                  }
                }}
              >
                {t("settings:general.quit_app_button")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function ProvidersSection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  // URL ?providerId= deep-link is only honored on first mount, so subsequent settings updates
  // (autosave, SSE) don't snap the selection back to the URL value or the default first provider.
  const initialProviderId = React.useMemo(() => {
    if (typeof window === "undefined") return settings.providers[0]?.id ?? "";
    const providerId = new URLSearchParams(window.location.search).get("providerId");
    if (providerId && settings.providers.some((provider) => provider.id === providerId))
      return providerId;
    return settings.providers[0]?.id ?? "";
    // Intentionally empty deps: capture only the initial value. We don't want to re-derive on
    // every settings update because that pulls selectedId back to the default.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const urlProviderId = React.useMemo(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("providerId");
  }, []);
  const focusedModelId = React.useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("modelId") ?? "";
  }, []);
  const [selectedId, setSelectedId] = React.useState(initialProviderId);
  const selected =
    settings.providers.find((provider) => provider.id === selectedId) ?? settings.providers[0];
  const [draft, setDraft] = React.useState<ProviderProfile | null>(
    selected ? clone(selected) : null,
  );
  const [testing, setTesting] = React.useState(false);
  const [fetchingModels, setFetchingModels] = React.useState(false);
  const [testResult, setTestResult] = React.useState("");
  const [testChecks, setTestChecks] = React.useState<ProviderTestCheck[]>([]);
  const [testInfo, setTestInfo] = React.useState<ProviderTestInfo | null>(null);
  const [checkingBalance, setCheckingBalance] = React.useState(false);
  const [balanceResult, setBalanceResult] = React.useState("");
  const [fetchedModels, setFetchedModels] = React.useState<ProviderModel[]>([]);
  // Free-text filter for the model list. Cleared whenever the user switches provider.
  const [modelFilter, setModelFilter] = React.useState("");
  const [testModelId, setTestModelId] = React.useState("");
  const [imageTestResult, setImageTestResult] = React.useState<{
    url: string;
    durationMs: number;
    modelId: string;
    prompt: string;
  } | null>(null);
  const dirtyRef = React.useRef(false);
  const lastSelectedRef = React.useRef(selectedId);

  // Only honor ?providerId=... deep-link navigation when the URL parameter is actually present
  // AND it differs from current selection. Otherwise (no URL param), do not reassert anything —
  // the user's clicks must win.
  React.useEffect(() => {
    if (!urlProviderId) return;
    if (urlProviderId === selectedId) return;
    if (!settings.providers.some((provider) => provider.id === urlProviderId)) return;
    setSelectedId(urlProviderId);
  }, [urlProviderId, selectedId, settings.providers]);

  // providersRef lets this realignment effect read the freshest providers list without
  // depending on settings.providers — otherwise every autosave → onSettings round-trip
  // re-fires the effect and overwrites mid-flight keystrokes. Same class of bug as
  // McpServerEditor; see there for the full rationale.
  const providersRef = React.useRef(settings.providers);
  providersRef.current = settings.providers;
  React.useEffect(() => {
    const next =
      providersRef.current.find((provider) => provider.id === selectedId) ?? providersRef.current[0];
    const selectedChanged = lastSelectedRef.current !== selectedId;
    lastSelectedRef.current = selectedId;
    setDraft(next ? clone(next) : null);
    dirtyRef.current = false;
    if (selectedChanged) {
      setFetchedModels([]);
      setModelFilter("");
      setTestResult("");
      setTestChecks([]);
      setTestInfo(null);
      setBalanceResult("");
      setImageTestResult(null);
      setTestModelId(next?.models?.find((model) => model.modelId !== "auto")?.modelId ?? "");
    }
  }, [selectedId]);

  if (!draft) return null;
  const balanceOption = balanceOptionOf(draft);
  const kind = providerKind(draft) as ProviderKind;
  const selectedModelIds = new Set((draft.models ?? []).map((model) => model.modelId));
  // Display source: merge fetchedModels with draft.models, deduping by modelId. Fetched
  // entries win on overlap (canonical upstream view); manually-added extras are appended.
  // Persisted per-row customizations are still applied downstream via the `persisted` lookup.
  // Manual models that were toggled off (absent from draft.models) are re-merged from the
  // in-memory manual cache so they stay visible instead of disappearing — see
  // manualModelsByProvider above. Fetched models are NOT cached: toggled off + a page switch
  // still clears them (re-fetch to bring them back), preserving the original behavior.
  const displayModels: ProviderModel[] = (() => {
    const fetched = fetchedModels;
    const drafts = draft.models ?? [];
    const fetchedIds = new Set(fetched.map((m) => m.modelId));
    // Start from fetched (canonical) + drafts not in fetched.
    const base = fetched.length === 0 ? drafts : [...fetched, ...drafts.filter((m) => !fetchedIds.has(m.modelId))];
    // Re-add cached manual models that have dropped out of draft.models (toggled off).
    const baseIds = new Set(base.map((m) => m.modelId));
    const cachedManual = manualModelsByProvider.get(draft.id);
    const danglingManual = cachedManual
      ? Array.from(cachedManual.values()).filter((m) => !baseIds.has(m.modelId))
      : [];
    const merged = danglingManual.length > 0 ? [...base, ...danglingManual] : base;
    // Manual models float to the top — they're user-authored (no upstream source) and tend to
    // be the ones the user cares about most; newly-added ones already sit at the head of
    // draft.models, so this surfaces them immediately instead of burying them under the
    // fetched list. Stable order preserved within each group.
    if (merged.length <= 1) return merged;
    const manual: ProviderModel[] = [];
    const rest: ProviderModel[] = [];
    for (const model of merged) {
      (model.manuallyAdded === true ? manual : rest).push(model);
    }
    return manual.length > 0 ? [...manual, ...rest] : rest;
  })();
  // Free-text filter (name or id). Applied on top of displayModels for the list view.
  const visibleModels = (() => {
    const query = modelFilter.trim().toLowerCase();
    if (!query) return displayModels;
    return displayModels.filter(
      (model) =>
        (model.displayName ?? "").toLowerCase().includes(query) ||
        (model.modelId ?? "").toLowerCase().includes(query),
    );
  })();
  // Whether every currently-visible (filtered) model is already enabled — drives the
  // select-all toggle label + click behavior. Acts on visibleModels, not the full set,
  // so "select filtered" works intuitively when searching.
  const allFilteredEnabled =
    visibleModels.length > 0 && visibleModels.every((model) => selectedModelIds.has(model.modelId));
  const fetchedModelIds = new Set(fetchedModels.map((model) => model.modelId));
  const mergedTestModels = [
    ...fetchedModels,
    ...(draft.models ?? []).filter(
      (model) => model.modelId !== "auto" && !fetchedModelIds.has(model.modelId),
    ),
  ].filter((model) => model.modelId !== "auto");
  const effectiveTestModelId =
    (testModelId && mergedTestModels.some((model) => model.modelId === testModelId)
      ? testModelId
      : mergedTestModels[0]?.modelId) || "";
  // The selected test model's persisted record drives whether we run the image-gen test path
  // (and hide the 3-mode chat panel) vs the chat test path.
  const effectiveTestModelType = (() => {
    const persisted = (draft.models ?? []).find((item) => item.modelId === effectiveTestModelId);
    const merged = mergedTestModels.find((item) => item.modelId === effectiveTestModelId);
    return String(persisted?.type ?? merged?.type ?? "CHAT").toUpperCase();
  })();
  const isImageTestMode = effectiveTestModelType === "IMAGE";

  const patchDraft = (patch: Partial<ProviderProfile>) => {
    dirtyRef.current = true;
    setDraft({ ...draft, ...patch });
  };
  const save = async () => {
    const nextProvider = draft;
    await api.post("settings/provider", nextProvider);
    onSettings({
      ...settings,
      providers: settings.providers.map((provider) =>
        provider.id === nextProvider.id ? nextProvider : provider,
      ),
    });
    dirtyRef.current = false;
  };
  React.useEffect(() => {
    if (!draft || !dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void api
        .post("settings/provider", draft)
        .then(() => {
          dirtyRef.current = false;
          onSettings({
            ...settings,
            providers: settings.providers.map((provider) =>
              provider.id === draft.id ? draft : provider,
            ),
          });
        })
        .catch((error: Error) => toast.error(error.message || t("settings:providers.autosave_failed")));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [draft, onSettings, settings]);
  const test = async () => {
    setTesting(true);
    setTestChecks([]);
    setTestInfo(null);
    setImageTestResult(null);
    // If user picked an IMAGE-type model, run a dedicated image-generation test instead of
    // the 3-mode chat test. Matches Android, which never tries chat completions for IMAGE models.
    const requestedModelId = effectiveTestModelId;
    const selectedTestModel =
      (draft.models ?? []).find((item) => item.modelId === requestedModelId) ??
      mergedTestModels.find((item) => item.modelId === requestedModelId) ??
      null;
    if (selectedTestModel && (selectedTestModel.type as string) === "IMAGE") {
      setTestResult(t("settings:providers.test_img_starting"));
      try {
        await save();
        const started = Date.now();
        const response = await api.post<{
          status: string;
          image: { url: string; mime: string; fileName: string };
        }>(
          "settings/provider/test/image",
          { providerId: draft.id, modelId: requestedModelId },
          { timeout: false },
        );
        const durationMs = Date.now() - started;
        const url = response.image?.url ?? "";
        setImageTestResult({
          url,
          durationMs,
          modelId: requestedModelId,
          prompt: "A red apple on a white background",
        });
        setTestResult(
          t("settings:providers.test_img_done", {
            model: requestedModelId,
            duration: (durationMs / 1000).toFixed(2),
            file: response.image?.fileName ?? "-",
          }),
        );
        onSettings(await api.get<Settings>("settings"));
        toast.success(t("settings:providers.test_img_ok"));
      } catch (error) {
        const message = error instanceof Error ? error.message : t("settings:providers.test_img_failed");
        setTestResult(message);
        toast.error(message);
      } finally {
        setTesting(false);
      }
      return;
    }
    setTestResult(t("settings:providers.test_starting"));
    try {
      await save();
      const response = await fetch(appendWebAuthQuery("/api/settings/provider/test/stream"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ providerId: draft.id, modelId: requestedModelId || undefined }),
      });
      if (!response.ok || !response.body) {
        if (response.status !== 404) {
          const text = await response.text();
          throw new Error(text || `HTTP ${response.status}`);
        }
        const fallback = await api.post<ProviderTestInfo>(
          "settings/provider/test",
          { providerId: draft.id, modelId: requestedModelId || undefined },
          { timeout: false },
        );
        const checks = (fallback.checks ?? [])
          .map(
            (item) =>
              `${item.ok ? "✓" : "×"} ${item.mode}: ${item.status || "failed"}\n${item.preview}`,
          )
          .join("\n\n");
        setTestInfo(fallback);
        setTestChecks(fallback.checks ?? []);
        setTestModelId(fallback.testModelId);
        setTestResult(
          t("settings:providers.test_done_fallback", {
            model: fallback.testModelId,
            endpoint: fallback.endpoint,
            chatEndpoint: fallback.responseApiEndpoint,
            count: fallback.modelCount,
            checks,
            preview: fallback.preview,
          }),
        );
        onSettings(await api.get<Settings>("settings"));
        toast.success(t("settings:providers.test_done_ok"));
        return;
      }
      const checks: ProviderTestCheck[] = [];
      let info: ProviderTestInfo | null = null;
      const renderResult = (prefix = "") => {
        setTestInfo(info);
        setTestChecks([...checks]);
        const header = info
          ? t("settings:providers.test_header", {
              model: info.testModelId || effectiveTestModelId,
              endpoint: info.endpoint,
              chatEndpoint: info.responseApiEndpoint,
              count: info.modelCount,
            })
          : t("settings:providers.test_header_pending", {
              model: effectiveTestModelId || t("settings:providers.auto_selecting"),
            });
        const checkText = checks
          .map(
            (item) =>
              `${item.ok ? "✓" : "×"} ${item.mode}: ${item.status || "failed"}\n${item.preview}`,
          )
          .join("\n\n");
        const preview = info?.preview ? t("settings:providers.test_preview", { preview: info.preview }) : "";
        setTestResult([prefix, header, checkText, preview].filter(Boolean).join("\n\n"));
      };
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\n\n+/);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const event =
            block
              .split(/\r?\n/)
              .find((line) => line.startsWith("event:"))
              ?.slice(6)
              .trim() ?? "message";
          const dataText = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (!dataText) continue;
          const data = JSON.parse(dataText) as Record<string, unknown>;
          if (event === "progress") {
            renderResult(String(data.message ?? t("settings:providers.testing")));
          } else if (event === "models") {
            info = data as unknown as ProviderTestInfo;
            if (info.testModelId) setTestModelId(info.testModelId);
            renderResult(t("settings:providers.models_read"));
          } else if (event === "check") {
            checks.push(data as unknown as ProviderTestCheck);
            renderResult(t("settings:providers.test_in_progress"));
          } else if (event === "done") {
            info = data as unknown as ProviderTestInfo;
            if (Array.isArray(info.checks)) checks.splice(0, checks.length, ...info.checks);
            if (info.testModelId) setTestModelId(info.testModelId);
            renderResult(t("settings:providers.test_complete"));
          } else if (event === "error") {
            throw new Error(String(data.error ?? t("settings:providers.test_error")));
          }
        }
      }
      onSettings(await api.get<Settings>("settings"));
      toast.success(t("settings:providers.test_success"));
    } catch (error) {
      const message = error instanceof Error ? error.message : t("settings:providers.test_failed");
      setTestInfo(null);
      setTestChecks([]);
      setTestResult(message);
      toast.error(message);
    } finally {
      setTesting(false);
    }
  };
  const fetchModels = async () => {
    if (!textValue(draft.apiKey).trim()) {
      toast.error(t("settings:providers.key_required_fetch"));
      return;
    }
    setFetchingModels(true);
    try {
      await api.post("settings/provider", draft);
      const result = await api.post<{ endpoint: string; models: ProviderModel[] }>(
        "settings/provider/models",
        { providerId: draft.id },
      );
      setFetchedModels(result.models);
      setTestModelId(result.models.find((model) => model.modelId !== "auto")?.modelId ?? "");
      toast.success(t("settings:providers.fetched_models", { count: result.models.length }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:providers.fetch_failed"));
    } finally {
      setFetchingModels(false);
    }
  };
  const handleToggleEnabled = async (enabled: boolean) => {
    // 关闭：直接关
    if (!enabled) {
      patchDraft({ enabled: false });
      return;
    }
    // 已有已启用模型（历史 / 用户此前已勾选）：直接启用，不自动拉取
    if ((draft.models ?? []).length > 0) {
      patchDraft({ enabled: true });
      return;
    }
    // 空列表：先持久化当前配置（让服务端拿到最新 baseUrl / apiKey），再拉取上游模型
    if (!textValue(draft.apiKey).trim()) {
      toast.error(t("settings:providers.key_required_enable"));
      return;
    }
    setFetchingModels(true);
    try {
      await api.post("settings/provider", draft);
      const result = await api.post<{ endpoint: string; models: ProviderModel[] }>(
        "settings/provider/models",
        { providerId: draft.id },
      );
      if (!result.models.length) {
        toast.error(t("settings:providers.no_models_enable"));
        return;
      }
      // 与单个勾选时一致地分类 CHAT / IMAGE / EMBEDDING
      const models = result.models.map(applyAutoModelType);
      setFetchedModels(result.models);
      patchDraft({ enabled: true, models });
      toast.success(t("settings:providers.enabled_models", { count: models.length }));
    } catch (error) {
      // 不 patch enabled —— 保持关闭
      toast.error(error instanceof Error ? error.message : t("settings:providers.enable_fetch_failed"));
    } finally {
      setFetchingModels(false);
    }
  };
  const checkBalance = async () => {
    setCheckingBalance(true);
    setBalanceResult(t("settings:providers.balance_querying"));
    try {
      await save();
      const result = await api.post<{ value: string; endpoint: string; preview: string }>(
        "settings/provider/balance",
        { providerId: draft.id },
        { timeout: false },
      );
      setBalanceResult(t("settings:providers.balance_done", { value: result.value, endpoint: result.endpoint, preview: result.preview }));
      toast.success(t("settings:providers.balance_ok", { value: result.value }));
    } catch (error) {
      const message = error instanceof Error ? error.message : t("settings:providers.balance_failed");
      setBalanceResult(message);
      toast.error(message);
    } finally {
      setCheckingBalance(false);
    }
  };
  const toggleModel = (model: ProviderModel, checked: boolean) => {
    const models = checked
      ? // Auto-fill type for newly enabled models (CHAT/IMAGE/EMBEDDING) — user can override per-row.
        [...(draft.models ?? []), applyAutoModelType(model)].filter(
          (item, index, arr) => arr.findIndex((x) => x.modelId === item.modelId) === index,
        )
      : (draft.models ?? []).filter((item) => item.modelId !== model.modelId);
    patchDraft({ models });
  };
  const toggleModelAbility = (modelId: string, ability: "TOOL" | "REASONING", enabled: boolean) => {
    const models = (draft.models ?? []).map((item) => {
      if (item.modelId !== modelId) return item;
      const current = Array.isArray(item.abilities) ? item.abilities : [];
      const next = enabled
        ? Array.from(new Set([...current, ability]))
        : current.filter((value) => value !== ability);
      return { ...item, abilities: next };
    });
    patchDraft({ models });
  };
  // Batch enable/disable for the "select all" toolbar. Acts on a given set of models
  // (the currently-visible filtered set): enable adds any missing ones (auto-typed),
  // disable removes them. Mirrors toggleModel's dedupe + applyAutoModelType semantics.
  const setModelsEnabled = (modelsToToggle: ProviderModel[], enabled: boolean) => {
    const ids = new Set(modelsToToggle.map((model) => model.modelId));
    if (enabled) {
      const existingIds = new Set((draft.models ?? []).map((model) => model.modelId));
      const additions = modelsToToggle
        .filter((model) => !existingIds.has(model.modelId))
        .map(applyAutoModelType);
      if (additions.length === 0) return;
      patchDraft({ models: [...(draft.models ?? []), ...additions] });
    } else {
      const remaining = (draft.models ?? []).filter((model) => !ids.has(model.modelId));
      if (remaining.length === (draft.models ?? []).length) return;
      patchDraft({ models: remaining });
    }
  };
  // -------- Model add/edit dialog state ----------------------------------------------------
  // Single dialog instance reused for both add (+ button) and edit (row click). The mode +
  // modelIdLocked flags determine the dialog UX. State is reset every time the dialog opens
  // (see ModelEditDialog's useEffect on `open`), so reusing one instance is safe.
  type ModelDialogState = {
    mode: "add" | "edit";
    model: ProviderModel;
    modelIdLocked: boolean;
  };
  const [modelDialog, setModelDialog] = React.useState<ModelDialogState | null>(null);

  const openAddModelDialog = () => {
    if (!draft) return;
    const uuid =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setModelDialog({
      mode: "add",
      modelIdLocked: false,
      model: {
        id: uuid,
        modelId: "",
        displayName: "",
        type: "CHAT",
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
        abilities: [],
        tools: [],
        customHeaders: [],
        customBodies: [],
        manuallyAdded: true,
      },
    });
  };

  const openEditModelDialog = (model: ProviderModel) => {
    if (!draft) return;
    // Prefer the persisted entry (with the user's prior customizations) over the fetched one.
    // If model isn't enabled yet, fall back to the fetched row — saving will auto-enable.
    const persisted = (draft.models ?? []).find((item) => item.modelId === model.modelId);
    const source = persisted ?? model;
    // Manually-added models keep ID editable; everything else (fetched, legacy) is locked
    // because the modelId is sent verbatim to the upstream API and editing it would silently
    // break request routing. See server.ts:6158, 6168, 6313.
    const isManual = source.manuallyAdded === true;
    setModelDialog({
      mode: "edit",
      modelIdLocked: !isManual,
      model: { ...source },
    });
  };

  const handleModelDialogSave = (model: ProviderModel) => {
    if (!draft || !modelDialog) return;
    const existing = (draft.models ?? []).find((item) => item.id === model.id);
    let models: ProviderModel[];
    if (existing) {
      // Edit existing persisted model — replace by UUID id (stable across re-fetches).
      models = (draft.models ?? []).map((item) => (item.id === model.id ? model : item));
    } else if (modelDialog.mode === "add") {
      // Brand-new manual add — also reject duplicate modelId to avoid confusing dedup behavior
      // downstream (toggleModel matches by modelId, not id, so a clash would orphan the new one).
      const clash = (draft.models ?? []).some((item) => item.modelId === model.modelId);
      if (clash) {
        toast.error(t("settings:providers.model_id_exists", { id: model.modelId }));
        return;
      }
      models = [model, ...(draft.models ?? [])];
    } else {
      // Edit dialog opened on a fetched-but-not-yet-enabled row → save auto-enables.
      // Dedup by modelId in case the user toggled the checkbox in parallel.
      const without = (draft.models ?? []).filter((item) => item.modelId !== model.modelId);
      models = [...without, model];
    }
    patchDraft({ models });
    // Cache manual models so toggling them off later doesn't erase them from the list
    // (they have no upstream source to re-fetch from). Also refreshes the cached copy on edit
    // so display-name/ability changes propagate. Fetched models are intentionally not cached.
    if (model.manuallyAdded === true) rememberManualModel(draft.id, model);
    toast.success(modelDialog.mode === "add" ? t("settings:providers.model_added") : t("settings:providers.model_saved"));
  };

  const handleModelDialogDelete = () => {
    if (!draft || !modelDialog) return;
    const target = modelDialog.model;
    // Remove by both id AND modelId to be safe — if the model came from a fetched row whose
    // id wasn't yet in draft.models, the id match alone wouldn't find anything.
    patchDraft({
      models: (draft.models ?? []).filter(
        (item) => item.id !== target.id && item.modelId !== target.modelId,
      ),
    });
    // Drop from the manual cache too, otherwise the deleted row would linger in the list.
    if (target.manuallyAdded === true) forgetManualModel(draft.id, target.modelId);
    toast.success(t("settings:providers.model_deleted"));
  };
  const addProvider = async () => {
    const next = createProvider();
    next.name = t("settings:providers.custom_name");
    next.shortDescription = t("settings:providers.custom_desc");
    await api.post("settings/provider", next);
    onSettings({ ...settings, providers: [...settings.providers, next] });
    setSelectedId(next.id);
    toast.success(t("settings:providers.added"));
  };
  const moveProvider = async (from: number, to: number) => {
    const nextProviders = moveItem(settings.providers, from, to);
    onSettings({ ...settings, providers: nextProviders });
    await api.post("settings/provider/reorder", {
      ids: nextProviders.map((provider) => provider.id),
    });
  };
  const testModeLabels: Record<ProviderTestMode, string> = {
    non_stream: t("settings:providers.mode_non_stream"),
    stream: t("settings:providers.mode_stream"),
    tools: t("settings:providers.mode_tools"),
  };

  return (
    <>
      <SectionHeader
        icon={KeyRound}
        title={t("settings:providers.title")}
        subtitle={t("settings:providers.subtitle")}
      />
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="rounded-lg border bg-card p-2">
          <Button className="mb-2 w-full justify-start" variant="outline" onClick={addProvider}>
            <Plus className="size-4" />
            {t("settings:providers.add")}
          </Button>
          {settings.providers.map((provider, index) => (
            <SortableRow
              key={provider.id}
              id={provider.id}
              index={index}
              active={provider.id === draft.id}
              onSelect={() => setSelectedId(provider.id)}
              onMove={moveProvider}
            >
              <span className="grid min-w-0 grid-cols-[28px_10px_minmax(0,1fr)_16px] items-center gap-2 text-left">
                <AIIcon name={provider.name} size={24} className="justify-self-start" />
                <span
                  className={`size-2 rounded-full ${provider.enabled ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                />
                <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                {provider.builtIn ? <Check className="size-3 text-primary" /> : null}
              </span>
            </SortableRow>
          ))}
        </div>
        <div className="space-y-5 rounded-lg border bg-card p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-lg font-medium">{draft.name}</div>
              <div className="text-xs text-muted-foreground">
                {textValue(draft.shortDescription) || providerKind(draft)}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{t("settings:providers.enabled_label")}</span>
              <Switch
                checked={draft.enabled}
                disabled={fetchingModels}
                onCheckedChange={(enabled) => void handleToggleEnabled(enabled)}
              />
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-2">
              <span className="text-sm font-medium">{t("settings:providers.name")}</span>
              <Input
                value={draft.name}
                onChange={(event) => patchDraft({ name: event.target.value })}
              />
            </label>
            <label className="space-y-2">
              <span className="text-sm font-medium">{t("settings:providers.type")}</span>
              <Select
                value={kind}
                onValueChange={(value) =>
                  setDraft(normalizeKindPatch(draft, value as ProviderKind))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI-compatible</SelectItem>
                  <SelectItem value="claude">Anthropic Claude</SelectItem>
                  <SelectItem value="google">Google Gemini</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-2 md:col-span-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">API Key</span>
                {providerGetKeyUrl(textValue(draft.baseUrl)) ? (
                  <button
                    type="button"
                    onClick={() => void openExternal(providerGetKeyUrl(textValue(draft.baseUrl))!)}
                    className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    title={t("settings:providers.get_key_title")}
                  >
                    <ExternalLink className="size-3" />
                    {t("settings:providers.get_key")}
                  </button>
                ) : null}
              </div>
              <PasswordInput
                value={textValue(draft.apiKey)}
                onChange={(apiKey) => patchDraft({ apiKey })}
              />
            </label>
            <label className="space-y-2 md:col-span-2">
              <span className="text-sm font-medium">Base URL</span>
              <Input
                value={textValue(draft.baseUrl)}
                onChange={(event) => patchDraft({ baseUrl: event.target.value })}
                placeholder={
                  kind === "claude" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"
                }
              />
              <span className="block break-all text-xs text-muted-foreground">
                {t("settings:providers.chat_url", { url: endpointPreview(draft) })}
              </span>
              <span className="block break-all text-xs text-muted-foreground">
                {t("settings:providers.models_url", { url: modelListEndpointPreview(draft) })}
              </span>
            </label>
            <div className="space-y-2 rounded-md border px-3 py-2">
              <span className="text-sm font-medium">Chat Completions Path</span>
              <Input
                disabled={kind !== "openai" || draft.useResponseApi === true}
                value={
                  textValue(draft.chatCompletionsPath) ||
                  defaultPathForKind(kind, draft.useResponseApi === true)
                }
                onChange={(event) => patchDraft({ chatCompletionsPath: event.target.value })}
              />
            </div>
            <div className="flex items-end justify-between gap-3 rounded-md border px-3 py-2">
              <div>
                <div className="text-sm font-medium">Response API</div>
                <div className="text-xs text-muted-foreground">
                  {t("settings:providers.response_api_desc")}
                </div>
              </div>
              <Switch
                disabled={kind !== "openai"}
                checked={draft.useResponseApi === true}
                onCheckedChange={(useResponseApi) =>
                  patchDraft({
                    useResponseApi,
                    chatCompletionsPath: defaultPathForKind("openai", useResponseApi),
                  })
                }
              />
            </div>
            {kind === "openai" ? (
              <div className="flex items-start justify-between gap-3 rounded-md border px-3 py-3 md:col-span-2">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="text-sm font-medium">{t("settings:providers.history_reasoning_title")}</div>
                  <div className="text-xs leading-relaxed text-muted-foreground">
                    {t("settings:providers.history_reasoning_desc")}
                  </div>
                </div>
                <Switch
                  className="mt-1 shrink-0"
                  checked={draft.includeHistoryReasoning !== false}
                  onCheckedChange={(includeHistoryReasoning) =>
                    patchDraft({ includeHistoryReasoning })
                  }
                />
              </div>
            ) : null}
            {kind === "claude" ? (
              <div className="grid gap-3 rounded-md border px-3 py-3 md:col-span-2 md:grid-cols-[1fr_180px]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">{t("settings:providers.prompt_cache_title")}</div>
                    <div className="text-xs text-muted-foreground">
                      {t("settings:providers.prompt_cache_desc")}
                    </div>
                  </div>
                  <Switch
                    checked={draft.promptCaching === true}
                    onCheckedChange={(promptCaching) => patchDraft({ promptCaching })}
                  />
                </div>
                <label className="space-y-2">
                  <span className="text-sm font-medium">{t("settings:providers.cache_ttl")}</span>
                  <Select
                    value={textValue(draft.promptCacheTtl) || "5m"}
                    onValueChange={(promptCacheTtl) =>
                      patchDraft({ promptCacheTtl: promptCacheTtl as "5m" | "1h" })
                    }
                    disabled={draft.promptCaching !== true}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="5m">{t("settings:providers.cache_5m")}</SelectItem>
                      <SelectItem value="1h">{t("settings:providers.cache_1h")}</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
              </div>
            ) : null}
          </div>
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">{t("settings:providers.models_title")}</div>
                <div className="text-xs text-muted-foreground">
                  {t("settings:providers.models_desc", { count: draft.models?.length ?? 0 })}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={openAddModelDialog}
                  title={t("settings:providers.add_model_title")}
                >
                  <Plus className="size-4" />
                  {t("settings:providers.add_model")}
                </Button>
                <Button variant="outline" onClick={fetchModels} disabled={fetchingModels}>
                  {fetchingModels ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  {t("settings:providers.fetch_models")}
                </Button>
              </div>
            </div>
            {/* Search + select-all toolbar. Only relevant when there's something to show;
                hidden while the list is empty (no fetch yet, no manual models). */}
            {(fetchedModels.length > 0 || (draft.models ?? []).length > 0) && (
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={modelFilter}
                    onChange={(event) => setModelFilter(event.target.value)}
                    placeholder={t("settings:providers.models_search_placeholder")}
                    className="h-8 pl-9 pr-8"
                  />
                  {modelFilter ? (
                    <button
                      type="button"
                      onClick={() => setModelFilter("")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-4" />
                    </button>
                  ) : null}
                </div>
                {/* Visible/total counts — surfaces how many survive the current filter. */}
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t("settings:providers.models_selection_count", {
                    enabled: draft.models?.length ?? 0,
                    total: displayModels.length,
                  })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setModelsEnabled(visibleModels, !allFilteredEnabled)}
                  disabled={visibleModels.length === 0}
                  title={
                    allFilteredEnabled
                      ? modelFilter
                        ? t("settings:providers.models_deselect_all_filtered")
                        : t("settings:providers.models_deselect_all")
                      : modelFilter
                        ? t("settings:providers.models_select_all_filtered")
                        : t("settings:providers.models_select_all")
                  }
                >
                  {allFilteredEnabled
                    ? modelFilter
                      ? t("settings:providers.models_deselect_all_filtered")
                      : t("settings:providers.models_deselect_all")
                    : modelFilter
                      ? t("settings:providers.models_select_all_filtered")
                      : t("settings:providers.models_select_all")}
                </Button>
              </div>
            )}
            <div className="max-h-72 space-y-2 overflow-auto">
              {visibleModels.map((model) => {
                const focused =
                  focusedModelId &&
                  (model.modelId === focusedModelId || model.id === focusedModelId);
                const enabled = selectedModelIds.has(model.modelId);
                const persisted = (draft.models ?? []).find(
                  (item) => item.modelId === model.modelId,
                );
                const currentType =
                  (persisted?.type as "CHAT" | "IMAGE" | "EMBEDDING" | undefined) ?? "CHAT";
                const currentAbilities = Array.isArray(persisted?.abilities)
                  ? persisted!.abilities
                  : [];
                const hasTool = currentAbilities.includes("TOOL");
                const hasReasoning = currentAbilities.includes("REASONING");
                return (
                  <div
                    key={model.id ?? model.modelId}
                    // The row itself is the click target for the edit dialog. The checkbox and
                    // ability buttons inside stop propagation so they keep their own semantics.
                    role="button"
                    tabIndex={0}
                    onClick={() => openEditModelDialog(model)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openEditModelDialog(model);
                      }
                    }}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 transition hover:border-primary/40 hover:bg-muted/40",
                      focused && "border-primary bg-primary/5 shadow-sm",
                    )}
                  >
                    <span onClick={(event) => event.stopPropagation()}>
                      <Checkbox
                        checked={enabled}
                        onCheckedChange={(checked) => toggleModel(model, checked === true)}
                      />
                    </span>
                    <AIIcon name={model.modelId} size={28} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {model.displayName || model.modelId}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {model.modelId}
                      </span>
                    </span>
                    {enabled && currentType === "CHAT" ? (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            event.preventDefault();
                            toggleModelAbility(model.modelId, "TOOL", !hasTool);
                          }}
                          className={cn(
                            "h-7 rounded-md border px-2 text-xs transition",
                            hasTool
                              ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                              : "border-border text-muted-foreground hover:bg-muted",
                          )}
                          title={hasTool ? t("settings:providers.tool_enabled") : t("settings:providers.tool_disabled")}
                        >
                          {t("settings:providers.tool_short")}
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            event.preventDefault();
                            toggleModelAbility(model.modelId, "REASONING", !hasReasoning);
                          }}
                          className={cn(
                            "h-7 rounded-md border px-2 text-xs transition",
                            hasReasoning
                              ? "border-sky-500/50 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                              : "border-border text-muted-foreground hover:bg-muted",
                          )}
                          title={hasReasoning ? t("settings:providers.reasoning_enabled") : t("settings:providers.reasoning_disabled")}
                        >
                          {t("settings:providers.reasoning_short")}
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {displayModels.length === 0 ? (
                <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  {t("settings:providers.no_models")}
                </div>
              ) : visibleModels.length === 0 ? (
                <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  {t("settings:providers.models_no_match")}
                </div>
              ) : null}
            </div>
          </div>
          <div className="space-y-2 rounded-md border px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-muted-foreground">{t("settings:providers.test_model")}</span>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={test} disabled={testing}>
                  {testing ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Database className="size-4" />
                  )}
                  {t("settings:providers.test")}
                </Button>
                <Button
                  variant="outline"
                  onClick={async () => {
                    if (!window.confirm(t("settings:providers.delete_confirm", { name: draft.name }))) return;
                    await api.delete(`settings/provider/${encodeURIComponent(draft.id)}`);
                    const providers = settings.providers.filter((item) => item.id !== draft.id);
                    onSettings({ ...settings, providers });
                    setSelectedId(providers[0]?.id ?? "");
                    toast.success(t("settings:providers.deleted"));
                  }}
                  disabled={settings.providers.length <= 1}
                >
                  <Trash2 className="size-4" />
                  {t("settings:providers.delete")}
                </Button>
                <span className="px-2 text-xs text-muted-foreground">{t("settings:providers.autosaved")}</span>
              </div>
            </div>
            <Select value={effectiveTestModelId} onValueChange={setTestModelId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("settings:providers.test_model_ph")} />
              </SelectTrigger>
              <SelectContent>
                {mergedTestModels.map((model) => (
                  <SelectItem key={model.id ?? model.modelId} value={model.modelId}>
                    {model.displayName || model.modelId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex items-end justify-between gap-3">
              <div>
                <div className="text-sm font-medium">{t("settings:providers.balance_title")}</div>
                <div className="text-xs text-muted-foreground">
                  {t("settings:providers.balance_desc")}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={balanceOption.enabled === true}
                  onCheckedChange={(enabled) =>
                    patchDraft({ balanceOption: { ...balanceOptionOf(draft), enabled } })
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void checkBalance()}
                  disabled={checkingBalance || balanceOption.enabled !== true}
                >
                  {checkingBalance ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Database className="size-4" />
                  )}
                  {t("settings:providers.query")}
                </Button>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-2">
                <span className="text-sm font-medium">{t("settings:providers.balance_api_path")}</span>
                <Input
                  value={textValue(balanceOption.apiPath) || "/credits"}
                  onChange={(event) =>
                    patchDraft({
                      balanceOption: { ...balanceOptionOf(draft), apiPath: event.target.value },
                    })
                  }
                />
              </label>
              <label className="space-y-2">
                <span className="text-sm font-medium">{t("settings:providers.balance_result_path")}</span>
                <Input
                  value={textValue(balanceOption.resultPath)}
                  onChange={(event) =>
                    patchDraft({
                      balanceOption: { ...balanceOptionOf(draft), resultPath: event.target.value },
                    })
                  }
                />
              </label>
            </div>
          </div>
          {(testing || testChecks.length > 0 || testInfo) &&
          !isImageTestMode &&
          !imageTestResult ? (
            <div className="rounded-md border bg-muted/40 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium">{t("settings:providers.test_summary")}</div>
                <div className="text-xs text-muted-foreground">
                  {testInfo?.testModelId
                    ? t("settings:providers.test_summary_model", { model: testInfo.testModelId })
                    : testing
                      ? t("settings:providers.testing")
                      : t("settings:providers.awaiting")}
                </div>
              </div>
              <div className="grid gap-2 md:grid-cols-3">
                {(["non_stream", "stream", "tools"] as ProviderTestMode[]).map((mode) => {
                  const check = testChecks.find((item) => item.mode === mode);
                  const pending = testing && !check;
                  return (
                    <div
                      key={mode}
                      className={cn(
                        "rounded-md border bg-background px-3 py-2",
                        check?.ok === true && "border-emerald-500/30 bg-emerald-500/5",
                        check?.ok === false && "border-destructive/30 bg-destructive/5",
                      )}
                    >
                      <div className="flex items-center gap-2 text-sm font-medium">
                        {pending ? (
                          <Loader2 className="size-4 animate-spin text-muted-foreground" />
                        ) : check?.ok ? (
                          <CheckCircle2 className="size-4 text-emerald-500" />
                        ) : check ? (
                          <Trash2 className="size-4 text-destructive" />
                        ) : (
                          <span className="size-2 rounded-full bg-muted-foreground/40" />
                        )}
                        <span>{testModeLabels[mode]}</span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {check
                          ? check.ok
                            ? t("settings:providers.check_ok", { status: check.status })
                            : t("settings:providers.check_failed", { status: check.status || t("settings:providers.not_connected") })
                          : pending
                            ? t("settings:providers.in_progress")
                            : t("settings:providers.not_tested")}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
          {isImageTestMode && testing && !imageTestResult ? (
            <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              <Loader2 className="mr-2 inline size-4 animate-spin align-middle" />
              {t("settings:providers.img_test_generating_pre")}<span className="font-medium text-foreground">
                {effectiveTestModelId}
              </span>{" "}
              {t("settings:providers.img_test_generating_post")}
            </div>
          ) : null}
          {imageTestResult ? (
            <div className="rounded-md border bg-muted/40 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium">{t("settings:providers.img_test_result")}</div>
                <div className="text-xs text-muted-foreground">
                  {t("settings:providers.img_test_model", { model: imageTestResult.modelId, duration: (imageTestResult.durationMs / 1000).toFixed(2) })}
                </div>
              </div>
              <div className="flex flex-wrap items-start gap-3">
                {imageTestResult.url ? (
                  <img
                    src={appendWebAuthQuery(imageTestResult.url)}
                    alt={t("settings:providers.img_alt")}
                    className="h-40 w-40 rounded-md border object-cover"
                  />
                ) : null}
                <div className="min-w-0 flex-1 text-xs text-muted-foreground">
                  <div className="mb-1 font-medium text-foreground">{t("settings:providers.prompt_label")}</div>
                  <div className="whitespace-pre-wrap">{imageTestResult.prompt}</div>
                </div>
              </div>
            </div>
          ) : null}
          {testResult ? (
            <pre className="max-h-56 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap">
              {testResult}
            </pre>
          ) : null}
          {balanceResult ? (
            <pre className="max-h-56 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap">
              {balanceResult}
            </pre>
          ) : null}
        </div>
      </div>
      {modelDialog ? (
        <ModelEditDialog
          open={Boolean(modelDialog)}
          onOpenChange={(open) => {
            if (!open) setModelDialog(null);
          }}
          mode={modelDialog.mode}
          modelIdLocked={modelDialog.modelIdLocked}
          initialModel={modelDialog.model}
          onSave={handleModelDialogSave}
          onDelete={modelDialog.mode === "edit" ? handleModelDialogDelete : undefined}
        />
      ) : null}
    </>
  );
}

function AssistantsSection({
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
  const dirtyRef = React.useRef(false);

  React.useEffect(() => {
    const next =
      settings.assistants.find((item) => item.id === assistantId) ?? settings.assistants[0];
    dirtyRef.current = false;
    setDraft(next ? clone(next) : null);
  }, [assistantId, settings.assistants]);

  const save = async () => {
    if (!draft) return;
    const nextAssistants = settings.assistants.map((item) => (item.id === draft.id ? draft : item));
    const nextSettings = { ...settings, assistants: nextAssistants };
    await api.post("settings/assistant/detail", draft);
    onSettings(nextSettings);
    dirtyRef.current = false;
  };

  React.useEffect(() => {
    if (!draft || !dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void save().catch((error: Error) =>
        toast.error(error.message || t("settings:assistants.autosave_failed")),
      );
    }, 700);
    return () => window.clearTimeout(timer);
  }, [draft, settings.assistants]);

  if (!draft) return null;

  const patchDraft = (patch: Partial<AssistantProfile>) => {
    dirtyRef.current = true;
    setDraft({ ...draft, ...patch });
  };

  const addAssistant = async () => {
    const created = {
      ...clone(settings.assistants[0]),
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
      if (!window.confirm(t("settings:assistants.delete_confirm_with_memories", { name: nameLabel, n: memoryCount }))) return;
      // 第二步:确定=同时删记忆,取消=保留为孤儿(记忆板块可管理)
      deleteMemories = window.confirm(t("settings:assistants.delete_memories_confirm", { n: memoryCount }));
    } else {
      if (!window.confirm(t("settings:assistants.delete_confirm", { name: nameLabel }))) return;
    }
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
                  typeof draft.contextMessageSize === "number"
                    ? draft.contextMessageSize
                    : 0,
                ]}
                onValueChange={([next]) =>
                  patchDraft({ contextMessageSize: next ?? 0 })
                }
              />
              <Input
                className="w-24"
                inputMode="numeric"
                value={
                  typeof draft.contextMessageSize === "number" &&
                  draft.contextMessageSize > 0
                    ? String(draft.contextMessageSize)
                    : ""
                }
                placeholder={t(
                  "settings:assistants.context_message_unlimited",
                )}
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  if (raw === "") {
                    patchDraft({ contextMessageSize: 0 });
                    return;
                  }
                  const parsed = Math.floor(Number(raw));
                  patchDraft({
                    contextMessageSize:
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
                [
                  "javascript_engine",
                  t("settings:assistants.tools.js_engine.title"),
                  t("settings:assistants.tools.js_engine.desc"),
                ],
                ["clipboard", t("settings:assistants.tools.clipboard.title"), t("settings:assistants.tools.clipboard.desc")],
                ["tts", t("settings:assistants.tools.tts.title"), t("settings:assistants.tools.tts.desc")],
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
            <div className="flex items-center px-2 text-xs text-muted-foreground">{t("settings:assistants.autosaved")}</div>
          </div>
        </div>
      </div>
    </>
  );
}

function SearchSection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const [selectedId, setSelectedId] = React.useState(
    String(
      settings.searchServices[settings.searchServiceSelected]?.id ??
        settings.searchServices[0]?.id ??
        "",
    ),
  );
  const selected = (settings.searchServices.find((item) => String(item.id) === selectedId) ??
    settings.searchServices[0]) as Record<string, unknown> | undefined;
  const [draft, setDraft] = React.useState<Record<string, unknown>>(
    selected ? clone(selected) : createSearchService(),
  );
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState("");
  const [keyTestEntries, setKeyTestEntries] = React.useState<
    Array<{ key: string; status: "ok" | "fail"; failCode?: string }>
  >([]);
  const dirtyRef = React.useRef(false);
  const { t } = useTranslation();

  // searchServicesRef: avoid re-running this effect after every autosave → onSettings
  // round-trip (would overwrite mid-flight keystrokes). See McpServerEditor for rationale.
  const searchServicesRef = React.useRef(settings.searchServices);
  searchServicesRef.current = settings.searchServices;
  React.useEffect(() => {
    const next = (searchServicesRef.current.find((item) => String(item.id) === selectedId) ??
      searchServicesRef.current[0]) as Record<string, unknown> | undefined;
    if (next) setDraft(clone(next));
    dirtyRef.current = false;
    setTestResult("");
  }, [selectedId]);

  const patchDraft = (patch: Record<string, unknown>) => {
    dirtyRef.current = true;
    setDraft({ ...draft, ...patch });
  };

  const moveSearchService = async (from: number, to: number) => {
    const searchServices = moveItem(settings.searchServices, from, to);
    const selectedId = settings.searchServices[settings.searchServiceSelected]?.id;
    const searchServiceSelected = Math.max(
      0,
      searchServices.findIndex((item) => item.id === selectedId),
    );
    const next = { ...settings, searchServices, searchServiceSelected };
    onSettings(next);
    await api.post("settings/search/reorder", {
      ids: searchServices.map((item) => item.id),
      selectedId,
    });
  };
  const selectService = async (index: number) => {
    setSelectedId(String(settings.searchServices[index]?.id ?? ""));
    onSettings({ ...settings, searchServiceSelected: index });
    await api.post("settings/search/service", { index });
  };
  const save = async () => {
    const result = await api.post<{ service: Record<string, unknown> }>(
      "settings/search/service/detail",
      draft,
    );
    const savedService = toSearchService(result.service);
    const exists = settings.searchServices.some(
      (item) => String(item.id) === String(result.service.id),
    );
    const searchServices = exists
      ? settings.searchServices.map((item) =>
          String(item.id) === String(savedService.id) ? savedService : item,
        )
      : [...settings.searchServices, savedService];
    onSettings({
      ...settings,
      searchServices,
      searchServiceSelected: searchServices.findIndex(
        (item) => String(item.id) === String(savedService.id),
      ),
    });
    setSelectedId(String(savedService.id));
    toast.success(t("settings:search.saved"));
  };
  React.useEffect(() => {
    if (!dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void api
        .post<{ service: Record<string, unknown> }>("settings/search/service/detail", draft)
        .then((result) => {
          dirtyRef.current = false;
          const savedService = toSearchService(result.service);
          const exists = settings.searchServices.some(
            (item) => String(item.id) === String(savedService.id),
          );
          const searchServices = exists
            ? settings.searchServices.map((item) =>
                String(item.id) === String(savedService.id) ? savedService : item,
              )
            : [...settings.searchServices, savedService];
          onSettings({ ...settings, searchServices });
        })
        .catch((error: Error) =>
          toast.error(error.message || t("settings:search.autosave_failed")),
        );
    }, 700);
    return () => window.clearTimeout(timer);
  }, [draft, onSettings, settings]);
  const addService = () => {
    const service = createSearchService();
    void api
      .post<{ service: Record<string, unknown> }>("settings/search/service/detail", service)
      .then((result) => {
        const savedService = toSearchService(result.service);
        const searchServices = [...settings.searchServices, savedService];
        onSettings({
          ...settings,
          searchServices,
          searchServiceSelected: searchServices.length - 1,
        });
        setDraft(savedService as unknown as Record<string, unknown>);
        setSelectedId(String(savedService.id));
        setTestResult("");
        toast.success(t("settings:search.added"));
      })
      .catch((error: Error) => toast.error(error.message || t("settings:search.add_failed")));
  };
  const test = async () => {
    setTesting(true);
    setTestResult(t("settings:search.testing_start"));
    setKeyTestEntries([]);
    try {
      await save();
      const result = await api.post<{
        status: "ok" | "fail";
        endpoint: string;
        preview: string;
        keys?: Array<{ key: string; status: "ok" | "fail"; failCode?: string }>;
      }>("settings/search/service/test", draft);
      const keys = Array.isArray(result.keys) ? result.keys : [];
      const okCount = keys.filter((k) => k.status === "ok").length;
      if (result.status === "ok") {
        if (keys.length > 1 && okCount < keys.length) {
          setTestResult(
            t("settings:search.test_partial", {
              endpoint: result.endpoint,
              ok: okCount,
              total: keys.length,
              failed: keys.length - okCount,
              preview: result.preview,
            }),
          );
        } else if (keys.length > 1) {
          setTestResult(
            t("settings:search.test_all_ok", {
              endpoint: result.endpoint,
              count: keys.length,
              preview: result.preview,
            }),
          );
        } else {
          setTestResult(
            t("settings:search.test_success", { endpoint: result.endpoint, preview: result.preview }),
          );
        }
        toast.success(t("settings:search.test_ok"));
        // Refresh settings so the "已通过测试" badge updates (server marks testPassed on success).
        onSettings(await api.get<Settings>("settings"));
      } else {
        // 多 key 全部失败:展示汇总 + 每个 key 的失败明细;单 key 失败:直接给出友好原因
        // (如"密钥无效或已过期"),比原来的 "401: {body}" 更易懂。
        const singleFailReason =
          keys.length === 1
            ? t(`settings:search.key_fail_${keys[0]?.failCode ?? "other"}`)
            : null;
        setTestResult(
          keys.length > 1
            ? t("settings:search.test_all_failed", { count: keys.length })
            : singleFailReason ?? t("settings:search.test_failed"),
        );
        toast.error(singleFailReason ?? t("settings:search.test_failed"));
      }
      setKeyTestEntries(keys);
    } catch (error) {
      // 无 key 服务(searxng/custom_js)失败、网络异常等仍以非 2xx 抛出,走这里。
      const message = error instanceof Error ? error.message : t("settings:search.test_failed");
      setTestResult(message);
      setKeyTestEntries([]);
      toast.error(message);
    } finally {
      setTesting(false);
    }
  };
  const remove = async () => {
    if (
      !window.confirm(
        t("settings:search.delete_confirm", {
          name: textValue(draft.name) || textValue(draft.type),
        }),
      )
    )
      return;
    await api.delete(`settings/search/service/${encodeURIComponent(String(draft.id))}`);
    const searchServices = settings.searchServices.filter(
      (item) => String(item.id) !== String(draft.id),
    );
    onSettings({ ...settings, searchServices, searchServiceSelected: 0 });
    setSelectedId(String(searchServices[0]?.id ?? ""));
    toast.success(t("settings:search.deleted"));
  };

  return (
    <>
      <SectionHeader
        icon={Search}
        title={t("settings:search.title")}
        subtitle={t("settings:search.subtitle")}
      />
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="space-y-2 rounded-lg border bg-card p-2">
          <Button className="w-full justify-start" variant="outline" onClick={addService}>
            <Plus className="size-4" />
            {t("settings:search.add")}
          </Button>
          {settings.searchServices.map((service, index) => (
            <SortableRow
              key={String(service.id ?? index)}
              id={String(service.id ?? index)}
              index={index}
              active={String(service.id) === String(draft.id)}
              onSelect={() => selectService(index)}
              onMove={moveSearchService}
            >
              <span className="grid min-w-0 grid-cols-[34px_minmax(0,1fr)_36px] items-center gap-3 text-left">
                <AIIcon
                  name={searchServiceLabelForType(textValue(service.type))}
                  size={30}
                  className="justify-self-start"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 truncate font-medium">
                    {(() => {
                      const type = String(service.type ?? "").toLowerCase();
                      const isPreset = type === "bing_local" || type === "rikkahub";
                      const passed =
                        isPreset || (service as Record<string, unknown>).testPassed === true;
                      return (
                        <span
                          aria-hidden
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            passed ? "bg-emerald-500" : "bg-muted-foreground/40",
                          )}
                          title={
                            passed
                              ? isPreset
                                ? t("settings:search.preset_ok")
                                : t("settings:search.passed")
                              : t("settings:search.not_passed")
                          }
                        />
                      );
                    })()}
                    <span className="truncate">
                      {textValue(service.name) ||
                        searchServiceLabelForType(textValue(service.type))}
                    </span>
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {textValue(service.type) || JSON.stringify(service)}
                  </span>
                </span>
                {index === settings.searchServiceSelected ? (
                  <span className="shrink-0 text-xs text-primary">
                    {t("settings:search.current")}
                  </span>
                ) : null}
              </span>
            </SortableRow>
          ))}
        </div>
        <div className="space-y-5 rounded-lg border bg-card p-5">
          <div className="flex items-center gap-3">
            <AIIcon name={searchServiceLabelForType(textValue(draft.type))} size={40} />
            <div>
              <div className="text-lg font-medium">
                {textValue(draft.name) ||
                  searchServiceLabelForType(textValue(draft.type)) ||
                  t("settings:search.service_default")}
              </div>
              <div className="text-xs text-muted-foreground">
                {textValue(draft.type) || "custom"}
              </div>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-2">
              <span className="text-sm font-medium">{t("settings:search.name")}</span>
              <Input
                value={textValue(draft.name)}
                onChange={(event) => patchDraft({ name: event.target.value })}
              />
            </label>
            <label className="space-y-2">
              <span className="text-sm font-medium">{t("settings:search.type")}</span>
              <Select
                value={textValue(draft.type) || "tavily"}
                onValueChange={(type) => {
                  // Re-sync `name` whenever it was still the previous type's default label —
                  // that way the row icon and detail-pane logo follow the chosen type. Manual
                  // names (anything not matching the canonical label) are preserved.
                  const previousType = textValue(draft.type);
                  const previousLabel = searchServiceLabelForType(previousType);
                  const currentName = textValue(draft.name);
                  const isDefaultName =
                    !currentName || currentName === previousLabel || currentName === previousType;
                  patchDraft({
                    type,
                    name: isDefaultName ? searchServiceLabelForType(type) : currentName,
                    ...(type === "custom_js" && !textValue(draft.searchScript)
                      ? {
                          searchScript: DEFAULT_CUSTOM_JS_SEARCH_SCRIPT,
                          scrapeScript: DEFAULT_CUSTOM_JS_SCRAPE_SCRIPT,
                        }
                      : {}),
                  });
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(
                    [
                      "bing_local",
                      "rikkahub",
                      "tavily",
                      "exa",
                      "zhipu",
                      "tinyfish",
                      "brave",
                      "perplexity",
                      "bocha",
                      "linkup",
                      "metaso",
                      "ollama",
                      "jina",
                      "firecrawl",
                      "grok",
                      "searxng",
                      "custom_js",
                    ] as const
                  ).map((type) => (
                    <SelectItem key={type} value={type}>
                      <span className="flex items-center gap-2">
                        <AIIcon
                          name={searchServiceLabelForType(type)}
                          size={16}
                          className="bg-transparent"
                        />
                        {searchServiceLabelForType(type)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {textValue(draft.type) !== "searxng" && textValue(draft.type) !== "custom_js" ? (
              <div className="space-y-2 md:col-span-2">
                <span className="text-sm font-medium">API Key</span>
                <SearchApiKeyList
                  value={textValue(draft.apiKey)}
                  onChange={(apiKey) => patchDraft({ apiKey })}
                  testEntries={keyTestEntries}
                />
                <span className="text-xs text-muted-foreground">{t("settings:search.api_key_hint")}</span>
              </div>
            ) : null}
            {textValue(draft.type) === "searxng" ? (
              <>
                <label className="space-y-2 md:col-span-2">
                  <span className="text-sm font-medium">SearXNG URL</span>
                  <Input
                    value={textValue(draft.url)}
                    onChange={(event) => patchDraft({ url: event.target.value })}
                    placeholder="https://search.example.com"
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium">Engines</span>
                  <Input
                    value={textValue(draft.engines)}
                    onChange={(event) => patchDraft({ engines: event.target.value })}
                    placeholder="google,bing"
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium">Language</span>
                  <Input
                    value={textValue(draft.language)}
                    onChange={(event) => patchDraft({ language: event.target.value })}
                    placeholder="zh-CN"
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium">Username</span>
                  <Input
                    value={textValue(draft.username)}
                    onChange={(event) => patchDraft({ username: event.target.value })}
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium">Password</span>
                  <PasswordInput
                    value={textValue(draft.password)}
                    onChange={(password) => patchDraft({ password })}
                  />
                </label>
              </>
            ) : null}
            {textValue(draft.type) === "custom_js" ? (
              <>
                <label className="space-y-2 md:col-span-2">
                  <span className="text-sm font-medium">Search Script</span>
                  <Textarea
                    value={textValue(draft.searchScript)}
                    onChange={(event) => patchDraft({ searchScript: event.target.value })}
                    className="min-h-56 font-mono text-xs"
                    placeholder={
                      "async function search(query, resultSize) {\n  const res = await fetch('https://example.com/search?q=' + encodeURIComponent(query));\n  const data = await res.json();\n  return { items: data.results.map((r) => ({ title: r.title, url: r.url, text: r.snippet })) };\n}"
                    }
                  />
                </label>
                <label className="space-y-2 md:col-span-2">
                  <span className="text-sm font-medium">Scrape Script</span>
                  <Textarea
                    value={textValue(draft.scrapeScript)}
                    onChange={(event) => patchDraft({ scrapeScript: event.target.value })}
                    className="min-h-40 font-mono text-xs"
                    placeholder={
                      "async function scrape(urls) {\n  return { urls: await Promise.all(urls.map(async (url) => {\n    const res = await fetch(url);\n    return { url, content: await res.text() };\n  })) };\n}"
                    }
                  />
                </label>
              </>
            ) : null}
            <label className="space-y-2">
              <span className="text-sm font-medium">{t("settings:search.depth")}</span>
              <Select
                value={textValue(draft.depth) || "standard"}
                onValueChange={(depth) => patchDraft({ depth })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="basic">Basic</SelectItem>
                  <SelectItem value="standard">Standard</SelectItem>
                  <SelectItem value="advanced">Advanced</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-2">
              <span className="text-sm font-medium">{t("settings:search.result_count")}</span>
              <Input
                value={numberText(
                  draft.resultSize ??
                    (settings.searchCommonOptions as Record<string, unknown> | undefined)
                      ?.resultSize,
                )}
                onChange={(event) => patchDraft({ resultSize: Number(event.target.value) || 10 })}
              />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={test} disabled={testing}>
              {testing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Database className="size-4" />
              )}
              {t("settings:search.test")}
            </Button>
            <Button
              variant="outline"
              onClick={remove}
              disabled={
                !settings.searchServices.some((item) => String(item.id) === String(draft.id))
              }
            >
              <Trash2 className="size-4" />
              {t("settings:search.delete")}
            </Button>
            <div className="flex items-center px-2 text-xs text-muted-foreground">
              {t("settings:search.autosaved")}
            </div>
          </div>
          {testResult ? (
            <pre className="max-h-56 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap">
              {testResult}
            </pre>
          ) : null}
          {keyTestEntries.length > 1 ? (
            <div className="space-y-1.5 rounded-md border bg-card p-3">
              <div className="text-xs font-medium text-muted-foreground">
                {t("settings:search.key_status_title")}
              </div>
              {keyTestEntries.map((entry, index) => (
                <div key={index} className="flex items-center gap-2 text-xs">
                  {entry.status === "ok" ? (
                    <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
                  ) : (
                    <XCircle className="size-3.5 shrink-0 text-destructive" />
                  )}
                  <code className="font-mono">{entry.key}</code>
                  <span
                    className={cn(
                      "text-muted-foreground",
                      entry.status === "fail" && "text-destructive",
                    )}
                  >
                    {entry.status === "ok"
                      ? t("settings:search.key_ok")
                      : t(`settings:search.key_fail_${entry.failCode ?? "other"}`)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

function DefaultModelsSection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const allModels = settings.providers.flatMap((provider) =>
    provider.enabled
      ? (provider.models ?? []).map((model) => ({ ...model, providerName: provider.name }))
      : [],
  );
  // Image generation models live on providers that don't necessarily pass the chat test
  // (image-only providers like findcg gpt-image-2). Source them directly from enabled providers
  // and require an image-related capability marker (parity with images.tsx).
  const imageModels = settings.providers
    .filter((provider) => provider.enabled !== false)
    .flatMap((provider) =>
      (provider.models ?? [])
        .filter(
          (model) =>
            model.type === "IMAGE" ||
            model.outputModalities?.includes("IMAGE") ||
            model.tools?.some(
              (tool) => String(tool.type ?? "").toLowerCase() === "image_generation",
            ),
        )
        .map((model) => ({ ...model, providerName: provider.name })),
    );
  type Draft = {
    chatModelId: string;
    titleModelId: string;
    translateModeId: string;
    suggestionModelId: string;
    imageGenerationModelId: string;
    ocrModelId: string;
    compressModelId: string;
    promptOptimizeModelId: string;
    promptOptimizePrompt: string;
    titlePrompt: string;
    translatePrompt: string;
    suggestionPrompt: string;
    ocrPrompt: string;
    compressPrompt: string;
  };
  type ModelKey =
    | "chatModelId"
    | "titleModelId"
    | "translateModeId"
    | "suggestionModelId"
    | "imageGenerationModelId"
    | "ocrModelId"
    | "compressModelId"
    | "promptOptimizeModelId";
  type PromptKey =
    | "titlePrompt"
    | "translatePrompt"
    | "suggestionPrompt"
    | "ocrPrompt"
    | "compressPrompt"
    | "promptOptimizePrompt";
  const [draft, setDraft] = React.useState({
    chatModelId: textValue(settings.chatModelId),
    titleModelId: textValue(settings.titleModelId),
    translateModeId: textValue(settings.translateModeId),
    suggestionModelId: textValue(settings.suggestionModelId),
    imageGenerationModelId: textValue(settings.imageGenerationModelId),
    ocrModelId: textValue(settings.ocrModelId),
    compressModelId: textValue(settings.compressModelId),
    promptOptimizeModelId: textValue(settings.promptOptimizeModelId),
    promptOptimizePrompt: textValue(settings.promptOptimizePrompt),
    titlePrompt: textValue(settings.titlePrompt),
    translatePrompt: textValue(settings.translatePrompt),
    suggestionPrompt: textValue(settings.suggestionPrompt),
    ocrPrompt: textValue(settings.ocrPrompt),
    compressPrompt: textValue(settings.compressPrompt),
  } satisfies Draft);
  const [editingPrompt, setEditingPrompt] = React.useState<PromptKey | null>(null);
  const save = async () => {
    await api.post("settings/default-models", draft);
    onSettings({ ...settings, ...draft });
  };
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      void save().catch((error: Error) =>
        toast.error(error.message || t("settings:models.autosave_failed")),
      );
    }, 500);
    return () => window.clearTimeout(timer);
  }, [draft]);
  const modelSelect = (key: ModelKey) => {
    const options = key === "imageGenerationModelId" ? imageModels : allModels;
    return (
      <Select
        value={draft[key] || "__none"}
        onValueChange={(value) => setDraft({ ...draft, [key]: value === "__none" ? "" : value })}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none">{t("settings:models.not_set")}</SelectItem>
          {options.map((model) => (
            <SelectItem key={`${key}-${model.id}`} value={model.id}>
              {model.providerName} / {model.displayName || model.modelId}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  };
  const promptMeta: Record<PromptKey, { title: string; variables: string; defaultValue: string }> =
    {
      titlePrompt: {
        title: t("settings:models.prompt.title"),
        variables: t("settings:models.vars.title"),
        defaultValue: DEFAULT_PROMPTS.titlePrompt,
      },
      translatePrompt: {
        title: t("settings:models.prompt.translate"),
        variables: t("settings:models.vars.translate"),
        defaultValue: DEFAULT_PROMPTS.translatePrompt,
      },
      suggestionPrompt: {
        title: t("settings:models.prompt.suggestion"),
        variables: t("settings:models.vars.suggestion"),
        defaultValue: DEFAULT_PROMPTS.suggestionPrompt,
      },
      ocrPrompt: {
        title: t("settings:models.prompt.ocr"),
        variables: t("settings:models.vars.ocr"),
        defaultValue: DEFAULT_PROMPTS.ocrPrompt,
      },
      compressPrompt: {
        title: t("settings:models.prompt.compress"),
        variables: t("settings:models.vars.compress"),
        defaultValue: DEFAULT_PROMPTS.compressPrompt,
      },
      promptOptimizePrompt: {
        title: t("settings:models.prompt.optimize"),
        variables: t("settings:models.vars.optimize"),
        defaultValue: DEFAULT_PROMPTS.promptOptimizePrompt,
      },
    };
  const features: Array<{
    modelKey: ModelKey;
    promptKey?: PromptKey;
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    description: string;
  }> = [
    {
      modelKey: "chatModelId",
      icon: Bot,
      title: t("settings:models.feature.chat.title"),
      description: t("settings:models.feature.chat.desc"),
    },
    {
      modelKey: "promptOptimizeModelId",
      promptKey: "promptOptimizePrompt",
      icon: Sparkles,
      title: t("settings:models.feature.optimize.title"),
      description: t("settings:models.feature.optimize.desc"),
    },
    {
      modelKey: "titleModelId",
      promptKey: "titlePrompt",
      icon: NotebookText,
      title: t("settings:models.feature.title.title"),
      description: t("settings:models.feature.title.desc"),
    },
    {
      modelKey: "translateModeId",
      promptKey: "translatePrompt",
      icon: Globe,
      title: t("settings:models.feature.translate.title"),
      description: t("settings:models.feature.translate.desc"),
    },
    {
      modelKey: "suggestionModelId",
      promptKey: "suggestionPrompt",
      icon: MessageSquareText,
      title: t("settings:models.feature.suggestion.title"),
      description: t("settings:models.feature.suggestion.desc"),
    },
    {
      modelKey: "compressModelId",
      promptKey: "compressPrompt",
      icon: FileClock,
      title: t("settings:models.feature.compress.title"),
      description: t("settings:models.feature.compress.desc"),
    },
    {
      modelKey: "ocrModelId",
      promptKey: "ocrPrompt",
      icon: FileImage,
      title: t("settings:models.feature.ocr.title"),
      description: t("settings:models.feature.ocr.desc"),
    },
    {
      modelKey: "imageGenerationModelId",
      icon: WandSparkles,
      title: t("settings:models.feature.image.title"),
      description: t("settings:models.feature.image.desc"),
    },
  ];
  const activePrompt = editingPrompt ? promptMeta[editingPrompt] : null;

  return (
    <>
      <SectionHeader
        icon={Settings2}
        title={t("settings:models.title")}
        subtitle={t("settings:models.subtitle")}
      />
      <div className="space-y-4">
        <div className="rounded-md border bg-card p-3 text-sm text-muted-foreground">
          {t("settings:models.note")}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {features.map((feature) => {
            const Icon = feature.icon;
            return (
              <div key={feature.modelKey} className="rounded-lg border bg-card p-4">
                <div className="mb-3 flex items-start gap-3">
                  <div className="rounded-md border bg-muted/40 p-2">
                    <Icon className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{feature.title}</div>
                    <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {feature.description}
                    </div>
                  </div>
                  {feature.promptKey ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setEditingPrompt(feature.promptKey ?? null)}
                      title={t("settings:models.edit_prompt")}
                    >
                      <Settings2 className="size-4" />
                    </Button>
                  ) : null}
                </div>
                {modelSelect(feature.modelKey)}
              </div>
            );
          })}
        </div>
        <div className="flex justify-end text-xs text-muted-foreground">
          {t("settings:models.autosaved")}
        </div>
      </div>
      <Dialog
        open={Boolean(editingPrompt)}
        onOpenChange={(open) => !open && setEditingPrompt(null)}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{activePrompt?.title ?? "Prompt"}</DialogTitle>
            <DialogDescription>
              {t("settings:models.variables_label")}
              {activePrompt?.variables}
            </DialogDescription>
          </DialogHeader>
          {editingPrompt ? (
            <Textarea
              value={draft[editingPrompt]}
              onChange={(event) => setDraft({ ...draft, [editingPrompt]: event.target.value })}
              className="h-[420px] font-mono text-xs"
            />
          ) : null}
          <DialogFooter>
            {editingPrompt ? (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setDraft({ ...draft, [editingPrompt]: promptMeta[editingPrompt].defaultValue })
                }
              >
                <RefreshCw className="size-4" />
                {t("settings:models.reset_default")}
              </Button>
            ) : null}
            <Button type="button" onClick={() => setEditingPrompt(null)}>
              {t("settings:models.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function createAsrProvider(type: AsrProviderType = "openai_realtime"): AsrProviderProfile {
  const base = {
    id: crypto.randomUUID(),
    type,
    apiKey: "",
    language: "",
  } as AsrProviderProfile;
  if (type === "dashscope") {
    return {
      ...base,
      name: "DashScope ASR",
      websocketUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
      model: "qwen3-asr-flash-realtime",
      sampleRate: 16000,
      vadThreshold: 0.2,
      silenceDurationMs: 800,
    };
  }
  if (type === "volcengine") {
    return {
      ...base,
      name: "Volcengine ASR",
      websocketUrl: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
      resourceId: "volc.seedasr.sauc.duration",
    };
  }
  return {
    ...base,
    name: "OpenAI Realtime ASR",
    websocketUrl: "wss://api.openai.com/v1/realtime?intent=transcription",
    model: "gpt-4o-transcribe",
    prompt: "",
    sampleRate: 24000,
    vadThreshold: 0.5,
    prefixPaddingMs: 300,
    silenceDurationMs: 500,
  };
}

function createTtsProvider(type: TtsProviderType = "system"): TtsProviderProfile {
  const base = {
    id: crypto.randomUUID(),
    type,
    apiKey: "",
    baseUrl: "",
  } as TtsProviderProfile;
  if (type === "openai")
    return {
      ...base,
      name: "OpenAI TTS",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-tts",
      voice: "alloy",
    };
  if (type === "gemini")
    return {
      ...base,
      name: "Gemini TTS",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-2.5-flash-preview-tts",
      voiceName: "Kore",
    };
  if (type === "minimax")
    return {
      ...base,
      name: "MiniMax TTS",
      baseUrl: "https://api.minimaxi.com/v1",
      model: "speech-2.6-turbo",
      voiceId: "female-shaonv",
      emotion: "calm",
      speed: 1,
    };
  if (type === "qwen")
    return {
      ...base,
      name: "Qwen TTS",
      baseUrl: "https://dashscope.aliyuncs.com/api/v1",
      model: "qwen3-tts-flash",
      voice: "Cherry",
      languageType: "Auto",
    };
  if (type === "groq")
    return {
      ...base,
      name: "Groq TTS",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "canopylabs/orpheus-v1-english",
      voice: "austin",
    };
  if (type === "xai")
    return {
      ...base,
      name: "xAI TTS",
      baseUrl: "https://api.x.ai/v1",
      voiceId: "eve",
      language: "auto",
    };
  if (type === "mimo")
    return {
      ...base,
      name: "MiMo TTS",
      baseUrl: "https://api.xiaomimimo.com/v1",
      model: "mimo-v2-tts",
      voice: "mimo_default",
    };
  return {
    ...base,
    id: "026a01a2-c3a0-4fd5-8075-80e03bdef200",
    name: "System TTS",
    speechRate: 1,
    pitch: 1,
  };
}

// Voice option lists per provider type. These mirror the curated dropdowns in Android's
// `TTSProviderConfigure.kt` — using `<Select>` (vs free-text `<Input>`) prevents typos
// that would otherwise cause silent 400/422 from the provider with no UI feedback.
// Lists are taken verbatim from the Android source as of v2.2.5.
const TTS_VOICES_OPENAI = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;
const TTS_VOICES_GROQ = ["austin", "natalie", "kailin"] as const;
const TTS_VOICES_QWEN = [
  "Cherry",
  "Serene",
  "Ethan",
  "Chelsie",
  "Momo",
  "Vivian",
  "Moon",
  "Maia",
  "Kai",
  "Nofish",
  "Bella",
  "Jennifer",
  "Ryan",
  "Katerina",
  "Aiden",
  "Eldric Sage",
  "Mia",
  "Mochi",
  "Bellona",
  "Vincent",
  "Bunny",
  "Neil",
  "Elias",
  "Arthur",
  "Nini",
] as const;
const TTS_VOICES_XAI = ["eve", "ara", "rex", "sal", "leo"] as const;
const TTS_VOICES_MINIMAX = [
  "male-qn-qingse",
  "male-qn-jingying",
  "male-qn-badao",
  "male-qn-daxuesheng",
  "female-shaonv",
  "female-yujie",
  "female-chengshu",
  "female-tianmei",
  "audiobook_male_1",
  "audiobook_female_1",
  "cartoon_pig",
] as const;
const TTS_EMOTIONS_MINIMAX = [
  "calm",
  "happy",
  "sad",
  "angry",
  "fearful",
  "disgusted",
  "surprised",
] as const;
const TTS_LANGUAGE_TYPES_QWEN = ["Auto", "Chinese", "English", "Japanese", "Korean"] as const;
const TTS_LANGUAGES_XAI: { value: string; label: string }[] = [
  { value: "auto", label: "Auto-detect" },
  { value: "en", label: "English" },
  { value: "zh", label: "Chinese (Simplified)" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "es-ES", label: "Spanish (Spain)" },
  { value: "es-MX", label: "Spanish (Mexico)" },
  { value: "pt-BR", label: "Portuguese (Brazil)" },
  { value: "pt-PT", label: "Portuguese (Portugal)" },
  { value: "it", label: "Italian" },
  { value: "ru", label: "Russian" },
  { value: "ar-EG", label: "Arabic (Egypt)" },
  { value: "hi", label: "Hindi" },
  { value: "tr", label: "Turkish" },
  { value: "vi", label: "Vietnamese" },
  { value: "id", label: "Indonesian" },
  { value: "bn", label: "Bengali" },
];

function TtsSettingsPanel({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const providers = settings.ttsProviders ?? [];
  const [selectedId, setSelectedId] = React.useState(
    settings.selectedTTSProviderId ?? providers[0]?.id ?? "",
  );
  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0];
  const [draft, setDraft] = React.useState<TtsProviderProfile | null>(
    selected ? clone(selected) : null,
  );

  React.useEffect(() => {
    const next = providers.find((provider) => provider.id === selectedId) ?? providers[0];
    setDraft(next ? clone(next) : null);
  }, [providers, selectedId]);

  const saveProvider = React.useCallback(
    async (provider: TtsProviderProfile) => {
      const result = await api.post<{ provider: TtsProviderProfile }>(
        "settings/tts-provider/detail",
        provider,
      );
      const exists = providers.some((item) => item.id === result.provider.id);
      const ttsProviders = exists
        ? providers.map((item) => (item.id === result.provider.id ? result.provider : item))
        : [result.provider, ...providers];
      onSettings({
        ...settings,
        ttsProviders,
        selectedTTSProviderId: settings.selectedTTSProviderId ?? result.provider.id,
      });
      setSelectedId(result.provider.id);
    },
    [onSettings, providers, settings],
  );

  const patchDraft = React.useCallback(
    (patch: Partial<TtsProviderProfile>) => {
      setDraft((current) => {
        if (!current) return current;
        const next = { ...current, ...patch };
        window.setTimeout(
          () => void saveProvider(next).catch((error: Error) => toast.error(error.message)),
          0,
        );
        return next;
      });
    },
    [saveProvider],
  );

  const addProvider = React.useCallback(
    async (type: TtsProviderType) => {
      await saveProvider(createTtsProvider(type));
    },
    [saveProvider],
  );

  const reorderProviders = React.useCallback(
    (from: number, to: number) => {
      const ttsProviders = moveItem(providers, from, to);
      onSettings({ ...settings, ttsProviders });
      void api
        .post("settings/tts-provider/reorder", { ids: ttsProviders.map((item) => item.id) })
        .catch((error: Error) => toast.error(error.message));
    },
    [onSettings, providers, settings],
  );

  const selectProvider = React.useCallback(
    async (providerId: string) => {
      setSelectedId(providerId);
      await api.post("settings/tts-provider/select", { id: providerId });
      onSettings({ ...settings, selectedTTSProviderId: providerId });
    },
    [onSettings, settings],
  );

  const removeProvider = React.useCallback(async () => {
    if (!draft || draft.type === "system") return;
    await api.delete(`settings/tts-provider/${encodeURIComponent(draft.id)}`);
    const ttsProviders = providers.filter((provider) => provider.id !== draft.id);
    onSettings({
      ...settings,
      ttsProviders,
      selectedTTSProviderId:
        settings.selectedTTSProviderId === draft.id
          ? (ttsProviders[0]?.id ?? null)
          : settings.selectedTTSProviderId,
    });
    setSelectedId(ttsProviders[0]?.id ?? "");
  }, [draft, onSettings, providers, settings]);

  // Test playback uses the global audio singleton with a synthetic key so the test button
  // can toggle (play vs stop) and so that starting the test stops any in-progress chat
  // message playback. The key embeds the draft id so multiple settings panels (if ever
  // mounted) don't collide.
  const testPlaybackKey = draft ? `__tts-test__:${draft.id}` : "__tts-test__";
  const playingKey = useAudioPlaybackKey();
  const isTestPlaying = playingKey === testPlaybackKey;

  const handleTest = React.useCallback(async () => {
    if (!draft) return;
    if (isTestPlaying) {
      stopAudio();
      return;
    }
    try {
      // The backend's `tts/speech` endpoint accepts a `providerId` override — this is
      // critical so the test fires against the provider being edited, not the globally
      // selected one (which may be a different provider entirely). The draft must be
      // already saved for this to work; patchDraft auto-saves on every keystroke so
      // by the time the user clicks test the latest config is persisted server-side.
      const response = await api.postBlob("tts/speech", {
        text: t("settings:speech.test_text"),
        providerId: draft.id,
      });
      const contentType = response.headers.get("Content-Type") ?? "";
      if (contentType.includes("application/json")) {
        // System TTS path — Windows is speaking on-device; nothing for us to play.
        toast.success(t("settings:speech.test_system_done"));
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      await playAudio(testPlaybackKey, url, url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:speech.test_failed"));
    }
  }, [draft, isTestPlaying, testPlaybackKey, t]);

  const numericInput = (
    key: keyof TtsProviderProfile,
    label: string,
    description: string,
    min: number,
    max: number,
    step = 0.05,
  ) => {
    if (!draft) return null;
    const value = Number(draft[key] ?? 1);
    return (
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-medium">{label}</div>
            <div className="text-xs text-muted-foreground">{description}</div>
          </div>
          <Input
            className="w-24"
            value={Number.isFinite(value) ? String(value) : ""}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next))
                patchDraft({
                  [key]: Math.min(max, Math.max(min, next)),
                } as Partial<TtsProviderProfile>);
            }}
          />
        </div>
        <Slider
          min={min}
          max={max}
          step={step}
          value={[Number.isFinite(value) ? value : 1]}
          onValueChange={([next]) =>
            patchDraft({ [key]: next ?? 1 } as Partial<TtsProviderProfile>)
          }
        />
      </div>
    );
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between gap-3 border-b p-3">
          <div className="text-sm font-medium">{t("settings:speech.tts_services")}</div>
          <Select onValueChange={(value) => void addProvider(value as TtsProviderType)}>
            <SelectTrigger className="h-8 w-28">
              <SelectValue placeholder={t("settings:speech.add")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="openai">OpenAI</SelectItem>
              <SelectItem value="gemini">Gemini</SelectItem>
              <SelectItem value="minimax">MiniMax</SelectItem>
              <SelectItem value="qwen">Qwen</SelectItem>
              <SelectItem value="groq">Groq</SelectItem>
              <SelectItem value="xai">xAI</SelectItem>
              <SelectItem value="mimo">MiMo</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 p-2">
          {providers.map((provider, index) => (
            <SortableRow
              key={provider.id}
              id={provider.id}
              index={index}
              active={provider.id === selectedId}
              onSelect={() => setSelectedId(provider.id)}
              onMove={reorderProviders}
            >
              <span className="flex min-w-0 items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{provider.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {provider.type}
                  </span>
                </span>
                {provider.id === settings.selectedTTSProviderId ? (
                  <Check className="size-4 shrink-0 text-primary" />
                ) : null}
              </span>
            </SortableRow>
          ))}
          {providers.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              {t("settings:speech.tts_empty")}
            </div>
          ) : null}
        </div>
      </div>

      {draft ? (
        <div className="space-y-4 rounded-lg border bg-card p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-lg font-semibold">{draft.name}</div>
              <div className="text-sm text-muted-foreground">
                {t("settings:speech.tts_card_desc")}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => void handleTest()}
                title={t("settings:speech.test_title")}
              >
                {isTestPlaying ? <Square className="size-4" /> : <Volume2 className="size-4" />}
                {isTestPlaying ? t("settings:speech.stop") : t("settings:speech.test")}
              </Button>
              <Button
                variant={draft.id === settings.selectedTTSProviderId ? "secondary" : "outline"}
                onClick={() => void selectProvider(draft.id)}
              >
                {draft.id === settings.selectedTTSProviderId
                  ? t("settings:speech.selected")
                  : t("settings:speech.set_current")}
              </Button>
              {draft.type !== "system" ? (
                <Button variant="outline" onClick={() => void removeProvider()}>
                  <Trash2 className="size-4" />
                  {t("settings:common.delete")}
                </Button>
              ) : null}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <div className="text-sm font-medium">{t("settings:speech.name")}</div>
              <Input
                value={draft.name}
                onChange={(event) => patchDraft({ name: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium">{t("settings:speech.type")}</div>
              <Input value={draft.type} readOnly />
            </div>
            {draft.type !== "system" ? (
              <>
                <div className="space-y-2 md:col-span-2">
                  <div className="text-sm font-medium">{t("settings:speech.api_key")}</div>
                  <PasswordInput
                    value={draft.apiKey ?? ""}
                    onChange={(apiKey) => patchDraft({ apiKey })}
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <div className="text-sm font-medium">{t("settings:speech.base_url")}</div>
                  <Input
                    value={draft.baseUrl ?? ""}
                    onChange={(event) => patchDraft({ baseUrl: event.target.value })}
                  />
                </div>
                {draft.type !== "xai" ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">{t("settings:speech.model")}</div>
                    <Input
                      value={draft.model ?? ""}
                      onChange={(event) => patchDraft({ model: event.target.value })}
                    />
                  </div>
                ) : null}
                {draft.type === "gemini" ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Voice Name</div>
                    <Input
                      value={draft.voiceName ?? ""}
                      onChange={(event) => patchDraft({ voiceName: event.target.value })}
                    />
                  </div>
                ) : null}
                {draft.type === "minimax"
                  ? (() => {
                      const voiceId = draft.voiceId ?? "";
                      const isPreset = (TTS_VOICES_MINIMAX as readonly string[]).includes(voiceId);
                      // Dropdown value: shows the matched preset, or our `__custom__` sentinel
                      // when voiceId is empty / a custom-trained value not in the preset list.
                      // The sentinel is needed because Radix Select reserves "" — we can't use
                      // the empty string as an option value directly.
                      const dropdownValue = isPreset ? voiceId : "__custom__";
                      return (
                        <div className="space-y-2">
                          <div className="text-sm font-medium">Voice ID</div>
                          {/* Preset-first combobox: dropdown is the primary control on the left;
                          a free-text Input appears on the right ONLY when the user picks
                          "自定义". MiniMax's voice cloning produces opaque voice IDs that
                          aren't in our preset list, so users need to be able to paste them.
                          Matches Android's `ExposedDropdownMenuBox` UX
                          (`TTSProviderConfigure.kt:382-431`) where the editable text field
                          appears once a custom voice is in use. */}
                          <div className="flex gap-2">
                            <Select
                              value={dropdownValue}
                              onValueChange={(value) => {
                                if (value === "__custom__") {
                                  // Switching from a preset to "custom" — wipe the voiceId so
                                  // the input starts empty and the user is prompted to fill it.
                                  // If we're already in custom mode (just re-selected "自定义"),
                                  // leave the existing custom voiceId alone.
                                  if (isPreset) patchDraft({ voiceId: "" });
                                } else {
                                  patchDraft({ voiceId: value });
                                }
                              }}
                            >
                              <SelectTrigger className="flex-1">
                                <SelectValue placeholder={t("settings:speech.select_voice")} />
                              </SelectTrigger>
                              <SelectContent>
                                {TTS_VOICES_MINIMAX.map((voice) => (
                                  <SelectItem key={voice} value={voice}>
                                    {voice}
                                  </SelectItem>
                                ))}
                                <SelectItem value="__custom__">
                                  {t("settings:speech.custom_voice")}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                            {dropdownValue === "__custom__" ? (
                              <Input
                                className="flex-1"
                                value={voiceId}
                                onChange={(event) => patchDraft({ voiceId: event.target.value })}
                                placeholder={t("settings:speech.custom_voice_ph")}
                              />
                            ) : null}
                          </div>
                        </div>
                      );
                    })()
                  : null}
                {draft.type === "xai" ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Voice ID</div>
                    <Select
                      value={draft.voiceId ?? ""}
                      onValueChange={(value) => patchDraft({ voiceId: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t("settings:speech.select_voice")} />
                      </SelectTrigger>
                      <SelectContent>
                        {TTS_VOICES_XAI.map((voice) => (
                          <SelectItem key={voice} value={voice}>
                            {voice}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                {draft.type === "openai" || draft.type === "qwen" || draft.type === "groq" ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Voice</div>
                    <Select
                      value={draft.voice ?? ""}
                      onValueChange={(value) => patchDraft({ voice: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t("settings:speech.select_voice")} />
                      </SelectTrigger>
                      <SelectContent>
                        {(draft.type === "openai"
                          ? TTS_VOICES_OPENAI
                          : draft.type === "qwen"
                            ? TTS_VOICES_QWEN
                            : TTS_VOICES_GROQ
                        ).map((voice) => (
                          <SelectItem key={voice} value={voice}>
                            {voice}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                {draft.type === "mimo" ? (
                  // Android keeps `mimo` voice as a free-text input — the provider exposes
                  // an open-ended voice catalog (custom-trained voice IDs), not a fixed list.
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Voice</div>
                    <Input
                      value={draft.voice ?? ""}
                      onChange={(event) => patchDraft({ voice: event.target.value })}
                    />
                  </div>
                ) : null}
                {draft.type === "qwen" ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Language Type</div>
                    <Select
                      value={draft.languageType ?? "Auto"}
                      onValueChange={(value) => patchDraft({ languageType: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t("settings:speech.select_lang_type")} />
                      </SelectTrigger>
                      <SelectContent>
                        {TTS_LANGUAGE_TYPES_QWEN.map((lang) => (
                          <SelectItem key={lang} value={lang}>
                            {lang}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                {draft.type === "xai" ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Language</div>
                    <Select
                      value={draft.language ?? "auto"}
                      onValueChange={(value) => patchDraft({ language: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t("settings:speech.select_language")} />
                      </SelectTrigger>
                      <SelectContent>
                        {TTS_LANGUAGES_XAI.map((lang) => (
                          <SelectItem key={lang.value} value={lang.value}>
                            {lang.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                {draft.type === "minimax" ? (
                  <>
                    <div className="space-y-2">
                      <div className="text-sm font-medium">Emotion</div>
                      {/* "自动" maps to empty string in the persisted state, which the server
                          uses as a signal to drop the `emotion` field entirely from the
                          MiniMax request (letting MiniMax pick based on text). We can't
                          actually USE `""` as a Radix `<SelectItem value>` — Radix reserves
                          empty string — so we route it through a `__auto__` sentinel and
                          convert at the boundary. The stored data stays clean (empty string),
                          only the UI uses the sentinel. */}
                      <Select
                        value={(draft.emotion ?? "") === "" ? "__auto__" : draft.emotion}
                        onValueChange={(value) =>
                          patchDraft({ emotion: value === "__auto__" ? "" : value })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={t("settings:speech.select_emotion")} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__auto__">
                            {t("settings:speech.emotion_auto")}
                          </SelectItem>
                          {TTS_EMOTIONS_MINIMAX.map((emotion) => (
                            <SelectItem key={emotion} value={emotion}>
                              {emotion}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="md:col-span-2">
                      {numericInput(
                        "speed",
                        "Speed",
                        t("settings:speech.minimax_speed_desc"),
                        0.5,
                        2,
                        0.05,
                      )}
                    </div>
                  </>
                ) : null}
              </>
            ) : (
              <div className="space-y-5 md:col-span-2">
                {numericInput(
                  "speechRate",
                  "Speech Rate",
                  t("settings:speech.system_rate_desc"),
                  0.2,
                  3,
                  0.05,
                )}
                {numericInput(
                  "pitch",
                  "Pitch",
                  t("settings:speech.system_pitch_desc"),
                  0.2,
                  3,
                  0.05,
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {t("settings:speech.select_tts")}
        </div>
      )}
    </div>
  );
}

function SpeechSection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const providers = settings.asrProviders ?? [];
  const [selectedId, setSelectedId] = React.useState(
    settings.selectedASRProviderId ?? providers[0]?.id ?? "",
  );
  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0];
  const [draft, setDraft] = React.useState<AsrProviderProfile | null>(
    selected ? clone(selected) : null,
  );

  React.useEffect(() => {
    const next = providers.find((provider) => provider.id === selectedId) ?? providers[0];
    setDraft(next ? clone(next) : null);
  }, [providers, selectedId]);

  const saveProvider = React.useCallback(
    async (provider: AsrProviderProfile) => {
      const result = await api.post<{ provider: AsrProviderProfile }>(
        "settings/asr-provider/detail",
        provider,
      );
      const exists = providers.some((item) => item.id === result.provider.id);
      const asrProviders = exists
        ? providers.map((item) => (item.id === result.provider.id ? result.provider : item))
        : [result.provider, ...providers];
      onSettings({
        ...settings,
        asrProviders,
        selectedASRProviderId: settings.selectedASRProviderId ?? result.provider.id,
      });
      setSelectedId(result.provider.id);
    },
    [onSettings, providers, settings],
  );

  const patchDraft = React.useCallback(
    (patch: Partial<AsrProviderProfile>) => {
      setDraft((current) => {
        if (!current) return current;
        const next = { ...current, ...patch };
        window.setTimeout(
          () => void saveProvider(next).catch((error: Error) => toast.error(error.message)),
          0,
        );
        return next;
      });
    },
    [saveProvider],
  );

  const addProvider = React.useCallback(
    async (type: AsrProviderType) => {
      const provider = createAsrProvider(type);
      await saveProvider(provider);
    },
    [saveProvider],
  );

  const reorderProviders = React.useCallback(
    (from: number, to: number) => {
      const asrProviders = moveItem(providers, from, to);
      onSettings({ ...settings, asrProviders });
      void api
        .post("settings/asr-provider/reorder", { ids: asrProviders.map((item) => item.id) })
        .catch((error: Error) => toast.error(error.message));
    },
    [onSettings, providers, settings],
  );

  const selectProvider = React.useCallback(
    async (providerId: string) => {
      setSelectedId(providerId);
      await api.post("settings/asr-provider/select", { id: providerId });
      onSettings({ ...settings, selectedASRProviderId: providerId });
    },
    [onSettings, settings],
  );

  const removeProvider = React.useCallback(async () => {
    if (!draft) return;
    await api.delete(`settings/asr-provider/${encodeURIComponent(draft.id)}`);
    const asrProviders = providers.filter((provider) => provider.id !== draft.id);
    onSettings({
      ...settings,
      asrProviders,
      selectedASRProviderId:
        settings.selectedASRProviderId === draft.id
          ? (asrProviders[0]?.id ?? null)
          : settings.selectedASRProviderId,
    });
    setSelectedId(asrProviders[0]?.id ?? "");
  }, [draft, onSettings, providers, settings]);

  const numericInput = (
    key: keyof AsrProviderProfile,
    label: string,
    description: string,
    min: number,
    max: number,
    step = 1,
  ) => {
    if (!draft) return null;
    const value = Number(draft[key] ?? min);
    return (
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-medium">{label}</div>
            <div className="text-xs text-muted-foreground">{description}</div>
          </div>
          <Input
            className="w-24"
            value={Number.isFinite(value) ? String(value) : ""}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next))
                patchDraft({
                  [key]: Math.min(max, Math.max(min, next)),
                } as Partial<AsrProviderProfile>);
            }}
          />
        </div>
        <Slider
          min={min}
          max={max}
          step={step}
          value={[Number.isFinite(value) ? value : min]}
          onValueChange={([next]) =>
            patchDraft({ [key]: next ?? min } as Partial<AsrProviderProfile>)
          }
        />
      </div>
    );
  };

  return (
    <>
      <SectionHeader
        icon={Mic}
        title={t("settings:speech.tts_title")}
        subtitle={t("settings:speech.tts_subtitle")}
      />
      <TtsSettingsPanel settings={settings} onSettings={onSettings} />
      <Separator className="my-8" />
      <SectionHeader
        icon={Mic}
        title={t("settings:speech.asr_title")}
        subtitle={t("settings:speech.asr_subtitle")}
      />
      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div className="rounded-lg border bg-card">
          <div className="flex items-center justify-between gap-3 border-b p-3">
            <div className="text-sm font-medium">{t("settings:speech.asr_services")}</div>
            <Select onValueChange={(value) => void addProvider(value as AsrProviderType)}>
              <SelectTrigger className="h-8 w-28">
                <SelectValue placeholder={t("settings:speech.add")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai_realtime">OpenAI</SelectItem>
                <SelectItem value="dashscope">DashScope</SelectItem>
                <SelectItem value="volcengine">Volcengine</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 p-2">
            {providers.map((provider, index) => (
              <SortableRow
                key={provider.id}
                id={provider.id}
                index={index}
                active={provider.id === selectedId}
                onSelect={() => setSelectedId(provider.id)}
                onMove={reorderProviders}
              >
                <span className="flex min-w-0 items-center justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{provider.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {provider.type}
                    </span>
                  </span>
                  {provider.id === settings.selectedASRProviderId ? (
                    <Check className="size-4 shrink-0 text-primary" />
                  ) : null}
                </span>
              </SortableRow>
            ))}
            {providers.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {t("settings:speech.asr_empty")}
              </div>
            ) : null}
          </div>
        </div>

        {draft ? (
          <div className="space-y-4 rounded-lg border bg-card p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-lg font-semibold">{draft.name}</div>
                <div className="text-sm text-muted-foreground">
                  {t("settings:speech.asr_card_desc")}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant={draft.id === settings.selectedASRProviderId ? "secondary" : "outline"}
                  onClick={() => void selectProvider(draft.id)}
                >
                  {draft.id === settings.selectedASRProviderId
                    ? t("settings:speech.selected")
                    : t("settings:speech.set_current")}
                </Button>
                <Button variant="outline" onClick={() => void removeProvider()}>
                  <Trash2 className="size-4" />
                  {t("settings:common.delete")}
                </Button>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <div className="text-sm font-medium">{t("settings:speech.name")}</div>
                <Input
                  value={draft.name}
                  onChange={(event) => patchDraft({ name: event.target.value })}
                />
              </div>
              <div className="space-y-2">
                <div className="text-sm font-medium">{t("settings:speech.type")}</div>
                <Input value={draft.type} readOnly />
              </div>
              <div className="space-y-2 md:col-span-2">
                <div className="text-sm font-medium">{t("settings:speech.api_key")}</div>
                <PasswordInput
                  value={draft.apiKey ?? ""}
                  onChange={(apiKey) => patchDraft({ apiKey })}
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <div className="text-sm font-medium">{t("settings:speech.ws_url")}</div>
                <Input
                  value={draft.websocketUrl ?? ""}
                  onChange={(event) => patchDraft({ websocketUrl: event.target.value })}
                />
              </div>
              {draft.type !== "volcengine" ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium">{t("settings:speech.model")}</div>
                  <Input
                    value={draft.model ?? ""}
                    onChange={(event) => patchDraft({ model: event.target.value })}
                    placeholder={
                      draft.type === "dashscope" ? "qwen3-asr-flash-realtime" : "gpt-4o-transcribe"
                    }
                  />
                </div>
              ) : null}
              {draft.type === "volcengine" ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium">Resource ID</div>
                  <Input
                    value={draft.resourceId ?? ""}
                    onChange={(event) => patchDraft({ resourceId: event.target.value })}
                    placeholder="volc.seedasr.sauc.duration"
                  />
                </div>
              ) : null}
              <div className="space-y-2">
                <div className="text-sm font-medium">{t("settings:speech.language")}</div>
                <Input
                  value={draft.language ?? ""}
                  onChange={(event) => patchDraft({ language: event.target.value })}
                  placeholder={draft.type === "dashscope" ? "zh" : "auto"}
                />
              </div>
              {draft.type === "openai_realtime" ? (
                <div className="space-y-2 md:col-span-2">
                  <div className="text-sm font-medium">{t("settings:speech.prompt")}</div>
                  <Textarea
                    value={draft.prompt ?? ""}
                    onChange={(event) => patchDraft({ prompt: event.target.value })}
                    placeholder="Optional"
                  />
                </div>
              ) : null}
            </div>
            <div className="space-y-5">
              {draft.type !== "volcengine"
                ? numericInput(
                    "sampleRate",
                    t("settings:speech.sample_rate"),
                    t("settings:speech.sample_rate_desc"),
                    8000,
                    48000,
                    1000,
                  )
                : null}
              {draft.type !== "volcengine"
                ? numericInput(
                    "vadThreshold",
                    t("settings:speech.vad_threshold"),
                    t("settings:speech.vad_threshold_desc"),
                    0,
                    1,
                    0.05,
                  )
                : null}
              {draft.type === "openai_realtime"
                ? numericInput(
                    "prefixPaddingMs",
                    t("settings:speech.prefix_padding"),
                    t("settings:speech.prefix_padding_desc"),
                    0,
                    2000,
                    50,
                  )
                : null}
              {draft.type !== "volcengine"
                ? numericInput(
                    "silenceDurationMs",
                    t("settings:speech.silence_duration"),
                    t("settings:speech.silence_duration_desc"),
                    100,
                    5000,
                    100,
                  )
                : null}
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
            {t("settings:speech.select_asr")}
          </div>
        )}
      </div>
    </>
  );
}

function McpExtensionsSection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  type Tab = "mcp" | "mode" | "lorebook" | "quick" | "skills";
  const tabFromQuery = React.useMemo<Tab>(() => {
    if (typeof window === "undefined") return "mcp";
    const value = new URLSearchParams(window.location.search).get("tab");
    return value === "mcp" ||
      value === "mode" ||
      value === "lorebook" ||
      value === "quick" ||
      value === "skills"
      ? value
      : "mcp";
  }, []);
  const [tab, setTab] = React.useState<Tab>(tabFromQuery);
  const [selectedAssistantId, setSelectedAssistantId] = React.useState(settings.assistantId);
  const selectedAssistant =
    settings.assistants.find((item) => item.id === selectedAssistantId) ?? settings.assistants[0];

  React.useEffect(() => {
    if (!settings.assistants.some((item) => item.id === selectedAssistantId))
      setSelectedAssistantId(settings.assistantId);
  }, [selectedAssistantId, settings.assistantId, settings.assistants]);

  return (
    <>
      <SectionHeader
        icon={CopyPlus}
        title={t("settings:mcp.title")}
        subtitle={t("settings:mcp.subtitle")}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(
          [
            ["mcp", "MCP", CopyPlus],
            ["mode", t("settings:mcp.tab.mode"), WandSparkles],
            ["lorebook", t("settings:mcp.tab.lorebook"), Database],
            ["quick", t("settings:mcp.tab.quick"), MessageSquareText],
            ["skills", "Skills", Bot],
          ] as Array<[Tab, string, React.ComponentType<{ className?: string }>]>
        ).map(([idValue, label, Icon]) => (
          <Button
            key={String(idValue)}
            variant={tab === idValue ? "default" : "outline"}
            size="sm"
            onClick={() => setTab(idValue as Tab)}
          >
            {React.createElement(Icon as React.ComponentType<{ className?: string }>, {
              className: "size-4",
            })}
            {label}
          </Button>
        ))}
        <div className="ml-auto min-w-56">
          <Select value={selectedAssistant.id} onValueChange={setSelectedAssistantId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {settings.assistants.map((assistant) => (
                <SelectItem key={assistant.id} value={assistant.id}>
                  {assistant.name || t("settings:assistants.default_name")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {tab === "mcp" && (
        <McpServerEditor
          settings={settings}
          assistant={selectedAssistant}
          onSettings={onSettings}
        />
      )}
      {tab === "mode" && (
        <ModeInjectionEditor
          settings={settings}
          assistant={selectedAssistant}
          onSettings={onSettings}
        />
      )}
      {tab === "lorebook" && (
        <LorebookEditor settings={settings} assistant={selectedAssistant} onSettings={onSettings} />
      )}
      {tab === "quick" && (
        <QuickMessageEditor
          settings={settings}
          assistant={selectedAssistant}
          onSettings={onSettings}
        />
      )}
      {tab === "skills" && (
        <SkillsEditor settings={settings} assistant={selectedAssistant} onSettings={onSettings} />
      )}
    </>
  );
}

function prettyJson(value: unknown) {
  return JSON.stringify(value ?? [], null, 2);
}

function parseJson<T>(value: string, fallback: T, errorMsg = "Invalid JSON"): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    void fallback;
    throw new Error(errorMsg);
  }
}

async function pullSettings(onSettings: (settings: Settings) => void) {
  const next = await api.get<Settings>("settings");
  onSettings(next);
  return next;
}

function mcpName(server: Record<string, unknown>) {
  const common =
    server.commonOptions && typeof server.commonOptions === "object"
      ? (server.commonOptions as Record<string, unknown>)
      : {};
  return textValue(common.name) || "MCP Server";
}

function mcpStatus(server: Record<string, unknown>) {
  const common =
    server.commonOptions && typeof server.commonOptions === "object"
      ? (server.commonOptions as Record<string, unknown>)
      : {};
  if (common.enable === false) return { ok: false, key: "off" };
  if (common.connected === false || textValue(common.lastSyncError))
    return { ok: false, key: "error" };
  return { ok: true, key: "connected" };
}

function McpServerEditor({
  settings,
  assistant,
  onSettings,
}: {
  settings: Settings;
  assistant: AssistantProfile;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const servers = (settings.mcpServers ?? []) as Array<Record<string, unknown>>;
  const [selectedId, setSelectedId] = React.useState(textValue(servers[0]?.id));
  const selected =
    servers.find((item) => String(item.id) === selectedId) ?? servers[0] ?? createMcpServer();
  const [draft, setDraft] = React.useState<Record<string, unknown>>(clone(selected));
  const [headersText, setHeadersText] = React.useState(
    prettyJson((selected.commonOptions as Record<string, unknown> | undefined)?.headers ?? []),
  );
  const [toolsText, setToolsText] = React.useState(
    prettyJson((selected.commonOptions as Record<string, unknown> | undefined)?.tools ?? []),
  );
  const [busy, setBusy] = React.useState(false);
  // dirtyRef drives the debounce autosave (set on every edit, cleared on save completion).
  const dirtyRef = React.useRef(false);
  // Race-condition tracking for in-flight saves. A keystroke landing between "save starts"
  // and "save resolves" used to have its dirtyRef=true overwritten by the post-save reset,
  // so the next debounce cycle skipped and the keystroke was never persisted — it lingered
  // in draft only until the realignment effect below clobbered it with the just-saved
  // (older) snapshot. savingRef lets every edit during the save window flag
  // editedDuringSaveRef; on completion we keep dirtyRef true when it's set, so the next
  // debounce re-saves instead of dropping the keystroke.
  const savingRef = React.useRef(false);
  const editedDuringSaveRef = React.useRef(false);
  // serversRef lets the realignment effect read the freshest servers list WITHOUT taking
  // settings.mcpServers as a dependency. If settings.mcpServers were a dep, the effect
  // would re-fire after every save → pullSettings round-trip and overwrite in-flight
  // keystrokes — the original "URL input eats characters" bug. The old dirtyRef guard
  // tried to defend this but was undone by save() clearing dirtyRef on completion (the
  // keystroke-while-saving window).
  const serversRef = React.useRef(servers);
  serversRef.current = servers;

  const markDirty = () => {
    dirtyRef.current = true;
    if (savingRef.current) editedDuringSaveRef.current = true;
  };

  React.useEffect(() => {
    // Re-load the form only when the user switches server (selectedId). settings.mcpServers
    // is intentionally NOT a dep — see serversRef above.
    const all = serversRef.current;
    const next = all.find((item) => String(item.id) === selectedId) ?? all[0];
    if (!next) return;
    if (String(next.id) !== selectedId) setSelectedId(String(next.id));
    setDraft(clone(next));
    setHeadersText(
      prettyJson((next.commonOptions as Record<string, unknown> | undefined)?.headers ?? []),
    );
    setToolsText(
      prettyJson((next.commonOptions as Record<string, unknown> | undefined)?.tools ?? []),
    );
    dirtyRef.current = false;
    editedDuringSaveRef.current = false;
  }, [selectedId]);

  const common =
    draft.commonOptions && typeof draft.commonOptions === "object"
      ? (draft.commonOptions as Record<string, unknown>)
      : {};
  const tools = Array.isArray(common.tools) ? (common.tools as Array<Record<string, unknown>>) : [];
  // Master switch (commonOptions.enable). When OFF, the per-tool child switches stay
  // visible AND show their last preference, but are read-only & greyed — the user can
  // see what'll come back when they re-enable the master switch.
  const serverEnabled = common.enable !== false;
  // Inline expand state — matches Android McpToolCard (SettingMcpPage.kt:801 `var expanded`).
  // Tracked by tool name (server-unique) so re-renders don't lose the open card.
  const [expandedToolName, setExpandedToolName] = React.useState<string | null>(null);
  const patchDraft = (nextDraft: Record<string, unknown>) => {
    markDirty();
    setDraft(nextDraft);
  };
  // Update one tool's fields (enable / needsApproval) without losing other tools' edits.
  // We mutate both the in-memory tools array (drives the UI) and toolsText (the canonical
  // persistence source consumed by save()) so the debounced auto-save writes the toggle.
  const updateToolAt = (index: number, patch: Partial<Record<string, unknown>>) => {
    const nextTools = tools.map((tool, i) => (i === index ? { ...tool, ...patch } : tool));
    const nextCommon = { ...common, tools: nextTools };
    patchDraft({ ...draft, commonOptions: nextCommon });
    setToolsText(prettyJson(nextTools));
  };
  // Merge the server's authoritative fields (fetched tools, sync status, Transition 1/2
  // enable flips) into the current draft WITHOUT touching user-edited fields (url / name /
  // headers text). Functional setState reads the freshest draft, so keystrokes that landed
  // during the save's network round-trip survive the merge.
  const applyServerResult = (serverData: Record<string, unknown>) => {
    const serverCommon =
      serverData.commonOptions && typeof serverData.commonOptions === "object"
        ? (serverData.commonOptions as Record<string, unknown>)
        : {};
    setDraft((prev) => {
      const prevCommon =
        prev.commonOptions && typeof prev.commonOptions === "object"
          ? (prev.commonOptions as Record<string, unknown>)
          : {};
      return {
        ...prev,
        commonOptions: {
          ...prevCommon,
          tools: serverCommon.tools ?? prevCommon.tools ?? [],
          lastSyncAt: serverCommon.lastSyncAt ?? prevCommon.lastSyncAt,
          lastSyncError: serverCommon.lastSyncError ?? prevCommon.lastSyncError,
          connected: serverCommon.connected ?? prevCommon.connected,
          enable:
            serverCommon.enable !== undefined ? serverCommon.enable : prevCommon.enable,
        },
      };
    });
    setToolsText(prettyJson(serverCommon.tools ?? []));
  };
  const patchCommon = (patch: Record<string, unknown>) => {
    let parsedHeaders: unknown[];
    let parsedTools: unknown[];
    try {
      parsedHeaders = parseJson<unknown[]>(headersText, [], t("settings:mcp.json_invalid"));
      parsedTools = parseJson<unknown[]>(toolsText, [], t("settings:mcp.json_invalid"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:mcp.json_invalid"));
      return;
    }
    const nextDraft = { ...draft, commonOptions: { ...common, ...patch } };
    setDraft(nextDraft);
    savingRef.current = true;
    editedDuringSaveRef.current = false;
    void api
      .post<{ server: Record<string, unknown> }>("settings/mcp-server/detail", {
        ...nextDraft,
        commonOptions: {
          ...(nextDraft.commonOptions as Record<string, unknown>),
          headers: parsedHeaders,
          tools: parsedTools,
        },
      })
      .then((result: { server: Record<string, unknown> }) => {
        setSelectedId(String(result.server.id));
        savingRef.current = false;
        // Keep dirty if the user typed during the round-trip; otherwise mark clean.
        dirtyRef.current = editedDuringSaveRef.current;
        applyServerResult(result.server);
        return pullSettings(onSettings);
      })
      .catch((error) => {
        savingRef.current = false;
        dirtyRef.current = true; // retry on next debounce
        toast.error(error instanceof Error ? error.message : t("settings:mcp.save_failed"));
      });
  };
  const save = async (announce = true) => {
    if (!announce && !dirtyRef.current) return;
    setBusy(true);
    savingRef.current = true;
    editedDuringSaveRef.current = false;
    try {
      const payload = {
        ...draft,
        commonOptions: {
          ...common,
          headers: parseJson<unknown[]>(headersText, [], t("settings:mcp.json_invalid")),
          tools: parseJson<unknown[]>(toolsText, [], t("settings:mcp.json_invalid")),
        },
      };
      const result = await api.post<{ server: Record<string, unknown> }>(
        "settings/mcp-server/detail",
        payload,
      );
      setSelectedId(String(result.server.id));
      savingRef.current = false;
      // Keep dirty if the user typed during the round-trip; otherwise mark clean.
      dirtyRef.current = editedDuringSaveRef.current;
      applyServerResult(result.server);
      await pullSettings(onSettings);
      if (announce) toast.success(t("settings:mcp.server.saved"));
    } catch (error) {
      savingRef.current = false;
      dirtyRef.current = true; // retry on next debounce
      if (announce) toast.error(error instanceof Error ? error.message : t("settings:mcp.save_failed"));
      else console.warn("MCP auto-save failed", error);
    } finally {
      setBusy(false);
    }
  };
  React.useEffect(() => {
    if (!dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void save(false);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [draft, headersText, toolsText]);
  const remove = async () => {
    if (!selected.id || !window.confirm(t("settings:mcp.server.delete_confirm"))) return;
    await api.delete(`settings/mcp-server/${encodeURIComponent(String(selected.id))}`);
    setSelectedId("");
    await pullSettings(onSettings);
    toast.success(t("settings:mcp.server.deleted"));
  };
  const reorder = async (from: number, to: number) => {
    const next = moveItem(servers, from, to);
    onSettings({ ...settings, mcpServers: next as unknown as Settings["mcpServers"] });
    await api.post("settings/mcp-server/reorder", { ids: next.map((item) => String(item.id)) });
    await pullSettings(onSettings);
  };

  return (
    <EditorShell
      items={servers}
      selectedId={selectedId}
      emptyLabel={t("settings:mcp.server.empty")}
      onSelect={setSelectedId}
      onMove={reorder}
      titleOf={mcpName}
      renderItem={(item) => {
        const status = mcpStatus(item);
        return (
          <div className="flex min-w-0 items-center gap-2 text-left">
            <span
              className={`size-2 shrink-0 rounded-full ${status.ok ? "bg-emerald-500" : "bg-red-500"}`}
              title={t(`settings:mcp.status_${status.key}`)}
            />
            <span className="truncate">{mcpName(item)}</span>
          </div>
        );
      }}
      onCreate={async () => {
        // Save the new item server-side BEFORE touching any state. Without the immediate
        // POST, the 800 ms debounce loses the race against the `[selectedId, settings.X]`
        // realignment effect at line 3410 — which fires when `setSelectedId(next.id)`
        // changes the dep, doesn't find the new id in `servers` (settings hasn't refreshed
        // yet), and snaps selectedId back to servers[0]. End result: the new item is
        // silently discarded. Eager-saving guarantees the new item lands in `settings`
        // before the realignment effect runs, so it finds and keeps the just-created id.
        const next = createMcpServer();
        try {
          await api.post("settings/mcp-server/detail", next);
          await pullSettings(onSettings);
          setSelectedId(String(next.id));
          setDraft(clone(next));
          setHeadersText("[]");
          setToolsText("[]");
          dirtyRef.current = false;
        } catch (error) {
          toast.error(error instanceof Error ? error.message : t("settings:mcp.server.create_failed"));
        }
      }}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">{t("settings:mcp.server.detail")}</div>
            <div className="text-xs text-muted-foreground">
              {t("settings:mcp.server.detail_desc")}
            </div>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.name")}</span>
            <Input
              value={textValue(common.name)}
              onChange={(event) =>
                patchDraft({ ...draft, commonOptions: { ...common, name: event.target.value } })
              }
              placeholder={t("settings:mcp.name_ph")}
            />
          </label>
          <label className="flex items-end gap-2 pb-1">
            <span className="pb-2 text-sm text-muted-foreground">{t("settings:mcp.enabled")}</span>
            <Switch
              checked={common.enable !== false}
              onCheckedChange={(checked) => patchCommon({ enable: checked })}
            />
          </label>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Select
            value={textValue(draft.type) || "streamable_http"}
            onValueChange={(value) => patchDraft({ ...draft, type: value })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="streamable_http">Streamable HTTP</SelectItem>
              <SelectItem value="sse">SSE</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.server.url")}</span>
          <Input
            value={textValue(draft.url)}
            onChange={(event) => patchDraft({ ...draft, url: event.target.value })}
            placeholder="https://example.com/mcp"
          />
          <span className="block text-xs text-muted-foreground">
            {t("settings:mcp.server.url_desc")}
          </span>
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.server.headers_json")}</span>
          <Textarea
            value={headersText}
            onChange={(event) => {
              markDirty();
              setHeadersText(event.target.value);
            }}
            className="min-h-24 font-mono text-xs"
            placeholder='[["Authorization","Bearer ..."]]'
          />
          <span className="block text-xs text-muted-foreground">
            {t("settings:mcp.server.headers_desc")}
          </span>
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.server.tools_json")}</span>
          <Textarea
            value={toolsText}
            onChange={(event) => {
              markDirty();
              setToolsText(event.target.value);
            }}
            className="h-44 max-h-44 font-mono text-xs"
            placeholder={t("settings:mcp.server.tools_ph")}
          />
          <span className="block text-xs text-muted-foreground">
            {t("settings:mcp.server.tools_desc")}
            {textValue(common.lastSyncError) ? t("settings:mcp.server.last_error", { error: textValue(common.lastSyncError) }) : ""}
          </span>
        </label>
        <div className="rounded-md border">
          <div className="border-b px-3 py-2 text-sm font-medium">{t("settings:mcp.server.tools_title")}</div>
          <div className="max-h-[28rem] overflow-auto p-2">
            {tools.length === 0 ? (
              <div className="p-3 text-sm text-muted-foreground">{t("settings:mcp.server.tools_empty")}</div>
            ) : null}
            {/* McpToolCard mirror — first row: name + needs-approval switch + enable switch +
                expand chevron. Expanded body: markdown description + JSON-schema property tags.
                Matches Android SettingMcpPage.kt:795-902 (no Dialog, all inline).
                Master/child semantics: when the MCP server's commonOptions.enable is false,
                the per-tool switches are read-only and greyed out — but they STILL show the
                user's last preference, which the master-on transition will revive. */}
            {tools.map((tool, index) => {
              const name = textValue(tool.name) || "unnamed_tool";
              const description = textValue(tool.description);
              const enabled = tool.enable !== false;
              const needsApproval = tool.needsApproval === true;
              const expanded = expandedToolName === name;
              const schema =
                tool.inputSchema && typeof tool.inputSchema === "object"
                  ? (tool.inputSchema as Record<string, unknown>)
                  : null;
              const properties =
                schema && schema.properties && typeof schema.properties === "object"
                  ? (schema.properties as Record<string, Record<string, unknown>>)
                  : {};
              const required = Array.isArray(schema?.required)
                ? (schema!.required as unknown[]).map(String)
                : [];
              const propertyEntries = Object.entries(properties);
              return (
                <div
                  key={`${name}_${index}`}
                  className={cn(
                    "rounded-md border bg-muted/20 px-3 py-2 mb-2 last:mb-0",
                    !serverEnabled && "opacity-60",
                  )}
                >
                  <div className="flex items-center gap-3">
                    <span className="flex-1 truncate text-sm font-medium" title={name}>
                      {name}
                    </span>
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span>{t("settings:mcp.server.needs_approval")}</span>
                      <Switch
                        checked={needsApproval}
                        disabled={!serverEnabled}
                        onCheckedChange={(checked) =>
                          updateToolAt(index, { needsApproval: checked })
                        }
                      />
                    </label>
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span>{t("settings:mcp.enabled")}</span>
                      <Switch
                        checked={enabled}
                        disabled={!serverEnabled}
                        onCheckedChange={(checked) => updateToolAt(index, { enable: checked })}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => setExpandedToolName(expanded ? null : name)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={expanded ? t("settings:mcp.server.collapse") : t("settings:mcp.server.expand")}
                    >
                      <ChevronDownChip expanded={expanded} />
                    </button>
                  </div>
                  {expanded ? (
                    <div className="mt-2 space-y-2">
                      {description ? (
                        <div className="text-xs text-muted-foreground">
                          <Markdown content={description} className="message-markdown" />
                        </div>
                      ) : null}
                      {propertyEntries.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {propertyEntries.map(([propName]) => {
                            const isRequired = required.includes(propName);
                            return (
                              <span
                                key={propName}
                                className={cn(
                                  "rounded-md px-2 py-0.5 font-mono text-[0.6875rem]",
                                  isRequired
                                    ? "bg-blue-500/10 text-blue-700 dark:text-blue-300"
                                    : "bg-background text-muted-foreground border",
                                )}
                                title={isRequired ? `${propName} (required)` : propName}
                              >
                                {propName}
                              </span>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <div className="mr-auto flex items-center px-2 text-xs text-muted-foreground">
            {busy ? t("settings:mcp.autosaving") : t("settings:mcp.autosaved")}
          </div>
          <Button variant="destructive" onClick={() => void remove()} disabled={!selected.id}>
            <Trash2 className="size-4" />
            {t("settings:mcp.delete")}
          </Button>
        </div>
      </div>
    </EditorShell>
  );
}

function createMcpServer(): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    type: "streamable_http",
    url: "",
    commonOptions: { enable: true, name: "MCP Server", headers: [], tools: [] },
  };
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
    id: crypto.randomUUID(),
    type: "mode",
    name: "提示词注入",
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
    id: crypto.randomUUID(),
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
              entry.enabled === false ? "bg-muted-foreground/40" : "bg-emerald-500",
            )}
          />
          <span className="truncate text-sm font-medium">
            {textValue(entry.name) || t("settings:mcp.entry_n", { n: index + 1 })}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">· {triggerSummary}</span>
        </span>
        <ChevronDownChip expanded={expanded} />
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
                    <SelectItem value="USER">User</SelectItem>
                    <SelectItem value="ASSISTANT">Assistant</SelectItem>
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

function ChevronDownChip({ expanded }: { expanded: boolean }) {
  return (
    <span
      aria-hidden
      className={cn("text-muted-foreground transition", expanded ? "rotate-180" : "rotate-0")}
    >
      ▾
    </span>
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
  const dirtyRef = React.useRef(false);
  // itemsRef: avoid re-running this effect after every autosave → pullSettings round-trip
  // (would overwrite mid-flight keystrokes). See McpServerEditor for rationale.
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  React.useEffect(() => {
    const next = itemsRef.current.find((item) => String(item.id) === selectedId) ?? itemsRef.current[0];
    if (!next) return;
    setSelectedId(String(next.id));
    setDraft(clone(next));
    dirtyRef.current = false;
  }, [selectedId]);
  const entries = Array.isArray(draft.entries)
    ? (draft.entries as Array<Record<string, unknown>>)
    : [];
  const patchDraft = (patch: Record<string, unknown>) => {
    dirtyRef.current = true;
    setDraft({ ...draft, ...patch });
  };
  const setEntries = (next: Array<Record<string, unknown>>) => {
    dirtyRef.current = true;
    setDraft({ ...draft, entries: next });
  };
  const save = async (announce = true) => {
    if (!announce && !dirtyRef.current) return;
    await api.post("settings/lorebook/detail", draft);
    dirtyRef.current = false;
    await pullSettings(onSettings);
    if (announce) toast.success(t("settings:mcp.lorebook.saved"));
  };
  React.useEffect(() => {
    if (!dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void save(false).catch((error: Error) => console.warn("Lorebook auto-save failed", error));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [draft]);
  const bind = async (checked: boolean) => {
    const ids = new Set(assistant.lorebookIds ?? []);
    if (checked) ids.add(String(draft.id));
    else ids.delete(String(draft.id));
    await api.post("settings/assistant/injections", {
      assistantId: assistant.id,
      modeInjectionIds: assistant.modeInjectionIds ?? [],
      lorebookIds: [...ids],
      quickMessageIds: assistant.quickMessageIds ?? [],
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
        // setState + dirtyRef=true approach loses the new lorebook because the
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
          dirtyRef.current = false;
        } catch (error) {
          toast.error(error instanceof Error ? error.message : t("settings:mcp.lorebook.create_failed"));
        }
      }}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">{t("settings:mcp.lorebook.detail")}</div>
          <Switch
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
          <div className="mr-auto flex items-center px-2 text-xs text-muted-foreground">
            {t("settings:mcp.autosaved")}
          </div>
          <Button
            variant="destructive"
            onClick={async () => {
              await api.delete(`settings/lorebook/${draft.id}`);
              await pullSettings(onSettings);
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
    id: crypto.randomUUID(),
    name: "世界书",
    description: "",
    enabled: true,
    entries: [
      {
        id: crypto.randomUUID(),
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

function QuickMessageEditor({
  settings,
  assistant,
  onSettings,
}: {
  settings: Settings;
  assistant: AssistantProfile;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const items = (settings.quickMessages ?? []) as unknown as Array<Record<string, unknown>>;
  const [selectedId, setSelectedId] = React.useState(textValue(items[0]?.id));
  const selected = items.find((item) => String(item.id) === selectedId) ??
    items[0] ?? { id: crypto.randomUUID(), title: "", content: "" };
  const [draft, setDraft] = React.useState<Record<string, unknown>>(clone(selected));
  const dirtyRef = React.useRef(false);
  // itemsRef: avoid re-running this effect after every autosave → pullSettings round-trip
  // (would overwrite mid-flight keystrokes). See McpServerEditor for rationale.
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  React.useEffect(() => {
    const next = itemsRef.current.find((item) => String(item.id) === selectedId) ?? itemsRef.current[0];
    if (next) {
      setSelectedId(String(next.id));
      setDraft(clone(next));
      dirtyRef.current = false;
    }
  }, [selectedId]);
  const patchDraft = (patch: Record<string, unknown>) => {
    dirtyRef.current = true;
    setDraft({ ...draft, ...patch });
  };
  const save = React.useCallback(
    async (announce = false) => {
      if (!announce && !dirtyRef.current) return;
      await api.post("settings/quick-message/detail", draft);
      dirtyRef.current = false;
      await pullSettings(onSettings);
      if (announce) toast.success(t("settings:mcp.quick.saved"));
    },
    [draft, onSettings],
  );
  React.useEffect(() => {
    if (!dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void save(false).catch((error: Error) =>
        console.warn("Quick message auto-save failed", error),
      );
    }, 700);
    return () => window.clearTimeout(timer);
  }, [draft, save]);
  const bind = async (checked: boolean) => {
    const ids = new Set(assistant.quickMessageIds ?? []);
    if (checked) ids.add(String(draft.id));
    else ids.delete(String(draft.id));
    await api.post("settings/assistant/injections", {
      assistantId: assistant.id,
      modeInjectionIds: assistant.modeInjectionIds ?? [],
      lorebookIds: assistant.lorebookIds ?? [],
      quickMessageIds: [...ids],
    });
    await pullSettings(onSettings);
  };
  return (
    <EditorShell
      items={items}
      selectedId={selectedId}
      emptyLabel={t("settings:mcp.quick.empty")}
      onSelect={setSelectedId}
      titleOf={(item) => textValue(item.title) || t("settings:mcp.tab.quick")}
      onMove={async (from, to) => {
        const next = moveItem(items, from, to);
        onSettings({ ...settings, quickMessages: next as unknown as Settings["quickMessages"] });
        await api.post("settings/quick-message/reorder", {
          ids: next.map((item) => String(item.id)),
        });
      }}
      onCreate={() => {
        const next = { id: crypto.randomUUID(), title: t("settings:mcp.tab.quick"), content: "" };
        setSelectedId(String(next.id));
        setDraft(next);
        dirtyRef.current = true;
      }}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">{t("settings:mcp.quick.detail")}</div>
          <Switch
            checked={(assistant.quickMessageIds ?? []).includes(String(draft.id))}
            onCheckedChange={(checked) => void bind(checked)}
          />
        </div>
        <Input
          value={textValue(draft.title)}
          onChange={(event) => patchDraft({ title: event.target.value })}
          placeholder={t("settings:mcp.quick.title")}
        />
        <Textarea
          value={textValue(draft.content)}
          onChange={(event) => patchDraft({ content: event.target.value })}
          className="min-h-52"
          placeholder={t("settings:mcp.quick.content")}
        />
        <div className="flex justify-end gap-2">
          <div className="mr-auto flex items-center px-2 text-xs text-muted-foreground">
            {t("settings:mcp.autosaved")}
          </div>
          <Button
            variant="destructive"
            onClick={async () => {
              await api.delete(`settings/quick-message/${draft.id}`);
              await pullSettings(onSettings);
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
  const dirtyRef = React.useRef(false);
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
    dirtyRef.current = false;
  }, [selectedId, items]);
  const patchDraft = (patch: Record<string, unknown>) => {
    dirtyRef.current = true;
    setDraft({ ...draft, ...patch });
  };
  const save = React.useCallback(
    async (announce = false) => {
      if (!announce && !dirtyRef.current) return;
      await api.post(savePath, draft);
      dirtyRef.current = false;
      await pullSettings(onSettings);
      if (announce) toast.success(t("settings:mcp.item_saved", { title }));
    },
    [draft, onSettings, savePath, title],
  );
  React.useEffect(() => {
    if (!dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void save(false).catch((error: Error) => console.warn(`${title} auto-save failed`, error));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [draft, save, title]);
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
      modeInjectionIds:
        bindKey === "modeInjectionIds" ? [...ids] : (assistant.modeInjectionIds ?? []),
      lorebookIds: assistant.lorebookIds ?? [],
      quickMessageIds: assistant.quickMessageIds ?? [],
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
        //      `dirtyRef.current = false` when selectedId changed, cancelling the pending
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
          dirtyRef.current = false;
        } catch (error) {
          toast.error(error instanceof Error ? error.message : t("settings:mcp.item_create_failed", { title }));
        }
      }}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">{t("settings:mcp.item_detail", { title })}</div>
          <Switch
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
                  <SelectItem value="USER">User</SelectItem>
                  <SelectItem value="ASSISTANT">Assistant</SelectItem>
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
        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <span className="text-sm">{t("settings:mcp.enabled")}</span>
          <Switch
            checked={draft.enabled !== false}
            onCheckedChange={(checked) => patchDraft({ enabled: checked })}
          />
        </div>
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
          <div className="mr-auto flex items-center px-2 text-xs text-muted-foreground">
            {t("settings:mcp.autosaved")}
          </div>
          <Button
            variant="destructive"
            onClick={async () => {
              await api.delete(`${deletePath}/${draft.id}`);
              await pullSettings(onSettings);
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

function SkillsEditor({
  settings,
  assistant,
  onSettings,
}: {
  settings: Settings;
  assistant: AssistantProfile;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const [skills, setSkills] = React.useState<SkillProfile[]>([]);
  const [selected, setSelected] = React.useState("");
  const [content, setContent] = React.useState("");
  const [files, setFiles] = React.useState<SkillFileInfo[]>([]);
  const [githubUrl, setGithubUrl] = React.useState("");
  const [importing, setImporting] = React.useState(false);
  const [importingFile, setImportingFile] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const dirtyRef = React.useRef(false);

  const load = React.useCallback(async () => {
    const list = await api.get<SkillProfile[]>("skills");
    setSkills(list);
    if (!selected && list[0]) setSelected(list[0].name);
  }, [selected]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const selectedSkill = skills.find((skill) => skill.name === selected);

  React.useEffect(() => {
    if (!selected) return;
    if (!selectedSkill) {
      setFiles([]);
      return;
    }
    api
      .get<SkillProfile>(`skills/${encodeURIComponent(selected)}`)
      .then((skill) => {
        setContent(skill.content ?? "");
        dirtyRef.current = false;
      })
      .catch(() => setContent(""));
    api
      .get<{ files: SkillFileInfo[] }>(`skills/${encodeURIComponent(selected)}/files`)
      .then((result) => setFiles(result.files))
      .catch(() => setFiles([]));
  }, [selected, selectedSkill]);

  const save = React.useCallback(
    async (announce = false) => {
      if (!announce && !dirtyRef.current) return;
      const name = textValue(parseSkillName(content) || selected || "new-skill");
      setSaving(true);
      try {
        await api.post("skills/detail", { name, content });
        dirtyRef.current = false;
        await load();
        setSelected(name);
        if (announce) toast.success(t("settings:mcp.skill_saved"));
      } catch (error) {
        if (announce) toast.error(error instanceof Error ? error.message : t("settings:mcp.save_failed"));
        else console.warn("Skill auto-save failed", error);
      } finally {
        setSaving(false);
      }
    },
    [content, load, selected],
  );
  React.useEffect(() => {
    if (!dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void save(false);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [content, save]);
  const remove = async () => {
    if (!selected || !window.confirm(t("settings:mcp.delete_skill_confirm"))) return;
    await api.delete(`skills/${encodeURIComponent(selected)}`);
    setSelected("");
    setContent("");
    await load();
    await pullSettings(onSettings);
  };
  const importFromGitHub = async () => {
    if (!githubUrl.trim()) return;
    setImporting(true);
    try {
      const result = await api.post<{ skill: SkillProfile }>(
        "skills/import-github",
        { repoUrl: githubUrl.trim() },
        { timeout: false },
      );
      await load();
      setSelected(result.skill.name);
      setContent(result.skill.content ?? "");
      dirtyRef.current = false;
      setGithubUrl("");
      toast.success(t("settings:mcp.skill_imported", { name: result.skill.name }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:mcp.import_failed"));
    } finally {
      setImporting(false);
    }
  };
  // 对齐安卓 commit af9b1f35 的 importSkillFromFile：支持从本地选择
  // .md/.zip 文件并上传到后端解析。ZIP 包内可含多个技能（每个根目录
  // 下放一份 SKILL.md），全部按原子方式导入。
  const importFromFile = async (file: File) => {
    setImportingFile(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(appendWebAuthQuery("/api/skills/import-file"), {
        method: "POST",
        body: formData,
      });
      const data = (await res.json()) as {
        imported?: string[];
        skills?: SkillProfile[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || t("settings:mcp.import_failed"));
      await load();
      const first = data.skills?.[0];
      if (first) {
        setSelected(first.name);
        setContent(first.content ?? "");
        dirtyRef.current = false;
      }
      const names = (data.imported ?? []).join("、");
      toast.success(t("settings:mcp.skill_imported", { name: names || file.name }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:mcp.import_failed"));
    } finally {
      setImportingFile(false);
    }
  };
  const handleFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void importFromFile(file);
  };
  const toggle = async (skillName: string, checked: boolean) => {
    const ids = new Set(assistant.enabledSkills as string[] | undefined);
    if (checked) ids.add(skillName);
    else ids.delete(skillName);
    await api.post("settings/assistant/skills", {
      assistantId: assistant.id,
      enabledSkills: [...ids],
    });
    await pullSettings(onSettings);
  };

  return (
    <EditorShell
      items={skills as unknown as Array<Record<string, unknown>>}
      selectedId={selected}
      emptyLabel={t("settings:mcp.empty_skill")}
      onSelect={setSelected}
      titleOf={(item) => textValue(item.name)}
      renderItem={(item) => {
        const name = textValue(item.name);
        const enabled = (assistant.enabledSkills as string[] | undefined)?.includes(name) ?? false;
        return (
          <div className="flex min-w-0 items-center gap-2 text-left">
            <span
              className={`size-2 shrink-0 rounded-full ${enabled ? "bg-emerald-500" : "bg-red-500"}`}
            />
            <span className="block min-w-0 truncate font-medium">{name}</span>
          </div>
        );
      }}
      onCreate={() => {
        const name = "new-skill";
        setSelected(name);
        setContent(
          `---\nname: ${name}\ndescription: ${t("settings:mcp.skill_desc_default")}\n---\n\n${t("settings:mcp.skill_body_default")}\n`,
        );
        setFiles([]);
        dirtyRef.current = true;
      }}
    >
      <div className="space-y-4">
        <div className="rounded-md border p-3">
          <div className="mb-2 text-sm font-medium">{t("settings:mcp.import_github")}</div>
          <div className="flex gap-2">
            <Input
              value={githubUrl}
              onChange={(event) => setGithubUrl(event.target.value)}
              placeholder={t("settings:mcp.github_url_ph")}
              onKeyDown={(event) => {
                if (event.key === "Enter") void importFromGitHub();
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => void importFromGitHub()}
              disabled={importing || !githubUrl.trim()}
            >
              {importing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              {t("settings:mcp.import_btn")}
            </Button>
          </div>
        </div>
        <div className="rounded-md border p-3">
          <div className="mb-2 text-sm font-medium">{t("settings:mcp.import_file")}</div>
          <div
            className="mb-2 text-xs text-muted-foreground"
            dangerouslySetInnerHTML={{ __html: t("settings:mcp.import_file_desc") }}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.markdown,.zip,application/zip"
            className="hidden"
            onChange={handleFileInputChange}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={importingFile}
          >
            {importingFile ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
            {t("settings:mcp.select_file")}
          </Button>
        </div>
        <div className="space-y-2 rounded-md border p-3">
          {skills.map((skill) => (
            <label
              key={skill.name}
              className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted/40"
            >
              <Checkbox
                className="mt-0.5"
                checked={
                  (assistant.enabledSkills as string[] | undefined)?.includes(skill.name) ?? false
                }
                onCheckedChange={(checked) => void toggle(skill.name, checked === true)}
              />
              <span className="min-w-0 flex-1 truncate font-medium">{skill.name}</span>
            </label>
          ))}
        </div>
        {selectedSkill?.description ? (
          <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
            {selectedSkill.description}
          </div>
        ) : null}
        <div className="rounded-md border">
          <div className="border-b px-3 py-2 text-sm font-medium">{t("settings:mcp.file_list")}</div>
          <div className="max-h-40 overflow-auto p-2">
            {files.length === 0 ? (
              <div className="p-2 text-sm text-muted-foreground">{t("settings:mcp.no_files")}</div>
            ) : null}
            {files.map((file) => (
              <div
                key={file.path}
                className="flex items-center justify-between gap-3 rounded px-2 py-1 text-xs hover:bg-muted/40"
              >
                <span className={file.type === "directory" ? "font-medium" : ""}>{file.path}</span>
                <span className="text-muted-foreground">
                  {file.type === "directory" ? t("settings:mcp.directory") : `${file.size} B`}
                </span>
              </div>
            ))}
          </div>
        </div>
        <label className="block space-y-2">
          <span className="text-sm font-medium">SKILL.md</span>
          <Textarea
            value={content}
            onChange={(event) => {
              dirtyRef.current = true;
              setContent(event.target.value);
            }}
            className="h-80 max-h-80 font-mono text-xs"
          />
        </label>
        <div className="flex justify-end gap-2">
          <div className="mr-auto flex items-center px-2 text-xs text-muted-foreground">
            {saving ? t("settings:mcp.autosaving") : t("settings:mcp.autosaved")}
          </div>
          <Button variant="destructive" onClick={() => void remove()} disabled={!selected}>
            <Trash2 className="size-4" />
            {t("settings:mcp.delete")}
          </Button>
        </div>
      </div>
    </EditorShell>
  );
}

function parseSkillName(content: string) {
  const match = content.match(/^---[\s\S]*?\nname:\s*([^\n]+)[\s\S]*?\n---/);
  return match?.[1]?.trim().replace(/^"|"$/g, "");
}

function EditorShell({
  items,
  selectedId,
  emptyLabel,
  onSelect,
  onMove,
  titleOf,
  renderItem,
  onCreate,
  children,
}: {
  items: Array<Record<string, unknown>>;
  selectedId: string;
  emptyLabel: string;
  onSelect: (id: string) => void;
  onMove?: (from: number, to: number) => void | Promise<void>;
  titleOf: (item: Record<string, unknown>) => string;
  renderItem?: (item: Record<string, unknown>) => React.ReactNode;
  onCreate: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <div className="rounded-lg border bg-card p-3">
        <Button className="mb-3 w-full" variant="outline" onClick={onCreate}>
          <Plus className="size-4" />
          {t("settings:mcp.add_new")}
        </Button>
        <div className="space-y-1">
          {items.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              {emptyLabel}
            </div>
          ) : null}
          {items.map((item, index) => (
            <SortableRow
              key={String(item.id ?? item.name)}
              id={String(item.id ?? item.name)}
              index={index}
              active={String(item.id ?? item.name) === selectedId}
              onSelect={() => onSelect(String(item.id ?? item.name))}
              onMove={onMove ? (from, to) => void onMove(from, to) : undefined}
            >
              {renderItem ? (
                renderItem(item)
              ) : (
                <div className="truncate text-left">{titleOf(item)}</div>
              )}
            </SortableRow>
          ))}
        </div>
      </div>
      <div className="rounded-lg border bg-card p-5">{children}</div>
    </div>
  );
}

function DataSection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const importInputRef = React.useRef<HTMLInputElement>(null);
  const schemaInputRef = React.useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = React.useState(false);
  const [exportProgress, setExportProgress] = React.useState(0);
  const [exportedBytes, setExportedBytes] = React.useState(0);
  const [exportTotalBytes, setExportTotalBytes] = React.useState(0);
  const [importing, setImporting] = React.useState(false);
  const [importPhase, setImportPhase] = React.useState<"idle" | "uploading" | "processing">("idle");
  const [showExportDialog, setShowExportDialog] = React.useState(false);
  const [schemaStatus, setSchemaStatus] = React.useState<{
    hasAndroidSchema: boolean;
    schemaInfo: { identityHash: string; version: number } | null;
    conversationCount: number;
  } | null>(null);
  const [registeringSchema, setRegisteringSchema] = React.useState(false);
  const [schemaExpanded, setSchemaExpanded] = React.useState(false);
  const [importProgress, setImportProgress] = React.useState(0); // 0-100 during upload
  const defaultWebDav = (settings.webDavConfig ?? {
    url: "",
    username: "",
    password: "",
    path: "rikkahub_backups",
    items: ["DATABASE", "FILES"],
  }) as WebDavConfig;
  const [webDavDraft, setWebDavDraft] = React.useState<WebDavConfig>(defaultWebDav);
  const [webDavItems, setWebDavItems] = React.useState<WebDavBackupItem[]>([]);
  const [webDavBusy, setWebDavBusy] = React.useState("");
  const [webDavBackupProgress, setWebDavBackupProgress] = React.useState<{
    message: string;
    percent: number;
  } | null>(null);
  const [showWebDavPassword, setShowWebDavPassword] = React.useState(false);
  const webDavDirtyRef = React.useRef(false);

  const defaultS3 = (settings.s3Config ?? {
    endpoint: "",
    accessKeyId: "",
    secretAccessKey: "",
    bucket: "",
    region: "auto",
    pathStyle: true,
    items: ["DATABASE", "FILES"],
  }) as S3Config;
  const [s3Draft, setS3Draft] = React.useState<S3Config>(defaultS3);
  const [s3Items, setS3Items] = React.useState<S3BackupItem[]>([]);
  const [s3Busy, setS3Busy] = React.useState("");
  const [s3BackupProgress, setS3BackupProgress] = React.useState<{
    message: string;
    percent: number;
  } | null>(null);
  const [showS3Secret, setShowS3Secret] = React.useState(false);
  const s3DirtyRef = React.useRef(false);

  React.useEffect(() => {
    setWebDavDraft(defaultWebDav);
    webDavDirtyRef.current = false;
  }, [
    defaultWebDav.url,
    defaultWebDav.username,
    defaultWebDav.password,
    defaultWebDav.path,
    JSON.stringify(defaultWebDav.items ?? []),
  ]);

  React.useEffect(() => {
    fetch(appendWebAuthQuery("/api/data/export/status"))
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (s) setSchemaStatus(s);
      })
      .catch(() => {});
  }, []);

  const consumeBackupSse = async (
    url: string,
    onProgress: (message: string, percent: number) => void,
    body?: string,
  ) => {
    const response = await fetch(appendWebAuthQuery(url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: body ?? undefined,
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      throw new Error(text || `HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\n\n+/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const eventName =
          block
            .split(/\r?\n/)
            .find((line) => line.startsWith("event:"))
            ?.slice(6)
            .trim() ?? "message";
        const dataText = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!dataText) continue;
        const data = JSON.parse(dataText) as Record<string, unknown>;
        if (eventName === "progress") {
          onProgress(String(data.message ?? ""), Number(data.percent ?? 0));
        } else if (eventName === "done") {
          return data;
        } else if (eventName === "error") {
          throw new Error(String(data.error ?? t("settings:data.op_failed")));
        }
      }
    }
    throw new Error(t("settings:data.conn_closed"));
  };

  const patchWebDav = (patch: Partial<WebDavConfig>) => {
    webDavDirtyRef.current = true;
    setWebDavDraft({ ...webDavDraft, ...patch });
  };

  const saveWebDav = React.useCallback(
    async (announce = false) => {
      if (!announce && !webDavDirtyRef.current) return;
      const result = await api.post<{ config: WebDavConfig }>("data/webdav/config", webDavDraft);
      webDavDirtyRef.current = false;
      onSettings({ ...settings, webDavConfig: result.config } as Settings);
      if (announce) toast.success(t("settings:data.webdav_saved"));
    },
    [onSettings, settings, webDavDraft, t],
  );

  React.useEffect(() => {
    if (!webDavDirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void saveWebDav(false).catch((error: Error) =>
        toast.error(error.message || t("settings:data.webdav_autosave_failed")),
      );
    }, 700);
    return () => window.clearTimeout(timer);
  }, [saveWebDav, webDavDraft, t]);

  const refreshWebDavList = async () => {
    setWebDavBusy("list");
    try {
      await saveWebDav(false);
      const result = await api.get<{ items: WebDavBackupItem[] }>("data/webdav/list", {
        timeout: false,
      });
      setWebDavItems(result.items);
    } finally {
      setWebDavBusy("");
    }
  };

  const testWebDav = async () => {
    setWebDavBusy("test");
    try {
      await saveWebDav(false);
      await api.post("data/webdav/test", { config: webDavDraft }, { timeout: false });
      toast.success(t("settings:data.webdav_conn_ok"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.webdav_conn_failed"));
    } finally {
      setWebDavBusy("");
    }
  };

  const warnIfNoSchema = async () => {
    try {
      const res = await fetch(appendWebAuthQuery("/api/data/export/status"));
      if (res.ok) {
        const s = await res.json();
        if (!s.hasAndroidSchema && s.conversationCount > 0) {
          toast(t("settings:data.no_schema_warn"), { duration: 6000 });
        }
      }
    } catch {
      /* */
    }
  };

  const backupWebDav = async () => {
    await warnIfNoSchema();
    setWebDavBusy("backup");
    setWebDavBackupProgress({ message: t("settings:data.preparing"), percent: 0 });
    try {
      await saveWebDav(false);
      const data = await consumeBackupSse("/api/data/webdav/backup/stream", (message, percent) => {
        setWebDavBackupProgress({ message, percent });
      });
      if (Array.isArray(data.items)) setWebDavItems(data.items as WebDavBackupItem[]);
      toast.success(t("settings:data.webdav_backup_done"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.webdav_backup_failed"));
    } finally {
      setWebDavBusy("");
      setWebDavBackupProgress(null);
    }
  };

  const restoreWebDav = async (item: WebDavBackupItem) => {
    if (!window.confirm(t("settings:data.restore_confirm", { name: item.displayName }))) return;
    setWebDavBusy(`restore:${item.displayName}`);
    setWebDavBackupProgress({ message: t("settings:data.preparing"), percent: 0 });
    try {
      const data = await consumeBackupSse(
        "/api/data/webdav/restore/stream",
        (message, percent) => {
          setWebDavBackupProgress({ message, percent });
        },
        JSON.stringify({ fileName: item.displayName }),
      );
      if (data.settings) onSettings(data.settings as Settings);
      toast.success(t("settings:data.webdav_restored"));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("settings:data.webdav_restore_failed"),
      );
    } finally {
      setWebDavBusy("");
      setWebDavBackupProgress(null);
    }
  };

  const deleteWebDav = async (item: WebDavBackupItem) => {
    if (!window.confirm(t("settings:data.delete_confirm", { name: item.displayName }))) return;
    setWebDavBusy(`delete:${item.displayName}`);
    try {
      const result = await api.post<{ items: WebDavBackupItem[] }>(
        "data/webdav/delete",
        { fileName: item.displayName },
        { timeout: false },
      );
      setWebDavItems(result.items);
      toast.success(t("settings:data.webdav_deleted"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.webdav_delete_failed"));
    } finally {
      setWebDavBusy("");
    }
  };

  React.useEffect(() => {
    setS3Draft(defaultS3);
    s3DirtyRef.current = false;
  }, [
    defaultS3.endpoint,
    defaultS3.region,
    defaultS3.accessKeyId,
    defaultS3.secretAccessKey,
    defaultS3.bucket,
    defaultS3.pathStyle,
    JSON.stringify(defaultS3.items ?? []),
  ]);

  const patchS3 = (patch: Partial<S3Config>) => {
    s3DirtyRef.current = true;
    setS3Draft({ ...s3Draft, ...patch });
  };
  const saveS3 = React.useCallback(
    async (announce = false) => {
      if (!announce && !s3DirtyRef.current) return;
      const result = await api.post<{ config: S3Config }>("data/s3/config", s3Draft);
      s3DirtyRef.current = false;
      onSettings({ ...settings, s3Config: result.config } as Settings);
      if (announce) toast.success(t("settings:data.s3_saved"));
    },
    [onSettings, settings, s3Draft, t],
  );
  React.useEffect(() => {
    if (!s3DirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void saveS3(false).catch((error: Error) =>
        toast.error(error.message || t("settings:data.s3_autosave_failed")),
      );
    }, 700);
    return () => window.clearTimeout(timer);
  }, [saveS3, s3Draft, t]);
  const refreshS3List = async () => {
    setS3Busy("list");
    try {
      await saveS3(false);
      const result = await api.get<{ items: S3BackupItem[] }>("data/s3/list", { timeout: false });
      setS3Items(result.items);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.s3_list_failed"));
    } finally {
      setS3Busy("");
    }
  };
  const testS3 = async () => {
    setS3Busy("test");
    try {
      await saveS3(false);
      await api.post("data/s3/test", { config: s3Draft }, { timeout: false });
      toast.success(t("settings:data.s3_conn_ok"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.s3_conn_failed"));
    } finally {
      setS3Busy("");
    }
  };
  const backupS3 = async () => {
    await warnIfNoSchema();
    setS3Busy("backup");
    setS3BackupProgress({ message: t("settings:data.preparing"), percent: 0 });
    try {
      await saveS3(false);
      const data = await consumeBackupSse("/api/data/s3/backup/stream", (message, percent) => {
        setS3BackupProgress({ message, percent });
      });
      if (Array.isArray(data.items)) setS3Items(data.items as S3BackupItem[]);
      toast.success(t("settings:data.s3_backup_done"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.s3_backup_failed"));
    } finally {
      setS3Busy("");
      setS3BackupProgress(null);
    }
  };
  const restoreS3 = async (item: S3BackupItem) => {
    if (!window.confirm(t("settings:data.s3_restore_confirm", { name: item.displayName }))) return;
    setS3Busy(`restore:${item.displayName}`);
    setS3BackupProgress({ message: t("settings:data.preparing"), percent: 0 });
    try {
      const data = await consumeBackupSse(
        "/api/data/s3/restore/stream",
        (message, percent) => {
          setS3BackupProgress({ message, percent });
        },
        JSON.stringify({ fileName: item.displayName }),
      );
      if (data.settings) onSettings(data.settings as Settings);
      toast.success(t("settings:data.s3_restored"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.s3_restore_failed"));
    } finally {
      setS3Busy("");
      setS3BackupProgress(null);
    }
  };
  const deleteS3 = async (item: S3BackupItem) => {
    if (!window.confirm(t("settings:data.delete_confirm", { name: item.displayName }))) return;
    setS3Busy(`delete:${item.displayName}`);
    try {
      const result = await api.post<{ items: S3BackupItem[] }>(
        "data/s3/delete",
        { fileName: item.displayName },
        { timeout: false },
      );
      setS3Items(result.items);
      toast.success(t("settings:data.s3_deleted"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.s3_delete_failed"));
    } finally {
      setS3Busy("");
    }
  };

  const handleExportClick = async () => {
    try {
      const res = await fetch(appendWebAuthQuery("/api/data/export/status"));
      if (res.ok) setSchemaStatus(await res.json());
    } catch {
      /* */
    }
    setShowExportDialog(true);
  };

  const handleRegisterSchema = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setRegisteringSchema(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(appendWebAuthQuery("/api/data/register-schema"), {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("settings:data.register_failed"));
      setSchemaStatus((prev) =>
        prev
          ? { ...prev, hasAndroidSchema: true, schemaInfo: data.schemaInfo }
          : { hasAndroidSchema: true, schemaInfo: data.schemaInfo, conversationCount: 0 },
      );
      toast.success(
        t("settings:data.register_ok", {
          version: data.schemaInfo.version,
          hash: data.schemaInfo.identityHash.slice(0, 8),
        }),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings:data.register_failed"));
    } finally {
      setRegisteringSchema(false);
    }
  };

  const doExport = async () => {
    setShowExportDialog(false);
    setExporting(true);
    setExportProgress(0);
    setExportedBytes(0);
    setExportTotalBytes(0);
    const prepToast = toast.loading(t("settings:data.export_preparing"));
    try {
      // Download the zip via XHR so we can read onprogress (loaded / total) and surface a
      // progress bar — Bun's response carries a Content-Length so the browser knows the
      // total up front. ky/fetch don't expose download progress without a custom
      // ReadableStream consumer; XHR is simpler and well-supported by Tauri's webview.
      const result: { blob: Blob; fileName: string } = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", appendWebAuthQuery("/api/data/export"));
        xhr.responseType = "blob";
        xhr.onprogress = (ev) => {
          if (ev.lengthComputable && ev.total > 0) {
            setExportTotalBytes(ev.total);
            setExportedBytes(ev.loaded);
            setExportProgress(Math.round((ev.loaded / ev.total) * 100));
          } else {
            // Server didn't send Content-Length (shouldn't happen with our endpoint, but be
            // defensive). At least bump the byte counter so the user sees something moving.
            setExportedBytes(ev.loaded);
          }
        };
        xhr.onerror = () => reject(new Error(t("settings:data.export_network_error")));
        xhr.onabort = () => reject(new Error(t("settings:data.export_cancelled")));
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            // X-Export-Filename is set by the server with the canonical zip filename, so we
            // don't have to recompute the timestamp on the client (and risk it drifting).
            const headerName = xhr.getResponseHeader("X-Export-Filename") || "";
            const fallback = `rikkahub-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
            resolve({ blob: xhr.response as Blob, fileName: headerName || fallback });
          } else {
            reject(new Error(t("settings:data.export_http_error", { status: xhr.status })));
          }
        };
        xhr.send();
      });

      // Hand off the blob to a hidden <a download> click; the browser writes it to its
      // default Downloads folder. We can't get the real filesystem path back from the
      // browser API, but we tell the user the filename and where to look.
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.fileName;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      toast.dismiss(prepToast);
      // Long-lived success toast so the user has time to read the filename before it dismisses.
      // 8s is enough to copy the name into a file manager search box if they want.
      toast.success(t("settings:data.export_done", { name: result.fileName }), { duration: 8000 });
    } catch (error) {
      toast.dismiss(prepToast);
      toast.error(error instanceof Error ? error.message : t("settings:data.export_failed"));
    } finally {
      setExporting(false);
      setExportProgress(0);
      setExportedBytes(0);
      setExportTotalBytes(0);
    }
  };

  const importData = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!window.confirm(t("settings:data.import_confirm"))) return;

    setImporting(true);
    setImportPhase("uploading");
    setImportProgress(0);
    try {
      // Stream the file body directly to /api/data/import as application/octet-stream rather
      // than wrap it in multipart/form-data. Two reasons:
      //   1. Users have reported 10+ GB backups. `Buffer.from(await file.arrayBuffer())` on
      //      the server doubles JS heap memory; with streaming, the server writes chunks
      //      straight to disk and never holds the full body in memory.
      //   2. fetch() can't report upload progress. XMLHttpRequest can. We need the progress
      //      bar so the user doesn't think the app froze during a multi-GB upload.
      // The backend's data/import endpoint detects octet-stream via Content-Type and routes
      // to the streaming path; multipart still works as a fallback.
      const result = await new Promise<{
        status: string;
        source?: string;
        summary?: string[];
        settings: Settings;
      }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        // Auth token goes via the query-string helper since XHR doesn't run through the
        // ky beforeRequest hook that would otherwise inject the Authorization header.
        xhr.open("POST", appendWebAuthQuery("/api/data/import"));
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        // X-Filename lets the server log the original name (useful for triage); the magic
        // bytes still determine format. Filename is URI-encoded so non-ASCII names survive.
        xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            setImportProgress(pct);
          }
        };
        xhr.upload.onload = () => {
          // Upload finished, but server is still processing — switch phase so the UI shows
          // the indeterminate "processing" hint instead of stuck-at-100% progress bar.
          setImportPhase("processing");
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText));
            } catch (err) {
              reject(new Error("Invalid server response"));
            }
          } else {
            // Try to surface the server-side error message rather than the raw status code.
            let serverError = `HTTP ${xhr.status}`;
            try {
              const parsed = JSON.parse(xhr.responseText) as { error?: string };
              if (parsed.error) serverError = parsed.error;
            } catch {
              /* keep status code */
            }
            reject(new Error(serverError));
          }
        };
        xhr.onerror = () => reject(new Error(t("settings:data.import_network_error")));
        xhr.onabort = () => reject(new Error(t("settings:data.import_cancelled")));
        // No timeout — large backups may take 10+ minutes through upload + extract + SQLite.
        xhr.timeout = 0;
        xhr.send(file);
      });
      onSettings(result.settings);
      if (result.source === "android-zip") {
        const lines = (result.summary ?? []).filter(Boolean);
        toast.success(
          lines.length
            ? t("settings:data.import_android_lines", { lines: lines.join("；") })
            : t("settings:data.import_android"),
        );
      } else {
        toast.success(t("settings:data.import_done"));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.import_failed"));
    } finally {
      setImporting(false);
      setImportPhase("idle");
      setImportProgress(0);
    }
  };

  return (
    <>
      {showExportDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowExportDialog(false)}
        >
          <div
            className="mx-4 max-w-md rounded-lg bg-card p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold">{t("settings:data.export_confirm_title")}</h3>
            <div className="mt-3 text-sm text-muted-foreground">
              {schemaStatus?.hasAndroidSchema
                ? t("settings:data.export_with_schema", { count: schemaStatus.conversationCount })
                : t("settings:data.export_without_schema")}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setShowExportDialog(false)}>
                {t("settings:data.cancel")}
              </Button>
              <Button onClick={() => void doExport()}>
                <Download className="mr-1 size-4" />
                {schemaStatus?.hasAndroidSchema
                  ? t("settings:data.confirm_export")
                  : t("settings:data.export_no_chat")}
              </Button>
            </div>
          </div>
        </div>
      )}
      <SectionHeader
        icon={Database}
        title={t("settings:data.title")}
        subtitle={t("settings:data.subtitle")}
      />
      <div className="mb-4 rounded-lg border p-4">
        <div
          className="flex items-center gap-2 cursor-pointer"
          onClick={() => schemaStatus?.hasAndroidSchema && setSchemaExpanded(!schemaExpanded)}
        >
          <div className="text-sm font-medium">{t("settings:data.android_compat")}</div>
          {schemaStatus?.hasAndroidSchema ? (
            <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-700 dark:bg-green-900 dark:text-green-300">
              {t("settings:data.ready")}
            </span>
          ) : (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-900 dark:text-amber-300">
              {t("settings:data.unregistered")}
            </span>
          )}
          {schemaStatus?.hasAndroidSchema && (
            <span className="ml-auto text-xs text-muted-foreground">
              {schemaExpanded ? t("settings:data.collapse") : t("settings:data.expand")}
            </span>
          )}
        </div>
        {schemaStatus?.hasAndroidSchema && !schemaExpanded && (
          <div className="mt-2 text-xs text-muted-foreground">
            {t("settings:data.compat_summary", {
              version: schemaStatus.schemaInfo?.version,
              hash: schemaStatus.schemaInfo?.identityHash.slice(0, 8),
            })}
          </div>
        )}
        {(!schemaStatus?.hasAndroidSchema || schemaExpanded) && (
          <div className="mt-2 space-y-2">
            {!schemaStatus?.hasAndroidSchema && (
              <div
                className="text-xs text-muted-foreground"
                dangerouslySetInnerHTML={{ __html: t("settings:data.unregistered_warn") }}
              />
            )}
            {schemaStatus?.hasAndroidSchema && (
              <div className="text-xs text-muted-foreground">
                {t("settings:data.current_format", {
                  version: schemaStatus.schemaInfo?.version,
                  hash: schemaStatus.schemaInfo?.identityHash.slice(0, 8),
                })}
              </div>
            )}
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
              <div className="text-xs font-medium">
                {schemaStatus?.hasAndroidSchema
                  ? t("settings:data.update_format")
                  : t("settings:data.how_to_register")}
              </div>
              <ol className="mt-1.5 list-inside list-decimal space-y-1 text-xs text-muted-foreground">
                <li>{t("settings:data.step1")}</li>
                <li>{t("settings:data.step2")}</li>
                <li>{t("settings:data.step3")}</li>
              </ol>
              <div className="mt-2 text-xs font-bold text-amber-700 dark:text-amber-300">
                {t("settings:data.register_note")}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => schemaInputRef.current?.click()}
                disabled={registeringSchema}
              >
                {registeringSchema ? (
                  <Loader2 className="mr-1 size-3 animate-spin" />
                ) : (
                  <Upload className="mr-1 size-3" />
                )}
                {t("settings:data.upload_phone_backup")}
              </Button>
              <input
                ref={schemaInputRef}
                className="sr-only"
                type="file"
                accept="application/zip,.zip"
                onChange={(e) => void handleRegisterSchema(e)}
              />
            </div>
          </div>
        )}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm font-medium">{t("settings:data.backup_title")}</div>
          <div className="mt-1 text-xs text-muted-foreground">{t("settings:data.backup_desc")}</div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => void handleExportClick()}
              disabled={exporting || importing}
            >
              {exporting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              {t("settings:data.export_backup")}
            </Button>
            <Button
              variant="outline"
              onClick={() => importInputRef.current?.click()}
              disabled={importing || exporting}
            >
              {importing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" />
              )}
              {t("settings:data.import_backup")}
            </Button>
            <input
              ref={importInputRef}
              className="sr-only"
              type="file"
              accept="application/json,.json,application/zip,.zip"
              onChange={(event) => void importData(event)}
            />
          </div>
          {exporting ? (
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {exportTotalBytes > 0
                    ? t("settings:data.downloading")
                    : t("settings:data.preparing_file")}
                </span>
                {exportTotalBytes > 0 ? (
                  <span>
                    {(exportedBytes / (1024 * 1024)).toFixed(1)} /{" "}
                    {(exportTotalBytes / (1024 * 1024)).toFixed(1)} MB · {exportProgress}%
                  </span>
                ) : null}
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full bg-primary transition-all",
                    exportTotalBytes === 0 && "animate-pulse w-full",
                  )}
                  style={exportTotalBytes > 0 ? { width: `${exportProgress}%` } : undefined}
                />
              </div>
              {exportTotalBytes === 0 ? (
                <div className="text-[0.6875rem] text-muted-foreground">
                  {t("settings:data.pack_slow")}
                </div>
              ) : null}
            </div>
          ) : null}
          {importing ? (
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {importPhase === "uploading" && t("settings:data.uploading")}
                  {importPhase === "processing" && t("settings:data.extracting")}
                  {importPhase === "idle" && t("settings:data.preparing")}
                </span>
                {importPhase === "uploading" ? <span>{importProgress}%</span> : null}
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full bg-primary transition-all",
                    importPhase === "processing" && "animate-pulse w-full",
                  )}
                  style={importPhase === "uploading" ? { width: `${importProgress}%` } : undefined}
                />
              </div>
              {importPhase === "processing" ? (
                <div className="text-[0.6875rem] text-muted-foreground">
                  {t("settings:data.extract_slow")}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm font-medium">{t("settings:data.chat_files_title")}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t("settings:data.chat_files_desc")}
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm font-medium">{t("settings:data.web_service_title")}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t("settings:data.web_service_desc", {
              status: settings.webServerJwtEnabled
                ? t("settings:data.enabled")
                : t("settings:data.disabled"),
            })}
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4 md:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium">
                {t("settings:data.webdav_title")}
                {!schemaStatus?.hasAndroidSchema && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[0.625rem] text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                    {t("settings:data.chat_unsyncable")}
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {t("settings:data.webdav_desc")}
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              {webDavBusy ? t("settings:data.processing") : t("settings:common.autosaved")}
            </div>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t("settings:data.server_url")}
              </span>
              <Input
                value={webDavDraft.url}
                onChange={(event) => patchWebDav({ url: event.target.value })}
                placeholder="https://example.com/dav"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t("settings:data.backup_path")}
              </span>
              <Input
                value={webDavDraft.path}
                onChange={(event) => patchWebDav({ path: event.target.value })}
                placeholder="rikkahub_backups"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t("settings:proxy.username")}
              </span>
              <Input
                value={webDavDraft.username}
                onChange={(event) => patchWebDav({ username: event.target.value })}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t("settings:proxy.password")}
              </span>
              <div className="flex gap-2">
                <Input
                  type={showWebDavPassword ? "text" : "password"}
                  value={webDavDraft.password}
                  onChange={(event) => patchWebDav({ password: event.target.value })}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setShowWebDavPassword((value) => !value)}
                >
                  {showWebDavPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
              </div>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {(["DATABASE", "FILES"] as const).map((item) => (
              <label
                key={item}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <Checkbox
                  checked={(webDavDraft.items ?? []).includes(item)}
                  onCheckedChange={(checked) => {
                    const items = new Set(webDavDraft.items ?? []);
                    if (checked) items.add(item);
                    else items.delete(item);
                    patchWebDav({ items: [...items] });
                  }}
                />
                {item === "DATABASE"
                  ? t("settings:data.item_database")
                  : t("settings:data.item_files")}
              </label>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => void testWebDav()}
              disabled={Boolean(webDavBusy) || !webDavDraft.url.trim()}
            >
              {webDavBusy === "test" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              {t("settings:data.test_conn")}
            </Button>
            <Button
              variant="outline"
              onClick={() => void refreshWebDavList()}
              disabled={Boolean(webDavBusy) || !webDavDraft.url.trim()}
            >
              {webDavBusy === "list" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              {t("settings:data.refresh_backups")}
            </Button>
            <Button
              onClick={() => void backupWebDav()}
              disabled={Boolean(webDavBusy) || !webDavDraft.url.trim()}
            >
              {webDavBusy === "backup" && !webDavBackupProgress ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" />
              )}
              {t("settings:data.backup_now")}
            </Button>
          </div>
          {(webDavBusy === "backup" || webDavBusy.startsWith("restore:")) &&
          webDavBackupProgress ? (
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{webDavBackupProgress.message}</span>
                {webDavBackupProgress.percent > 0 ? (
                  <span>{webDavBackupProgress.percent}%</span>
                ) : null}
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full bg-primary transition-all",
                    webDavBackupProgress.percent === 0 && "animate-pulse w-full",
                  )}
                  style={
                    webDavBackupProgress.percent > 0
                      ? { width: `${webDavBackupProgress.percent}%` }
                      : undefined
                  }
                />
              </div>
            </div>
          ) : null}
          <div className="mt-4 rounded-md border">
            {webDavItems.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">
                {t("settings:data.no_remote_backups")}
              </div>
            ) : null}
            {webDavItems.map((item, index) => (
              <React.Fragment key={item.displayName}>
                {index > 0 ? <Separator /> : null}
                <div className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{item.displayName}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {new Date(item.lastModified || 0).toLocaleString()} ·{" "}
                      {Math.round((item.size || 0) / 1024)} KB
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void restoreWebDav(item)}
                      disabled={Boolean(webDavBusy)}
                    >
                      {webDavBusy === `restore:${item.displayName}` ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Download className="size-4" />
                      )}
                      {t("settings:data.restore")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void deleteWebDav(item)}
                      disabled={Boolean(webDavBusy)}
                    >
                      {webDavBusy === `delete:${item.displayName}` ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4 md:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium">
                {t("settings:data.s3_title")}
                {!schemaStatus?.hasAndroidSchema && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[0.625rem] text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                    {t("settings:data.chat_unsyncable")}
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{t("settings:data.s3_desc")}</div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Path-style</span>
              <Switch
                checked={s3Draft.pathStyle}
                onCheckedChange={(pathStyle) => patchS3({ pathStyle })}
              />
            </div>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t("settings:data.endpoint_label")}
              </span>
              <Input
                value={s3Draft.endpoint}
                onChange={(event) => patchS3({ endpoint: event.target.value })}
                placeholder="https://s3.example.com"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Region</span>
              <Input
                value={s3Draft.region}
                onChange={(event) => patchS3({ region: event.target.value })}
                placeholder="auto"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Bucket</span>
              <Input
                value={s3Draft.bucket}
                onChange={(event) => patchS3({ bucket: event.target.value })}
                placeholder="my-rikkahub-bucket"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Access Key ID</span>
              <Input
                value={s3Draft.accessKeyId}
                onChange={(event) => patchS3({ accessKeyId: event.target.value })}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Secret Access Key</span>
              <div className="flex gap-2">
                <Input
                  type={showS3Secret ? "text" : "password"}
                  value={s3Draft.secretAccessKey}
                  onChange={(event) => patchS3({ secretAccessKey: event.target.value })}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setShowS3Secret((value) => !value)}
                >
                  {showS3Secret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
              </div>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => void testS3()}
              disabled={Boolean(s3Busy) || !s3Draft.bucket.trim() || !s3Draft.accessKeyId.trim()}
            >
              {s3Busy === "test" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <CheckCircle2 className="size-4" />
              )}
              {t("settings:data.test_conn")}
            </Button>
            <Button
              variant="outline"
              onClick={() => void refreshS3List()}
              disabled={Boolean(s3Busy) || !s3Draft.bucket.trim()}
            >
              {s3Busy === "list" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              {t("settings:data.refresh_backups")}
            </Button>
            <Button
              onClick={() => void backupS3()}
              disabled={Boolean(s3Busy) || !s3Draft.bucket.trim() || !s3Draft.accessKeyId.trim()}
            >
              {s3Busy === "backup" && !s3BackupProgress ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" />
              )}
              {t("settings:data.backup_now")}
            </Button>
          </div>
          {(s3Busy === "backup" || s3Busy.startsWith("restore:")) && s3BackupProgress ? (
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{s3BackupProgress.message}</span>
                {s3BackupProgress.percent > 0 ? <span>{s3BackupProgress.percent}%</span> : null}
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full bg-primary transition-all",
                    s3BackupProgress.percent === 0 && "animate-pulse w-full",
                  )}
                  style={
                    s3BackupProgress.percent > 0
                      ? { width: `${s3BackupProgress.percent}%` }
                      : undefined
                  }
                />
              </div>
            </div>
          ) : null}
          <div className="mt-3 overflow-hidden rounded-md border">
            {s3Items.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">
                {t("settings:data.no_remote_backups_s3")}
              </div>
            ) : null}
            {s3Items.map((item, index) => (
              <React.Fragment key={item.displayName}>
                {index > 0 ? <Separator /> : null}
                <div className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{item.displayName}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {new Date(item.lastModified || 0).toLocaleString()} ·{" "}
                      {Math.round((item.size || 0) / 1024)} KB
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void restoreS3(item)}
                      disabled={Boolean(s3Busy)}
                    >
                      {s3Busy === `restore:${item.displayName}` ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Download className="size-4" />
                      )}
                      {t("settings:data.restore")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void deleteS3(item)}
                      disabled={Boolean(s3Busy)}
                    >
                      {s3Busy === `delete:${item.displayName}` ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function StatsSection({ stats }: { stats: StatsPayload | null }) {
  const { t } = useTranslation();
  if (!stats) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        {t("settings:stats.loading")}
      </div>
    );
  }
  const dailyByDate = new Map(stats.daily.map((item) => [item.date, item]));
  const today = new Date();
  const start = new Date(today);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay() - 52 * 7);
  const activeCounts = stats.daily
    .map((item) => item.messages)
    .filter((count) => count > 0)
    .sort((a, b) => a - b);
  const quantile = (ratio: number, fallback: number) =>
    activeCounts[Math.floor(activeCounts.length * ratio)] ?? fallback;
  const q1 = quantile(0.25, 1);
  const q2 = quantile(0.5, 2);
  const q3 = quantile(0.75, 3);
  const formatKey = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const heatmapWeeks = Array.from({ length: 53 }, (_, weekIndex) =>
    Array.from({ length: 7 }, (_, dayIndex) => {
      const date = new Date(start);
      date.setDate(start.getDate() + weekIndex * 7 + dayIndex);
      const key = formatKey(date);
      const item = dailyByDate.get(key);
      const isFuture = date > today;
      const count = isFuture ? 0 : (item?.messages ?? 0);
      const level = isFuture
        ? -1
        : count === 0
          ? 0
          : count <= q1
            ? 1
            : count <= q2
              ? 2
              : count <= q3
                ? 3
                : 4;
      return { key, date, count, level };
    }),
  );
  const monthLabels = heatmapWeeks.map((week) => {
    const firstOfMonth = week.find((day) => day.date.getDate() === 1);
    if (!firstOfMonth) return "";
    return firstOfMonth.date.getMonth() === 0
      ? String(firstOfMonth.date.getFullYear())
      : firstOfMonth.date.toLocaleString(undefined, { month: "short" });
  });
  const heatmapClass = (level: number) => {
    if (level < 0) return "bg-muted/40";
    if (level === 0) return "bg-muted";
    return ["bg-primary/25", "bg-primary/45", "bg-primary/70", "bg-primary"][level - 1];
  };
  return (
    <>
      <SectionHeader
        icon={Database}
        title={t("settings:stats.title")}
        subtitle={t("settings:stats.subtitle")}
      />
      <div className="grid gap-4 md:grid-cols-5">
        {[
          [t("settings:stats.t_conversations"), stats.totals.conversations],
          [t("settings:stats.t_messages"), stats.totals.messages],
          [t("settings:stats.t_input_tokens"), stats.totals.inputTokens],
          [t("settings:stats.t_output_tokens"), stats.totals.outputTokens],
          [t("settings:stats.t_launches"), stats.totals.launchCount],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-lg border bg-card p-4">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-2 text-2xl font-semibold">{value}</div>
          </div>
        ))}
      </div>
      <div className="mt-6 rounded-lg border bg-card p-4">
        <div className="mb-3 text-sm font-medium">{t("settings:stats.heatmap")}</div>
        <div className="pb-1">
          <div className="grid w-full grid-cols-[24px_minmax(0,1fr)] gap-x-2 overflow-hidden">
            <div />
            <div
              className="grid justify-between gap-[2px]"
              style={{ gridTemplateColumns: "repeat(53, minmax(10px, 14px))" }}
            >
              {monthLabels.map((label, index) => (
                <div
                  key={`${label}-${index}`}
                  className="h-5 overflow-visible whitespace-nowrap text-[0.6875rem] text-muted-foreground"
                >
                  {label}
                </div>
              ))}
            </div>
            <div
              className="grid gap-[2px] pt-[2px]"
              style={{ gridTemplateRows: "repeat(7, 12px)" }}
            >
              {[
                "",
                t("settings:stats.day_mon"),
                "",
                t("settings:stats.day_wed"),
                "",
                t("settings:stats.day_fri"),
                "",
              ].map((label, index) => (
                <div
                  key={`${label}-${index}`}
                  className="flex h-3 items-center justify-end text-[0.6875rem] text-muted-foreground"
                >
                  {label}
                </div>
              ))}
            </div>
            <div
              className="grid justify-between gap-[2px] pt-[2px]"
              style={{ gridTemplateColumns: "repeat(53, minmax(10px, 14px))" }}
            >
              {heatmapWeeks.map((week, weekIndex) => (
                <div
                  key={weekIndex}
                  className="grid gap-[2px]"
                  style={{ gridTemplateRows: "repeat(7, 12px)" }}
                >
                  {week.map((day) => (
                    <div
                      key={day.key}
                      title={t("settings:stats.day_count", { date: day.key, count: day.count })}
                      className={`size-3 rounded-[3px] sm:size-3.5 ${heatmapClass(day.level)}`}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-end gap-1 text-[0.6875rem] text-muted-foreground">
          <span>{t("settings:stats.less")}</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span key={level} className={`size-[12px] rounded-[4px] ${heatmapClass(level)}`} />
          ))}
          <span>{t("settings:stats.more")}</span>
        </div>
        {stats.daily.length === 0 ? (
          <div className="mt-3 text-xs text-muted-foreground">
            {t("settings:stats.heatmap_empty")}
          </div>
        ) : null}
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border bg-card p-4">
          <div className="mb-3 text-sm font-medium">{t("settings:stats.model_usage")}</div>
          <div className="space-y-2">
            {stats.models.slice(0, 8).map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate">
                  {[item.providerName, item.name || item.id].filter(Boolean).join(" / ")}
                </span>
                <span className="text-muted-foreground">{item.count}</span>
              </div>
            ))}
            {stats.models.length === 0 ? (
              <div className="text-sm text-muted-foreground">{t("settings:stats.no_models")}</div>
            ) : null}
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="mb-3 text-sm font-medium">{t("settings:stats.request_groups")}</div>
          <div className="mb-4 space-y-2">
            {(stats.requestGroups ?? []).map((item) => (
              <div key={item.name} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate">{item.name}</span>
                <span className="text-muted-foreground">
                  {t("settings:stats.ok_failed", { ok: item.ok, failed: item.failed })}
                </span>
              </div>
            ))}
            {(stats.requestGroups ?? []).length === 0 ? (
              <div className="text-sm text-muted-foreground">{t("settings:stats.no_groups")}</div>
            ) : null}
          </div>
          <div className="mb-3 text-sm font-medium">{t("settings:stats.provider_requests")}</div>
          <div className="space-y-2">
            {stats.providers.slice(0, 8).map((item) => (
              <div key={item.name} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate">{item.name}</span>
                <span className="text-muted-foreground">
                  {item.ok} / {item.failed}
                </span>
              </div>
            ))}
            {stats.providers.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                {t("settings:stats.no_provider_requests")}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

type ProxyMode = "auto" | "manual" | "direct" | "env";

interface ProxyConfig {
  mode: ProxyMode;
  url: string;
  username: string;
  password: string;
  // 代理绕过规则 (逗号分隔域名/通配符): 命中的 URL 直连不走代理。
  // localhost/127.0.0.1/::1 永远 bypass (后端硬编码)。仅 auto/manual 生效。
  bypassRules: string;
}

interface ProxyStatus {
  activeUrl: string | null;
  source: "manual" | "system" | "env" | "none";
  detectedSystemProxy: string | null;
  // 当前 mode 与容器标记(后端 proxyStatusPayload 返回)。containerMode=true 时 UI 锁定 mode=env 只读。
  mode: ProxyMode;
  containerMode: boolean;
  // 实际运行端口(顺延后可能与 preferredPort 不同), 端口 Card 显示
  runningPort: number | null;
}

function isValidProxyUrl(url: string): boolean {
  // 允许 "host:port" / "http://host:port" / "https://..."。先补 scheme 再用 WHATWG URL 校验,
  // 与后端 composeProxyUrl 的容错保持一致(用户可不填 scheme)。
  const withScheme = /^https?:\/\//i.test(url) ? url : `http://${url}`;
  try {
    const u = new URL(withScheme);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}

// 导航项"代理"右侧的状态点(P2-7): 让用户不进设置页就知道代理运行态。
// 绿=走代理 / 灰=直连(无代理)。独立轮询, 不依赖 ProxySection。
function ProxyNavDot() {
  const { t } = useTranslation();
  const [st, setSt] = React.useState<{ activeUrl: string | null } | null>(null);
  React.useEffect(() => {
    const refresh = async () => {
      try {
        const s = await api.get<{ activeUrl: string | null }>("settings/proxy/status");
        setSt({ activeUrl: s.activeUrl });
      } catch {
        // 后端未起或请求失败时静默, 不显示点
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 3_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!st) return null;
  const cls = st.activeUrl ? "bg-green-500" : "bg-muted-foreground/30";
  const tip = st.activeUrl
    ? t("settings:proxy.nav_status_proxy", { url: st.activeUrl })
    : t("settings:proxy.nav_status_direct");
  return <span className={`ml-auto size-2 shrink-0 rounded-full ${cls}`} title={tip} />;
}

// 测试 URL 是纯 UI 偏好 (不属于代理配置), 存 localStorage 即可 — 不进 settings/备份,
// 避免 APP↔PC 备份兼容性波纹。ProxySection 是条件渲染 (切页即 unmount), 必须持久化,
// 否则用户填的测试 URL 切走再回来就丢了。
const PROXY_TEST_URL_KEY = "rikkahub:proxy-test-url";
const DEFAULT_PROXY_TEST_URL = "https://www.gstatic.com/generate_204";

function ProxySection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const initial = (settings.proxyConfig ?? { mode: "auto" as ProxyMode, url: "", username: "", password: "", bypassRules: "" }) as ProxyConfig;
  const [draft, setDraft] = React.useState<ProxyConfig>(initial);
  const [showPassword, setShowPassword] = React.useState(false);
  const [detecting, setDetecting] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testUrl, setTestUrl] = React.useState<string>(() => {
    try {
      return window.localStorage.getItem(PROXY_TEST_URL_KEY) || DEFAULT_PROXY_TEST_URL;
    } catch {
      return DEFAULT_PROXY_TEST_URL;
    }
  });
  const updateTestUrl = React.useCallback((v: string) => {
    setTestUrl(v);
    try { window.localStorage.setItem(PROXY_TEST_URL_KEY, v); } catch { /* 隐私模式/SSR */ }
  }, []);
  const [testResult, setTestResult] = React.useState<{ ok: boolean; status?: number; latencyMs?: number; error?: string } | null>(null);
  const [status, setStatus] = React.useState<ProxyStatus | null>(null);
  const dirtyRef = React.useRef(false);

  React.useEffect(() => {
    // Only adopt the settings-prop value when the user isn't mid-edit. Without this guard,
    // a save round-trip races with continued typing: the SSE push of the (older) saved
    // value arrives a few ms after the user has typed another character, and naively
    // resetting `draft` from `initial` would wipe those new keystrokes.
    if (dirtyRef.current) return;
    setDraft(initial);
  }, [initial.mode, initial.url, initial.username, initial.password, initial.bypassRules]);

  // Fetch the active-proxy footer state on mount + after every save so it reflects what the
  // backend is actually using right now (manual override vs auto-detected from system).
  const refreshStatus = React.useCallback(async () => {
    try {
      const next = await api.get<ProxyStatus>("settings/proxy/status");
      setStatus(next);
    } catch (err) {
      console.warn("[proxy] failed to load status", err);
    }
  }, []);
  React.useEffect(() => {
    void refreshStatus();
    // 后端 readSystemProxy 已加 2s TTL 缓存, 这里 3s 轮询命中缓存的成本几乎为零,
    // 用户开关 Clash 后小绿点最多 ~5s (TTL 过期 + 下一轮) 更新。
    const timer = window.setInterval(() => void refreshStatus(), 3_000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  const patch = (next: Partial<ProxyConfig>) => {
    dirtyRef.current = true;
    setDraft((prev) => ({ ...prev, ...next }));
  };

  const save = React.useCallback(
    async (announce = false) => {
      if (!announce && !dirtyRef.current) return;
      // P0-2: Bun fetch 静默丢弃 SOCKS 代理(表现成直连失败), 在保存前拦截 ——
      // 否则用户保存后看到"已保存"却所有请求失败, 极难排查。仅 manual 模式需校验
      // (其它模式 url 字段被后端忽略)。
      if (draft.mode === "manual") {
        const trimmedUrl = draft.url.trim();
        if (/^socks/i.test(trimmedUrl)) {
          toast.error(t("settings:proxy.socks_not_supported"));
          return;
        }
        if (trimmedUrl && !isValidProxyUrl(trimmedUrl)) {
          toast.error(t("settings:proxy.url_invalid"));
          return;
        }
      }
      try {
        const result = await api.post<{ config: ProxyConfig } & ProxyStatus>(
          "settings/proxy",
          draft,
        );
        dirtyRef.current = false;
        onSettings({ ...settings, proxyConfig: result.config } as Settings);
        setStatus({
          activeUrl: result.activeUrl,
          source: result.source,
          detectedSystemProxy: result.detectedSystemProxy,
          mode: result.mode,
          containerMode: result.containerMode,
          runningPort: result.runningPort,
        });
        if (announce) toast.success(t("settings:proxy.saved"));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("settings:proxy.save_failed"));
      }
    },
    [draft, onSettings, settings],
  );

  React.useEffect(() => {
    if (!dirtyRef.current) return;
    const timer = window.setTimeout(() => void save(false), 600);
    return () => window.clearTimeout(timer);
  }, [draft, save]);

  const detectSystemProxy = async () => {
    setDetecting(true);
    try {
      const result = await api.post<{ detected: string | null }>("settings/proxy/detect", {});
      if (result.detected) {
        patch({ url: result.detected });
        toast.success(t("settings:proxy.detected_filled", { url: result.detected }));
      } else {
        toast.message(t("settings:proxy.none_detected"), {
          description: t("settings:proxy.none_detected_desc"),
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings:proxy.detect_failed"));
    } finally {
      setDetecting(false);
    }
  };

  const testProxy = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.post<{ ok: boolean; status?: number; latencyMs?: number; error?: string }>(
        "settings/proxy/test",
        { url: testUrl.trim() },
      );
      setTestResult(result);
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  // ── 服务端口 ──────────────────────────────────────────────────────────
  // 端口是启动期配置：写入后要重启应用才生效。这里沿用代理的 600ms 防抖自动保存，
  // 但走独立的 settings/port 端点（它需要做范围校验并返回 requiresRestart 提示）。
  const initialPort = settings.preferredPort ?? null;
  const [portDraft, setPortDraft] = React.useState<string>(
    initialPort == null ? "" : String(initialPort),
  );
  const portDirtyRef = React.useRef(false);

  React.useEffect(() => {
    // 同代理 draft 的保护：用户正在输入时不让 SSE 回推覆盖，避免吞掉刚敲的字符。
    if (portDirtyRef.current) return;
    setPortDraft(initialPort == null ? "" : String(initialPort));
  }, [initialPort]);

  const savePort = React.useCallback(
    async (announce = false) => {
      const trimmed = portDraft.trim();
      const parsed = trimmed === "" ? null : Number(trimmed);
      if (
        parsed !== null &&
        (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
      ) {
        toast.error(t("settings:proxy.port_invalid"));
        return;
      }
      if (!announce && !portDirtyRef.current) return;
      try {
        await api.post<{ preferredPort: number | null }>("settings/port", { port: parsed });
        portDirtyRef.current = false;
        onSettings({ ...settings, preferredPort: parsed } as Settings);
        if (announce) toast.success(t("settings:proxy.port_saved"));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("settings:proxy.port_save_failed"));
      }
    },
    [portDraft, onSettings, settings],
  );

  React.useEffect(() => {
    if (!portDirtyRef.current) return;
    const timer = window.setTimeout(() => void savePort(false), 600);
    return () => window.clearTimeout(timer);
  }, [portDraft, savePort]);

  const activeDisplay = status?.activeUrl
    ? status.source === "system"
      ? t("settings:proxy.active_from_system", { url: status.activeUrl })
      : status.source === "env"
        ? t("settings:proxy.active_from_env", { url: status.activeUrl })
        : status.activeUrl
    : t("settings:proxy.not_active");

  return (
    <>
      <SectionHeader
        icon={Globe}
        title={t("settings:proxy.title")}
        subtitle={t("settings:proxy.subtitle")}
      />
      <div className="space-y-4">
        <div className="space-y-4 rounded-lg border bg-card p-6">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-base font-medium">{t("settings:proxy.http_title")}</div>
              <ProxyNavDot />
            </div>
            <div className="text-xs text-muted-foreground">{t("settings:proxy.mode_desc")}</div>
            <Select
              value={draft.mode}
              onValueChange={(v) => patch({ mode: v as ProxyMode })}
              disabled={status?.containerMode === true}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" sideOffset={4}>
                <SelectItem value="auto">{t("settings:proxy.mode_auto")}</SelectItem>
                <SelectItem value="manual">{t("settings:proxy.mode_manual")}</SelectItem>
                <SelectItem value="direct">{t("settings:proxy.mode_direct")}</SelectItem>
                <SelectItem value="env">{t("settings:proxy.mode_env")}</SelectItem>
              </SelectContent>
            </Select>
            <div className="text-xs text-muted-foreground">
              {draft.mode === "auto" && t("settings:proxy.mode_auto_desc")}
              {draft.mode === "manual" && t("settings:proxy.mode_manual_desc")}
              {draft.mode === "direct" && t("settings:proxy.mode_direct_desc")}
              {draft.mode === "env" && t("settings:proxy.mode_env_desc")}
            </div>
          </div>

          {status?.containerMode && (
            <div className="rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
              {t("settings:proxy.container_mode_desc")}
            </div>
          )}

          {draft.mode === "manual" && (
            <div className="space-y-3">
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">{t("settings:proxy.address")}</span>
                <div className="flex gap-2">
                  <Input
                    className="flex-1"
                    value={draft.url}
                    onChange={(event) => patch({ url: event.target.value })}
                    placeholder={t("settings:proxy.address_ph")}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => void detectSystemProxy()}
                    disabled={detecting}
                  >
                    {detecting ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RefreshCw className="size-4" />
                    )}
                    {t("settings:proxy.detect")}
                  </Button>
                </div>
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium">
                    {t("settings:proxy.username")}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      {t("settings:proxy.optional")}
                    </span>
                  </span>
                  <Input
                    value={draft.username}
                    onChange={(event) => patch({ username: event.target.value })}
                    placeholder="proxy username"
                    autoComplete="off"
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium">
                    {t("settings:proxy.password")}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      {t("settings:proxy.optional")}
                    </span>
                  </span>
                  <div className="relative">
                    <Input
                      type={showPassword ? "text" : "password"}
                      value={draft.password}
                      onChange={(event) => patch({ password: event.target.value })}
                      placeholder="proxy password"
                      autoComplete="off"
                      className="pr-9"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((value) => !value)}
                      tabIndex={-1}
                      className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted"
                    >
                      {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                </label>
              </div>
            </div>
          )}

          {(draft.mode === "auto" || draft.mode === "manual") && (
            <div className="space-y-1.5">
              <div className="text-sm font-medium">{t("settings:proxy.bypass_rules")}</div>
              <Input
                value={draft.bypassRules}
                onChange={(e) => patch({ bypassRules: e.target.value })}
                placeholder={t("settings:proxy.bypass_rules_placeholder")}
              />
              <p className="text-xs text-muted-foreground">{t("settings:proxy.bypass_rules_desc")}</p>
            </div>
          )}

          <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {t("settings:proxy.current")}:
            <span className="font-mono text-foreground">{activeDisplay}</span>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Input
                value={testUrl}
                onChange={(e) => updateTestUrl(e.target.value)}
                placeholder={DEFAULT_PROXY_TEST_URL}
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => void testProxy()}
                disabled={testing || !status?.activeUrl}
              >
                {testing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Zap className="size-4" />
                )}
                {t("settings:proxy.test")}
              </Button>
            </div>
            {testResult && (
              <div
                className={`text-xs ${
                  testResult.ok
                    ? "text-green-600 dark:text-green-400"
                    : "text-red-600 dark:text-red-400"
                }`}
              >
                {testResult.ok
                  ? t("settings:proxy.test_ok", { latency: testResult.latencyMs ?? 0 })
                  : `${t("settings:proxy.test_fail")}${testResult.error ? `: ${testResult.error}` : ""}`}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4 rounded-lg border bg-card p-6">
          <div>
            <div className="text-base font-medium">{t("settings:proxy.port_title")}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t("settings:proxy.port_desc")}
            </div>
          </div>
          <label className="block space-y-2">
            <span className="text-sm font-medium">
              {t("settings:proxy.port_number")}{" "}
              <span className="text-xs font-normal text-muted-foreground">
                {t("settings:proxy.port_number_hint")}
              </span>
            </span>
            <Input
              type="number"
              inputMode="numeric"
              value={portDraft}
              onChange={(event) => {
                portDirtyRef.current = true;
                setPortDraft(event.target.value);
              }}
              placeholder="8080"
              min={1}
              max={65535}
              step={1}
            />
          </label>
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {t("settings:proxy.port_restart_note")}
          </div>
          {status?.runningPort != null && (
            <div className="text-xs text-muted-foreground">
              {t("settings:proxy.port_running", { port: status.runningPort })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// 爱发电品牌图标。path 数据取自 Rikkahub-Android 的 VectorDrawable,保持品牌识别度。
function AfdianIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M9,14.234a0.567,0.567 0,1 0,0 1.134,0.567 0.567 0 0,0 0,-1.134m5.351,1.705a0.567,0.567 0,1 0,0 1.135,0.567 0.567,0 0,0 0,-1.135m8.401,1.436c-0.189,0.095 -0.461,0.1 -0.713,0.013 -0.169,-0.06 -0.352,-0.116 -0.534,-0.172 -0.339,-0.104 -0.904,-0.276 -1.011,-0.407a0.533,0.533 0,1 0,-0.853 0.643c0.059,0.08 0.139,0.146 0.22,0.209 -0.816,1.131 -4.398,3.382 -9.464,2.273 -2.283,-0.5 -3.819,-1.413 -4.444,-2.639 -0.451,-0.885 -0.348,-1.797 -0.133,-2.293 0.62,-1.29 5.097,-4.261 7.955,-5.943a0.537,0.537 0,0 0,0.188 -0.733c-0.149,-0.254 -0.49,-0.356 -0.73,-0.189 -0.231,0.135 -1.015,0.601 -2.015,1.236 -0.338,-0.227 -0.923,-0.508 -1.86,-0.6 -1.486,-0.148 -4.92,-0.805 -6.029,-1.275C2.535,7.162 0.731,6.27 1.131,5.267c0.092,-0.234 0.527,-0.613 1.47,-0.974a8.5,8.5 0,0 1,1.995 -0.492l-0.212,0.103c-0.642,0.312 -1.343,0.662 -1.813,1.075 -0.034,-0.022 -0.07,-0.044 -0.094,-0.069a0.527,0.527 0,0 0,-0.754 -0.017,0.533 0.533 0,0,0 -0.017,0.756c0.19,0.2 0.471,0.35 0.829,0.465l0.039,0.014c1.245,0.383 3.458,0.336 6.578,0.211 1.345,-0.052 2.615,-0.102 3.674,-0.082 3.512,0.07 6.152,1.469 8.07,4.279 1.178,1.725 0.753,3.426 0.079,4.903a1.4,1.4 0,0 1,-0.231 -0.222,0.54 0.54,0 0,0 -0.75,-0.085 0.535,0.535 0,0 0,-0.086 0.751c0.109,0.137 0.665,0.778 1.355,0.724l0.037,-0.002c0.021,-0.003 0.042,0.001 0.064,-0.003 0.472,-0.086 0.768,-0.063 1.045,0.111 0.367,0.232 0.547,0.37 0.511,0.485 -0.021,0.073 -0.076,0.125 -0.168,0.177M8.19,11.418l-0.315,0.231a1.6,1.6 0,0 1,-0.243 -0.32c0.123,-0.038 0.33,0.007 0.558,0.089m14.733,4.356a1.9,1.9 0,0 0,-0.81 -0.27c0.632,-1.544 1.034,-3.565 -0.336,-5.572 -2.096,-3.072 -5.101,-4.668 -8.93,-4.744 -1.091,-0.022 -2.377,0.029 -3.737,0.083 -1.58,0.063 -3.683,0.145 -5.112,0.027 0.285,-0.155 0.588,-0.304 0.851,-0.431 1.006,-0.49 1.797,-0.872 1.535,-1.548 -0.137,-0.396 -0.547,-0.603 -1.219,-0.618C3.748,2.669 0.688,3.489 0.138,4.872c-0.31,0.779 -0.361,2.282 2.775,3.61 1.29,0.548 4.934,1.216 6.341,1.355 0.397,0.039 0.701,0.119 0.931,0.205a75,75 0,0 0,-0.986 0.664c-0.577,-0.329 -1.521,-0.718 -2.226,-0.237a0.94,0.94 0,0 0,-0.435 0.768c-0.01,0.385 0.224,0.763 0.486,1.066 -1.038,0.83 -1.877,1.634 -2.175,2.253 -0.332,0.762 -0.467,2.008 0.153,3.224 0.786,1.544 2.524,2.62 5.166,3.199 3.454,0.755 6.437,0.075 8.411,-0.966 1.099,-0.579 1.878,-1.27 2.257,-1.887l0.356,0.113c0.169,0.051 0.338,0.103 0.496,0.159 0.522,0.181 1.1,0.157 1.545,-0.068l0.025,-0.013c0.336,-0.177 0.577,-0.46 0.683,-0.803 0.285,-0.922 -0.528,-1.432 -1.018,-1.74" />
    </svg>
  );
}

// 赞助者数据结构(预留)。赞助用户列表上线后由 /api/sponsors 返回此结构;
// 接入方案见后端该接口注释。
interface Sponsor {
  userName: string;
  avatar: string;
  amount?: string;
}

function DonateSection() {
  const { t } = useTranslation();
  return (
    <>
      <SectionHeader icon={Heart} title={t("settings:donate.title")} subtitle={t("settings:donate.subtitle")} />
      <div className="space-y-6">
        <div className="rounded-lg border bg-card">
          <button
            type="button"
            className="flex w-full items-center gap-3 p-4 text-left transition hover:bg-accent/50"
            onClick={() => void openExternal("https://afdian.com/a/mirsky")}
          >
            <AfdianIcon className="size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{t("settings:donate.afdian")}</div>
              <div className="text-sm text-muted-foreground">{t("settings:donate.afdian_desc")}</div>
            </div>
            <ExternalLink className="size-4 shrink-0 text-muted-foreground" />
          </button>
          <Separator />
          <div className="flex items-center gap-3 p-4">
            <Globe className="size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{t("settings:donate.international")}</div>
              <div className="text-sm text-muted-foreground">{t("settings:donate.international_desc")}</div>
            </div>
            <span className="shrink-0 rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground">
              {t("settings:donate.coming_soon")}
            </span>
          </div>
        </div>

        {/* 赞助用户列表暂未上线;数据源就绪后在此恢复,结构见 Sponsor 类型与后端 /api/sponsors 注释。 */}
      </div>
    </>
  );
}

function AboutSection() {
  const { t } = useTranslation();
  // Hard-coded current version — must match pc-server/server.ts:APP_VERSION and
  // web-ui/src-tauri/tauri.conf.json:version. The update checker compares this against
  // the latest GitHub release.
  const APP_VERSION = "1.4.1";

  const [checking, setChecking] = React.useState(false);
  const [updateInfo, setUpdateInfo] = React.useState<UpdateInfo | null>(null);
  // 真实系统版本(走 Tauri OS 插件),异步加载。
  const [systemSummary, setSystemSummary] = React.useState("");

  React.useEffect(() => {
    void getSystemInfo().then((info) => setSystemSummary(info.summary));
  }, []);

  const checkForUpdate = async () => {
    setChecking(true);
    try {
      const info = await api.get<UpdateInfo>("update/check");
      setUpdateInfo(info);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings:about.check_failed"));
    } finally {
      setChecking(false);
    }
  };

  const aboutRows = [
    {
      key: "version",
      label: t("settings:about.version"),
      value: APP_VERSION,
      icon: Settings2,
      onClick: undefined,
      action: "update" as const,
    },
    {
      key: "system",
      label: t("settings:about.system"),
      value: systemSummary || "—",
      icon: Smartphone,
      onClick: undefined,
      action: undefined,
    },
    {
      key: "website",
      label: t("settings:about.website"),
      value: "https://rikkahub-desktop.pages.dev",
      icon: Globe,
      onClick: () => void openExternal("https://rikkahub-desktop.pages.dev/"),
      action: undefined,
    },
    {
      key: "github",
      label: "GitHub",
      value: "https://github.com/yuh-G/rikkahub-desktop",
      icon: Github,
      onClick: () => void openExternal("https://github.com/yuh-G/rikkahub-desktop/"),
      action: undefined,
    },
    {
      key: "license",
      label: "License",
      value: "https://github.com/yuh-G/rikkahub-desktop/blob/master/LICENSE",
      icon: FileClock,
      onClick: () =>
        void openExternal("https://github.com/yuh-G/rikkahub-desktop/blob/master/LICENSE"),
      action: undefined,
    },
  ];
  return (
    <>
      <SectionHeader
        icon={CheckCircle2}
        title={t("settings:about.title")}
        subtitle={t("settings:about.subtitle")}
      />
      <div className="space-y-6">
        <div className="flex flex-col items-center gap-3 rounded-lg border bg-card p-8 text-center">
          <img src="/app-icon.png" alt="RikkaHub" className="size-28 rounded-full shadow-sm" />
          <div className="text-3xl font-semibold tracking-normal">RikkaHub</div>
        </div>
        <div className="rounded-lg border bg-card">
          {aboutRows.map((row, index) => {
            const Icon = row.icon;
            const content = (
              <>
                <div className="flex min-w-0 items-center gap-3">
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="font-medium">{row.label}</div>
                </div>
                <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                  <span className="truncate">{row.value}</span>
                  {row.action === "update" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="ml-2 shrink-0"
                      onClick={(event) => {
                        event.stopPropagation();
                        void checkForUpdate();
                      }}
                      disabled={checking}
                    >
                      {checking ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="size-3.5" />
                      )}
                      {t("settings:about.check_update")}
                    </Button>
                  ) : row.onClick ? (
                    <ExternalLink className="size-3.5 shrink-0" />
                  ) : null}
                </div>
              </>
            );
            return (
              <React.Fragment key={row.key}>
                {index > 0 ? <Separator /> : null}
                {row.onClick ? (
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-4 p-4 text-left transition hover:bg-accent/50"
                    onClick={row.onClick}
                  >
                    {content}
                  </button>
                ) : (
                  <div className="flex items-center justify-between gap-4 p-4">{content}</div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>
      {updateInfo && (
        <UpdateDialog info={updateInfo} open={true} onClose={() => setUpdateInfo(null)} />
      )}
    </>
  );
}

function LogsSection({ logs, onClear }: { logs: RequestLog[]; onClear: () => void }) {
  const { t } = useTranslation();
  const [active, setActive] = React.useState<RequestLog | null>(null);
  return (
    <>
      <SectionHeader icon={FileClock} title={t("settings:logs.title")} subtitle={t("settings:logs.subtitle")} />
      {logs.length > 0 ? (
        <div className="-mt-4 mb-2 flex justify-end">
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs text-destructive transition hover:bg-destructive/10"
          >
            <Trash2 className="size-3.5" />
            {t("settings:logs.clear")}
          </button>
        </div>
      ) : null}
      <div className="space-y-2">
        {logs.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            {t("settings:logs.empty")}
          </div>
        ) : null}
        {logs.map((log) => (
          <button
            key={log.id}
            type="button"
            onClick={() => setActive(log)}
            className="block w-full rounded-lg border bg-card p-3 text-left transition hover:shadow-sm"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-primary">{log.method ?? "POST"}</span>
              <span className={cn("text-xs font-medium", log.ok ? "text-emerald-600" : "text-destructive")}>
                {log.status}
              </span>
            </div>
            <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{log.url}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span>{new Date(log.at).toLocaleString()}</span>
              <span>{log.durationMs ?? 0}ms</span>
              <span className="truncate">
                {log.providerName}
                {log.kind ? ` · ${log.kind}` : ""}
              </span>
            </div>
            {log.error ? <div className="mt-1 truncate text-xs text-destructive">{log.error}</div> : null}
          </button>
        ))}
      </div>
      <LogDetailDialog log={active} onClose={() => setActive(null)} />
    </>
  );
}

function LogDetailDialog({ log, onClose }: { log: RequestLog | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [reveal, setReveal] = React.useState(false);
  const requestText = log?.requestBody || "";
  const responseText = log?.responseBody || log?.error || "";
  const requestJson = React.useMemo(() => tryParseJson(requestText), [requestText]);
  const responseJson = React.useMemo(() => tryParseJson(responseText), [responseText]);
  const copy = React.useCallback(
    async (text: string) => {
      if (!text) return;
      await navigator.clipboard.writeText(text);
      toast.success(t("settings:logs.copied", { title: "" }));
    },
    [t],
  );
  return (
    <Dialog
      open={log !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate font-mono text-sm">{log?.url ?? ""}</DialogTitle>
        </DialogHeader>
        {log ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
              <DetailField label={t("settings:logs.field_time")} value={new Date(log.at).toLocaleString()} />
              <DetailField label={t("settings:logs.field_method")} value={log.method ?? "-"} />
              <DetailField label={t("settings:logs.field_status")} value={String(log.status)} valueClass={log.ok ? "text-emerald-600" : "text-destructive"} />
              <DetailField label={t("settings:logs.field_duration")} value={`${log.durationMs ?? 0}ms`} />
              <DetailField label={t("settings:logs.field_provider")} value={log.providerName} />
              <DetailField label={t("settings:logs.field_kind")} value={log.kind ?? "-"} />
            </div>
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => setReveal((v) => !v)}>
                {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                {reveal ? t("settings:logs.hide_sensitive") : t("settings:logs.show_sensitive")}
              </Button>
            </div>
            {log.error ? (
              <pre className="overflow-auto rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-xs whitespace-pre-wrap text-destructive">
                {log.error}
              </pre>
            ) : null}
            <HeaderList title={t("settings:logs.request_headers")} headers={log.requestHeaders} reveal={reveal} />
            <BodySection title={t("settings:logs.request_body")} text={requestText} json={requestJson} onCopy={copy} emptyText={t("settings:logs.no_request_body")} />
            <HeaderList title={t("settings:logs.response_headers")} headers={log.responseHeaders} reveal={reveal} />
            <BodySection title={t("settings:logs.response_body")} text={responseText} json={responseJson} onCopy={copy} emptyText={t("settings:logs.no_response_body")} />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DetailField({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground">{label}</div>
      <div className={cn("truncate font-medium", valueClass)} title={value}>
        {value}
      </div>
    </div>
  );
}

// 敏感请求头默认打码,避免在日志详情里直接暴露 API Key / Token。
const SENSITIVE_HEADER_PATTERN = /(authorization|api[-_]?key|secret|token|password|cookie)/i;

function isSensitiveHeader(key: string): boolean {
  return SENSITIVE_HEADER_PATTERN.test(key);
}

function maskHeaderValue(value: string): string {
  if (!value) return value;
  const scheme = value.match(/^(Bearer|Basic|Token|ApiKey)\s+(.+)$/i);
  if (scheme) return `${scheme[1]} ${"•".repeat(Math.min(scheme[2].length, 16))}`;
  if (value.length <= 8) return "••••••";
  return `${value.slice(0, 4)}••••••`;
}

function HeaderList({ title, headers, reveal }: { title: string; headers?: Record<string, string>; reveal?: boolean }) {
  if (!headers || Object.keys(headers).length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">{title}</div>
      <div className="divide-y rounded-lg border bg-muted/30">
        {Object.entries(headers).map(([key, value]) => {
          const sensitive = isSensitiveHeader(key);
          const display = sensitive && !reveal ? maskHeaderValue(value) : value;
          return (
            <div key={key} className="flex gap-2 px-2 py-1 text-xs">
              <span className="shrink-0 font-mono text-primary">{key}:</span>
              <span className={cn("min-w-0 break-all font-mono", sensitive && !reveal && "text-muted-foreground")}>{display}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BodySection({
  title,
  text,
  json,
  onCopy,
  emptyText,
}: {
  title: string;
  text: string;
  json: unknown;
  onCopy: (text: string) => void;
  emptyText: string;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
        <span>{title}</span>
        {text ? (
          <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted" onClick={() => void onCopy(text)}>
            {t("settings:logs.copy")}
          </button>
        ) : null}
      </div>
      {!text ? (
        <div className="text-xs text-muted-foreground">{emptyText}</div>
      ) : json !== undefined ? (
        <JsonTree data={json} className="rounded-lg border bg-muted/30 p-2" zoomTitle={title} />
      ) : (
        <pre className="max-h-[400px] overflow-auto rounded-lg border bg-muted/30 p-2 text-xs whitespace-pre-wrap">
          {text}
        </pre>
      )}
    </div>
  );
}
