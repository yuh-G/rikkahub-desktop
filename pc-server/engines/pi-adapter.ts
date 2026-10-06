// engines/pi-adapter.ts — pi 工作区引擎适配器(T1 收敛,行为零变化)
//
// 把 pi 的装配实现(pi-engine/assembly:runPiWorkspaceGeneration / runPiWorkspaceCompaction)
// 收敛为一个 EngineAdapter。matches() 收编「工作区三道闸」能力判定
// (workspaceRuntimeForConversation):工作区可用即由 pi 接管,不可用则放行给兜底引擎。
//
// runtime 透传:matches() 已算出 WorkspaceRuntime,run()/compact() 还需要它(cwd/root
// 装配资源)。为保持「判定只在编排器入口发生一次」的语义,用模块级 WeakMap 把 matches 的
// runtime 结果带给同一会话的 run()/compact()——内部重新调用 workspaceRuntimeForConversation
// 兜底(防御弱引用被回收的极端情况),双重来源取同一判定函数,结果天然一致。

import type { Assistant, Conversation } from "../foundation/types";
import type { GenerationEventSink } from "../inference-engine/events";
import { workspaceRuntimeForConversation, type WorkspaceRuntime } from "../workspace/runtime";
import type { EngineAdapter, EngineCompactContext, EngineCompactionResult, EngineRunContext } from "./index";

/** pi 专属输入:引擎无关输入包 + adapter 透传的工作区 runtime(matches() 判定产物)。
 *  这是 pi 私有形状,只在 adapter 与其装配实现之间流动,不进公共契约(engines/index)。 */
export type PiRunContext = EngineRunContext & { piRuntime: WorkspaceRuntime | null };
export type PiCompactContext = EngineCompactContext & { piRuntime: WorkspaceRuntime | null };

export interface PiEngineImpl {
  run(ctx: PiRunContext, sink: GenerationEventSink, signal?: AbortSignal): Promise<string>;
  compact(ctx: PiCompactContext, sink: GenerationEventSink, signal?: AbortSignal): Promise<EngineCompactionResult>;
}

export function createPiAdapter(impl: PiEngineImpl): EngineAdapter {
  const runtimeByConversation = new WeakMap<Conversation, WorkspaceRuntime>();
  const runtimeFor = (conversation: Conversation): WorkspaceRuntime | null =>
    runtimeByConversation.get(conversation) ?? workspaceRuntimeForConversation(conversation);
  return {
    kind: "pi",
    matches(conversation: Conversation, _assistant: Assistant): boolean {
      const runtime = workspaceRuntimeForConversation(conversation);
      if (!runtime) return false;
      runtimeByConversation.set(conversation, runtime);
      return true;
    },
    // pi 引擎=生成保持在跑、单个工具调用挂起等待审批门放行(approval-gate 汇合),
    // 不整批暂停重触发。
    resumeSemantics: "run-and-suspend",
    // runner 在 pi turn_end 调用 onSteerBoundary,文本经 session.steer() 入 pi steering 队列。
    steering: "boundary",
    // 进程内引擎、请求在 pi SDK 内部发出 → 经宿主请求通道(只能在通道层记日志)。
    transport: { mode: "host", requestLog: "transport" },
    run(ctx, sink, signal) {
      return impl.run({ ...ctx, piRuntime: runtimeFor(ctx.conversation) }, sink, signal);
    },
    // pi 原生压缩(session.compact):压引擎记忆,产物由装配实现落 engineCompactions。
    compact(ctx, sink, signal) {
      return impl.compact({ ...ctx, piRuntime: runtimeFor(ctx.conversation) }, sink, signal);
    },
  };
}
