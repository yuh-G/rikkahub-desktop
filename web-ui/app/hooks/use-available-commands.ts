// hooks/use-available-commands.ts — 斜杠指令:可用清单获取
//
// 可用性由服务端权威判定(GET /api/commands,引擎路由材料在服务端;方案 §3.3),
// 前端只消费。清单含通用指令与引擎特色指令(插件指令、引擎自带指令,方案 §5.9)。新对话页(第一条消息发出前会话还不
// 存在)也取:带上所在的工作区与左下角改过的插件选择,服务端按「此刻新建的会话」判。切会话、插件记录、当前助手变化时
// 重取;取失败按空清单处理(指令面整体关闭,不打扰输入)。

import * as React from "react";

import type { SlashCommandDto } from "~/lib/slash-commands";
import api from "~/services/api";
import { useSettingsStore } from "~/stores/app-store";

const EMPTY: SlashCommandDto[] = [];

/** 新对话页的环境:工作区(null = 对话模式)与左下角改过的插件选择(没改过为 undefined,服务端取助手的默认)。 */
export interface DraftCommandScope {
  workspaceId: string | null;
  enginePluginIds?: string[];
}

export function commandsQuery(conversationId: string | null, draft: DraftCommandScope): string {
  if (conversationId) return `conversationId=${encodeURIComponent(conversationId)}`;
  const params = new URLSearchParams();
  if (draft.workspaceId) params.set("workspaceId", draft.workspaceId);
  if (draft.enginePluginIds) params.set("enginePluginIds", JSON.stringify(draft.enginePluginIds));
  return params.toString();
}

export function useAvailableCommands(conversationId: string | null, draft: DraftCommandScope): SlashCommandDto[] {
  const [commands, setCommands] = React.useState<SlashCommandDto[]>(EMPTY);
  // 装/卸/开关插件、换助手(新对话按当前助手的默认插件)后插件指令会变,借它们当重取信号。设置快照每次推送都是新对象,
  // 所以折成字符串比较,别的设置变化不触发重取。
  const pluginsKey = useSettingsStore((state) => {
    const settings = state.settings;
    const assistant = settings?.assistants.find((item) => item.id === settings.assistantId);
    return JSON.stringify([settings?.enginePlugins ?? [], settings?.assistantId ?? null, assistant?.enginePluginIds ?? []]);
  });
  const query = commandsQuery(conversationId, draft);

  React.useEffect(() => {
    let cancelled = false;
    api
      .get<{ commands?: SlashCommandDto[] }>(query ? `commands?${query}` : "commands")
      .then((result) => {
        if (!cancelled) setCommands(result.commands ?? EMPTY);
      })
      .catch(() => {
        if (!cancelled) setCommands(EMPTY);
      });
    return () => {
      cancelled = true;
    };
  }, [query, pluginsKey]);

  return commands;
}
