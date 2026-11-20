// pi-engine/llm-request-log.ts — pi google 轨的请求日志壳(唯一登记在册的全局 fetch 例外,P2.5 收窄)
//
// 工作区的模型请求经模型出口(engines/model-outlet)记日志:pi 驱动把带供应商身份的 fetch 作为流选项
// 注入(model-bridge withModelOutlet)。上游的 google 两条适配器拒收自定义 fetch
// (google-generative-ai.ts / google-vertex.ts:options.fetch !== globalThis.fetch 即抛),这两条轨
// 不注入出口,改由本壳补记:runner 以 AsyncLocalStorage 圈定「本轮 google 请求的目标 origin + 日志
// 回调」,壳内只记打到该 origin 的请求(同一异步树里工具的搜索/抓取/MCP 请求打的是别家主机,各自
// 管线已有日志)。上下文只为 google 轨开(googleRequestLogContextFor),所以与出口不会双记。
// 记录语义与出口同一函数(recordModelResponse)。
//
// 安装顺序:在 installProxyFetchInterceptor 之后安装(包外层),计时覆盖代理。装在 pi 驱动所在的进程:引擎宿主进程
// (pi-engine/host-process),以及 P7.2.6 之前仍在主程序里跑 pi 的 bootstrap。
// **拆除条件**:pi 的 google 适配器接受注入的 fetch 后,google 轨改走模型出口,删除本文件与
// bootstrap 的安装调用(engines/model-outlet.test.ts 的全局壳登记表同步删掉本文件)。

import { AsyncLocalStorage } from "node:async_hooks";
import type { Api } from "../../pi/packages/ai/src/types.ts";
import { recordModelResponse, type ModelOutletIdentity, type ModelRequestLog } from "../engines/model-outlet";
import { piApiRejectsCustomFetch } from "./model-bridge";

export interface GoogleRequestLogContext {
  identity: ModelOutletIdentity;
  /** 模型端点 origin(协议+主机+端口)。用 origin 而非完整 baseUrl 前缀:pi 侧的路径形态可能与
   *  应用配置不同,origin 恒稳。 */
  origin: string;
  log: ModelRequestLog;
}

const als = new AsyncLocalStorage<GoogleRequestLogContext>();

/** runner 侧入口:把一次生成(prompt/compact)包进日志上下文;context 为 null 时直跑。 */
export function runWithGoogleRequestLog<T>(context: GoogleRequestLogContext | null, fn: () => T): T {
  if (!context) return fn();
  return als.run(context, fn);
}

/** 只有拒收自定义 fetch 的轨(google)需要本壳;其余返回 null(由模型出口记)。 */
export function googleRequestLogContextFor(
  api: Api,
  grant: { providerId: string; providerName: string; baseUrl: string },
  log: ModelRequestLog | undefined,
): GoogleRequestLogContext | null {
  if (!log || !piApiRejectsCustomFetch(api)) return null;
  let origin: string;
  try {
    origin = new URL(grant.baseUrl).origin;
  } catch {
    // baseUrl 不合法(本地异常配置):该轮不记日志,请求本身照常失败并由引擎报错。
    return null;
  }
  return { identity: { providerId: grant.providerId, providerName: grant.providerName }, origin, log };
}

let installed = false;

/** 安装 google 轨日志壳(幂等)。必须晚于 installProxyFetchInterceptor。 */
export function installGoogleRequestLogShell(): void {
  if (installed) return;
  installed = true;
  const inner = globalThis.fetch;
  globalThis.fetch = function (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
    const ctx = als.getStore();
    if (!ctx) return inner(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input instanceof Request ? input.url : "";
    if (!url.startsWith(ctx.origin)) return inner(input, init);
    const started = Date.now();
    const promise = inner(input, init);
    recordModelResponse(
      {
        identity: ctx.identity,
        url,
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        requestBody: typeof init?.body === "string" ? init.body : undefined,
        started,
      },
      promise,
      ctx.log,
    );
    return promise;
  } as typeof fetch;
}
