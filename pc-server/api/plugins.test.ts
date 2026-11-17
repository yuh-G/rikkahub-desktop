// api/plugins.test.ts — 插件管理端点(P5.8):安装(本地 / npm 压缩包,离线)→ 启停 / 开关 / 绑定 → 重装沿用设置
// → 卸载删包并解除所有助手的绑定;不是 pi 插件的包装上后立即卸掉。安装走真实子进程(本程序以 bun 身份运行包管理器)。
// npm 来源用 `bun pm pack` 打的压缩包:Windows 上 bun 1.4.2 装 file:<目录> 会在拷贝阶段报 EPERM(目录插件走本地来源)。
// 上传(P6.2.3):三种格式各装通一次、同名 409 与 replace=1、存档丢失、搬动数据目录后安装根仍能再装别的包。
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildZip } from "../test-utils/build-zip";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-plugins-api-test-"));

const { defaultState } = await import("../app-config/defaults");
const jsonStore = await import("../persistence/json-store");
const { handlePluginRoutes } = await import("./handlers/plugins");
const { handleSettingsRoutes } = await import("./handlers/settings");
const { enginePluginInstallRoot, enginePluginsFor, enginePluginUploadsDir } = await import("../engines/plugins");
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

async function upload(fileName: string, bytes: Uint8Array, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], fileName));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const url = new URL("http://127.0.0.1/api/plugins/upload");
  const response = await handlePluginRoutes(new Request(url, { method: "POST", body: form }), url, "plugins/upload");
  return { status: response!.status, body: (await response!.json()) as Record<string, any> };
}

async function tgzOf(files: Record<string, string>): Promise<Uint8Array> {
  const encoded = Object.fromEntries(Object.entries(files).map(([name, text]) => [`package/${name}`, new TextEncoder().encode(text)]));
  return new Bun.Archive(encoded, { compress: "gzip" }).bytes();
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
    const tarball = packTarball(
      writePackage(
        "demo-pkg",
        { name: "@demo/peek", version: "1.2.0", description: "看一眼的工具", author: "Ada", license: "MIT", pi: { extensions: ["./main.js"] } },
        { "main.js": PLUGIN_SOURCE, "README.md": "# Peek\n用法" },
      ),
    );
    const installed = await call("plugins/install", { source: { kind: "npm", spec: tarball } });
    expect(installed.body.error ?? "").toBe("");
    expect(installed.status).toBe(200);
    const plugin = installed.body.plugin;
    expect(plugin).toMatchObject({
      id: "pi:@demo/peek",
      engine: "pi",
      name: "@demo/peek",
      version: "1.2.0",
      enabled: true,
      installed: true,
      loadFailed: false,
      auditCount: 0,
      meta: { description: "看一眼的工具", author: "Ada", license: "MIT" },
    });
    expect(plugin.path).toBe(join(enginePluginInstallRoot("pi"), "node_modules", "@demo", "peek"));

    const detail = await call("plugins/detail", undefined, `?id=${encodeURIComponent(plugin.id)}`);
    expect(detail.body.tools.map((tool: { name: string }) => tool.name)).toEqual(["peek"]);
    expect(detail.body.commands.map((command: { name: string }) => command.name)).toEqual(["todos"]);
    expect(detail.body.readme).toBe("# Peek\n用法");
    const list = await call("plugins");
    expect(list.body.engines).toEqual([{ id: "pi", label: "Pi" }]);
    // 压缩包来源不检查更新,也不能「更新」。
    expect((await call("plugins/updates")).body.updates).toEqual({});
    expect((await call("plugins/update", { id: plugin.id })).body.errorCode).toBe("plugin_update_unsupported");

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
    expect((await call("plugins/install", { source: { kind: "npm", spec: "x", registry: "ftp://r" } })).body.errorCode).toBe("plugin_source_invalid");
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

  test("市场源:内置的在前且不可移除;未知市场源报错", async () => {
    const sources = (await call("plugins/market/sources")).body.sources as Array<Record<string, unknown>>;
    expect(sources.map((source) => [source.id, source.builtin])).toEqual([["pi-official", true]]);
    expect((await call("plugins/market/sources/remove", { id: "pi-official" })).body.errorCode).toBe("plugin_market_source_invalid");
    expect((await call("plugins/market", undefined, "?source=nope")).body.errorCode).toBe("plugin_market_source_invalid");
    expect((await call("plugins/market/sources", { url: "" })).body.errorCode).toBe("plugin_market_source_invalid");
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
    // 列表的运行记录摘要:有加载失败、共两条。
    const local = writePackage("audit-a", { name: "a" }, { "index.js": PLUGIN_SOURCE });
    const installed = await call("plugins/install", { source: { kind: "local", spec: local } });
    expect(installed.body.plugin.id).toBe("pi:a");
    expect(installed.body.plugin).toMatchObject({ loadFailed: true, auditCount: 2 });
    expect((await call("plugins/uninstall", { id: "pi:a" })).status).toBe(200);
  });

  test("上传:tgz / zip / 单个脚本各装通一次;同名 409 与 replace=1;存档丢失;卸载连文件一起删", async () => {
    const uploads = enginePluginUploadsDir("pi");
    const uploaded = () => jsonStore.state.settings.enginePlugins.filter((record) => record.source.kind === "upload");
    const pkg = (version: string) => JSON.stringify({ name: "@demo/up", version, pi: { extensions: ["./main.js"] } });
    const first = await upload("up.tgz", await tgzOf({ "package.json": pkg("1.0.0"), "main.js": PLUGIN_SOURCE }));
    expect(first.body.error ?? "").toBe("");
    const plugin = first.body.plugin;
    expect(plugin).toMatchObject({ id: "pi:@demo/up", name: "@demo/up", version: "1.0.0", installed: true, source: { kind: "upload" } });
    expect(plugin.source.spec).toMatch(/^demo-up-1\.0\.0-[0-9a-f]{8}\.tgz$/);
    expect(plugin.path).toBe(join(enginePluginInstallRoot("pi"), "node_modules", "@demo", "up"));
    // 安装根的清单与锁文件里只有相对路径。
    const root = enginePluginInstallRoot("pi");
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies["@demo/up"]).toContain(`../uploads/${plugin.source.spec}`);
    // 数据目录按 foundation/paths 首次加载时的环境定(整套测试同一进程跑时不一定是本文件设的那个)。
    const enginesDir = dirname(dirname(root));
    const dataDir = dirname(enginesDir);
    for (const file of ["package.json", "bun.lock"]) {
      const text = readFileSync(join(root, file), "utf8");
      expect(text.includes(dataDir) || text.includes(dataDir.replaceAll("\\", "/")) || text.includes(dataDir.replaceAll("\\", "\\\\"))).toBe(false);
    }

    // 搬动数据目录后,在新位置再装别的包仍成功(清单里的上传依赖跟着走)。
    const moved = join(lab, "moved-engines");
    renameSync(enginesDir, moved);
    try {
      const other = packTarball(writePackage("after-move", { name: "after-move", version: "0.1.0" }, { "index.js": PLUGIN_SOURCE }));
      const movedRoot = join(moved, "pi", "npm");
      const added = Bun.spawnSync([process.execPath, "add", other, "--omit=peer"], { cwd: movedRoot, stdout: "pipe", stderr: "pipe" });
      if (added.exitCode !== 0) throw new Error(added.stderr.toString());
      expect(Bun.spawnSync([process.execPath, "remove", "after-move"], { cwd: movedRoot }).exitCode).toBe(0);
    } finally {
      renameSync(moved, enginesDir);
    }

    const conflict = await upload("up-1.1.tgz", await tgzOf({ "package.json": pkg("1.1.0"), "main.js": PLUGIN_SOURCE }));
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ errorCode: "plugin_name_conflict", existing: { id: plugin.id } });
    expect((await call("plugins/enabled", { id: plugin.id, enabled: false })).status).toBe(200);
    const replaced = await upload("up-1.1.tgz", await tgzOf({ "package.json": pkg("1.1.0"), "main.js": PLUGIN_SOURCE }), { replace: "1" });
    expect(replaced.body.plugin).toMatchObject({ id: plugin.id, version: "1.1.0", enabled: false });
    expect(existsSync(join(uploads, plugin.source.spec))).toBe(false);
    expect(existsSync(join(uploads, replaced.body.plugin.source.spec))).toBe(true);
    expect((await call("plugins/reinstall", { id: plugin.id })).status).toBe(200);
    expect(uploaded()).toHaveLength(1);

    // zip:GitHub 下载的形态(唯一的顶层目录),重打成 tgz 存档后照常装。
    const zipped = await upload("zipped-main.zip", new Uint8Array(buildZip([
      { name: "zipped-main/package.json", data: JSON.stringify({ name: "zipped", version: "0.2.0" }) },
      { name: "zipped-main/index.js", data: PLUGIN_SOURCE },
    ])));
    expect(zipped.body.plugin).toMatchObject({ id: "pi:zipped", version: "0.2.0", installed: true, source: { kind: "upload" } });
    expect(zipped.body.plugin.source.spec).toEndWith(".tgz");

    // 单个脚本:存在 uploads/scripts 原地加载;加载不了的不落地;同名同样 409。
    const broken = await upload("broken.js", new TextEncoder().encode("export default function (pi) { pi.registerTool("));
    expect(broken.body.errorCode).toBe("plugin_upload_invalid");
    expect(existsSync(join(uploads, "scripts", "broken.js"))).toBe(false);
    const script = await upload("hello.ts", new TextEncoder().encode(PLUGIN_SOURCE));
    expect(script.body.plugin).toMatchObject({ id: "pi:hello", name: "hello", source: { kind: "upload", spec: "scripts/hello.ts" } });
    expect(script.body.plugin.path).toBe(join(uploads, "scripts", "hello.ts"));
    const detail = await call("plugins/detail", undefined, "?id=pi:hello");
    expect(detail.body.tools.map((tool: { name: string }) => tool.name)).toEqual(["peek"]);
    expect((await upload("hello.ts", new TextEncoder().encode(PLUGIN_SOURCE))).status).toBe(409);
    expect((await call("plugins/reinstall", { id: "pi:hello" })).status).toBe(200);

    // 存档不在(换机恢复后的样子):重装报 plugin_upload_missing。
    const zipArchive = join(uploads, zipped.body.plugin.source.spec);
    renameSync(zipArchive, `${zipArchive}.bak`);
    expect((await call("plugins/reinstall", { id: "pi:zipped" })).body.errorCode).toBe("plugin_upload_missing");
    renameSync(`${zipArchive}.bak`, zipArchive);

    for (const id of [plugin.id, "pi:zipped", "pi:hello"]) expect((await call("plugins/uninstall", { id })).status).toBe(200);
    expect(uploaded()).toEqual([]);
    expect(readdirSync(uploads).filter((name) => name !== "scripts")).toEqual([]);
    expect(readdirSync(join(uploads, "scripts"))).toEqual([]);
    expect(existsSync(plugin.path)).toBe(false);
    expect((await upload("x.exe", new Uint8Array([1]))).body.errorCode).toBe("plugin_upload_invalid");
    expect((await upload("x.tgz", new Uint8Array([1]), { engine: "chat" })).body.errorCode).toBe("plugin_engine_unsupported");
  }, 180_000);
});
