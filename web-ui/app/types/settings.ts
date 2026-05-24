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
  uiFontFamily?: string;
  chatFontFamily?: string;
  uiFontFamilyCss?: string;
  chatFontFamilyCss?: string;
  pasteLongTextAsFile: boolean;
  pasteLongTextThreshold: number;
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

export type TtsProviderType = "system" | "openai" | "gemini" | "minimax" | "qwen" | "groq" | "xai" | "mimo";

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
  [key: string]: unknown;
}
