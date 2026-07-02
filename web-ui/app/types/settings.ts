/**
 * Display settings — user nickname, avatar, theme, fonts and other purely visual preferences.
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
  /** User-resizable chat input min-height in px (null = default). PC-only. */
  chatInputHeight?: number | null;
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
  // Per-assistant overrides for individual MCP tools. See server.ts:Assistant.mcpToolOverrides
  // for the full semantics. Shape: { [serverId]: { [toolName]: { enable?, needsApproval? } } }.
  mcpToolOverrides?: Record<string, Record<string, McpToolOverride>>;
  modeInjectionIds?: string[];
  lorebookIds?: string[];
  allowConversationSystemPrompt?: boolean;
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

export type ModelType = "CHAT" | "IMAGE" | "EMBEDDING";
// PC keeps the wider Modality list (AUDIO/VIDEO/DOCUMENT) for forward-compat with providers
// that already accept those — Android only has TEXT/IMAGE today but we don't want PC to ship
// narrower than the upstream API allows.
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
   * override instead. See server.ts:findModel for the request-build merge logic.
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
  /** OpenAI providers only — 是否在历史回放里把 reasoning_content 回传给上游（默认开启）。对齐安卓 e63d017。 */
  includeHistoryReasoning?: boolean;
  [key: string]: unknown;
}

export interface SearchServiceOption {
  id: string;
  type?: string;
  [key: string]: unknown;
}

export type AsrProviderType = "openai_realtime" | "dashscope" | "volcengine";

export interface AsrProviderProfile {
  id: string;
  type: AsrProviderType;
  name: string;
  apiKey: string;
  websocketUrl: string;
  model?: string;
  language?: string;
  prompt?: string;
  sampleRate?: number;
  vadThreshold?: number;
  prefixPaddingMs?: number;
  silenceDurationMs?: number;
  resourceId?: string;
  [key: string]: unknown;
}

export type TtsProviderType =
  | "system"
  | "openai"
  | "gemini"
  | "minimax"
  | "qwen"
  | "groq"
  | "xai"
  | "mimo";

export interface TtsProviderProfile {
  id: string;
  type: TtsProviderType;
  name: string;
  apiKey: string;
  baseUrl: string;
  model?: string;
  voice?: string;
  voiceName?: string;
  voiceId?: string;
  language?: string;
  languageType?: string;
  emotion?: string;
  speed?: number;
  speechRate?: number;
  pitch?: number;
  [key: string]: unknown;
}

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

/** 记忆写入策略(1.3.2)。后端 memorySettings.writeStrategy 的前端镜像。 */
export type WriteStrategy = "ask" | "always_assistant" | "always_global" | "readonly";

export interface MemorySettings {
  globalEnabled: boolean;
  writeStrategy: WriteStrategy;
}

/** 一条记忆(运行时内部表示,含来源标记 source)。 */
export interface MemoryEntry {
  id: number;
  content: string;
  createdAt: number;
  updatedAt: number;
  source: "manual" | "ai";
}

/** 助手记忆分组(assistant_memory.json 结构,含助手名快照)。 */
export interface AssistantMemoryGroup {
  assistantId: string;
  assistantName: string;
  memories: MemoryEntry[];
}

/** 待确认记忆条目(模型提议,等用户处理)。 */
export interface PendingEntry {
  pendingId: string;
  conversationId: string;
  assistantId: string;
  assistantName: string;
  content: string;
  proposedAt: number;
  messageNodeId?: string;
}

/** memory SSE(/api/memory/stream)推送的完整快照。 */
export interface MemorySnapshot {
  globalEnabled: boolean;
  writeStrategy: WriteStrategy;
  globalMemories: MemoryEntry[];
  assistantMemories: AssistantMemoryGroup[];
  pending: PendingEntry[];
  pendingCount: number;
}

/**
 * Global app settings. The backend pushes the full object via SSE on `/api/settings/stream`
 * whenever any field changes, and the SPA mirrors it into the Zustand settings slice.
 */
export interface Settings {
  dynamicColor: boolean;
  themeId: string;
  developerMode: boolean;
  displaySetting: DisplaySetting;
  enableWebSearch: boolean;
  favoriteModels: string[];
  chatModelId: string;
  titleModelId?: string;
  translateModeId?: string;
  suggestionModelId?: string;
  imageGenerationModelId?: string;
  ocrModelId?: string;
  compressModelId?: string;
  /** 模型 ID,用于对话界面"优化提示词"按钮。空串 = 未配置。 */
  promptOptimizeModelId?: string;
  /** "优化提示词"按钮使用的 meta-prompt。空串 = 用默认模板。 */
  promptOptimizePrompt?: string;
  titlePrompt?: string;
  translatePrompt?: string;
  suggestionPrompt?: string;
  ocrPrompt?: string;
  compressPrompt?: string;
  asrProviders?: AsrProviderProfile[];
  selectedASRProviderId?: string | null;
  ttsProviders?: TtsProviderProfile[];
  selectedTTSProviderId?: string | null;
  assistantId: string;
  providers: ProviderProfile[];
  assistants: AssistantProfile[];
  assistantTags: AssistantTag[];
  modeInjections?: ModeInjectionProfile[];
  lorebooks?: LorebookProfile[];
  mcpServers: McpServerConfig[];
  searchServices: SearchServiceOption[];
  quickMessages?: QuickMessage[];
  searchServiceSelected: number;
  /** Preferred local server port (null = auto, default 8080). PC-only; restart required. */
  preferredPort?: number | null;
  /** 应用内快捷键绑定。PC-only(备份导出时后端剥离,Android 不可见)。 */
  keybindings?: Partial<Record<KeybindingAction, KeybindingEntry>>;
  /** 1.3.2 记忆设置。globalEnabled 控制全局记忆层注入;writeStrategy 控制模型提议记忆的处理。 */
  memorySettings?: MemorySettings;
  [key: string]: unknown;
}
