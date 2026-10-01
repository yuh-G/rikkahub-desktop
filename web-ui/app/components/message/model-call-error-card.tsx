import * as React from "react";
import { ChevronDown, Copy, Settings2, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SettingsLink } from "~/components/settings/settings-link";
import { copyTextToClipboard } from "~/lib/clipboard";
import { cn } from "~/lib/utils";
import type { UIMessageAnnotation } from "~/types";

// 域1-3/13-3(对齐 Android ErrorCard):模型调用失败的呈现唯一入口。错误详情只来自
// model_call_error 注解的 message 字段(正文零污染),卡片持久挂在失败消息下方——
// 桌面端不照抄 APP 的 5 秒浮动卡,但信息要素等价:标题 + 完整错误 + 复制 + 设置跳转。

/** 错误详情超过该长度时折叠为预览,点击展开全文。 */
const ERROR_PREVIEW_LENGTH = 200;

export function ModelCallErrorCard({
  annotations,
  settingsSearch,
}: {
  annotations: UIMessageAnnotation[] | undefined;
  /** 设置深链查询串(定位到出错模型所属的供应商)。 */
  settingsSearch: string;
}) {
  const { t } = useTranslation("message");
  const errorMessage =
    (annotations ?? []).find((annotation) => annotation.type === "model_call_error")?.message ??
    null;
  const [expanded, setExpanded] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const copyTimerRef = React.useRef<number | null>(null);

  React.useEffect(
    () => () => {
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  if (!errorMessage) return null;

  const collapsible = errorMessage.length > ERROR_PREVIEW_LENGTH;
  const shownMessage =
    expanded || !collapsible ? errorMessage : `${errorMessage.slice(0, ERROR_PREVIEW_LENGTH)}…`;

  const handleCopy = async () => {
    try {
      await copyTextToClipboard(errorMessage);
      setCopied(true);
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // 剪贴板不可用(权限拒绝等)时保持卡片其余交互可用
    }
  };

  return (
    <div className="mx-1 max-w-2xl rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-destructive">
      <div className="flex items-center gap-2">
        <TriangleAlert className="size-4 shrink-0" />
        <span className="text-sm font-medium">{t("chat_message.generation_failed")}</span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-5 text-destructive/90">
        {shownMessage}
      </p>
      {collapsible ? (
        <button
          className="mt-1 inline-flex items-center gap-1 text-xs text-destructive/80 underline-offset-2 transition hover:text-destructive hover:underline"
          type="button"
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDown className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
          {expanded ? t("chat_message.collapse_error") : t("chat_message.expand_error")}
        </button>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          className="inline-flex items-center gap-1 rounded-md border border-destructive/30 bg-card/60 px-2 py-1 text-xs transition hover:bg-accent"
          type="button"
          onClick={() => void handleCopy()}
        >
          <Copy className="size-3" />
          {copied ? t("chat_message.copied") : t("chat_message.copy_error")}
        </button>
        <SettingsLink
          className="inline-flex items-center gap-1 rounded-md border border-destructive/30 bg-card/60 px-2 py-1 text-xs transition hover:bg-accent"
          search={settingsSearch}
        >
          <Settings2 className="size-3" />
          {t("chat_message.open_model_settings")}
        </SettingsLink>
      </div>
    </div>
  );
}
