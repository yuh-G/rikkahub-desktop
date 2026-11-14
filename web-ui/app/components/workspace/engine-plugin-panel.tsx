import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Check, Puzzle, Send, X } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";
import api, { ApiError } from "~/services/api";
import { useConversationEngineUi } from "~/stores/conversation-store";
import type { EngineUiResponseDto, EngineUiStateEventDto } from "~/types";

type DialogItem = EngineUiStateEventDto["dialogs"][number];

// 插件界面(P5.5 最小版,完整会话内呈现在 P6.3):输入框上方的对话框卡、状态条目、挂件与进行中提示。
// 数据源是会话 SSE 的 engine-ui 帧(整份覆盖,连接时补发);全部纯文本,不渲染插件给的任何标记。
export function EnginePluginPanel({ conversationId }: { conversationId: string | null }) {
  const ui = useConversationEngineUi(conversationId);
  if (!conversationId || !ui) return null;
  const dialog = ui.dialogs[0];
  const hasInfo = ui.statuses.length > 0 || ui.widgets.length > 0 || ui.working !== null;
  return (
    <div className="mx-auto mb-2 flex w-full max-w-3xl flex-col gap-2 px-4">
      {dialog ? <PluginDialogCard key={dialog.requestId} conversationId={conversationId} dialog={dialog} /> : null}
      {hasInfo ? <PluginInfo ui={ui} /> : null}
    </div>
  );
}

function PluginInfo({ ui }: { ui: EngineUiStateEventDto }) {
  return (
    <div className="space-y-1 text-muted-foreground text-xs">
      {ui.working !== null ? <div className="animate-pulse">{ui.working}</div> : null}
      {ui.widgets.map((widget) => (
        <pre key={`${widget.source}:${widget.key}`} className="whitespace-pre-wrap break-words font-sans">
          {widget.lines.join("\n")}
        </pre>
      ))}
      {ui.statuses.length > 0 ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {ui.statuses.map((status) => (
            <span key={`${status.source}:${status.key}`} className="inline-flex items-center gap-1">
              <Puzzle className="size-3 shrink-0" aria-hidden />
              {status.text}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PluginDialogCard({ conversationId, dialog }: { conversationId: string; dialog: DialogItem }) {
  const { t } = useTranslation("page");
  const [text, setText] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const { request } = dialog;

  const respond = async (answer: { cancelled: true } | { value: string | boolean }) => {
    if (sending) return;
    setSending(true);
    const body: EngineUiResponseDto = { requestId: dialog.requestId, ...answer };
    try {
      await api.post(`conversations/${conversationId}/ui-response`, body);
    } catch (err) {
      // 对话框已被收起(轮次结束 / 插件超时)时回 404,卡片随下一帧消失,不必提示。
      if (!(err instanceof ApiError && err.code === 404)) toast.error(t("conversations.plugin_dialog.send_failed"));
      setSending(false);
    }
  };

  const submitText = () => {
    const value = text.trim();
    if (value) void respond({ value });
  };

  return (
    <div
      className="rounded-2xl border border-primary/40 bg-primary/5 px-4 py-3 shadow-sm ring-1 ring-primary/10"
      role="region"
      aria-live="polite"
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Puzzle className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="whitespace-pre-wrap break-words text-sm font-semibold text-foreground">{request.title}</div>
          <p className="text-xs text-muted-foreground">
            {dialog.source
              ? t("conversations.plugin_dialog.from", { plugin: dialog.source })
              : t("conversations.plugin_dialog.from_unknown")}
          </p>
        </div>
      </div>

      <div className="mt-3 space-y-3">
        {request.kind === "confirm" && request.message ? (
          <p className="whitespace-pre-wrap break-words text-sm text-foreground">{request.message}</p>
        ) : null}
        {request.kind === "select" ? (
          <div className="flex flex-wrap gap-1.5" role="radiogroup">
            {request.options.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={false}
                disabled={sending}
                onClick={() => void respond({ value: option })}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
                  "border-primary/40 bg-background text-foreground hover:border-primary hover:bg-primary/10",
                )}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}
        {request.kind === "input" ? (
          <Input
            value={text}
            autoFocus
            disabled={sending}
            onChange={(e) => setText(e.target.value)}
            placeholder={request.placeholder ?? ""}
            className="text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitText();
              }
            }}
          />
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={sending} onClick={() => void respond({ cancelled: true })}>
            <X className="mr-1.5 h-3.5 w-3.5" />
            {t("conversations.plugin_dialog.cancel")}
          </Button>
          {request.kind === "confirm" ? (
            <>
              <Button size="sm" variant="outline" disabled={sending} onClick={() => void respond({ value: false })}>
                {t("conversations.plugin_dialog.no")}
              </Button>
              <Button size="sm" disabled={sending} onClick={() => void respond({ value: true })}>
                <Check className="mr-1.5 h-3.5 w-3.5" />
                {t("conversations.plugin_dialog.yes")}
              </Button>
            </>
          ) : null}
          {request.kind === "input" ? (
            <Button size="sm" disabled={sending || !text.trim()} onClick={submitText}>
              <Send className="mr-1.5 h-3.5 w-3.5" />
              {t("conversations.plugin_dialog.submit")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
