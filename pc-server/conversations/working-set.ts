// conversations/working-set.ts — 会话单一权威实例注册表（DB-first 批2，方案见 项目重构方案.md）
//
// DB-first 最大风险是"同一会话出现两个内存实例 → 并发修改互相丢失"（旧架构共享单实例，
// 天然无此问题）。本模块保证：**只要有代码持有某会话实例，checkout(id) 必返回同一实例**。
//
// 驻留判据（sweep 四条件，缺一不可才清扫）：
//   refs === 0                    —— 无请求作用域在持有（长 await 期间 refs>0，永不清）
//   !isGenerating(id)             —— 不在流式生成中
//   !hasSseClients(id)            —— 无打开的会话 SSE 流（用户界面正开着）
//   !hasDirty(id)                 —— 无未落库的脏标记
// 外加 lastAccess 距今 > IDLE_GRACE_MS（快速重开场景免重复加载）。
//
// 依赖全部注入（configureWorkingSet）：加载器与三个判据。零模块依赖 → 无循环导入，单测可控。
import type { Conversation } from "../foundation/types";

interface WorkingSetEntry {
  conv: Conversation;
  refs: number;
  lastAccess: number;
}

export interface WorkingSetGuards {
  /** 从持久层加载完整会话（含消息树）。不存在返回 undefined。 */
  loadConversation: (conversationId: string) => Conversation | undefined;
  isGenerating: (conversationId: string) => boolean;
  hasSseClients: (conversationId: string) => boolean;
  hasDirty: (conversationId: string) => boolean;
  /** 有排队待发消息(消息发送队列非空)——生成派发链会跨"当前流结束→下条点火"的空窗持有会话,
   *  此窗口 refs/generating 都可能为 0,不挡则队列孤儿化、下一条永远点不燃。缺省 = 无队列。 */
  hasQueuedMessages?: (conversationId: string) => boolean;
}

const IDLE_GRACE_MS = 60_000;
export const WORKING_SET_SWEEP_INTERVAL_MS = 30_000;

const entries = new Map<string, WorkingSetEntry>();
let guards: WorkingSetGuards | null = null;

export function configureWorkingSet(next: WorkingSetGuards): void {
  guards = next;
}

/** 取出（或从持久层装入）会话实例并持有引用。必须与 releaseConversation 配对（try/finally）。 */
export function checkoutConversation(conversationId: string): Conversation | undefined {
  if (!guards) throw new Error("working set not configured");
  const existing = entries.get(conversationId);
  if (existing) {
    existing.refs += 1;
    existing.lastAccess = Date.now();
    return existing.conv;
  }
  const conv = guards.loadConversation(conversationId);
  if (!conv) return undefined;
  entries.set(conversationId, { conv, refs: 1, lastAccess: Date.now() });
  return conv;
}

/** 释放一次引用。checkout 未命中（返回 undefined）时不要调用。 */
export function releaseConversation(conversationId: string): void {
  const entry = entries.get(conversationId);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  entry.lastAccess = Date.now();
}

/** 新建/fork/导入的会话直接注册（内存即权威，防 checkout 从持久层读旧/空数据反向覆盖）。refs 从 0 起。 */
export function registerConversation(conv: Conversation): void {
  const existing = entries.get(conv.id);
  if (existing) {
    // 同 id 重复注册（导入覆盖既有会话）：替换实例内容而非替换引用——已持有旧实例的代码
    // 不应出现（导入前已中止所有流），防御性保留 refs。
    existing.conv = conv;
    existing.lastAccess = Date.now();
    return;
  }
  entries.set(conv.id, { conv, refs: 0, lastAccess: Date.now() });
}

/** 只查注册表，不加载不加引用（flushConvDirty 查脏会话用——脏标记只可能来自注册过的会话）。 */
export function peekConversation(conversationId: string): Conversation | undefined {
  return entries.get(conversationId)?.conv;
}

/** 删除会话/导入作废时移除条目。 */
export function removeConversations(ids: Iterable<string>): void {
  for (const idValue of ids) entries.delete(idValue);
}

/** 导入 finalize：全部作废（陈旧实例读到旧数据比空更危险）。 */
export function clearWorkingSet(): void {
  entries.clear();
}

/** 遍历当前驻留实例（关停 flush 等场景）。 */
export function workingSetIds(): string[] {
  return Array.from(entries.keys());
}

export function workingSetSize(): number {
  return entries.size;
}

/** 清扫一轮，返回清出的会话数。四条件 + 闲置期，见文件头。 */
export function sweepWorkingSet(now = Date.now()): number {
  if (!guards) return 0;
  let removed = 0;
  for (const [conversationId, entry] of entries) {
    if (entry.refs > 0) continue;
    if (guards.isGenerating(conversationId)) continue;
    if (guards.hasSseClients(conversationId)) continue;
    if (guards.hasDirty(conversationId)) continue;
    if (guards.hasQueuedMessages?.(conversationId)) continue;
    if (now - entry.lastAccess <= IDLE_GRACE_MS) continue;
    entries.delete(conversationId);
    removed += 1;
  }
  return removed;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startWorkingSetSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => sweepWorkingSet(), WORKING_SET_SWEEP_INTERVAL_MS);
  // Bun/Node: unref 让定时器不阻止进程退出
  if (typeof sweepTimer === "object" && "unref" in sweepTimer) sweepTimer.unref();
}

export function stopWorkingSetSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
