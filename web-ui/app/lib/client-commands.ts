// lib/client-commands.ts — 入口类通用指令的前端执行器表(方案 §5.9 / D18)
//
// 名单单源在服务端叶子模块(@server/commands/client-commands),注册表里 executionTarget 为 client 的行与它一一对应;
// 这里按名单建执行器,Record<ClientCommandName, …> 漏一个编译不过,多一个由 tests/client-commands.test.ts 抓。
// 每个执行器调界面上对应按钮的同一个处理函数(由会话窗格以 deps 交进来),自己不另写一套。

import type { ClientCommandName } from "@server/commands/client-commands";

/** 输入框里能被指令打开的选择器:右下角的模型菜单(thinking = 顺带展开思考强度子菜单),左下角「MCP 与拓展」的两个页签。 */
export type ComposerPicker = "model" | "thinking" | "mcp" | "skills";

/** 打开选择器的请求:seq 每次递增,选择器见到新的 seq 才动(重挂载时不会被旧请求再打开一次)。 */
export interface ComposerPickerRequest {
  picker: ComposerPicker;
  seq: number;
}

/** 敲指令的那个输入框交给执行器的能力。 */
export interface SlashCommandComposer {
  openPicker: (picker: ComposerPicker) => void;
}

/** 返回 false = 未受理,输入框回填原文;void = 已受理。 */
export type SlashCommandExecutor = (argument: string, composer: SlashCommandComposer) => Promise<boolean | void> | boolean | void;

export interface ClientCommandDeps {
  /** 侧栏「新建对话」。 */
  newConversation: () => void;
  /** 会话标题的手动编辑(重命名弹窗)。 */
  renameConversation: () => void;
  /** 打开设置(回到上次停留的位置)。 */
  openSettings: () => void;
  /** 最新一条回复下的「创建分叉」;没有回复可分叉、或没分成时返回 false。 */
  forkLatestReply: () => Promise<boolean | void>;
}

export function createClientCommandExecutors(deps: ClientCommandDeps): Record<ClientCommandName, SlashCommandExecutor> {
  return {
    new: () => deps.newConversation(),
    fork: () => deps.forkLatestReply(),
    name: () => deps.renameConversation(),
    model: (_argument, composer) => composer.openPicker("model"),
    thinking: (_argument, composer) => composer.openPicker("thinking"),
    mcp: (_argument, composer) => composer.openPicker("mcp"),
    skill: (_argument, composer) => composer.openPicker("skills"),
    settings: () => deps.openSettings(),
  };
}
