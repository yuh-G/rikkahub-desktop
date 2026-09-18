// foundation/types.ts — 共享类型（从 server.ts 迁出）
// 纪律：本文件只放类型，不放运行时值，不引入副作用。

import type { Settings } from "./settings";
import type { MessagePart } from "./parts";

export * from "./parts";
export * from "./dto";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue | undefined };

export interface Model {
  id: string;
  modelId: string;
  displayName: string;
  type: "CHAT" | "IMAGE" | "EMBEDDING";
  inputModalities: string[];
  outputModalities: string[];
  abilities: string[];
  tools: JsonValue[];
  // 以下为可选持久化字段(normalize/enrichModel 展开透传,老数据无此字段)。
  // 对齐安卓 Model.kt;web-ui 的 ProviderModel 是其 UI 视图形状。
  customHeaders?: JsonValue[];
  customBodies?: JsonValue[];
  /** 每模型供应商覆写:非空时请求构建期整体替换父 provider(见 model-providers findModel)。 */
  providerOverwrite?: Partial<Provider> | null;
  /** 手动“+”添加的模型(modelId 用户可编辑);获取列表得到的模型无此标记,前端锁定 id。 */
  manuallyAdded?: boolean;
}

export interface Provider {
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
  // 对齐安卓 ProviderSetting.responsesPath(commit §2.3):Responses API 的请求路径,
  // 默认 /responses,仅 useResponseApi 开启时生效。Azure/自建网关把 Responses 挂在
  // 非标准路径时由用户改这里;留空回落 /responses。与 chatCompletionsPath 同语义、
  // 互斥生效(同一时刻只有一个路径被 endpointFor 采用)。
  responsesPath?: string;
  // 对齐安卓 commit e63d017：OpenAI provider 是否在历史回放里把
  // assistant 的 reasoning_content 也回传给上游。默认 true（保持过去行为）；
  // 用户可以为某些代理/平台关闭，避免它们因为不识别这个字段而拒绝请求。
  includeHistoryReasoning?: boolean;
  promptCaching?: boolean;
  promptCacheTtl?: "5m" | "1h";
  // 专题12:OpenAI 系请求附带 prompt_cache_key=会话ID,官方端据此把同一会话路由到
  // 同一缓存分片提高命中率(codex 同款)。第三方兼容端可能不识别该字段报 400,
  // 故做成 provider 级开关,默认关。
  promptCacheKey?: boolean;
  testPassed?: boolean;
  testPassedAt?: number;
  models: Model[];
  balanceOption: {
    enabled: boolean;
    apiPath: string;
    resultPath: string;
  };
}

export interface WebDavConfig {
  url: string;
  username: string;
  password: string;
  path: string;
  items: string[];
}

export interface S3Config {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  pathStyle: boolean;
  items: string[];
}

export type ProxyMode = "auto" | "manual" | "direct" | "env";

export interface ProxyConfig {
  // 代理模式:
  // - auto: 跟随系统代理(Windows 注册表 / GNOME gsettings), 配合活性探测自动降级
  // - manual: 使用 url 指定的固定代理, 同样支持活性探测与降级
  // - direct: 强制直连, 完全忽略系统代理声明(系统代理失效时的逃生口)
  // - env: 完全由 HTTPS_PROXY/HTTP_PROXY 环境变量控制(Docker 部署), UI 只读
  mode: ProxyMode;
  // manual 模式下的代理地址(auto/direct/env 下被忽略)。空字符串在 manual 下等同直连。
  url: string;
  // Optional HTTP basic auth credentials, applied as `http://user:pass@host:port` when
  // forwarding to upstream APIs. 仅 manual 模式生效。
  username: string;
  password: string;
  // 代理绕过规则: 逗号分隔的域名/通配符列表, 命中的 URL 直连不走代理。
  // 例 "*.internal.corp,10.0.0.0/8,git.company.com"。localhost/127.0.0.1/::1 永远 bypass(硬编码)。
  // 仅 mode=auto/manual 生效; env(Docker) / direct 忽略。
  bypassRules: string;
  // 自定义 User-Agent(对齐安卓 networkSetting.userAgent)。空串 = 用品牌默认
  // RikkaHub-Desktop/<version>(resolveUserAgent)。仅填了才覆盖默认值。
  // 备份面:随 proxyConfig 走——给安卓的 settings.json 剥离 proxyConfig(其 userAgent 在
  // networkSetting 下,本就不透传);pc-backup.json 完整保留(PC→PC 跨机恢复带上,合理)。
  userAgent?: string;
}

export interface Assistant {
  id: string;
  chatModelId: string | null;
  name: string;
  avatar: Record<string, JsonValue>;
  useAssistantAvatar: boolean;
  tags: string[];
  systemPrompt: string;
  temperature: number | null;
  topP: number | null;
  // 专题3 F-1:与安卓 Assistant.contextMessageLimit 同名对齐(2026-07 安卓把
  // contextMessageSize 改名,语义同为"上下文最多携带的消息条数",0 = 不限)。
  // 老数据的 contextMessageSize 由 normalizeState 一次性搬运。
  contextMessageLimit: number;
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
  // Per-assistant MCP-tool overrides. Outer key = MCP server id, inner key = tool name, value
  // = { enable?: boolean, needsApproval?: boolean }. PC-only extension (Android's McpPicker
  // is server-level only). Override semantics:
  //   - global tool.enable === false  → tool hidden everywhere, override irrelevant
  //   - global tool.enable === true && override.enable === false  → tool not exposed to the
  //     model for THIS assistant (other assistants still see it)
  //   - override.needsApproval !== undefined  → overrides the global per-tool needsApproval
  //     for THIS assistant (true forces approval prompt, false skips it)
  //   - missing override entry → behave as the global tool definition
  // Default `{}` = inherit everything from the global tool list.
  mcpToolOverrides: Record<string, Record<string, { enable?: boolean; needsApproval?: boolean }>>;
  localTools: JsonValue[];
  background: string | null;
  backgroundOpacity: number;
  modeInjectionIds: string[];
  lorebookIds: string[];
  enabledSkills: string[];
  enableTimeReminder: boolean;
  allowConversationSystemPrompt: boolean;
  /** 专题9:允许"会话级"绑定提示词注入/世界书(对齐安卓 Assistant.allowConversationPromptInjection)。
   *  开启后生效的注入 id 集来自 Conversation.modeInjectionIds/lorebookIds,完全取代助手级集合。 */
  allowConversationPromptInjection: boolean;
}

export interface AsrProvider {
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

export interface TtsProvider {
  // type 是跨端共享枚举：PC 导出的备份会被 Android kotlinx.serialization 反序列化，
  // 新增取值必须逐字等于 Android TTSProviderSetting 的 @SerialName（§4.5）。
  type:
    | "system" | "openai" | "gemini" | "minimax" | "qwen" | "groq" | "xai" | "mimo"
    | "elevenlabs" | "step" | "fish-audio" | "volcengine";
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  model?: string;
  voice?: string;
  voiceName?: string;
  voiceId?: string;
  language?: string;
  // languageType 仅旧版 qwen3-tts 使用;qwen-audio-3.0 起改用 format/sampleRate,字段保留防丢数据。
  languageType?: string;
  emotion?: string;
  speed?: number;
  speechRate?: number;
  pitch?: number;
  // qwen-audio-3.0 / fish-audio / step 的音频格式与采样率。
  format?: string;
  sampleRate?: number;
  // elevenlabs
  stability?: number;
  similarityBoost?: number;
  // step(camelCase 协议; instruction 仅 stepaudio-2.5-tts 生效)
  responseFormat?: string;
  volume?: number;
  instruction?: string;
  // fish-audio(referenceId=克隆音色; prosody 用 speed)
  referenceId?: string;
  temperature?: number;
  topP?: number;
  chunkLength?: number;
  normalize?: boolean;
  latency?: string;
  // volcengine(豆包语音;speaker=音色 ID,resourceId 与开通服务绑定)
  speaker?: string;
  resourceId?: string;
}

export interface Message {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM" | "TOOL";
  parts: MessagePart[];
  annotations: JsonValue[];
  createdAt: string;
  finishedAt: string | null;
  modelId: string | null;
  usage: JsonValue | null;
  translation: string | null;
}

export interface MessageNode {
  id: string;
  messages: Message[];
  selectIndex: number;
}

export interface AssistantMemory {
  id: number;
  assistantId: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

// 记忆写入策略(模型提议记忆时应用如何处理)。阶段 3 启用,阶段 2 先加字段。
// - "ask":进待确认队列,用户事后确认存哪层(默认)
// - "always_assistant":直接存为当前助手记忆(助手层未启用则降级 ask)
// - "always_global":直接存为全局记忆(全局未启用则降级 ask)
// - "readonly":不暴露写入工具,只注入已有记忆
export type WriteStrategy = "ask" | "always_assistant" | "always_global" | "readonly";

export interface MemorySettings {
  globalEnabled: boolean;       // 启用全局记忆层(注入 + 可写)
  writeStrategy: WriteStrategy;
}

export interface Conversation {
  id: string;
  assistantId: string;
  systemPrompt: string | null;
  title: string;
  messages: MessageNode[];
  chatSuggestions: string[];
  isPinned: boolean;
  createAt: number;
  updateAt: number;
  /** 专题9:会话级绑定的注入/世界书 id(仅当助手开启 allowConversationPromptInjection 时生效,
   *  对齐安卓 Conversation.modeInjectionIds/lorebookIds)。缺省 = 空集。 */
  modeInjectionIds?: string[];
  lorebookIds?: string[];
  /** 工作区归属(agent 模式)。null/缺省 = 对话模式。创建时绑定,不随会话迁移。
   *  仅存 PC 自有库;跨端导出白名单不含此列(工作区会话到安卓降级为普通对话,§9.1)。 */
  workspaceId?: string | null;
  /** 会话级工作目录(绝对路径,必须在 workspace root 边界内)。null = workspace root。 */
  workspaceCwd?: string | null;
  /** P7 会话数据统一:引擎压缩记录数组(元素 {cutMessageId,summary,tokensBefore,
   *  createdAt}),SQLite 单一事实源下压缩状态的唯一载体。压缩记录是引擎中性的
   *  会话级状态(T3 泛化:压缩是引擎无关能力,不再绑死 pi)。切点为消息 id,从切点(含)
   *  起保留原文、之前历史被 summary 取代;只有"切点仍在选中路径"的最新一条生效
   *  (编码器自校验,编辑/fork 后失效记录自动跳过)。仅存 PC 自有库;跨端导出
   *  白名单不含此列。 */
  engineCompactions?: JsonValue[] | null;
}

// ----- 工作区(agent 模式)领域模型 -----

export type WorkspaceType = "managed" | "folder";

/** 审批档位(§3.2):read 恒免审;confirm_each=write/edit/bash 全审批;
 *  balanced=区内写免审、bash 审批;full_access=全免审(危险命令拦截独立于档位,恒生效)。 */
export type WorkspacePermissionPreset = "confirm_each" | "balanced" | "full_access";

/** 运行时健康状态(计算属性,不落库):missing = 根目录丢失(对齐安卓 BROKEN 语义,不静默删记录)。 */
export type WorkspaceStatus = "ready" | "missing";

export interface Workspace {
  id: string;
  name: string;
  type: WorkspaceType;
  /** 边界根(绝对路径)。managed 型指向 dataDir/workspaces/<id>/files(载入时由 dataDir 计算,
   *  DB 存空串——数据目录整体搬迁后自愈);folder 型为用户选择的真实目录(DB 存绝对路径)。 */
  root: string;
  permissionPreset: WorkspacePermissionPreset;
  /** 信任门通过时间(§3.3)。managed 型创建即信任;folder 型 null = 未过信任门。 */
  trustedAt: number | null;
  createAt: number;
  updateAt: number;
  lastAccessAt: number;
}

export interface PcWorkspaceRow {
  id: string;
  name: string;
  type: string;
  root: string;
  permission_preset: string;
  trusted_at: number | null;
  create_at: number;
  update_at: number;
  last_access_at: number;
}

export interface RequestLog {
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
  method?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  responseHeaders?: Record<string, string>;
  toolName?: string;
}

// 与 logs 解耦的持久化请求统计累加器。logs 已改为内存态(重启清空,对齐移动端),
// 但统计页的累计指标必须跨重启保留,所以单独维护计数器,每次请求完成时累加。
export interface RequestStats {
  totalRequests: number;
  failedRequests: number;
  byProvider: Record<string, { ok: number; failed: number }>;
  byGroup: Record<string, { ok: number; failed: number }>;
}

export interface DailyStat {
  date: string;
  messages: number;
  conversations: number;
  characters: number;
}

export interface StoredFile {
  id: number;
  path: string;
  fileName: string;
  mime: string;
  size: number;
  /** 1-7:仅出现在老备份 zip 元数据与迁移窗口内;运行时 state 不携带,
   *  抽取全文在 files/<id>.extracted.txt 旁车缓存(可再生)。 */
  extractedText?: string;
  /** 仅存在于备份 zip 的元数据里:zip 内 upload/ 的实际文件名(导出端去重/重名规避后),
   *  恢复端据此把字节精确回链到本条目的原 id。运行时 state 中不携带。 */
  backupName?: string;
}

export interface GeneratedImage {
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

export interface State {
  settings: Settings;
  // DB-first:会话运行时权威 = SQLite 活库 + working set,state 不持有会话。此字段仅两种
  // 场景存在:①迁移失败时保留 state.json 原数据作重试源(performStateSave 按标记决定写盘
  // 保留,删了它 saveState 会把重试源抹掉);②备份导入流程的暂存中转(finalize 灌库后 delete)。
  conversations?: Conversation[];
  // B6-①a:备份导入流程的工作区暂存中转(dump format 2 的 pc_workspace 行),与 conversations
  // 同生命周期——finalize 随会话同事务灌库后 delete。仅暂存,运行时权威在活库。
  pcWorkspaces?: PcWorkspaceRow[];
  files: StoredFile[];
  generatedImages: GeneratedImage[];
  logs: RequestLog[];
  stats: RequestStats;
  // 1.3.2 起,记忆由 memoryStore 管理(memory/ 目录),不再落进 state.json。这两个字段
  // 保留 optional 仅为兼容 normalizeState 解析旧 state.json / 备份 incoming;迁移完成后从 state delete。
  memories?: AssistantMemory[];
  nextFileId: number;
  nextMemoryId?: number;
  nextGeneratedImageId: number;
  launchCount: number;
  // 一次性迁移记录。每个已应用的迁移 id 存一次,防止启动时反复执行会覆盖用户后续
  // 手动调整的迁移(如供应商顺序重排)。老 state 没有该字段,视为空数组。
  appliedMigrations?: string[];
}

export type SearchService = Record<string, JsonValue>;
export type SkillMetadata = {
  name: string;
  description: string;
  compatibility?: string;
  allowedTools: string[];
};

export type GithubRelease = {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  assets?: { name?: string; browser_download_url?: string; size?: number }[];
};

export interface MemoryEntry {
  id: number;
  content: string;
  createdAt: number;
  updatedAt: number;
  // 来源标记(非跨端契约,备份导出时丢弃)。语义:用户手动新增/编辑过 → "manual";
  // 模型提议且用户原样确认 → "ai"。任何手动编辑都置 manual,故 "ai" 徽章不会长期挂着已改动的记忆。
  source: "manual" | "ai";
}

export interface GlobalMemoryFile {
  version: 1;
  nextMemoryId: number;
  memories: MemoryEntry[];
}

export interface AssistantMemoryGroup {
  assistantId: string;       // 权威键,不可变
  assistantName: string;     // 显示快照,每次保存时从 settings 反查刷新;反查不到填 "未知助手"(M5)
  memories: MemoryEntry[];
}

export interface AssistantMemoryFile {
  version: 1;
  assistants: AssistantMemoryGroup[];
}

// 阶段 3 启用;阶段 1 仅预留文件结构与类型定义。
export interface PendingEntry {
  pendingId: string;
  conversationId: string;
  conversationTitle?: string;   // 来源会话标题快照(入队时取,与会话改名/删除解耦),前端确认面板展示
  assistantId: string;
  assistantName: string;
  content: string;
  proposedAt: number;
  messageNodeId?: string;
}

export interface PendingMemoryFile {
  version: 1;
  pending: PendingEntry[];
}

export interface AddMemoryInput {
  scope: "global" | "assistant";
  assistantId?: string;       // scope=assistant 时必填
  content: string;
  source?: "manual" | "ai";
  createdAt?: number;
  updatedAt?: number;
}

// memory SSE 推送给前端的完整快照。globalEnabled/writeStrategy 冗余(从 settings 读),
// 让前端少订阅一个 settings SSE 源——字段冗余但读起来方便(§10.3)。
export interface MemorySnapshot {
  globalEnabled: boolean;
  writeStrategy: WriteStrategy;
  globalMemories: MemoryEntry[];
  assistantMemories: AssistantMemoryGroup[];
  pending: PendingEntry[];
  pendingCount: number;
}

// ============================================================================
// 会话活库(SQLite,1.2.6 引入)
//
// 会话从 state.json 搬进 rikka_hub.db,采用 Android APP 节点级 schema 的 PC 超集
// (pc_conversation / pc_message_node,含 system_prompt——Android 备份库没有这列)。DB-first:活库是唯一运行时权威,读路径直查,内存只驻留正在使用的实例
// (conversations/working-set.ts 单一权威实例注册表);运行时写路径:
//   - 流式热路径:只 upsert 当前在长的那个 pc_message_node 行(脏标记 + 200ms 节流),
//     SQLite 只把脏页追加进 WAL,开销与总会话数/总数据量无关——这是根除"每 200ms 全量
//     重写 state.json"的关键。
//   - 非流式变更(改名/编辑/分叉/导入/流结束):persistConversation 全量 reconcile。
//
// 与 insertConversationsIntoDb(写 Android 的 ConversationEntity/message_node)是不同
// 文件、不同表名、不同 schema:备份库须 Android 兼容(有损、无 PC 超集列),活库须 PC 完整。
// 备份从活库现场生成(flush 对齐脏数据后逐会话瞬时读)。详见设计文档。
// ============================================================================

// 活库行类型(SELECT 结果)。is_pinned 存 0/1;system_prompt 空 string 对应 null。
export interface PcConversationRow {
  id: string;
  assistant_id: string;
  title: string;
  system_prompt: string;
  suggestions: string;
  is_pinned: number;
  create_at: number;
  update_at: number;
  mode_injection_ids?: string;
  lorebook_ids?: string;
  workspace_id?: string | null;
  workspace_cwd?: string | null;
  engine_compactions?: string | null;
}
export interface PcMessageNodeRow {
  id: string;
  node_index: number;
  messages: string;
  select_index: number;
}

export type GitHubSkillInfo = { owner: string; repo: string; branch: string; path: string };
export type GitHubSkillFile = { relativePath: string; downloadUrl: string };

export type ApiMessage = Record<string, any>;

export interface XmlToken {
  type: number;
  name?: string;
  attrs?: Record<string, string>;
  text?: string;
  depth: number;
}

// ── 字体系统 ───────────────────────────────────────────────────────────────
// 三层来源:
//   builtin — 随应用分发。repo 根 fonts/ 经 Tauri resources 打到 executableDir/fonts/,
//             跟 icons 完全同构;dev 时从 rootDir/fonts/ 读。
//   custom  — 用户上传,存在 pc-data/fonts/(gitignored,更新不覆盖)。
//   system  — 系统已装字体。Linux 走 `fc-list`,Windows 走 PowerShell +
//             System.Drawing.Text.InstalledFontCollection(真枚举,非硬编码清单);
//             两者都失败才降级到 COMMON_FONTS_FALLBACK。
// 关键:@font-face 的 font-family 名由我们掌控(= 文件名 stem),所以不解析字体文件
// 内部的 name 表——绕开了"从二进制读真实族名"这个最烦的活,也保证 @font-face 名与 CSS
// font-family 链首项严格一致(浏览器靠这个名字匹配 @font-face 规则加载文件)。

export interface FontWeightFile {
  fileName: string;   // 字体文件名
  weight: number;     // CSS font-weight:100-900
  style: "normal" | "italic";
  format?: string;    // woff2/truetype/...(@font-face 的 format() 提示)
}
export interface FontEntry {
  id: string;        // catalog 内唯一:`builtin:<family>` / `custom:<file>` / `system:<name>`
  label: string;     // 下拉框显示名
  cssName: string;   // @font-face 的 font-family 名(builtin/custom);system 即族名本身。
                     // 必须与 family 链首项一致——浏览器靠它匹配 @font-face。
  family: string;    // 完整 CSS font-family 值(含 fallback 链)——root.tsx 实际注入 CSS 变量的值
  source: "builtin" | "custom" | "system";
  // 字体族由一个或多个文件组成。单字重字体只有一个元素。多字重字体(HarmonyOS Sans 6 个
  // 字重)共享同一 cssName,每个文件声明对应 font-weight,这样浏览器遇到 <b>/700 自动
  // 挑 Bold 文件,而不是用 Regular 合成假粗体。
  weights: FontWeightFile[];
}

// 可选 builtin 清单:repo 根 fonts/manifest.json。
// 两种写法:
//   1) 单文件映射(向后兼容老 manifest):"<file>": { label?, family? }
//   2) 字重族定义(一个 family 下多个文件):"<id>": { label, family, weights:[{file,weight,style?}] }
//      weights 里每个 file 必须真实存在于 fonts/ 目录;family 是共享的 @font-face 名。
export type ManifestWeight = { file: string; weight: number; style?: "normal" | "italic" };
export interface ManifestEntry {
  label?: string;
  family?: string;
  weights?: ManifestWeight[];
}
export type BuiltinManifest = Record<string, ManifestEntry>;

export type StreamHooks = {
  message?: Message;
  conversation?: Conversation;
  node?: MessageNode;
};

// Per-round Claude SSE reader. Returns the assistant content blocks captured during the stream
// plus stop_reason + usage. Text/thinking/input_json deltas are emitted to the live UI as they
// arrive. This is the building block of streamClaudeChatWithTools — we drive a tool loop on top
// where the outer code dispatches tools and re-streams.
export type ClaudeStreamRoundResult = {
  blocks: Array<Record<string, any>>;
  textOut: string;
  thinkingOut: string;
  stopReason: string | null;
  usage: Message["usage"] | undefined;
  raw: string;
};

// ===== Google / Gemini 流式 + 工具循环 =====
// 镜像安卓 GoogleProvider.streamText：通过 streamGenerateContent?alt=sse 拿到 SSE，
// 逐 chunk 解析 candidates[].content.parts，区分 thought(reasoning) / text / inlineData(图片)
// / functionCall，并把增量推给实时 UI。返回该轮的聚合结果供工具循环驱动。
export type GoogleStreamRoundResult = {
  textOut: string;
  thinkingOut: string;
  functionCalls: Array<{ id: string; name: string; args: Record<string, JsonValue>; thoughtSignature?: string }>;
  modelParts: Record<string, JsonValue>[];
  usage: Message["usage"] | undefined;
  raw: string;
};

export interface AuxiliaryTextOptions {
  maxTokens?: number | null;
  temperature?: number | null;
  topP?: number | null;
  reasoningLevel?: string | null;
  customBody?: Record<string, any>;
  stream?: boolean;
  onDelta?: (text: string) => void;
  /** 取消信号（压缩等可被用户中止的辅助调用）：中止立即撕底层连接，不空耗轮次。 */
  signal?: AbortSignal;
  /** 会话身份（§7.4/#1902）：标题/压缩等有会话上下文的调用传真实 conversationId；
   *  缺省时注入层兜底随机 UUID（OpenCode Zen 拒收无会话头请求）。 */
  conversationId?: string;
}

export interface AsrRealtimeSession {
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
  /** 语音模式去抖:上一个已发 turn_end 的 utterance 文本。Volcengine 的 definite=true 会随
   *  累积 full-text 重复到达,凭此只在文本真正前进时才推一次「这句说完了」,防重复入队。 */
  lastTurnEndText: string;
}