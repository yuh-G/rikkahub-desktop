// pi-engine/llm-request-log.ts — 工作区 LLM 请求接入统一日志管线(日志问题 1)。
//
// 聊天引擎的每条 LLM fetch 在调用点 addLog(inference-engine/providers.ts);pi 引擎的
// fetch 发生在 pi SDK 内部(openai-completions/anthropic-messages 等),零补丁原则不改
// pi——在全局 fetch 外再包一层"日志壳":runner 以 AsyncLocalStorage 圈定"本次生成的
// LLM 目标 origin",壳内只记录打到该 origin 的请求。精准性依据:
//   - 工具执行(搜索/抓取/MCP)虽在同一异步树内,但打的是别家主机,且各自管线已有
//     addLog(kind: search:*/mcp:*)——origin 不匹配即透传,零双记。
//   - 聊天引擎的 fetch 不在本 ALS 上下文内,不受影响(它有自己的调用点日志)。
//
// 安装顺序:在 installProxyFetchInterceptor 之后安装(包外层),计时覆盖代理与重试,
// 记录端到端时长。流式响应口径:status/headers 到手即记(时长=响应头时间),
// responseBody 不读(SSE 流由 pi 消费,tee 全量会翻倍内存);非 2xx 时 clone 读文本
// (错误响应体小且非流式)。凭据脱敏由 addLog 入口统一负责(6-1:url/headers 打码)。

import { AsyncLocalStorage } from "node:async_hooks";
import { addLog } from "../api/logs";

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

let installed = false;

/** 安装工作区 LLM 日志壳(幂等)。必须晚于 installProxyFetchInterceptor。 */
export function installLlmRequestLogInterceptor(): void {
  if (installed) return;
  installed = true;
  const inner = globalThis.fetch;
  globalThis.fetch = function (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
    const ctx = als.getStore();
    if (!ctx) return inner(input, init);
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input instanceof Request ? input.url : "";
    if (!target.startsWith(ctx.origin)) return inner(input, init);
    const started = Date.now();
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const requestBody = typeof init?.body === "string" ? init.body : undefined;
    const promise = inner(input, init);
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
          providerId: ctx.providerId,
          providerName: ctx.providerName,
          url: target,
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
          providerId: ctx.providerId,
          providerName: ctx.providerName,
          url: target,
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
    return promise;
  } as typeof fetch;
}
