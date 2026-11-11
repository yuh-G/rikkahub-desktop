// engines/pi-adapter.ts — 工作区引擎适配器(T1 收敛;P2.2 起包一个 portable 驱动)
//
// 把 portable 驱动(生产 = pi 驱动,经回环传输连接)收敛为一个 EngineAdapter。matches()
// 收编「工作区三道闸」能力判定(workspaceRuntimeForConversation):工作区可用即由本引擎
// 接管,不可用则放行给兜底引擎。种类与能力声明直接读驱动,不在这里另写一份。
//
// runtime 透传:matches() 已算出 WorkspaceRuntime,run()/compact() 还需要它(cwd/root
// 进 TurnInput)。为保持「判定只在编排器入口发生一次」的语义,用模块级 WeakMap 把 matches 的
// runtime 结果带给同一会话的 run()/compact()——内部重新调用 workspaceRuntimeForConversation
// 兜底(防御弱引用被回收的极端情况),双重来源取同一判定函数,结果天然一致。

import type { Assistant, Conversation } from "../foundation/types";
import { workspaceRuntimeForConversation, type WorkspaceRuntime } from "../workspace/runtime";
import type { EngineDriver } from "./contract";
import type { EngineAdapter, PortableCompactFn, PortableRunFn } from "./index";

export function createPiAdapter(impl: { driver: EngineDriver; run: PortableRunFn; compact: PortableCompactFn }): EngineAdapter {
  const { driver } = impl;
  const runtimeByConversation = new WeakMap<Conversation, WorkspaceRuntime>();
  const runtimeFor = (conversation: Conversation): WorkspaceRuntime | null =>
    runtimeByConversation.get(conversation) ?? workspaceRuntimeForConversation(conversation);
  return {
    kind: driver.kind,
    matches(conversation: Conversation, _assistant: Assistant): boolean {
      const runtime = workspaceRuntimeForConversation(conversation);
      if (!runtime) return false;
      runtimeByConversation.set(conversation, runtime);
      return true;
    },
    resumeSemantics: driver.capabilities.resumeSemantics,
    steering: driver.capabilities.steering,
    run(ctx, sink, signal) {
      return impl.run({ ...ctx, driver, workspace: runtimeFor(ctx.conversation) }, sink, signal);
    },
    // 引擎原生压缩:压引擎记忆,产物由注入实现落 engineCompactions。
    ...(driver.capabilities.nativeCompaction
      ? {
          compact: (ctx, sink, signal) =>
            impl.compact({ ...ctx, driver, workspace: runtimeFor(ctx.conversation) }, sink, signal),
        }
      : {}),
  } satisfies EngineAdapter;
}
