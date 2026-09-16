// app-config/defaults.ts — 出厂默认设置与默认 State（含跨端契约 ID，不可改动）
// 纪律：纯搬迁自 server.ts（阶段 5.3h），行为不变。

import type { State } from "../foundation/types";
import type { Settings } from "../foundation/types/settings";
import { id } from "../foundation/utils";
import { RUNNING_IN_CONTAINER } from "../foundation/platform";
import { DEFAULT_AUTO_MODEL_ID, defaultProviders } from "../model-providers";
import { DEFAULT_SYSTEM_TTS_ID, defaultTtsProviders } from "../media/tts";
import { defaultAssistant } from "../assistants";
import { defaultRequestStats } from "../api/logs";
import {
  DEFAULT_COMPRESS_PROMPT,
  DEFAULT_OCR_PROMPT,
  DEFAULT_PROMPT_OPTIMIZE_PROMPT,
  DEFAULT_SUGGESTION_PROMPT,
  DEFAULT_TITLE_PROMPT,
  DEFAULT_TRANSLATION_PROMPT,
} from "./prompts";

export const DEFAULT_LEARNING_MODE_ID = "b87eaf16-f5cd-4ac1-9e4f-b11ae3a61d74";
// 一次性下架的预置 TTS 供应商。留在 server.ts 是因为 normalizeState 仍需要它;
// 等 media/ 模块拆分后再迁走。
export const SUNSET_TTS_PROVIDER_IDS = new Set<string>([
  "e36b22ef-ca82-40ab-9e70-60cad861911c", // AiHubMix (TTS)
]);
// Mirrors `MemoryRepository.kt:11` in the original RikkaHub project. Keeping the literal
// value identical means a `state.json` produced on one platform can be imported on the
// other without losing the global-scope memory records.
// ── Analytics (anonymous DAU tracking) ────────────────────────────────────
// One ping per app start + periodic updates during the session.  Sends only:
//   device UUID, date, version, OS, cumulative message count for the day.
// No user content, no IP storage, no model names, no file names.
//
// 设计准则:
//   - 完全静默:无网络/DNS 失败/防火墙拦截都不能让用户看到任何报错
//   - 不阻塞:fetch 出错只能被 Promise 链吞掉,绝不能冒泡成 UnhandledRejection
//   - 不持久错误状态:连续失败不退避、不停跳,因为我们根本不关心是否送达

/** 默认助手系统提示词(a63d46b 起为天级 Date: {{cur_date}}——秒级 cur_datetime 会让
 *  每条消息的 system 都变,从该行起前缀缓存全部失效)。改动本串时注意 state-load 的
 *  D7 迁移链:旧串由本串反推,"与旧默认逐字相等"才替换。 */
export const DEFAULT_ASSISTANT_SYSTEM_PROMPT =
  "You are a helpful assistant, called {{char}}, based on model {{model_name}}.\n\n## Info\n- Date: {{cur_date}}\n- Locale: {{locale}}\n- Timezone: {{timezone}}\n- Device Info: {{device_info}}\n- System Version: {{system_version}}\n- User Nickname: {{user}}\n\n## Hint\n- If the user does not specify a language, reply in the user's primary language.\n- Remember to use Markdown syntax for formatting, and use latex for mathematical expressions.\n\n## Search\n- You must use English keywords when searching to get higher quality sources.\n- Chinese sources are generally of low quality.";

export function defaultSettings(): Settings {
  const assistant = defaultAssistant();
  return {
    dynamicColor: true,
    themeId: "default",
    developerMode: false,
    displaySetting: {
      userAvatar: { type: "dummy" },
      userNickname: "",
      showUserAvatar: true,
      showAssistantBubble: false,
      showModelIcon: true,
      showModelName: true,
      showTokenUsage: true,
      showThinkingContent: true,
      uiFontFamily: "Noto Sans SC",
      chatFontFamily: "",
      uiFontFamilyCss: "\"Noto Sans SC\", \"Microsoft YaHei\", sans-serif",
      chatFontFamilyCss: "",
      autoCloseThinking: true,
      codeBlockAutoWrap: false,
      codeBlockAutoCollapse: false,
      showLineNumbers: false,
      // 域13-2(交互审查 3C):默认 Enter 发送(对齐主流桌面 IM)。normalizeState 用
      // { ...defaults, ...persisted } 合并——存量用户显式保存过的 false 原样保留,
      // 本默认值只影响新装机与缺省字段回填。前端 chat-input 的 ?? true 兜底同向。
      sendOnEnter: true,
      enableAutoScroll: true,
      fontSizeRatio: 1,
      // 界面字号缩放(建议 0.85–1.20)。null = 不缩放,根字号保持浏览器默认 16px。PC-only,
      // 已在 pcOnlyDisplayFields 清单里,导出备份时剥离,Android 不可见。
      uiFontSize: null,
      pasteLongTextAsFile: false,
      pasteLongTextThreshold: 1000,
      // User-resizable chat input height in px (null = default min). Persisted across
      // restarts via displaySetting. PC-only — stripped before syncing to Android.
      chatInputHeight: null,
    },
    enableWebSearch: false,
    favoriteModels: [],
    chatModelId: DEFAULT_AUTO_MODEL_ID,
    titleModelId: DEFAULT_AUTO_MODEL_ID,
    translateModeId: DEFAULT_AUTO_MODEL_ID,
    translateThinkingBudget: 0,
    suggestionModelId: DEFAULT_AUTO_MODEL_ID,
    imageGenerationModelId: "",
    ocrModelId: "",
    compressModelId: DEFAULT_AUTO_MODEL_ID,
    promptOptimizeModelId: "",
    promptOptimizePrompt: DEFAULT_PROMPT_OPTIMIZE_PROMPT,
    titlePrompt: DEFAULT_TITLE_PROMPT,
    translatePrompt: DEFAULT_TRANSLATION_PROMPT,
    suggestionPrompt: DEFAULT_SUGGESTION_PROMPT,
    ocrPrompt: DEFAULT_OCR_PROMPT,
    compressPrompt: DEFAULT_COMPRESS_PROMPT,
    asrProviders: [],
    selectedASRProviderId: null,
    ttsProviders: defaultTtsProviders(),
    selectedTTSProviderId: DEFAULT_SYSTEM_TTS_ID,
    assistantId: assistant.id,
    providers: defaultProviders(),
    assistants: [
      assistant,
      {
        ...defaultAssistant(),
        id: "3d47790c-c415-4b90-9388-751128adb0a0",
        systemPrompt: DEFAULT_ASSISTANT_SYSTEM_PROMPT,
      },
    ],
    assistantTags: [],
    // 默认搜索服务清单,顺序对齐 APP SearchServiceOptions.TYPES("add provider" 选择器顺序)。
    // bing_local/rikkahub 是免测预置;其余带空 key 待用户配置。custom_js 不进默认(需写脚本,由用户手动添加)。
    searchServices: [
      { type: "bing_local", id: id(), name: "Bing" },
      { type: "rikkahub", id: id(), name: "RikkaHub", apiKey: "", depth: "standard" },
      { type: "zhipu", id: id(), name: "智谱", apiKey: "" },
      { type: "doubao", id: id(), name: "豆包", apiKey: "", mode: "custom" },
      { type: "tavily", id: id(), name: "Tavily", apiKey: "", depth: "advanced" },
      { type: "exa", id: id(), name: "Exa", apiKey: "" },
      { type: "searxng", id: id(), name: "SearXNG", url: "", engines: "", language: "" },
      { type: "linkup", id: id(), name: "LinkUp", apiKey: "", depth: "standard" },
      { type: "brave", id: id(), name: "Brave", apiKey: "" },
      { type: "metaso", id: id(), name: "秘塔", apiKey: "" },
      { type: "ollama", id: id(), name: "Ollama", apiKey: "" },
      { type: "perplexity", id: id(), name: "Perplexity", apiKey: "" },
      { type: "firecrawl", id: id(), name: "Firecrawl", apiKey: "" },
      { type: "jina", id: id(), name: "Jina", apiKey: "" },
      { type: "bocha", id: id(), name: "博查", apiKey: "" },
      { type: "grok", id: id(), name: "Grok", apiKey: "", customUrl: "https://api.x.ai/v1/responses", model: "grok-4-fast" },
      { type: "tinyfish", id: id(), name: "Tinyfish", apiKey: "" },
      { type: "serper", id: id(), name: "Serper", apiKey: "" },
    ],
    searchCommonOptions: { resultSize: 10 },
    searchServiceSelected: 0,
    dismissedSearchServiceTypes: [],
    mcpServers: [],
    modeInjections: [
      {
        type: "mode",
        id: DEFAULT_LEARNING_MODE_ID,
        name: "Learning Mode",
        enabled: true,
        priority: 0,
        position: "after_system_prompt",
        content: "Use Socratic guidance. Ask questions, give hints, and help the user build understanding.",
        injectDepth: 4,
        role: "USER",
      },
    ],
    lorebooks: [],
    quickMessages: [],
    webDavConfig: {
      url: "",
      username: "",
      password: "",
      path: "rikkahub_backups",
      items: ["DATABASE", "FILES"],
    },
    s3Config: {
      endpoint: "",
      accessKeyId: "",
      secretAccessKey: "",
      bucket: "",
      region: "auto",
      pathStyle: true,
      items: ["DATABASE", "FILES"],
    },
    proxyConfig: {
      // 容器部署默认 env(docker 注入 HTTPS_PROXY); 桌面默认 auto(跟随系统代理)
      mode: RUNNING_IN_CONTAINER ? "env" : "auto",
      url: "",
      username: "",
      password: "",
      bypassRules: "",
    },
    webServerJwtEnabled: false,
    preferredPort: null,
    workspaceLastPermissionPreset: null,
    shellPath: "",
    keybindings: {
      newConversation: { keys: ["Ctrl", "N"], enabled: true },
      prevConversation: { keys: ["Alt", "Up"], enabled: true },
      nextConversation: { keys: ["Alt", "Down"], enabled: true },
      renameConversation: { keys: ["F2"], enabled: true },
      searchConversations: { keys: ["Ctrl", "Shift", "F"], enabled: true },
      openSettings: { keys: ["Ctrl", ","], enabled: true },
      openImageGeneration: { keys: ["Ctrl", "I"], enabled: true },
      // 滚轮缩放:binding 固定为 Ctrl+Wheel,无法录制,只有 enabled 开关。
      zoomInOut: { enabled: true },
    },
    // 默认开启全局记忆层(叠加注入开箱可用)。老用户迁移时由 normalizeState 的 M1 逻辑
    // 推断:若所有助手 enableMemory=false,改为 false(避免被动注入全局记忆)。
    memorySettings: {
      globalEnabled: true,
      writeStrategy: "ask",
    },
  };
}

export function defaultState(): State {
  return {
    settings: defaultSettings(),
    conversations: [],
    files: [],
    generatedImages: [],
    logs: [],
    stats: defaultRequestStats(),
    nextFileId: 1,
    nextGeneratedImageId: 1,
    launchCount: 0,
  };
}
