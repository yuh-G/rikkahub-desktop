// pi-engine/llm-request-log.ts — pi google 轨的 LLM 请求日志**兜底壳**。
//
// 背景:pi 的 google-generative-ai / google-vertex 适配器拒收自定义 fetch(§2.3 P5),
// 其请求不经宿主 LLM 请求通道(inference-engine/llm-transport),故无法用通道中间件记日志。
// 本文件用一层**窄**全局 fetch 壳 + AsyncLocalStorage 圈定「这条请求属于 pi 的哪个 google
// provider」来补记,保住用户的排障面。**只记日志、不预热**——预热对 google 无意义(官方
// Anthropic 端点专属),且本壳的存在只是为了日志不降级。
//
// 拆除条件:pi 上游支持注入 fetch 后,删除本文件 + bootstrap 的安装调用 + runner 的
// runWithProviderLog(CLAUDE.md pi 维护手册「清除冗余」条目已登记)。
//
// 与主路径的关系:非 google 协议的 pi 请求、以及未来所有进程内引擎的请求,都经请求通道
// 的 requestLogMiddleware 记日志(inference-engine/request-log)——那条路无全局壳、无 ALS。
// 本壳与它共用 recordRequest(记录语义单点),故同一份日志口径。
//
// 安装顺序:在 installProxyFetchInterceptor 之后安装(包外层),计时覆盖代理与重试。

import { AsyncLocalStorage } from "node:async_hooks";
import { recordRequest } from "../inference-engine/request-log";

export type LlmLogContext = {
  providerId: string;
  providerName: string;
  /** LLM 端点 origin(协议+主机+端口)。用 origin 而非完整 baseUrl 前缀:claude 场景
   *  pi 侧 base 被剥 /v1(model-bridge piBaseUrlFor),路径形态两引擎不同,origin 恒稳。 */
  origin: string;
};

const als = new AsyncLocalStorage<LlmLogContext>();

/** runner 侧入口:把一次生成(prompt/compact)包进日志上下文(仅 google 轨调用)。 */
export function runWithLlmRequestLog<T>(context: LlmLogContext | null, fn: () => T): T {
  if (!context) return fn();
  return als.run(context, fn);
}

/** 从 provider.baseUrl 提取 origin;不合法(本地异常配置)返回 null=该轮不记日志。 */
export function llmLogContextFor(provider: { id: string; name: string; baseUrl: string }): LlmLogContext | null {
  try {
    return { providerId: provider.id, providerName: provider.name, origin: new URL(provider.baseUrl).origin };
  } catch {
    return null;
  }
}

let installed = false;

/** 安装 pi google 轨的 LLM 日志壳(幂等)。必须晚于 installProxyFetchInterceptor。
 *  仅当请求处于本壳的 ALS 上下文内、且 URL 以该 provider 的 origin 开头时才记
 *  (ALS 圈定「属于 pi google 轨的哪次生成」,origin 圈定「确实打到该端点」)。 */
export function installLlmRequestLogInterceptor(): void {
  if (installed) return;
  installed = true;
  const inner = globalThis.fetch;
  globalThis.fetch = function (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
    const ctx = als.getStore();
    if (!ctx) return inner(input, init);
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input instanceof Request ? input.url : "";
    if (!target.startsWith(ctx.origin)) return inner(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const requestBody = typeof init?.body === "string" ? init.body : undefined;
    const started = Date.now();
    const promise = inner(input, init);
    recordRequest(ctx, target, method, requestBody, started, promise);
    return promise;
  } as typeof fetch;
}
