// engines/index.ts — 引擎抽象契约 + 注册表(T1 路由枚举化)
//
// 定位:把「引擎」从布尔(piRuntime 有/无)提升为一等的、可枚举、可注册的概念。
// 这是多引擎拓展的唯一接入面——第三引擎(dsh)、第四/五候选(codex/claude-code)
// 落地时各新增一个 adapter 并注册进 ENGINE_REGISTRY,不改动共享面、不改动已有引擎。
//
// 最小抽象纪律(防「把 pi 形状烙进公共契约」):EngineRunContext 只含引擎无关输入包
// (会话 + 消息 + 助手/Provider/模型快照 + 工具执行闭包);引擎专属决策(pi 的工作区
// runtime、子进程引擎的 spawn 句柄)由各 adapter 在 matches()/run() 内部自行解析,
// 不进公共契约。进程内引擎(chat/pi)与子进程引擎(dsh/codex,见 T4 骨架)共享同一
// 输出契约 GenerationEvent,前端永远无感知。
//
// 防循环导入:本模块不 import orchestrator;两个引擎的生成函数(callProviderStreaming /
// runPiWorkspaceGeneration)由编排器在组装注册表时经参数注入。matches() 只做路由判定,
// 不产副作用。

import type { Assistant, Conversation, Model, Provider } from "../foundation/types";
import type { GenerationEventSink, GenerationTarget, ToolExecutor } from "../inference-engine/events";
import type { WorkspaceRuntime } from "../workspace/runtime";
import { createChatAdapter } from "./chat-adapter";
import { createPiAdapter } from "./pi-adapter";

/** 引擎种类(开放枚举)。新增引擎 = 追加一个字面量 + 一个 adapter + 注册一行。 */
export type EngineKind = "chat" | "pi" | "dsh" | "codex" | "claude-code" | (string & {});

/** 审批续跑语义(替代 orchestrator.ts 写死的 `!piRuntime` 二选一):
 *  - "pause-resume":聊天引擎——待审批工具整批暂停生成,用户逐卡批准后重触发续跑
 *    (resumeApprovedToolParts + hasPendingToolApproval 收尾)。
 *  - "run-and-suspend":pi 引擎——生成保持在跑,单个工具调用挂起等待审批门放行
 *    (approval-gate 汇合),不重触发整轮。
 *  子进程引擎届时按其审批模型声明。 */
export type EngineResumeSemantics = "pause-resume" | "run-and-suspend";

/** steering 能力声明(生成中补发的用户消息如何送达模型):
 *  - "boundary":引擎在「即将构建下一模型请求之前」调用 ctx.onSteerBoundary(),把返回文本
 *    作为 user turn 喂给模型(聊天引擎 = 工具轮边界 + 最终轮;pi = turn_end)。协调器在同一
 *    调用里完成数据层分裂(定格当前节点 / 落库 steer user / 新开 continuation 节点 / 换绑落点),
 *    引擎经 ctx.target 活视图自动跟随。
 *  - "none":引擎无注入位点(单次不透明请求等)。协调器不下发回调,补发消息留在 FIFO 队列由
 *    收尾派发兜底——视觉序仍是 [ai_1, user_2, ai_2],只是晚到生成结束;按构造优雅降级,
 *    不会出现半吸收状态。
 *  必填:新引擎接入时必须显式选择,忘了调回调不会静默丢能力(契约测试锁每个 "boundary"
 *  引擎的真实调用)。 */
export type EngineSteeringSupport = "boundary" | "none";

/** 引擎无关的生成输入包(编排器入口一次性装配,贯穿本次生成)。 */
export interface EngineRunContext {
  conversation: Conversation;
  /** 流式落点(活视图,协调器持有可换绑实现)。引擎每次现读 target.node/target.message,
   *  不得解构缓存——steer 边界分裂会把落点换到新开的 continuation 节点。 */
  target: GenerationTarget;
  assistant: Assistant;
  provider: Provider;
  model: Model;
  /** 工具执行闭包(协调器注入,内部已挂生成级 signal 与部分输出回写)。 */
  executeTool: ToolExecutor;
  /** steering 轮边界(用户问题②,对齐 Codex pending_input):声明 steering:"boundary" 的引擎
   *  在「即将构建下一模型请求之前」调用,取「生成中补发」的用户消息文本(协调器已同步
   *  落库、换绑落点并通知 FIFO 队列移除)。返回空数组 = 无注入。声明 "none" 的引擎收不到
   *  此回调(协调器不下发)。 */
  onSteerBoundary?: () => string[];
}

/** 引擎无关的压缩输入包(编排器压缩入口装配,与 EngineRunContext 同哲学:
 *  只含引擎无关输入,引擎专属决策由各 adapter 内部解析)。 */
export interface EngineCompactContext {
  conversation: Conversation;
  assistant: Assistant;
  provider: Provider;
  model: Model;
  /** 执行摘要的模型(「设置-默认模型与提示词」的压缩模型,公共基础设施:配置即对
   *  所有引擎生效;未配置=会话模型)。与 provider/model 的角色分工:后者是"压缩对象
   *  的视角"——窗口锚定/富化裁决/上下文极限都按会话模型算,摘要文本由 summarizer
   *  生成。引擎用不了此模型时(如 pi 映射失败)由 adapter 自行回退会话模型——
   *  公共设置是偏好不是硬约束,压缩必须总能进行。 */
  summarizer: { provider: Provider; model: Model };
  /** 用户附加指示(compress 框的 additionalPrompt)。 */
  customInstructions: string;
}

/** 引擎原生压缩的产出(展示/日志用途)。压缩记录落库(conversation.engineCompactions)
 *  是各引擎注入实现的义务——与生成路径的压缩捕获同一落点、同一 helper。 */
export interface EngineCompactionResult {
  summary: string;
  tokensBefore: number;
  /** 引擎对压缩后上下文的估算(拿不到为 null)。 */
  estimatedTokensAfter: number | null;
}

export interface EngineAdapter {
  readonly kind: EngineKind;
  /** 路由判定:该会话是否由本引擎接管。注册表按序取首个命中;chat 恒 true 兜底。 */
  matches(conversation: Conversation, assistant: Assistant): boolean;
  readonly resumeSemantics: EngineResumeSemantics;
  readonly steering: EngineSteeringSupport;
  /** 驱动一次生成,经 sink 发出 GenerationEvent,返回最终文本(steer 分裂后为当前段口径)。 */
  run(ctx: EngineRunContext, sink: GenerationEventSink, signal?: AbortSignal): Promise<string>;
  /** 可选能力:引擎原生压缩(压引擎记忆,UI 历史不动)。每个引擎的压缩机制独立设计
   *  (prompt/切点语义各异),但共享同一调用面与 engine_status 瞬态状态通道(经 sink,
   *  广播与终局清条由调用方统一负责)。未声明 = 该引擎无原生压缩,调用方回落
   *  UI 历史压缩。 */
  compact?(ctx: EngineCompactContext, sink: GenerationEventSink, signal?: AbortSignal): Promise<EngineCompactionResult>;
}

/** 生成函数注入形状:编排器把真实实现注入 adapter 工厂,engines/ 与 orchestrator 解耦。 */
export type ChatRunFn = (
  ctx: EngineRunContext,
  sink: GenerationEventSink,
  signal?: AbortSignal,
) => Promise<string>;
/** pi 生成实现签名:除引擎无关输入包外,还需 pi adapter 在 run() 内注入的工作区
 *  runtime(matches() 判定产物,经 WeakMap 透传)。 */
export type PiRunFn = (
  ctx: EngineRunContext & { piRuntime: WorkspaceRuntime | null },
  sink: GenerationEventSink,
  signal?: AbortSignal,
) => Promise<string>;
/** pi 压缩实现签名:与 PiRunFn 同构(引擎无关输入包 + adapter 透传的 runtime)。 */
export type PiCompactFn = (
  ctx: EngineCompactContext & { piRuntime: WorkspaceRuntime | null },
  sink: GenerationEventSink,
  signal?: AbortSignal,
) => Promise<EngineCompactionResult>;

/** 组装引擎注册表(编排器在模块加载时调用一次)。顺序即优先级:pi 在前(能力命中
 *  才接管),chat 恒兜底。新增引擎往数组前部插(chat 必须保持最后兜底)。 */
export function createEngineRegistry(deps: {
  chatRun: ChatRunFn;
  piRun: PiRunFn;
  piCompact: PiCompactFn;
}): EngineAdapter[] {
  return [createPiAdapter({ run: deps.piRun, compact: deps.piCompact }), createChatAdapter(deps.chatRun)];
}

/** 路由:遍历注册表取首个 matches() 命中的 adapter;数组恒含 chat 兜底,不会空。 */
export function resolveEngine(
  registry: EngineAdapter[],
  conversation: Conversation,
  assistant: Assistant,
): EngineAdapter {
  return registry.find((adapter) => adapter.matches(conversation, assistant)) ?? registry[registry.length - 1]!;
}
