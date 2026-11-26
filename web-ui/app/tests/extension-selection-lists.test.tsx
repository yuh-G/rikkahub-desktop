// extension-selection-lists.test.tsx — 拓展选择列表里 MCP 逐工具设置的呈现(D32):「需要用户审核」只对对话模式生效,
// 工作区会话的选择器里不出现、只留「启用」;对话模式照旧;助手的默认(不限会话)照旧可设,列表下注明只对对话模式生效。
import { beforeEach, describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { McpToolOverrides, SELECTION_LISTS } from "~/components/settings/extensions/selection-lists";
import i18n from "~/i18n";
import type { McpServerConfig, Settings } from "~/types";

const server: McpServerConfig = {
  id: "srv1",
  commonOptions: { enable: true, name: "文档服务", tools: [{ name: "search_docs", enable: true, needsApproval: true }] },
};
const settings = { mcpServers: [server] } as unknown as Settings;
const selection = {
  mcpServers: ["srv1"],
  mcpToolOverrides: {},
  enabledSkills: [],
  enginePluginIds: [],
  modeInjectionIds: [],
  lorebookIds: [],
  quickMessageIds: [],
};

const tools = (chatConversation?: boolean) =>
  renderToStaticMarkup(
    React.createElement(McpToolOverrides, {
      server,
      tools: server.commonOptions.tools,
      selected: true,
      settings,
      selection,
      onChange: () => undefined,
      ...(chatConversation === undefined ? {} : { chatConversation }),
    }),
  );
const list = (chatConversation?: boolean) =>
  renderToStaticMarkup(
    React.createElement(SELECTION_LISTS.mcp, {
      settings,
      skills: [],
      selection,
      onChange: () => undefined,
      ...(chatConversation === undefined ? {} : { chatConversation }),
    }),
  );

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("MCP 逐工具设置", () => {
  test("工作区会话:没有「需要用户审核」,只留「启用」", () => {
    const html = tools(false);
    expect(html).toContain("search_docs");
    expect(html).not.toContain("需要用户审核");
    expect(html).toContain(i18n.t("settings:mcp.enabled"));
  });

  test("对话模式与助手的默认:「需要用户审核」照旧", () => {
    expect(tools(true)).toContain("需要用户审核");
    expect(tools()).toContain("需要用户审核");
  });

  test("只有助手的默认在列表下注明「需要用户审核」只对对话模式生效", () => {
    const note = i18n.t("settings:extension_select.mcp_approval_chat_only");
    expect(list()).toContain(note);
    expect(list(true)).not.toContain(note);
    expect(list(false)).not.toContain(note);
  });
});
