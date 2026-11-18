import * as React from "react";
import { useTranslation } from "react-i18next";
import { FoldVertical, Loader2, Puzzle, ShieldAlert } from "lucide-react";

import { usePluginName } from "~/components/message/parts/plugin-attribution";
import { useConversationEngineStatus } from "~/stores/conversation-store";
import { useCompressStore, useConversationCompressing } from "~/stores/compress-store";

/** 每秒重渲染的已过秒数(startedAt 无值时返回 null,不显示耗时)。 */
function useElapsedSeconds(startedAt: number | undefined): number | null {
  const [, forceTick] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (startedAt === undefined) return;
    const timer = setInterval(forceTick, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (startedAt === undefined) return null;
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

// 会话瞬态状态条:压缩中/自动重试中。数据源是会话 SSE 的 engine-status 帧——
// 工作区会话由 pi 事件桥推送(P5),对话/工作区手动压缩由 compress 端点统一推送并在
// SSE 连接期补发快照(切页回来状态恢复)。无状态时不渲染,窄选择器订阅:只有本会话
// 状态跳变才重渲染,流式增量不经过这里。
export function EngineStatusBar({ conversationId }: { conversationId: string | null }) {
  const { t } = useTranslation("page");
  const status = useConversationEngineStatus(conversationId);
  // 耗时计时的生效相:压缩(长任务)+ 域4-1 审批等待(用户离席回来要看等了多久)。
  // 重试相是短暂交替态,计时无意义。hook 须在条件返回之前调用。
  const elapsed = useElapsedSeconds(
    status?.phase === "compacting" || status?.phase === "awaiting_approval"
      ? status.startedAt
      : undefined,
  );
  // 可中止 = 压缩相 && 本端持有取消句柄(手动 /compact 或压缩框发起,compress-store 有
  // AbortController)。pi 自动压缩(threshold/overflow)发生在生成流内、无本端句柄,
  // 天然不显示中止钮也不响应 Esc——自动维护动作不该被误按打断。
  const cancellable = useConversationCompressing(conversationId);
  // 等的是插件的对话框(P6.3):写「插件 X 在等你回答」,不说「审批」。
  const dialog = status?.phase === "awaiting_approval" ? status.dialog : undefined;
  const dialogPlugin = usePluginName(dialog?.source ?? "");
  const canInterrupt = status?.phase === "compacting" && cancellable;

  // Esc 中止(Codex 语义:Esc to interrupt):bubble 阶段监听 + defaultPrevented 检查,
  // 对话框/斜杠菜单等已消费的 Esc(radix dismissable layer 会 preventDefault)不抢。
  // 服务端保证取消不污染:signal 中止 → 压缩作废,原上下文原样保留(R7-4 硬保证)。
  React.useEffect(() => {
    if (!canInterrupt || !conversationId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      useCompressStore.getState().cancel(conversationId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canInterrupt, conversationId]);

  if (!status) return null;

  const text =
    status.phase === "retrying"
      ? t("conversations.engine_status.retrying", {
          attempt: status.attempt ?? 1,
          max: status.maxAttempts ?? 1,
        })
      : status.phase === "awaiting_approval"
        ? dialog
          ? dialogPlugin
            ? t("conversations.awaiting_approval.plugin_status", { plugin: dialogPlugin })
            : t("conversations.awaiting_approval.plugin_status_unknown")
          : t("conversations.awaiting_approval.status")
        : status.reason === "threshold" || status.reason === "overflow"
          ? t("conversations.engine_status.compacting_auto")
          : status.progress
            ? t("conversations.engine_status.compacting_progress", {
                current: status.progress.current,
                total: status.progress.total,
              })
            : t("conversations.engine_status.compacting");

  // "已处理 xx秒"(Codex 截图):秒级实时递增,起点服务端权威(切页/重连计时连续)。
  // 审批相措辞换"已等待"(用户离席回来读的是等待时长,不是处理时长)。
  const ns = status.phase === "awaiting_approval" ? "awaiting_approval" : "engine_status";
  const elapsedText =
    elapsed === null
      ? null
      : elapsed >= 60
        ? t(`conversations.${ns}.elapsed_minutes`, {
            minutes: Math.floor(elapsed / 60),
            seconds: elapsed % 60,
          })
        : t(`conversations.${ns}.elapsed_seconds`, { seconds: elapsed });

  // Codex 式行内状态(内测拍板):左对齐、无边框背景、小图标+灰字,与消息列同宽对齐;
  // 压缩相用折叠图标+文字呼吸(pulse),重试相保留 spinner(旋转更贴"重试中"语义)。
  return (
    <div className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-2 px-4 text-muted-foreground text-xs">
      {status.phase === "retrying" ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
      ) : status.phase === "awaiting_approval" ? (
        dialog ? (
          <Puzzle className="size-3.5 shrink-0 text-primary" />
        ) : (
          <ShieldAlert className="size-3.5 shrink-0 text-warning" />
        )
      ) : (
        <FoldVertical className="size-3.5 shrink-0" />
      )}
      <span className="animate-pulse">{text}</span>
      {elapsedText ? <span className="shrink-0">· {elapsedText}</span> : null}
      {canInterrupt && conversationId ? (
        <button
          type="button"
          onClick={() => useCompressStore.getState().cancel(conversationId)}
          className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
        >
          {t("conversations.engine_status.interrupt")}
        </button>
      ) : null}
    </div>
  );
}
