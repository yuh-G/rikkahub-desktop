// engines/plugins.ts — 本轮要加载的引擎插件(应用侧组装,契约 EnginePlugin[])
//
// P5a 过渡:清单来自开发者字段 settings.devPiPluginPaths,只对 pi 引擎生效,没有界面。P5.8 起改为
// 「全局已启用 ∩ 会话助手已绑定」的插件记录(方案 §5.9),组装点仍是这里。
// 插件 id 现在由路径派生(`dev:<包目录名或文件名>`,入口是 index.* 时取所在目录名;重名追加 `#2`…),
// 审计与否决署名都用它。

import { basename, dirname, extname } from "node:path";
import type { Settings } from "../foundation/types/settings";
import { getStringArray, uniqueStrings } from "../foundation/utils";
import type { EngineKind, EnginePlugin } from "./contract";

export function enginePluginsFor(engine: EngineKind, settings: Pick<Settings, "devPiPluginPaths">): EnginePlugin[] {
  if (engine !== "pi") return [];
  const plugins: EnginePlugin[] = [];
  const taken = new Set<string>();
  for (const path of uniqueStrings(getStringArray(settings.devPiPluginPaths))) {
    const stem = basename(path, extname(path));
    const name = (stem === "index" ? basename(dirname(path)) : stem) || "plugin";
    let id = `dev:${name}`;
    for (let n = 2; taken.has(id); n++) id = `dev:${name}#${n}`;
    taken.add(id);
    plugins.push({ id, path });
  }
  return plugins;
}
