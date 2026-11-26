// tests/client-commands.test.ts — 入口类通用指令:前端执行器表与服务端名单一一对应(服务端那边锁注册表行),
// 以及每个执行器落到对应按钮的处理函数上;新对话页取清单的查询参数。
import { describe, expect, test } from "bun:test";

import { CLIENT_COMMAND_NAMES } from "@server/commands/client-commands";
import { commandsQuery } from "~/hooks/use-available-commands";
import { createClientCommandExecutors, type ComposerPicker } from "~/lib/client-commands";

function setup() {
  const calls: string[] = [];
  const executors = createClientCommandExecutors({
    newConversation: () => void calls.push("new"),
    renameConversation: () => void calls.push("rename"),
    openSettings: () => void calls.push("settings"),
    forkLatestReply: async () => void calls.push("fork"),
  });
  const composer = { openPicker: (picker: ComposerPicker) => void calls.push(`picker:${picker}`) };
  return { calls, executors, composer };
}

describe("入口类执行器表", () => {
  test("名单里的每个指令都有执行器,不多不少", () => {
    const { executors } = setup();
    expect(Object.keys(executors).sort()).toEqual([...CLIENT_COMMAND_NAMES].sort());
  });

  test("每个执行器调对应按钮的处理函数", async () => {
    const { calls, executors, composer } = setup();
    for (const name of CLIENT_COMMAND_NAMES) await executors[name]("", composer);
    expect(calls).toEqual(["new", "fork", "rename", "picker:model", "picker:thinking", "picker:mcp", "picker:skills", "settings"]);
  });
});

describe("指令清单的查询参数", () => {
  test("有会话按会话取;新对话页带工作区与左下角改过的插件选择,没改过不带", () => {
    expect(commandsQuery("c 1", { workspaceId: "w1", enginePluginIds: ["pi:a"] })).toBe("conversationId=c%201");
    expect(commandsQuery(null, { workspaceId: null })).toBe("");
    expect(commandsQuery(null, { workspaceId: "w1" })).toBe("workspaceId=w1");
    expect(new URLSearchParams(commandsQuery(null, { workspaceId: "w1", enginePluginIds: [] })).get("enginePluginIds")).toBe("[]");
  });
});
