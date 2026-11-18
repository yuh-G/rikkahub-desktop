// commands/registry.test.ts — 指令注册表:可用性矩阵解析 + 通用指令与引擎特色指令的合并(P5.7,方案 §5.9)
import { describe, expect, test } from "bun:test";

import type { EngineCommand } from "../engines/contract";
import { CLIENT_COMMAND_NAMES } from "./client-commands";
import { COMMAND_REGISTRY, mergeEngineCommands, pluginShortName, resolveAvailableCommands, type CommandDefinition } from "./registry";

describe("指令注册表:定义形状约束", () => {
  test("指令名全局唯一且为小写英文(用户输入的 /name,不翻译)", () => {
    const names = COMMAND_REGISTRY.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  test("入口类一律在前端执行(执行的是界面按钮的同一个处理函数)", () => {
    for (const command of COMMAND_REGISTRY.filter((c) => c.kind === "entry")) expect(command.executionTarget).toBe("client");
  });

  test("在前端执行的行与前端名单一一对应(前端那边另有一条锁执行器表)", () => {
    const client = COMMAND_REGISTRY.filter((c) => c.executionTarget === "client").map((c) => c.name);
    expect([...client].sort()).toEqual([...CLIENT_COMMAND_NAMES].sort());
  });
});

describe("可用性矩阵解析(白名单缺省禁用)", () => {
  test("对话模式(chat):/compact 与八个入口类可用", () => {
    const commands = resolveAvailableCommands("chat");
    expect(commands[0]).toEqual({ name: "compact", hasArgument: true, executionTarget: "server", source: "app", invocation: "compact" });
    expect(commands.slice(1).map((c) => c.name)).toEqual(["new", "fork", "name", "model", "thinking", "mcp", "skill", "settings"]);
    for (const command of commands.slice(1)) expect(command).toMatchObject({ hasArgument: false, executionTarget: "client", source: "app" });
  });

  test("pi 工作区:/compact 可用(绑 pi 原生 compaction)", () => {
    expect(resolveAvailableCommands("pi").map((c) => c.name)).toContain("compact");
  });

  test("矩阵未声明的引擎缺省禁用(dsh/codex 未点亮)", () => {
    expect(resolveAvailableCommands("dsh")).toEqual([]);
    expect(resolveAvailableCommands("codex")).toEqual([]);
  });

  test("开放枚举:未来任意新引擎 kind 缺省禁用,强制显式评估绑定", () => {
    expect(resolveAvailableCommands("some-future-engine")).toEqual([]);
  });
});

// 合并规则用固定的注册表测(真实注册表的行数会随指令增加而变)。
const registry: CommandDefinition[] = [
  { name: "compact", hasArgument: true, kind: "capability", executionTarget: "server", availability: { chat: true, workspace: { pi: true } } },
  { name: "model", hasArgument: false, kind: "entry", executionTarget: "client", availability: { chat: true, workspace: { pi: true } } },
  { name: "review", hasArgument: true, kind: "capability", executionTarget: "server", availability: { chat: true, workspace: {} } },
];

const plugin = (pluginId: string, name: string, description?: string): EngineCommand => ({
  id: JSON.stringify([pluginId, name]),
  name,
  source: `plugin:${pluginId}`,
  ...(description ? { description } : {}),
});

const merge = (commands: EngineCommand[], engine = "pi") => mergeEngineCommands(engine, commands, registry);
const lines = (result: ReturnType<typeof merge>) => result.commands.map((c) => `${c.source} /${c.invocation}`);

describe("合并:重名规则", () => {
  test("插件指令与入口类同名 → 拿掉,交给调用方记审计", () => {
    const result = merge([plugin("dev:todo", "model")]);
    expect(lines(result)).toEqual(["app /compact", "app /model"]);
    expect(result.removed.map((c) => `${c.source} ${c.name}`)).toEqual(["plugin:dev:todo model"]);
  });

  test("插件指令与能力类同名 → 两条都在,裸名归通用,插件那条写成 name:<插件短名>", () => {
    const result = merge([plugin("dev:todo", "compact", "按待办压缩")]);
    expect(lines(result)).toEqual(["app /compact", "app /model", "plugin:dev:todo /compact:todo"]);
    expect(result.removed).toEqual([]);
    const own = result.commands.at(-1)!;
    expect(own).toMatchObject({ name: "compact", executionTarget: "engine", description: "按待办压缩", commandId: JSON.stringify(["dev:todo", "compact"]) });
  });

  test("多个插件同名 → 都保留,各用限定写法;没有通用指令时也不给裸名", () => {
    const result = merge([plugin("dev:a", "review"), plugin("dev:b", "review"), plugin("dev:a", "todos")], "pi");
    // review 在注册表里对 pi 没点亮:不算通用指令,但两个插件同名仍要限定。
    expect(lines(result)).toEqual(["app /compact", "app /model", "plugin:dev:a /review:a", "plugin:dev:b /review:b", "plugin:dev:a /todos"]);
  });

  test("只有一个插件有这个名字、也没有通用指令 → 裸名归该插件", () => {
    expect(lines(merge([plugin("dev:todo", "todos")]))).toEqual(["app /compact", "app /model", "plugin:dev:todo /todos"]);
  });

  test("引擎自带的同名指令不单列(它就是通用指令在该引擎的原生绑定);不同名的照常列出", () => {
    const own = (name: string): EngineCommand => ({ id: name, name, source: "engine" });
    expect(lines(merge([own("compact"), own("model"), own("stats")]))).toEqual(["app /compact", "app /model", "engine /stats"]);
  });

  test("插件短名相同(不同命名空间)时退回完整插件 id,写法仍然唯一", () => {
    const result = merge([plugin("dev:todo", "compact"), plugin("npm:todo", "compact")]);
    expect(lines(result)).toEqual(["app /compact", "app /model", "plugin:dev:todo /compact:todo", "plugin:npm:todo /compact:npm:todo"]);
  });

  test("名字里有空白的指令敲不出来,不列", () => {
    expect(lines(merge([plugin("dev:x", "two words")]))).toEqual(["app /compact", "app /model"]);
  });

  test("引擎在矩阵里没点亮通用指令时,插件指令照常列出且不被通用指令占名", () => {
    expect(lines(merge([plugin("dev:todo", "compact")], "dsh"))).toEqual(["plugin:dev:todo /compact"]);
  });
});

describe("插件短名", () => {
  test("去掉命名空间前缀与包的作用域;没有前缀原样", () => {
    expect(pluginShortName("dev:todo")).toBe("todo");
    expect(pluginShortName("todo")).toBe("todo");
    expect(pluginShortName("dev:")).toBe("dev:");
    expect(pluginShortName("pi:@juicesharp/rpiv-todo")).toBe("rpiv-todo");
    expect(pluginShortName("pi:rpiv-todo#2")).toBe("rpiv-todo#2");
  });
});
