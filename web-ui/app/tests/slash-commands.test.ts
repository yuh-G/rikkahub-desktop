// tests/slash-commands.test.ts — 斜杠指令前端解析纯函数
import { describe, expect, test } from "bun:test";

import { filterSlashCommands, parseSlashCommand, slashMenuQuery, type SlashCommandDto } from "~/lib/slash-commands";

const compact: SlashCommandDto = { name: "compact", hasArgument: true, executionTarget: "server", source: "app", invocation: "compact" };
const copy: SlashCommandDto = { name: "copy", hasArgument: false, executionTarget: "client", source: "app", invocation: "copy" };
const commands = [compact, copy];

describe("slashMenuQuery:菜单触发判定", () => {
  test("开头 / 触发,返回小写过滤词;刚敲 / 返回空串(展示全部)", () => {
    expect(slashMenuQuery("/")).toBe("");
    expect(slashMenuQuery("/Co")).toBe("co");
  });

  test("非开头 / 、空文本、普通文本不触发", () => {
    expect(slashMenuQuery("")).toBeNull();
    expect(slashMenuQuery("a/co")).toBeNull();
    expect(slashMenuQuery("hello")).toBeNull();
  });

  test("token 内出现空白(含换行)即进入参数区,菜单关闭", () => {
    expect(slashMenuQuery("/compact ")).toBeNull();
    expect(slashMenuQuery("/compact 保留要点")).toBeNull();
    expect(slashMenuQuery("/com\npact")).toBeNull();
  });
});

describe("filterSlashCommands:前缀优先其次子串,大小写不敏感", () => {
  test("空 query 返回全部(注册表序)", () => {
    expect(filterSlashCommands(commands, "")).toEqual(commands);
  });

  test("前缀命中排在子串命中前", () => {
    expect(filterSlashCommands(commands, "co").map((c) => c.name)).toEqual(["compact", "copy"]);
    expect(filterSlashCommands(commands, "pact").map((c) => c.name)).toEqual(["compact"]);
    expect(filterSlashCommands(commands, "COPY").map((c) => c.name)).toEqual(["copy"]);
  });

  test("无命中返回空(菜单隐藏,不显示空态)", () => {
    expect(filterSlashCommands(commands, "xyz")).toEqual([]);
  });
});

describe("parseSlashCommand:完整指令判定(拦截与染色共用)", () => {
  test("无参命中:argument 空串,tokenLength 含斜杠", () => {
    expect(parseSlashCommand("/compact", commands)).toEqual({ command: compact, argument: "", tokenLength: 8 });
  });

  test("带参命中:参数 trim;参数可含空格与换行", () => {
    expect(parseSlashCommand("/compact  保留 API 决策\n和风险", commands)).toEqual({
      command: compact,
      argument: "保留 API 决策\n和风险",
      tokenLength: 8,
    });
  });

  test("大小写不敏感命中(手敲大写也认)", () => {
    expect(parseSlashCommand("/Compact 参数", commands)?.command).toBe(compact);
  });

  test("未注册/前缀多敲字符不命中(原样发送)", () => {
    expect(parseSlashCommand("/compactx", commands)).toBeNull();
    expect(parseSlashCommand("/unknown", commands)).toBeNull();
    expect(parseSlashCommand("compact", commands)).toBeNull();
  });

  test("无参指令带参数视为普通文本;仅尾随空白不算参数", () => {
    expect(parseSlashCommand("/copy 什么", commands)).toBeNull();
    expect(parseSlashCommand("/copy ", commands)).toEqual({ command: copy, argument: "", tokenLength: 5 });
  });

  test("可用清单为空时一切放行", () => {
    expect(parseSlashCommand("/compact", [])).toBeNull();
  });
});
