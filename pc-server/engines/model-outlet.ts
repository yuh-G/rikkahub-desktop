// engines/model-outlet.ts — 引擎的模型出口(方案 §5.8 进程内送达方式,P2.5)
//
// 一个带显式供应商身份的 fetch,交给引擎的模型客户端(pi:流选项 fetch)。它只做两件事:
//   1. 入口规范化:三形态输入(string / URL / Request)拆成「字符串 URL + init」,请求头统一成
//      Headers(各家 SDK 传的头形状不同)。以字符串 URL 交给全局 fetch——foundation/net.ts 的壳对
//      Request 输入跳过 timeout:0 与 UA 注入,传 Request 会丢掉 300s 空闲防线。
//   2. 记请求日志:响应头到手即记(durationMs = 到响应头的时间),经 log 回调交给应用(引擎在
//      子进程里时它是一次单向通知)。流式响应体不读(SSE 由引擎消费,tee 全量会翻倍内存);非 2xx
//      克隆读截断的错误体;网络失败记 status 0。返回给调用方的 Response 与 promise 语义不变。
// purpose 给出口打上请求用途(缓存预热的重发用另一个出口,记录带 purpose,见 pi-engine/model-bridge applyModelOutlet)。
// 代理 / UA / 空闲定时器仍归 foundation/net.ts 的全局壳。本模块不读应用状态、不 import 应用模块,
// 随引擎一起搬进子进程。

import type { ModelRequestRecord } from "./contract";

const RESPONSE_BODY_LIMIT = 2000;

export interface ModelOutletIdentity {
  providerId: string;
  providerName: string;
}

export type ModelRequestLog = (record: ModelRequestRecord) => void;

/** 一条请求的记录骨架(响应前已知的部分)。 */
export interface ModelRequestStart {
  identity: ModelOutletIdentity;
  url: string;
  method: string;
  requestBody: string | undefined;
  started: number;
  purpose?: ModelRequestRecord["purpose"];
}

/** 记录一条请求的结局。模型出口与 google 轨的全局日志壳(pi-engine/llm-request-log)共用,
 *  记录语义只有这一处。 */
export function recordModelResponse(start: ModelRequestStart, promise: Promise<Response>, log: ModelRequestLog): void {
  const base = {
    providerId: start.identity.providerId,
    providerName: start.identity.providerName,
    url: start.url,
    method: start.method,
    ...(start.requestBody !== undefined ? { requestBody: start.requestBody } : {}),
    ...(start.purpose ? { purpose: start.purpose } : {}),
  };
  void promise.then(
    async (response) => {
      const durationMs = Date.now() - start.started;
      let errorBody: string | undefined;
      if (!response.ok) {
        try {
          errorBody = (await response.clone().text()).slice(0, RESPONSE_BODY_LIMIT);
        } catch {
          // 错误体读失败不影响日志主体。
        }
      }
      log({
        ...base,
        ok: response.ok,
        status: response.status,
        durationMs,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        ...(errorBody !== undefined ? { responseBody: errorBody, error: errorBody } : {}),
      });
    },
    (err: unknown) => {
      log({
        ...base,
        ok: false,
        status: 0,
        durationMs: Date.now() - start.started,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    },
  );
}

/** init 的字段优先,缺省取自 Request(与 fetch 的覆盖语义一致)。 */
async function normalizeRequest(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
): Promise<{ url: string; init: RequestInit }> {
  if (!(input instanceof Request)) {
    const url = typeof input === "string" ? input : input.href;
    return { url, init: { ...init, headers: new Headers(init?.headers) } };
  }
  const body = init?.body ?? (input.body !== null ? await input.clone().text() : undefined);
  return {
    url: input.url,
    init: {
      method: input.method,
      signal: input.signal,
      ...init,
      headers: new Headers(init?.headers ?? input.headers),
      ...(body !== undefined ? { body } : {}),
    },
  };
}

export function createModelOutlet(identity: ModelOutletIdentity, log: ModelRequestLog, purpose?: ModelRequestRecord["purpose"]): typeof fetch {
  return async function modelOutlet(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    const started = Date.now();
    const request = await normalizeRequest(input, init);
    const promise = globalThis.fetch(request.url, request.init);
    recordModelResponse(
      {
        identity,
        url: request.url,
        method: request.init.method ?? "GET",
        requestBody: typeof request.init.body === "string" ? request.init.body : undefined,
        started,
        purpose,
      },
      promise,
      log,
    );
    return promise;
  } as typeof fetch;
}
