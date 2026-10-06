// pi-engine/llm-request-log.ts — 工作区 LLM 请求接入统一日志管线(日志问题 1)。
//
// **T3 起主路径是通道中间件**(requestLogMiddleware,见文件尾):pi 的 streamFunction 包装
// 器把 ctx.llmFetch 注入 StreamOptions.fetch,SDK 内部每条请求经请求通道(见
// inference-engine/llm-transport),身份(provider)由通道 ctx 显式给出、零 ALS。
//
// **全局壳(installLlmRequestLogInterceptor)保留为 google 轨兜底**:pi 的
// google-generative-ai / google-vertex 适配器拒收自定义 fetch(§2.3 P5),其请求不经通道,
// 靠本壳(ALS 圈定 origin)补记日志以保住用户排障面;拆除条件见 CLAUDE.md pi 维护手册。
// 聊天引擎的每条 LLM fetch 在调用点 addLog(inference-engine/providers.ts),不经本模块。
//
// 安装顺序:在 installProxyFetchInterceptor 之后安装(包外层),计时覆盖代理与重试,
// 记录端到端时长。流式响应口径:status/headers 到手即记(时长=响应头时间),
// responseBody 不读(SSE 流由 pi 消费,tee 全量会翻倍内存);非 2xx 时 clone 读文本
// (错误响应体小且非流式)。凭据脱敏由 addLog 入口统一负责(6-1:url/headers 打码)。

import { AsyncLocalStorage } from "node:async_hooks";
import { addLog } from "../api/logs";
import type { LlmMiddleware } from "../inference-engine/llm-transport";

export type LlmLogContext = {
  providerId: string;
  providerName: string;
  /** LLM 端点 origin(协议+主机+端口)。用 origin 而非完整 baseUrl 前缀:claude 场景
   *  pi 侧 base 被剥 /v1(model-bridge piBaseUrlFor),路径形态两引擎不同,origin 恒稳。 */
  origin: string;
};

const als = new AsyncLocalStorage<LlmLogContext>();

/** runner 侧入口:把一次生成(prompt/compact)包进日志上下文。 */
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

const RESPONSE_BODY_LIMIT = 2000;

/** 记录一条 LLM 请求到统一日志管线(日志壳与通道中间件共用,语义单点)。
 *  status/headers 到手即记(流式时长=响应头时间),非 2xx clone 读错误体(小且非流式),
 *  reject 记 status 0。凭据脱敏由 addLog 入口统一负责(6-1:url/headers 打码)。 */
function recordRequest(
  identity: { providerId: string; providerName: string },
  url: string,
  method: string,
  requestBody: string | undefined,
  started: number,
  promise: Promise<Response>,
): void {
  void promise.then(
    async (response) => {
      let errorBody: string | undefined;
      if (!response.ok) {
        try {
          errorBody = (await response.clone().text()).slice(0, RESPONSE_BODY_LIMIT);
        } catch {
          // 读失败不影响日志主体。
        }
      }
      addLog({
        providerId: identity.providerId,
        providerName: identity.providerName,
        url,
        ok: response.ok,
        status: response.status,
        kind: "provider:agent",
        durationMs: Date.now() - started,
        method,
        requestBody,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        ...(errorBody !== undefined ? { responseBody: errorBody, error: errorBody } : {}),
      });
    },
    (err: unknown) => {
      addLog({
        providerId: identity.providerId,
        providerName: identity.providerName,
        url,
        ok: false,
        status: 0,
        kind: "provider:agent",
        durationMs: Date.now() - started,
        method,
        requestBody,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    },
  );
}

let installed = false;

/** 安装工作区 LLM 日志壳(幂等)。必须晚于 installProxyFetchInterceptor。
 *  **T3 起仅 pi google 轨使用**(该轨适配器拒收自定义 fetch,请求不经通道);其余协议
 *  经 requestLogMiddleware 记日志。拆除条件:上游支持注入 fetch 后删除(见 CLAUDE.md)。 */
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

/** 通道中间件形态(T2 新增;T3 起为 pi 的实际路径,替代上面的全局壳)。
 *  与壳的两点差异,都是「收敛」带来的:①**无 origin 过滤**——通道只承载 LLM 请求,
 *  工具/搜索/MCP 的 fetch 根本不经通道(原 origin 匹配只是为在全局壳里排除别家主机);
 *  ②**无 ALS**——身份(provider)由通道在调用时显式传入的 ctx 给出。kind 恒 provider:agent
 *  (warm 用途由组装点保证不挂本中间件,见 T4 llmMiddlewaresFor)。 */
export const requestLogMiddleware: LlmMiddleware = async (req, ctx, next) => {
  const started = Date.now();
  const promise = next(req);
  recordRequest(
    { providerId: ctx.provider.id, providerName: ctx.provider.name },
    req.url,
    req.method,
    req.body,
    started,
    promise,
  );
  return promise;
};
