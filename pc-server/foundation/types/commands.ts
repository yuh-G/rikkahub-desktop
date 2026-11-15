// foundation/types/commands.ts — 斜杠指令跨端契约(叶子模块,web-ui type-only 消费)
//
// 纪律:web-ui 经 @server 别名只允许 type-only import,且只允许指向 foundation/types
// 下的叶子模块——若直接 type-import commands/registry.ts(运行时模块),tsc 会顺着
// import 图把 engines/runner 等服务端运行时代码整个拖进 web-ui 的类型检查语境。
// 指令定义与可用性矩阵住 commands/registry.ts;这里只放前端可见的 DTO 形状。

/** 指令执行目标:server = 前端调某个既有/专用 REST API;client = 纯前端动作(入口类通用指令,执行界面上对应
 *  按钮的同一个处理函数);engine = 引擎特色指令,前端调 POST /api/conversations/:id/command。
 *  注册表只声明目标类型,具体执行器在前端分发表。 */
export type CommandExecutionTarget = "server" | "client" | "engine";

/** app = 应用的通用指令;engine = 引擎自带;plugin:<插件 id> = 插件登记的。菜单按它分组(方案 §5.9)。 */
export type CommandSource = "app" | "engine" | `plugin:${string}`;

/** GET /api/commands 下发的可用指令条目(定义中与环境无关的展示/执行字段)。 */
export interface AvailableCommandDto {
  /** 用户输入的名字(英文小写,不带斜杠,不翻译)。通用指令全局唯一;引擎特色指令可以与通用指令或彼此同名。
   *  通用指令的前端 i18n key 约定:commands.<name>.description / commands.<name>.argument_hint */
  name: string;
  /** 是否接受参数(/name <参数>)。false 的指令带参数视为普通文本,不拦截。 */
  hasArgument: boolean;
  executionTarget: CommandExecutionTarget;
  source: CommandSource;
  /** 输入框里的写法(不带斜杠),清单内唯一:裸名,或重名时的 name:<插件短名>。 */
  invocation: string;
  /** 引擎特色指令的说明原文(通用指令的说明走前端 i18n)。 */
  description?: string;
  /** 引擎特色指令的执行键(原样交给执行接口)。 */
  commandId?: string;
}
