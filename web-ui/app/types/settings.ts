// R8-4:Settings 顶层单源 —— 权威声明在 pc-server/foundation/types/settings(state.json 序列化
// 格式)。服务端对安卓契约透传域(mcpServers / searchServices / quickMessages / assistantTags /
// modeInjections / lorebooks 等)故意存 JsonValue 不建模(备份往返不丢未知字段);前端在这些域
// 需要 UI 视图形状。因此本文件 = 服务端 Settings 的全部顶层键(Omit 基座,服务端新增字段自动
// 对前端可见)+ 下方 VIEW-REFINED 清单里显式列出的视图细化。两端同形的类型一律 type-only
// re-export,不再手写镜像。视图细化字段的增删属契约变更,必须两端同评审。
import type {
  AsrProvider,
  Model as ServerModel,
  TtsProvider,
} from "@server/foundation/types";
import type { Settings as ServerSettings } from "@server/foundation/types/settings";

// 两端同形:直接单源 re-export(权威在 pc-server/foundation/types)。
export type {
  AssistantMemoryGroup,
  MemoryEntry,
  MemorySettings,
  MemorySnapshot,
  PendingEntry,
  ProxyConfig,
  ProxyMode,
  S3Config,
  WebDavConfig,
  WriteStrategy,
} from "@server/foundation/types";

/**
 * Display settings — user nickname, avatar, theme, fonts and other purely visual preferences.
 * 服务端存 Record<string, JsonValue>(安卓透传 + PC-only 字段剥离逻辑见 pcOnlyDisplayFields),
 * 这里是前端视图形状。
 */
export interface DisplaySetting {
  userNickname: string;
  userAvatar?: AssistantAvatar;
  showUserAvatar: boolean;
  showAssistantBubble?: boolean;
  showModelIcon?: boolean;
  showModelName: boolean;
  showTokenUsage: boolean;
  showThinkingContent: boolean;
  autoCloseThinking: boolean;
  codeBlockAutoWrap: boolean;
  codeBlockAutoCollapse: boolean;
  showLineNumbers: boolean;
  sendOnEnter: boolean;
  enableAutoScroll: boolean;
  fontSizeRatio: number;
  /**
   * 界面字号缩放比例(作用于 <html> 根字号,所有 rem 等比变化)。PC-only。
   * null / 未设置 = 不缩放(根字号保持浏览器默认 16px)。范围建议 0.85–1.20。
   * 已在 pc-server 的 pcOnlyDisplayFields 清单里,导出备份时会被剥离,Android 不可见。
   */
  uiFontSize?: number | null;
  uiFontFamily?: string;
  chatFontFamily?: string;
  uiFontFamilyCss?: string;
  chatFontFamilyCss?: string;
  // 中英文分别设置(Word 式):中文栏可选,为空则中文走英文字体的 fallback 链。
  // 字段透传字符串,后端 normalize 不需感知;老数据无这些字段 = 不分开,行为同前。
  uiFontFamilyCjk?: string;
  uiFontFamilyCjkCss?: string;
  chatFontFamilyCjk?: string;
  chatFontFamilyCjkCss?: string;
  pasteLongTextAsFile: boolean;
  pasteLongTextThreshold: number;
  /** 朗读过滤:只读引号内台词(跳过旁白/动作)。byte-match Android displaySetting。 */
  ttsOnlyReadQuoted?: boolean;
  /** 朗读过滤:跳过中英文括号内的注释/语气说明。byte-match Android displaySetting。 */
  ttsOnlyReadOutsideBrackets?: boolean;
  /** User-resizable chat input min-height in px (null = default). PC-only. */
  chatInputHeight?: number | null;
  /** 专题8:UI 主题与语言的权威存储(原在 localStorage,按 origin 隔离,改端口即丢)。
   *  PC-only,已在 pc-server pcOnlyDisplayFields 剥离清单,导出安卓不可见。 */
  themeMode?: "light" | "dark" | "system";
  colorTheme?: string;
  userThemes?: { id: string; name: string; css: { light: string; dark: string } }[];
  language?: string;
  [key: string]: unknown;
}

export interface AssistantTag {
  id: string;
  name: string;
}

export interface AssistantAvatar {
  type?: string;
  content?: string;
  url?: string;
  [key: string]: unknown;
}

export interface AssistantQuickMessage {
  title: string;
  content: string;
}

export interface QuickMessage {
  id: string;
  title: string;
  content: string;
}

export interface ModeInjectionProfile {
  id: string;
  name: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface LorebookProfile {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface McpToolOverride {
  enable?: boolean;
  needsApproval?: boolean;
}

export interface AssistantProfile {
  id: string;
  chatModelId?: string | null;
  reasoningLevel?: string | null;
  mcpServers?: string[];
  // Per-assistant overrides for individual MCP tools. See Assistant.mcpToolOverrides in
  // pc-server/foundation/types for the full semantics.
  // Shape: { [serverId]: { [toolName]: { enable?, needsApproval? } } }.
  mcpToolOverrides?: Record<string, Record<string, McpToolOverride>>;
  modeInjectionIds?: string[];
  lorebookIds?: string[];
  allowConversationSystemPrompt?: boolean;
  // 专题9:独立对话提示词注入(对齐安卓 Assistant.allowConversationPromptInjection)。
  // 开启后 modeInjectionIds/lorebookIds 的生效来源改为会话上的同名字段。
  allowConversationPromptInjection?: boolean;
  name: string;
  systemPrompt?: string;
  messageTemplate?: string;
  avatar?: AssistantAvatar;
  useAssistantAvatar?: boolean;
  tags: string[];
  quickMessageIds?: string[];
  [key: string]: unknown;
}

export interface McpToolOption {
  enable: boolean;
  name: string;
  description?: string | null;
  needsApproval?: boolean;
  [key: string]: unknown;
}

export interface McpCommonOptions {
  enable: boolean;
  name: string;
  tools: McpToolOption[];
  [key: string]: unknown;
}

export interface McpServerConfig {
  id: string;
  type?: string;
  commonOptions: McpCommonOptions;
  [key: string]: unknown;
}

// 单源自服务端 Model.type("CHAT" | "IMAGE" | "EMBEDDING")。
export type ModelType = ServerModel["type"];
// PC keeps the wider Modality list (AUDIO/VIDEO/DOCUMENT) for forward-compat with providers
// that already accept those — Android only has TEXT/IMAGE today but we don't want PC to ship
// narrower than the upstream API allows. 服务端存 string[](透传),此联合是前端视图收窄。
export type ModelModality = "TEXT" | "IMAGE" | "AUDIO" | "VIDEO" | "DOCUMENT";
export type ModelAbility = "TOOL" | "REASONING";

// Mirrors Android's `BuiltInTools` sealed class (`@SerialName("search" | "url_context" | "image_generation")`).
// The string is the canonical id sent to the provider when invoking the tool.
export type BuiltInToolType = "search" | "url_context" | "image_generation";

export interface BuiltInTool {
  type?: BuiltInToolType | string;
  [key: string]: unknown;
}

// Mirrors Android's `CustomHeader` (Provider.kt:103).
export interface CustomHeader {
  name: string;
  value: string;
}

// Mirrors Android's `CustomBody` (Provider.kt:109). `value` is intentionally `unknown` because
// the upstream stores a raw `JsonElement` — could be string, number, bool, object, or array.
export interface CustomBody {
  key: string;
  value: unknown;
}

// Mirrors Android's `Model.providerOverwrite: ProviderSetting?`. When set, a per-model
// override replaces the model's parent provider entirely at request-build time — useful
// when one model in a provider needs a different baseUrl / API key (e.g. routing through
// a custom OpenAI-compatible gateway for just that model).
//
// The four fields below are the minimum we surface in the UI. The backend stores and
// reads whatever else is here too (the catch-all `[key: string]: unknown` covers future
// fields like custom headers per-override).
export interface ProviderOverwrite {
  type: "openai" | "claude" | "google" | string;
  name: string;
  baseUrl: string;
  apiKey: string;
  [key: string]: unknown;
}

export interface ProviderModel {
  id: string;
  modelId: string;
  displayName: string;
  type: ModelType;
  inputModalities?: ModelModality[];
  outputModalities?: ModelModality[];
  abilities?: ModelAbility[];
  tools?: BuiltInTool[];
  customHeaders?: CustomHeader[];
  customBodies?: CustomBody[];
  /**
   * Per-model provider override. `null` / `undefined` means "use the parent provider".
   * When set, the entire upstream request (baseUrl, apiKey, etc.) goes through this
   * override instead. See findModel in pc-server/model-providers/index.ts for the
   * request-build merge logic.
   */
  providerOverwrite?: ProviderOverwrite | null;
  /**
   * `true` for models added via the manual "+" dialog. Used to decide whether to lock the
   * `modelId` field in the edit dialog: manually-added models keep editable IDs (the user
   * owns them); models that came from `获取模型列表` have their ID locked because the value
   * is sent verbatim to the upstream API and editing it would silently break request routing.
   *
   * Existing/back-compat models (no flag) are treated as fetched → locked.
   */
  manuallyAdded?: boolean;
  [key: string]: unknown;
}

export interface ProviderProfile {
  id: string;
  enabled: boolean;
  name: string;
  models: ProviderModel[];
  promptCaching?: boolean;
  promptCacheTtl?: "5m" | "1h";
  /** OpenAI providers only — 请求附带 prompt_cache_key=会话ID 提高官方端缓存命中(专题12),默认关。 */
  promptCacheKey?: boolean;
  /** OpenAI providers only — 是否在历史回放里把 reasoning_content 回传给上游（默认开启）。对齐安卓 e63d017。 */
  includeHistoryReasoning?: boolean;
  /** 订阅制登录:缺省 "apiKey";"oauth" 时凭证在服务端,前端只见 oauthStatus 安全视图。 */
  authMode?: "apiKey" | "oauth";
  /** 订阅登录状态(stripAuthSecrets 剥 credential 后的安全视图,永不含 token)。
   *  未登录的订阅行也带视图(signedIn:false):登录卡要首登前就能挂「仅工作区/合规」提示。 */
  oauthStatus?: {
    signedIn: boolean;
    flow: string;
    signedInAt: number;
    expiresAt?: number;
    accountId?: string;
    /** false = 仅工作区(Claude Pro/Max):不进聊天模型选择器,登录卡挂合规提示。 */
    chatCapable?: boolean;
  };
  [key: string]: unknown;
}

export interface SearchServiceOption {
  id: string;
  type?: string;
  [key: string]: unknown;
}

// ASR/TTS provider:字段单源自服务端 AsrProvider/TtsProvider(两端同形);交集保留
// index signature 供未来字段透传(前端整对象回传,不感知新字段)。
export type AsrProviderType = AsrProvider["type"];
export type AsrProviderProfile = AsrProvider & { [key: string]: unknown };
export type TtsProviderType = TtsProvider["type"];
export type TtsProviderProfile = TtsProvider & { [key: string]: unknown };

/**
 * 应用内快捷键的 action 标识。和后端 defaultSettings().keybindings 的 key 一一对应,
 * 改动需同步后端 + 前端默认表(DEFAULT_KEYBINDINGS in lib/hotkeys.ts)。
 */
export type KeybindingAction =
  | "newConversation"
  | "prevConversation"
  | "nextConversation"
  | "renameConversation"
  | "searchConversations"
  | "openSettings"
  | "openImageGeneration"
  | "zoomInOut";

/** 单条快捷键绑定。keys 为 token 数组(如 ["Ctrl","N"]);zoomInOut 例外无 keys(滚轮固定)。 */
export interface KeybindingEntry {
  keys?: string[];
  enabled: boolean;
}

/**
 * VIEW-REFINED 清单:这些顶层键在服务端是透传存储形状(JsonValue[] / Record<string, JsonValue>
 * / 严格存储实体),前端换成 UI 视图形状。新增视图细化时在此登记并在下方 Settings 里声明。
 */
type ViewRefinedKey =
  | "displaySetting"
  | "keybindings"
  | "providers"
  | "assistants"
  | "assistantTags"
  | "mcpServers"
  | "searchServices"
  | "quickMessages"
  | "modeInjections"
  | "lorebooks"
  | "asrProviders"
  | "ttsProviders";

/**
 * Global app settings. The backend pushes the full object via the `/api/events` channel
 * (settings event) whenever any field changes, and the SPA mirrors it into the Zustand
 * settings slice. 顶层键以服务端 Settings 为准(normalizeState 保证全字段在场,故无可选);
 * 仅 ViewRefinedKey 列出的字段替换为前端视图形状。
 */
export interface Settings extends Omit<ServerSettings, ViewRefinedKey> {
  displaySetting: DisplaySetting;
  /** 应用内快捷键绑定。PC-only(备份导出时后端剥离,Android 不可见)。 */
  keybindings: Partial<Record<KeybindingAction, KeybindingEntry>>;
  providers: ProviderProfile[];
  assistants: AssistantProfile[];
  assistantTags: AssistantTag[];
  mcpServers: McpServerConfig[];
  searchServices: SearchServiceOption[];
  quickMessages: QuickMessage[];
  modeInjections: ModeInjectionProfile[];
  lorebooks: LorebookProfile[];
  asrProviders: AsrProviderProfile[];
  ttsProviders: TtsProviderProfile[];
}
