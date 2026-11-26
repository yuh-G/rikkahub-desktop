// 插件使用说明(P7.3.2):信任模型、哪些部分不生效、联网搜索类插件、审批、插件的数据、引擎进程与重启提示。
// 入口在插件首页标题下与详情概览的「在哪里用」。文案在 settings:plugins.guide.*,界面上的名字用 $t() 引用原文案,
// 改了按钮名这里跟着变;说明里的时长与次数对照引擎监管器的取值,由 tests/plugin-guide.test.tsx 锁住。
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { cn } from "~/lib/utils";

/** 节 → 条目,顺序即显示顺序。键与 settings:plugins.guide.<节>.<条目> 一一对应(测试双向核对)。 */
export const PLUGIN_GUIDE_SECTIONS = [
  { id: "trust", items: ["code", "process", "sources"] },
  { id: "use", items: ["enable", "workspace_only", "changes"] },
  { id: "overlap", items: ["app_owned", "mcp", "terminal", "background", "resources", "same_name", "where"] },
  { id: "search", items: ["coexist", "turn_off"] },
  { id: "approval", items: ["preset", "always_allow", "mcp_switch", "sub_tasks", "hook"] },
  { id: "data", items: ["home", "backup"] },
  { id: "engine", items: ["process", "unresponsive", "crashed", "gave_up", "where"] },
] as const;

export function PluginGuideContent() {
  const { t } = useTranslation();
  return (
    <div className="space-y-5">
      {PLUGIN_GUIDE_SECTIONS.map((section) => (
        <section key={section.id} className="space-y-1.5">
          <h3 className="text-sm font-semibold text-[var(--ds-text-primary)]">
            {t(`settings:plugins.guide.${section.id}.title`)}
          </h3>
          <ul className="list-disc space-y-1 pl-4 text-sm leading-relaxed text-[var(--ds-text-secondary)]">
            {section.items.map((item) => (
              <li key={item}>{t(`settings:plugins.guide.${section.id}.${item}`)}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function PluginGuideDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] grid-rows-[auto_minmax(0,1fr)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("settings:plugins.guide.title")}</DialogTitle>
          <DialogDescription>{t("settings:plugins.guide.intro")}</DialogDescription>
        </DialogHeader>
        <div className="-mr-6 overflow-y-auto pr-6">
          <PluginGuideContent />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 文字链样式的入口,自带弹窗。 */
export function PluginGuideLink({ className }: { className?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        className={cn("text-xs text-[var(--ds-brand-primary)] underline-offset-2 hover:underline", className)}
        onClick={() => setOpen(true)}
      >
        {t("settings:plugins.guide_entry")}
      </button>
      <PluginGuideDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
