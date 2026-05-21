import * as React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  AudioLines,
  BookHeart,
  BookX,
  Check,
  Clipboard,
  ClipboardPaste,
  Clock3,
  Globe,
  Loader2,
  MessageCircleQuestion,
  Search,
  Send,
  Video,
  Wrench,
  X,
} from "lucide-react";

import Markdown from "~/components/markdown/markdown";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "~/components/ui/drawer";
import { useIsMobile } from "~/hooks/use-mobile";
import { resolveFileUrl } from "~/lib/files";
import { cn } from "~/lib/utils";
import type {
  TextPart as UITextPart,
  ToolPart as UIToolPart,
} from "~/types";

import { ControlledChainOfThoughtStep } from "../chain-of-thought";
import { AudioPart as AudioPartRenderer } from "./audio-part";
import { ImagePart as ImagePartRenderer } from "./image-part";
import { VideoPart as VideoPartRenderer } from "./video-part";

interface ToolPartProps {
  tool: UIToolPart;
  loading?: boolean;
  onToolApproval?: (toolCallId: string, approved: boolean, reason: string, answer?: string) => void | Promise<void>;
  isFirst?: boolean;
  isLast?: boolean;
}

const TOOL_NAMES = {
  MEMORY: "memory_tool",
  SEARCH_WEB: "search_web",
  SCRAPE_WEB: "scrape_web",
  GET_TIME_INFO: "get_time_info",
  CLIPBOARD: "clipboard_tool",
  ASK_USER: "ask_user",
} as const;

const MEMORY_ACTIONS = {
  CREATE: "create",
  EDIT: "edit",
  DELETE: "delete",
} as const;

const CLIPBOARD_ACTIONS = {
  READ: "read",
  WRITE: "write",
} as const;

function safeJsonParse(input: string): unknown {
  if (!input.trim()) return {};
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}

function toJsonString(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function getStringField(data: unknown, key: string): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function getArrayField(data: unknown, key: string): unknown[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const value = (data as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

function domainFromUrl(targetUrl: string) {
  try {
    return new URL(targetUrl).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function faviconUrl(targetUrl: string) {
  const domain = domainFromUrl(targetUrl);
  return domain ? `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico` : "";
}

function googleFaviconUrl(targetUrl: string) {
  const domain = domainFromUrl(targetUrl);
  return domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64` : "";
}

function SearchFavicon({ icon, url, className }: { icon?: string; url: string; className?: string }) {
  const candidates = React.useMemo(
    () => [icon, faviconUrl(url), googleFaviconUrl(url)].filter((item): item is string => Boolean(item)),
    [icon, url],
  );
  const [index, setIndex] = React.useState(0);
  const domain = domainFromUrl(url);

  React.useEffect(() => {
    setIndex(0);
  }, [url, icon]);

  // Always render the favicon on a small white tile so dark-on-dark logos (GitHub octocat,
  // mcpservers.org, etc.) stay legible when the user is on a dark theme. Without this the
  // black square that ships in the actual favicon disappears into the dark message card.
  if (candidates[index]) {
    return (
      <span className={cn("inline-flex items-center justify-center overflow-hidden rounded bg-white p-[2px]", className)}>
        <img
          alt=""
          className="h-full w-full object-contain"
          src={candidates[index]}
          onError={() => setIndex((current) => current + 1)}
        />
      </span>
    );
  }

  return (
    <span className={cn("inline-flex items-center justify-center overflow-hidden rounded bg-muted", className)}>
      <span className="flex h-full w-full items-center justify-center text-[10px] font-semibold text-muted-foreground">
        {(domain[0] ?? "?").toUpperCase()}
      </span>
    </span>
  );
}

function SearchFaviconRow({ items }: { items: unknown[] }) {
  const records = items
    .map((item) => (!item || typeof item !== "object" || Array.isArray(item) ? null : item as Record<string, unknown>))
    .filter((item): item is Record<string, unknown> => Boolean(item && item.url))
    .slice(0, 5);
  if (records.length === 0) return null;
  return (
    <span className="inline-flex items-center -space-x-1.5">
      {records.map((record, index) => (
        <SearchFavicon
          key={`${String(record.url)}-${index}`}
          className="size-[18px] rounded-full border border-background bg-muted"
          icon={typeof record.icon === "string" ? record.icon : undefined}
          url={String(record.url)}
        />
      ))}
    </span>
  );
}

function SearchResultMiniList({ items }: { items: unknown[] }) {
  const records = items
    .map((item) => (!item || typeof item !== "object" || Array.isArray(item) ? null : item as Record<string, unknown>))
    .filter((item): item is Record<string, unknown> => Boolean(item && item.url))
    .slice(0, 3);
  if (records.length === 0) return null;
  return (
    <div className="mt-1 grid gap-1">
      {records.map((record, index) => {
        const url = String(record.url);
        const title = typeof record.title === "string" ? record.title : url;
        const domain = typeof record.domain === "string" ? record.domain : domainFromUrl(url);
        return (
          <div key={`${url}-${index}`} className="flex min-w-0 items-center gap-2 rounded-md bg-background/60 px-2 py-1">
            <SearchFavicon
              className="size-5 shrink-0 overflow-hidden rounded border bg-muted"
              icon={typeof record.icon === "string" ? record.icon : undefined}
              url={url}
            />
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">{title}</span>
            {domain ? <span className="shrink-0 text-[10px] text-muted-foreground">{domain}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

function getToolIcon(toolName: string, action?: string) {
  if (toolName === TOOL_NAMES.MEMORY) {
    if (action === MEMORY_ACTIONS.CREATE || action === MEMORY_ACTIONS.EDIT) {
      return BookHeart;
    }
    if (action === MEMORY_ACTIONS.DELETE) {
      return BookX;
    }
    return Wrench;
  }

  if (toolName === TOOL_NAMES.SEARCH_WEB) return Search;
  if (toolName === TOOL_NAMES.SCRAPE_WEB) return Globe;
  if (toolName === TOOL_NAMES.GET_TIME_INFO) return Clock3;

  if (toolName === TOOL_NAMES.CLIPBOARD) {
    if (action === CLIPBOARD_ACTIONS.WRITE) return ClipboardPaste;
    return Clipboard;
  }

  if (toolName === TOOL_NAMES.ASK_USER) return MessageCircleQuestion;

  return Wrench;
}

function getToolTitle(toolName: string, args: unknown, t: TFunction): string {
  const action = getStringField(args, "action");

  if (toolName === TOOL_NAMES.MEMORY) {
    if (action === MEMORY_ACTIONS.CREATE) return t("tool_part.memory_create");
    if (action === MEMORY_ACTIONS.EDIT) return t("tool_part.memory_edit");
    if (action === MEMORY_ACTIONS.DELETE) return t("tool_part.memory_delete");
  }

  if (toolName === TOOL_NAMES.SEARCH_WEB) {
    const query = getStringField(args, "query") ?? "";
    return query ? t("tool_part.search_web_with_query", { query }) : t("tool_part.search_web");
  }

  if (toolName === TOOL_NAMES.SCRAPE_WEB) return t("tool_part.scrape_web");
  if (toolName === TOOL_NAMES.GET_TIME_INFO) return t("tool_part.get_time_info");

  if (toolName === TOOL_NAMES.CLIPBOARD) {
    if (action === CLIPBOARD_ACTIONS.READ) return t("tool_part.clipboard_read");
    if (action === CLIPBOARD_ACTIONS.WRITE) return t("tool_part.clipboard_write");
  }

  if (toolName === TOOL_NAMES.ASK_USER) return t("tool_part.ask_user_title");

  return t("tool_part.tool_call_with_name", { toolName });
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
      {toJsonString(value)}
    </pre>
  );
}

function SearchWebPreview({ args, content }: { args: unknown; content: unknown }) {
  const { t } = useTranslation("message");
  const query = getStringField(args, "query") ?? "";
  const answer = getStringField(content, "answer");
  const items = getArrayField(content, "items");
  return (
    <div className="space-y-3">
      <div className="text-sm">
        {t("tool_part.search_query_label", { query: query || t("tool_part.empty") })}
      </div>
      {answer && (
        <div className="rounded-lg border bg-muted/50 p-3">
          <Markdown content={answer} className="text-sm" />
        </div>
      )}

      {items.length > 0 ? (
        <div className="space-y-2">
          {items.map((item, index) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
              return null;
            }

            const record = item as Record<string, unknown>;
            const url = typeof record.url === "string" ? record.url : "";
            const title = typeof record.title === "string" ? record.title : "";
            const text = typeof record.text === "string" ? record.text : "";
            const domain = typeof record.domain === "string" ? record.domain : domainFromUrl(url) || url;
            const icon = typeof record.icon === "string" && record.icon ? record.icon : undefined;

            if (!url) return null;

            return (
              <a
                key={`${url}-${index}`}
                className="flex gap-3 rounded-lg border border-muted bg-card p-3 transition-colors hover:bg-muted/40"
                href={url}
                rel="noreferrer"
                target="_blank"
              >
                <SearchFavicon
                  className="mt-0.5 size-7 shrink-0 rounded-md border bg-muted object-contain"
                  icon={icon}
                  url={url}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="line-clamp-1 font-medium text-sm">{title || url}</span>
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{domain}</span>
                  </span>
                  {text && (
                    <span className="mt-1 line-clamp-3 text-muted-foreground text-xs">{text}</span>
                  )}
                  <span className="mt-2 line-clamp-1 text-primary text-xs">{url}</span>
                </span>
              </a>
            );
          })}
        </div>
      ) : (
        <JsonBlock value={content} />
      )}
    </div>
  );
}

function ScrapeWebPreview({ content }: { content: unknown }) {
  const urls = getArrayField(content, "urls");

  if (urls.length === 0) {
    return <JsonBlock value={content} />;
  }

  return (
    <div className="space-y-3">
      {urls.map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return null;
        }

        const record = item as Record<string, unknown>;
        const url = typeof record.url === "string" ? record.url : "";
        const text = typeof record.content === "string" ? record.content : "";

        return (
          <div key={`${url}-${index}`} className="space-y-2 rounded-lg border p-3">
            <div className="line-clamp-1 text-muted-foreground text-xs">{url}</div>
            <div className="rounded-md border bg-muted/20 p-2">
              <Markdown content={text} className="text-sm" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface AskUserQuestion {
  id: string;
  question: string;
  options: string[];
}

function parseAskUserQuestions(args: unknown): AskUserQuestion[] {
  try {
    const questions = getArrayField(args, "questions");
    return questions
      .map((q) => {
        if (!q || typeof q !== "object" || Array.isArray(q)) return null;
        const record = q as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id : "";
        const question = typeof record.question === "string" ? record.question : "";
        if (!id || !question) return null;
        const rawOptions = Array.isArray(record.options) ? record.options : [];
        const options = rawOptions.filter((o): o is string => typeof o === "string");
        return { id, question, options } satisfies AskUserQuestion;
      })
      .filter((q): q is AskUserQuestion => q !== null);
  } catch {
    return [];
  }
}

function AskUserToolStep({
  tool,
  loading,
  onToolApproval,
  isFirst,
  isLast,
}: ToolPartProps) {
  const { t } = useTranslation("message");
  const [expanded, setExpanded] = React.useState(true);

  const args = React.useMemo(() => safeJsonParse(tool.input), [tool.input]);
  const questions = React.useMemo(() => parseAskUserQuestions(args), [args]);
  const [answers, setAnswers] = React.useState<Record<string, string>>({});

  const isPending = tool.approvalState.type === "pending";
  const isAnswered = tool.approvalState.type === "answered";

  const firstQuestion = questions[0]?.question ?? "...";
  const title =
    questions.length <= 1
      ? firstQuestion
      : t("tool_part.ask_user_questions_count", { count: questions.length });

  const allAnswered = questions.length > 0 && questions.every((q) => answers[q.id]?.trim());

  const handleSubmit = () => {
    if (!onToolApproval || !allAnswered) return;
    const payload = JSON.stringify({
      answers: Object.fromEntries(questions.map((q) => [q.id, answers[q.id] ?? ""])),
    });
    void onToolApproval(tool.toolCallId, true, "", payload);
  };

  const setAnswer = (questionId: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
  };

  // Parse answered state for display
  const answeredValues = React.useMemo(() => {
    if (tool.approvalState.type !== "answered") return {};
    try {
      const parsed = JSON.parse(tool.approvalState.answer) as { answers?: Record<string, string> };
      return parsed.answers ?? {};
    } catch {
      return {};
    }
  }, [tool.approvalState]);

  return (
    <ControlledChainOfThoughtStep
      expanded={expanded}
      onExpandedChange={setExpanded}
      isFirst={isFirst}
      isLast={isLast}
      active={loading}
      icon={
        loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
        ) : (
          <MessageCircleQuestion className="h-4 w-4 text-primary" />
        )
      }
      label={<span className="text-foreground line-clamp-2 text-sm font-medium">{title}</span>}
    >
      <div className="space-y-3 w-full">
        {questions.map((q) => (
          <div key={q.id} className="space-y-1.5">
            {questions.length > 1 && (
              <div className="text-sm text-foreground">{q.question}</div>
            )}

            {isPending && onToolApproval ? (
              <>
                {q.options.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {q.options.map((option) => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setAnswer(q.id, option)}
                        className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                          answers[q.id] === option
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-muted-foreground/30 text-muted-foreground hover:border-primary/50"
                        }`}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                )}
                <Input
                  value={answers[q.id] ?? ""}
                  onChange={(e) => setAnswer(q.id, e.target.value)}
                  placeholder={q.question}
                  className="text-sm"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && allAnswered) {
                      e.preventDefault();
                      handleSubmit();
                    }
                  }}
                />
              </>
            ) : isAnswered ? (
              <div className="text-sm text-primary">
                {answeredValues[q.id] ?? tool.approvalState.type === "answered" ? answeredValues[q.id] || "" : ""}
              </div>
            ) : null}
          </div>
        ))}

        {isPending && onToolApproval && (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="secondary"
              disabled={!allAnswered}
              onClick={handleSubmit}
            >
              <Send className="mr-1.5 h-3.5 w-3.5" />
              {t("tool_part.ask_user_submit")}
            </Button>
          </div>
        )}
      </div>
    </ControlledChainOfThoughtStep>
  );
}

export function ToolPart({
  tool,
  loading = false,
  onToolApproval,
  isFirst,
  isLast,
}: ToolPartProps) {
  if (tool.toolName === TOOL_NAMES.ASK_USER) {
    return (
      <AskUserToolStep
        tool={tool}
        loading={loading}
        onToolApproval={onToolApproval}
        isFirst={isFirst}
        isLast={isLast}
      />
    );
  }

  const { t } = useTranslation("message");
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = React.useState(true);
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  const args = React.useMemo(() => safeJsonParse(tool.input), [tool.input]);

  const outputText = React.useMemo(
    () =>
      tool.output
        .filter((part): part is UITextPart => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    [tool.output],
  );

  const outputContent = React.useMemo(() => safeJsonParse(outputText), [outputText]);

  const hasMediaOutput = React.useMemo(
    () => tool.output.some((p) => p.type === "image" || p.type === "video" || p.type === "audio"),
    [tool.output],
  );

  const memoryAction = getStringField(args, "action");
  const title = getToolTitle(tool.toolName, args, t);
  const isPending = tool.approvalState.type === "pending";
  const isDenied = tool.approvalState.type === "denied";
  const deniedReason =
    tool.approvalState.type === "denied" ? (tool.approvalState.reason ?? "") : "";
  const isExecuted = tool.output.length > 0;

  const hasExtraContent =
    (tool.toolName === TOOL_NAMES.MEMORY &&
      (memoryAction === MEMORY_ACTIONS.CREATE || memoryAction === MEMORY_ACTIONS.EDIT) &&
      Boolean(getStringField(outputContent, "content"))) ||
    (tool.toolName === TOOL_NAMES.SEARCH_WEB &&
      (Boolean(getStringField(outputContent, "answer")) ||
        getArrayField(outputContent, "items").length > 0)) ||
    (tool.toolName === TOOL_NAMES.SCRAPE_WEB && Boolean(getStringField(args, "url"))) ||
    isDenied ||
    hasMediaOutput;

  const canOpenDrawer = isPending || isExecuted;
  const Icon = getToolIcon(tool.toolName, memoryAction);

  const handleApprove = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!onToolApproval) return;
    await onToolApproval(tool.toolCallId, true, "");
  };

  const handleDeny = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!onToolApproval) return;
    const reason = window.prompt(t("tool_part.deny_reason_prompt"), "");
    if (reason === null) return;
    await onToolApproval(tool.toolCallId, false, reason);
  };

  return (
    <>
      <ControlledChainOfThoughtStep
        expanded={expanded}
        onExpandedChange={setExpanded}
        isFirst={isFirst}
        isLast={isLast}
        active={loading}
        icon={
          loading ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : (
            <Icon className="h-4 w-4 text-primary" />
          )
        }
        label={<span className="text-foreground line-clamp-2 text-sm font-medium">{title}</span>}
        extra={
          isPending && onToolApproval ? (
            <div className="flex items-center gap-1">
              <Button onClick={handleDeny} size="icon-xs" type="button" variant="secondary">
                <X className="h-3.5 w-3.5" />
              </Button>
              <Button onClick={handleApprove} size="icon-xs" type="button" variant="secondary">
                <Check className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : undefined
        }
        onClick={canOpenDrawer ? () => setDrawerOpen(true) : undefined}
      >
        {hasExtraContent && (
          <div className="space-y-1">
            {tool.toolName === TOOL_NAMES.MEMORY &&
              (memoryAction === MEMORY_ACTIONS.CREATE || memoryAction === MEMORY_ACTIONS.EDIT) && (
                <div className="line-clamp-3 text-muted-foreground text-xs">
                  {getStringField(outputContent, "content")}
                </div>
              )}

            {tool.toolName === TOOL_NAMES.SEARCH_WEB && getStringField(outputContent, "answer") && (
              <div className="line-clamp-3 text-muted-foreground text-xs">
                {getStringField(outputContent, "answer")}
              </div>
            )}

            {tool.toolName === TOOL_NAMES.SEARCH_WEB &&
              getArrayField(outputContent, "items").length > 0 && (
                <>
                  <div className="flex items-center gap-2 text-muted-foreground text-xs">
                    <SearchFaviconRow items={getArrayField(outputContent, "items")} />
                    <span>
                      {t("tool_part.search_results_count", {
                        count: getArrayField(outputContent, "items").length,
                      })}
                    </span>
                  </div>
                  <SearchResultMiniList items={getArrayField(outputContent, "items")} />
                </>
              )}

            {tool.toolName === TOOL_NAMES.SCRAPE_WEB && getStringField(args, "url") && (
              <div className="line-clamp-2 text-muted-foreground text-xs">
                {getStringField(args, "url")}
              </div>
            )}

            {isDenied && (
              <div className="text-destructive text-xs">
                {deniedReason
                  ? t("tool_part.denied_with_reason", { reason: deniedReason })
                  : t("tool_part.denied")}
              </div>
            )}

            {hasMediaOutput && (
              <div className="flex flex-wrap gap-1">
                {tool.output.map((part, i) => {
                  if (part.type === "image") {
                    return (
                      <img
                        key={i}
                        alt=""
                        className="h-16 w-auto rounded border border-muted object-contain"
                        src={resolveFileUrl(part.url)}
                      />
                    );
                  }
                  if (part.type === "video") {
                    return (
                      <span
                        key={i}
                        className="inline-flex items-center gap-1 rounded border border-muted bg-muted/30 px-2 py-1 text-muted-foreground text-xs"
                      >
                        <Video className="h-3 w-3" />
                        video
                      </span>
                    );
                  }
                  if (part.type === "audio") {
                    return (
                      <span
                        key={i}
                        className="inline-flex items-center gap-1 rounded border border-muted bg-muted/30 px-2 py-1 text-muted-foreground text-xs"
                      >
                        <AudioLines className="h-3 w-3" />
                        audio
                      </span>
                    );
                  }
                  return null;
                })}
              </div>
            )}
          </div>
        )}
      </ControlledChainOfThoughtStep>

      <Drawer
        direction={isMobile ? "bottom" : "right"}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
      >
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{title}</DrawerTitle>
            <DrawerDescription>
              {t("tool_part.tool_name_label", { toolName: tool.toolName })}
            </DrawerDescription>
          </DrawerHeader>

          <div className="flex-1 min-h-0 space-y-4 overflow-y-auto px-4 pb-6">
            {tool.toolName === TOOL_NAMES.SEARCH_WEB && isExecuted ? (
              <SearchWebPreview args={args} content={outputContent} />
            ) : tool.toolName === TOOL_NAMES.SCRAPE_WEB && isExecuted ? (
              <ScrapeWebPreview content={outputContent} />
            ) : (
              <div className="space-y-3">
                <div>
                  <div className="mb-1 text-muted-foreground text-xs">
                    {t("tool_part.parameters")}
                  </div>
                  <JsonBlock value={args} />
                </div>
                {isExecuted && (
                  <div className="space-y-2">
                    <div className="mb-1 text-muted-foreground text-xs">
                      {t("tool_part.result")}
                    </div>
                    {tool.output.map((part, i) => {
                      if (part.type === "text") {
                        let parsed: unknown;
                        try {
                          parsed = JSON.parse(part.text);
                        } catch {
                          parsed = part.text;
                        }
                        return <JsonBlock key={i} value={parsed} />;
                      }
                      if (part.type === "image") return <ImagePartRenderer key={i} url={part.url} />;
                      if (part.type === "video") return <VideoPartRenderer key={i} url={part.url} />;
                      if (part.type === "audio") return <AudioPartRenderer key={i} url={part.url} />;
                      return null;
                    })}
                  </div>
                )}
                {!isExecuted && (
                  <div className="text-muted-foreground text-sm">{t("tool_part.not_executed")}</div>
                )}
              </div>
            )}
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
