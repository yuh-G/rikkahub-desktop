import * as React from "react";
import { Bell, ChevronDown, RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import type { NoticePart as UINoticePart } from "~/types";

import { ChainOfThoughtStep } from "../chain-of-thought";

// 运行时通知(APP 端工作区的后台命令退出时产生,随备份导进来)。title 是给人看的一句话,text 是发给模型的原文,
// 展开时照原样等宽显示。

/** 助手消息里的一步(与工具调用同在思维链里)。 */
export function NoticeStepPart({
  notice,
  isFirst,
  isLast,
}: {
  notice: UINoticePart;
  isFirst?: boolean;
  isLast?: boolean;
}) {
  return (
    <div data-part="notice">
      <ChainOfThoughtStep
        isFirst={isFirst}
        isLast={isLast}
        icon={<Bell className="h-3.5 w-3.5 text-muted-foreground" />}
        label={<span className="line-clamp-2 text-xs text-muted-foreground">{notice.title}</span>}
      >
        <NoticeText text={notice.text} />
      </ChainOfThoughtStep>
    </div>
  );
}

/** 只有 notice 的用户消息:不画成气泡,不能编辑。一张可展开的卡,每条一行;展开看原文,可重试(最后一条且不在生成时)或删除。 */
export function NoticeCard({
  notices,
  onRetry,
  onDelete,
}: {
  notices: UINoticePart[];
  onRetry?: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation("message");
  const [expanded, setExpanded] = React.useState(false);
  return (
    <div data-part="notice-card" className="w-full rounded-2xl border border-border/40 bg-muted/40 px-3 py-2">
      <button
        type="button"
        className="flex w-full items-start gap-2 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          {notices.map((notice, index) => (
            <span key={index} className="flex items-center gap-2 text-xs text-muted-foreground">
              <Bell className="size-3.5 shrink-0" />
              <span className="line-clamp-2">{notice.title}</span>
            </span>
          ))}
        </span>
        <ChevronDown
          className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-200", expanded && "-rotate-180")}
        />
      </button>
      {expanded ? (
        <div className="mt-2 flex flex-col gap-2">
          {notices.map((notice, index) => (
            <NoticeText key={index} text={notice.text} />
          ))}
          {onRetry || onDelete ? (
            <div className="flex justify-end gap-1">
              {onRetry ? (
                <Button type="button" variant="ghost" size="compact" onClick={onRetry}>
                  <RefreshCw className="size-3.5" />
                  {t("notice.retry")}
                </Button>
              ) : null}
              {onDelete ? (
                <Button type="button" variant="ghost" size="compact" onClick={onDelete}>
                  <Trash2 className="size-3.5" />
                  {t("chat_message.delete")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function NoticeText({ text }: { text: string }) {
  return <pre className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{text}</pre>;
}
