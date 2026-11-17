// engines/plugin-mcp.test.ts — 插件声明的 MCP 服务登记(P5.8b):转成服务器记录、重装按稳定 id 合并且保留用户改动、
// 不支持的声明不登记;服务器对助手的可见性跟随插件绑定与启停;读盘对齐插件记录。
import { describe, expect, test } from "bun:test";
import type { JsonValue } from "../foundation/types";
import type { EnginePluginRecord } from "../foundation/types/settings";
import { openAiMcpTools } from "../tools/definitions";
import { isServerInUse } from "../tools/mcp-health";
import { isMcpServerSelected } from "../tools/mcp-source";
import { pluginMcpServerId, reconcilePluginMcpServers, removePluginMcpServers, setPluginMcpServersActive, syncPluginMcpServers } from "./plugin-mcp";

const PLUGIN = "pi:carrier";
const userServer = { id: "user-1", type: "streamable_http", url: "https://user.example/mcp", commonOptions: { enable: true, name: "U", tools: [] } };
const docs = { name: "docs", config: { url: "https://docs.example/mcp", headers: { Authorization: "Bearer t" } } };

const byId = (servers: JsonValue[], id: string) => servers.find((server) => (server as { id: string }).id === id) as Record<string, any>;

describe("登记与合并", () => {
  test("HTTP 声明转成带来源的服务器记录;stdio / 借用凭据 / 引用环境变量的请求头不登记并给出原因", () => {
    const { servers, skipped } = syncPluginMcpServers([userServer], PLUGIN, true, [
      docs,
      { name: "local", config: { command: "node", args: ["server.js"] } },
      { name: "borrow", config: { url: "https://x.example/mcp", auth: { provider: "anthropic" } } },
      { name: "envy", config: { url: "https://y.example/mcp", headers: { "X-Key": "${KEY}" } } },
    ]);
    expect(skipped).toEqual([
      { name: "local", reason: "transport: stdio" },
      { name: "borrow", reason: "auth.provider" },
      { name: "envy", reason: "headers: ${VAR} / !command" },
    ]);
    expect(servers[0]).toBe(userServer);
    const id = pluginMcpServerId(PLUGIN, "docs");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(pluginMcpServerId(PLUGIN, "docs")).toBe(id);
    expect(byId(servers, id)).toEqual({
      id,
      type: "streamable_http",
      url: "https://docs.example/mcp",
      source: { kind: "plugin", pluginId: PLUGIN, name: "docs", active: true },
      commonOptions: {
        enable: true,
        name: "docs",
        headers: [{ first: "Authorization", second: "Bearer t" }],
        tools: [],
        lastSyncAt: null,
        lastSyncError: "",
        connected: false,
        oauth: null,
      },
    });
    // 声明里 enabled:false = 登记但默认关着。
    const off = syncPluginMcpServers([], PLUGIN, true, [{ name: "quiet", config: { url: "https://q.example/mcp", enabled: false } }]);
    expect((off.servers[0] as Record<string, any>).commonOptions.enable).toBe(false);
  });

  test("重装:只更新连接配置,用户的开关 / 显示名 / 逐工具设置保留;地址变了清掉授权;不再声明的移除", () => {
    const id = pluginMcpServerId(PLUGIN, "docs");
    const first = syncPluginMcpServers([userServer], PLUGIN, true, [docs, { name: "old", config: { url: "https://old.example/mcp" } }]).servers;
    const edited = first.map((server) => {
      const record = server as Record<string, any>;
      if (record.id !== id) return server;
      const tools = [{ name: "search", enable: false, needsApproval: true }];
      return { ...record, commonOptions: { ...record.commonOptions, enable: false, name: "我的文档", tools, oauth: { accessToken: "a" } } };
    });
    const sameUrl = byId(syncPluginMcpServers(edited, PLUGIN, true, [docs]).servers, id);
    expect(sameUrl.commonOptions).toMatchObject({ enable: false, name: "我的文档", tools: [{ name: "search", enable: false, needsApproval: true }], oauth: { accessToken: "a" } });

    const moved = syncPluginMcpServers(edited, PLUGIN, true, [{ name: "docs", config: { url: "https://docs2.example/mcp" } }]).servers;
    expect(moved.map((server) => (server as { id: string }).id)).toEqual(["user-1", id]);
    expect(byId(moved, id)).toMatchObject({ url: "https://docs2.example/mcp", commonOptions: { enable: false, name: "我的文档", headers: [], oauth: null } });
  });

  test("启停只翻来源上的镜像,卸载移除该插件的全部服务器,别的插件不受影响", () => {
    const servers = [
      ...syncPluginMcpServers([userServer], PLUGIN, true, [docs]).servers,
      ...syncPluginMcpServers([], "pi:other", true, [docs]).servers,
    ];
    const off = setPluginMcpServersActive(servers, PLUGIN, false);
    expect(off.map((server) => (server as Record<string, any>).source?.active)).toEqual([undefined, false, true]);
    expect(byId(off, pluginMcpServerId(PLUGIN, "docs")).commonOptions.enable).toBe(true);
    expect(removePluginMcpServers(off, PLUGIN).map((server) => (server as { id: string }).id)).toEqual(["user-1", pluginMcpServerId("pi:other", "docs")]);
  });

  test("读盘对齐:插件记录不在的服务器移除,启停镜像按记录校正", () => {
    const servers = [
      ...syncPluginMcpServers([userServer], PLUGIN, true, [docs]).servers,
      ...syncPluginMcpServers([], "pi:gone", true, [docs]).servers,
    ];
    const records = [{ id: PLUGIN, enabled: false }] as EnginePluginRecord[];
    const next = reconcilePluginMcpServers(servers, records);
    expect(next.map((server) => (server as { id: string }).id)).toEqual(["user-1", pluginMcpServerId(PLUGIN, "docs")]);
    expect((next[1] as Record<string, any>).source.active).toBe(false);
  });
});

describe("可见性跟随插件绑定", () => {
  const id = pluginMcpServerId(PLUGIN, "docs");
  const withTools = (active: boolean) =>
    setPluginMcpServersActive(syncPluginMcpServers([userServer], PLUGIN, true, [docs]).servers, PLUGIN, active).map((server) => {
      const record = server as Record<string, any>;
      return { ...record, commonOptions: { ...record.commonOptions, tools: [{ name: "search", enable: true }] } };
    }) as JsonValue[];

  test("助手绑定了插件即可用,不看 MCP 勾选;插件停用、没绑定或服务器总开关关着都不可用", () => {
    const bound = { id: "a", mcpServers: [], enginePluginIds: [PLUGIN] } as never;
    const ticked = { id: "a", mcpServers: [id], enginePluginIds: [] } as never;
    expect(openAiMcpTools(bound, withTools(true)).map((tool) => tool.function.name)).toEqual(["mcp__search"]);
    expect(openAiMcpTools(ticked, withTools(true))).toEqual([]);
    expect(openAiMcpTools(bound, withTools(false))).toEqual([]);
    const disabled = withTools(true).map((server) => {
      const record = server as Record<string, any>;
      return record.id === id ? { ...record, commonOptions: { ...record.commonOptions, enable: false } } : server;
    }) as JsonValue[];
    expect(openAiMcpTools(bound, disabled)).toEqual([]);
    expect(isServerInUse(byId(withTools(true), id))).toBe(true);
    // 用户自己加的服务器照旧看勾选。
    expect(isMcpServerSelected({ mcpServers: ["user-1"] }, userServer)).toBe(true);
    expect(isMcpServerSelected({ enginePluginIds: [PLUGIN] }, userServer)).toBe(false);
  });
});
