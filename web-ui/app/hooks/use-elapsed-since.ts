// hooks/use-elapsed-since.ts — 运行耗时共用计时(专题-交互审查 域3-1)。
//
// 计时口径的单一裁决点是 resolveElapsedSeconds:终点戳在场 → 定格;缺失时只有
// live(此刻真的还在跑/还在等用户)才允许以"现在"走表。持久化的"无终点戳"——进程
// 被杀、停止、打断遗留的孤儿消息——并不是"正在跑",一律 null(不显示、不起 tick);
// 此前"缺戳即走表"正是 issue #59「用时永增」在历史会话上的残余形态。规则只在此
// 写一次,工具卡/思维链/消息统计行全部经由这里,新显示点不再自带口径。
import * as React from "react";

import { serverNow } from "~/lib/utils";

/** 纯函数裁决:毫秒进、秒出。
 *  - finishMs 在场 → 定格差值;不足 1 秒按 1 秒定格(与思维链时长口径一致)。
 *  - finishMs 缺失 + live → 以 nowMs 走表;不足 1 秒返回 null(秒数静默登场,不闪 "0s")。
 *  - finishMs 缺失 + !live → null:时长未知且无人证明它还在跑,宁缺毋假。 */
export function resolveElapsedSeconds(startMs: number, finishMs: number | null, live: boolean, nowMs: number): number | null {
  const end = finishMs ?? (live ? nowMs : null);
  if (end == null) return null;
  const seconds = Math.max(0, Math.round((end - startMs) / 1000));
  if (seconds <= 0) return finishMs != null ? 1 : null;
  return seconds;
}

/** 受控定格版:运行中(无 finishedAt 且 live)每秒 tick;finishedAt 到达后定格、停表;
 *  终点缺失且非 live → null 且不起 tick。live 缺省 true——恒走表场景(生图占位卡等
 *  调用方传的就是真·活动状态)零改动;历史回放一律显式传 live。
 *  createdAt 缺失或解析失败 → null。 */
export function useElapsedSeconds(startIso: string | undefined, finishIso?: string | null, live = true): number | null {
  const finished = Boolean(finishIso);
  const [, forceTick] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!startIso || finished || !live) return;
    const timer = setInterval(forceTick, 1000);
    return () => clearInterval(timer);
  }, [startIso, finished, live]);
  if (!startIso) return null;
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return null;
  const finish = finishIso ? Date.parse(finishIso) : null;
  if (finish != null && Number.isNaN(finish)) return null;
  return resolveElapsedSeconds(start, finish, live, serverNow());
}

/** 工具卡自己的耗时(issue #59):建卡(metadata.toolStartedAt)→终局结果
 *  (metadata.toolFinishedAt)。无戳的历史数据(修复前落库的会话)回退消息级口径
 *  (messageCreatedAt→messageFinishedAt)。live = 这张卡此刻还活着——消息在生成中,
 *  或 pending 卡的审批等待仍在挂起(等用户期间秒数照走是 #59 的刻意语义)——由
 *  调用方把 loading / awaitingApproval 信号汇成 live 传入。
 *  bash 流式中间帧(partial)不落戳:输出还在长,秒数继续走表直到终局。 */
export function useToolElapsedSeconds(
  tool: { metadata?: Record<string, unknown> | null },
  messageCreatedAt?: string,
  messageFinishedAt?: string | null,
  live = true,
): number | null {
  const meta = tool.metadata;
  const startedAt = typeof meta?.toolStartedAt === "string" ? meta.toolStartedAt : undefined;
  const finishedAt = typeof meta?.toolFinishedAt === "string" ? meta.toolFinishedAt : null;
  if (startedAt) return useElapsedSeconds(startedAt, finishedAt, live);
  return useElapsedSeconds(messageCreatedAt, messageFinishedAt ?? null, live);
}
