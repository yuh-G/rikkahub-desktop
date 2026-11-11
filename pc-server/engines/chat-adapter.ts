// engines/chat-adapter.ts — 聊天引擎适配器(T1 收敛;P2.4 起包一个进程内驱动)
//
// 把聊天驱动(engines/chat-driver)收敛为一个 EngineAdapter。matches() 恒 true——它是注册表的
// 兜底引擎(排在最后),任何会话没被更靠前的引擎(如 pi)接管时由它跑。种类与能力声明直接读
// 驱动;一轮的应用侧装配(进程内绑定、中止转发)由编排器经 run 注入。

import type { Assistant, Conversation } from "../foundation/types";
import type { EngineDriver } from "./contract";
import type { EngineAdapter, InProcessRunFn } from "./index";

export function createChatAdapter(impl: { driver: EngineDriver; run: InProcessRunFn }): EngineAdapter {
  const { driver } = impl;
  return {
    kind: driver.kind,
    // 兜底引擎:恒命中。注册表顺序保证它最后才被轮到(resolveEngine 取首个命中)。
    matches(_conversation: Conversation, _assistant: Assistant): boolean {
      return true;
    },
    resumeSemantics: driver.capabilities.resumeSemantics,
    steering: driver.capabilities.steering,
    run(ctx, sink, signal) {
      return impl.run({ ...ctx, driver }, sink, signal);
    },
  };
}
