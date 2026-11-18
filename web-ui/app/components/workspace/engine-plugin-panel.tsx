import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Check, Loader2, Puzzle, Send } from "lucide-react";

import { PluginSourceLink, usePluginFromLabel } from "~/components/message/parts/plugin-attribution";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { formatBinding, IS_MAC_PLATFORM } from "~/lib/hotkeys";
import { cn } from "~/lib/utils";
import api, { ApiError } from "~/services/api";
import { useConversationEngineUi } from "~/stores/conversation-store";
import type { EngineUiResponseDto, EngineUiStateEventDto } from "~/types";

type DialogItem = EngineUiStateEventDto["dialogs"][number];
type Answer = { cancelled: true } | { value: string | boolean };

const ENTER_IN = "animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none";
const SAVE_SHORTCUT = formatBinding([IS_MAC_PLATFORM ? "Meta" : "Ctrl", "Enter"]);

// 插件界面(P5.5 起,P6.3 完整呈现):输入框上方的对话框卡、挂件、状态条目与进行中提示。
// 数据源是会话 SSE 的 engine-ui 帧(整份覆盖,连接时补发);全部纯文本,不渲染插件给的任何标记。
export function EnginePluginPanel({ conversationId }: { conversationId: string | null }) {
  const ui = useConversationEngineUi(conversationId);
  if (!conversationId || !ui) return null;
  const [dialog, ...queued] = ui.dialogs;
  const hasInfo = ui.statuses.length > 0 || ui.widgets.length > 0 || ui.working !== null;
  return (
    <div className="mx-auto mb-2 flex w-full max-w-3xl flex-col gap-2 px-4">
      {hasInfo ? <PluginInfo ui={ui} /> : null}
      {dialog ? (
        <PluginDialogCard key={dialog.requestId} conversationId={conversationId} dialog={dialog} queued={queued.length} />
      ) : null}
    </div>
  );
}

function PluginInfo({ ui }: { ui: EngineUiStateEventDto }) {
  const hasRow = ui.working !== null || ui.statuses.length > 0;
  return (
    <div className="flex flex-col gap-1.5">
      {ui.widgets.map((widget) => (
        <PluginWidget key={`${widget.source}:${widget.key}`} source={widget.source} lines={widget.lines} />
      ))}
      {hasRow ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
          {ui.working !== null ? (
            <span className={cn("inline-flex min-w-0 items-center gap-2", ENTER_IN)}>
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />
              <span className="truncate">{ui.working}</span>
            </span>
          ) : null}
          {ui.statuses.map((status) => (
            <PluginStatus key={`${status.source}:${status.key}`} source={status.source} text={status.text} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 挂件:插件给的几行纯文本(常是终端排版的清单 / 进度),等宽保住对齐。 */
function PluginWidget({ source, lines }: { source: string; lines: string[] }) {
  const label = usePluginFromLabel(source);
  return (
    <div className={cn("rounded-xl border border-border/60 bg-muted/30 px-3 py-2", ENTER_IN)}>
      <div className="mb-1 flex items-center gap-1 text-mini text-muted-foreground">
        <Puzzle className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground/80">
        {lines.join("\n")}
      </pre>
    </div>
  );
}

function PluginStatus({ source, text }: { source: string; text: string }) {
  const label = usePluginFromLabel(source);
  return (
    <span
      className={cn("inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-mini", ENTER_IN)}
      title={label}
    >
      <Puzzle className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{text}</span>
    </span>
  );
}

function PluginDialogCard({ conversationId, dialog, queued }: { conversationId: string; dialog: DialogItem; queued: number }) {
  const { t } = useTranslation("page");
  const { request } = dialog;
  const [text, setText] = React.useState(request.kind === "editor" ? (request.prefill ?? "") : "");
  const [sending, setSending] = React.useState<string | null>(null);

  // 答案送达后卡片留到下一帧把它收走,期间保持「发送中」,防重复回答。
  const respond = async (answer: Answer, mark: string) => {
    if (sending) return;
    setSending(mark);
    const body: EngineUiResponseDto = { requestId: dialog.requestId, ...answer };
    try {
      await api.post(`conversations/${conversationId}/ui-response`, body);
    } catch (err) {
      // 对话框已被收起(轮次结束 / 插件超时)时回 404,卡片随下一帧消失,不必提示。
      if (!(err instanceof ApiError && err.code === 404)) toast.error(t("conversations.plugin_dialog.send_failed"));
      setSending(null);
    }
  };
  const cancel = () => void respond({ cancelled: true }, "cancel");
  const submitText = () => {
    if (request.kind === "editor") void respond({ value: text }, "submit");
    else if (text.trim()) void respond({ value: text.trim() }, "submit");
  };
  const busy = sending !== null;
  const spinner = (mark: string, icon: React.ReactNode) =>
    sending === mark ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : icon;

  return (
    <div
      className={cn("rounded-2xl border border-primary/40 bg-primary/5 px-4 py-3 shadow-sm ring-1 ring-primary/10", ENTER_IN)}
      role="region"
      aria-live="polite"
      aria-label={request.title}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          cancel();
        }
      }}
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Puzzle className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-start gap-2">
            <span className="min-w-0 whitespace-pre-wrap break-words text-sm font-semibold text-foreground">{request.title}</span>
            <span className="mt-2 size-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />
            {queued > 0 ? (
              <span className="mt-0.5 ml-auto shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-mini tabular-nums text-primary">
                {t("conversations.plugin_dialog.queued", { count: queued })}
              </span>
            ) : null}
          </div>
          <PluginSourceLink pluginId={dialog.source} />
        </div>
      </div>

      <div className="mt-3 space-y-3">
        {request.kind === "confirm" && request.message ? (
          <p className="whitespace-pre-wrap break-words text-sm text-foreground">{request.message}</p>
        ) : null}
        {request.kind === "select" ? (
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={request.title}>
            {request.options.map((option, index) => {
              const active = sending === `option:${index}`;
              return (
                <button
                  key={`${index}:${option}`}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={busy}
                  onClick={() => void respond({ value: option }, `option:${index}`)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors disabled:cursor-default",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-primary/40 bg-background text-foreground hover:border-primary hover:bg-primary/10 disabled:opacity-60 disabled:hover:border-primary/40 disabled:hover:bg-background",
                  )}
                >
                  {active ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
                  {option}
                </button>
              );
            })}
          </div>
        ) : null}
        {request.kind === "input" ? (
          <Input
            value={text}
            autoFocus
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            placeholder={request.placeholder ?? ""}
            className="text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submitText();
              }
            }}
          />
        ) : null}
        {request.kind === "editor" ? (
          <Textarea
            value={text}
            autoFocus
            disabled={busy}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            className="max-h-72 min-h-28 resize-y overflow-auto font-mono text-xs leading-5 md:text-xs"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submitText();
              }
            }}
          />
        ) : null}
        <div className="flex items-center justify-end gap-2">
          {request.kind === "editor" ? (
            <span className="mr-auto text-mini text-muted-foreground">
              {t("conversations.plugin_dialog.save_hint", { shortcut: SAVE_SHORTCUT })}
            </span>
          ) : null}
          {request.kind === "confirm" ? (
            <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void respond({ value: false }, "no")}>
                {spinner("no", null)}
                {t("conversations.plugin_dialog.no")}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void respond({ value: true }, "yes")}>
                {spinner("yes", <Check className="mr-1.5 h-3.5 w-3.5" />)}
                {t("conversations.plugin_dialog.yes")}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" disabled={busy} onClick={cancel}>
              {spinner("cancel", null)}
              {t("conversations.plugin_dialog.cancel")}
            </Button>
          )}
          {request.kind === "input" || request.kind === "editor" ? (
            <Button size="sm" disabled={busy || (request.kind === "input" && !text.trim())} onClick={submitText}>
              {spinner("submit", request.kind === "editor" ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Send className="mr-1.5 h-3.5 w-3.5" />)}
              {t(request.kind === "editor" ? "conversations.plugin_dialog.save" : "conversations.plugin_dialog.submit")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
