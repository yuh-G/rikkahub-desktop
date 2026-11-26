// 插件页各视图共用的小部件(方案 P6.2 的「通用规则」):图标块、返回、工具栏的图标按钮与原地展开的搜索、
// 状态徽标、时间、说明块与信息卡的行。只用现有组件与刻度。
import * as React from "react";
import { ArrowLeft, Puzzle, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import Markdown from "~/components/markdown/markdown";
import { Button } from "~/components/ui/button";
import { SearchInput } from "~/components/ui/search-input";
import { Skeleton } from "~/components/ui/skeleton";
import { StatusBadge } from "~/components/ui/status-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import i18n from "~/i18n";
import { copyTextToClipboard } from "~/lib/clipboard";
import { extractErrorMessage } from "~/lib/error";
import { formatAbsoluteTime, formatRelativeTime } from "~/lib/relative-time";
import { cn } from "~/lib/utils";

import type { PluginStatus } from "./model";

const TILE_SIZES = {
  row: "size-9 [&>svg]:size-4",
  card: "size-10 [&>svg]:size-5",
  header: "size-12 [&>svg]:size-6",
} as const;

/** 插件没有自带图标,统一用这个方块。 */
export function PluginIconTile({ size = "row" }: { size?: keyof typeof TILE_SIZES }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-[var(--ds-radius-sm)] border border-[var(--ds-divider)] bg-[var(--ds-surface-100)] text-[var(--ds-text-tertiary)]",
        TILE_SIZES[size],
      )}
    >
      <Puzzle />
    </span>
  );
}

/** 左上的「← 上一视图的标题」,图标与内容左缘对齐。 */
export function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="-ml-2.5 text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]"
      onClick={onClick}
    >
      <ArrowLeft className="size-4" />
      {label}
    </Button>
  );
}

/** 工具栏的图标按钮:带提示;active = 设了非默认值(底色 + 右上小圆点)。 */
export function ToolbarIconButton({
  label,
  active = false,
  className,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string; active?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          className={cn(
            "relative text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]",
            active && "bg-[var(--ds-on-surface)] text-[var(--ds-text-primary)]",
            className,
          )}
          {...props}
        >
          {children}
          {active ? (
            <span aria-hidden className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-[var(--ds-brand-primary)]" />
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * 原地展开的搜索:图标按钮变成搜索框,宽度向左长(右边的控件不动)。Esc 清空并收回;失焦时内容为空才收回。
 * Esc 在窗口的捕获阶段先拦下:设置模态在 document 上监听 Esc,不拦的话会连设置一起关掉。
 */
export function ToolbarSearch({
  value,
  onValueChange,
  label,
  placeholder,
  clearLabel,
}: {
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  placeholder: string;
  clearLabel: string;
}) {
  const [open, setOpen] = React.useState(value !== "");
  // 只有点了按钮才聚焦;带着搜索词回到首页时只展开、不抢焦点。
  const openedByClick = React.useRef(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const expanded = open || value !== "";

  React.useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.target !== inputRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      onValueChange("");
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [expanded, onValueChange]);

  return (
    <div
      className={cn(
        "flex h-8 justify-end overflow-hidden transition-[width] duration-(--ds-duration-base) ease-(--ds-ease-soft) motion-reduce:transition-none",
        expanded ? "w-60 max-w-[50vw]" : "w-8",
      )}
    >
      {expanded ? (
        <SearchInput
          ref={inputRef}
          autoFocus={openedByClick.current}
          value={value}
          onValueChange={onValueChange}
          onBlur={() => {
            if (!value) setOpen(false);
          }}
          placeholder={placeholder}
          aria-label={label}
          clearLabel={clearLabel}
          className="w-full min-w-0 animate-in fade-in-0 duration-(--ds-duration-base) motion-reduce:animate-none"
        />
      ) : (
        <ToolbarIconButton
          label={label}
          onClick={() => {
            openedByClick.current = true;
            setOpen(true);
          }}
        >
          <Search />
        </ToolbarIconButton>
      )}
    </div>
  );
}

const STATUS_TONES: Record<PluginStatus, "danger" | "neutral" | "brand"> = {
  missing: "danger",
  load_failed: "danger",
  disabled: "neutral",
  update: "brand",
};

/** 状态徽标,最多显示 max 个(按严重程度,见 pluginStatuses)。 */
export function PluginStatusBadges({ statuses, max = 2 }: { statuses: readonly PluginStatus[]; max?: number }) {
  const { t } = useTranslation();
  return (
    <>
      {statuses.slice(0, max).map((status) => (
        <StatusBadge key={status} tone={STATUS_TONES[status]}>
          {t(`settings:plugins.status.${status}`)}
        </StatusBadge>
      ))}
    </>
  );
}

/** 相对时间,悬停看绝对时间;时间缺省或解析不了时不显示。 */
export function RelativeTime({ at, className }: { at: string | undefined; className?: string }) {
  const { t } = useTranslation();
  if (!at || Number.isNaN(Date.parse(at))) return null;
  return (
    <time dateTime={at} title={formatAbsoluteTime(at)} className={cn("shrink-0 text-xs text-[var(--ds-text-tertiary)]", className)}>
      {formatRelativeTime(at, t)}
    </time>
  );
}

/** 包里的 README:默认收起到 320px、底部渐隐 +「展开全文」;内容不够高时原样显示。第一块不留上边距,与旁边的信息卡顶对齐。 */
export function ReadmeBlock({ content }: { content: string }) {
  const { t } = useTranslation();
  const ref = React.useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  // 收起态(限高)下量:正文比限高还高才算溢出;展开后不再量,按钮保持「收起」。量的是里面正文的高度(overflow: clip 不是
  // 滚动容器,不拿 scrollHeight);图片晚到会撑高正文,所以两层都盯。
  React.useLayoutEffect(() => {
    const node = ref.current;
    const body = node?.firstElementChild as HTMLElement | null | undefined;
    if (!node || !body || expanded) return;
    const measure = () => setOverflows(body.offsetHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observer.observe(body);
    return () => observer.disconnect();
  }, [content, expanded]);
  return (
    <div>
      <div
        ref={ref}
        className={cn(
          // overflow-clip 而不是 hidden:hidden 会自成格式化上下文,整块正文缩在信息卡左边一窄条,不绕排。
          // 正文的标题与配图段带着非分层的上边距(markdown.css),工具类要加 ! 才压得过。
          // 带框线的块(二级标题的下划线、分隔线、脚注的上框)与配图段在卡片旁边时整体变窄让开,不伸到卡片底下;
          // 配图段变窄后图片按变窄的宽度缩,不会因为放不下被挤到卡片下面、在左边留出一大块空白。代码块与表格本来就是独立的
          // 格式化上下文,会自己让开;代码块带着 w-full,要改回 auto 才肯在卡片旁边变窄,不然整块被推到卡片下面。
          "overflow-clip text-sm text-[var(--ds-text-primary)] [&_.markdown>*>:first-child]:mt-0!",
          "[&_.markdown>*>:is(h2,hr,p:has(img),div:has(img),.footnotes)]:flow-root [&_.code-block]:w-auto",
          !expanded && "max-h-80",
          !expanded && overflows && "[mask-image:linear-gradient(to_bottom,black_70%,transparent)]",
        )}
      >
        <Markdown content={content} className="message-markdown" />
      </div>
      {overflows ? (
        <Button type="button" variant="ghost" size="compact" className="mt-1 -ml-2.5" onClick={() => setExpanded(!expanded)}>
          {t(expanded ? "settings:plugins.collapse_readme" : "settings:plugins.expand_readme")}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * 「说明」:小标题占整宽一行;信息卡浮在右上,正文从它左边排起,过了卡片的高度铺满整宽。内容区窄于 40rem 时卡片在上、
 * 正文在下。正文里各块怎么让开卡片见 ReadmeBlock;别的块要是带框线或底色,自己加 flow-root(整体变窄,不伸到卡片底下)。
 */
export function ReadmeWithInfo({ info, children }: { info: React.ReactNode; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-[var(--ds-text-secondary)]">{t("settings:plugins.readme_title")}</h3>
      <div className="flow-root">
        {/* relative z-[1]:README 收起时的渐隐遮罩自成层叠上下文,它的盒子伸到卡片底下;卡片得压在上面,链接才点得到。 */}
        <div className="relative z-[1] mb-6 @min-[40rem]:float-right @min-[40rem]:mb-4 @min-[40rem]:ml-6 @min-[40rem]:w-64">{info}</div>
        <div className="space-y-6">{children}</div>
      </div>
    </div>
  );
}

/** 信息卡的外框与标题;行用 InfoRow。 */
export function InfoCard({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <aside className="rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] bg-[var(--ds-surface-100)] px-4 py-3">
      <h3 className="pb-1 text-xs font-semibold text-[var(--ds-text-secondary)]">{t("settings:plugins.info_title")}</h3>
      <dl className="divide-y divide-[var(--ds-divider)]">{children}</dl>
    </aside>
  );
}

/** 信息卡的一行:左标签、右内容。放在 <dl> 里。 */
export function InfoRow({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5 text-xs">
      <dt className="w-14 shrink-0 text-[var(--ds-text-tertiary)]">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-[var(--ds-text-primary)]">{children}</dd>
    </div>
  );
}

/** 页签内容回来前的三行骨架。flow-root:放在信息卡旁边时整体变窄,骨架条不伸到卡片底下。 */
export function PanelSkeleton() {
  return (
    <div className="flow-root space-y-2.5 py-1" aria-hidden>
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

export async function copyText(text: string): Promise<void> {
  try {
    await copyTextToClipboard(text);
    toast.success(i18n.t("settings:plugins.copied"));
  } catch (error) {
    toast.error(extractErrorMessage(error, i18n.t("settings:plugins.action_failed")));
  }
}
