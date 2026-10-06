// engines/llm-middlewares.ts — LLM 请求通道的**唯一组装点**(T4 §4.3)。
//
// 回答一个问题:某个引擎 + 某个供应商的一次调用,通道上该挂哪些中间件?此前这段
// 决策散在编排器的 pi 专属函数(piSessionLlmFetch)里,是「靠人记得去加一行」的约定;
// 本模块把它提升为**按 adapter 声明推导**的契约——新引擎接入只需声明 transport,不需要
// 有人记得改组装点(§9:新增引擎声明 transport 即自动获得日志/预热的正确分派)。
//
// 为什么导出的是「工厂」而非「单条通道」:一条通道的身份 =(引擎, 供应商, 会话, 用途),
// 供应商在压缩路径常与会话不同(摘要模型),且引擎可能自行回退供应商——把供应商延迟到
// 引擎实际发起调用的那一刻,日志/预热门控的归属恒与真实请求一致。引擎侧只看到
// `ctx.llmFetchFor(provider)` 一个概念。

import { cacheWarmCaptureMiddleware, isProviderWarmable } from "../inference-engine/cache-warming";
import { createLlmFetch, type LlmCallContext, type LlmFetch, type LlmMiddleware } from "../inference-engine/llm-transport";
import { requestLogMiddleware } from "../inference-engine/request-log";
import type { Provider } from "../foundation/types";
import type { EngineAdapter } from "./index";

/** 宿主预热的**推导**谓词(§4.3:预热不声明,而是从事实推出)。
 *  `宿主预热 ⇔ transport 走宿主通道 && resumeSemantics==="run-and-suspend" && 供应商可预热`。
 *  - 引擎侧两格在此判定;供应商侧(策略开 + 官方端点)复用 cache-warming 的唯一定义
 *    isProviderWarmable,规则不复写。
 *  - run-and-suspend 是关键:预热的价值场景是「生成在等待(审批/长工具)中仍然活着」,
 *    这正是 run-and-suspend 的定义;pause-resume(聊天)遇审批即结束本轮、无等待期可保温,
 *    D-T2「聊天引擎不预热」由此**自动成立**,不再靠 adapter 上的特例声明。 */
export function warmingEligible(adapter: EngineAdapter, provider: Provider): boolean {
  if (adapter.transport.mode !== "host") return false;
  if (adapter.resumeSemantics !== "run-and-suspend") return false;
  return isProviderWarmable(provider);
}

/** 单次调用的中间件选择(有序:数组顺序 = 请求经过顺序,前项在外层先见请求)。
 *  - **请求日志**:仅 `transport.requestLog==="transport"`(引擎在 SDK 内部发请求,只能在
 *    通道记);`"call-site"`(聊天)在调用点自记,不挂。
 *  - **缓存预热捕获**:仅 generation 用途且 warmingEligible——compaction 不挂(压缩请求自带
 *    cacheRetention:"none",重放无意义);warm 用途走空链(重放不挂任何中间件,「重放被自己
 *    捕获」结构上不可能)。端点/策略门控同在这一处判定,中间件内不再重复自检。 */
function middlewaresFor(adapter: EngineAdapter, provider: Provider, purpose: LlmCallContext["purpose"]): LlmMiddleware[] {
  const middlewares: LlmMiddleware[] = [];
  if (adapter.transport.mode === "host" && adapter.transport.requestLog === "transport") {
    middlewares.push(requestLogMiddleware);
  }
  if (purpose === "generation" && warmingEligible(adapter, provider)) {
    middlewares.push(cacheWarmCaptureMiddleware);
  }
  return middlewares;
}

/** 装配「以 provider 为身份」的通道工厂(编排层每轮生成/压缩入口调用一次,结果放进
 *  EngineRunContext / EngineCompactContext.llmFetchFor)。这是 LLM 请求通道的**唯一组装点**;
 *  将来插件钩子(审计/限流/自定义头)在这里按序插入一项即对所有引擎生效。 */
export function engineLlmFetchFor(
  adapter: EngineAdapter,
  conversationId: string,
  purpose: LlmCallContext["purpose"],
): (provider: Provider) => LlmFetch {
  return (provider) =>
    createLlmFetch({ engine: adapter.kind, provider, conversationId, purpose }, middlewaresFor(adapter, provider, purpose));
}
