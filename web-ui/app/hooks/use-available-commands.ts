// hooks/use-available-commands.ts — 斜杠指令:可用清单获取
//
// 可用性由服务端权威判定(GET /api/commands,引擎路由材料在服务端;方案 §3.3),
// 前端只消费。清单含通用指令与引擎特色指令(插件指令、引擎自带指令,方案 §5.9)。切会话、插件记录变化时
// 重取;取失败按空清单处理(指令面整体关闭,不打扰输入)。

import * as React from "react";

import type { SlashCommandDto } from "~/lib/slash-commands";
import api from "~/services/api";
import { useSettingsStore } from "~/stores/app-store";

const EMPTY: SlashCommandDto[] = [];

export function useAvailableCommands(conversationId: string | null): SlashCommandDto[] {
  const [commands, setCommands] = React.useState<SlashCommandDto[]>(EMPTY);
  // 装/卸/开关插件后插件记录会变,借它当重取信号(插件指令随之增减)。设置快照每次推送都是新对象,
  // 所以折成字符串比较,别的设置变化不触发重取。
  const pluginsKey = useSettingsStore((state) => JSON.stringify(state.settings?.enginePlugins ?? []));

  React.useEffect(() => {
    if (!conversationId) {
      setCommands(EMPTY);
      return;
    }
    let cancelled = false;
    api
      .get<{ commands?: SlashCommandDto[] }>(`commands?conversationId=${encodeURIComponent(conversationId)}`)
      .then((result) => {
        if (!cancelled) setCommands(result.commands ?? EMPTY);
      })
      .catch(() => {
        if (!cancelled) setCommands(EMPTY);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, pluginsKey]);

  return commands;
}
