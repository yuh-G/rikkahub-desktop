// engines/chat-driver.ts — 聊天引擎的 EngineDriver 实现(P2.4,placement: "in-process-only")
//
// 聊天引擎是应用自研的循环(inference-engine/chat-generation),直接读写活的会话对象:落点活视图、
// 工具执行闭包、配置快照都经进程内绑定(engines/host 的 inProcess)按 turnId 取,不收 TurnInput。
// 它也不经回环传输连接:上游错误要以原对象到达编排器的错误归类(classifyProxyError 等看错误
// 类型与 cause 链),JSON 往返会把它们压扁成 { name, message, code }。
//
// 取消与 pi 驱动同形:abort(conversationId) 中止该会话登记的控制器。登记发生在 startTurn 的同步
// 前缀里,编排器在调用之前挂好中止监听,所以调用期间的任何中止都落在这一轮上。

import { callProviderStreaming } from "../inference-engine/chat-generation";
import type { EngineCapabilities, EngineDriver, TurnRequest, TurnResult } from "./contract";
import { boundTurn } from "./host";

const CHAT_CAPABILITIES: EngineCapabilities = {
  // 待审批工具整批暂停生成,用户逐卡批准后由编排器重触发续跑(resumeApprovedToolParts)。
  resumeSemantics: "pause-resume",
  // 工具循环骨架在工具轮边界与最终轮排水补发(inference-engine/tool-loop absorbSteering)。
  steering: "boundary",
  // 没有引擎记忆:请求每轮从界面历史构建,压缩回落界面历史压缩。
  nativeCompaction: false,
  // 不用工作区:工作区不可用(无工作区、缺根、未信任)的会话都由它兜底。
  workspace: "none",
  placement: "in-process-only",
};

export function createChatDriver(): EngineDriver {
  const running = new Map<string, AbortController>();

  return {
    kind: "chat",
    capabilities: CHAT_CAPABILITIES,

    async startTurn(req: TurnRequest): Promise<TurnResult> {
      const binding = boundTurn(req.turnId);
      const turn = binding?.inProcess;
      if (!binding || !turn) throw new Error("聊天引擎缺少进程内绑定(编排器未按进程内驱动装配本轮)。");
      // 同会话已有登记时覆盖(旧轮已被应用中止);释放按控制器身份,旧轮收尾不会误删新登记。
      const controller = new AbortController();
      running.set(req.conversationId, controller);
      try {
        const text = await callProviderStreaming(turn.conversation, turn.target, {
          signal: controller.signal,
          sink: binding.sink,
          executeTool: turn.executeTool,
          onSteerBoundary: binding.steer,
          snapshot: { assistant: turn.assistant, provider: turn.provider, model: turn.model },
        });
        return { text, stopReason: null, compactions: [] };
      } finally {
        if (running.get(req.conversationId) === controller) running.delete(req.conversationId);
      }
    },

    async abort(conversationId: string, reason: string): Promise<void> {
      running.get(conversationId)?.abort(new DOMException(`Generation ${reason}`, "AbortError"));
    },

    // 没有跨轮状态:每轮从界面历史构建请求。
    async invalidate(): Promise<void> {},

    async dispose(): Promise<void> {
      for (const controller of running.values()) controller.abort();
      running.clear();
    },
  };
}
