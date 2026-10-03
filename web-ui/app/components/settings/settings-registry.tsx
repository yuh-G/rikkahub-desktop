// 页键 → 页面组件的映射。与 settings-nav.ts 同属"设置页结构层",分两个文件是
// 有意的:nav 表保持零组件依赖(可被非 UI 模块安全引用),本文件才把 React 树拖进来。
//
// 键类型用 `Record<SettingsPageKey, …>`(页键由 nav 表推导)——表里加了一页却忘了挂
// 组件时,typecheck 当场报缺键,不会留到运行时白屏。
import * as React from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { AboutSection, DonateSection } from "~/components/settings/about";
import { AssistantsSection } from "~/components/settings/assistants";
import { BackupSection, WebServiceSection } from "~/components/settings/data";
import { DefaultModelsSection } from "~/components/settings/default-models";
import { McpSection } from "~/components/settings/extensions/mcp";
import { PromptInjectionSection } from "~/components/settings/extensions/injection";
import { QuickMessagesSection } from "~/components/settings/extensions/quick-messages";
import { SkillsSection } from "~/components/settings/extensions/skills";
import { AppSection, AppearanceSection, ProfileSection, ShortcutsSection } from "~/components/settings/general";
import { LogsSection, type RequestLog } from "~/components/settings/logs";
import { PortRequestSection, ProxySection } from "~/components/settings/proxy";
import { ProvidersSection } from "~/components/settings/providers";
import { SearchSection } from "~/components/settings/search";
import { AsrSection, TtsSection } from "~/components/settings/speech";
import { StatsSection, type StatsPayload } from "~/components/settings/stats";
import { MemorySection } from "~/components/memory/memory-section";
import api from "~/services/api";
import type { Settings } from "~/types";

import type { SettingsPageKey } from "./settings-nav";

/** 页面组件的统一入参。派发点因此只有一句 `<Component {...props} />`。 */
export interface SettingsSectionProps {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}

// stats 的数据不在 settings 里、由本页自取。承载形态(整页/模态)无论怎样换壳,
// 页面的数据依赖都不必外传。
function StatsSectionHost() {
  const [stats, setStats] = React.useState<StatsPayload | null>(null);
  React.useEffect(() => {
    api
      .get<StatsPayload>("stats")
      .then(setStats)
      .catch((error: Error) => toast.error(error.message));
  }, []);
  return <StatsSection stats={stats} />;
}

// logs 同理自取。清空动作退化为纯删除:二次确认收口在 LogsSection.clearVisible()
// (一次确认管请求+错误两类),这里绝不能再弹一次(双弹窗)或先删后问。
function LogsSectionHost() {
  const { t } = useTranslation();
  const [logs, setLogs] = React.useState<RequestLog[]>([]);
  React.useEffect(() => {
    api
      .get<RequestLog[]>("logs")
      .then(setLogs)
      .catch((error: Error) => toast.error(error.message));
  }, []);
  const clearLogs = React.useCallback(async () => {
    try {
      await api.delete("logs");
      setLogs([]);
      toast.success(t("settings:logs.cleared"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [t]);
  return <LogsSection logs={logs} onClear={clearLogs} />;
}

/** 无入参的页:闭包吞掉 props,函数体不进 jsx 泄漏 unused 符号。 */
function DonateSectionHost() {
  return <DonateSection />;
}
function AboutSectionHost() {
  return <AboutSection />;
}

export const SETTINGS_PAGES: Record<SettingsPageKey, React.ComponentType<SettingsSectionProps>> = {
  "general/profile": ProfileSection,
  "general/app": AppSection,
  assistants: AssistantsSection,
  "models/providers": ProvidersSection,
  "models/scenes": DefaultModelsSection,
  "network/search": SearchSection,
  "network/proxy": ProxySection,
  "network/port": PortRequestSection,
  "extensions/mcp": McpSection,
  "extensions/skills": SkillsSection,
  "extensions/injection": PromptInjectionSection,
  "extensions/quick": QuickMessagesSection,
  "personalization/appearance": AppearanceSection,
  "personalization/shortcuts": ShortcutsSection,
  "speech/tts": TtsSection,
  "speech/asr": AsrSection,
  memory: MemorySection,
  "data/backup": BackupSection,
  "data/server": WebServiceSection,
  "stats/usage": StatsSectionHost,
  "stats/logs": LogsSectionHost,
  donate: DonateSectionHost,
  about: AboutSectionHost,
};
