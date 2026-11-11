// engines/stdio-transport.ts — 契约的跨进程传输(P2.6):JSON-RPC 2.0 over NDJSON
//
// 一条双向行通道,两端各一个 peer:应用侧持驱动代理并服务宿主回调(connectDriverOverStdio),
// 引擎侧持宿主代理并服务驱动调用(serveDriverOverStdio)。帧归类复用 subprocess-engine/protocol 的
// parseJsonRpcLine;字节流切行由调用方接 createLineFramer(本模块只认整行)。
//
// 方法名即契约路径(driver.startTurn、host.tools.call…),参数按位置成数组。返回 void 的单向通知
// (emit / models.log / report)走 notification,其余走 request/response。同一方向的帧按序处理,
// 所以一轮的事件恒先于该轮 startTurn 的结果到达;请求处理函数在收到帧时同步调用,驱动「在
// startTurn 的同步前缀里登记」的约定跨进程照样成立(紧随其后的 abort 不会落空)。
// 引擎侧启动后先发 engine.ready(种类 + 能力声明),应用侧据此造驱动代理。
//
// 载荷纪律与回环传输一致:发出前 assertJsonSafe(函数 / 类实例 / 循环引用即抛,不让 JSON 静默丢字段);
// 拒绝原因按 serializeEngineError 的形态放进 error.data,对端 reviveEngineError 还原(AbortError、
// CodedError 保真)。通道关闭(对端退出)时在途请求一律以错误拒绝。

import { parseJsonRpcLine, type JsonRpcErrorObject } from "../subprocess-engine/protocol";
import type {
  AppToolResult,
  CompactResult,
  EngineCapabilities,
  EngineDriver,
  EngineHost,
  EngineKind,
  SubscriptionCredential,
  TurnResult,
} from "./contract";
import { assertJsonSafe, reviveEngineError, serializeEngineError, type EngineErrorPayload } from "./loopback";

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

function createPeer(write: (line: string) => void, handlers: Record<string, Handler>, onProtocolError: (reason: string) => void): Peer {
  let nextId = 1;
  let closedReason: string | null = null;
  const pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (err: unknown) => void }>();

  const send = (frame: Record<string, unknown>) => {
    if (closedReason === null) write(JSON.stringify({ jsonrpc: "2.0", ...frame }));
  };

  const handlerFor = (method: string) =>
    Object.hasOwn(handlers, method) ? (handlers[method] as (...args: unknown[]) => unknown) : undefined;

  const argsOf = (params: unknown): unknown[] => (Array.isArray(params) ? params : []);

  function respond(id: string | number, method: string, run: () => unknown): void {
    let result: unknown;
    try {
      result = run();
    } catch (err) {
      send({ id, error: errorObject(err) });
      return;
    }
    Promise.resolve(result).then(
      (value) => {
        try {
          assertJsonSafe(value, `${method}(返回值)`);
        } catch (err) {
          send({ id, error: errorObject(err) });
          return;
        }
        send({ id, result: value });
      },
      (err: unknown) => send({ id, error: errorObject(err) }),
    );
  }

  return {
    request(method, args) {
      if (closedReason !== null) return Promise.reject(new Error(`引擎通道已关闭(${closedReason}),无法调用 ${method}`));
      try {
        assertJsonSafe(args, `${method}(参数)`);
      } catch (err) {
        return Promise.reject(err);
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { method, resolve, reject });
        send({ id, method, params: args });
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
      for (const waiter of pending.values()) waiter.reject(new Error(`引擎通道已关闭(${reason}),${waiter.method} 未完成`));
      pending.clear();
    },
  };
}

export interface StdioDriverConnection {
  /** 引擎侧握手(engine.ready)后可用的驱动代理。 */
  ready: Promise<EngineDriver>;
  /** 收到对端的一行。 */
  receive(line: string): void;
  /** 通道断开(子进程退出):在途调用以错误拒绝。 */
  close(reason: string): void;
}

/** 应用侧:经行通道连到另一端的驱动,宿主回调转给 host。 */
export function connectDriverOverStdio(
  write: (line: string) => void,
  host: EngineHost,
  onProtocolError: (reason: string) => void,
): StdioDriverConnection {
  let resolveReady!: (driver: EngineDriver) => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<EngineDriver>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const peer = createPeer(
    write,
    {
      "engine.ready": (kind: EngineKind, capabilities: EngineCapabilities) => resolveReady(driverProxy(kind, capabilities)),
      "host.emit": (...args: Parameters<EngineHost["emit"]>) => host.emit(...args),
      "host.tools.call": (...args: Parameters<EngineHost["tools"]["call"]>) => host.tools.call(...args),
      "host.steer.take": (...args: Parameters<EngineHost["steer"]["take"]>) => host.steer.take(...args),
      "host.models.credential": (...args: Parameters<EngineHost["models"]["credential"]>) => host.models.credential(...args),
      "host.models.log": (...args: Parameters<EngineHost["models"]["log"]>) => host.models.log(...args),
      "host.report": (...args: Parameters<EngineHost["report"]>) => host.report(...args),
    },
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
      dispose: async () => {
        await peer.request("driver.dispose", []);
      },
    } satisfies EngineDriver;
  }

  return {
    ready,
    receive: (line) => peer.receive(line),
    close(reason) {
      peer.close(reason);
      rejectReady(new Error(`引擎进程未完成握手即断开(${reason})`));
    },
  };
}

export interface StdioDriverServer {
  receive(line: string): void;
  close(reason: string): void;
}

/** 引擎侧:造宿主代理交给驱动工厂,服务应用发来的驱动调用;建好即发 engine.ready。 */
export function serveDriverOverStdio(
  write: (line: string) => void,
  createDriver: (host: EngineHost) => EngineDriver,
  onProtocolError: (reason: string) => void,
): StdioDriverServer {
  let driver: EngineDriver | undefined;
  const target = (): EngineDriver => {
    if (!driver) throw new Error("驱动尚未就绪");
    return driver;
  };
  const peer = createPeer(
    write,
    {
      "driver.startTurn": (...args: Parameters<EngineDriver["startTurn"]>) => target().startTurn(...args),
      "driver.abort": (...args: Parameters<EngineDriver["abort"]>) => target().abort(...args),
      "driver.compact": (...args: Parameters<NonNullable<EngineDriver["compact"]>>) => {
        const current = target();
        if (!current.compact) throw new Error(`引擎 ${current.kind} 未实现原生压缩`);
        return current.compact(...args);
      },
      "driver.dispose": () => target().dispose(),
    },
    onProtocolError,
  );
  const host: EngineHost = {
    emit: (turn, event) => peer.notify("host.emit", [turn, event]),
    tools: { call: (call) => peer.request("host.tools.call", [call]) as Promise<AppToolResult> },
    steer: { take: (turn) => peer.request("host.steer.take", [turn]) as Promise<string[]> },
    models: {
      credential: (req) => peer.request("host.models.credential", [req]) as Promise<SubscriptionCredential>,
      log: (turn, record) => peer.notify("host.models.log", [turn, record]),
    },
    report: (report) => peer.notify("host.report", [report]),
  };
  driver = createDriver(host);
  peer.notify("engine.ready", [driver.kind, driver.capabilities]);
  return { receive: (line) => peer.receive(line), close: (reason) => peer.close(reason) };
}
