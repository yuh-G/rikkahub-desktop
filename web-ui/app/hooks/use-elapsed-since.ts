// hooks/use-elapsed-since.ts — 运行耗时共用计时(专题-交互审查 域3-1)。
//
// 单一来源:reasoning-step-part 的"思考了 xx 秒"此前自带 formatDuration + tick 逻辑,
// 工具卡耗时(域3-1)与图像生成耗时(域10-2)需要同款能力。把"从起点时刻算秒数 +
// 运行期每秒 tick"提炼到这里,三处共用——计时口径永远一致,不复制粘贴。
//
// 三种用法:
// - useElapsedSecondsSince(startIso) —— 自然走表:isostring 起点,运行中每秒 tick,
//   起算不足 1 秒返回 null(与思维链"秒数静默登场"同习惯)。
// - useElapsedSeconds(startIso, finishIso) —— 受控定格:finishedAt 到达后停 tick
//   并定格终值(工具卡终局语义);缺 createdAt/finishedAt 未到等非法输入一律 null。
// - useToolElapsedSeconds(tool) —— issue #59:工具卡自己的计时(建卡→结果落地),
//   戳存 part.metadata(toolStartedAt/toolFinishedAt,无戳的历史数据回退消息级口径)。
import * as React from "react";

import { serverNow } from "~/lib/utils";

/** 每秒重渲染的已过秒数(startIso 无值时返回 null,不显示耗时)。
 *  不足 1 秒返回 null——与思维链时长同习惯:秒数静默登场,不闪 "0s"。 */
export function useElapsedSecondsSince(startIso?: string): number | null {
  const [, forceTick] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (startIso === undefined) return;
    const timer = setInterval(forceTick, 1000);
    return () => clearInterval(timer);
  }, [startIso]);
  if (!startIso) return null;
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return null;
  const seconds = Math.max(0, Math.round((serverNow() - start) / 1000));
  return seconds < 1 ? null : seconds;
}

/** 受控定格版:运行中(无 finishedAt)每秒 tick;finishedAt 到达后定格、停表。
 *  createdAt 缺失或解析失败 → null;终值不足 1 秒按 1 秒定格(与思维链时长口径一致)。 */
export function useElapsedSeconds(startIso: string | undefined, finishIso?: string | null): number | null {
  const finished = Boolean(finishIso);
  const [, forceTick] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!startIso || finished) return;
    const timer = setInterval(forceTick, 1000);
    return () => clearInterval(timer);
  }, [startIso, finished]);
  if (!startIso) return null;
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return null;
  const end = finishIso ? Date.parse(finishIso) : serverNow();
  if (Number.isNaN(end)) return null;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds <= 0) return finished ? 1 : null; // 定格不足 1 秒进位显示 1 秒;运行中不足 1 秒不显示
  return seconds;
}

/** 工具卡自己的耗时(issue #59):建卡(metadata.toolStartedAt)→终局结果
 *  (metadata.toolFinishedAt)。无戳的历史数据(修复前落库的会话)回退消息级口径
 *  (messageCreatedAt→messageFinishedAt),行为与旧版一致——只是旧数据语义本就
 *  是消息级墙钟,新数据才是"这步工具自己跑了多久"。
 *  bash 流式中间帧(partial)不落戳:输出还在长,秒数继续走表直到终局。 */
export function useToolElapsedSeconds(
  tool: { metadata?: Record<string, unknown> | null },
  messageCreatedAt?: string,
  messageFinishedAt?: string | null,
): number | null {
  const meta = tool.metadata;
  const startedAt = typeof meta?.toolStartedAt === "string" ? meta.toolStartedAt : undefined;
  const finishedAt = typeof meta?.toolFinishedAt === "string" ? meta.toolFinishedAt : null;
  if (startedAt) return useElapsedSeconds(startedAt, finishedAt);
  return useElapsedSeconds(messageCreatedAt, messageFinishedAt ?? null);
}
