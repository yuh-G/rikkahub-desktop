// commands/client-commands.ts — 在前端执行的通用指令名单(入口类,方案 §5.9 / D18)
//
// 叶子模块:零依赖,web-ui 运行时引用。注册表(registry.ts)里 executionTarget 为 client 的行与这份名单一一对应,
// 前端执行器表(web-ui lib/client-commands.ts)按它建;两端各有一条测试锁住「注册了没接执行器」。

export const CLIENT_COMMAND_NAMES = ["new", "fork", "name", "model", "thinking", "mcp", "skill", "settings"] as const;

export type ClientCommandName = (typeof CLIENT_COMMAND_NAMES)[number];
