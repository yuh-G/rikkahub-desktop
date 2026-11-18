// slash-command-menu.test.tsx — 斜杠指令菜单:按来源分组的组标题、插件显示名、引擎特色指令的说明原文、限定写法淡显(P6.4)。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SlashCommandMenu } from "~/components/input/slash-command-menu";
import i18n from "~/i18n";
import { filterSlashCommands, type SlashCommandDto } from "~/lib/slash-commands";
import { useAppStore } from "~/stores/app-store";
import type { Settings } from "~/types";

// 静态渲染读的是 store 的初始状态,插件记录要写进初始状态对象;跑完还原。
const initial = useAppStore.getInitialState();
const before = initial.settings;
afterAll(() => {
  initial.settings = before;
});

const app = (name: string, hasArgument = false): SlashCommandDto => ({ name, hasArgument, executionTarget: "client", source: "app", invocation: name });
const plugin = (name: string, invocation: string, description?: string): SlashCommandDto => ({
  name,
  hasArgument: true,
  executionTarget: "engine",
  source: "plugin:pi:todo-pkg",
  invocation,
  commandId: name,
  ...(description ? { description } : {}),
});

const render = (commands: SlashCommandDto[], query = "") =>
  renderToStaticMarkup(
    React.createElement(SlashCommandMenu, { id: "m", commands, selectedIndex: 0, query, onHover: () => undefined, onPick: () => undefined }),
  );

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  const settings = { enginePlugins: [{ id: "pi:todo-pkg", name: "待办" }] } as unknown as Settings;
  initial.settings = settings;
  useAppStore.setState({ settings });
});

describe("斜杠指令菜单", () => {
  test("只有通用指令时不出组标题;说明走 i18n", () => {
    const html = render([app("new"), app("settings")]);
    expect(html).not.toContain("通用");
    expect(html).toContain("新建对话");
    expect(html).toContain("打开设置");
  });

  test("多个来源时分组:通用 / 插件显示名;插件指令显示自带说明,限定写法的短名淡显", () => {
    const commands = filterSlashCommands([plugin("compact", "compact:todo", "按待办压缩"), app("compact", true), plugin("todos", "todos")], "");
    const html = render(commands);
    expect(html.indexOf("通用")).toBeLessThan(html.indexOf("待办"));
    expect(html).toContain("按待办压缩");
    expect(html).toContain('<span class="font-normal text-muted-foreground">:todo</span>');
    expect(html).toContain('id="m-option-compact:todo"');
    expect(html.match(/role="option"/g)).toHaveLength(3);
  });
});
