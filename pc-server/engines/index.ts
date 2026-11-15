// engines/index.ts — 引擎注册表与路由(P2.7 定稿)
//
// 注册表是驱动数组,顺序即优先级。路由只读驱动的声明式能力,不按引擎种类特判:会话工作区可用
// (workspaceRuntimeForConversation 的三道闸)→ 首个 workspace:"required" 的驱动;否则 → 首个
// workspace:"none" 的驱动(聊天引擎,排在最后兜底)。路由在生成/压缩入口判定一次并贯穿本次调用,
// 工作区运行时随判定结果带出(cwd/root 进 TurnInput),执行时不再重判。
//
// portable 驱动经回环传输连接(测试里 strict:每个载荷 JSON 往返),宿主是应用唯一的 appEngineHost;
// 进程内驱动直连(上游错误要以原对象到达编排器的错误归类)。具体驱动只在本模块实例化,编排器只认
// 契约(engines/engine-agnostic-guard.test.ts 锁定)。新增引擎 = 契约里追加种类字面量 + 一个驱动 +
// 本数组一行。

import type { Conversation } from "../foundation/types";
import { createPiDriver } from "../pi-engine/driver";
import { workspaceRuntimeForConversation, type WorkspaceRuntime } from "../workspace/runtime";
import { createChatDriver } from "./chat-driver";
import type { EngineDriver } from "./contract";
import { appEngineHost } from "./host";
import { reportError } from "../observability/app-errors";
import { connectDriver, connectHost, STRICT_CONTRACT_TRANSPORT } from "./loopback";

const strict = { strict: STRICT_CONTRACT_TRANSPORT };

const ENGINE_DRIVERS: readonly EngineDriver[] = [
  connectDriver(createPiDriver(connectHost(appEngineHost, strict)), strict),
  createChatDriver(),
];

export interface EngineRoute {
  driver: EngineDriver;
  /** 驱动需要工作区时为判定时刻的工作区运行时;否则 null。 */
  workspace: WorkspaceRuntime | null;
}

export function resolveEngine(conversation: Conversation): EngineRoute {
  const runtime = workspaceRuntimeForConversation(conversation);
  const wanted = runtime ? "required" : "none";
  const driver = ENGINE_DRIVERS.find((item) => item.capabilities.workspace === wanted) ?? ENGINE_DRIVERS.at(-1)!;
  return { driver, workspace: driver.capabilities.workspace === "required" ? runtime : null };
}

/** 让各引擎丢掉该会话的长驻状态(会话删除时)。失败只上报:删除本身不受影响。 */
export function invalidateEngineSessions(conversationId: string): void {
  for (const driver of ENGINE_DRIVERS) {
    driver.invalidate(conversationId).catch((err: unknown) => reportError("internal", "info", "引擎会话状态清理失败", err));
  }
}
