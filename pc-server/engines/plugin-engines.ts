// engines/plugin-engines.ts — 有插件运行时的引擎(D20,方案 §5.13)
//
// 插件页按这张表的顺序分组,安装接口按它认引擎;前端不写死引擎 id 与名字。某个引擎有了插件运行时就在这里加一行
// (DSH 接入时同时在内置市场源表加一行)。

import type { PluginEngineDto } from "../foundation/types/plugins";

export const PLUGIN_ENGINES: readonly PluginEngineDto[] = [{ id: "pi", label: "Pi" }];

export function isPluginEngine(engine: string): boolean {
  return PLUGIN_ENGINES.some((item) => item.id === engine);
}
