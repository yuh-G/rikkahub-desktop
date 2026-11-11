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
// 防循环导入:本模块不 import orchestrator;各驱动一轮的应用侧装配(进程内驱动绑会话上下文,
// portable 驱动组 TurnInput)由编排器在组装注册表时经参数注入。matches() 只做
// 路由判定,不产副作用。具体驱动只在本模块实例化,编排器不认识任何具体引擎
// (engines/engine-agnostic-guard.test.ts 锁定)。

import type { Assistant, Conversation, Model, Provider } from "../foundation/types";
import type { GenerationEventSink, GenerationTarget, ToolExecutor } from "../inference-engine/events";
import { createPiDriver } from "../pi-engine/driver";
import type { WorkspaceRuntime } from "../workspace/runtime";
import { createChatAdapter } from "./chat-adapter";
import { createChatDriver } from "./chat-driver";
import type { EngineDriver, EngineKind, EngineResumeSemantics, EngineSteeringSupport } from "./contract";
import { appEngineHost } from "./host";
import { connectDriver, connectHost, STRICT_CONTRACT_TRANSPORT } from "./loopback";
import { createPiAdapter } from "./pi-adapter";

// 三个能力枚举的定义已迁到契约(engines/contract.ts);旧形状在 P2.7 删除前经这里转出。
export type { EngineKind, EngineResumeSemantics, EngineSteeringSupport };

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
  /** 执行摘要的模型(「设置 → 模型 → 场景模型」的压缩模型,公共基础设施:配置即对
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

/** 进程内驱动一轮生成的应用侧装配(绑进程内上下文、转发中止、调 driver.startTurn)。 */
export type InProcessRunFn = (
  ctx: EngineRunContext & { driver: EngineDriver },
  sink: GenerationEventSink,
  signal?: AbortSignal,
) => Promise<string>;
/** portable 驱动的调用目标:驱动句柄 + adapter 在 matches() 判定出的工作区 runtime
 *  (经 WeakMap 透传)。 */
export interface PortableTarget {
  driver: EngineDriver;
  workspace: WorkspaceRuntime | null;
}
/** portable 驱动一轮生成的应用侧装配(组 TurnInput、绑宿主上下文、调 driver.startTurn)。 */
export type PortableRunFn = (
  ctx: EngineRunContext & PortableTarget,
  sink: GenerationEventSink,
  signal?: AbortSignal,
) => Promise<string>;
/** portable 驱动原生压缩的应用侧装配(与 PortableRunFn 同构)。 */
export type PortableCompactFn = (
  ctx: EngineCompactContext & PortableTarget,
  sink: GenerationEventSink,
  signal?: AbortSignal,
) => Promise<EngineCompactionResult>;

/** 组装引擎注册表(编排器在模块加载时调用一次)。顺序即优先级:pi 在前(能力命中
 *  才接管),chat 恒兜底。新增引擎往数组前部插(chat 必须保持最后兜底)。
 *  portable 驱动经回环传输连接(测试里 strict:每个载荷 JSON 往返),宿主是应用唯一的
 *  appEngineHost;进程内驱动直连(上游错误要以原对象到达编排器的错误归类)。 */
export function createEngineRegistry(deps: {
  inProcessRun: InProcessRunFn;
  portableRun: PortableRunFn;
  portableCompact: PortableCompactFn;
}): EngineAdapter[] {
  const strict = { strict: STRICT_CONTRACT_TRANSPORT };
  const piDriver = connectDriver(createPiDriver(connectHost(appEngineHost, strict)), strict);
  return [
    createPiAdapter({ driver: piDriver, run: deps.portableRun, compact: deps.portableCompact }),
    createChatAdapter({ driver: createChatDriver(), run: deps.inProcessRun }),
  ];
}

/** 路由:遍历注册表取首个 matches() 命中的 adapter;数组恒含 chat 兜底,不会空。 */
export function resolveEngine(
  registry: EngineAdapter[],
  conversation: Conversation,
  assistant: Assistant,
): EngineAdapter {
  return registry.find((adapter) => adapter.matches(conversation, assistant)) ?? registry[registry.length - 1]!;
}
