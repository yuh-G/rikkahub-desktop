// pi-engine/session-host.ts — 长驻 pi 会话(P5.6)
//
// 每个会话最多一个活的 AgentSession,跨轮复用:插件的内存态(session_start 只发一次)、模型运行时与工具
// 定义都留着。是否接着用由 runner 每轮判定:配置键(模型授权、推理档位、指令、插件、工具、工作区)相同,
// 且活会话按模型可见内容与本轮视图重建出的会话逐条相同(session-view 的 matchLiveSession);否则关掉重建。
// 应用对会话的改动(编辑、重新生成、分支切换、别的引擎写的回答、压缩)都因此自动生效,不需要通知。
//
// 每轮变化的接线(凭据、请求日志、审批、工具调用、界面通道)装在 routes 里,会话里登记的是委托到 routes
// 的版本;轮次结束清空,轮次之间插件的对话框按取消回答、工具调用以错误拒绝。
//
// 引擎发起的轮次:轮次之间插件 sendMessage({triggerTurn}) 不在这里直接开跑(会绕过应用的落点与持久化),
// 而是挂起消息、经 onTurnRequest 请应用开一轮;应用开轮时 TurnInput.trigger 带回请求 id,runner 取回消息
// 照 pi 原语义开跑。应用当时忙没开,消息在下一轮并进来(nextTurn)。插件 sendUserMessage 把文本直接交给
// 应用,由应用落成用户消息。
//
// 空闲 IDLE_TIMEOUT_MS 回收;invalidate(会话删除)立即关掉空闲的会话,正在跑的那个在交还时关。
// 关会话 = 插件 session_shutdown + dispose(pi 按会话 id 释放会话级资源)。

import type { AgentSession } from "../../pi/packages/coding-agent/src/core/agent-session.ts";
import type { ModelRuntime } from "../../pi/packages/coding-agent/src/core/model-runtime.ts";
import type { SessionManager } from "../../pi/packages/coding-agent/src/core/session-manager.ts";
import type { Api, Model as PiModel } from "../../pi/packages/ai/src/types.ts";
import type { EngineTurnRequest } from "../engines/contract";
import type { ModelRequestLog } from "../engines/model-outlet";
import type { PiAppToolCaller } from "./app-tools";
import type { PiBuiltinToolApprover } from "./builtin-tools";
import type { SubscriptionCredentialSource } from "./model-bridge";
import { activePiPluginId, type PiPluginToolApprover } from "./plugins/arbiter";
import type { PiPluginSessionBinding } from "./plugins/session-binding";
import type { PiPluginInteraction } from "./plugins/ui-bridge";
import { EMPTY_SYNTHETIC_PLAN, injectSyntheticRows, type PiEntrySync, type PiSyntheticPlan } from "./session-view";

export const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** 一轮的接线。会话里登记的都是委托到这里的版本,轮次之间为空。 */
export interface PiTurnRoutes {
  credentialSource?: SubscriptionCredentialSource;
  requestLog?: ModelRequestLog;
  approveWorkspaceTool?: PiBuiltinToolApprover;
  approvePluginTool?: PiPluginToolApprover;
  callTool?: PiAppToolCaller;
  interaction?: PiPluginInteraction;
}

export function clearTurnRoutes(routes: PiTurnRoutes): void {
  for (const key of Object.keys(routes) as Array<keyof PiTurnRoutes>) delete routes[key];
}

type SendCustomMessage = AgentSession["sendCustomMessage"];

export interface PiPendingTurn {
  message: Parameters<SendCustomMessage>[0];
  options: NonNullable<Parameters<SendCustomMessage>[1]>;
}

export interface PiLiveSession {
  readonly conversationId: string;
  /** 建会话时的配置键;undefined = 一次性会话(不复用)。 */
  readonly configKey: string | undefined;
  readonly session: AgentSession;
  readonly manager: SessionManager;
  readonly runtime: ModelRuntime;
  readonly model: PiModel<Api>;
  /** 带应用标记的工具名(工作区工具 + 应用工具),事件桥据此映射 details。 */
  readonly markedToolNames: ReadonlySet<string>;
  readonly routes: PiTurnRoutes;
  /** 本轮的合成行插入计划(建会话时装的上下文变换每次请求读它)。 */
  synthetic: PiSyntheticPlan;
  /** 上一轮的对账器:它没交出的条目(轮次之间插件追加的)由下一轮交出。 */
  lastSync?: PiEntrySync;
  /** 不经截取的 sendCustomMessage(跑引擎发起的轮次、并进挂起消息用它)。 */
  readonly sendCustomMessage: SendCustomMessage;
  attachPlugins(binding: PiPluginSessionBinding): void;
  close(): Promise<void>;
}

export interface PiLiveSessionParts {
  conversationId: string;
  configKey: string | undefined;
  session: AgentSession;
  manager: SessionManager;
  runtime: ModelRuntime;
  model: PiModel<Api>;
  markedToolNames: ReadonlySet<string>;
  routes: PiTurnRoutes;
}

/** 会话建好、插件绑定之前调用:装合成行注入;有会话宿主时截取轮次之间的引擎发起轮次。 */
export function createPiLiveSession(parts: PiLiveSessionParts, host: PiSessionHost | undefined): PiLiveSession {
  const { session } = parts;
  let pluginBinding: PiPluginSessionBinding | undefined;
  let closed: Promise<void> | undefined;
  const live: PiLiveSession = {
    ...parts,
    synthetic: EMPTY_SYNTHETIC_PLAN,
    sendCustomMessage: session.sendCustomMessage.bind(session),
    attachPlugins(binding) {
      pluginBinding = binding;
    },
    close() {
      closed ??= (async () => {
        await pluginBinding?.shutdown();
        session.dispose();
      })();
      return closed;
    },
  };

  // 合成行逐请求注入,排在 pi 自己的上下文变换(含插件的 context 处理函数)之前:插件看得到,会话条目里没有。
  const previous = session.agent.transformContext;
  session.agent.transformContext = async (messages, signal) => {
    const injected = injectSyntheticRows(messages, live.synthetic);
    return previous ? previous(injected, signal) : injected;
  };

  if (host) {
    const sendUserMessage = session.sendUserMessage.bind(session);
    // pi 把插件的 sendMessage / sendUserMessage 转到会话实例上现查的方法,覆盖实例属性即可截住。没在跑
    // (含一轮的开头与收尾)时一律交给应用:应用忙就不开轮,消息在下一轮并进来。
    session.sendCustomMessage = (async (message, options) => {
      if (session.isIdle && options?.triggerTurn && options.deliverAs !== "nextTurn") {
        host.holdTurn(live, { message, options });
        return;
      }
      return live.sendCustomMessage(message, options);
    }) as SendCustomMessage;
    session.sendUserMessage = (async (content, options) => {
      if (session.isIdle) {
        const text = typeof content === "string" ? content : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
        host.forwardUserTurn(live, text);
        return;
      }
      return sendUserMessage(content, options);
    }) as AgentSession["sendUserMessage"];
  }
  host?.claim(live);
  return live;
}

export interface PiSessionHost {
  /** 取出该会话空闲的活会话(取出即停止回收计时);没有返回 undefined。 */
  checkout(conversationId: string): PiLiveSession | undefined;
  /** 登记为该会话当前的活会话(新建时)。 */
  claim(live: PiLiveSession): void;
  /** 轮末交还:一次性会话、期间被作废、或已被更新的会话顶替时关掉,否则开始回收计时。 */
  checkin(live: PiLiveSession): Promise<void>;
  /** 关掉空闲的活会话并丢掉挂起的引擎轮次;正在跑的那个在交还时关。 */
  invalidate(conversationId: string): Promise<void>;
  /** 取回应用开轮时带回的那条挂起消息。 */
  takePendingTurn(conversationId: string, requestId: string): PiPendingTurn | undefined;
  /** 取走该会话其余挂起的消息(并进本轮)。 */
  drainPendingTurns(conversationId: string): PiPendingTurn[];
  holdTurn(live: PiLiveSession, turn: PiPendingTurn): void;
  forwardUserTurn(live: PiLiveSession, text: string): void;
  dispose(): Promise<void>;
}

export function createPiSessionHost(options: {
  /** 请应用开一轮(生产 = host.turn.request)。 */
  onTurnRequest: (req: Omit<EngineTurnRequest, "engine">) => void;
  idleMs?: number;
}): PiSessionHost {
  const idleMs = options.idleMs ?? IDLE_TIMEOUT_MS;
  const idle = new Map<string, { live: PiLiveSession; timer: ReturnType<typeof setTimeout> }>();
  /** 每会话当前的活会话(在跑或空闲)。旧轮被接管后才收尾时,它已不是当前的那个。 */
  const owners = new Map<string, PiLiveSession>();
  const pending = new Map<string, Map<string, PiPendingTurn>>();

  const take = (conversationId: string) => {
    const slot = idle.get(conversationId);
    if (!slot) return undefined;
    clearTimeout(slot.timer);
    idle.delete(conversationId);
    return slot.live;
  };

  return {
    checkout(conversationId) {
      const live = take(conversationId);
      if (live) owners.set(conversationId, live);
      return live;
    },

    claim(live) {
      owners.set(live.conversationId, live);
    },

    async checkin(live) {
      const { conversationId } = live;
      if (live.configKey === undefined || owners.get(conversationId) !== live) {
        await live.close();
        return;
      }
      const timer = setTimeout(() => {
        if (idle.get(conversationId)?.live !== live) return;
        idle.delete(conversationId);
        owners.delete(conversationId);
        pending.delete(conversationId);
        void live.close();
      }, idleMs);
      // 回收计时不拖住进程退出。
      (timer as { unref?: () => void }).unref?.();
      idle.set(conversationId, { live, timer });
    },

    async invalidate(conversationId) {
      owners.delete(conversationId);
      pending.delete(conversationId);
      await take(conversationId)?.close();
    },

    takePendingTurn(conversationId, requestId) {
      const turns = pending.get(conversationId);
      const turn = turns?.get(requestId);
      turns?.delete(requestId);
      return turn;
    },

    drainPendingTurns(conversationId) {
      const turns = [...(pending.get(conversationId)?.values() ?? [])];
      pending.delete(conversationId);
      return turns;
    },

    holdTurn(live, turn) {
      const requestId = crypto.randomUUID();
      const turns = pending.get(live.conversationId) ?? new Map<string, PiPendingTurn>();
      turns.set(requestId, turn);
      pending.set(live.conversationId, turns);
      options.onTurnRequest({ conversationId: live.conversationId, requestId, source: activePiPluginId() ?? "" });
    },

    forwardUserTurn(live, text) {
      if (!text.trim()) return;
      options.onTurnRequest({ conversationId: live.conversationId, requestId: crypto.randomUUID(), source: activePiPluginId() ?? "", prompt: text });
    },

    async dispose() {
      const slots = [...idle.values()];
      idle.clear();
      owners.clear();
      pending.clear();
      for (const slot of slots) clearTimeout(slot.timer);
      await Promise.all(slots.map((slot) => slot.live.close()));
    },
  };
}
