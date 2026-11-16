// api/plugins.test.ts — 插件管理端点(P5.8):安装(本地 / npm 压缩包,离线)→ 启停 / 开关 / 绑定 → 重装沿用设置
// → 卸载删包并解除所有助手的绑定;不是 pi 插件的包装上后立即卸掉。安装走真实子进程(本程序以 bun 身份运行包管理器)。
// npm 来源用 `bun pm pack` 打的压缩包:Windows 上 bun 1.4.2 装 file:<目录> 会在拷贝阶段报 EPERM(目录插件走本地来源)。
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-plugins-api-test-"));

const { defaultState } = await import("../app-config/defaults");
const jsonStore = await import("../persistence/json-store");
const { handlePluginRoutes } = await import("./handlers/plugins");
const { handleSettingsRoutes } = await import("./handlers/settings");
const { enginePluginInstallRoot, enginePluginsFor } = await import("../engines/plugins");
const { pluginAudit, recordPluginAudit } = await import("../engines/plugin-audit");
const { pluginMcpServerId } = await import("../engines/plugin-mcp");

jsonStore.setState(defaultState());
const lab = mkdtempSync(join(tmpdir(), "rkh-plugins-api-lab-"));
afterAll(() => {
  rmSync(lab, { recursive: true, force: true });
  rmSync(process.env.RIKKAHUB_PC_DATA_DIR!, { recursive: true, force: true });
});

function writePackage(dirName: string, pkg: Record<string, unknown>, files: Record<string, string>): string {
  const dir = join(lab, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

function packTarball(dir: string): string {
  const packed = Bun.spawnSync([process.execPath, "pm", "pack", "--destination", lab], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  expect(packed.exitCode).toBe(0);
  const name = readdirSync(lab).find((file) => file.endsWith(".tgz") && !file.startsWith("_"))!;
  const target = join(lab, `_${name}`);
  renameSync(join(lab, name), target);
  return target;
}

async function call(path: string, body?: unknown, query = "") {
  const url = new URL(`http://127.0.0.1/api/${path}${query}`);
  const request = body === undefined
    ? new Request(url)
    : new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const response = path.startsWith("settings/") ? await handleSettingsRoutes(request, url, path) : await handlePluginRoutes(request, url, path);
  return { status: response!.status, body: (await response!.json()) as Record<string, any> };
}

function pluginAuditCodes(pluginId: string) {
  return pluginAudit(pluginId).map((entry) => [entry.code, entry.subject, entry.detail]);
}

const PLUGIN_SOURCE = `export default function (pi) {
  pi.registerTool({ name: "peek", label: "peek", description: "看一眼", parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; } });
  pi.registerCommand("todos", { description: "待办", handler: async () => {} });
  pi.registerCommand("model", { handler: async () => {} });
}
`;

describe("插件管理端点", () => {
  test("npm 来源装进引擎的安装目录;开关与绑定进会话装配;重装沿用;卸载删包并解绑", async () => {
    const tarball = packTarball(writePackage("demo-pkg", { name: "@demo/peek", version: "1.2.0", pi: { extensions: ["./main.js"] } }, { "main.js": PLUGIN_SOURCE }));
    const installed = await call("plugins/install", { source: { kind: "npm", spec: tarball } });
    expect(installed.body.error ?? "").toBe("");
    expect(installed.status).toBe(200);
    const plugin = installed.body.plugin;
    expect(plugin).toMatchObject({ id: "pi:@demo/peek", engine: "pi", name: "@demo/peek", version: "1.2.0", enabled: true, installed: true });
    expect(plugin.path).toBe(join(enginePluginInstallRoot("pi"), "node_modules", "@demo", "peek"));

    const detail = await call("plugins/detail", undefined, `?id=${encodeURIComponent(plugin.id)}`);
    expect(detail.body.tools.map((tool: { name: string }) => tool.name)).toEqual(["peek"]);
    expect(detail.body.commands.map((command: { name: string }) => command.name)).toEqual(["todos"]);

    const assistantId = jsonStore.state.settings.assistants[0]!.id;
    expect((await call("settings/assistant/plugins", { assistantId, pluginIds: ["pi:nope"] })).status).toBe(400);
    expect((await call("settings/assistant/plugins", { assistantId, pluginIds: [plugin.id] })).status).toBe(200);
    expect((await call("plugins/switches", { id: plugin.id, toolCall: false, tools: { peek: { enabled: false, exempt: true } } })).status).toBe(200);
    const assistant = () => jsonStore.state.settings.assistants.find((item) => item.id === assistantId)!;
    expect(enginePluginsFor("pi", jsonStore.state.settings, assistant())).toEqual([
      { id: plugin.id, path: plugin.path, toolCallHookDisabled: true, disabledTools: ["peek"], revision: plugin.installedAt },
    ]);
    expect((await call("plugins/enabled", { id: plugin.id, enabled: false })).status).toBe(200);
    expect(enginePluginsFor("pi", jsonStore.state.settings, assistant())).toEqual([]);

    const reinstalled = await call("plugins/reinstall", { id: plugin.id });
    expect(reinstalled.status).toBe(200);
    expect(reinstalled.body.plugin).toMatchObject({ id: plugin.id, enabled: false, hookSwitches: { toolCall: false }, toolSwitches: { peek: { enabled: false, exempt: true } } });
    expect(jsonStore.state.settings.enginePlugins).toHaveLength(1);

    const uninstalled = await call("plugins/uninstall", { id: plugin.id });
    expect(uninstalled.status).toBe(200);
    expect(jsonStore.state.settings.enginePlugins).toEqual([]);
    expect(assistant().enginePluginIds).toEqual([]);
    expect(existsSync(plugin.path)).toBe(false);
  }, 120_000);

  test("不是 pi 插件的包装上后立即卸掉;本地来源原地使用、卸载不动文件;重名追加序号", async () => {
    const notPlugin = packTarball(writePackage("not-plugin", { name: "not-a-plugin", version: "0.0.1" }, { "lib.js": "export const x = 1;\n" }));
    const rejected = await call("plugins/install", { source: { kind: "npm", spec: notPlugin } });
    expect(rejected.status).toBe(400);
    expect(rejected.body.errorCode).toBe("plugin_entry_missing");
    expect(existsSync(join(enginePluginInstallRoot("pi"), "node_modules", "not-a-plugin"))).toBe(false);
    expect(jsonStore.state.settings.enginePlugins).toEqual([]);

    const local = writePackage("local-guard", { name: "guard" }, { "index.js": PLUGIN_SOURCE });
    const first = await call("plugins/install", { source: { kind: "local", spec: local } });
    const second = await call("plugins/install", { source: { kind: "local", spec: local } });
    expect([first.body.plugin.id, second.body.plugin.id]).toEqual(["pi:guard", "pi:guard#2"]);
    expect(first.body.plugin.path).toBe(local);
    expect((await call("plugins/uninstall", { id: "pi:guard" })).status).toBe(200);
    expect(existsSync(join(local, "index.js"))).toBe(true);

    // 装失败(包不存在)不留下坏依赖:之后的安装不受影响。
    const missing = await call("plugins/install", { source: { kind: "npm", spec: join(lab, "missing.tgz") } });
    expect(missing.body.errorCode).toBe("plugin_install_failed");
    expect(Object.keys(JSON.parse(readFileSync(join(enginePluginInstallRoot("pi"), "package.json"), "utf8")).dependencies ?? {})).toEqual([]);

    expect((await call("plugins/install", { source: { kind: "local", spec: "relative/path" } })).body.errorCode).toBe("plugin_source_invalid");
    expect((await call("plugins/install", { source: { kind: "npm", spec: "--registry=x" } })).body.errorCode).toBe("plugin_source_invalid");
    expect((await call("plugins/install", { engine: "chat", source: { kind: "npm", spec: "x" } })).body.errorCode).toBe("plugin_engine_unsupported");
  }, 120_000);

  test("插件声明的 MCP 服务登记进应用的 MCP 列表:启停跟随、重装保留用户开关、卸载移除;不支持的写审计", async () => {
    const source = `export default function (pi) {
  pi.registerMcpServer("notes", { url: "http://127.0.0.1:9/mcp" });
  pi.registerMcpServer("local", { command: "node", args: ["server.js"] });
}
`;
    const dir = writePackage("mcp-carrier", { name: "mcp-carrier" }, { "index.js": source });
    const installed = await call("plugins/install", { source: { kind: "local", spec: dir } });
    expect(installed.status).toBe(200);
    const pluginId = installed.body.plugin.id as string;
    const serverId = pluginMcpServerId(pluginId, "notes");
    const server = () => (jsonStore.state.settings.mcpServers as Array<Record<string, any>>).find((item) => item.id === serverId);
    expect(server()).toMatchObject({ url: "http://127.0.0.1:9/mcp", source: { kind: "plugin", pluginId, name: "notes", active: true }, commonOptions: { enable: true, name: "notes" } });
    expect(jsonStore.state.settings.mcpServers).toHaveLength(1);
    expect(pluginAuditCodes(pluginId)).toContainEqual(["pi_plugin_mcp_unsupported", "mcp:local", "transport: stdio"]);

    expect((await call("plugins/enabled", { id: pluginId, enabled: false })).status).toBe(200);
    expect(server()!.source.active).toBe(false);
    // 用户在 MCP 页关掉它,重装后照旧关着。
    jsonStore.setState({ ...jsonStore.state, settings: { ...jsonStore.state.settings, mcpServers: [{ ...server()!, commonOptions: { ...server()!.commonOptions, enable: false } }] } });
    expect((await call("plugins/reinstall", { id: pluginId })).status).toBe(200);
    expect(server()).toMatchObject({ source: { active: false }, commonOptions: { enable: false } });

    expect((await call("plugins/uninstall", { id: pluginId })).status).toBe(200);
    expect(jsonStore.state.settings.mcpServers).toEqual([]);
  });

  test("审计按插件归集:同码同对象合并计数,不带插件 id 的报告不收", async () => {
    const report = { domain: "pi-engine" as const, severity: "info" as const, message: "m", code: "pi_plugin_removed", params: { plugin: "pi:a", subject: "tool:read" } };
    recordPluginAudit(report);
    recordPluginAudit(report);
    recordPluginAudit({ ...report, code: "pi_plugin_load_failed", params: { plugin: "pi:a", error: "boom" } });
    recordPluginAudit({ ...report, params: { subject: "tool:read" } });
    const audit = (await call("plugins/audit", undefined, "?id=pi:a")).body.audit as Array<Record<string, unknown>>;
    expect(audit.map((entry) => [entry.code, entry.subject, entry.count, entry.detail])).toEqual([
      ["pi_plugin_load_failed", "load", 1, "boom"],
      ["pi_plugin_removed", "tool:read", 2, undefined],
    ]);
  });
});
