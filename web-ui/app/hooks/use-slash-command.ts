// hooks/use-slash-command.ts — 斜杠指令:推荐菜单状态机
//
// 职责边界:只管「菜单开合/过滤/键盘导航/补全回写」;完整指令的拦截执行在
// chat-input 的提交路径(handlePrimaryAction)做,与本 hook 解耦。
// Enter 语义优先级(方案 §3.5):菜单打开时 Enter/Tab = 补全选中项(绝不发送),
// 由 handleMenuKeyDown 在 chat-input handleKeyDown 顶部先行消费。

import * as React from "react";

import { filterSlashCommands, slashMenuQuery, type SlashCommandDto } from "~/lib/slash-commands";

export interface UseSlashCommandOptions {
  text: string;
  commands: readonly SlashCommandDto[];
  /** 指令面总开关(生成中/未就绪/编辑历史消息/带附件等场景由调用方关闭)。 */
  enabled: boolean;
  /** 补全回写(受控 value 替换;文本变长后光标自然落尾)。 */
  onCompleteText: (text: string) => void;
}

export function useSlashCommand({ text, commands, enabled, onCompleteText }: UseSlashCommandOptions) {
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  // Esc 关闭后记住当时的过滤词:同一前缀不再自动弹出,前缀一变即恢复(方案 §4.2)。
  const [dismissedQuery, setDismissedQuery] = React.useState<string | null>(null);

  const query = enabled ? slashMenuQuery(text) : null;
  const matches = React.useMemo(
    () => (query === null ? [] : filterSlashCommands(commands, query)),
    [commands, query],
  );
  const menuOpen = query !== null && matches.length > 0 && dismissedQuery !== query;

  // 过滤结果变化后选中项归位,避免悬空索引。
  React.useEffect(() => {
    setSelectedIndex(0);
  }, [query, matches.length]);
  React.useEffect(() => {
    if (dismissedQuery !== null && dismissedQuery !== query) setDismissedQuery(null);
  }, [dismissedQuery, query]);

  const pick = React.useCallback(
    (command: SlashCommandDto) => {
      onCompleteText(command.hasArgument ? `/${command.invocation} ` : `/${command.invocation}`);
    },
    [onCompleteText],
  );

  /** 菜单键盘处理,返回 true = 事件已被菜单消费(调用方须 return,不再走发送语义)。 */
  const handleMenuKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!menuOpen) return false;
      // IME 组合中除 Escape 外不抢按键(组合期间的 Enter/方向键属于输入法)。
      if (event.nativeEvent.isComposing && event.key !== "Escape") return false;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setSelectedIndex((index) => (index + 1) % matches.length);
          return true;
        case "ArrowUp":
          event.preventDefault();
          setSelectedIndex((index) => (index - 1 + matches.length) % matches.length);
          return true;
        case "Tab":
        case "Enter": {
          event.preventDefault();
          const command = matches[selectedIndex] ?? matches[0];
          if (command) pick(command);
          return true;
        }
        case "Escape":
          event.preventDefault();
          setDismissedQuery(query);
          return true;
        default:
          return false;
      }
    },
    [matches, menuOpen, pick, query, selectedIndex],
  );

  return { menuOpen, matches, selectedIndex, setSelectedIndex, query: query ?? "", pick, handleMenuKeyDown };
}
