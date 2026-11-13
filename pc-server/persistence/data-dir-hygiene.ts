// persistence/data-dir-hygiene.ts — 数据目录卫生(全面审查 R1-13)
// 原则(审查阶段九):只碰"冗余/可再生/已过期"三类,绝不触碰唯一副本;每次清理在
// 错误中心留 info 级痕迹。就绪后由 server.ts 异步触发,失败只留痕、不影响运行。
// 保留策略(批次四决策,详见发现文档批次四记录):
// - corrupt-* 损坏隔离文件(活库/记忆):同族保最新一份(取证价值),其余超龄 30 天清;
// - pi-agent/:旧版 pi 数据目录(装过 jsonl 时代的引擎记忆与空置的客房),pi 的数据目录已迁到
//   engines/pi/,旧目录存在即整目录退役删除;
// - updates/:版本 ≤ 当前 APP_VERSION 的安装包与 extracted-* 解压残留即删(纯可再生);
// - state.json.pre-memory-split.bak:迁移标记已写且超龄 30 天即删(全代码无读取方,纯遗物);
//   pre-sqlite.bak 原样保留——它仍是活库损坏恢复链的最后兜底,退役需先补替代兜底(未做);
// - files/ 孤儿附件:只统计提示、不删(GC 需与安卓删除语义对齐,留后续专项);
// - 备份类收敛 backups/ 子目录:缓做(要改恢复链全部路径,收益只有目录可读性)。

import { existsSync, readdirSync, rmSync, statSync, unlinkSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";
import { dataDir, filesDir, memoryDir, updatesCacheDir } from "../foundation/paths";
import { compareSemver } from "../foundation/utils";
import { APP_VERSION } from "../updates/index";
import { reportError } from "../observability/app-errors";
import { MEMORY_FILE_SPLIT_MIGRATION, state } from "./json-store";
import { collectReferencedFileIds } from "../backup/export";

const DAY_MS = 24 * 60 * 60 * 1000;
const CORRUPT_MAX_AGE_MS = 30 * DAY_MS;
const FOSSIL_MAX_AGE_MS = 30 * DAY_MS;
/** 孤儿附件统计要全库扫节点(同步 CPU),不必每次启动都付这个成本。 */
const ORPHAN_STATS_LAUNCH_INTERVAL = 10;

/** corrupt-* 隔离文件:同族(同基名)保最新一份——无论多老,那是仅存的取证副本;
 *  其余超龄即删。族 = `<基名>.corrupt-<时间戳>` 的基名(rikka_hub.db / global_memory.json …)。 */
export function sweepCorruptQuarantineIn(dir: string, maxAgeMs = CORRUPT_MAX_AGE_MS, now = Date.now()): string[] {
  const removed: string[] = [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return removed; }
  const families = new Map<string, { name: string; mtimeMs: number }[]>();
  for (const name of names) {
    const match = name.match(/^(.+)\.corrupt-\d+$/);
    if (!match) continue;
    try {
      const mtimeMs = statSync(join(dir, name)).mtimeMs;
      const list = families.get(match[1]!) ?? [];
      list.push({ name, mtimeMs });
      families.set(match[1]!, list);
    } catch { /* stat 失败 → 当不存在 */ }
  }
  const nameTs = (name: string) => Number(name.match(/\.corrupt-(\d+)$/)?.[1] ?? 0);
  for (const list of families.values()) {
    // mtime 新者在前;同 mtime(同一 tick 隔离出两份)按文件名时间戳破平——命名时间戳
    // 是隔离动作自己写的,权威。
    list.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (nameTs(b.name) - nameTs(a.name)));
    for (const item of list.slice(1)) {
      if (now - item.mtimeMs < maxAgeMs) continue;
      try {
        unlinkSync(join(dir, item.name));
        removed.push(item.name);
      } catch { /* 单个失败不影响其余 */ }
    }
  }
  return removed;
}

/** updates/:文件名里能解析出语义化版本且 ≤ 当前版本的安装包/解压目录即删。
 *  版本解析不出来的一律保留——安全第一,宁可漏清不可错删。 */
export function sweepStaleInstallersIn(updatesDir: string, currentVersion: string): string[] {
  const removed: string[] = [];
  let entries: Dirent[];
  try { entries = readdirSync(updatesDir, { withFileTypes: true }); } catch { return removed; }
  for (const entry of entries) {
    const version = entry.name.match(/\d+\.\d+\.\d+/)?.[0];
    if (!version || compareSemver(version, currentVersion) > 0) continue;
    const fullPath = join(updatesDir, entry.name);
    try {
      if (entry.isDirectory()) rmSync(fullPath, { recursive: true, force: true });
      else unlinkSync(fullPath);
      removed.push(entry.name);
    } catch { /* 被占用等,下次启动再清 */ }
  }
  return removed;
}

/** 1.3.2 记忆迁移遗留快照:迁移标记已写(memory/ 目录即权威)且超龄即删。
 *  与 pre-sqlite.bak 不同,它在恢复链/兜底路径中没有任何读取方,是纯遗物。 */
export function sweepMemorySplitFossilIn(dir: string, migrationDone: boolean, maxAgeMs = FOSSIL_MAX_AGE_MS, now = Date.now()): boolean {
  if (!migrationDone) return false;
  const bakPath = join(dir, "state.json.pre-memory-split.bak");
  try {
    if (!existsSync(bakPath)) return false;
    if (now - statSync(bakPath).mtimeMs < maxAgeMs) return false;
    unlinkSync(bakPath);
    return true;
  } catch {
    return false;
  }
}

export interface OrphanUploadStats {
  /** 账本条目未被任何形态引用(删会话不删文件、画廊截断遗留等)。 */
  orphanEntries: number;
  orphanBytes: number;
  /** files/ 里没有对应账本条目的物理文件(半途上传/历史缺陷遗留)。 */
  untrackedFiles: number;
  untrackedBytes: number;
}

export function computeOrphanUploadStats(referenced: Set<number>): OrphanUploadStats {
  let orphanEntries = 0;
  let orphanBytes = 0;
  const ledgerBasenames = new Set<string>();
  const ledgerIds = new Set<number>();
  for (const f of state.files) {
    ledgerIds.add(f.id);
    const path = f.path && existsSync(f.path) ? f.path : "";
    if (path) ledgerBasenames.add(basename(path));
    if (referenced.has(f.id)) continue;
    orphanEntries++;
    if (path) {
      try { orphanBytes += statSync(path).size; } catch { /* 忽略 */ }
    }
  }
  let untrackedFiles = 0;
  let untrackedBytes = 0;
  try {
    for (const name of readdirSync(filesDir)) {
      if (ledgerBasenames.has(name)) continue;
      // 提取文本旁车 <id>.extracted.txt:账本里有该 id 就算被追踪
      const sidecarId = name.match(/^(\d+)\.extracted\.txt$/)?.[1];
      if (sidecarId && ledgerIds.has(Number(sidecarId))) continue;
      try {
        const st = statSync(join(filesDir, name));
        if (!st.isFile()) continue;
        untrackedFiles++;
        untrackedBytes += st.size;
      } catch { /* 忽略 */ }
    }
  } catch { /* files/ 不存在 */ }
  return { orphanEntries, orphanBytes, untrackedFiles, untrackedBytes };
}

/** 退役清理:旧版 pi 数据目录 pi-agent/ 整目录删除。它只装过 jsonl 引擎记忆(P7 起无读取方)与空置
 *  的客房;pi 的数据目录已迁到 engines/pi/(paths.piAgentDir)。全局 AGENTS.md 在发版之前就已迁出
 *  (v2.0.0-preview-v5 同版内完成),所以这里没有用户亲写的内容,删了零数据损失。 */
export function sweepLegacyPiAgentDirIn(dir: string): boolean {
  const retiredDir = join(dir, "pi-agent");
  try {
    if (!existsSync(retiredDir)) return false;
    rmSync(retiredDir, { recursive: true, force: true });
    return true;
  } catch {
    // 删不掉(文件被占用等)就留到下次启动再试,残留不影响运行。
    return false;
  }
}

/** 就绪后异步执行的卫生任务总入口(server.ts 调用)。 */
export async function runDataDirHygiene(): Promise<void> {
  try {
    // 让开启动后的首屏请求高峰
    await Bun.sleep(3_000);
    if (sweepLegacyPiAgentDirIn(dataDir)) {
      reportError("persistence", "info", "数据目录清理：退役并移除旧版引擎数据目录", "pi-agent/(已迁到 engines/pi/)", "hygiene_pi_agent_dir_retired");
    }
    const removedCorrupt = [...sweepCorruptQuarantineIn(dataDir), ...sweepCorruptQuarantineIn(memoryDir)];
    if (removedCorrupt.length > 0) {
      reportError("persistence", "info", `数据目录清理：移除 ${removedCorrupt.length} 个过期的损坏隔离文件`, removedCorrupt.join("、"), "hygiene_corrupt_cleaned", { count: removedCorrupt.length });
    }
    const removedInstallers = sweepStaleInstallersIn(updatesCacheDir, APP_VERSION);
    if (removedInstallers.length > 0) {
      reportError("persistence", "info", `数据目录清理：移除 ${removedInstallers.length} 个过时的更新安装包残留`, removedInstallers.join("、"), "hygiene_installers_cleaned", { count: removedInstallers.length });
    }
    const memorySplitDone = Array.isArray(state.appliedMigrations) && state.appliedMigrations.includes(MEMORY_FILE_SPLIT_MIGRATION);
    if (sweepMemorySplitFossilIn(dataDir, memorySplitDone)) {
      reportError("persistence", "info", "数据目录清理：移除旧版迁移遗留快照", "state.json.pre-memory-split.bak", "hygiene_legacy_snapshot_cleaned");
    }
    // 孤儿附件只统计提示(全库扫节点较重,按启动次数间隔执行)
    if (state.launchCount % ORPHAN_STATS_LAUNCH_INTERVAL === 1) {
      await Bun.sleep(0);
      const stats = computeOrphanUploadStats(collectReferencedFileIds());
      if (stats.orphanEntries > 0 || stats.untrackedFiles > 0) {
        const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
        reportError(
          "persistence",
          "info",
          `附件目录统计：${stats.orphanEntries} 个条目已无引用，约 ${mb(stats.orphanBytes)} MB；另有 ${stats.untrackedFiles} 个无记录文件，约 ${mb(stats.untrackedBytes)} MB。不会自动删除，如需清理请先备份`,
          undefined,
          "orphan_stats",
          {
            orphans: stats.orphanEntries,
            orphanMb: mb(stats.orphanBytes),
            untracked: stats.untrackedFiles,
            untrackedMb: mb(stats.untrackedBytes),
          },
        );
      }
    }
  } catch (err) {
    reportError("persistence", "warn", "数据目录清理任务失败，不影响运行，下次启动重试", err, "hygiene_failed");
  }
}
