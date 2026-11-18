// lib/slash-commands.ts — 斜杠指令:前端解析纯函数(触发/过滤/完整判定)
//
// 方案 tmp_doc/指令体系方案-2026-09-05.md §4.1:
// - 仅文本开头的 "/" 触发;未注册或当前环境禁用的 /xxx 原样发送(不惊扰原则);
//   可用清单来自 GET /api/commands(服务端权威),前端不自行判定可用性。
// - 完整指令判定(染色与拦截共用同一判据):文本 = /写法 或 /写法␣参数,
//   写法 ∈ 可用清单(大小写不敏感);无参指令带参数视为普通文本。
// 全部为纯函数,单测见 app/tests/slash-commands.test.ts。

import type { AvailableCommandDto } from "@server/foundation/types/commands";

/** 前端指令形状 = 服务端可用清单条目(type-only 对齐,值经 API 下发)。 */
export type SlashCommandDto = AvailableCommandDto;

/** 推荐菜单触发判定:仅当文本以 "/" 开头且仍在敲指令名阶段(token 内无任何空白)
 *  时返回过滤词(小写,可为空串 = 刚敲 "/",展示全部);否则 null(菜单关闭)。
 *  出现空白即进入参数区,引导使命结束,菜单收起。 */
export function slashMenuQuery(text: string): string | null {
  if (!text.startsWith("/")) return null;
  const token = text.slice(1);
  if (/\s/.test(token)) return null;
  return token.toLowerCase();
}

/** 菜单分组(方案 §5.9 / D17):通用 → 引擎自带 → 各插件(按清单里首次出现的顺序);组内保持清单序。 */
export interface SlashCommandGroup {
  source: SlashCommandDto["source"];
  commands: SlashCommandDto[];
}

function sourceRank(source: SlashCommandDto["source"]): number {
  if (source === "app") return 0;
  if (source === "engine") return 1;
  return 2;
}

export function groupSlashCommands(commands: readonly SlashCommandDto[]): SlashCommandGroup[] {
  const groups = new Map<string, SlashCommandGroup>();
  for (const command of commands) {
    const group = groups.get(command.source);
    if (group) group.commands.push(command);
    else groups.set(command.source, { source: command.source, commands: [command] });
  }
  // sort 是稳定的:同为插件的组保持首次出现的顺序。
  return [...groups.values()].sort((a, b) => sourceRank(a.source) - sourceRank(b.source));
}

/** 过滤推荐清单:按写法(invocation)匹配,前缀命中优先其次子串命中,大小写不敏感;结果按分组排好
 *  (键盘上下移动与显示同序)。空 query 返回全部。 */
export function filterSlashCommands(commands: readonly SlashCommandDto[], query: string): SlashCommandDto[] {
  const q = query.toLowerCase();
  return groupSlashCommands(commands).flatMap(({ commands: items }) => {
    if (!q) return items;
    const prefixed: SlashCommandDto[] = [];
    const included: SlashCommandDto[] = [];
    for (const command of items) {
      const invocation = command.invocation.toLowerCase();
      if (invocation.startsWith(q)) prefixed.push(command);
      else if (invocation.includes(q)) included.push(command);
    }
    return [...prefixed, ...included];
  });
}

export interface ParsedSlashCommand {
  command: SlashCommandDto;
  /** 指令名后的参数文本(已 trim;无参数为空串)。 */
  argument: string;
  /** 指令 token 在原文中的长度(含斜杠),镜像染色用。 */
  tokenLength: number;
}

/** 完整指令判定(拦截执行与染色共用):命中返回解析结果,否则 null(按普通文本发送)。
 *  按写法认:裸名归谁由服务端定好(通用指令 > 唯一有这个名字的插件),重名的插件指令要写 name:<插件短名>,
 *  所以裸名在没人认领时不算完整指令,要从菜单里选。 */
export function parseSlashCommand(
  text: string,
  commands: readonly SlashCommandDto[],
): ParsedSlashCommand | null {
  const match = /^\/(\S+)(?:\s([\s\S]*))?$/.exec(text);
  if (!match) return null;
  const typed = match[1]!;
  const command = commands.find((c) => c.invocation.toLowerCase() === typed.toLowerCase());
  if (!command) return null;
  const argument = (match[2] ?? "").trim();
  if (argument && !command.hasArgument) return null;
  return { command, argument, tokenLength: 1 + typed.length };
}
