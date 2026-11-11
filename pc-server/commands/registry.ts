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
// - 纪律:web-ui 不得 import 本文件(连 type-only 都不行——tsc 会顺 import 图把
//   engines/runner 等运行时代码拖进前端类型检查语境)。跨端 DTO 契约住
//   foundation/types/commands.ts(叶子模块),运行时值经 GET /api/commands 下发。

import type { AvailableCommandDto, CommandExecutionTarget } from "../foundation/types/commands";
import type { EngineKind } from "../engines/contract";

export interface CommandDefinition {
  /** 全局唯一名(英文小写,即用户输入的 /name,不翻译——肌肉记忆惯例)。
   *  前端 i18n key 约定:commands.<name>.description / commands.<name>.argument_hint */
  name: string;
  /** 是否接受参数(/name <参数>)。false 的指令带参数视为普通文本,不拦截。 */
  hasArgument: boolean;
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

/** 全局指令表(V1 仅 /compact;后续指令 = 追加一行 + 绑实现,见方案 §6 路线图)。 */
export const COMMAND_REGISTRY: readonly CommandDefinition[] = [
  {
    // /compact [额外指示] —— 压缩会话上下文。执行入口复用既有
    // POST /api/conversations/:id/compress(引擎原生优先,chat 回落 UI 历史压缩;
    // 参数透传 additionalPrompt/customInstructions)。回车直接执行,不弹压缩框
    // (压缩框保留为精细参数入口,两入口同 API 同状态通道)。
    name: "compact",
    hasArgument: true,
    executionTarget: "server",
    availability: { chat: true, workspace: { pi: true } },
  },
];

/** 解析某环境此刻的可用指令清单。engineKind 是引擎路由(resolveEngine)的产物:
 *  "chat" = 对话模式,其余 = 工作区模式按引擎查矩阵(缺省禁用)。 */
export function resolveAvailableCommands(engineKind: EngineKind): AvailableCommandDto[] {
  return COMMAND_REGISTRY.filter((command) => {
    if (engineKind === "chat") return command.availability.chat;
    return command.availability.workspace[engineKind] ?? false;
  }).map(({ name, hasArgument, executionTarget }) => ({ name, hasArgument, executionTarget }));
}
