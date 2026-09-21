// persistence/json-store.ts — state.json 读写与状态对象
// 纪律：负责 state 对象的持久化和共享，不依赖业务逻辑（阶段 2/3 逐步解耦 normalizeState）。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as fsPromises from "node:fs/promises";
import { dataDir, statePath } from "../foundation/paths";
import { reportError } from "../observability/app-errors";
import type { State } from "../foundation/types";

// 迁移常量：诞生版本档案，不可改。从 server.ts 迁出以便 persistence 层自包含。
export const CONVERSATIONS_SQLITE_MIGRATION = "conversations-sqlite-1.2.6";
export const MEMORY_FILE_SPLIT_MIGRATION = "memory-file-split-1.3.2";

// 全局状态对象。由 bootstrap() 在启动时通过 setState(loadState()) 初始化并赋值。
export let state!: State;
export function setState(next: State) { state = next; }

/** R1-1:Bun.serve 现在先于 loadState 绑端口(先打端口标记再跑迁移),选端口需要
 *  preferredPort 但不能等全量装载/迁移——这里对 state.json 做一次"只窥探端口"的轻量
 *  读取。任何失败(不存在/损坏/字段非法)都返回 null 走默认端口;损坏场景 loadState
 *  稍后自会走恢复链,恢复出的端口下次启动生效。 */
export function peekPreferredPortIn(statePathValue: string): number | null {
  try {
    if (!existsSync(statePathValue)) return null;
    const parsed = JSON.parse(readFileSync(statePathValue, "utf8")) as { settings?: { preferredPort?: unknown } };
    const port = parsed.settings?.preferredPort;
    return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

export function peekPreferredPort(): number | null {
  return peekPreferredPortIn(statePath);
}

let pendingThrottledSave: ReturnType<typeof setTimeout> | null = null;
let lastSaveStateMs = 0;
const STREAM_SAVE_INTERVAL_MS = 200;

export function scheduleThrottledSaveState() {
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

let activeSaveStatePromise: Promise<void> | null = null;
let coalescedSaveRequested = false;

async function performStateSave(): Promise<void> {
  lastSaveStateMs = Date.now();
  mkdirSync(dataDir, { recursive: true });
  // No pretty-printing — state.json is read by the server, not humans. On a large state
  // (post-import), the indentation alone can double serialize CPU cost.
  // logs 是内存态运行时缓冲（对齐移动端，重启清空），不写入 state.json。
  // JSON.stringify 对值为 undefined 的属性会省略键，故 logs 不会落盘。
  // conversations:仅当迁移标记（conversations-sqlite-1.2.6）已写时才排除——此时活库是
  // 权威源，state.json 瘦身。迁移未完成时必须保留 conversations，确保 state.json 始终是
  // 合法的重试源：若迁移失败后这里把会话抹空，下次启动 parsed.conversations 为空、活库也空，
  // 会话永久丢失（详见 migrateConversationsIfNeeded 的方案 B 兜底）。
  const convSqliteMigrated = Array.isArray(state.appliedMigrations)
    && state.appliedMigrations.includes(CONVERSATIONS_SQLITE_MIGRATION);
  const memoryFileSplit = Array.isArray(state.appliedMigrations)
    && state.appliedMigrations.includes(MEMORY_FILE_SPLIT_MIGRATION);
  // 与 conversations 同理：记忆迁移未完成时必须保留 state.memories，确保 state.json 始终
  // 是合法的重试源（迁移失败下次启动重试）；迁移完成后排除，瘦身且以 memory/ 为权威。
  const content = JSON.stringify({
    ...state,
    logs: undefined,
    ...(convSqliteMigrated ? { conversations: undefined } : {}),
    ...(memoryFileSplit ? { memories: undefined, nextMemoryId: undefined } : {}),
  });
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.${attempt}.tmp`;
    try {
      // Bun.write is non-blocking — yields to the event loop while the OS does the I/O.
      await Bun.write(tempPath, content);
      // fs.promises.rename is also non-blocking. The atomic temp-then-rename pattern
      // protects against torn writes if the process is killed mid-save.
      await fsPromises.rename(tempPath, statePath);
      maybeWriteDailyBackup(content);
      sweepObsoleteRecoveryFilesIfArmed();
      return;
    } catch (errorValue) {
      lastError = errorValue;
      try { await fsPromises.unlink(tempPath); } catch { /* cleanup best-effort */ }
      // Backoff via setTimeout/await rather than busy-wait — frees the event loop during
      // the retry delay. Windows occasionally holds locks on state.json briefly (e.g.
      // virus scanners), so the retries are still worth keeping.
      await new Promise<void>((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  // 全面审查 1-2:原先这里还有一步"非原子直写 state.json"的兜底——中途被杀即撕裂主文件,
  // 下次启动只能走损坏回退。删除该步:直接写 recovery 旁文件(全新文件,绝不撕裂既有数据),
  // loadState 的损坏回退链会优先采用最新 recovery(见 recoverStateFromBackups)。
  // P2-1:静默丢配置是最高危的一类故障,用户必须知道(通道镜像到 console)。
  try {
    await Bun.write(`${statePath}.recovery-${Date.now()}.json`, content);
    recoverySweepArmed = true; // 磁盘上有 recovery 了,下次成功落盘后需要清
    reportError("persistence", "error", "设置落盘失败，已写入抢救文件，重启后自动恢复", lastError, "state_save_failed_rescued");
  } catch (recErr) {
    reportError("persistence", "error", "设置落盘失败且抢救文件也写不出，本次变更未保存", lastError ?? recErr, "state_save_failed");
  }
}

// ----- 全面审查 1-3:state.json 滚动每日备份(单代)-----
// 会话有活库+WAL+导入前快照,设置层(供应商 apiKey/助手/记忆配置)此前只有一次性迁移
// 时代的化石快照。每天首次成功落盘后顺手写一份 state.json.daily.bak,与 recovery 链
// 组成完整恢复梯队(recovery=最后一笔 → daily.bak=最多回退一天 → pre-sqlite.bak=化石)。

let dailyBackupDoneForDay: string | null = null;

/** 参数化实现,回归测试直连;返回是否真的写了备份。失败只告警——备份是增强,不阻塞主写。 */
export function maybeWriteDailyBackupTo(bakPath: string, content: string, now = new Date()): boolean {
  const today = now.toISOString().slice(0, 10);
  if (dailyBackupDoneForDay === today) return false;
  try {
    try {
      // 跨进程重启同日不重复写:以备份文件 mtime 的日期为准
      if (new Date(statSync(bakPath).mtimeMs).toISOString().slice(0, 10) === today) {
        dailyBackupDoneForDay = today;
        return false;
      }
    } catch { /* 不存在 → 写 */ }
    const tempPath = `${bakPath}.${process.pid}.tmp`;
    writeFileSync(tempPath, content);
    renameSync(tempPath, bakPath);
    dailyBackupDoneForDay = today;
    return true;
  } catch (err) {
    dailyBackupDoneForDay = today; // 当天不再反复尝试/告警
    reportError("persistence", "warn", "设置每日备份写入失败，主数据不受影响", err, "daily_backup_failed");
    return false;
  }
}

function maybeWriteDailyBackup(content: string): void {
  maybeWriteDailyBackupTo(`${statePath}.daily.bak`, content);
}

/** 恢复链返回信息:除状态本体外携带来源与落盘时间,调用方必须让用户知道
 *  "回滚到了哪个备份、哪一天"(R1-2 ④)。 */
export interface RecoveredStateInfo {
  state: Partial<State>;
  source: string;
  mtimeMs: number;
}

/** 全面审查 1-2(批次一收口):state.json 损坏时的回退链(loadState 解析失败后调用)。
 *  候选 = recovery-*.json(落盘失败的最后一笔抢救)+ daily.bak(每日滚动)+
 *  pre-sqlite.bak(迁移时代化石)。原实现按"类别优先级"固定顺序,数月前的陈旧
 *  recovery 会压过昨天的 daily.bak——静默把设置/密钥回滚数月。现统一按文件 mtime
 *  新鲜度排序取最新可解析者;同龄(同一 tick 写出)按 recovery > daily > pre-sqlite
 *  破平。用过的 recovery 归档改名 .applied-<ts>,防下次启动重复采用。 */
export function recoverStateFromBackups(dataDirPath: string, statePathValue: string): RecoveredStateInfo | null {
  interface Candidate { path: string; source: string; mtimeMs: number; rank: number }
  const candidates: Candidate[] = [];
  try {
    for (const name of readdirSync(dataDirPath)) {
      if (!name.startsWith("state.json.recovery-") || !name.endsWith(".json")) continue;
      const candidatePath = join(dataDirPath, name);
      try {
        candidates.push({ path: candidatePath, source: name, mtimeMs: statSync(candidatePath).mtimeMs, rank: 0 });
      } catch { /* stat 失败 → 当不存在 */ }
    }
  } catch { /* readdir 失败 → 只剩固定候选 */ }
  const fixed = [
    { path: `${statePathValue}.daily.bak`, source: "daily.bak(每日滚动备份,最多回退一天)", rank: 1 },
    { path: join(dataDirPath, "state.json.pre-sqlite.bak"), source: "pre-sqlite.bak(迁移时代快照,可能显著过时)", rank: 2 },
  ];
  for (const f of fixed) {
    try {
      candidates.push({ ...f, mtimeMs: statSync(f.path).mtimeMs });
    } catch { /* 不存在 */ }
  }
  // mtime 新鲜度优先;同龄按类别(rank)破平;recovery 之间再按文件名时间戳降序破平。
  candidates.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.rank - b.rank) || b.source.localeCompare(a.source));
  // 用过的 recovery 不改名归档:采用后到首次成功落盘之间若再崩溃,改名会让下次启动
  // 读不到这份最新数据(.applied 不参与恢复链)。原样保留 → 重启重采用(幂等),
  // 首次成功落盘后由 sweepObsoleteRecoveryFilesIfArmed 统一清掉。
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(c.path, "utf8")) as Partial<State>;
      console.error(`[loadState] 已从备份恢复:${c.source}(落盘于 ${new Date(c.mtimeMs).toISOString()})`);
      return { state: parsed, source: c.source, mtimeMs: c.mtimeMs };
    } catch { /* 本候选损坏 → 试下一个 */ }
  }
  return null;
}

/** R1-2(终极补强):state.json 完好也要看一眼 recovery。场景:落盘八连败写出 recovery
 *  后进程随即退出(关机/崩溃时序),下次启动 state.json 能正常解析——但它是旧的,
 *  最后一笔状态只存在于 recovery 里;原实现只在"解析失败"时才读 recovery,这笔数据
 *  被静默丢弃。仅当 recovery 严格新于 state.json(mtime)才采用;正常运行中写过
 *  recovery 且后续保存成功的场景,成功路径已把 recovery 清掉,不会走到这里。
 *  采用后不改名不删除:首次成功落盘前再崩溃可幂等重采用;落盘成功即被清扫。 */
export function maybeAdoptFresherRecovery(dataDirPath: string, statePathValue: string): RecoveredStateInfo | null {
  let stateMtimeMs: number;
  try { stateMtimeMs = statSync(statePathValue).mtimeMs; } catch { return null; }
  let names: string[];
  try { names = readdirSync(dataDirPath); } catch { return null; }
  const fresher = names
    .filter((n) => n.startsWith("state.json.recovery-") && n.endsWith(".json"))
    .flatMap((n) => {
      const p = join(dataDirPath, n);
      try {
        const mtimeMs = statSync(p).mtimeMs;
        return mtimeMs > stateMtimeMs ? [{ path: p, source: n, mtimeMs }] : [];
      } catch { return []; }
    })
    .sort((a, b) => (b.mtimeMs - a.mtimeMs) || b.source.localeCompare(a.source));
  for (const c of fresher) {
    try {
      const parsed = JSON.parse(readFileSync(c.path, "utf8")) as Partial<State>;
      return { state: parsed, source: c.source, mtimeMs: c.mtimeMs };
    } catch { /* 该 recovery 损坏 → 试更早的 fresher */ }
  }
  return null;
}

// ── R1-2 ① 成功落盘后清扫过期 recovery ────────────────────────────────
// 成功写入的 state.json 必然新于磁盘上任何 recovery(saves 串行 + 实例锁单进程),
// 过期 recovery 留着只会在未来某次损坏恢复时把状态拽回旧点位,且内含全量 API Key。
// 启动时磁盘状况未知 → 首次成功保存清一次;此后仅在再次写出 recovery 后重新武装,
// 避免每次保存都 readdir。
let recoverySweepArmed = true;

export function sweepObsoleteRecoveryFilesIn(dir: string): number {
  let removed = 0;
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!name.startsWith("state.json.recovery-") || !name.endsWith(".json")) continue;
    try { unlinkSync(join(dir, name)); removed++; } catch { /* 单个失败不影响其余 */ }
  }
  if (removed > 0) console.log(`[state] 已清扫 ${removed} 个过期 recovery 文件`);
  return removed;
}

function sweepObsoleteRecoveryFilesIfArmed(): void {
  if (!recoverySweepArmed) return;
  recoverySweepArmed = false;
  sweepObsoleteRecoveryFilesIn(dataDir);
}

/** R1-2 ③:.applied-*(旧版"用后归档"产生的 recovery 残留,现行代码不再生成)
 *  内含全量 API Key,超龄即清(默认 30 天)。启动时调用(见 loadState)。 */
export function sweepAgedRecoveryArchivesIn(dir: string, maxAgeMs = 30 * 24 * 60 * 60 * 1000): number {
  let removed = 0;
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!name.startsWith("state.json.recovery-") || !name.includes(".applied-")) continue;
    const fullPath = join(dir, name);
    try {
      if (Date.now() - statSync(fullPath).mtimeMs < maxAgeMs) continue;
      unlinkSync(fullPath);
      removed++;
    } catch { /* 单个失败不影响其余 */ }
  }
  if (removed > 0) console.log(`[state] 已清扫 ${removed} 个超龄 recovery 归档(.applied)`);
  return removed;
}

export function sweepAgedRecoveryArchives(): number {
  return sweepAgedRecoveryArchivesIn(dataDir);
}

// ── 1-4 启动清扫 .tmp 残留 ──────────────────────────────────────
// 原子写的 rename 失败且 unlink 也失败(Windows 反病毒锁窗口两连击)会留下
// state.json.*.tmp——每个都是含全部 apiKey 的完整 state 副本,生产环境实测会
// 永久堆积。启动时清扫;10 分钟年龄护栏避免误删并发实例正在写的 tmp(双实例
// 互斥锁是 1-5,另批处理)。
export function sweepStaleStateTempFilesIn(dir: string, stateBasename: string, maxAgeMs = 10 * 60 * 1000): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(`${stateBasename}.`) || !name.endsWith(".tmp")) continue;
    const fullPath = join(dir, name);
    try {
      if (Date.now() - statSync(fullPath).mtimeMs < maxAgeMs) continue;
      unlinkSync(fullPath);
      removed++;
    } catch { /* 单个失败不影响其余清扫 */ }
  }
  if (removed > 0) console.log(`[state] 清扫 ${removed} 个残留 .tmp 文件`);
  return removed;
}

export function sweepStaleStateTempFiles(): number {
  return sweepStaleStateTempFilesIn(dataDir, basename(statePath));
}

export function saveState(): void {
  // Cancel any pending throttled save — its work is about to be done by this call.
  if (pendingThrottledSave) {
    clearTimeout(pendingThrottledSave);
    pendingThrottledSave = null;
  }
  // If a save is already in flight, mark that another save is needed; it'll run when
  // the current one completes. Coalesces a burst of saves into at most two writes
  // (current + one trailing) instead of N synchronous serializations.
  if (activeSaveStatePromise) {
    coalescedSaveRequested = true;
    return;
  }
  const run = async (): Promise<void> => {
    try {
      await performStateSave();
    } finally {
      if (coalescedSaveRequested) {
        coalescedSaveRequested = false;
        // Snapshot the latest state — performStateSave reads `state` at call time, so
        // re-running it will pick up any changes that landed during the previous write.
        activeSaveStatePromise = run();
        // 尾随写与主路径(本函数尾部)同契约:fire-and-forget,rejection 落 console——
        // 此前漏挂 .catch,尾随写一旦拒绝即成 unhandled rejection。
        activeSaveStatePromise.catch((err) => console.warn("saveState failed", err));
      } else {
        activeSaveStatePromise = null;
      }
    }
  };
  activeSaveStatePromise = run();
  // Surface unhandled rejections to the console rather than crashing the process —
  // every saveState call is treated as fire-and-forget by the existing call sites.
  activeSaveStatePromise.catch((err) => console.warn("saveState failed", err));
}

/** Used by graceful shutdown paths to ensure the final write completes on disk.
 *  全面审查 1-1:必须循环追引用——coalesced 尾随写在 finally 里把 activeSaveStatePromise
 *  换成新 promise,只 await 一次旧引用会漏掉最后一笔(拿到旧引用即返回)。 */
export async function flushSaveState(): Promise<void> {
  while (activeSaveStatePromise) {
    const current = activeSaveStatePromise;
    try { await current; } catch { /* already logged */ }
    if (activeSaveStatePromise === current) break; // 防御:引用未变说明已结算,避免死循环
  }
}

/** 同步 temp+rename 写瘦 state.json。loadState 启动阶段用（不能异步）。 */
export function writeSlimStateJsonSync(data: Partial<State>): void {
  const slimContent = JSON.stringify({ ...data, logs: undefined, conversations: undefined });
  const tempPath = `${statePath}.migrate.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, slimContent);
  try {
    renameSync(tempPath, statePath);
  } catch (err) {
    try { unlinkSync(tempPath); } catch { /* cleanup best-effort */ }
    throw err;
  }
}

/** 同步 temp+rename 写瘦 state.json，记忆迁移后立即落盘用（S2-b）。
 *  排除 logs（始终内存态）、conversations（会话已迁移则不写，未迁移则保留——按标记判断）、
 *  memories/nextMemoryId（调用前已 delete，不出现）。 */
export function writeSlimStateJsonSyncForMemory(data: State): void {
  const convMigrated = Array.isArray(data.appliedMigrations)
    && data.appliedMigrations.includes(CONVERSATIONS_SQLITE_MIGRATION);
  const slimContent = JSON.stringify({
    ...data,
    logs: undefined,
    ...(convMigrated ? { conversations: undefined } : {}),
  });
  const tempPath = `${statePath}.mem-migrate.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, slimContent);
    renameSync(tempPath, statePath);
  } catch (err) {
    try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    reportError("persistence", "warn", "写瘦设置文件失败，下次启动重试", err, "slim_state_failed");
  }
}

