// conversations/fork-repair.ts — 修复历史 fork 缺陷造成的节点行"主键抢夺"。
//
// 缺陷(已在 handlers/conversations.ts 的 fork 路由修复):fork 深拷贝节点时沿用了源节点 id,
// 而 pc_message_node.id 是全局主键,persistConversation(fork) 的 ON CONFLICT(id) DO UPDATE
// 会把源会话的节点行改挂到分支名下。源会话从 DB 重载后前缀(或全部)节点消失,表现为
// "回到源会话显示暂无消息";若用户随后删除分支,这些节点行被级联销毁,数据永久丢失。
//
// 修复原理:被抢的行内容与分支应有的内容本就相同(fork 即前缀拷贝),因此把配对会话的
// 前缀节点以**新 id**复制回受害会话,即可逐字节还原被抢前的状态,分支自身保持不变。
//
// 受害特征(仅本缺陷可产生,正常删除消息会在 persist 时重排 node_index 从 0 连续):
//   - 会话行存在但节点数为 0(fork 自最后一条消息,前缀=全部),或
//   - MIN(node_index) > 0(fork 自中间消息,前缀被抢走、尾部残留)。
// 配对规则(历史缺陷期的 fork 路由固定生成 "<源标题> Fork"/"Fork" 标题;现行路由已改
// "(N) 序号"命名,但受害会话只能由旧缺陷产生,配对始终认旧形态):
//   - 正向:受害者是源会话,供体标题 === 受害标题 + " Fork",且供体 create_at(即 fork
//     时刻) >= 受害 update_at——排除"fork 后用户又删光消息"这类合法空会话被误修复。
//   - 反向:受害者是分支(源会话事后再持久化会把行抢回去),供体标题 + " Fork" === 受害
//     标题,供体节点数足以覆盖缺口。受害者为空时缺口长度不可知,跳过。
// 无法配对(标题被改/分支已删除)时仅记录日志,绝不猜。修复只插入缺失前缀行,从不改动
// 受害会话既有行,幂等(修复后不再命中受害特征)。
import type { Database } from "bun:sqlite";
import type { MessageNode } from "../foundation/types";
import { id } from "../foundation/utils";
import { reportError } from "../observability/app-errors";
import { replaceNodeFts } from "./fts";

interface ConvMeta {
  id: string;
  title: string;
  createAt: number;
  updateAt: number;
  nodeCount: number;
  minIndex: number | null;
}

interface RepairOutcome {
  repaired: number;
  skipped: number;
}

interface PassOutcome extends RepairOutcome {
  /** 本轮跳过原因。链式 fork 下中间轮的"找不到配对"可能下一轮就修好,
   *  所以只有终轮(repaired=0)的跳过才是真正无法修复的,由外层统一输出。 */
  skipLogs: string[];
}

function forkTitleOf(title: string): string {
  return title ? `${title} Fork` : "Fork";
}

/** 把 donor 的 node_index ∈ [0, prefixLength) 节点行以新 id 复制进 victim(含 FTS)。 */
function copyPrefixNodes(db: Database, donorId: string, victimId: string, prefixLength: number): number {
  const rows = db
    .prepare(
      "SELECT node_index, messages, select_index FROM pc_message_node WHERE conversation_id = ? AND node_index < ? ORDER BY node_index",
    )
    .all(donorId, prefixLength) as Array<{ node_index: number; messages: string; select_index: number }>;
  if (rows.length !== prefixLength) return 0;
  const insert = db.prepare(
    "INSERT INTO pc_message_node (id, conversation_id, node_index, messages, select_index) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    const nodeId = id();
    insert.run(nodeId, victimId, row.node_index, row.messages, row.select_index);
    let messages: MessageNode["messages"] = [];
    try {
      messages = JSON.parse(row.messages) as MessageNode["messages"];
    } catch {
      // 行内容损坏时仅跳过 FTS,节点行本身照常还原
    }
    replaceNodeFts(db, victimId, { id: nodeId, messages, selectIndex: row.select_index });
  }
  return rows.length;
}

/** 单轮扫描修复。链式 fork(分支再分支)的中间层既是受害者又是供体,一轮内供体可能
 *  还是空的,需要外层 repairForkNodeTheft 迭代到定点。 */
function repairForkNodeTheftOnce(db: Database): PassOutcome {
  const metas = db
    .prepare(
      `SELECT c.id, c.title, c.create_at, c.update_at,
              COUNT(n.id) AS node_count, MIN(n.node_index) AS min_index
         FROM pc_conversation c LEFT JOIN pc_message_node n ON n.conversation_id = c.id
        GROUP BY c.id`,
    )
    .all() as Array<{ id: string; title: string; create_at: number; update_at: number; node_count: number; min_index: number | null }>;
  const all: ConvMeta[] = metas.map((m) => ({
    id: m.id,
    title: m.title ?? "",
    createAt: m.create_at,
    updateAt: m.update_at,
    nodeCount: m.node_count,
    minIndex: m.min_index,
  }));
  const victims = all.filter((c) => c.nodeCount === 0 || (c.minIndex ?? 0) > 0);
  if (victims.length === 0) return { repaired: 0, skipped: 0, skipLogs: [] };

  let repaired = 0;
  let skipped = 0;
  const skipLogs: string[] = [];
  for (const victim of victims) {
    // 正向:供体 = 受害会话的分支(持有被抢前缀 0..gap-1)。空受害者缺口=供体全部节点。
    const gap = victim.nodeCount === 0 ? null : (victim.minIndex ?? 0);
    const forward = all.filter(
      (d) =>
        d.id !== victim.id &&
        d.title === forkTitleOf(victim.title) &&
        d.minIndex === 0 &&
        d.createAt >= victim.updateAt &&
        (gap === null || d.nodeCount === gap),
    );
    // 反向:受害者是分支、源会话把行抢了回去。空分支缺口长度不可知,不修。
    const backward =
      gap === null
        ? []
        : all.filter(
            (d) =>
              d.id !== victim.id &&
              forkTitleOf(d.title) === victim.title &&
              d.minIndex === 0 &&
              d.nodeCount >= gap,
          );
    const pool = forward.length > 0 ? forward : backward;
    if (pool.length === 0) {
      skipped += 1;
      skipLogs.push(`[fork-repair] 会话 ${victim.id} 缺失前缀(gap=${gap ?? "全部"})但找不到可配对的分支/源会话,跳过`);
      continue;
    }
    // 多候选时内容等价(同一源的前缀拷贝),取最新创建者(空受害者的抢夺者必是最后一次 fork)。
    const donor = pool.reduce((a, b) => (b.createAt > a.createAt ? b : a));
    const prefixLength = gap ?? donor.nodeCount;
    const copied = db.transaction(() => copyPrefixNodes(db, donor.id, victim.id, prefixLength))();
    if (copied === prefixLength && copied > 0) {
      repaired += 1;
      console.log(`[fork-repair] 会话 ${victim.id} 已从 ${donor.id} 还原前缀 ${copied} 个节点`);
    } else {
      skipped += 1;
      skipLogs.push(`[fork-repair] 会话 ${victim.id} 供体 ${donor.id} 前缀不完整(期望 ${prefixLength},实得 ${copied}),跳过`);
    }
  }
  return { repaired, skipped, skipLogs };
}

export function repairForkNodeTheft(db: Database): RepairOutcome {
  let repaired = 0;
  // 迭代到定点:每轮至少修复 1 个才继续,轮数上限即受害者上限,天然有界。
  for (let pass = 0; pass < 32; pass += 1) {
    const outcome = repairForkNodeTheftOnce(db);
    repaired += outcome.repaired;
    if (outcome.repaired === 0) {
      // 终轮:此时的跳过才是真正无法修复的
      for (const line of outcome.skipLogs) console.warn(line);
      return { repaired, skipped: outcome.skipped };
    }
  }
  // 32 轮跑满仍在修复 = 链式 fork 深度超过上限,定点未收敛。此前静默 return {...,skipped:0}
  // 吞掉超限,受损会话永远缺前缀且无任何信号。上报 warn 让运维知情(不中断启动)。
  reportError(
    "persistence",
    "warn",
    `fork 节点修复迭代超过 32 轮仍未收敛(已修复 ${repaired} 个),可能存在超深链式 fork 残留`,
    undefined,
    "fork_repair_pass_limit",
    { repaired, passLimit: 32 },
  );
  return { repaired, skipped: 0 };
}
