// pi-engine/plugins/arbiter.ts — 插件裁决层(方案 §5.5;资源加载器的 extensionsOverride 接在这里)
//
// 输入是 pi 加载器的结果,输出是裁决后的结果。P5.2 只做一件事:插件登记的工具一律不进会话——
// 执行前的应用审批(类别 plugin)在 P5.4 才接上,在那之前放行等于让插件工具绕过审批直接执行。
// 处置表的其余部分(保留域拿掉、tool_call 行为裁决、审计)在 P5.3 落地。

import type { LoadExtensionsResult } from "../../../pi/packages/coding-agent/src/core/extensions/types.ts";

export function arbitratePiExtensions(result: LoadExtensionsResult): LoadExtensionsResult {
  for (const extension of result.extensions) extension.tools.clear();
  return result;
}
