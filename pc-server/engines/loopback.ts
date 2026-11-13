// engines/loopback.ts — 契约的进程内传输(P2.1)
//
// 生产:connectDriver/connectHost 在 strict=false 时原样返回目标对象,调用就是直调。
// 测试:strict=true 时每个经过契约的载荷(参数、返回值、拒绝原因)都 JSON 往返一次,并先做
// 可序列化检查。函数、类实例、循环引用、非有限数、数组里的 undefined 都会直接抛错,所以
// 「进程内能跑、搬进子进程就坏」的载荷在测试里就会暴露(方案 §5.3 不变式 2)。
// 对象属性值为 undefined 不算错:JSON 丢掉它,接收方看到的是「没有这个键」,与可选字段同义。
//
// 拒绝原因按跨进程的形态归一为 { name, message, code }:AbortError 还原成 DOMException,
// 带 code 的还原成 CodedError(前端按 errorCode 查文案),其余还原成普通 Error。

import { CodedError } from "../foundation/errors";
import type { EngineDriver, EngineHost } from "./contract";

/** 默认档位:bun test 下 NODE_ENV=test,经契约的载荷一律强制往返;生产直调。 */
export const STRICT_CONTRACT_TRANSPORT = process.env.NODE_ENV === "test";

export class ContractPayloadError extends Error {
  constructor(path: string, reason: string) {
    super(`契约载荷不可序列化:${path} ${reason}`);
    this.name = "ContractPayloadError";
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function check(value: unknown, path: string, ancestors: Set<object>, inArray: boolean): void {
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) throw new ContractPayloadError(path, `是非有限数(${value})`);
      return;
    case "undefined":
      if (inArray) throw new ContractPayloadError(path, "是数组里的 undefined(JSON 会变成 null)");
      return;
    case "function":
    case "symbol":
    case "bigint":
      throw new ContractPayloadError(path, `是 ${typeof value}`);
  }
  if (value === null) return;
  const obj = value as object;
  if (ancestors.has(obj)) throw new ContractPayloadError(path, "是循环引用");
  ancestors.add(obj);
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => check(item, `${path}[${index}]`, ancestors, true));
  } else {
    if (!isPlainObject(obj)) {
      throw new ContractPayloadError(path, `是类实例(${obj.constructor?.name ?? "未知类"})`);
    }
    for (const [key, item] of Object.entries(obj)) check(item, `${path}.${key}`, ancestors, false);
  }
  ancestors.delete(obj);
}

/** 可序列化检查(规则见文件头注)。 */
export function assertJsonSafe(value: unknown, label: string): void {
  check(value, label, new Set(), false);
}

/** 检查后 JSON 往返。顶层 undefined(无返回值的调用)原样返回。 */
export function jsonRoundTrip<T>(value: T, label: string): T {
  if (value === undefined) return value;
  assertJsonSafe(value, label);
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 跨进程的拒绝原因形态。 */
export interface EngineErrorPayload {
  name: string;
  message: string;
  code?: string;
}

export function serializeEngineError(err: unknown): EngineErrorPayload {
  if (err instanceof CodedError) return { name: err.name, message: err.message, code: err.errorCode };
  if (err instanceof Error) return { name: err.name, message: err.message };
  // DOMException 在 Bun 里是 Error 子类,走上一支;这里只剩非 Error 的抛出值。
  return { name: "Error", message: String(err) };
}

export function reviveEngineError(payload: EngineErrorPayload): Error {
  if (payload.name === "AbortError") return new DOMException(payload.message, "AbortError");
  if (payload.code) return new CodedError(payload.message, payload.code);
  const error = new Error(payload.message);
  if (payload.name && payload.name !== "Error") error.name = payload.name;
  return error;
}

function strictCall<A extends unknown[], R>(label: string, fn: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => {
    const sent = args.map((arg, index) => jsonRoundTrip(arg, `${label}(参数 ${index})`)) as A;
    const result = fn(...sent);
    if (!(result instanceof Promise)) return jsonRoundTrip(result, `${label}(返回值)`);
    return result.then(
      (value) => jsonRoundTrip(value, `${label}(返回值)`),
      (err: unknown) => {
        throw reviveEngineError(jsonRoundTrip(serializeEngineError(err), `${label}(拒绝原因)`));
      },
    ) as R;
  };
}

/** 应用侧持有的驱动句柄。 */
export function connectDriver(driver: EngineDriver, options: { strict: boolean }): EngineDriver {
  if (!options.strict) return driver;
  const label = (method: string) => `driver(${driver.kind}).${method}`;
  return {
    kind: driver.kind,
    capabilities: jsonRoundTrip(driver.capabilities, label("capabilities")),
    startTurn: strictCall(label("startTurn"), driver.startTurn.bind(driver)),
    abort: strictCall(label("abort"), driver.abort.bind(driver)),
    ...(driver.compact ? { compact: strictCall(label("compact"), driver.compact.bind(driver)) } : {}),
    dispose: strictCall(label("dispose"), driver.dispose.bind(driver)),
  };
}

/** 引擎侧持有的宿主句柄。 */
export function connectHost(host: EngineHost, options: { strict: boolean }): EngineHost {
  if (!options.strict) return host;
  return {
    emit: strictCall("host.emit", host.emit.bind(host)),
    session: {
      load: strictCall("host.session.load", host.session.load.bind(host.session)),
      append: strictCall("host.session.append", host.session.append.bind(host.session)),
    },
    tools: { call: strictCall("host.tools.call", host.tools.call.bind(host.tools)) },
    permission: { check: strictCall("host.permission.check", host.permission.check.bind(host.permission)) },
    steer: { take: strictCall("host.steer.take", host.steer.take.bind(host.steer)) },
    models: {
      credential: strictCall("host.models.credential", host.models.credential.bind(host.models)),
      log: strictCall("host.models.log", host.models.log.bind(host.models)),
    },
    report: strictCall("host.report", host.report.bind(host)),
  };
}
