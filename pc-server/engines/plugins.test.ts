// engines/plugins.test.ts — 本轮插件清单的组装(插件记录 ∩ 助手绑定 + 开发者字段 → 契约 EnginePlugin[])
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { EnginePluginRecord } from "../foundation/types/settings";
import { enginePluginInstallRoot, enginePluginsFor, enginePluginUploadsDir, isPackageSource, locateEnginePlugin, normalizeEnginePluginRecords } from "./plugins";

function record(overrides: Partial<EnginePluginRecord> = {}): EnginePluginRecord {
  return {
    id: "pi:@demo/todo",
    engine: "pi",
    name: "@demo/todo",
    source: { kind: "npm", spec: "@demo/todo" },
    version: "1.0.0",
    enabled: true,
    hookSwitches: { toolCall: true },
    toolSwitches: {},
    installedAt: "2026-11-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("enginePluginsFor", () => {
  test("开发者字段只对 pi 引擎生效;字段缺省或为空 = 不加载插件", () => {
    expect(enginePluginsFor("chat", { devPiPluginPaths: ["D:\\plugins\\todo"] }, null)).toEqual([]);
    expect(enginePluginsFor("pi", {}, null)).toEqual([]);
    expect(enginePluginsFor("pi", { devPiPluginPaths: [] }, null)).toEqual([]);
  });

  test("开发者条目 id 取包目录名或文件名(入口是 index.* 时取所在目录名),重名追加序号;重复路径只算一次", () => {
    const plugins = enginePluginsFor("pi", {
      devPiPluginPaths: [
        join("D:", "plugins", "rpiv-todo"),
        join("D:", "plugins", "rpiv-todo"),
        join("D:", "lab", "guard.ts"),
        join("D:", "other", "rpiv-todo"),
        join("D:", "ask", "index.ts"),
        "  ",
      ],
    }, null);
    expect(plugins.map((plugin) => plugin.id)).toEqual(["dev:rpiv-todo", "dev:guard", "dev:rpiv-todo#2", "dev:ask"]);
    expect(plugins[1]!.path).toBe(join("D:", "lab", "guard.ts"));
  });

  test("插件记录:同引擎、全局已启用、且助手已绑定才加载;开发者条目不经绑定,排在后面", () => {
    const settings = {
      devPiPluginPaths: [join("D:", "lab", "guard.ts")],
      enginePlugins: [
        record(),
        record({ id: "pi:off", name: "off", enabled: false }),
        record({ id: "pi:unbound", name: "unbound" }),
        record({ id: "dsh:todo", engine: "dsh", name: "todo" }),
      ],
    };
    const assistant = { enginePluginIds: ["pi:@demo/todo", "pi:off", "dsh:todo"] };
    expect(enginePluginsFor("pi", settings, assistant).map((plugin) => plugin.id)).toEqual(["pi:@demo/todo", "dev:guard"]);
    expect(enginePluginsFor("pi", settings, null).map((plugin) => plugin.id)).toEqual(["dev:guard"]);
    expect(enginePluginsFor("dsh", settings, assistant).map((plugin) => plugin.id)).toEqual(["dsh:todo"]);
  });

  test("位置、钩子开关、逐工具开关与安装时刻随清单给出(都进长驻会话的配置键)", () => {
    const settings = {
      enginePlugins: [
        record({ hookSwitches: { toolCall: false }, toolSwitches: { todo: { enabled: false }, peek: {} } }),
        record({ id: "pi:local", name: "local", source: { kind: "local", spec: join("D:", "lab", "local") } }),
      ],
    };
    const [installed, local] = enginePluginsFor("pi", settings, { enginePluginIds: ["pi:@demo/todo", "pi:local"] });
    expect(installed).toEqual({
      id: "pi:@demo/todo",
      path: join(enginePluginInstallRoot("pi"), "node_modules", "@demo", "todo"),
      toolCallHookDisabled: true,
      disabledTools: ["todo"],
      revision: "2026-11-16T00:00:00.000Z",
    });
    expect(local).toEqual({ id: "pi:local", path: join("D:", "lab", "local"), revision: "2026-11-16T00:00:00.000Z" });
  });

  test("上传来源:压缩包按包名进安装目录,单个脚本在 uploads/scripts 原地加载", () => {
    const archive = { engine: "pi", name: "@demo/up", source: { kind: "upload" as const, spec: "demo-up-1.0.0-abcd1234.tgz" } };
    const script = { engine: "pi", name: "hello", source: { kind: "upload" as const, spec: "scripts/hello.ts" } };
    expect(locateEnginePlugin(archive)).toBe(join(enginePluginInstallRoot("pi"), "node_modules", "@demo", "up"));
    expect(locateEnginePlugin(script)).toBe(join(enginePluginUploadsDir("pi"), "scripts", "hello.ts"));
    expect([isPackageSource(archive.source), isPackageSource(script.source), isPackageSource({ kind: "local", spec: "x" })]).toEqual([true, false, false]);
  });
});

describe("插件记录", () => {
  test("规范化:丢坏行与重复 id,补齐开关缺省值,旧记录里的逐工具免问(exempt,D32 删除)丢掉;说明字段按上限规整,空的整项去掉", () => {
    const records = normalizeEnginePluginRecords([
      { id: "pi:a", engine: "pi", source: { kind: "npm", spec: "a" }, toolSwitches: { x: { exempt: true, junk: 1 }, z: { enabled: false, exempt: true }, y: null }, meta: { license: "MIT", author: 3 } },
      { id: "pi:m", engine: "pi", source: { kind: "npm", spec: "m", registry: "javascript:x" }, meta: { author: "" } },
      { id: "pi:r", engine: "pi", source: { kind: "npm", spec: "r", registry: "https://npm.example.com" } },
      { id: "pi:a", engine: "pi", source: { kind: "npm", spec: "a" } },
      { id: "pi:b", engine: "pi", source: { kind: "ftp", spec: "b" } },
      { id: "pi:u1", engine: "pi", source: { kind: "upload", spec: "../npm/package.json" } },
      { id: "pi:u2", engine: "pi", source: { kind: "upload", spec: "scripts/../../x.ts" } },
      { id: "pi:u3", engine: "pi", source: { kind: "upload", spec: "scripts/hello.ts" } },
      { engine: "pi", source: { kind: "npm", spec: "c" } },
      "junk",
    ]);
    expect(records).toEqual([
      {
        id: "pi:a",
        engine: "pi",
        name: "pi:a",
        source: { kind: "npm", spec: "a" },
        version: null,
        enabled: true,
        hookSwitches: { toolCall: true },
        toolSwitches: { x: {}, z: { enabled: false } },
        installedAt: "",
        meta: { license: "MIT" },
      },
      {
        id: "pi:m",
        engine: "pi",
        name: "pi:m",
        source: { kind: "npm", spec: "m" },
        version: null,
        enabled: true,
        hookSwitches: { toolCall: true },
        toolSwitches: {},
        installedAt: "",
      },
      {
        id: "pi:r",
        engine: "pi",
        name: "pi:r",
        source: { kind: "npm", spec: "r", registry: "https://npm.example.com" },
        version: null,
        enabled: true,
        hookSwitches: { toolCall: true },
        toolSwitches: {},
        installedAt: "",
      },
      {
        id: "pi:u3",
        engine: "pi",
        name: "pi:u3",
        source: { kind: "upload", spec: "scripts/hello.ts" },
        version: null,
        enabled: true,
        hookSwitches: { toolCall: true },
        toolSwitches: {},
        installedAt: "",
      },
    ]);
    expect(normalizeEnginePluginRecords(undefined)).toEqual([]);
  });
});
