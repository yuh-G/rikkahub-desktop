import * as React from "react";

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
  WandSparkles,
} from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";

import { AvatarCropper } from "~/components/avatar-cropper";
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
import { Textarea } from "~/components/ui/textarea";
import { UIAvatar } from "~/components/ui/ui-avatar";
import { cn } from "~/lib/utils";
import { openExternal } from "~/lib/external-link";
import api, { appendWebAuthQuery } from "~/services/api";
import { useSettingsStore } from "~/stores/app-store";
import type { AsrProviderProfile, AsrProviderType, AssistantAvatar, AssistantProfile, ProviderModel, ProviderProfile, SearchServiceOption, Settings, TtsProviderProfile, TtsProviderType } from "~/types";

type Section = "general" | "providers" | "models" | "assistants" | "search" | "mcp" | "speech" | "data" | "stats" | "logs" | "proxy" | "about" | "plan";
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
  requestPreview?: string;
  responsePreview?: string;
  requestBody?: string;
  responseBody?: string;
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
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
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

const navItems: Array<{ id: Section; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "general", label: "通用设置", icon: UserRound },
  { id: "assistants", label: "助手", icon: Bot },
  { id: "providers", label: "供应商", icon: KeyRound },
  { id: "models", label: "默认模型与提示词", icon: Settings2 },
  { id: "search", label: "搜索服务", icon: Search },
  { id: "mcp", label: "MCP 与拓展", icon: CopyPlus },
  { id: "speech", label: "语音", icon: Mic },
  { id: "data", label: "数据设置", icon: Database },
  { id: "stats", label: "统计", icon: Database },
  { id: "logs", label: "请求日志", icon: FileClock },
  { id: "proxy", label: "代理", icon: Globe },
  { id: "about", label: "关于", icon: CheckCircle2 },
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
  if (/(text-embedding|^embedding|-embed(ding)?|bge|e5|gte|m3-embedding|nomic-embed|jina-embed)/.test(id)) return "EMBEDDING";
  if (/(gpt-image|dall-e|dalle|imagen|stable-diffusion|sd[\d-]|flux|midjourney|kolors|qwen-image|wanx|hunyuan-dit|seedream|cogview|recraft)/.test(id)) return "IMAGE";
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
  const key = String(type ?? "").trim().toLowerCase();
  if (!key) return "Search";
  return SEARCH_SERVICE_TYPE_LABELS[key] ?? key;
}

function applyAutoModelType<M extends { modelId?: string; type?: string }>(model: M): M {
  if (model.type && model.type !== "CHAT") return model;
  const inferred = inferModelType(String(model.modelId ?? ""));
  if (inferred === "CHAT") return model;
  return { ...model, type: inferred };
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

function renderMessageTemplatePreview(template: string, message: string, role: string, assistant: AssistantProfile, model?: ProviderModel | null) {
  const now = new Date();
  const values: Record<string, string> = {
    message,
    role,
    time: formatTemplatePreviewTime(now),
    date: formatTemplatePreviewDate(now),
    cur_time: formatTemplatePreviewTime(now),
    cur_date: formatTemplatePreviewDate(now),
    cur_datetime: new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "medium" }).format(now),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    user: "User",
    nickname: "User",
    char: assistant.name?.trim() || "Assistant",
    model_id: model?.modelId || "gpt-4o",
    model_name: model?.displayName || model?.modelId || "GPT-4o",
    system_version: `Windows PC (${navigator.platform || "web"})`,
  };
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => values[key] ?? match);
}

function isProviderTested(provider: ProviderProfile) {
  return provider.testPassed === true || provider.name === "RikkaHub";
}

function PasswordInput({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  const [visible, setVisible] = React.useState(false);
  return (
    <div className="relative">
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
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
        aria-label={visible ? "隐藏 API Key" : "显示 API Key"}
        title={visible ? "隐藏 API Key" : "显示 API Key"}
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </Button>
    </div>
  );
}

const FONT_OPTIONS = [
  { label: "跟随系统", value: "__system", family: "" },
  {
    label: "Tailwind Sans",
    value: "tailwind-sans",
    family: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, \"Noto Sans\", sans-serif, \"Apple Color Emoji\", \"Segoe UI Emoji\", \"Segoe UI Symbol\", \"Noto Color Emoji\"",
  },
  {
    label: "Tailwind Serif",
    value: "tailwind-serif",
    family: "ui-serif, Georgia, Cambria, \"Times New Roman\", Times, serif",
  },
  {
    label: "Tailwind Mono",
    value: "tailwind-mono",
    family: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace",
  },
  { label: "Microsoft YaHei", value: "Microsoft YaHei", family: "\"Microsoft YaHei\", system-ui, sans-serif" },
  { label: "Segoe UI", value: "Segoe UI", family: "\"Segoe UI\", system-ui, sans-serif" },
  { label: "Noto Sans SC", value: "Noto Sans SC", family: "\"Noto Sans SC\", \"Microsoft YaHei\", sans-serif" },
  { label: "Source Han Sans", value: "Source Han Sans", family: "\"Source Han Sans SC\", \"Microsoft YaHei\", sans-serif" },
  { label: "思源宋体", value: "Source Han Serif", family: "\"Source Han Serif SC\", SimSun, serif" },
  { label: "霞鹜文楷", value: "LXGW WenKai", family: "\"LXGW WenKai\", \"Microsoft YaHei\", sans-serif" },
  { label: "等宽字体", value: "monospace", family: "ui-monospace, SFMono-Regular, Consolas, monospace" },
];

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
};

function FontSelect({
  label,
  value,
  fallbackFamily,
  onChange,
}: {
  label: string;
  value: string;
  fallbackFamily: string;
  onChange: (value: string, family: string) => void;
}) {
  const selected = FONT_OPTIONS.find((item) => item.value === value) ?? FONT_OPTIONS[0];
  const previewFamily = selected.family || fallbackFamily;
  return (
    <label className="block space-y-2">
      <span className="text-sm font-medium">{label}</span>
      <Select value={selected.value} onValueChange={(next) => {
        const option = FONT_OPTIONS.find((item) => item.value === next) ?? FONT_OPTIONS[0];
        onChange(option.value, option.family);
      }}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FONT_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div
        className="rounded-md border bg-muted/30 px-3 py-2 text-sm"
        style={{ fontFamily: previewFamily }}
      >
        RikkaHub 字体预览：你好，Hello 123
      </div>
    </label>
  );
}

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

function endpointPreview(provider: ProviderProfile): string {
  const kind = providerKind(provider) as ProviderKind;
  const base = textValue(provider.baseUrl).replace(/\/+$/, "");
  if (!base) return defaultPathForKind(kind, provider.useResponseApi === true);
  if (kind === "openai") return `${base}${provider.useResponseApi === true ? "/responses" : textValue(provider.chatCompletionsPath) || "/chat/completions"}`;
  if (kind === "claude") return `${base}/messages`;
  return `${base}/models/{model}:generateContent?key=${textValue(provider.apiKey) ? "***" : "<API_KEY>"}`;
}

function modelListEndpointPreview(provider: ProviderProfile): string {
  const kind = providerKind(provider) as ProviderKind;
  const base = textValue(provider.baseUrl).replace(/\/+$/, "");
  if (!base) return kind === "google" ? "/models?pageSize=100&key=<API_KEY>" : "/models";
  if (kind === "google") return `${base}/models?pageSize=100&key=${textValue(provider.apiKey) ? "***" : "<API_KEY>"}`;
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
  const nextBaseUrl = kind === "claude"
    ? "https://api.anthropic.com/v1"
    : kind === "google"
      ? "https://generativelanguage.googleapis.com/v1beta"
      : textValue(provider.baseUrl) || "https://api.openai.com/v1";
  return {
    ...provider,
    type: kind,
    baseUrl: nextBaseUrl,
    useResponseApi: kind === "openai" ? provider.useResponseApi === true : false,
    chatCompletionsPath: defaultPathForKind(kind, kind === "openai" && provider.useResponseApi === true),
  };
}

export function meta() {
  return [{ title: "RikkaHub PC 设置" }];
}

export default function SettingsPage() {
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
    api.get<Settings>("settings").then(setSettings).catch((error: Error) => toast.error(error.message));
  }, [settings]);

  React.useEffect(() => {
    if (section !== "logs") return;
    api.get<RequestLog[]>("logs").then(setLogs).catch((error: Error) => toast.error(error.message));
  }, [section]);

  React.useEffect(() => {
    if (section !== "stats") return;
    api.get<StatsPayload>("stats").then(setStats).catch((error: Error) => toast.error(error.message));
  }, [section]);

  if (!settings) {
    return (
      <div className="flex h-svh items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        加载 PC 设置
      </div>
    );
  }

  const updateLocal = (next: Settings) => {
    setSettings(next);
    setStreamedSettings(next);
  };

  return (
    <div className="flex h-svh overflow-hidden bg-background">
      <aside className="flex w-64 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Button asChild size="icon-sm" variant="ghost">
            <Link to="/">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <div>
            <div className="text-sm font-semibold">RikkaHub PC</div>
            <div className="text-xs text-muted-foreground">本地设置中心</div>
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
                className={[
                  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition",
                  active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/70",
                ].join(" ")}
                onClick={() => setSection(item.id)}
              >
                <Icon className="size-4" />
                {item.label}
              </button>
            );
          })}
        </nav>
      </aside>
      <main className="min-w-0 flex-1">
        <ScrollArea className="h-svh">
          <div className="mx-auto w-full max-w-5xl px-6 py-6">
            {section === "general" && <GeneralSection settings={settings} onSettings={updateLocal} />}
            {section === "providers" && <ProvidersSection settings={settings} onSettings={updateLocal} />}
            {section === "models" && <DefaultModelsSection settings={settings} onSettings={updateLocal} />}
            {section === "assistants" && <AssistantsSection settings={settings} onSettings={updateLocal} />}
            {section === "search" && <SearchSection settings={settings} onSettings={updateLocal} />}
            {section === "mcp" && <McpExtensionsSection settings={settings} onSettings={updateLocal} />}
            {section === "speech" && <SpeechSection settings={settings} onSettings={updateLocal} />}
            {section === "data" && <DataSection settings={settings} onSettings={updateLocal} />}
            {section === "stats" && <StatsSection stats={stats} />}
            {section === "logs" && <LogsSection logs={logs} />}
            {section === "proxy" && <ProxySection settings={settings} onSettings={updateLocal} />}
            {section === "about" && <AboutSection />}
          </div>
        </ScrollArea>
      </main>
    </div>
  );
}

function SectionHeader({ icon: Icon, title, subtitle }: { icon: React.ComponentType<{ className?: string }>; title: string; subtitle: string }) {
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
      {canMove ? <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground" /> : null}
      <button type="button" className="min-w-0 flex-1" onClick={onSelect}>
        {children}
      </button>
    </div>
  );
}

function GeneralSection({ settings, onSettings }: { settings: Settings; onSettings: (settings: Settings) => void }) {
  const display = settings.displaySetting;
  const [name, setName] = React.useState(textValue(display.userNickname));
  const [avatar, setAvatar] = React.useState<AssistantAvatar>(display.userAvatar ?? { type: "dummy" });
  const [saving, setSaving] = React.useState(false);
  const profileDirtyRef = React.useRef(false);

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
      if (announce) toast.success("用户资料已保存");
    } catch (error) {
      if (announce) toast.error(error instanceof Error ? error.message : "保存失败");
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
      <SectionHeader icon={UserRound} title="通用设置" subtitle="管理颜色与显示、用户资料、助手与拓展入口。" />
      <div className="grid gap-6">
        <div className="space-y-4 rounded-lg border bg-card p-5">
          <AvatarCropper
            value={avatar}
            fallbackName={name || "User"}
            onChange={async (nextAvatar) => {
              setAvatar(nextAvatar);
              const nextDisplay = { ...settings.displaySetting, userNickname: name.trim(), userAvatar: nextAvatar };
              await api.post("settings/display", nextDisplay);
              onSettings({ ...settings, displaySetting: nextDisplay });
            }}
          />
          <Separator />
          <label className="block space-y-2">
            <span className="text-sm font-medium">昵称</span>
            <Input
              value={name}
              onChange={(event) => {
                profileDirtyRef.current = true;
                setName(event.target.value);
              }}
            />
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            <FontSelect
              label="界面字体"
              value={textValue(display.uiFontFamily)}
              fallbackFamily={"\"Noto Sans SC\", \"Microsoft YaHei\", ui-sans-serif, system-ui, sans-serif"}
              onChange={(value, family) => void patchDisplay({ uiFontFamily: value, uiFontFamilyCss: family })}
            />
            <FontSelect
              label="对话字体"
              value={textValue(display.chatFontFamily)}
              fallbackFamily={textValue(display.uiFontFamilyCss) || "\"Noto Sans SC\", \"Microsoft YaHei\", ui-sans-serif, system-ui, sans-serif"}
              onChange={(value, family) => void patchDisplay({ chatFontFamily: value, chatFontFamilyCss: family })}
            />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {[
              ["showUserAvatar", "显示用户头像"],
              ["showAssistantBubble", "显示助手气泡"],
              ["showModelIcon", "显示模型图标"],
              ["showModelName", "显示模型名称"],
              ["showTokenUsage", "显示 Token 用量"],
              ["showThinkingContent", "显示思考内容"],
              ["sendOnEnter", "Enter 发送"],
              ["enableAutoScroll", "自动滚动"],
            ].map(([key, label]) => (
              <label key={key} className="flex items-center justify-between rounded-md border px-3 py-2">
                <span className="text-sm">{label}</span>
                <Switch
                  checked={display[key] !== false}
                  onCheckedChange={(checked) => void patchDisplay({ [key]: checked })}
                />
              </label>
            ))}
          </div>
          <div className="flex justify-end text-xs text-muted-foreground">
            {saving ? "正在自动保存..." : "已自动保存"}
          </div>
        </div>
      </div>
    </>
  );
}

function ProvidersSection({ settings, onSettings }: { settings: Settings; onSettings: (settings: Settings) => void }) {
  // URL ?providerId= deep-link is only honored on first mount, so subsequent settings updates
  // (autosave, SSE) don't snap the selection back to the URL value or the default first provider.
  const initialProviderId = React.useMemo(() => {
    if (typeof window === "undefined") return settings.providers[0]?.id ?? "";
    const providerId = new URLSearchParams(window.location.search).get("providerId");
    if (providerId && settings.providers.some((provider) => provider.id === providerId)) return providerId;
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
  const selected = settings.providers.find((provider) => provider.id === selectedId) ?? settings.providers[0];
  const [draft, setDraft] = React.useState<ProviderProfile | null>(selected ? clone(selected) : null);
  const [testing, setTesting] = React.useState(false);
  const [fetchingModels, setFetchingModels] = React.useState(false);
  const [testResult, setTestResult] = React.useState("");
  const [testChecks, setTestChecks] = React.useState<ProviderTestCheck[]>([]);
  const [testInfo, setTestInfo] = React.useState<ProviderTestInfo | null>(null);
  const [checkingBalance, setCheckingBalance] = React.useState(false);
  const [balanceResult, setBalanceResult] = React.useState("");
  const [fetchedModels, setFetchedModels] = React.useState<ProviderModel[]>([]);
  const [testModelId, setTestModelId] = React.useState("");
  const [imageTestResult, setImageTestResult] = React.useState<{ url: string; durationMs: number; modelId: string; prompt: string } | null>(null);
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

  React.useEffect(() => {
    const next = settings.providers.find((provider) => provider.id === selectedId) ?? settings.providers[0];
    const selectedChanged = lastSelectedRef.current !== selectedId;
    lastSelectedRef.current = selectedId;
    setDraft(next ? clone(next) : null);
    dirtyRef.current = false;
    if (selectedChanged) {
      setFetchedModels([]);
      setTestResult("");
      setTestChecks([]);
      setTestInfo(null);
      setBalanceResult("");
      setImageTestResult(null);
      setTestModelId(next?.models?.find((model) => model.modelId !== "auto")?.modelId ?? "");
    }
  }, [selectedId, settings.providers]);

  if (!draft) return null;
  const balanceOption = balanceOptionOf(draft);
  const kind = providerKind(draft) as ProviderKind;
  const selectedModelIds = new Set((draft.models ?? []).map((model) => model.modelId));
  const fetchedModelIds = new Set(fetchedModels.map((model) => model.modelId));
  const mergedTestModels = [
    ...fetchedModels,
    ...(draft.models ?? []).filter((model) => model.modelId !== "auto" && !fetchedModelIds.has(model.modelId)),
  ].filter((model) => model.modelId !== "auto");
  const effectiveTestModelId = (testModelId && mergedTestModels.some((model) => model.modelId === testModelId) ? testModelId : mergedTestModels[0]?.modelId) || "";
  // The selected test model's persisted record drives whether we run the image-gen test path
  // (and hide the 3-mode chat panel) vs the chat test path.
  const effectiveTestModelType = (() => {
    const persisted = (draft.models ?? []).find((item) => item.modelId === effectiveTestModelId);
    const merged = mergedTestModels.find((item) => item.modelId === effectiveTestModelId);
    return String((persisted?.type ?? merged?.type ?? "CHAT")).toUpperCase();
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
      providers: settings.providers.map((provider) => (provider.id === nextProvider.id ? nextProvider : provider)),
    });
    dirtyRef.current = false;
  };
  React.useEffect(() => {
    if (!draft || !dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void api.post("settings/provider", draft)
        .then(() => {
          dirtyRef.current = false;
          onSettings({
            ...settings,
            providers: settings.providers.map((provider) => (provider.id === draft.id ? draft : provider)),
          });
        })
        .catch((error: Error) => toast.error(error.message || "自动保存供应商失败"));
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
    const selectedTestModel = (draft.models ?? []).find((item) => item.modelId === requestedModelId)
      ?? mergedTestModels.find((item) => item.modelId === requestedModelId)
      ?? null;
    if (selectedTestModel && (selectedTestModel.type as string) === "IMAGE") {
      setTestResult("正在保存配置...\n正在执行图像生成测试...");
      try {
        await save();
        const started = Date.now();
        const response = await api.post<{ status: string; image: { url: string; mime: string; fileName: string } }>(
          "settings/provider/test/image",
          { providerId: draft.id, modelId: requestedModelId },
          { timeout: false },
        );
        const durationMs = Date.now() - started;
        const url = response.image?.url ?? "";
        setImageTestResult({ url, durationMs, modelId: requestedModelId, prompt: "A red apple on a white background" });
        setTestResult(`图像生成测试完成\n\n模型: ${requestedModelId}\n用时: ${(durationMs / 1000).toFixed(2)}s\n输出文件: ${response.image?.fileName ?? "-"}`);
        onSettings(await api.get<Settings>("settings"));
        toast.success("图像生成测试成功");
      } catch (error) {
        const message = error instanceof Error ? error.message : "图像生成测试失败";
        setTestResult(message);
        toast.error(message);
      } finally {
        setTesting(false);
      }
      return;
    }
    setTestResult("正在保存配置...\n正在读取模型列表并准备测试...");
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
        const fallback = await api.post<ProviderTestInfo>("settings/provider/test", { providerId: draft.id, modelId: requestedModelId || undefined }, { timeout: false });
        const checks = (fallback.checks ?? [])
          .map((item) => `${item.ok ? "✓" : "×"} ${item.mode}: ${item.status || "failed"}\n${item.preview}`)
          .join("\n\n");
        setTestInfo(fallback);
        setTestChecks(fallback.checks ?? []);
        setTestModelId(fallback.testModelId);
        setTestResult(`测试完成\n\n测试模型: ${fallback.testModelId}\n模型列表端点: ${fallback.endpoint}\n当前聊天端点: ${fallback.responseApiEndpoint}\n模型数量: ${fallback.modelCount}\n\n${checks}\n\n模型列表预览:\n${fallback.preview}`);
        onSettings(await api.get<Settings>("settings"));
        toast.success("连接测试完成");
        return;
      }
      const checks: ProviderTestCheck[] = [];
      let info: ProviderTestInfo | null = null;
      const renderResult = (prefix = "") => {
        setTestInfo(info);
        setTestChecks([...checks]);
        const header = info
          ? `测试模型: ${info.testModelId || effectiveTestModelId}\n模型列表端点: ${info.endpoint}\n当前聊天端点: ${info.responseApiEndpoint}\n模型数量: ${info.modelCount}`
          : `测试模型: ${effectiveTestModelId || "正在自动选择..."}`;
        const checkText = checks
          .map((item) => `${item.ok ? "✓" : "×"} ${item.mode}: ${item.status || "failed"}\n${item.preview}`)
          .join("\n\n");
        const preview = info?.preview ? `\n\n模型列表预览:\n${info.preview}` : "";
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
          const event = block.split(/\r?\n/).find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
          const dataText = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (!dataText) continue;
          const data = JSON.parse(dataText) as Record<string, unknown>;
          if (event === "progress") {
            renderResult(String(data.message ?? "正在测试..."));
          } else if (event === "models") {
            info = data as unknown as ProviderTestInfo;
            if (info.testModelId) setTestModelId(info.testModelId);
            renderResult("模型列表读取完成，开始逐项测试...");
          } else if (event === "check") {
            checks.push(data as unknown as ProviderTestCheck);
            renderResult("测试进行中...");
          } else if (event === "done") {
            info = data as unknown as ProviderTestInfo;
            if (Array.isArray(info.checks)) checks.splice(0, checks.length, ...info.checks);
            if (info.testModelId) setTestModelId(info.testModelId);
            renderResult("测试完成");
          } else if (event === "error") {
            throw new Error(String(data.error ?? "测试失败"));
          }
        }
      }
      onSettings(await api.get<Settings>("settings"));
      toast.success("连接测试成功");
    } catch (error) {
      const message = error instanceof Error ? error.message : "测试失败";
      setTestInfo(null);
      setTestChecks([]);
      setTestResult(message);
      toast.error(message);
    } finally {
      setTesting(false);
    }
  };
  const fetchModels = async () => {
    setFetchingModels(true);
    try {
      await api.post("settings/provider", draft);
      const result = await api.post<{ endpoint: string; models: ProviderModel[] }>("settings/provider/models", { providerId: draft.id });
      setFetchedModels(result.models);
      setTestModelId(result.models.find((model) => model.modelId !== "auto")?.modelId ?? "");
      toast.success(`获取到 ${result.models.length} 个模型`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "获取模型失败");
    } finally {
      setFetchingModels(false);
    }
  };
  const checkBalance = async () => {
    setCheckingBalance(true);
    setBalanceResult("正在查询余额...");
    try {
      await save();
      const result = await api.post<{ value: string; endpoint: string; preview: string }>("settings/provider/balance", { providerId: draft.id }, { timeout: false });
      setBalanceResult(`余额：${result.value}\n端点：${result.endpoint}\n\n${result.preview}`);
      toast.success(`余额：${result.value}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "余额查询失败";
      setBalanceResult(message);
      toast.error(message);
    } finally {
      setCheckingBalance(false);
    }
  };
  const toggleModel = (model: ProviderModel, checked: boolean) => {
    const models = checked
      // Auto-fill type for newly enabled models (CHAT/IMAGE/EMBEDDING) — user can override per-row.
      ? [...(draft.models ?? []), applyAutoModelType(model)].filter((item, index, arr) => arr.findIndex((x) => x.modelId === item.modelId) === index)
      : (draft.models ?? []).filter((item) => item.modelId !== model.modelId);
    patchDraft({ models });
  };
  const updateModelType = (modelId: string, type: "CHAT" | "IMAGE" | "EMBEDDING") => {
    const models = (draft.models ?? []).map((item) => item.modelId === modelId ? { ...item, type } : item);
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
  const addProvider = async () => {
    const next = createProvider();
    await api.post("settings/provider", next);
    onSettings({ ...settings, providers: [...settings.providers, next] });
    setSelectedId(next.id);
    toast.success("供应商已添加");
  };
  const moveProvider = async (from: number, to: number) => {
    const nextProviders = moveItem(settings.providers, from, to);
    onSettings({ ...settings, providers: nextProviders });
    await api.post("settings/provider/reorder", { ids: nextProviders.map((provider) => provider.id) });
  };
  const testModeLabels: Record<ProviderTestMode, string> = {
    non_stream: "非流式",
    stream: "流式",
    tools: "工具调用",
  };

  return (
    <>
      <SectionHeader icon={KeyRound} title="供应商" subtitle="内置模板、启用状态、Base URL、API 路径、Response API、余额路径和模型配置。" />
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="rounded-lg border bg-card p-2">
          <Button className="mb-2 w-full justify-start" variant="outline" onClick={addProvider}>
            <Plus className="size-4" />
            添加供应商
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
                <span className={`size-2 rounded-full ${provider.enabled ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
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
              <div className="text-xs text-muted-foreground">{textValue(draft.shortDescription) || providerKind(draft)}</div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">启用</span>
              <Switch checked={draft.enabled} onCheckedChange={(enabled) => patchDraft({ enabled })} />
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-2">
              <span className="text-sm font-medium">名称</span>
              <Input value={draft.name} onChange={(event) => patchDraft({ name: event.target.value })} />
            </label>
            <label className="space-y-2">
              <span className="text-sm font-medium">类型</span>
              <Select value={kind} onValueChange={(value) => setDraft(normalizeKindPatch(draft, value as ProviderKind))}>
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
              <span className="text-sm font-medium">API Key</span>
              <PasswordInput value={textValue(draft.apiKey)} onChange={(apiKey) => patchDraft({ apiKey })} />
            </label>
            <label className="space-y-2 md:col-span-2">
              <span className="text-sm font-medium">Base URL</span>
              <Input
                value={textValue(draft.baseUrl)}
                onChange={(event) => patchDraft({ baseUrl: event.target.value })}
                placeholder={kind === "claude" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"}
              />
              <span className="block break-all text-xs text-muted-foreground">聊天完整 URL：{endpointPreview(draft)}</span>
              <span className="block break-all text-xs text-muted-foreground">模型列表 URL：{modelListEndpointPreview(draft)}</span>
            </label>
            <label className="space-y-2">
              <span className="text-sm font-medium">Chat Completions Path</span>
              <Input
                disabled={kind !== "openai" || draft.useResponseApi === true}
                value={textValue(draft.chatCompletionsPath) || defaultPathForKind(kind, draft.useResponseApi === true)}
                onChange={(event) => patchDraft({ chatCompletionsPath: event.target.value })}
              />
            </label>
            <div className="flex items-end justify-between gap-3 rounded-md border px-3 py-2">
              <div>
                <div className="text-sm font-medium">Response API</div>
                <div className="text-xs text-muted-foreground">开启后聊天端点自动切换为 /responses</div>
              </div>
              <Switch
                disabled={kind !== "openai"}
                checked={draft.useResponseApi === true}
                onCheckedChange={(useResponseApi) => patchDraft({ useResponseApi, chatCompletionsPath: defaultPathForKind("openai", useResponseApi) })}
              />
            </div>
            {kind === "claude" ? (
              <div className="grid gap-3 rounded-md border px-3 py-3 md:col-span-2 md:grid-cols-[1fr_180px]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">Claude 提示缓存</div>
                    <div className="text-xs text-muted-foreground">
                      开启后会给系统提示词和倒数第二条用户消息添加 cache_control，复用 Anthropic 的提示缓存。
                    </div>
                  </div>
                  <Switch
                    checked={draft.promptCaching === true}
                    onCheckedChange={(promptCaching) => patchDraft({ promptCaching })}
                  />
                </div>
                <label className="space-y-2">
                  <span className="text-sm font-medium">缓存时长</span>
                  <Select
                    value={textValue(draft.promptCacheTtl) || "5m"}
                    onValueChange={(promptCacheTtl) => patchDraft({ promptCacheTtl: promptCacheTtl as "5m" | "1h" })}
                    disabled={draft.promptCaching !== true}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="5m">5 分钟</SelectItem>
                      <SelectItem value="1h">1 小时</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
              </div>
            ) : null}
            <label className="space-y-2">
              <span className="text-sm font-medium">余额 API Path</span>
              <Input
                value={textValue(balanceOption.apiPath) || "/credits"}
                onChange={(event) => patchDraft({ balanceOption: { ...balanceOptionOf(draft), apiPath: event.target.value } })}
              />
            </label>
            <label className="space-y-2">
              <span className="text-sm font-medium">余额结果路径</span>
              <Input
                value={textValue(balanceOption.resultPath)}
                onChange={(event) => patchDraft({ balanceOption: { ...balanceOptionOf(draft), resultPath: event.target.value } })}
              />
            </label>
            <div className="flex items-end justify-between gap-3 rounded-md border px-3 py-2">
              <div>
                <div className="text-sm font-medium">余额查询</div>
                <div className="text-xs text-muted-foreground">按下方接口路径 GET 余额，并按指定 JSON 字段读取数值。</div>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={balanceOption.enabled === true}
                  onCheckedChange={(enabled) => patchDraft({ balanceOption: { ...balanceOptionOf(draft), enabled } })}
                />
                <Button type="button" variant="outline" size="sm" onClick={() => void checkBalance()} disabled={checkingBalance || balanceOption.enabled !== true}>
                  {checkingBalance ? <Loader2 className="size-4 animate-spin" /> : <Database className="size-4" />}
                  查询
                </Button>
              </div>
            </div>
          </div>
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">模型列表</div>
                <div className="text-xs text-muted-foreground">先获取供应商模型，再勾选要启用的模型。当前已启用 {draft.models?.length ?? 0} 个。</div>
              </div>
              <Button variant="outline" onClick={fetchModels} disabled={fetchingModels}>
                {fetchingModels ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                获取模型列表
              </Button>
            </div>
            <div className="max-h-72 space-y-2 overflow-auto">
              {(fetchedModels.length ? fetchedModels : draft.models ?? []).map((model) => {
                const focused = focusedModelId && (model.modelId === focusedModelId || model.id === focusedModelId);
                const enabled = selectedModelIds.has(model.modelId);
                const persisted = (draft.models ?? []).find((item) => item.modelId === model.modelId);
                const currentType = (persisted?.type as "CHAT" | "IMAGE" | "EMBEDDING" | undefined) ?? "CHAT";
                const currentAbilities = Array.isArray(persisted?.abilities) ? persisted!.abilities : [];
                const hasTool = currentAbilities.includes("TOOL");
                const hasReasoning = currentAbilities.includes("REASONING");
                return (
                <label
                  key={model.id ?? model.modelId}
                  className={cn(
                    "flex items-center gap-3 rounded-md border px-3 py-2 transition",
                    focused && "border-primary bg-primary/5 shadow-sm",
                  )}
                >
                  <Checkbox checked={enabled} onCheckedChange={(checked) => toggleModel(model, checked === true)} />
                  <AIIcon name={model.modelId} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{model.displayName || model.modelId}</span>
                    <span className="block truncate text-xs text-muted-foreground">{model.modelId}</span>
                  </span>
                  {enabled ? (
                    <div className="flex items-center gap-1.5">
                      {currentType === "CHAT" ? (
                        <>
                          <button
                            type="button"
                            onClick={(event) => { event.preventDefault(); toggleModelAbility(model.modelId, "TOOL", !hasTool); }}
                            className={cn(
                              "h-7 rounded-md border px-2 text-xs transition",
                              hasTool
                                ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                                : "border-border text-muted-foreground hover:bg-muted",
                            )}
                            title={hasTool ? "工具调用已启用，点击关闭" : "点击启用工具调用能力"}
                          >
                            工具
                          </button>
                          <button
                            type="button"
                            onClick={(event) => { event.preventDefault(); toggleModelAbility(model.modelId, "REASONING", !hasReasoning); }}
                            className={cn(
                              "h-7 rounded-md border px-2 text-xs transition",
                              hasReasoning
                                ? "border-sky-500/50 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                                : "border-border text-muted-foreground hover:bg-muted",
                            )}
                            title={hasReasoning ? "推理已启用，点击关闭" : "点击启用推理能力"}
                          >
                            推理
                          </button>
                        </>
                      ) : null}
                      <Select value={currentType} onValueChange={(value) => updateModelType(model.modelId, value as "CHAT" | "IMAGE" | "EMBEDDING")}>
                        <SelectTrigger className="h-8 w-28" onClick={(event) => event.preventDefault()}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="CHAT">聊天</SelectItem>
                          <SelectItem value="IMAGE">图像生成</SelectItem>
                          <SelectItem value="EMBEDDING">嵌入</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                </label>
                );
              })}
              {!fetchedModels.length && !(draft.models ?? []).length ? (
                <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">还没有模型。请先点击“获取模型列表”。</div>
              ) : null}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <div className="mr-auto min-w-64 max-w-sm space-y-1">
              <span className="text-xs font-medium text-muted-foreground">测试模型</span>
              <Select value={effectiveTestModelId} onValueChange={setTestModelId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="先获取模型列表或选择已启用模型" />
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
            <Button variant="outline" onClick={test} disabled={testing}>
              {testing ? <Loader2 className="size-4 animate-spin" /> : <Database className="size-4" />}
              测试
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                if (!window.confirm(`删除供应商「${draft.name}」？`)) return;
                await api.delete(`settings/provider/${encodeURIComponent(draft.id)}`);
                const providers = settings.providers.filter((item) => item.id !== draft.id);
                onSettings({ ...settings, providers });
                setSelectedId(providers[0]?.id ?? "");
                toast.success("供应商已删除");
              }}
              disabled={settings.providers.length <= 1}
            >
              <Trash2 className="size-4" />
              删除
            </Button>
            <div className="flex items-center px-2 text-xs text-muted-foreground">已自动保存</div>
          </div>
          {(testing || testChecks.length > 0 || testInfo) && !isImageTestMode && !imageTestResult ? (
            <div className="rounded-md border bg-muted/40 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium">测试摘要</div>
                <div className="text-xs text-muted-foreground">
                  {testInfo?.testModelId ? `模型：${testInfo.testModelId}` : (testing ? "正在测试..." : "等待结果")}
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
                        {check ? (check.ok ? `成功 · HTTP ${check.status}` : `失败 · ${check.status || "未连接"}`) : (pending ? "进行中" : "未测试")}
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
              正在用 <span className="font-medium text-foreground">{effectiveTestModelId}</span> 生成测试图像…
            </div>
          ) : null}
          {imageTestResult ? (
            <div className="rounded-md border bg-muted/40 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium">图像生成测试结果</div>
                <div className="text-xs text-muted-foreground">
                  模型：{imageTestResult.modelId} · 用时 {(imageTestResult.durationMs / 1000).toFixed(2)}s
                </div>
              </div>
              <div className="flex flex-wrap items-start gap-3">
                {imageTestResult.url ? (
                  <img
                    src={appendWebAuthQuery(imageTestResult.url)}
                    alt="生成结果"
                    className="h-40 w-40 rounded-md border object-cover"
                  />
                ) : null}
                <div className="min-w-0 flex-1 text-xs text-muted-foreground">
                  <div className="mb-1 font-medium text-foreground">提示词</div>
                  <div className="whitespace-pre-wrap">{imageTestResult.prompt}</div>
                </div>
              </div>
            </div>
          ) : null}
          {testResult ? <pre className="max-h-56 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap">{testResult}</pre> : null}
          {balanceResult ? <pre className="max-h-56 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap">{balanceResult}</pre> : null}
        </div>
      </div>
    </>
  );
}

function AssistantsSection({ settings, onSettings }: { settings: Settings; onSettings: (settings: Settings) => void }) {
  const [assistantId, setAssistantId] = React.useState(settings.assistantId);
  const assistant = (settings.assistants.find((item) => item.id === assistantId) ?? settings.assistants[0]) as AssistantProfile | undefined;
  const [draft, setDraft] = React.useState<AssistantProfile | null>(assistant ? clone(assistant) : null);
  const [memories, setMemories] = React.useState<AssistantMemoryInfo[]>([]);
  const [memoryContent, setMemoryContent] = React.useState("");
  const [editingMemoryId, setEditingMemoryId] = React.useState<number | null>(null);
  const dirtyRef = React.useRef(false);

  React.useEffect(() => {
    const next = settings.assistants.find((item) => item.id === assistantId) ?? settings.assistants[0];
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
      void save().catch((error: Error) => toast.error(error.message || "自动保存助手失败"));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [draft, settings.assistants]);

  const loadMemories = React.useCallback(async () => {
    if (!draft) {
      setMemories([]);
      return;
    }
    const result = await api.get<{ memories: AssistantMemoryInfo[] }>(`settings/memories?assistantId=${encodeURIComponent(draft.id)}`);
    setMemories(result.memories);
  }, [draft?.id]);

  React.useEffect(() => {
    void loadMemories().catch((error: Error) => toast.error(error.message || "读取记忆失败"));
  }, [loadMemories, draft?.useGlobalMemory]);

  if (!draft) return null;

  const patchDraft = (patch: Partial<AssistantProfile>) => {
    dirtyRef.current = true;
    setDraft({ ...draft, ...patch });
  };

  const addAssistant = async () => {
    const created = {
      ...clone(settings.assistants[0]),
      id: crypto.randomUUID(),
      name: "新助手",
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
    toast.success("助手已添加");
  };
  const moveAssistant = async (from: number, to: number) => {
    const assistants = moveItem(settings.assistants, from, to);
    onSettings({ ...settings, assistants });
    await api.post("settings/assistants/reorder", { ids: assistants.map((item) => item.id) });
  };
  const removeAssistant = async () => {
    if (!window.confirm(`删除助手「${draft.name || "默认助手"}」？`)) return;
    await api.delete(`settings/assistant/${encodeURIComponent(draft.id)}`);
    const assistants = settings.assistants.filter((item) => item.id !== draft.id);
    onSettings({ ...settings, assistants, assistantId: settings.assistantId === draft.id ? assistants[0]?.id ?? "" : settings.assistantId });
    setAssistantId(assistants[0]?.id ?? "");
    toast.success("助手已删除");
  };
  const parameterControl = (key: "temperature" | "topP", label: string, max: number, step: number) => {
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
          <Slider min={0} max={max} step={step} value={[value]} onValueChange={([next]) => patchDraft({ [key]: next ?? null } as Partial<AssistantProfile>)} />
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
    return settings.providers.flatMap((provider) => provider.models).find((modelItem) => modelItem.id === wanted || modelItem.modelId === wanted) ?? null;
  }, [draft.chatModelId, settings.chatModelId, settings.providers]);
  const messageTemplatePreview = React.useMemo(
    () => [
      {
        role: "user",
        text: renderMessageTemplatePreview(messageTemplateValue, "你好啊", "user", draft, previewModel),
      },
      {
        role: "assistant",
        text: "你好，有什么我可以帮你的吗？",
      },
    ],
    [draft, messageTemplateValue, previewModel],
  );
  const presetMessages = Array.isArray(draft.presetMessages) ? (draft.presetMessages as Array<Record<string, unknown>>) : [];
  const assistantRegexes = Array.isArray(draft.regexes) ? (draft.regexes as Array<Record<string, unknown>>) : [];
  const customHeaders = Array.isArray(draft.customHeaders) ? (draft.customHeaders as Array<Record<string, unknown>>) : [];
  const customBodies = Array.isArray(draft.customBodies) ? (draft.customBodies as Array<Record<string, unknown>>) : [];
  const updatePresetMessage = (index: number, patch: Record<string, unknown>) => {
    patchDraft({ presetMessages: presetMessages.map((message, itemIndex) => (itemIndex === index ? { ...message, ...patch } : message)) });
  };
  const updateRegex = (index: number, patch: Record<string, unknown>) => {
    patchDraft({ regexes: assistantRegexes.map((regex, itemIndex) => (itemIndex === index ? { ...regex, ...patch } : regex)) });
  };
  const updateCustomHeader = (index: number, patch: Record<string, unknown>) => {
    patchDraft({ customHeaders: customHeaders.map((header, itemIndex) => (itemIndex === index ? { ...header, ...patch } : header)) });
  };
  const updateCustomBody = (index: number, patch: Record<string, unknown>) => {
    patchDraft({ customBodies: customBodies.map((body, itemIndex) => (itemIndex === index ? { ...body, ...patch } : body)) });
  };
  const saveMemory = async () => {
    const content = memoryContent.trim();
    if (!content) return;
    await api.post("settings/memory/detail", { assistantId: draft.id, id: editingMemoryId ?? undefined, content });
    setMemoryContent("");
    setEditingMemoryId(null);
    await loadMemories();
    toast.success(editingMemoryId ? "记忆已更新" : "记忆已添加");
  };
  const removeMemory = async (memoryId: number) => {
    if (!window.confirm(`删除记忆 #${memoryId}？`)) return;
    await api.delete(`settings/memory/${memoryId}`);
    if (editingMemoryId === memoryId) {
      setEditingMemoryId(null);
      setMemoryContent("");
    }
    await loadMemories();
    toast.success("记忆已删除");
  };

  return (
    <>
      <SectionHeader icon={Bot} title="助手" subtitle="按基础、提示词、拓展、记忆、请求、MCP、本地工具分页编辑每个助手。" />
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="rounded-lg border bg-card p-2">
          <Button className="mb-2 w-full justify-start" variant="outline" onClick={addAssistant}>
            <CopyPlus className="size-4" />
            添加助手
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
                <span className="truncate">{item.name || "默认助手"}</span>
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
                assistants: settings.assistants.map((item) => (item.id === nextDraft.id ? nextDraft : item)),
              });
            }}
          />
          <Separator />
          <label className="block space-y-2">
            <span className="text-sm font-medium">名称</span>
            <Input value={draft.name} onChange={(event) => patchDraft({ name: event.target.value })} />
          </label>
          <label className="block space-y-2">
            <span className="text-sm font-medium">系统提示词</span>
            <Textarea className="min-h-52 font-mono text-xs" value={textValue(draft.systemPrompt)} onChange={(event) => patchDraft({ systemPrompt: event.target.value })} />
          </label>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">消息内容模板</div>
                <div className="mt-0.5 text-xs text-muted-foreground">发送给模型前会用这个模板包裹用户消息，通常保持默认即可。</div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={messageTemplateValue === "{{ message }}"}
                onClick={() => patchDraft({ messageTemplate: "{{ message }}" })}
              >
                <RefreshCw className="size-4" />
                重置
              </Button>
            </div>
            <Textarea
              className="min-h-32 font-mono text-xs"
              value={messageTemplateValue}
              onChange={(event) => patchDraft({ messageTemplate: event.target.value })}
            />
            {messageTemplateMissingMessage ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                模板不包含 {"{{ message }}"}，用户消息将不会被发送给模型。
              </div>
            ) : null}
            <div className="rounded-md border bg-muted/30 p-3">
              <div className="mb-2 text-sm font-medium">模板预览</div>
              <div className="space-y-2">
                {messageTemplatePreview.map((item) => (
                  <div key={item.role} className="rounded-md bg-background p-3 text-xs">
                    <div className="mb-1 text-muted-foreground">{item.role}</div>
                    <pre className="whitespace-pre-wrap font-sans leading-relaxed">{item.text}</pre>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                <span>可用变量：</span>
                {["role", "message", "time", "date", "cur_datetime", "user", "char", "model_name"].map((variable) => (
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
                <div className="text-sm font-medium">预设消息</div>
                <div className="mt-0.5 text-xs text-muted-foreground">新会话创建时会先写入这些预设消息，用于给助手一个稳定的开场上下文。</div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => patchDraft({ presetMessages: [...presetMessages, { role: "ASSISTANT", content: "" }] })}
              >
                <Plus className="size-4" />
                添加
              </Button>
            </div>
            <div className="space-y-3">
              {presetMessages.length === 0 ? <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">没有预设消息</div> : null}
              {presetMessages.map((message, index) => (
                <div key={String(message.id ?? index)} className="rounded-md border bg-muted/20 p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <Select value={textValue(message.role).toUpperCase() || "ASSISTANT"} onValueChange={(role) => updatePresetMessage(index, { role })}>
                      <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
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
                      onClick={() => patchDraft({ presetMessages: presetMessages.filter((_, itemIndex) => itemIndex !== index) })}
                      title="删除预设消息"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                  <Textarea
                    className="min-h-24"
                    value={textValue(message.content)}
                    onChange={(event) => updatePresetMessage(index, { content: event.target.value })}
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">正则替换</div>
                <div className="mt-0.5 text-xs text-muted-foreground">在用户输入或助手输出结束后执行替换；无效正则会被自动跳过。</div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  patchDraft({
                    regexes: [
                      ...assistantRegexes,
                      { id: crypto.randomUUID(), name: "", enabled: true, findRegex: "", replaceString: "", affectingScope: ["ASSISTANT"], visualOnly: false },
                    ],
                  })
                }
              >
                <Plus className="size-4" />
                添加
              </Button>
            </div>
            <div className="space-y-3">
              {assistantRegexes.length === 0 ? <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">没有正则规则</div> : null}
              {assistantRegexes.map((regex, index) => {
                const scopes = Array.isArray(regex.affectingScope) ? regex.affectingScope.map(String) : [];
                const toggleScope = (scope: "USER" | "ASSISTANT", checked: boolean) => {
                  const nextScopes = new Set(scopes);
                  if (checked) nextScopes.add(scope);
                  else nextScopes.delete(scope);
                  updateRegex(index, { affectingScope: [...nextScopes] });
                };
                return (
                  <div key={String(regex.id ?? index)} className="rounded-md border bg-muted/20 p-3">
                    <div className="mb-3 flex items-center gap-2">
                      <Switch checked={regex.enabled !== false} onCheckedChange={(checked) => updateRegex(index, { enabled: checked })} />
                      <Input className="h-8" value={textValue(regex.name)} onChange={(event) => updateRegex(index, { name: event.target.value })} placeholder="规则名称" />
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => patchDraft({ regexes: assistantRegexes.filter((_, itemIndex) => itemIndex !== index) })}
                        title="删除正则"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="space-y-1">
                        <span className="text-xs text-muted-foreground">Find Regex</span>
                        <Input value={textValue(regex.findRegex)} onChange={(event) => updateRegex(index, { findRegex: event.target.value })} />
                      </label>
                      <label className="space-y-1">
                        <span className="text-xs text-muted-foreground">Replace String</span>
                        <Input value={textValue(regex.replaceString)} onChange={(event) => updateRegex(index, { replaceString: event.target.value })} />
                      </label>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
                      <label className="flex items-center gap-2">
                        <Checkbox checked={scopes.includes("USER")} onCheckedChange={(checked) => toggleScope("USER", checked === true)} />
                        User
                      </label>
                      <label className="flex items-center gap-2">
                        <Checkbox checked={scopes.includes("ASSISTANT")} onCheckedChange={(checked) => toggleScope("ASSISTANT", checked === true)} />
                        Assistant
                      </label>
                      <label className="flex items-center gap-2">
                        <Checkbox checked={regex.visualOnly === true} onCheckedChange={(checked) => updateRegex(index, { visualOnly: checked === true })} />
                        仅视觉替换
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
                placeholder="不限制"
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  setDraft({ ...draft, maxTokens: raw === "" ? null : Math.max(1, Number(raw) || 1) });
                }}
              />
              <div className="text-xs text-muted-foreground">留空表示不向供应商发送 max_tokens 限制。</div>
            </label>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {[
              ["enableMemory", "启用记忆"],
              ["useGlobalMemory", "使用全局记忆"],
              ["enableRecentChatsReference", "引用最近聊天"],
              ["streamOutput", "流式输出"],
              ["enableTimeReminder", "时间提醒"],
              ["useAssistantAvatar", "聊天中使用助手头像"],
              ["allowConversationSystemPrompt", "允许会话独立 system prompt"],
            ].map(([key, label]) => (
              <label key={key} className="flex items-center justify-between rounded-md border px-3 py-2">
                <span className="text-sm">{label}</span>
                <Switch checked={draft[key] === true} onCheckedChange={(checked) => patchDraft({ [key]: checked } as Partial<AssistantProfile>)} />
              </label>
            ))}
          </div>
          <div className="rounded-md border p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">记忆管理</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  开启记忆后会注入 <code className="rounded bg-muted px-1">memory_tool</code>，并在后续会话中以 Memories Prompt 注入已保存的记忆。
                </div>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={() => void loadMemories()}>
                <RefreshCw className="size-4" />
                刷新
              </Button>
            </div>
            <div className="grid gap-3 md:grid-cols-[1fr_220px]">
              <Textarea
                className="min-h-24"
                value={memoryContent}
                onChange={(event) => setMemoryContent(event.target.value)}
                placeholder="写入一条长期记忆，例如用户偏好的称呼、工作背景或长期项目设定"
              />
              <div className="flex flex-col gap-2">
                <Button type="button" onClick={() => void saveMemory()} disabled={!memoryContent.trim()}>
                  <Save className="size-4" />
                  {editingMemoryId ? `更新 #${editingMemoryId}` : "添加记忆"}
                </Button>
                {editingMemoryId ? (
                  <Button type="button" variant="outline" onClick={() => { setEditingMemoryId(null); setMemoryContent(""); }}>
                    取消编辑
                  </Button>
                ) : null}
                <div className="text-xs text-muted-foreground">
                  当前来源：{draft.useGlobalMemory ? "全局记忆" : "当前助手记忆"}，共 {memories.length} 条。
                </div>
              </div>
            </div>
            <div className="mt-3 max-h-64 space-y-2 overflow-auto">
              {memories.length === 0 ? <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">没有记忆</div> : null}
              {memories.map((memory) => (
                <div key={memory.id} className="flex items-start gap-3 rounded-md border bg-muted/20 p-3">
                  <div className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">#{memory.id}</div>
                  <div className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-relaxed">{memory.content}</div>
                  <Button type="button" size="icon-sm" variant="ghost" title="编辑记忆" onClick={() => { setEditingMemoryId(memory.id); setMemoryContent(memory.content); }}>
                    <NotebookText className="size-4" />
                  </Button>
                  <Button type="button" size="icon-sm" variant="ghost" title="删除记忆" onClick={() => void removeMemory(memory.id)}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="text-sm font-medium">本地工具</div>
            <div className="mt-1 text-xs text-muted-foreground">本地工具列表。启用后，仅在当前模型支持工具调用时才会注入给模型。</div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {[
                ["time_info", "时间信息", "读取 PC 本地时间、时区、星期和时间戳。"],
                ["javascript_engine", "JavaScript 引擎", "用于计算和纯文本数据转换，不提供 DOM/Node API。"],
                ["clipboard", "剪贴板", "读写 Windows 系统剪贴板；除非用户明确要求，否则模型不应写入。"],
                ["tts", "语音播报", "调用 Windows 系统语音朗读文本。"],
                ["ask_user", "询问用户", "需要澄清时在对话中展示问题，由用户回答后继续。"],
              ].map(([type, label, desc]) => {
                const enabled = Array.isArray(draft.localTools) && draft.localTools.some((tool) => isPlainRecord(tool) ? tool.type === type : tool === type);
                return (
                  <label key={type} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                    <span>
                      <span className="block text-sm">{label}</span>
                      <span className="block text-xs text-muted-foreground">{desc}</span>
                    </span>
                    <Switch
                      checked={enabled}
                      onCheckedChange={(checked) => {
                        const current = Array.isArray(draft.localTools) ? draft.localTools : [];
                        const next = checked
                          ? [...current.filter((tool) => !(isPlainRecord(tool) ? tool.type === type : tool === type)), { type }]
                          : current.filter((tool) => !(isPlainRecord(tool) ? tool.type === type : tool === type));
                        patchDraft({ localTools: next });
                      }}
                    />
                  </label>
                );
              })}
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="mb-3 text-sm font-medium">自定义请求</div>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm">Headers</div>
                    <div className="text-xs text-muted-foreground">发送模型请求时会追加到请求头。</div>
                  </div>
                  <Button type="button" size="sm" variant="outline" onClick={() => patchDraft({ customHeaders: [...customHeaders, { name: "", value: "" }] })}>
                    <Plus className="size-4" />
                    添加
                  </Button>
                </div>
                {customHeaders.length === 0 ? <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">没有自定义 Header</div> : null}
                {customHeaders.map((header, index) => (
                  <div key={index} className="grid gap-2 rounded-md border bg-muted/20 p-3 md:grid-cols-[1fr_1fr_auto]">
                    <Input value={textValue(header.name ?? header.key)} onChange={(event) => updateCustomHeader(index, { name: event.target.value })} placeholder="Header name" />
                    <Input value={textValue(header.value)} onChange={(event) => updateCustomHeader(index, { value: event.target.value })} placeholder="Header value" />
                    <Button type="button" size="icon-sm" variant="ghost" onClick={() => patchDraft({ customHeaders: customHeaders.filter((_, itemIndex) => itemIndex !== index) })}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm">Bodies</div>
                    <div className="text-xs text-muted-foreground">按 key 合并进请求体；value 可填写 JSON 或普通字符串。</div>
                  </div>
                  <Button type="button" size="sm" variant="outline" onClick={() => patchDraft({ customBodies: [...customBodies, { key: "", value: "\"\"" }] })}>
                    <Plus className="size-4" />
                    添加
                  </Button>
                </div>
                {customBodies.length === 0 ? <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">没有自定义 Body</div> : null}
                {customBodies.map((body, index) => (
                  <div key={index} className="rounded-md border bg-muted/20 p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <Input value={textValue(body.key ?? body.name)} onChange={(event) => updateCustomBody(index, { key: event.target.value })} placeholder="Body key" />
                      <Button type="button" size="icon-sm" variant="ghost" onClick={() => patchDraft({ customBodies: customBodies.filter((_, itemIndex) => itemIndex !== index) })}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    <Textarea
                      className="min-h-24 font-mono text-xs"
                      value={typeof body.value === "string" ? body.value : JSON.stringify(body.value ?? "", null, 2)}
                      onChange={(event) => updateCustomBody(index, { value: event.target.value })}
                      placeholder='"value" 或 {"extra": true}'
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="text-sm font-medium">拓展状态摘要</div>
            <div className="mt-2 grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
              <div>模式注入: {(draft.modeInjectionIds ?? []).length}</div>
              <div>世界书: {(draft.lorebookIds ?? []).length}</div>
              <div>MCP: {(draft.mcpServers ?? []).length}</div>
              <div>Local tools: {Array.isArray(draft.localTools) ? draft.localTools.length : 0}</div>
            </div>
          </div>
          <div className="flex justify-end">
            <Button variant="outline" onClick={removeAssistant} disabled={settings.assistants.length <= 1}>
              <Trash2 className="size-4" />
              删除
            </Button>
            <div className="flex items-center px-2 text-xs text-muted-foreground">已自动保存</div>
          </div>
        </div>
      </div>
    </>
  );
}

function SearchSection({ settings, onSettings }: { settings: Settings; onSettings: (settings: Settings) => void }) {
  const [selectedId, setSelectedId] = React.useState(String(settings.searchServices[settings.searchServiceSelected]?.id ?? settings.searchServices[0]?.id ?? ""));
  const selected = (settings.searchServices.find((item) => String(item.id) === selectedId) ?? settings.searchServices[0]) as Record<string, unknown> | undefined;
  const [draft, setDraft] = React.useState<Record<string, unknown>>(selected ? clone(selected) : createSearchService());
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState("");
  const dirtyRef = React.useRef(false);

  React.useEffect(() => {
    const next = (settings.searchServices.find((item) => String(item.id) === selectedId) ?? settings.searchServices[0]) as Record<string, unknown> | undefined;
    if (next) setDraft(clone(next));
    dirtyRef.current = false;
    setTestResult("");
  }, [selectedId, settings.searchServices]);

  const patchDraft = (patch: Record<string, unknown>) => {
    dirtyRef.current = true;
    setDraft({ ...draft, ...patch });
  };

  const moveSearchService = async (from: number, to: number) => {
    const searchServices = moveItem(settings.searchServices, from, to);
    const selectedId = settings.searchServices[settings.searchServiceSelected]?.id;
    const searchServiceSelected = Math.max(0, searchServices.findIndex((item) => item.id === selectedId));
    const next = { ...settings, searchServices, searchServiceSelected };
    onSettings(next);
    await api.post("settings/search/reorder", { ids: searchServices.map((item) => item.id), selectedId });
  };
  const selectService = async (index: number) => {
    setSelectedId(String(settings.searchServices[index]?.id ?? ""));
    onSettings({ ...settings, searchServiceSelected: index });
    await api.post("settings/search/service", { index });
  };
  const save = async () => {
    const result = await api.post<{ service: Record<string, unknown> }>("settings/search/service/detail", draft);
    const savedService = toSearchService(result.service);
    const exists = settings.searchServices.some((item) => String(item.id) === String(result.service.id));
    const searchServices = exists
      ? settings.searchServices.map((item) => (String(item.id) === String(savedService.id) ? savedService : item))
      : [...settings.searchServices, savedService];
    onSettings({ ...settings, searchServices, searchServiceSelected: searchServices.findIndex((item) => String(item.id) === String(savedService.id)) });
    setSelectedId(String(savedService.id));
    toast.success("搜索服务已保存");
  };
  React.useEffect(() => {
    if (!dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void api.post<{ service: Record<string, unknown> }>("settings/search/service/detail", draft)
        .then((result) => {
          dirtyRef.current = false;
          const savedService = toSearchService(result.service);
          const exists = settings.searchServices.some((item) => String(item.id) === String(savedService.id));
          const searchServices = exists
            ? settings.searchServices.map((item) => (String(item.id) === String(savedService.id) ? savedService : item))
            : [...settings.searchServices, savedService];
          onSettings({ ...settings, searchServices });
        })
        .catch((error: Error) => toast.error(error.message || "自动保存搜索服务失败"));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [draft, onSettings, settings]);
  const addService = () => {
    const service = createSearchService();
    void api.post<{ service: Record<string, unknown> }>("settings/search/service/detail", service)
      .then((result) => {
        const savedService = toSearchService(result.service);
        const searchServices = [...settings.searchServices, savedService];
        onSettings({ ...settings, searchServices, searchServiceSelected: searchServices.length - 1 });
        setDraft(savedService as unknown as Record<string, unknown>);
        setSelectedId(String(savedService.id));
        setTestResult("");
        toast.success("搜索服务已添加");
      })
      .catch((error: Error) => toast.error(error.message || "添加搜索服务失败"));
  };
  const test = async () => {
    setTesting(true);
    setTestResult("正在保存配置并发起搜索服务测试...");
    try {
      await save();
      const result = await api.post<{ endpoint: string; preview: string }>("settings/search/service/test", draft);
      setTestResult(`测试成功\n端点: ${result.endpoint}\n\n${result.preview}`);
      toast.success("搜索服务测试成功");
      // Refresh settings so the "已通过测试" badge updates (server marks testPassed on success).
      onSettings(await api.get<Settings>("settings"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "测试失败";
      setTestResult(message);
      toast.error(message);
    } finally {
      setTesting(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(`删除搜索服务「${textValue(draft.name) || textValue(draft.type)}」？`)) return;
    await api.delete(`settings/search/service/${encodeURIComponent(String(draft.id))}`);
    const searchServices = settings.searchServices.filter((item) => String(item.id) !== String(draft.id));
    onSettings({ ...settings, searchServices, searchServiceSelected: 0 });
    setSelectedId(String(searchServices[0]?.id ?? ""));
    toast.success("搜索服务已删除");
  };

  return (
    <>
      <SectionHeader icon={Search} title="搜索服务" subtitle="默认包含 Bing 和 RikkaHub，并保留 Tavily、Exa、智谱等模板。" />
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="space-y-2 rounded-lg border bg-card p-2">
          <Button className="w-full justify-start" variant="outline" onClick={addService}>
            <Plus className="size-4" />
            添加搜索服务
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
                <AIIcon name={searchServiceLabelForType(textValue(service.type))} size={30} className="justify-self-start" />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 truncate font-medium">
                    {(() => {
                      const type = String(service.type ?? "").toLowerCase();
                      const isPreset = type === "bing_local" || type === "rikkahub";
                      const passed = isPreset || (service as Record<string, unknown>).testPassed === true;
                      return (
                        <span
                          aria-hidden
                          className={cn("size-2 shrink-0 rounded-full", passed ? "bg-emerald-500" : "bg-muted-foreground/40")}
                          title={passed ? (isPreset ? "预置可用" : "已通过测试") : "未通过测试"}
                        />
                      );
                    })()}
                    <span className="truncate">{textValue(service.name) || searchServiceLabelForType(textValue(service.type))}</span>
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{textValue(service.type) || JSON.stringify(service)}</span>
                </span>
                {index === settings.searchServiceSelected ? <span className="shrink-0 text-xs text-primary">当前</span> : null}
              </span>
            </SortableRow>
          ))}
        </div>
        <div className="space-y-5 rounded-lg border bg-card p-5">
          <div className="flex items-center gap-3">
            <AIIcon name={searchServiceLabelForType(textValue(draft.type))} size={40} />
            <div>
              <div className="text-lg font-medium">{textValue(draft.name) || searchServiceLabelForType(textValue(draft.type)) || "搜索服务"}</div>
              <div className="text-xs text-muted-foreground">{textValue(draft.type) || "custom"}</div>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-2">
              <span className="text-sm font-medium">名称</span>
              <Input value={textValue(draft.name)} onChange={(event) => patchDraft({ name: event.target.value })} />
            </label>
            <label className="space-y-2">
              <span className="text-sm font-medium">类型</span>
              <Select
                value={textValue(draft.type) || "tavily"}
                onValueChange={(type) => {
                  // Re-sync `name` whenever it was still the previous type's default label —
                  // that way the row icon and detail-pane logo follow the chosen type. Manual
                  // names (anything not matching the canonical label) are preserved.
                  const previousType = textValue(draft.type);
                  const previousLabel = searchServiceLabelForType(previousType);
                  const currentName = textValue(draft.name);
                  const isDefaultName = !currentName || currentName === previousLabel || currentName === previousType;
                  patchDraft({
                    type,
                    name: isDefaultName ? searchServiceLabelForType(type) : currentName,
                    ...(type === "custom_js" && !textValue(draft.searchScript) ? { searchScript: DEFAULT_CUSTOM_JS_SEARCH_SCRIPT, scrapeScript: DEFAULT_CUSTOM_JS_SCRAPE_SCRIPT } : {}),
                  });
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["bing_local", "rikkahub", "tavily", "exa", "zhipu", "tinyfish", "brave", "perplexity", "bocha", "linkup", "metaso", "ollama", "jina", "firecrawl", "grok", "searxng", "custom_js"] as const).map((type) => (
                    <SelectItem key={type} value={type}>
                      <span className="flex items-center gap-2">
                        <AIIcon name={searchServiceLabelForType(type)} size={16} className="bg-transparent" />
                        {searchServiceLabelForType(type)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {textValue(draft.type) !== "searxng" && textValue(draft.type) !== "custom_js" ? (
              <label className="space-y-2 md:col-span-2">
                <span className="text-sm font-medium">API Key</span>
                <PasswordInput value={textValue(draft.apiKey)} onChange={(apiKey) => patchDraft({ apiKey })} />
              </label>
            ) : null}
            {textValue(draft.type) === "searxng" ? (
              <>
                <label className="space-y-2 md:col-span-2">
                  <span className="text-sm font-medium">SearXNG URL</span>
                  <Input value={textValue(draft.url)} onChange={(event) => patchDraft({ url: event.target.value })} placeholder="https://search.example.com" />
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium">Engines</span>
                  <Input value={textValue(draft.engines)} onChange={(event) => patchDraft({ engines: event.target.value })} placeholder="google,bing" />
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium">Language</span>
                  <Input value={textValue(draft.language)} onChange={(event) => patchDraft({ language: event.target.value })} placeholder="zh-CN" />
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium">Username</span>
                  <Input value={textValue(draft.username)} onChange={(event) => patchDraft({ username: event.target.value })} />
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium">Password</span>
                  <PasswordInput value={textValue(draft.password)} onChange={(password) => patchDraft({ password })} />
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
                    placeholder={"async function search(query, resultSize) {\n  const res = await fetch('https://example.com/search?q=' + encodeURIComponent(query));\n  const data = await res.json();\n  return { items: data.results.map((r) => ({ title: r.title, url: r.url, text: r.snippet })) };\n}"}
                  />
                </label>
                <label className="space-y-2 md:col-span-2">
                  <span className="text-sm font-medium">Scrape Script</span>
                  <Textarea
                    value={textValue(draft.scrapeScript)}
                    onChange={(event) => patchDraft({ scrapeScript: event.target.value })}
                    className="min-h-40 font-mono text-xs"
                    placeholder={"async function scrape(urls) {\n  return { urls: await Promise.all(urls.map(async (url) => {\n    const res = await fetch(url);\n    return { url, content: await res.text() };\n  })) };\n}"}
                  />
                </label>
              </>
            ) : null}
            <label className="space-y-2">
              <span className="text-sm font-medium">深度</span>
              <Select value={textValue(draft.depth) || "standard"} onValueChange={(depth) => patchDraft({ depth })}>
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
              <span className="text-sm font-medium">结果数量</span>
              <Input
                value={numberText(draft.resultSize ?? ((settings.searchCommonOptions as Record<string, unknown> | undefined)?.resultSize))}
                onChange={(event) => patchDraft({ resultSize: Number(event.target.value) || 10 })}
              />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={test} disabled={testing}>
              {testing ? <Loader2 className="size-4 animate-spin" /> : <Database className="size-4" />}
              测试
            </Button>
            <Button variant="outline" onClick={remove} disabled={!settings.searchServices.some((item) => String(item.id) === String(draft.id))}>
              <Trash2 className="size-4" />
              删除
            </Button>
            <div className="flex items-center px-2 text-xs text-muted-foreground">已自动保存</div>
          </div>
          {testResult ? <pre className="max-h-56 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap">{testResult}</pre> : null}
        </div>
      </div>
    </>
  );
}

function DefaultModelsSection({ settings, onSettings }: { settings: Settings; onSettings: (settings: Settings) => void }) {
  const allModels = settings.providers.flatMap((provider) =>
    isProviderTested(provider) ? (provider.models ?? []).map((model) => ({ ...model, providerName: provider.name })) : [],
  );
  // Image generation models live on providers that don't necessarily pass the chat test
  // (image-only providers like findcg gpt-image-2). Source them directly from enabled providers
  // and require an image-related capability marker (parity with images.tsx).
  const imageModels = settings.providers
    .filter((provider) => provider.enabled !== false)
    .flatMap((provider) => (provider.models ?? [])
      .filter((model) =>
        model.type === "IMAGE" ||
        model.outputModalities?.includes("IMAGE") ||
        model.tools?.some((tool) => String(tool.type ?? "").toLowerCase() === "image_generation"),
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
    titlePrompt: string;
    translatePrompt: string;
    suggestionPrompt: string;
    ocrPrompt: string;
    compressPrompt: string;
  };
  type ModelKey = "chatModelId" | "titleModelId" | "translateModeId" | "suggestionModelId" | "imageGenerationModelId" | "ocrModelId" | "compressModelId";
  type PromptKey = "titlePrompt" | "translatePrompt" | "suggestionPrompt" | "ocrPrompt" | "compressPrompt";
  const [draft, setDraft] = React.useState({
    chatModelId: textValue(settings.chatModelId),
    titleModelId: textValue(settings.titleModelId),
    translateModeId: textValue(settings.translateModeId),
    suggestionModelId: textValue(settings.suggestionModelId),
    imageGenerationModelId: textValue(settings.imageGenerationModelId),
    ocrModelId: textValue(settings.ocrModelId),
    compressModelId: textValue(settings.compressModelId),
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
      void save().catch((error: Error) => toast.error(error.message || "自动保存默认模型失败"));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [draft]);
  const modelSelect = (key: ModelKey) => {
    const options = key === "imageGenerationModelId" ? imageModels : allModels;
    return (
      <Select value={draft[key] || "__none"} onValueChange={(value) => setDraft({ ...draft, [key]: value === "__none" ? "" : value })}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none">未设置</SelectItem>
          {options.map((model) => (
            <SelectItem key={`${key}-${model.id}`} value={model.id}>
              {model.providerName} / {model.displayName || model.modelId}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  };
  const promptMeta: Record<PromptKey, { title: string; variables: string; defaultValue: string }> = {
    titlePrompt: { title: "标题生成 Prompt", variables: "{locale}, {content}", defaultValue: DEFAULT_PROMPTS.titlePrompt },
    translatePrompt: { title: "翻译 Prompt", variables: "{source_text}, {target_lang}", defaultValue: DEFAULT_PROMPTS.translatePrompt },
    suggestionPrompt: { title: "建议回复 Prompt", variables: "{locale}, {content}", defaultValue: DEFAULT_PROMPTS.suggestionPrompt },
    ocrPrompt: { title: "OCR Prompt", variables: "图片输入", defaultValue: DEFAULT_PROMPTS.ocrPrompt },
    compressPrompt: { title: "上下文压缩 Prompt", variables: "{content}, {target_tokens}, {additional_context}, {locale}", defaultValue: DEFAULT_PROMPTS.compressPrompt },
  };
  const features: Array<{
    modelKey: ModelKey;
    promptKey?: PromptKey;
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    description: string;
  }> = [
    { modelKey: "chatModelId", icon: Bot, title: "默认聊天模型", description: "首页未手动选择模型时使用。" },
    { modelKey: "titleModelId", promptKey: "titlePrompt", icon: NotebookText, title: "标题生成", description: "对话首次回复后读取最近消息自动生成会话标题。" },
    { modelKey: "translateModeId", promptKey: "translatePrompt", icon: Globe, title: "翻译", description: "AI 回复下方翻译按钮使用这个模型和 Prompt。" },
    { modelKey: "suggestionModelId", promptKey: "suggestionPrompt", icon: MessageSquareText, title: "建议回复", description: "回复完成后生成 3 到 5 条用户可点选建议。" },
    { modelKey: "compressModelId", promptKey: "compressPrompt", icon: FileClock, title: "上下文压缩", description: "长会话压缩时保留关键上下文并写回会话。" },
    { modelKey: "ocrModelId", promptKey: "ocrPrompt", icon: FileImage, title: "OCR", description: "图片转文字的备用通道，用于不支持视觉输入的聊天模型。" },
    { modelKey: "imageGenerationModelId", icon: WandSparkles, title: "图像生成", description: "用于支持具备图像生成能力的模型入口。" },
  ];
  const activePrompt = editingPrompt ? promptMeta[editingPrompt] : null;

  return (
    <>
      <SectionHeader icon={Settings2} title="默认模型与提示词" subtitle="为聊天、标题、翻译、建议、OCR、压缩等场景分别指定默认模型和 Prompt。" />
      <div className="space-y-4">
        <div className="rounded-md border bg-card p-3 text-sm text-muted-foreground">
          这里只显示已通过供应商测试的模型。标题、翻译、建议回复、OCR 和压缩 Prompt 均预置了合理的默认模板，点右侧工具按钮可查看和恢复默认值。
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
                    <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{feature.description}</div>
                  </div>
                  {feature.promptKey ? (
                    <Button type="button" variant="ghost" size="icon-sm" onClick={() => setEditingPrompt(feature.promptKey ?? null)} title="编辑 Prompt">
                      <Settings2 className="size-4" />
                    </Button>
                  ) : null}
                </div>
                {modelSelect(feature.modelKey)}
              </div>
            );
          })}
        </div>
        <div className="flex justify-end text-xs text-muted-foreground">已自动保存</div>
      </div>
      <Dialog open={Boolean(editingPrompt)} onOpenChange={(open) => !open && setEditingPrompt(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{activePrompt?.title ?? "Prompt"}</DialogTitle>
            <DialogDescription>变量：{activePrompt?.variables}</DialogDescription>
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
              <Button type="button" variant="outline" onClick={() => setDraft({ ...draft, [editingPrompt]: promptMeta[editingPrompt].defaultValue })}>
                <RefreshCw className="size-4" />
                恢复默认
              </Button>
            ) : null}
            <Button type="button" onClick={() => setEditingPrompt(null)}>完成</Button>
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
  if (type === "openai") return { ...base, name: "OpenAI TTS", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-tts", voice: "alloy" };
  if (type === "gemini") return { ...base, name: "Gemini TTS", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash-preview-tts", voiceName: "Kore" };
  if (type === "minimax") return { ...base, name: "MiniMax TTS", baseUrl: "https://api.minimaxi.com/v1", model: "speech-2.6-turbo", voiceId: "female-shaonv", emotion: "calm", speed: 1 };
  if (type === "qwen") return { ...base, name: "Qwen TTS", baseUrl: "https://dashscope.aliyuncs.com/api/v1", model: "qwen3-tts-flash", voice: "Cherry", languageType: "Auto" };
  if (type === "groq") return { ...base, name: "Groq TTS", baseUrl: "https://api.groq.com/openai/v1", model: "canopylabs/orpheus-v1-english", voice: "austin" };
  if (type === "xai") return { ...base, name: "xAI TTS", baseUrl: "https://api.x.ai/v1", voiceId: "eve", language: "auto" };
  if (type === "mimo") return { ...base, name: "MiMo TTS", baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2-tts", voice: "mimo_default" };
  return {
    ...base,
    id: "026a01a2-c3a0-4fd5-8075-80e03bdef200",
    name: "System TTS",
    speechRate: 1,
    pitch: 1,
  };
}

function TtsSettingsPanel({ settings, onSettings }: { settings: Settings; onSettings: (settings: Settings) => void }) {
  const providers = settings.ttsProviders ?? [];
  const [selectedId, setSelectedId] = React.useState(settings.selectedTTSProviderId ?? providers[0]?.id ?? "");
  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0];
  const [draft, setDraft] = React.useState<TtsProviderProfile | null>(selected ? clone(selected) : null);

  React.useEffect(() => {
    const next = providers.find((provider) => provider.id === selectedId) ?? providers[0];
    setDraft(next ? clone(next) : null);
  }, [providers, selectedId]);

  const saveProvider = React.useCallback(async (provider: TtsProviderProfile) => {
    const result = await api.post<{ provider: TtsProviderProfile }>("settings/tts-provider/detail", provider);
    const exists = providers.some((item) => item.id === result.provider.id);
    const ttsProviders = exists
      ? providers.map((item) => item.id === result.provider.id ? result.provider : item)
      : [result.provider, ...providers];
    onSettings({ ...settings, ttsProviders, selectedTTSProviderId: settings.selectedTTSProviderId ?? result.provider.id });
    setSelectedId(result.provider.id);
  }, [onSettings, providers, settings]);

  const patchDraft = React.useCallback((patch: Partial<TtsProviderProfile>) => {
    setDraft((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      window.setTimeout(() => void saveProvider(next).catch((error: Error) => toast.error(error.message)), 0);
      return next;
    });
  }, [saveProvider]);

  const addProvider = React.useCallback(async (type: TtsProviderType) => {
    await saveProvider(createTtsProvider(type));
  }, [saveProvider]);

  const reorderProviders = React.useCallback((from: number, to: number) => {
    const ttsProviders = moveItem(providers, from, to);
    onSettings({ ...settings, ttsProviders });
    void api.post("settings/tts-provider/reorder", { ids: ttsProviders.map((item) => item.id) }).catch((error: Error) => toast.error(error.message));
  }, [onSettings, providers, settings]);

  const selectProvider = React.useCallback(async (providerId: string) => {
    setSelectedId(providerId);
    await api.post("settings/tts-provider/select", { id: providerId });
    onSettings({ ...settings, selectedTTSProviderId: providerId });
  }, [onSettings, settings]);

  const removeProvider = React.useCallback(async () => {
    if (!draft || draft.type === "system") return;
    await api.delete(`settings/tts-provider/${encodeURIComponent(draft.id)}`);
    const ttsProviders = providers.filter((provider) => provider.id !== draft.id);
    onSettings({ ...settings, ttsProviders, selectedTTSProviderId: settings.selectedTTSProviderId === draft.id ? ttsProviders[0]?.id ?? null : settings.selectedTTSProviderId });
    setSelectedId(ttsProviders[0]?.id ?? "");
  }, [draft, onSettings, providers, settings]);

  const numericInput = (key: keyof TtsProviderProfile, label: string, description: string, min: number, max: number, step = 0.05) => {
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
              if (Number.isFinite(next)) patchDraft({ [key]: Math.min(max, Math.max(min, next)) } as Partial<TtsProviderProfile>);
            }}
          />
        </div>
        <Slider min={min} max={max} step={step} value={[Number.isFinite(value) ? value : 1]} onValueChange={([next]) => patchDraft({ [key]: next ?? 1 } as Partial<TtsProviderProfile>)} />
      </div>
    );
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between gap-3 border-b p-3">
          <div className="text-sm font-medium">TTS 服务</div>
          <Select onValueChange={(value) => void addProvider(value as TtsProviderType)}>
            <SelectTrigger className="h-8 w-28"><SelectValue placeholder="新增" /></SelectTrigger>
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
                  <span className="block truncate text-xs text-muted-foreground">{provider.type}</span>
                </span>
                {provider.id === settings.selectedTTSProviderId ? <Check className="size-4 shrink-0 text-primary" /> : null}
              </span>
            </SortableRow>
          ))}
          {providers.length === 0 ? <div className="p-6 text-center text-sm text-muted-foreground">暂无 TTS 服务，点击新增开始配置。</div> : null}
        </div>
      </div>

      {draft ? (
        <div className="space-y-4 rounded-lg border bg-card p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-lg font-semibold">{draft.name}</div>
              <div className="text-sm text-muted-foreground">消息下方语音播报会调用当前 provider，并写入请求日志。</div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant={draft.id === settings.selectedTTSProviderId ? "secondary" : "outline"} onClick={() => void selectProvider(draft.id)}>
                {draft.id === settings.selectedTTSProviderId ? "已选择" : "设为当前"}
              </Button>
              {draft.type !== "system" ? <Button variant="outline" onClick={() => void removeProvider()}><Trash2 className="size-4" />删除</Button> : null}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <div className="text-sm font-medium">名称</div>
              <Input value={draft.name} onChange={(event) => patchDraft({ name: event.target.value })} />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium">类型</div>
              <Input value={draft.type} readOnly />
            </div>
            {draft.type !== "system" ? (
              <>
                <div className="space-y-2 md:col-span-2">
                  <div className="text-sm font-medium">API Key</div>
                  <PasswordInput value={draft.apiKey ?? ""} onChange={(apiKey) => patchDraft({ apiKey })} />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <div className="text-sm font-medium">Base URL</div>
                  <Input value={draft.baseUrl ?? ""} onChange={(event) => patchDraft({ baseUrl: event.target.value })} />
                </div>
                {draft.type !== "xai" ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">模型</div>
                    <Input value={draft.model ?? ""} onChange={(event) => patchDraft({ model: event.target.value })} />
                  </div>
                ) : null}
                {draft.type === "gemini" ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Voice Name</div>
                    <Input value={draft.voiceName ?? ""} onChange={(event) => patchDraft({ voiceName: event.target.value })} />
                  </div>
                ) : null}
                {draft.type === "minimax" || draft.type === "xai" ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Voice ID</div>
                    <Input value={draft.voiceId ?? ""} onChange={(event) => patchDraft({ voiceId: event.target.value })} />
                  </div>
                ) : null}
                {draft.type === "openai" || draft.type === "qwen" || draft.type === "groq" || draft.type === "mimo" ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Voice</div>
                    <Input value={draft.voice ?? ""} onChange={(event) => patchDraft({ voice: event.target.value })} />
                  </div>
                ) : null}
                {draft.type === "qwen" ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Language Type</div>
                    <Input value={draft.languageType ?? ""} onChange={(event) => patchDraft({ languageType: event.target.value })} />
                  </div>
                ) : null}
                {draft.type === "xai" ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Language</div>
                    <Input value={draft.language ?? ""} onChange={(event) => patchDraft({ language: event.target.value })} />
                  </div>
                ) : null}
                {draft.type === "minimax" ? (
                  <>
                    <div className="space-y-2">
                      <div className="text-sm font-medium">Emotion</div>
                      <Input value={draft.emotion ?? ""} onChange={(event) => patchDraft({ emotion: event.target.value })} />
                    </div>
                    <div className="md:col-span-2">{numericInput("speed", "Speed", "MiniMax 语速。", 0.5, 2, 0.05)}</div>
                  </>
                ) : null}
              </>
            ) : (
              <div className="space-y-5 md:col-span-2">
                {numericInput("speechRate", "Speech Rate", "Windows System.Speech 语速，1 为默认。", 0.2, 3, 0.05)}
                {numericInput("pitch", "Pitch", "Windows 系统语音当前不支持直接调整音高，此设置仅会随配置导出。", 0.2, 3, 0.05)}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">请选择或新增 TTS 服务。</div>
      )}
    </div>
  );
}

function SpeechSection({ settings, onSettings }: { settings: Settings; onSettings: (settings: Settings) => void }) {
  const providers = settings.asrProviders ?? [];
  const [selectedId, setSelectedId] = React.useState(settings.selectedASRProviderId ?? providers[0]?.id ?? "");
  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0];
  const [draft, setDraft] = React.useState<AsrProviderProfile | null>(selected ? clone(selected) : null);

  React.useEffect(() => {
    const next = providers.find((provider) => provider.id === selectedId) ?? providers[0];
    setDraft(next ? clone(next) : null);
  }, [providers, selectedId]);

  const saveProvider = React.useCallback(async (provider: AsrProviderProfile) => {
    const result = await api.post<{ provider: AsrProviderProfile }>("settings/asr-provider/detail", provider);
    const exists = providers.some((item) => item.id === result.provider.id);
    const asrProviders = exists
      ? providers.map((item) => item.id === result.provider.id ? result.provider : item)
      : [result.provider, ...providers];
    onSettings({ ...settings, asrProviders, selectedASRProviderId: settings.selectedASRProviderId ?? result.provider.id });
    setSelectedId(result.provider.id);
  }, [onSettings, providers, settings]);

  const patchDraft = React.useCallback((patch: Partial<AsrProviderProfile>) => {
    setDraft((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      window.setTimeout(() => void saveProvider(next).catch((error: Error) => toast.error(error.message)), 0);
      return next;
    });
  }, [saveProvider]);

  const addProvider = React.useCallback(async (type: AsrProviderType) => {
    const provider = createAsrProvider(type);
    await saveProvider(provider);
  }, [saveProvider]);

  const reorderProviders = React.useCallback((from: number, to: number) => {
    const asrProviders = moveItem(providers, from, to);
    onSettings({ ...settings, asrProviders });
    void api.post("settings/asr-provider/reorder", { ids: asrProviders.map((item) => item.id) }).catch((error: Error) => toast.error(error.message));
  }, [onSettings, providers, settings]);

  const selectProvider = React.useCallback(async (providerId: string) => {
    setSelectedId(providerId);
    await api.post("settings/asr-provider/select", { id: providerId });
    onSettings({ ...settings, selectedASRProviderId: providerId });
  }, [onSettings, settings]);

  const removeProvider = React.useCallback(async () => {
    if (!draft) return;
    await api.delete(`settings/asr-provider/${encodeURIComponent(draft.id)}`);
    const asrProviders = providers.filter((provider) => provider.id !== draft.id);
    onSettings({ ...settings, asrProviders, selectedASRProviderId: settings.selectedASRProviderId === draft.id ? asrProviders[0]?.id ?? null : settings.selectedASRProviderId });
    setSelectedId(asrProviders[0]?.id ?? "");
  }, [draft, onSettings, providers, settings]);

  const numericInput = (key: keyof AsrProviderProfile, label: string, description: string, min: number, max: number, step = 1) => {
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
              if (Number.isFinite(next)) patchDraft({ [key]: Math.min(max, Math.max(min, next)) } as Partial<AsrProviderProfile>);
            }}
          />
        </div>
        <Slider min={min} max={max} step={step} value={[Number.isFinite(value) ? value : min]} onValueChange={([next]) => patchDraft({ [key]: next ?? min } as Partial<AsrProviderProfile>)} />
      </div>
    );
  };

  return (
    <>
      <SectionHeader icon={Mic} title="文字转语音" subtitle="TTS provider 用于消息语音播报，ASR provider 用于输入框实时语音识别。" />
      <TtsSettingsPanel settings={settings} onSettings={onSettings} />
      <Separator className="my-8" />
      <SectionHeader icon={Mic} title="语音识别" subtitle="支持 OpenAI Realtime、DashScope、Volcengine；通过实时 PCM WebSocket 完成转写。" />
      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div className="rounded-lg border bg-card">
          <div className="flex items-center justify-between gap-3 border-b p-3">
            <div className="text-sm font-medium">ASR 服务</div>
            <Select onValueChange={(value) => void addProvider(value as AsrProviderType)}>
              <SelectTrigger className="h-8 w-28"><SelectValue placeholder="新增" /></SelectTrigger>
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
                    <span className="block truncate text-xs text-muted-foreground">{provider.type}</span>
                  </span>
                  {provider.id === settings.selectedASRProviderId ? <Check className="size-4 shrink-0 text-primary" /> : null}
                </span>
              </SortableRow>
            ))}
            {providers.length === 0 ? <div className="p-6 text-center text-sm text-muted-foreground">暂无 ASR 服务，点击新增开始配置。</div> : null}
          </div>
        </div>

        {draft ? (
          <div className="space-y-4 rounded-lg border bg-card p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-lg font-semibold">{draft.name}</div>
                <div className="text-sm text-muted-foreground">为每个 ASR provider 配置鉴权与音频参数。</div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant={draft.id === settings.selectedASRProviderId ? "secondary" : "outline"} onClick={() => void selectProvider(draft.id)}>
                  {draft.id === settings.selectedASRProviderId ? "已选择" : "设为当前"}
                </Button>
                <Button variant="outline" onClick={() => void removeProvider()}><Trash2 className="size-4" />删除</Button>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <div className="text-sm font-medium">名称</div>
                <Input value={draft.name} onChange={(event) => patchDraft({ name: event.target.value })} />
              </div>
              <div className="space-y-2">
                <div className="text-sm font-medium">类型</div>
                <Input value={draft.type} readOnly />
              </div>
              <div className="space-y-2 md:col-span-2">
                <div className="text-sm font-medium">API Key</div>
                <PasswordInput value={draft.apiKey ?? ""} onChange={(apiKey) => patchDraft({ apiKey })} />
              </div>
              <div className="space-y-2 md:col-span-2">
                <div className="text-sm font-medium">WebSocket URL</div>
                <Input value={draft.websocketUrl ?? ""} onChange={(event) => patchDraft({ websocketUrl: event.target.value })} />
              </div>
              {draft.type !== "volcengine" ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium">模型</div>
                  <Input value={draft.model ?? ""} onChange={(event) => patchDraft({ model: event.target.value })} placeholder={draft.type === "dashscope" ? "qwen3-asr-flash-realtime" : "gpt-4o-transcribe"} />
                </div>
              ) : null}
              {draft.type === "volcengine" ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium">Resource ID</div>
                  <Input value={draft.resourceId ?? ""} onChange={(event) => patchDraft({ resourceId: event.target.value })} placeholder="volc.seedasr.sauc.duration" />
                </div>
              ) : null}
              <div className="space-y-2">
                <div className="text-sm font-medium">语言</div>
                <Input value={draft.language ?? ""} onChange={(event) => patchDraft({ language: event.target.value })} placeholder={draft.type === "dashscope" ? "zh" : "auto"} />
              </div>
              {draft.type === "openai_realtime" ? (
                <div className="space-y-2 md:col-span-2">
                  <div className="text-sm font-medium">Prompt</div>
                  <Textarea value={draft.prompt ?? ""} onChange={(event) => patchDraft({ prompt: event.target.value })} placeholder="Optional" />
                </div>
              ) : null}
            </div>
            <div className="space-y-5">
              {draft.type !== "volcengine" ? numericInput("sampleRate", "Sample Rate", "默认 OpenAI 24000，DashScope 16000。", 8000, 48000, 1000) : null}
              {draft.type !== "volcengine" ? numericInput("vadThreshold", "VAD Threshold", "语音活动检测阈值。", 0, 1, 0.05) : null}
              {draft.type === "openai_realtime" ? numericInput("prefixPaddingMs", "Prefix Padding", "默认 300ms。", 0, 2000, 50) : null}
              {draft.type !== "volcengine" ? numericInput("silenceDurationMs", "Silence Duration", "静音结束判定时长。", 100, 5000, 100) : null}
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">请选择或新增 ASR 服务。</div>
        )}
      </div>
    </>
  );
}

function McpExtensionsSection({ settings, onSettings }: { settings: Settings; onSettings: (settings: Settings) => void }) {
  type Tab = "mcp" | "mode" | "lorebook" | "quick" | "skills";
  const tabFromQuery = React.useMemo<Tab>(() => {
    if (typeof window === "undefined") return "mcp";
    const value = new URLSearchParams(window.location.search).get("tab");
    return value === "mcp" || value === "mode" || value === "lorebook" || value === "quick" || value === "skills"
      ? value
      : "mcp";
  }, []);
  const [tab, setTab] = React.useState<Tab>(tabFromQuery);
  const [selectedAssistantId, setSelectedAssistantId] = React.useState(settings.assistantId);
  const selectedAssistant = settings.assistants.find((item) => item.id === selectedAssistantId) ?? settings.assistants[0];

  React.useEffect(() => {
    if (!settings.assistants.some((item) => item.id === selectedAssistantId)) setSelectedAssistantId(settings.assistantId);
  }, [selectedAssistantId, settings.assistantId, settings.assistants]);

  return (
    <>
      <SectionHeader icon={CopyPlus} title="MCP 与拓展" subtitle="管理 MCP 服务器、模式注入、世界书、快捷消息与 Agent Skills。" />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {([
          ["mcp", "MCP", CopyPlus],
          ["mode", "模式注入", WandSparkles],
          ["lorebook", "世界书", Database],
          ["quick", "快捷消息", MessageSquareText],
          ["skills", "Skills", Bot],
        ] as Array<[Tab, string, React.ComponentType<{ className?: string }>]>).map(([idValue, label, Icon]) => (
          <Button key={String(idValue)} variant={tab === idValue ? "default" : "outline"} size="sm" onClick={() => setTab(idValue as Tab)}>
            {React.createElement(Icon as React.ComponentType<{ className?: string }>, { className: "size-4" })}
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
                <SelectItem key={assistant.id} value={assistant.id}>{assistant.name || "默认助手"}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {tab === "mcp" && <McpServerEditor settings={settings} assistant={selectedAssistant} onSettings={onSettings} />}
      {tab === "mode" && <ModeInjectionEditor settings={settings} assistant={selectedAssistant} onSettings={onSettings} />}
      {tab === "lorebook" && <LorebookEditor settings={settings} assistant={selectedAssistant} onSettings={onSettings} />}
      {tab === "quick" && <QuickMessageEditor settings={settings} assistant={selectedAssistant} onSettings={onSettings} />}
      {tab === "skills" && <SkillsEditor settings={settings} assistant={selectedAssistant} onSettings={onSettings} />}
    </>
  );
}

function prettyJson(value: unknown) {
  return JSON.stringify(value ?? [], null, 2);
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    void fallback;
    throw new Error("JSON 格式不正确");
  }
}

async function pullSettings(onSettings: (settings: Settings) => void) {
  const next = await api.get<Settings>("settings");
  onSettings(next);
  return next;
}

function mcpName(server: Record<string, unknown>) {
  const common = server.commonOptions && typeof server.commonOptions === "object" ? server.commonOptions as Record<string, unknown> : {};
  return textValue(common.name) || "MCP Server";
}

function mcpStatus(server: Record<string, unknown>) {
  const common = server.commonOptions && typeof server.commonOptions === "object" ? server.commonOptions as Record<string, unknown> : {};
  if (common.enable === false) return { ok: false, label: "已关闭" };
  if (common.connected === false || textValue(common.lastSyncError)) return { ok: false, label: "连接异常" };
  return { ok: true, label: "已连接" };
}

function McpServerEditor({ settings, assistant, onSettings }: { settings: Settings; assistant: AssistantProfile; onSettings: (settings: Settings) => void }) {
  const servers = (settings.mcpServers ?? []) as Array<Record<string, unknown>>;
  const [selectedId, setSelectedId] = React.useState(textValue(servers[0]?.id));
  const selected = servers.find((item) => String(item.id) === selectedId) ?? servers[0] ?? createMcpServer();
  const [draft, setDraft] = React.useState<Record<string, unknown>>(clone(selected));
  const [headersText, setHeadersText] = React.useState(prettyJson((selected.commonOptions as Record<string, unknown> | undefined)?.headers ?? []));
  const [toolsText, setToolsText] = React.useState(prettyJson((selected.commonOptions as Record<string, unknown> | undefined)?.tools ?? []));
  const [busy, setBusy] = React.useState(false);
  const dirtyRef = React.useRef(false);

  React.useEffect(() => {
    const next = servers.find((item) => String(item.id) === selectedId) ?? servers[0];
    if (!next) return;
    setSelectedId(String(next.id));
    setDraft(clone(next));
    setHeadersText(prettyJson((next.commonOptions as Record<string, unknown> | undefined)?.headers ?? []));
    setToolsText(prettyJson((next.commonOptions as Record<string, unknown> | undefined)?.tools ?? []));
    dirtyRef.current = false;
  }, [selectedId, settings.mcpServers]);

  const common = draft.commonOptions && typeof draft.commonOptions === "object" ? draft.commonOptions as Record<string, unknown> : {};
  const tools = Array.isArray(common.tools) ? common.tools as Array<Record<string, unknown>> : [];
  const patchDraft = (nextDraft: Record<string, unknown>) => {
    dirtyRef.current = true;
    setDraft(nextDraft);
  };
  const patchCommon = (patch: Record<string, unknown>) => {
    let parsedHeaders: unknown[];
    let parsedTools: unknown[];
    try {
      parsedHeaders = parseJson<unknown[]>(headersText, []);
      parsedTools = parseJson<unknown[]>(toolsText, []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "JSON 格式不正确");
      return;
    }
    const nextDraft = { ...draft, commonOptions: { ...common, ...patch } };
    setDraft(nextDraft);
    void api.post<{ server: Record<string, unknown> }>("settings/mcp-server/detail", {
      ...nextDraft,
      commonOptions: {
        ...(nextDraft.commonOptions as Record<string, unknown>),
        headers: parsedHeaders,
        tools: parsedTools,
      },
    }).then((result: { server: Record<string, unknown> }) => {
      setSelectedId(String(result.server.id));
      dirtyRef.current = false;
      return pullSettings(onSettings);
    }).catch((error) => {
      toast.error(error instanceof Error ? error.message : "保存失败");
    });
  };
  const save = async (announce = true) => {
    if (!announce && !dirtyRef.current) return;
    setBusy(true);
    try {
      const payload = {
        ...draft,
        commonOptions: {
          ...common,
          headers: parseJson<unknown[]>(headersText, []),
          tools: parseJson<unknown[]>(toolsText, []),
        },
      };
      const result = await api.post<{ server: Record<string, unknown> }>("settings/mcp-server/detail", payload);
      setSelectedId(String(result.server.id));
      dirtyRef.current = false;
      await pullSettings(onSettings);
      if (announce) toast.success("MCP 服务器已保存");
    } catch (error) {
      if (announce) toast.error(error instanceof Error ? error.message : "保存失败");
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
    if (!selected.id || !window.confirm("删除这个 MCP 服务器？")) return;
    await api.delete(`settings/mcp-server/${encodeURIComponent(String(selected.id))}`);
    setSelectedId("");
    await pullSettings(onSettings);
    toast.success("已删除 MCP 服务器");
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
      emptyLabel="还没有 MCP 服务器"
      onSelect={setSelectedId}
      onMove={reorder}
      titleOf={mcpName}
      renderItem={(item) => {
        const status = mcpStatus(item);
        return (
          <div className="flex min-w-0 items-center gap-2 text-left">
            <span className={`size-2 shrink-0 rounded-full ${status.ok ? "bg-emerald-500" : "bg-red-500"}`} title={status.label} />
            <span className="truncate">{mcpName(item)}</span>
          </div>
        );
      }}
      onCreate={() => {
        const next = createMcpServer();
        setSelectedId(String(next.id));
        setDraft(next);
        setHeadersText("[]");
        setToolsText("[]");
        dirtyRef.current = true;
      }}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">服务器详情</div>
            <div className="text-xs text-muted-foreground">启用后会自动连接并同步 tools/list；在首页 MCP 选择器里决定当前助手是否使用它。</div>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">名称</span>
              <Input value={textValue(common.name)} onChange={(event) => patchDraft({ ...draft, commonOptions: { ...common, name: event.target.value } })} placeholder="名称" />
          </label>
          <label className="flex items-end gap-2 pb-1">
            <span className="pb-2 text-sm text-muted-foreground">启用</span>
            <Switch checked={common.enable !== false} onCheckedChange={(checked) => patchCommon({ enable: checked })} />
          </label>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Select value={textValue(draft.type) || "streamable_http"} onValueChange={(value) => patchDraft({ ...draft, type: value })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="streamable_http">Streamable HTTP</SelectItem>
              <SelectItem value="sse">SSE</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">服务地址</span>
          <Input value={textValue(draft.url)} onChange={(event) => patchDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp" />
          <span className="block text-xs text-muted-foreground">MCP 服务器的 Streamable HTTP / SSE 入口地址。</span>
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">请求头 JSON</span>
          <Textarea value={headersText} onChange={(event) => { dirtyRef.current = true; setHeadersText(event.target.value); }} className="min-h-24 font-mono text-xs" placeholder='[["Authorization","Bearer ..."]]' />
          <span className="block text-xs text-muted-foreground">用于鉴权或自定义 Header，格式为键值数组。</span>
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">工具列表 JSON</span>
          <Textarea value={toolsText} onChange={(event) => { dirtyRef.current = true; setToolsText(event.target.value); }} className="h-44 max-h-44 font-mono text-xs" placeholder="启用并保存后自动写入 tools/list 的结果，也可以手动编辑 enable 字段" />
          <span className="block text-xs text-muted-foreground">
            自动保存启用的 MCP 服务时会同步工具。{textValue(common.lastSyncError) ? `最近错误：${textValue(common.lastSyncError)}` : ""}
          </span>
        </label>
        <div className="rounded-md border">
          <div className="border-b px-3 py-2 text-sm font-medium">工具</div>
          <div className="max-h-64 overflow-auto p-2">
            {tools.length === 0 ? <div className="p-3 text-sm text-muted-foreground">启用并保存后会自动同步工具。</div> : null}
            {tools.map((tool) => (
              <div key={textValue(tool.name)} className="rounded-md px-2 py-2 text-sm hover:bg-muted/40">
                <div className="flex items-center gap-2">
                  <span className={`size-2 rounded-full ${tool.enable === false ? "bg-red-500" : "bg-emerald-500"}`} />
                  <span className="font-medium">{textValue(tool.name) || "unnamed_tool"}</span>
                </div>
                {textValue(tool.description) ? <div className="mt-1 line-clamp-2 pl-4 text-xs text-muted-foreground">{textValue(tool.description)}</div> : null}
              </div>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <div className="mr-auto flex items-center px-2 text-xs text-muted-foreground">{busy ? "正在自动保存..." : "已自动保存"}</div>
          <Button variant="destructive" onClick={() => void remove()} disabled={!selected.id}><Trash2 className="size-4" />删除</Button>
        </div>
      </div>
    </EditorShell>
  );
}

function createMcpServer(): Record<string, unknown> {
  return { id: crypto.randomUUID(), type: "streamable_http", url: "", commonOptions: { enable: true, name: "MCP Server", headers: [], tools: [] } };
}

function ModeInjectionEditor({ settings, assistant, onSettings }: { settings: Settings; assistant: AssistantProfile; onSettings: (settings: Settings) => void }) {
  const items = (settings.modeInjections ?? []) as Array<Record<string, unknown>>;
  const [selectedId, setSelectedId] = React.useState(textValue(items[0]?.id));
  const selected = items.find((item) => String(item.id) === selectedId) ?? items[0] ?? createModeInjection();
  const [draft, setDraft] = React.useState<Record<string, unknown>>(clone(selected));
  React.useEffect(() => {
    const next = items.find((item) => String(item.id) === selectedId) ?? items[0];
    if (next) {
      setSelectedId(String(next.id));
      setDraft(clone(next));
    }
  }, [selectedId, settings.modeInjections]);
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
      title="模式注入"
    />
  );
}

function createModeInjection(): Record<string, unknown> {
  return { id: crypto.randomUUID(), type: "mode", name: "模式注入", enabled: true, priority: 0, position: "after_system_prompt", role: "USER", injectDepth: 4, content: "" };
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
  const [expanded, setExpanded] = React.useState(false);
  const patch = (next: Partial<Record<string, unknown>>) => onChange({ ...entry, ...next });
  const keywords = Array.isArray(entry.keywords) ? entry.keywords.map(String) : [];
  const position = textValue(entry.position) || "after_system_prompt";
  const usesStandaloneMessage = position === "top_of_chat" || position === "bottom_of_chat" || position === "at_depth";
  const constantActive = entry.constantActive === true;
  const triggerSummary = constantActive
    ? "常驻激活"
    : keywords.length > 0
      ? `关键词 (${keywords.length})`
      : "未配置触发条件";
  return (
    <div className="rounded-md border bg-background">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className={cn("size-2 rounded-full", entry.enabled === false ? "bg-muted-foreground/40" : "bg-emerald-500")} />
          <span className="truncate text-sm font-medium">{textValue(entry.name) || `条目 ${index + 1}`}</span>
          <span className="shrink-0 text-xs text-muted-foreground">· {triggerSummary}</span>
        </span>
        <ChevronDownChip expanded={expanded} />
      </button>
      {expanded ? (
        <div className="space-y-3 border-t px-3 py-3">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">名称</span>
              <Input value={textValue(entry.name)} onChange={(event) => patch({ name: event.target.value })} placeholder="（可选）条目名称" />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">优先级</span>
              <Input type="number" value={numberText(entry.priority)} onChange={(event) => patch({ priority: Number(event.target.value) })} placeholder="0" />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">注入位置</span>
              <Select value={position} onValueChange={(value) => patch({ position: value })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="before_system_prompt">系统前</SelectItem>
                  <SelectItem value="after_system_prompt">系统后</SelectItem>
                  <SelectItem value="top_of_chat">对话顶部</SelectItem>
                  <SelectItem value="bottom_of_chat">对话底部</SelectItem>
                  <SelectItem value="at_depth">指定深度</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {usesStandaloneMessage ? (
              <label className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">角色</span>
                <Select value={textValue(entry.role) || "USER"} onValueChange={(value) => patch({ role: value })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USER">User</SelectItem>
                    <SelectItem value="ASSISTANT">Assistant</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            ) : null}
            {position === "at_depth" ? (
              <label className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">注入深度</span>
                <Input type="number" min={1} value={numberText(entry.injectDepth ?? 4)} onChange={(event) => patch({ injectDepth: Math.max(1, Number(event.target.value) || 4) })} placeholder="4" />
              </label>
            ) : null}
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">扫描深度（最近 N 条消息）</span>
              <Input type="number" min={1} value={numberText(entry.scanDepth ?? 4)} onChange={(event) => patch({ scanDepth: Math.max(1, Number(event.target.value) || 4) })} placeholder="4" />
            </label>
          </div>
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">关键词（按 Enter 添加；未启用常驻时需匹配上下文才触发）</span>
            <KeywordChipInput
              keywords={keywords}
              disabled={constantActive}
              onChange={(next) => patch({ keywords: next })}
            />
          </label>
          <div className="grid gap-2 md:grid-cols-3">
            <label className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <span>使用正则</span>
              <Switch checked={entry.useRegex === true} onCheckedChange={(checked) => patch({ useRegex: checked })} disabled={constantActive} />
            </label>
            <label className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <span>大小写敏感</span>
              <Switch checked={entry.caseSensitive === true} onCheckedChange={(checked) => patch({ caseSensitive: checked })} disabled={constantActive} />
            </label>
            <label className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <span>常驻激活</span>
              <Switch checked={constantActive} onCheckedChange={(checked) => patch({ constantActive: checked })} />
            </label>
          </div>
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">注入内容</span>
            <Textarea
              value={textValue(entry.content)}
              onChange={(event) => patch({ content: event.target.value })}
              className="min-h-32 font-mono text-xs leading-relaxed"
              placeholder="触发后注入的提示词"
            />
          </label>
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={entry.enabled !== false} onCheckedChange={(checked) => patch({ enabled: checked })} />
              <span>启用本条</span>
            </label>
            <Button type="button" variant="ghost" size="sm" onClick={onDelete}>
              <Trash2 className="size-4" />
              删除条目
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

function KeywordChipInput({ keywords, disabled, onChange }: { keywords: string[]; disabled?: boolean; onChange: (next: string[]) => void }) {
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
    <div className={cn("flex flex-wrap items-center gap-1 rounded-md border bg-background px-2 py-1.5", disabled && "opacity-50")}>
      {keywords.map((keyword) => (
        <span key={keyword} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
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
        placeholder={disabled ? "常驻激活时无需关键词" : "输入关键词后按 Enter"}
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

function LorebookEditor({ settings, assistant, onSettings }: { settings: Settings; assistant: AssistantProfile; onSettings: (settings: Settings) => void }) {
  const items = (settings.lorebooks ?? []) as Array<Record<string, unknown>>;
  const [selectedId, setSelectedId] = React.useState(textValue(items[0]?.id));
  const selected = items.find((item) => String(item.id) === selectedId) ?? items[0] ?? createLorebook();
  const [draft, setDraft] = React.useState<Record<string, unknown>>(clone(selected));
  const dirtyRef = React.useRef(false);
  React.useEffect(() => {
    const next = items.find((item) => String(item.id) === selectedId) ?? items[0];
    if (!next) return;
    setSelectedId(String(next.id));
    setDraft(clone(next));
    dirtyRef.current = false;
  }, [selectedId, settings.lorebooks]);
  const entries = Array.isArray(draft.entries) ? (draft.entries as Array<Record<string, unknown>>) : [];
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
    if (announce) toast.success("世界书已保存");
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
      emptyLabel="还没有世界书"
      onSelect={setSelectedId}
      titleOf={(item) => textValue(item.name) || "世界书"}
      onMove={async (from, to) => {
        const next = moveItem(items, from, to);
        onSettings({ ...settings, lorebooks: next as unknown as Settings["lorebooks"] });
        await api.post("settings/lorebook/reorder", { ids: next.map((item) => String(item.id)) });
      }}
      onCreate={() => {
        const next = createLorebook();
        setSelectedId(String(next.id));
        setDraft(next);
        dirtyRef.current = true;
      }}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">世界书详情</div>
          <Switch checked={(assistant.lorebookIds ?? []).includes(String(draft.id))} onCheckedChange={(checked) => void bind(checked)} />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">名称</span>
            <Input value={textValue(draft.name)} onChange={(event) => patchDraft({ name: event.target.value })} placeholder="世界书名称" />
          </label>
          <label className="flex items-end gap-2">
            <span className="flex-1 space-y-1">
              <span className="text-xs font-medium text-muted-foreground">启用整个世界书</span>
              <div className="rounded-md border px-3 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span>{draft.enabled === false ? "已禁用" : "已启用"}</span>
                  <Switch checked={draft.enabled !== false} onCheckedChange={(checked) => patchDraft({ enabled: checked })} />
                </div>
              </div>
            </span>
          </label>
        </div>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">描述</span>
          <Input value={textValue(draft.description)} onChange={(event) => patchDraft({ description: event.target.value })} placeholder="（可选）说明这个世界书的用途" />
        </label>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">条目（{entries.length}）</div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEntries([...entries, createLorebookEntry()])}
            >
              <Plus className="size-4" />
              添加条目
            </Button>
          </div>
          <div className="space-y-2">
            {entries.length === 0 ? (
              <div className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
                还没有条目。点击"添加条目"开始。
              </div>
            ) : null}
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
        </div>
        <div className="flex justify-end gap-2">
          <div className="mr-auto flex items-center px-2 text-xs text-muted-foreground">已自动保存</div>
          <Button variant="destructive" onClick={async () => { await api.delete(`settings/lorebook/${draft.id}`); await pullSettings(onSettings); }}><Trash2 className="size-4" />删除世界书</Button>
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

function QuickMessageEditor({ settings, assistant, onSettings }: { settings: Settings; assistant: AssistantProfile; onSettings: (settings: Settings) => void }) {
  const items = (settings.quickMessages ?? []) as unknown as Array<Record<string, unknown>>;
  const [selectedId, setSelectedId] = React.useState(textValue(items[0]?.id));
  const selected = items.find((item) => String(item.id) === selectedId) ?? items[0] ?? { id: crypto.randomUUID(), title: "", content: "" };
  const [draft, setDraft] = React.useState<Record<string, unknown>>(clone(selected));
  const dirtyRef = React.useRef(false);
  React.useEffect(() => {
    const next = items.find((item) => String(item.id) === selectedId) ?? items[0];
    if (next) {
      setSelectedId(String(next.id));
      setDraft(clone(next));
      dirtyRef.current = false;
    }
  }, [selectedId, settings.quickMessages]);
  const patchDraft = (patch: Record<string, unknown>) => {
    dirtyRef.current = true;
    setDraft({ ...draft, ...patch });
  };
  const save = React.useCallback(async (announce = false) => {
    if (!announce && !dirtyRef.current) return;
    await api.post("settings/quick-message/detail", draft);
    dirtyRef.current = false;
    await pullSettings(onSettings);
    if (announce) toast.success("快捷消息已保存");
  }, [draft, onSettings]);
  React.useEffect(() => {
    if (!dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void save(false).catch((error: Error) => console.warn("Quick message auto-save failed", error));
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
      emptyLabel="还没有快捷消息"
      onSelect={setSelectedId}
      titleOf={(item) => textValue(item.title) || "快捷消息"}
      onMove={async (from, to) => {
        const next = moveItem(items, from, to);
        onSettings({ ...settings, quickMessages: next as unknown as Settings["quickMessages"] });
        await api.post("settings/quick-message/reorder", { ids: next.map((item) => String(item.id)) });
      }}
      onCreate={() => {
        const next = { id: crypto.randomUUID(), title: "快捷消息", content: "" };
        setSelectedId(String(next.id));
        setDraft(next);
        dirtyRef.current = true;
      }}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">快捷消息详情</div>
          <Switch checked={(assistant.quickMessageIds ?? []).includes(String(draft.id))} onCheckedChange={(checked) => void bind(checked)} />
        </div>
        <Input value={textValue(draft.title)} onChange={(event) => patchDraft({ title: event.target.value })} placeholder="标题" />
        <Textarea value={textValue(draft.content)} onChange={(event) => patchDraft({ content: event.target.value })} className="min-h-52" placeholder="内容" />
        <div className="flex justify-end gap-2">
          <div className="mr-auto flex items-center px-2 text-xs text-muted-foreground">已自动保存</div>
          <Button variant="destructive" onClick={async () => { await api.delete(`settings/quick-message/${draft.id}`); await pullSettings(onSettings); }}><Trash2 className="size-4" />删除</Button>
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
  const dirtyRef = React.useRef(false);
  const promptVariables = ["{{cur_datetime}}", "{{date}}", "{{time}}", "{{locale}}", "{{timezone}}", "{{model_name}}", "{{user}}", "{{char}}"];
  const position = textValue(draft.position) || "after_system_prompt";
  const usesStandaloneMessage = position === "top_of_chat" || position === "bottom_of_chat" || position === "at_depth";
  React.useEffect(() => {
    dirtyRef.current = false;
  }, [selectedId, items]);
  const patchDraft = (patch: Record<string, unknown>) => {
    dirtyRef.current = true;
    setDraft({ ...draft, ...patch });
  };
  const save = React.useCallback(async (announce = false) => {
    if (!announce && !dirtyRef.current) return;
    await api.post(savePath, draft);
    dirtyRef.current = false;
    await pullSettings(onSettings);
    if (announce) toast.success(`${title} 已保存`);
  }, [draft, onSettings, savePath, title]);
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
      modeInjectionIds: bindKey === "modeInjectionIds" ? [...ids] : assistant.modeInjectionIds ?? [],
      lorebookIds: assistant.lorebookIds ?? [],
      quickMessageIds: assistant.quickMessageIds ?? [],
    });
    await pullSettings(onSettings);
  };
  return (
    <EditorShell
      items={items}
      selectedId={selectedId}
      emptyLabel={`还没有 ${title}`}
      onSelect={setSelectedId}
      titleOf={(item) => textValue(item.name) || title}
      onMove={async (from, to) => {
        const next = moveItem(items, from, to);
        onSettings({ ...settings, modeInjections: next as unknown as Settings["modeInjections"] });
        await api.post(reorderPath, { ids: next.map((item) => String(item.id)) });
      }}
      onCreate={() => {
        const next = createItem();
        setSelectedId(String(next.id));
        setDraft(next);
        dirtyRef.current = true;
      }}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">{title} 详情</div>
          <Switch checked={(assistant[bindKey] ?? []).includes(String(draft.id))} onCheckedChange={(checked) => void bind(checked)} />
        </div>
        <Input value={textValue(draft.name)} onChange={(event) => patchDraft({ name: event.target.value })} placeholder="名称" />
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">优先级</span>
            <Input type="number" value={numberText(draft.priority)} onChange={(event) => patchDraft({ priority: Number(event.target.value) })} placeholder="0" />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">注入位置</span>
            <Select value={position} onValueChange={(value) => patchDraft({ position: value })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="before_system_prompt">系统前</SelectItem>
                <SelectItem value="after_system_prompt">系统后</SelectItem>
                <SelectItem value="top_of_chat">对话顶部</SelectItem>
                <SelectItem value="bottom_of_chat">对话底部</SelectItem>
                <SelectItem value="at_depth">指定深度</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {usesStandaloneMessage ? (
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">角色</span>
              <Select value={textValue(draft.role) || "USER"} onValueChange={(value) => patchDraft({ role: value })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="USER">User</SelectItem>
                  <SelectItem value="ASSISTANT">Assistant</SelectItem>
                </SelectContent>
              </Select>
            </label>
          ) : null}
          {position === "at_depth" ? (
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">注入深度（从最新消息往前数）</span>
              <Input type="number" min={1} value={numberText(draft.injectDepth ?? 4)} onChange={(event) => patchDraft({ injectDepth: Math.max(1, Number(event.target.value) || 4) })} placeholder="4" />
            </label>
          ) : null}
        </div>
        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <span className="text-sm">启用</span>
          <Switch checked={draft.enabled !== false} onCheckedChange={(checked) => patchDraft({ enabled: checked })} />
        </div>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">模板变量</span>
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
            placeholder="注入内容，支持 {{cur_datetime}} 等模板变量"
          />
        </div>
        <div className="flex justify-end gap-2">
          <div className="mr-auto flex items-center px-2 text-xs text-muted-foreground">已自动保存</div>
          <Button variant="destructive" onClick={async () => { await api.delete(`${deletePath}/${draft.id}`); await pullSettings(onSettings); }}><Trash2 className="size-4" />删除</Button>
        </div>
      </div>
    </EditorShell>
  );
}

function SkillsEditor({ settings, assistant, onSettings }: { settings: Settings; assistant: AssistantProfile; onSettings: (settings: Settings) => void }) {
  const [skills, setSkills] = React.useState<SkillProfile[]>([]);
  const [selected, setSelected] = React.useState("");
  const [content, setContent] = React.useState("");
  const [files, setFiles] = React.useState<SkillFileInfo[]>([]);
  const [githubUrl, setGithubUrl] = React.useState("");
  const [importing, setImporting] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
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
    api.get<SkillProfile>(`skills/${encodeURIComponent(selected)}`).then((skill) => {
      setContent(skill.content ?? "");
      dirtyRef.current = false;
    }).catch(() => setContent(""));
    api.get<{ files: SkillFileInfo[] }>(`skills/${encodeURIComponent(selected)}/files`).then((result) => setFiles(result.files)).catch(() => setFiles([]));
  }, [selected, selectedSkill]);

  const save = React.useCallback(async (announce = false) => {
    if (!announce && !dirtyRef.current) return;
    const name = textValue(parseSkillName(content) || selected || "new-skill");
    setSaving(true);
    try {
      await api.post("skills/detail", { name, content });
      dirtyRef.current = false;
      await load();
      setSelected(name);
      if (announce) toast.success("Skill 已保存");
    } catch (error) {
      if (announce) toast.error(error instanceof Error ? error.message : "保存失败");
      else console.warn("Skill auto-save failed", error);
    } finally {
      setSaving(false);
    }
  }, [content, load, selected]);
  React.useEffect(() => {
    if (!dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void save(false);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [content, save]);
  const remove = async () => {
    if (!selected || !window.confirm("删除这个 Skill？")) return;
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
      const result = await api.post<{ skill: SkillProfile }>("skills/import-github", { repoUrl: githubUrl.trim() }, { timeout: false });
      await load();
      setSelected(result.skill.name);
      setContent(result.skill.content ?? "");
      dirtyRef.current = false;
      setGithubUrl("");
      toast.success(`Skill 已导入：${result.skill.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导入失败");
    } finally {
      setImporting(false);
    }
  };
  const toggle = async (skillName: string, checked: boolean) => {
    const ids = new Set(assistant.enabledSkills as string[] | undefined);
    if (checked) ids.add(skillName);
    else ids.delete(skillName);
    await api.post("settings/assistant/skills", { assistantId: assistant.id, enabledSkills: [...ids] });
    await pullSettings(onSettings);
  };

  return (
    <EditorShell
      items={skills as unknown as Array<Record<string, unknown>>}
      selectedId={selected}
      emptyLabel="还没有 Skill"
      onSelect={setSelected}
      titleOf={(item) => textValue(item.name)}
      renderItem={(item) => {
        const name = textValue(item.name);
        const enabled = (assistant.enabledSkills as string[] | undefined)?.includes(name) ?? false;
        return (
          <div className="flex min-w-0 items-center gap-2 text-left">
            <span className={`size-2 shrink-0 rounded-full ${enabled ? "bg-emerald-500" : "bg-red-500"}`} />
            <span className="block min-w-0 truncate font-medium">{name}</span>
          </div>
        );
      }}
      onCreate={() => {
        const name = "new-skill";
        setSelected(name);
        setContent(`---\nname: ${name}\ndescription: 描述何时应使用这个 skill\n---\n\n写入 Skill 指令。\n`);
        setFiles([]);
        dirtyRef.current = true;
      }}
    >
      <div className="space-y-4">
        <div className="rounded-md border p-3">
          <div className="mb-2 text-sm font-medium">从 GitHub 导入</div>
          <div className="flex gap-2">
            <Input
              value={githubUrl}
              onChange={(event) => setGithubUrl(event.target.value)}
              placeholder="https://github.com/owner/repo 或 /tree/branch/sub/path"
              onKeyDown={(event) => {
                if (event.key === "Enter") void importFromGitHub();
              }}
            />
            <Button type="button" variant="outline" onClick={() => void importFromGitHub()} disabled={importing || !githubUrl.trim()}>
              {importing ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              导入
            </Button>
          </div>
        </div>
        <div className="space-y-2 rounded-md border p-3">
          {skills.map((skill) => (
            <label key={skill.name} className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted/40">
              <Checkbox className="mt-0.5" checked={(assistant.enabledSkills as string[] | undefined)?.includes(skill.name) ?? false} onCheckedChange={(checked) => void toggle(skill.name, checked === true)} />
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
          <div className="border-b px-3 py-2 text-sm font-medium">文件列表</div>
          <div className="max-h-40 overflow-auto p-2">
            {files.length === 0 ? <div className="p-2 text-sm text-muted-foreground">暂无文件</div> : null}
            {files.map((file) => (
              <div key={file.path} className="flex items-center justify-between gap-3 rounded px-2 py-1 text-xs hover:bg-muted/40">
                <span className={file.type === "directory" ? "font-medium" : ""}>{file.path}</span>
                <span className="text-muted-foreground">{file.type === "directory" ? "目录" : `${file.size} B`}</span>
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
          <div className="mr-auto flex items-center px-2 text-xs text-muted-foreground">{saving ? "正在自动保存..." : "已自动保存"}</div>
          <Button variant="destructive" onClick={() => void remove()} disabled={!selected}><Trash2 className="size-4" />删除</Button>
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
  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <div className="rounded-lg border bg-card p-3">
        <Button className="mb-3 w-full" variant="outline" onClick={onCreate}>
          <Plus className="size-4" />
          新增
        </Button>
        <div className="space-y-1">
          {items.length === 0 ? <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{emptyLabel}</div> : null}
          {items.map((item, index) => (
            <SortableRow key={String(item.id ?? item.name)} id={String(item.id ?? item.name)} index={index} active={String(item.id ?? item.name) === selectedId} onSelect={() => onSelect(String(item.id ?? item.name))} onMove={onMove ? ((from, to) => void onMove(from, to)) : undefined}>
              {renderItem ? renderItem(item) : <div className="truncate text-left">{titleOf(item)}</div>}
            </SortableRow>
          ))}
        </div>
      </div>
      <div className="rounded-lg border bg-card p-5">{children}</div>
    </div>
  );
}

function DataSection({ settings, onSettings }: { settings: Settings; onSettings: (settings: Settings) => void }) {
  const importInputRef = React.useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const defaultWebDav = (settings.webDavConfig ?? { url: "", username: "", password: "", path: "rikkahub_backups", items: ["DATABASE", "FILES"] }) as WebDavConfig;
  const [webDavDraft, setWebDavDraft] = React.useState<WebDavConfig>(defaultWebDav);
  const [webDavItems, setWebDavItems] = React.useState<WebDavBackupItem[]>([]);
  const [webDavBusy, setWebDavBusy] = React.useState("");
  const [showWebDavPassword, setShowWebDavPassword] = React.useState(false);
  const webDavDirtyRef = React.useRef(false);

  const defaultS3 = (settings.s3Config ?? {
    endpoint: "",
    region: "us-east-1",
    accessKeyId: "",
    secretAccessKey: "",
    bucket: "",
    prefix: "rikkahub_backups",
    forcePathStyle: false,
    items: ["DATABASE", "FILES"],
  }) as S3Config;
  const [s3Draft, setS3Draft] = React.useState<S3Config>(defaultS3);
  const [s3Items, setS3Items] = React.useState<S3BackupItem[]>([]);
  const [s3Busy, setS3Busy] = React.useState("");
  const [showS3Secret, setShowS3Secret] = React.useState(false);
  const s3DirtyRef = React.useRef(false);

  React.useEffect(() => {
    setWebDavDraft(defaultWebDav);
    webDavDirtyRef.current = false;
  }, [defaultWebDav.url, defaultWebDav.username, defaultWebDav.password, defaultWebDav.path, JSON.stringify(defaultWebDav.items ?? [])]);

  const patchWebDav = (patch: Partial<WebDavConfig>) => {
    webDavDirtyRef.current = true;
    setWebDavDraft({ ...webDavDraft, ...patch });
  };

  const saveWebDav = React.useCallback(async (announce = false) => {
    if (!announce && !webDavDirtyRef.current) return;
    const result = await api.post<{ config: WebDavConfig }>("data/webdav/config", webDavDraft);
    webDavDirtyRef.current = false;
    onSettings({ ...settings, webDavConfig: result.config } as Settings);
    if (announce) toast.success("WebDAV 配置已保存");
  }, [onSettings, settings, webDavDraft]);

  React.useEffect(() => {
    if (!webDavDirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void saveWebDav(false).catch((error: Error) => toast.error(error.message || "自动保存 WebDAV 失败"));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [saveWebDav, webDavDraft]);

  const refreshWebDavList = async () => {
    setWebDavBusy("list");
    try {
      await saveWebDav(false);
      const result = await api.get<{ items: WebDavBackupItem[] }>("data/webdav/list", { timeout: false });
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
      toast.success("WebDAV 连接成功");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "WebDAV 连接失败");
    } finally {
      setWebDavBusy("");
    }
  };

  const backupWebDav = async () => {
    setWebDavBusy("backup");
    try {
      await saveWebDav(false);
      const result = await api.post<{ items: WebDavBackupItem[] }>("data/webdav/backup", {}, { timeout: false });
      setWebDavItems(result.items);
      toast.success("WebDAV 备份完成");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "WebDAV 备份失败");
    } finally {
      setWebDavBusy("");
    }
  };

  const restoreWebDav = async (item: WebDavBackupItem) => {
    if (!window.confirm(`恢复 ${item.displayName} 会覆盖当前本地设置、会话和日志。继续？`)) return;
    setWebDavBusy(`restore:${item.displayName}`);
    try {
      const result = await api.post<{ settings: Settings }>("data/webdav/restore", { fileName: item.displayName }, { timeout: false });
      onSettings(result.settings);
      toast.success("WebDAV 备份已恢复");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "WebDAV 恢复失败");
    } finally {
      setWebDavBusy("");
    }
  };

  const deleteWebDav = async (item: WebDavBackupItem) => {
    if (!window.confirm(`删除远端备份 ${item.displayName}？`)) return;
    setWebDavBusy(`delete:${item.displayName}`);
    try {
      const result = await api.post<{ items: WebDavBackupItem[] }>("data/webdav/delete", { fileName: item.displayName }, { timeout: false });
      setWebDavItems(result.items);
      toast.success("WebDAV 备份已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "WebDAV 删除失败");
    } finally {
      setWebDavBusy("");
    }
  };

  React.useEffect(() => {
    setS3Draft(defaultS3);
    s3DirtyRef.current = false;
  }, [defaultS3.endpoint, defaultS3.region, defaultS3.accessKeyId, defaultS3.secretAccessKey, defaultS3.bucket, defaultS3.prefix, defaultS3.forcePathStyle, JSON.stringify(defaultS3.items ?? [])]);

  const patchS3 = (patch: Partial<S3Config>) => {
    s3DirtyRef.current = true;
    setS3Draft({ ...s3Draft, ...patch });
  };
  const saveS3 = React.useCallback(async (announce = false) => {
    if (!announce && !s3DirtyRef.current) return;
    const result = await api.post<{ config: S3Config }>("data/s3/config", s3Draft);
    s3DirtyRef.current = false;
    onSettings({ ...settings, s3Config: result.config } as Settings);
    if (announce) toast.success("S3 配置已保存");
  }, [onSettings, settings, s3Draft]);
  React.useEffect(() => {
    if (!s3DirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void saveS3(false).catch((error: Error) => toast.error(error.message || "自动保存 S3 失败"));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [saveS3, s3Draft]);
  const refreshS3List = async () => {
    setS3Busy("list");
    try {
      await saveS3(false);
      const result = await api.get<{ items: S3BackupItem[] }>("data/s3/list", { timeout: false });
      setS3Items(result.items);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "S3 列表失败");
    } finally {
      setS3Busy("");
    }
  };
  const testS3 = async () => {
    setS3Busy("test");
    try {
      await saveS3(false);
      await api.post("data/s3/test", { config: s3Draft }, { timeout: false });
      toast.success("S3 连接成功");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "S3 连接失败");
    } finally {
      setS3Busy("");
    }
  };
  const backupS3 = async () => {
    setS3Busy("backup");
    try {
      await saveS3(false);
      const result = await api.post<{ items: S3BackupItem[] }>("data/s3/backup", {}, { timeout: false });
      setS3Items(result.items);
      toast.success("S3 备份完成");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "S3 备份失败");
    } finally {
      setS3Busy("");
    }
  };
  const restoreS3 = async (item: S3BackupItem) => {
    if (!window.confirm(`从远端备份 ${item.displayName} 恢复？这会覆盖当前本地状态。`)) return;
    setS3Busy(`restore:${item.displayName}`);
    try {
      const result = await api.post<{ settings: Settings }>("data/s3/restore", { fileName: item.displayName }, { timeout: false });
      onSettings(result.settings);
      toast.success("S3 备份已恢复");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "S3 恢复失败");
    } finally {
      setS3Busy("");
    }
  };
  const deleteS3 = async (item: S3BackupItem) => {
    if (!window.confirm(`删除远端备份 ${item.displayName}？`)) return;
    setS3Busy(`delete:${item.displayName}`);
    try {
      const result = await api.post<{ items: S3BackupItem[] }>("data/s3/delete", { fileName: item.displayName }, { timeout: false });
      setS3Items(result.items);
      toast.success("S3 备份已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "S3 删除失败");
    } finally {
      setS3Busy("");
    }
  };

  const exportData = async () => {
    setExporting(true);
    try {
      const backup = await api.get<Record<string, unknown>>("data/export");
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `rikkahub-pc-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success("备份已导出");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导出失败");
    } finally {
      setExporting(false);
    }
  };

  const importData = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!window.confirm("导入会覆盖当前本地设置、会话和日志。继续？")) return;

    setImporting(true);
    try {
      const text = await file.text();
      const backup = JSON.parse(text) as unknown;
      const result = await api.post<{ status: string; settings: Settings }>("data/import", backup);
      onSettings(result.settings);
      toast.success("备份已导入");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导入失败");
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <SectionHeader icon={Database} title="数据设置" subtitle="本地状态导入导出、聊天文件存储路径，以及 WebDAV / S3 远端同步。" />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm font-medium">数据备份</div>
          <div className="mt-1 text-xs text-muted-foreground">导出或导入本地 JSON 状态，包含设置、会话、文件索引和请求日志。</div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void exportData()} disabled={exporting}>
              {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              导出备份
            </Button>
            <Button variant="outline" onClick={() => importInputRef.current?.click()} disabled={importing}>
              {importing ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
              导入备份
            </Button>
            <input ref={importInputRef} className="sr-only" type="file" accept="application/json,.json" onChange={(event) => void importData(event)} />
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm font-medium">聊天文件储存</div>
          <div className="mt-1 text-xs text-muted-foreground">上传的头像和附件会保存到本地数据目录，并通过 /api/files 提供内容。</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm font-medium">Web 服务</div>
          <div className="mt-1 text-xs text-muted-foreground">当前 Web JWT：{settings.webServerJwtEnabled ? "已启用" : "未启用"}</div>
        </div>
        <div className="rounded-lg border bg-card p-4 md:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">WebDAV 备份</div>
              <div className="mt-1 text-xs text-muted-foreground">通过 WebDAV 测试连接、立即备份、列出远端备份、恢复或删除。备份内容包含本地 JSON 状态、Skills 与上传文件。</div>
            </div>
            <div className="text-xs text-muted-foreground">{webDavBusy ? "正在处理..." : "已自动保存"}</div>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">服务器地址</span>
              <Input value={webDavDraft.url} onChange={(event) => patchWebDav({ url: event.target.value })} placeholder="https://example.com/dav" />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">备份路径</span>
              <Input value={webDavDraft.path} onChange={(event) => patchWebDav({ path: event.target.value })} placeholder="rikkahub_backups" />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">用户名</span>
              <Input value={webDavDraft.username} onChange={(event) => patchWebDav({ username: event.target.value })} />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">密码</span>
              <div className="flex gap-2">
                <Input type={showWebDavPassword ? "text" : "password"} value={webDavDraft.password} onChange={(event) => patchWebDav({ password: event.target.value })} />
                <Button type="button" variant="outline" size="icon" onClick={() => setShowWebDavPassword((value) => !value)}>
                  {showWebDavPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
              </div>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {(["DATABASE", "FILES"] as const).map((item) => (
              <label key={item} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <Checkbox
                  checked={(webDavDraft.items ?? []).includes(item)}
                  onCheckedChange={(checked) => {
                    const items = new Set(webDavDraft.items ?? []);
                    if (checked) items.add(item);
                    else items.delete(item);
                    patchWebDav({ items: [...items] });
                  }}
                />
                {item === "DATABASE" ? "设置与会话" : "上传文件"}
              </label>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void testWebDav()} disabled={Boolean(webDavBusy) || !webDavDraft.url.trim()}>
              {webDavBusy === "test" ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              测试连接
            </Button>
            <Button variant="outline" onClick={() => void refreshWebDavList()} disabled={Boolean(webDavBusy) || !webDavDraft.url.trim()}>
              {webDavBusy === "list" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              刷新备份
            </Button>
            <Button onClick={() => void backupWebDav()} disabled={Boolean(webDavBusy) || !webDavDraft.url.trim()}>
              {webDavBusy === "backup" ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
              立即备份
            </Button>
          </div>
          <div className="mt-4 rounded-md border">
            {webDavItems.length === 0 ? <div className="p-4 text-sm text-muted-foreground">暂无远端备份。点击“刷新备份”读取 WebDAV 目录。</div> : null}
            {webDavItems.map((item, index) => (
              <React.Fragment key={item.displayName}>
                {index > 0 ? <Separator /> : null}
                <div className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{item.displayName}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{new Date(item.lastModified || 0).toLocaleString()} · {Math.round((item.size || 0) / 1024)} KB</div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => void restoreWebDav(item)} disabled={Boolean(webDavBusy)}>
                      {webDavBusy === `restore:${item.displayName}` ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                      恢复
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => void deleteWebDav(item)} disabled={Boolean(webDavBusy)}>
                      {webDavBusy === `delete:${item.displayName}` ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
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
              <div className="text-sm font-medium">S3 备份</div>
              <div className="mt-1 text-xs text-muted-foreground">支持标准 AWS S3 与兼容 endpoint（MinIO/R2/腾讯云 COS/阿里云 OSS 等）。备份内容与 WebDAV 一致。</div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Path-style</span>
              <Switch checked={s3Draft.forcePathStyle} onCheckedChange={(forcePathStyle) => patchS3({ forcePathStyle })} />
            </div>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Endpoint（留空使用 AWS 官方）</span>
              <Input value={s3Draft.endpoint} onChange={(event) => patchS3({ endpoint: event.target.value })} placeholder="https://s3.example.com" />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Region</span>
              <Input value={s3Draft.region} onChange={(event) => patchS3({ region: event.target.value })} placeholder="us-east-1" />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Bucket</span>
              <Input value={s3Draft.bucket} onChange={(event) => patchS3({ bucket: event.target.value })} placeholder="my-rikkahub-bucket" />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">前缀路径</span>
              <Input value={s3Draft.prefix} onChange={(event) => patchS3({ prefix: event.target.value })} placeholder="rikkahub_backups" />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Access Key ID</span>
              <Input value={s3Draft.accessKeyId} onChange={(event) => patchS3({ accessKeyId: event.target.value })} />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Secret Access Key</span>
              <div className="flex gap-2">
                <Input type={showS3Secret ? "text" : "password"} value={s3Draft.secretAccessKey} onChange={(event) => patchS3({ secretAccessKey: event.target.value })} />
                <Button type="button" variant="outline" size="icon" onClick={() => setShowS3Secret((value) => !value)}>
                  {showS3Secret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
              </div>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void testS3()} disabled={Boolean(s3Busy) || !s3Draft.bucket.trim() || !s3Draft.accessKeyId.trim()}>
              {s3Busy === "test" ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
              测试连接
            </Button>
            <Button variant="outline" onClick={() => void refreshS3List()} disabled={Boolean(s3Busy) || !s3Draft.bucket.trim()}>
              {s3Busy === "list" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              刷新备份
            </Button>
            <Button onClick={() => void backupS3()} disabled={Boolean(s3Busy) || !s3Draft.bucket.trim() || !s3Draft.accessKeyId.trim()}>
              {s3Busy === "backup" ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
              立即备份
            </Button>
          </div>
          <div className="mt-3 overflow-hidden rounded-md border">
            {s3Items.length === 0 ? <div className="p-4 text-sm text-muted-foreground">暂无远端备份。点击"刷新备份"读取 S3 目录。</div> : null}
            {s3Items.map((item, index) => (
              <React.Fragment key={item.displayName}>
                {index > 0 ? <Separator /> : null}
                <div className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{item.displayName}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{new Date(item.lastModified || 0).toLocaleString()} · {Math.round((item.size || 0) / 1024)} KB</div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => void restoreS3(item)} disabled={Boolean(s3Busy)}>
                      {s3Busy === `restore:${item.displayName}` ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                      恢复
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => void deleteS3(item)} disabled={Boolean(s3Busy)}>
                      {s3Busy === `delete:${item.displayName}` ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
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
  if (!stats) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        加载统计
      </div>
    );
  }
  const dailyByDate = new Map(stats.daily.map((item) => [item.date, item]));
  const today = new Date();
  const start = new Date(today);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay() - 52 * 7);
  const activeCounts = stats.daily.map((item) => item.messages).filter((count) => count > 0).sort((a, b) => a - b);
  const quantile = (ratio: number, fallback: number) => activeCounts[Math.floor(activeCounts.length * ratio)] ?? fallback;
  const q1 = quantile(0.25, 1);
  const q2 = quantile(0.5, 2);
  const q3 = quantile(0.75, 3);
  const formatKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const heatmapWeeks = Array.from({ length: 53 }, (_, weekIndex) =>
    Array.from({ length: 7 }, (_, dayIndex) => {
      const date = new Date(start);
      date.setDate(start.getDate() + weekIndex * 7 + dayIndex);
      const key = formatKey(date);
      const item = dailyByDate.get(key);
      const isFuture = date > today;
      const count = isFuture ? 0 : item?.messages ?? 0;
      const level = isFuture ? -1 : count === 0 ? 0 : count <= q1 ? 1 : count <= q2 ? 2 : count <= q3 ? 3 : 4;
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
      <SectionHeader icon={Database} title="统计" subtitle="基于本地聊天、请求日志和模型使用情况生成的用量统计与活动热力图。" />
      <div className="grid gap-4 md:grid-cols-5">
        {[
          ["总对话数", stats.totals.conversations],
          ["总消息数", stats.totals.messages],
          ["输入 Token", stats.totals.inputTokens],
          ["输出 Token", stats.totals.outputTokens],
          ["应用启动次数", stats.totals.launchCount],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-lg border bg-card p-4">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-2 text-2xl font-semibold">{value}</div>
          </div>
        ))}
      </div>
      <div className="mt-6 rounded-lg border bg-card p-4">
        <div className="mb-3 text-sm font-medium">消息热力图</div>
        <div className="pb-1">
          <div className="grid w-full grid-cols-[24px_minmax(0,1fr)] gap-x-2 overflow-hidden">
            <div />
            <div className="grid justify-between gap-[2px]" style={{ gridTemplateColumns: "repeat(53, minmax(10px, 14px))" }}>
              {monthLabels.map((label, index) => (
                <div key={`${label}-${index}`} className="h-5 overflow-visible whitespace-nowrap text-[11px] text-muted-foreground">{label}</div>
              ))}
            </div>
            <div className="grid gap-[2px] pt-[2px]" style={{ gridTemplateRows: "repeat(7, 12px)" }}>
              {["", "一", "", "三", "", "五", ""].map((label, index) => (
                <div key={`${label}-${index}`} className="flex h-3 items-center justify-end text-[11px] text-muted-foreground">{label}</div>
              ))}
            </div>
            <div className="grid justify-between gap-[2px] pt-[2px]" style={{ gridTemplateColumns: "repeat(53, minmax(10px, 14px))" }}>
              {heatmapWeeks.map((week, weekIndex) => (
                <div key={weekIndex} className="grid gap-[2px]" style={{ gridTemplateRows: "repeat(7, 12px)" }}>
                  {week.map((day) => (
                    <div
                      key={day.key}
                      title={`${day.key}: ${day.count} messages`}
                      className={`size-3 rounded-[3px] sm:size-3.5 ${heatmapClass(day.level)}`}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
          <span>少</span>
          {[0, 1, 2, 3, 4].map((level) => <span key={level} className={`size-[12px] rounded-[4px] ${heatmapClass(level)}`} />)}
          <span>多</span>
        </div>
        {stats.daily.length === 0 ? <div className="mt-3 text-xs text-muted-foreground">暂无聊天统计，开始对话后这里会自动出现热力图。</div> : null}
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border bg-card p-4">
          <div className="mb-3 text-sm font-medium">模型使用</div>
          <div className="space-y-2">
            {stats.models.slice(0, 8).map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate">{[item.providerName, item.name || item.id].filter(Boolean).join(" / ")}</span>
                <span className="text-muted-foreground">{item.count}</span>
              </div>
            ))}
            {stats.models.length === 0 ? <div className="text-sm text-muted-foreground">暂无模型使用记录</div> : null}
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="mb-3 text-sm font-medium">请求分类</div>
          <div className="mb-4 space-y-2">
            {(stats.requestGroups ?? []).map((item) => (
              <div key={item.name} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate">{item.name}</span>
                <span className="text-muted-foreground">成功 {item.ok} / 失败 {item.failed}</span>
              </div>
            ))}
            {(stats.requestGroups ?? []).length === 0 ? <div className="text-sm text-muted-foreground">暂无请求分类</div> : null}
          </div>
          <div className="mb-3 text-sm font-medium">供应商请求</div>
          <div className="space-y-2">
            {stats.providers.slice(0, 8).map((item) => (
              <div key={item.name} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate">{item.name}</span>
                <span className="text-muted-foreground">{item.ok} / {item.failed}</span>
              </div>
            ))}
            {stats.providers.length === 0 ? <div className="text-sm text-muted-foreground">暂无请求记录</div> : null}
          </div>
        </div>
      </div>
    </>
  );
}

interface ProxyConfig {
  url: string;
  username: string;
  password: string;
}

interface ProxyStatus {
  activeUrl: string | null;
  source: "manual" | "system" | "none";
  detectedSystemProxy: string | null;
}

function ProxySection({ settings, onSettings }: { settings: Settings; onSettings: (settings: Settings) => void }) {
  const initial = (settings.proxyConfig ?? { url: "", username: "", password: "" }) as ProxyConfig;
  const [draft, setDraft] = React.useState<ProxyConfig>(initial);
  const [showPassword, setShowPassword] = React.useState(false);
  const [detecting, setDetecting] = React.useState(false);
  const [status, setStatus] = React.useState<ProxyStatus | null>(null);
  const dirtyRef = React.useRef(false);

  React.useEffect(() => {
    // Only adopt the settings-prop value when the user isn't mid-edit. Without this guard,
    // a save round-trip races with continued typing: the SSE push of the (older) saved
    // value arrives a few ms after the user has typed another character, and naively
    // resetting `draft` from `initial` would wipe those new keystrokes.
    if (dirtyRef.current) return;
    setDraft(initial);
  }, [initial.url, initial.username, initial.password]);

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
    // Poll every 10s so toggling Clash on/off updates the footer without a manual refresh.
    const timer = window.setInterval(() => void refreshStatus(), 10_000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  const patch = (next: Partial<ProxyConfig>) => {
    dirtyRef.current = true;
    setDraft((prev) => ({ ...prev, ...next }));
  };

  const save = React.useCallback(async (announce = false) => {
    if (!announce && !dirtyRef.current) return;
    try {
      const result = await api.post<{ config: ProxyConfig } & ProxyStatus>("settings/proxy", draft);
      dirtyRef.current = false;
      onSettings({ ...settings, proxyConfig: result.config } as Settings);
      setStatus({ activeUrl: result.activeUrl, source: result.source, detectedSystemProxy: result.detectedSystemProxy });
      if (announce) toast.success("代理设置已保存");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存代理设置失败");
    }
  }, [draft, onSettings, settings]);

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
        toast.success(`检测到系统代理：${result.detected}`);
      } else {
        toast.message("未检测到系统代理", { description: "Windows 系统代理当前未开启，或代理工具尚未启动。" });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "检测失败");
    } finally {
      setDetecting(false);
    }
  };

  const activeDisplay = status?.activeUrl
    ? status.source === "system"
      ? `${status.activeUrl}（来自系统代理）`
      : status.activeUrl
    : "未启用（所有请求直连）";

  return (
    <>
      <SectionHeader icon={Globe} title="代理" subtitle="为 AI API、搜索、MCP 等所有出站请求统一指定 HTTP 代理。留空将自动跟随系统代理。" />
      <div className="space-y-5 rounded-lg border bg-card p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-base font-medium">HTTP 代理设置</div>
            <div className="mt-1 text-xs text-muted-foreground">所有 AI API 请求均通过此代理转发</div>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void detectSystemProxy()} disabled={detecting}>
            {detecting ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            自动检测系统代理
          </Button>
        </div>

        <label className="block space-y-2">
          <span className="text-sm font-medium">代理地址</span>
          <Input
            value={draft.url}
            onChange={(event) => patch({ url: event.target.value })}
            placeholder="http://127.0.0.1:7890（留空 = 跟随系统代理）"
          />
        </label>

        <label className="block space-y-2">
          <span className="text-sm font-medium">
            用户名 <span className="text-xs font-normal text-muted-foreground">（可选）</span>
          </span>
          <Input
            value={draft.username}
            onChange={(event) => patch({ username: event.target.value })}
            placeholder="proxy username"
            autoComplete="off"
          />
        </label>

        <label className="block space-y-2">
          <span className="text-sm font-medium">
            密码 <span className="text-xs font-normal text-muted-foreground">（可选）</span>
          </span>
          <div className="flex gap-2">
            <Input
              type={showPassword ? "text" : "password"}
              value={draft.password}
              onChange={(event) => patch({ password: event.target.value })}
              placeholder="proxy password"
              autoComplete="off"
            />
            <Button type="button" variant="outline" size="icon" onClick={() => setShowPassword((value) => !value)}>
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </Button>
          </div>
        </label>

        <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          当前代理：<span className="font-mono text-foreground">{activeDisplay}</span>
        </div>
      </div>
    </>
  );
}

function AboutSection() {
  const aboutRows = [
    { label: "版本", value: "1.0.0", icon: Settings2, onClick: undefined },
    { label: "系统", value: typeof navigator === "undefined" ? "Windows / Web" : navigator.userAgent, icon: Smartphone, onClick: undefined },
    { label: "官网", value: "https://rikka-ai.com", icon: Globe, onClick: () => void openExternal("https://rikka-ai.com/") },
    { label: "GitHub", value: "https://github.com/yuh-G/rikkahub-pc", icon: Github, onClick: () => void openExternal("https://github.com/yuh-G/rikkahub-pc") },
    { label: "License", value: "https://github.com/yuh-G/rikkahub-pc/blob/master/LICENSE", icon: FileClock, onClick: () => void openExternal("https://github.com/yuh-G/rikkahub-pc/blob/master/LICENSE") },
  ];
  return (
    <>
      <SectionHeader icon={CheckCircle2} title="关于" subtitle="应用标识、版本、系统信息、官网、GitHub 与 License。" />
      <div className="space-y-6">
        <div className="flex flex-col items-center gap-3 rounded-lg border bg-card p-8 text-center">
          <img
            src="/app-icon.png"
            alt="RikkaHub"
            className="size-28 rounded-full shadow-sm"
          />
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
                  {row.onClick ? <ExternalLink className="size-3.5 shrink-0" /> : null}
                </div>
              </>
            );
            return (
              <React.Fragment key={row.label}>
                {index > 0 ? <Separator /> : null}
                {row.onClick ? (
                  <button type="button" className="flex w-full items-center justify-between gap-4 p-4 text-left transition hover:bg-accent/50" onClick={row.onClick}>
                    {content}
                  </button>
                ) : (
                  <div className="flex items-center justify-between gap-4 p-4">
                    {content}
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </>
  );
}

function LogsSection({ logs }: { logs: RequestLog[] }) {
  const [openId, setOpenId] = React.useState<string | null>(null);
  const copyLogText = React.useCallback(async (event: React.MouseEvent, title: string, text: string) => {
    event.stopPropagation();
    if (!text) return;
    await navigator.clipboard.writeText(text);
    toast.success(`${title} 已复制`);
  }, []);
  return (
    <>
      <SectionHeader icon={FileClock} title="请求日志" subtitle="记录每个 provider 请求的端点、状态码、耗时与错误摘要。" />
      <div className="space-y-3">
        {logs.length === 0 ? <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">暂无请求日志</div> : null}
        {logs.map((log) => {
          const open = openId === log.id;
          const requestText = log.requestBody || log.requestPreview || "";
          const responseText = log.responseBody || log.responsePreview || log.error || "";
          return (
          <div
            key={log.id}
            role="button"
            tabIndex={0}
            className="block w-full select-text rounded-lg border bg-card p-4 text-left transition hover:shadow-sm"
            onClick={() => setOpenId(open ? null : log.id)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              setOpenId(open ? null : log.id);
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="font-medium">{log.providerName}</div>
              <span className={log.ok ? "text-xs text-emerald-600" : "text-xs text-destructive"}>{log.status}</span>
            </div>
            <div className="mt-1 truncate text-xs text-muted-foreground">{log.url}</div>
            <div className="mt-1 text-xs text-muted-foreground">{new Date(log.at).toLocaleString()} · {log.kind ?? "request"} · {log.durationMs ?? 0}ms</div>
            {log.error ? <pre className="mt-2 max-h-32 select-text overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">{log.error}</pre> : null}
            {open ? (
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div>
                  <div className="mb-1 flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
                    <span>Request</span>
                    <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted" onClick={(event) => void copyLogText(event, "Request", requestText)}>复制</button>
                  </div>
                  <pre className="max-h-[520px] select-text overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">{requestText || "无请求体记录"}</pre>
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
                    <span>Response</span>
                    <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted" onClick={(event) => void copyLogText(event, "Response", responseText)}>复制</button>
                  </div>
                  <pre className="max-h-[520px] select-text overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">{responseText || "无响应体记录"}</pre>
                </div>
              </div>
            ) : null}
          </div>
        );
        })}
      </div>
    </>
  );
}
