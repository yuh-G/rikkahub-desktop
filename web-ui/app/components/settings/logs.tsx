// components/settings/logs.tsx — 请求日志分区（纯搬迁自 routes/settings.tsx）

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff, FileClock, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { JsonTree, tryParseJson } from "~/components/ui/json-tree";
import { cn } from "~/lib/utils";
import { copyTextToClipboard } from "~/lib/clipboard";
import { SectionHeader } from "~/components/settings/shared";
import { appErrorText, useAppErrorsStore } from "~/stores";
import { confirmDialog } from "~/stores/confirm-store";
import type { AppErrorDto } from "~/types";

// FE-P1-2 收编:线上契约单源在后端 foundation/types(此前本地手抄漏了 providerId)。
export type { RequestLog } from "@server/foundation/types";
import type { RequestLog } from "@server/foundation/types";

type LogFilter = "all" | "requests" | "errors";

// 2026-07-30 用户拍板:请求日志与应用错误完全并列,合入同一条时间线(按时间倒序),
// 顶部筛选片 全部/请求/错误 决定纳入哪类,默认全部;清空按钮作用于当前筛选可见的类别。
export function LogsSection({ logs, onClear }: { logs: RequestLog[]; onClear: () => void }) {
  const { t } = useTranslation();
  const [active, setActive] = React.useState<RequestLog | null>(null);
  const [activeError, setActiveError] = React.useState<AppErrorDto | null>(null);
  const [filter, setFilter] = React.useState<LogFilter>("all");
  const errors = useAppErrorsStore((s) => s.errors);
  const clearErrors = useAppErrorsStore((s) => s.clearErrors);
  const feed = React.useMemo(() => {
    const items: Array<{ at: number; log?: RequestLog; error?: AppErrorDto }> = [];
    if (filter !== "errors") for (const log of logs) items.push({ at: Number(log.at) || 0, log });
    if (filter !== "requests") for (const error of errors) items.push({ at: error.at, error });
    items.sort((a, b) => b.at - a.at);
    return items;
  }, [logs, errors, filter]);
  // 日志问题 3:确认必须先于任何删除。此前请求日志的 confirm 藏在 onClear 内部,而
  // clearErrors 在弹窗弹出前就已执行——用户点"取消"错误日志也没了,二次确认形同虚设。
  // 收口:本层统一确认一次,通过后才按当前筛选分发两类清空;onClear 退化为纯删除动作。
  const clearVisible = React.useCallback(async () => {
    if (!(await confirmDialog({ title: t("settings:logs.clear_confirm"), danger: true }))) return;
    if (filter !== "errors") onClear();
    if (filter !== "requests") void clearErrors();
  }, [filter, onClear, clearErrors, t]);
  const filterOptions: Array<{ id: LogFilter; label: string }> = [
    { id: "all", label: t("settings:logs.filter_all") },
    { id: "requests", label: t("settings:logs.filter_requests") },
    { id: "errors", label: t("settings:logs.filter_errors") },
  ];
  return (
    <>
      <SectionHeader icon={FileClock} title={t("settings:logs.title")} subtitle={t("settings:logs.subtitle")} />
      <div className="-mt-2 mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {filterOptions.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              aria-pressed={filter === id}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition",
                filter === id
                  ? "border-primary bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {feed.length > 0 ? (
          <button
            type="button"
            onClick={() => void clearVisible()}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs text-destructive transition hover:bg-destructive/10"
          >
            <Trash2 className="size-3.5" />
            {t("settings:logs.clear")}
          </button>
        ) : null}
      </div>
      <div className="space-y-2">
        {feed.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            {t("settings:logs.empty")}
          </div>
        ) : null}
        {feed.map((item) =>
          item.log ? (
            <RequestLogRow key={`req-${item.log.id}`} log={item.log} onClick={() => setActive(item.log!)} />
          ) : (
            <AppErrorRow key={`err-${item.error!.id}`} entry={item.error!} onClick={() => setActiveError(item.error!)} />
          ),
        )}
      </div>
      <LogDetailDialog log={active} onClose={() => setActive(null)} />
      <AppErrorDetailDialog entry={activeError} onClose={() => setActiveError(null)} />
    </>
  );
}

function RequestLogRow({ log, onClick }: { log: RequestLog; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full rounded-lg border bg-card p-3 text-left transition hover:shadow-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-primary">{log.method ?? "POST"}</span>
        <span className={cn("text-xs font-medium", log.ok ? "text-success" : "text-destructive")}>
          {log.status}
        </span>
      </div>
      <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{log.url}</div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span>{new Date(log.at).toLocaleString()}</span>
        <span>{log.durationMs ?? 0}ms</span>
        <span className="truncate">
          {log.providerName}
          {log.kind ? ` · ${log.kind}` : ""}
        </span>
      </div>
      {log.error ? <div className="mt-1 truncate text-xs text-destructive">{log.error}</div> : null}
    </button>
  );
}

const SEVERITY_STYLE: Record<AppErrorDto["severity"], string> = {
  error: "bg-destructive/10 text-destructive",
  warn: "bg-warning/10 text-warning",
  info: "bg-muted text-muted-foreground",
};

function AppErrorRow({ entry, onClick }: { entry: AppErrorDto; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full rounded-lg border bg-card p-3 text-left transition hover:shadow-sm"
    >
      <div className="flex items-center gap-2">
        <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", SEVERITY_STYLE[entry.severity])}>
          {t(`settings:app_errors.severity_${entry.severity}`)}
        </span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{entry.domain}</span>
        {entry.count > 1 ? <span className="text-xs text-muted-foreground">×{entry.count}</span> : null}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{new Date(entry.at).toLocaleString()}</span>
      </div>
      <div className="mt-1 truncate text-sm">{appErrorText(entry)}</div>
    </button>
  );
}

function AppErrorDetailDialog({ entry, onClose }: { entry: AppErrorDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">{entry ? appErrorText(entry) : ""}</DialogTitle>
        </DialogHeader>
        {entry ? (
          <div className="space-y-3 text-xs">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
              <span>{t(`settings:app_errors.severity_${entry.severity}`)}</span>
              <span className="font-mono">{entry.domain}</span>
              <span>{new Date(entry.at).toLocaleString()}</span>
              {entry.count > 1 ? <span>{t("settings:app_errors.merged_count", { count: entry.count })}</span> : null}
            </div>
            {entry.detail ? (
              <pre className="max-h-[400px] overflow-auto rounded-lg border bg-muted/30 p-2 whitespace-pre-wrap">{entry.detail}</pre>
            ) : (
              <div className="text-muted-foreground">{t("settings:app_errors.no_detail")}</div>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}


function LogDetailDialog({ log, onClose }: { log: RequestLog | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [reveal, setReveal] = React.useState(false);
  const requestText = log?.requestBody || "";
  const responseText = log?.responseBody || log?.error || "";
  const requestJson = React.useMemo(() => tryParseJson(requestText), [requestText]);
  const responseJson = React.useMemo(() => tryParseJson(responseText), [responseText]);
  const copy = React.useCallback(
    async (text: string) => {
      if (!text) return;
      // 走共享 helper(非安全上下文自动回退 execCommand);裸 navigator.clipboard.writeText
      // 在 Docker 裸 IP 部署下是 undefined,会静默失败。
      await copyTextToClipboard(text);
      toast.success(t("settings:logs.copied", { title: "" }));
    },
    [t],
  );
  return (
    <Dialog
      open={log !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate font-mono text-sm">{log?.url ?? ""}</DialogTitle>
        </DialogHeader>
        {log ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
              <DetailField label={t("settings:logs.field_time")} value={new Date(log.at).toLocaleString()} />
              <DetailField label={t("settings:logs.field_method")} value={log.method ?? "-"} />
              <DetailField label={t("settings:logs.field_status")} value={String(log.status)} valueClass={log.ok ? "text-success" : "text-destructive"} />
              <DetailField label={t("settings:logs.field_duration")} value={`${log.durationMs ?? 0}ms`} />
              <DetailField label={t("settings:logs.field_provider")} value={log.providerName} />
              <DetailField label={t("settings:logs.field_kind")} value={log.kind ?? "-"} />
            </div>
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => setReveal((v) => !v)}>
                {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                {reveal ? t("settings:logs.hide_sensitive") : t("settings:logs.show_sensitive")}
              </Button>
            </div>
            {log.error ? (
              <pre className="overflow-auto rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-xs whitespace-pre-wrap text-destructive">
                {log.error}
              </pre>
            ) : null}
            <HeaderList title={t("settings:logs.request_headers")} headers={log.requestHeaders} reveal={reveal} />
            <BodySection title={t("settings:logs.request_body")} text={requestText} json={requestJson} onCopy={copy} emptyText={t("settings:logs.no_request_body")} />
            <HeaderList title={t("settings:logs.response_headers")} headers={log.responseHeaders} reveal={reveal} />
            <BodySection title={t("settings:logs.response_body")} text={responseText} json={responseJson} onCopy={copy} emptyText={t("settings:logs.no_response_body")} />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DetailField({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground">{label}</div>
      <div className={cn("truncate font-medium", valueClass)} title={value}>
        {value}
      </div>
    </div>
  );
}

// 敏感请求头默认打码,避免在日志详情里直接暴露 API Key / Token。
const SENSITIVE_HEADER_PATTERN = /(authorization|api[-_]?key|secret|token|password|cookie)/i;

function isSensitiveHeader(key: string): boolean {
  return SENSITIVE_HEADER_PATTERN.test(key);
}

function maskHeaderValue(value: string): string {
  if (!value) return value;
  const scheme = value.match(/^(Bearer|Basic|Token|ApiKey)\s+(.+)$/i);
  if (scheme) return `${scheme[1]} ${"•".repeat(Math.min(scheme[2].length, 16))}`;
  if (value.length <= 8) return "••••••";
  return `${value.slice(0, 4)}••••••`;
}

function HeaderList({ title, headers, reveal }: { title: string; headers?: Record<string, string>; reveal?: boolean }) {
  if (!headers || Object.keys(headers).length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">{title}</div>
      <div className="divide-y rounded-lg border bg-muted/30">
        {Object.entries(headers).map(([key, value]) => {
          const sensitive = isSensitiveHeader(key);
          const display = sensitive && !reveal ? maskHeaderValue(value) : value;
          return (
            <div key={key} className="flex gap-2 px-2 py-1 text-xs">
              <span className="shrink-0 font-mono text-primary">{key}:</span>
              <span className={cn("min-w-0 break-all font-mono", sensitive && !reveal && "text-muted-foreground")}>{display}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BodySection({
  title,
  text,
  json,
  onCopy,
  emptyText,
}: {
  title: string;
  text: string;
  json: unknown;
  onCopy: (text: string) => void;
  emptyText: string;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
        <span>{title}</span>
        {text ? (
          <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted" onClick={() => void onCopy(text)}>
            {t("settings:logs.copy")}
          </button>
        ) : null}
      </div>
      {!text ? (
        <div className="text-xs text-muted-foreground">{emptyText}</div>
      ) : json !== undefined ? (
        <JsonTree data={json} className="rounded-lg border bg-muted/30 p-2" zoomTitle={title} />
      ) : (
        <pre className="max-h-[400px] overflow-auto rounded-lg border bg-muted/30 p-2 text-xs whitespace-pre-wrap">
          {text}
        </pre>
      )}
    </div>
  );
}
