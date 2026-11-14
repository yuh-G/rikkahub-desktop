// pi-engine/tool-gate.ts — 「执行前经应用审批」的闸门标记(P4b)
//
// pi 会话里能执行的工具只有三种来源,每种都在执行前回应用审批:工作区工具(pi 内建定义 + 执行前
// host.permission.check,builtin-tools.ts)、应用工具(执行整个交给 host.tools.call,app-tools.ts)、
// 插件工具(裁决层包一层 host.permission.check,plugins/arbiter.ts)。包好的定义打上标记;runner 在
// 会话就绪后逐个核对已登记的工具,没有标记的一律拒绝开跑——pi 默认后端的内建工具或别的未经审批的
// 工具混进会话,会在这里被拦下,而不是静默绕开审批与边界。

import type { ToolDefinition } from "../../pi/packages/coding-agent/src/core/extensions/types.ts";

const APP_TOOL_GATE = Symbol.for("rikkahub.app-tool-gate");

export function markToolGated<T extends object>(definition: T): T {
  return Object.assign(definition, { [APP_TOOL_GATE]: true as const });
}

export function isToolGated(definition: object | undefined): boolean {
  return Boolean(definition && (definition as { [APP_TOOL_GATE]?: true })[APP_TOOL_GATE]);
}

/** 会话里已登记(不论是否激活)的工具都必须带闸门标记,否则抛错。 */
export function assertPiToolsGated(session: {
  getAllTools(): Array<{ name: string }>;
  getToolDefinition(name: string): ToolDefinition | undefined;
}): void {
  const ungated = session
    .getAllTools()
    .map((tool) => tool.name)
    .filter((name) => !isToolGated(session.getToolDefinition(name)));
  if (ungated.length) throw new Error(`工作区引擎拒绝开跑:以下工具未经应用审批闸门:${ungated.join(", ")}`);
}
