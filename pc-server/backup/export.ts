// backup/export.ts — PC 备份导出（zip 打包、Android rikka_hub.db 生成、avatar 类型互转）
// 纪律：Android 互导契约（枚举过滤、avatar FQN 转换、备份 zip 结构）冻结，只准原样搬迁。
// 部分辅助（updateSettings 等）暂经 ../server 导入，3.5 拆 api/ 时收敛。

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { Database } from "bun:sqlite";
import type { JsonValue } from "../foundation/types";
import type { Settings } from "../foundation/types/settings";
import {
  ANDROID_ASR_PROVIDER_TYPES,
  ANDROID_MESSAGE_PART_TYPES,
  ANDROID_TTS_PROVIDER_TYPES,
} from "../foundation/types/android-contract";
import { isRecord, safeJsonStringify } from "../foundation/utils";
import { dataDir, filesDir, skillsDir } from "../foundation/paths";
import { isWindowsReservedName } from "../foundation/windows-names";
import { reportError } from "../observability/app-errors";
import { tempDir } from "../foundation/platform";
import { state } from "../persistence/json-store";
import { GLOBAL_MEMORY_ID, memoryStore } from "../memory/index";
import { DEFAULT_ASSISTANT_ID, collectConversationReferencedFileIds, exportPcConversationsDump, flushConvDirtyNow, getConversationsDb, loadConversationNodesFromDb } from "../conversations";
import { listAllConversationMetas } from "../conversations/read-queries";
import { collectPcFileRefs, hashFileSha256 } from "./file-refs";
import { createZipFromDirectory } from "./zip";
import { adaptWorkspaceToolPartForAndroid } from "./workspace-android-export";
import androidSchemaV24 from "./android-schema-v24.json";
import { exportSkills } from "../tools";

export function copyDirRecursive(src: string, dest: string): number {
  let count = 0;
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stats = statSync(srcPath);
    if (stats.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      count += copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath); // 5-7:内核级拷贝,>2GiB 不进 JS 堆
      count += 1;
    }
  }
  return count;
}

// 导出备份时剥离移动端无法识别的模型模态(AUDIO/VIDEO/DOCUMENT)。
// 移动端 Modality 枚举只有 TEXT/IMAGE,kotlinx.serialization 反序列化 List<Modality>
// 遇到这三个值会抛 SerializationException,导致整个 settings 恢复失败(Issue #11)。
// 另:LLM 体系里不存在"文档"模态,且 PC/移动端当前都没有音视频对话能力,这些配置对
// 用户只是无效元数据。
// 纯函数:深拷贝,绝不改动内存中的运行时 state.settings,只清洗"写入备份文件"的内容。
const BACKUP_INCOMPATIBLE_MODALITIES = new Set(["AUDIO", "VIDEO", "DOCUMENT"]);

function sanitizeModelModalitiesForExport(settings: Settings): Settings {
  return {
    ...settings,
    providers: (settings.providers ?? []).map((provider) => ({
      ...provider,
      models: (provider.models ?? []).map((modelItem) => {
        const filterMods = (mods: string[] | undefined): string[] => {
          const cleaned = (mods ?? []).filter(
            (m) => !BACKUP_INCOMPATIBLE_MODALITIES.has(String(m).toUpperCase()),
          );
          return cleaned.length ? cleaned : ["TEXT"];
        };
        return {
          ...modelItem,
          inputModalities: filterMods(modelItem.inputModalities),
          outputModalities: filterMods(modelItem.outputModalities),
        };
      }),
    })),
  };
}

// Backup payload that does NOT base64-inline file bytes — file data lives in
// the surrounding zip's `upload/<displayName>` entries, and only file metadata (id, fileName,
// mime, size) survives the JSON round-trip. This is the format used inside
// `pc-backup.json` of a zip backup, and is the only OOM-safe path for users with multi-GB
// of attachments (inlining base64 file bytes can easily push a couple GB of files into
// a JS string, blowing the V8 heap limit).
export function backupPayloadMetadataOnly(settingsOverride?: Settings, backupNameById?: Map<number, string>) {
  const settings = settingsOverride ?? state.settings;
  return {
    version: 2,
    app: "RikkaHub PC",
    exportedAt: new Date().toISOString(),
    // Exclude conversations from pc-backup.json — they're exported as rikka_hub.db now.
    // Including them here caused OOM crashes for users with large imported Android histories.
    state: {
      settings,
      generatedImages: state.generatedImages,
      // backupName = zip 内 upload/ 实际文件名(去重/重名规避后),恢复端据此回链原 id(批5)。
      files: state.files.map((file) =>
        backupNameById?.has(file.id) ? { ...file, backupName: backupNameById.get(file.id) } : file,
      ),
      memories: memoryStore.exportFlat(),
    },
    skills: exportSkills(),
    // 批5:移除曾经的顶层 files[] 副本——与 state.files 完全重复(含 extractedText 时是
    // 双份全文文本),zip 恢复端只读 state.files。老 JSON 备份的顶层 files(带 base64 data)
    // 由另一条导出路径生产,不受影响。
  };
}

// kotlinx.serialization uses the FQN of @Serializable subclasses as the polymorphic
// discriminator value (no @SerialName annotation on Avatar.Dummy / Emoji / Image, so the
// FQN is the default). PC internally uses short names — "dummy"/"emoji"/"image" — for
// brevity in the UI code paths. When we hand off settings.json to Android we must rewrite
// the avatar.type field to the FQN form, otherwise Android's BackupVM crashes with
// "Serializer for subclass 'dummy' is not found in the polymorphic scope of 'Avatar'".
// Same transform is applied in reverse when we import an Android-origin settings.json.
export const PC_AVATAR_TYPE_TO_ANDROID: Record<string, string> = {
  dummy: "me.rerere.rikkahub.data.model.Avatar.Dummy",
  emoji: "me.rerere.rikkahub.data.model.Avatar.Emoji",
  image: "me.rerere.rikkahub.data.model.Avatar.Image",
  url: "me.rerere.rikkahub.data.model.Avatar.Image",
};

export const ANDROID_AVATAR_TYPE_TO_PC: Record<string, string> = Object.fromEntries(
  Object.entries(PC_AVATAR_TYPE_TO_ANDROID).map(([pc, android]) => [android, pc]),
);

export function mapAvatarType(value: JsonValue, mapping: Record<string, string>): JsonValue {
  if (!isRecord(value)) return value;
  const type = String(value.type ?? "");
  if (!type || !mapping[type]) return value;
  return { ...value, type: mapping[type] };
}

/** 方向感知的 settings 转换。
 *  - "to-android"(默认,PC→APP 导出):映射 avatar + strip PC-only 字段 + role/reasoningLevel
 *    转小写 + 空 UUID 填随机。strip 是 Android kotlinx.serialization 的硬要求——PC-only 字段
 *    进去 Android 无法反序列化、Android Uuid 反序列化拒空串。
 *  - "to-pc"(APP→PC 导入):只映射 avatar(Android FQN → PC 短格式)。不 strip、不填 UUID、不动
 *    role——PC 端接受 null/大写,且 PC-only 字段(proxyConfig / preferredPort / 字体 / 助手的
 *    mcpToolOverrides 等)必须原样保留,否则一次导入就会清空 PC 上已配置的代理、端口、字体
 *    与 MCP 覆盖,也会把未选模型的 null chatModelId 填成不存在的随机 UUID。 */
export function rewriteAvatarsInSettings(settings: any, mapping: Record<string, string>, direction: "to-android" | "to-pc" = "to-android"): any {
  if (!isRecord(settings)) return settings;
  const stripPcOnly = direction === "to-android";
  const copy: any = { ...settings };
  if (Array.isArray(copy.assistants)) {
    copy.assistants = copy.assistants.map((a: any) => {
      if (!isRecord(a)) return a;
      const fixed: any = { ...a };
      if (fixed.avatar) fixed.avatar = mapAvatarType(fixed.avatar, mapping);
      if (stripPcOnly) {
        // reasoningLevel: PC uses "AUTO", Android expects "auto"
        if (typeof fixed.reasoningLevel === "string") fixed.reasoningLevel = fixed.reasoningLevel.toLowerCase();
        // 专题3 A-1:preset 消息统一成安卓 UIMessage 形状,详见 toAndroidPresetMessage。
        if (Array.isArray(fixed.presetMessages)) {
          fixed.presetMessages = fixed.presetMessages.map(toAndroidPresetMessage);
        }
        // Strip PC-only assistant fields that Android doesn't have.
        // 安卓对齐批6:allowConversationSystemPrompt 已是安卓正式字段(Assistant.kt),
        // 不再 strip——此前误删导致 PC→APP 后所有助手的会话级系统提示词开关归 false。
        delete fixed.mcpToolOverrides;
      }
      return fixed;
    });
  }
  // modeInjections role: PC uses "USER", Android expects "user"
  if (stripPcOnly && Array.isArray(copy.modeInjections)) {
    copy.modeInjections = copy.modeInjections.map((mi: any) =>
      isRecord(mi) && typeof mi.role === "string" ? { ...mi, role: mi.role.toLowerCase() } : mi,
    );
  }
  if (isRecord(copy.displaySetting)) {
    const displaySetting = { ...(copy.displaySetting as Record<string, JsonValue>) };
    if (displaySetting.userAvatar) {
      displaySetting.userAvatar = mapAvatarType(displaySetting.userAvatar, mapping);
    }
    if (stripPcOnly) {
      // Strip PC-only displaySetting fields that Android can't deserialize:
      // - chatFontFamilyCss: PC-only CSS field
      // - uiFontSize / chatFontSize: PC-only font size fields
      // - themeMode/colorTheme/userThemes/language: 专题8,UI 主题与语言的权威存储
      //   (从 localStorage 迁来,防端口变更导致 origin 隔离丢失)
      const pcOnlyDisplayFields = [
        "chatFontFamilyCss", "uiFontSize", "chatFontSize", "chatInputHeight",
        "themeMode", "colorTheme", "userThemes", "language",
      ];
      for (const field of pcOnlyDisplayFields) {
        if (field in displaySetting) delete displaySetting[field];
      }
      // 安卓对齐批6:chatFontFamily 只对安卓枚举外的值(PC 自由字体名/空串)strip;
      // 合法枚举(PreferencesStore.kt ChatFontFamily 的 SerialName)原样保留,
      // APP 用户的 serif/monospace 选择经 PC 往返不再退回 default。
      const androidChatFontFamilies = new Set(["default", "serif", "monospace", "custom"]);
      if ("chatFontFamily" in displaySetting && !androidChatFontFamilies.has(String(displaySetting.chatFontFamily))) {
        delete displaySetting.chatFontFamily;
      }
    }
    copy.displaySetting = displaySetting;
  }
  if (stripPcOnly) {
    // Strip PC-only top-level fields
    delete copy.proxyConfig;
    delete copy.preferredPort;
    delete copy.keybindings;
    // webPasswordHash 是 PC-only 敏感字段(访问密码派生哈希):APP 无此概念,且敏感值不该
    // 进跨端备份。pc-backup(PC→PC)不剥,跨机恢复带上(见 api/auth.ts)。
    delete copy.webPasswordHash;
    // shellPath 是机器级 bash 绝对路径,PC→APP/跨机恢复无意义;带到目标机反而因路径不存在
    // 锁死 bash(getShellConfig 对不存在的 customShellPath 抛错),故剥离,目标机走自动探测。
    delete copy.shellPath;
    // 专题3 S-1(机制,详见 filterSearchServicesForAndroid):PC-only 搜索服务过滤 +
    // 选中下标修正;全被过滤时删键,让安卓走自身默认值(避免空列表越界)。
    if (Array.isArray(copy.searchServices)) {
      const filtered = filterSearchServicesForAndroid(copy.searchServices, copy.searchServiceSelected);
      if (filtered.services.length !== copy.searchServices.length) {
        if (filtered.services.length === 0) {
          delete copy.searchServices;
          delete copy.searchServiceSelected;
        } else {
          copy.searchServices = filtered.services;
          copy.searchServiceSelected = filtered.selectedIndex;
        }
      }
    }
    // C3:TTS/ASR provider 白名单清洗——type 不在 vendored 安卓全集内的整体滤掉(否则撑爆旧 APP
    // 的 TTSProviderSetting/ASRProviderSetting 多态解码 = settings 恢复整体失败)。当前两端逐字对齐
    // 不会滤掉任何值;这是面向「PC 未来先加、APP 未跟上」的纵深。选中 id 随之重定位到首个幸存项。
    if (Array.isArray(copy.ttsProviders)) {
      const before = copy.ttsProviders;
      const kept = filterTtsProvidersForAndroid(before);
      if (kept.length !== before.length) {
        copy.ttsProviders = kept;
        const sel = String(copy.selectedTTSProviderId ?? "");
        copy.selectedTTSProviderId = kept.some((p) => isRecord(p) && String(p.id) === sel)
          ? sel
          : (isRecord(kept[0]) ? String(kept[0].id ?? "") : "");
      }
    }
    if (Array.isArray(copy.asrProviders)) {
      const before = copy.asrProviders;
      const kept = filterAsrProvidersForAndroid(before);
      if (kept.length !== before.length) {
        copy.asrProviders = kept;
        const sel = String(copy.selectedASRProviderId ?? "");
        copy.selectedASRProviderId = kept.some((p) => isRecord(p) && String(p.id) === sel)
          ? sel
          : (isRecord(kept[0]) ? String(kept[0].id ?? "") : "");
      }
    }
    // 订阅制供应商 OAuth 凭证(方案 §3 决策④):refresh token 是长效凭证,不扩散到移动端 zip。
    // 剥 authMode/oauth 但保留供应商行——chatModelId/favoriteModels 等引用仍可解析,APP 侧表现
    // 同「未填 key」。pc-backup(PC→PC)不剥,跨机恢复带上(免重登,与 apiKey 同策略)。
    if (Array.isArray(copy.providers)) {
      copy.providers = copy.providers.map((p: any) => {
        if (!isRecord(p) || (p.authMode === undefined && p.oauth === undefined)) return p;
        const stripped = { ...p };
        delete stripped.authMode;
        delete stripped.oauth;
        return stripped;
      });
    }
    // 快速模型收敛:PC 内部统一用 fastModelId(对齐 APP)。导出前清掉 2.4.16 之前残留的
    // titleModelId / suggestionModelId——新版 Android 的 Settings 数据类已删除这两个字段,
    // 发未知键会被其序列化器拒收(state-load 正常路径已删,这里兜备份合并等异常残留)。
    delete copy.titleModelId;
    delete copy.suggestionModelId;
    // Fix empty-string UUID fields — Android's Uuid deserializer rejects ""
    const uuidFields = ["chatModelId", "fastModelId", "translateModeId", "imageGenerationModelId", "ocrModelId", "compressModelId", "assistantId", "selectedTTSProviderId", "selectedASRProviderId"];
    for (const field of uuidFields) {
      if (field in copy && (copy[field] === "" || copy[field] === null || copy[field] === undefined)) {
        copy[field] = crypto.randomUUID();
      }
    }
  }
  return copy;
}

// ── 专题3 批2:PC→APP 消息/settings 契约助手 ─────────────────────────────────
// 安卓 JsonInstant 无 coerceInputValues:非空字段(即使有默认值)收到显式 null、密封类
// 收到未知判别符,都直接抛 SerializationException;settings 恢复整体失败,会话解码处
// (ConversationRepository.loadMessageNodes)更是零容错——一条脏消息 = 会话永久打不开。
// 以下助手都是纯函数,只作用于导出产物,PC 内部数据一律不动。

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** PC-only 搜索服务判别符(安卓 me.rerere.search.SearchService.kt 密封类没有的类型)。
 *  ⚠️ 事故记录(2026-07-28):曾误把 custom_js 登记于此——它其实是安卓正式类型
 *  (CustomJsOptions,全字段带默认值,透传完全兼容),过滤会静默丢用户配置。教训:
 *  人工核对安卓源码会看错模块,兼容性判定必须走 android-contract-sync.test.ts 的
 *  机械化分类(vendored 判别符全集 + 安卓仓库在场时直接从 Kotlin 源码比对)。
 *  当前 PC 可创建的服务类型全部为安卓所知 → 集合为空,机制保留待未来登记。 */
export const PC_ONLY_SEARCH_SERVICE_TYPES: ReadonlySet<string> = new Set<string>();

/** PC-only 消息 part 判别符。loading 是生成首 token 前的占位 part,正常路径在首个增量
 *  时摘除,但崩溃/断电会把它留在已持久化的消息里;安卓 UIMessagePart 无此判别符,
 *  流入即"会话打不开"(A-3,与 A-2 注解同族)。 */
export const PC_ONLY_MESSAGE_PART_TYPES: ReadonlySet<string> = new Set(["loading"]);

/** S-1 机制:按 PC-only 黑名单过滤搜索服务并重定位选中下标(黑名单而非安卓白名单——
 *  未来安卓新增类型经 PC 往返不能被误删)。pcOnlyTypes 参数化供测试注入。 */
export function filterSearchServicesForAndroid(
  services: unknown[],
  selectedIndex: unknown,
  pcOnlyTypes: ReadonlySet<string> = PC_ONLY_SEARCH_SERVICE_TYPES,
): { services: unknown[]; selectedIndex: number } {
  const selected = services[Number(selectedIndex) || 0];
  const kept = services.filter((svc) => !(isRecord(svc) && pcOnlyTypes.has(String(svc.type))));
  const idx = kept.indexOf(selected);
  return { services: kept, selectedIndex: idx >= 0 ? idx : 0 };
}

/** C3 降级兜底:把「安卓不认识」的消息 part 降级为占位 text part,而非原样硬发(硬发会让旧版
 *  APP 的 UIMessagePart 多态解码抛 SerializationException = 会话永久打不开)。保留原始类型名
 *  + 可读摘要,让用户在移动端至少看到「此处有一段桌面端新功能内容」。 */
export function downgradeUnknownPartForAndroid(part: Record<string, unknown>): Record<string, unknown> {
  const type = String(part.type ?? "unknown");
  const summary =
    typeof part.text === "string" && part.text.trim() ? part.text
    : typeof (part as { reasoning?: unknown }).reasoning === "string" && String((part as { reasoning?: unknown }).reasoning).trim() ? String((part as { reasoning?: unknown }).reasoning)
    : typeof part.toolName === "string" ? `[工具调用 ${part.toolName}]`
    : typeof part.url === "string" ? `[附件 ${part.url}]`
    : "";
  return { type: "text", text: `[此内容(${type})暂不支持移动端显示]${summary ? `\n${summary}` : ""}` };
}

/** A-3 + C3:导出方向的消息 part 清洗——「黑名单删除 + 白名单降级」双闸。
 *  ① PC-only 黑名单(loading 占位):删除,无信息量。
 *  ② 缺判别符的脏对象:删除(安卓多态解码即炸)。
 *  ③ 不在 vendored 安卓全集内的未知判别符:降级为占位 text part(C3 纵深——即便哨兵 C1 漏网、
 *     PC 先于 APP 产出新 part,也绝不让未知值硬发出去)。安卓已知类型原样透传。 */
export function filterMessagePartsForAndroid(
  parts: unknown[],
  pcOnlyTypes: ReadonlySet<string> = PC_ONLY_MESSAGE_PART_TYPES,
  counter?: { downgraded: number },
): unknown[] {
  return parts
    .filter((p) => isRecord(p) && typeof p.type === "string" && !pcOnlyTypes.has(p.type))
    .map((p) => {
      if (ANDROID_MESSAGE_PART_TYPES.has(String((p as Record<string, unknown>).type))) return p;
      if (counter) counter.downgraded += 1;
      return downgradeUnknownPartForAndroid(p as Record<string, unknown>);
    });
}

/** PC-only 消息注解判别符(安卓 UIMessageAnnotation 只有 url_citation;PC 生成失败时
 *  写入的 model_call_error 若流入安卓即"会话打不开")。pi-fidelity 是 P7 引擎消息
 *  保真注解(块结构/思维链签名),纯 PC 工作区语义,同样不得流入安卓。steered 是
 *  steer 插话用户消息的轻量标注(仅 PC 用于将来可选 UI 标记),同样不得流入安卓。 */
export const PC_ONLY_ANNOTATION_TYPES: ReadonlySet<string> = new Set(["model_call_error", "pi-fidelity", "compaction_boundary", "steered"]);

/** A-2:导出方向的注解清洗。只保留"带字符串判别符且非 PC-only"的注解——缺判别符的
 *  遗留脏对象与 PC-only 类型都会让安卓多态解码即炸;安卓自有/未来新增类型原样透传。 */
export function filterAnnotationsForAndroid(
  annotations: unknown,
  pcOnlyTypes: ReadonlySet<string> = PC_ONLY_ANNOTATION_TYPES,
): unknown[] {
  if (!Array.isArray(annotations)) return [];
  return annotations.filter(
    (a) => isRecord(a) && typeof a.type === "string" && !pcOnlyTypes.has(a.type),
  );
}

/** C3:导出方向的 TTS provider 清洗——type 不在 vendored 安卓全集内的整体过滤(否则会撑爆
 *  旧 APP 的 TTSProviderSetting 多态解码 = settings 恢复整体失败)。当前 PC 12 家与安卓逐字对齐,
 *  实际不会滤掉任何值;这是面向「PC 未来先加、APP 未跟上」的纵深防御。选中 id 由调用方重定位。 */
export function filterTtsProvidersForAndroid(providers: unknown): unknown[] {
  if (!Array.isArray(providers)) return [];
  return providers.filter((p) => isRecord(p) && ANDROID_TTS_PROVIDER_TYPES.has(String(p.type)));
}

/** C3:ASR provider 同理(ASRProviderSetting 多态解码)。 */
export function filterAsrProvidersForAndroid(providers: unknown): unknown[] {
  if (!Array.isArray(providers)) return [];
  return providers.filter((p) => isRecord(p) && ANDROID_ASR_PROVIDER_TYPES.has(String(p.type)));
}

/** A-1:把 PC 侧 preset 消息({role, content} 简化形态)转成安卓 UIMessage 形状。
 *  安卓 UIMessage.parts 必填(无默认值),缺失即 SerializationException;role 枚举
 *  @SerialName 为小写。已是安卓形态(带 parts,来自 APP→PC 透传)只做 role 卫生,
 *  不重复包装。显式 null 的 id/createdAt 删键让安卓默认值生效(非空字段拒 null)。 */
export function toAndroidPresetMessage(pm: unknown): unknown {
  if (!isRecord(pm)) return pm;
  const fixed: any = { ...pm };
  fixed.role = typeof fixed.role === "string" && fixed.role ? fixed.role.toLowerCase() : "user";
  if (!Array.isArray(fixed.parts)) {
    const content = typeof fixed.content === "string" ? fixed.content : "";
    fixed.parts = content ? [{ type: "text", text: content }] : [];
  }
  fixed.parts = filterMessagePartsForAndroid(fixed.parts);
  delete fixed.content;
  if (fixed.id == null || (typeof fixed.id === "string" && !UUID_RE.test(fixed.id))) delete fixed.id;
  if (fixed.createdAt == null) delete fixed.createdAt;
  return fixed;
}

/** Generate a Room-compatible SQLite database from PC's conversation data so Android can
 *  restore chat history from a PC-origin backup zip.
 *  专题3 T-1/T-2 重构:
 *  - 有 cached 模板(上次安卓导入的原库):以其为基底重建——PC 管理的表(会话/节点/记忆)
 *    清空重灌,其余安卓自有表(workspaces / conversation_folder / favorites / GenMedia 等)
 *    原样保留,ConversationEntity 上 PC 不认识的列(folder_id 等)按会话 id 回填。
 *    此前逐表重建只搬 PC 认识的数据,APP→PC→APP 一轮往返会清洗掉安卓侧其余数据(T-2)。
 *  - 无模板(纯 PC 用户首次导出):按 vendored 安卓 Room schema v24 全新建库。此前直接
 *    放弃生成,静默产出"安卓导入后没有任何会话"的 zip(T-1)。 */
/** 安卓会话库生成的降级统计:C3 白名单把「安卓不认识」的 part 降级成占位 text 时计数,
 *  由导出端汇成 X-Export-Warnings 透出(B2 联动)——用户必须知道「有内容在移动端会变成
 *  占位文本」,而不是拿到一份看似完整、实则降级的备份。 */
export interface AndroidDbBuildResult {
  ok: boolean;
  downgradedParts: number;
}

function generateRikkaHubDb(dbPath: string, backupNameById?: Map<number, string>): AndroidDbBuildResult {
  try {
    const cachedDbPath = join(dataDir, "rikka_hub_cached.db");
    const counter = { downgraded: 0 };
    if (existsSync(cachedDbPath)) {
      buildAndroidDbOnCachedBase(cachedDbPath, dbPath, backupNameById, counter);
    } else {
      buildAndroidDbFromVendoredSchema(dbPath, backupNameById, counter);
    }
    return { ok: true, downgradedParts: counter.downgraded };
  } catch (err) {
    reportError("backup", "error", "安卓会话库生成失败，导出包将不含会话", err, "android_db_export_failed");
    return { ok: false, downgradedParts: 0 };
  }
}

/** PC 写入的 ConversationEntity 列(与 insertConversationsIntoDb 的 INSERT 列集一致,
 *  改动必须同步)。其余列视为"安卓自有",cached 基底重建时按会话 id 回填——未来安卓
 *  加列无需 PC 改代码。 */
const PC_MANAGED_CONVERSATION_COLUMNS = new Set([
  "id", "assistant_id", "title", "nodes", "create_at", "update_at", "suggestions", "is_pinned", "custom_system_prompt",
  "mode_injection_ids", "lorebook_ids",
]);

/** T-2:以 cached 安卓库为基底重建。基底字节 deserialize 进内存库操作,只重灌 PC 管理
 *  的表,安卓自有表与未知列全部存活;结果 serialize 一次性落盘。FTS5 虚拟表整表 DROP
 *  (影子表随虚拟表自动删除;陈旧索引不该跟着新数据走,安卓 Room 会在 onOpen 重建。
 *  切勿把影子表当普通表留下——APP 端重建 FTS 虚拟表时会撞影子表名直接崩,这是旧实现
 *  用排除法换来的教训)。
 *  为何不直接在 stage 内的 dbPath 上操作(旧实现 copyFileSync 后 new Database(dbPath)):
 *  bun:sqlite 的 close() 是 sqlite3_close_v2 语义——存在未 finalize 的预编译语句时延迟
 *  关闭,句柄要等语句被 GC 才真正释放。Windows 上暂存 rikka_hub.db 因此一直被本进程
 *  锁着,-wal/-shm 删不掉,随后 PowerShell 压缩报"文件正被另一个进程使用"→ 导出
 *  HTTP 500(1.5.0 用户实测,仅 cached 基底路径踩中;vendored 路径在内存建库无此问题)。
 *  现改为:工作副本放系统临时目录(stage 之外)落盘操作,VACUUM + wal_checkpoint(TRUNCATE)
 *  归并后把主库文件字节拷入 stage——延迟释放的句柄只挂在临时目录文件上,stage 内的
 *  rikka_hub.db 从头到尾不存在打开的句柄。不用 Database.deserialize 走全内存:cached 库
 *  是 WAL 模式,其镜像 deserialize 后任何访问都报 SQLITE_CANTOPEN(内存库不支持 WAL)。 */
function buildAndroidDbOnCachedBase(cachedDbPath: string, dbPath: string, backupNameById?: Map<number, string>, counter?: { downgraded: number }): void {
  const workPath = join(tempDir(), `rikkahub-android-db-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  copyFileSync(cachedDbPath, workPath);
  const db = new Database(workPath);
  try {
    // ① 快照安卓自有列,重灌后按 id 回填。
    const convCols = (db.prepare("PRAGMA table_info(ConversationEntity)").all() as { name: string }[]).map((c) => c.name);
    const extraCols = convCols.filter((n) => !PC_MANAGED_CONVERSATION_COLUMNS.has(n));
    const extrasById = new Map<string, unknown[]>();
    if (extraCols.length > 0) {
      const colList = extraCols.map((c) => `"${c}"`).join(", ");
      for (const row of db.prepare(`SELECT id, ${colList} FROM ConversationEntity`).all() as Record<string, unknown>[]) {
        extrasById.set(String(row.id), extraCols.map((c) => row[c]));
      }
    }
    // ② DROP FTS5 虚拟表(连同影子表)。
    const ftsTables = (db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL").all() as { name: string; sql: string }[])
      .filter((t) => /\bUSING\s+fts5\b/i.test(t.sql));
    for (const t of ftsTables) db.exec(`DROP TABLE IF EXISTS "${t.name}"`);
    // ③ 清空并重灌 PC 管理的表。
    db.exec("DELETE FROM message_node");
    db.exec("DELETE FROM ConversationEntity");
    if (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='MemoryEntity'").get()) {
      db.exec("DELETE FROM MemoryEntity");
    }
    insertConversationsIntoDb(db, backupNameById, counter);
    insertMemoriesIntoDb(db);
    // ④ 回填安卓自有列(UPDATE 未命中 = 会话已在 PC 删除,自然跳过)。
    if (extraCols.length > 0 && extrasById.size > 0) {
      const setList = extraCols.map((c) => `"${c}" = ?`).join(", ");
      const update = db.prepare(`UPDATE ConversationEntity SET ${setList} WHERE id = ?`);
      for (const [convId, values] of extrasById) update.run(...(values as never[]), convId);
    }
    // ⑤ 基底继承的旧数据体积真正还地;checkpoint(TRUNCATE) 把 WAL 全量并回主库,
    //    使 workPath 主文件成为完整一致的库镜像,拷贝即成品。
    db.exec("VACUUM");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  copyFileSync(workPath, dbPath);
  // 工作副本尽力清理:延迟释放的句柄可能让删除失败,吞掉——文件在系统临时目录,无碍。
  for (const suffix of ["", "-wal", "-shm"]) {
    try { rmSync(workPath + suffix); } catch { /* best-effort */ }
  }
}

/** T-1:无模板时按 vendored 安卓 Room schema 全新建库。schema 文件是安卓仓库
 *  app/schemas/…/24.json 的逐字节副本(安卓升级 Room 版本后同步替换并更新文件名);
 *  setupQueries 自带 room_master_table 建表 + identityHash 写入(Room 打开时校验),
 *  android_metadata 由安卓框架管理,这里按惯例补一行 locale。 */
function buildAndroidDbFromVendoredSchema(dbPath: string, backupNameById?: Map<number, string>, counter?: { downgraded: number }): void {
  const schema = (androidSchemaV24 as {
    database: {
      version: number;
      entities: Array<{ tableName: string; createSql: string; indices?: Array<{ createSql: string }> }>;
      setupQueries?: string[];
    };
  }).database;
  const db = new Database(":memory:");
  try {
    db.exec(`PRAGMA user_version = ${Number(schema.version)}`);
    db.exec("CREATE TABLE android_metadata (locale TEXT)");
    db.prepare("INSERT INTO android_metadata VALUES (?)").run("en_US");
    for (const q of schema.setupQueries ?? []) db.exec(q);
    for (const entity of schema.entities) {
      db.exec(entity.createSql.replaceAll("${TABLE_NAME}", entity.tableName));
      for (const idx of entity.indices ?? []) {
        db.exec(idx.createSql.replaceAll("${TABLE_NAME}", entity.tableName));
      }
    }
    insertConversationsIntoDb(db, backupNameById, counter);
    insertMemoriesIntoDb(db);
    writeFileSync(dbPath, db.serialize());
  } finally {
    db.close();
  }
}

/** 把 PC 记忆写进 rikka_hub.db 的 MemoryEntity 表(PC→APP 方向,§7.7)。表结构从
 *  cached.db 克隆(id INTEGER PK AUTOINCREMENT / assistant_id TEXT / content TEXT)。
 *  防御:cached.db 若来自老版 APP(无 MemoryEntity 表),跳过,不影响会话。
 *  id 不写:SQLite AUTOINCREMENT 分配(对称 APP→PC 导入丢弃 id 重分配,backup/import.ts)。
 *  时间戳不写:APP 的 MemoryEntity 表无此列。整体替换语义下助手+记忆同源 assistantId,天然匹配。 */
function insertMemoriesIntoDb(db: InstanceType<typeof Database>) {
  const hasTable = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='MemoryEntity'").get();
  if (!hasTable) return;
  const flat = memoryStore.exportFlat();
  if (flat.length === 0) return;
  const stmt = db.prepare("INSERT INTO MemoryEntity (assistant_id, content) VALUES (?, ?)");
  const seen = new Set<string>();
  for (const m of flat) {
    const content = String(m.content ?? "").trim();
    if (!content) continue;
    const assistantId = String(m.assistantId ?? GLOBAL_MEMORY_ID) || GLOBAL_MEMORY_ID;
    const key = `${assistantId} ${content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stmt.run(assistantId, content);
  }
}

// ----- 1.2.6 迁移:state.json conversations → 活库(一次性,P1)-----
//
// 触发条件:state.json 仍含 conversations 数组 且 appliedMigrations 不含
// "conversations-sqlite-1.2.6"。流程(崩溃安全):
//   ① 备份 state.json → state.json.pre-sqlite.bak(降级安全网,已存在不覆盖)
//   ② 灌库(单事务,INSERT OR REPLACE 幂等)
//   ③ 写瘦 state.json(删 conversations + 加迁移标记,temp+rename 原子)
// 崩在 ①②:state.json 未变,重跑幂等;崩在 ③:temp 未 rename,重跑。无数据丢失。

// 安卓对齐批6:PC 消息里的附件引用是 /api/files/<id>/content,安卓无法解析(此前 PC→APP
// 全部裂图)。导出时反向重写成安卓自身的 upload 绝对路径 URI(与安卓消息内的原生形态一致,
// PC 导入端 rewriteAndroidFileUrl 的 upload/<name> 正则也能精确逆回)。文件名做 JSON 转义。
/** 安卓对齐批6(审查A P0):ToolPart.output 里的 {error}/{pending} 历史载荷没有 type 判别符,
 *  安卓 sealed 多态解码抛 SerializationException 且读会话处无容错。对齐安卓自身写法
 *  (GenerationHandler 把错误 JSON 包成 text part)。仅用于导出产物,PC 内部契约不动。 */
export function wrapToolOutputEntriesForAndroid(output: unknown[]): unknown[] {
  return output.map((entry: any) =>
    entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.type !== "string"
      ? { type: "text", text: JSON.stringify(entry) }
      : entry,
  );
}

const ANDROID_UPLOAD_URI_PREFIX = "file:///data/user/0/me.rerere.rikkahub/files/upload/";
export function rewritePcUrlsToAndroidUpload(jsonText: string, backupNameById: Map<number, string>): string {
  return jsonText.replace(/\/api\/files\/(\d+)\/content/g, (whole, idStr: string) => {
    const name = backupNameById.get(Number(idStr));
    if (name === undefined) return whole;
    return `${ANDROID_UPLOAD_URI_PREFIX}${JSON.stringify(name).slice(1, -1)}`;
  });
}

function insertConversationsIntoDb(db: InstanceType<typeof Database>, backupNameById?: Map<number, string>, counter?: { downgraded: number }) {
  // 安卓对齐批6:模板列存在时回写 custom_system_prompt(会话级系统提示词),按 PRAGMA
  // 判该列可否为 null。模板较老没有该列时保持 8 列写入,不破坏旧模板兼容。
  const convCols = db.prepare("PRAGMA table_info(ConversationEntity)").all() as { name: string; notnull: number }[];
  const cspCol = convCols.find((c) => c.name === "custom_system_prompt");
  // 专题9:会话级注入绑定列(安卓 mode_injection_ids/lorebook_ids,JSON 数组字符串)。
  // 与 custom_system_prompt 同策略:模板有列才写,老模板保持原列集不破坏兼容。
  const hasInjectionCols = convCols.some((c) => c.name === "mode_injection_ids") && convCols.some((c) => c.name === "lorebook_ids");
  const extraCols = [
    ...(cspCol ? ["custom_system_prompt"] : []),
    ...(hasInjectionCols ? ["mode_injection_ids", "lorebook_ids"] : []),
  ];
  const allCols = ["id", "assistant_id", "title", "nodes", "create_at", "update_at", "suggestions", "is_pinned", ...extraCols];
  const insertConv = db.prepare(
    `INSERT OR REPLACE INTO ConversationEntity (${allCols.join(", ")}) VALUES (${allCols.map(() => "?").join(", ")})`,
  );
  const insertNode = db.prepare("INSERT OR REPLACE INTO message_node (id, conversation_id, node_index, messages, select_index) VALUES (?, ?, ?, ?, ?)");
  // DB-first 批1:导出全走活库(先 flush 对齐脏数据),逐会话瞬时读,峰值内存=单会话。
  flushConvDirtyNow();
  const liveDb = getConversationsDb();
  const exportMetas = liveDb ? listAllConversationMetas(liveDb) : [];
  const txn = db.transaction(() => {
    for (const conv of exportMetas) {
      try {
        const baseVals: (string | number | null)[] = [conv.id, conv.assistantId || DEFAULT_ASSISTANT_ID, conv.title || "", "[]", conv.createAt || Date.now(), conv.updateAt || Date.now(), JSON.stringify(conv.chatSuggestions || []), conv.isPinned ? 1 : 0];
        if (cspCol) baseVals.push(conv.systemPrompt ? conv.systemPrompt : (cspCol.notnull ? "" : null));
        if (hasInjectionCols) {
          baseVals.push(JSON.stringify(conv.modeInjectionIds ?? []), JSON.stringify(conv.lorebookIds ?? []));
        }
        insertConv.run(...baseVals);
        const convNodes = liveDb ? loadConversationNodesFromDb(liveDb, conv.id) : [];
        for (let i = 0; i < convNodes.length; i++) {
          const node = convNodes[i];
          if (!node?.id) continue;
          const toLocalDt = (v: any) => typeof v === "string" ? v.replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "") : v;
          const toInstant = (v: any) => typeof v === "string" && v && !v.endsWith("Z") && !/[+-]\d{2}:\d{2}$/.test(v) ? v + "Z" : v;
          const fixParts = (parts: any[]) => parts.map((p: any) => {
            if (!p || typeof p !== "object") return p;
            let fixed = { ...p };
            if (fixed.createdAt) fixed.createdAt = toInstant(fixed.createdAt);
            if (fixed.finishedAt) fixed.finishedAt = toInstant(fixed.finishedAt);
            if (fixed.type === "tool") {
              // M3-2(§9.1B 增强层):pi 形状 → 安卓 workspace_* 原生形状,换原生 diff/终端卡渲染。
              fixed = adaptWorkspaceToolPartForAndroid(fixed);
              // 安卓对齐批6(审查A P0):无判别符工具载荷包装成 text part,详见 wrapToolOutputEntriesForAndroid。
              if (Array.isArray(fixed.output)) {
                fixed.output = wrapToolOutputEntriesForAndroid(fixed.output);
              }
            }
            return fixed;
          });
          const msgs = (node.messages || []).map((m: any) => {
            const out: Record<string, unknown> = {
              // E-1:安卓 UIMessage.id 是非空 Uuid(有默认值但拒显式 null/非法格式),
              // 旧实现写 id: null → 含该消息的会话在安卓端解码即炸(会话永久打不开)。
              id: typeof m.id === "string" && UUID_RE.test(m.id) ? m.id : crypto.randomUUID(),
              role: String(m.role || "user").toLowerCase(),
              // A-3:PC-only part(loading 占位)与缺判别符脏对象过滤,详见助手注释。
              parts: filterMessagePartsForAndroid(fixParts(m.parts || []), PC_ONLY_MESSAGE_PART_TYPES, counter),
              // A-2:PC-only 注解(model_call_error)与缺判别符脏对象过滤,详见助手注释。
              annotations: filterAnnotationsForAndroid(m.annotations),
              finishedAt: toLocalDt(m.finishedAt) ?? null,
              modelId: typeof m.modelId === "string" && UUID_RE.test(m.modelId) ? m.modelId : null,
              usage: m.usage || null,
              translation: m.translation || null,
            };
            // createdAt 非空但有默认值:显式 null 会炸,缺键则走安卓默认(finishedAt 可空,照写)。
            const createdAt = toLocalDt(m.createdAt);
            if (createdAt != null) out.createdAt = createdAt;
            return out;
          });
          const nodeJson = JSON.stringify(msgs);
          insertNode.run(node.id, conv.id, i, backupNameById ? rewritePcUrlsToAndroidUpload(nodeJson, backupNameById) : nodeJson, node.selectIndex ?? 0);
        }
      } catch (err) { console.warn(`[backup] skipping conversation ${conv.id}: ${err}`); }
    }
  });
  txn();
}

// Writes the backup zip directly to a caller-provided path and returns its size. Used
// by the local-export endpoint to avoid pulling the whole zip into a Buffer just to turn
// around and stream it as the HTTP response — for users with multi-GB attachments, the zip
// itself can exceed 4 GB and Buffer.from(...) on it is an OOM in waiting.
// 收集全系统对文件 id 的引用:state 全量 JSON(设置头像/生图画廊 url 等)+ 活库全部节点
// messages(消息附件/工具输出图)+ generatedImages.fileId 数字引用。宁可多留不可错删:
// 引用扫描为并集,只有任何形态都未命中的条目(孤儿:删会话不删文件、画廊截断遗留等)
// 才不进备份。调用方需先 flushConvDirtyNow() 保证活库为最新。
// ── 5-2 自适应压缩超时 ─────────────────────────────────────────
// 固定 120s 在多 GB 附件库 + 机械盘上必然超时(进程被杀,导出报 "Zip creation
// failed")。按暂存目录实际体积折算:基础 120s + 按 8 MB/s 保守压缩吞吐每 MB
// 加 125ms,上限 30 分钟。导入侧解压本就无超时,导出侧对齐为"够用而有界"。
export function adaptiveZipTimeoutMs(totalBytes: number): number {
  const BASE_MS = 120_000;
  const MS_PER_MB = 125;
  const CAP_MS = 30 * 60_000;
  return Math.min(BASE_MS + Math.round((totalBytes / (1024 * 1024)) * MS_PER_MB), CAP_MS);
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
}

// ── 5-3 附件暂存失败不再静默吞 ─────────────────────────────────
// 磁盘满/文件名含 Windows 非法字符时 writeFileSync 失败,原实现只 console.warn,
// 用户拿到"看似成功"的不完整备份。改为计数返回,由调用方 reportError 上报
// (与 missingSkipped 同等待遇——staging 写失败恰恰是更严重的那种)。
export function stageUploadFilesInto(
  uploadStage: string,
  copies: Array<{ srcPath: string; name: string }>,
  onProgress?: (msg: string) => void,
): { staged: number; failed: number; firstError?: string } {
  let staged = 0;
  let failed = 0;
  let firstError: string | undefined;
  let done = 0;
  for (const { srcPath, name } of copies) {
    done++;
    onProgress?.(`正在打包附件 (${done}/${copies.length})...`);
    try {
      copyFileSync(srcPath, join(uploadStage, name)); // 5-7:同上
      staged++;
    } catch (copyErr) {
      failed++;
      if (!firstError) firstError = `${name}: ${copyErr}`;
      console.warn("[backup] failed to stage upload file", srcPath, copyErr);
    }
  }
  return { staged, failed, firstError };
}

// R1-13:数据目录卫生的孤儿附件统计复用本扫描器,导出。
export function collectReferencedFileIds(): Set<number> {
  const ids = new Set<number>();
  collectPcFileRefs(safeJsonStringify(state), ids);
  for (const img of state.generatedImages ?? []) {
    if (typeof img.fileId === "number") ids.add(img.fileId);
  }
  const db = getConversationsDb();
  if (db) {
    // B1:消息节点引用收集经 SQL LIKE 预筛(只把含 /api/files/ 的节点搬进 JS 抽取),
    // 不再把全库 messages 文本搬进 JS 堆——海量会话库的导出峰值从「全库文本」降到「仅命中行」。
    collectConversationReferencedFileIds(db, ids);
  }
  return ids;
}

type UploadStagingPlan = {
  copies: Array<{ srcPath: string; name: string }>;
  backupNameById: Map<number, string>;
  totalFiles: number;
  missingSkipped: number;
  orphanSkipped: number;
  dedupedCount: number;
};

// 批5:附件 staging 计划。①无引用孤儿不进备份;②内容 sha256 去重(只对尺寸碰撞组计算,
// 避免全量读盘两遍),重复内容共享同一 zip 内文件名——多个 id 的 backupName 指向同一份字节,
// 恢复端天然归并;③重名规避沿用 stem_<id>.ext。
// R4-6:备份 staging 文件名跨平台清洗。fileName 可能来自 Linux/安卓上传(那边 :*?"<>|
// 等字符合法),Windows 上 copyFileSync 会炸,该附件永远缺席备份且用户无解。backupName
// 与原名本就解耦(pc-backup.json 按 backupName 回链,manifest 与 zip 同源于同一产出),
// 清洗零副作用。四步:①非法字符、控制符与 #(D4 复查:# 是引用 URL 的锚分隔符,含 # 的文件名跨端往返后引用失效) → _;②剥结尾点/空格(Windows 目录项非法尾缀);
// ③CON/PRN/AUX/NUL/COM1-9/LPT1-9 设备保留名(裸名或带任意扩展名)加 _ 前缀;④超长名
// 截干保尾缀(staging 与解包都落真实文件系统,常见上限 255 字节,150 字符对多字节留足余量)。
// 清洗后为空由调用方回退 <id>.<ext>;清洗后撞名由调用方 usedNames 去重兜底。
export function sanitizeStagingFileName(rawName: string): string {
  let name = rawName.replace(/[<>:"/\\|?*#\x00-\x1f]/g, "_").replace(/[. ]+$/, "");
  // 设备保留名判定单源于 foundation/windows-names(问题4);此处"加 _ 前缀"的清洗行为冻结。
  if (isWindowsReservedName(name)) name = `_${name}`;
  if (name.length > 150) {
    const ext = extname(name);
    name = name.slice(0, 150 - ext.length) + ext;
  }
  return name;
}

function buildUploadStagingPlan(): UploadStagingPlan {
  const referenced = collectReferencedFileIds();
  const resolved: Array<{ file: (typeof state.files)[number]; srcPath: string; size: number }> = [];
  let missingSkipped = 0;
  let orphanSkipped = 0;
  for (const file of state.files) {
    // path 可能因跨机器/跨平台迁移 state.json、或 dataDir 漂移而失效(指向不存在的文件)。
    // PC 文件命名固定为 <id>.<ext>,path 找不到时回退到 filesDir 下按 id 重找,尽量不丢附件。
    let srcPath = file.path;
    if (!srcPath || !existsSync(srcPath)) {
      const ext = extname(file.fileName || "") || extname(file.path || "") || "";
      const fallback = join(filesDir, `${file.id}${ext}`);
      srcPath = existsSync(fallback) ? fallback : "";
    }
    if (!srcPath) {
      missingSkipped++;
      continue;
    }
    if (!referenced.has(file.id)) {
      orphanSkipped++;
      continue;
    }
    // 5-7:existsSync↔statSync 窗口内文件被删(TOCTOU)按缺失跳过,不炸整个导出。
    try {
      resolved.push({ file, srcPath, size: statSync(srcPath).size });
    } catch {
      missingSkipped++;
    }
  }
  const sizeCount = new Map<number, number>();
  for (const r of resolved) sizeCount.set(r.size, (sizeCount.get(r.size) ?? 0) + 1);
  const usedNames = new Set<string>();
  const nameByHash = new Map<string, string>();
  const backupNameById = new Map<number, string>();
  const copies: Array<{ srcPath: string; name: string }> = [];
  let dedupedCount = 0;
  for (const { file, srcPath, size } of resolved) {
    const hash = (sizeCount.get(size) ?? 0) > 1 ? hashFileSha256(srcPath) : null;
    if (hash) {
      const prior = nameByHash.get(hash);
      if (prior) {
        backupNameById.set(file.id, prior);
        dedupedCount++;
        continue;
      }
    }
    // R4-6:跨平台清洗见 sanitizeStagingFileName(非法字符/尾缀/设备保留名/超长名)。
    const sanitized = sanitizeStagingFileName(file.fileName || "");
    let name = sanitized || `${file.id}${extname(srcPath) || ""}`;
    if (usedNames.has(name)) {
      const ext = extname(name);
      const stem = name.slice(0, name.length - ext.length);
      name = `${stem}_${file.id}${ext}`;
    }
    usedNames.add(name);
    if (hash) nameByHash.set(hash, name);
    backupNameById.set(file.id, name);
    copies.push({ srcPath, name });
  }
  return { copies, backupNameById, totalFiles: state.files.length, missingSkipped, orphanSkipped, dedupedCount };
}

/** B4-①:导出返回值。size=zip 字节数;warnings=关键降级项(安卓库失败/附件暂存失败),
 *  经 X-Export-Warnings header 透出给前端显式 toast——用户必须知道"备份成功了但缺会话库"。 */
export interface BackupExportResult {
  size: number;
  warnings: string[];
}

export function createSettingsBackupZipToPath(targetZipPath: string, onProgress?: (message: string) => void): BackupExportResult {
  const warnings: string[] = [];
  const tmpRoot = join(tempDir(), `rikkahub-backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const stageDir = join(tmpRoot, "stage");
  mkdirSync(stageDir, { recursive: true });
  try {
    // 批5:先算附件 staging 计划(引用收集 + 内容去重 + zip 内文件名分配),让每个条目的
    // backupName 随 pc-backup.json 元数据导出,恢复端据此精确回链原 id。
    // 专题3 H-1:计划必须先于 settings.json 落盘——settings 里的头像/生图 URL 要按
    // backupNameById 反写成安卓 upload URI。
    onProgress?.("正在分析附件引用...");
    flushConvDirtyNow();
    const uploadPlan = buildUploadStagingPlan();
    onProgress?.("正在准备配置文件...");
    console.log(`[backup] staging settings.json...`);
    // 导出时剥离移动端不兼容的模型模态(AUDIO/VIDEO/DOCUMENT),避免移动端导入崩溃
    // (Issue #11)。仅作用于备份文件内容,不改内存中的运行时 state.settings。
    // 专题3 H-1:settings.json 里的 /api/files/<id>/content(助手/用户头像等)反写成安卓
    // upload URI——附件字节一直都在 zip 里,唯独 settings 的 URL 此前没改写,这就是
    // "导入 APP 后头像丢失"的根因;pc-backup.json 保持 PC 形态,PC→PC 恢复走原有回链。
    const sanitizedSettings = sanitizeModelModalitiesForExport(state.settings);
    writeFileSync(
      join(stageDir, "settings.json"),
      rewritePcUrlsToAndroidUpload(
        safeJsonStringify(rewriteAvatarsInSettings(sanitizedSettings, PC_AVATAR_TYPE_TO_ANDROID)),
        uploadPlan.backupNameById,
      ),
    );
    console.log(`[backup] staging pc-backup.json...`);
    writeFileSync(
      join(stageDir, "pc-backup.json"),
      safeJsonStringify(backupPayloadMetadataOnly(sanitizedSettings, uploadPlan.backupNameById)),
    );
    // 备份 2.0:PC 原生会话 dump——PC→PC 恢复的权威载体,与安卓模板解耦。活库已打开即
    // 无条件生成(零会话也写:恢复端以 dump 存在为准执行替换语义);安卓端导入对未知
    // 文件容忍跳过,不影响 PC→APP 通路。失败仅告警,老的 rikka_hub.db 通路仍在兜底。
    onProgress?.("正在导出会话数据库...");
    try {
      flushConvDirtyNow();
      const dumped = exportPcConversationsDump(join(stageDir, "pc_conversations.db"));
      if (dumped >= 0) console.log(`[backup] pc_conversations.db staged (${dumped} conversations)`);
    } catch (dumpErr) {
      reportError("backup", "error", "PC 会话库导出失败，恢复时将回退安卓格式", dumpErr, "pc_db_export_failed");
    }
    if ((getConversationsDb() ? listAllConversationMetas(getConversationsDb()!).length : 0) > 0 || memoryStore.exportFlat().length > 0) {
      onProgress?.("正在生成对话数据库...");
      const dbPath = join(stageDir, "rikka_hub.db");
      try {
        const dbResult = generateRikkaHubDb(dbPath, uploadPlan.backupNameById);
        if (dbResult.ok) {
          if (dbResult.downgradedParts > 0) {
            // B2↔C3:有 part 被白名单降级成占位文本——知情透出,不再是「看似完整的降级备份」。
            warnings.push(`${dbResult.downgradedParts} 段内容移动端暂不支持，已在备份中降级为占位文本`);
          }
          for (const suffix of ["-wal", "-shm", "-journal"]) {
            const p = dbPath + suffix;
            if (existsSync(p)) try { rmSync(p); } catch { /* */ }
          }
          writeFileSync(join(stageDir, "rikka_hub-wal"), Buffer.alloc(0));
          writeFileSync(join(stageDir, "rikka_hub-shm"), Buffer.alloc(0));
        } else {
          if (existsSync(dbPath)) try { rmSync(dbPath); } catch { /* */ }
          // B4-①:rikka_hub.db 是 PC→APP 会话的唯一载体,失败=该备份恢复后无会话。分级降级:
          // zip 仍产出(PC→PC 走 pc_conversations.db 不受影响),但记 warning 让前端显式告知。
          warnings.push("对话数据库(rikka_hub.db)生成失败，本备份恢复到移动端将不含会话");
        }
      } catch (dbErr) {
        console.error("[backup] generateRikkaHubDb failed:", dbErr);
        if (existsSync(dbPath)) try { rmSync(dbPath); } catch { /* */ }
        warnings.push("对话数据库(rikka_hub.db)生成失败，本备份恢复到移动端将不含会话");
      }
    }
    if (uploadPlan.copies.length > 0) {
      const uploadStage = join(stageDir, "upload");
      mkdirSync(uploadStage, { recursive: true });
      const stageResult = stageUploadFilesInto(uploadStage, uploadPlan.copies, onProgress);
      if (stageResult.failed > 0) {
        reportError("backup", "error", `${stageResult.failed}/${uploadPlan.copies.length} 个附件暂存失败，备份不完整；首个错误：${stageResult.firstError}`, undefined, "staging_failed", { failed: stageResult.failed, total: uploadPlan.copies.length, firstError: stageResult.firstError ?? "" });
        // B4-①:附件缺失属"备份不完整"的关键降级,同样透出给前端。
        warnings.push(`${stageResult.failed}/${uploadPlan.copies.length} 个附件未能打进备份`);
      }
    }
    if (uploadPlan.missingSkipped > 0) {
      reportError("backup", "warn", `${uploadPlan.missingSkipped}/${uploadPlan.totalFiles} 个附件源文件缺失，未包含在备份中`, undefined, "attachments_missing", { missing: uploadPlan.missingSkipped, total: uploadPlan.totalFiles });
    }
    if (uploadPlan.orphanSkipped > 0 || uploadPlan.dedupedCount > 0) {
      console.log(`[backup] upload staging: 跳过 ${uploadPlan.orphanSkipped} 个无引用孤儿文件, 内容去重 ${uploadPlan.dedupedCount} 个`);
    }
    if (existsSync(skillsDir)) {
      onProgress?.("正在打包技能文件...");
      const skillsStage = join(stageDir, "skills");
      mkdirSync(skillsStage, { recursive: true });
      copyDirRecursive(skillsDir, skillsStage);
    }
    // P7:引擎会话状态(压缩记录)在会话行内,随 PC 库 dump 一体进备份——P5 的
    // pi-sessions/ jsonl 打包段随层退役,备份面回归"库即全部"。
    // 安卓对齐批6:fonts/ 透传(安卓 2.4.2 新增自定义聊天字体)。PC 不消费,仅忠实搬运,
    // 保证 APP→PC→APP 往返不丢字体文件(导入侧对应 importFontsDirIfPresent)。
    const fontsDir = join(dataDir, "fonts");
    if (existsSync(fontsDir)) {
      const fontsStage = join(stageDir, "fonts");
      mkdirSync(fontsStage, { recursive: true });
      copyDirRecursive(fontsDir, fontsStage);
    }
    onProgress?.("正在压缩...");
    if (existsSync(targetZipPath)) rmSync(targetZipPath);
    const zipTimeoutMs = adaptiveZipTimeoutMs(dirSizeBytes(stageDir));
    console.log(`[backup] creating zip from ${stageDir} → ${targetZipPath} (${readdirSync(stageDir).join(", ")})`);
    // Z-1:打包收敛到 backup/zip.ts 单入口(Windows 打包后按中央目录做条目名归一化)。
    // 安卓端按 "upload/" 等前缀匹配,反斜杠条目会被静默跳过,详见 zip.ts 头注。
    createZipFromDirectory(stageDir, targetZipPath, zipTimeoutMs);
    if (!existsSync(targetZipPath)) {
      throw new Error("Zip file was not created (file missing after archiver exited 0)");
    }
    return { size: statSync(targetZipPath).size, warnings };
  } finally {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
