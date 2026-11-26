// commands/registry.ts — 斜杠指令体系:全局指令定义单源 + 可用性矩阵
//
// 定位(方案 tmp_doc/指令体系方案-2026-09-05.md,三元模型):
// - 指令定义是产品层的全局资产,任何模式/引擎看到的 /name 都是同一个指令;
//   模式/引擎只有「启用/禁用」与「绑定哪个实现」两项权利,没有另立指令的权利。
// - 本表只声明「定义 + 可用性(启用/禁用)」。「绑哪个实现」不在此重复表达——
//   由执行链路天然承载(引擎驱动的可选能力 = 原生绑定;缺席 = 共享沉淀
//   实现兜底,如 /compact 的 UI 历史压缩),避免同一事实两处声明后漂移。
//   注册表声明 pi 可用而 pi 驱动无对应能力,属于集成测试要抓的矛盾。
// - 可用性判定必须在服务端:引擎路由(engines/index resolveEngine)的判定材料(会话与工作区)
//   只有服务端权威。前端经 GET /api/commands 消费,不得自行判定。
// - 本模块保持纯函数、零 orchestrator 依赖(防循环导入):引擎路由结果(EngineKind)
//   由 api handler 调 resolveEngineForConversation 后传入。
// - 两类(方案 §5.9,D17/D18):通用指令(本表)与引擎特色指令(驱动 listCommands 按会话给出:插件指令、引擎自带
//   指令),mergeEngineCommands 合成一份下发,每条带来源。通用指令再分两种:入口类(通往应用资产的入口,谁来做都
//   一样;执行界面上对应按钮的同一个处理函数)与能力类(做法本身有设计;引擎有原生实现就绑原生)。
//   重名:引擎自带的同名指令不单列(它就是通用指令在该引擎的原生绑定);插件与入口类同名 → 拿掉并记审计
//   (引擎侧裁决层已按名单删过,这里按本表兜底);与能力类同名、或多个插件同名 → 都保留,按来源分组显示。
//   写法:裸名归通用;没有通用指令时只有一个插件有这个名字归该插件;其余写成 name:<插件短名>。
// - 纪律:web-ui 不得 import 本文件(连 type-only 都不行——tsc 会顺 import 图把
//   engines/runner 等运行时代码拖进前端类型检查语境)。跨端 DTO 契约住
//   foundation/types/commands.ts(叶子模块),运行时值经 GET /api/commands 下发。

import type { AvailableCommandDto, CommandExecutionTarget } from "../foundation/types/commands";
import type { EngineCommand, EngineKind } from "../engines/contract";

export interface CommandDefinition {
  /** 全局唯一名(英文小写,即用户输入的 /name,不翻译——肌肉记忆惯例)。
   *  前端 i18n key 约定:commands.<name>.description / commands.<name>.argument_hint */
  name: string;
  /** 是否接受参数(/name <参数>)。false 的指令带参数视为普通文本,不拦截。 */
  hasArgument: boolean;
  /** entry = 入口类(executionTarget 为 client,插件不能同名);capability = 能力类(插件同名并列)。 */
  kind: "entry" | "capability";
  executionTarget: CommandExecutionTarget;
  /** 可用性矩阵(绑定矩阵的启用/禁用维度):按环境逐一声明,缺省 = 禁用。
   *  白名单心智:新引擎登记进 engines/index 的驱动数组后,每个指令对它都是禁用,直到
   *  在这里显式点亮——强制完成「评估绑定」动作,防新引擎意外继承不适配的指令。
   *  已拍板(2026-09-05):禁用是开发者侧概念,对用户完全不可见(推荐列表不出现、
   *  不染色、不拦截,视同指令在该环境不存在)。 */
  availability: {
    /** 对话模式(chat 引擎会话)。 */
    chat: boolean;
    /** 工作区模式按引擎细分(EngineKind 开放枚举;应用级指令也无豁免权,
     *  任何引擎都可对任何指令一票否决)。 */
    workspace: Partial<Record<EngineKind, boolean>>;
  };
}

/** 入口类:前端执行,行与 client-commands.ts 的名单一一对应(两端测试锁住);对话模式与 pi 工作区都可用。 */
const entry = (name: string): CommandDefinition => ({
  name,
  hasArgument: false,
  kind: "entry",
  executionTarget: "client",
  availability: { chat: true, workspace: { pi: true } },
});

/** 全局指令表(后续指令 = 追加一行 + 绑实现,见方案 §6 路线图)。顺序即菜单「通用」组里的顺序。 */
export const COMMAND_REGISTRY: readonly CommandDefinition[] = [
  {
    // /compact [额外指示] —— 压缩会话上下文。执行入口复用既有
    // POST /api/conversations/:id/compress(引擎原生优先,chat 回落 UI 历史压缩;
    // 参数透传 additionalPrompt/customInstructions)。回车直接执行,不弹压缩框
    // (压缩框保留为精细参数入口,两入口同 API 同状态通道)。
    name: "compact",
    hasArgument: true,
    kind: "capability",
    executionTarget: "server",
    availability: { chat: true, workspace: { pi: true } },
  },
  // 名单本身住叶子模块(web-ui 运行时要引用,不能 import 本文件);这里逐个写出,注册表一眼可读。
  entry("new"),
  entry("fork"),
  entry("name"),
  entry("model"),
  entry("thinking"),
  entry("mcp"),
  entry("skill"),
  entry("settings"),
];

/** 解析某环境此刻的可用通用指令。engineKind 是引擎路由(resolveEngine)的产物:
 *  "chat" = 对话模式,其余 = 工作区模式按引擎查矩阵(缺省禁用)。 */
export function resolveAvailableCommands(
  engineKind: EngineKind,
  registry: readonly CommandDefinition[] = COMMAND_REGISTRY,
): AvailableCommandDto[] {
  return registry
    .filter((command) => {
      if (engineKind === "chat") return command.availability.chat;
      return command.availability.workspace[engineKind] ?? false;
    })
    .map(({ name, hasArgument, executionTarget }) => ({ name, hasArgument, executionTarget, source: "app", invocation: name }));
}

/** 插件短名(限定写法用):插件 id(`<引擎>:<包名>` / `dev:<名>`)去掉前缀与包的作用域
 *  (pi:@demo/todo → todo,dev:guard → guard)。两个插件短名相同时,合并处退回完整 id。 */
export function pluginShortName(pluginId: string): string {
  const colon = pluginId.indexOf(":");
  const name = colon >= 0 && colon < pluginId.length - 1 ? pluginId.slice(colon + 1) : pluginId;
  const slash = name.lastIndexOf("/");
  return slash >= 0 && slash < name.length - 1 ? name.slice(slash + 1) : name;
}

/** 通用指令 + 引擎特色指令 → 下发清单(规则见头注)。removed = 与入口类同名而被拿掉的插件指令(调用方记审计)。
 *  输入框敲不出来的名字(含空白)不列。 */
export function mergeEngineCommands(
  engineKind: EngineKind,
  engineCommands: readonly EngineCommand[],
  registry: readonly CommandDefinition[] = COMMAND_REGISTRY,
): { commands: AvailableCommandDto[]; removed: EngineCommand[] } {
  const app = resolveAvailableCommands(engineKind, registry);
  const appNames = new Set(app.map((command) => command.name));
  const entryNames = new Set(registry.filter((command) => command.kind === "entry").map((command) => command.name));
  const removed: EngineCommand[] = [];
  const kept: EngineCommand[] = [];
  for (const command of engineCommands) {
    if (!command.name || /\s/.test(command.name)) continue;
    if (command.source === "engine") {
      if (!appNames.has(command.name) && !entryNames.has(command.name)) kept.push(command);
    } else if (entryNames.has(command.name)) {
      removed.push(command);
    } else {
      kept.push(command);
    }
  }
  const counts = new Map<string, number>();
  for (const command of kept) counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
  const owns = (command: EngineCommand) => !appNames.has(command.name) && counts.get(command.name) === 1;
  const taken = new Set(app.map((command) => command.invocation));
  const invocations = new Map<EngineCommand, string>();
  // 裸名先占,限定写法后排;限定写法撞了(两个插件短名相同)退回完整来源。
  for (const command of kept.filter(owns)) {
    invocations.set(command, command.name);
    taken.add(command.name);
  }
  for (const command of kept.filter((item) => !owns(item))) {
    const sourceId = command.source === "engine" ? engineKind : command.source.slice("plugin:".length);
    const short = command.source === "engine" ? engineKind : pluginShortName(sourceId);
    let invocation = `${command.name}:${short}`;
    if (taken.has(invocation)) invocation = `${command.name}:${sourceId}`;
    invocations.set(command, invocation);
    taken.add(invocation);
  }
  const engine = kept.map(
    (command): AvailableCommandDto => ({
      name: command.name,
      hasArgument: true,
      executionTarget: "engine",
      source: command.source,
      invocation: invocations.get(command)!,
      ...(command.description ? { description: command.description } : {}),
      commandId: command.id,
    }),
  );
  return { commands: [...app, ...engine], removed };
}
