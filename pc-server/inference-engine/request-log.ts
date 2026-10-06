// inference-engine/request-log.ts — LLM 请求记入统一日志管线的**引擎中立**中间件。
//
// 定位:LLM 请求通道(inference-engine/llm-transport)上的一环——把经通道发出的每条
// LLM 请求记入统一日志管线(设置页请求日志 + 统计分类)。与 cache-warming 的捕获中间件
// 同级,都是挂在通道上的引擎级关注点。**不属任何引擎**,故住 inference-engine 而非
// pi-engine(T4 从 pi-engine/llm-request-log 迁出:通用基础设施不该寄存引擎私产目录)。
//
// 与 pi google 轨兜底壳的分工(pi-engine/llm-request-log.ts):pi 的 google 适配器拒收
// 自定义 fetch(§2.3 P5),其请求不经通道,由那层窄 ALS 壳补记——两者共用本文件的
// recordRequest(记录语义单点)。聊天引擎的日志在调用点 addLog(带响应体与轮次 kind,
// 信息更全),不经本中间件。
//
// 记录口径:status/headers 到手即记(流式时长=响应头时间),responseBody 不读(SSE 流由
// 引擎消费,tee 全量翻倍内存);非 2xx 时 clone 读文本(错误响应体小且非流式)。凭据脱敏
// 由 addLog 入口统一负责(6-1:url/headers 打码)。

import { addLog } from "../api/logs";
import type { LlmMiddleware } from "./llm-transport";

const RESPONSE_BODY_LIMIT = 2000;

/** 记录一条 LLM 请求到统一日志管线(pi google 轨的 ALS 兜底壳与通道中间件共用,语义单点)。
 *  status/headers 到手即记(流式时长=响应头时间),非 2xx clone 读错误体(小且非流式),
 *  reject 记 status 0。凭据脱敏由 addLog 入口统一负责(6-1:url/headers 打码)。 */
export function recordRequest(
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

/** 通道中间件(T2 新增,T3 起为 pi 主路径的日志来源):与旧全局壳的两点差异,都是
 *  「收敛」带来的——①**无 origin 过滤**:通道只承载 LLM 请求,工具/搜索/MCP 的 fetch
 *  根本不经通道(原 origin 匹配只是为在全局壳里排除别家主机);②**无 ALS**:身份
 *  (provider)由通道在调用时显式传入的 ctx 给出。kind 恒 provider:agent(warm 用途由
 *  组装点 engines/llm-middlewares 保证不挂本中间件)。 */
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
