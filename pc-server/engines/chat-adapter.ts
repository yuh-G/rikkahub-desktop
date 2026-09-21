// engines/chat-adapter.ts — 聊天引擎适配器(T1 收敛,行为零变化)
//
// 把既有的 callProviderStreaming(三家 Provider 流式 + 工具循环)收敛为一个
// EngineAdapter。matches() 恒 true——它是注册表的兜底引擎(排在最后),任何会话
// 没被更靠前的引擎(如 pi)接管时由它跑。生成逻辑本体仍在 orchestrator 的
// callProviderStreaming,经工厂参数注入,本文件只做契约封装,不含 Provider 细节。

import type { Assistant, Conversation } from "../foundation/types";
import type { ChatRunFn, EngineAdapter } from "./index";

export function createChatAdapter(chatRun: ChatRunFn): EngineAdapter {
  return {
    kind: "chat",
    // 兜底引擎:恒命中。注册表顺序保证它最后才被轮到(resolveEngine 取首个命中)。
    matches(_conversation: Conversation, _assistant: Assistant): boolean {
      return true;
    },
    // 聊天引擎=整批暂停→逐卡批准→重触发续跑(resumeApprovedToolParts)。
    resumeSemantics: "pause-resume",
    // 工具循环骨架在工具轮边界与最终轮调用 onSteerBoundary(inference-engine/tool-loop absorbSteering)。
    steering: "boundary",
    run(ctx, sink, signal) {
      return chatRun(ctx, sink, signal);
    },
  };
}
