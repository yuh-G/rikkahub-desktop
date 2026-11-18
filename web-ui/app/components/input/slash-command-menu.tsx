// input/slash-command-menu.tsx — 斜杠指令:推荐列表浮层 + 输入框指令染色镜像层
//
// 方案 tmp_doc/指令体系方案-2026-09-05.md §4.2/§4.3:
// - 列表锚定输入卡片上方(bottom-full),视觉与现有 Popover 同 token,不新造动效语言;
//   键盘导航由 use-slash-command 状态机负责,本组件纯展示 + 鼠标交互。
// - 按来源分组(方案 §5.9 / D17):通用 / 引擎 / 各插件,不止一组时才出组标题;重名的插件指令写成
//   name:<插件短名>,短名部分淡显。通用指令的说明走 i18n,引擎特色指令显示它自带的说明原文。
// - 染色用 backdrop 镜像层:textarea 无法富文本染色,命中完整指令时把 textarea
//   文字置透明(caret 保留),下层镜像 div 以完全相同的度量渲染文本,指令 token
//   染 --command(编辑器代码蓝,深浅主题共用,拍板 2026-09-05)。
//   度量 class 单源:TEXTAREA_METRICS 同时供 chat-input 的 Textarea 与镜像层使用,
//   杜绝两处漂移导致的字符错位(方案 §4.3 风险对策)。

import * as React from "react";

import { Puzzle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { usePluginName } from "~/components/message/parts/plugin-attribution";
import { cn } from "~/lib/utils";
import { groupSlashCommands, type SlashCommandDto } from "~/lib/slash-commands";

/** 输入框文本度量(影响字形排布的全部类,镜像层与 Textarea 共用单源)。
 *  组成:chat-input 对 ui/Textarea 的覆盖(p-2 text-sm)+ 基础组件中参与度量的
 *  w-full 与 md 字号档。行高继承 text-sm,两层同 class 组合必然同结果。 */
export const TEXTAREA_METRICS = "w-full p-2 text-sm md:text-compact";

export interface SlashCommandMenuProps {
  /** aria-controls 对齐用(textarea 侧标注)。 */
  id: string;
  /** 已按分组排好的过滤结果(filterSlashCommands 的产物,与键盘导航同序)。 */
  commands: readonly SlashCommandDto[];
  selectedIndex: number;
  /** 当前过滤词(小写),用于条目内匹配段加粗。 */
  query: string;
  onHover: (index: number) => void;
  onPick: (command: SlashCommandDto) => void;
}

export function slashOptionId(menuId: string, command: SlashCommandDto): string {
  return `${menuId}-option-${command.invocation}`;
}

/** 指令写法渲染:匹配段加粗染色,限定写法的 :<插件短名> 淡显。 */
function CommandName({ command, query }: { command: SlashCommandDto; query: string }) {
  const text = command.invocation;
  const base = text.startsWith(`${command.name}:`) ? command.name.length : text.length;
  const start = query ? text.toLowerCase().indexOf(query) : -1;
  const end = start < 0 ? -1 : start + query.length;
  const cuts = [...new Set([0, base, text.length, ...(start < 0 ? [] : [start, end])])].sort((a, b) => a - b);
  return (
    <span className="shrink-0 font-medium">
      /
      {cuts.slice(0, -1).map((from, index) => {
        const to = cuts[index + 1]!;
        const hit = start >= 0 && from >= start && to <= end;
        return (
          <span
            key={from}
            className={cn(hit && "font-semibold text-[var(--command)]", !hit && from >= base && "font-normal text-muted-foreground")}
          >
            {text.slice(from, to)}
          </span>
        );
      })}
    </span>
  );
}

function PluginGroupLabel({ pluginId }: { pluginId: string }) {
  const name = usePluginName(pluginId);
  return (
    <>
      <Puzzle className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{name}</span>
    </>
  );
}

function GroupLabel({ id, source }: { id: string; source: SlashCommandDto["source"] }) {
  const { t } = useTranslation("input");
  return (
    <div id={id} className="flex items-center gap-1 px-2 pt-1.5 pb-1 text-mini font-medium text-muted-foreground">
      {source === "app" ? (
        t("commands.group_app")
      ) : source === "engine" ? (
        t("commands.group_engine")
      ) : (
        <PluginGroupLabel pluginId={source.slice("plugin:".length)} />
      )}
    </div>
  );
}

export function SlashCommandMenu({ id, commands, selectedIndex, query, onHover, onPick }: SlashCommandMenuProps) {
  const { t } = useTranslation("input");
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const groups = React.useMemo(() => groupSlashCommands(commands), [commands]);

  // 键盘上下移动时把选中项滚进视野(清单比浮层高时)。
  React.useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, commands]);

  if (commands.length === 0) return null;
  let index = -1;
  return (
    <div
      id={id}
      role="listbox"
      aria-label={t("commands.menu_label")}
      className="absolute bottom-full left-0 z-20 mb-2 w-full max-w-[420px] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
    >
      <div ref={listRef} className="max-h-[280px] overflow-y-auto p-1">
        {groups.map((group, groupIndex) => (
          <div
            key={group.source}
            role="group"
            aria-labelledby={groups.length > 1 ? `${id}-group-${groupIndex}` : undefined}
            className={cn(groupIndex > 0 && "mt-1 border-t border-border/60 pt-1")}
          >
            {groups.length > 1 ? <GroupLabel id={`${id}-group-${groupIndex}`} source={group.source} /> : null}
            {group.commands.map((command) => {
              index += 1;
              const itemIndex = index;
              const active = itemIndex === selectedIndex;
              const app = command.source === "app";
              const hint = app && command.hasArgument ? t(`commands.${command.name}.argument_hint`, { defaultValue: "" }) : "";
              const description = app ? t(`commands.${command.name}.description`, { defaultValue: "" }) : (command.description ?? "");
              return (
                <button
                  key={command.invocation}
                  id={slashOptionId(id, command)}
                  role="option"
                  aria-selected={active}
                  type="button"
                  title={description || undefined}
                  className={cn(
                    "flex w-full items-baseline gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none",
                    active && "bg-accent text-accent-foreground",
                  )}
                  onMouseEnter={() => onHover(itemIndex)}
                  // onMouseDown 抢在 textarea blur 之前完成补全,避免焦点抖动。
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onPick(command);
                  }}
                >
                  <CommandName command={command} query={query} />
                  {hint ? <span className="shrink-0 text-xs text-muted-foreground">{hint}</span> : null}
                  {description ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{description}</span> : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export interface CommandHighlightOverlayProps {
  text: string;
  /** 指令 token 长度(含斜杠;parseSlashCommand 命中产物)。 */
  tokenLength: number;
}

/** 染色镜像层:绝对定位铺满输入区包装层(高度由 textarea 撑起,inset-0 自动重合),
 *  以与 textarea 完全相同的度量渲染文本,指令段染 --command 色。挂载条件(命中
 *  完整指令且非 IME 组合中)由 chat-input 控制;滚动同步经 ref 由 onScroll 驱动。 */
export const CommandHighlightOverlay = React.forwardRef<HTMLDivElement, CommandHighlightOverlayProps>(
  function CommandHighlightOverlay({ text, tokenLength }, ref) {
    return (
      <div
        ref={ref}
        aria-hidden
        className={cn(
          TEXTAREA_METRICS,
          "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-[var(--ds-text-primary)]",
        )}
      >
        <span className="text-[var(--command)]">{text.slice(0, tokenLength)}</span>
        {text.slice(tokenLength)}
      </div>
    );
  },
);
