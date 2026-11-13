// engines/host.ts — EngineHost 的应用侧实现(P2.2)
//
// 应用只有一个宿主实例,交给每个驱动。每轮的应用侧上下文(事件下沉、工具调用口、补发排水、
// 本轮授权涉及的供应商快照)按 turnId 绑定:编排器在 startTurn/compact 之前 bindEngineTurn,
// 返回后解绑。解绑后迟到的回调落空:emit 与 session.append 丢弃、tools.call / permission.check 与
// session.load 以错误拒绝、steer.take 返回空、credential 报凭据不可用——会话被接管时,旧轮的回调不会写进新轮。
// 引擎经 host.report 把诊断交给应用的错误中心,不直接 import observability。
//
// 进程内驱动(placement: "in-process-only",即聊天引擎)不收 TurnInput:它的循环直接读写活的
// 会话对象,所以绑定里另带 inProcess 上下文,驱动经 boundTurn 按 turnId 取。portable 驱动
// 永远不读它(读不到——它在另一个进程里也能跑)。

import type { Assistant, Conversation, Model, Provider } from "../foundation/types";
import type { GenerationEventSink, GenerationTarget, ToolExecutor } from "../inference-engine/events";
import { addLog } from "../api/logs";
import { freshSubscriptionCredential } from "../model-providers/auth/resolve";
import { reportError } from "../observability/app-errors";
import type { AppToolCaller, PluginToolPermissionChecker } from "./app-tools";
import type { EngineEntryInput, EngineErrorReport, EngineHost, EngineSessionView, SubscriptionCredential, TurnRef } from "./contract";

/** 进程内驱动一轮的会话上下文(活对象,不经契约)。 */
export interface InProcessTurnContext {
  conversation: Conversation;
  /** 流式落点活视图:每次现读,补发分裂会换绑到新节点。 */
  target: GenerationTarget;
  /** 生成入口解析的配置快照,贯穿本轮(不回读可能已被替换的设置)。 */
  assistant: Assistant;
  provider: Provider;
  model: Model;
  /** 工具执行闭包(已挂生成级 signal 与部分输出回写)。 */
  executeTool: ToolExecutor;
}

/** 一次调用的会话存储口(conversations/engine-session 组装)。 */
export interface EngineSessionBinding {
  view: EngineSessionView;
  /** 追加到当前落点。不传 = 本次调用不接收原生条目(压缩)。 */
  append?: (entries: EngineEntryInput[]) => void;
}

export interface EngineTurnBinding {
  /** 生成事件的应用器(与聊天引擎同一份 sink)。 */
  sink: GenerationEventSink;
  /** 只给 portable 驱动(进程内驱动直接读会话)。 */
  session?: EngineSessionBinding;
  /** 应用工具调用口(审批/执行/实体化在应用侧)。不传 = 本轮没有应用工具。 */
  callTool?: AppToolCaller;
  /** 引擎自己执行的工具(插件工具)的审批口。不传 = 本轮不接受这类工具(审批以错误拒绝)。 */
  checkPermission?: PluginToolPermissionChecker;
  /** 轮边界补发排水(同一调用里完成数据层分裂)。不传 = 本轮不接补发。 */
  steer?: () => string[];
  /** 本轮授权涉及的供应商快照(会话模型 + 摘要模型)。订阅令牌按授权的 providerId 在这里找,
   *  用的是生成入口的配置快照,不回读可能已被替换的设置。 */
  providers: Provider[];
  /** 只给进程内驱动。 */
  inProcess?: InProcessTurnContext;
}

const turns = new Map<string, EngineTurnBinding>();

/** 绑定一轮的应用侧上下文,返回解绑函数(按绑定身份解绑,重复调用无害)。 */
export function bindEngineTurn(turn: TurnRef, binding: EngineTurnBinding): () => void {
  turns.set(turn.turnId, binding);
  return () => {
    if (turns.get(turn.turnId) === binding) turns.delete(turn.turnId);
  };
}

/** 进程内驱动取本轮绑定。portable 驱动不得调用(它只经 EngineHost 拿东西)。 */
export function boundTurn(turnId: string): EngineTurnBinding | undefined {
  return turns.get(turnId);
}

export function reportEngineError(report: EngineErrorReport): void {
  reportError(report.domain, report.severity, report.message, report.detail, report.code, report.params);
}

export const appEngineHost: EngineHost = {
  emit(turn, event) {
    turns.get(turn.turnId)?.sink(event);
  },
  session: {
    async load(turn) {
      const session = turns.get(turn.turnId)?.session;
      if (!session) throw new Error("会话视图通道未接线");
      return session.view;
    },
    async append(turn, entries) {
      const binding = turns.get(turn.turnId);
      // 轮次已结束:迟到的条目不会被封存,丢弃与装载时作废等价。
      if (!binding) return;
      if (!binding.session?.append) throw new Error("本次调用不接收原生条目");
      binding.session.append(entries);
    },
  },
  tools: {
    async call(call) {
      const callTool = turns.get(call.turnId)?.callTool;
      if (!callTool) throw new Error(`应用工具通道未接线,无法执行 ${call.name}`);
      return callTool({ toolCallId: call.toolCallId, name: call.name, args: call.args });
    },
  },
  permission: {
    async check(req) {
      const checkPermission = turns.get(req.turnId)?.checkPermission;
      if (!checkPermission) throw new Error(`审批通道未接线,无法执行 ${req.toolName}`);
      await checkPermission({ toolCallId: req.toolCallId, toolName: req.toolName, pluginId: req.origin.pluginId, args: req.args });
    },
  },
  steer: {
    async take(turn) {
      return turns.get(turn.turnId)?.steer?.() ?? [];
    },
  },
  models: {
    async credential(req) {
      const provider = turns.get(req.turnId)?.providers.find((item) => item.id === req.providerId);
      // 与 freshSubscriptionCredential 自身的失败同一文案,classifyOAuthCredentialError 照常归类。
      if (!provider) throw new Error(`OAuth credential unavailable for ${req.providerId}`);
      const credential = await freshSubscriptionCredential(provider, { minValidityMs: req.minValidityMs });
      return credential as unknown as SubscriptionCredential;
    },
    // 引擎侧模型出口的请求记录。不看轮次绑定:请求已经发生,轮次结束后迟到的记录照样入档。
    log(_turn, record) {
      addLog({ ...record, kind: "provider:agent" });
    },
  },
  report: reportEngineError,
};
