// engines/pi-adapter.ts — pi 工作区引擎适配器(T1 收敛,行为零变化)
//
// 把既有的 runPiWorkspaceGeneration(pi 代理循环 + 上下文灌注 + 工具/资源装配)收敛为
// 一个 EngineAdapter。matches() 收编原 orchestrator.ts:711 的「工作区三道闸」能力判定
// (workspaceRuntimeForConversation):工作区可用即由 pi 接管,不可用则放行给兜底引擎。
//
// runtime 透传:matches() 已算出 WorkspaceRuntime,run()/compact() 还需要它(cwd/root
// 装配资源)。为保持「判定只在编排器入口发生一次」的语义,用模块级 WeakMap 把 matches 的
// runtime 结果带给同一会话的 run()/compact()——内部重新调用 workspaceRuntimeForConversation
// 兜底(防御弱引用被回收的极端情况),双重来源取同一判定函数,结果天然一致。

import type { Assistant, Conversation } from "../foundation/types";
import { workspaceRuntimeForConversation, type WorkspaceRuntime } from "../workspace/runtime";
import type { EngineAdapter, EngineCompactContext, EngineRunContext, PiCompactFn, PiRunFn } from "./index";

export function createPiAdapter(impl: { run: PiRunFn; compact: PiCompactFn }): EngineAdapter {
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
    run(ctx, sink, signal) {
      const withRuntime: EngineRunContext & { piRuntime: WorkspaceRuntime | null } = {
        ...ctx,
        piRuntime: runtimeFor(ctx.conversation),
      };
      return impl.run(withRuntime, sink, signal);
    },
    // pi 原生压缩(session.compact):压引擎记忆,产物由注入实现落 engineCompactions。
    compact(ctx, sink, signal) {
      const withRuntime: EngineCompactContext & { piRuntime: WorkspaceRuntime | null } = {
        ...ctx,
        piRuntime: runtimeFor(ctx.conversation),
      };
      return impl.compact(withRuntime, sink, signal);
    },
  };
}
