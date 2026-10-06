// inference-engine/llm-transport.ts — LLM 请求通道(T 阶段 §4.1/§4.2,两引擎统一出口)。
//
// 定位:进程内引擎(聊天 / pi / 未来 deepseek-harness 等)的**唯一** LLM 出口。引擎只调
// ctx.llmFetch(url, init),不再各自往 globalThis.fetch 上叠猴补丁;引擎级关注点(请求
// 日志、缓存预热捕获、将来的插件钩子)以**有序中间件**形式挂在通道上,拿到的永远是
// 「规范化后的结构化请求」——不再猜 URL/头/body 形状、不再靠 AsyncLocalStorage 推断
// 「这个请求属于谁」。
//
// 两层分工(架构边界,勿越界):
//   ┌ 引擎层:  ctx.llmFetch(url, init)             ← 显式参数,不是全局
//   ├ 通道层:  createLlmFetch(ctx, middlewares)    ← 本模块;入口规范化一次 → 中间件链
//   └ 基础设施: globalThis.fetch(url字符串, init)  ← foundation/net.ts 唯一一层
//               (代理 / UA / timeout:0 / SSE identity——管**所有**出站请求,不只 LLM,全局是对的位置)
//
// 为什么这么分(替代 C2 的 fetch 猴补丁栈):
//   - **形状猜测**对每个新 SDK 都是一次赌博(Anthropic SDK 传的是 Headers 实例,`{...}` 展开成 {})。
//     入口一次 `new Headers(...)` 规范化,所有中间件天然兼容任意 SDK 的头形状。
//   - **环境 ALS** 隐式传播:任何在上下文里发的请求都会被圈进去,包括服务自己(重放被自己捕获)。
//     调用方身份(引擎/供应商/会话/用途)由组装点**显式**给出,重放走「同 base、空中间件链」
//     → 「重放被自己捕获」在结构上不可能。
//
// 终点必须传**字符串 URL + init**(P8):net.ts 拦截器对 `Request` 对象输入跳过 timeout:0 与
// UA/identity 注入——传 Request 会丢 300s 空闲防线。normalize 把 Request 输入拆成 url+init。
//
// zod/依赖纪律:本模块不 import bun/node 内置、不读文件、不碰全局状态,只做纯转换 + 链执行,
// 故可被 web-ui 经 @server 引用(参见 webui-runtime-import-server-precedent)。

import type { EngineKind } from "../engines";
import type { Provider } from "../foundation/types";

/** 一次 LLM 调用的身份(组装点显式给出,贯穿整条中间件链)。 */
export interface LlmCallContext {
  /** 发起引擎(chat / pi / 未来引擎)。EngineKind 为开放枚举,新引擎自动可用。 */
  engine: EngineKind;
  /** 供应商(中间件据此取策略 / 端点身份 / 记账用 id+name)。 */
  provider: Provider;
  /** 会话身份(可用会话上下文;无归属的辅助调用传 null)。 */
  conversationId: string | null;
  /** 本次调用的用途:generation=主生成、compaction=压缩、warm=预热重放。 */
  purpose: "generation" | "compaction" | "warm";
}

/** 规范化后的 LLM 请求。中间件看到的结构,不再有形状歧义。 */
export interface LlmRequest {
  url: string;
  method: string;
  /** 恒为 Headers 实例(入口已把任意 HeadersInit 规范化;键名小写,HTTP 头大小写无关)。 */
  headers: Headers;
  /** 可解析请求体(text 形态)。非字符串 body(流 / Blob / FormData)时为 undefined——
   *  中间件据此判定「不可解析」:日志记占位、预热不捕获。 */
  body: string | undefined;
  /** 原始请求体(终点照发):字符串时 === body;流 / Blob / FormData 时是原对象。 */
  readonly rawBody: BodyInit | undefined;
  signal: AbortSignal | null | undefined;
}

/** 链路下游:中间件调它把(可修改的)请求交给下一环 / 终点。 */
export type LlmNext = (req: LlmRequest) => Promise<Response>;
/** 中间件:读 / 改写请求或短路返回自造 Response。 */
export type LlmMiddleware = (req: LlmRequest, ctx: LlmCallContext, next: LlmNext) => Promise<Response>;
/** 引擎可见的 fetch 形状(与全局 fetch 同形,pi 的 StreamOptions.fetch 直接可用)。 */
export type LlmFetch = typeof fetch;

/** 把 fetch 的三形态输入(string / URL / Request)+ init 规范化成 LlmRequest。
 *  - 三个字段各取「init 优先,否则来自 Request」:Request 输入常见于 Bun.serve 入站请求被转发;
 *    init 一旦给出 headers/body 即整体覆盖(与 fetch 语义一致)。
 *  - Request 的 body 用 `clone().text()` 读取(仅在有 body 时);随后以「字符串 URL + init」
 *    形态往下走,不把 Request 对象透给终点(P8:否则丢 net.ts 的 timeout:0 / UA 注入)。 */
export async function normalizeLlmRequest(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<LlmRequest> {
  const isRequest = input instanceof Request;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = String(init?.method ?? (isRequest ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers ?? (isRequest ? input.headers : undefined));
  const signal = init?.signal ?? (isRequest ? input.signal : undefined);

  let rawBody: BodyInit | undefined;
  if (init?.body !== undefined && init?.body !== null) {
    rawBody = init.body;
  } else if (isRequest && input.body !== null) {
    rawBody = await input.clone().text();
  }
  const body = typeof rawBody === "string" ? rawBody : undefined;

  return { url, method, headers, body, rawBody, signal };
}

/** 组装一条 LLM 请求通道(编排层在每次生成 / 压缩入口调用一次,见 T4 llmMiddlewaresFor)。
 *
 *  中间件**有序**:数组前项在外层(先见到请求),后项在内层(先见到响应)——与 fetch 拦截器
 *  「后装者在外」相反,这里按人类直觉「数组顺序 = 请求经过顺序」。
 *  终点调 `globalThis.fetch(req.url, ...)`:传字符串 URL(P8),net.ts 基础设施层照常生效。 */
export function createLlmFetch(ctx: LlmCallContext, middlewares: readonly LlmMiddleware[]): LlmFetch {
  return async function llmFetch(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> {
    const req = await normalizeLlmRequest(input, init);
    let next: LlmNext = (r) => terminalFetch(r);
    for (let i = middlewares.length - 1; i >= 0; i -= 1) {
      const mw = middlewares[i]!;
      const downstream = next;
      next = (r) => mw(r, ctx, downstream);
    }
    return next(req);
  } as LlmFetch;
}

/** 链路终点:以字符串 URL + init 调底层 fetch(P8)。body 取规范化后的可解析形态;
 *  不可解析时回落到原始 BodyInit(流 / Blob / FormData 原样透传,中途不被吞)。 */
function terminalFetch(req: LlmRequest): Promise<Response> {
  const init: RequestInit = { method: req.method, headers: req.headers };
  if (req.signal) init.signal = req.signal;
  const body = req.body !== undefined ? req.body : req.rawBody;
  if (body !== undefined) init.body = body;
  return globalThis.fetch(req.url, init);
}
