// memory/index.ts — 记忆系统
// 纪律：负责记忆的加载、写入、待确认队列与备份导入导出。

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { dateKey, isRecord, textFromParts } from "../foundation/utils";
import { basename } from "node:path";
import { globalMemoryPath, assistantMemoryPath, memoryDir, pendingMemoryPath } from "../foundation/paths";
import { reportError } from "../observability/app-errors";
import { getConversationsDb, peekFirstMessageParts } from "../conversations/index";
import { recentConversationMetas } from "../conversations/read-queries";
import { state } from "../persistence/json-store";
import type {
  AddMemoryInput,
  Assistant,
  AssistantMemory,
  AssistantMemoryFile,
  AssistantMemoryGroup,
  GlobalMemoryFile,
  MemoryEntry,
  MemorySnapshot,
  PendingEntry,
  PendingMemoryFile,
  State,
} from "../foundation/types";

// Mirrors `MemoryRepository.kt:11` in the original RikkaHub project. Keeping the literal
// value identical means a `state.json` produced on one platform can be imported on the
// other without losing the global-scope memory records.
export const GLOBAL_MEMORY_ID = "__global__";

// pending 队列容量上限（M7）。超限拒绝入队，工具返回 overflow，徽章变体高亮提醒用户处理积压。
const PENDING_MAX = 100;

export const memoryStore = {
  globalMemories: [] as MemoryEntry[],
  assistantGroups: [] as AssistantMemoryGroup[],
  pending: [] as PendingEntry[],
  nextMemoryId: 1,
  loaded: false,
  // 串行化写队列：每次写操作排队，保证不并发写文件。批量编辑/AI 写入/导入都走这条队列。
  writeQueue: Promise.resolve() as Promise<unknown>,

  // ---------- 文件 IO ----------

  /** 读 JSON；缺失/损坏降级为 fallback，绝不抛错（启动失败比数据丢失更可接受）。 */
  readFile<T>(filePath: string, fallback: T): T {
    if (!existsSync(filePath)) return fallback;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      return parsed && typeof parsed === "object" ? { ...fallback, ...parsed } as T : fallback;
    } catch (err) {
      // 9-1/6-3:此前仅 console.warn 后返回空默认,后续任何 persistAll 都会用空数据
      // 覆写损坏原件且用户零感知("记忆全没了")。先把原件改名隔离保住原始字节,再上报。
      try {
        renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
      } catch { /* 隔离失败不阻塞降级 */ }
      reportError("persistence", "error", `记忆文件损坏，已隔离原件并回退默认：${basename(filePath)}`, err, "memory_corrupt", { file: basename(filePath) });
      return fallback;
    }
  },

  /** 同步原子 temp-rename 写（启动/迁移阶段用，不能异步）。8 次重试，对齐 state.json 模式。 */
  writeJsonSync(filePath: string, data: unknown) {
    mkdirSync(memoryDir, { recursive: true });
    const content = JSON.stringify(data, null, 2);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.${attempt}.tmp`;
      try {
        writeFileSync(tempPath, content);
        renameSync(tempPath, filePath);
        return;
      } catch (err) {
        lastError = err;
        try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
      }
    }
    reportError("persistence", "error", `记忆写入失败，重试 8 次后放弃，本次变更未保存：${basename(filePath)}`, lastError, "memory_write_failed", { file: basename(filePath) });
  },

  /** 异步原子 temp-rename 写（运行时用）。Bun.write + fsPromises.rename，8 次重试。 */
  async writeJsonAsync(filePath: string, data: unknown) {
    mkdirSync(memoryDir, { recursive: true });
    const content = JSON.stringify(data, null, 2);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.${attempt}.tmp`;
      try {
        await Bun.write(tempPath, content);
        await fsPromises.rename(tempPath, filePath);
        return;
      } catch (err) {
        lastError = err;
        try { await fsPromises.unlink(tempPath); } catch { /* best-effort cleanup */ }
        await new Promise<void>((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
    reportError("persistence", "error", `记忆写入失败，重试 8 次后放弃，本次变更未保存：${basename(filePath)}`, lastError, "memory_write_failed", { file: basename(filePath) });
  },

  /** 把一次写任务推入串行队列。吞掉 reject 避免"一次失败永久污染队列"
   *  （失败已在 task 内部 console.warn，这里只需不让它传播给后续 .then）。 */
  enqueueWrite(task: () => Promise<unknown>): Promise<unknown> {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.catch(() => {});
    return run;
  },

  /** 全量落盘三个文件。先写 global（含 nextMemoryId 计数器）、再写 assistant/pending——
   *  保证 S1 顺序：计数器先于记忆持久化。崩在 global 写完、assistant 写之前，
   *  重启 recompute 会从不完整的 assistant 文件重算 nextMemoryId，已落盘 id 永不重用。 */
  persistAll(): Promise<unknown> {
    return this.enqueueWrite(async () => {
      await this.writeJsonAsync(globalMemoryPath, {
        version: 1,
        nextMemoryId: this.nextMemoryId,
        memories: this.globalMemories,
      });
      await this.writeJsonAsync(assistantMemoryPath, {
        version: 1,
        assistants: this.assistantGroups,
      });
      await this.writeJsonAsync(pendingMemoryPath, {
        version: 1,
        pending: this.pending,
      });
    });
  },

  // ---------- 启动加载与迁移 ----------

  /** S1 兜底：nextMemoryId = max（所有现存 id）+1。不信任持久化值——
   *  无论崩溃发生在写入的哪一步，重启后都能自愈，杜绝 id 重用。 */
  recomputeNextId() {
    let max = 0;
    for (const m of this.globalMemories) if (m.id > max) max = m.id;
    for (const g of this.assistantGroups) for (const m of g.memories) if (m.id > max) max = m.id;
    this.nextMemoryId = max + 1;
  },

  /** 从 settings.assistants 反查助手名，刷新 assistantName 快照。
   *  反查不到（助手已删除）填 "未知助手"（M5），UI 归"已删除的助手"分组。 */
  refreshAssistantNames(assistants: Assistant[]) {
    const nameById = new Map<string, string>();
    for (const a of assistants) nameById.set(a.id, a.name);
    for (const group of this.assistantGroups) {
      group.assistantName = nameById.get(group.assistantId) ?? "未知助手";
    }
  },

  /** 已迁移：从 memory/ 目录加载到内存。启动阶段调用，传入当前 state（刷助手名快照）。 */
  load(stateObj: State) {
    const gmf = this.readFile(globalMemoryPath, { version: 1, nextMemoryId: 1, memories: [] }) as GlobalMemoryFile;
    this.globalMemories = Array.isArray(gmf.memories) ? gmf.memories : [];
    const amf = this.readFile(assistantMemoryPath, { version: 1, assistants: [] }) as AssistantMemoryFile;
    this.assistantGroups = Array.isArray(amf.assistants) ? amf.assistants : [];
    const pmf = this.readFile(pendingMemoryPath, { version: 1, pending: [] }) as PendingMemoryFile;
    this.pending = Array.isArray(pmf.pending) ? pmf.pending : [];
    this.recomputeNextId();
    this.refreshAssistantNames(stateObj.settings.assistants);
    this.loaded = true;
  },

  /** 首次升级迁移：把旧 state.memories 搬到 memory/ 目录。保留原 id（PC 内部已全局唯一，
   *  无冲突风险）。同步落盘（启动阶段不能异步），写入后 loaded=true。 */
  migrateFromStateMemories(memories: AssistantMemory[], assistants: Assistant[]) {
    this.globalMemories = [];
    this.assistantGroups = [];
    this.pending = [];
    const nameById = new Map<string, string>();
    for (const a of assistants) nameById.set(a.id, a.name);
    const now = Date.now();
    let maxId = 0;
    for (const m of memories) {
      const rawId = String(m.assistantId ?? GLOBAL_MEMORY_ID);
      const assistantId = rawId === "global" ? GLOBAL_MEMORY_ID : rawId;
      const content = String(m.content ?? "").trim();
      if (!content) continue;
      const entry: MemoryEntry = {
        id: Number(m.id) || 1,
        content,
        createdAt: Number(m.createdAt) || now,
        updatedAt: Number(m.updatedAt) || now,
        source: "manual",  // 老数据无法判断来源，统一 manual
      };
      if (entry.id > maxId) maxId = entry.id;
      if (assistantId === GLOBAL_MEMORY_ID) {
        this.globalMemories.push(entry);
      } else {
        let group = this.assistantGroups.find((g: AssistantMemoryGroup) => g.assistantId === assistantId);
        if (!group) {
          group = { assistantId, assistantName: nameById.get(assistantId) ?? "未知助手", memories: [] };
          this.assistantGroups.push(group);
        }
        group.memories.push(entry);
      }
    }
    this.nextMemoryId = maxId + 1;
    // 同步写三个文件（启动阶段）；目录由 writeJsonSync 内部 mkdirSync 创建。
    this.writeJsonSync(globalMemoryPath, { version: 1, nextMemoryId: this.nextMemoryId, memories: this.globalMemories });
    this.writeJsonSync(assistantMemoryPath, { version: 1, assistants: this.assistantGroups });
    this.writeJsonSync(pendingMemoryPath, { version: 1, pending: [] });
    this.loaded = true;
  },

  // ---------- 读取 ----------

  getGlobalMemories(): MemoryEntry[] { return this.globalMemories; },

  getAssistantMemories(assistantId: string): MemoryEntry[] {
    const group = this.assistantGroups.find((g: AssistantMemoryGroup) => g.assistantId === assistantId);
    return group ? group.memories : [];
  },

  getAllAssistantGroups(): AssistantMemoryGroup[] { return this.assistantGroups; },

  getPending(): PendingEntry[] { return this.pending; },

  /** 扁平化所有记忆为备份契约格式（无 source；全局的 assistantId 写 "__global__"）。
   *  这是 PC↔PC / APP↔PC 备份的外部契约，格式不可变（[[backup-android-memory-table]]）。 */
  exportFlat(): AssistantMemory[] {
    const flat: AssistantMemory[] = [];
    for (const m of this.globalMemories) {
      flat.push({ id: m.id, assistantId: GLOBAL_MEMORY_ID, content: m.content, createdAt: m.createdAt, updatedAt: m.updatedAt });
    }
    for (const g of this.assistantGroups) {
      for (const m of g.memories) {
        flat.push({ id: m.id, assistantId: g.assistantId, content: m.content, createdAt: m.createdAt, updatedAt: m.updatedAt });
      }
    }
    return flat;
  },

  // ---------- 写入（运行时；全局 state 已就绪） ----------

  /** 新增记忆。S1：内存层面先自增 nextMemoryId 再入队；persistAll 先写 global（计数器）
   *  再写 assistant，保证计数器先于记忆持久化。返回新条目。
   *  persist=false 时只改内存不落盘——供 resolvePending 在批量改内存后统一一次 persistAll，
   *  避免"addMemory 内部 fire-and-forget 一次 + resolvePending 末尾再 await 一次"的冗余 IO。 */
  addMemory(input: AddMemoryInput, persist = true): MemoryEntry {
    const content = String(input.content ?? "").trim();
    if (!content) throw new Error("content is required");
    const now = Date.now();
    const entry: MemoryEntry = {
      id: this.nextMemoryId,
      content,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
      source: input.source ?? "manual",
    };
    this.nextMemoryId += 1;
    if (input.scope === "global") {
      this.globalMemories.push(entry);
    } else {
      const assistantId = String(input.assistantId ?? "");
      if (!assistantId) throw new Error("assistantId is required for assistant-scope memory");
      let group = this.assistantGroups.find((g: AssistantMemoryGroup) => g.assistantId === assistantId);
      if (!group) {
        group = {
          assistantId,
          assistantName: state.settings.assistants.find((a) => a.id === assistantId)?.name ?? "未知助手",
          memories: [],
        };
        this.assistantGroups.push(group);
      }
      group.memories.push(entry);
    }
    if (persist) void this.persistAll();
    return entry;
  },

  /** 全局唯一 id 定位 + 改内容。updatedAt 刷新 + source 置 manual（M2：用户手动编辑过的记忆
   *  不再挂 AI 来源标签——前端 MemoryItem 据此决定是否显示"AI 来源"）。 */
  updateMemory(memoryId: number, content: string): MemoryEntry {
    const trimmed = String(content ?? "").trim();
    if (!trimmed) throw new Error("content is required");
    const entry = this.findEntryById(memoryId);
    if (!entry) throw new Error(`Memory record #${memoryId} not found`);
    entry.content = trimmed;
    entry.updatedAt = Date.now();
    entry.source = "manual";
    void this.persistAll();
    return entry;
  },

  /** 全局唯一 id 定位 + 删除。返回是否命中。 */
  deleteMemory(memoryId: number): boolean {
    const gbefore = this.globalMemories.length;
    this.globalMemories = this.globalMemories.filter((m: MemoryEntry) => m.id !== memoryId);
    if (this.globalMemories.length < gbefore) {
      void this.persistAll();
      return true;
    }
    for (const group of this.assistantGroups) {
      const before = group.memories.length;
      group.memories = group.memories.filter((m: MemoryEntry) => m.id !== memoryId);
      if (group.memories.length < before) {
        void this.persistAll();
        return true;
      }
    }
    return false;
  },

  /** 删除某助手的所有记忆（删除助手时调用）。返回删除条数。 */
  deleteMemoriesByAssistant(assistantId: string): number {
    const idx = this.assistantGroups.findIndex((g: AssistantMemoryGroup) => g.assistantId === assistantId);
    if (idx < 0) return 0;
    const count = this.assistantGroups[idx].memories.length;
    this.assistantGroups.splice(idx, 1);
    if (count > 0) void this.persistAll();
    return count;
  },

  /** 复制某助手的所有记忆到另一助手（复制助手时按需调用）。逐条 addMemory 保留内容、
   *  分配新 id（对齐 APP copyMemories——副本与源各自演化,不共享 id）。返回复制条数;
   *  persist=false 供与助手落库同批的场景由调用方统一一次 persistAll。 */
  copyAssistantMemories(fromAssistantId: string, toAssistantId: string, persist = true): number {
    const source = this.getAssistantMemories(fromAssistantId);
    for (const entry of source) {
      this.addMemory(
        { scope: "assistant", assistantId: toAssistantId, content: entry.content, source: entry.source },
        false,
      );
    }
    if (persist && source.length > 0) void this.persistAll();
    return source.length;
  },

  findEntryById(memoryId: number): MemoryEntry | undefined {
    for (const m of this.globalMemories) if (m.id === memoryId) return m;
    for (const g of this.assistantGroups) for (const m of g.memories) if (m.id === memoryId) return m;
    return undefined;
  },

  // ---------- 备份导入 ----------

  /** 清空全部记忆（含 pending）。备份恢复 replace 语义用。 */
  clearAll() {
    this.globalMemories = [];
    this.assistantGroups = [];
    this.pending = [];
    this.nextMemoryId = 1;
  },

  /** 批量导入扁平数组。
   *  mode="replace":先 clearAll 再导入（PC 备份恢复——整体替换语义）
   *  mode="merge":按 (assistantId, content) 去重并入（APP→PC 迁移——补充语义）
   *  两种模式都重新分配 id（备份/APP 的 id 空间可能与当前冲突）。导入后 recompute 兜底。 */
  importFlatMemories(flat: AssistantMemory[], mode: "replace" | "merge") {
    if (mode === "replace") this.clearAll();
    const seen = mode === "merge"
      ? new Set(this.exportFlat().map((m: AssistantMemory) => `${m.assistantId} ${m.content}`))
      : new Set<string>();
    const now = Date.now();
    for (const item of flat) {
      const rawId = String(item.assistantId ?? GLOBAL_MEMORY_ID);
      const assistantId = rawId === "global" ? GLOBAL_MEMORY_ID : rawId;
      const content = String(item.content ?? "").trim();
      if (!content) continue;
      const key = `${assistantId} ${content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // 直接构造内存对象（不经 addMemory，避免逐条触发 persistAll 的 IO 开销）。
      const entry: MemoryEntry = {
        id: this.nextMemoryId,
        content,
        createdAt: Number(item.createdAt) || now,
        updatedAt: Number(item.updatedAt) || now,
        source: "manual",  // 导入的记忆无法判断原 source，统一 manual
      };
      this.nextMemoryId += 1;
      if (assistantId === GLOBAL_MEMORY_ID) {
        this.globalMemories.push(entry);
      } else {
        let group = this.assistantGroups.find((g: AssistantMemoryGroup) => g.assistantId === assistantId);
        if (!group) {
          group = {
            assistantId,
            assistantName: state.settings.assistants.find((a) => a.id === assistantId)?.name ?? "未知助手",
            memories: [],
          };
          this.assistantGroups.push(group);
        }
        group.memories.push(entry);
      }
    }
    this.recomputeNextId();
    void this.persistAll();
  },

  // ---------- 待确认队列（阶段 3） ----------

  /** 入队一条待确认记忆。M7：与现有 pending content 完全相同（忽略首尾空白）则不重复入队
   *  （返回 null）；超 PENDING_MAX 容量上限拒绝（返回 "overflow"）。
   *  落盘 await 完成——pending 是用户尚未确认的数据，丢不得（区别于 addMemory 的 fire-and-forget）。 */
  async enqueuePending(entry: { conversationId: string; conversationTitle?: string; assistantId: string; assistantName: string; content: string; messageNodeId?: string }): Promise<PendingEntry | "overflow" | null> {
    const content = String(entry.content ?? "").trim();
    if (!content) throw new Error("content is required");
    if (this.pending.some((p: PendingEntry) => p.content.trim() === content)) return null;       // M7 去重
    if (this.pending.length >= PENDING_MAX) return "overflow";                      // M7 容量
    const pendingEntry: PendingEntry = {
      pendingId: `p-${crypto.randomUUID()}`,
      conversationId: String(entry.conversationId ?? ""),
      ...(entry.conversationTitle ? { conversationTitle: entry.conversationTitle } : {}),
      assistantId: String(entry.assistantId ?? ""),
      assistantName: String(entry.assistantName ?? ""),
      content,
      proposedAt: Date.now(),
      ...(entry.messageNodeId ? { messageNodeId: entry.messageNodeId } : {}),
    };
    this.pending.push(pendingEntry);
    await this.persistAll();
    return pendingEntry;
  },

  /** 处理一条 pending。action: "global"|"assistant"|"discard"。contentOverride 可选（用户编辑后）。
   *  无论何种 action，处理完立即从 pending 移除（保证干净）。source 规则（§4.1）：用户编辑过→manual，
   *  否则 ai（原样确认）。pendingId 不存在返回 { resolved: false }。 */
  async resolvePending(pendingId: string, action: "global" | "assistant" | "discard", contentOverride?: string): Promise<{ resolved: boolean; memory?: MemoryEntry }> {
    const idx = this.pending.findIndex((p: PendingEntry) => p.pendingId === pendingId);
    if (idx < 0) return { resolved: false };
    const entry = this.pending[idx];
    const content = String(contentOverride ?? entry.content).trim();
    this.pending.splice(idx, 1);
    let memory: MemoryEntry | undefined;
    // addMemory 传 persist=false：只改内存，由末尾统一一次 persistAll 落盘（pending 移除 + 新记忆）。
    if (action === "global") {
      memory = this.addMemory({ scope: "global", content, source: contentOverride ? "manual" : "ai" }, false);
    } else if (action === "assistant") {
      memory = this.addMemory({
        scope: "assistant",
        assistantId: entry.assistantId,
        content,
        source: contentOverride ? "manual" : "ai",
      }, false);
    }
    // discard：不写记忆，仅移除 pending。
    await this.persistAll();
    return { resolved: true, memory };
  },

  /** 批量处理 pending。逐条 resolve（事务粒度单条，不整体回滚）。返回每条结果。 */
  async resolvePendingBatch(items: Array<{ pendingId: string; action: "global" | "assistant" | "discard"; content?: string }>): Promise<Array<{ pendingId: string; resolved: boolean }>> {
    const results: Array<{ pendingId: string; resolved: boolean }> = [];
    for (const item of items) {
      const r = await this.resolvePending(item.pendingId, item.action, item.content);
      results.push({ pendingId: item.pendingId, resolved: r.resolved });
    }
    return results;
  },

  /** 推送给前端的完整快照。globalEnabled/writeStrategy 从 settings 读（冗余字段，前端少订阅一个源）。 */
  getSnapshot(): MemorySnapshot {
    return {
      globalEnabled: state.settings.memorySettings.globalEnabled,
      writeStrategy: state.settings.memorySettings.writeStrategy,
      globalMemories: this.globalMemories,
      assistantMemories: this.assistantGroups,
      pending: this.pending,
      pendingCount: this.pending.length,
    };
  },

  // ---------- 批量编辑（高级用户直接编辑 JSON，§9.3） ----------
  // 校验单条记忆结构，失败抛错（调用方 catch 返回 400，不落盘）。
  // id 唯一性校验（I4）：用户批量编辑时若手抖输入重复 id，会导致 findEntryById/updateMemory 只命中
  // 第一条、第二条成改不动的幽灵——校验阶段直接拒绝，提示哪条重复。
  validateMemoryEntries(entries: unknown): MemoryEntry[] {
    if (!Array.isArray(entries)) throw new Error("memories must be an array");
    const now = Date.now();
    const seenIds = new Set<number>();
    return entries.map((e, i) => {
      if (!isRecord(e)) throw new Error(`memory[${i}] must be an object`);
      const content = String(e.content ?? "").trim();
      if (!content) throw new Error(`memory[${i}].content is required`);
      const rawId = Number(e.id);
      const finalId = Number.isFinite(rawId) && rawId > 0 ? rawId : i + 1;
      if (seenIds.has(finalId)) throw new Error(`memory[${i}] has duplicate id ${finalId}`);
      seenIds.add(finalId);
      return {
        id: finalId,
        content,
        createdAt: Number(e.createdAt) || now,
        updatedAt: Number(e.updatedAt) || now,
        source: e.source === "ai" ? "ai" : "manual",
      };
    });
  },

  validateAssistantGroups(groups: unknown): AssistantMemoryGroup[] {
    if (!Array.isArray(groups)) throw new Error("assistants must be an array");
    // 跨组 id 也要唯一（id 是全局自增空间，组间重复同样会让 findEntryById 只命中第一条）。
    const globalSeenIds = new Set<number>();
    return groups.map((g, i) => {
      if (!isRecord(g)) throw new Error(`assistant[${i}] must be an object`);
      const assistantId = String(g.assistantId ?? "").trim();
      if (!assistantId) throw new Error(`assistant[${i}].assistantId is required`);
      const memories = this.validateMemoryEntries(g.memories);
      for (const m of memories) {
        if (globalSeenIds.has(m.id)) throw new Error(`assistant[${i}] has duplicate id ${m.id} across groups`);
        globalSeenIds.add(m.id);
      }
      return {
        assistantId,
        assistantName: String(g.assistantName ?? "未知助手"),
        memories,
      };
    });
  },

  /** 批量替换全局记忆。校验 + 备份 .bak + recompute（S1 兜底）。校验失败抛错（不落盘）。 */
  replaceGlobalMemories(entries: unknown): void {
    const validated = this.validateMemoryEntries(entries);
    this.writeJsonSync(globalMemoryPath + ".bak", { version: 1, nextMemoryId: this.nextMemoryId, memories: this.globalMemories });
    this.globalMemories = validated;
    this.recomputeNextId();
    void this.persistAll();
  },

  /** 批量替换助手记忆（整体）。校验 + 备份 + recompute + 刷新助手名快照。 */
  replaceAssistantGroups(groups: unknown): void {
    const validated = this.validateAssistantGroups(groups);
    this.writeJsonSync(assistantMemoryPath + ".bak", { version: 1, assistants: this.assistantGroups });
    this.assistantGroups = validated;
    this.refreshAssistantNames(state.settings.assistants);
    this.recomputeNextId();
    void this.persistAll();
  },
};

export function memoriesForAssistant(assistant: Assistant): MemoryEntry[] {
  // 叠加注入（1.3.2）：助手层（assistant.enableMemory）+ 全局层（memorySettings.globalEnabled）。
  // enableMemory 只控制助手层、globalEnabled 只控制全局层，两者独立叠加——助手关记忆时仍可见
  // 全局层（§6.5 联动矩阵），模型侧完全不感知层级存在（产品决策核心：叠加对模型透明）。
  // 替代旧的 useGlobalMemory 二选一——useGlobalMemory 字段废弃，运行时不再读（老值保留兼容）。
  const assistantMems = assistant.enableMemory ? memoryStore.getAssistantMemories(assistant.id) : [];
  const globalMems = state.settings.memorySettings.globalEnabled
    ? memoryStore.getGlobalMemories()
    : [];
  return [...globalMems, ...assistantMems].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function buildMemoryPrompt(assistant: Assistant) {
  const memories = memoriesForAssistant(assistant).map((memory) => ({ id: memory.id, content: memory.content }));
  if (memories.length === 0) return "";
  return `
**Memories**
These are memories you can reference in future conversations.
${JSON.stringify(memories, null, 2)}
`.trim();
}

export function buildRecentChatsPrompt(assistant: Assistant, currentConversationId?: string) {
  if (!assistant.enableRecentChatsReference) return "";
  // DB-first 批1:最近会话直查活库(update_at 倒序,并列时 create_at 倒序保持与旧稳定
  // sort 的等价顺序)。流式期间 updateAt 最多滞后 200ms,提示词场景不可感知。
  const recentDb = getConversationsDb();
  const recent = (recentDb ? recentConversationMetas(recentDb, assistant.id, currentConversationId, 10) : [])
    .map((conversation) => ({
      // 标题兜底经 peekFirstMessageParts(working set 命中读实例,否则只读活库单行,不驻留)
      title: conversation.title || textFromParts(peekFirstMessageParts(conversation.id)).slice(0, 40) || "New Conversation",
      last_chat: dateKey(conversation.updateAt),
    }));
  if (recent.length === 0) return "";
  return `
**Recent Chats**
These are some of the user's recent conversations. You can use them to understand user preferences:
${JSON.stringify(recent, null, 2)}
`.trim();
}
