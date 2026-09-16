// persistence/state-load.ts — state.json 装载、规范化与一次性迁移（会话入 SQLite、记忆拆文件）
// 纪律：纯搬迁自 server.ts（阶段 5.3h），行为不变。迁移常量语义见 json-store.ts。

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { AssistantMemoryFile, Conversation, GlobalMemoryFile, JsonValue, State, StoredFile, WriteStrategy } from "../foundation/types";
import { getStringArray, id, isRecord, mergeById, uniqueStrings } from "../foundation/utils";
import { assistantMemoryPath, dataDir, filesDir, globalMemoryPath, pendingMemoryPath, skillsDir, statePath } from "../foundation/paths";
import { normalizeProxyConfig, normalizePreferredPort } from "../foundation/net";
import {
  CONVERSATIONS_SQLITE_MIGRATION,
  MEMORY_FILE_SPLIT_MIGRATION,
  maybeAdoptFresherRecovery,
  recoverStateFromBackups,
  sweepAgedRecoveryArchives,
  sweepStaleStateTempFiles,
  writeSlimStateJsonSync,
  writeSlimStateJsonSyncForMemory,
} from "./json-store";
import { reportError } from "../observability/app-errors";
import { getConversationsDb, migrateConversationsIntoDbBatched, openConversationsDb, resetConversationsDbTo } from "../conversations";
import { setStartupPhase } from "../foundation/startup-gate";
import { countConversations } from "../conversations/read-queries";
import { GLOBAL_MEMORY_ID, memoryStore } from "../memory";
import { NA_API_PRESET_MODELS, NA_API_PROVIDER_ID, SUNSET_PROVIDER_IDS, TENCENT_PROVIDER_ID, builtinProviderRank, enrichModel, inferModelAbilities, model } from "../model-providers";
import { normalizeTtsProviders } from "../media/tts";
import { normalizeAsrProviders } from "../media/asr";
import { normalizeS3Config, normalizeWebDavConfig } from "../app-config/backup-config";
import { hashFileSha256, rewriteAndroidFileUrlsDeep, rewritePcFileUrlsDeep } from "../backup/file-refs";
import { writeExtractedTextSidecar } from "../files/index";
import { rebuildFtsFromNodeTable } from "../conversations/fts";
import { normalizeRequestStats } from "../api/logs";
import { DEFAULT_ASSISTANT_SYSTEM_PROMPT, SUNSET_TTS_PROVIDER_IDS, defaultSettings, defaultState } from "../app-config/defaults";
import {
  DEFAULT_COMPRESS_PROMPT,
  DEFAULT_OCR_PROMPT,
  DEFAULT_PROMPT_OPTIMIZE_PROMPT,
  DEFAULT_SUGGESTION_PROMPT,
  SUGGESTION_CHARACTER_LIMIT,
  DEFAULT_TITLE_PROMPT,
  DEFAULT_TRANSLATION_PROMPT,
  TITLE_CHARACTER_LIMIT,
} from "../app-config/prompts";

// 1.1.1 内置供应商重排迁移标记。模块级导出:恢复备份时由 backup/import.ts 预置
// (备份里的 providers 顺序就是用户排好的顺序,恢复后重排只会破坏它,见 R4-1)。
export const PROVIDER_REORDER_MIGRATION = "provider-reorder-1.1.1";

export function normalizeState(input: Partial<State>): State {
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
    logs: [],  // 内存态:启动清空,对齐移动端(performStateSave 写盘排除)
    stats: normalizeRequestStats(input.stats, Array.isArray(input.logs) ? input.logs : []),
    memories: Array.isArray(input.memories) ? input.memories.filter(isRecord).map((memory, index) => {
      const now = Date.now();
      // Pre-2026-05 PC builds saved global-scope memories under "global" (without underscores).
      // Migrate any legacy records so they continue to surface for assistants with
      // `useGlobalMemory: true`, matching the Android schema literal.
      const rawAssistantId = String(memory.assistantId ?? (memory as any).assistant_id ?? GLOBAL_MEMORY_ID);
      const assistantId = rawAssistantId === "global" ? GLOBAL_MEMORY_ID : rawAssistantId;
      return {
        id: Number(memory.id ?? index + 1),
        assistantId,
        content: String(memory.content ?? ""),
        createdAt: Number(memory.createdAt ?? (memory as any).created_at ?? now),
        updatedAt: Number(memory.updatedAt ?? (memory as any).updated_at ?? now),
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
  // D7(复查):默认提示词曾把秒级 "Time: {{cur_datetime}}" 改为天级 "Date: {{cur_date}}"
  // (a63d46b,秒级时间让 system 每条消息都变、前缀缓存从该行起全部失效),但存量用户的
  // 助手仍带旧串。与 R1-11 同一模式:仅对"与旧默认逐字相等"的提示词做一次性替换,
  // 用户改过一个字都不动;无迁移标记,幂等且随备份天然往返。
  const legacyDefaultPrompt = DEFAULT_ASSISTANT_SYSTEM_PROMPT.replace("- Date: {{cur_date}}", "- Time: {{cur_datetime}}");
  normalized.settings.assistants = normalized.settings.assistants.map((assistant) =>
    assistant.systemPrompt === legacyDefaultPrompt
      ? { ...assistant, systemPrompt: DEFAULT_ASSISTANT_SYSTEM_PROMPT }
      : assistant,
  );
  // Backfill mcpToolOverrides for assistants saved before this field existed. Default empty
  // object = inherit all globally-enabled tools, no per-assistant overrides applied.
  normalized.settings.assistants = normalized.settings.assistants.map((assistant) => {
    // 专题3 F-1:安卓把 contextMessageSize 改名为 contextMessageLimit(语义不变:上下文
    // 最多携带的消息条数,0 = 不限),PC 同名对齐备份契约。老 state/旧备份里的旧键在此
    // 一次性搬运并丢弃(显式解构剔除,避免残留键随导出流向安卓)。幂等:新键已存在时
    // 旧键只被丢弃、不覆盖。
    const { contextMessageSize: legacyLimit, ...rest } = assistant as typeof assistant & { contextMessageSize?: unknown };
    return {
      ...rest,
      contextMessageLimit: typeof rest.contextMessageLimit === "number"
        ? rest.contextMessageLimit
        : (typeof legacyLimit === "number" ? legacyLimit : 0),
      mcpToolOverrides: isRecord(assistant.mcpToolOverrides)
        ? assistant.mcpToolOverrides as Record<string, Record<string, { enable?: boolean; needsApproval?: boolean }>>
        : {},
    };
  });
  // memorySettings 规范化 + M1 迁移推断:老用户首次升级(settings 无 memorySettings)时,
  // 若所有助手 enableMemory=false,globalEnabled 默认 false(避免被动注入全局,违背用户意愿);
  // 否则默认 true。用户设过 memorySettings(存在)则保留,仅校验 writeStrategy 合法性。
  {
    const userMs = (parsedSettings as unknown as Record<string, unknown>).memorySettings;
    if (isRecord(userMs)) {
      const ws = String((userMs as unknown as Record<string, unknown>).writeStrategy ?? "ask");
      normalized.settings.memorySettings = {
        globalEnabled: (userMs as unknown as Record<string, unknown>).globalEnabled !== false,
        writeStrategy: ws === "always_assistant" || ws === "always_global" || ws === "readonly"
          ? (ws as WriteStrategy)
          : "ask",
      };
    } else {
      const allDisabled = normalized.settings.assistants.length > 0
        && normalized.settings.assistants.every((a) => !a.enableMemory);
      normalized.settings.memorySettings = { globalEnabled: !allDisabled, writeStrategy: "ask" };
    }
  }
  normalized.settings.displaySetting = { ...defaults.displaySetting, ...(normalized.settings.displaySetting ?? {}) };
  // Backfill keybindings:以默认表为基底,逐 action 用用户保存的条目覆盖。保证新增 action 自动补
  // 默认、过滤未知 action、且每条 entry 字段完整(即使用户手改 state.json 造成残缺,默认值兜底)。
  const keybindingDefaults = defaults.keybindings as Record<string, JsonValue>;
  const userKeybindings = (normalized.settings.keybindings ?? {}) as Record<string, JsonValue>;
  const mergedKeybindings: Record<string, JsonValue> = {};
  for (const action of Object.keys(keybindingDefaults)) {
    const def = isRecord(keybindingDefaults[action]) ? keybindingDefaults[action] : {};
    const user = isRecord(userKeybindings[action]) ? userKeybindings[action] : {};
    mergedKeybindings[action] = { ...def, ...user };
  }
  normalized.settings.keybindings = mergedKeybindings;
  if (!String(normalized.settings.displaySetting.uiFontFamily ?? "").trim()) {
    normalized.settings.displaySetting.uiFontFamily = defaults.displaySetting.uiFontFamily;
    normalized.settings.displaySetting.uiFontFamilyCss = defaults.displaySetting.uiFontFamilyCss;
  }
  normalized.settings.titlePrompt = normalized.settings.titlePrompt || DEFAULT_TITLE_PROMPT;
  normalized.settings.translatePrompt = normalized.settings.translatePrompt || DEFAULT_TRANSLATION_PROMPT;
  normalized.settings.suggestionPrompt = normalized.settings.suggestionPrompt || DEFAULT_SUGGESTION_PROMPT;
  normalized.settings.ocrPrompt = normalized.settings.ocrPrompt || DEFAULT_OCR_PROMPT;
  normalized.settings.compressPrompt = normalized.settings.compressPrompt || DEFAULT_COMPRESS_PROMPT;
  normalized.settings.promptOptimizePrompt = normalized.settings.promptOptimizePrompt || DEFAULT_PROMPT_OPTIMIZE_PROMPT;
  // R1-11:标题/建议默认提示词的字数上限曾从 10 调到 15/18。旧做法是每次启动无条件正则
  // 替换 "not exceed 10 characters"——用户有意写 10 的自定义提示词被反复静默改掉。
  // 终极版不用迁移标记(pc-backup.json 不导出标记,恢复即丢,R1-12 已踩过这坑),改为
  // 无状态精确匹配:由现默认值重建"字数还是 10"的旧默认全文,整段完全相等才视为
  // "未自定义的旧默认值",升级到新默认;任何自定义(含刻意写 10)原样保留。幂等、
  // 随备份天然往返,新老数据同一条路径。
  const legacyTitlePrompt = DEFAULT_TITLE_PROMPT.replace(`not exceed ${TITLE_CHARACTER_LIMIT} characters`, "not exceed 10 characters");
  if (normalized.settings.titlePrompt === legacyTitlePrompt) normalized.settings.titlePrompt = DEFAULT_TITLE_PROMPT;
  const legacySuggestionPrompt = DEFAULT_SUGGESTION_PROMPT.replace(`not exceed ${SUGGESTION_CHARACTER_LIMIT} characters`, "not exceed 10 characters");
  if (normalized.settings.suggestionPrompt === legacySuggestionPrompt) normalized.settings.suggestionPrompt = DEFAULT_SUGGESTION_PROMPT;
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
  // 下架清理(见 SUNSET_PROVIDER_IDS):仅删老用户 state 里残留、且从未配置 apiKey 的。
  normalized.settings.providers = normalized.settings.providers.filter(
    (providerItem) => !SUNSET_PROVIDER_IDS.has(providerItem.id) || String(providerItem.apiKey ?? "").trim() !== "",
  );
  // 1.1.1 供应商迁移:
  // (a) 腾讯 Hunyuan 改名为"腾讯混元"(mergeById 保留老 name,这里强制按 id 改名,配置不变)。
  // (b) 钠API 给从未配置过的老用户(models 为空)补上预置模型;已自定义 models 的不覆盖。
  normalized.settings.providers = normalized.settings.providers.map((providerItem) => {
    if (providerItem.id === TENCENT_PROVIDER_ID) {
      return { ...providerItem, name: "腾讯混元" };
    }
    if (providerItem.id === NA_API_PROVIDER_ID && (providerItem.models ?? []).length === 0) {
      return { ...providerItem, models: NA_API_PRESET_MODELS.map((mid) => model(mid)) };
    }
    return providerItem;
  });
  // 1.1.1:按预置顺序重排内置供应商(老用户也生效)。用户新增的自定义供应商不在
  // BUILTIN_PROVIDER_ORDER 里,rank 都是 MAX_SAFE_INTEGER,稳定排序后仍按原相对顺序
  // 排在内置供应商之后,不会被重排打乱。这是一次性迁移——记录在 appliedMigrations,
  // 升级后用户的后续手动排序不会再被覆盖(常量在模块顶部,恢复路径也引用)。
  const appliedMigrations = Array.isArray(normalized.appliedMigrations) ? normalized.appliedMigrations : [];
  if (!appliedMigrations.includes(PROVIDER_REORDER_MIGRATION)) {
    normalized.settings.providers = [...normalized.settings.providers].sort(
      (a, b) => builtinProviderRank(a) - builtinProviderRank(b),
    );
    normalized.appliedMigrations = [...appliedMigrations, PROVIDER_REORDER_MIGRATION];
  }
  // 专题3 H-1 存量自愈:历史版本的安卓 zip 导入只改写消息里的 file:///…/upload/<name>
  // 引用,settings(助手/用户头像等)漏改,安卓私有路径在 PC 上永远无法解析(头像丢失)。
  // file ledger 的 fileName 保留安卓原始文件名,可精确回链成 /api/files/<id>/content。
  // 只动 file:// 形态字符串(fileSchemeOnly),改写后不再匹配 → 天然幂等;新导入已在
  // backup/import.ts 就地改写,此处专救存量数据。
  if (JSON.stringify(normalized.settings).includes("file://")) {
    const uploadNameToId = new Map<string, number>();
    for (const f of normalized.files) {
      if (f && typeof f.fileName === "string" && f.fileName && typeof f.id === "number" && !uploadNameToId.has(f.fileName)) {
        uploadNameToId.set(f.fileName, f.id);
      }
    }
    if (uploadNameToId.size > 0) {
      normalized.settings = rewriteAndroidFileUrlsDeep(
        normalized.settings as unknown as JsonValue,
        uploadNameToId,
        { fileSchemeOnly: true },
      ) as unknown as State["settings"];
    }
  }
  // 全面审查 R1-12(终极版):内置搜索服务的补齐/回填必须尊重删除墓碑。此前"按 type
  // 缺了就补"每次启动都跑,用户删掉的内置项重启必复活;一次性迁移标记也不彻底——
  // pc-backup.json 不导出 appliedMigrations,备份恢复后标记丢失、复活重演。墓碑
  // (dismissedSearchServiceTypes)住在 settings 里,由删除端点写入、手动重加撤销,
  // 随备份天然往返:重启/恢复/跨机迁移都不推翻删除意图。老数据无该字段 → 空墓碑,
  // 行为与旧版完全一致。
  normalized.settings.dismissedSearchServiceTypes = uniqueStrings(
    getStringArray(normalized.settings.dismissedSearchServiceTypes).map((t) => t.toLowerCase()),
  );
  const dismissedSearchTypes = new Set(normalized.settings.dismissedSearchServiceTypes);
  const searchTypeOf = (service: JsonValue) => String((service as Record<string, JsonValue>).type ?? "").toLowerCase();
  normalized.settings.searchServices = normalized.settings.searchServices?.length
    ? normalized.settings.searchServices
    : defaults.searchServices.filter((service) => !dismissedSearchTypes.has(searchTypeOf(service)));
  normalized.settings.webDavConfig = normalizeWebDavConfig(normalized.settings.webDavConfig);
  normalized.settings.s3Config = normalizeS3Config(normalized.settings.s3Config);
  normalized.settings.proxyConfig = normalizeProxyConfig(normalized.settings.proxyConfig);
  normalized.settings.preferredPort = normalizePreferredPort(normalized.settings.preferredPort);
  // 内置搜索服务补齐(带墓碑豁免):type 不存在且用户没删过 → 补。新增内置服务时在
  // 此登记即可,墓碑机制天然防复活,无需迁移标记。
  const backfillSearchPresets: Array<Record<string, JsonValue>> = [
    { type: "doubao", id: id(), name: "豆包", apiKey: "", mode: "custom" },
    { type: "serper", id: id(), name: "Serper", apiKey: "" },
    { type: "tinyfish", id: id(), name: "Tinyfish", apiKey: "" },
    { type: "firecrawl", id: id(), name: "Firecrawl", apiKey: "" },
    { type: "grok", id: id(), name: "Grok", apiKey: "", customUrl: "https://api.x.ai/v1/responses", model: "grok-4-fast" },
  ];
  for (const preset of backfillSearchPresets) {
    const presetType = String(preset.type);
    if (dismissedSearchTypes.has(presetType)) continue;
    if (normalized.settings.searchServices.some((service) => searchTypeOf(service) === presetType)) continue;
    normalized.settings.searchServices = [...normalized.settings.searchServices, preset];
  }
  normalized.settings.asrProviders = normalizeAsrProviders(normalized.settings.asrProviders);
  normalized.settings.selectedASRProviderId = normalized.settings.asrProviders.some((provider) => provider.id === normalized.settings.selectedASRProviderId)
    ? normalized.settings.selectedASRProviderId
    : normalized.settings.asrProviders[0]?.id ?? null;
  normalized.settings.ttsProviders = normalizeTtsProviders(normalized.settings.ttsProviders);
  normalized.settings.ttsProviders = normalized.settings.ttsProviders.filter(
    (providerItem) => !SUNSET_TTS_PROVIDER_IDS.has(providerItem.id) || String(providerItem.apiKey ?? "").trim() !== "",
  );
  normalized.settings.selectedTTSProviderId = normalized.settings.ttsProviders.some((provider) => provider.id === normalized.settings.selectedTTSProviderId)
    ? normalized.settings.selectedTTSProviderId
    : normalized.settings.ttsProviders[0]?.id ?? null;
  normalized.nextFileId = Math.max(
    normalized.nextFileId,
    ...normalized.files.map((file) => file.id + 1),
    1,
  );
  normalized.nextMemoryId = Math.max(
    normalized.nextMemoryId ?? 1,
    ...(normalized.memories ?? []).map((memory) => memory.id + 1),
    1,
  );
  normalized.nextGeneratedImageId = Math.max(
    normalized.nextGeneratedImageId,
    ...normalized.generatedImages.map((image) => Number(image.id) + 1).filter((value) => Number.isFinite(value)),
    1,
  );
  // R3-3:ssePostEndpoint 曾被误持久化进 settings(现已停止,见 api/handlers/settings.ts)。
  // 它是运行时会话缓存(常带 sessionId),服务器重启即失效,留在磁盘上会让重启 PC 也救不回来。
  // 每次加载无条件剥除——幂等、无需迁移标记,且天然覆盖备份恢复带回的旧值(顺应"数据文件夹
  // 干净"原则)。
  if (Array.isArray(normalized.settings.mcpServers)) {
    normalized.settings.mcpServers = normalized.settings.mcpServers.map((server) => {
      if (!server || typeof server !== "object" || Array.isArray(server)) return server;
      if (!("ssePostEndpoint" in server)) return server;
      const clone = { ...(server as Record<string, JsonValue>) };
      delete clone.ssePostEndpoint;
      return clone as JsonValue;
    });
  }
  return normalized;
}

// ============================================================================
// 记忆存储层(1.3.2 引入)
//
// 记忆从 state.json 分离到 pc-data/memory/ 目录,三个 JSON 文件独立管理:
//   global_memory.json     全局记忆 + nextMemoryId 全局计数器
//   assistant_memory.json  所有助手记忆(按 assistantId 分组,带助手名快照)
//   pending_memory.json    待确认队列(阶段 3 启用,阶段 1 预留结构)
//
// 本层是所有记忆读写的唯一入口,屏蔽文件细节。设计要点:
//   - 全量内存缓存,写入双写(内存 + 原子落盘);读取走内存索引,零 IO
//   - 原子 temp-rename 写(复用 state.json 的 8 次重试模式),绝不直接覆盖
//   - 串行化写队列:同一时刻只有一个写操作进行,防 AI 写入与批量编辑/导入并发交错
//   - S1 不变式:nextMemoryId 启动重算 = max(已落盘记忆 id)+1,不信任持久化值。
//     addMemory 先自增计数器再写记忆(内存序),persistAll 先写 global(计数器)再写
//     assistant——崩在任意点,recompute 都能自愈,已落盘 id 永不重用。
// ============================================================================

export async function loadState(): Promise<State> {
  mkdirSync(filesDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  // 1.2.6:会话从 state.json 迁入 SQLite 活库(rikka_hub.db)。state.json 瘦身后只保留
  // settings/files/images/memories/stats 等非会话状态;conversations 启动时从活库读。
  openConversationsDb();

  // 读 state.json(旧版含 conversations / 新版瘦身 / 不存在)
  let parsed: Partial<State>;
  if (!existsSync(statePath)) {
    parsed = defaultState();
  } else {
    try {
      parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<State>;
      // R1-2(终极补强):state.json 完好但磁盘上有更新鲜的 recovery——上次退出前落盘
      // 八连败写出的最后一笔抢救数据,不采用即静默丢弃最后一个会话期的全部变更。
      const fresher = maybeAdoptFresherRecovery(dataDir, statePath);
      if (fresher) {
        reportError("persistence", "warn", `检测到上次落盘失败的抢救数据，比主文件更新，已自动采用：${fresher.source}`, undefined, "recovery_adopted", { source: fresher.source, time: new Date(fresher.mtimeMs).toISOString() });
        parsed = fresher.state;
      }
    } catch (err) {
      // 全面审查 1-2:state.json 损坏 → 按新鲜度走恢复链(recovery-*.json → daily.bak
      // → pre-sqlite.bak),全部失败才回默认。原先只认化石 pre-sqlite.bak,磁盘上躺着
      // performStateSave 兜底写出的最新 recovery 却从来无人读。
      console.error("[loadState] state.json 解析失败,按恢复链回退", err);
      const recovered = recoverStateFromBackups(dataDir, statePath);
      if (recovered) {
        reportError("persistence", "warn", `设置文件损坏，已从备份 ${recovered.source} 恢复，请核对设置是否最新`, err, "state_restored_from_backup", { source: recovered.source, time: new Date(recovered.mtimeMs).toISOString() });
        parsed = recovered.state;
      } else {
        reportError("persistence", "error", "设置文件损坏且无可用备份，已重置为默认", err, "state_reset_default");
        parsed = defaultState();
      }
    }
  }

  // 迁移 + 瘦身(首次升级)。返回 true=迁移完成(活库即权威);false=迁移失败。
  const migrated = await migrateConversationsIfNeeded(parsed);

  // DB-first:会话运行时权威 = 活库 + working set,启动不装载会话(元数据也不装)。
  // 活库健康探测:迁移完成但活库读失败(打开成功而 SELECT 失败的窄场景,如页损坏)
  // → 尽力从 pre-sqlite.bak 重灌(对应旧回退路径,恢复目标从内存改为活库本身)。
  if (migrated) probeConversationsDbOrRecover();

  const state = normalizeState(parsed);
  if (migrated) {
    // 已迁移:state 不持有会话(State.conversations 注释有此字段的完整角色说明)
    delete state.conversations;
  }
  // 迁移失败:保留 normalizeState 解析出的 parsed.conversations 作写盘重试源——
  // performStateSave 按标记把它继续写回 state.json,下次启动重试迁移。运行时读路径
  // 已 DB 化,本次启动会话表现为空,但数据仍在 state.json,不丢。
  migrateMemoryFilesIfNeeded(state);
  repairRelocatedFilePaths(state);
  migrateExtractedTextToSidecars(state);
  await migrateFileDedupIfNeeded(state);
  sweepStaleStateTempFiles(); // 1-4:此刻本进程尚未开始任何原子写,清扫安全
  sweepAgedRecoveryArchives(); // R1-2 ③:.applied 归档(已采用的 recovery)超龄 30 天清扫
  return state;
}

/** 全面审查 1-6:StoredFile.path 存绝对路径,便携布局(pc-data 随 exe)下用户移动安装目录/
 *  换盘符/拷目录迁移新机后,字节都还在 files/ 里,账本却指向旧盘符——附件/生图/头像全部 404。
 *  启动时一次性修正:原路径不存在但 files/ 下按落盘命名(basename 或 <id><ext>,上传与导入
 *  都按 <id><ext> 命名,全局唯一)能找到 → 改写账本。修好的路径由 bootstrap 尾部 saveState 落盘。 */
export function repairRelocatedFilePathsIn(files: StoredFile[], filesDirPath: string): number {
  let repaired = 0;
  for (const f of files) {
    if (f.path && existsSync(f.path)) continue;
    const byBasename = f.path ? join(filesDirPath, basename(f.path)) : "";
    const ext = extname(f.fileName || "") || extname(f.path || "") || "";
    const byId = join(filesDirPath, `${f.id}${ext}`);
    const candidate = byBasename && existsSync(byBasename) ? byBasename : existsSync(byId) ? byId : "";
    if (!candidate) continue; // 字节确实没了,读取侧 404 是正确行为
    f.path = candidate;
    repaired++;
  }
  if (repaired > 0) console.log(`[files] 数据目录搬家修正:${repaired} 个附件路径已改指当前 files/`);
  return repaired;
}

function repairRelocatedFilePaths(stateObj: State): number {
  return repairRelocatedFilePathsIn(stateObj.files, filesDir);
}

/** 1-7:存量账本里的抽取全文迁到旁车文件。幂等(迁完字段即删,重跑零工作量),
 *  无需迁移标记;bootstrap 尾部 saveState 落盘瘦身结果。extractedAt 一并清除(已废弃)。 */
function migrateExtractedTextToSidecars(stateObj: State): void {
  let moved = 0;
  for (const f of stateObj.files) {
    const legacy = f as StoredFile & { extractedAt?: number };
    if (typeof legacy.extractedText === "string" && legacy.extractedText) {
      writeExtractedTextSidecar(f.id, legacy.extractedText);
      moved++;
    }
    delete legacy.extractedText;
    delete legacy.extractedAt;
  }
  if (moved > 0) console.log(`[files] 抽取全文迁出账本:${moved} 条已落旁车缓存`);
}

export const FILE_DEDUP_MIGRATION = "file-dedup-2.0";

/** 备份 2.0 批5b:一次性归并 state.files 中内容重复的条目。历史上安卓 zip 导入对 upload/
 *  零去重(旧条目仍被消息引用删不得),每次 PC↔APP 往返附件翻倍(用户实测 4 份 = 两轮)。
 *  流程:尺寸碰撞组内 sha256 分组 → 每组保留最小 id → 改写活库全部节点 messages 与
 *  settings/generatedImages 中的 /api/files/<dup>/content 引用 → 删除重复条目与其物理文件
 *  (仅当该路径不再被任何保留条目使用)。改写先于删除:任意点崩溃后重跑,分组与映射由
 *  当前内容重新推导,天然幂等。活库未打开、或会话仍在 state.json(SQLite 迁移未完成)时
 *  本次跳过且不写标记,下次启动重试。 */
async function migrateFileDedupIfNeeded(stateObj: State): Promise<void> {
  const appliedMigrations = Array.isArray(stateObj.appliedMigrations) ? stateObj.appliedMigrations : [];
  if (appliedMigrations.includes(FILE_DEDUP_MIGRATION)) return;
  if (Array.isArray(stateObj.conversations)) return;
  const db = getConversationsDb();
  if (!db) return;
  try {
    const bySize = new Map<number, { f: StoredFile; path: string }[]>();
    for (const f of stateObj.files) {
      let p = f.path && existsSync(f.path) ? f.path : "";
      if (!p) {
        const ext = extname(f.fileName || "") || extname(f.path || "") || "";
        const fallback = join(filesDir, `${f.id}${ext}`);
        p = existsSync(fallback) ? fallback : "";
      }
      if (!p) continue;
      const size = statSync(p).size;
      const list = bySize.get(size) ?? [];
      list.push({ f, path: p });
      bySize.set(size, list);
    }
    const idMap = new Map<number, number>();
    const dupItems: { f: StoredFile; path: string }[] = [];
    // R1-1:sha256 是同步 CPU/IO 块(GB 级截图库可达分钟级),逐文件让出事件循环并回填
    // 进度,迁移期的 503/进度端点才有机会被服务。
    let hashTotal = 0;
    for (const group of bySize.values()) if (group.length >= 2) hashTotal += group.length;
    let hashed = 0;
    if (hashTotal > 0) setStartupPhase("file-dedup", 0, hashTotal);
    for (const group of bySize.values()) {
      if (group.length < 2) continue;
      const byHash = new Map<string, { f: StoredFile; path: string }[]>();
      for (const item of group) {
        await Bun.sleep(0);
        const h = hashFileSha256(item.path);
        hashed += 1;
        setStartupPhase("file-dedup", hashed, hashTotal);
        if (!h) continue;
        const list = byHash.get(h) ?? [];
        list.push(item);
        byHash.set(h, list);
      }
      for (const same of byHash.values()) {
        if (same.length < 2) continue;
        same.sort((a, b) => a.f.id - b.f.id);
        const kept = same[0]!;
        for (const dup of same.slice(1)) {
          idMap.set(dup.f.id, kept.f.id);
          dupItems.push(dup);
        }
      }
    }
    if (idMap.size > 0) {
      // 改写活库节点(单事务);URL 引用形态全系统唯一,直接对节点 JSON 文本做正则替换。
      const rows = db.prepare("SELECT id, messages FROM pc_message_node").all() as { id: string; messages: string }[];
      const update = db.prepare("UPDATE pc_message_node SET messages = ? WHERE id = ?");
      let changedNodes = 0;
      db.exec("BEGIN");
      try {
        for (const row of rows) {
          const rewritten = rewritePcFileUrlsDeep(row.messages, idMap) as string;
          if (rewritten !== row.messages) {
            update.run(rewritten, row.id);
            changedNodes++;
          }
        }
        db.exec("COMMIT");
      } catch (txErr) {
        db.exec("ROLLBACK");
        throw txErr;
      }
      if (changedNodes > 0) rebuildFtsFromNodeTable(db);
      stateObj.settings = rewritePcFileUrlsDeep(
        stateObj.settings as unknown as JsonValue,
        idMap,
      ) as unknown as typeof stateObj.settings;
      if (Array.isArray(stateObj.generatedImages)) {
        const rewritten = rewritePcFileUrlsDeep(
          stateObj.generatedImages as unknown as JsonValue,
          idMap,
        ) as unknown as typeof stateObj.generatedImages;
        stateObj.generatedImages = rewritten.map((img) =>
          typeof img.fileId === "number" && idMap.has(img.fileId)
            ? { ...img, fileId: idMap.get(img.fileId)! }
            : img,
        );
      }
      const dupIds = new Set(idMap.keys());
      stateObj.files = stateObj.files.filter((f) => !dupIds.has(f.id));
      // 物理清理:保留条目仍在用的路径绝不删(同路径多条目的防御)。
      const keptPaths = new Set<string>();
      for (const group of bySize.values()) {
        for (const item of group) {
          if (!dupIds.has(item.f.id)) keptPaths.add(item.path);
        }
      }
      let removedFiles = 0;
      for (const dup of dupItems) {
        if (keptPaths.has(dup.path)) continue;
        try {
          unlinkSync(dup.path);
          removedFiles++;
        } catch (rmErr) {
          console.warn("[file-dedup] 物理文件删除失败(条目已归并,不影响正确性)", dup.path, rmErr);
        }
      }
      console.log(`[file-dedup] 归并 ${idMap.size} 个重复附件条目,改写 ${changedNodes} 个消息节点,清理 ${removedFiles} 个物理文件`);
    }
    stateObj.appliedMigrations = [...(Array.isArray(stateObj.appliedMigrations) ? stateObj.appliedMigrations : []), FILE_DEDUP_MIGRATION];
    writeSlimStateJsonSyncForMemory(stateObj);
  } catch (err) {
    reportError("persistence", "warn", "附件去重迁移失败，下次启动重试", err, "dedup_migration_failed");
  }
}

/** 1.3.2 记忆迁移:把 state.memories 搬到 pc-data/memory/ 目录(三个 JSON 文件)。
 *  迁移完成后 state 不再持有 memories / nextMemoryId(归 memoryStore 管理)。
 *  S2 三道防线:(a) 备份 state.json → pre-memory-split.bak;(b) 迁移完成后立即同步写瘦
 *  state.json(绕过 throttle,标记 + 排除第一时间落盘);(c) memory/ 目录已有数据则不覆盖
 *  (上次半完成),改为从文件加载 + 补写标记,保留用户可能的新增数据。 */
function migrateMemoryFilesIfNeeded(stateObj: State): void {
  const appliedMigrations = Array.isArray(stateObj.appliedMigrations) ? stateObj.appliedMigrations : [];

  // 已迁移:从 memory/ 目录加载,state 不持有 memories/nextMemoryId。
  if (appliedMigrations.includes(MEMORY_FILE_SPLIT_MIGRATION)) {
    memoryStore.load(stateObj);
    delete stateObj.memories;
    delete stateObj.nextMemoryId;
    return;
  }

  // S2 防御(c):标记未写但 memory/ 已有数据——上次迁移半完成(写文件后、写标记前崩)。
  // 不覆盖!从已有文件加载 + 补写标记,保留用户可能的新增数据。
  if (existsSync(globalMemoryPath) || existsSync(assistantMemoryPath) || existsSync(pendingMemoryPath)) {
    const gmfTemp = memoryStore.readFile(globalMemoryPath, { version: 1, nextMemoryId: 1, memories: [] }) as GlobalMemoryFile;
    const amfTemp = memoryStore.readFile(assistantMemoryPath, { version: 1, assistants: [] }) as AssistantMemoryFile;
    const hasData = (Array.isArray(gmfTemp.memories) && gmfTemp.memories.length > 0)
      || (Array.isArray(amfTemp.assistants) && amfTemp.assistants.length > 0);
    if (hasData) {
      console.warn("[memory] 检测到上次迁移半完成,memory/ 已有数据,从文件加载(不覆盖)");
      memoryStore.load(stateObj);
      stateObj.appliedMigrations = [...appliedMigrations, MEMORY_FILE_SPLIT_MIGRATION];
      delete stateObj.memories;
      delete stateObj.nextMemoryId;
      writeSlimStateJsonSyncForMemory(stateObj);
      return;
    }
  }

  // 正常首次迁移。S2(a):备份 state.json → pre-memory-split.bak(防覆盖已有备份)。
  const bakPath = join(dataDir, "state.json.pre-memory-split.bak");
  if (existsSync(statePath) && !existsSync(bakPath)) {
    try {
      copyFileSync(statePath, bakPath);
    } catch (err) {
      reportError("persistence", "warn", "记忆迁移前备份失败，迁移继续但无快照回退", err, "memory_migration_backup_failed");
    }
  }

  const memoriesToMigrate = Array.isArray(stateObj.memories) ? stateObj.memories : [];
  console.log(`[memory] 首次升级:迁移 ${memoriesToMigrate.length} 条记忆到 memory/ 目录...`);
  memoryStore.migrateFromStateMemories(memoriesToMigrate, stateObj.settings.assistants);

  stateObj.appliedMigrations = [...appliedMigrations, MEMORY_FILE_SPLIT_MIGRATION];
  delete stateObj.memories;
  delete stateObj.nextMemoryId;

  // S2(b):立即同步写瘦 state.json,把"标记已写 + memories 已排除"第一时间持久化,
  // 把"已迁移但标记未落盘"的崩溃窗口压到几乎为零(对齐 migrateConversationsIfNeeded 的纪律)。
  writeSlimStateJsonSyncForMemory(stateObj);
  console.log("[memory] 记忆迁移完成");
}

// 0-3/8-4:本模块曾在顶层执行 setState(loadState())+代理拦截器安装(import 副作用),
// 启动顺序全靠 server.ts 的 import 顺序隐式保证,且任何脚本/测试 import 到本模块就会
// 触发真实磁盘迁移。已收敛到 bootstrap.ts 显式编排;此处原有的三段搬迁遗留无主注释
// (描述 json-store 写队列/TDZ 约束)一并清除。

async function migrateConversationsIfNeeded(parsed: Partial<State>): Promise<boolean> {
  const appliedMigrations = Array.isArray(parsed.appliedMigrations) ? parsed.appliedMigrations : [];
  if (appliedMigrations.includes(CONVERSATIONS_SQLITE_MIGRATION)) return true;

  let conversationsToMigrate = Array.isArray(parsed.conversations) ? parsed.conversations : [];
  const preSqliteBakPath = join(dataDir, "state.json.pre-sqlite.bak");

  // 方案 B(兜底):state.json 已无 conversations,但 pre-sqlite.bak 里有——说明上次迁移
  // 失败、saveState 把会话从 state.json 抹空了(此路径已被 performStateSave 的标记门闸堵住,
  // 这里是纵深防御,捕获任何把 state.json 抹空的未知途径)。从 .bak 救回重灌。
  // 仅在迁移标记未写时执行:已迁移用户的空活库是合法空状态(用户删光了),不能误复活。
  // 标记已写会在函数开头早退,不会走到这里。
  if (conversationsToMigrate.length === 0) {
    const fromBak = recoverConversationsFromBak();
    if (fromBak.length > 0) {
      console.log(`[conv-db] 检测到迁移失败残留:从 pre-sqlite.bak 恢复 ${fromBak.length} 条会话`);
      // R4-1 配套:化石灌库是重大事件(快照可能落后数月),必须让用户看见——正常升级
      // 首启不走这里(state.json 自带 conversations),走到这里说明会话曾被某种途径抹空。
      reportError("persistence", "warn", `检测到会话迁移失败残留，已从快照恢复 ${fromBak.length} 条会话，请核对内容`, undefined, "migration_residue_recovered", { count: fromBak.length });
      conversationsToMigrate = fromBak;
    }
  }

  // ① 备份(只在有会话、state.json 存在、.bak 不存在时;防覆盖已有备份)
  if (conversationsToMigrate.length > 0 && existsSync(statePath) && !existsSync(preSqliteBakPath)) {
    try {
      copyFileSync(statePath, preSqliteBakPath);
    } catch (err) {
      reportError("persistence", "warn", "会话迁移前备份失败，迁移继续但无快照回退", err, "conversation_migration_backup_failed");
    }
  }

  // ② 灌库(分批事务,幂等;R1-1 ③)。批间让出事件循环,迁移期启动进度端点可响应;
  // 中途断电重启后从头重灌,逐会话 upsert 幂等不会脏。
  if (conversationsToMigrate.length > 0) {
    console.log(`[conv-db] 首次升级:迁移 ${conversationsToMigrate.length} 条会话进 SQLite 活库...`);
    setStartupPhase("migrate-conversations", 0, conversationsToMigrate.length);
    try {
      await migrateConversationsIntoDbBatched(getConversationsDb()!, conversationsToMigrate, 200, (done, total) => setStartupPhase("migrate-conversations", done, total));
      console.log("[conv-db] 会话迁移完成");
    } catch (err) {
      console.error("[conv-db] 会话迁移失败,保留 state.json 原样,下次启动重试", err);
      reportError("persistence", "error", "会话迁移到活库失败，数据保持原样，下次启动重试", err, "conversation_migration_failed");
      return false;
    }
  }

  // ③ 写瘦 state.json(删 conversations + 加迁移标记)
  parsed.appliedMigrations = [...appliedMigrations, CONVERSATIONS_SQLITE_MIGRATION];
  delete (parsed as { conversations?: Conversation[] }).conversations;
  try {
    writeSlimStateJsonSync(parsed);
  } catch (err) {
    reportError("persistence", "warn", "迁移后写瘦设置文件失败，运行不受影响", err, "slim_state_after_migration_failed");
  }
  return true;
}

/** 同步 temp+rename 写瘦 state.json。loadState 启动阶段用(不能异步)。 */

/** 从 state.json.pre-sqlite.bak 读 conversations(活库损坏时的最后兜底)。 */
function recoverConversationsFromBak(): Conversation[] {
  const bakPath = join(dataDir, "state.json.pre-sqlite.bak");
  try {
    if (!existsSync(bakPath)) return [];
    const bakParsed = JSON.parse(readFileSync(bakPath, "utf8")) as Partial<State>;
    return Array.isArray(bakParsed.conversations) ? bakParsed.conversations : [];
  } catch (err) {
    reportError("persistence", "error", "会话迁移快照恢复失败", err, "sqlite_backup_restore_failed");
    return [];
  }
}

function probeConversationsDbOrRecover(): void {
  const db = getConversationsDb();
  if (!db) return;
  try {
    countConversations(db);
  } catch (err) {
    console.error("[conv-db] 活库读取失败,尝试从 state.json.pre-sqlite.bak 重灌", err);
    reportError("persistence", "error", "会话库读取失败，正在从迁移备份重灌", err, "live_db_unreadable");
    const fromBak = recoverConversationsFromBak();
    if (fromBak.length === 0) return;
    try {
      resetConversationsDbTo(fromBak);
      console.error(`[conv-db] 已从 pre-sqlite.bak 重灌 ${fromBak.length} 个会话`);
    } catch (err2) {
      // 读写都失败:库彻底不可用,本次会话为空;bak 原样保留,人工可救
      reportError("persistence", "error", "会话库重灌失败，本次启动会话列表为空，数据仍在迁移快照中", err2, "live_db_refill_failed");
    }
  }
}
