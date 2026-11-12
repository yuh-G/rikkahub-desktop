// backup/import.ts — 备份导入（PC json/zip 与 Android zip，含 Android 会话/文件/记忆导入）
// 纪律：Android 互导契约（FTS5 影子表排除、MemoryEntity、settings 合并、迁移常量）冻结，只准原样搬迁。
// 部分辅助暂经 ../server 导入，3.5 拆 api/ 时收敛。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { writeExtractedTextSidecar } from "../files/index";
import { dirname, extname, join } from "node:path";
import { Database } from "bun:sqlite";
import type { AssistantMemory, Conversation, JsonValue, Message, MessageNode, MessagePart, PcWorkspaceRow, State, StoredFile } from "../foundation/types";
import { guessMimeFromExt, isRecord, mergeById, uniqueStrings } from "../foundation/utils";
import { dataDir, filesDir, skillsDir, statePath } from "../foundation/paths";
import { tempDir } from "../foundation/platform";
import { CONVERSATIONS_SQLITE_MIGRATION, MEMORY_FILE_SPLIT_MIGRATION, saveState, setState, state } from "../persistence/json-store";
import { GLOBAL_MEMORY_ID, memoryStore } from "../memory/index";
import { invalidateContextSnapshots } from "../inference-engine/context-snapshots";
import { readEngineTables } from "../conversations/engine-entries";
import { clearConvDirtyState, DEFAULT_ASSISTANT_ID, getConversationsDb, loadAllConversationsFromDb, loadConversationNodesFromDb, resetConversationsDbTo, snapshotConversationsDbBeforeImport } from "../conversations";
import { reportError } from "../observability/app-errors";
import { hashFileSha256, rewriteAndroidFileUrlsDeep, rewritePcFileUrlsDeep } from "./file-refs";
import { clearWorkingSet } from "../conversations/working-set";
import { clearAllPendingBroadcasts } from "../api/sse";
import { importSkills } from "../tools";
import { ANDROID_AVATAR_TYPE_TO_PC, copyDirRecursive, rewriteAvatarsInSettings } from "./export";
import { broadcastList, broadcastSettings } from "../api/sse";
import { defaultSettings } from "../app-config/defaults";
import { FILE_DEDUP_MIGRATION, normalizeState, PROVIDER_REORDER_MIGRATION, PROVIDER_REORDER_MIGRATION_V2 } from "../persistence/state-load";
import { generating } from "../conversations/generation-state";
import { listAllConversationMetas } from "../conversations/read-queries";

// ── B2:结构化导入报告 ────────────────────────────────────────────────────────
// 导入过程的「跳过/降级」此前只进 console,用户在 UI 只看到「成功/没反应」。现把三类
// 关键降级聚合成结构化计数,由 handler 拼成人类可读的 warnings 透出(对齐导出侧
// X-Export-Warnings 机制)。messageNodesUnreadable 是存量静默(坏节点 JSON → []),
// 升级为可见——一条脏消息不再无声消失。
export interface ImportReport {
  filesDeduped: number;
  /** 备份声称有会话库、但读取失败(settings 已降级恢复,会话丢)——独立字段供明确文案。 */
  dbReadError: string | null;
  messageNodesUnreadable: number;
}

export function newImportReport(): ImportReport {
  return { filesDeduped: 0, dbReadError: null, messageNodesUnreadable: 0 };
}

/** 把结构化计数翻译成用户可读警告(仅列出实际发生的降级)。 */
export function buildImportWarnings(report: ImportReport): string[] {
  const warnings: string[] = [];
  if (report.dbReadError) {
    warnings.push(`对话历史导入失败:${report.dbReadError}——已降级为仅恢复设置`);
  }
  if (report.messageNodesUnreadable > 0) {
    warnings.push(`${report.messageNodesUnreadable} 条消息因备份内数据损坏被跳过`);
  }
  if (report.filesDeduped > 0) {
    warnings.push(`${report.filesDeduped} 个附件与本机已有内容一致，已复用（未重复占用空间）`);
  }
  return warnings;
}

// —— N-5 custom_js 导入告警 —————————————————————————————————————————————
// custom_js 搜索服务的 searchScript/scrapeScript 会在本机进程内执行（search/index.ts 的
// runCustomJsFunction，AsyncFunction 无沙箱）。脚本本是用户自配，但设置随备份导入导出，
// 恶意备份 zip/json 是现实的社工攻击路径。策略：导入前对现有脚本做签名快照，导入后只对
// "新增或脚本内容变化"的服务告警——用户自己配置过且未变的服务不重复提示，避免告警疲劳。
export function customJsScriptSignatures(settings: unknown): Map<string, string> {
  const signatures = new Map<string, string>();
  if (!isRecord(settings) || !Array.isArray(settings.searchServices)) return signatures;
  for (const service of settings.searchServices) {
    if (!isRecord(service) || String(service.type ?? "") !== "custom_js") continue;
    const searchScript = String(service.searchScript ?? "").trim();
    const scrapeScript = String(service.scrapeScript ?? "").trim();
    if (!searchScript && !scrapeScript) continue;
    signatures.set(String(service.id ?? ""), String(Bun.hash(`${searchScript}\x00${scrapeScript}`)));
  }
  return signatures;
}

export function customJsImportWarning(beforeSignatures: Map<string, string>, settingsAfter: unknown): string | null {
  const afterSignatures = customJsScriptSignatures(settingsAfter);
  if (afterSignatures.size === 0 || !isRecord(settingsAfter) || !Array.isArray(settingsAfter.searchServices)) return null;
  const names: string[] = [];
  for (const service of settingsAfter.searchServices) {
    if (!isRecord(service)) continue;
    const id = String(service.id ?? "");
    const signature = afterSignatures.get(id);
    if (!signature || beforeSignatures.get(id) === signature) continue;
    names.push(String(service.name ?? "custom_js"));
  }
  if (names.length === 0) return null;
  return `安全提醒：本次导入包含 ${names.length} 个自定义 JS 搜索脚本（${names.join("、")}）。这类脚本会在本机执行，请确认备份来源可信；如不确定，请到 设置 → 网络 → 搜索引擎 中检查或删除对应服务。`;
}

/** 七层合并·层3修正(Linux 用户实测"导入后设置覆盖不完全"):含 apiKey 的集合
 *  (providers/asrProviders/ttsProviders)同 id 时并非无条件保 PC——PC 的默认供应商与
 *  安卓共享同一批固定 UUID(互导契约刻意对齐),全新安装的 PC 条目全是无 key 出厂默认,
 *  裸 mergeById(PC, APP) 会把手机上配好的 key/模型列表/启用状态整条挡在门外。
 *  与 mergeSearchByType 同规则:同 id 且 APP 配了 apiKey 而 PC 没配 → 采用 APP 条目
 *  (key 与模型定义一起进来);PC 已配 key → 保 PC(层3原意:保护 PC 端已验证的 key 与
 *  定义);两端都无 key(如系统 TTS)→ 保 PC,不让安卓端的本机化配置串台;APP 独有追加。 */
export function mergeKeyedCollectionById<T extends { id: string; apiKey?: unknown }>(pcList: T[], appList: T[]): T[] {
  const result = [...pcList];
  const idxById = new Map(result.map((item, i) => [item.id, i] as const));
  for (const appItem of appList) {
    const idx = idxById.get(appItem.id);
    if (idx === undefined) {
      idxById.set(appItem.id, result.length);
      result.push(appItem);
    } else if (String(appItem.apiKey ?? "").trim() && !String(result[idx].apiKey ?? "").trim()) {
      result[idx] = appItem; // APP 有 key、PC 没有 → 用 APP
    }
  }
  return result;
}

/** 全面审查 5-6:导入前 state.json 快照(单份滚动覆盖,与会话库 pre-import.bak 对齐)。
 *  恢复是全量替换语义,误选备份时这是设置/供应商 apiKey/文件账本的唯一本地回退点。
 *  快照失败只告警不阻断导入(尽力而为的安全网,不是前置条件)。 */
function snapshotStateJsonBeforeImport(): void {
  try {
    if (!existsSync(statePath)) return;
    copyFileSync(statePath, `${statePath}.pre-import.bak`);
    console.log(`[import] 导入前 state.json 快照已写入 ${statePath}.pre-import.bak`);
  } catch (err) {
    reportError("backup", "warn", "导入前设置快照失败，导入继续但无本地回退点", err, "pre_import_snapshot_failed");
  }
}

/** R4-1(P1):恢复路径必须重建迁移标记。pc-backup.json 不导出 appliedMigrations(标记
 *  描述的是本机安装的迁移史,不随备份跨机),normalizeState 重建 state 后标记全部丢失,
 *  下次启动各一次性迁移会按"未迁移"重跑。凡"恢复流程自身已保证其不变式成立"的迁移
 *  在此登记,并在 normalizeState 之前种进 incoming(而非事后补):
 *  - CONVERSATIONS_SQLITE_MIGRATION:finalizeConversationImport 使活库成为会话权威。缺失
 *    则下次启动 migrateConversationsIfNeeded 走方案 B,把 pre-sqlite.bak 化石会话灌回
 *    活库——数月前删掉的会话复活、同 id 会话被旧树覆盖(1.2.6 前入坑的老用户恢复任意
 *    PC 备份即必现)。
 *  - MEMORY_FILE_SPLIT_MIGRATION:记忆已由 memoryStore 接管(replace 语义)。
 *  - FILE_DEDUP_MIGRATION:附件已由恢复流程全新落盘(导出端已按内容去重)。缺失则下次
 *    启动对 files/ 全量同尺寸组 sha256 重扫,GB 级附件目录拖慢启动数十秒(壳 20s 就绪
 *    超时 R1-1 的放大器)。
 *  - PROVIDER_REORDER_MIGRATION:备份里的 providers 顺序就是用户排好的顺序。必须在
 *    normalizeState 之前种入——它见标记缺失会当场重排,事后补写救不回顺序。
 *    (2.0.0-preview-v4 二次重排 PROVIDER_REORDER_MIGRATION_V2 同理。)
 *  新增一次性迁移时必须评估:恢复后其不变式是否成立;成立则登记于此,不成立则保证
 *  该迁移可在恢复后的数据上安全重跑(幂等)。 */
const RESTORE_GUARANTEED_MIGRATIONS = [
  CONVERSATIONS_SQLITE_MIGRATION,
  MEMORY_FILE_SPLIT_MIGRATION,
  FILE_DEDUP_MIGRATION,
  PROVIDER_REORDER_MIGRATION,
  PROVIDER_REORDER_MIGRATION_V2,
];

function seedRestoreMigrationMarkers(incoming: Partial<State>): void {
  const existing = Array.isArray(incoming.appliedMigrations) ? incoming.appliedMigrations : [];
  incoming.appliedMigrations = uniqueStrings([...existing, ...RESTORE_GUARANTEED_MIGRATIONS]);
}

/** R4-2(P2):恢复是全量替换语义,失败必须回到"什么都没发生"。进入破坏性应用段
 *  (setState / 记忆 replace / 附件 re-link / 活库重灌)之前留存内存快照,失败时回滚
 *  state(structuredClone,含暂存字段与迁移标记)与记忆(exportFlat 快照 replace 回)。
 *  活库无需回滚:恢复流程唯一写点 finalizeConversationImport 的 resetConversationsDbTo
 *  是单事务,中途失败即 SQLite 自动回滚;reset 成功后流程再无可抛点。附件 re-link 已
 *  拷进 files/ 的字节成为孤儿——数据安全优先不回删,同内容再导入会被去重复用。 */
function captureRestoreRollbackPoint(): (err: unknown) => void {
  const stateSnapshot = structuredClone(state);
  const memorySnapshot = memoryStore.exportFlat();
  return (err: unknown) => {
    try {
      setState(stateSnapshot);
      memoryStore.importFlatMemories(memorySnapshot, "replace");
      invalidateContextSnapshots();
      saveState();
      broadcastSettings();
      reportError("backup", "error", "备份恢复失败，已回滚到导入前状态", err, "restore_rolled_back");
    } catch (rollbackErr) {
      // 回滚自身失败的最后防线:清掉暂存,防止半应用的备份内容被后续 saveState 持久化、
      // 下次启动被当作待迁移数据灌进活库(R4-2 的事故链)。
      delete state.conversations;
      delete state.pcWorkspaces;
      delete state.pcEngineTables;
      reportError("backup", "error", "备份恢复失败且回滚异常，请重启应用并核对设置与记忆", rollbackErr, "restore_rollback_failed");
    }
  };
}

/** 全面审查 5-1(P0):恢复时新文件 id 的安全下界——绝不重置 nextFileId。
 *  本机现有附件的落盘命名是 filesDir/<id>.<ext>,若恢复从 1 重新分配 id,同 id 同扩展名
 *  的新写入会直接覆写现有附件字节,不可逆。取内存 state(nextFileId 与 files 账本)与
 *  磁盘文件名三者的最大值+1,沿现有 id 空间单调续分配,新写入天然零覆写;被替换掉的旧
 *  附件字节成为孤儿留在磁盘,可人工找回。filesDirPath 参数化供回归测试注入临时目录。 */
export function nextFileIdSafeFloor(filesDirPath: string = filesDir): number {
  let floor = 1;
  const live = state as State | undefined;
  if (live && typeof live.nextFileId === "number" && live.nextFileId > floor) floor = live.nextFileId;
  for (const entry of Array.isArray(live?.files) ? live.files : []) {
    if (entry && typeof entry.id === "number" && entry.id + 1 > floor) floor = entry.id + 1;
  }
  try {
    for (const name of readdirSync(filesDirPath)) {
      const m = /^(\d+)(?:\.|$)/.exec(name);
      if (!m) continue;
      const candidate = Number(m[1]) + 1;
      if (Number.isFinite(candidate) && candidate > floor) floor = candidate;
    }
  } catch { /* filesDir 不存在 → 以内存账本为准 */ }
  return floor;
}

export function applyBackupPayload(body: { state?: Partial<State>; skills?: unknown; files?: unknown } & Partial<State>): ImportReport {
  const report = newImportReport();
  const incoming = body.state ?? body;
  if (!incoming || typeof incoming !== "object" || !incoming.settings) {
    throw new Error("Invalid backup file");
  }
  // 收官审查 P0-1 同型守卫:先记录备份里是否显式携带 conversations。normalizeState 会把
  // 缺失归一化成 [],而 finalize 把"数组存在"当替换基底——缺失若不删除,等于把
  // settings-only 备份当成"清空全部会话"执行。显式空数组则尊重替换语义。
  const hadConversations = Array.isArray(incoming.conversations);
  snapshotStateJsonBeforeImport();
  const rollbackRestore = captureRestoreRollbackPoint();
  try {
    seedRestoreMigrationMarkers(incoming);
    setState(normalizeState(incoming));
    if (!hadConversations) delete state.conversations;
    // 记忆:整体替换语义(恢复备份 = 回到备份时的状态)。normalizeState 已把 incoming.memories
    // 解析到 state.memories;交给 memoryStore 接管(replace:先清空再导入),然后从 state 移除。
    // pending 一并清空(备份不含 pending,恢复即丢弃待确认队列——前端应在恢复前弹警告)。
    const incomingMemories = Array.isArray(state.memories) ? state.memories : [];
    memoryStore.importFlatMemories(incomingMemories, "replace");
    invalidateContextSnapshots();
    delete state.memories;
    delete state.nextMemoryId;
    importSkills(body.skills);
    if (Array.isArray(body.files)) {
      mkdirSync(filesDir, { recursive: true });
      // 全面审查 5-1:老 JSON 备份按原 id 写 filesDir/<id>.<ext> 会覆写本机现有同名附件字节
      // (备份内的 id 空间与本机磁盘既有文件无关)。落盘名加恢复批次前缀保证全新路径;
      // 元数据 id 不变——/api/files/<id>/content 按 state.files 查 entry.path 提供内容,
      // 与磁盘文件名解耦,引用不受影响,旧字节零破坏。
      const restoreStamp = Date.now();
      for (const file of body.files) {
        if (!isRecord(file) || typeof file.data !== "string") continue;
        const fileId = Number(file.id);
        if (!Number.isFinite(fileId)) continue;
        const ext = extname(String(file.originalName ?? file.name ?? "")) || extname(String(file.path ?? "")) || "";
        const target = join(filesDir, `restored-${restoreStamp}-${fileId}${ext}`);
        writeFileSync(target, Buffer.from(file.data, "base64"));
        state.files = state.files.map((entry) => (entry.id === fileId ? { ...entry, path: target } : entry));
      }
    }
    finalizeConversationImport();
    saveState();
    broadcastSettings();
    broadcastList();
  } catch (err) {
    rollbackRestore(err);
    throw err;
  }
  return report;
}

/**
 * Try to import an Android-format backup ZIP. The Android client (v2.x) produces a ZIP
 * containing `settings.json` + Room database files + `upload/` + `skills/`. PC and Android
 * use different storage layouts (PC: JSON state.json; Android: SQLite via Room), so we can't
 * literally restore the .db files. Instead we cherry-pick the cross-platform-portable bits:
 *
 *   ✓ settings.json → merged into PC settings (providers, search services, assistants,
 *     mode injections, lorebooks, quick messages, display preferences, etc.)
 *   ✓ upload/<file> → copied verbatim into pc-data/files/ and registered in state.files[]
 *     so they're available as attachments by their old filenames
 *   ✓ skills/<...> → copied into pc-data/skills/ so Agent Skills survive the migration
 *   ✗ rikka_hub.db / -wal / -shm → SKIPPED. Reading Room SQLite would require duplicating
 *     Android's schema mapping; conversation history therefore doesn't migrate. The summary
 *     returned to the UI lists what was and wasn't recovered so the user understands.
 *
 * Uses PowerShell's Expand-Archive (ships on every supported Windows) to extract — no
 * extra dependency in the compiled exe.
 */
// PC lossless restore: read `pc-backup.json` (metadata-only state), apply it via
// `applyBackupPayload`, then re-link the actual file bytes from the zip's `upload/<fileName>`
// entries by copying them into pc-data/files/<newId>.<ext> and rewriting state.files[].path.
//
// This preserves conversations + message tree + tool parts + generatedImages + logs that a
// pure-Android-format zip can't carry (Android stores those in SQLite, which PC doesn't have).
// Out-of-memory safety: file bytes are copied with readFileSync→writeFileSync per file, never
// aggregated into a single buffer.
function applyPcBackupFromExtractDir(extractDir: string, pcBackupPath: string): { settingsImported: boolean; filesImported: number; skillsImported: number; conversationsImported: number; dbReadError: string | null; report: ImportReport } {
  let settingsImported = false;
  let filesImported = 0;
  let skillsImported = 0;
  let conversationsImported = 0;
  let dbReadError: string | null = null;
  let rollbackRestore: ((err: unknown) => void) | null = null;
  const report = newImportReport();
  try {
    const body = JSON.parse(readFileSync(pcBackupPath, "utf-8")) as { state?: Partial<State>; skills?: unknown; files?: unknown } & Partial<State>;
    const incoming = body.state ?? body;
    if (!incoming || typeof incoming !== "object" || !incoming.settings) {
      throw new Error("Invalid pc-backup.json: missing state.settings");
    }
    // Wipe state.files first so we can re-add entries from upload/ with fresh IDs and paths
    // that are valid on THIS machine (the path stored in pc-backup.json points at the source
    // machine's filesystem and would be wrong here).
    // 全面审查 5-1(P0):nextFileId 沿本机现有 id 空间续分配,绝不重置为 1——否则 re-link
    // 从 1 起分配 id,写 filesDir/<id>.<ext> 时同 id 同扩展名的本机现有附件字节被直接覆写
    // (settings-only 降级路径下保留的现有会话,其附件引用随即指向被覆写/悬空的内容)。
    snapshotStateJsonBeforeImport();
    rollbackRestore = captureRestoreRollbackPoint();
    const incomingState = { ...(incoming as State), files: [], nextFileId: nextFileIdSafeFloor() } as State;
    seedRestoreMigrationMarkers(incomingState);
    setState(normalizeState(incomingState));
    // 记忆:整体替换语义(PC 备份恢复)。normalizeState 把 incomingState.memories 解析到
    // state.memories;交给 memoryStore 接管(replace),然后从 state 移除。
    const incomingMemories = Array.isArray(state.memories) ? state.memories : [];
    memoryStore.importFlatMemories(incomingMemories, "replace");
    invalidateContextSnapshots();
    delete state.memories;
    delete state.nextMemoryId;
    settingsImported = true;
    if (Array.isArray(incoming.conversations)) {
      conversationsImported = incoming.conversations.length;
    }
    // 新格式 pc-backup.json 不含 conversations,会话由 zip 内会话库承载。
    // 收官审查 P0-1:找不到任何会话库、或读取失败时,必须降级为 settings-only 语义
    // (delete state.conversations → finalize 不触碰活库)——否则纯 PC 用户(无安卓模板,
    // 导出 zip 天然无 rikka_hub.db)恢复自己的备份会被 resetConversationsDbTo([]) 清空全部会话。
    // 显式内联 conversations(老格式,含空数组)仍走替换语义,不进本分支。
    if (!Array.isArray(incoming.conversations)) {
      const pcDumpFile = join(extractDir, "pc_conversations.db");
      const dbFile = join(extractDir, "rikka_hub.db");
      // 备份 2.0:优先读 PC 原生 dump(字段零丢失、与安卓模板解耦);老备份无 dump 时
      // 回退安卓格式 rikka_hub.db。dump 读取失败不静默回退安卓库——两库内容同源,
      // dump 坏则 zip 大概率已损坏,宁可 settings-only 降级并明确报错。
      if (existsSync(pcDumpFile)) {
        try {
          conversationsImported = importPcConversationsDump(pcDumpFile);
        } catch (dumpErr) {
          dbReadError = dumpErr instanceof Error ? dumpErr.message : String(dumpErr);
          report.dbReadError = dbReadError;
          delete state.conversations;
          reportError("backup", "error", "备份内桌面端会话库读取失败，仅恢复了设置", dumpErr, "pc_db_unreadable");
        }
      } else if (existsSync(dbFile)) {
        try {
          conversationsImported = importAndroidConversations(extractDir, dbFile, new Map(), report);
        } catch (dbErr) {
          dbReadError = dbErr instanceof Error ? dbErr.message : String(dbErr);
          report.dbReadError = dbReadError;
          delete state.conversations;
          reportError("backup", "error", "备份内 APP端会话库读取失败，仅恢复了设置", dbErr, "android_db_unreadable");
        }
      } else {
        delete state.conversations;
        reportError("backup", "warn", "备份不含会话数据库，仅恢复了设置", undefined, "no_conversation_db");
      }
    }
    // P7:引擎会话状态(压缩记录)在会话行内随库替换一体恢复,jsonl 层已退役——
    // 旧备份携带的 pi-sessions/ 目录静默忽略(无消费方),启动卫生会清掉本机残留目录。
    importSkills((body as { skills?: unknown }).skills);
    importFontsDirIfPresent(extractDir);
    importGlobalAgentsIfPresent(extractDir);
    // 批5:re-link 改为元数据驱动。旧实现按目录字母序重编号且不改写引用(id>9 时
    // '10.png'<'2.png',字母序≠id 序),恢复后消息附件/头像/画廊全面错位。现在:每条元数据
    // 用 backupName(导出端 zip 内实际文件名;老备份无此字段时退回 fileName)定位字节,
    // 注册新 id 并记录 旧id→新id;导出端内容去重使多条元数据共享同一 backupName,在此
    // 天然归并为一条。未被元数据认领的 upload/ 文件按未知文件兜底注册,坚持不丢字节。
    const uploadDir = join(extractDir, "upload");
    const incomingFiles = Array.isArray((incoming as State).files) ? (incoming as State).files : [];
    const oldIdToNewId = new Map<number, number>();
    if (existsSync(uploadDir)) {
      mkdirSync(filesDir, { recursive: true });
      const registerStaged = (entry: string, meta: StoredFile | undefined): number => {
        const srcPath = join(uploadDir, entry);
        const newId = state.nextFileId++;
        const ext = extname(entry) || "";
        const targetPath = join(filesDir, `${newId}${ext}`);
        copyFileSync(srcPath, targetPath); // 5-7:内核级拷贝,>2GiB 不进 JS 堆
        state.files.push({
          id: newId,
          path: targetPath,
          fileName: meta?.fileName ?? entry,
          mime: meta?.mime ?? guessMimeFromExt(ext),
          size: meta?.size ?? statSync(srcPath).size,
        });
        // 1-7:老备份元数据携带的抽取全文落旁车缓存,不进账本;新备份不含此字段,
        // 恢复后按需后台重抽。
        if (typeof meta?.extractedText === "string" && meta.extractedText) {
          writeExtractedTextSidecar(newId, meta.extractedText);
        }
        filesImported += 1;
        return newId;
      };
      const newIdByStagedName = new Map<string, number>();
      for (const meta of incomingFiles) {
        if (!meta || typeof meta !== "object") continue;
        const rawName = typeof meta.backupName === "string" && meta.backupName ? meta.backupName : meta.fileName;
        if (typeof rawName !== "string" || !rawName) continue;
        // 备份文件是外部输入:zip 内文件名不允许路径分隔符/上跳,防路径穿越。
        if (rawName.includes("..") || rawName.includes("/") || rawName.includes("\\")) continue;
        const srcPath = join(uploadDir, rawName);
        if (!existsSync(srcPath) || !statSync(srcPath).isFile()) continue;
        let newId = newIdByStagedName.get(rawName);
        if (newId === undefined) {
          newId = registerStaged(rawName, meta);
          newIdByStagedName.set(rawName, newId);
        }
        if (typeof meta.id === "number") oldIdToNewId.set(meta.id, newId);
      }
      for (const entry of readdirSync(uploadDir)) {
        if (newIdByStagedName.has(entry)) continue;
        if (!statSync(join(uploadDir, entry)).isFile()) continue;
        registerStaged(entry, undefined);
      }
    }
    // 引用改写:把恢复进来的会话/设置/画廊里的 /api/files/<旧id>/content 指向新 id。
    // 旧实现完全不改写,是"恢复后图片错位/丢失"的根因之一(备份 2.0 调查)。
    if (oldIdToNewId.size > 0) {
      if (Array.isArray(state.conversations)) {
        state.conversations = rewritePcFileUrlsDeep(
          state.conversations as unknown as JsonValue,
          oldIdToNewId,
        ) as unknown as typeof state.conversations;
      }
      state.settings = rewritePcFileUrlsDeep(
        state.settings as unknown as JsonValue,
        oldIdToNewId,
      ) as unknown as typeof state.settings;
      if (Array.isArray(state.generatedImages)) {
        const rewritten = rewritePcFileUrlsDeep(
          state.generatedImages as unknown as JsonValue,
          oldIdToNewId,
        ) as unknown as typeof state.generatedImages;
        state.generatedImages = rewritten.map((img) =>
          typeof img.fileId === "number" && oldIdToNewId.has(img.fileId)
            ? { ...img, fileId: oldIdToNewId.get(img.fileId)! }
            : img,
        );
      }
    }
    // Skills are restored via importSkills() above; count them from the skills array if present.
    if (Array.isArray((body as { skills?: unknown }).skills)) {
      skillsImported = ((body as { skills?: unknown[] }).skills as unknown[]).length;
    }
    finalizeConversationImport();
    saveState();
    broadcastSettings();
    broadcastList();
  } catch (err) {
    console.warn("[import] pc-backup.json apply failed", err);
    rollbackRestore?.(err);
    throw err;
  }
  return { settingsImported, filesImported, skillsImported, conversationsImported, dbReadError, report };
}

export function applyAndroidZipBackupFromPath(zipPath: string): { settingsImported: boolean; filesImported: number; skillsImported: number; conversationsImported: number; dbReadError: string | null; report: ImportReport } {
  // Caller is expected to have already written the zip to disk (streamed from request.body
  // for the large-file path). We accept a path rather than a Buffer because users have
  // reported backups in the 1-10 GB range — buffering those in JS heap is not feasible.
  const tmpRoot = dirname(zipPath);
  const extractDir = join(tmpRoot, "extracted");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}', '${extractDir.replace(/'/g, "''")}')`,
    ].join("; ");
    const proc = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script]);
    if (proc.exitCode !== 0) {
      throw new Error(`Failed to extract backup zip: ${new TextDecoder().decode(proc.stderr ?? new Uint8Array()).slice(0, 300)}`);
    }
  } else {
    const proc = Bun.spawnSync(["unzip", "-o", zipPath, "-d", extractDir]);
    if (proc.exitCode !== 0) {
      throw new Error(`Failed to extract backup zip: ${new TextDecoder().decode(proc.stderr ?? new Uint8Array()).slice(0, 300)}`);
    }
  }

  // PC-origin zip fast path: if pc-backup.json exists, this came from a PC export — restore
  // settings + generatedImages + memories + files metadata (from pc-backup.json) and
  // conversations (from rikka_hub.db), then re-link file bytes from upload/. logs/stats are
  // machine-local (in-memory / per-install accumulator) and are NOT carried in the backup.
  // The Android settings.json path below still exists for Android-origin zips, which don't
  // ship pc-backup.json.
  const pcBackupPath = join(extractDir, "pc-backup.json");
  if (existsSync(pcBackupPath)) {
    return applyPcBackupFromExtractDir(extractDir, pcBackupPath);
  }
  // R4-2:安卓 zip 合并路径同样覆盖回滚——settings 七层合并/附件注册/会话暂存任一步
  // 失败都不能留下半合并状态。段体原样抽出为独立函数,行为不变。
  const rollbackRestore = captureRestoreRollbackPoint();
  try {
    return applyAndroidOriginZipFromExtractDir(extractDir);
  } catch (err) {
    rollbackRestore(err);
    throw err;
  }
}

function applyAndroidOriginZipFromExtractDir(extractDir: string): { settingsImported: boolean; filesImported: number; skillsImported: number; conversationsImported: number; dbReadError: string | null; report: ImportReport } {
  let settingsImported = false;
  let filesImported = 0;
  let skillsImported = 0;
  let conversationsImported = 0;
  let dbReadError: string | null = null;
  const report = newImportReport();

  // 全面审查 5-6:安卓 zip 路径(settings 合并 + 文件注册 + 可选会话导入)同样先快照。
  snapshotStateJsonBeforeImport();

  const settingsPath = join(extractDir, "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      // APP→PC 导入的 settings 合并(七层策略,灵活处理):
      //   1) ...app 基底:APP 全字段进来,含 PC 不认识的 APP 独有字段(customThemes / fastModelId /
      //      enableSuggestion / webServer* / backupReminderConfig 等),不漏。PC 运行时不读的多余字段
      //      原样保留,saveState 写回、PC→APP 回导还能用。
      //   2) 标量配置(默认模型选择 / 各类 prompt / 主题 / 布尔开关):PC 缺失或仍=出厂默认 = 用户没在
      //      PC 定制 → 采用 APP(APP 是主力端);PC 已定制 → 保 PC。pick() 同时判 null 和 ===。
      //   3) 含 apiKey 的集合(providers/asr/tts):mergeKeyedCollectionById——同 id 时 PC 已配 key 保 PC,
      //      PC 无 key 而 APP 有 → 采用 APP 条目(默认供应商两端共享固定 UUID,全新安装若无条件保 PC
      //      会把手机配好的 key/模型挡在门外,Linux 用户实测“覆盖不完全”),APP 独有条目追加。
      //      searchServices 单独处理——两端 id 都是随机生成(defaultSettings 用 id()、
      //      Android 用 Uuid.random()),mergeById 按 id 去重会翻倍,改按 type 去重(见 mergeSearchByType)。
      //   4) 用户内容集合(assistants/mcpServers/lorebooks/quickMessages/modeInjections/assistantTags):
      //      mergeById(APP, PC) APP 优先(改名/配置进来),PC 独有追加。id 是 UUID 且两端默认空,撞 id
      //      极罕见——MCP 凭证在 commonOptions.headers,撞 id 时可能丢 PC token,可接受。
      //   5) favoriteModels:元素是 model UUID(string)非 {id} 对象,用 Set 去重取并集。
      //   6) displaySetting / searchCommonOptions:对象 shallow merge,APP 字段进来、PC 独有保留;
      //      displaySetting.userNickname 非空、userAvatar 非 Dummy 才覆盖;chatFontFamily 永远保 PC
      //      (APP 是 enum 字符串、PC 是字体名,手机端字体 PC 未必安装)。
      //   7) webDav/s3:两端结构对齐后,PC 已配置保 PC、PC 空采用 APP(APP 也有此功能)。
      //      proxy/jwt/port/promptOptimize* 是 PC 独有(Android 无),永远保 PC。
      // 历史:{...PC,...APP} 浅合并丢 key;Plan B 全 PC 优先把 APP 同 id 助手/MCP/世界书挡在外面;
      //      三轮分流只覆盖 10 个集合,标量全走 PC 基底→默认模型/提示词/主题/收藏/标签全丢;七层方案补齐
      //      后又发现 searchServices 两端随机 id 致 mergeById 翻倍、webDav 误判 PC 独有被丢——本轮修正。
      const pc = state.settings;
      const app = raw as Record<string, JsonValue>;
      const defaults = defaultSettings();
      // 标量:APP 有该字段、且 PC 缺失(null)或仍=出厂默认 → 采用 APP;否则保 PC。APP 没该字段时保 PC。
      const pick = (key: string): unknown => {
        const pcVal = (pc as unknown as Record<string, unknown>)[key];
        if (!(key in app)) return pcVal;
        const defVal = (defaults as unknown as Record<string, unknown>)[key];
        return pcVal == null || pcVal === defVal ? app[key] : pcVal;
      };
      // searchServices 两端 id 都是随机生成(defaultSettings 用 id()、Android 用 Uuid.random()),mergeById
      // 按 id 去重会把 APP 的全部追加 → 搜索服务翻倍。改按 type 去重:同 type 时 APP 配了 apiKey 而 PC
      // 对应项没有 → 用 APP(把 key 带过来);否则保 PC;APP 独有 type 追加。无 type 的脏数据当独有项追加。
      const mergeSearchByType = (
        pcList: { type?: string; apiKey?: JsonValue; id: string }[],
        appList: { type?: string; apiKey?: JsonValue; id: string }[],
      ) => {
        const result = [...pcList];
        const typeToIdx = new Map<string, number>();
        result.forEach((s, i) => {
          const t = String(s.type ?? "");
          if (t && !typeToIdx.has(t)) typeToIdx.set(t, i);
        });
        for (const appSvc of appList) {
          const t = String(appSvc.type ?? "");
          if (!t) { result.push(appSvc); continue; }
          const idx = typeToIdx.get(t);
          if (idx === undefined) {
            typeToIdx.set(t, result.length);
            result.push(appSvc);
          } else if (String(appSvc.apiKey ?? "").trim() && !String(result[idx].apiKey ?? "").trim()) {
            result[idx] = appSvc; // APP 有 key、PC 没有 → 用 APP
          }
        }
        return result;
      };
      const mergedSearchServices = mergeSearchByType(
        (Array.isArray(pc.searchServices) ? pc.searchServices : []) as { type?: string; apiKey?: JsonValue; id: string }[],
        (Array.isArray(app.searchServices) ? app.searchServices : []) as { type?: string; apiKey?: JsonValue; id: string }[],
      );
      // searchServiceSelected 存的是数组下标,合并后顺序变了。PC 段在合并列表前部、顺序不变,故 PC 非默认
      // 时其索引仍有效直接保;PC=默认(0)= 用户没在 PC 选过 → 采用 APP 选中意图:取 APP 选中服务的 type
      // 在合并列表重新定位,找不到回退 0(脏数据 / APP 列表为空时兜底)。
      const resolveSearchSelected = (): number => {
        if (pc.searchServiceSelected !== defaults.searchServiceSelected) return pc.searchServiceSelected;
        const appIdx = Number(app.searchServiceSelected);
        const appList = (Array.isArray(app.searchServices) ? app.searchServices : []) as { type?: string }[];
        const targetType = String(appList[appIdx]?.type ?? "");
        if (!targetType) return 0;
        const found = mergedSearchServices.findIndex((s) => String(s.type ?? "") === targetType);
        return found >= 0 ? found : 0;
      };
      // displaySetting 两端字段不同(PC 有 uiFontFamilyCss/chatInputHeight,APP 有 showDateTimeInMessage/
      // 触觉/通知等)。shallow merge;身份字段 + chatFontFamily 做兜底。APP 的 userAvatar type 可能是
      // Android FQN(...Avatar.Dummy),rewriteAvatarsInSettings 后续转 PC 短格式,这里同时兜住 FQN 与短格式。
      // chatFontFamily:APP 是 enum 字符串(DEFAULT/MONOSPACE/CUSTOM)、PC 是字体名,且手机端字体 PC 未必
      // 安装,类型与可用性都不一致 → 永远保 PC,不接管 APP 值。
      const pcDisplay = (pc.displaySetting ?? {}) as Record<string, JsonValue>;
      const appDisplay = (app.displaySetting as Record<string, JsonValue> | undefined) ?? {};
      const mergedDisplay: Record<string, JsonValue> = { ...pcDisplay };
      for (const [k, v] of Object.entries(appDisplay)) {
        if (k === "userNickname") {
          if (typeof v === "string" && v.trim()) mergedDisplay.userNickname = v;
        } else if (k === "userAvatar") {
          const avatarType = String((v as Record<string, JsonValue> | null)?.type ?? "");
          if (v && !/\.Dummy$/i.test(avatarType) && avatarType.toLowerCase() !== "dummy") {
            mergedDisplay.userAvatar = v;
          }
        } else if (k === "chatFontFamily") {
          // 字体两端语义/可用性不同 → 保 PC
        } else {
          mergedDisplay[k] = v;
        }
      }
      // WebDavConfig 两端结构完全一致(url/username/password/path/items)。PC 已配置(url 非空)= PC 上
      // 验证过能用且含密钥 → 保 PC;PC 空(url 空)= 用户没在 PC 配过 → 采用 APP 的(主力端配置)。
      const mergedWebDav = String((pc.webDavConfig as unknown as Record<string, JsonValue> | null)?.url ?? "").trim()
        ? pc.webDavConfig
        : (app.webDavConfig ?? pc.webDavConfig);
      // S3Config 对齐 APP 后两端结构一致。PC 已配置(endpoint 非空)→ 保 PC;PC 空 → 采用 APP。
      const mergedS3 = String((pc.s3Config as unknown as Record<string, JsonValue> | null)?.endpoint ?? "").trim()
        ? pc.s3Config
        : (app.s3Config ?? pc.s3Config);
      const merged = {
        ...app,
        dynamicColor: pick("dynamicColor"),
        themeId: pick("themeId"),
        developerMode: pick("developerMode"),
        enableWebSearch: pick("enableWebSearch"),
        chatModelId: pick("chatModelId"),
        // 快速模型:APP 2.4.16+ 的 settings 带 fastModelId 直接采;老 APP/老 PC 备份只有
        // titleModelId/suggestionModelId 时回退迁移(标题优先,其次建议,皆无则由 state-load 兜底 AUTO)。
        fastModelId: pick("fastModelId") ?? pick("titleModelId") ?? pick("suggestionModelId"),
        // 快速模型子功能开关:enableSuggestion 是 APP 原生字段(双向互通——手机关过建议,
        // PC 未定制时采纳 APP);titleGenerationEnabled 是 PC 先行字段,APP 备份没有 → 恒保 PC。
        enableSuggestion: pick("enableSuggestion"),
        titleGenerationEnabled: pick("titleGenerationEnabled"),
        translateModeId: pick("translateModeId"),
        imageGenerationModelId: pick("imageGenerationModelId"),
        ocrModelId: pick("ocrModelId"),
        compressModelId: pick("compressModelId"),
        translateThinkingBudget: pick("translateThinkingBudget"),
        titlePrompt: pick("titlePrompt"),
        translatePrompt: pick("translatePrompt"),
        suggestionPrompt: pick("suggestionPrompt"),
        ocrPrompt: pick("ocrPrompt"),
        compressPrompt: pick("compressPrompt"),
        selectedASRProviderId: pick("selectedASRProviderId"),
        selectedTTSProviderId: pick("selectedTTSProviderId"),
        assistantId: pick("assistantId"),
        providers: mergeKeyedCollectionById(pc.providers ?? [], (Array.isArray(app.providers) ? app.providers : []) as { id: string }[]),
        searchServices: mergedSearchServices,
        searchServiceSelected: resolveSearchSelected(),
        asrProviders: mergeKeyedCollectionById(pc.asrProviders ?? [], (Array.isArray(app.asrProviders) ? app.asrProviders : []) as { id: string }[]),
        ttsProviders: mergeKeyedCollectionById(pc.ttsProviders ?? [], (Array.isArray(app.ttsProviders) ? app.ttsProviders : []) as { id: string }[]),
        assistants: mergeById((Array.isArray(app.assistants) ? app.assistants : []) as any[], pc.assistants ?? []),
        mcpServers: mergeById((Array.isArray(app.mcpServers) ? app.mcpServers : []) as any[], pc.mcpServers ?? []),
        lorebooks: mergeById((Array.isArray(app.lorebooks) ? app.lorebooks : []) as any[], pc.lorebooks ?? []),
        quickMessages: mergeById((Array.isArray(app.quickMessages) ? app.quickMessages : []) as any[], pc.quickMessages ?? []),
        modeInjections: mergeById((Array.isArray(app.modeInjections) ? app.modeInjections : []) as any[], pc.modeInjections ?? []),
        assistantTags: mergeById((Array.isArray(app.assistantTags) ? app.assistantTags : []) as any[], pc.assistantTags ?? []),
        favoriteModels: Array.from(new Set([
          ...(Array.isArray(pc.favoriteModels) ? pc.favoriteModels : []),
          ...(Array.isArray(app.favoriteModels) ? (app.favoriteModels as string[]) : []),
        ])),
        displaySetting: mergedDisplay,
        searchCommonOptions: {
          ...(pc.searchCommonOptions ?? {}),
          ...((app.searchCommonOptions as Record<string, JsonValue> | undefined) ?? {}),
        },
        webDavConfig: mergedWebDav,
        s3Config: mergedS3,
        proxyConfig: pc.proxyConfig,
        webServerJwtEnabled: pc.webServerJwtEnabled,
        preferredPort: pc.preferredPort,
        // workspaceLastPermissionPreset 是 PC-only 字段(工作区新建档位记忆),导入时保 PC 值。
        workspaceLastPermissionPreset: pc.workspaceLastPermissionPreset,
        promptOptimizeModelId: pc.promptOptimizeModelId,
        promptOptimizePrompt: pc.promptOptimizePrompt,
        // keybindings 是 PC-only 字段(APP 无对应),导入时必须保 PC 自定义,否则被 normalizeState 重置为默认。
        keybindings: pc.keybindings,
        // memorySettings 同为 PC-only(APP Settings 无此字段),保 PC 设置,否则 normalizeState
        // 的 M1 推断会覆盖用户的 globalEnabled 选择。
        memorySettings: pc.memorySettings,
      } as unknown as State["settings"];
      const adjusted = rewriteAvatarsInSettings(merged, ANDROID_AVATAR_TYPE_TO_PC, "to-pc");
      setState(normalizeState({ ...state, settings: adjusted as State["settings"] }));
      // Android 导入是合并语义,settings 步骤不触碰会话:normalizeState 会把 undefined
      // 归一化成 [],若留着它,后续 importAndroidConversations 会误把空数组当合并基底、
      // settings-only zip 的 finalize 会用 [] 清空用户全部会话(P0)。删掉恢复"无暂存"态。
      delete state.conversations;
      settingsImported = true;
    } catch (err) {
      console.warn("[import] failed to parse Android settings.json", err);
    }
  }

  // Copy upload/ files into pc-data/files/ with fresh ids and register them in state.files.
  // We do this BEFORE importing conversations so that the filename→PC-file-id map is
  // available when rewriting `file://…/upload/<uuid>.png` URLs embedded in message parts —
  // without that rewrite, the imported messages would all show "Failed to load image"
  // because the on-disk file was renamed from `<uuid>.png` to `<numeric-id>.png`.
  const androidFilenameToPcId = new Map<string, number>();
  const uploadDir = join(extractDir, "upload");
  if (existsSync(uploadDir)) {
    mkdirSync(filesDir, { recursive: true });
    // 批5 去重:此前每次安卓 zip 导入把 upload/ 全量追加注册(旧条目仍被消息引用,删不得),
    // 每 PC↔APP 往返一轮附件翻倍(用户实测 4 份 = 两轮)。现按内容 sha256 对照现有文件,
    // 命中即复用旧 id,只登记 filename→id 映射供 URL 改写。只对尺寸相同的候选计算 hash,
    // 避免每次导入都全量读一遍 files 目录。
    const existingBySize = new Map<number, { id: number; path: string }[]>();
    for (const f of state.files) {
      let p = f.path && existsSync(f.path) ? f.path : "";
      if (!p) {
        const ext = extname(f.fileName || "") || extname(f.path || "") || "";
        const fallback = join(filesDir, `${f.id}${ext}`);
        p = existsSync(fallback) ? fallback : "";
      }
      if (!p) continue;
      const size = statSync(p).size;
      const list = existingBySize.get(size) ?? [];
      list.push({ id: f.id, path: p });
      existingBySize.set(size, list);
    }
    const hashCache = new Map<string, string | null>();
    // 5-7:此前整读字节进内存再哈希/写盘,>2GiB 附件撞 Buffer 上限;改按路径流式哈希+内核级拷贝。
    const findExistingByContent = (size: number, srcPath: string): number | undefined => {
      const candidates = existingBySize.get(size);
      if (!candidates || candidates.length === 0) return undefined;
      const incomingHash = hashFileSha256(srcPath);
      if (incomingHash === null) return undefined;
      for (const c of candidates) {
        let h = hashCache.get(c.path);
        if (h === undefined) {
          h = hashFileSha256(c.path);
          hashCache.set(c.path, h);
        }
        if (h !== null && h === incomingHash) return c.id;
      }
      return undefined;
    };
    let dedupedFiles = 0;
    for (const entry of readdirSync(uploadDir)) {
      const srcPath = join(uploadDir, entry);
      const stats = statSync(srcPath);
      if (!stats.isFile()) continue;
      const existingId = findExistingByContent(stats.size, srcPath);
      if (existingId !== undefined) {
        androidFilenameToPcId.set(entry, existingId);
        dedupedFiles += 1;
        report.filesDeduped += 1;
        continue;
      }
      const fileId = state.nextFileId++;
      const ext = extname(entry) || "";
      const targetName = `${fileId}${ext}`;
      const targetPath = join(filesDir, targetName);
      copyFileSync(srcPath, targetPath);
      state.files.push({
        id: fileId,
        path: targetPath,
        fileName: entry,
        mime: guessMimeFromExt(ext),
        size: stats.size,
      });
      const list = existingBySize.get(stats.size) ?? [];
      list.push({ id: fileId, path: targetPath });
      existingBySize.set(stats.size, list);
      androidFilenameToPcId.set(entry, fileId);
      filesImported += 1;
    }
    if (dedupedFiles > 0) {
      console.log(`[import] upload 去重:${dedupedFiles} 个文件与现有内容一致,复用原条目`);
    }
  }
  // 专题3 H-1(导入侧):settings 里的安卓 file:///…/upload/<name> 引用(助手/用户头像等)
  // 改写成 PC 形态。此前只改写消息 parts,settings 漏改 → 头像指向安卓私有路径,PC 前端
  // 永远无法解析(APP→PC"头像丢失"根因)。必须在 upload 注册完成、文件名映射就绪后执行;
  // fileSchemeOnly 只动 file:// 形态,提示词普通文本不受影响。
  if (settingsImported && androidFilenameToPcId.size > 0) {
    state.settings = rewriteAndroidFileUrlsDeep(
      state.settings as unknown as JsonValue,
      androidFilenameToPcId,
      { fileSchemeOnly: true },
    ) as unknown as State["settings"];
  }

  importFontsDirIfPresent(extractDir);

  // Conversation history: Android stores them in a Room SQLite db (`rikka_hub.db`) with two
  // tables — ConversationEntity for metadata + message_node for the per-node messages array.
  // We open the file via Bun's native SQLite and rebuild PC's Conversation[] shape, which
  // happens to be a near-1:1 mapping because both sides serialize messages with the same
  // kotlinx.serialization-compatible JSON format. The filename map built from upload/ is
  // passed in so we can rewrite `file://…/upload/<uuid>.png` refs to `/api/files/<id>/content`.
  const dbPath = join(extractDir, "rikka_hub.db");
  if (existsSync(dbPath)) {
    try {
      conversationsImported = importAndroidConversations(extractDir, dbPath, androidFilenameToPcId, report);
      // Keep a copy of the original Android db for re-export. Open it first to
      // checkpoint any WAL data (Android exports with WAL that may contain schema
      // updates like identity_hash changes), then serialize the consolidated db.
      const cachedDbPath = join(dataDir, "rikka_hub_cached.db");
      try {
        const cacheDb = new Database(dbPath, { readonly: true });
        const bytes = cacheDb.serialize();
        cacheDb.close();
        writeFileSync(cachedDbPath, bytes);
      } catch { /* best-effort */ }
    } catch (err) {
      dbReadError = err instanceof Error ? err.message : String(err);
      report.dbReadError = dbReadError;
      console.warn("[import] failed to read Android SQLite database:", dbReadError);
    }
  }

  // skills/ — copy the directory tree verbatim into pc-data/skills/.
  const skillsSrc = join(extractDir, "skills");
  if (existsSync(skillsSrc) && skillsDir) {
    mkdirSync(skillsDir, { recursive: true });
    skillsImported = copyDirRecursive(skillsSrc, skillsDir);
  }

  finalizeConversationImport();
  saveState();
  broadcastSettings();
  broadcastList();

  // Clean up the extracted/ subdir; the caller owns and cleans tmpRoot (which still holds
  // the original streamed zip until they decide to remove the whole thing).
  rmSync(extractDir, { recursive: true, force: true });
  return { settingsImported, filesImported, skillsImported, conversationsImported, dbReadError, report };
}

/**
 * Reads `rikka_hub.db` (Android Room) and reconstructs PC `Conversation[]` entries by
 * joining ConversationEntity with message_node (ordered by node_index). Returns the count
 * of imported conversations.
 *
 * Conversations are merged into `state.conversations` by id — Android UUIDs effectively
 * never collide with PC-generated ones, so this is functionally an append. If the user
 * imports the same backup twice the second import overwrites prior copies (idempotent).
 *
 * The Android-side `messages` column is JSON `List<UIMessage>` serialized by kotlinx, which
 * matches PC's `Message` shape directly (role enum, parts/annotations/usage as JsonValue
 * passthroughs, ISO-string timestamps). We do shape-coercion as a defensive pass — bad rows
 * are skipped, not thrown, so a single corrupt node doesn't lose the rest of the history.
 */
/** 备份 2.0:读 PC 原生会话 dump 进暂存(state.conversations),替换语义。
 *  dump 两表结构与活库一致,loadAllConversationsFromDb 直读;FTS 由 finalize 的
 *  resetConversationsDbTo 统一重建。返回会话数(0 = 备份时确实无会话,仍是替换基底)。 */
function importPcConversationsDump(dumpPath: string): number {
  const db = new Database(dumpPath, { readonly: true });
  try {
    const conversations = loadAllConversationsFromDb(db);
    state.conversations = conversations;
    // B6-①a(format 2):pc_workspace 随行带回——PC→PC 恢复后工作区实体(权限档/信任态/类型)
    // 一并回来,不再悬空。按表存在性探测(不读 pc_dump_meta.format),老 dump(format 1,无该表)
    // 跳过、现有工作区原样保留。暂存 state.pcWorkspaces 由 finalize 随会话同事务重灌。
    const hasWorkspaceTable = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pc_workspace'",
    ).get();
    if (hasWorkspaceTable) {
      state.pcWorkspaces = db.query("SELECT * FROM pc_workspace").all() as PcWorkspaceRow[];
    }
    // format 3:引擎私有条目替换语义;老 dump 无两表时不暂存,finalize 保留活库里仍有效的行。
    const engineTables = readEngineTables(db);
    if (engineTables) state.pcEngineTables = engineTables;
    return conversations.length;
  } finally {
    try { db.close(); } catch { /* best-effort:句柄随 GC 释放 */ }
  }
}

/** 安卓对齐批6:安卓 2.4.2 起备份 zip 含 fonts/(自定义聊天字体)。PC 不消费,只作忠实
 *  透传:导入落到 dataDir/fonts,导出原样打包,保证 APP→PC→APP 往返不丢。失败仅告警。 */
function importFontsDirIfPresent(extractDir: string): void {
  const src = join(extractDir, "fonts");
  if (!existsSync(src)) return;
  try {
    const dest = join(dataDir, "fonts");
    mkdirSync(dest, { recursive: true });
    const copied = copyDirRecursive(src, dest);
    console.log(`[import] fonts/ 透传 ${copied} 个文件`);
  } catch (err) {
    console.warn("[import] fonts/ 透传失败(不影响其他数据)", err);
  }
}

/** 全局工作区指引(pc-data/ 直系上下文件,引擎中立)恢复:PC→PC 备份顶层只有
 *  导出端搬进去的四个候选名文件。候选序与导出端一致,首命中即恢复——多文件并存时
 *  恢复运行时会实际加载的那个(AGENTS.md 优先),与读取语义对齐,不复制被遮蔽的
 *  次选。安卓 zip 无这些文件,自然跳过。 */
function importGlobalAgentsIfPresent(extractDir: string): void {
  const candidates = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
  for (const name of candidates) {
    const src = join(extractDir, name);
    try {
      if (!statSync(src).isFile()) continue;
      copyFileSync(src, join(dataDir, name));
      console.log(`[import] 全局工作区指引已恢复: ${name}`);
      return;
    } catch { /* 不存在/复制失败 → 试下一个候选 */ }
  }
}

function importAndroidConversations(extractDir: string, dbPath: string, androidFilenameToPcId: Map<string, number>, report: ImportReport): number {
  // SQLite resolves WAL siblings as `${dbfile}-wal` / `${dbfile}-shm`, but Android exports
  // them with the original (extension-less) database name `rikka_hub-wal` / `rikka_hub-shm`.
  // Without renaming, any uncommitted writes still sitting in the WAL are silently ignored.
  for (const [src, dest] of [
    ["rikka_hub-wal", "rikka_hub.db-wal"],
    ["rikka_hub-shm", "rikka_hub.db-shm"],
  ]) {
    const s = join(extractDir, src);
    const d = join(extractDir, dest);
    if (existsSync(s) && !existsSync(d)) {
      try { renameSync(s, d); } catch (err) { console.warn(`[import] WAL rename failed: ${err}`); }
    }
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    // Use dynamic column access (SELECT *) so we don't blow up on older Android schemas
    // missing a column. Defaults are applied per-field below.
    const convRows = db.query("SELECT * FROM ConversationEntity").all() as Record<string, unknown>[];
    const nodeStmt = db.query("SELECT * FROM message_node WHERE conversation_id = ? ORDER BY node_index ASC");

    let imported = 0;
    // DB-first + B1:合并基底二选一——PC zip 恢复路径已把备份会话放进 state.conversations
    // 暂存(替换语义,基底=备份内容);无暂存(Android zip 合并路径)则「逐会话流式合并」:
    // 只读现有会话的元数据(轻量)定序,会话节点按需逐会话从活库瞬时读、用完即放,绝不把
    // 全量会话文本一次性堆进内存(海量大库的「超级大导入」爆点正是这里,附件本就流式)。
    const mergeDb = getConversationsDb();
    const hasStaging = Array.isArray(state.conversations);
    const stagingList = hasStaging ? (state.conversations as Conversation[]) : null;
    const stagingIndexById = new Map<string, number>();
    stagingList?.forEach((conv, i) => stagingIndexById.set(conv.id, i));
    // 合并路径的现有会话按 updateAt 倒序当基底槽位(与旧全量方案的最终排序一致);
    // 命中备份的现有会话按需补节点并原位标记,保证「备份覆盖同 id」语义不变。
    const liveMetas = hasStaging ? [] : mergeDb ? listAllConversationMetas(mergeDb) : [];
    liveMetas.sort((a, b) => b.updateAt - a.updateAt);
    const liveIndexById = new Map<string, number>();
    liveMetas.forEach((meta, i) => liveIndexById.set(meta.id, i));
    const overwrittenLiveIndex = new Set<number>();
    const merged: Conversation[] = hasStaging
      ? (stagingList as Conversation[])
      : liveMetas.map((meta) => ({ ...meta, messages: [] }));

    for (const row of convRows) {
      const convId = String(row.id ?? "");
      if (!convId) continue;

      const nodeRows = nodeStmt.all(convId) as Record<string, unknown>[];
      const messageNodes: MessageNode[] = nodeRows.map((node) => {
        const rawMessages = typeof node.messages === "string" ? node.messages : "[]";
        let parsed: unknown[] = [];
        try {
          const decoded = JSON.parse(rawMessages);
          if (Array.isArray(decoded)) parsed = decoded;
        } catch {
          // B2:坏节点 JSON 此前静默吞成 [](该节点消息无声丢)。升级为可见计数。
          parsed = [];
          report.messageNodesUnreadable += 1;
        }
        const messages: Message[] = parsed
          .map(normalizeAndroidMessage)
          .filter((m): m is Message => m !== null)
          .map((m) => ({
            ...m,
            // Walk parts deeply and rewrite any Android upload paths into PC file refs. Done
            // per-message so a corrupted node only affects itself, not the whole conversation.
            parts: rewriteAndroidFileUrlsDeep(m.parts, androidFilenameToPcId) as MessagePart[],
          }));
        return {
          id: String(node.id ?? Bun.randomUUIDv7()),
          messages,
          selectIndex: typeof node.select_index === "number" ? node.select_index : 0,
        };
      });

      let chatSuggestions: string[] = [];
      try {
        const decoded = JSON.parse(typeof row.suggestions === "string" ? row.suggestions : "[]");
        if (Array.isArray(decoded)) chatSuggestions = decoded.filter((x): x is string => typeof x === "string");
      } catch { /* keep empty */ }

      // 专题9:安卓会话级注入绑定列(mode_injection_ids/lorebook_ids,JSON 数组字符串)。
      const parseIdArray = (value: unknown): string[] => {
        try {
          const decoded = JSON.parse(typeof value === "string" && value ? value : "[]");
          return Array.isArray(decoded) ? decoded.map((v) => String(v)) : [];
        } catch {
          return [];
        }
      };
      const conv: Conversation = {
        id: convId,
        assistantId: String(row.assistant_id ?? DEFAULT_ASSISTANT_ID) || DEFAULT_ASSISTANT_ID,
        systemPrompt: row.custom_system_prompt ? String(row.custom_system_prompt) : null,
        title: String(row.title ?? ""),
        messages: messageNodes,
        chatSuggestions,
        isPinned: row.is_pinned === 1 || row.is_pinned === true,
        createAt: Number(row.create_at ?? Date.now()),
        updateAt: Number(row.update_at ?? Date.now()),
        modeInjectionIds: parseIdArray(row.mode_injection_ids),
        lorebookIds: parseIdArray(row.lorebook_ids),
      };

      const existingIdx = stagingIndexById.get(conv.id) ?? liveIndexById.get(conv.id);
      if (existingIdx !== undefined) {
        merged[existingIdx] = conv; // 同 id 覆盖(二次导入幂等),保持基底槽位
        if (!hasStaging) overwrittenLiveIndex.add(existingIdx);
      } else {
        merged.push(conv); // 备份独有条目追加,末尾统一按 updateAt 倒序归位
      }
      imported += 1;
    }

    // 合并路径:把按需补读节点的现有会话(元数据槽位,内容被覆盖的跳过)回填进结果,
    // 然后整体按 updateAt 倒序——与旧「全量 existingById → Array.from → sort」逐元素等价。
    if (!hasStaging) {
      for (let i = 0; i < liveMetas.length; i++) {
        if (overwrittenLiveIndex.has(i)) continue;
        merged[i] = { ...merged[i], messages: mergeDb ? loadConversationNodesFromDb(mergeDb, liveMetas[i].id) : [] };
      }
      merged.sort((a, b) => b.updateAt - a.updateAt);
    }
    // Re-sort by updateAt desc so the imported conversations land in the natural "most
    // recent first" order alongside any PC-side conversations the user already had.
    state.conversations = merged;

    // 助手记忆:Android 存在同库的 MemoryEntity 表(字段 id / assistant_id / content,无时间戳)。
    // 按 (assistantId, content) 去重 merge 进 memoryStore——PC 已有的相同内容不重复导入;
    // Android 的 Int 自增 id 和 PC 的 id 空间不一致,memoryStore 统一重新分配。global 记忆的
    // assistant_id 两端都是 "__global__"。MemoryEntity 不存在(老版本 APP / 空库)时查询抛错,
    // 静默跳过。语义为"合并"(迁移场景,不覆盖 PC 已有记忆),区别于备份恢复的"替换"。
    try {
      const memoryRows = db.query("SELECT assistant_id, content FROM MemoryEntity").all() as Record<string, unknown>[];
      const flat: AssistantMemory[] = memoryRows.map((row) => ({
        id: 0,
        assistantId: String(row.assistant_id ?? GLOBAL_MEMORY_ID) || GLOBAL_MEMORY_ID,
        content: String(row.content ?? ""),
        createdAt: 0,
        updatedAt: 0,
      }));
      memoryStore.importFlatMemories(flat, "merge");
      invalidateContextSnapshots();
    } catch (err) {
      console.warn("[import] failed to read MemoryEntity table:", err);
    }
    return imported;
  } finally {
    db.close();
  }
}

/**
 * Defensive shape-coercion from Android UIMessage JSON to PC Message. Bad rows return null
 * (caller filters). Role enum is whitelisted to PC's 4 known values; anything else falls
 * back to "USER" rather than producing an unrecognized role.
 */
function normalizeAndroidMessage(raw: unknown): Message | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const role = typeof r.role === "string" ? r.role.toUpperCase() : "USER";
  const allowedRoles: Message["role"][] = ["USER", "ASSISTANT", "SYSTEM", "TOOL"];
  const mappedRole: Message["role"] = (allowedRoles as string[]).includes(role)
    ? (role as Message["role"])
    : "USER";
  return {
    id: typeof r.id === "string" ? r.id : Bun.randomUUIDv7(),
    role: mappedRole,
    parts: Array.isArray(r.parts) ? (r.parts as MessagePart[]) : [],
    annotations: Array.isArray(r.annotations) ? (r.annotations as JsonValue[]) : [],
    createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString(),
    finishedAt: typeof r.finishedAt === "string" ? r.finishedAt : null,
    modelId: typeof r.modelId === "string" ? r.modelId : null,
    usage: (r.usage ?? null) as JsonValue | null,
    translation: typeof r.translation === "string" ? r.translation : null,
  };
}

/** 导入备份收尾:中止所有流 + 清脏 + 重灌活库为暂存的 state.conversations,然后清空
 *  暂存与 working set。中止所有流 + 清脏防竞态(流式中导入备份:否则流式循环会继续
 *  upsert 旧节点进刚重灌的活库);清空 working set 防陈旧实例(导入前 checkout 的实例
 *  数据已作废,读到旧数据比读到空更危险)。 */
function finalizeConversationImport(): void {
  // 中止所有流(手动,不走 abortConversationGeneration 以免它 persist——马上要全量重灌)
  for (const conversationId of Array.from(generating.keys())) {
    generating.get(conversationId)?.abort();
  }
  generating.clear();
  clearConvDirtyState();
  // 有暂存才重灌:PC 备份恢复(替换语义,含"备份无会话→清空")与 Android 库合并都会建立
  // 暂存;settings-only Android zip 无暂存,不触碰活库现有会话。
  if (Array.isArray(state.conversations)) {
    snapshotConversationsDbBeforeImport();
    // B6-①a:工作区(dump format 2)随会话同事务重灌,保持"会话+其绑定工作区"原子替换。
    resetConversationsDbTo(state.conversations, state.pcWorkspaces, state.pcEngineTables);
    delete state.conversations; // 中转字段用完即清(State 类型注释有角色说明)
    delete state.pcWorkspaces;
    delete state.pcEngineTables;
  }
  clearWorkingSet();
  // R2-4:待发节点广播挂着旧实例引用,定时器触发会把导入前的陈旧帧广播出去,整表清空。
  clearAllPendingBroadcasts();
}

/** Stream an HTTP response body to a temp file (no in-JS-memory buffering) and route the
 *  saved file through applyAndroidZipBackupFromPath / applyBackupPayload as appropriate.
 *  Used by s3Restore + webDavRestore. Mirrors the local data/import streaming-path so
 *  multi-GB backups can be restored from cloud the same way they can from a local picker. */
export async function streamResponseToTempAndRestore(response: Response, fileName: string, onProgress?: (message: string, percent?: number) => void): Promise<void> {
  const tmpRoot = join(tempDir(), `rikkahub-restore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmpRoot, { recursive: true });
  const sanitized = fileName.replace(/[^A-Za-z0-9._\-]/g, "_") || "backup.zip";
  const onDiskName = sanitized.toLowerCase().endsWith(".zip") || sanitized.toLowerCase().endsWith(".json")
    ? sanitized
    : `${sanitized}.zip`;
  const onDiskPath = join(tmpRoot, onDiskName);
  const customJsBefore = customJsScriptSignatures(state.settings);
  try {
    const body = response.body;
    if (!body) throw new Error("Empty response body");
    const totalSize = Number(response.headers.get("Content-Length") || "0");
    let downloaded = 0;
    const writer = Bun.file(onDiskPath).writer();
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        writer.write(value);
        downloaded += value.length;
        if (totalSize > 0) {
          const pct = Math.round(downloaded / totalSize * 100);
          onProgress?.(`正在下载 (${pct}%)`, pct);
        }
      }
    } finally {
      await writer.end();
    }
    onProgress?.("正在导入数据...");
    const magic = new Uint8Array(await Bun.file(onDiskPath).slice(0, 4).arrayBuffer());
    const isZip = magic.length >= 4 && magic[0] === 0x50 && magic[1] === 0x4B && magic[2] === 0x03 && magic[3] === 0x04;
    // B2:云端恢复把结构化降级报告存进 settings.lastRestoreReport,经设置 SSE 推到前端——
    // 流式恢复的「成功但跳过/降级了 N 项」不再只留在控制台。error 级失败仍走 onProgress 即时提示。
    let report = newImportReport();
    let restoreSource = "";
    if (isZip) {
      report = applyAndroidZipBackupFromPath(onDiskPath).report;
      restoreSource = "cloud-zip";
    } else {
      report = applyBackupPayload(JSON.parse(readFileSync(onDiskPath, "utf-8")));
      restoreSource = "cloud-json";
    }
    state.settings = { ...state.settings, lastRestoreReport: { finishedAt: new Date().toISOString(), source: restoreSource, ...report } };
    saveState();
    broadcastSettings();
    const customJsWarning = customJsImportWarning(customJsBefore, state.settings);
    if (customJsWarning) {
      console.warn(`[restore] ${customJsWarning}`);
      onProgress?.(customJsWarning);
    }
  } finally {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
