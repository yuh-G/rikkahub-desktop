import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import process from "node:process";
import { gunzipSync, gzipSync, inflateRawSync } from "node:zlib";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface Model {
  id: string;
  modelId: string;
  displayName: string;
  type: "CHAT" | "IMAGE" | "EMBEDDING";
  inputModalities: string[];
  outputModalities: string[];
  abilities: string[];
  tools: JsonValue[];
}

interface Provider {
  type: "openai" | "google" | "claude";
  id: string;
  enabled: boolean;
  name: string;
  builtIn: boolean;
  shortDescription: string;
  description: string;
  apiKey: string;
  baseUrl: string;
  chatCompletionsPath?: string;
  useResponseApi?: boolean;
  promptCaching?: boolean;
  promptCacheTtl?: "5m" | "1h";
  testPassed?: boolean;
  testPassedAt?: number;
  models: Model[];
  balanceOption: {
    enabled: boolean;
    apiPath: string;
    resultPath: string;
  };
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

interface ProxyConfig {
  // User-set proxy URL. Empty string means "follow the system proxy automatically"
  // (Windows registry → Bun env), matching browser-like behavior for non-technical users.
  url: string;
  // Optional HTTP basic auth credentials, applied as `http://user:pass@host:port` when
  // forwarding to upstream APIs.
  username: string;
  password: string;
}

interface Assistant {
  id: string;
  chatModelId: string | null;
  name: string;
  avatar: Record<string, JsonValue>;
  useAssistantAvatar: boolean;
  tags: string[];
  systemPrompt: string;
  temperature: number | null;
  topP: number | null;
  contextMessageSize: number;
  streamOutput: boolean;
  enableMemory: boolean;
  useGlobalMemory: boolean;
  enableRecentChatsReference: boolean;
  messageTemplate: string;
  presetMessages: JsonValue[];
  quickMessageIds: string[];
  regexes: JsonValue[];
  reasoningLevel: string;
  maxTokens: number | null;
  customHeaders: JsonValue[];
  customBodies: JsonValue[];
  mcpServers: string[];
  localTools: JsonValue[];
  background: string | null;
  backgroundOpacity: number;
  modeInjectionIds: string[];
  lorebookIds: string[];
  enabledSkills: string[];
  enableTimeReminder: boolean;
  allowConversationSystemPrompt: boolean;
}

interface Settings {
  dynamicColor: boolean;
  themeId: string;
  developerMode: boolean;
  displaySetting: Record<string, JsonValue>;
  enableWebSearch: boolean;
  favoriteModels: string[];
  chatModelId: string;
  titleModelId: string;
  translateModeId: string;
  suggestionModelId: string;
  imageGenerationModelId: string;
  ocrModelId: string;
  compressModelId: string;
  translateThinkingBudget?: number;
  titlePrompt: string;
  translatePrompt: string;
  suggestionPrompt: string;
  ocrPrompt: string;
  compressPrompt: string;
  asrProviders: AsrProvider[];
  selectedASRProviderId: string | null;
  ttsProviders: TtsProvider[];
  selectedTTSProviderId: string | null;
  assistantId: string;
  providers: Provider[];
  assistants: Assistant[];
  assistantTags: JsonValue[];
  searchServices: JsonValue[];
  searchCommonOptions: Record<string, JsonValue>;
  searchServiceSelected: number;
  mcpServers: JsonValue[];
  modeInjections: JsonValue[];
  lorebooks: JsonValue[];
  quickMessages: JsonValue[];
  webDavConfig: WebDavConfig;
  s3Config: S3Config;
  proxyConfig: ProxyConfig;
  webServerJwtEnabled: boolean;
}

interface AsrProvider {
  type: "openai_realtime" | "dashscope" | "volcengine";
  id: string;
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
}

interface TtsProvider {
  type: "system" | "openai" | "gemini" | "minimax" | "qwen" | "groq" | "xai" | "mimo";
  id: string;
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
}

interface Message {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM" | "TOOL";
  parts: JsonValue[];
  annotations: JsonValue[];
  createdAt: string;
  finishedAt: string | null;
  modelId: string | null;
  usage: JsonValue | null;
  translation: string | null;
}

interface MessageNode {
  id: string;
  messages: Message[];
  selectIndex: number;
}

interface AssistantMemory {
  id: number;
  assistantId: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

interface Conversation {
  id: string;
  assistantId: string;
  systemPrompt: string | null;
  title: string;
  messages: MessageNode[];
  truncateIndex: number;
  chatSuggestions: string[];
  isPinned: boolean;
  createAt: number;
  updateAt: number;
}

interface RequestLog {
  id: string;
  at: number;
  providerId: string;
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

interface DailyStat {
  date: string;
  messages: number;
  conversations: number;
  characters: number;
}

interface StoredFile {
  id: number;
  path: string;
  fileName: string;
  mime: string;
  size: number;
  extractedText?: string;
  extractedAt?: number;
}

interface GeneratedImage {
  id: string;
  prompt: string;
  fileId: number;
  url: string;
  fileName: string;
  mime: string;
  model: string;
  modelId: string;
  type: "image_generation" | "image_edit";
  sourceFileIds: number[];
  sourcePaths?: string;
  createdAt: number;
}

interface State {
  settings: Settings;
  conversations: Conversation[];
  files: StoredFile[];
  generatedImages: GeneratedImage[];
  logs: RequestLog[];
  memories: AssistantMemory[];
  nextFileId: number;
  nextMemoryId: number;
  nextGeneratedImageId: number;
  launchCount: number;
}

type SearchService = Record<string, JsonValue>;
type SkillMetadata = {
  name: string;
  description: string;
  compatibility?: string;
  allowedTools: string[];
};

const DEFAULT_AUTO_MODEL_ID = "b7055fb4-39f9-4042-a88a-0d80ed76cf08";
const DEFAULT_ASSISTANT_ID = "0950e2dc-9bd5-4801-afa3-aa887aa36b4e";
const DEFAULT_LEARNING_MODE_ID = "b87eaf16-f5cd-4ac1-9e4f-b11ae3a61d74";
// Mirrors `MemoryRepository.kt:11` in the original RikkaHub project. Keeping the literal
// value identical means a `state.json` produced on one platform can be imported on the
// other without losing the global-scope memory records.
const GLOBAL_MEMORY_ID = "__global__";
const DEFAULT_SYSTEM_TTS_ID = "026a01a2-c3a0-4fd5-8075-80e03bdef200";
const MAX_TOOL_STEPS = 256;
const TITLE_CHARACTER_LIMIT = 15;
const SUGGESTION_CHARACTER_LIMIT = 18;

const DEFAULT_TITLE_PROMPT = `I will give you some dialogue content in the \`<content>\` block.
You need to summarize the conversation between user and assistant into a short title.
1. The title language should be consistent with the user's primary language
2. Do not use punctuation or other special symbols
3. Reply directly with the title
4. Summarize using {locale} language
5. The title should not exceed ${TITLE_CHARACTER_LIMIT} characters

<content>
{content}
</content>`;

const DEFAULT_SUGGESTION_PROMPT = `I will provide you with some chat content in the \`<content>\` block, including conversations between the User and the AI assistant.
You need to act as the **User** to reply to the assistant, generating 3~5 appropriate and contextually relevant responses to the assistant.

Rules:
1. Reply directly with suggestions, do not add any formatting, and separate suggestions with newlines, no need to add markdown list formats.
2. Use {locale} language.
3. Ensure each suggestion is valid.
4. Each suggestion should not exceed ${SUGGESTION_CHARACTER_LIMIT} characters.
5. Imitate the user's previous conversational style.
6. Act as a User, not an Assistant!

<content>
{content}
</content>`;

const DEFAULT_TRANSLATION_PROMPT = `You are a translation expert, skilled in translating various languages, and maintaining accuracy, faithfulness, and elegance in translation.
Next, I will send you text. Please translate it into {target_lang}, and return the translation result directly, without adding any explanations or other content.

Please translate the <source_text> section:

<source_text>
{source_text}
</source_text>`;

const DEFAULT_OCR_PROMPT = `You are an OCR assistant.

Extract all visible text from the image and also describe any non-text elements (icons, shapes, arrows, objects, symbols, or emojis).

For each element, specify:
- The exact text (for text) or a short description (for non-text).
- For document-type content, please use markdown and latex format.
- If there are objects like buildings or characters, try to identify who they are.
- Its approximate position in the image (e.g., 'top left', 'center right', 'bottom middle').
- Its spatial relationship to nearby elements (e.g., 'above', 'below', 'next to', 'on the left of').

Keep the original reading order and layout structure as much as possible.
Do not interpret or translate—only transcribe and describe what is visually present.`;

const DEFAULT_COMPRESS_PROMPT = `You are a conversation compression assistant. Compress the following conversation into a concise summary.

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
</conversation>`;

const sourceRootDir = resolve(import.meta.dir, "..");
const executableDir = dirname(process.execPath);
const rootDir = existsSync(join(executableDir, "web-ui")) ? executableDir : sourceRootDir;
const dataDir = resolve(process.env.RIKKAHUB_PC_DATA_DIR ?? join(rootDir, "pc-data"));
const filesDir = join(dataDir, "files");
const skillsDir = join(dataDir, "skills");
const statePath = join(dataDir, "state.json");

function id() {
  return crypto.randomUUID();
}

const LOG_PREVIEW_LIMIT = 256_000;

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function inferModelAbilities(modelId: string): string[] {
  const name = modelId.toLowerCase();
  const abilities: string[] = [];
  if (/(^|[/:_-])(gpt-[45]|o[134]|claude|gemini|deepseek|qwen|qwq|qvq|glm|kimi|moonshot|doubao|hunyuan|grok|llama|mistral|mixtral|command|sonar|perplexity|mimo)/i.test(modelId)) {
    abilities.push("TOOL");
  }
  // Reasoning detection mirrors Android's ModelRegistry. Note that Claude family names like
  // `claude-opus-4-6` don't contain literal "claude-4" as a substring (there's `opus` between),
  // so we match either the legacy `claude-3.7 / claude-4` patterns OR any modern variant of
  // claude-{opus,sonnet,haiku}-X to catch all Anthropic models 3.5+ which all support thinking.
  if (/(gpt-5|^o[134]|[/:_-]o[134]|reason|reasoning|thinking|deepseek-r1|deepseek-reasoner|deepseek-v4|deepseek.*v4|qwq|qvq|qwen3|glm-[45]|glm-z1|hunyuan-a13b|mimo-v2|claude-3[.-]7|claude-4|claude-(opus|sonnet|haiku)-(3[.-]7|[4-9]|\d{2,})|gemini-2[.-]5|gemini-3|grok-4)/i.test(name)) {
    abilities.push("REASONING");
  }
  return uniqueStrings(abilities);
}

function inferModelTools(modelId: string): JsonValue[] {
  return /(gemini-2|gemini-3|sonar|perplexity|grok|search|online|web|glm-4\.5|kimi-k2|doubao-seed|hunyuan)/i.test(modelId)
    ? [{ type: "search" }]
    : [];
}

function inferInputModalities(modelId: string, raw?: any): string[] {
  const declared = [
    ...(Array.isArray(raw?.input_modalities) ? raw.input_modalities : []),
    ...(Array.isArray(raw?.inputModalities) ? raw.inputModalities : []),
  ].map((item) => String(item).toUpperCase());
  if (declared.length) return uniqueStrings(declared);
  return /(vision|visual|vl|omni|gpt-4o|gpt-4\.1|gemini|claude-3|claude-4|qwen.*vl|glm-4v|grok-vision|llava|pixtral|mimo[-_./:]?v?2[-_./:]?5|mimo[-_./:]?v?2[-_./:]?omni)/i.test(modelId)
    ? ["TEXT", "IMAGE"]
    : ["TEXT"];
}

function inferOutputModalities(modelId: string, raw?: any): string[] {
  const declared = [
    ...(Array.isArray(raw?.output_modalities) ? raw.output_modalities : []),
    ...(Array.isArray(raw?.outputModalities) ? raw.outputModalities : []),
    ...(Array.isArray(raw?.modalities) ? raw.modalities : []),
  ].map((item) => String(item).toUpperCase());
  if (declared.length) return uniqueStrings(declared);
  return /(dall-e|gpt-image|image|imagen|flux|stable-diffusion|sd3|midjourney|recraft)/i.test(modelId)
    ? ["TEXT", "IMAGE"]
    : ["TEXT"];
}

function enrichModel(input: Model, raw?: any): Model {
  const abilities = uniqueStrings([...(input.abilities ?? []), ...inferModelAbilities(input.modelId)]);
  const inputModalities = uniqueStrings([...(input.inputModalities ?? []), ...inferInputModalities(input.modelId, raw)]);
  const outputModalities = uniqueStrings([...(input.outputModalities ?? []), ...inferOutputModalities(input.modelId, raw)]);
  const tools = (input.tools?.length ? input.tools : inferModelTools(input.modelId)) as JsonValue[];
  return {
    ...input,
    abilities,
    inputModalities: inputModalities.length ? inputModalities : ["TEXT"],
    outputModalities: outputModalities.length ? outputModalities : ["TEXT"],
    tools,
  };
}

function model(modelId: string, displayName = modelId): Model {
  return enrichModel({
    id: id(),
    modelId,
    displayName,
    type: "CHAT",
    inputModalities: ["TEXT"],
    outputModalities: ["TEXT"],
    abilities: [],
    tools: [],
  });
}

function provider(input: Partial<Provider> & Pick<Provider, "id" | "name" | "baseUrl">): Provider {
  return {
    type: "openai",
    enabled: false,
    builtIn: true,
    shortDescription: "",
    description: "",
    apiKey: "",
    chatCompletionsPath: "/chat/completions",
    useResponseApi: false,
    promptCaching: false,
    promptCacheTtl: "5m",
    testPassed: input.name === "RikkaHub" || input.id === "a8d2d463-e8c0-41f2-b89e-f5eb8e716cce",
    models: [],
    balanceOption: { enabled: false, apiPath: "/credits", resultPath: "data.total_usage" },
    ...input,
  };
}

function defaultProviders(): Provider[] {
  return [
    provider({
      id: "a8d2d463-e8c0-41f2-b89e-f5eb8e716cce",
      name: "RikkaHub",
      baseUrl: "https://api.rikka-ai.com/v1",
      enabled: true,
      shortDescription: "RikkaHub built-in relay",
      description: "Built-in RikkaHub provider template, matching the Android default.",
      models: [
        {
          ...model("auto", "Auto"),
          id: DEFAULT_AUTO_MODEL_ID,
          abilities: ["TOOL", "REASONING"],
        },
      ],
    }),
    provider({
      id: "1eeea727-9ee5-4cae-93e6-6fb01a4d051e",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      shortDescription: "Official OpenAI-compatible API",
      models: [model("gpt-4.1"), model("gpt-4.1-mini"), model("gpt-4o-mini")],
    }),
    provider({
      id: "6ab18148-c138-4394-a46f-1cd8c8ceaa6d",
      type: "google",
      name: "Gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      enabled: true,
      shortDescription: "Google Gemini API",
      models: [model("gemini-2.5-flash"), model("gemini-2.5-pro")],
    }),
    provider({
      id: "1b1395ed-b702-4aeb-8bc1-b681c4456953",
      name: "AiHubMix",
      baseUrl: "https://aihubmix.com/v1",
      enabled: true,
      shortDescription: "Supports GPT, Claude, Gemini and 200+ models",
      description: "OpenAI-compatible multi-model gateway. Website: https://aihubmix.com",
    }),
    provider({
      id: "56a94d29-c88b-41c5-8e09-38a7612d6cf8",
      name: "硅基流动",
      baseUrl: "https://api.siliconflow.cn/v1",
      shortDescription: "SiliconFlow OpenAI-compatible API",
      balanceOption: { enabled: true, apiPath: "/user/info", resultPath: "data.totalBalance" },
    }),
    provider({
      id: "f099ad5b-ef03-446d-8e78-7e36787f780b",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      shortDescription: "DeepSeek official API",
      balanceOption: { enabled: true, apiPath: "/user/balance", resultPath: "balance_infos[0].total_balance" },
    }),
    provider({
      id: "d5734028-d39b-4d41-9841-fd648d65440e",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      shortDescription: "OpenRouter multi-model gateway",
      balanceOption: { enabled: true, apiPath: "/credits", resultPath: "data.total_credits - data.total_usage" },
    }),
    provider({
      id: "386e0f29-8228-4512-affe-8fd8add82d88",
      name: "Vercel AI Gateway",
      baseUrl: "https://ai-gateway.vercel.sh/v1",
      shortDescription: "Vercel AI Gateway",
      balanceOption: { enabled: true, apiPath: "/credits", resultPath: "balance" },
    }),
    provider({ id: "da020a90-f7b3-4c29-b90e-c511a0630630", name: "小马算力", baseUrl: "https://api.tokenpony.cn/v1" }),
    provider({ id: "f76cae46-069a-4334-ab8e-224e4979e58c", name: "阿里云百炼", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }),
    provider({ id: "3dfd6f9b-f9d9-417f-80c1-ff8d77184191", name: "火山引擎", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" }),
    provider({
      id: "d6c4d8c6-3f62-4ca9-a6f3-7ade6b15ecc3",
      name: "月之暗面",
      baseUrl: "https://api.moonshot.cn/v1",
      balanceOption: { enabled: true, apiPath: "/users/me/balance", resultPath: "data.available_balance" },
    }),
    provider({ id: "3bc40dc1-b11a-46fa-863b-6306971223be", name: "智谱AI开放平台", baseUrl: "https://open.bigmodel.cn/api/paas/v4" }),
    provider({ id: "f4f8870e-82d3-495b-9b64-d58e508b3b2c", name: "阶跃星辰", baseUrl: "https://api.stepfun.com/v1" }),
    provider({ id: "da93779f-3956-48cc-82ef-67bb482eaaf7", name: "302.AI", baseUrl: "https://api.302.ai/v1" }),
    provider({ id: "ef5d149b-8e34-404b-818c-6ec242e5c3c5", name: "腾讯Hunyuan", baseUrl: "https://api.hunyuan.cloud.tencent.com/v1" }),
    provider({ id: "ff3cde7e-0f65-43d7-8fb2-6475c99f5990", name: "xAI", baseUrl: "https://api.x.ai/v1", useResponseApi: true }),
    provider({ id: "53027b08-1b58-43d5-90ed-29173203e3d8", name: "AckAI", baseUrl: "https://ackai.fun/v1" }),
    provider({ id: "4da09554-8844-4cc8-a4a9-fe1b2515e91b", name: "UnifyLLM", baseUrl: "https://apicn.unifyllm.top/v1" }),
  ];
}

function defaultAssistant(): Assistant {
  return {
    id: DEFAULT_ASSISTANT_ID,
    chatModelId: null,
    name: "",
    avatar: { type: "dummy" },
    useAssistantAvatar: false,
    tags: [],
    systemPrompt: "",
    temperature: null,
    topP: null,
    contextMessageSize: 0,
    streamOutput: true,
    enableMemory: false,
    useGlobalMemory: false,
    enableRecentChatsReference: false,
    messageTemplate: "{{ message }}",
    presetMessages: [],
    quickMessageIds: [],
    regexes: [],
    reasoningLevel: "AUTO",
    maxTokens: null,
    customHeaders: [],
    customBodies: [],
    mcpServers: [],
    localTools: [{ type: "time_info" }],
    background: null,
    backgroundOpacity: 1,
    modeInjectionIds: [],
    lorebookIds: [],
    enabledSkills: [],
    enableTimeReminder: false,
    allowConversationSystemPrompt: false,
  };
}

function defaultSettings(): Settings {
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
      sendOnEnter: false,
      enableAutoScroll: true,
      fontSizeRatio: 1,
      pasteLongTextAsFile: false,
      pasteLongTextThreshold: 1000,
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
        systemPrompt:
          "You are a helpful assistant, called {{char}}, based on model {{model_name}}.\n\n## Info\n- Time: {{cur_datetime}}\n- Locale: {{locale}}\n- Timezone: {{timezone}}\n- Device Info: {{device_info}}\n- System Version: {{system_version}}\n- User Nickname: {{user}}\n\n## Hint\n- If the user does not specify a language, reply in the user's primary language.\n- Remember to use Markdown syntax for formatting, and use latex for mathematical expressions.\n\n## Search\n- You must use English keywords when searching to get higher quality sources.\n- Chinese sources are generally of low quality.",
      },
    ],
    assistantTags: [],
    searchServices: [
      { type: "bing_local", id: id(), name: "Bing" },
      { type: "rikkahub", id: id(), name: "RikkaHub", apiKey: "", depth: "standard" },
      { type: "tavily", id: id(), name: "Tavily", apiKey: "", depth: "advanced" },
      { type: "exa", id: id(), name: "Exa", apiKey: "" },
      { type: "zhipu", id: id(), name: "智谱", apiKey: "" },
      { type: "tinyfish", id: id(), name: "Tinyfish", apiKey: "" },
      { type: "perplexity", id: id(), name: "Perplexity", apiKey: "" },
      { type: "bocha", id: id(), name: "博查", apiKey: "" },
      { type: "linkup", id: id(), name: "LinkUp", apiKey: "", depth: "standard" },
      { type: "metaso", id: id(), name: "秘塔", apiKey: "" },
      { type: "ollama", id: id(), name: "Ollama", apiKey: "" },
      { type: "jina", id: id(), name: "Jina", apiKey: "" },
      { type: "firecrawl", id: id(), name: "Firecrawl", apiKey: "" },
      { type: "grok", id: id(), name: "Grok", apiKey: "", customUrl: "https://api.x.ai/v1/responses", model: "grok-4-fast" },
    ],
    searchCommonOptions: { resultSize: 10 },
    searchServiceSelected: 0,
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
      region: "us-east-1",
      accessKeyId: "",
      secretAccessKey: "",
      bucket: "",
      prefix: "rikkahub_backups",
      forcePathStyle: false,
      items: ["DATABASE", "FILES"],
    },
    proxyConfig: {
      url: "",
      username: "",
      password: "",
    },
    webServerJwtEnabled: false,
  };
}

function defaultState(): State {
  return {
    settings: defaultSettings(),
    conversations: [],
    files: [],
    generatedImages: [],
    logs: [],
    memories: [],
    nextFileId: 1,
    nextMemoryId: 1,
    nextGeneratedImageId: 1,
    launchCount: 0,
  };
}

function normalizeState(input: Partial<State>): State {
  const fresh = defaultState();
  const parsedSettings = input.settings ?? fresh.settings;
  const normalized: State = {
    ...fresh,
    ...input,
    settings: {
      ...fresh.settings,
      ...parsedSettings,
    },
    conversations: Array.isArray(input.conversations)
      ? input.conversations.map((conversation) => ({
          ...conversation,
          systemPrompt: typeof conversation.systemPrompt === "string" ? conversation.systemPrompt : null,
        }))
      : [],
    files: Array.isArray(input.files) ? input.files : [],
    generatedImages: Array.isArray(input.generatedImages) ? input.generatedImages : [],
    logs: Array.isArray(input.logs) ? input.logs : [],
    memories: Array.isArray(input.memories) ? input.memories.filter(isRecord).map((memory, index) => {
      const now = Date.now();
      // Pre-2026-05 PC builds saved global-scope memories under "global" (without underscores).
      // Migrate any legacy records so they continue to surface for assistants with
      // `useGlobalMemory: true`, matching the Android schema literal.
      const rawAssistantId = String(memory.assistantId ?? memory.assistant_id ?? GLOBAL_MEMORY_ID);
      const assistantId = rawAssistantId === "global" ? GLOBAL_MEMORY_ID : rawAssistantId;
      return {
        id: Number(memory.id ?? index + 1),
        assistantId,
        content: String(memory.content ?? ""),
        createdAt: Number(memory.createdAt ?? memory.created_at ?? now),
        updatedAt: Number(memory.updatedAt ?? memory.updated_at ?? now),
      };
    }).filter((memory) => memory.content.trim()) : [],
    nextFileId: typeof input.nextFileId === "number" ? input.nextFileId : 1,
    nextMemoryId: typeof input.nextMemoryId === "number" ? input.nextMemoryId : 1,
    nextGeneratedImageId: typeof input.nextGeneratedImageId === "number" ? input.nextGeneratedImageId : 1,
    launchCount: typeof input.launchCount === "number" ? input.launchCount : 0,
  };
  const defaults = defaultSettings();
  normalized.settings.providers = mergeById(normalized.settings.providers ?? [], defaults.providers);
  normalized.settings.providers = normalized.settings.providers.map((providerItem) => ({
    ...providerItem,
    promptCaching: providerItem.type === "claude" ? providerItem.promptCaching === true : providerItem.promptCaching,
    promptCacheTtl: providerItem.promptCacheTtl === "1h" ? "1h" : "5m",
    models: (providerItem.models ?? []).map((item) => enrichModel(item)),
  }));
  normalized.settings.assistants = mergeById(normalized.settings.assistants ?? [], defaults.assistants);
  normalized.settings.displaySetting = { ...defaults.displaySetting, ...(normalized.settings.displaySetting ?? {}) };
  if (!String(normalized.settings.displaySetting.uiFontFamily ?? "").trim()) {
    normalized.settings.displaySetting.uiFontFamily = defaults.displaySetting.uiFontFamily;
    normalized.settings.displaySetting.uiFontFamilyCss = defaults.displaySetting.uiFontFamilyCss;
  }
  normalized.settings.titlePrompt = normalized.settings.titlePrompt || DEFAULT_TITLE_PROMPT;
  normalized.settings.translatePrompt = normalized.settings.translatePrompt || DEFAULT_TRANSLATION_PROMPT;
  normalized.settings.suggestionPrompt = normalized.settings.suggestionPrompt || DEFAULT_SUGGESTION_PROMPT;
  normalized.settings.ocrPrompt = normalized.settings.ocrPrompt || DEFAULT_OCR_PROMPT;
  normalized.settings.compressPrompt = normalized.settings.compressPrompt || DEFAULT_COMPRESS_PROMPT;
  normalized.settings.titlePrompt = normalized.settings.titlePrompt.replace(/not exceed 10 characters/gi, "not exceed 15 characters");
  normalized.settings.suggestionPrompt = normalized.settings.suggestionPrompt.replace(/not exceed 10 characters/gi, "not exceed 18 characters");
  // Backfill REASONING ability for previously-saved models (e.g. claude-opus-4-6) whose
  // abilities array was set before the inference regex covered them. Only adds — never removes.
  normalized.settings.providers = normalized.settings.providers.map((providerItem) => ({
    ...providerItem,
    models: (providerItem.models ?? []).map((modelItem) => {
      const inferred = inferModelAbilities(modelItem.modelId);
      const current = Array.isArray(modelItem.abilities) ? modelItem.abilities : [];
      const merged = uniqueStrings([...current, ...inferred]);
      return merged.length === current.length ? modelItem : { ...modelItem, abilities: merged };
    }),
  }));
  normalized.settings.searchServices = normalized.settings.searchServices?.length
    ? normalized.settings.searchServices
    : defaults.searchServices;
  normalized.settings.webDavConfig = normalizeWebDavConfig(normalized.settings.webDavConfig);
  normalized.settings.s3Config = normalizeS3Config(normalized.settings.s3Config);
  normalized.settings.proxyConfig = normalizeProxyConfig(normalized.settings.proxyConfig);
  if (!normalized.settings.searchServices.some((service) => String((service as Record<string, JsonValue>).type ?? "").toLowerCase() === "tinyfish")) {
    normalized.settings.searchServices = [
      ...normalized.settings.searchServices,
      { type: "tinyfish", id: id(), name: "Tinyfish", apiKey: "" },
    ];
  }
  // Backfill 2026-05 search service additions for existing installs.
  if (!normalized.settings.searchServices.some((service) => String((service as Record<string, JsonValue>).type ?? "").toLowerCase() === "firecrawl")) {
    normalized.settings.searchServices = [
      ...normalized.settings.searchServices,
      { type: "firecrawl", id: id(), name: "Firecrawl", apiKey: "" },
    ];
  }
  if (!normalized.settings.searchServices.some((service) => String((service as Record<string, JsonValue>).type ?? "").toLowerCase() === "grok")) {
    normalized.settings.searchServices = [
      ...normalized.settings.searchServices,
      { type: "grok", id: id(), name: "Grok", apiKey: "", customUrl: "https://api.x.ai/v1/responses", model: "grok-4-fast" },
    ];
  }
  normalized.settings.asrProviders = normalizeAsrProviders(normalized.settings.asrProviders);
  normalized.settings.selectedASRProviderId = normalized.settings.asrProviders.some((provider) => provider.id === normalized.settings.selectedASRProviderId)
    ? normalized.settings.selectedASRProviderId
    : normalized.settings.asrProviders[0]?.id ?? null;
  normalized.settings.ttsProviders = normalizeTtsProviders(normalized.settings.ttsProviders);
  normalized.settings.selectedTTSProviderId = normalized.settings.ttsProviders.some((provider) => provider.id === normalized.settings.selectedTTSProviderId)
    ? normalized.settings.selectedTTSProviderId
    : normalized.settings.ttsProviders[0]?.id ?? null;
  normalized.nextFileId = Math.max(
    normalized.nextFileId,
    ...normalized.files.map((file) => file.id + 1),
    1,
  );
  normalized.nextMemoryId = Math.max(
    normalized.nextMemoryId,
    ...normalized.memories.map((memory) => memory.id + 1),
    1,
  );
  normalized.nextGeneratedImageId = Math.max(
    normalized.nextGeneratedImageId,
    ...normalized.generatedImages.map((image) => Number(image.id) + 1).filter((value) => Number.isFinite(value)),
    1,
  );
  return normalized;
}

function defaultAsrProvider(type: AsrProvider["type"] = "openai_realtime"): AsrProvider {
  if (type === "dashscope") {
    return {
      type,
      id: id(),
      name: "DashScope ASR",
      apiKey: "",
      websocketUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
      model: "qwen3-asr-flash-realtime",
      language: "",
      sampleRate: 16000,
      vadThreshold: 0.2,
      silenceDurationMs: 800,
    };
  }
  if (type === "volcengine") {
    return {
      type,
      id: id(),
      name: "Volcengine ASR",
      apiKey: "",
      websocketUrl: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
      resourceId: "volc.seedasr.sauc.duration",
      language: "",
    };
  }
  return {
    type: "openai_realtime",
    id: id(),
    name: "OpenAI Realtime ASR",
    apiKey: "",
    websocketUrl: "wss://api.openai.com/v1/realtime?intent=transcription",
    model: "gpt-4o-transcribe",
    language: "",
    prompt: "",
    sampleRate: 24000,
    vadThreshold: 0.5,
    prefixPaddingMs: 300,
    silenceDurationMs: 500,
  };
}

function defaultTtsProvider(type: TtsProvider["type"] = "system"): TtsProvider {
  if (type === "openai") {
    return {
      type,
      id: id(),
      name: "OpenAI TTS",
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-tts",
      voice: "alloy",
    };
  }
  if (type === "gemini") {
    return {
      type,
      id: id(),
      name: "Gemini TTS",
      apiKey: "",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-2.5-flash-preview-tts",
      voiceName: "Kore",
    };
  }
  if (type === "minimax") {
    return {
      type,
      id: id(),
      name: "MiniMax TTS",
      apiKey: "",
      baseUrl: "https://api.minimaxi.com/v1",
      model: "speech-2.6-turbo",
      voiceId: "female-shaonv",
      emotion: "calm",
      speed: 1,
    };
  }
  if (type === "qwen") {
    return {
      type,
      id: id(),
      name: "Qwen TTS",
      apiKey: "",
      baseUrl: "https://dashscope.aliyuncs.com/api/v1",
      model: "qwen3-tts-flash",
      voice: "Cherry",
      languageType: "Auto",
    };
  }
  if (type === "groq") {
    return {
      type,
      id: id(),
      name: "Groq TTS",
      apiKey: "",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "canopylabs/orpheus-v1-english",
      voice: "austin",
    };
  }
  if (type === "xai") {
    return {
      type,
      id: id(),
      name: "xAI TTS",
      apiKey: "",
      baseUrl: "https://api.x.ai/v1",
      voiceId: "eve",
      language: "auto",
    };
  }
  if (type === "mimo") {
    return {
      type,
      id: id(),
      name: "MiMo TTS",
      apiKey: "",
      baseUrl: "https://api.xiaomimimo.com/v1",
      model: "mimo-v2-tts",
      voice: "mimo_default",
    };
  }
  return {
    type: "system",
    id: DEFAULT_SYSTEM_TTS_ID,
    name: "System TTS",
    apiKey: "",
    baseUrl: "",
    speechRate: 1,
    pitch: 1,
  };
}

function defaultTtsProviders(): TtsProvider[] {
  return [
    defaultTtsProvider("system"),
    {
      ...defaultTtsProvider("openai"),
      id: "e36b22ef-ca82-40ab-9e70-60cad861911c",
      name: "AiHubMix",
      baseUrl: "https://aihubmix.com/v1",
    },
  ];
}

function normalizeAsrProviders(value: unknown): AsrProvider[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((item) => {
      const type = ["dashscope", "volcengine", "openai_realtime"].includes(String(item.type))
        ? String(item.type) as AsrProvider["type"]
        : "openai_realtime";
      const base = defaultAsrProvider(type);
      return {
        ...base,
        ...item,
        type,
        id: String(item.id ?? base.id),
        name: String(item.name ?? base.name),
        apiKey: String(item.apiKey ?? ""),
        websocketUrl: String(item.websocketUrl ?? base.websocketUrl),
      };
    });
}

function normalizeTtsProviders(value: unknown): TtsProvider[] {
  const defaults = defaultTtsProviders();
  const raw = Array.isArray(value) ? value.filter(isRecord) : [];
  const normalized = raw.map((item) => {
    const type = ["system", "openai", "gemini", "minimax", "qwen", "groq", "xai", "mimo"].includes(String(item.type))
      ? String(item.type) as TtsProvider["type"]
      : "system";
    const base = defaultTtsProvider(type);
    return {
      ...base,
      ...item,
      type,
      id: String(item.id ?? base.id),
      name: String(item.name ?? base.name),
      apiKey: String(item.apiKey ?? ""),
      baseUrl: String(item.baseUrl ?? base.baseUrl),
    };
  });
  return mergeById(normalized, defaults);
}

function loadState(): State {
  mkdirSync(filesDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  if (!existsSync(statePath)) {
    const fresh = defaultState();
    writeFileSync(statePath, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  return normalizeState(JSON.parse(readFileSync(statePath, "utf8")) as Partial<State>);
}

function mergeById<T extends { id: string }>(current: T[], defaults: T[]): T[] {
  const byId = new Set(current.map((item) => item.id));
  return [...current, ...defaults.filter((item) => !byId.has(item.id))];
}

// Streaming path throttles disk writes: token deltas can arrive 30-50/s for fast providers, and
// serializing+writing the full state on every chunk turns smooth streams into stutter. We coalesce
// writes inside `touchStream` to ~5/s while still broadcasting every chunk to SSE clients in real
// time. A final saveState() at end-of-generation makes the persisted state authoritative.
let pendingThrottledSave: ReturnType<typeof setTimeout> | null = null;
let lastSaveStateMs = 0;
const STREAM_SAVE_INTERVAL_MS = 200;
function scheduleThrottledSaveState() {
  const now = Date.now();
  const elapsed = now - lastSaveStateMs;
  if (elapsed >= STREAM_SAVE_INTERVAL_MS) {
    if (pendingThrottledSave) {
      clearTimeout(pendingThrottledSave);
      pendingThrottledSave = null;
    }
    saveState();
    return;
  }
  if (pendingThrottledSave) return;
  pendingThrottledSave = setTimeout(() => {
    pendingThrottledSave = null;
    saveState();
  }, STREAM_SAVE_INTERVAL_MS - elapsed);
}

// Streaming clients receive a node_update per chunk. Since each update carries the full growing
// MessageNode (cumulative text), naive per-chunk broadcasts turn into O(N^2) bytes over SSE and
// browsers fall behind — the user sees "stuck then dump" instead of smooth streaming, and the stop
// button feels laggy because old events keep flushing. We coalesce broadcasts to ~30 fps while
// always flushing the final state at end-of-generation.
const STREAM_BROADCAST_INTERVAL_MS = 33;
const pendingBroadcasts = new Map<string, { conversation: Conversation; node: MessageNode; timer: ReturnType<typeof setTimeout> | null; lastFlush: number }>();
function flushNodeBroadcast(key: string) {
  const entry = pendingBroadcasts.get(key);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  entry.lastFlush = Date.now();
  broadcastNodeUpdateNow(entry.conversation, entry.node);
}
function scheduleNodeBroadcast(conversation: Conversation, node: MessageNode) {
  const key = `${conversation.id}::${node.id}`;
  const now = Date.now();
  const existing = pendingBroadcasts.get(key);
  if (!existing) {
    pendingBroadcasts.set(key, { conversation, node, timer: null, lastFlush: now });
    broadcastNodeUpdateNow(conversation, node);
    return;
  }
  // Always keep the freshest references — the node object identity can stay but the parts mutate.
  existing.conversation = conversation;
  existing.node = node;
  const elapsed = now - existing.lastFlush;
  if (elapsed >= STREAM_BROADCAST_INTERVAL_MS) {
    flushNodeBroadcast(key);
    return;
  }
  if (existing.timer) return;
  existing.timer = setTimeout(() => flushNodeBroadcast(key), STREAM_BROADCAST_INTERVAL_MS - elapsed);
}
function clearNodeBroadcast(conversation: Conversation, node: MessageNode) {
  const key = `${conversation.id}::${node.id}`;
  const entry = pendingBroadcasts.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  pendingBroadcasts.delete(key);
}

// === Effective proxy resolution ============================================================
// Two-tier model so non-technical users get zero-config behavior, while power users keep full
// control via 设置 → 代理:
//
//   1. If the user filled in `settings.proxyConfig.url` → use it verbatim (with optional
//      basic-auth credentials composed into the URL).
//   2. Otherwise, read Windows registry (HKCU\…\Internet Settings\ProxyServer) the same way
//      browsers and Clash/V2Ray "规则代理 / 系统代理" mode set it. This is the path that
//      "just works" for users who have a proxy tool running.
//
// The result is mirrored into `HTTPS_PROXY`/`HTTP_PROXY` env vars because Bun's `fetch()`
// reads those dynamically — so every LLM / search / MCP request picks up the proxy. We
// refresh every 10 s so toggling Clash on/off propagates without restarting the app.

const SYSTEM_PROXY_REFRESH_MS = 10_000;
const USER_SET_HTTPS_PROXY = process.env.HTTPS_PROXY?.trim();
const USER_SET_HTTP_PROXY = process.env.HTTP_PROXY?.trim();
const USER_SET_NO_PROXY = process.env.NO_PROXY?.trim();
let lastAppliedEffectiveProxy: string | undefined;
let lastDetectedSystemProxy: string | undefined;

function parseProxyServerValue(value: string): string | undefined {
  if (!value) return undefined;
  // `ProxyServer` can be either a single endpoint ("127.0.0.1:7890") or per-protocol
  // ("http=127.0.0.1:7890;https=127.0.0.1:7891;ftp=..."). Prefer the https= variant for
  // outbound API calls; fall back to http= or the bare endpoint.
  if (value.includes("=")) {
    const map = new Map<string, string>();
    for (const piece of value.split(";")) {
      const [k, v] = piece.split("=");
      if (k && v) map.set(k.trim().toLowerCase(), v.trim());
    }
    const target = map.get("https") ?? map.get("http") ?? map.get("socks");
    if (!target) return undefined;
    return /^https?:\/\//i.test(target) ? target : `http://${target}`;
  }
  return /^https?:\/\//i.test(value) ? value : `http://${value}`;
}

function readWindowsSystemProxy(): string | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const enableProc = Bun.spawnSync(["reg", "query", key, "/v", "ProxyEnable"]);
    if (enableProc.exitCode !== 0) return undefined;
    const enableOut = new TextDecoder().decode(enableProc.stdout ?? new Uint8Array());
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enableOut)) return undefined;
    const serverProc = Bun.spawnSync(["reg", "query", key, "/v", "ProxyServer"]);
    if (serverProc.exitCode !== 0) return undefined;
    const serverOut = new TextDecoder().decode(serverProc.stdout ?? new Uint8Array());
    const match = serverOut.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
    if (!match) return undefined;
    return parseProxyServerValue(match[1].trim());
  } catch {
    return undefined;
  }
}

function composeProxyUrl(base: string, username: string, password: string): string {
  const trimmed = base.trim();
  if (!trimmed) return "";
  if (!username && !password) return trimmed;
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    // The WHATWG URL setter encodes the value itself — don't pre-encode or we end up
    // double-escaping characters like "@" in `user@example.com` into "user%2540example.com".
    if (username) url.username = username;
    if (password) url.password = password;
    return url.toString();
  } catch {
    return trimmed;
  }
}

function resolveEffectiveProxy(): { url: string | undefined; source: "manual" | "system" | "none" } {
  const cfg = state?.settings?.proxyConfig;
  const manual = cfg?.url?.trim();
  if (manual) {
    return { url: composeProxyUrl(manual, cfg!.username ?? "", cfg!.password ?? ""), source: "manual" };
  }
  const system = readWindowsSystemProxy();
  lastDetectedSystemProxy = system;
  if (system) return { url: system, source: "system" };
  return { url: undefined, source: "none" };
}

function applyEffectiveProxy() {
  const { url, source } = resolveEffectiveProxy();
  if (url === lastAppliedEffectiveProxy) return;
  lastAppliedEffectiveProxy = url;
  if (!USER_SET_HTTPS_PROXY) {
    if (url) process.env.HTTPS_PROXY = url;
    else delete process.env.HTTPS_PROXY;
  }
  if (!USER_SET_HTTP_PROXY) {
    if (url) process.env.HTTP_PROXY = url;
    else delete process.env.HTTP_PROXY;
  }
  if (!USER_SET_NO_PROXY) {
    // localhost/loopback must always bypass — the sidecar's own webview and smoke tests
    // talk to 127.0.0.1 and would otherwise loop through the proxy.
    process.env.NO_PROXY = "localhost,127.0.0.1,::1";
  }
  console.log(url ? `[proxy] ${source}: ${redactProxyForLog(url)}` : "[proxy] direct (no proxy)");
}

function redactProxyForLog(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return url;
  }
}

function proxyStatusPayload() {
  const { url, source } = resolveEffectiveProxy();
  // Strip credentials from the URL we send back to the UI — the UI shows the username/password
  // fields separately, no need to echo them in the "active proxy" footer.
  let displayUrl: string | undefined;
  if (url) {
    try {
      const parsed = new URL(url);
      parsed.username = "";
      parsed.password = "";
      displayUrl = parsed.toString().replace(/\/$/, "");
    } catch {
      displayUrl = url;
    }
  }
  return {
    activeUrl: displayUrl ?? null,
    source, // "manual" | "system" | "none"
    detectedSystemProxy: lastDetectedSystemProxy ?? null,
  };
}

let state = loadState();
state.launchCount += 1;
saveState();

applyEffectiveProxy();
setInterval(applyEffectiveProxy, SYSTEM_PROXY_REFRESH_MS).unref();



function saveState() {
  if (pendingThrottledSave) {
    clearTimeout(pendingThrottledSave);
    pendingThrottledSave = null;
  }
  lastSaveStateMs = Date.now();
  mkdirSync(dataDir, { recursive: true });
  const content = JSON.stringify(state, null, 2);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.${attempt}.tmp`;
    try {
      writeFileSync(tempPath, content);
      renameSync(tempPath, statePath);
      return;
    } catch (errorValue) {
      lastError = errorValue;
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // Ignore cleanup failures.
      }
      const start = Date.now();
      while (Date.now() - start < 50 * (attempt + 1)) {
        // Tiny synchronous backoff keeps state writes ordered on Windows.
      }
    }
  }
  try {
    writeFileSync(statePath, content);
  } catch {
    try {
      writeFileSync(`${statePath}.recovery-${Date.now()}.json`, content);
    } catch {
      // Keep generation alive even when Windows temporarily locks the data file.
    }
    console.warn("Failed to save state", lastError);
  }
}

function addLog(input: Omit<RequestLog, "id" | "at">) {
  const requestPreview = input.requestPreview ?? input.requestBody;
  const responsePreview = input.responsePreview ?? input.responseBody;
  state.logs.unshift({
    id: id(),
    at: Date.now(),
    ...input,
    ...(requestPreview ? { requestPreview, requestBody: input.requestBody ?? requestPreview } : {}),
    ...(responsePreview ? { responsePreview, responseBody: input.responseBody ?? responsePreview } : {}),
  });
  state.logs = state.logs.slice(0, 500);
  saveState();
}

const settingsClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const listClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const conversationClients = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();
const encoder = new TextEncoder();

function sseFrame(event: string, data: JsonValue | object) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function openSse(
  initial: () => Array<[string, JsonValue | object]>,
  register: (controller: ReadableStreamDefaultController<Uint8Array>) => () => void,
) {
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      cleanup = register(controller);
      for (const [event, payload] of initial()) {
        controller.enqueue(sseFrame(event, payload));
      }
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);
      cleanup = ((old) => () => {
        clearInterval(heartbeat);
        old();
      })(cleanup);
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function broadcastSettings() {
  for (const client of settingsClients) client.enqueue(sseFrame("update", state.settings));
}

function broadcastList() {
  const payload = { type: "invalidate", assistantId: state.settings.assistantId, timestamp: Date.now() };
  for (const client of listClients) client.enqueue(sseFrame("invalidate", payload));
}

function broadcastConversation(conversation: Conversation, event = "snapshot") {
  const payload = {
    type: "snapshot",
    seq: Date.now(),
    conversation: toConversationDto(conversation),
    serverTime: Date.now(),
  };
  for (const client of conversationClients.get(conversation.id) ?? []) {
    client.enqueue(sseFrame(event, payload));
  }
  broadcastList();
}

function broadcastNodeUpdateNow(conversation: Conversation, node: MessageNode) {
  const payload = {
    type: "node_update",
    seq: Date.now(),
    serverTime: Date.now(),
    conversationId: conversation.id,
    nodeId: node.id,
    nodeIndex: conversation.messages.findIndex((item) => item.id === node.id),
    node,
    updateAt: conversation.updateAt,
    isGenerating: generating.has(conversation.id),
  };
  for (const client of conversationClients.get(conversation.id) ?? []) {
    client.enqueue(sseFrame("node_update", payload));
  }
  broadcastList();
}

// Non-streaming call sites (final flush, tool approval, etc.) flush immediately so callers see
// the authoritative state without delay. Streaming hot paths go through scheduleNodeBroadcast.
function broadcastNodeUpdate(conversation: Conversation, node: MessageNode) {
  clearNodeBroadcast(conversation, node);
  broadcastNodeUpdateNow(conversation, node);
}

function abortConversationGeneration(conversationId: string) {
  generating.get(conversationId)?.abort();
  generating.delete(conversationId);
}

function deleteConversationsById(ids: Set<string>) {
  for (const conversationId of ids) {
    abortConversationGeneration(conversationId);
    conversationClients.delete(conversationId);
  }
  state.conversations = state.conversations.filter((item) => !ids.has(item.id));
  saveState();
  broadcastList();
}

function json(data: JsonValue | object, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

function error(message: string, status = 400) {
  return json({ error: message, code: status }, { status });
}

async function readJson<T>(request: Request): Promise<T> {
  if (request.headers.get("content-length") === "0") return {} as T;
  return (await request.json().catch(() => ({}))) as T;
}

function findAssistant(idValue = state.settings.assistantId) {
  return state.settings.assistants.find((assistant) => assistant.id === idValue) ?? state.settings.assistants[0];
}

function findModel(modelId: string | null | undefined) {
  const wanted = modelId || state.settings.chatModelId;
  for (const provider of state.settings.providers) {
    const modelItem = provider.models.find((item) => item.id === wanted || item.modelId === wanted);
    if (modelItem) return { provider, model: modelItem };
  }
  return { provider: state.settings.providers.find((item) => item.enabled) ?? state.settings.providers[0], model: model("auto", "Auto") };
}

function toConversationDto(conversation: Conversation) {
  return { ...conversation, isGenerating: generating.has(conversation.id) };
}

function toListDto(conversation: Conversation) {
  return {
    id: conversation.id,
    assistantId: conversation.assistantId,
    title: conversation.title,
    isPinned: conversation.isPinned,
    createAt: conversation.createAt,
    updateAt: conversation.updateAt,
    isGenerating: generating.has(conversation.id),
  };
}

function getConversation(idValue: string) {
  return state.conversations.find((conversation) => conversation.id === idValue);
}

function ensureConversation(idValue: string) {
  let conversation = getConversation(idValue);
  if (!conversation) {
    const now = Date.now();
    const assistant = findAssistant(state.settings.assistantId);
    conversation = {
      id: idValue,
      assistantId: assistant.id,
      systemPrompt: null,
      title: "",
      messages: presetMessageNodes(assistant),
      truncateIndex: -1,
      chatSuggestions: [],
      isPinned: false,
      createAt: now,
      updateAt: now,
    };
    state.conversations.unshift(conversation);
  }
  return conversation;
}

function roleFromPreset(value: unknown): Message["role"] {
  const role = String(value ?? "USER").toUpperCase();
  if (role === "ASSISTANT" || role === "SYSTEM" || role === "TOOL") return role;
  return "USER";
}

function partsFromPreset(value: unknown): JsonValue[] {
  if (Array.isArray(value)) return value as JsonValue[];
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (isRecord(value) && Array.isArray(value.parts)) return value.parts;
  if (isRecord(value) && typeof value.content === "string") return [{ type: "text", text: value.content }];
  return [];
}

function presetMessageNodes(assistant: Assistant): MessageNode[] {
  return (Array.isArray(assistant.presetMessages) ? assistant.presetMessages : [])
    .map((preset) => {
      if (!isRecord(preset)) return null;
      const msg = message(roleFromPreset(preset.role), partsFromPreset(preset), String(preset.modelId ?? "") || null);
      if (typeof preset.id === "string") msg.id = preset.id;
      if (typeof preset.createdAt === "string") msg.createdAt = preset.createdAt;
      if (typeof preset.finishedAt === "string" || preset.finishedAt === null) msg.finishedAt = preset.finishedAt as string | null;
      return { id: id(), messages: [msg], selectIndex: 0 };
    })
    .filter(Boolean) as MessageNode[];
}

function message(role: Message["role"], parts: JsonValue[], modelId: string | null = null): Message {
  const now = new Date().toISOString();
  return {
    id: id(),
    role,
    parts,
    annotations: [],
    createdAt: now,
    finishedAt: role === "ASSISTANT" ? now : null,
    modelId,
    usage: null,
    translation: null,
  };
}

function finishMessage(msg: Message, parts: JsonValue[], usage: JsonValue | null = msg.usage) {
  msg.parts = parts;
  msg.finishedAt = new Date().toISOString();
  msg.usage = usage;
}

function appendTextPart(msg: Message, text: string) {
  const last = msg.parts[msg.parts.length - 1];
  if (last && typeof last === "object" && !Array.isArray(last) && last.type === "text") {
    last.text = String(last.text ?? "") + text;
  } else {
    msg.parts.push({ type: "text", text });
  }
}

function applyThinkTagTransform(msg: Message) {
  if (msg.role !== "ASSISTANT") return;
  const now = new Date().toISOString();
  const transformed: JsonValue[] = [];
  const thinkRegex = /<think>([\s\S]*?)(?:<\/think>|$)/gi;
  for (const part of msg.parts) {
    if (!isRecord(part) || part.type !== "text") {
      transformed.push(part);
      continue;
    }
    const text = String(part.text ?? "");
    if (!/<think>/i.test(text)) {
      transformed.push(part);
      continue;
    }
    let reasoning = "";
    const stripped = text.replace(thinkRegex, (_match, capture) => {
      reasoning += `${reasoning ? "\n" : ""}${String(capture ?? "").trim()}`;
      return "";
    }).replace(/<\/think>/gi, "");
    if (reasoning.trim()) {
      transformed.push({
        type: "reasoning",
        reasoning: reasoning.trim(),
        createdAt: msg.createdAt,
        finishedAt: now,
      });
    }
    if (stripped.trim()) transformed.push({ ...part, text: stripped });
  }
  msg.parts = transformed;
}

function regexScopes(value: unknown) {
  return new Set(getStringArray(value).map((item) => item.toUpperCase()));
}

function activeRegexesForScope(assistant: Assistant, scope: "USER" | "ASSISTANT") {
  return Array.isArray(assistant.regexes)
    ? assistant.regexes.filter((regex) =>
        isRecord(regex) &&
        regex.enabled !== false &&
        regex.visualOnly !== true &&
        regexScopes(regex.affectingScope).has(scope) &&
        String(regex.findRegex ?? "").trim(),
      )
    : [];
}

function applyRegexesToText(text: string, regexes: JsonValue[]) {
  let value = text;
  for (const regex of regexes) {
    if (!isRecord(regex)) continue;
    try {
      value = value.replace(new RegExp(String(regex.findRegex ?? ""), "g"), String(regex.replaceString ?? ""));
    } catch {
      // Match Android's fault tolerance: invalid regex leaves content unchanged.
    }
  }
  return value;
}

function applyInputRegexTransformParts(parts: JsonValue[], assistant: Assistant) {
  const activeRegexes = activeRegexesForScope(assistant, "USER");
  if (activeRegexes.length === 0) return parts;
  return parts.map((part) =>
    isRecord(part) && part.type === "text"
      ? { ...part, text: applyRegexesToText(String(part.text ?? ""), activeRegexes) }
      : part,
  );
}

function applyRegexOutputTransform(msg: Message, assistant: Assistant) {
  if (msg.role !== "ASSISTANT" || !Array.isArray(assistant.regexes) || assistant.regexes.length === 0) return;
  const activeRegexes = activeRegexesForScope(assistant, "ASSISTANT");
  if (activeRegexes.length === 0) return;
  msg.parts = msg.parts.map((part) => {
    if (!isRecord(part) || (part.type !== "text" && part.type !== "reasoning")) return part;
    const key = part.type === "reasoning" ? "reasoning" : "text";
    return { ...part, [key]: applyRegexesToText(String(part[key] ?? ""), activeRegexes) };
  });
}

function applyOutputTransforms(msg: Message, assistant: Assistant) {
  applyThinkTagTransform(msg);
  applyRegexOutputTransform(msg, assistant);
}

function hasTextPart(msg: Message, marker: string) {
  return msg.parts.some((part) =>
    part && typeof part === "object" && !Array.isArray(part) && part.type === "text" && String(part.text ?? "").includes(marker)
  );
}

function imageParts(parts: JsonValue[]) {
  return parts.filter((part): part is Record<string, JsonValue> =>
    !!part && typeof part === "object" && !Array.isArray(part) && part.type === "image" && typeof part.url === "string"
  );
}

function setMessageLoading(msg: Message, label = "正在生成回复") {
  if (msg.parts.length > 0) return;
  msg.parts = [{ type: "loading", label }];
}

function finishReasoningParts(msg: Message) {
  const now = new Date().toISOString();
  msg.parts = msg.parts.map((part) => {
    if (part && typeof part === "object" && !Array.isArray(part) && part.type === "reasoning" && !part.finishedAt) {
      return { ...part, finishedAt: now };
    }
    return part;
  });
}

function hasOpenReasoningPart(msg: Message) {
  return msg.parts.some((part) =>
    part && typeof part === "object" && !Array.isArray(part) && part.type === "reasoning" && !part.finishedAt
  );
}

function replaceLoadingReasoningWithTool(msg: Message, toolPart: JsonValue) {
  msg.parts = msg.parts.filter((part) => !(
    part &&
    typeof part === "object" &&
    !Array.isArray(part) &&
    (part.type === "loading" || (part.type === "reasoning" && part.reasoning === "正在生成回复"))
  ));
  msg.parts.push(toolPart);
}

function textFromParts(parts: JsonValue[]) {
  return parts
    .map((part) => {
      if (part && typeof part === "object" && !Array.isArray(part) && part.type === "text") return String(part.text ?? "");
      return "";
    })
    .join("\n")
    .trim();
}

function formatLocalDate(date = new Date()) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(date);
}

function formatLocalTime(date = new Date()) {
  return new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(date);
}

function renderTemplate(template: string, variables: Record<string, string>) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => variables[key] ?? match);
}

function applyPlaceholders(template: string, variables: Record<string, string>) {
  return template
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => variables[key] ?? match)
    .replace(/\{\s*([a-zA-Z0-9_]+)\s*\}/g, (match, key) => variables[key] ?? match);
}

function localeDisplayName() {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(locale.split("-")[0]) ?? locale;
  } catch {
    return locale;
  }
}

function summaryAsText(msg: Message) {
  return `[${msg.role}]: ${textFromParts(msg.parts)}`;
}

function selectedConversationMessages(conversation: Conversation) {
  return conversation.messages
    .map((node) => node.messages[node.selectIndex] ?? node.messages[0])
    .filter(Boolean);
}

function estimateTokens(text: string) {
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const other = Math.max(0, text.length - cjk);
  return Math.max(1, Math.ceil(cjk * 0.9 + other / 4));
}

function estimatePromptTokensForConversation(conversation: Conversation) {
  return selectedConversationMessages(conversation)
    .filter((msg) => msg.role !== "ASSISTANT")
    .reduce((sum, msg) => sum + estimateTokens(textFromParts(msg.parts)), 0);
}

function ensureUsage(msg: Message, conversation?: Conversation) {
  const existing = msg.usage;
  if (existing && typeof existing === "object" && !Array.isArray(existing)) return;
  const completionTokens = estimateTokens(textFromParts(msg.parts) || reasoningFromParts(msg.parts));
  const promptTokens = conversation ? estimatePromptTokensForConversation(conversation) : 0;
  msg.usage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cachedTokens: 0,
    estimated: true,
  };
}

function toolApprovalType(part: JsonValue) {
  return isRecord(part) && isRecord(part.approvalState) ? String(part.approvalState.type ?? "auto") : "auto";
}

function hasToolParts(msg: Message) {
  return msg.parts.some((part) => isRecord(part) && part.type === "tool");
}

function hasPendingToolApproval(msg: Message) {
  return msg.parts.some((part) => isRecord(part) && part.type === "tool" && toolApprovalType(part) === "pending");
}

function canResumeToolExecution(part: JsonValue) {
  const type = toolApprovalType(part);
  return type === "approved" || type === "denied" || type === "answered";
}

function hasResumableToolParts(msg: Message) {
  return msg.parts.some((part) =>
    isRecord(part) &&
    part.type === "tool" &&
    (!Array.isArray(part.output) || part.output.length === 0) &&
    canResumeToolExecution(part)
  );
}

function templateVariables(messageText: string, role: string, assistant: Assistant, modelItem: Model) {
  const now = new Date();
  const display = state.settings.displaySetting;
  const user = String(display.userNickname ?? "").trim() || "User";
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  return {
    message: messageText,
    role,
    time: formatLocalTime(now),
    date: formatLocalDate(now),
    cur_time: formatLocalTime(now),
    cur_date: formatLocalDate(now),
    cur_datetime: new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "medium" }).format(now),
    timezone,
    locale,
    user,
    nickname: user,
    char: assistant.name?.trim() || "Assistant",
    model_id: modelItem.modelId,
    model_name: modelItem.displayName?.trim() || modelItem.modelId,
    system_version: `Windows PC (${process.platform})`,
    device_info: "RikkaHub PC",
    battery_level: "unknown",
  };
}

function renderAssistantMessageTemplate(template: string, messageText: string, role: string) {
  const variables = {
    message: messageText,
    role: role.toLowerCase(),
    time: formatLocalTime(new Date()),
    date: formatLocalDate(new Date()),
  };
  return renderTemplate(template || "{{ message }}", variables);
}

function transformedTextPart(part: JsonValue, text: string): JsonValue {
  return isRecord(part) ? { ...part, text } : part;
}

function applyMessageTemplateToParts(parts: JsonValue[], role: string, template: string) {
  return parts.map((part) => {
    if (!isRecord(part) || part.type !== "text") return part;
    return transformedTextPart(part, renderAssistantMessageTemplate(template, String(part.text ?? ""), role));
  });
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function dateKey(timestamp: number | string) {
  return formatKeyLocal(new Date(timestamp));
}

function formatKeyLocal(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function computeStats() {
  const daily = new Map<string, DailyStat>();
  let userMessages = 0;
  let assistantMessages = 0;
  let characters = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const models = new Map<string, { id: string; name: string; providerName: string; count: number }>();
  const requestGroups = new Map<string, { ok: number; failed: number }>();
  const providers = new Map<string, { ok: number; failed: number }>();
  const modelLookup = new Map<string, { name: string; providerName: string }>();
  for (const provider of state.settings.providers) {
    for (const modelItem of provider.models ?? []) {
      modelLookup.set(modelItem.id, {
        name: modelItem.displayName || modelItem.modelId,
        providerName: provider.name,
      });
    }
  }

  for (const conversation of state.conversations) {
    const conversationDate = dateKey(conversation.createAt);
    const row = daily.get(conversationDate) ?? { date: conversationDate, messages: 0, conversations: 0, characters: 0 };
    row.conversations += 1;
    daily.set(conversationDate, row);

    for (const node of conversation.messages) {
      for (const msg of node.messages) {
        const msgDate = dateKey(msg.createdAt);
        const item = daily.get(msgDate) ?? { date: msgDate, messages: 0, conversations: 0, characters: 0 };
        const text = textFromParts(msg.parts);
        item.messages += 1;
        item.characters += text.length;
        daily.set(msgDate, item);
        characters += text.length;
        if (msg.role === "USER") userMessages += 1;
        if (msg.role === "ASSISTANT") assistantMessages += 1;
        if (msg.usage && typeof msg.usage === "object" && !Array.isArray(msg.usage)) {
          inputTokens += Number(msg.usage.promptTokens ?? msg.usage.inputTokens ?? 0);
          outputTokens += Number(msg.usage.completionTokens ?? msg.usage.outputTokens ?? 0);
        }
        if (msg.modelId) {
          const info = modelLookup.get(msg.modelId) ?? { name: msg.modelId, providerName: "" };
          const row = models.get(msg.modelId) ?? { id: msg.modelId, name: info.name, providerName: info.providerName, count: 0 };
          row.count += 1;
          models.set(msg.modelId, row);
        }
      }
    }
  }

  for (const log of state.logs) {
    const item = providers.get(log.providerName) ?? { ok: 0, failed: 0 };
    if (log.ok) item.ok += 1;
    else item.failed += 1;
    providers.set(log.providerName, item);
    const kind = String(log.kind ?? "");
    const toolName = String(log.toolName ?? "");
    const groupName = kind.startsWith("mcp:")
      ? "MCP 请求"
      : kind.startsWith("search:") || kind.startsWith("tool:search") || kind.startsWith("tool:scrape") || toolName === "search_web" || toolName === "scrape_web"
        ? "搜索引擎请求"
        : "模型请求";
    const group = requestGroups.get(groupName) ?? { ok: 0, failed: 0 };
    if (log.ok) group.ok += 1;
    else group.failed += 1;
    requestGroups.set(groupName, group);
  }

  return {
    totals: {
      conversations: state.conversations.length,
      messages: userMessages + assistantMessages,
      userMessages,
      assistantMessages,
      characters,
      inputTokens,
      outputTokens,
      launchCount: state.launchCount,
      requests: state.logs.length,
      failedRequests: state.logs.filter((log) => !log.ok).length,
    },
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    models: [...models.values()].sort((a, b) => b.count - a.count),
    requestGroups: [...requestGroups.entries()].map(([name, value]) => ({ name, ...value })).sort((a, b) => (b.ok + b.failed) - (a.ok + a.failed)),
    providers: [...providers.entries()].map(([name, value]) => ({ name, ...value })).sort((a, b) => (b.ok + b.failed) - (a.ok + a.failed)),
  };
}

function getStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeWebDavConfig(value: unknown): WebDavConfig {
  const raw = isRecord(value) ? value : {};
  const items = getStringArray(raw.items).filter((item) => item === "DATABASE" || item === "FILES");
  return {
    url: String(raw.url ?? ""),
    username: String(raw.username ?? ""),
    password: String(raw.password ?? ""),
    path: String(raw.path ?? "rikkahub_backups") || "rikkahub_backups",
    items: items.length ? items : ["DATABASE", "FILES"],
  };
}

function normalizeS3Config(value: unknown): S3Config {
  const raw = isRecord(value) ? value : {};
  const items = getStringArray(raw.items).filter((item) => item === "DATABASE" || item === "FILES");
  return {
    endpoint: String(raw.endpoint ?? ""),
    region: String(raw.region ?? "us-east-1") || "us-east-1",
    accessKeyId: String(raw.accessKeyId ?? ""),
    secretAccessKey: String(raw.secretAccessKey ?? ""),
    bucket: String(raw.bucket ?? ""),
    prefix: String(raw.prefix ?? "rikkahub_backups") || "rikkahub_backups",
    forcePathStyle: raw.forcePathStyle === true,
    items: items.length ? items : ["DATABASE", "FILES"],
  };
}

function normalizeProxyConfig(value: unknown): ProxyConfig {
  const raw = isRecord(value) ? value : {};
  return {
    url: String(raw.url ?? "").trim(),
    username: String(raw.username ?? ""),
    password: String(raw.password ?? ""),
  };
}

function hasJsonItemId(items: unknown, idValue: string) {
  return Array.isArray(items) && items.some((item) => isRecord(item) && String(item.id ?? "") === idValue);
}

function validateKnownJsonIds(items: unknown, ids: unknown, fieldName: string) {
  const requested = getStringArray(ids);
  const unknownId = requested.find((itemId) => !hasJsonItemId(items, itemId));
  if (unknownId) throw new Error(`${fieldName} contains unknown id: ${unknownId}`);
  return requested;
}

function jsonPreview(value: unknown, limit = LOG_PREVIEW_LIMIT) {
  const text = JSON.stringify(value, null, 2);
  return text.length > limit ? `${text.slice(0, limit)}\n\n... [truncated ${text.length - limit} chars]` : text;
}

function textPreview(value: string, limit = LOG_PREVIEW_LIMIT) {
  return value.length > limit ? `${value.slice(0, limit)}\n\n... [truncated ${value.length - limit} chars]` : value;
}

function getByPath(value: unknown, path: string): unknown {
  const expression = path.trim();
  if (!expression) return value;
  const tokens = expression.match(/[^.[\]]+|\[(\d+)\]/g) ?? [];
  let current: any = value;
  for (const token of tokens) {
    if (current == null) return undefined;
    const indexMatch = /^\[(\d+)\]$/.exec(token);
    current = indexMatch ? current[Number(indexMatch[1])] : current[token];
  }
  return current;
}

function formatBalanceValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value.toFixed(2);
  const text = String(value ?? "").trim();
  const num = Number(text);
  return text && Number.isFinite(num) ? num.toFixed(2) : text;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function upsertById(items: JsonValue[], item: Record<string, JsonValue>) {
  const itemId = String(item.id ?? id());
  const nextItem = { ...item, id: itemId };
  const exists = items.some((entry) => isRecord(entry) && String(entry.id) === itemId);
  return {
    item: nextItem,
    items: exists ? items.map((entry) => (isRecord(entry) && String(entry.id) === itemId ? nextItem : entry)) : [...items, nextItem],
  };
}

function deleteById(items: JsonValue[], idValue: string) {
  return items.filter((entry) => !(isRecord(entry) && String(entry.id) === idValue));
}

function reorderByIds<T extends JsonValue>(items: T[], ids: string[]) {
  const byId = new Map(items.filter(isRecord).map((item) => [String(item.id), item as T]));
  const ordered = ids.map((itemId) => byId.get(itemId)).filter(Boolean) as T[];
  const rest = items.filter((item) => !isRecord(item) || !ids.includes(String(item.id)));
  return [...ordered, ...rest];
}

function safeSkillDir(skillName: string) {
  const name = skillName.trim();
  if (!name || name === "." || name === ".." || /[\\/]/.test(name)) return null;
  const root = resolve(skillsDir);
  const target = resolve(root, name);
  if (dirname(target) !== root) return null;
  return target;
}

function safeSkillFile(skillName: string, relativePath: string) {
  if (!relativePath.trim()) return null;
  const dir = safeSkillDir(skillName);
  if (!dir) return null;
  const root = resolve(dir);
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(root + "\\") && !target.startsWith(root + "/")) return null;
  return target;
}

function parseSkillFrontmatter(content: string) {
  const result: Record<string, string> = {};
  if (!content.startsWith("---")) return result;
  const match = content.slice(3).match(/\r?\n---(?:\r?\n|$)/);
  if (!match || match.index === undefined) return result;
  const yaml = content.slice(3, 3 + match.index).trim();
  for (const line of yaml.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^"|"$/g, "");
    if (key && value) result[key] = value;
  }
  return result;
}

function extractSkillBody(content: string) {
  if (!content.startsWith("---")) return content;
  const match = content.slice(3).match(/\r?\n---(?:\r?\n|$)/);
  if (!match || match.index === undefined) return content;
  return content.slice(3 + match.index + match[0].length).replace(/^[\r\n]+/, "");
}

function skillMetadataFromFile(skillName: string): SkillMetadata | null {
  const file = safeSkillFile(skillName, "SKILL.md");
  if (!file || !existsSync(file)) return null;
  const content = readFileSync(file, "utf8");
  const frontmatter = parseSkillFrontmatter(content);
  const name = frontmatter.name?.trim();
  const description = frontmatter.description?.trim();
  if (!name || !description) return null;
  return {
    name,
    description,
    compatibility: frontmatter.compatibility,
    allowedTools: frontmatter["allowed-tools"]?.split(/\s+/).filter(Boolean) ?? [],
  };
}

function listSkills(): SkillMetadata[] {
  mkdirSync(skillsDir, { recursive: true });
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => skillMetadataFromFile(entry.name))
    .filter(Boolean) as SkillMetadata[];
}

function readSkillBody(skillName: string) {
  const file = safeSkillFile(skillName, "SKILL.md");
  if (!file || !existsSync(file)) return null;
  return extractSkillBody(readFileSync(file, "utf8"));
}

function readSkillContent(skillName: string) {
  const file = safeSkillFile(skillName, "SKILL.md");
  if (!file || !existsSync(file)) return null;
  return readFileSync(file, "utf8");
}

function listSkillFiles(skillName: string) {
  const dir = safeSkillDir(skillName);
  if (!dir || !existsSync(dir)) return [];
  const root = resolve(dir);
  const result: Array<{ path: string; size: number; type: "file" | "directory" }> = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      const relativePath = resolve(full).slice(root.length + 1).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        result.push({ path: relativePath, size: 0, type: "directory" });
        visit(full);
      } else {
        result.push({ path: relativePath, size: statSync(full).size, type: "file" });
      }
    }
  };
  visit(root);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function exportSkills() {
  return listSkills().map((skill) => ({ ...skill, content: readSkillContent(skill.name) ?? "" }));
}

function importSkills(skills: unknown) {
  if (!Array.isArray(skills)) return;
  for (const item of skills) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = String(record.name ?? "").trim();
    const dir = safeSkillDir(name);
    if (!dir) continue;
    mkdirSync(dir, { recursive: true });
    const files = Array.isArray(record.files) ? record.files : [];
    if (files.length > 0) {
      for (const file of files) {
        if (!isRecord(file)) continue;
        const relativePath = String(file.path ?? "").replace(/\\/g, "/");
        if (!relativePath || relativePath.includes("..") || relativePath.startsWith("/")) continue;
        const target = resolve(dir, relativePath);
        if (!target.startsWith(resolve(dir))) continue;
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, String(file.content ?? ""));
      }
      continue;
    }
    const content = String(record.content ?? "");
    if (content) writeFileSync(join(dir, "SKILL.md"), content);
  }
}

function defaultSkillContent(name = "new-skill") {
  return `---\nname: ${name}\ndescription: Describe when this skill should be used\n---\n\nWrite the skill instructions here.\n`;
}

function backupPayload() {
  return {
    version: 1,
    app: "RikkaHub PC",
    exportedAt: new Date().toISOString(),
    state,
    skills: exportSkills(),
    files: state.files.map((file) => ({
      ...file,
      data: existsSync(file.path) ? readFileSync(file.path).toString("base64") : null,
    })),
  };
}

function applyBackupPayload(body: { state?: Partial<State>; skills?: unknown; files?: unknown } & Partial<State>) {
  const incoming = body.state ?? body;
  if (!incoming || typeof incoming !== "object" || !incoming.settings) {
    throw new Error("Invalid backup file");
  }
  state = normalizeState(incoming);
  importSkills(body.skills);
  if (Array.isArray(body.files)) {
    mkdirSync(filesDir, { recursive: true });
    for (const file of body.files) {
      if (!isRecord(file) || typeof file.data !== "string") continue;
      const fileId = Number(file.id);
      if (!Number.isFinite(fileId)) continue;
      const ext = extname(String(file.originalName ?? file.name ?? "")) || extname(String(file.path ?? "")) || "";
      const target = join(filesDir, `${fileId}${ext}`);
      writeFileSync(target, Buffer.from(file.data, "base64"));
      state.files = state.files.map((entry) => (entry.id === fileId ? { ...entry, path: target } : entry));
    }
  }
  saveState();
  broadcastSettings();
  broadcastList();
}

function webDavAuthHeader(config: WebDavConfig) {
  return config.username || config.password
    ? { Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}` }
    : {};
}

function webDavUrl(config: WebDavConfig, fileName = "") {
  const base = config.url.trim().replace(/\/+$/, "");
  if (!base) throw new Error("WebDAV URL 为空");
  const parts = [config.path, fileName]
    .map((part) => String(part ?? "").trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .map((part) => part.split("/").map(encodeURIComponent).join("/"));
  return parts.length ? `${base}/${parts.join("/")}` : base;
}

async function webDavRequest(config: WebDavConfig, method: string, fileName = "", init: RequestInit = {}) {
  const headers = {
    ...webDavAuthHeader(config),
    ...(init.headers as Record<string, string> | undefined ?? {}),
  };
  return fetch(webDavUrl(config, fileName), { ...init, method, headers });
}

async function webDavEnsureCollection(config: WebDavConfig) {
  const check = await webDavRequest(config, "PROPFIND", "", {
    headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
    body: "<D:propfind xmlns:D=\"DAV:\"><D:prop><D:resourcetype/></D:prop></D:propfind>",
  });
  if (check.ok || check.status === 207) return;
  const create = await webDavRequest(config, "MKCOL");
  if (!create.ok && create.status !== 405) {
    throw new Error(`WebDAV 创建目录失败：${create.status} ${(await create.text()).slice(0, 500)}`);
  }
}

function parseWebDavItems(xml: string) {
  const blocks = xml.match(/<[^>]*response[\s\S]*?<\/[^>]*response>/gi) ?? [];
  return blocks.map((block) => {
    const value = (name: string) => {
      const match = block.match(new RegExp(`<[^>]*(?:${name})[^>]*>([\\s\\S]*?)<\\/[^>]*(?:${name})>`, "i"));
      return match ? stripXmlText(match[1]) : "";
    };
    const href = value("href");
    const displayName = value("displayname") || decodeURIComponent(href.replace(/\/$/, "").split("/").pop() ?? "");
    return {
      href,
      displayName,
      size: Number(value("getcontentlength")) || 0,
      lastModified: value("getlastmodified"),
      isCollection: /<[^>]*collection\b/i.test(block),
    };
  });
}

async function webDavListBackups(config: WebDavConfig) {
  await webDavEnsureCollection(config);
  const response = await webDavRequest(config, "PROPFIND", "", {
    headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
    body: "<D:propfind xmlns:D=\"DAV:\"><D:prop><D:displayname/><D:getcontentlength/><D:getlastmodified/><D:resourcetype/></D:prop></D:propfind>",
  });
  const text = await response.text();
  if (!response.ok && response.status !== 207) throw new Error(`WebDAV 列表失败：${response.status} ${text.slice(0, 500)}`);
  return parseWebDavItems(text)
    .filter((item) => !item.isCollection && /^backup_.*\.json$/i.test(item.displayName))
    .sort((a, b) => Date.parse(b.lastModified || "") - Date.parse(a.lastModified || ""));
}

async function webDavBackup(config: WebDavConfig) {
  await webDavEnsureCollection(config);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
  const fileName = `backup_${stamp}.json`;
  const payload = JSON.stringify(backupPayload(), null, 2);
  const response = await webDavRequest(config, "PUT", fileName, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(payload)),
    },
    body: payload,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`WebDAV 备份失败：${response.status} ${text.slice(0, 500)}`);
  return { fileName, size: Buffer.byteLength(payload) };
}

async function webDavRestore(config: WebDavConfig, fileName: string) {
  const response = await webDavRequest(config, "GET", fileName);
  const text = await response.text();
  if (!response.ok) throw new Error(`WebDAV 下载失败：${response.status} ${text.slice(0, 500)}`);
  applyBackupPayload(JSON.parse(text));
}

async function webDavDelete(config: WebDavConfig, fileName: string) {
  const response = await webDavRequest(config, "DELETE", fileName);
  const text = await response.text();
  if (!response.ok) throw new Error(`WebDAV 删除失败：${response.status} ${text.slice(0, 500)}`);
}

// AWS Signature Version 4 — see https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html.
// Supports standard AWS S3 plus any S3-compatible endpoint (MinIO, R2, OSS, COS) by letting the
// caller override `endpoint` and `forcePathStyle`. The signer always emits `s3` as the service
// and `aws4_request` as the terminator, which is correct for both AWS and all major S3 clones.
function sha256Hex(payload: string | Buffer) {
  return createHash("sha256").update(payload).digest("hex");
}
function hmacSha256(key: string | Buffer, data: string) {
  return createHmac("sha256", key).update(data).digest();
}
function awsUriEncode(value: string, encodeSlash: boolean) {
  let result = "";
  for (const ch of value) {
    if (/[A-Za-z0-9_.~\-]/.test(ch)) {
      result += ch;
    } else if (ch === "/") {
      result += encodeSlash ? "%2F" : "/";
    } else {
      const buf = Buffer.from(ch, "utf-8");
      for (const byte of buf) result += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return result;
}

function s3EndpointHost(config: S3Config) {
  const explicit = config.endpoint.trim().replace(/\/+$/, "");
  if (explicit) {
    const parsed = new URL(/^https?:\/\//i.test(explicit) ? explicit : `https://${explicit}`);
    return { protocol: parsed.protocol, host: parsed.host, base: `${parsed.protocol}//${parsed.host}` };
  }
  // Default AWS S3 path-style endpoint per region.
  const host = `s3.${config.region}.amazonaws.com`;
  return { protocol: "https:", host, base: `https://${host}` };
}

function s3RequestUrl(config: S3Config, key: string, query: Record<string, string>) {
  const { base, host } = s3EndpointHost(config);
  const pathStyle = config.forcePathStyle || Boolean(config.endpoint.trim());
  const path = key ? `/${awsUriEncode(key, false)}` : "/";
  const url = pathStyle ? `${base}/${config.bucket}${path}` : `${base.replace("//", `//${config.bucket}.`)}${path}`;
  const finalHost = pathStyle ? host : `${config.bucket}.${host}`;
  const sortedQuery = Object.entries(query).sort(([a], [b]) => a.localeCompare(b));
  const canonicalQuery = sortedQuery.map(([k, v]) => `${awsUriEncode(k, true)}=${awsUriEncode(v, true)}`).join("&");
  const canonicalUri = pathStyle ? `/${awsUriEncode(config.bucket, false)}${path}` : path;
  return {
    requestUrl: canonicalQuery ? `${url}?${canonicalQuery}` : url,
    canonicalUri,
    canonicalQuery,
    host: finalHost,
  };
}

function s3Sign(config: S3Config, method: string, key: string, query: Record<string, string>, payload: Buffer) {
  if (!config.accessKeyId || !config.secretAccessKey) throw new Error("S3 凭据未配置");
  if (!config.bucket) throw new Error("S3 bucket 未配置");
  const { requestUrl, canonicalUri, canonicalQuery, host } = s3RequestUrl(config, key, query);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(payload);
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys.map((name) => `${name}:${headers[name].trim()}\n`).join("");
  const signedHeaders = sortedHeaderKeys.join(";");
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const kDate = hmacSha256(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, config.region);
  const kService = hmacSha256(kRegion, "s3");
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {
    requestUrl,
    headers: { ...headers, Authorization: authorization },
  };
}

async function s3Request(
  config: S3Config,
  method: string,
  key: string,
  options: { query?: Record<string, string>; body?: Buffer; contentType?: string } = {},
) {
  const payload = options.body ?? Buffer.alloc(0);
  const { requestUrl, headers } = s3Sign(config, method, key, options.query ?? {}, payload);
  const finalHeaders: Record<string, string> = { ...headers };
  if (options.contentType) finalHeaders["Content-Type"] = options.contentType;
  return await fetch(requestUrl, { method, headers: finalHeaders, body: payload.length ? payload : undefined });
}

function s3Prefix(config: S3Config) {
  return config.prefix ? `${config.prefix.replace(/\/+$/, "")}/` : "";
}

async function s3TestConnection(config: S3Config) {
  // HEAD on the bucket validates credentials + endpoint without listing.
  const response = await s3Request(config, "GET", "", { query: { "list-type": "2", "max-keys": "1" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`S3 测试失败：${response.status} ${text.slice(0, 500)}`);
}

async function s3ListBackups(config: S3Config) {
  const prefix = `${s3Prefix(config)}backup_`;
  const response = await s3Request(config, "GET", "", { query: { "list-type": "2", prefix } });
  const text = await response.text();
  if (!response.ok) throw new Error(`S3 列表失败：${response.status} ${text.slice(0, 500)}`);
  const items: Array<{ href: string; displayName: string; size: number; lastModified: string }> = [];
  // Minimal XML scan — S3 ListObjectsV2 has one <Contents> element per object.
  const blocks = text.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? [];
  for (const block of blocks) {
    const keyMatch = block.match(/<Key>([\s\S]*?)<\/Key>/);
    const sizeMatch = block.match(/<Size>(\d+)<\/Size>/);
    const lastMatch = block.match(/<LastModified>([\s\S]*?)<\/LastModified>/);
    if (!keyMatch) continue;
    const fileKey = keyMatch[1];
    const displayName = fileKey.split("/").pop() ?? fileKey;
    if (!/^backup_.*\.json$/i.test(displayName)) continue;
    items.push({
      href: fileKey,
      displayName,
      size: Number(sizeMatch?.[1] ?? 0),
      lastModified: lastMatch?.[1] ?? "",
    });
  }
  items.sort((a, b) => Date.parse(b.lastModified || "") - Date.parse(a.lastModified || ""));
  return items;
}

async function s3Backup(config: S3Config) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
  const fileName = `backup_${stamp}.json`;
  const key = `${s3Prefix(config)}${fileName}`;
  const payload = Buffer.from(JSON.stringify(backupPayload(), null, 2), "utf-8");
  const response = await s3Request(config, "PUT", key, { body: payload, contentType: "application/json; charset=utf-8" });
  const text = await response.text();
  if (!response.ok) throw new Error(`S3 备份失败：${response.status} ${text.slice(0, 500)}`);
  return { fileName, size: payload.length };
}

async function s3Restore(config: S3Config, fileName: string) {
  const key = `${s3Prefix(config)}${fileName}`;
  const response = await s3Request(config, "GET", key);
  const text = await response.text();
  if (!response.ok) throw new Error(`S3 下载失败：${response.status} ${text.slice(0, 500)}`);
  applyBackupPayload(JSON.parse(text));
}

async function s3Delete(config: S3Config, fileName: string) {
  const key = `${s3Prefix(config)}${fileName}`;
  const response = await s3Request(config, "DELETE", key);
  const text = await response.text();
  if (!response.ok && response.status !== 204) throw new Error(`S3 删除失败：${response.status} ${text.slice(0, 500)}`);
}

type GitHubSkillInfo = { owner: string; repo: string; branch: string; path: string };
type GitHubSkillFile = { relativePath: string; downloadUrl: string };

function parseGitHubSkillUrl(repoUrl: string): GitHubSkillInfo | null {
  const trimmed = repoUrl.trim().replace(/\/+$/, "");
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/tree\/([^/]+)(?:\/(.*))?)?$/.exec(trimmed);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/i, ""),
    branch: match[3] || "HEAD",
    path: match[4] || "",
  };
}

async function githubJson(url: string) {
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "RikkaHub-PC" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${text.slice(0, 500) || response.statusText}`);
  return JSON.parse(text);
}

async function collectGitHubSkillFiles(info: GitHubSkillInfo, dirPath: string, basePath: string, result: GitHubSkillFile[]) {
  const apiPath = dirPath ? encodeURI(dirPath).replace(/#/g, "%23") : "";
  const apiUrl = `https://api.github.com/repos/${info.owner}/${info.repo}/contents/${apiPath}?ref=${encodeURIComponent(info.branch)}`;
  const payload = await githubJson(apiUrl);
  const items = Array.isArray(payload) ? payload : [payload];
  for (const item of items) {
    const type = String(item.type ?? "");
    const itemPath = String(item.path ?? "");
    const relativePath = itemPath.replace(new RegExp(`^${basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?`), "");
    if (type === "file") {
      const downloadUrl = String(item.download_url ?? "");
      if (!downloadUrl) throw new Error(`GitHub 文件没有 download_url: ${itemPath}`);
      result.push({ relativePath: relativePath || itemPath.split("/").pop() || itemPath, downloadUrl });
    } else if (type === "dir") {
      await collectGitHubSkillFiles(info, itemPath, basePath, result);
    }
  }
}

async function importSkillFromGitHub(repoUrl: string) {
  const info = parseGitHubSkillUrl(repoUrl);
  if (!info) throw new Error("无效的 GitHub 仓库链接。支持 https://github.com/owner/repo 或 /tree/branch/sub/path");
  const files: GitHubSkillFile[] = [];
  await collectGitHubSkillFiles(info, info.path, info.path, files);
  const skillFile = files.find((file) => file.relativePath === "SKILL.md");
  if (!skillFile) throw new Error("目录中未找到 SKILL.md");
  const downloaded = new Map<string, string>();
  for (const file of files) {
    const response = await fetch(file.downloadUrl, { headers: { "User-Agent": "RikkaHub-PC" } });
    if (!response.ok) throw new Error(`下载文件失败 ${file.relativePath}: ${response.status}`);
    downloaded.set(file.relativePath, await response.text());
  }
  const skillContent = downloaded.get("SKILL.md") ?? "";
  const frontmatter = parseSkillFrontmatter(skillContent);
  const name = frontmatter.name?.trim();
  if (!name) throw new Error("SKILL.md 格式错误：缺少 name 字段");
  const targetDir = safeSkillDir(name);
  if (!targetDir) throw new Error("Skill name 无效");
  mkdirSync(skillsDir, { recursive: true });
  const stagingDir = join(skillsDir, `.${name}.staging.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  const backupDir = join(skillsDir, `.${name}.backup.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    mkdirSync(stagingDir, { recursive: true });
    for (const [relativePath, content] of downloaded) {
      const root = resolve(stagingDir);
      const target = resolve(root, relativePath);
      if (target !== root && !target.startsWith(root + "\\") && !target.startsWith(root + "/")) {
        throw new Error(`非法文件路径：${relativePath}`);
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    if (existsSync(targetDir)) renameSync(targetDir, backupDir);
    renameSync(stagingDir, targetDir);
    if (existsSync(backupDir)) rmSync(backupDir, { recursive: true, force: true });
  } catch (err) {
    if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
    if (!existsSync(targetDir) && existsSync(backupDir)) renameSync(backupDir, targetDir);
    throw err;
  }
  const metadata = skillMetadataFromFile(name);
  if (!metadata) throw new Error("Skill frontmatter must include name and description");
  return { ...metadata, content: skillContent };
}

function normalizeInjectionPosition(value: unknown) {
  return String(value ?? "").toLowerCase();
}

function roleForInjection(value: unknown) {
  return String(value ?? "USER").toLowerCase() === "assistant" ? "assistant" : "user";
}

function activeModeInjections(assistant: Assistant) {
  const selected = new Set(getStringArray(assistant.modeInjectionIds));
  return (state.settings.modeInjections as Array<Record<string, JsonValue>>)
    .filter((item) => item.enabled !== false && selected.has(String(item.id ?? "")))
    .sort((left, right) => Number(right.priority ?? 0) - Number(left.priority ?? 0));
}

function regexMatches(injection: Record<string, JsonValue>, context: string) {
  if (injection.enabled === false) return false;
  if (injection.constantActive === true) return true;
  const keywords = getStringArray(injection.keywords);
  if (keywords.length === 0) return false;
  const useRegex = injection.useRegex === true;
  const caseSensitive = injection.caseSensitive === true;
  return keywords.some((keyword) => {
    if (useRegex) {
      try {
        return new RegExp(keyword, caseSensitive ? "" : "i").test(context);
      } catch {
        return false;
      }
    }
    return caseSensitive ? context.includes(keyword) : context.toLowerCase().includes(keyword.toLowerCase());
  });
}

function contextForMatchingMessages(messages: Message[], scanDepth: number) {
  return messages
    .filter((message) => message.role !== "SYSTEM")
    .slice(-Math.max(1, scanDepth || 4))
    .map((message) => textFromParts(message.parts) || reasoningFromParts(message.parts))
    .filter(Boolean)
    .join("\n");
}

function activeLorebookInjections(assistant: Assistant, messages: Message[]) {
  const selected = new Set(getStringArray(assistant.lorebookIds));
  return (state.settings.lorebooks as Array<Record<string, JsonValue>>)
    .filter((book) => book.enabled !== false && selected.has(String(book.id ?? "")))
    .flatMap((book) => (Array.isArray(book.entries) ? book.entries : []))
    .filter(isRecord)
    .filter((entry) => regexMatches(entry, contextForMatchingMessages(messages, Number(entry.scanDepth ?? 4))))
    .sort((left, right) => Number(right.priority ?? 0) - Number(left.priority ?? 0));
}

function activePromptInjections(assistant: Assistant, messages: Message[]) {
  return [...activeModeInjections(assistant), ...activeLorebookInjections(assistant, messages)]
    .filter((item) => item.enabled !== false)
    .sort((left, right) => Number(right.priority ?? 0) - Number(left.priority ?? 0));
}

function applySystemPromptInjections(systemPrompt: string, injections: Array<Record<string, JsonValue>>) {
  let before = "";
  let after = "";
  for (const injection of injections) {
    const content = String(injection.content ?? "").trim();
    if (!content) continue;
    const position = normalizeInjectionPosition(injection.position);
    if (position === "before_system_prompt") before += `${content}\n`;
    if (position === "after_system_prompt") after += `\n${content}`;
  }
  return `${before}${systemPrompt}${after}`.trim();
}

function mergedInjectionMessages(injections: Array<Record<string, JsonValue>>): Message[] {
  const grouped = new Map<string, string[]>();
  for (const injection of injections) {
    const content = String(injection.content ?? "").trim();
    if (!content) continue;
    const role = roleForInjection(injection.role).toUpperCase();
    grouped.set(role, [...(grouped.get(role) ?? []), content]);
  }
  return [...grouped.entries()].map(([role, content]) =>
    message(role === "ASSISTANT" ? "ASSISTANT" : "USER", [{ type: "text", text: content.join("\n") }]),
  );
}

function hasAssistantToolsForSafeInsert(messageValue: Message | undefined) {
  return messageValue?.role === "ASSISTANT" && messageValue.parts.some((part) => isRecord(part) && part.type === "tool");
}

function findSafeInsertIndex(messages: Message[], targetIndex: number) {
  let index = Math.max(0, Math.min(targetIndex, messages.length));
  while (index > 0) {
    const prev = messages[index - 1];
    const current = messages[index];
    if (prev?.role === "USER" && hasAssistantToolsForSafeInsert(current)) index -= 1;
    else break;
  }
  return index;
}

function insertInjectionMessages(items: Message[], targetIndex: number, injections: Array<Record<string, JsonValue>>) {
  const messages = mergedInjectionMessages(injections);
  if (messages.length === 0) return;
  const insertIndex = findSafeInsertIndex(items, targetIndex);
  items.splice(insertIndex, 0, ...messages);
}

function applyPromptInjectionsToMessages(messages: Message[], injections: Array<Record<string, JsonValue>>) {
  const result = messages.map((item) => cloneJson(item));
  const systemIndex = result.findIndex((item) => item.role === "SYSTEM");
  const systemContent = systemIndex >= 0 ? applySystemPromptInjections(textFromParts(result[systemIndex].parts), injections) : "";
  if (systemIndex >= 0) {
    if (systemContent) result[systemIndex] = { ...result[systemIndex], parts: [{ type: "text", text: systemContent }] };
    else result.splice(systemIndex, 1);
  } else {
    const injectedSystem = applySystemPromptInjections("", injections);
    if (injectedSystem) result.unshift(message("SYSTEM", [{ type: "text", text: injectedSystem }]));
  }

  const firstUserIndex = result.findIndex((item) => item.role === "USER");
  insertInjectionMessages(
    result,
    firstUserIndex >= 0 ? firstUserIndex : result.length,
    injections.filter((injection) => normalizeInjectionPosition(injection.position) === "top_of_chat"),
  );
  insertInjectionMessages(
    result,
    Math.max(0, result.length - 1),
    injections.filter((injection) => normalizeInjectionPosition(injection.position) === "bottom_of_chat"),
  );
  for (const depth of [...new Set(injections
    .filter((injection) => normalizeInjectionPosition(injection.position) === "at_depth")
    .map((injection) => Math.max(1, Number(injection.injectDepth ?? 4))))].sort((left, right) => right - left)) {
    insertInjectionMessages(
      result,
      Math.max(0, result.length - depth),
      injections.filter((injection) =>
        normalizeInjectionPosition(injection.position) === "at_depth" &&
        Math.max(1, Number(injection.injectDepth ?? 4)) === depth,
      ),
    );
  }
  return result;
}

function timeReminderContent(current: Message, previous?: Message) {
  const currentTime = new Date(current.createdAt);
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(currentTime);
  const timeText = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(currentTime);
  if (!previous) return `<time_reminder>Current time: ${weekday}, ${timeText}</time_reminder>`;
  const gapSeconds = Math.floor((Date.parse(current.createdAt) - Date.parse(previous.createdAt)) / 1000);
  if (gapSeconds <= 3600) return "";
  const gapText = gapSeconds < 3600
    ? `${Math.floor(gapSeconds / 60)} min`
    : gapSeconds < 86400
      ? `${Math.floor(gapSeconds / 3600)} h`
      : `${Math.floor(gapSeconds / 86400)} d`;
  return `<time_reminder>Current time: ${weekday}, ${timeText} (${gapText} since last message)</time_reminder>`;
}

function memoriesForAssistant(assistant: Assistant) {
  const assistantId = assistant.useGlobalMemory ? GLOBAL_MEMORY_ID : assistant.id;
  return state.memories.filter((memory) => memory.assistantId === assistantId);
}

function buildMemoryPrompt(assistant: Assistant) {
  if (!assistant.enableMemory) return "";
  const memories = memoriesForAssistant(assistant).map((memory) => ({ id: memory.id, content: memory.content }));
  return `
**Memories**
These are memories stored via the memory_tool that you can reference in future conversations.
${JSON.stringify(memories, null, 2)}
`.trim();
}

function buildRecentChatsPrompt(assistant: Assistant, currentConversationId?: string) {
  if (!assistant.enableRecentChatsReference) return "";
  const recent = state.conversations
    .filter((conversation) => conversation.assistantId === assistant.id && conversation.id !== currentConversationId)
    .sort((left, right) => right.updateAt - left.updateAt)
    .slice(0, 10)
    .map((conversation) => ({
      title: conversation.title || textFromParts(conversation.messages[0]?.messages[0]?.parts ?? []).slice(0, 40) || "New Conversation",
      last_chat: dateKey(conversation.updateAt),
    }));
  if (recent.length === 0) return "";
  return `
**Recent Chats**
These are some of the user's recent conversations. You can use them to understand user preferences:
${JSON.stringify(recent, null, 2)}
`.trim();
}

function buildSkillsContext(assistant: Assistant) {
  const enabled = new Set(getStringArray(assistant.enabledSkills));
  const available = listSkills().filter((skill) => enabled.has(skill.name));
  if (available.length === 0) return "";
  const body = available
    .map((skill) => `  <skill>\n    <name>${skill.name}</name>\n    <description>${skill.description}</description>\n  </skill>`)
    .join("\n");
  return `**Skills**
You have access to the following skills. Use the \`use_skill\` tool to load a skill's instructions when the user's request matches.
<available_skills>
${body}
</available_skills>`;
}

function buildSearchContext() {
  if (!state.settings.enableWebSearch) return "";
  const service = state.settings.searchServices[state.settings.searchServiceSelected] as Record<string, JsonValue> | undefined;
  const serviceName = String(service?.name ?? service?.type ?? "Search");
  return `
Available tools: search_web, scrape_web
Use search_web when the user needs current, external, or verifiable information. The selected service is ${serviceName}. The tool returns source ids as plain numbers. After using search information, cite sources in the format [citation,domain](1), [citation,domain](2). If snippets are not enough, call scrape_web for a specific result URL.
`.trim();
}

function selectedSearchService() {
  return (state.settings.searchServices[state.settings.searchServiceSelected] ??
    state.settings.searchServices[0] ??
    { type: "bing_local", name: "Bing" }) as Record<string, JsonValue>;
}

function nameOfSearchService(service: Record<string, JsonValue>) {
  return String(service.name ?? service.type ?? "Search");
}

function searchResultSize(service: Record<string, JsonValue>) {
  const serviceSize = Number(service.resultSize ?? 0);
  const commonSize = Number(state.settings.searchCommonOptions?.resultSize ?? 10);
  return Math.max(1, Math.min(10, serviceSize || commonSize || 5));
}

function stripHtml(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function domainOfUrl(targetUrl: string) {
  try {
    return new URL(targetUrl).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function faviconForUrl(targetUrl: string) {
  const domain = domainOfUrl(targetUrl);
  return domain ? `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico` : "";
}

function searchResult(index: number, item: { title?: unknown; url?: unknown; text?: unknown }) {
  const url = String(item.url ?? "");
  return {
    id: `${index + 1}`,
    title: String(item.title ?? url),
    url,
    domain: domainOfUrl(url),
    icon: faviconForUrl(url),
    text: String(item.text ?? ""),
  };
}

async function parseJsonResponse(response: Response) {
  const text = await response.text();
  try {
    return { text, raw: text ? JSON.parse(text) : {} };
  } catch {
    return { text, raw: { text } };
  }
}

async function customJsHttpRequest(
  url: string,
  method = "GET",
  headersValue: unknown = {},
  bodyValue: unknown = null,
) {
  const headers = isRecord(headersValue) ? Object.fromEntries(Object.entries(headersValue).map(([key, value]) => [key, String(value)])) : {};
  const body = bodyValue == null || String(method).toUpperCase() === "GET" || String(method).toUpperCase() === "HEAD"
    ? undefined
    : (typeof bodyValue === "string" ? bodyValue : JSON.stringify(bodyValue));
  const response = await fetch(url, {
    method: String(method || "GET").toUpperCase(),
    headers,
    body,
  });
  const text = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    statusText: response.statusText,
    url: response.url,
    body: text,
  };
}

async function runCustomJsFunction(service: Record<string, JsonValue>, script: string, invocation: string, args: JsonValue[]) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const userFetch = async (targetUrl: string, options: Record<string, JsonValue> = {}) => {
    const response = await customJsHttpRequest(
      targetUrl,
      String(options.method ?? "GET"),
      options.headers,
      options.body,
    );
    return {
      status: response.status,
      ok: response.ok,
      statusText: response.statusText,
      url: response.url,
      text: async () => response.body,
      json: async () => JSON.parse(response.body),
    };
  };
  const fn = new AsyncFunction("fetch", "args", `"use strict";\n${script}\nconst result = ${invocation}.apply(null, args);\nreturn await result;`);
  return await fn(userFetch, args);
}

async function runCustomJsSearch(service: Record<string, JsonValue>, query: string, maxResults: number) {
  const script = String(service.searchScript ?? "").trim();
  if (!script) throw new Error("Custom JS search script is empty");
  const raw = await runCustomJsFunction(service, script, "search", [query, maxResults]);
  const items = Array.isArray(raw?.items) ? raw.items : [];
  return {
    query,
    service: nameOfSearchService(service),
    answer: raw?.answer,
    items: items.slice(0, maxResults).map((item: any, index: number) =>
      searchResult(index, { title: item.title, url: item.url, text: item.text ?? item.content ?? item.snippet }),
    ),
  };
}

async function runCustomJsScrape(service: Record<string, JsonValue>, target: string) {
  const script = String(service.scrapeScript ?? "").trim();
  if (!script) throw new Error("Custom JS scrape script is empty");
  const raw = await runCustomJsFunction(service, script, "scrape", [[target]]);
  const item = Array.isArray(raw?.urls) ? raw.urls[0] : raw;
  return {
    url: String(item?.url ?? target),
    title: item?.metadata?.title ?? item?.title,
    description: item?.metadata?.description ?? item?.description,
    language: item?.metadata?.language ?? item?.language,
    text: String(item?.content ?? item?.text ?? "").slice(0, 12000),
  };
}

async function runSearchWeb(params: Record<string, JsonValue>) {
  const started = Date.now();
  const service = selectedSearchService();
  const type = String(service.type ?? "bing_local").toLowerCase();
  const query = String(params.query ?? params.q ?? "").trim();
  if (!query) throw new Error("search_web requires query");
  const maxResults = Math.max(1, Math.min(10, Number(params.max_results ?? params.maxResults ?? searchResultSize(service))));

  if (type === "tavily") {
    const apiKey = String(service.apiKey ?? "");
    if (!apiKey) throw new Error("Tavily API Key is empty");
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, max_results: maxResults, search_depth: service.depth ?? "basic" }),
    });
    const raw = await response.json();
    addLog({
      providerId: String(service.id ?? "search"),
      providerName: nameOfSearchService(service),
      url: "https://api.tavily.com/search",
      ok: response.ok,
      status: response.status,
      kind: "tool:search_web",
      toolName: "search_web",
      durationMs: Date.now() - started,
      requestPreview: jsonPreview({ query, maxResults }),
      responsePreview: jsonPreview(raw),
      error: response.ok ? undefined : jsonPreview(raw),
    });
    if (!response.ok) throw new Error(JSON.stringify(raw).slice(0, 500));
    return {
      query,
      service: "Tavily",
      items: (raw.results ?? []).slice(0, maxResults).map((item: any, index: number) =>
        searchResult(index, { title: item.title, url: item.url, text: item.content ?? item.raw_content }),
      ),
    };
  }

  if (type === "rikkahub") {
    const apiKey = String(service.apiKey ?? "");
    const endpoint = "https://api.rikka-ai.com/v1/search";
    const requestBody = { q: query, depth: service.depth ?? "standard", outputType: "sourcedAnswer", includeImages: false };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(requestBody),
    });
    const { text, raw } = await parseJsonResponse(response);
    addLog({
      providerId: String(service.id ?? "search"),
      providerName: nameOfSearchService(service),
      url: endpoint,
      ok: response.ok,
      status: response.status,
      kind: "tool:search_web",
      toolName: "search_web",
      durationMs: Date.now() - started,
      requestPreview: jsonPreview(requestBody),
      responsePreview: textPreview(text),
      error: response.ok ? undefined : textPreview(text),
    });
    if (!response.ok) throw new Error(`RikkaHub search failed with code ${response.status}: ${text.slice(0, 500)}`);
    return {
      query,
      service: "RikkaHub",
      answer: raw.answer,
      items: (raw.sources ?? []).slice(0, maxResults).map((item: any, index: number) =>
        searchResult(index, { title: item.name, url: item.url, text: item.snippet }),
      ),
    };
  }

  if (type === "exa") {
    const apiKey = String(service.apiKey ?? "");
    if (!apiKey) throw new Error("Exa API Key is empty");
    const response = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ query, numResults: maxResults }),
    });
    const raw = await response.json();
    addLog({
      providerId: String(service.id ?? "search"),
      providerName: nameOfSearchService(service),
      url: "https://api.exa.ai/search",
      ok: response.ok,
      status: response.status,
      kind: "tool:search_web",
      toolName: "search_web",
      durationMs: Date.now() - started,
      requestPreview: jsonPreview({ query, maxResults }),
      responsePreview: jsonPreview(raw),
      error: response.ok ? undefined : jsonPreview(raw),
    });
    if (!response.ok) throw new Error(JSON.stringify(raw).slice(0, 500));
    return {
      query,
      service: "Exa",
      items: (raw.results ?? []).slice(0, maxResults).map((item: any, index: number) =>
        searchResult(index, { title: item.title, url: item.url, text: item.text ?? item.summary }),
      ),
    };
  }

  if (type === "zhipu") {
    const apiKey = String(service.apiKey ?? "");
    if (!apiKey) throw new Error("Zhipu API Key is empty");
    const endpoint = "https://open.bigmodel.cn/api/paas/v4/web_search";
    const requestBody = { search_query: query, search_engine: "search_std", count: maxResults };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(requestBody),
    });
    const { text, raw } = await parseJsonResponse(response);
    addLog({
      providerId: String(service.id ?? "search"),
      providerName: nameOfSearchService(service),
      url: endpoint,
      ok: response.ok,
      status: response.status,
      kind: "tool:search_web",
      toolName: "search_web",
      durationMs: Date.now() - started,
      requestPreview: jsonPreview(requestBody),
      responsePreview: textPreview(text),
      error: response.ok ? undefined : textPreview(text),
    });
    if (!response.ok) throw new Error(`Zhipu search failed with code ${response.status}: ${text.slice(0, 500)}`);
    return {
      query,
      service: "Zhipu",
      items: (raw.search_result ?? raw.searchResult ?? []).slice(0, maxResults).map((item: any, index: number) =>
        searchResult(index, { title: item.title, url: item.link, text: item.content }),
      ),
    };
  }

  if (type === "brave") {
    const apiKey = String(service.apiKey ?? "");
    if (!apiKey) throw new Error("Brave API Key is empty");
    const endpoint = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
    const response = await fetch(endpoint, { headers: { Accept: "application/json", "X-Subscription-Token": apiKey } });
    const { text, raw } = await parseJsonResponse(response);
    addLog({
      providerId: String(service.id ?? "search"),
      providerName: nameOfSearchService(service),
      url: endpoint,
      ok: response.ok,
      status: response.status,
      kind: "tool:search_web",
      toolName: "search_web",
      durationMs: Date.now() - started,
      requestPreview: jsonPreview({ query, maxResults }),
      responsePreview: textPreview(text),
      error: response.ok ? undefined : textPreview(text),
    });
    if (!response.ok) throw new Error(`Brave search failed with code ${response.status}: ${text.slice(0, 500)}`);
    return {
      query,
      service: "Brave",
      items: (raw.web?.results ?? []).slice(0, maxResults).map((item: any, index: number) =>
        searchResult(index, { title: item.title, url: item.url, text: item.description }),
      ),
    };
  }

  if (type === "searxng") {
    const baseUrl = String(service.url ?? "").trim().replace(/\/+$/, "");
    if (!baseUrl) throw new Error("SearXNG URL cannot be empty");
    const endpoint = new URL(`${baseUrl}/search`);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("format", "json");
    const engines = String(service.engines ?? "").trim();
    const language = String(service.language ?? "").trim();
    if (engines) endpoint.searchParams.set("engines", engines);
    if (language) endpoint.searchParams.set("language", language);
    const headers: Record<string, string> = {};
    const username = String(service.username ?? "");
    const password = String(service.password ?? "");
    if (username && password) headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    const response = await fetch(endpoint, { headers });
    const { text, raw } = await parseJsonResponse(response);
    addLog({
      providerId: String(service.id ?? "search"),
      providerName: nameOfSearchService(service),
      url: endpoint.toString(),
      ok: response.ok,
      status: response.status,
      kind: "tool:search_web",
      toolName: "search_web",
      durationMs: Date.now() - started,
      requestPreview: jsonPreview({ query, maxResults, engines, language }),
      responsePreview: textPreview(text),
      error: response.ok ? undefined : textPreview(text),
    });
    if (!response.ok) throw new Error(`SearXNG request failed with status ${response.status}: ${text.slice(0, 500)}`);
    return {
      query,
      service: "SearXNG",
      items: (raw.results ?? []).slice(0, maxResults).map((item: any, index: number) =>
        searchResult(index, { title: item.title, url: item.url, text: item.content }),
      ),
    };
  }

  if (type === "tinyfish") {
    const apiKey = String(service.apiKey ?? "");
    if (!apiKey) throw new Error("Tinyfish API Key is empty");
    const endpoint = `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}`;
    const response = await fetch(endpoint, {
      headers: { "X-API-Key": apiKey },
    });
    const { text, raw } = await parseJsonResponse(response);
    addLog({
      providerId: String(service.id ?? "search"),
      providerName: nameOfSearchService(service),
      url: endpoint,
      ok: response.ok,
      status: response.status,
      kind: "tool:search_web",
      toolName: "search_web",
      durationMs: Date.now() - started,
      requestPreview: jsonPreview({ query, maxResults }),
      responsePreview: textPreview(text),
      error: response.ok ? undefined : textPreview(text),
    });
    if (!response.ok) throw new Error(`Tinyfish search failed with code ${response.status}: ${text.slice(0, 500)}`);
    return {
      query,
      service: "Tinyfish",
      items: (raw.results ?? []).slice(0, maxResults).map((item: any, index: number) =>
        searchResult(index, { title: item.title, url: item.url, text: item.snippet }),
      ),
    };
  }

  if (type === "perplexity") {
    const apiKey = String(service.apiKey ?? "");
    if (!apiKey) throw new Error("Perplexity API Key is empty");
    const endpoint = "https://api.perplexity.ai/search";
    const body: Record<string, JsonValue> = { query, max_results: maxResults };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const { text, raw } = await parseJsonResponse(response);
    addLog({
      providerId: String(service.id ?? "search"), providerName: nameOfSearchService(service),
      url: endpoint, ok: response.ok, status: response.status, kind: "search:perplexity",
      durationMs: Date.now() - started, requestPreview: jsonPreview(body), responsePreview: textPreview(text),
      toolName: "search_web", error: response.ok ? undefined : textPreview(text),
    });
    if (!response.ok) throw new Error(`Perplexity search failed: ${response.status} ${text.slice(0, 300)}`);
    const results = Array.isArray(raw.results) ? raw.results : [];
    return {
      answer: typeof raw.answer === "string" ? raw.answer : "",
      items: results.filter((r: any) => r?.title && r?.url).slice(0, maxResults).map((r: any, index: number) =>
        searchResult(index, { title: String(r.title ?? ""), url: String(r.url ?? ""), text: String(r.snippet ?? r.text ?? "") }),
      ),
    };
  }

  if (type === "bocha") {
    const apiKey = String(service.apiKey ?? "");
    if (!apiKey) throw new Error("Bocha API Key is empty");
    const endpoint = "https://api.bochaai.com/v1/web-search";
    const summary = service.summary !== false;
    const body: Record<string, JsonValue> = { query, summary, count: maxResults };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const { text, raw } = await parseJsonResponse(response);
    addLog({
      providerId: String(service.id ?? "search"), providerName: nameOfSearchService(service),
      url: endpoint, ok: response.ok, status: response.status, kind: "search:bocha",
      durationMs: Date.now() - started, requestPreview: jsonPreview(body), responsePreview: textPreview(text),
      toolName: "search_web", error: response.ok ? undefined : textPreview(text),
    });
    if (!response.ok) throw new Error(`Bocha search failed: ${response.status} ${text.slice(0, 300)}`);
    const pages = raw?.data?.webPages?.value ?? [];
    return {
      answer: "",
      items: (Array.isArray(pages) ? pages : []).slice(0, maxResults).map((page: any, index: number) =>
        searchResult(index, { title: String(page.name ?? ""), url: String(page.url ?? ""), text: String(page.summary ?? page.snippet ?? "") }),
      ),
    };
  }

  if (type === "linkup") {
    const apiKey = String(service.apiKey ?? "");
    if (!apiKey) throw new Error("LinkUp API Key is empty");
    const endpoint = "https://api.linkup.so/v1/search";
    const depth = String(service.depth ?? "standard");
    const body: Record<string, JsonValue> = { q: query, depth, outputType: "sourcedAnswer", includeImages: "false" };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const { text, raw } = await parseJsonResponse(response);
    addLog({
      providerId: String(service.id ?? "search"), providerName: nameOfSearchService(service),
      url: endpoint, ok: response.ok, status: response.status, kind: "search:linkup",
      durationMs: Date.now() - started, requestPreview: jsonPreview(body), responsePreview: textPreview(text),
      toolName: "search_web", error: response.ok ? undefined : textPreview(text),
    });
    if (!response.ok) throw new Error(`LinkUp search failed: ${response.status} ${text.slice(0, 300)}`);
    const sources = Array.isArray(raw.sources) ? raw.sources : [];
    return {
      answer: typeof raw.answer === "string" ? raw.answer : "",
      items: sources.slice(0, maxResults).map((s: any, index: number) =>
        searchResult(index, { title: String(s.name ?? ""), url: String(s.url ?? ""), text: String(s.snippet ?? "") }),
      ),
    };
  }

  if (type === "metaso") {
    const apiKey = String(service.apiKey ?? "");
    if (!apiKey) throw new Error("Metaso API Key is empty");
    const endpoint = "https://metaso.cn/api/v1/search";
    const body: Record<string, JsonValue> = { q: query, scope: "webpage", size: maxResults, includeSummary: false };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const { text, raw } = await parseJsonResponse(response);
    addLog({
      providerId: String(service.id ?? "search"), providerName: nameOfSearchService(service),
      url: endpoint, ok: response.ok, status: response.status, kind: "search:metaso",
      durationMs: Date.now() - started, requestPreview: jsonPreview(body), responsePreview: textPreview(text),
      toolName: "search_web", error: response.ok ? undefined : textPreview(text),
    });
    if (!response.ok) throw new Error(`Metaso search failed: ${response.status} ${text.slice(0, 300)}`);
    const webpages = Array.isArray(raw.webpages) ? raw.webpages : [];
    return {
      answer: "",
      items: webpages.slice(0, maxResults).map((w: any, index: number) =>
        searchResult(index, { title: String(w.title ?? ""), url: String(w.link ?? ""), text: String(w.snippet ?? "") }),
      ),
    };
  }

  if (type === "ollama") {
    const apiKey = String(service.apiKey ?? "");
    if (!apiKey) throw new Error("Ollama API Key is empty");
    const endpoint = "https://ollama.com/api/web_search";
    const clamped = Math.max(5, Math.min(10, maxResults));
    const body: Record<string, JsonValue> = { query, max_results: clamped };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const { text, raw } = await parseJsonResponse(response);
    addLog({
      providerId: String(service.id ?? "search"), providerName: nameOfSearchService(service),
      url: endpoint, ok: response.ok, status: response.status, kind: "search:ollama",
      durationMs: Date.now() - started, requestPreview: jsonPreview(body), responsePreview: textPreview(text),
      toolName: "search_web", error: response.ok ? undefined : textPreview(text),
    });
    if (!response.ok) throw new Error(`Ollama search failed: ${response.status} ${text.slice(0, 300)}`);
    const results = Array.isArray(raw.results) ? raw.results : [];
    return {
      answer: "",
      items: results.slice(0, maxResults).map((r: any, index: number) =>
        searchResult(index, { title: String(r.title ?? ""), url: String(r.url ?? ""), text: String(r.content ?? "") }),
      ),
    };
  }

  if (type === "jina") {
    const apiKey = String(service.apiKey ?? "");
    if (!apiKey) throw new Error("Jina API Key is empty");
    const searchUrl = String(service.searchUrl ?? "").trim() || "https://s.jina.ai/";
    const body: Record<string, JsonValue> = { q: query };
    const response = await fetch(searchUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const { text, raw } = await parseJsonResponse(response);
    addLog({
      providerId: String(service.id ?? "search"), providerName: nameOfSearchService(service),
      url: searchUrl, ok: response.ok, status: response.status, kind: "search:jina",
      durationMs: Date.now() - started, requestPreview: jsonPreview(body), responsePreview: textPreview(text),
      toolName: "search_web", error: response.ok ? undefined : textPreview(text),
    });
    if (!response.ok) throw new Error(`Jina search failed: ${response.status} ${text.slice(0, 300)}`);
    const data = Array.isArray(raw.data) ? raw.data : [];
    return {
      answer: "",
      items: data.slice(0, maxResults).map((r: any, index: number) =>
        searchResult(index, { title: String(r.title ?? ""), url: String(r.url ?? ""), text: String(r.description ?? "") }),
      ),
    };
  }

  if (type === "firecrawl") {
    const apiKey = String(service.apiKey ?? "");
    if (!apiKey) throw new Error("Firecrawl API Key is empty");
    const endpoint = "https://api.firecrawl.dev/v2/search";
    const body: Record<string, JsonValue> = { query, limit: maxResults };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const { text, raw } = await parseJsonResponse(response);
    addLog({
      providerId: String(service.id ?? "search"), providerName: nameOfSearchService(service),
      url: endpoint, ok: response.ok, status: response.status, kind: "search:firecrawl",
      durationMs: Date.now() - started, requestPreview: jsonPreview(body), responsePreview: textPreview(text),
      toolName: "search_web", error: response.ok ? undefined : textPreview(text),
    });
    if (!response.ok) throw new Error(`Firecrawl search failed: ${response.status} ${text.slice(0, 300)}`);
    const data = isRecord(raw.data) ? (raw.data as Record<string, JsonValue>) : {};
    const web = Array.isArray(data.web) ? data.web : [];
    const news = Array.isArray(data.news) ? data.news : [];
    const items: ReturnType<typeof searchResult>[] = [];
    for (const item of web) {
      items.push(searchResult(items.length, {
        title: String((item as Record<string, JsonValue>).title ?? ""),
        url: String((item as Record<string, JsonValue>).url ?? ""),
        text: String((item as Record<string, JsonValue>).description ?? ""),
      }));
    }
    for (const item of news) {
      const record = item as Record<string, JsonValue>;
      items.push(searchResult(items.length, {
        title: String(record.title ?? ""),
        url: String(record.url ?? ""),
        text: `${String(record.snippet ?? "")}\n${String(record.date ?? "")}`.trim(),
      }));
    }
    return { answer: "", items: items.slice(0, maxResults) };
  }

  if (type === "grok") {
    const apiKey = String(service.apiKey ?? "");
    if (!apiKey) throw new Error("Grok API Key is empty");
    const endpoint = String(service.customUrl ?? "").trim() || "https://api.x.ai/v1/responses";
    const model = String(service.model ?? "").trim() || "grok-4-fast";
    const systemPrompt = String(service.systemPrompt ?? "").trim()
      || "You are a helpful assistant that searches the web for the user. Respond with a concise answer and cite sources via web_search/x_search tools.";
    const body: Record<string, JsonValue> = {
      model,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: query },
      ],
      tools: [{ type: "web_search" }, { type: "x_search" }],
      store: false,
    };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const { text, raw } = await parseJsonResponse(response);
    addLog({
      providerId: String(service.id ?? "search"), providerName: nameOfSearchService(service),
      url: endpoint, ok: response.ok, status: response.status, kind: "search:grok",
      durationMs: Date.now() - started, requestPreview: jsonPreview(body), responsePreview: textPreview(text),
      toolName: "search_web", error: response.ok ? undefined : textPreview(text),
    });
    if (!response.ok) throw new Error(`Grok search failed: ${response.status} ${text.slice(0, 300)}`);
    const output = Array.isArray(raw.output) ? raw.output : [];
    const messageOutput = output.find((entry: any) => entry?.type === "message" && entry?.role === "assistant");
    const contentArr = Array.isArray(messageOutput?.content) ? messageOutput.content : [];
    const textContent = contentArr.find((entry: any) => entry?.type === "output_text");
    const answer = textContent?.text ? String(textContent.text) : "";
    const annotations = Array.isArray(textContent?.annotations) ? textContent.annotations : [];
    const seen = new Set<string>();
    const items: ReturnType<typeof searchResult>[] = [];
    for (const annotation of annotations) {
      if (!annotation || annotation.type !== "url_citation") continue;
      const url = String(annotation.url ?? "");
      if (!url || seen.has(url)) continue;
      seen.add(url);
      items.push(searchResult(items.length, {
        title: String(annotation.title ?? url),
        url,
        text: "",
      }));
      if (items.length >= maxResults) break;
    }
    return { answer, items };
  }

  if (type === "custom_js") {
    const result = await runCustomJsSearch(service, query, maxResults);
    addLog({
      providerId: String(service.id ?? "search"),
      providerName: nameOfSearchService(service),
      url: "custom_js:search",
      ok: true,
      status: 0,
      kind: "tool:search_web",
      toolName: "search_web",
      durationMs: Date.now() - started,
      requestPreview: jsonPreview({ query, maxResults }),
      responsePreview: jsonPreview(result),
    });
    return result;
  }

  const response = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`, {
    headers: { "User-Agent": "Mozilla/5.0 RikkaHubPC/1.0" },
  });
  const html = await response.text();
  addLog({
    providerId: String(service.id ?? "search"),
    providerName: nameOfSearchService(service),
    url: response.url,
    ok: response.ok,
    status: response.status,
    kind: "tool:search_web",
    toolName: "search_web",
    durationMs: Date.now() - started,
    requestPreview: jsonPreview({ query, maxResults }),
    responsePreview: textPreview(stripHtml(html)),
    error: response.ok ? undefined : textPreview(html),
  });
  if (!response.ok) throw new Error(`Bing ${response.status}: ${html.slice(0, 300)}`);
  const items: Array<{ id: string; title: string; url: string; domain: string; icon: string; text: string }> = [];
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/gi) ?? [];
  for (const block of blocks.slice(0, maxResults)) {
    const link = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (!link) continue;
    items.push(searchResult(items.length, {
      title: stripHtml(link[2]),
      url: link[1].replace(/&amp;/g, "&"),
      text: snippet ? stripHtml(snippet[1]) : "",
    }));
  }
  return { query, service: "Bing", items };
}

async function runScrapeWeb(params: Record<string, JsonValue>) {
  const started = Date.now();
  const target = String(params.url ?? "").trim();
  if (!target || !/^https?:\/\//i.test(target)) throw new Error("scrape_web requires an http(s) url");
  const service = selectedSearchService();
  const type = String(service.type ?? "bing_local").toLowerCase();
  if (type === "custom_js" && String(service.scrapeScript ?? "").trim()) {
    const result = await runCustomJsScrape(service, target);
    addLog({
      providerId: String(service.id ?? "search"),
      providerName: nameOfSearchService(service),
      url: "custom_js:scrape",
      ok: true,
      status: 0,
      kind: "tool:scrape_web",
      toolName: "scrape_web",
      durationMs: Date.now() - started,
      requestPreview: jsonPreview({ url: target }),
      responsePreview: jsonPreview(result),
    });
    return result;
  }
  if (type === "tinyfish") {
    const apiKey = String(service.apiKey ?? "");
    if (!apiKey) throw new Error("Tinyfish API Key is empty");
    const endpoint = "https://api.fetch.tinyfish.ai";
    const requestBody = { urls: [target], format: "markdown" };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify(requestBody),
    });
    const { text, raw } = await parseJsonResponse(response);
    addLog({
      providerId: String(service.id ?? "search"),
      providerName: nameOfSearchService(service),
      url: endpoint,
      ok: response.ok,
      status: response.status,
      kind: "tool:scrape_web",
      toolName: "scrape_web",
      durationMs: Date.now() - started,
      requestPreview: jsonPreview(requestBody),
      responsePreview: textPreview(text),
      error: response.ok ? undefined : textPreview(text),
    });
    if (!response.ok) throw new Error(`Tinyfish fetch failed with code ${response.status}: ${text.slice(0, 500)}`);
    const item = Array.isArray(raw.results) ? raw.results[0] : null;
    const fetchError = Array.isArray(raw.errors) ? raw.errors[0]?.error : "";
    if (!item && fetchError) throw new Error(String(fetchError));
    return {
      url: String(item?.final_url ?? item?.url ?? target),
      title: item?.title,
      description: item?.description,
      language: item?.language,
      text: String(item?.text ?? "").slice(0, 12000),
    };
  }
  const response = await fetch(target, { headers: { "User-Agent": "Mozilla/5.0 RikkaHubPC/1.0" } });
  const text = await response.text();
  addLog({
    providerId: "scrape_web",
    providerName: "Scrape Web",
    url: target,
    ok: response.ok,
    status: response.status,
    kind: "tool:scrape_web",
    toolName: "scrape_web",
    durationMs: Date.now() - started,
    requestPreview: jsonPreview({ url: target }),
    responsePreview: textPreview(stripHtml(text)),
    error: response.ok ? undefined : textPreview(text),
  });
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 300)}`);
  return {
    url: target,
    text: stripHtml(text).slice(0, 12000),
  };
}

function openAiSearchTools() {
  return state.settings.enableWebSearch
    ? [
    {
      type: "function",
      function: {
        name: "search_web",
        description: `
Search the web for up-to-date or specific information.
Use this when the user asks for the latest news, current facts, or needs verification.
Generate focused keywords and run multiple searches if needed.
Today is ${formatKeyLocal(new Date())}.

Response format:
- items[].id (short id), title, url, text

Citations:
- After using results, add \`[citation,domain](id)\` after the sentence.
- Multiple citations are allowed.
- If no results are cited, omit citations.

Example:
The capital of France is Paris. [citation,example.com](abc123)
The population is about 2.1 million. [citation,example.com](abc123) [citation,example2.com](def456)
`.trim(),
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Focused search query" },
            max_results: { type: "integer", minimum: 1, maximum: 10 },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "scrape_web",
        description: `
Scrape a URL for detailed page content.
Use this when the user requests content from a specific page or when search snippets are insufficient.
Avoid using it for common questions unless the user asks.
`.trim(),
        parameters: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
        },
      },
    },
  ]
    : [];
}

function openAiSkillTools(assistant: Assistant) {
  const enabled = new Set(getStringArray(assistant.enabledSkills));
  const available = listSkills().filter((skill) => enabled.has(skill.name));
  if (available.length === 0) return [];
  return [
    {
      type: "function",
      function: {
        name: "use_skill",
        description: "Load and apply a skill to get specialized instructions or capabilities.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "The name of the skill to use" },
            path: {
              type: "string",
              description: "Optional relative path to a file inside the skill directory. Omit to read the default SKILL.md instructions. Only use paths extracted from Markdown links in the SKILL.md content. Do NOT guess or infer paths.",
            },
          },
          required: ["name"],
        },
      },
    },
  ];
}

function openAiLocalTools(assistant: Assistant) {
  const enabled = new Set((assistant.localTools ?? []).map((tool) => isRecord(tool) ? String(tool.type ?? "") : String(tool)));
  const tools = [];
  if (assistant.enableMemory) {
    tools.push({
      type: "function",
      function: {
        name: "memory_tool",
        description: `The memory tool stores long-term information across conversations.
Use \`action\` to control the operation: \`create\` (add), \`edit\` (update), \`delete\` (remove).
- No relevant record: \`create\` + \`content\`
- Existing relevant record: \`edit\` + \`id\` + \`content\`
- Outdated/irrelevant record: \`delete\` + \`id\`
Memories will automatically appear in the <memories> tag in later conversations.
Do not store sensitive information (e.g., ethnicity, religion, sexual orientation, political views, sex life, criminal records).
You may store: preferred name, preferences, plans, work-related notes, chat style preferences, first chat time, etc.
Do not show memory content directly in the conversation unless the user explicitly asks.
Today is ${formatKeyLocal(new Date())}.
Similar memories should be merged; prefer updating existing records.

Examples:
{"action":"create","content":"User prefers brief replies and is more active on weekends."}
{"action":"edit","id":12,"content":"User's preferred name updated to A-Xing, prefers Chinese replies."}
{"action":"delete","id":7}`,
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["create", "edit", "delete"],
              description: "Operation to perform: create, edit, or delete",
            },
            id: {
              type: "integer",
              description: "The id of the memory record (required for edit/delete)",
            },
            content: {
              type: "string",
              description: "The content of the memory record (required for create/edit)",
            },
          },
          required: ["action"],
        },
      },
    });
  }
  if (enabled.has("time_info")) {
    tools.push({
      type: "function",
      function: {
        name: "get_time_info",
        description: "Get the current local date and time info from the device. Returns year/month/day, weekday, ISO date/time strings, timezone, and timestamp.",
        parameters: { type: "object", properties: {} },
      },
    });
  }
  if (enabled.has("javascript_engine")) {
    tools.push({
      type: "function",
      function: {
        name: "eval_javascript",
        description: "Execute JavaScript code using QuickJS engine (ES2020). The result is the value of the last expression in the code. For calculations with decimals, use toFixed() to control precision. Console output (log/info/warn/error) is captured and returned in 'logs' field. No DOM or Node.js APIs available. Example: '1 + 2' returns 3; 'const x = 5; x * 2' returns 10.",
        parameters: {
          type: "object",
          properties: { code: { type: "string", description: "JavaScript code to evaluate" } },
          required: ["code"],
        },
      },
    });
  }
  if (enabled.has("clipboard")) {
    tools.push({
      type: "function",
      function: {
        name: "clipboard_tool",
        description: "Read or write plain text from the device clipboard. Use action: read or write. For write, provide text. Do NOT write to the clipboard unless the user has explicitly requested it.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["read", "write"], description: "Operation to perform: read or write" },
            text: { type: "string", description: "Text to write to the clipboard (required for write)" },
          },
          required: ["action"],
        },
      },
    });
  }
  if (enabled.has("tts")) {
    tools.push({
      type: "function",
      function: {
        name: "text_to_speech",
        description: "Speak text aloud to the user using the device's text-to-speech engine. Use this when the user asks you to read something aloud, or when audio output is appropriate. The tool returns immediately; audio plays in the background on the device. Provide natural, readable text without markdown formatting.",
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "The text to speak aloud" } },
          required: ["text"],
        },
      },
    });
  }
  if (enabled.has("ask_user")) {
    tools.push({
      type: "function",
      function: {
        name: "ask_user",
        description: "Ask the user one or more questions when you need clarification, additional information, or confirmation. Each question can optionally provide a list of suggested options for the user to choose from. The user may select an option or provide their own free-text answer for each question. The answers will be returned as a JSON object mapping question IDs to the user's responses.",
        parameters: {
          type: "object",
          properties: {
            questions: {
              type: "array",
              description: "List of questions to ask the user",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "Unique identifier for this question" },
                  question: { type: "string", description: "The question text to display to the user" },
                  options: { type: "array", description: "Optional suggested options", items: { type: "string" } },
                  selection_type: { type: "string", enum: ["text", "single", "multi"], description: "Answer type" },
                },
                required: ["id", "question"],
              },
            },
          },
          required: ["questions"],
        },
      },
    });
  }
  return tools;
}

function openAiMcpTools(assistant: Assistant) {
  const selected = new Set(getStringArray(assistant.mcpServers));
  return (state.settings.mcpServers as Array<Record<string, JsonValue>>)
    .filter((server) => selected.has(String(server.id ?? "")) && isRecord(server.commonOptions) && server.commonOptions.enable !== false)
    .flatMap((server) => {
      const serverName = String((server.commonOptions as Record<string, JsonValue>).name ?? server.id ?? "mcp");
      const tools = Array.isArray((server.commonOptions as Record<string, JsonValue>).tools)
        ? ((server.commonOptions as Record<string, JsonValue>).tools as JsonValue[])
        : [];
      return tools.filter(isRecord).filter((tool) => tool.enable !== false).map((tool) => ({
        type: "function",
        function: {
          name: `mcp__${String(tool.name ?? "").replace(/[^a-zA-Z0-9_-]/g, "_")}`,
          description: String(tool.description ?? `MCP tool from ${serverName}`),
          parameters: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
        },
      })).filter((tool) => tool.function.name !== "mcp__");
    });
}

function headersFromMcpServer(server: Record<string, JsonValue>) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const common = isRecord(server.commonOptions) ? server.commonOptions : {};
  const rawHeaders = Array.isArray(common.headers) ? common.headers : [];
  for (const header of rawHeaders) {
    if (Array.isArray(header)) {
      const [key, value] = header;
      if (key) headers[String(key)] = String(value ?? "");
    } else if (isRecord(header)) {
      const key = String(header.key ?? header.name ?? header.first ?? "").trim();
      const value = String(header.value ?? header.second ?? "");
      if (key) headers[key] = value;
    }
  }
  return headers;
}

function parseMcpResponseText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const dataLines = trimmed
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.replace(/^data:\s?/, "").trim())
      .filter((line) => line && line !== "[DONE]");
    for (const line of dataLines.reverse()) {
      try {
        return JSON.parse(line);
      } catch {
        // Continue scanning older SSE data frames.
      }
    }
    return { text };
  }
}

function resolveMcpSseEndpoint(baseUrl: string, endpoint: string) {
  const trimmed = endpoint.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return new URL(trimmed, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

const mcpSessionCache = new Map<string, { sessionId: string; protocolVersion?: string }>();
const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

function mcpSessionCacheKey(server: Record<string, JsonValue>) {
  const common = isRecord(server.commonOptions) ? server.commonOptions : {};
  const headers = Array.isArray(common.headers) ? common.headers : [];
  return JSON.stringify({
    id: String(server.id ?? ""),
    type: String(server.type ?? "streamable_http"),
    url: String(server.url ?? ""),
    headers,
  });
}

async function readMcpSseUntilEndpoint(response: Response, timeoutMs = 15000) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE MCP response has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  const started = Date.now();
  try {
    for (;;) {
      if (Date.now() - started > timeoutMs) throw new Error("SSE MCP endpoint event timeout");
      const read = await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) =>
          setTimeout(() => reject(new Error("SSE MCP endpoint event timeout")), 1000),
        ),
      ]);
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      const events = buffer.split(/\n\n+/);
      buffer = events.pop() ?? "";
      for (const eventBlock of events) {
        const eventName = eventBlock.split(/\r?\n/).find((line) => line.startsWith("event:"))?.replace(/^event:\s*/, "").trim() ?? "";
        const data = eventBlock
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.replace(/^data:\s?/, ""))
          .join("\n")
          .trim();
        if (eventName === "endpoint" && data) return data;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors from the long-lived SSE stream.
    }
  }
  throw new Error("SSE MCP endpoint event was not received");
}

async function mcpSsePostEndpoint(server: Record<string, JsonValue>) {
  const cached = String(server.ssePostEndpoint ?? "").trim();
  if (cached) return cached;
  const target = String(server.url ?? "").trim();
  if (!/^https?:\/\//i.test(target)) throw new Error("MCP SSE server URL must be http(s)");
  const started = Date.now();
  const response = await fetch(target, { headers: headersFromMcpServer(server) });
  const endpoint = resolveMcpSseEndpoint(target, await readMcpSseUntilEndpoint(response));
  addLog({
    providerId: String(server.id ?? "mcp"),
    providerName: String(isRecord(server.commonOptions) ? server.commonOptions.name ?? "MCP Server" : "MCP Server"),
    url: target,
    ok: true,
    status: response.status,
    kind: "mcp:sse:endpoint",
    durationMs: Date.now() - started,
    responsePreview: endpoint,
    toolName: "endpoint",
  });
  server.ssePostEndpoint = endpoint;
  return endpoint;
}

async function postMcpJsonRpc(
  server: Record<string, JsonValue>,
  method: string,
  params: Record<string, JsonValue> | undefined,
  extraHeaders: Record<string, string> = {},
  options: { notification?: boolean } = {},
) {
  const target = String(server.type ?? "streamable_http") === "sse"
    ? await mcpSsePostEndpoint(server)
    : String(server.url ?? "").trim();
  if (!/^https?:\/\//i.test(target)) throw new Error("MCP server URL must be http(s)");
  const body = options.notification
    ? { jsonrpc: "2.0", method, params: params ?? {} }
    : { jsonrpc: "2.0", id: id(), method, params: params ?? {} };
  const started = Date.now();
  const response = await fetch(target, { method: "POST", headers: { ...headersFromMcpServer(server), ...extraHeaders }, body: JSON.stringify(body) });
  const text = await response.text();
  const raw: any = parseMcpResponseText(text);
  addLog({
    providerId: String(server.id ?? "mcp"),
    providerName: String(isRecord(server.commonOptions) ? server.commonOptions.name ?? "MCP Server" : "MCP Server"),
    url: target,
    ok: response.ok && !raw.error,
    status: response.status,
    kind: `mcp:${method}`,
    durationMs: Date.now() - started,
    requestPreview: jsonPreview(body),
    responsePreview: textPreview(text),
    toolName: method,
    error: response.ok && !raw.error ? undefined : jsonPreview(raw.error ?? text),
  });
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 500)}`);
  if (raw.error) throw new Error(jsonPreview(raw.error, 500));
  return {
    result: raw.result ?? raw,
    sessionId: response.headers.get("mcp-session-id") ?? response.headers.get("Mcp-Session-Id") ?? undefined,
    protocolVersion: typeof raw.result?.protocolVersion === "string" ? raw.result.protocolVersion : undefined,
  };
}

async function mcpSessionHeaders(server: Record<string, JsonValue>) {
  const cacheKey = mcpSessionCacheKey(server);
  const cached = mcpSessionCache.get(cacheKey);
  if (cached?.sessionId) {
    return {
      "mcp-session-id": cached.sessionId,
      ...(cached.protocolVersion ? { "mcp-protocol-version": cached.protocolVersion } : {}),
    };
  }
  let init: Awaited<ReturnType<typeof postMcpJsonRpc>> | null = null;
  let lastError: unknown = null;
  for (const protocolVersion of MCP_PROTOCOL_VERSIONS) {
    try {
      init = await postMcpJsonRpc(server, "initialize", {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "RikkaHub PC", version: "pc-dev" },
      });
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!init) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "MCP initialize failed"));
  }
  if (init.sessionId) mcpSessionCache.set(cacheKey, { sessionId: init.sessionId, protocolVersion: init.protocolVersion });
  const headers = init.sessionId
    ? {
      "mcp-session-id": init.sessionId,
      ...(init.protocolVersion ? { "mcp-protocol-version": init.protocolVersion } : {}),
    }
    : {};
  await postMcpJsonRpc(server, "notifications/initialized", {}, headers, { notification: true });
  return headers;
}

async function mcpJsonRpc(server: Record<string, JsonValue>, method: string, params?: Record<string, JsonValue>) {
  const cacheKey = mcpSessionCacheKey(server);
  const headers = await mcpSessionHeaders(server);
  try {
    const response = await postMcpJsonRpc(server, method, params, headers);
    return response.result;
  } catch (err) {
    if (!mcpSessionCache.has(cacheKey)) throw err;
    mcpSessionCache.delete(cacheKey);
    const retryHeaders = await mcpSessionHeaders(server);
    const response = await postMcpJsonRpc(server, method, params, retryHeaders);
    return response.result;
  }
}

async function fetchMcpTools(server: Record<string, JsonValue>) {
  const result = await mcpJsonRpc(server, "tools/list");
  const tools = Array.isArray(result.tools) ? result.tools : [];
  return tools.map((tool: any) => ({
    enable: true,
    name: String(tool.name ?? ""),
    description: tool.description ? String(tool.description) : null,
    inputSchema: tool.inputSchema ?? tool.input_schema ?? { type: "object", properties: {} },
    needsApproval: tool.needsApproval === true,
  })).filter((tool) => tool.name);
}

async function syncMcpServerTools(server: Record<string, JsonValue>) {
  const common = isRecord(server.commonOptions) ? server.commonOptions : {};
  try {
    const tools = await fetchMcpTools(server);
    return {
      ...server,
      commonOptions: {
        ...common,
        tools,
        lastSyncAt: Date.now(),
        lastSyncError: "",
        connected: true,
      },
    };
  } catch (err) {
    return {
      ...server,
      commonOptions: {
        ...common,
        lastSyncAt: Date.now(),
        lastSyncError: err instanceof Error ? err.message : String(err),
        connected: false,
      },
    };
  }
}

async function callMcpTool(assistant: Assistant, toolName: string, args: Record<string, JsonValue>) {
  const selected = new Set(getStringArray(assistant.mcpServers));
  const servers = (state.settings.mcpServers as Array<Record<string, JsonValue>>)
    .filter((server) => selected.has(String(server.id ?? "")) && isRecord(server.commonOptions) && server.commonOptions.enable !== false);
  for (const server of servers) {
    const common = server.commonOptions as Record<string, JsonValue>;
    const tools = Array.isArray(common.tools) ? common.tools.filter(isRecord) : [];
    const matched = tools.find((tool) => tool.enable !== false && `mcp__${String(tool.name ?? "").replace(/[^a-zA-Z0-9_-]/g, "_")}` === toolName);
    if (!matched) continue;
    const result = await mcpJsonRpc(server, "tools/call", { name: String(matched.name), arguments: args });
    return result;
  }
  throw new Error(`MCP tool '${toolName}' is not available for this assistant`);
}

async function runPowerShell(command: string, input = "") {
  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input) {
    proc.stdin.write(input);
  }
  proc.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `PowerShell exited with code ${exitCode}`);
  return stdout;
}

async function readSystemClipboardText() {
  return runPowerShell("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-Clipboard -Raw");
}

async function writeSystemClipboardText(text: string) {
  await runPowerShell("[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd())", text);
}

async function speakSystemText(text: string, speechRate = 1) {
  const rate = Math.max(-10, Math.min(10, Math.round((speechRate - 1) * 5)));
  await runPowerShell(`Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate=${rate}; $s.Speak([Console]::In.ReadToEnd())`, text);
}

function runMemoryTool(assistant: Assistant, args: Record<string, JsonValue>) {
  if (!assistant.enableMemory) throw new Error("memory_tool is not enabled for this assistant");
  const action = String(args.action ?? "").trim();
  const assistantId = assistant.useGlobalMemory ? GLOBAL_MEMORY_ID : assistant.id;
  const now = Date.now();
  if (action === "create") {
    const content = String(args.content ?? "").trim();
    if (!content) throw new Error("content is required");
    const memory: AssistantMemory = {
      id: state.nextMemoryId++,
      assistantId,
      content,
      createdAt: now,
      updatedAt: now,
    };
    state.memories.push(memory);
    saveState();
    return { id: memory.id, content: memory.content };
  }
  if (action === "edit") {
    const memoryId = Number(args.id);
    const content = String(args.content ?? "").trim();
    if (!Number.isInteger(memoryId)) throw new Error("id is required");
    if (!content) throw new Error("content is required");
    const memory = state.memories.find((item) => item.id === memoryId && item.assistantId === assistantId);
    if (!memory) throw new Error(`Memory record #${memoryId} not found`);
    memory.content = content;
    memory.updatedAt = now;
    saveState();
    return { id: memory.id, content: memory.content };
  }
  if (action === "delete") {
    const memoryId = Number(args.id);
    if (!Number.isInteger(memoryId)) throw new Error("id is required");
    const before = state.memories.length;
    state.memories = state.memories.filter((item) => !(item.id === memoryId && item.assistantId === assistantId));
    if (state.memories.length === before) throw new Error(`Memory record #${memoryId} not found`);
    saveState();
    return { success: true, id: memoryId };
  }
  throw new Error("unknown action: " + action + ", must be one of [create, edit, delete]");
}

async function executeToolCall(toolCall: any, assistant: Assistant) {
  const name = String(toolCall.function?.name ?? "");
  let args: Record<string, JsonValue> = {};
  try {
    const parsedArgs = JSON.parse(String(toolCall.function?.arguments ?? "{}").trim() || "{}");
    if (!isRecord(parsedArgs) || Array.isArray(parsedArgs)) {
      throw new Error("tool arguments must be a JSON object");
    }
    args = parsedArgs as Record<string, JsonValue>;
  } catch (err) {
    throw new Error(`Invalid tool arguments JSON for ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (name === "memory_tool") return runMemoryTool(assistant, args);
  if (name === "search_web") return runSearchWeb(args);
  if (name === "scrape_web") return runScrapeWeb(args);
  if (name === "get_time_info") {
    const now = new Date();
    return {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
      weekday: new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(now),
      weekday_en: new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(now),
      date: formatKeyLocal(now),
      time: now.toLocaleTimeString(),
      datetime: `${formatKeyLocal(now)} ${now.toLocaleTimeString()}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timestamp_ms: now.getTime(),
    };
  }
  if (name === "eval_javascript") {
    const code = String(args.code ?? "");
    if (code.length > 20_000) throw new Error("JavaScript code is too long");
    const logs: string[] = [];
    const toolConsole = {
      log: (...values: unknown[]) => logs.push(`[LOG] ${values.map((value) => String(value)).join(" ")}`),
      info: (...values: unknown[]) => logs.push(`[INFO] ${values.map((value) => String(value)).join(" ")}`),
      warn: (...values: unknown[]) => logs.push(`[WARN] ${values.map((value) => String(value)).join(" ")}`),
      error: (...values: unknown[]) => logs.push(`[ERROR] ${values.map((value) => String(value)).join(" ")}`),
    };
    const fn = new Function("code", "console", "process", "Bun", "require", "globalThis", "\"use strict\"; return eval(code);");
    const result = fn(code, toolConsole, undefined, undefined, undefined, undefined);
    return { ...(logs.length ? { logs: logs.join("\n") } : {}), result: result == null ? null : String(result) };
  }
  if (name === "clipboard_tool") {
    const action = String(args.action ?? "").trim();
    if (action === "write") {
      const text = String(args.text ?? "");
      await writeSystemClipboardText(text);
      return {
        success: true,
        text,
      };
    }
    if (action === "read") {
      return {
        text: await readSystemClipboardText(),
      };
    }
    throw new Error("unknown action: " + action + ", must be one of [read, write]");
  }
  if (name === "text_to_speech") {
    const text = String(args.text ?? "").trim();
    if (!text) throw new Error("text is required");
    await speakSystemText(text);
    return {
      success: true,
    };
  }
  if (name === "ask_user") {
    return {
      pending: true,
      questions: Array.isArray(args.questions) ? args.questions : [],
      note: "The question has been shown in the conversation. Wait for the user answer before continuing.",
    };
  }
  if (name === "use_skill") {
    const skillName = String(args.name ?? "").trim();
    if (!getStringArray(assistant.enabledSkills).includes(skillName)) {
      throw new Error(`Skill '${skillName}' is not available. Available skills: ${getStringArray(assistant.enabledSkills).join(", ")}`);
    }
    const path = String(args.path ?? "").trim();
    const content = path ? (() => {
      const target = safeSkillFile(skillName, path);
      if (!target || !existsSync(target)) throw new Error(`File '${path}' not found in skill '${skillName}'`);
      return readFileSync(target, "utf8");
    })() : readSkillBody(skillName);
    if (!content) throw new Error(`Skill '${skillName}' not found`);
    return { name: skillName, content };
  }
  if (name.startsWith("mcp__")) {
    return callMcpTool(assistant, name, args);
  }
  throw new Error(`Unknown tool: ${name}`);
}

function toolExecutionErrorPayload(err: unknown) {
  if (err instanceof Error) {
    return {
      error: `[${err.name || "Error"}] ${err.message}${err.stack ? `\n${err.stack}` : ""}`,
    };
  }
  return { error: String(err) };
}

type ApiMessage = Record<string, any>;

function openAiToolOutput(parts: JsonValue[]) {
  const text = textFromParts(parts);
  if (text) return text;
  return parts.length ? JSON.stringify(parts) : "";
}

function toolOutputForApproval(part: Record<string, JsonValue>) {
  const approvalState = isRecord(part.approvalState) ? part.approvalState : { type: "auto" };
  const type = String(approvalState.type ?? "auto");
  if (type === "answered") return String(approvalState.answer ?? "");
  if (type === "denied") {
    const reason = String(approvalState.reason ?? "").trim() || "No reason provided";
    return JSON.stringify({ error: `Tool execution denied by user. Reason: ${reason}` });
  }
  return "";
}

function resolvedToolOutput(part: Record<string, JsonValue>) {
  const output = Array.isArray(part.output) ? part.output : [];
  const fromOutput = openAiToolOutput(output);
  if (fromOutput) return fromOutput;
  return toolOutputForApproval(part);
}

function fileEntryFromApiUrl(url: string) {
  const match = url.match(/^\/api\/files\/(\d+)\/content(?:\?.*)?$/) ?? url.match(/^\/files\/(\d+)\/content(?:\?.*)?$/);
  if (!match) return null;
  return state.files.find((file) => file.id === Number(match[1])) ?? null;
}

function safeDataFilePath(relativePath: string) {
  let decoded = "";
  try {
    decoded = decodeURIComponent(relativePath).replace(/\\/g, "/").replace(/^\/+/, "");
  } catch {
    return null;
  }
  if (!decoded || decoded.split("/").some((part) => part === "..")) return null;
  const roots = [resolve(dataDir), resolve(filesDir)];
  const separator = process.platform === "win32" ? "\\" : "/";
  const candidates = [resolve(dataDir, decoded), resolve(filesDir, decoded)];
  return candidates.find((candidate) =>
    roots.some((root) => (candidate === root || candidate.startsWith(`${root}${separator}`))) &&
    existsSync(candidate) &&
    statSync(candidate).isFile()
  ) ?? null;
}

function extensionFromMime(mime: string) {
  const normalized = mime.toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return ".jpg";
  if (normalized.includes("webp")) return ".webp";
  if (normalized.includes("gif")) return ".gif";
  if (normalized.includes("svg")) return ".svg";
  if (normalized.includes("pdf")) return ".pdf";
  if (normalized.includes("json")) return ".json";
  if (normalized.includes("text")) return ".txt";
  return ".png";
}

async function saveToolBinaryContent(data: string, mime: string, prefix: string) {
  const fileId = state.nextFileId++;
  const fileName = `${prefix}-${Date.now()}-${fileId}${extensionFromMime(mime)}`;
  const target = join(filesDir, fileName);
  await Bun.write(target, Buffer.from(data, "base64"));
  const fileEntry: StoredFile = { id: fileId, path: target, fileName, mime, size: statSync(target).size };
  state.files.push(fileEntry);
  saveState();
  return `/api/files/${fileId}/content`;
}

async function toolResultToParts(toolResult: unknown): Promise<JsonValue[]> {
  if (typeof toolResult === "string") return [{ type: "text", text: toolResult }];
  if (isRecord(toolResult) && Array.isArray(toolResult.content)) {
    const parts: JsonValue[] = [];
    for (const item of toolResult.content) {
      if (!isRecord(item)) continue;
      const type = String(item.type ?? "").toLowerCase();
      if (type === "text") {
        parts.push({ type: "text", text: String(item.text ?? "") });
        continue;
      }
      if (type === "image") {
        const data = String(item.data ?? item.base64 ?? "");
        const mime = String(item.mimeType ?? item.mime_type ?? "image/png");
        if (data) {
          parts.push({
            type: "image",
            url: await saveToolBinaryContent(data, mime, "mcp-image"),
            metadata: { source: "mcp", mime },
          });
        }
        continue;
      }
      if (type === "resource" && isRecord(item.resource)) {
        const resource = item.resource;
        const text = String(resource.text ?? "");
        if (text) parts.push({ type: "text", text });
        else parts.push({ type: "text", text: JSON.stringify(item) });
        continue;
      }
      parts.push({ type: "text", text: JSON.stringify(item) });
    }
    if (parts.length) return parts;
  }
  return [{ type: "text", text: JSON.stringify(toolResult) }];
}

function dataUrlForMessageUrl(url: string) {
  if (!url || url.startsWith("data:") || /^https?:\/\//i.test(url)) return url;
  const entry = fileEntryFromApiUrl(url);
  if (!entry || !existsSync(entry.path)) return url;
  const data = readFileSync(entry.path).toString("base64");
  return `data:${entry.mime || "application/octet-stream"};base64,${data}`;
}

function parseDataUrl(url: string) {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/);
  return match ? { mime: match[1], data: match[2] } : null;
}

function stripXmlText(input: string) {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function readZipEntries(buffer: Buffer) {
  const entries: Array<{ name: string; data: Buffer }> = [];
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return entries;
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && offset + 46 <= buffer.length; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8");
    offset += 46 + fileNameLength + extraLength + commentLength;
    if (!name || name.endsWith("/") || localOffset + 30 > buffer.length) continue;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    try {
      if (compression === 0) entries.push({ name, data: raw });
      if (compression === 8) entries.push({ name, data: inflateRawSync(raw) });
    } catch {
      // Ignore unreadable zip members; EPUB text extraction is best-effort.
    }
  }
  return entries;
}

function extractEpubText(pathValue: string) {
  const entries = readZipEntries(readFileSync(pathValue));
  const textEntries = entries
    .filter((entry) => /\.(xhtml|html|htm|xml|opf|ncx)$/i.test(entry.name))
    .filter((entry) => !/^(META-INF\/|mimetype$)/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const text = textEntries
    .map((entry) => stripXmlText(entry.data.toString("utf8")))
    .filter(Boolean)
    .join("\n\n");
  return text.slice(0, 240_000);
}

function extractStoredFileText(entry: StoredFile) {
  const name = entry.fileName.toLowerCase();
  const mimeValue = entry.mime.toLowerCase();
  try {
    if (mimeValue === "application/epub+zip" || name.endsWith(".epub")) return extractEpubText(entry.path);
    if (
      mimeValue.startsWith("text/") ||
      /\.(txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|xml|html|htm|css|js|ts|tsx|jsx|py|java|kt|rs|go|c|cpp|h|hpp|cs|php|rb|sh|ps1|sql)$/i.test(name)
    ) {
      return readFileSync(entry.path, "utf8").slice(0, 240_000);
    }
  } catch {
    return "";
  }
  return "";
}

function documentPromptText(fileName: string, content: string) {
  return `## user sent a file: ${fileName}
<content>
\`\`\`
${content}
\`\`\`
</content>`;
}

function contentPartsForApi(parts: JsonValue[], targetModel?: Model) {
  const stripImageForOcr = targetModel ? !supportsInputModality(targetModel, "IMAGE") : false;
  const result: any[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.type === "text") {
      const text = String(part.text ?? "");
      if (text) result.push({ type: "text", text });
    } else if (part.type === "image") {
      const metadata = isRecord(part.metadata) ? part.metadata : {};
      const ocrText = String(metadata.ocrText ?? "").trim();
      // Android OcrTransformer: when chat model has no IMAGE input, replace image with OCR text.
      // Otherwise (model supports image), keep the image and append OCR text alongside as extra hint.
      if (stripImageForOcr && ocrText) {
        result.push({
          type: "text",
          text: `<image_file_ocr>\n${ocrText}\n</image_file_ocr>`,
        });
        continue;
      }
      const url = dataUrlForMessageUrl(String(part.url ?? ""));
      if (url) result.push({ type: "image_url", image_url: { url } });
      if (ocrText) {
        result.push({
          type: "text",
          text: `<image_file_ocr>\n${ocrText}\n</image_file_ocr>`,
        });
      }
    } else if (part.type === "document") {
      const fileName = String(part.fileName ?? "document");
      const url = String(part.url ?? "");
      const entry = fileEntryFromApiUrl(url);
      const extractedText = String(entry?.extractedText ?? "").trim();
      result.push({
        type: "text",
        text: extractedText
          ? documentPromptText(fileName, extractedText)
          : `[Document: ${fileName}] ${url}`,
      });
    } else if (part.type === "audio" || part.type === "video") {
      const url = String(part.url ?? "");
      if (url) result.push({ type: "text", text: `[${part.type}: ${url}]` });
    }
  }
  return result;
}

function apiContentFromParts(parts: JsonValue[], fallbackText = "", targetModel?: Model) {
  const contentParts = contentPartsForApi(parts, targetModel);
  if (contentParts.length === 0) return fallbackText;
  if (contentParts.length === 1 && contentParts[0].type === "text") return contentParts[0].text;
  return contentParts;
}

function claudeContentFromApiContent(content: any) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((part) => {
    if (part?.type === "image_url") {
      const dataUrl = String(part.image_url?.url ?? "");
      const parsed = parseDataUrl(dataUrl);
      if (parsed) {
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: parsed.mime,
            data: parsed.data,
          },
        };
      }
      return { type: "text", text: `[Image: ${dataUrl}]` };
    }
    if (part?.type === "text") return { type: "text", text: String(part.text ?? "") };
    return { type: "text", text: JSON.stringify(part) };
  });
}

function claudeCacheControlEphemeral(providerItem: Provider) {
  return {
    type: "ephemeral",
    ...(providerItem.promptCacheTtl === "1h" ? { ttl: "1h" } : {}),
  };
}

function claudeTextBlock(text: string) {
  return { type: "text", text };
}

function claudeContentBlocks(content: any) {
  const converted = claudeContentFromApiContent(content);
  return Array.isArray(converted) ? converted : [claudeTextBlock(String(converted ?? ""))];
}

function claudeBlocksFromUiParts(parts: JsonValue[]) {
  const blocks: any[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.type === "text") {
      const text = String(part.text ?? "");
      if (text) blocks.push({ type: "text", text });
    } else if (part.type === "image") {
      const parsed = parseDataUrl(dataUrlForMessageUrl(String(part.url ?? "")));
      if (parsed) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: parsed.mime, data: parsed.data },
        });
      } else {
        const url = String(part.url ?? "");
        if (url) blocks.push({ type: "text", text: `[Image: ${url}]` });
      }
    } else if (part.type === "document") {
      const fileName = String(part.fileName ?? "document");
      const url = String(part.url ?? "");
      const entry = fileEntryFromApiUrl(url);
      const extractedText = String(entry?.extractedText ?? "").trim();
      blocks.push({
        type: "text",
        text: extractedText
          ? documentPromptText(fileName, extractedText)
          : `[Document: ${fileName}] ${url}`,
      });
    }
  }
  return blocks.length ? blocks : [claudeTextBlock("")];
}

function parseToolInput(value: unknown) {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function claudeToolUseBlock(toolCall: any) {
  const fn = toolCall?.function ?? {};
  return {
    type: "tool_use",
    id: String(toolCall?.id ?? id()),
    name: String(fn.name ?? ""),
    input: parseToolInput(fn.arguments),
  };
}

function claudeToolResultBlock(toolMessage: ApiMessage) {
  const outputParts = Array.isArray(toolMessage._rikkahub_tool_output_parts)
    ? claudeBlocksFromUiParts(toolMessage._rikkahub_tool_output_parts)
    : claudeContentBlocks(toolMessage.content);
  return {
    type: "tool_result",
    tool_use_id: String(toolMessage.tool_call_id ?? ""),
    content: outputParts,
  };
}

function withClaudeCacheOnLastBlock(content: any, providerItem: Provider) {
  const blocks = claudeContentBlocks(content);
  if (blocks.length === 0) return blocks;
  return blocks.map((block, index) =>
    index === blocks.length - 1 && isRecord(block)
      ? { ...block, cache_control: claudeCacheControlEphemeral(providerItem) }
      : block,
  );
}

function claudeSystemContent(system: unknown, providerItem: Provider) {
  const text = String(system ?? "").trim();
  if (!text) return undefined;
  return providerItem.promptCaching === true ? withClaudeCacheOnLastBlock(text, providerItem) : text;
}

function claudeMessagesFromApiMessages(messages: ApiMessage[], providerItem: Provider) {
  const items = messages
    .filter((item) => item.role !== "system")
    .flatMap((item) => {
      if (item.role === "assistant") {
        const content = claudeContentBlocks(item.content).filter((block) =>
          !isRecord(block) || block.type !== "text" || String(block.text ?? "").trim()
        );
        const toolCalls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
        const toolUseBlocks = toolCalls.map(claudeToolUseBlock).filter((block) => block.name);
        const blocks = [...content, ...toolUseBlocks];
        return blocks.length ? [{ role: "assistant", content: blocks }] : [];
      }
      if (item.role === "tool") {
        return [{ role: "user", content: [claudeToolResultBlock(item)] }];
      }
      return [{ role: "user", content: claudeContentBlocks(item.content) }];
    });
  if (providerItem.promptCaching !== true) return items;

  const realUserIndices = items
    .map((item, index) => {
      const content = Array.isArray(item.content) ? item.content : [];
      const hasOnlyToolResults = content.length > 0 && content.every((block) => isRecord(block) && block.type === "tool_result");
      return item.role === "user" && !hasOnlyToolResults ? index : -1;
    })
    .filter((index) => index >= 0);
  const targetIndex = realUserIndices.length >= 2 ? realUserIndices[realUserIndices.length - 2] : -1;
  if (targetIndex < 0) return items;
  return items.map((item, index) =>
    index === targetIndex
      ? { ...item, content: withClaudeCacheOnLastBlock(item.content, providerItem) }
      : item,
  );
}

function claudeToolsFromOpenAiTools(tools: any[], providerItem: Provider) {
  return tools
    .map((tool, index) => {
      const fn = tool?.function ?? {};
      const name = String(fn.name ?? "");
      if (!name) return null;
      return {
        name,
        description: String(fn.description ?? ""),
        input_schema: isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
        ...(providerItem.promptCaching === true && index === tools.length - 1
          ? { cache_control: claudeCacheControlEphemeral(providerItem) }
          : {}),
      };
    })
    .filter(Boolean);
}

function appendAssistantApiMessages(items: ApiMessage[], message: Message, includeReasoning: boolean) {
  const contentBuffer: string[] = [];
  let reasoningBuffer = "";

  const flushAssistant = (tools: JsonValue[] = []) => {
    const content = contentBuffer.join("\n").trim();
    const reasoning = reasoningBuffer.trim();
    if (!content && !reasoning && tools.length === 0) return;
    const payload: ApiMessage = {
      role: "assistant",
      content,
    };
    if (includeReasoning && reasoning) payload.reasoning_content = reasoning;
    if (tools.length) {
      payload.tool_calls = tools.map((tool) => {
        const record = isRecord(tool) ? tool : {};
        return {
          id: String(record.toolCallId ?? id()),
          type: "function",
          function: {
            name: String(record.toolName ?? ""),
            arguments: String(record.input ?? "{}"),
          },
        };
      });
    }
    items.push(payload);
    contentBuffer.length = 0;
    reasoningBuffer = "";
  };

  for (const part of message.parts) {
    if (!isRecord(part)) continue;
    if (part.type === "reasoning") {
      const reasoning = String(part.reasoning ?? "").trim();
      if (reasoning) reasoningBuffer += `${reasoningBuffer ? "\n" : ""}${reasoning}`;
      continue;
    }
    if (part.type === "text") {
      const text = String(part.text ?? "").trim();
      if (text) contentBuffer.push(text);
      continue;
    }
    if (part.type === "image" || part.type === "document" || part.type === "audio" || part.type === "video") {
      const url = String(part.url ?? "");
      const name = String(part.fileName ?? part.type);
      if (url) contentBuffer.push(`[${name}] ${url}`);
      continue;
    }
    if (part.type === "tool") {
      flushAssistant([part]);
      items.push({
        role: "tool",
        name: String(part.toolName ?? ""),
        tool_call_id: String(part.toolCallId ?? ""),
        content: resolvedToolOutput(part),
        _rikkahub_tool_output_parts: Array.isArray(part.output) ? part.output : [],
      });
    }
  }
  flushAssistant();
}

function conversationTransformedMessages(conversation: Conversation, assistant: Assistant) {
  const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
  const rawMessages = conversation.messages.slice(assistant.contextMessageSize > 0 ? -assistant.contextMessageSize : undefined);
  const selectedMessages = rawMessages
    .map((node) => node.messages[node.selectIndex] ?? node.messages[0])
    .filter(Boolean);
  const conversationSystemPrompt = assistant.allowConversationSystemPrompt
    ? String(conversation.systemPrompt ?? "").trim()
    : "";
  const effectiveSystemPrompt = conversationSystemPrompt || assistant.systemPrompt.trim();
  const systemParts = [
    effectiveSystemPrompt
      ? renderTemplate(effectiveSystemPrompt, templateVariables("", "system", assistant, picked.model))
      : "",
    buildMemoryPrompt(assistant),
    buildRecentChatsPrompt(assistant, conversation.id),
    buildSkillsContext(assistant),
    buildSearchContext(),
  ].filter(Boolean);

  const internalMessages: Message[] = [];
  if (systemParts.length) {
    internalMessages.push(message("SYSTEM", [{ type: "text", text: systemParts.join("\n\n") }]));
  }
  internalMessages.push(...selectedMessages.map((msg) => cloneJson(msg)));

  const messagesAfterTimeReminder: Message[] = [];
  let firstUserReminderInjected = false;
  for (let index = 0; index < internalMessages.length; index += 1) {
    const selected = internalMessages[index];
    if (assistant.enableTimeReminder && selected.role === "USER") {
      const previous = firstUserReminderInjected && index > 0 ? internalMessages[index - 1] : undefined;
      const reminder = timeReminderContent(
        selected,
        previous,
      );
      if (reminder) messagesAfterTimeReminder.push(message("USER", [{ type: "text", text: reminder }]));
      firstUserReminderInjected = true;
    }
    messagesAfterTimeReminder.push(selected);
  }

  const injections = activePromptInjections(assistant, messagesAfterTimeReminder);
  return { messages: applyPromptInjectionsToMessages(messagesAfterTimeReminder, injections), picked };
}

function conversationMessagesForApi(conversation: Conversation, assistant: Assistant) {
  const template = assistant.messageTemplate?.trim() || "{{ message }}";
  const { messages: transformedMessages, picked } = conversationTransformedMessages(conversation, assistant);

  const items: ApiMessage[] = [];
  for (const selected of transformedMessages) {
    if (selected.role === "ASSISTANT") {
      appendAssistantApiMessages(
        items,
        {
          ...selected,
          parts: applyMessageTemplateToParts(selected.parts, "assistant", template),
        },
        true,
      );
      continue;
    }
    const rawContent = textFromParts(selected.parts);
    const role = selected.role === "SYSTEM" ? "system" : selected.role === "TOOL" ? "tool" : "user";
    const placeholderParts = selected.parts.map((part) =>
      isRecord(part) && part.type === "text"
        ? { ...part, text: applyPlaceholders(String(part.text ?? ""), templateVariables(rawContent, role, assistant, picked.model)) }
        : part,
    );
    const templatedParts = applyMessageTemplateToParts(placeholderParts, role, template);
    const content = apiContentFromParts(templatedParts, rawContent, picked.model);
    if (!content) continue;
    items.push({ role, content });
  }
  return items;
}

function conversationResponseApiInput(conversation: Conversation, assistant: Assistant) {
  const template = assistant.messageTemplate?.trim() || "{{ message }}";
  const { messages: transformedMessages, picked } = conversationTransformedMessages(conversation, assistant);
  const converted = transformedMessages
    .map((selected) => {
      if (selected.role === "ASSISTANT") {
        return {
          ...selected,
          parts: applyMessageTemplateToParts(selected.parts, "assistant", template),
        };
      }
      const rawContent = textFromParts(selected.parts);
      const role = selected.role === "SYSTEM" ? "system" : selected.role === "TOOL" ? "tool" : "user";
      const placeholderParts = selected.parts.map((part) =>
        isRecord(part) && part.type === "text"
          ? { ...part, text: applyPlaceholders(String(part.text ?? ""), templateVariables(rawContent, role, assistant, picked.model)) }
          : part,
      );
      return {
        ...selected,
        parts: applyMessageTemplateToParts(placeholderParts, role, template),
      };
    });
  return responseApiMessagesFromUiMessages(converted, picked.model);
}

function conversationResponseApiInstructions(conversation: Conversation, assistant: Assistant) {
  const { messages: transformedMessages, picked } = conversationTransformedMessages(conversation, assistant);
  return transformedMessages
    .filter((item) => item.role === "SYSTEM")
    .map((item) =>
      applyPlaceholders(
        textFromParts(item.parts),
        templateVariables(textFromParts(item.parts), "system", assistant, picked.model),
      )
    )
    .filter(Boolean)
    .join("\n");
}

function endpointFor(providerItem: Provider) {
  const base = providerItem.baseUrl.replace(/\/+$/, "");
  if (providerItem.type === "openai") {
    return providerItem.useResponseApi ? `${base}/responses` : `${base}${providerItem.chatCompletionsPath || "/chat/completions"}`;
  }
  if (providerItem.type === "claude") return `${base}/messages`;
  return `${base}/models/{model}:generateContent`;
}

function reasoningEffortForApi(level: string | null | undefined) {
  const normalized = String(level ?? "").toLowerCase();
  if (!["low", "medium", "high"].includes(normalized)) return undefined;
  return normalized;
}

function reasoningForApi(level: string | null | undefined) {
  const normalized = String(level ?? "").toLowerCase();
  if (!["low", "medium", "high"].includes(normalized)) return undefined;
  return { effort: normalized };
}

function reasoningLevelNormalized(level: string | null | undefined) {
  const normalized = String(level ?? "").toLowerCase();
  return normalized === "off" || normalized === "none" ? "off" : normalized;
}

function supportsAbility(modelItem: Model, ability: string) {
  return (modelItem.abilities ?? []).map((item) => String(item).toUpperCase()).includes(ability.toUpperCase());
}

function supportsInputModality(modelItem: Model, modality: string) {
  return (modelItem.inputModalities ?? []).map((item) => String(item).toUpperCase()).includes(modality.toUpperCase());
}

function supportsOutputModality(modelItem: Model, modality: string) {
  return (modelItem.outputModalities ?? []).map((item) => String(item).toUpperCase()).includes(modality.toUpperCase());
}

function hasBuiltInTool(modelItem: Model, toolType: string) {
  return (Array.isArray(modelItem.tools) ? modelItem.tools : []).some((tool) => {
    if (typeof tool === "string") return tool.toLowerCase() === toolType.toLowerCase();
    if (tool && typeof tool === "object" && !Array.isArray(tool)) return String(tool.type ?? "").toLowerCase() === toolType.toLowerCase();
    return false;
  });
}

function responseApiBuiltInTools(modelItem: Model) {
  const tools: Record<string, JsonValue>[] = [];
  if (hasBuiltInTool(modelItem, "search")) tools.push({ type: "web_search" });
  if (hasBuiltInTool(modelItem, "image_generation")) tools.push({ type: "image_generation", model: "gpt-image-2" });
  return tools;
}

function openAiChatCompletionsModalities(modelItem: Model, providerItem: Provider) {
  if (hostOfProvider(providerItem) === "openrouter.ai" && supportsOutputModality(modelItem, "IMAGE")) {
    return ["image", "text"];
  }
  return undefined;
}

function responseProviderCapabilities(providerItem: Provider) {
  const host = hostOfProvider(providerItem);
  if (host === "ark.cn-beijing.volces.com") {
    return { supportsReasoningSummary: false, supportsEncryptedContent: false };
  }
  return { supportsReasoningSummary: true, supportsEncryptedContent: true };
}

function responseApiReasoningForProvider(providerItem: Provider, modelItem: Model, level: string | null | undefined) {
  if (!supportsAbility(modelItem, "REASONING")) return undefined;
  const normalized = reasoningLevelNormalized(level);
  const capabilities = responseProviderCapabilities(providerItem);
  const payload: Record<string, JsonValue> = {};
  if (capabilities.supportsReasoningSummary) payload.summary = "auto";
  if (normalized !== "auto") {
    payload.effort = normalized === "off" ? "none" : normalized;
  }
  return payload;
}

function responseApiIncludeForProvider(providerItem: Provider, modelItem: Model) {
  if (!supportsAbility(modelItem, "REASONING")) return undefined;
  return responseProviderCapabilities(providerItem).supportsEncryptedContent
    ? ["reasoning.encrypted_content"]
    : undefined;
}

function apiContentText(content: unknown) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (isRecord(part)) return String(part.text ?? part.content ?? "");
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function responseApiContent(content: unknown, role: string) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return apiContentText(content);
  return content
    .map((part) => {
      if (!isRecord(part)) return null;
      const text = String(part.text ?? part.content ?? "");
      if (text) {
        return {
          type: role === "assistant" ? "output_text" : "input_text",
          text,
        };
      }
      if (part.type === "image_url") return part;
      return null;
    })
    .filter(Boolean);
}

function responseApiContentFromUiParts(parts: JsonValue[], role: string) {
  const content = parts
    .map((part) => {
      if (!isRecord(part)) return null;
      if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
        return {
          type: role === "assistant" ? "output_text" : "input_text",
          text: String(part.text ?? ""),
        };
      }
      if (part.type === "image") {
        return responseApiImagePart(part, role);
      }
      if (part.type === "image_url" || part.type === "input_image" || part.type === "output_image") {
        const rawImageUrl = isRecord(part.image_url) ? part.image_url.url : part.image_url;
        const url = String(rawImageUrl ?? part.url ?? "");
        return {
          type: role === "assistant" ? "output_image" : "input_image",
          image_url: url,
        };
      }
      if (part.type === "document") return responseApiDocumentPart(part);
      if (part.type === "audio" || part.type === "video") return responseApiTextPart(`[${part.type}: ${String(part.url ?? "")}]`, role);
      return null;
    })
    .filter(Boolean);
  if (content.length === 1 && isRecord(content[0]) && content[0].type === "input_text") return String(content[0].text ?? "");
  if (content.length === 1 && isRecord(content[0]) && content[0].type === "output_text") return String(content[0].text ?? "");
  return content;
}

function responseApiReasoningItem(part: Record<string, JsonValue>) {
  const reasoning = String(part.reasoning ?? "").trim();
  if (!reasoning) return null;
  const metadata = isRecord(part.metadata) ? part.metadata : {};
  const payload: Record<string, JsonValue> = {
    type: "reasoning",
    summary: [{ type: "summary_text", text: reasoning }],
  };
  const reasoningId = String(metadata.reasoning_id ?? "").trim();
  if (reasoningId) payload.id = reasoningId;
  const encryptedContent = String(metadata.encrypted_content ?? "").trim();
  if (encryptedContent) payload.encrypted_content = encryptedContent;
  return payload;
}

function responseApiTextPart(text: string, role: string) {
  return { type: role === "assistant" ? "output_text" : "input_text", text };
}

function responseApiImagePart(part: Record<string, JsonValue>, role: string, stripForOcr = false) {
  const metadata = isRecord(part.metadata) ? part.metadata : {};
  const ocrText = String(metadata.ocrText ?? "").trim();
  if (stripForOcr && ocrText) {
    return responseApiTextPart(`<image_file_ocr>\n${ocrText}\n</image_file_ocr>`, role);
  }
  const url = dataUrlForMessageUrl(String(part.url ?? ""));
  if (!url) return null;
  return {
    type: role === "assistant" ? "output_image" : "input_image",
    image_url: url,
  };
}

function responseApiDocumentPart(part: Record<string, JsonValue>) {
  const fileName = String(part.fileName ?? "document");
  const url = String(part.url ?? "");
  const entry = fileEntryFromApiUrl(url);
  const extractedText = String(entry?.extractedText ?? "").trim();
  return responseApiTextPart(
    extractedText ? documentPromptText(fileName, extractedText) : `[Document: ${fileName}] ${url}`,
    "user",
  );
}

function responseApiImageGenerationItem(part: Record<string, JsonValue>) {
  const metadata = isRecord(part.metadata) ? part.metadata : {};
  const callId = String(metadata.openai_image_call_id ?? "").trim();
  if (!callId) return null;
  return { type: "image_generation_call", id: callId };
}

function responseApiMessagesFromUiMessages(messages: Message[], targetModel?: Model) {
  const stripImageForOcr = targetModel ? !supportsInputModality(targetModel, "IMAGE") : false;
  const items: ApiMessage[] = [];
  for (const messageValue of messages) {
    if (messageValue.role === "SYSTEM") continue;
    if (messageValue.role === "ASSISTANT") {
      const contentBuffer: JsonValue[] = [];
      const flushContent = () => {
        const content = responseApiContentFromUiParts(contentBuffer, "assistant");
        const hasContent = typeof content === "string"
          ? content.trim().length > 0
          : Array.isArray(content) && content.length > 0;
        if (hasContent) items.push({ role: "assistant", content });
        contentBuffer.length = 0;
      };
      for (const part of messageValue.parts) {
        if (!isRecord(part)) continue;
        if (part.type === "reasoning") {
          flushContent();
          const reasoningItem = responseApiReasoningItem(part);
          if (reasoningItem) items.push(reasoningItem);
          continue;
        }
        if (part.type === "image") {
          const imageCall = responseApiImageGenerationItem(part);
          if (imageCall) {
            flushContent();
            items.push(imageCall);
            continue;
          }
          contentBuffer.push(part);
          continue;
        }
        if (part.type === "text" || part.type === "document" || part.type === "audio" || part.type === "video") {
          if (part.type === "document") contentBuffer.push(responseApiDocumentPart(part));
          else if (part.type === "audio" || part.type === "video") contentBuffer.push(responseApiTextPart(`[${part.type}: ${String(part.url ?? "")}]`, "assistant"));
          else contentBuffer.push(part);
          continue;
        }
        if (part.type === "tool") {
          flushContent();
          items.push({
            type: "function_call",
            call_id: String(part.toolCallId ?? ""),
            name: String(part.toolName ?? ""),
            arguments: String(part.input ?? "{}"),
          });
          items.push({
            type: "function_call_output",
            call_id: String(part.toolCallId ?? ""),
            output: resolvedToolOutput(part),
          });
        }
      }
      flushContent();
      continue;
    }
    const role = messageValue.role === "TOOL" ? "tool" : "user";
    const contentParts = messageValue.parts
      .map((part) => {
        if (!isRecord(part)) return null;
        if (part.type === "text") return part;
        if (part.type === "image") return responseApiImagePart(part, role, stripImageForOcr);
        if (part.type === "document") return responseApiDocumentPart(part);
        if (part.type === "audio" || part.type === "video") return responseApiTextPart(`[${part.type}: ${String(part.url ?? "")}]`, role);
        return null;
      })
      .filter(Boolean) as JsonValue[];
    const content = responseApiContentFromUiParts(contentParts, role);
    const hasContent = typeof content === "string"
      ? content.trim().length > 0
      : Array.isArray(content) && content.length > 0;
    if (hasContent) items.push({ role, content });
  }
  return items;
}

function responseApiMessages(messagesForApi: ApiMessage[]) {
  const items: ApiMessage[] = [];
  for (const item of messagesForApi) {
    if (item.role === "system") continue;
    if (item.role === "assistant") {
      const content = responseApiContent(item.content, "assistant");
      if ((typeof content === "string" && content.trim()) || (Array.isArray(content) && content.length)) {
        items.push({ role: "assistant", content });
      }
      const toolCalls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
      for (const toolCall of toolCalls) {
        const fn = toolCall?.function ?? {};
        items.push({
          type: "function_call",
          call_id: String(toolCall.id ?? ""),
          name: String(fn.name ?? ""),
          arguments: String(fn.arguments ?? ""),
        });
      }
      continue;
    }
    if (item.role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: String(item.tool_call_id ?? ""),
        output: apiContentText(item.content),
      });
      continue;
    }
    items.push({ role: item.role, content: responseApiContent(item.content, String(item.role ?? "user")) });
  }
  return items;
}

function responseApiInstructions(messagesForApi: ApiMessage[]) {
  return messagesForApi
    .filter((item) => item.role === "system")
    .map((item) => apiContentText(item.content))
    .filter(Boolean)
    .join("\n");
}

function isModelAllowTemperature(modelItem: Model) {
  return !/(^o\d|[/:_-]o\d|gpt-5)/i.test(modelItem.modelId);
}

function hostOfProvider(providerItem: Provider) {
  try {
    return new URL(providerItem.baseUrl).hostname;
  } catch {
    return "";
  }
}

function reasoningPayloadForProvider(providerItem: Provider, modelItem: Model, level: string | null | undefined) {
  if (!supportsAbility(modelItem, "REASONING")) return {};
  const normalized = reasoningLevelNormalized(level);
  const enabled = normalized !== "off";
  const host = hostOfProvider(providerItem);
  if (host === "openrouter.ai") {
    if (normalized === "off") return { reasoning: { effort: "none" } };
    if (normalized === "auto") return { reasoning: { enabled: true } };
    if (["low", "medium", "high"].includes(normalized)) return { reasoning: { effort: normalized } };
    return { reasoning: { enabled: true } };
  }
  if (host === "dashscope.aliyuncs.com") {
    return { enable_thinking: enabled };
  }
  if (host === "api.siliconflow.cn") {
    const siliconflowThinkingModels = new Set([
      "Pro/moonshotai/Kimi-K2.5",
      "Pro/zai-org/GLM-5",
      "Pro/zai-org/GLM-5.1",
      "Pro/zai-org/GLM-4.7",
      "deepseek-ai/DeepSeek-V3.2",
      "Pro/deepseek-ai/DeepSeek-V3.2",
      "Qwen/Qwen3.5-397B-A17B",
      "Qwen/Qwen3.5-122B-A10B",
      "Qwen/Qwen3.5-35B-A3B",
      "Qwen/Qwen3.5-27B",
      "Qwen/Qwen3.5-9B",
      "Qwen/Qwen3.5-4B",
      "zai-org/GLM-4.6",
      "Qwen/Qwen3-8B",
      "Qwen/Qwen3-14B",
      "Qwen/Qwen3-32B",
      "Qwen/Qwen3-30B-A3B",
      "tencent/Hunyuan-A13B-Instruct",
      "zai-org/GLM-4.5V",
      "deepseek-ai/DeepSeek-V3.1-Terminus",
      "Pro/deepseek-ai/DeepSeek-V3.1-Terminus",
      "deepseek-ai/DeepSeek-V4-Flash",
      "Pro/deepseek-ai/DeepSeek-V4-Flash",
      "deepseek-ai/DeepSeek-V4-Pro",
      "Pro/deepseek-ai/DeepSeek-V4-Pro",
    ]);
    return siliconflowThinkingModels.has(modelItem.modelId) ? { enable_thinking: enabled } : {};
  }
  if (["ark.cn-beijing.volces.com", "open.bigmodel.cn", "api.moonshot.cn", "api.deepseek.com"].includes(host)) {
    return { thinking: { type: enabled ? "enabled" : "disabled" }, ...(host === "api.deepseek.com" && enabled && ["low", "medium", "high"].includes(normalized) ? { reasoning_effort: normalized } : {}) };
  }
  if (host === "integrate.api.nvidia.com") {
    if (normalized === "auto") return {};
    if (modelItem.modelId.toLowerCase().includes("deepseek-v4")) {
      if (normalized === "xhigh") return { reasoning_effort: "max" };
      if (normalized === "off") return { reasoning_effort: "none" };
      return { reasoning_effort: "high" };
    }
    if (normalized === "off") return { reasoning_effort: "low" };
    if (normalized === "xhigh") return { reasoning_effort: "high" };
    return { reasoning_effort: normalized };
  }
  if (host === "chat.intern-ai.org.cn") return { thinking_mode: enabled };
  // Android default else branch: OpenAI 官方只接受 low/medium/high；其他兼容网关一般忽略未知字段。
  // 因此 OFF 映射成 "low"（最低预算），AUTO 不带任何字段。
  if (normalized === "auto") return {};
  if (normalized === "off") return { reasoning_effort: "low" };
  if (!["low", "medium", "high"].includes(normalized)) return {};
  return { reasoning_effort: normalized };
}

function auxiliaryReasoningPayloadForProvider(providerItem: Provider, modelItem: Model, level: string | null | undefined) {
  if (!level || !supportsAbility(modelItem, "REASONING")) return {};
  return reasoningPayloadForProvider(providerItem, modelItem, level);
}

function modelsEndpointFor(providerItem: Provider) {
  const base = providerItem.baseUrl.replace(/\/+$/, "");
  if (providerItem.type === "google") return `${base}/models?pageSize=100&key=${encodeURIComponent(providerItem.apiKey)}`;
  return `${base}/models`;
}

function providerHeaders(providerItem: Provider) {
  const headers: Record<string, string> = {};
  if (providerItem.type === "openai") headers.Authorization = `Bearer ${providerItem.apiKey}`;
  if (providerItem.type === "claude") {
    headers["x-api-key"] = providerItem.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }
  return headers;
}

function customHeaderRecords(assistant: Assistant, modelItem?: Model) {
  return [
    ...(Array.isArray(assistant.customHeaders) ? assistant.customHeaders : []),
    ...(Array.isArray((modelItem as any)?.customHeaders) ? (modelItem as any).customHeaders : []),
  ].filter(isRecord);
}

function modelCustomHeaderRecords(modelItem?: Model) {
  return (Array.isArray((modelItem as any)?.customHeaders) ? (modelItem as any).customHeaders : []).filter(isRecord);
}

function applyModelRequestHeaders(headers: Record<string, string>, providerItem: Provider, modelItem?: Model) {
  for (const header of modelCustomHeaderRecords(modelItem)) {
    const name = String(header.name ?? header.key ?? "").trim();
    if (name) headers[name] = String(header.value ?? "");
  }
  const host = hostOfProvider(providerItem);
  if (host === "aihubmix.com") headers["APP-Code"] ??= "DKHA9468";
  if (host === "openrouter.ai") {
    headers["X-Title"] ??= "RikkaHub";
    headers["HTTP-Referer"] ??= "https://rikka-ai.com";
  }
  return headers;
}

function applyRequestHeaders(
  headers: Record<string, string>,
  assistant: Assistant,
  providerItem: Provider,
  modelItem?: Model,
) {
  for (const header of customHeaderRecords(assistant, modelItem)) {
    const name = String(header.name ?? header.key ?? "").trim();
    if (name) headers[name] = String(header.value ?? "");
  }
  const host = hostOfProvider(providerItem);
  if (host === "aihubmix.com") headers["APP-Code"] ??= "DKHA9468";
  if (host === "openrouter.ai") {
    headers["X-Title"] ??= "RikkaHub";
    headers["HTTP-Referer"] ??= "https://rikka-ai.com";
  }
  return headers;
}

function mergeObjects(base: Record<string, any>, overlay: Record<string, any>): Record<string, any> {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = result[key];
    result[key] = isRecord(existing) && isRecord(value)
      ? mergeObjects(existing as Record<string, any>, value as Record<string, any>)
      : value;
  }
  return result;
}

function decodeCustomBodyValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function applyCustomBody<T extends Record<string, any>>(body: T, assistant: Assistant, modelItem?: Model): T {
  const entries = [
    ...(Array.isArray(assistant.customBodies) ? assistant.customBodies : []),
    ...(Array.isArray((modelItem as any)?.customBodies) ? (modelItem as any).customBodies : []),
  ].filter(isRecord);
  if (entries.length === 0) return body;
  let next: Record<string, any> = { ...body };
  for (const entry of entries) {
    const key = String(entry.key ?? entry.name ?? "").trim();
    if (!key) continue;
    const value = decodeCustomBodyValue(entry.value);
    const existing = next[key];
    next[key] = isRecord(existing) && isRecord(value)
      ? mergeObjects(existing as Record<string, any>, value as Record<string, any>)
      : value;
  }
  return next as T;
}

function applyModelCustomBody<T extends Record<string, any>>(body: T, modelItem?: Model): T {
  const entries = (Array.isArray((modelItem as any)?.customBodies) ? (modelItem as any).customBodies : []).filter(isRecord);
  if (entries.length === 0) return body;
  let next: Record<string, any> = { ...body };
  for (const entry of entries) {
    const key = String(entry.key ?? entry.name ?? "").trim();
    if (!key) continue;
    const value = decodeCustomBodyValue(entry.value);
    const existing = next[key];
    next[key] = isRecord(existing) && isRecord(value)
      ? mergeObjects(existing as Record<string, any>, value as Record<string, any>)
      : value;
  }
  return next as T;
}

function customBodyEntriesForForm(modelItem?: Model) {
  return (Array.isArray((modelItem as any)?.customBodies) ? (modelItem as any).customBodies : [])
    .filter(isRecord)
    .map((entry) => ({
      key: String(entry.key ?? entry.name ?? "").trim(),
      value: decodeCustomBodyValue(entry.value),
    }))
    .filter((entry) => entry.key.length > 0);
}

function customFormValue(value: unknown) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function normalizeFetchedModels(providerItem: Provider, raw: any): Model[] {
  const items = providerItem.type === "google" ? raw.models ?? [] : raw.data ?? raw.models ?? [];
  const models = (Array.isArray(items) ? items : [])
    .map((item: any) => {
      const rawId = String(item.id ?? item.name ?? item.model ?? "").trim();
      const modelId = rawId.replace(/^models\//, "");
      if (!modelId) return null;
      const displayName = String(item.display_name ?? item.displayName ?? item.name ?? modelId).replace(/^models\//, "");
      return enrichModel(model(modelId, displayName || modelId), item);
    })
    .filter(Boolean) as Model[];
  const byId = new Map<string, Model>();
  for (const item of models) byId.set(item.modelId, item);
  return [...byId.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
}

async function fetchProviderModels(providerItem: Provider) {
  const endpoint = modelsEndpointFor(providerItem);
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(endpoint, { headers: providerHeaders(providerItem) });
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    addLog({
      providerId: providerItem.id,
      providerName: providerItem.name,
      url: endpoint,
      ok: false,
      status: 0,
      kind: "provider:models",
      durationMs: Date.now() - started,
      error: detail,
    });
    throw new Error(`获取模型列表失败：请求未能发送到供应商。\n${detail}\n\n请检查 Base URL、API Key、代理、防火墙或供应商服务状态。`);
  }
  const text = await response.text();
  let raw: any = {};
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = { text };
  }
  addLog({
    providerId: providerItem.id,
    providerName: providerItem.name,
    url: endpoint,
    ok: response.ok,
    status: response.status,
    kind: "provider:models",
    durationMs: Date.now() - started,
    responsePreview: textPreview(text),
    error: response.ok ? undefined : textPreview(text),
  });
  if (!response.ok) {
    if (response.status === 404 && providerItem.models.length > 0) {
      return {
        endpoint,
        models: providerItem.models,
        preview: `The provider did not expose a model-list endpoint at ${endpoint}; using the configured local model templates.`,
      };
    }
    throw new Error(`${response.status}: ${text.slice(0, 500) || response.statusText}`);
  }
  return { endpoint, models: normalizeFetchedModels(providerItem, raw), preview: textPreview(text) };
}

async function fetchProviderBalance(providerItem: Provider) {
  const option = providerItem.balanceOption ?? { enabled: false, apiPath: "", resultPath: "" };
  if (!option.enabled) throw new Error("余额查询未启用");
  if (providerItem.type !== "openai") throw new Error("原版仅对 OpenAI-compatible 供应商执行余额查询");
  const apiPath = String(option.apiPath ?? "").trim();
  if (!apiPath) throw new Error("余额 API Path 为空");
  const endpoint = /^https?:\/\//i.test(apiPath) ? apiPath : `${providerItem.baseUrl.replace(/\/+$/, "")}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`;
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(endpoint, { headers: providerHeaders(providerItem) });
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    addLog({
      providerId: providerItem.id,
      providerName: providerItem.name,
      url: endpoint,
      ok: false,
      status: 0,
      kind: "provider:balance",
      durationMs: Date.now() - started,
      error: detail,
    });
    throw new Error(`余额查询请求失败：${detail}`);
  }
  const text = await response.text();
  let raw: any = {};
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = { text };
  }
  addLog({
    providerId: providerItem.id,
    providerName: providerItem.name,
    url: endpoint,
    ok: response.ok,
    status: response.status,
    kind: "provider:balance",
    durationMs: Date.now() - started,
    responsePreview: textPreview(text),
    error: response.ok ? undefined : textPreview(text),
  });
  if (!response.ok) throw new Error(`余额查询失败：${response.status} ${text.slice(0, 500) || response.statusText}`);
  const value = getByPath(raw, String(option.resultPath ?? ""));
  const formatted = formatBalanceValue(value);
  if (!formatted) throw new Error(`余额结果路径没有取到值：${option.resultPath || "(root)"}`);
  return { status: "ok", endpoint, value: formatted, preview: textPreview(text) };
}

function firstProviderModel(providerItem: Provider, preferredModelId?: string, fetchedModels: Model[] = []) {
  const preferred = preferredModelId?.trim();
  if (preferred && preferred !== "auto") return preferred;
  const configured = providerItem.models.find((item) => item.modelId && item.modelId !== "auto")?.modelId;
  if (configured) return configured;
  const fetched = fetchedModels.find((item) => item.modelId && item.modelId !== "auto")?.modelId;
  if (fetched) return fetched;
  const fallback = providerItem.models.find((item) => item.modelId)?.modelId;
  if (fallback && fallback !== "auto") return fallback;
  throw new Error("No test model is available. Fetch the provider model list or select a model first.");
}

function providerTestAssistant(modelItem?: Model): Assistant {
  return {
    ...findAssistant(state.settings.assistantId),
    systemPrompt: "",
    temperature: null,
    topP: null,
    maxTokens: null,
    reasoningLevel: "off",
    customHeaders: [],
    customBodies: [],
    chatModelId: modelItem?.id ?? null,
  } as Assistant;
}

function providerTestPayload(providerItem: Provider, mode: "non_stream" | "stream" | "tools", selectedModel: string) {
  if (providerItem.type === "google") {
    const body: any = {
      contents: [{ role: "user", parts: [{ text: mode === "tools" ? "Use the get_current_time tool." : "hello" }] }],
      systemInstruction: { parts: [{ text: "You are a helpful assistant" }] },
    };
    if (mode === "tools") {
      body.tools = [{ functionDeclarations: [{ name: "get_current_time", description: "Get the current date and time.", parameters: { type: "object", properties: {} } }] }];
    }
    const suffix = mode === "stream" ? "streamGenerateContent?alt=sse" : "generateContent";
    const connector = suffix.includes("?") ? "&" : "?";
    return { url: `${providerItem.baseUrl.replace(/\/+$/, "")}/models/${selectedModel}:${suffix}${connector}key=${encodeURIComponent(providerItem.apiKey)}`, body };
  }
  if (providerItem.type === "claude") {
    const body: any = {
      model: selectedModel,
      max_tokens: 4096,
      stream: mode === "stream",
      system: "You are a helpful assistant",
      messages: [{ role: "user", content: mode === "tools" ? "Use the get_current_time tool." : "hello" }],
    };
    if (mode === "tools") {
      body.tools = [{ name: "get_current_time", description: "Get the current date and time.", input_schema: { type: "object", properties: {} } }];
      body.tool_choice = { type: "tool", name: "get_current_time" };
    }
    return { url: endpointFor(providerItem), body };
  }
  if (providerItem.useResponseApi) {
    const body: any = {
      model: selectedModel,
      input: [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: mode === "tools" ? "Use the get_current_time tool." : "hello" },
      ],
      stream: mode === "stream",
      store: false,
    };
    if (mode === "tools") {
      body.tools = [{ type: "function", name: "get_current_time", description: "Get the current date and time.", parameters: { type: "object", properties: {} } }];
      body.tool_choice = { type: "function", name: "get_current_time" };
    }
    return { url: endpointFor(providerItem), body };
  }
  const body: any = {
    model: selectedModel,
    messages: [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: mode === "tools" ? "Use the get_current_time tool." : "hello" },
    ],
    stream: mode === "stream",
  };
  if (mode === "stream" && hostOfProvider(providerItem) !== "api.mistral.ai") body.stream_options = { include_usage: true };
  if (mode === "tools") {
    body.tools = [{ type: "function", function: { name: "get_current_time", description: "Get the current date and time.", parameters: { type: "object", properties: {} } } }];
    body.tool_choice = { type: "function", function: { name: "get_current_time" } };
  }
  return { url: endpointFor(providerItem), body };
}

function providerTestModel(providerItem: Provider, selectedModel: string, fetchedModels: Model[] = []) {
  return (
    providerItem.models.find((item) => item.modelId === selectedModel || item.id === selectedModel)
    ?? fetchedModels.find((item) => item.modelId === selectedModel || item.id === selectedModel)
    ?? model(selectedModel, selectedModel)
  );
}

async function readProviderTestStream(response: Response, providerItem: Provider) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let buffer = "";
  let preview = "";
  let sawEvent = false;
  const appendPreview = (text: string) => {
    if (!text) return;
    preview += text;
    if (preview.length > 6000) preview = `${preview.slice(0, 6000)}...`;
  };
  const readWithIdleTimeout = async () => {
    const timeoutMs = 600_000;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("流式测试超时：10 分钟内没有收到供应商的 SSE 数据")), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  const consumePayload = (payload: string) => {
    if (!payload || payload === "[DONE]") return;
    sawEvent = true;
    try {
      const raw = JSON.parse(payload);
      if (providerItem.type === "google") {
        appendPreview(String(raw.candidates?.[0]?.content?.parts?.[0]?.text ?? ""));
        appendUsageFromRaw(undefined, raw);
        return;
      }
      if (providerItem.type === "claude") {
        appendPreview(String(raw.delta?.text ?? raw.content_block?.text ?? raw.message?.content?.[0]?.text ?? ""));
        return;
      }
      const delta = raw.choices?.[0]?.delta ?? raw.choices?.[0]?.message ?? responseEventToDelta(raw) ?? {};
      const text = deltaTextContent(delta);
      const reasoning = deltaReasoningContent(delta);
      if (text) appendPreview(text);
      else if (reasoning) appendPreview(`[reasoning] ${reasoning}`);
      else if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        const names = delta.tool_calls
          .map((call: any) => String(call?.function?.name ?? "").trim())
          .filter(Boolean)
          .join(", ");
        appendPreview(names ? `[tool_calls] ${names}` : "[tool_calls]");
      } else if (raw.usage) {
        appendPreview("[usage]");
      }
      appendUsageFromRaw(undefined, raw);
    } catch {
      appendPreview(payload);
    }
  };
  try {
    for (;;) {
      const { done, value } = await readWithIdleTimeout();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\n\n+/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        for (const payload of parseSseChunks(part)) consumePayload(payload);
      }
      if (sawEvent) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed by the provider.
    }
  }
  for (const payload of parseSseChunks(buffer)) consumePayload(payload);
  return preview.trim() || (sawEvent ? "已收到流式事件" : "已建立流式连接，供应商未返回可解析内容");
}

async function runProviderCheck(providerItem: Provider, mode: "non_stream" | "stream" | "tools", selectedModel: string, fetchedModels: Model[] = []) {
  const modelItem = providerTestModel(providerItem, selectedModel, fetchedModels);
  const assistant = providerTestAssistant(modelItem);
  const { url, body: rawBody } = providerTestPayload(providerItem, mode, selectedModel);
  const body = applyCustomBody(rawBody, assistant, modelItem);
  const started = Date.now();
  let response: Response;
  const headers = applyRequestHeaders(
    {
      "Content-Type": "application/json",
      ...(mode === "stream" ? { Accept: "text/event-stream" } : {}),
      ...providerHeaders(providerItem),
    },
    assistant,
    providerItem,
    modelItem,
  );
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    addLog({
      providerId: providerItem.id,
      providerName: providerItem.name,
      url,
      ok: false,
      status: 0,
      kind: `provider:test:${mode}`,
      durationMs: Date.now() - started,
      requestPreview: jsonPreview(body),
      responsePreview: "",
      error: detail,
    });
    return {
      mode,
      ok: false,
      status: 0,
      endpoint: url,
      preview: `请求未能发送到供应商。\n${detail}\n\n请检查 Base URL、API 路径、代理、防火墙、证书或供应商服务状态。`,
    };
  }
  let text = "";
  try {
    text = mode === "stream" && response.ok ? await readProviderTestStream(response, providerItem) : await response.text();
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    addLog({
      providerId: providerItem.id,
      providerName: providerItem.name,
      url,
      ok: false,
      status: response.status,
      kind: `provider:test:${mode}`,
      durationMs: Date.now() - started,
      requestPreview: jsonPreview(body),
      responsePreview: textPreview(text),
      error: detail,
    });
    return {
      mode,
      ok: false,
      status: response.status,
      endpoint: url,
      preview: `供应商已建立连接，但流式读取失败。\n${detail}`,
    };
  }
  addLog({
    providerId: providerItem.id,
    providerName: providerItem.name,
    url,
    ok: response.ok,
    status: response.status,
    kind: `provider:test:${mode}`,
    durationMs: Date.now() - started,
    requestPreview: jsonPreview(body),
    responsePreview: textPreview(text),
    error: response.ok ? undefined : textPreview(text),
  });
  return {
    mode,
    ok: response.ok,
    status: response.status,
    endpoint: url,
    preview: textPreview(text || (mode === "stream" && response.ok ? "流式测试已收到事件" : "")),
  };
}

function providerTestCorePassed(checks: Array<{ mode: string; ok: boolean }>) {
  const nonStream = checks.find((item) => item.mode === "non_stream");
  const stream = checks.find((item) => item.mode === "stream");
  return nonStream?.ok === true || stream?.ok === true;
}

function markProviderTestResult(providerItem: Provider, models: Model[], checks: Array<{ mode: string; ok: boolean }>) {
  if (!providerTestCorePassed(checks)) return;
  updateSettings({
    ...state.settings,
    providers: state.settings.providers.map((item) =>
      item.id === providerItem.id
        ? { ...item, testPassed: true, testPassedAt: Date.now() }
        : item,
    ),
  });
}

async function testSearchService(service: SearchService) {
  const type = String(service.type ?? "");
  const name = String(service.name ?? (type || "Search"));
  const apiKey = String(service.apiKey ?? "");
  if (type === "bing_local" || type === "rikkahub") {
    if (type === "bing_local") {
      return { status: "ok", name, endpoint: type, preview: "Built-in Bing local search is available without API key." };
    }
  }
  if (type !== "searxng" && type !== "rikkahub" && !apiKey) throw new Error(`${name} API Key is empty`);
  if (type === "rikkahub") {
    const endpoint = "https://api.rikka-ai.com/v1/search";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ q: "RikkaHub", depth: service.depth ?? "standard", outputType: "sourcedAnswer", includeImages: false }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 500)}`);
    return { status: "ok", name, endpoint, preview: textPreview(text) };
  }
  if (type === "tavily") {
    const endpoint = "https://api.tavily.com/search";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: "RikkaHub", max_results: 1 }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 500)}`);
    return { status: "ok", name, endpoint, preview: textPreview(text) };
  }
  if (type === "exa") {
    const endpoint = "https://api.exa.ai/search";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ query: "RikkaHub", numResults: 1 }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 500)}`);
    return { status: "ok", name, endpoint, preview: textPreview(text) };
  }
  if (type === "tinyfish") {
    const endpoint = "https://api.search.tinyfish.ai?query=RikkaHub";
    const response = await fetch(endpoint, {
      headers: { "X-API-Key": apiKey },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Tinyfish search failed with code ${response.status}: ${text.slice(0, 500)}`);
    return { status: "ok", name, endpoint, preview: textPreview(text) };
  }
  if (type === "zhipu") {
    const endpoint = "https://open.bigmodel.cn/api/paas/v4/web_search";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ search_query: "RikkaHub", search_engine: "search_std", count: 1 }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 500)}`);
    return { status: "ok", name, endpoint, preview: textPreview(text) };
  }
  if (type === "brave") {
    const endpoint = "https://api.search.brave.com/res/v1/web/search?q=RikkaHub&count=1";
    const response = await fetch(endpoint, { headers: { Accept: "application/json", "X-Subscription-Token": apiKey } });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 500)}`);
    return { status: "ok", name, endpoint, preview: textPreview(text) };
  }
  if (type === "searxng") {
    const baseUrl = String(service.url ?? "").trim().replace(/\/+$/, "");
    if (!baseUrl) throw new Error("SearXNG URL is empty");
    const endpoint = `${baseUrl}/search?q=RikkaHub&format=json`;
    const headers: Record<string, string> = {};
    const username = String(service.username ?? "");
    const password = String(service.password ?? "");
    if (username && password) headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    const response = await fetch(endpoint, { headers });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 500)}`);
    return { status: "ok", name, endpoint, preview: textPreview(text) };
  }
  if (type === "custom_js") {
    const searchScript = String(service.searchScript ?? "").trim();
    if (!searchScript) throw new Error("Custom JS search script is empty");
    const result = await runCustomJsSearch(service, "RikkaHub", 1);
    return { status: "ok", name, endpoint: "custom_js", preview: jsonPreview(result) };
  }
  if (type === "firecrawl") {
    const endpoint = "https://api.firecrawl.dev/v2/search";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: "RikkaHub", limit: 1 }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 500)}`);
    return { status: "ok", name, endpoint, preview: textPreview(text) };
  }
  if (type === "grok") {
    const endpoint = String(service.customUrl ?? "").trim() || "https://api.x.ai/v1/responses";
    const model = String(service.model ?? "").trim() || "grok-4-fast";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        input: [
          { role: "system", content: "You are a helpful search assistant." },
          { role: "user", content: "RikkaHub" },
        ],
        tools: [{ type: "web_search" }, { type: "x_search" }],
        store: false,
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 500)}`);
    return { status: "ok", name, endpoint, preview: textPreview(text) };
  }
  throw new Error(`${name} search type '${type}' is not supported`);
}

function fallbackSvg(name: string) {
  const first = (name.trim()[0] ?? "A")
    .toUpperCase()
    .replace("&", "&amp;")
    .replace("<", "&lt;")
    .replace(">", "&gt;")
    .replace("\"", "&quot;")
    .replace("'", "&apos;");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#E9EAEE"/><text x="32" y="38" font-family="system-ui, sans-serif" font-size="24" font-weight="600" text-anchor="middle" fill="#4E5969">${first}</text></svg>`;
}

const iconRules: Array<[RegExp, string]> = [
  [/rikka|auto/i, "rikkahub.svg"],
  [/(gpt|openai|o\d)/i, "openai.svg"],
  [/(gemini|nano-banana)/i, "gemini-color.svg"],
  [/google/i, "google-color.svg"],
  [/claude/i, "claude-color.svg"],
  [/anthropic/i, "anthropic.svg"],
  [/deepseek/i, "deepseek-color.svg"],
  [/grok/i, "grok.svg"],
  [/qwen|qwq|qvq/i, "qwen-color.svg"],
  [/doubao/i, "doubao-color.svg"],
  [/openrouter/i, "openrouter.svg"],
  [/zhipu|智谱|glm/i, "zhipu-color.svg"],
  [/mistral/i, "mistral-color.svg"],
  [/meta\b|(?<!o)llama/i, "meta-color.svg"],
  [/hunyuan|tencent/i, "hunyuan-color.svg"],
  [/gemma/i, "gemma-color.svg"],
  [/perplexity/i, "perplexity-color.svg"],
  [/aliyun|阿里云|百炼/i, "alibabacloud-color.svg"],
  [/bytedance|火山/i, "bytedance-color.svg"],
  [/silicon|硅基/i, "siliconflow.svg"],
  [/aihubmix/i, "aihubmix-color.svg"],
  [/ollama/i, "ollama.svg"],
  [/github/i, "github.svg"],
  [/cloudflare/i, "cloudflare-color.svg"],
  [/minimax/i, "minimax-color.svg"],
  [/xai/i, "xai.svg"],
  [/juhenext/i, "juhenext.png"],
  [/kimi/i, "kimi-color.svg"],
  [/moonshot|月之暗面/i, "moonshot.svg"],
  [/302/i, "302ai.svg"],
  [/step|阶跃/i, "stepfun-color.svg"],
  [/intern|书生/i, "internlm-color.svg"],
  [/cohere|command-.+/i, "cohere-color.svg"],
  [/tavern/i, "tavern.png"],
  [/cerebras/i, "cerebras-color.svg"],
  [/nvidia/i, "nvidia-color.svg"],
  [/ppio|派欧/i, "ppio-color.svg"],
  [/vercel/i, "vercel.svg"],
  [/groq/i, "groq.svg"],
  [/tokenpony|小马算力/i, "tokenpony.svg"],
  [/ling|ring|百灵/i, "ling.png"],
  [/mimo|xiaomi|小米/i, "xiaomimimo.svg"],
  [/longcat/i, "longcat-color.svg"],
  [/linkup/i, "linkup.png"],
  [/bing/i, "bing.png"],
  [/tavily/i, "tavily.png"],
  [/exa/i, "exa.png"],
  [/brave/i, "brave.svg"],
  [/metaso|秘塔/i, "metaso.svg"],
  [/firecrawl/i, "firecrawl.svg"],
  [/jina/i, "jina.svg"],
  [/tinyfish/i, "tinyfish.svg"],
  [/searxng/i, "searxng.svg"],
];

function iconForName(name: string) {
  return iconRules.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

async function serveAIIcon(name: string) {
  const iconName = iconForName(name);
  if (iconName) {
    const candidates = [
      resolve(executableDir, "icons", iconName),
      resolve(rootDir, "icons", iconName),
    ];
    const target = candidates.find((candidate) => existsSync(candidate));
    if (target) {
      return new Response(Bun.file(target), {
        headers: { "Content-Type": mime(target), "Cache-Control": "public, max-age=86400" },
      });
    }
  }
  return new Response(fallbackSvg(name), {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" },
  });
}

async function callProvider(
  conversation: Conversation,
  signal?: AbortSignal,
  hooks?: StreamHooks,
) {
  const assistant = findAssistant(conversation.assistantId);
  const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
  const providerItem = picked.provider;
  const selectedModel = picked.model.modelId === "auto" ? "gpt-4o-mini" : picked.model.modelId;
  const url = endpointFor(providerItem);
  const headers = applyRequestHeaders({ "Content-Type": "application/json" }, assistant, providerItem, picked.model);
  const messagesForApi = conversationMessagesForApi(conversation, assistant);
  let body: Record<string, any>;

  if (providerItem.type === "google") {
    const googleTools = hasBuiltInTool(picked.model, "search")
      ? [{ googleSearch: {} }]
      : undefined;
    const googleUrl = `${providerItem.baseUrl.replace(/\/+$/, "")}/models/${selectedModel}:generateContent?key=${encodeURIComponent(providerItem.apiKey)}`;
    const systemContent = messagesForApi.find((item) => item.role === "system")?.content;
    body = {
      contents: messagesForApi
        .filter((item) => item.role !== "system")
        .map((item) => ({ role: item.role === "assistant" ? "model" : "user", parts: [{ text: item.content }] })),
      systemInstruction: systemContent
        ? { parts: [{ text: systemContent }] }
        : undefined,
      tools: googleTools,
    };
    return fetchText(googleUrl, headers, applyCustomBody(body, assistant, picked.model), providerItem, (raw) => raw.candidates?.[0]?.content?.parts?.[0]?.text, signal);
  }

  if (providerItem.type === "claude") {
    headers["x-api-key"] = providerItem.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    const messages = messagesForApi;
    const systemContent = messages.find((item) => item.role === "system")?.content;
    const functionTools = supportsAbility(picked.model, "TOOL")
      ? [...openAiSearchTools(), ...openAiLocalTools(assistant), ...openAiSkillTools(assistant), ...openAiMcpTools(assistant)]
      : [];
    const claudeTools = claudeToolsFromOpenAiTools(functionTools, providerItem);
    const normalizedReasoning = reasoningLevelNormalized(assistant.reasoningLevel);
    const reasoningActive = supportsAbility(picked.model, "REASONING") && normalizedReasoning !== "off";
    // Always stream when invoked from a conversation (hooks present). The streaming path handles
    // text + thinking + tool_use deltas live, matching Android (ClaudeProvider.streamText). The
    // non-streaming fallback only runs for auxiliary calls without hooks (title/translate, etc.).
    const canStream = hooks?.message != null;
    body = {
      model: selectedModel,
      max_tokens: assistant.maxTokens ?? 4096,
      stream: canStream,
      system: claudeSystemContent(systemContent, providerItem),
      messages: claudeMessagesFromApiMessages(messages, providerItem),
      ...(assistant.temperature != null && !reasoningActive ? { temperature: assistant.temperature } : {}),
      ...(assistant.topP != null ? { top_p: assistant.topP } : {}),
      ...(supportsAbility(picked.model, "REASONING")
        ? {
            thinking: reasoningActive
              ? { type: "adaptive", display: "summarized" }
              : { type: "disabled" },
            ...(reasoningActive && ["low", "medium", "high"].includes(normalizedReasoning)
              ? { output_config: { effort: normalizedReasoning } }
              : {}),
          }
        : {}),
      ...(claudeTools.length ? { tools: claudeTools } : {}),
    };
    if (canStream) {
      return streamClaudeChatWithTools(url, headers, applyCustomBody(body, assistant, picked.model), providerItem, assistant, signal, hooks!);
    }
    return fetchClaudeTextWithTools(url, headers, applyCustomBody(body, assistant, picked.model), providerItem, assistant, signal, hooks);
  }

  headers.Authorization = `Bearer ${providerItem.apiKey}`;
  if (providerItem.useResponseApi) {
    const functionTools = supportsAbility(picked.model, "TOOL") ? [...openAiSearchTools(), ...openAiLocalTools(assistant), ...openAiSkillTools(assistant), ...openAiMcpTools(assistant)] : [];
    const builtInTools = responseApiBuiltInTools(picked.model);
    const systemContent = conversationResponseApiInstructions(conversation, assistant);
    const reasoning = responseApiReasoningForProvider(providerItem, picked.model, assistant.reasoningLevel);
    const include = responseApiIncludeForProvider(providerItem, picked.model);
    body = {
      model: selectedModel,
      stream: false,
      store: !hasBuiltInTool(picked.model, "image_generation"),
      ...(systemContent ? { instructions: systemContent } : {}),
      input: conversationResponseApiInput(conversation, assistant),
      ...(isModelAllowTemperature(picked.model) ? { temperature: assistant.temperature ?? undefined } : {}),
      ...(assistant.maxTokens != null ? { max_output_tokens: assistant.maxTokens } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(include ? { include } : {}),
      tools: [
        ...functionTools.map((tool: any) => ({
          type: "function",
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })),
        ...builtInTools,
      ].filter(Boolean),
    };
    if (!body.tools.length) delete body.tools;
    return fetchText(url, headers, applyCustomBody(body, assistant, picked.model), providerItem, (raw) => raw.output_text ?? raw.output?.flatMap((item: any) => item.content ?? []).map((item: any) => item.text ?? "").join("\n"), signal);
  }
  const tools = supportsAbility(picked.model, "TOOL") ? [...openAiSearchTools(), ...openAiLocalTools(assistant), ...openAiSkillTools(assistant), ...openAiMcpTools(assistant)] : [];
  body = {
    model: selectedModel,
    messages: messagesForApi,
    temperature: isModelAllowTemperature(picked.model) ? assistant.temperature ?? undefined : undefined,
    top_p: isModelAllowTemperature(picked.model) ? assistant.topP ?? undefined : undefined,
    max_tokens: assistant.maxTokens ?? undefined,
    ...(providerItem.type === "openai" ? { modalities: openAiChatCompletionsModalities(picked.model, providerItem) } : {}),
    ...reasoningPayloadForProvider(providerItem, picked.model, assistant.reasoningLevel),
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? "auto" : undefined,
  };
  return fetchOpenAiText(url, headers, applyCustomBody(body, assistant, picked.model), providerItem, assistant, signal, hooks);
}

type StreamHooks = {
  message?: Message;
  conversation?: Conversation;
  node?: MessageNode;
};

function touchStream(hooks?: StreamHooks) {
  if (!hooks?.conversation || !hooks.node) return;
  hooks.conversation.updateAt = Date.now();
  scheduleThrottledSaveState();
  scheduleNodeBroadcast(hooks.conversation, hooks.node);
}

function addStreamText(hooks: StreamHooks | undefined, text: string) {
  if (!hooks?.message || !text) return;
  const hadOpenReasoning = hasOpenReasoningPart(hooks.message);
  hooks.message.parts = hooks.message.parts.filter((part) => !(
    part &&
    typeof part === "object" &&
    !Array.isArray(part) &&
    (part.type === "loading" || (part.type === "reasoning" && part.reasoning === "正在生成回复"))
  ));
  if (hadOpenReasoning) {
    finishReasoningParts(hooks.message);
  }
  appendTextPart(hooks.message, text);
  touchStream(hooks);
}

function appendUsageFromRaw(msg: Message | undefined, raw: any) {
  if (!msg) return;
  const usage = raw?.usage;
  if (!usage || typeof usage !== "object") return;
  msg.usage = {
    promptTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? 0),
    completionTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ?? 0),
    totalTokens: Number(usage.total_tokens ?? usage.totalTokens ?? 0),
    cachedTokens: Number(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.cachedTokens ?? 0),
  };
}

async function callProviderStreaming(conversation: Conversation, assistantMessage: Message, assistantNode: MessageNode, signal?: AbortSignal) {
  const assistant = findAssistant(conversation.assistantId);
  const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
  const providerItem = picked.provider;
  const selectedModel = picked.model.modelId === "auto" ? "gpt-4o-mini" : picked.model.modelId;
  const url = endpointFor(providerItem);
  const headers = applyRequestHeaders(
    { "Content-Type": "application/json", Authorization: `Bearer ${providerItem.apiKey}` },
    assistant,
    providerItem,
    picked.model,
  );
  const messagesForApi = conversationMessagesForApi(conversation, assistant);
  const tools = supportsAbility(picked.model, "TOOL") ? [...openAiSearchTools(), ...openAiLocalTools(assistant), ...openAiSkillTools(assistant), ...openAiMcpTools(assistant)] : [];
  if (providerItem.type !== "openai") {
    return callProvider(conversation, signal, {
      message: assistantMessage,
      conversation,
      node: assistantNode,
    });
  }
  if (providerItem.useResponseApi) {
    const responseTools = [
      ...tools.map((tool: any) => ({
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      })),
      ...responseApiBuiltInTools(picked.model),
    ];
    const systemContent = conversationResponseApiInstructions(conversation, assistant);
    const reasoning = responseApiReasoningForProvider(providerItem, picked.model, assistant.reasoningLevel);
    const include = responseApiIncludeForProvider(providerItem, picked.model);
    const body = applyCustomBody({
      model: selectedModel,
      stream: true,
      store: !hasBuiltInTool(picked.model, "image_generation"),
      ...(systemContent ? { instructions: systemContent } : {}),
      input: conversationResponseApiInput(conversation, assistant),
      ...(isModelAllowTemperature(picked.model) ? { temperature: assistant.temperature ?? undefined } : {}),
      ...(assistant.maxTokens != null ? { max_output_tokens: assistant.maxTokens } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(include ? { include } : {}),
      tools: responseTools.length ? responseTools : undefined,
    }, assistant, picked.model);
    return fetchOpenAiTextStreaming(url, headers, body, providerItem, assistant, {
      message: assistantMessage,
      conversation,
      node: assistantNode,
    }, signal);
  }
  const body = applyCustomBody({
    model: selectedModel,
    messages: messagesForApi,
    temperature: isModelAllowTemperature(picked.model) ? assistant.temperature ?? undefined : undefined,
    top_p: isModelAllowTemperature(picked.model) ? assistant.topP ?? undefined : undefined,
    max_tokens: assistant.maxTokens ?? undefined,
    ...(providerItem.type === "openai" ? { modalities: openAiChatCompletionsModalities(picked.model, providerItem) } : {}),
    ...reasoningPayloadForProvider(providerItem, picked.model, assistant.reasoningLevel),
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? "auto" : undefined,
    stream: true,
    stream_options: hostOfProvider(providerItem) === "api.mistral.ai" ? undefined : { include_usage: true },
  }, assistant, picked.model);
  return fetchOpenAiTextStreaming(url, headers, body, providerItem, assistant, {
    message: assistantMessage,
    conversation,
    node: assistantNode,
  }, signal);
}

async function fetchText(
  url: string,
  headers: Record<string, string>,
  body: JsonValue | object,
  providerItem: Provider,
  pick: (raw: any) => string | undefined,
  signal?: AbortSignal,
) {
  const started = Date.now();
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  const rawText = await response.text();
  let raw: any = {};
  try {
    raw = rawText ? JSON.parse(rawText) : {};
  } catch {
    raw = { text: rawText };
  }
  addLog({
    providerId: providerItem.id,
    providerName: providerItem.name,
    url,
    ok: response.ok,
    status: response.status,
    kind: "provider:chat",
    durationMs: Date.now() - started,
    requestPreview: jsonPreview(body),
    responsePreview: textPreview(rawText),
    error: response.ok ? undefined : textPreview(rawText),
  });
  if (!response.ok) throw new Error(`${providerItem.name} ${response.status}: ${rawText.slice(0, 500)}`);
  return pick(raw)?.trim() || "(empty response)";
}

function claudeTextFromContent(content: any[]) {
  return content
    .map((item) => {
      if (!isRecord(item)) return "";
      if (typeof item.text === "string") return item.text;
      if (typeof item.thinking === "string") return "";
      return "";
    })
    .join("")
    .trim();
}

async function streamClaudeChat(
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  providerItem: Provider,
  signal: AbortSignal | undefined,
  hooks: StreamHooks,
) {
  const started = Date.now();
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!response.ok) {
    const text = await response.text();
    addLog({
      providerId: providerItem.id,
      providerName: providerItem.name,
      url,
      ok: false,
      status: response.status,
      kind: "provider:chat:stream",
      durationMs: Date.now() - started,
      requestPreview: jsonPreview(body),
      responsePreview: textPreview(text),
      error: textPreview(text),
    });
    throw new Error(`${providerItem.name} ${response.status}: ${text.slice(0, 500)}`);
  }
  let usage: Message["usage"] | undefined;
  const full = await readClaudeStream(response, (text, raw) => {
    if (text) addStreamText(hooks, text);
    if (raw && isRecord(raw) && (raw.usage || raw.message?.usage)) {
      const u: any = raw.usage ?? raw.message?.usage;
      if (u) {
        const promptTokens = Number(u.input_tokens ?? 0);
        const completionTokens = Number(u.output_tokens ?? 0);
        usage = {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          cachedTokens: Number(u.cache_read_input_tokens ?? 0),
        };
      }
    }
  }, signal);
  if (hooks.message && usage) hooks.message.usage = usage;
  addLog({
    providerId: providerItem.id,
    providerName: providerItem.name,
    url,
    ok: true,
    status: response.status,
    kind: "provider:chat:stream",
    durationMs: Date.now() - started,
    requestPreview: jsonPreview(body),
    responsePreview: textPreview(full),
  });
  return full || "(empty response)";
}

// Per-round Claude SSE reader. Returns the assistant content blocks captured during the stream
// plus stop_reason + usage. Text/thinking/input_json deltas are emitted to the live UI as they
// arrive. This is the building block of streamClaudeChatWithTools — we drive a tool loop on top
// where the outer code dispatches tools and re-streams.
type ClaudeStreamRoundResult = {
  blocks: Array<Record<string, any>>;
  textOut: string;
  thinkingOut: string;
  stopReason: string | null;
  usage: Message["usage"] | undefined;
  raw: string;
};

async function readClaudeStreamingRound(
  response: Response,
  hooks: StreamHooks,
  signal?: AbortSignal,
): Promise<ClaudeStreamRoundResult> {
  const reader = response.body?.getReader();
  if (!reader) {
    return { blocks: [], textOut: "", thinkingOut: "", stopReason: null, usage: undefined, raw: "" };
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let raw = "";
  // Index-keyed accumulators for the active content blocks. Claude emits content_block_start
  // with an index, then deltas with the same index, then content_block_stop. We mirror that
  // structure here so concurrent text + thinking + tool_use blocks all reconstruct correctly.
  const blocks = new Map<number, Record<string, any>>();
  let textOut = "";
  let thinkingOut = "";
  let stopReason: string | null = null;
  let usage: Message["usage"] | undefined;
  const setUsage = (u: any) => {
    if (!u || typeof u !== "object") return;
    const promptTokens = Number(u.input_tokens ?? 0);
    const completionTokens = Number(u.output_tokens ?? 0);
    usage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cachedTokens: Number(u.cache_read_input_tokens ?? 0),
    };
  };
  const handleEvent = (eventName: string, dataJson: any) => {
    if (!dataJson || typeof dataJson !== "object") return;
    if (eventName === "message_start") {
      const u = dataJson.message?.usage;
      if (u) setUsage(u);
      return;
    }
    if (eventName === "message_delta") {
      if (dataJson.delta?.stop_reason) stopReason = String(dataJson.delta.stop_reason);
      if (dataJson.usage) setUsage(dataJson.usage);
      return;
    }
    if (eventName === "message_stop") return;
    if (eventName === "error") {
      const errMessage = dataJson.error?.message ?? "Claude stream error";
      throw new Error(String(errMessage));
    }
    const index = typeof dataJson.index === "number" ? dataJson.index : -1;
    if (eventName === "content_block_start") {
      const block = dataJson.content_block ?? {};
      blocks.set(index, { ...block, _inputBuffer: "" });
      const type = String(block.type ?? "");
      if (type === "tool_use") {
        // Insert/refresh a Tool part immediately so the user sees the tool card appear right
        // when Claude announces the call, even before the input_json_delta arrives.
        if (hooks.message) {
          finishReasoningParts(hooks.message);
          const toolPart: JsonValue = {
            type: "tool",
            toolCallId: String(block.id ?? ""),
            toolName: String(block.name ?? ""),
            input: "",
            output: [],
            approvalState: String(block.name ?? "") === "ask_user" ? { type: "pending" } : { type: "auto" },
          };
          replaceLoadingReasoningWithTool(hooks.message, toolPart);
          touchStream(hooks);
        }
      } else if (type === "text" && block.text) {
        textOut += block.text;
        addStreamText(hooks, String(block.text));
      } else if (type === "thinking" && block.thinking) {
        thinkingOut += block.thinking;
        appendReasoningDelta(hooks, String(block.thinking));
      }
      return;
    }
    if (eventName === "content_block_delta") {
      const delta = dataJson.delta ?? {};
      const dtype = String(delta.type ?? "");
      const block = blocks.get(index) ?? {};
      if (dtype === "text_delta" && typeof delta.text === "string") {
        textOut += delta.text;
        addStreamText(hooks, delta.text);
      } else if (dtype === "thinking_delta" && typeof delta.thinking === "string") {
        thinkingOut += delta.thinking;
        appendReasoningDelta(hooks, delta.thinking);
      } else if (dtype === "signature_delta" && typeof delta.signature === "string") {
        block.signature = String(block.signature ?? "") + delta.signature;
        blocks.set(index, block);
      } else if (dtype === "input_json_delta" && typeof delta.partial_json === "string") {
        block._inputBuffer = String(block._inputBuffer ?? "") + delta.partial_json;
        blocks.set(index, block);
        // Stream the partial input into the tool part so users see argument JSON taking shape.
        if (hooks.message && block.type === "tool_use") {
          const targetId = String(block.id ?? "");
          if (targetId) {
            hooks.message.parts = hooks.message.parts.map((part) => {
              if (!isRecord(part) || part.type !== "tool" || part.toolCallId !== targetId) return part;
              return { ...part, input: block._inputBuffer };
            });
            touchStream(hooks);
          }
        }
      }
      return;
    }
    if (eventName === "content_block_stop") {
      const block = blocks.get(index);
      if (!block) return;
      if (block.type === "tool_use" && block._inputBuffer) {
        // Finalize tool input as parsed object.
        try {
          block.input = JSON.parse(block._inputBuffer);
        } catch {
          block.input = block._inputBuffer;
        }
      }
      delete block._inputBuffer;
      blocks.set(index, block);
      return;
    }
  };
  let currentEvent = "message";
  for (;;) {
    if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    raw += chunk;
    buffer += chunk;
    // SSE frames are separated by a blank line. Inside a frame, lines starting with `event:`
    // set the event type and `data:` lines contribute payload (concatenated). Anthropic
    // always uses single-line data, but we handle the general case.
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      let eventName = "message";
      const dataLines: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim() || "message";
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      currentEvent = eventName;
      const data = dataLines.join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        handleEvent(eventName, JSON.parse(data));
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Claude stream error")) throw err;
        // Ignore malformed fragments — Anthropic occasionally pings.
      }
    }
  }
  // Drain the trailing partial frame if any.
  if (buffer.trim()) {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of buffer.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim() || "message";
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    currentEvent = eventName;
    const data = dataLines.join("\n");
    if (data && data !== "[DONE]") {
      try {
        handleEvent(eventName, JSON.parse(data));
      } catch {
        // ignore
      }
    }
  }
  const orderedBlocks = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, block]) => block);
  void currentEvent;
  return { blocks: orderedBlocks, textOut, thinkingOut, stopReason, usage, raw };
}

async function streamClaudeChatWithTools(
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  providerItem: Provider,
  assistant: Assistant,
  signal: AbortSignal | undefined,
  hooks: StreamHooks,
) {
  let messages = Array.isArray(body.messages) ? [...body.messages] : [];
  let currentBody = { ...body, messages, stream: true };
  let allContent = "";
  for (let round = 0; round < MAX_TOOL_STEPS; round += 1) {
    if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
    const roundStarted = Date.now();
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, Accept: "text/event-stream" },
      body: JSON.stringify(currentBody),
      signal,
    });
    if (!response.ok) {
      const text = await response.text();
      addLog({
        providerId: providerItem.id,
        providerName: providerItem.name,
        url,
        ok: false,
        status: response.status,
        kind: round === 0 ? "provider:chat:stream" : "provider:chat:tool_result:stream",
        durationMs: Date.now() - roundStarted,
        requestPreview: jsonPreview(currentBody),
        responsePreview: textPreview(text),
        error: textPreview(text),
      });
      throw new Error(`${providerItem.name} ${response.status}: ${text.slice(0, 500)}`);
    }
    const round_ = await readClaudeStreamingRound(response, hooks, signal);
    if (hooks.message && round_.usage) hooks.message.usage = round_.usage;
    addLog({
      providerId: providerItem.id,
      providerName: providerItem.name,
      url,
      ok: true,
      status: response.status,
      kind: round === 0 ? "provider:chat:stream" : "provider:chat:tool_result:stream",
      durationMs: Date.now() - roundStarted,
      requestPreview: jsonPreview(currentBody),
      responsePreview: textPreview(round_.raw),
    });
    if (round_.textOut) {
      allContent += `${allContent ? "\n" : ""}${round_.textOut}`;
    }
    // Collect tool_use blocks and dispatch them.
    const toolUses = round_.blocks.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      finishReasoningParts(hooks.message!);
      return allContent.trim() || "(empty response)";
    }
    const toolResultBlocks: Array<Record<string, JsonValue>> = [];
    for (const toolUse of toolUses) {
      const toolCallId = String(toolUse.id ?? id());
      const toolName = String(toolUse.name ?? "");
      const toolInput = isRecord(toolUse.input)
        ? toolUse.input
        : (typeof toolUse.input === "string" && toolUse.input ? safeJsonParse(toolUse.input) : {});
      const toolCall = {
        id: toolCallId,
        type: "function" as const,
        function: {
          name: toolName,
          arguments: JSON.stringify(toolInput ?? {}),
        },
      };
      // The tool part was already created during the stream — find it and run the tool.
      let toolResult: unknown;
      try {
        toolResult = await executeToolCall(toolCall, assistant);
      } catch (err) {
        toolResult = toolExecutionErrorPayload(err);
      }
      const outputParts = await toolResultToParts(toolResult);
      if (hooks.message) {
        hooks.message.parts = hooks.message.parts.map((part) => {
          if (!isRecord(part) || part.type !== "tool" || part.toolCallId !== toolCallId) return part;
          return { ...part, input: toolCall.function.arguments, output: outputParts as unknown as JsonValue };
        });
        touchStream(hooks);
      }
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: toolCallId,
        content: claudeBlocksFromUiParts(outputParts) as unknown as JsonValue,
      });
    }
    // Anthropic requires us to echo the assistant's content blocks verbatim (including the
    // tool_use entries) before sending the tool_result user turn. Strip our internal markers
    // and pass the rest through.
    const assistantBlocksForReplay = round_.blocks
      .filter((block) => block && (block.type === "text" || block.type === "thinking" || block.type === "tool_use"))
      .map((block) => {
        if (block.type === "tool_use") {
          return { type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} };
        }
        if (block.type === "thinking") {
          return block.signature
            ? { type: "thinking", thinking: block.thinking ?? "", signature: block.signature }
            : { type: "thinking", thinking: block.thinking ?? "" };
        }
        return { type: "text", text: block.text ?? "" };
      });
    messages = [
      ...messages,
      { role: "assistant", content: assistantBlocksForReplay },
      { role: "user", content: toolResultBlocks },
    ];
    currentBody = { ...body, messages, stream: true };
  }
  throw new Error("Too many consecutive Claude tool calls without final assistant content");
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function fetchClaudeTextWithTools(
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  providerItem: Provider,
  assistant: Assistant,
  signal?: AbortSignal,
  hooks?: StreamHooks,
) {
  let messages = Array.isArray(body.messages) ? [...body.messages] : [];
  let currentBody = { ...body, messages, stream: false };
  let allContent = "";

  for (let round = 0; round < MAX_TOOL_STEPS; round += 1) {
    const started = Date.now();
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(currentBody), signal });
    const rawText = await response.text();
    let raw: any = {};
    try {
      raw = rawText ? JSON.parse(rawText) : {};
    } catch {
      raw = { text: rawText };
    }
    addLog({
      providerId: providerItem.id,
      providerName: providerItem.name,
      url,
      ok: response.ok,
      status: response.status,
      kind: round === 0 ? "provider:chat" : "provider:chat:tool_result",
      durationMs: Date.now() - started,
      requestPreview: jsonPreview(currentBody),
      responsePreview: textPreview(rawText),
      error: response.ok ? undefined : textPreview(rawText),
    });
    if (!response.ok) throw new Error(`${providerItem.name} ${response.status}: ${rawText.slice(0, 500)}`);

    const content = Array.isArray(raw.content) ? raw.content : [];
    const text = claudeTextFromContent(content);
    if (text) {
      allContent += `${allContent ? "\n" : ""}${text}`;
      addStreamText(hooks, text);
    }
    const toolUses = content.filter((item) => isRecord(item) && item.type === "tool_use");
    if (toolUses.length === 0) return allContent.trim() || "(empty response)";

    const toolResultBlocks = [];
    for (const toolUse of toolUses) {
      const toolCall = {
        id: String(toolUse.id ?? id()),
        type: "function",
        function: {
          name: String(toolUse.name ?? ""),
          arguments: JSON.stringify(isRecord(toolUse.input) ? toolUse.input : {}),
        },
      };
      const toolPart: JsonValue = {
        type: "tool",
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        input: toolCall.function.arguments,
        output: [],
        approvalState: toolCall.function.name === "ask_user" ? { type: "pending" } : { type: "auto" },
      };
      if (hooks?.message) {
        finishReasoningParts(hooks.message);
        replaceLoadingReasoningWithTool(hooks.message, toolPart);
        touchStream(hooks);
      }
      let toolResult: unknown;
      try {
        toolResult = await executeToolCall(toolCall, assistant);
      } catch (err) {
        toolResult = toolExecutionErrorPayload(err);
      }
      const outputParts = await toolResultToParts(toolResult);
      (toolPart as Record<string, JsonValue>).output = outputParts as unknown as JsonValue;
      touchStream(hooks);
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: toolCall.id,
        content: claudeBlocksFromUiParts(outputParts),
      });
    }

    messages = [
      ...messages,
      { role: "assistant", content },
      { role: "user", content: toolResultBlocks },
    ];
    currentBody = { ...body, messages, stream: false };
  }

  throw new Error("Too many consecutive Claude tool calls without final assistant content");
}

async function fetchOpenAiText(
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  providerItem: Provider,
  assistant: Assistant,
  signal?: AbortSignal,
  hooks?: StreamHooks,
) {
  let messages = Array.isArray(body.messages) ? [...body.messages] : [];
  let currentBody = { ...body, messages, stream: false };
  let allContent = "";
  for (let round = 0; round < MAX_TOOL_STEPS; round += 1) {
    const started = Date.now();
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(currentBody), signal });
    const rawText = await response.text();
    let raw: any = {};
    try {
      raw = rawText ? JSON.parse(rawText) : {};
    } catch {
      raw = { text: rawText };
    }
    addLog({
      providerId: providerItem.id,
      providerName: providerItem.name,
      url,
      ok: response.ok,
      status: response.status,
      kind: round === 0 ? "provider:chat" : "provider:chat:tool_result",
      durationMs: Date.now() - started,
      requestPreview: jsonPreview(currentBody),
      responsePreview: textPreview(rawText),
      error: response.ok ? undefined : textPreview(rawText),
    });
    if (!response.ok) throw new Error(`${providerItem.name} ${response.status}: ${rawText.slice(0, 500)}`);

    const assistantMessage = raw.choices?.[0]?.message ?? {};
    const content = completionMessageText(raw);
    if (content) {
      allContent += content;
      addStreamText(hooks, content);
    }
    const toolCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];
    if (toolCalls.length === 0) return allContent.trim() || "(empty response)";

    const toolMessages = [];
    for (const toolCall of toolCalls) {
      const toolPart: JsonValue = {
        type: "tool",
        toolCallId: String(toolCall.id ?? id()),
        toolName: String(toolCall.function?.name ?? ""),
        input: String(toolCall.function?.arguments ?? "{}"),
        output: [],
        approvalState: String(toolCall.function?.name ?? "") === "ask_user" ? { type: "pending" } : { type: "auto" },
      };
      if (hooks?.message) {
        finishReasoningParts(hooks.message);
        replaceLoadingReasoningWithTool(hooks.message, toolPart);
        touchStream(hooks);
      }
      let toolResult: unknown;
      try {
        toolResult = await executeToolCall(toolCall, assistant);
      } catch (err) {
        toolResult = toolExecutionErrorPayload(err);
      }
      const outputParts = await toolResultToParts(toolResult);
      (toolPart as Record<string, JsonValue>).output = outputParts as unknown as JsonValue;
      touchStream(hooks);
      toolMessages.push({
        role: "tool",
        tool_call_id: (toolPart as Record<string, JsonValue>).toolCallId,
        content: openAiToolOutput(outputParts),
      });
    }
    messages = [
      ...messages,
      compactAssistantToolMessage(
        content,
        toolCalls,
        String(assistantMessage.reasoning_content ?? assistantMessage.reasoning ?? ""),
      ),
      ...toolMessages,
    ];
    currentBody = { ...body, messages, stream: false };
  }
  throw new Error("Too many consecutive tool calls without final assistant content");
}

function responseMessageText(raw: any): string {
  const chunks: string[] = [];
  const walk = (value: any) => {
    if (value == null) return;
    if (typeof value === "string") {
      chunks.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value !== "object") return;
    const type = String(value.type ?? "");
    if (
      typeof value.text === "string" &&
      (!type || type === "text" || type === "output_text" || type === "message")
    ) {
      chunks.push(value.text);
    }
    if (type === "image_generation_call" && typeof value.result === "string") {
      chunks.push(`\n\n![generated image](${normalizeGeneratedImageUrl(value.result)})\n\n`);
    }
    if (typeof value.content === "string") chunks.push(value.content);
    if (value.content) walk(value.content);
    if (value.output_text) walk(value.output_text);
  };
  if (typeof raw.output_text === "string") chunks.push(raw.output_text);
  walk(raw.output);
  return chunks.join("").trim();
}

function completionMessageText(raw: any): string {
  const message = raw.choices?.[0]?.message ?? raw.choices?.[0]?.delta ?? {};
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item: any) => typeof item === "string" ? item : String(item?.text ?? item?.content ?? ""))
      .join("")
      .trim();
  }
  return responseMessageText(raw);
}

function parseSseChunks(text: string) {
  return text
    .split(/\n\n+/)
    .flatMap((block) => {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean)
        .join("\n")
        .trim();
      if (!data) return [];
      if (data === "[DONE]") return [data];
      return data
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    });
}

function responseEventToDelta(raw: any) {
  const type = String(raw.type ?? "");
  if (type === "response.output_text.delta") return { content: String(raw.delta ?? "") };
  if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
    return { reasoning_content: String(raw.delta ?? "") };
  }
  if (type === "response.output_item.added") {
    const item = raw.item ?? {};
    if (item.type === "image_generation_call") {
      return {
        image_url: "",
        metadata: { openai_image_call_id: String(item.id ?? "") },
      };
    }
    if (item.type === "reasoning") {
      return {
        reasoning_content: "",
        metadata: {
          reasoning_id: String(item.id ?? ""),
          encrypted_content: String(item.encrypted_content ?? ""),
        },
      };
    }
    if (item.type === "function_call") {
      return {
        tool_calls: [{
          index: Number(raw.output_index ?? 0),
          id: String(item.call_id ?? item.id ?? ""),
          type: "function",
          function: {
            name: String(item.name ?? ""),
            arguments: String(item.arguments ?? ""),
          },
        }],
      };
    }
  }
  if (type === "response.output_item.done") {
    const item = raw.item ?? {};
    if (item.type === "image_generation_call") {
      return {
        image_url: String(item.result ?? ""),
        metadata: { openai_image_call_id: String(item.id ?? "") },
      };
    }
    if (item.type === "reasoning") {
      const summary = Array.isArray(item.summary)
        ? item.summary.map((part: any) => String(part?.text ?? "")).join("")
        : "";
      return {
        reasoning_content: summary,
        metadata: {
          reasoning_id: String(item.id ?? ""),
          encrypted_content: String(item.encrypted_content ?? ""),
        },
        _rikkahubSnapshot: true,
      };
    }
  }
  if (type === "response.function_call_arguments.delta") {
    return {
      tool_calls: [{
        index: Number(raw.output_index ?? 0),
        id: String(raw.item_id ?? raw.call_id ?? ""),
        type: "function",
        function: { name: "", arguments: String(raw.delta ?? "") },
      }],
    };
  }
  if (type === "response.function_call_arguments.done") {
    return {
      tool_calls: [{
        index: Number(raw.output_index ?? 0),
        id: String(raw.item_id ?? raw.call_id ?? ""),
        type: "function",
        function: { name: "", arguments: String(raw.arguments ?? "") },
        _rikkahubSnapshot: true,
      }],
    };
  }
  return null;
}

function deltaTextContent(delta: any) {
  if (typeof delta.content === "string") return delta.content;
  if (typeof delta.text === "string") return delta.text;
  if (typeof delta.output_text === "string") return delta.output_text;
  if (Array.isArray(delta.content)) {
    return delta.content
      .map((item: any) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.delta === "string") return item.delta;
        return "";
      })
      .join("");
  }
  return "";
}

function deltaReasoningContent(delta: any) {
  const direct = delta.reasoning_content ?? delta.reasoning ?? delta.thinking ?? delta.reasoning_text ?? delta.reasoning_summary;
  if (typeof direct === "string") return direct;
  if (Array.isArray(delta.content)) {
    return delta.content
      .map((item: any) => {
        if (typeof item?.thinking === "string") return item.thinking;
        if (Array.isArray(item?.thinking)) return item.thinking.map((x: any) => String(x?.text ?? "")).join("");
        if (item?.type === "reasoning" && typeof item?.text === "string") return item.text;
        return "";
      })
      .join("");
  }
  return "";
}

async function readOpenAiStream(
  response: Response,
  onDelta: (delta: any, raw?: any) => { content?: string } | void,
  signal?: AbortSignal,
) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  const readWithIdleTimeout = async () => {
    const timeoutMs = 600_000;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Stream idle timeout: no data received for 10min")), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  for (;;) {
    if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
    const { done, value } = await readWithIdleTimeout();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\n\n+/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      for (const payload of parseSseChunks(part)) {
        if (payload === "[DONE]") continue;
        try {
          const raw = JSON.parse(payload);
          const delta = raw.choices?.[0]?.delta ?? raw.choices?.[0]?.message ?? responseEventToDelta(raw) ?? {};
          if (Object.keys(delta).length > 0) {
            const applied = onDelta(delta, raw);
            full += applied?.content ?? deltaTextContent(delta);
          }
        } catch {
          // Ignore malformed stream fragments.
        }
      }
    }
  }
  for (const payload of parseSseChunks(buffer)) {
    if (payload === "[DONE]") continue;
    try {
      const raw = JSON.parse(payload);
      const delta = raw.choices?.[0]?.delta ?? raw.choices?.[0]?.message ?? responseEventToDelta(raw) ?? {};
      if (Object.keys(delta).length > 0) {
        const applied = onDelta(delta, raw);
        full += applied?.content ?? deltaTextContent(delta);
      }
    } catch {
      // Ignore malformed trailing stream fragments.
    }
  }
  return full;
}

function applyOpenAiDelta(
  delta: any,
  rawEvent: any,
  hooks: StreamHooks,
  toolCalls: any[],
) {
  appendUsageFromRaw(hooks.message, rawEvent);
  let content = "";
  let reasoning = "";
  const isSnapshot = !!rawEvent?.choices?.[0]?.message;
  const deltaMetadata = isRecord(delta.metadata) ? delta.metadata as Record<string, JsonValue> : undefined;
  if (deltaMetadata && (deltaMetadata.reasoning_id || deltaMetadata.encrypted_content)) {
    ensureReasoningPart(hooks, deltaMetadata);
  }
  const reasoningDelta = deltaReasoningContent(delta);
  if (reasoningDelta) {
    const currentReasoning = (isSnapshot || delta._rikkahubSnapshot) ? visibleReasoningFromMessage(hooks.message) : "";
    const nextReasoning = (isSnapshot || delta._rikkahubSnapshot) && currentReasoning && reasoningDelta.startsWith(currentReasoning)
      ? reasoningDelta.slice(currentReasoning.length)
      : reasoningDelta;
    if (nextReasoning) {
      reasoning += nextReasoning;
      appendReasoningDelta(hooks, nextReasoning, deltaMetadata);
    }
  }
  const contentDelta = deltaTextContent(delta);
  if (contentDelta) {
    const currentText = isSnapshot ? visibleTextFromMessage(hooks.message) : "";
    const nextContent = isSnapshot && currentText && contentDelta.startsWith(currentText)
      ? contentDelta.slice(currentText.length)
      : contentDelta;
    if (nextContent) {
      content += nextContent;
      addStreamText(hooks, nextContent);
    }
  }
  if (typeof delta.image_url === "string") {
    addStreamImage(hooks, delta.image_url, isRecord(delta.metadata) ? delta.metadata as Record<string, JsonValue> : {});
  }
  if (Array.isArray(delta.tool_calls)) {
    const mode = isSnapshot || delta.tool_calls.some((call: any) => call?._rikkahubSnapshot) ? "snapshot" : "delta";
    mergeToolCallDeltas(toolCalls, delta.tool_calls, mode);
  }
  return { content, reasoning };
}

async function fetchOpenAiAuxiliaryStream(
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  providerItem: Provider,
  onDelta: (text: string) => void,
) {
  const started = Date.now();
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  let text = "";
  if (response.ok) {
    text = await readOpenAiStream(response, (delta, raw) => {
      const content = deltaTextContent(delta);
      appendUsageFromRaw(undefined, raw);
      onDelta(content);
      return { content };
    });
  } else {
    text = await response.text();
  }
  addLog({
    providerId: providerItem.id,
    providerName: providerItem.name,
    url,
    ok: response.ok,
    status: response.status,
    kind: "provider:aux:stream",
    durationMs: Date.now() - started,
    requestPreview: jsonPreview(body),
    responsePreview: textPreview(text),
    error: response.ok ? undefined : textPreview(text),
  });
  if (!response.ok) throw new Error(`${providerItem.name} ${response.status}: ${text.slice(0, 500)}`);
  return text.trim() || "(empty response)";
}

async function fetchClaudeAuxiliaryStream(
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  providerItem: Provider,
  onDelta: (text: string) => void,
) {
  const started = Date.now();
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!response.ok) {
    const text = await response.text();
    addLog({
      providerId: providerItem.id,
      providerName: providerItem.name,
      url,
      ok: false,
      status: response.status,
      kind: "provider:aux:stream",
      durationMs: Date.now() - started,
      requestPreview: jsonPreview(body),
      responsePreview: textPreview(text),
      error: textPreview(text),
    });
    throw new Error(`${providerItem.name} ${response.status}: ${text.slice(0, 500)}`);
  }
  const text = await readClaudeStream(response, (content) => {
    onDelta(content);
  });
  addLog({
    providerId: providerItem.id,
    providerName: providerItem.name,
    url,
    ok: true,
    status: response.status,
    kind: "provider:aux:stream",
    durationMs: Date.now() - started,
    requestPreview: jsonPreview(body),
    responsePreview: textPreview(text),
  });
  return text.trim() || "(empty response)";
}

function claudeEventText(raw: any) {
  const type = String(raw?.type ?? "");
  const delta = raw?.delta ?? {};
  if (type === "content_block_delta") {
    if (delta.type === "text_delta") return String(delta.text ?? "");
    if (delta.type === "thinking_delta") return "";
  }
  if (type === "content_block_start") {
    const block = raw?.content_block ?? {};
    return block.type === "text" ? String(block.text ?? "") : "";
  }
  if (typeof delta.text === "string") return delta.text;
  return "";
}

async function readClaudeStream(response: Response, onDelta: (text: string, raw?: any) => void, signal?: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  for (;;) {
    if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\n\n+/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      for (const payload of parseSseChunks(part)) {
        try {
          const raw = JSON.parse(payload);
          const text = claudeEventText(raw);
          if (!text) continue;
          full += text;
          onDelta(text, raw);
        } catch {
          // Ignore malformed Anthropic stream fragments.
        }
      }
    }
  }
  for (const payload of parseSseChunks(buffer)) {
    try {
      const raw = JSON.parse(payload);
      const text = claudeEventText(raw);
      if (!text) continue;
      full += text;
      onDelta(text, raw);
    } catch {
      // Ignore malformed trailing Anthropic stream fragments.
    }
  }
  return full;
}

async function fetchGoogleAuxiliaryStream(
  url: string,
  headers: Record<string, string>,
  body: JsonValue | object,
  providerItem: Provider,
  onDelta: (text: string) => void,
) {
  const started = Date.now();
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const rawText = await response.text();
  addLog({
    providerId: providerItem.id,
    providerName: providerItem.name,
    url,
    ok: response.ok,
    status: response.status,
    kind: "provider:aux:stream",
    durationMs: Date.now() - started,
    requestPreview: jsonPreview(body),
    responsePreview: textPreview(rawText),
    error: response.ok ? undefined : textPreview(rawText),
  });
  if (!response.ok) throw new Error(`${providerItem.name} ${response.status}: ${rawText.slice(0, 500)}`);
  const chunks = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  let text = "";
  for (const chunk of chunks) {
    const delta = String(chunk?.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
    if (!delta) continue;
    text += delta;
    onDelta(delta);
  }
  return text.trim() || "(empty response)";
}

function readOpenAiSseTextIntoMessage(rawText: string, hooks: StreamHooks, toolCalls: any[]) {
  let content = "";
  let reasoning = "";
  for (const payload of parseSseChunks(rawText)) {
    if (payload === "[DONE]") continue;
    try {
      const raw = JSON.parse(payload);
      const delta = raw.choices?.[0]?.delta ?? raw.choices?.[0]?.message ?? responseEventToDelta(raw) ?? {};
      if (Object.keys(delta).length === 0) {
        appendUsageFromRaw(hooks.message, raw);
        continue;
      }
      const applied = applyOpenAiDelta(delta, raw, hooks, toolCalls);
      content += applied.content;
      reasoning += applied.reasoning;
    } catch {
      // Ignore malformed stream fragments, matching the streaming reader.
    }
  }
  return { content, reasoning };
}

function reasoningFromParts(parts: JsonValue[]) {
  return parts
    .map((part) => (isRecord(part) && part.type === "reasoning" ? String(part.reasoning ?? "") : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function compactAssistantToolMessage(content: string, toolCalls: any[], reasoningContent = "") {
  const payload: ApiMessage = {
    role: "assistant",
    content: content || "",
    tool_calls: toolCalls,
  };
  if (reasoningContent.trim()) payload.reasoning_content = reasoningContent.trim();
  return payload;
}

function responseApiToolCallItems(toolCalls: any[]) {
  return toolCalls.map((toolCall) => ({
    type: "function_call",
    call_id: String(toolCall.id ?? ""),
    name: String(toolCall.function?.name ?? ""),
    arguments: String(toolCall.function?.arguments ?? "{}"),
  }));
}

function apiToolCallFromPart(part: Record<string, JsonValue>) {
  return {
    id: String(part.toolCallId ?? id()),
    type: "function",
    function: {
      name: String(part.toolName ?? ""),
      arguments: String(part.input ?? "{}"),
    },
  };
}

async function executeApprovedToolPart(part: Record<string, JsonValue>, assistant: Assistant) {
  const approvalType = toolApprovalType(part);
  if (approvalType === "answered") return String((part.approvalState as Record<string, JsonValue>)?.answer ?? "");
  if (approvalType === "denied") {
    const reason = String((part.approvalState as Record<string, JsonValue>)?.reason ?? "").trim() || "No reason provided";
    return { error: `Tool execution denied by user. Reason: ${reason}` };
  }
  return executeToolCall(apiToolCallFromPart(part), assistant);
}

async function resumeApprovedToolParts(
  conversation: Conversation,
  assistant: Assistant,
  assistantMessage: Message,
  assistantNode: MessageNode,
  useResponseInput: boolean,
) {
  const toolMessages: ApiMessage[] = [];
  let changed = false;
  for (const part of assistantMessage.parts) {
    if (!isRecord(part) || part.type !== "tool") continue;
    if (Array.isArray(part.output) && part.output.length > 0) continue;
    if (!canResumeToolExecution(part)) continue;
    let toolResult: unknown;
    try {
      toolResult = await executeApprovedToolPart(part, assistant);
    } catch (err) {
      toolResult = toolExecutionErrorPayload(err);
    }
    part.output = await toolResultToParts(toolResult);
    changed = true;
    toolMessages.push(
      useResponseInput
        ? { type: "function_call_output", call_id: String(part.toolCallId ?? ""), output: resolvedToolOutput(part) }
        : { role: "tool", tool_call_id: String(part.toolCallId ?? ""), content: resolvedToolOutput(part) },
    );
  }
  if (changed) {
    conversation.updateAt = Date.now();
    saveState();
    touchStream({ message: assistantMessage, conversation, node: assistantNode });
  }
  return toolMessages;
}

function extractToolNameFromArguments(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.name === "string") return parsed.name;
    if (typeof parsed?.tool_name === "string") return parsed.tool_name;
  } catch {
    // Leave the original tool name unchanged if arguments are partial or non-JSON.
  }
  return "";
}

function mergeToolCallDeltas(existing: any[], deltaCalls: any[], mode: "delta" | "snapshot" = "delta") {
  for (const delta of deltaCalls) {
    const index = Number(delta.index ?? existing.length);
    const current = existing[index] ?? { id: "", type: "function", function: { name: "", arguments: "" } };
    const incomingName = String(delta.function?.name ?? "");
    const incomingArguments = String(delta.function?.arguments ?? "");
    const currentName = String(current.function?.name ?? "");
    const currentArguments = String(current.function?.arguments ?? "");
    const nextArguments = mode === "snapshot"
      ? (incomingArguments || currentArguments)
      : currentArguments + incomingArguments;
    const inferredName = !currentName && !incomingName ? extractToolNameFromArguments(nextArguments) : "";
    existing[index] = {
      ...current,
      id: delta.id ?? current.id,
      type: delta.type ?? current.type,
      function: {
        name: incomingName || currentName || inferredName,
        arguments: nextArguments,
      },
    };
  }
}

function visibleTextFromMessage(msg: Message | undefined) {
  return msg ? textFromParts(msg.parts) : "";
}

function visibleReasoningFromMessage(msg: Message | undefined) {
  return msg
    ? msg.parts
        .map((part) => isRecord(part) && part.type === "reasoning" ? String(part.reasoning ?? "") : "")
        .filter(Boolean)
        .join("")
    : "";
}

function ensureReasoningPart(hooks: StreamHooks, metadata?: Record<string, JsonValue>) {
  if (!hooks.message) return null;
  hooks.message.parts = hooks.message.parts.filter((part) => !(
    part &&
    typeof part === "object" &&
    !Array.isArray(part) &&
    (part.type === "loading" || (part.type === "reasoning" && part.reasoning === "正在生成回复"))
  ));
  const last = hooks.message.parts[hooks.message.parts.length - 1];
  if (last && typeof last === "object" && !Array.isArray(last) && last.type === "reasoning") {
    if (metadata && Object.keys(metadata).length > 0) {
      last.metadata = { ...(isRecord(last.metadata) ? last.metadata : {}), ...metadata };
    }
    return last;
  }
  const next = {
    type: "reasoning",
    reasoning: "",
    createdAt: new Date().toISOString(),
    finishedAt: null,
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
  hooks.message.parts.push(next);
  return next;
}

function appendReasoningDelta(hooks: StreamHooks, text: string, metadata?: Record<string, JsonValue>) {
  if (!hooks.message) return;
  const part = ensureReasoningPart(hooks, metadata);
  if (part && text) part.reasoning = String(part.reasoning ?? "") + text;
  touchStream(hooks);
}

function normalizeGeneratedImageUrl(value: string) {
  const text = value.trim();
  if (!text || text.startsWith("data:") || /^https?:\/\//i.test(text)) return text;
  return `data:image/png;base64,${text}`;
}

function addStreamImage(hooks: StreamHooks | undefined, url: string, metadata: Record<string, JsonValue> = {}) {
  if (!hooks?.message) return;
  const normalized = normalizeGeneratedImageUrl(url);
  if (!normalized) return;
  hooks.message.parts.push({ type: "image", url: normalized, metadata });
  touchStream(hooks);
}

async function readOpenAiResponseIntoMessage(
  response: Response,
  hooks: StreamHooks,
  signal?: AbortSignal,
) {
  const toolCalls: any[] = [];
  const contentType = response.headers.get("content-type") ?? "";
  let content = "";
  let reasoning = "";
  let rawText = "";
  let raw: any = {};

  if (contentType.includes("text/event-stream")) {
    content = await readOpenAiStream(response, (delta, rawEvent) => {
      const applied = applyOpenAiDelta(delta, rawEvent, hooks, toolCalls);
      reasoning += applied.reasoning;
      return applied;
    }, signal);
  } else {
    rawText = await response.text();
    if (/^\s*data:/m.test(rawText)) {
      const streamed = readOpenAiSseTextIntoMessage(rawText, hooks, toolCalls);
      content = streamed.content;
      reasoning = streamed.reasoning;
      return { content, reasoning, toolCalls, rawText, raw };
    }
    try {
      raw = rawText ? JSON.parse(rawText) : {};
    } catch {
      raw = { text: rawText };
    }
    const message = raw.choices?.[0]?.message ?? {};
    content = completionMessageText(raw);
    reasoning = String(message.reasoning_content ?? message.reasoning ?? "").trim();
    if (reasoning) appendReasoningDelta(hooks, reasoning);
    if (content) addStreamText(hooks, content);
    if (Array.isArray(message.tool_calls)) {
      mergeToolCallDeltas(toolCalls, message.tool_calls.map((call: any, index: number) => ({ ...call, index })), "snapshot");
    }
    appendUsageFromRaw(hooks.message, raw);
  }

  return { content, reasoning, toolCalls, rawText, raw };
}

async function fetchOpenAiTextStreaming(
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  providerItem: Provider,
  assistant: Assistant,
  hooks: StreamHooks,
  signal?: AbortSignal,
) {
  const started = Date.now();
  const useResponseInput = Array.isArray(body.input) && !Array.isArray(body.messages);
  let messages = [...(useResponseInput ? body.input ?? [] : body.messages ?? [])];
  let currentBody = useResponseInput ? { ...body, input: messages } : { ...body, messages };
  let allContent = "";
  let forceNonStream = false;
  const fetchRound = (requestBody: Record<string, any>) => {
    const timeoutMs = requestBody.stream === false ? 180_000 : 600_000;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let abortHandler: (() => void) | null = null;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
    };
    if (signal) {
      abortHandler = () => controller.abort(signal.reason);
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", abortHandler, { once: true });
    }
    timeout = setTimeout(() => controller.abort(new Error(`Response header timeout: no response from provider for ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    return fetch(url, {
      method: "POST",
      headers: requestBody.stream === false ? headers : { ...headers, Accept: "text/event-stream" },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    }).finally(cleanup);
  };

  for (let round = 0; round < MAX_TOOL_STEPS; round += 1) {
    const roundStarted = Date.now();
    const requestBody = forceNonStream
      ? { ...currentBody, stream: false, stream_options: undefined }
      : currentBody;
    let response: Response;
    try {
      response = await fetchRound(requestBody);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      addLog({
        providerId: providerItem.id,
        providerName: providerItem.name,
        url,
        ok: false,
        status: 0,
        kind: round === 0 ? "provider:chat:stream" : "provider:chat:tool_result:stream",
        durationMs: Date.now() - roundStarted,
        requestPreview: jsonPreview(requestBody),
        responsePreview: "",
        error: detail,
      });
      if (!forceNonStream && requestBody.stream !== false && !signal?.aborted) {
        forceNonStream = true;
        appendReasoningDelta(hooks, `\n流式连接失败，正在按非流式重试... ${detail}`);
        round -= 1;
        continue;
      }
      throw err;
    }
    if (!response.ok) {
      const text = await response.text();
      addLog({
        providerId: providerItem.id,
        providerName: providerItem.name,
        url,
        ok: false,
        status: response.status,
        kind: round === 0 ? "provider:chat:stream" : "provider:chat:tool_result:stream",
        durationMs: Date.now() - roundStarted,
        requestPreview: jsonPreview(requestBody),
        responsePreview: textPreview(text),
        error: textPreview(text),
      });
      throw new Error(`${providerItem.name} ${response.status}: ${text.slice(0, 500)}`);
    }

    let result: Awaited<ReturnType<typeof readOpenAiResponseIntoMessage>>;
    try {
      result = await readOpenAiResponseIntoMessage(response, hooks, signal);
    } catch (err) {
      addLog({
        providerId: providerItem.id,
        providerName: providerItem.name,
        url,
        ok: false,
        status: response.status,
        kind: round === 0 ? "provider:chat:stream" : "provider:chat:tool_result:stream",
        durationMs: Date.now() - roundStarted,
        requestPreview: jsonPreview(requestBody),
        responsePreview: "",
        error: err instanceof Error ? err.message : String(err),
      });
      if (!forceNonStream && !signal?.aborted) {
        forceNonStream = true;
        appendReasoningDelta(hooks, "\n流式连接中断，正在按非流式重试...");
        round -= 1;
        continue;
      }
      throw err;
    }
    allContent += result.content;
    addLog({
      providerId: providerItem.id,
      providerName: providerItem.name,
      url,
      ok: true,
      status: response.status,
      kind: round === 0 ? "provider:chat:stream" : "provider:chat:tool_result:stream",
      durationMs: Date.now() - roundStarted,
      requestPreview: jsonPreview(requestBody),
      responsePreview: textPreview(result.rawText || result.content || JSON.stringify({
        toolCalls: result.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.function?.name,
          argumentsLength: String(toolCall.function?.arguments ?? "").length,
        })),
        reasoningLength: result.reasoning.length,
      })),
    });
    if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
    if (result.toolCalls.length === 0) return allContent.trim() || "(empty response)";

    const toolMessages = [];
    for (const toolCall of result.toolCalls) {
      const toolPart = {
        type: "tool",
        toolCallId: String(toolCall.id ?? id()),
        toolName: String(toolCall.function?.name ?? ""),
        input: String(toolCall.function?.arguments ?? "{}"),
        output: [],
        approvalState: String(toolCall.function?.name ?? "") === "ask_user" ? { type: "pending" } : { type: "auto" },
      };
      if (hooks.message) {
        finishReasoningParts(hooks.message);
        replaceLoadingReasoningWithTool(hooks.message, toolPart);
        touchStream(hooks);
      }
      if (toolPart.approvalState.type === "pending") {
        return allContent.trim() || "";
      }
      let toolResult: unknown;
      try {
        toolResult = await executeToolCall(toolCall, assistant);
      } catch (err) {
        toolResult = toolExecutionErrorPayload(err);
      }
      toolPart.output = await toolResultToParts(toolResult);
      touchStream(hooks);
      toolMessages.push(
        useResponseInput
          ? { type: "function_call_output", call_id: toolPart.toolCallId, output: resolvedToolOutput(toolPart) }
          : { role: "tool", tool_call_id: toolPart.toolCallId, content: resolvedToolOutput(toolPart) },
      );
    }

    if (useResponseInput) {
      messages = [...messages, ...responseApiToolCallItems(result.toolCalls), ...toolMessages];
      currentBody = { ...body, input: messages, stream: !forceNonStream };
    } else {
      messages = [
        ...messages,
        compactAssistantToolMessage(result.content, result.toolCalls, result.reasoning || reasoningFromParts(hooks.message?.parts ?? [])),
        ...toolMessages,
      ];
      currentBody = { ...body, messages, stream: !forceNonStream };
    }
  }

  throw new Error("Too many consecutive tool calls without final assistant content");
}

function cleanAuxiliaryText(text: string, fallback = "") {
  const cleaned = text.replace(/^["“”'‘’]+|["“”'‘’]+$/g, "").trim();
  if (!cleaned || cleaned === "(empty response)") {
    if (fallback) return fallback;
    throw new Error("Auxiliary model returned empty response");
  }
  return cleaned;
}

function firstAuxiliaryLine(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

function limitAuxiliaryText(text: string, limit: number) {
  return Array.from(text).slice(0, limit).join("");
}

async function generateTitleForConversation(conversation: Conversation) {
  const summary = conversationSummary(conversation, 4).trim();
  const firstText = textFromParts(conversation.messages[0]?.messages[0]?.parts ?? []).trim();
  const content = summary || firstText;
  if (!content) return "New Conversation";
  const prompt = applyPlaceholders(state.settings.titlePrompt || DEFAULT_TITLE_PROMPT, {
    locale: localeDisplayName(),
    content: selectedConversationMessages(conversation).slice(-4).map(summaryAsText).join("\n\n"),
  });
  const text = await fetchAuxiliaryText(state.settings.titleModelId, prompt, "title", {
    reasoningLevel: "off",
  });
  return limitAuxiliaryText(
    firstAuxiliaryLine(cleanAuxiliaryText(text, limitAuxiliaryText(firstText, TITLE_CHARACTER_LIMIT) || "New Conversation")),
    TITLE_CHARACTER_LIMIT,
  ) || "New Conversation";
}

function shouldAutoGenerateTitle(conversation: Conversation) {
  const firstText = textFromParts(conversation.messages[0]?.messages[0]?.parts ?? []).trim();
  const title = String(conversation.title ?? "").trim();
  if (!title || title === "New Conversation") return true;
  if (firstText && title === limitAuxiliaryText(firstText, TITLE_CHARACTER_LIMIT)) return true;
  return false;
}

function conversationSummary(conversation: Conversation, takeLast = 8) {
  return conversation.messages
    .map((node) => node.messages[node.selectIndex] ?? node.messages[0])
    .filter(Boolean)
    .slice(-takeLast)
    .map((msg) => summaryAsText(msg))
    .filter((line) => line.trim().length > 6)
    .join("\n\n");
}

interface AuxiliaryTextOptions {
  maxTokens?: number | null;
  temperature?: number | null;
  topP?: number | null;
  reasoningLevel?: string | null;
  customBody?: Record<string, any>;
  stream?: boolean;
  onDelta?: (text: string) => void;
}

function isQwenMtModel(modelId: string) {
  const normalized = modelId.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  return tokens.includes("qwen") && tokens.includes("mt");
}

function englishLanguageName(locale: string) {
  const language = locale.trim() || Intl.DateTimeFormat().resolvedOptions().locale;
  try {
    const displayNames = new Intl.DisplayNames(["en"], { type: "language" });
    return displayNames.of(language) || displayNames.of(language.split(/[-_]/)[0]) || language;
  } catch {
    return language.split(/[-_]/)[0] || language;
  }
}

async function fetchAuxiliaryText(modelId: string, prompt: string, kind: string, options: AuxiliaryTextOptions = {}) {
  const picked = findModel(modelId || state.settings.chatModelId);
  const providerItem = picked.provider;
  const modelItem = picked.model;
  const selectedModel = modelItem.modelId === "auto" ? "gpt-4o-mini" : modelItem.modelId;
  const maxTokens = options.maxTokens ?? null;
  const reasoningLevel = options.reasoningLevel ?? null;
  const stream = options.stream === true;
  const pushDelta = (text: string) => {
    if (text) options.onDelta?.(text);
  };
  const assistant = {
    ...findAssistant(state.settings.assistantId),
    chatModelId: modelItem.id,
    systemPrompt: "",
    temperature: options.temperature ?? null,
    topP: null,
    maxTokens,
    streamOutput: false,
    enabledSkills: [],
    mcpServers: [],
    localTools: [],
    customBodies: options.customBody
      ? Object.entries(options.customBody).map(([key, value]) => ({ key, value }))
      : [],
  } as Assistant;
  const headers = applyRequestHeaders({ "Content-Type": "application/json" }, assistant, providerItem, modelItem);
  let endpoint = endpointFor(providerItem);
  let body: Record<string, any>;
  if (providerItem.type === "google") {
    endpoint = `${providerItem.baseUrl.replace(/\/+$/, "")}/models/${selectedModel}:generateContent?key=${encodeURIComponent(providerItem.apiKey)}`;
    body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        ...(maxTokens != null ? { maxOutputTokens: maxTokens } : {}),
        ...(options.temperature != null ? { temperature: options.temperature } : {}),
      },
    };
    if (stream && options.onDelta) {
      const streamEndpoint = `${providerItem.baseUrl.replace(/\/+$/, "")}/models/${selectedModel}:streamGenerateContent?key=${encodeURIComponent(providerItem.apiKey)}`;
      try {
        return cleanAuxiliaryText(await fetchGoogleAuxiliaryStream(streamEndpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, pushDelta));
      } catch {
        // Fall back to non-streaming auxiliary calls; some compatible gateways do not expose Gemini streaming.
      }
    }
    return fetchText(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, (raw) => raw.candidates?.[0]?.content?.parts?.[0]?.text);
  }
  if (providerItem.type === "claude") {
    headers["x-api-key"] = providerItem.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body = {
      model: selectedModel,
      max_tokens: maxTokens ?? 64_000,
      messages: [{ role: "user", content: prompt }],
      stream,
      ...(options.temperature != null && (!reasoningLevel || !reasoningEnabled(reasoningLevel)) ? { temperature: options.temperature } : {}),
      ...(reasoningLevel && supportsAbility(modelItem, "REASONING") ? { thinking: { type: reasoningEnabled(reasoningLevel) ? "adaptive" : "disabled", ...(reasoningLevelNormalized(reasoningLevel) === "auto" ? { display: "summarized" } : {}) } } : {}),
    };
    if (stream && options.onDelta) {
      try {
        return cleanAuxiliaryText(await fetchClaudeAuxiliaryStream(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, pushDelta));
      } catch {
        body.stream = false;
      }
    }
    return fetchText(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, (raw) => raw.content?.map((item: { text?: string }) => item.text ?? "").join("\n"));
  }
  headers.Authorization = `Bearer ${providerItem.apiKey}`;
  body = providerItem.useResponseApi
    ? {
        model: selectedModel,
        input: [{ role: "user", content: prompt }],
        stream,
        store: false,
        ...(maxTokens != null ? { max_output_tokens: maxTokens } : {}),
        ...(reasoningLevel && supportsAbility(modelItem, "REASONING")
          ? { reasoning: { summary: "auto", ...(reasoningLevelNormalized(reasoningLevel) !== "auto" ? { effort: reasoningLevelNormalized(reasoningLevel) === "off" ? "none" : reasoningLevelNormalized(reasoningLevel) } : {}) } }
          : {}),
      }
    : {
        model: selectedModel,
        messages: [{ role: "user", content: prompt }],
        stream,
        ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
        ...(options.temperature != null && isModelAllowTemperature(modelItem) ? { temperature: options.temperature } : {}),
        ...(options.topP != null && isModelAllowTemperature(modelItem) ? { top_p: options.topP } : {}),
        ...auxiliaryReasoningPayloadForProvider(providerItem, modelItem, reasoningLevel),
      };
  if (stream && options.onDelta) {
    try {
      const text = await fetchOpenAiAuxiliaryStream(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, pushDelta);
      if (!text || text === "(empty response)") throw new Error(`${kind} model returned empty response`);
      return text;
    } catch {
      body.stream = false;
    }
  }
  const text = await fetchText(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, completionMessageText);
  if (!text || text === "(empty response)") throw new Error(`${kind} model returned empty response`);
  return text;
}

function reasoningEnabled(level: string | null | undefined) {
  return reasoningLevelNormalized(level) !== "off";
}

function modelExists(modelId: string | null | undefined) {
  if (!modelId) return false;
  if (modelId === DEFAULT_AUTO_MODEL_ID || modelId === "auto") return true;
  return state.settings.providers.some((providerItem) =>
    providerItem.models.some((modelItem) => modelItem.id === modelId || modelItem.modelId === modelId)
  );
}

async function fetchAuxiliaryOcrText(imageUrl: string) {
  if (!modelExists(state.settings.ocrModelId)) return "";
  const picked = findModel(state.settings.ocrModelId);
  const providerItem = picked.provider;
  const modelItem = picked.model;
  const selectedModel = modelItem.modelId === "auto" ? "gpt-4o-mini" : modelItem.modelId;
  const assistant = {
    ...findAssistant(state.settings.assistantId),
    chatModelId: modelItem.id,
    systemPrompt: "",
    temperature: 0,
    topP: null,
    maxTokens: 2048,
    streamOutput: false,
    enabledSkills: [],
    mcpServers: [],
    localTools: [],
  } as Assistant;
  const prompt = state.settings.ocrPrompt || DEFAULT_OCR_PROMPT;
  const dataUrl = dataUrlForMessageUrl(imageUrl);
  const headers = applyRequestHeaders({ "Content-Type": "application/json" }, assistant, providerItem, modelItem);
  let endpoint = endpointFor(providerItem);
  let body: Record<string, any>;

  if (providerItem.type === "google") {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return "";
    endpoint = `${providerItem.baseUrl.replace(/\/+$/, "")}/models/${selectedModel}:generateContent?key=${encodeURIComponent(providerItem.apiKey)}`;
    body = {
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType: parsed.mime, data: parsed.data } },
        ],
      }],
    };
    return cleanAuxiliaryText(await fetchText(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, (raw) => raw.candidates?.[0]?.content?.parts?.[0]?.text));
  }

  if (providerItem.type === "claude") {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return "";
    headers["x-api-key"] = providerItem.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body = {
      model: selectedModel,
      max_tokens: 2048,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image", source: { type: "base64", media_type: parsed.mime, data: parsed.data } },
        ],
      }],
    };
    return cleanAuxiliaryText(await fetchText(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, (raw) => raw.content?.map((item: { text?: string }) => item.text ?? "").join("\n")));
  }

  headers.Authorization = `Bearer ${providerItem.apiKey}`;
  body = providerItem.useResponseApi
    ? {
        model: selectedModel,
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: dataUrl },
          ],
        }],
        max_output_tokens: 2048,
      }
    : {
        model: selectedModel,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        }],
        max_tokens: 2048,
        temperature: isModelAllowTemperature(modelItem) ? 0 : undefined,
      };
  return cleanAuxiliaryText(await fetchText(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, completionMessageText));
}

function shouldOcrForModel(modelItem: Model) {
  return !supportsInputModality(modelItem, "IMAGE") && modelExists(state.settings.ocrModelId);
}

async function attachOcrToImageParts(parts: JsonValue[], modelItem: Model) {
  if (!shouldOcrForModel(modelItem)) return parts;
  const next = [...parts];
  for (let index = 0; index < next.length; index += 1) {
    const part = next[index];
    if (!isRecord(part) || part.type !== "image") continue;
    const metadata = isRecord(part.metadata) ? part.metadata : {};
    if (String(metadata.ocrText ?? "").trim()) continue;
    const url = String(part.url ?? "");
    if (!url) continue;
    try {
      const ocrText = await fetchAuxiliaryOcrText(url);
      if (ocrText) {
        next[index] = { ...part, metadata: { ...metadata, ocrText, ocrStatus: "done" } };
      }
    } catch (err) {
      next[index] = {
        ...part,
        metadata: {
          ...metadata,
          ocrStatus: "failed",
          ocrError: err instanceof Error ? err.message : String(err),
        },
      };
      console.warn("OCR failed:", err);
    }
  }
  return next;
}

function markOcrPendingParts(parts: JsonValue[], modelItem: Model) {
  if (!shouldOcrForModel(modelItem)) return parts;
  return parts.map((part) => {
    if (!isRecord(part) || part.type !== "image") return part;
    const metadata = isRecord(part.metadata) ? part.metadata : {};
    if (String(metadata.ocrText ?? "").trim()) return part;
    return { ...part, metadata: { ...metadata, ocrStatus: "pending" } };
  });
}

function imageSize(aspectRatio: string) {
  switch (aspectRatio) {
    case "landscape":
      return { openai: "1536x1024", google: "16:9" };
    case "portrait":
      return { openai: "1024x1536", google: "9:16" };
    default:
      return { openai: "1024x1024", google: "1:1" };
  }
}

function imageFileExtension(mime: string) {
  if (mime.includes("jpeg") || mime.includes("jpg")) return ".jpg";
  if (mime.includes("webp")) return ".webp";
  return ".png";
}

async function saveGeneratedImage(
  data: string,
  mime: string,
  prompt: string,
  model: Model,
  type: GeneratedImage["type"],
  sourceFileIds: number[] = [],
) {
  const fileId = state.nextFileId++;
  const fileName = `generated-${Date.now()}-${fileId}${imageFileExtension(mime)}`;
  const target = join(filesDir, fileName);
  await Bun.write(target, Buffer.from(data, "base64"));
  const fileEntry: StoredFile = { id: fileId, path: target, fileName, mime, size: statSync(target).size };
  state.files.push(fileEntry);
  const generated: GeneratedImage = {
    id: String(state.nextGeneratedImageId++),
    prompt,
    fileId,
    url: `/api/files/${fileId}/content`,
    fileName,
    mime,
    model: model.displayName || model.modelId,
    modelId: model.id,
    type,
    sourceFileIds,
    sourcePaths: sourceFileIds.length ? sourceFileIds.join(",") : "",
    createdAt: Date.now(),
  };
  state.generatedImages.unshift(generated);
  state.generatedImages = state.generatedImages.slice(0, 300);
  saveState();
  return generated;
}

async function callImageGeneration(input: {
  prompt: string;
  numberOfImages: number;
  aspectRatio: string;
  referenceFileIds?: number[];
}) {
  const picked = findModel(state.settings.imageGenerationModelId);
  const providerItem = picked.provider;
  const modelItem = picked.model;
  const selectedModel = modelItem.modelId === "auto" ? "gpt-image-2" : modelItem.modelId;
  const count = Math.min(4, Math.max(1, Number(input.numberOfImages) || 1));
  const sizes = imageSize(input.aspectRatio);
  const references = (input.referenceFileIds ?? [])
    .map((fileId) => state.files.find((file) => file.id === fileId))
    .filter(Boolean) as StoredFile[];
  const started = Date.now();

  if (providerItem.type === "google") {
    if (references.length > 0) throw new Error("Gemini image edit is not supported by the original provider implementation");
    const endpoint = `${providerItem.baseUrl.replace(/\/+$/, "")}/models/${selectedModel}:predict?key=${encodeURIComponent(providerItem.apiKey)}`;
    const body = applyModelCustomBody({
      instances: [{ prompt: input.prompt }],
      parameters: { sampleCount: count, aspectRatio: sizes.google },
    }, modelItem);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: applyModelRequestHeaders({ "Content-Type": "application/json" }, providerItem, modelItem),
      body: JSON.stringify(body),
    });
    const text = await response.text();
    addLog({
      providerId: providerItem.id,
      providerName: providerItem.name,
      url: endpoint,
      ok: response.ok,
      status: response.status,
      kind: "provider:image:generation",
      durationMs: Date.now() - started,
      requestPreview: jsonPreview(body),
      responsePreview: textPreview(text),
      error: response.ok ? undefined : textPreview(text),
    });
    if (!response.ok) throw new Error(`Failed to generate image: ${response.status} ${text.slice(0, 500)}`);
    const raw = JSON.parse(text || "{}");
    const predictions = Array.isArray(raw.predictions) ? raw.predictions : [];
    const items = [];
    for (const item of predictions) {
      const data = String(item?.bytesBase64Encoded ?? "");
      if (data) items.push(await saveGeneratedImage(data, "image/png", input.prompt, modelItem, "image_generation"));
    }
    return items;
  }

  if (providerItem.type !== "openai") {
    throw new Error("Image generation is supported for OpenAI-compatible and Google providers");
  }

  const base = providerItem.baseUrl.replace(/\/+$/, "");
  const headers = applyModelRequestHeaders(providerHeaders(providerItem), providerItem, modelItem);
  if (references.length > 0) {
    const endpoint = `${base}/images/edits`;
    const form = new FormData();
    form.append("model", selectedModel);
    form.append("prompt", input.prompt);
    form.append("n", String(count));
    form.append("size", sizes.openai);
    const field = references.length === 1 ? "image" : "image[]";
    for (const reference of references) {
      form.append(field, new Blob([readFileSync(reference.path)], { type: reference.mime || "image/png" }), reference.fileName);
    }
    for (const entry of customBodyEntriesForForm(modelItem)) {
      form.append(entry.key, customFormValue(entry.value));
    }
    const response = await fetch(endpoint, { method: "POST", headers, body: form });
    const text = await response.text();
    addLog({
      providerId: providerItem.id,
      providerName: providerItem.name,
      url: endpoint,
      ok: response.ok,
      status: response.status,
      kind: "provider:image:edit",
      durationMs: Date.now() - started,
      requestPreview: `multipart image edit\nmodel=${selectedModel}\nn=${count}\nsize=${sizes.openai}\nreferences=${references.map((file) => file.fileName).join(", ")}\ncustom=${customBodyEntriesForForm(modelItem).map((entry) => entry.key).join(", ") || "-"}`,
      responsePreview: textPreview(text),
      error: response.ok ? undefined : textPreview(text),
    });
    if (!response.ok) throw new Error(`Failed to edit image: ${response.status} ${text.slice(0, 500)}`);
    const raw = JSON.parse(text || "{}");
    const sourceFileIds = references.map((file) => file.id);
    const items = [];
    for (const item of Array.isArray(raw.data) ? raw.data : []) {
      const data = String(item?.b64_json ?? "");
      if (data) items.push(await saveGeneratedImage(data, "image/png", input.prompt, modelItem, "image_edit", sourceFileIds));
    }
    return items;
  }

  const endpoint = `${base}/images/generations`;
  const body = applyModelCustomBody({ model: selectedModel, prompt: input.prompt, n: count, size: sizes.openai }, modelItem);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  addLog({
    providerId: providerItem.id,
    providerName: providerItem.name,
    url: endpoint,
    ok: response.ok,
    status: response.status,
    kind: "provider:image:generation",
    durationMs: Date.now() - started,
    requestPreview: jsonPreview(body),
    responsePreview: textPreview(text),
    error: response.ok ? undefined : textPreview(text),
  });
  if (!response.ok) throw new Error(`Failed to generate image: ${response.status} ${text.slice(0, 500)}`);
  const raw = JSON.parse(text || "{}");
  const items = [];
  for (const item of Array.isArray(raw.data) ? raw.data : []) {
    const data = String(item?.b64_json ?? "");
    if (data) items.push(await saveGeneratedImage(data, "image/png", input.prompt, modelItem, "image_generation"));
  }
  return items;
}

function selectedAsrProvider() {
  return state.settings.asrProviders.find((provider) => provider.id === state.settings.selectedASRProviderId)
    ?? state.settings.asrProviders[0]
    ?? null;
}

function selectedTtsProvider(providerId?: string) {
  return state.settings.ttsProviders.find((provider) => provider.id === providerId)
    ?? state.settings.ttsProviders.find((provider) => provider.id === state.settings.selectedTTSProviderId)
    ?? state.settings.ttsProviders[0]
    ?? null;
}

function ttsMimeForProvider(provider: TtsProvider) {
  if (provider.type === "groq" || provider.type === "gemini" || provider.type === "qwen" || provider.type === "mimo") return "audio/wav";
  return "audio/mpeg";
}

function pcm16ToWav(pcm: Buffer, sampleRate = 24000, channels = 1) {
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function decodeHexBytes(hexString: string) {
  const clean = hexString.replace(/\s+/g, "");
  if (!clean || clean.length % 2 !== 0) return Buffer.alloc(0);
  return Buffer.from(clean, "hex");
}

async function collectSseAudio(
  response: Response,
  parseData: (data: string) => Buffer | null,
) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: Buffer[] = [];
  let buffer = "";
  let currentData = "";
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data:")) {
          currentData += line.slice(5).trim();
        } else if (line.trim() === "" && currentData) {
          const audio = parseData(currentData);
          if (audio?.length) chunks.push(audio);
          currentData = "";
        }
      }
    }
    if (done) break;
  }
  if (currentData) {
    const audio = parseData(currentData);
    if (audio?.length) chunks.push(audio);
  }
  return Buffer.concat(chunks);
}

async function generateSpeechWithTtsProvider(text: string, providerId?: string) {
  const provider = selectedTtsProvider(providerId);
  if (!provider) throw new Error("No TTS provider configured");
  const started = Date.now();
  if (provider.type === "system") {
    await speakSystemText(text, Number(provider.speechRate ?? 1));
    addLog({
      providerId: provider.id,
      providerName: provider.name,
      url: "windows:System.Speech",
      ok: true,
      status: 0,
      kind: "provider:tts",
      durationMs: Date.now() - started,
      requestPreview: `system tts\ntextLength=${text.length}\nspeechRate=${provider.speechRate ?? 1}`,
      responsePreview: "spoken by Windows System.Speech",
    });
    return { audio: null as Buffer | null, mime: "application/json", provider };
  }
  if (!provider.apiKey.trim()) throw new Error("TTS API Key is empty");
  let endpoint = "";
  let body: Record<string, JsonValue> = {};
  let mime = ttsMimeForProvider(provider);
  let headers: Record<string, string> = { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" };
  let parseAudio: ((response: Response) => Promise<Buffer>) | null = null;
  if (provider.type === "openai" || provider.type === "groq") {
    endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/audio/speech`;
    body = {
      model: provider.model || (provider.type === "openai" ? "gpt-4o-mini-tts" : "canopylabs/orpheus-v1-english"),
      input: text,
      voice: provider.voice || (provider.type === "openai" ? "alloy" : "austin"),
      response_format: provider.type === "groq" ? "wav" : "mp3",
    };
    parseAudio = async (response) => Buffer.from(await response.arrayBuffer());
  } else if (provider.type === "gemini") {
    endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/models/${provider.model || "gemini-2.5-flash-preview-tts"}:generateContent`;
    headers = { "x-goog-api-key": provider.apiKey, "Content-Type": "application/json" };
    body = {
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: provider.voiceName || "Kore" } } },
      },
      model: provider.model || "gemini-2.5-flash-preview-tts",
    };
    parseAudio = async (response) => {
      const raw = await response.json().catch(() => ({})) as Record<string, unknown>;
      const candidates = Array.isArray(raw.candidates) ? raw.candidates : [];
      const first = candidates[0] as Record<string, unknown> | undefined;
      const content = first?.content as Record<string, unknown> | undefined;
      const parts = Array.isArray(content?.parts) ? content.parts : [];
      const part = parts[0] as Record<string, unknown> | undefined;
      const inlineData = part?.inlineData as Record<string, unknown> | undefined;
      const data = typeof inlineData?.data === "string" ? inlineData.data : "";
      if (!data) throw new Error("No audio data returned from Gemini TTS");
      return pcm16ToWav(Buffer.from(data, "base64"), 24000, 1);
    };
  } else if (provider.type === "minimax") {
    endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/t2a_v2`;
    body = {
      model: provider.model || "speech-2.6-turbo",
      text,
      stream: true,
      output_format: "hex",
      stream_options: { exclude_aggregated_audio: true },
      voice_setting: {
        voice_id: provider.voiceId || "female-shaonv",
        emotion: provider.emotion || "calm",
        speed: Number(provider.speed ?? 1),
      },
    };
    parseAudio = async (response) => collectSseAudio(response, (data) => {
      if (data === "[DONE]") return null;
      const raw = JSON.parse(data || "{}") as { data?: { audio?: string } };
      return decodeHexBytes(raw.data?.audio ?? "");
    });
  } else if (provider.type === "qwen") {
    endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/services/aigc/multimodal-generation/generation`;
    headers = { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json", "X-DashScope-SSE": "enable" };
    body = {
      model: provider.model || "qwen3-tts-flash",
      input: { text, voice: provider.voice || "Cherry", language_type: provider.languageType || "Auto" },
    };
    parseAudio = async (response) => {
      const pcm = await collectSseAudio(response, (data) => {
        const raw = JSON.parse(data || "{}") as { output?: { audio?: { data?: string } } };
        const encoded = raw.output?.audio?.data ?? "";
        return encoded ? Buffer.from(encoded, "base64") : null;
      });
      return pcm16ToWav(pcm, 24000, 1);
    };
  } else if (provider.type === "xai") {
    endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/tts`;
    body = {
      text,
      voice_id: provider.voiceId || "eve",
      language: provider.language || "auto",
    };
    parseAudio = async (response) => Buffer.from(await response.arrayBuffer());
  } else if (provider.type === "mimo") {
    endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    headers = { "api-key": provider.apiKey, "Content-Type": "application/json" };
    body = {
      model: provider.model || "mimo-v2-tts",
      messages: [{ role: "assistant", content: text }],
      audio: { format: "pcm16", voice: provider.voice || "mimo_default" },
      stream: true,
    };
    parseAudio = async (response) => {
      const pcm = await collectSseAudio(response, (data) => {
        if (data === "[DONE]") return null;
        const raw = JSON.parse(data || "{}") as { choices?: Array<{ delta?: { audio?: { data?: string } } }> };
        const encoded = raw.choices?.[0]?.delta?.audio?.data ?? "";
        return encoded ? Buffer.from(encoded, "base64") : null;
      });
      return pcm16ToWav(pcm, 24000, 1);
    };
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const audio = response.ok && parseAudio
    ? await parseAudio(response)
    : Buffer.from(await response.arrayBuffer());
  addLog({
    providerId: provider.id,
    providerName: provider.name,
    url: endpoint,
    ok: response.ok,
    status: response.status,
    kind: "provider:tts",
    durationMs: Date.now() - started,
    requestPreview: jsonPreview(body),
    responsePreview: response.ok ? `${audio.length} bytes ${mime}` : textPreview(audio.toString("utf8")),
    error: response.ok ? undefined : textPreview(audio.toString("utf8")),
  });
  if (!response.ok) throw new Error(`TTS request failed: ${response.status} ${audio.toString("utf8").slice(0, 500)}`);
  return { audio, mime, provider };
}

function openAiAsrTranscriptionEndpoint(provider: AsrProvider) {
  try {
    const url = new URL(provider.websocketUrl || "wss://api.openai.com/v1/realtime?intent=transcription");
    url.protocol = "https:";
    const basePath = url.pathname.replace(/\/realtime\/?$/, "").replace(/\/$/, "");
    url.pathname = `${basePath}/audio/transcriptions`;
    url.search = "";
    return url.toString();
  } catch {
    return "https://api.openai.com/v1/audio/transcriptions";
  }
}

async function transcribeAudioWithAsrProvider(file: File) {
  const provider = selectedAsrProvider();
  if (!provider) throw new Error("No ASR provider configured");
  if (!provider.apiKey.trim()) throw new Error("ASR API Key is empty");
  const endpoint = provider.type === "openai_realtime"
    ? openAiAsrTranscriptionEndpoint(provider)
    : provider.type === "dashscope"
      ? "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription"
      : "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
  const form = new FormData();
  if (provider.type === "openai_realtime") {
    form.append("file", file, file.name || "speech.webm");
    form.append("model", provider.model || "gpt-4o-transcribe");
    if (provider.language?.trim()) form.append("language", provider.language.trim());
    if (provider.prompt?.trim()) form.append("prompt", provider.prompt.trim());
  } else {
    form.append("file", file, file.name || "speech.webm");
    form.append("model", provider.model || (provider.type === "dashscope" ? "paraformer-realtime-v2" : "bigmodel"));
    if (provider.language?.trim()) form.append("language", provider.language.trim());
  }
  const started = Date.now();
  const headers: Record<string, string> = provider.type === "openai_realtime"
    ? { Authorization: `Bearer ${provider.apiKey}` }
    : provider.type === "dashscope"
      ? { Authorization: `Bearer ${provider.apiKey}` }
      : {
          "X-Api-Key": provider.apiKey,
          "X-Api-Resource-Id": provider.resourceId || "volc.seedasr.sauc.duration",
          "X-Api-Request-Id": id(),
        };
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: form,
  });
  const rawText = await response.text();
  addLog({
    providerId: provider.id,
    providerName: provider.name,
    url: endpoint,
    ok: response.ok,
    status: response.status,
    kind: "provider:asr",
    durationMs: Date.now() - started,
    requestPreview: `multipart audio transcription\nmodel=${provider.model || "gpt-4o-transcribe"}\nlanguage=${provider.language || "auto"}\nfile=${file.name || "speech.webm"}`,
    responsePreview: textPreview(rawText),
    error: response.ok ? undefined : textPreview(rawText),
  });
  if (!response.ok) throw new Error(`ASR failed: ${response.status} ${rawText.slice(0, 500)}`);
  let raw: any = {};
  try {
    raw = rawText ? JSON.parse(rawText) : {};
  } catch {
    raw = { text: rawText };
  }
  return String(
    raw.text ??
    raw.transcript ??
    raw.output_text ??
    raw.output?.text ??
    raw.result?.text ??
    raw.data?.text ??
    raw.data?.result ??
    "",
  ).trim();
}

interface AsrRealtimeSession {
  provider: AsrProvider;
  client: any;
  upstream: WebSocket | null;
  completedTranscripts: string[];
  partialTranscripts: Map<string, string>;
  lastText: string;
  pendingFrames: ArrayBuffer[];
  opened: boolean;
  finished: boolean;
  startedAt: number;
  volcSequence: number;
}

const asrRealtimeSessions = new WeakMap<object, AsrRealtimeSession>();

function asrSendClient(session: AsrRealtimeSession, payload: Record<string, unknown>) {
  try {
    session.client.send(JSON.stringify(payload));
  } catch {
    // Client has gone away.
  }
}

function asrPublishTranscript(session: AsrRealtimeSession) {
  const transcript = [...session.completedTranscripts, ...session.partialTranscripts.values()]
    .filter((text) => text.trim().length > 0)
    .join(" ");
  asrSendClient(session, { type: "transcript", transcript });
}

function asrFail(session: AsrRealtimeSession, message: string) {
  if (session.finished) return;
  asrSendClient(session, { type: "error", error: message });
  addLog({
    providerId: session.provider.id,
    providerName: session.provider.name,
    url: session.provider.websocketUrl,
    ok: false,
    status: 0,
    kind: "provider:asr:realtime",
    durationMs: Date.now() - session.startedAt,
    error: message,
  });
}

function openAiAsrEndpoint(provider: AsrProvider) {
  const endpoint = (provider.websocketUrl || "wss://api.openai.com/v1/realtime?intent=transcription").trim();
  if (endpoint.includes("intent=transcription") || endpoint.includes("model=")) return endpoint;
  const separator = endpoint.includes("?") ? "&" : "?";
  return `${endpoint.replace(/\/+$/, "")}${separator}intent=transcription`;
}

function dashScopeAsrEndpoint(provider: AsrProvider) {
  const endpoint = (provider.websocketUrl || "wss://dashscope.aliyuncs.com/api-ws/v1/inference").trim().replace(/\/+$/, "");
  if (endpoint.includes("model=")) return endpoint;
  const separator = endpoint.includes("?") ? "&" : "?";
  return `${endpoint}${separator}model=${encodeURIComponent(provider.model || "qwen3-asr-flash-realtime")}`;
}

function openAiAsrSessionUpdate(provider: AsrProvider) {
  const transcription: Record<string, unknown> = { model: provider.model || "gpt-4o-transcribe" };
  if (provider.language?.trim()) transcription.language = provider.language.trim();
  if (provider.prompt?.trim()) transcription.prompt = provider.prompt.trim();
  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: Number(provider.sampleRate || 24000) },
          transcription,
          noise_reduction: { type: "near_field" },
          turn_detection: {
            type: "server_vad",
            threshold: Number(provider.vadThreshold ?? 0.5),
            prefix_padding_ms: Number(provider.prefixPaddingMs ?? 300),
            silence_duration_ms: Number(provider.silenceDurationMs ?? 500),
          },
        },
      },
    },
  };
}

function dashScopeAsrSessionUpdate(provider: AsrProvider) {
  const transcription: Record<string, unknown> = {};
  if (provider.language?.trim()) transcription.language = provider.language.trim();
  const session: Record<string, unknown> = {
    modalities: ["text"],
    input_audio_format: "pcm",
    sample_rate: Number(provider.sampleRate || 16000),
    input_audio_transcription: transcription,
  };
  const vad = Number(provider.vadThreshold ?? 0.2);
  session.turn_detection = vad > 0
    ? { type: "server_vad", threshold: vad, silence_duration_ms: Number(provider.silenceDurationMs ?? 800) }
    : null;
  return { event_id: "evt_session_update", type: "session.update", session };
}

function base64FromArrayBuffer(data: ArrayBuffer) {
  return Buffer.from(data).toString("base64");
}

function handleTextAsrEvent(session: AsrRealtimeSession, text: string) {
  const event = JSON.parse(text || "{}") as Record<string, any>;
  switch (String(event.type ?? "")) {
    case "conversation.item.input_audio_transcription.delta": {
      const itemId = String(event.item_id || "default");
      const delta = String(event.delta || "");
      if (delta) {
        session.partialTranscripts.set(itemId, `${session.partialTranscripts.get(itemId) ?? ""}${delta}`);
        asrPublishTranscript(session);
      }
      break;
    }
    case "conversation.item.input_audio_transcription.text": {
      const itemId = String(event.item_id || "default");
      const content = String(event.text || "");
      if (content) {
        session.partialTranscripts.set(itemId, content);
        asrPublishTranscript(session);
      }
      break;
    }
    case "conversation.item.input_audio_transcription.completed": {
      const itemId = String(event.item_id || "default");
      const transcript = String(event.transcript || "").trim();
      session.partialTranscripts.delete(itemId);
      if (transcript) session.completedTranscripts.push(transcript);
      asrPublishTranscript(session);
      break;
    }
    case "error": {
      const message = String(event.error?.message || "ASR realtime error");
      asrFail(session, message);
      break;
    }
    default:
      break;
  }
}

const VOLC_MSG_FULL_CLIENT_REQUEST = 0x01;
const VOLC_MSG_AUDIO_ONLY = 0x02;
const VOLC_SER_NONE = 0x00;
const VOLC_SER_JSON = 0x01;
const VOLC_COMP_NONE = 0x00;
const VOLC_COMP_GZIP = 0x01;
const VOLC_FLAG_LAST_PACKET = 0x02;

function volcFrame(messageType: number, flags: number, serialization: number, compression: number, payload: Buffer) {
  const header = Buffer.from([0x11, ((messageType << 4) | (flags & 0x0f)) & 0xff, ((serialization << 4) | (compression & 0x0f)) & 0xff, 0x00]);
  const size = Buffer.alloc(4);
  size.writeInt32BE(payload.length, 0);
  return Buffer.concat([header, size, payload]);
}

function volcStartPayload(provider: AsrProvider) {
  const audio: Record<string, unknown> = { format: "pcm", rate: 16000, bits: 16, channel: 1 };
  if (provider.language?.trim()) audio.language = provider.language.trim();
  return Buffer.from(JSON.stringify({
    user: { uid: "rikkahub" },
    audio,
    request: {
      model_name: "bigmodel",
      enable_itn: true,
      enable_punc: true,
      show_utterances: true,
      result_type: "full",
    },
  }));
}

function handleVolcAsrEvent(session: AsrRealtimeSession, data: ArrayBuffer) {
  const buffer = Buffer.from(data);
  if (buffer.length < 4) return;
  const byte1 = buffer[1] & 0xff;
  const byte2 = buffer[2] & 0xff;
  const messageType = (byte1 >> 4) & 0x0f;
  const messageFlags = byte1 & 0x0f;
  const compression = byte2 & 0x0f;
  let offset = 4;
  if (messageType === 0x09) {
    if ((messageFlags & 0x01) !== 0) offset += 4;
    if (offset + 4 > buffer.length) return;
    const payloadSize = buffer.readInt32BE(offset);
    offset += 4;
    if (payloadSize <= 0 || offset + payloadSize > buffer.length) return;
    let payload = buffer.subarray(offset, offset + payloadSize);
    if (compression === VOLC_COMP_GZIP) payload = gunzipSync(payload);
    const raw = JSON.parse(payload.toString("utf8")) as Record<string, any>;
    const text = String(raw.result?.text || "");
    if (text && text !== session.lastText) {
      session.lastText = text;
      asrSendClient(session, { type: "transcript", transcript: text });
    }
  } else if (messageType === 0x0f) {
    if (offset + 8 > buffer.length) return;
    offset += 4;
    const size = buffer.readInt32BE(offset);
    offset += 4;
    const message = size > 0 && offset + size <= buffer.length ? buffer.subarray(offset, offset + size).toString("utf8") : "Volcengine ASR error";
    asrFail(session, message);
  }
}

function sendAsrAudio(session: AsrRealtimeSession, data: ArrayBuffer) {
  if (!session.upstream || session.upstream.readyState !== WebSocket.OPEN) {
    session.pendingFrames.push(data);
    return;
  }
  if (session.provider.type === "volcengine") {
    session.upstream.send(volcFrame(VOLC_MSG_AUDIO_ONLY, 0x00, VOLC_SER_NONE, VOLC_COMP_NONE, Buffer.from(data)));
    return;
  }
  const event: Record<string, unknown> = {
    type: "input_audio_buffer.append",
    audio: base64FromArrayBuffer(data),
  };
  if (session.provider.type === "dashscope") event.event_id = `evt_${Date.now()}`;
  session.upstream.send(JSON.stringify(event));
}

function startAsrRealtimeSession(client: any, providerId?: string) {
  const provider = state.settings.asrProviders.find((item) => item.id === providerId) ?? selectedAsrProvider();
  if (!provider) {
    client.send(JSON.stringify({ type: "error", error: "No ASR provider configured" }));
    return;
  }
  if (!provider.apiKey.trim()) {
    client.send(JSON.stringify({ type: "error", error: "ASR API Key is empty" }));
    return;
  }
  const endpoint = provider.type === "openai_realtime"
    ? openAiAsrEndpoint(provider)
    : provider.type === "dashscope"
      ? dashScopeAsrEndpoint(provider)
      : provider.websocketUrl || "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
  const session: AsrRealtimeSession = {
    provider,
    client,
    upstream: null,
    completedTranscripts: [],
    partialTranscripts: new Map(),
    lastText: "",
    pendingFrames: [],
    opened: false,
    finished: false,
    startedAt: Date.now(),
    volcSequence: 1,
  };
  asrRealtimeSessions.set(client, session);
  const headers: Record<string, string> = provider.type === "volcengine"
    ? {
        "X-Api-Key": provider.apiKey,
        "X-Api-Resource-Id": provider.resourceId || "volc.seedasr.sauc.duration",
        "X-Api-Request-Id": id(),
        "X-Api-Sequence": "-1",
      }
    : {
        Authorization: `Bearer ${provider.apiKey}`,
        ...(provider.type === "dashscope" ? { "OpenAI-Beta": "realtime=v1" } : {}),
      };
  const upstream = new WebSocket(endpoint, { headers });
  session.upstream = upstream;
  upstream.binaryType = "arraybuffer";
  upstream.onopen = () => {
    session.opened = true;
    if (provider.type === "openai_realtime") upstream.send(JSON.stringify(openAiAsrSessionUpdate(provider)));
    if (provider.type === "dashscope") upstream.send(JSON.stringify(dashScopeAsrSessionUpdate(provider)));
    if (provider.type === "volcengine") {
      upstream.send(volcFrame(VOLC_MSG_FULL_CLIENT_REQUEST, 0x00, VOLC_SER_JSON, VOLC_COMP_GZIP, gzipSync(volcStartPayload(provider))));
    }
    asrSendClient(session, { type: "status", status: "listening" });
    for (const frame of session.pendingFrames.splice(0)) sendAsrAudio(session, frame);
  };
  upstream.onmessage = (event) => {
    try {
      if (typeof event.data === "string") handleTextAsrEvent(session, event.data);
      else handleVolcAsrEvent(session, event.data as ArrayBuffer);
    } catch (err) {
      asrFail(session, err instanceof Error ? err.message : String(err));
    }
  };
  upstream.onerror = () => asrFail(session, "ASR websocket failed");
  upstream.onclose = () => {
    session.finished = true;
    addLog({
      providerId: provider.id,
      providerName: provider.name,
      url: endpoint,
      ok: true,
      status: 0,
      kind: "provider:asr:realtime",
      durationMs: Date.now() - session.startedAt,
      requestPreview: `realtime pcm websocket\nprovider=${provider.type}\nsampleRate=${provider.sampleRate || (provider.type === "openai_realtime" ? 24000 : 16000)}`,
      responsePreview: session.lastText || [...session.completedTranscripts, ...session.partialTranscripts.values()].join(" "),
    });
    asrSendClient(session, { type: "status", status: "idle" });
  };
}

function stopAsrRealtimeSession(client: any) {
  const session = asrRealtimeSessions.get(client);
  if (!session) return;
  if (session.provider.type === "volcengine" && session.upstream?.readyState === WebSocket.OPEN) {
    session.upstream.send(volcFrame(VOLC_MSG_AUDIO_ONLY, VOLC_FLAG_LAST_PACKET, VOLC_SER_NONE, VOLC_COMP_NONE, Buffer.alloc(0)));
  }
  session.upstream?.close(1000, "stop");
  asrRealtimeSessions.delete(client);
}

async function generateSuggestionsForConversation(conversation: Conversation) {
  const content = conversationSummary(conversation, 8);
  if (!content) return [];
  const prompt = applyPlaceholders(state.settings.suggestionPrompt || DEFAULT_SUGGESTION_PROMPT, {
    locale: localeDisplayName(),
    content: selectedConversationMessages(conversation).slice(-8).map(summaryAsText).join("\n\n"),
  });
  const text = await fetchAuxiliaryText(state.settings.suggestionModelId, prompt, "suggestion", {
    reasoningLevel: "off",
  });
  return uniqueStrings(
    text
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)、])\s*/, "").trim())
      .filter(Boolean)
      .map((line) => limitAuxiliaryText(line, SUGGESTION_CHARACTER_LIMIT))
      .filter(Boolean),
  ).slice(0, 10);
}

async function compressConversation(conversation: Conversation, additionalPrompt = "", targetTokens = 2000, keepRecentMessages = 32) {
  const allMessages = selectedConversationMessages(conversation);
  if (allMessages.length === 0) throw new Error("当前会话没有可压缩的消息");

  let messagesToCompress: Message[];
  let messagesToKeep: Message[];
  if (keepRecentMessages > 0 && allMessages.length > keepRecentMessages) {
    messagesToCompress = allMessages.slice(0, -keepRecentMessages);
    messagesToKeep = allMessages.slice(-keepRecentMessages);
  } else if (keepRecentMessages > 0) {
    throw new Error("消息数量不足，无法在保留最近消息的同时压缩历史");
  } else {
    messagesToCompress = allMessages;
    messagesToKeep = [];
  }

  const splitMessages = (messages: Message[]): Message[][] => {
    if (messages.length <= 256) return [messages];
    const mid = Math.floor(messages.length / 2);
    return [...splitMessages(messages.slice(0, mid)), ...splitMessages(messages.slice(mid))];
  };

  const chunks = splitMessages(messagesToCompress);
  const summaries: string[] = [];
  for (const chunk of chunks) {
    const prompt = applyPlaceholders(state.settings.compressPrompt || DEFAULT_COMPRESS_PROMPT, {
      content: chunk.map(summaryAsText).join("\n\n"),
      target_tokens: String(targetTokens),
      additional_context: additionalPrompt.trim() ? `Additional instructions from user: ${additionalPrompt.trim()}` : "",
      locale: localeDisplayName(),
    });
    summaries.push(cleanAuxiliaryText(await fetchAuxiliaryText(state.settings.compressModelId || state.settings.chatModelId, prompt, "compression", {
      stream: true,
      onDelta: (delta) => {
        if (!delta) return;
        conversation.chatSuggestions = [`正在压缩对话历史... ${Math.min(summaries.length + 1, chunks.length)}/${chunks.length}`];
        conversation.updateAt = Date.now();
        saveState();
        broadcastConversation(conversation);
      },
    })));
  }

  conversation.messages = [
    ...summaries.filter(Boolean).map((summary) => ({ id: id(), messages: [message("USER", [{ type: "text", text: summary }])], selectIndex: 0 })),
    ...messagesToKeep.map((msg) => ({ id: id(), messages: [JSON.parse(JSON.stringify(msg))], selectIndex: 0 })),
  ];
  conversation.truncateIndex = 0;
  conversation.chatSuggestions = [];
  conversation.updateAt = Date.now();
  saveState();
  broadcastConversation(conversation);
  return summaries;
}

const generating = new Map<string, AbortController>();

function cloneConversation(conversation: Conversation): Conversation {
  return JSON.parse(JSON.stringify(conversation)) as Conversation;
}

function completeConversationGeneration(conversationId: string, controller: AbortController) {
  if (generating.get(conversationId) === controller) {
    generating.delete(conversationId);
  }
}

function conversationStillExists(conversationId: string) {
  return state.conversations.some((item) => item.id === conversationId);
}

async function runPostGenerationTasks(conversationId: string, snapshot: Conversation, assistantMessageId: string) {
  const liveConversation = () => getConversation(conversationId);
  if (shouldAutoGenerateTitle(snapshot) && modelExists(state.settings.titleModelId)) {
    try {
      const title = await generateTitleForConversation(snapshot);
      const live = liveConversation();
      if (live && shouldAutoGenerateTitle(live)) {
        live.title = title;
        saveState();
        broadcastConversation(live);
      }
    } catch (titleError) {
      addLog({
        providerId: "",
        providerName: "RikkaHub PC",
        url: "conversation:title",
        ok: false,
        status: 0,
        kind: "aux:title",
        error: titleError instanceof Error ? titleError.message : String(titleError),
      });
      // Title generation failed → fall back to first user message text (Android parity).
      const live = liveConversation();
      if (live && shouldAutoGenerateTitle(live)) {
        const firstText = textFromParts(live.messages[0]?.messages[0]?.parts ?? []).trim();
        const fallback = limitAuxiliaryText(firstText, TITLE_CHARACTER_LIMIT) || "New Conversation";
        live.title = fallback;
        saveState();
        broadcastConversation(live);
      }
    }
  } else if (shouldAutoGenerateTitle(snapshot)) {
    // No title model configured at all → still give it a sensible name from the first user message.
    const live = liveConversation();
    if (live && shouldAutoGenerateTitle(live)) {
      const firstText = textFromParts(live.messages[0]?.messages[0]?.parts ?? []).trim();
      const fallback = limitAuxiliaryText(firstText, TITLE_CHARACTER_LIMIT) || "New Conversation";
      if (fallback !== live.title) {
        live.title = fallback;
        saveState();
        broadcastConversation(live);
      }
    }
  }

  if (modelExists(state.settings.suggestionModelId)) {
    try {
      const suggestions = await generateSuggestionsForConversation(snapshot);
      const live = liveConversation();
      const lastNode = live?.messages[live.messages.length - 1];
      const lastMessage = lastNode?.messages[lastNode.selectIndex] ?? lastNode?.messages[0];
      if (live && lastMessage?.id === assistantMessageId && !generating.has(live.id)) {
        live.chatSuggestions = suggestions;
        live.updateAt = Date.now();
        saveState();
        broadcastConversation(live);
      }
    } catch {
      // Suggestions are auxiliary;正文生成状态不应受影响。
    }
  }
}

async function generateAnswer(conversation: Conversation) {
  const controller = new AbortController();
  generating.set(conversation.id, controller);
  const assistant = findAssistant(conversation.assistantId);
  const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
  const assistantNode = ensureAssistantGenerationNode(conversation, picked.model.id);
  const currentMessage = assistantNode.messages[assistantNode.selectIndex];
  const resumingApprovedTools = hasResumableToolParts(currentMessage);
  currentMessage.finishedAt = null;
  if (!resumingApprovedTools) {
    // Show a loading placeholder immediately so the UI has visual feedback during the
    // upstream first-token wait. addStreamText / replaceLoadingReasoningWithTool will
    // strip this placeholder as soon as the first real delta arrives.
    setMessageLoading(currentMessage);
  }
  conversation.updateAt = Date.now();
  saveState();
  broadcastNodeUpdate(conversation, assistantNode);
  try {
    if (resumingApprovedTools) {
      await resumeApprovedToolParts(conversation, assistant, currentMessage, assistantNode, false);
    }
    const content = await callProviderStreaming(conversation, currentMessage, assistantNode, controller.signal);
    if (controller.signal.aborted) throw new DOMException("Generation stopped", "AbortError");
    applyOutputTransforms(currentMessage, assistant);
    finishReasoningParts(currentMessage);
    if (hasPendingToolApproval(currentMessage)) {
      currentMessage.finishedAt = null;
      ensureUsage(currentMessage, conversation);
      conversation.updateAt = Date.now();
      saveState();
      completeConversationGeneration(conversation.id, controller);
      broadcastNodeUpdate(conversation, assistantNode);
      broadcastConversation(conversation);
      return;
    }
    if (currentMessage.parts.length === 0) {
      finishMessage(currentMessage, [{ type: "text", text: content }]);
    } else {
      const hasText = textFromParts(currentMessage.parts).trim().length > 0;
      if (!hasText && content && content !== "(empty response)") {
        appendTextPart(currentMessage, content);
      }
      currentMessage.finishedAt = new Date().toISOString();
    }
    ensureUsage(currentMessage, conversation);
    conversation.updateAt = Date.now();
    saveState();
    completeConversationGeneration(conversation.id, controller);
    broadcastNodeUpdate(conversation, assistantNode);
    broadcastConversation(conversation);
    const snapshot = cloneConversation(conversation);
    void runPostGenerationTasks(conversation.id, snapshot, currentMessage.id);
  } catch (err) {
    if (!conversationStillExists(conversation.id)) {
      completeConversationGeneration(conversation.id, controller);
      return;
    }
    if (err instanceof DOMException && err.name === "AbortError") {
      applyOutputTransforms(currentMessage, assistant);
      finishReasoningParts(currentMessage);
      currentMessage.finishedAt = new Date().toISOString();
      ensureUsage(currentMessage, conversation);
      conversation.updateAt = Date.now();
      saveState();
      completeConversationGeneration(conversation.id, controller);
      broadcastNodeUpdate(conversation, assistantNode);
      broadcastConversation(conversation);
      return;
    }
    const content = err instanceof Error ? err.message : String(err);
    applyOutputTransforms(currentMessage, assistant);
    finishReasoningParts(currentMessage);
    if (currentMessage.parts.length === 0) {
      finishMessage(currentMessage, [{ type: "text", text: `请求失败：${content}` }]);
    } else {
      appendTextPart(currentMessage, `\n\n请求失败：${content}`);
      currentMessage.finishedAt = new Date().toISOString();
    }
    ensureUsage(currentMessage, conversation);
    conversation.updateAt = Date.now();
    saveState();
    completeConversationGeneration(conversation.id, controller);
    broadcastNodeUpdate(conversation, assistantNode);
    broadcastConversation(conversation);
  } finally {
    completeConversationGeneration(conversation.id, controller);
    if (!conversationStillExists(conversation.id)) return;
    broadcastNodeUpdate(conversation, assistantNode);
    broadcastConversation(conversation);
  }
}

function ensureAssistantGenerationNode(conversation: Conversation, modelId: string): MessageNode {
  const last = conversation.messages[conversation.messages.length - 1];
  if (last?.messages[last.selectIndex]?.role === "ASSISTANT") {
    const msg = last.messages[last.selectIndex];
    msg.modelId = modelId;
    if (hasToolParts(msg)) {
      return last;
    }
    return last;
  }
  const assistantNode: MessageNode = {
    id: id(),
    messages: [message("ASSISTANT", [], modelId)],
    selectIndex: 0,
  };
  conversation.messages.push(assistantNode);
  return assistantNode;
}

function truncateConversationForRegenerate(conversation: Conversation, messageId?: string) {
  if (!messageId) {
    const last = conversation.messages[conversation.messages.length - 1];
    if (last?.messages[last.selectIndex]?.role === "ASSISTANT") conversation.messages.pop();
    return;
  }
  const nodeIndex = conversation.messages.findIndex((node) => node.messages.some((msg) => msg.id === messageId));
  if (nodeIndex < 0) return;
  const node = conversation.messages[nodeIndex];
  const msg = node.messages.find((item) => item.id === messageId);
  if (!msg) return;
  if (msg.role === "USER") {
    conversation.messages = conversation.messages.slice(0, nodeIndex + 1);
    return;
  }
  conversation.messages = conversation.messages.slice(0, nodeIndex);
}

function updateSettings(next: Settings) {
  state.settings = next;
  saveState();
  broadcastSettings();
  broadcastList();
}

async function routeApi(request: Request, url: URL) {
  const path = url.pathname.replace(/^\/api\/?/, "");

  if (path === "health") return json({ ok: true, version: "pc-dev", dataDir });
  if (path === "ai-icon" && request.method === "GET") {
    const name = url.searchParams.get("name")?.trim();
    if (!name) return error("Missing name", 400);
    return serveAIIcon(name);
  }
  if (path === "settings" && request.method === "GET") return json(state.settings);
  if (path === "settings/stream") {
    return openSse(
      () => [["update", state.settings]],
      (controller) => {
        settingsClients.add(controller);
        return () => settingsClients.delete(controller);
      },
    );
  }
  if (path === "conversations/stream") {
    return openSse(
      () => [["invalidate", { type: "invalidate", assistantId: state.settings.assistantId, timestamp: Date.now() }]],
      (controller) => {
        listClients.add(controller);
        return () => listClients.delete(controller);
      },
    );
  }

  if (path === "settings/display" && request.method === "POST") {
    const body = await readJson<Record<string, JsonValue>>(request);
    updateSettings({ ...state.settings, displaySetting: { ...state.settings.displaySetting, ...body } });
    return json({ status: "ok" });
  }
  if (path === "settings/assistant" && request.method === "POST") {
    const body = await readJson<{ assistantId: string }>(request);
    if (!state.settings.assistants.some((assistant) => assistant.id === body.assistantId)) return error("Assistant not found", 404);
    updateSettings({ ...state.settings, assistantId: body.assistantId });
    return json({ status: "ok" });
  }
  if (path === "settings/assistant/detail" && request.method === "POST") {
    const body = await readJson<Assistant>(request);
    const assistant = { ...defaultAssistant(), ...body, id: body.id || id() };
    updateSettings({
      ...state.settings,
      assistantId: assistant.id,
      assistants: state.settings.assistants.some((item) => item.id === assistant.id)
        ? state.settings.assistants.map((item) => (item.id === assistant.id ? assistant : item))
        : [...state.settings.assistants, assistant],
    });
    return json({ status: "ok", assistant });
  }
  const assistantDelete = path.match(/^settings\/assistant\/([^/]+)$/);
  if (assistantDelete && request.method === "DELETE") {
    const idValue = decodeURIComponent(assistantDelete[1]);
    if (state.settings.assistants.length <= 1) return error("At least one assistant is required", 400);
    const assistants = state.settings.assistants.filter((item) => item.id !== idValue);
    state.memories = state.memories.filter((memory) => memory.assistantId !== idValue);
    updateSettings({
      ...state.settings,
      assistants,
      assistantId: state.settings.assistantId === idValue ? assistants[0].id : state.settings.assistantId,
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/assistants/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    const byId = new Map(state.settings.assistants.map((item) => [item.id, item]));
    const ordered = body.ids.map((itemId) => byId.get(itemId)).filter(Boolean) as Assistant[];
    const rest = state.settings.assistants.filter((item) => !body.ids.includes(item.id));
    updateSettings({ ...state.settings, assistants: [...ordered, ...rest] });
    return json({ status: "ok" });
  }
  if (path === "settings/assistant/model" && request.method === "POST") {
    const body = await readJson<{ assistantId: string; modelId: string }>(request);
    updateSettings({
      ...state.settings,
      assistants: state.settings.assistants.map((assistant) =>
        assistant.id === body.assistantId ? { ...assistant, chatModelId: body.modelId } : assistant,
      ),
    });
    return json({ status: "ok" });
  }
  if (path === "settings/assistant/thinking-budget" && request.method === "POST") {
    const body = await readJson<{ assistantId: string; reasoningLevel: string }>(request);
    updateSettings({
      ...state.settings,
      assistants: state.settings.assistants.map((assistant) =>
        assistant.id === body.assistantId ? { ...assistant, reasoningLevel: body.reasoningLevel } : assistant,
      ),
    });
    return json({ status: "ok" });
  }
  if (path === "settings/assistant/mcp" && request.method === "POST") {
    const body = await readJson<{ assistantId: string; mcpServerIds: string[] }>(request);
    const assistantExists = state.settings.assistants.some((assistant) => assistant.id === body.assistantId);
    if (!assistantExists) return error("Assistant not found", 404);
    let mcpServerIds: string[];
    try {
      mcpServerIds = validateKnownJsonIds(state.settings.mcpServers, body.mcpServerIds, "mcpServerIds");
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 400);
    }
    updateSettings({
      ...state.settings,
      assistants: state.settings.assistants.map((assistant) =>
        assistant.id === body.assistantId ? { ...assistant, mcpServers: mcpServerIds } : assistant,
      ),
    });
    return json({ status: "ok" });
  }
  if (path === "settings/assistant/injections" && request.method === "POST") {
    const body = await readJson<{
      assistantId: string;
      modeInjectionIds: string[];
      lorebookIds: string[];
      quickMessageIds: string[];
    }>(request);
    const assistantExists = state.settings.assistants.some((assistant) => assistant.id === body.assistantId);
    if (!assistantExists) return error("Assistant not found", 404);
    let modeInjectionIds: string[];
    let lorebookIds: string[];
    let quickMessageIds: string[];
    try {
      modeInjectionIds = validateKnownJsonIds(state.settings.modeInjections, body.modeInjectionIds, "modeInjectionIds");
      lorebookIds = validateKnownJsonIds(state.settings.lorebooks, body.lorebookIds, "lorebookIds");
      quickMessageIds = validateKnownJsonIds(state.settings.quickMessages, body.quickMessageIds, "quickMessageIds");
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 400);
    }
    updateSettings({
      ...state.settings,
      assistants: state.settings.assistants.map((assistant) =>
        assistant.id === body.assistantId
          ? {
              ...assistant,
              modeInjectionIds,
              lorebookIds,
              quickMessageIds,
            }
          : assistant,
      ),
    });
    return json({ status: "ok" });
  }
  if (path === "settings/assistant/skills" && request.method === "POST") {
    const body = await readJson<{ assistantId: string; enabledSkills: string[] }>(request);
    const assistantExists = state.settings.assistants.some((assistant) => assistant.id === body.assistantId);
    if (!assistantExists) return error("Assistant not found", 404);
    const installedSkillNames = new Set(listSkills().map((skill) => skill.name));
    const enabledSkills = getStringArray(body.enabledSkills);
    const unknownSkill = enabledSkills.find((skillName) => !installedSkillNames.has(skillName));
    if (unknownSkill) return error(`enabledSkills contains unknown skill: ${unknownSkill}`, 400);
    updateSettings({
      ...state.settings,
      assistants: state.settings.assistants.map((assistant) =>
        assistant.id === body.assistantId ? { ...assistant, enabledSkills } : assistant,
      ),
    });
    return json({ status: "ok" });
  }
  if (path === "settings/memories" && request.method === "GET") {
    const assistantId = url.searchParams.get("assistantId") ?? state.settings.assistantId;
    const assistant = findAssistant(assistantId);
    const memoryAssistantId = assistant.useGlobalMemory ? GLOBAL_MEMORY_ID : assistant.id;
    return json({
      assistantId: memoryAssistantId,
      memories: state.memories
        .filter((memory) => memory.assistantId === memoryAssistantId)
        .sort((a, b) => a.id - b.id),
    });
  }
  if (path === "settings/memory/detail" && request.method === "POST") {
    const body = await readJson<{ assistantId?: string; id?: number; content?: string }>(request);
    const assistant = findAssistant(body.assistantId ?? state.settings.assistantId);
    const memoryAssistantId = assistant.useGlobalMemory ? GLOBAL_MEMORY_ID : assistant.id;
    const content = String(body.content ?? "").trim();
    if (!content) return error("Memory content is required", 400);
    let memory: AssistantMemory | undefined;
    if (Number.isInteger(Number(body.id)) && Number(body.id) > 0) {
      const memoryId = Number(body.id);
      memory = state.memories.find((item) => item.id === memoryId && item.assistantId === memoryAssistantId);
      if (!memory) return error(`Memory record #${memoryId} not found`, 404);
      memory.content = content;
      memory.updatedAt = Date.now();
    } else {
      const now = Date.now();
      memory = {
        id: state.nextMemoryId++,
        assistantId: memoryAssistantId,
        content,
        createdAt: now,
        updatedAt: now,
      };
      state.memories.push(memory);
    }
    saveState();
    broadcastSettings();
    return json({ status: "ok", memory });
  }
  const memoryDelete = path.match(/^settings\/memory\/(\d+)$/);
  if (memoryDelete && request.method === "DELETE") {
    const memoryId = Number(memoryDelete[1]);
    const before = state.memories.length;
    state.memories = state.memories.filter((memory) => memory.id !== memoryId);
    if (state.memories.length === before) return error(`Memory record #${memoryId} not found`, 404);
    saveState();
    broadcastSettings();
    return json({ status: "deleted" });
  }
  if (path === "settings/mcp-server/detail" && request.method === "POST") {
    const body = await readJson<Record<string, JsonValue>>(request);
    const common = isRecord(body.commonOptions) ? body.commonOptions : {};
    let server: Record<string, JsonValue> = {
      type: String(body.type ?? "streamable_http") === "sse" ? "sse" : "streamable_http",
      url: String(body.url ?? ""),
      ...body,
      id: String(body.id ?? id()),
      ssePostEndpoint: String(body.ssePostEndpoint ?? ""),
      commonOptions: {
        enable: common.enable !== false,
        name: String(common.name ?? body.name ?? "MCP Server"),
        headers: Array.isArray(common.headers) ? common.headers : [],
        tools: Array.isArray(common.tools) ? common.tools : [],
        lastSyncAt: typeof common.lastSyncAt === "number" ? common.lastSyncAt : null,
        lastSyncError: String(common.lastSyncError ?? ""),
        connected: common.connected === true,
      },
    };
    if (isRecord(server.commonOptions) && server.commonOptions.enable !== false && String(server.url ?? "").trim()) {
      server = await syncMcpServerTools(server);
    }
    const result = upsertById(state.settings.mcpServers as JsonValue[], server);
    updateSettings({ ...state.settings, mcpServers: result.items });
    return json({ status: "ok", server: result.item });
  }
  const mcpDelete = path.match(/^settings\/mcp-server\/([^/]+)$/);
  if (mcpDelete && request.method === "DELETE") {
    const idValue = decodeURIComponent(mcpDelete[1]);
    updateSettings({
      ...state.settings,
      mcpServers: deleteById(state.settings.mcpServers as JsonValue[], idValue),
      assistants: state.settings.assistants.map((assistant) => ({
        ...assistant,
        mcpServers: assistant.mcpServers.filter((serverId) => serverId !== idValue),
      })),
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/mcp-server/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    updateSettings({ ...state.settings, mcpServers: reorderByIds(state.settings.mcpServers as JsonValue[], body.ids ?? []) });
    return json({ status: "ok" });
  }
  if (path === "settings/mcp-server/sync" && request.method === "POST") {
    const body = await readJson<{ serverId: string }>(request);
    const server = (state.settings.mcpServers as Array<Record<string, JsonValue>>).find((item) => String(item.id) === body.serverId);
    if (!server) return error("MCP server not found", 404);
    const nextServer = await syncMcpServerTools(server);
    const result = upsertById(state.settings.mcpServers as JsonValue[], nextServer);
    updateSettings({ ...state.settings, mcpServers: result.items });
    const common = isRecord(nextServer.commonOptions) ? nextServer.commonOptions : {};
    if (common.connected === false) return error(String(common.lastSyncError ?? "MCP sync failed"), 502);
    return json({ status: "ok", tools: Array.isArray(common.tools) ? common.tools : [], server: result.item });
  }
  if (path === "settings/mode-injection/detail" && request.method === "POST") {
    const body = await readJson<Record<string, JsonValue>>(request);
    const item = {
      type: "mode",
      enabled: true,
      priority: 0,
      position: "after_system_prompt",
      content: "",
      injectDepth: 4,
      role: "USER",
      ...body,
      id: String(body.id ?? id()),
      name: String(body.name ?? "Mode Injection"),
    };
    const result = upsertById(state.settings.modeInjections as JsonValue[], item);
    updateSettings({ ...state.settings, modeInjections: result.items });
    return json({ status: "ok", item: result.item });
  }
  const modeDelete = path.match(/^settings\/mode-injection\/([^/]+)$/);
  if (modeDelete && request.method === "DELETE") {
    const idValue = decodeURIComponent(modeDelete[1]);
    updateSettings({
      ...state.settings,
      modeInjections: deleteById(state.settings.modeInjections as JsonValue[], idValue),
      assistants: state.settings.assistants.map((assistant) => ({
        ...assistant,
        modeInjectionIds: assistant.modeInjectionIds.filter((itemId) => itemId !== idValue),
      })),
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/mode-injection/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    updateSettings({ ...state.settings, modeInjections: reorderByIds(state.settings.modeInjections as JsonValue[], body.ids ?? []) });
    return json({ status: "ok" });
  }
  if (path === "settings/lorebook/detail" && request.method === "POST") {
    const body = await readJson<Record<string, JsonValue>>(request);
    const item = {
      enabled: true,
      description: "",
      entries: [],
      ...body,
      id: String(body.id ?? id()),
      name: String(body.name ?? "Lorebook"),
    };
    const result = upsertById(state.settings.lorebooks as JsonValue[], item);
    updateSettings({ ...state.settings, lorebooks: result.items });
    return json({ status: "ok", item: result.item });
  }
  const lorebookDelete = path.match(/^settings\/lorebook\/([^/]+)$/);
  if (lorebookDelete && request.method === "DELETE") {
    const idValue = decodeURIComponent(lorebookDelete[1]);
    updateSettings({
      ...state.settings,
      lorebooks: deleteById(state.settings.lorebooks as JsonValue[], idValue),
      assistants: state.settings.assistants.map((assistant) => ({
        ...assistant,
        lorebookIds: assistant.lorebookIds.filter((itemId) => itemId !== idValue),
      })),
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/lorebook/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    updateSettings({ ...state.settings, lorebooks: reorderByIds(state.settings.lorebooks as JsonValue[], body.ids ?? []) });
    return json({ status: "ok" });
  }
  if (path === "settings/quick-message/detail" && request.method === "POST") {
    const body = await readJson<Record<string, JsonValue>>(request);
    const item = { title: "", content: "", ...body, id: String(body.id ?? id()) };
    const result = upsertById(state.settings.quickMessages as JsonValue[], item);
    updateSettings({ ...state.settings, quickMessages: result.items });
    return json({ status: "ok", item: result.item });
  }
  const quickMessageDelete = path.match(/^settings\/quick-message\/([^/]+)$/);
  if (quickMessageDelete && request.method === "DELETE") {
    const idValue = decodeURIComponent(quickMessageDelete[1]);
    updateSettings({
      ...state.settings,
      quickMessages: deleteById(state.settings.quickMessages as JsonValue[], idValue),
      assistants: state.settings.assistants.map((assistant) => ({
        ...assistant,
        quickMessageIds: assistant.quickMessageIds.filter((itemId) => itemId !== idValue),
      })),
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/quick-message/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    updateSettings({ ...state.settings, quickMessages: reorderByIds(state.settings.quickMessages as JsonValue[], body.ids ?? []) });
    return json({ status: "ok" });
  }
  if (path === "settings/search/enabled" && request.method === "POST") {
    const body = await readJson<{ enabled: boolean }>(request);
    updateSettings({ ...state.settings, enableWebSearch: body.enabled });
    return json({ status: "ok" });
  }
  if (path === "settings/search/service" && request.method === "POST") {
    const body = await readJson<{ index: number }>(request);
    updateSettings({ ...state.settings, searchServiceSelected: body.index });
    return json({ status: "ok" });
  }
  if (path === "settings/search/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[]; selectedId?: string }>(request);
    const services = state.settings.searchServices as Array<Record<string, JsonValue>>;
    const byId = new Map(services.map((item) => [String(item.id), item]));
    const ordered = body.ids.map((itemId) => byId.get(String(itemId))).filter(Boolean) as JsonValue[];
    const rest = services.filter((item) => !body.ids.includes(String(item.id)));
    const searchServices = [...ordered, ...rest];
    const selectedId = body.selectedId ?? String(services[state.settings.searchServiceSelected]?.id ?? "");
    const selectedIndex = Math.max(0, searchServices.findIndex((item) => String((item as Record<string, JsonValue>).id) === selectedId));
    updateSettings({ ...state.settings, searchServices, searchServiceSelected: selectedIndex });
    return json({ status: "ok" });
  }
  if (path === "settings/search/service/detail" && request.method === "POST") {
    const body = await readJson<SearchService>(request);
    const service: SearchService = { ...body, id: String(body.id ?? id()) };
    const services = state.settings.searchServices as SearchService[];
    const existing = services.find((item) => String(item.id) === String(service.id));
    // Invalidate testPassed when any auth/endpoint field changes. Preset types
    // (bing_local, rikkahub) don't need testPassed gating — they always show in chat.
    if (existing && existing.testPassed === true) {
      const authFields = ["type", "apiKey", "url", "customUrl", "model", "username", "password", "engines"];
      const changed = authFields.some((key) => String(existing[key] ?? "") !== String(service[key] ?? ""));
      if (changed) {
        service.testPassed = false;
        service.testPassedAt = 0;
      } else {
        service.testPassed = existing.testPassed;
        service.testPassedAt = existing.testPassedAt;
      }
    }
    updateSettings({
      ...state.settings,
      searchServices: existing ? services.map((item) => (String(item.id) === String(service.id) ? service : item)) : [...services, service],
      searchServiceSelected: existing ? state.settings.searchServiceSelected : services.length,
    });
    return json({ status: "ok", service });
  }
  if (path === "settings/search/service/test" && request.method === "POST") {
    const body = await readJson<SearchService>(request);
    try {
      const result = await testSearchService(body);
      // Mark the persisted service as passing so the chat picker can include it.
      const services = state.settings.searchServices as SearchService[];
      const targetId = String(body.id ?? "");
      if (targetId) {
        updateSettings({
          ...state.settings,
          searchServices: services.map((item) =>
            String(item.id) === targetId ? { ...item, testPassed: true, testPassedAt: Date.now() } : item,
          ),
        });
      }
      return json(result);
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  const searchDelete = path.match(/^settings\/search\/service\/([^/]+)$/);
  if (searchDelete && request.method === "DELETE") {
    const idValue = decodeURIComponent(searchDelete[1]);
    const services = state.settings.searchServices as SearchService[];
    const nextServices = services.filter((item) => String(item.id) !== idValue);
    updateSettings({
      ...state.settings,
      searchServices: nextServices,
      searchServiceSelected: Math.min(state.settings.searchServiceSelected, Math.max(0, nextServices.length - 1)),
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/default-models" && request.method === "POST") {
    const body = await readJson<Partial<Settings>>(request);
    updateSettings({
      ...state.settings,
      chatModelId: String(body.chatModelId ?? state.settings.chatModelId),
      titleModelId: String(body.titleModelId ?? state.settings.titleModelId),
      translateModeId: String(body.translateModeId ?? state.settings.translateModeId),
      suggestionModelId: String(body.suggestionModelId ?? state.settings.suggestionModelId),
      imageGenerationModelId: String(body.imageGenerationModelId ?? state.settings.imageGenerationModelId),
      ocrModelId: String(body.ocrModelId ?? state.settings.ocrModelId),
      compressModelId: String(body.compressModelId ?? state.settings.compressModelId),
      titlePrompt: String(body.titlePrompt ?? state.settings.titlePrompt ?? DEFAULT_TITLE_PROMPT),
      translatePrompt: String(body.translatePrompt ?? state.settings.translatePrompt ?? DEFAULT_TRANSLATION_PROMPT),
      suggestionPrompt: String(body.suggestionPrompt ?? state.settings.suggestionPrompt ?? DEFAULT_SUGGESTION_PROMPT),
      ocrPrompt: String(body.ocrPrompt ?? state.settings.ocrPrompt ?? DEFAULT_OCR_PROMPT),
      compressPrompt: String(body.compressPrompt ?? state.settings.compressPrompt ?? DEFAULT_COMPRESS_PROMPT),
    });
    return json({ status: "ok" });
  }
  if (path === "settings/favorite-models" && request.method === "POST") {
    const body = await readJson<{ modelIds: string[] }>(request);
    updateSettings({ ...state.settings, favoriteModels: body.modelIds ?? [] });
    return json({ status: "ok" });
  }
  if (path === "settings/model/built-in-tool" && request.method === "POST") {
    const body = await readJson<{ modelId: string; tool: string; enabled: boolean }>(request);
    const toolName = String(body.tool ?? "").trim();
    updateSettings({
      ...state.settings,
      providers: state.settings.providers.map((providerItem) => ({
        ...providerItem,
        models: providerItem.models.map((modelItem) => {
          if (modelItem.id !== body.modelId) return modelItem;
          const existingTools = Array.isArray(modelItem.tools) ? modelItem.tools : [];
          const nextTools = body.enabled
            ? [...existingTools.filter((tool) => String((tool as Record<string, JsonValue>).type ?? tool) !== toolName), { type: toolName }]
            : existingTools.filter((tool) => String((tool as Record<string, JsonValue>).type ?? tool) !== toolName);
          return { ...modelItem, tools: nextTools };
        }),
      })),
    });
    return json({ status: "ok" });
  }
  if (path === "settings/provider" && request.method === "POST") {
    const body = await readJson<Provider>(request);
    updateSettings({
      ...state.settings,
      providers: state.settings.providers.some((item) => item.id === body.id)
        ? state.settings.providers.map((item) =>
          item.id === body.id
            ? {
                ...item,
                ...body,
                testPassed: item.testPassed === true ? true : body.testPassed,
                testPassedAt: item.testPassed === true ? item.testPassedAt : body.testPassedAt,
              }
            : item,
        )
        : [...state.settings.providers, { ...body, id: body.id || id(), builtIn: false }],
    });
    return json({ status: "ok" });
  }
  const providerDelete = path.match(/^settings\/provider\/([^/]+)$/);
  if (providerDelete && request.method === "DELETE") {
    const idValue = decodeURIComponent(providerDelete[1]);
    if (state.settings.providers.length <= 1) return error("At least one provider is required", 400);
    updateSettings({ ...state.settings, providers: state.settings.providers.filter((item) => item.id !== idValue) });
    return json({ status: "deleted" });
  }
  if (path === "settings/provider/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    const byId = new Map(state.settings.providers.map((item) => [item.id, item]));
    const ordered = body.ids.map((itemId) => byId.get(itemId)).filter(Boolean) as Provider[];
    const rest = state.settings.providers.filter((item) => !body.ids.includes(item.id));
    updateSettings({ ...state.settings, providers: [...ordered, ...rest] });
    return json({ status: "ok" });
  }
  if (path === "settings/provider/balance" && request.method === "POST") {
    const body = await readJson<{ providerId: string }>(request);
    const providerItem = state.settings.providers.find((item) => item.id === body.providerId);
    if (!providerItem) return error("Provider not found", 404);
    try {
      return json(await fetchProviderBalance(providerItem));
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "settings/provider/test" && request.method === "POST") {
    const body = await readJson<{ providerId: string; modelId?: string }>(request);
    const providerItem = state.settings.providers.find((item) => item.id === body.providerId);
    if (!providerItem) return error("Provider not found", 404);
    try {
      const result = await fetchProviderModels(providerItem);
      const selectedModel = firstProviderModel(providerItem, body.modelId, result.models);
      const checks = [];
      for (const mode of ["non_stream", "stream", "tools"] as const) {
        checks.push(await runProviderCheck(providerItem, mode, selectedModel, result.models).catch((err) => ({
          mode,
          ok: false,
          status: 0,
          endpoint: endpointFor(providerItem),
          preview: err instanceof Error ? err.message : String(err),
        })));
      }
      markProviderTestResult(providerItem, result.models, checks);
      return json({
        status: "ok",
        endpoint: result.endpoint,
        responseApiEndpoint: endpointFor(providerItem),
        testModelId: selectedModel,
        modelCount: result.models.length,
        models: result.models.slice(0, 20),
        checks,
        preview: result.preview,
      });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }

  if (path === "settings/provider/test/image" && request.method === "POST") {
    const body = await readJson<{ providerId: string; modelId?: string; prompt?: string }>(request);
    const providerItem = state.settings.providers.find((item) => item.id === body.providerId);
    if (!providerItem) return error("Provider not found", 404);
    const requestedModelId = String(body.modelId ?? "").trim();
    const modelItem = (providerItem.models ?? []).find((item) => item.modelId === requestedModelId)
      ?? (providerItem.models ?? []).find((item) => (item.type as string) === "IMAGE")
      ?? null;
    if (!modelItem) return error("No image model available for this provider", 400);
    // Borrow the existing image-generation pipeline by temporarily swapping the
    // imageGenerationModelId so callImageGeneration picks our target model.
    const previousImageId = state.settings.imageGenerationModelId;
    state.settings.imageGenerationModelId = modelItem.id;
    try {
      const prompt = String(body.prompt ?? "A red apple on a white background").trim() || "A red apple on a white background";
      const images = await callImageGeneration({ prompt, numberOfImages: 1, aspectRatio: "square" });
      const generated = images[0];
      if (!generated) return error("Image generation returned no images", 502);
      return json({
        status: "ok",
        modelId: modelItem.modelId,
        image: { url: generated.url, mime: generated.mime, fileName: generated.fileName },
      });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    } finally {
      state.settings.imageGenerationModelId = previousImageId;
    }
  }

  if (path === "settings/provider/test/stream" && request.method === "POST") {
    const body = await readJson<{ providerId: string; modelId?: string }>(request);
    const providerItem = state.settings.providers.find((item) => item.id === body.providerId);
    if (!providerItem) return error("Provider not found", 404);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, payload: JsonValue | object) => controller.enqueue(sseFrame(event, payload));
        try {
          send("progress", { message: "正在读取模型列表..." });
          const result = await fetchProviderModels(providerItem);
          const selectedModel = firstProviderModel(providerItem, body.modelId, result.models);
          send("models", {
            endpoint: result.endpoint,
            responseApiEndpoint: endpointFor(providerItem),
            testModelId: selectedModel,
            modelCount: result.models.length,
            models: result.models.slice(0, 20),
            preview: result.preview,
          });
          const checks = [];
          for (const mode of ["non_stream", "stream", "tools"] as const) {
            send("progress", { message: `正在测试 ${mode}...` });
            const check = await runProviderCheck(providerItem, mode, selectedModel, result.models).catch((err) => ({
              mode,
              ok: false,
              status: 0,
              endpoint: endpointFor(providerItem),
              preview: err instanceof Error ? err.message : String(err),
            }));
            checks.push(check);
            send("check", check);
          }
          markProviderTestResult(providerItem, result.models, checks);
          send("done", {
            status: "ok",
            endpoint: result.endpoint,
            responseApiEndpoint: endpointFor(providerItem),
            testModelId: selectedModel,
            modelCount: result.models.length,
            models: result.models.slice(0, 20),
            checks,
            preview: result.preview,
          });
        } catch (err) {
          send("error", { error: err instanceof Error ? err.message : String(err) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
  if (path === "settings/provider/models" && request.method === "POST") {
    const body = await readJson<{ providerId: string; save?: boolean }>(request);
    const providerItem = state.settings.providers.find((item) => item.id === body.providerId);
    if (!providerItem) return error("Provider not found", 404);
    try {
      const result = await fetchProviderModels(providerItem);
      if (body.save) {
        updateSettings({
          ...state.settings,
          providers: state.settings.providers.map((item) =>
            item.id === providerItem.id ? { ...item, models: result.models } : item,
          ),
        });
      }
      return json({ status: "ok", endpoint: result.endpoint, models: result.models, preview: result.preview });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }

  if (path === "conversations/batch-delete" && request.method === "POST") {
    const body = await readJson<{ ids?: string[] }>(request);
    const ids = new Set((body.ids ?? []).map(String).filter(Boolean));
    if (ids.size === 0) return error("No conversations selected", 400);
    deleteConversationsById(ids);
    return json({ status: "deleted", deleted: ids.size });
  }

  if (path === "conversations" && request.method === "GET") {
    return json(state.conversations.filter((item) => item.assistantId === state.settings.assistantId).map(toListDto));
  }
  if (path === "conversations/paged" && request.method === "GET") {
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "20");
    const query = (url.searchParams.get("query") ?? "").toLowerCase();
    const items = state.conversations
      .filter((item) => item.assistantId === state.settings.assistantId)
      .filter((item) => !query || item.title.toLowerCase().includes(query))
      .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.updateAt - a.updateAt);
    const page = items.slice(offset, offset + limit);
    return json({ items: page.map(toListDto), nextOffset: offset + limit < items.length ? offset + limit : null, hasMore: offset + limit < items.length });
  }
  if (path === "conversations/search" && request.method === "GET") {
    const queryText = (url.searchParams.get("query") ?? "").toLowerCase();
    const results = queryText
      ? state.conversations
          .filter((conversation) => conversation.assistantId === state.settings.assistantId)
          .flatMap((conversation) =>
            conversation.messages.flatMap((node) =>
            node.messages.flatMap((msg) => {
              const snippet = textFromParts(msg.parts);
              return snippet.toLowerCase().includes(queryText)
                ? [{ nodeId: node.id, messageId: msg.id, conversationId: conversation.id, title: conversation.title, updateAt: conversation.updateAt, snippet }]
                : [];
            }),
          ),
        )
      : [];
    return json(results);
  }

  const conversationStream = path.match(/^conversations\/([^/]+)\/stream$/);
  if (conversationStream) {
    const conversation = getConversation(conversationStream[1]);
    if (!conversation) return error("Conversation not found", 404);
    return openSse(
      () => [["snapshot", { type: "snapshot", seq: Date.now(), conversation: toConversationDto(conversation), serverTime: Date.now() }]],
      (controller) => {
        const set = conversationClients.get(conversation.id) ?? new Set<ReadableStreamDefaultController<Uint8Array>>();
        set.add(controller);
        conversationClients.set(conversation.id, set);
        return () => set.delete(controller);
      },
    );
  }

  const conversationRoute = path.match(/^conversations\/([^/]+)(?:\/(.*))?$/);
  if (conversationRoute) {
    const conversationId = conversationRoute[1];
    const sub = conversationRoute[2] ?? "";

    if (!sub && request.method === "DELETE") {
      deleteConversationsById(new Set([conversationId]));
      return new Response(null, { status: 204 });
    }
    const conversation = (sub === "messages" || sub === "system-prompt") && request.method === "POST"
      ? ensureConversation(conversationId)
      : getConversation(conversationId);
    if (!conversation) return error("Conversation not found", 404);

    if (!sub && request.method === "GET") return json(toConversationDto(conversation));
    if (sub === "messages" && request.method === "POST") {
      const body = await readJson<{ parts: JsonValue[] }>(request);
      const assistant = findAssistant(conversation.assistantId);
      const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
      const processedParts = applyInputRegexTransformParts(body.parts ?? [], assistant);
      const userMessage = message("USER", markOcrPendingParts(processedParts, picked.model));
      const userNode = { id: id(), messages: [userMessage], selectIndex: 0 };
      conversation.messages.push(userNode);
      conversation.chatSuggestions = [];
      conversation.updateAt = Date.now();
      if (!conversation.title) conversation.title = "New Conversation";
      saveState();
      broadcastConversation(conversation);
      void (async () => {
        userMessage.parts = await attachOcrToImageParts(userMessage.parts, picked.model);
        conversation.updateAt = Date.now();
        saveState();
        broadcastNodeUpdate(conversation, userNode);
        void generateAnswer(conversation);
      })();
      return json({ status: "accepted" }, { status: 202 });
    }
    if (sub === "pin" && request.method === "POST") {
      conversation.isPinned = !conversation.isPinned;
      conversation.updateAt = Date.now();
      saveState();
      broadcastConversation(conversation);
      return json({ status: "updated" });
    }
    if (sub === "title" && request.method === "POST") {
      const body = await readJson<{ title: string }>(request);
      conversation.title = body.title?.trim() || conversation.title;
      conversation.updateAt = Date.now();
      saveState();
      broadcastConversation(conversation);
      return json({ status: "updated" });
    }
    if (sub === "move" && request.method === "POST") {
      const body = await readJson<{ assistantId: string }>(request);
      conversation.assistantId = body.assistantId;
      conversation.updateAt = Date.now();
      saveState();
      broadcastConversation(conversation);
      return json({ status: "updated" });
    }
    if (sub === "system-prompt" && request.method === "POST") {
      const body = await readJson<{ systemPrompt?: string }>(request);
      conversation.systemPrompt = String(body.systemPrompt ?? "").trim() || null;
      conversation.updateAt = Date.now();
      saveState();
      broadcastConversation(conversation);
      return json({ status: "updated" });
    }
    if (sub === "stop" && request.method === "POST") {
      // Abort the in-flight upstream fetch. Some providers take a moment to actually close the
      // socket after `controller.abort()` returns, so we proactively flush any throttled state
      // and broadcast immediately — the UI shouldn't have to wait for the next streaming chunk.
      const controller = generating.get(conversation.id);
      controller?.abort();
      generating.delete(conversation.id);
      const lastNode = conversation.messages[conversation.messages.length - 1];
      if (lastNode) {
        const msg = lastNode.messages[lastNode.selectIndex];
        if (msg) {
          // Strip the loading placeholder — otherwise the user sees the typing "..." linger
          // because the placeholder part rendering doesn't depend on isGenerating.
          msg.parts = msg.parts.filter((part) => !(
            part && typeof part === "object" && !Array.isArray(part) && part.type === "loading"
          ));
          if (!msg.finishedAt) msg.finishedAt = new Date().toISOString();
        }
        broadcastNodeUpdate(conversation, lastNode);
      }
      conversation.updateAt = Date.now();
      saveState();
      broadcastConversation(conversation);
      return json({ status: "stopped" });
    }
    if (sub === "regenerate-title" && request.method === "POST") {
      try {
        conversation.title = await generateTitleForConversation(conversation);
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err), 400);
      }
      saveState();
      broadcastConversation(conversation);
      return json({ status: "updated", title: conversation.title });
    }
    if (sub === "regenerate" && request.method === "POST") {
      const body = await readJson<{ messageId?: string }>(request);
      truncateConversationForRegenerate(conversation, body.messageId);
      conversation.updateAt = Date.now();
      saveState();
      broadcastConversation(conversation);
      void generateAnswer(conversation);
      return json({ status: "accepted" }, { status: 202 });
    }
    const nodeSelect = sub.match(/^nodes\/([^/]+)\/select$/);
    if (nodeSelect && request.method === "POST") {
      const body = await readJson<{ selectIndex?: number }>(request);
      const node = conversation.messages.find((item) => item.id === decodeURIComponent(nodeSelect[1]));
      if (!node) return error("Node not found", 404);
      const nextIndex = Number(body.selectIndex ?? node.selectIndex);
      if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= node.messages.length) return error("Invalid branch index", 400);
      node.selectIndex = nextIndex;
      conversation.updateAt = Date.now();
      saveState();
      broadcastConversation(conversation);
      return json({ status: "updated" });
    }
    const messageDelete = sub.match(/^messages\/([^/]+)$/);
    if (messageDelete && request.method === "DELETE") {
      const messageId = decodeURIComponent(messageDelete[1]);
      let changed = false;
      conversation.messages = conversation.messages
        .map((node) => {
          const messages = node.messages.filter((msg) => msg.id !== messageId);
          if (messages.length !== node.messages.length) changed = true;
          return { ...node, messages, selectIndex: Math.min(node.selectIndex, Math.max(messages.length - 1, 0)) };
        })
        .filter((node) => node.messages.length > 0);
      if (!changed) return error("Message not found", 404);
      conversation.updateAt = Date.now();
      saveState();
      broadcastConversation(conversation);
      return json({ status: "deleted" });
    }
    const messageEdit = sub.match(/^messages\/([^/]+)\/edit$/);
    if (messageEdit && request.method === "POST") {
      const body = await readJson<{ parts?: JsonValue[] }>(request);
      const messageId = decodeURIComponent(messageEdit[1]);
      const nodeIndex = conversation.messages.findIndex((node) => node.messages.some((msg) => msg.id === messageId));
      if (nodeIndex < 0) return error("Message not found", 404);
      const node = conversation.messages[nodeIndex];
      const msgIndex = node.messages.findIndex((msg) => msg.id === messageId);
      const msg = node.messages[msgIndex];
      const assistant = findAssistant(conversation.assistantId);
      const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
      const editedParts = msg.role === "USER"
        ? applyInputRegexTransformParts(body.parts ?? msg.parts, assistant)
        : body.parts ?? msg.parts;
      msg.parts = markOcrPendingParts(editedParts, picked.model);
      msg.translation = null;
      msg.finishedAt = msg.role === "ASSISTANT" ? new Date().toISOString() : null;
      node.selectIndex = msgIndex;
      conversation.messages = conversation.messages.slice(0, nodeIndex + 1);
      conversation.chatSuggestions = [];
      conversation.updateAt = Date.now();
      saveState();
      broadcastConversation(conversation);
      if (msg.role === "USER") {
        void (async () => {
          msg.parts = await attachOcrToImageParts(msg.parts, picked.model);
          conversation.updateAt = Date.now();
          saveState();
          broadcastNodeUpdate(conversation, node);
          void generateAnswer(conversation);
        })();
      }
      return json({ status: "updated" }, { status: msg.role === "USER" ? 202 : 200 });
    }
    const messageTranslate = sub.match(/^messages\/([^/]+)\/translate$/);
    if (messageTranslate && request.method === "POST") {
      const body = await readJson<{ targetLanguage?: string }>(request).catch(() => ({ targetLanguage: "" }));
      const messageId = decodeURIComponent(messageTranslate[1]);
      const msg = conversation.messages.flatMap((node) => node.messages).find((item) => item.id === messageId);
      if (!msg) return error("Message not found", 404);
      const sourceText = textFromParts(msg.parts).trim();
      if (!sourceText) return error("Message has no text to translate", 400);
      const targetLanguage = String(body.targetLanguage ?? "").trim() || Intl.DateTimeFormat().resolvedOptions().locale;
      msg.translation = "正在翻译...";
      conversation.updateAt = Date.now();
      saveState();
      broadcastConversation(conversation);
      void (async () => {
        try {
          const pickedTranslationModel = findModel(state.settings.translateModeId || state.settings.chatModelId);
          const useQwenMt = isQwenMtModel(pickedTranslationModel.model.modelId);
          const prompt = useQwenMt
            ? sourceText
            : applyPlaceholders(state.settings.translatePrompt || DEFAULT_TRANSLATION_PROMPT, {
                source_text: sourceText,
                target_lang: targetLanguage,
              });
          let streamedTranslation = "";
          msg.translation = await fetchAuxiliaryText(state.settings.translateModeId, prompt, "translation", {
            reasoningLevel: useQwenMt ? null : (state.settings.translateThinkingBudget ?? 0) > 0 ? "LOW" : null,
            temperature: useQwenMt ? 0.3 : null,
            topP: useQwenMt ? 0.95 : null,
            customBody: useQwenMt
              ? { translation_options: { source_lang: "auto", target_lang: englishLanguageName(targetLanguage) } }
              : undefined,
            stream: !useQwenMt,
            onDelta: (delta) => {
              streamedTranslation += delta;
              msg.translation = streamedTranslation || "正在翻译...";
              conversation.updateAt = Date.now();
              saveState();
              broadcastConversation(conversation);
            },
          });
        } catch (err) {
          msg.translation = `翻译失败：${err instanceof Error ? err.message : String(err)}`;
        } finally {
          conversation.updateAt = Date.now();
          saveState();
          broadcastConversation(conversation);
        }
      })();
      return json({ status: "accepted", translation: msg.translation }, { status: 202 });
    }
    if (sub === "compress" && request.method === "POST") {
      const body = await readJson<{ additionalPrompt?: string; targetTokens?: number; keepRecentMessages?: number }>(request);
      try {
        const summaries = await compressConversation(
          conversation,
          String(body.additionalPrompt ?? ""),
          Math.max(256, Number(body.targetTokens ?? 2000) || 2000),
          Math.max(0, Number(body.keepRecentMessages ?? 32) || 0),
        );
        return json({ status: "compressed", summaries });
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err), 400);
      }
    }
    if (sub === "fork" && request.method === "POST") {
      const body = await readJson<{ messageId?: string }>(request);
      const messageId = String(body.messageId ?? "");
      const nodeIndex = conversation.messages.findIndex((node) => node.messages.some((msg) => msg.id === messageId));
      if (nodeIndex < 0) return error("Message not found", 404);
      const fork: Conversation = {
        ...JSON.parse(JSON.stringify(conversation)),
        id: id(),
        title: conversation.title ? `${conversation.title} Fork` : "Fork",
        messages: JSON.parse(JSON.stringify(conversation.messages.slice(0, nodeIndex + 1))),
        isPinned: false,
        createAt: Date.now(),
        updateAt: Date.now(),
      };
      state.conversations.unshift(fork);
      saveState();
      broadcastList();
      return json({ conversationId: fork.id });
    }
    if (sub === "tool-approval" && request.method === "POST") {
      const body = await readJson<{ toolCallId?: string; approved?: boolean; reason?: string; answer?: string }>(request);
      let changed = false;
      for (const node of conversation.messages) {
        for (const msg of node.messages) {
          msg.parts = msg.parts.map((part) => {
            if (!part || typeof part !== "object" || Array.isArray(part) || part.type !== "tool" || part.toolCallId !== body.toolCallId) return part;
            changed = true;
            return {
              ...part,
              approvalState: body.approved
                ? { type: body.answer ? "answered" : "approved", answer: body.answer ?? "" }
                : { type: "denied", reason: body.reason ?? "" },
            };
          });
        }
      }
      if (!changed) return error("Tool call not found", 404);
      conversation.updateAt = Date.now();
      saveState();
      broadcastConversation(conversation);
      const hasPendingTools = conversation.messages.some((node) =>
        node.messages.some((msg) => hasPendingToolApproval(msg))
      );
      if (!hasPendingTools) {
        void generateAnswer(conversation);
        return json({ status: "accepted" }, { status: 202 });
      }
      return json({ status: "updated" });
    }
  }

  if (path === "files/upload" && request.method === "POST") {
    const form = await request.formData();
    const uploaded = await Promise.all(
      form.getAll("files").filter((item): item is File => item instanceof File).map(async (file) => {
        const fileId = state.nextFileId++;
        const target = join(filesDir, `${fileId}${extname(file.name)}`);
        await Bun.write(target, file);
        const entry: StoredFile = { id: fileId, path: target, fileName: file.name, mime: file.type || "application/octet-stream", size: file.size };
        const extractedText = extractStoredFileText(entry);
        if (extractedText) {
          entry.extractedText = extractedText;
          entry.extractedAt = Date.now();
        }
        state.files.push(entry);
        return {
          id: fileId,
          url: `/api/files/${fileId}/content`,
          fileName: entry.fileName,
          mime: entry.mime,
          size: entry.size,
          extractedTextLength: entry.extractedText?.length ?? 0,
        };
      }),
    );
    saveState();
    return json({ files: uploaded });
  }
  const fileContent = path.match(/^files\/(\d+)\/content$/);
  if (fileContent) {
    const entry = state.files.find((item) => item.id === Number(fileContent[1]));
    if (!entry || !existsSync(entry.path)) return error("File not found", 404);
    return new Response(Bun.file(entry.path), { headers: { "Content-Type": entry.mime } });
  }
  const fileByPath = path.match(/^files\/path\/(.+)$/);
  if (fileByPath) {
    const target = safeDataFilePath(fileByPath[1]);
    if (!target) return error("File not found", 404);
    return new Response(Bun.file(target), { headers: { "Content-Type": mime(target) } });
  }
  const fileDelete = path.match(/^files\/(\d+)$/);
  if (fileDelete && request.method === "DELETE") {
    state.files = state.files.filter((item) => item.id !== Number(fileDelete[1]));
    saveState();
    return json({ status: "deleted" });
  }

  if (path === "skills" && request.method === "GET") return json(listSkills());
  const skillFiles = path.match(/^skills\/([^/]+)\/files$/);
  if (skillFiles && request.method === "GET") {
    const name = decodeURIComponent(skillFiles[1]);
    const metadata = skillMetadataFromFile(name);
    if (!metadata) return error("Skill not found", 404);
    return json({ files: listSkillFiles(name) });
  }
  const skillDetail = path.match(/^skills\/([^/]+)$/);
  if (skillDetail && request.method === "GET") {
    const name = decodeURIComponent(skillDetail[1]);
    const metadata = skillMetadataFromFile(name);
    const content = readSkillContent(name);
    if (!metadata || content == null) return error("Skill not found", 404);
    return json({ ...metadata, content });
  }
  if (path === "skills/detail" && request.method === "POST") {
    const body = await readJson<{ name?: string; content?: string }>(request);
    const requestedName = String(body.name ?? parseSkillFrontmatter(body.content ?? "").name ?? "new-skill").trim();
    const dir = safeSkillDir(requestedName);
    if (!dir) return error("Invalid skill name", 400);
    mkdirSync(dir, { recursive: true });
    const content = String(body.content ?? defaultSkillContent(requestedName));
    writeFileSync(join(dir, "SKILL.md"), content);
    const metadata = skillMetadataFromFile(requestedName);
    if (!metadata) return error("Skill frontmatter must include name and description", 400);
    return json({ status: "ok", skill: { ...metadata, content } });
  }
  if (path === "skills/import-github" && request.method === "POST") {
    const body = await readJson<{ repoUrl?: string }>(request);
    try {
      const skill = await importSkillFromGitHub(String(body.repoUrl ?? ""));
      return json({ status: "ok", skill });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (skillDetail && request.method === "DELETE") {
    const name = decodeURIComponent(skillDetail[1]);
    const dir = safeSkillDir(name);
    if (!dir || !existsSync(dir)) return error("Skill not found", 404);
    rmSync(dir, { recursive: true, force: true });
    updateSettings({
      ...state.settings,
      assistants: state.settings.assistants.map((assistant) => ({
        ...assistant,
        enabledSkills: assistant.enabledSkills.filter((skillName) => skillName !== name),
      })),
    });
    return json({ status: "deleted" });
  }

  if (path === "logs" && request.method === "GET") return json(state.logs);
  if (path === "stats" && request.method === "GET") return json(computeStats());
  if (path === "data/webdav/config" && request.method === "POST") {
    const body = await readJson<Partial<WebDavConfig>>(request);
    const webDavConfig = normalizeWebDavConfig(body);
    updateSettings({ ...state.settings, webDavConfig });
    return json({ status: "ok", config: webDavConfig });
  }
  if (path === "data/webdav/test" && request.method === "POST") {
    const config = normalizeWebDavConfig((await readJson<{ config?: Partial<WebDavConfig> }>(request)).config ?? state.settings.webDavConfig);
    try {
      await webDavEnsureCollection(config);
      return json({ status: "ok" });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "data/webdav/list" && request.method === "GET") {
    try {
      return json({ items: await webDavListBackups(state.settings.webDavConfig) });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "data/webdav/backup" && request.method === "POST") {
    try {
      const result = await webDavBackup(state.settings.webDavConfig);
      return json({ status: "ok", ...result, items: await webDavListBackups(state.settings.webDavConfig) });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "data/webdav/restore" && request.method === "POST") {
    const body = await readJson<{ fileName?: string }>(request);
    const fileName = String(body.fileName ?? "").trim();
    if (!fileName || fileName.includes("/") || fileName.includes("\\")) return error("Invalid WebDAV backup file name", 400);
    try {
      await webDavRestore(state.settings.webDavConfig, fileName);
      return json({ status: "restored", settings: state.settings });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "data/webdav/delete" && request.method === "POST") {
    const body = await readJson<{ fileName?: string }>(request);
    const fileName = String(body.fileName ?? "").trim();
    if (!fileName || fileName.includes("/") || fileName.includes("\\")) return error("Invalid WebDAV backup file name", 400);
    try {
      await webDavDelete(state.settings.webDavConfig, fileName);
      return json({ status: "deleted", items: await webDavListBackups(state.settings.webDavConfig) });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "data/s3/config" && request.method === "POST") {
    const body = await readJson<Partial<S3Config>>(request);
    const s3Config = normalizeS3Config(body);
    updateSettings({ ...state.settings, s3Config });
    return json({ status: "ok", config: s3Config });
  }
  if (path === "data/s3/test" && request.method === "POST") {
    const config = normalizeS3Config((await readJson<{ config?: Partial<S3Config> }>(request)).config ?? state.settings.s3Config);
    try {
      await s3TestConnection(config);
      return json({ status: "ok" });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "data/s3/list" && request.method === "GET") {
    try {
      return json({ items: await s3ListBackups(state.settings.s3Config) });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "data/s3/backup" && request.method === "POST") {
    try {
      const result = await s3Backup(state.settings.s3Config);
      return json({ status: "ok", ...result, items: await s3ListBackups(state.settings.s3Config) });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "data/s3/restore" && request.method === "POST") {
    const body = await readJson<{ fileName?: string }>(request);
    const fileName = String(body.fileName ?? "").trim();
    if (!fileName || fileName.includes("\\")) return error("Invalid S3 backup file name", 400);
    try {
      await s3Restore(state.settings.s3Config, fileName);
      return json({ status: "restored", settings: state.settings });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "data/s3/delete" && request.method === "POST") {
    const body = await readJson<{ fileName?: string }>(request);
    const fileName = String(body.fileName ?? "").trim();
    if (!fileName || fileName.includes("\\")) return error("Invalid S3 backup file name", 400);
    try {
      await s3Delete(state.settings.s3Config, fileName);
      return json({ status: "deleted", items: await s3ListBackups(state.settings.s3Config) });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "settings/proxy" && request.method === "POST") {
    const body = await readJson<Partial<ProxyConfig>>(request);
    const proxyConfig = normalizeProxyConfig(body);
    updateSettings({ ...state.settings, proxyConfig });
    applyEffectiveProxy();
    return json({ status: "ok", config: proxyConfig, ...proxyStatusPayload() });
  }
  if (path === "settings/proxy/detect" && request.method === "POST") {
    const detected = readWindowsSystemProxy();
    return json({ detected: detected ?? null });
  }
  if (path === "settings/proxy/status" && request.method === "GET") {
    return json(proxyStatusPayload());
  }
  if (path === "data/export" && request.method === "GET") {
    const payload = backupPayload();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="rikkahub-pc-backup-${stamp}.json"`,
      },
    });
  }
  if (path === "data/import" && request.method === "POST") {
    const body = await readJson<{ state?: Partial<State>; skills?: unknown } & Partial<State>>(request);
    try {
      applyBackupPayload(body);
    } catch {
      return error("Invalid backup file", 400);
    }
    return json({ status: "imported", settings: state.settings });
  }

  if (path === "settings/asr-provider/detail" && request.method === "POST") {
    const body = await readJson<Partial<AsrProvider>>(request);
    const type = ["dashscope", "volcengine", "openai_realtime"].includes(String(body.type))
      ? String(body.type) as AsrProvider["type"]
      : "openai_realtime";
    const base = defaultAsrProvider(type);
    const providerItem = normalizeAsrProviders([{ ...base, ...body, type, id: String(body.id ?? base.id) }])[0];
    const exists = state.settings.asrProviders.some((item) => item.id === providerItem.id);
    updateSettings({
      ...state.settings,
      asrProviders: exists
        ? state.settings.asrProviders.map((item) => item.id === providerItem.id ? providerItem : item)
        : [providerItem, ...state.settings.asrProviders],
      selectedASRProviderId: state.settings.selectedASRProviderId ?? providerItem.id,
    });
    return json({ status: "ok", provider: providerItem });
  }
  if (path === "settings/asr-provider/select" && request.method === "POST") {
    const body = await readJson<{ id: string }>(request);
    const providerId = String(body.id ?? "");
    if (!state.settings.asrProviders.some((provider) => provider.id === providerId)) return error("ASR provider not found", 404);
    updateSettings({ ...state.settings, selectedASRProviderId: providerId });
    return json({ status: "ok" });
  }
  const asrProviderDelete = path.match(/^settings\/asr-provider\/([^/]+)$/);
  if (asrProviderDelete && request.method === "DELETE") {
    const providerId = decodeURIComponent(asrProviderDelete[1]);
    const asrProviders = state.settings.asrProviders.filter((provider) => provider.id !== providerId);
    updateSettings({
      ...state.settings,
      asrProviders,
      selectedASRProviderId: state.settings.selectedASRProviderId === providerId ? asrProviders[0]?.id ?? null : state.settings.selectedASRProviderId,
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/asr-provider/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    const byId = new Map(state.settings.asrProviders.map((provider) => [provider.id, provider]));
    const reordered = (body.ids ?? []).map((providerId) => byId.get(providerId)).filter(Boolean) as AsrProvider[];
    for (const provider of state.settings.asrProviders) {
      if (!reordered.some((item) => item.id === provider.id)) reordered.push(provider);
    }
    updateSettings({ ...state.settings, asrProviders: reordered });
    return json({ status: "ok" });
  }

  if (path === "settings/tts-provider/detail" && request.method === "POST") {
    const body = await readJson<Partial<TtsProvider>>(request);
    const type = ["system", "openai", "gemini", "minimax", "qwen", "groq", "xai", "mimo"].includes(String(body.type)) ? body.type as TtsProvider["type"] : "system";
    const base = defaultTtsProvider(type);
    const providerItem = normalizeTtsProviders([{ ...base, ...body, type, id: String(body.id ?? base.id) }])[0];
    const exists = state.settings.ttsProviders.some((item) => item.id === providerItem.id);
    updateSettings({
      ...state.settings,
      ttsProviders: exists
        ? state.settings.ttsProviders.map((item) => item.id === providerItem.id ? providerItem : item)
        : [providerItem, ...state.settings.ttsProviders],
      selectedTTSProviderId: state.settings.selectedTTSProviderId ?? providerItem.id,
    });
    return json({ status: "ok", provider: providerItem });
  }
  if (path === "settings/tts-provider/select" && request.method === "POST") {
    const body = await readJson<{ id: string }>(request);
    const providerId = String(body.id ?? "");
    if (!state.settings.ttsProviders.some((provider) => provider.id === providerId)) return error("TTS provider not found", 404);
    updateSettings({ ...state.settings, selectedTTSProviderId: providerId });
    return json({ status: "ok" });
  }
  const ttsProviderDelete = path.match(/^settings\/tts-provider\/([^/]+)$/);
  if (ttsProviderDelete && request.method === "DELETE") {
    const providerId = decodeURIComponent(ttsProviderDelete[1]);
    if (providerId === DEFAULT_SYSTEM_TTS_ID) return error("System TTS provider cannot be deleted", 400);
    const ttsProviders = state.settings.ttsProviders.filter((provider) => provider.id !== providerId);
    updateSettings({
      ...state.settings,
      ttsProviders,
      selectedTTSProviderId: state.settings.selectedTTSProviderId === providerId ? ttsProviders[0]?.id ?? null : state.settings.selectedTTSProviderId,
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/tts-provider/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    const byId = new Map(state.settings.ttsProviders.map((provider) => [provider.id, provider]));
    const reordered = (body.ids ?? []).map((providerId) => byId.get(providerId)).filter(Boolean) as TtsProvider[];
    for (const provider of state.settings.ttsProviders) {
      if (!reordered.some((item) => item.id === provider.id)) reordered.push(provider);
    }
    updateSettings({ ...state.settings, ttsProviders: reordered });
    return json({ status: "ok" });
  }

  if (path === "tts/speech" && request.method === "POST") {
    const body = await readJson<{ text?: string; providerId?: string }>(request);
    const text = String(body.text ?? "").trim();
    if (!text) return error("Text is required", 400);
    try {
      const result = await generateSpeechWithTtsProvider(text, body.providerId);
      if (!result.audio) return json({ status: "spoken", providerId: result.provider.id });
      return new Response(result.audio, {
        headers: {
          "Content-Type": result.mime,
          "Cache-Control": "no-store",
          "X-RikkaHub-TTS-Provider": result.provider.id,
        },
      });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }

  if (path === "asr/transcribe" && request.method === "POST") {
    const form = await request.formData();
    const file = form.get("audio");
    if (!(file instanceof File)) return error("No audio file uploaded", 400);
    try {
      const text = await transcribeAudioWithAsrProvider(file);
      return json({ status: "ok", text });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }

  if (path === "images" && request.method === "GET") {
    return json({ images: state.generatedImages });
  }
  if (path === "images/generate" && request.method === "POST") {
    const body = await readJson<{ prompt: string; numberOfImages?: number; aspectRatio?: string; referenceFileIds?: number[] }>(request);
    if (!String(body.prompt ?? "").trim()) return error("Prompt is required", 400);
    try {
      const images = await callImageGeneration({
        prompt: String(body.prompt).trim(),
        numberOfImages: Number(body.numberOfImages ?? 1),
        aspectRatio: String(body.aspectRatio ?? "square"),
        referenceFileIds: Array.isArray(body.referenceFileIds) ? body.referenceFileIds.map(Number).filter(Number.isFinite) : [],
      });
      return json({ status: "ok", images });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  const generatedImageDelete = path.match(/^images\/([^/]+)$/);
  if (generatedImageDelete && request.method === "DELETE") {
    const imageId = decodeURIComponent(generatedImageDelete[1]);
    state.generatedImages = state.generatedImages.filter((image) => image.id !== imageId);
    saveState();
    return json({ status: "deleted" });
  }

  return error("Not found", 404);
}

function mime(path: string) {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

async function routeStatic(url: URL) {
  const candidates = [
    resolve(executableDir, "web-ui", "build", "client"),
    resolve(executableDir, "web-ui", "build"),
    resolve(rootDir, "web-ui", "build", "client"),
    resolve(rootDir, "web-ui", "build"),
    resolve(rootDir, "web-ui", "dist"),
  ];
  const staticRoot = candidates.find((candidate) => existsSync(join(candidate, "index.html")));
  if (!staticRoot) {
    return new Response("web-ui is not built. Run `cd web-ui && bun install && bun run build`.", { status: 200 });
  }
  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const target = resolve(staticRoot, requested);
  if (target.startsWith(staticRoot) && existsSync(target)) {
    return new Response(Bun.file(target), { headers: { "Content-Type": mime(target) } });
  }
  return new Response(Bun.file(join(staticRoot, "index.html")), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// Tolerate both layouts: when run via `bun run server.ts`, argv[0..1] are bun + script;
// when run as a `bun build --compile` exe, argv[0] is the exe itself. `slice(1)` strips
// the leading process binary in both cases, leaving just user flags.
const args = new Set(Bun.argv.slice(1));
const portIndex = Bun.argv.findIndex((arg) => arg === "--port");
const portEqualsArg = Bun.argv.find((arg) => arg.startsWith("--port="));
const portValue = portEqualsArg?.split("=")[1] ?? (portIndex >= 0 ? Bun.argv[portIndex + 1] : undefined);
const port = Number(portValue ?? process.env.PORT ?? "8080");

const server = Bun.serve({
  port,
  idleTimeout: 0,
  async fetch(request, server) {
    server.timeout(request, 0);
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/asr/realtime" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const upgraded = server.upgrade(request, { data: { kind: "asr" } });
        return upgraded ? undefined : error("WebSocket upgrade failed", 400);
      }
      if (url.pathname.startsWith("/api/")) return await routeApi(request, url);
      return await routeStatic(url);
    } catch (err) {
      console.error(err);
      return error(err instanceof Error ? err.message : String(err), 500);
    }
  },
  websocket: {
    message(ws, data) {
      if ((ws.data as { kind?: string } | undefined)?.kind !== "asr") return;
      if (typeof data === "string") {
        const payload = JSON.parse(data || "{}") as { type?: string; providerId?: string };
        if (payload.type === "start") startAsrRealtimeSession(ws, payload.providerId);
        if (payload.type === "stop") stopAsrRealtimeSession(ws);
        return;
      }
      const session = asrRealtimeSessions.get(ws);
      if (!session) return;
      const buffer = data instanceof ArrayBuffer
        ? data
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      sendAsrAudio(session, buffer);
    },
    close(ws) {
      if ((ws.data as { kind?: string } | undefined)?.kind === "asr") stopAsrRealtimeSession(ws);
    },
  },
});

console.log(`RikkaHub PC server running at http://localhost:${port}`);
console.log(`Data directory: ${dataDir}`);
console.log("Press Ctrl+C to stop RikkaHub PC.");

function shutdown() {
  server.stop(true);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (!args.has("--dev") && !args.has("--no-open")) {
  const opener = process.platform === "win32" ? "cmd" : "sh";
  const command = process.platform === "win32"
    ? ["/c", "start", `http://localhost:${port}`]
    : ["-c", `open http://localhost:${port} || xdg-open http://localhost:${port}`];
  Bun.spawn([opener, ...command], { stdout: "ignore", stderr: "ignore" });
}
