// 输入框左下角「拓展」(D19,方案 §5.12):这里的开关只写当前会话(新会话发出前写草稿,见
// useExtensionSelection)。页签来自拓展类别表,列表组件与助手的「拓展管理」弹窗共用;徽标 = 各类已选且
// 此刻可用的条目数之和。插件只对工作区会话生效,所在列是聊天时「插件」页签只给一句说明、不计数。

import * as React from "react";
import { ExternalLink, PackageIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { usePaneContainer } from "~/components/workspace/pane-container-context";
import { usePickerPopover } from "~/hooks/use-picker-popover";
import type { ComposerPickerRequest } from "~/lib/client-commands";
import { extractErrorMessage } from "~/lib/error";
import { cn } from "~/lib/utils";
import { CHAT_CONTAINER } from "~/stores/container-tabs-store";
import type { Settings } from "~/types";
import { Button } from "~/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { SettingsLink, openSettings } from "~/components/settings/settings-link";
import { EXTENSION_CATEGORIES, type ExtensionCategoryId } from "~/components/settings/extensions/categories";
import {
  AVAILABLE_COUNTS,
  SELECTION_COUNTS,
  SELECTION_LISTS,
  useSkillSummaries,
} from "~/components/settings/extensions/selection-lists";
import type { ExtensionSelection } from "@server/assistants/extension-selection";

import { PickerErrorAlert } from "./picker-error-alert";

export interface ExtensionPickerButtonProps {
  settings: Settings | null;
  selection: ExtensionSelection;
  onChange: (patch: Partial<ExtensionSelection>) => Promise<void>;
  /** 选择的数据源已就绪(会话快照已到 / 新会话有草稿键)。 */
  ready: boolean;
  disabled?: boolean;
  /** /mcp、/skill 指令打开到对应页签的请求。 */
  openRequest?: ComposerPickerRequest | null;
  className?: string;
}

function ExtensionPickerButtonImpl({
  settings,
  selection,
  onChange,
  ready,
  disabled = false,
  openRequest,
  className,
}: ExtensionPickerButtonProps) {
  const { t } = useTranslation("input");
  const navigate = useNavigate();
  const canUse = Boolean(settings && ready && !disabled);
  const { open, setOpen, error, setError, popoverProps } = usePickerPopover(canUse);
  // 每次打开重拉技能目录,拿到刚在技能页新建的。
  const [openCount, setOpenCount] = React.useState(0);
  React.useEffect(() => {
    if (open) setOpenCount((count) => count + 1);
  }, [open]);
  const skills = useSkillSummaries(Boolean(settings), openCount);
  const [tab, setTab] = React.useState<ExtensionCategoryId | null>(null);
  const chatConversation = usePaneContainer() === CHAT_CONTAINER;

  // 只认新来的请求(重挂载不重放)。一类可选的都没有时按钮不出现,改去设置里对应的拓展页,入口不落空。
  const handledRequest = React.useRef(openRequest?.seq ?? 0);
  React.useEffect(() => {
    if (!openRequest || openRequest.seq === handledRequest.current) return;
    handledRequest.current = openRequest.seq;
    const target = openRequest.picker;
    if (target !== "mcp" && target !== "skills") return;
    const shown =
      settings !== null &&
      EXTENSION_CATEGORIES.some((item) => AVAILABLE_COUNTS[item.id]({ settings, skills, chatConversation }) > 0);
    if (!canUse || !shown) {
      openSettings(navigate, `?section=extensions&sub=${target}`);
      return;
    }
    setTab(target);
    setOpen(true);
  }, [canUse, chatConversation, navigate, openRequest, setOpen, settings, skills]);

  if (!settings) return null;
  const available = Object.fromEntries(
    EXTENSION_CATEGORIES.map((item) => [item.id, AVAILABLE_COUNTS[item.id]({ settings, skills, chatConversation })]),
  ) as Record<ExtensionCategoryId, number>;
  // 一类都没有可选的条目时不出现(入口在拓展页);否则打开时停在用户上次看的页签,初次落在第一个有内容的。
  const firstAvailable = EXTENSION_CATEGORIES.find((item) => available[item.id] > 0)?.id;
  if (!firstAvailable) return null;
  const activeTab = tab ?? firstAvailable;
  const selectedCount = EXTENSION_CATEGORIES.reduce(
    (sum, item) => sum + SELECTION_COUNTS[item.id]({ settings, skills, selection, chatConversation }),
    0,
  );
  const List = SELECTION_LISTS[activeTab];
  const handleChange = (patch: Partial<ExtensionSelection>) => {
    setError(null);
    onChange(patch).catch((updateError) => setError(extractErrorMessage(updateError, t("integrations.update_failed"))));
  };

  return (
    <Popover {...popoverProps}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!canUse}
          aria-label={t("integrations.title")}
          className={cn(
            "h-8 rounded-full px-2 text-muted-foreground hover:text-foreground",
            selectedCount > 0 && "text-primary hover:bg-primary/10",
            className,
          )}
        >
          <PackageIcon className="size-4" />
          {selectedCount > 0 ? (
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-micro text-primary">{selectedCount}</span>
          ) : null}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-[min(92vw,28rem)] gap-0 p-0">
        <PopoverHeader className="px-5 pt-4 pb-2">
          <PopoverTitle>{t("integrations.title")}</PopoverTitle>
          <PopoverDescription>{t("integrations.description")}</PopoverDescription>
        </PopoverHeader>

        <div role="tablist" className="flex overflow-x-auto border-b px-3">
          {EXTENSION_CATEGORIES.map((item) => {
            const count = SELECTION_COUNTS[item.id]({ settings, skills, selection, chatConversation });
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(item.id)}
                className={cn(
                  "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2 text-xs whitespace-nowrap transition",
                  active
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {t(item.labelKey)}
                {count > 0 ? (
                  <span className="rounded-full bg-primary/10 px-1.5 text-micro leading-4 text-primary">{count}</span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="space-y-3 px-4 py-3">
          <PickerErrorAlert error={error} />
          <ScrollArea className="max-h-[min(50vh,22rem)] [&>[data-slot=scroll-area-viewport]]:max-h-[inherit]">
            <div role="tabpanel" className="pr-3">
              <List
                settings={settings}
                skills={skills}
                selection={selection}
                onChange={handleChange}
                disabled={!canUse}
                chatConversation={chatConversation}
                onNavigate={() => popoverProps.onOpenChange(false)}
              />
            </div>
          </ScrollArea>
        </div>

        <div className="flex justify-end border-t px-3 py-2">
          <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
            <SettingsLink
              search={`?section=extensions&sub=${activeTab}`}
              onClick={() => popoverProps.onOpenChange(false)}
            >
              <ExternalLink className="size-3.5" />
              {t("integrations.manage")}
            </SettingsLink>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// memo:打字时 ChatInput 每键重渲染,这里的入参(设置、选择、回调)不变就跳过。
export const ExtensionPickerButton = React.memo(ExtensionPickerButtonImpl);
