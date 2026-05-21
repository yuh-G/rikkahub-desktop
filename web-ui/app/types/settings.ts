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

export interface AssistantProfile {
  id: string;
  chatModelId?: string | null;
  reasoningLevel?: string | null;
  mcpServers?: string[];
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
export type ModelModality = "TEXT" | "IMAGE" | "AUDIO" | "VIDEO" | "DOCUMENT";
export type ModelAbility = "TOOL" | "REASONING";

export interface BuiltInTool {
  type?: string;
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
