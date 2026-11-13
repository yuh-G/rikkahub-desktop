// engines/plugins.test.ts — 本轮插件清单的组装(P5a 开发者字段 → 契约 EnginePlugin[])
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enginePluginsFor } from "./plugins";

describe("enginePluginsFor", () => {
  test("只对 pi 引擎生效;字段缺省或为空 = 不加载插件", () => {
    expect(enginePluginsFor("chat", { devPiPluginPaths: ["D:\\plugins\\todo"] })).toEqual([]);
    expect(enginePluginsFor("pi", {})).toEqual([]);
    expect(enginePluginsFor("pi", { devPiPluginPaths: [] })).toEqual([]);
  });

  test("id 取包目录名或文件名(入口是 index.* 时取所在目录名),重名追加序号;重复路径只算一次", () => {
    const plugins = enginePluginsFor("pi", {
      devPiPluginPaths: [
        join("D:", "plugins", "rpiv-todo"),
        join("D:", "plugins", "rpiv-todo"),
        join("D:", "lab", "guard.ts"),
        join("D:", "other", "rpiv-todo"),
        join("D:", "ask", "index.ts"),
        "  ",
      ],
    });
    expect(plugins.map((plugin) => plugin.id)).toEqual(["dev:rpiv-todo", "dev:guard", "dev:rpiv-todo#2", "dev:ask"]);
    expect(plugins[1]!.path).toBe(join("D:", "lab", "guard.ts"));
  });
});
