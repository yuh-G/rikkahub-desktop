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
  FileSearch,
  FileText,
  FolderOpen,
  Globe,
  Loader2,
  MessageCircleQuestion,
  Search,
  Send,
  Sparkles,
  Video,
  Wrench,
  X,
} from "lucide-react";

import Markdown from "~/components/markdown/markdown";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { DetailDrawer } from "~/components/detail-drawer";
import { copyTextToClipboard } from "~/lib/clipboard";
import { resolveFileUrl } from "~/lib/files";
import { cn } from "~/lib/utils";
import type { TextPart as UITextPart, ToolPart as UIToolPart } from "~/types";

import { workspaceToolKind } from "~/lib/workspace-tool-model";
import {
  buildAskUserAnswerMap,
  normalizeAskUserQuestions,
  parseAskUserAnswer,
  serializeAskUserAnswer,
  type AskUserQuestion,
} from "@server/tools/ask-user";

import { ControlledChainOfThoughtStep } from "../chain-of-thought";
import {
  WorkspaceApprovalCard,
  ElapsedBadge,
  workspaceReadTitle,
  workspaceReconTitle,
} from "./workspace-tool-part";
import { useElapsedSeconds } from "~/hooks/use-elapsed-since";
import { AudioPart as AudioPartRenderer } from "./audio-part";
import { ImagePart as ImagePartRenderer } from "./image-part";
import { VideoPart as VideoPartRenderer } from "./video-part";

interface ToolPartProps {
  tool: UIToolPart;
  loading?: boolean;
  /** 域3-1 耗时计时基准(消息级,由 message-part.tsx 统一透传)。 */
  messageCreatedAt?: string;
  messageFinishedAt?: string | null;
  onToolApproval?: (
    toolCallId: string,
    approved: boolean,
    reason: string,
    answer?: string,
  ) => void | Promise<void>;
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
  USE_SKILL: "use_skill",
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
  return domain
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`
    : "";
}

function SearchFavicon({
  icon,
  url,
  className,
}: {
  icon?: string;
  url: string;
  className?: string;
}) {
  const candidates = React.useMemo(
    () =>
      [icon, faviconUrl(url), googleFaviconUrl(url)].filter((item): item is string =>
        Boolean(item),
      ),
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
      <span
        className={cn(
          "inline-flex items-center justify-center overflow-hidden rounded bg-white p-[2px]",
          className,
        )}
      >
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
    <span
      className={cn(
        "inline-flex items-center justify-center overflow-hidden rounded bg-muted",
        className,
      )}
    >
      <span className="flex h-full w-full items-center justify-center text-micro font-semibold text-muted-foreground">
        {(domain[0] ?? "?").toUpperCase()}
      </span>
    </span>
  );
}

function SearchFaviconRow({ items }: { items: unknown[] }) {
  const records = items
    .map((item) =>
      !item || typeof item !== "object" || Array.isArray(item)
        ? null
        : (item as Record<string, unknown>),
    )
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
    .map((item) =>
      !item || typeof item !== "object" || Array.isArray(item)
        ? null
        : (item as Record<string, unknown>),
    )
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
          <div
            key={`${url}-${index}`}
            className="flex min-w-0 items-center gap-2 rounded-md bg-background/60 px-2 py-1"
          >
            <SearchFavicon
              className="size-5 shrink-0 overflow-hidden rounded border bg-muted"
              icon={typeof record.icon === "string" ? record.icon : undefined}
              url={url}
            />
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">{title}</span>
            {domain ? (
              <span className="shrink-0 text-micro text-muted-foreground">{domain}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function getToolIcon(toolName: string, action?: string) {
  // 工作区 read(M2-3):文件图标。write/edit/bash 已被抽出为顶层动作卡,不走本分派。
  if (workspaceToolKind(toolName) === "read") return FileText;
  // 兜底检索工具(grep/find/ls):与 read 同属侦察类,折叠组内用专属图标
  if (toolName === "grep") return FileSearch;
  if (toolName === "find") return FileSearch;
  if (toolName === "ls") return FolderOpen;
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
  if (toolName === TOOL_NAMES.USE_SKILL) return Sparkles;

  return Wrench;
}

function getToolTitle(toolName: string, args: unknown, t: TFunction): string {
  const action = getStringField(args, "action");

  {
    // 工作区 read(M2-3):相对路径+offset/limit 徽标(方案 §4.3 单行步骤形态)。
    const readTitle = workspaceReadTitle(toolName, JSON.stringify(args ?? {}), t);
    if (readTitle) return readTitle;
    // 兜底检索工具(grep/find/ls)的单行步骤标题
    const reconTitle = workspaceReconTitle(toolName, JSON.stringify(args ?? {}), t);
    if (reconTitle) return reconTitle;
  }

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

  if (toolName === TOOL_NAMES.USE_SKILL) {
    const skillName = getStringField(args, "name");
    const skillPath = getStringField(args, "path");
    if (skillName && skillPath) {
      return t("tool_part.use_skill_with_name", { skillName: `${skillName}/${skillPath}` });
    }
    return skillName
      ? t("tool_part.use_skill_with_name", { skillName })
      : t("tool_part.use_skill");
  }

  return t("tool_part.tool_call_with_name", { toolName });
}

// issue3:工具结果常是纯文本(JSON.parse 失败回退原文)——此前对字符串再走 JSON.stringify,
// 换行被转义成 \n 字面量,整段挤成一条超长单行只能横向滚动。字符串直接按原文
// 渲染,对象保持缩进 JSON;pre-wrap + break-words 让长行折行,用足垂直空间。
// maxHeightClass:卡片内联预览限高,抽屉里不限(外层容器自身可滚)。
function JsonBlock({ value, maxHeightClass = "max-h-64" }: { value: unknown; maxHeightClass?: string }) {
  const text = typeof value === "string" ? value : toJsonString(value);
  return (
    <pre className={cn("overflow-y-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-xs", maxHeightClass)}>
      {text}
    </pre>
  );
}

// issue3:参数/结果区块的复制按钮。复制工具原始文本(结果用原文,不用二次
// stringify 的转义形态),方便调试时把错误信息带走。
function SectionCopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = React.useState(false);
  const timeoutRef = React.useRef(0);
  React.useEffect(() => () => window.clearTimeout(timeoutRef.current), []);
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-label={label}
      title={label}
      className="h-5 px-1 text-muted-foreground"
      onClick={async () => {
        if (copied) return;
        try {
          await copyTextToClipboard(text);
        } catch {
          return;
        }
        setCopied(true);
        timeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <Check className="size-3" /> : <Clipboard className="size-3" />}
    </Button>
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
            const domain =
              typeof record.domain === "string" ? record.domain : domainFromUrl(url) || url;
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
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-micro text-muted-foreground">
                      {domain}
                    </span>
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

// use_skill(PR#30 想法7):技能正文本质是 SKILL.md 的 Markdown——按富文本渲染;
// 经 path 加载的附属文件可能是脚本/数据,仅 .md 走 Markdown,其余保持等宽原文。
function UseSkillPreview({ args, content, rawText }: { args: unknown; content: unknown; rawText: string }) {
  const { t } = useTranslation("message");
  const skillPath = getStringField(args, "path");
  const body = getStringField(content, "content") ?? rawText;
  const renderAsMarkdown = !skillPath || skillPath.toLowerCase().endsWith(".md");
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 flex items-center justify-between text-muted-foreground text-xs">
          <span>{t("tool_part.parameters")}</span>
          <SectionCopyButton text={toJsonString(args)} label={t("tool_part.copy")} />
        </div>
        <JsonBlock value={args} maxHeightClass="max-h-none" />
      </div>
      {body && (
        <div>
          <div className="mb-1 flex items-center justify-between text-muted-foreground text-xs">
            <span>{t("tool_part.result")}</span>
            <SectionCopyButton text={body} label={t("tool_part.copy")} />
          </div>
          {renderAsMarkdown ? (
            <div className="rounded-md border bg-muted/20 p-3">
              <Markdown content={body} className="text-sm" />
            </div>
          ) : (
            <JsonBlock value={body} maxHeightClass="max-h-none" />
          )}
        </div>
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

interface AskUserToolStep {
  tool: UIToolPart;
}

// ask_user 的解析/合并/序列化全部走共享模块(@server/tools/ask-user)——与后端、与 APP
// 端逐字同源,UI 不再自带一套解析。selectionType: text 纯文本 / single 单选(chip 选中即
// 填回文本框,可再改) / multi 多选(checkbox 切换,自定义文本追加最后,逗号合并)。
function AskUserToolStep({
  tool,
  loading,
  messageCreatedAt,
  messageFinishedAt,
  onToolApproval,
  isFirst,
  isLast,
}: ToolPartProps) {
  const { t } = useTranslation("message");
  const [expanded, setExpanded] = React.useState(true);

  const args = React.useMemo(() => safeJsonParse(tool.input), [tool.input]);
  const questions = React.useMemo<AskUserQuestion[]>(() => {
    const normalized = normalizeAskUserQuestions((args as Record<string, unknown>)?.questions);
    return "error" in normalized ? [] : normalized.questions;
  }, [args]);

  // 每题原始选择:text/single 用 customText(chip 选中写入),multi 另持 selected 集合。
  const [drafts, setDrafts] = React.useState<Record<string, { selected: string[]; customText: string }>>({});
  const [confirmingPartial, setConfirmingPartial] = React.useState(false);

  const isPending = tool.approvalState.type === "pending";
  const isAnswered = tool.approvalState.type === "answered";

  // 域3-1:等待用户答复的时长同样入账(等待+执行=用户体感的"这步多久"),终局定格。
  const elapsedSeconds = useElapsedSeconds(messageCreatedAt, messageFinishedAt ?? null);

  const firstQuestion = questions[0]?.question ?? "...";
  const title =
    questions.length <= 1
      ? firstQuestion
      : t("tool_part.ask_user_questions_count", { count: questions.length });

  const getDraft = (id: string) => drafts[id] ?? { selected: [], customText: "" };
  const patchDraft = (id: string, patch: Partial<{ selected: string[]; customText: string }>) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...getDraft(id), ...prev[id], ...patch } }));
    setConfirmingPartial(false);
  };
  const toggleOption = (q: AskUserQuestion, option: string) => {
    const draft = getDraft(q.id);
    if (q.selectionType === "multi") {
      const selected = draft.selected.includes(option)
        ? draft.selected.filter((o) => o !== option)
        : [...draft.selected, option];
      patchDraft(q.id, { selected });
    } else {
      // single/text:chip 选中即填入文本框(用户可继续编辑),再点同一项不撤销(避免误清空)。
      patchDraft(q.id, { customText: option });
    }
  };

  const resolved = React.useMemo(
    () => buildAskUserAnswerMap(questions, Object.fromEntries(questions.map((q) => [q.id, getDraft(q.id)]))),
    // drafts 变化即重算;getDraft 从 drafts 派生,不列入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [questions, drafts],
  );
  const answeredCount = questions.filter((q) => resolved[q.id]?.trim()).length;
  const anyAnswered = answeredCount > 0;
  const allAnswered = questions.length > 0 && answeredCount === questions.length;

  const doSubmit = () => {
    if (!onToolApproval || !anyAnswered) return;
    void onToolApproval(tool.toolCallId, true, "", serializeAskUserAnswer(resolved));
  };
  const handleSubmit = () => {
    if (!anyAnswered) return;
    // codex 式未答全确认:有留空时先确认,再提交(空题以空串提交)。
    if (!allAnswered && !confirmingPartial) {
      setConfirmingPartial(true);
      return;
    }
    doSubmit();
  };

  // 历史回放:共享容错读取器解析 answered.answer(扁平契约)。
  const answeredValues = React.useMemo(
    () => (tool.approvalState.type === "answered" ? parseAskUserAnswer(tool.approvalState.answer) : {}),
    [tool.approvalState],
  );

  // PC 端可见性改进：pending 状态时脱离"思考链折叠步骤"的视觉壳，改用一张
  // 高显眼度的卡片直接挂在消息流里。问题在于原来的设计把整个 ask_user 都
  // 套在 ControlledChainOfThoughtStep（左侧带 chain 竖线）里，又被外层
  // ChainOfThought 的"折叠展示最近 N 步"机制隐藏，用户根本意识不到 AI
  // 在等他回复。配合 message-part.tsx 的 groupMessageParts 将 pending
  // ask_user 抽出为独立 attention block，本组件这一支就能在消息流顶层
  // 渲染醒目卡片。
  if (isPending && onToolApproval) {
    return (
      <div
        className="my-2 rounded-2xl border border-primary/40 bg-primary/5 px-4 py-3 shadow-sm ring-1 ring-primary/10"
        role="region"
        aria-live="polite"
      >
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <MessageCircleQuestion className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">
                {t("tool_part.ask_user_waiting_title")}
              </span>
              <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
            </div>
            <p className="text-xs text-muted-foreground">{t("tool_part.ask_user_waiting_desc")}</p>
          </div>
        </div>

        <div className="mt-3 space-y-4">
          {questions.map((q) => {
            const draft = getDraft(q.id);
            const isMulti = q.selectionType === "multi";
            return (
              <div key={q.id} className="space-y-2">
                <div className="text-sm font-medium text-foreground">{q.question}</div>
                {q.options.length > 0 && q.selectionType !== "text" && (
                  <div className="flex flex-wrap gap-1.5" role={isMulti ? "group" : "radiogroup"}>
                    {q.options.map((option) => {
                      const active = isMulti ? draft.selected.includes(option) : draft.customText === option;
                      return (
                        <button
                          key={option}
                          type="button"
                          role={isMulti ? "checkbox" : "radio"}
                          aria-checked={active}
                          onClick={() => toggleOption(q, option)}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
                            active
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-primary/40 bg-background text-foreground hover:border-primary hover:bg-primary/10",
                          )}
                        >
                          {isMulti && active && <Check className="h-3 w-3" aria-hidden />}
                          {option}
                        </button>
                      );
                    })}
                  </div>
                )}
                <Input
                  value={draft.customText}
                  onChange={(e) => patchDraft(q.id, { customText: e.target.value })}
                  placeholder={
                    q.selectionType === "text" || q.options.length === 0
                      ? q.question
                      : isMulti
                        ? t("tool_part.ask_user_custom_placeholder_multi")
                        : t("tool_part.ask_user_custom_placeholder")
                  }
                  className="text-sm"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && anyAnswered) {
                      e.preventDefault();
                      handleSubmit();
                    }
                  }}
                />
              </div>
            );
          })}

          <div className="flex items-center justify-end gap-2">
            {confirmingPartial && !allAnswered && (
              <span className="mr-auto text-xs text-amber-600 dark:text-amber-500">
                {t("tool_part.ask_user_submit_partial_confirm", {
                  count: questions.length - answeredCount,
                })}
              </span>
            )}
            <Button size="sm" disabled={!anyAnswered} onClick={handleSubmit}>
              <Send className="mr-1.5 h-3.5 w-3.5" />
              {confirmingPartial && !allAnswered
                ? t("tool_part.ask_user_submit_anyway")
                : t("tool_part.ask_user_submit")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // 非 pending（已回答/已拒绝/历史回放）保持思考链 step 样式，因为这时它
  // 只是一条历史记录，不应抢占视觉焦点。
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
      extra={elapsedSeconds !== null ? <ElapsedBadge seconds={elapsedSeconds} running={Boolean(loading)} /> : undefined}
    >
      <div className="space-y-3 w-full">
        {questions.map((q) => (
          <div key={q.id} className="space-y-1.5">
            {questions.length > 1 && <div className="text-sm text-foreground">{q.question}</div>}
            {isAnswered ? (
              <div className="text-sm text-primary whitespace-pre-wrap">{answeredValues[q.id] ?? ""}</div>
            ) : null}
          </div>
        ))}
      </div>
    </ControlledChainOfThoughtStep>
  );
}

export function ToolPart({
  tool,
  loading = false,
  messageCreatedAt,
  messageFinishedAt,
  onToolApproval,
  isFirst,
  isLast,
}: ToolPartProps) {
  if (tool.toolName === TOOL_NAMES.ASK_USER) {
    return (
      <AskUserToolStep
        tool={tool}
        loading={loading}
        messageCreatedAt={messageCreatedAt}
        messageFinishedAt={messageFinishedAt}
        onToolApproval={onToolApproval}
        isFirst={isFirst}
        isLast={isLast}
      />
    );
  }

  const { t } = useTranslation("message");
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
  // 域3-1:运行耗时(等待审批+执行=这步的真实时长),与工作区动作卡同一计时口径。
  const elapsedSeconds = useElapsedSeconds(messageCreatedAt, messageFinishedAt ?? null);

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
          <span className="flex shrink-0 items-center gap-1.5">
            {isPending && onToolApproval ? (
              <span className="flex items-center gap-1">
                <Button onClick={handleDeny} size="icon-xs" type="button" variant="secondary">
                  <X className="h-3.5 w-3.5" />
                </Button>
                <Button onClick={handleApprove} size="icon-xs" type="button" variant="secondary">
                  <Check className="h-3.5 w-3.5" />
                </Button>
              </span>
            ) : null}
            {elapsedSeconds !== null ? <ElapsedBadge seconds={elapsedSeconds} running={loading} /> : null}
          </span>
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

      <DetailDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        title={title}
        description={t("tool_part.tool_name_label", { toolName: tool.toolName })}
      >
        {tool.toolName === TOOL_NAMES.SEARCH_WEB && isExecuted ? (
          <SearchWebPreview args={args} content={outputContent} />
        ) : tool.toolName === TOOL_NAMES.SCRAPE_WEB && isExecuted ? (
          <ScrapeWebPreview content={outputContent} />
        ) : tool.toolName === TOOL_NAMES.USE_SKILL && isExecuted ? (
          <UseSkillPreview args={args} content={outputContent} rawText={outputText} />
        ) : (
          <div className="space-y-3">
            <div>
              <div className="mb-1 flex items-center justify-between text-muted-foreground text-xs">
                <span>{t("tool_part.parameters")}</span>
                <SectionCopyButton text={toJsonString(args)} label={t("tool_part.copy")} />
              </div>
              <JsonBlock value={args} maxHeightClass="max-h-none" />
            </div>
            {isExecuted && (
              <div className="space-y-2">
                <div className="mb-1 flex items-center justify-between text-muted-foreground text-xs">
                  <span>{t("tool_part.result")}</span>
                  <SectionCopyButton text={outputText} label={t("tool_part.copy")} />
                </div>
                {tool.output.map((part, i) => {
                  if (part.type === "text") {
                    let parsed: unknown;
                    try {
                      parsed = JSON.parse(part.text);
                    } catch {
                      parsed = part.text;
                    }
                    // 结构化 JSON 保持等宽缩进块;纯文本(多为工具的自然语言/Markdown
                    // 输出)走富文本渲染,与技能内容(UseSkillPreview)的呈现一致。
                    if (parsed !== null && typeof parsed === "object") {
                      return <JsonBlock key={i} value={parsed} maxHeightClass="max-h-none" />;
                    }
                    return (
                      <div key={i} className="rounded-md border bg-muted/20 p-3">
                        <Markdown
                          content={typeof parsed === "string" ? parsed : part.text}
                          className="text-sm"
                        />
                      </div>
                    );
                  }
                  if (part.type === "image")
                    return <ImagePartRenderer key={i} url={part.url} />;
                  if (part.type === "video")
                    return <VideoPartRenderer key={i} url={part.url} />;
                  if (part.type === "audio")
                    return <AudioPartRenderer key={i} url={part.url} />;
                  return null;
                })}
              </div>
            )}
            {!isExecuted && (
              <div className="text-muted-foreground text-sm">{t("tool_part.not_executed")}</div>
            )}
          </div>
        )}
      </DetailDrawer>
    </>
  );
}

/**
 * 顶层"等待用户授权"卡片。任何处于 pending 状态的工具（ask_user 或
 * 需要审批的 MCP 工具）在 message-part.tsx 里都会从思考链折叠中抽出，
 * 走这个组件渲染——目的是用清晰的视觉语言告诉用户"AI 暂停了，正等
 * 你授权"，而不是在折叠面板里挤个小小的勾叉让用户误以为是出错。
 *
 * 对 ask_user 工具：内部已有专属醒目卡片（带问题/选项/提交按钮），
 * 直接透传给 ToolStepPart 让它走 AskUserToolStep 的 pending 分支即可。
 *
 * 对其它需要审批的工具（典型场景是 MCP 工具）：在外层包一个明显的
 * 警示 banner（标题、说明、待执行操作概要），再把原本的 ToolStepPart
 * 嵌进来——保留它对工具名/参数预览/同意/拒绝按钮的现有渲染能力。
 */
export function PendingToolAttentionCard({
  tool,
  loading,
  messageCreatedAt,
  messageFinishedAt,
  onToolApproval,
}: {
  tool: UIToolPart;
  loading?: boolean;
  /** 域3-1:pending 期间持续计时(审批等待本身就是这步的耗时)。 */
  messageCreatedAt?: string;
  messageFinishedAt?: string | null;
  onToolApproval?: ToolPartProps["onToolApproval"];
}) {
  const { t } = useTranslation("message");
  const elapsedSeconds = useElapsedSeconds(messageCreatedAt, messageFinishedAt ?? null);

  // ask_user 已经有自己的专属醒目卡片（AskUserToolStep 内部的 pending 分支），
  // 不需要再多套一层 banner。
  if (tool.toolName === TOOL_NAMES.ASK_USER) {
    return (
      <AskUserToolStep
        tool={tool}
        loading={loading}
        messageCreatedAt={messageCreatedAt}
        messageFinishedAt={messageFinishedAt}
        onToolApproval={onToolApproval}
      />
    );
  }

  // 工作区工具(M2-3):专属审批卡——琥珀色左边条,完整展示将执行的命令/写入路径。
  if (workspaceToolKind(tool.toolName)) {
    return <WorkspaceApprovalCard tool={tool} onToolApproval={onToolApproval} />;
  }

  const args = (() => {
    try {
      return JSON.parse(tool.input || "{}");
    } catch {
      return {};
    }
  })();

  const handleApprove = async () => {
    if (!onToolApproval) return;
    await onToolApproval(tool.toolCallId, true, "");
  };

  const handleDeny = async () => {
    if (!onToolApproval) return;
    const reason = window.prompt(t("tool_part.deny_reason_prompt"), "");
    if (reason === null) return;
    await onToolApproval(tool.toolCallId, false, reason);
  };

  const argsPreview = (() => {
    try {
      const json = JSON.stringify(args, null, 2);
      // 截断过长的参数预览，避免卡片过高
      return json.length > 400 ? `${json.slice(0, 400)}…` : json;
    } catch {
      return tool.input || "";
    }
  })();

  return (
    <div
      className="my-2 rounded-2xl border border-primary/40 bg-primary/5 px-4 py-3 shadow-sm ring-1 ring-primary/10"
      role="region"
      aria-live="polite"
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Wrench className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">
              {t("tool_part.pending_approval_title")}
            </span>
            <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
            {elapsedSeconds !== null ? <ElapsedBadge seconds={elapsedSeconds} running /> : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("tool_part.pending_approval_desc", { toolName: tool.toolName })}
          </p>
        </div>
      </div>

      {argsPreview && argsPreview !== "{}" ? (
        <pre className="mt-3 max-h-40 overflow-auto rounded-md border border-border/50 bg-background/60 px-3 py-2 text-xs text-foreground">
          <code>{argsPreview}</code>
        </pre>
      ) : null}

      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={handleDeny} disabled={!onToolApproval}>
          <X className="mr-1.5 h-3.5 w-3.5" />
          {t("tool_part.pending_deny")}
        </Button>
        <Button size="sm" onClick={handleApprove} disabled={!onToolApproval}>
          <Check className="mr-1.5 h-3.5 w-3.5" />
          {t("tool_part.pending_approve")}
        </Button>
      </div>
    </div>
  );
}
