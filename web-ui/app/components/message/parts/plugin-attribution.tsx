// 插件署名(方案 P6.3):工具卡与插件界面上的「来自插件 X」,D14 的「被插件 X 拒绝:原因」+ 跳到该插件的开关。
// 工具卡的数据挂在 metadata.attribution(P6.1,事件桥写入);插件显示名取设置里的插件记录。
import { ArrowUpRight, Puzzle, ShieldBan } from "lucide-react";
import { useTranslation } from "react-i18next";

import { settingsPageKey } from "~/components/settings/settings-nav";
import { pluginDisplayName } from "~/components/settings/extensions/plugins/model";
import i18n from "~/i18n";
import { cn } from "~/lib/utils";
import { useSettingsStore } from "~/stores/app-store";
import { openPluginDetail } from "~/stores/plugins-view-store";
import { requestSettingsFocus } from "~/stores/settings-dialog-store";
import type { ToolCardAttribution, ToolPart } from "~/types";

type Veto = NonNullable<ToolCardAttribution["blockedBy"]>;

/** 读工具卡的署名;没有或形状不对返回 null(落库数据按不可信解析)。 */
export function readToolAttribution(tool: Pick<ToolPart, "metadata">): ToolCardAttribution | null {
  const raw = tool.metadata?.attribution;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { pluginId, blockedBy } = raw as Record<string, unknown>;
  const veto = blockedBy && typeof blockedBy === "object" && !Array.isArray(blockedBy) ? (blockedBy as Record<string, unknown>) : null;
  const result: ToolCardAttribution = {
    ...(typeof pluginId === "string" && pluginId ? { pluginId } : {}),
    ...(veto && typeof veto.pluginId === "string" && veto.pluginId
      ? { blockedBy: { pluginId: veto.pluginId, reason: typeof veto.reason === "string" ? veto.reason.trim() : "" } }
      : {}),
  };
  return result.pluginId || result.blockedBy ? result : null;
}

/** 插件显示名;id 为空串(认领不到来源)时返回空串。 */
export function usePluginName(pluginId: string): string {
  const records = useSettingsStore((state) => state.settings?.enginePlugins);
  return pluginId ? pluginDisplayName(records, pluginId) : "";
}

/** 「来自插件 X」的文案;认领不到来源时只写「来自插件」。 */
export function usePluginFromLabel(pluginId: string): string {
  const { t } = useTranslation("message");
  const name = usePluginName(pluginId);
  return name ? t("plugin.from", { plugin: name }) : t("plugin.from_unknown");
}

/** D14 的跳转:打开否决方的插件详情,定位并闪烁「允许这个插件拦截工具调用」开关(在高级设置里,替用户展开)。 */
export function openPluginVetoSwitch(pluginId: string): void {
  openPluginDetail(pluginId, "overview");
  requestSettingsFocus({
    page: settingsPageKey("extensions", "plugins"),
    title: i18n.t("settings:plugins.hook_tool_call"),
    advanced: true,
    // 已停在这个插件详情的别的页签上时深链不动栈,要先切回概览。
    tab: i18n.t("settings:plugins.tab_overview"),
  });
}

/** 「来自插件 X」:纯文字,可以放进整行可点的步骤行里(不嵌套交互元素)。 */
export function PluginSourceTag({ pluginId, className }: { pluginId: string; className?: string }) {
  const label = usePluginFromLabel(pluginId);
  return (
    <span className={cn("inline-flex min-w-0 max-w-40 items-center gap-1 text-mini text-muted-foreground", className)} title={label}>
      <Puzzle className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  );
}

/** 「来自插件 X ↗」:点开插件详情;认领不到来源时退成不可点的文字。 */
export function PluginSourceLink({ pluginId }: { pluginId: string }) {
  const { t } = useTranslation("message");
  const label = usePluginFromLabel(pluginId);
  if (!pluginId) return <p className="text-xs text-muted-foreground">{label}</p>;
  return (
    <button
      type="button"
      onClick={() => openPluginDetail(pluginId)}
      title={t("plugin.open")}
      className="inline-flex max-w-full items-center gap-0.5 rounded text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span className="truncate">{label}</span>
      <ArrowUpRight className="size-3 shrink-0" aria-hidden />
    </button>
  );
}

/** 「被插件 X 拒绝:原因」+「插件设置」入口。入口是按钮,放在步骤行之外。 */
export function PluginVetoNotice({ veto, className }: { veto: Veto; className?: string }) {
  const { t } = useTranslation("message");
  const plugin = usePluginName(veto.pluginId);
  return (
    <div className={cn("flex flex-wrap items-start gap-x-2.5 gap-y-1 text-xs", className)}>
      <span className="inline-flex min-w-0 items-start gap-1.5 text-destructive">
        <ShieldBan className="mt-px size-3.5 shrink-0" aria-hidden />
        <span className="whitespace-pre-wrap break-words">
          {veto.reason ? t("plugin.blocked", { plugin, reason: veto.reason }) : t("plugin.blocked_no_reason", { plugin })}
        </span>
      </span>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          openPluginVetoSwitch(veto.pluginId);
        }}
        title={t("plugin.settings_hint")}
        className="inline-flex shrink-0 items-center gap-0.5 rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {t("plugin.settings")}
        <ArrowUpRight className="size-3" aria-hidden />
      </button>
    </div>
  );
}
