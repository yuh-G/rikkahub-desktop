// components/settings/assistant-extensions-dialog.tsx — 助手页「拓展管理」弹窗(D19,方案 §5.12)。
//
// 这里选的是「该助手下新会话默认开哪些拓展」。写入走助手页的草稿(该页整对象自动保存,另走绑定接口会被
// 下一次自动保存覆盖),开关即时生效,没有保存按钮。页签来自拓展类别表,列表组件与会话选择器共用。

import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { ScrollArea } from "~/components/ui/scroll-area";
import { EXTENSION_CATEGORIES, type ExtensionCategoryId } from "~/components/settings/extensions/categories";
import {
  SELECTION_COUNTS,
  SELECTION_LISTS,
  useSkillSummaries,
} from "~/components/settings/extensions/selection-lists";
import { cn } from "~/lib/utils";
import type { AssistantProfile, Settings } from "~/types";
import { type ExtensionSelection, selectionOf } from "@server/assistants/extension-selection";

export function AssistantExtensionsDialog({
  open,
  onOpenChange,
  assistant,
  settings,
  onChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assistant: AssistantProfile;
  settings: Settings;
  onChange: (patch: Partial<ExtensionSelection>) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = React.useState<ExtensionCategoryId>(EXTENSION_CATEGORIES[0].id);
  const skills = useSkillSummaries(open);
  const selection = selectionOf(assistant);
  const List = SELECTION_LISTS[tab];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("settings:assistants.extensions.title")}</DialogTitle>
          <DialogDescription>{t("settings:assistants.extensions.dialog_desc")}</DialogDescription>
        </DialogHeader>

        <div role="tablist" className="flex border-b">
          {EXTENSION_CATEGORIES.map((item) => {
            const count = SELECTION_COUNTS[item.id]({ settings, skills, selection });
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(item.id)}
                className={cn(
                  "-mb-px flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm transition",
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

        <ScrollArea className="max-h-[60vh]">
          <div role="tabpanel" className="pr-3">
            <List
              settings={settings}
              skills={skills}
              selection={selection}
              onChange={onChange}
              onNavigate={() => onOpenChange(false)}
            />
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
