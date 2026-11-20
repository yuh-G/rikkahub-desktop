// engines/rpc-transport.ts — 契约的跨进程传输(P2.6;P7.2.2 起一条消息一帧):JSON-RPC 2.0
//
// 一条双向消息通道,两端各一个 peer:应用侧持驱动代理并服务宿主回调(connectDriverOverRpc),
// 引擎侧持宿主代理并服务驱动调用(serveDriverOverRpc)。本模块只认整条消息的文本;切帧归调用方
// (引擎宿主进程走 subprocess-engine/channel 的长度前缀帧)。消息归类复用 subprocess-engine/protocol 的 parseJsonRpcLine。
//
// 方法名即契约路径(driver.startTurn、host.tools.call…),参数按位置成数组。返回 void 的单向通知
// (emit / models.log / report)走 notification,其余走 request/response。同一方向的消息按序处理,
// 所以一轮的事件恒先于该轮 startTurn 的结果到达;请求处理函数在收到消息时同步调用,驱动「在
// startTurn 的同步前缀里登记」的约定跨进程照样成立(紧随其后的 abort 不会落空)。
// 引擎侧启动后先发 engine.ready(种类 + 能力声明),应用侧据此造驱动代理。
// 契约之外的进程运维消息(推代理配置、转发错误)以 runtime. 开头,由两端各自登记处理函数,经 notify 发出。
// host.emit 不逐条发:宿主侧整形、攒批后以 host.emitBatch 发出,应用侧还原成原事件逐条交给 host.emit(rpc-events);
// 这一端发任何其他消息前先把攒着的事件发完,所以上面「同方向按序」的保证对事件同样成立。
// host.session.load 按指纹对账:宿主侧带上已缓存的条目指纹,应用侧只附宿主侧没有的条目(rpc-session-view)。
// host.models.log 的请求正文只传与同一会话上一次正文不同的部分(rpc-request-log)。
//
// 载荷纪律与回环传输一致:发出前 assertJsonSafe(函数 / 类实例 / 循环引用即抛,不让 JSON 静默丢字段);
// 拒绝原因按 serializeEngineError 的形态放进 error.data,对端 reviveEngineError 还原(AbortError、
// CodedError 保真)。通道关闭(对端退出)时在途请求一律以错误拒绝。

import { parseJsonRpcLine, type JsonRpcErrorObject } from "../subprocess-engine/protocol";
import type {
  AppToolResult,
  CommandRunResult,
  CompactResult,
  EngineCapabilities,
  EngineCommand,
  EngineDialogAnswer,
  EngineDriver,
  EngineHost,
  EngineKind,
  EnginePluginInspectionDto,
  PermissionGrant,
  SubscriptionCredential,
  TurnRef,
  TurnResult,
} from "./contract";
import { assertJsonSafe, reviveEngineError, serializeEngineError, type EngineErrorPayload } from "./loopback";
import { createEmitCoalescer, createEmitDecoder, type WireEmitBatch } from "./rpc-events";
import { createRequestLogDecoder, createRequestLogEncoder, type WireRequestRecord } from "./rpc-request-log";
import { SessionViewCache, shrinkSessionView, type WireSessionView } from "./rpc-session-view";

/** JSON-RPC 的实现自定义错误段;error.data 携带 EngineErrorPayload。 */
const ENGINE_ERROR = -32000;
const METHOD_NOT_FOUND = -32601;

type Handler = (...args: never[]) => unknown;

interface Peer {
  request(method: string, args: unknown[]): Promise<unknown>;
  notify(method: string, args: unknown[]): void;
  receive(line: string): void;
  close(reason: string): void;
}

function errorObject(err: unknown): JsonRpcErrorObject {
  const payload = serializeEngineError(err);
  return { code: ENGINE_ERROR, message: payload.message, data: payload };
}

function isErrorPayload(value: unknown): value is EngineErrorPayload {
  return typeof value === "object" && value !== null
    && typeof (value as EngineErrorPayload).name === "string"
    && typeof (value as EngineErrorPayload).message === "string";
}

function errorFromObject(error: JsonRpcErrorObject, method: string): Error {
  if (isErrorPayload(error.data)) return reviveEngineError(error.data);
  return new Error(error.message ?? `引擎调用 ${method} 失败`);
}

/** 契约之外的进程运维消息的处理函数;名字必须以 runtime. 开头,不能顶替契约方法。 */
export type RuntimeHandlers = Record<string, Handler>;

/** 通道已关闭(对端进程退出或被结束)时,在途与之后的调用以它拒绝;监管器据此去查进程是怎么没的。 */
export class EngineChannelClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineChannelClosedError";
  }
}

function withRuntime(handlers: Record<string, Handler>, runtime: RuntimeHandlers): Record<string, Handler> {
  for (const name of Object.keys(runtime)) {
    if (!name.startsWith("runtime.")) throw new Error(`进程运维消息必须以 runtime. 开头:${name}`);
  }
  return { ...handlers, ...runtime };
}

function createPeer(
  write: (line: string) => void,
  handlers: Record<string, Handler>,
  onProtocolError: (reason: string) => void,
  beforeSend?: () => void,
): Peer {
  let nextId = 1;
  let closedReason: string | null = null;
  const pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (err: unknown) => void }>();

  const send = (frame: Record<string, unknown>) => {
    if (closedReason !== null) return;
    beforeSend?.();
    write(JSON.stringify({ jsonrpc: "2.0", ...frame }));
  };

  const handlerFor = (method: string) =>
    Object.hasOwn(handlers, method) ? (handlers[method] as (...args: unknown[]) => unknown) : undefined;

  const argsOf = (params: unknown): unknown[] => (Array.isArray(params) ? params : []);

  /** 回包发不出去(载荷不可序列化、超过对端的单帧上限):改回一个错误,对端的调用不会挂住。 */
  function reply(id: string | number, method: string, outcome: { result: unknown } | { error: unknown }): void {
    try {
      if ("error" in outcome) send({ id, error: errorObject(outcome.error) });
      else {
        assertJsonSafe(outcome.result, `${method}(返回值)`);
        send({ id, result: outcome.result });
      }
    } catch (err) {
      send({ id, error: errorObject(err) });
    }
  }

  function respond(id: string | number, method: string, run: () => unknown): void {
    let result: unknown;
    try {
      result = run();
    } catch (err) {
      reply(id, method, { error: err });
      return;
    }
    Promise.resolve(result).then(
      (value) => reply(id, method, { result: value }),
      (err: unknown) => reply(id, method, { error: err }),
    );
  }

  return {
    request(method, args) {
      if (closedReason !== null) return Promise.reject(new EngineChannelClosedError(`引擎通道已关闭(${closedReason}),无法调用 ${method}`));
      try {
        assertJsonSafe(args, `${method}(参数)`);
      } catch (err) {
        return Promise.reject(err);
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { method, resolve, reject });
        try {
          send({ id, method, params: args });
        } catch (err) {
          pending.delete(id);
          reject(err);
        }
      });
    },

    notify(method, args) {
      assertJsonSafe(args, `${method}(参数)`);
      send({ method, params: args });
    },

    receive(line) {
      const parsed = parseJsonRpcLine(line);
      if (!parsed.ok) {
        onProtocolError(`${parsed.reason}:${parsed.raw.slice(0, 200)}`);
        return;
      }
      const message = parsed.message;
      if (message.kind === "response") {
        const waiter = typeof message.id === "number" ? pending.get(message.id) : undefined;
        if (!waiter) {
          onProtocolError(`收到无主响应 id=${String(message.id)}`);
          return;
        }
        pending.delete(message.id as number);
        if (message.error) waiter.reject(errorFromObject(message.error, waiter.method));
        else waiter.resolve(message.result);
        return;
      }
      const handler = handlerFor(message.method);
      if (message.kind === "notification") {
        if (!handler) {
          onProtocolError(`未知通知 ${message.method}`);
          return;
        }
        try {
          handler(...argsOf(message.params));
        } catch (err) {
          onProtocolError(`通知 ${message.method} 处理失败:${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      if (!handler) {
        send({ id: message.id, error: { code: METHOD_NOT_FOUND, message: `未知方法 ${message.method}` } });
        return;
      }
      respond(message.id, message.method, () => handler(...argsOf(message.params)));
    },

    close(reason) {
      if (closedReason !== null) return;
      closedReason = reason;
      for (const waiter of pending.values()) waiter.reject(new EngineChannelClosedError(`引擎通道已关闭(${reason}),${waiter.method} 未完成`));
      pending.clear();
    },
  };
}

export interface RpcDriverConnection {
  /** 引擎侧握手(engine.ready)后可用的驱动代理。 */
  ready: Promise<EngineDriver>;
  /** 收到对端的一条消息。 */
  receive(line: string): void;
  /** 发一条进程运维消息(runtime.*)。 */
  notify(method: string, args: unknown[]): void;
  /** 发一条进程运维请求(runtime.*),等对端回包(监管器判活用)。 */
  request(method: string, args: unknown[]): Promise<unknown>;
  /** 通道断开(子进程退出):在途调用以错误拒绝。 */
  close(reason: string): void;
}

/** 应用侧:经消息通道连到另一端的驱动,宿主回调转给 host。 */
export function connectDriverOverRpc(
  write: (line: string) => void,
  host: EngineHost,
  onProtocolError: (reason: string) => void,
  runtime: RuntimeHandlers = {},
): RpcDriverConnection {
  let resolveReady!: (driver: EngineDriver) => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<EngineDriver>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const decode = createEmitDecoder();
  const decodeLog = createRequestLogDecoder();
  const peer = createPeer(
    write,
    withRuntime({
      "engine.ready": (kind: EngineKind, capabilities: EngineCapabilities) => resolveReady(driverProxy(kind, capabilities)),
      "host.emitBatch": (batch: WireEmitBatch) => {
        for (const [turn, wire] of batch) {
          let event;
          try {
            event = decode(turn, wire);
          } catch (err) {
            onProtocolError(`host.emitBatch 还原失败:${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
          host.emit(turn, event);
        }
      },
      "host.session.load": async (turn: TurnRef, have: string[]) => {
        const view = await host.session.load(turn);
        assertJsonSafe(view, "host.session.load(返回值)");
        return shrinkSessionView(view, have);
      },
      "host.session.append": (...args: Parameters<EngineHost["session"]["append"]>) => host.session.append(...args),
      "host.tools.call": (...args: Parameters<EngineHost["tools"]["call"]>) => host.tools.call(...args),
      "host.permission.check": (...args: Parameters<EngineHost["permission"]["check"]>) => host.permission.check(...args),
      "host.interaction.dialog": (...args: Parameters<EngineHost["interaction"]["dialog"]>) => host.interaction.dialog(...args),
      "host.interaction.dismiss": (...args: Parameters<EngineHost["interaction"]["dismiss"]>) => host.interaction.dismiss(...args),
      "host.interaction.show": (...args: Parameters<EngineHost["interaction"]["show"]>) => host.interaction.show(...args),
      "host.steer.take": (...args: Parameters<EngineHost["steer"]["take"]>) => host.steer.take(...args),
      "host.turn.request": (...args: Parameters<EngineHost["turn"]["request"]>) => host.turn.request(...args),
      "host.models.credential": (...args: Parameters<EngineHost["models"]["credential"]>) => host.models.credential(...args),
      "host.models.log": (turn: TurnRef, wire: WireRequestRecord) => {
        try {
          host.models.log(turn, decodeLog(turn, wire));
        } catch (err) {
          onProtocolError(`host.models.log 还原失败:${err instanceof Error ? err.message : String(err)}`);
          const { bodyDiff: _bodyDiff, ...record } = wire;
          host.models.log(turn, record);
        }
      },
      "host.report": (...args: Parameters<EngineHost["report"]>) => host.report(...args),
    }, runtime),
    onProtocolError,
  );

  function driverProxy(kind: EngineKind, capabilities: EngineCapabilities): EngineDriver {
    return {
      kind,
      capabilities,
      startTurn: (req) => peer.request("driver.startTurn", [req]) as Promise<TurnResult>,
      abort: async (conversationId, reason) => {
        await peer.request("driver.abort", [conversationId, reason]);
      },
      ...(capabilities.nativeCompaction
        ? { compact: (req) => peer.request("driver.compact", [req]) as Promise<CompactResult> }
        : {}),
      invalidate: async (conversationId) => {
        await peer.request("driver.invalidate", [conversationId]);
      },
      ...(capabilities.commands
        ? {
            listCommands: (req) => peer.request("driver.listCommands", [req]) as Promise<EngineCommand[]>,
            runCommand: (req) => peer.request("driver.runCommand", [req]) as Promise<CommandRunResult>,
          }
        : {}),
      ...(capabilities.plugins
        ? { inspectPlugin: (req) => peer.request("driver.inspectPlugin", [req]) as Promise<EnginePluginInspectionDto> }
        : {}),
      dispose: async () => {
        await peer.request("driver.dispose", []);
      },
    } satisfies EngineDriver;
  }

  return {
    ready,
    receive: (line) => peer.receive(line),
    notify: (method, args) => peer.notify(method, args),
    request: (method, args) =>
      method.startsWith("runtime.") ? peer.request(method, args) : Promise.reject(new Error(`进程运维请求必须以 runtime. 开头:${method}`)),
    close(reason) {
      peer.close(reason);
      rejectReady(new Error(`引擎进程未完成握手即断开(${reason})`));
    },
  };
}

export interface RpcDriverServer {
  receive(line: string): void;
  notify(method: string, args: unknown[]): void;
  close(reason: string): void;
}

/** 引擎侧:造宿主代理交给驱动工厂,服务应用发来的驱动调用;建好即发 engine.ready。 */
export function serveDriverOverRpc(
  write: (line: string) => void,
  createDriver: (host: EngineHost) => EngineDriver,
  onProtocolError: (reason: string) => void,
  runtime: RuntimeHandlers = {},
): RpcDriverServer {
  let driver: EngineDriver | undefined;
  const target = (): EngineDriver => {
    if (!driver) throw new Error("驱动尚未就绪");
    return driver;
  };
  let coalescer: ReturnType<typeof createEmitCoalescer> | undefined;
  const views = new SessionViewCache();
  const encodeLog = createRequestLogEncoder();
  const peer = createPeer(
    write,
    withRuntime({
      "driver.startTurn": (...args: Parameters<EngineDriver["startTurn"]>) => target().startTurn(...args),
      "driver.abort": (...args: Parameters<EngineDriver["abort"]>) => target().abort(...args),
      "driver.compact": (...args: Parameters<NonNullable<EngineDriver["compact"]>>) => {
        const current = target();
        if (!current.compact) throw new Error(`引擎 ${current.kind} 未实现原生压缩`);
        return current.compact(...args);
      },
      "driver.invalidate": (...args: Parameters<EngineDriver["invalidate"]>) => {
        views.drop(args[0]);
        return target().invalidate(...args);
      },
      "driver.listCommands": (...args: Parameters<NonNullable<EngineDriver["listCommands"]>>) => {
        const current = target();
        if (!current.listCommands) throw new Error(`引擎 ${current.kind} 没有引擎特色指令`);
        return current.listCommands(...args);
      },
      "driver.runCommand": (...args: Parameters<NonNullable<EngineDriver["runCommand"]>>) => {
        const current = target();
        if (!current.runCommand) throw new Error(`引擎 ${current.kind} 没有引擎特色指令`);
        return current.runCommand(...args);
      },
      "driver.inspectPlugin": (...args: Parameters<NonNullable<EngineDriver["inspectPlugin"]>>) => {
        const current = target();
        if (!current.inspectPlugin) throw new Error(`引擎 ${current.kind} 没有插件运行时`);
        return current.inspectPlugin(...args);
      },
      "driver.dispose": () => target().dispose(),
    }, runtime),
    onProtocolError,
    () => coalescer?.flush(),
  );
  coalescer = createEmitCoalescer((batch) => peer.notify("host.emitBatch", [batch]));
  const events = coalescer;
  const host: EngineHost = {
    emit: (turn, event) => {
      assertJsonSafe([turn, event], "host.emit(参数)");
      events.emit(turn, event);
    },
    session: {
      load: async (turn) => {
        const snapshot = views.snapshot(turn.conversationId);
        const have = [...snapshot.keys()];
        const wire = (await peer.request("host.session.load", [turn, have])) as WireSessionView;
        return views.rebuild(turn.conversationId, snapshot, have, wire);
      },
      append: async (turn, entries) => {
        await peer.request("host.session.append", [turn, entries]);
      },
    },
    tools: { call: (call) => peer.request("host.tools.call", [call]) as Promise<AppToolResult> },
    permission: { check: (req) => peer.request("host.permission.check", [req]) as Promise<PermissionGrant> },
    interaction: {
      dialog: (call) => peer.request("host.interaction.dialog", [call]) as Promise<EngineDialogAnswer>,
      dismiss: (call) => peer.notify("host.interaction.dismiss", [call]),
      show: (call) => peer.notify("host.interaction.show", [call]),
    },
    steer: { take: (turn) => peer.request("host.steer.take", [turn]) as Promise<string[]> },
    turn: { request: (req) => peer.notify("host.turn.request", [req]) },
    models: {
      credential: (req) => peer.request("host.models.credential", [req]) as Promise<SubscriptionCredential>,
      log: (turn, record) => {
        assertJsonSafe([turn, record], "host.models.log(参数)");
        peer.notify("host.models.log", [turn, encodeLog(turn, record)]);
      },
    },
    report: (report) => peer.notify("host.report", [report]),
  };
  driver = createDriver(host);
  peer.notify("engine.ready", [driver.kind, driver.capabilities]);
  return {
    receive: (line) => peer.receive(line),
    notify: (method, args) => peer.notify(method, args),
    close(reason) {
      events.close();
      peer.close(reason);
    },
  };
}
