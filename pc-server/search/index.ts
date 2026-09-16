// search/index.ts — 搜索服务（19 种实现、连接测试、多 key failover、custom_js 脚本执行）
// 纪律：负责 search_web / scrape_web 工具的具体实现与搜索服务测试。
// 不处理路由、不处理 SSE；请求日志暂经 ../server 的 addLog 记录（3.5 拆 api/ 时收敛）。

import type { JsonValue, SearchService } from "../foundation/types";
import { fetchWithTimeout } from "../foundation/net";
import { domainOfUrl, faviconForUrl, isRecord, stripHtml } from "../foundation/utils";
import { state } from "../persistence/json-store";
import { jsonBody, textBody } from "../model-providers";
import { addLog } from "../api/logs";

export function buildSearchContext() {
  if (!state.settings.enableWebSearch) return "";
  const service = state.settings.searchServices[state.settings.searchServiceSelected] as Record<string, JsonValue> | undefined;
  const serviceName = String(service?.name ?? service?.type ?? "Search");
  return `
Available tools: search_web, scrape_web
Use search_web when the user needs current, external, or verifiable information. The selected service is ${serviceName}. The tool returns source ids as plain numbers. After using search information, cite sources in the format [citation,domain](1), [citation,domain](2). If snippets are not enough, call scrape_web for a specific result URL.
`.trim();
}

function selectedSearchService() {
  return (state.settings.searchServices[state.settings.searchServiceSelected] ??
    state.settings.searchServices[0] ??
    { type: "bing_local", name: "Bing" }) as Record<string, JsonValue>;
}

function nameOfSearchService(service: Record<string, JsonValue>) {
  return String(service.name ?? service.type ?? "Search");
}

function searchResultSize(service: Record<string, JsonValue>) {
  // Mirror Android: each *.SearchService.kt directly uses `commonOptions.resultSize` (default 10
  // in SearchService.kt:94) with no upper clamp — Tavily/Perplexity/Brave/Exa/etc. all forward
  // the raw value to the upstream API. The earlier PC code had a hard-coded `Math.min(10, …)`
  // that silently capped requests at 10 even when the user had configured 15+ in settings;
  // that cap was invented, not ported, and contradicted the user-visible "结果数量" input which
  // has no max attribute. PC keeps the per-service `service.resultSize` field for backward
  // compat with the UI, falling back to the Android-equivalent global `searchCommonOptions.resultSize`.
  const serviceSize = Number(service.resultSize ?? 0);
  const commonSize = Number(state.settings.searchCommonOptions?.resultSize ?? 10);
  // Lower bound 1 prevents nonsensical zero/negative requests. No upper bound — match Android.
  return Math.max(1, serviceSize || commonSize || 10);
}

function searchResult(index: number, item: { title?: unknown; url?: unknown; text?: unknown }) {
  const url = String(item.url ?? "");
  return {
    id: `${index + 1}`,
    title: String(item.title ?? url),
    url,
    domain: domainOfUrl(url),
    icon: faviconForUrl(url),
    text: String(item.text ?? ""),
  };
}

async function parseJsonResponse(response: Response) {
  const text = await response.text();
  try {
    return { text, raw: text ? JSON.parse(text) : {} };
  } catch {
    return { text, raw: { text } };
  }
}

async function customJsHttpRequest(
  url: string,
  method = "GET",
  headersValue: unknown = {},
  bodyValue: unknown = null,
) {
  const headers = isRecord(headersValue) ? Object.fromEntries(Object.entries(headersValue).map(([key, value]) => [key, String(value)])) : {};
  const body = bodyValue == null || String(method).toUpperCase() === "GET" || String(method).toUpperCase() === "HEAD"
    ? undefined
    : (typeof bodyValue === "string" ? bodyValue : JSON.stringify(bodyValue));
  const response = await fetchWithTimeout(url, {
    method: String(method || "GET").toUpperCase(),
    headers,
    body,
  });
  const text = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    statusText: response.statusText,
    url: response.url,
    body: text,
  };
}

async function runCustomJsFunction(script: string, invocation: string, args: JsonValue[]) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const userFetch = async (targetUrl: string, options: Record<string, JsonValue> = {}) => {
    const response = await customJsHttpRequest(
      targetUrl,
      String(options.method ?? "GET"),
      options.headers,
      options.body,
    );
    return {
      status: response.status,
      ok: response.ok,
      statusText: response.statusText,
      url: response.url,
      text: async () => response.body,
      json: async () => JSON.parse(response.body),
    };
  };
  const fn = new AsyncFunction("fetch", "args", `"use strict";\n${script}\nconst result = ${invocation}.apply(null, args);\nreturn await result;`);
  return await fn(userFetch, args);
}

// === 搜索服务多 key 故障转移(PC 独占)===
// apiKey 字段可填多个 key(空白/逗号分隔),请求遇 401/403/429 自动换下一个 key 重试。
// 分隔符 /[\s,]+/ 必须与 APP 端 KeyRoulette.splitKey 的 [\\s,]+ 一字一致——否则 PC 写入的多 key
// 配置导出到 APP 后无法被拆分。字段结构不变,备份完全兼容 APP。

/** 拆分多 key:空白/逗号分隔,去重保序。与 APP KeyRoulette 一致,切勿改分隔符。 */
function splitSearchApiKeys(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const key = part.trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(key);
    }
  }
  return result;
}

/** 状态码是否属于"换 key 可能解决"的故障:鉴权失败(401/403)或限流/额度耗尽(429)。 */
function isSearchKeyError(status: number): boolean {
  return status === 401 || status === 403 || status === 429;
}

/** 可重试的 key 类错误。withSearchKeyFailover 只对它换 key,其它错误透传不重试。 */
class SearchKeyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SearchKeyError";
    this.status = status;
  }
}

/** 响应失败时按状态码抛 SearchKeyError(可换 key)或普通 Error(直接放弃)。 */
function throwSearchStatus(status: number, detail: string): never {
  if (isSearchKeyError(status)) throw new SearchKeyError(status, detail);
  throw new Error(detail);
}

/**
 * 多 key 故障转移:逐个 key 执行 fn;fn 抛 SearchKeyError 且后面还有 key 则换下一个重试;
 * 其它错误(网络/解析/5xx)或最后一个 key 仍失败则直接抛。单 key 时等价于直接执行 fn。
 */
async function withSearchKeyFailover<T>(
  rawKey: string,
  fn: (apiKey: string) => Promise<T>,
): Promise<T> {
  const keys = splitSearchApiKeys(rawKey);
  if (keys.length === 0) throw new SearchKeyError(0, "API Key is empty");
  for (let i = 0; i < keys.length; i++) {
    try {
      return await fn(keys[i]);
    } catch (e) {
      if (i === keys.length - 1 || !(e instanceof SearchKeyError)) throw e;
    }
  }
  throw new Error("withSearchKeyFailover: unreachable");
}

/** 脱敏 API Key 用于测试结果展示:保留首尾少量字符,中间以 *** 替代。短 key 仅留首位便于区分。 */
function maskSearchKey(key: string): string {
  const k = key.trim();
  if (k.length === 0) return "";
  if (k.length <= 4) return `${k[0]}***`;
  if (k.length <= 8) return `${k.slice(0, 2)}***${k.slice(-2)}`;
  return `${k.slice(0, 3)}***${k.slice(-3)}`;
}

/** 把测试单个 key 时抛出的错误归一为前端可翻译的失败码(便于 i18n)。 */
function searchKeyFailCode(e: unknown): string {
  if (e instanceof SearchKeyError) {
    if (e.status === 401 || e.status === 403) return "auth_invalid";
    if (e.status === 429) return "quota_exhausted";
    return "key_error";
  }
  // 非 SearchKeyError:网络断开 / DNS / 5xx / 响应解析失败等——换 key 解决不了,
  // 但测试模式仍逐 key 记录,让用户看到具体哪个 key 受影响。
  return "network";
}

/** issue11:失败码之外保留底层错误原文(截断),否则超时/证书/DNS 等一律显示
 *  "网络异常或服务暂不可用",用户与支持都无从排查。 */
function searchKeyFailDetail(e: unknown): string {
  const base = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const cause = e instanceof Error && e.cause ? ` (${String((e.cause as Error)?.message ?? e.cause)})` : "";
  return `${base}${cause}`.slice(0, 500);
}

/**
 * 多 key 测试模式:对每个 key 独立执行 exec,收集每个 key 的脱敏标识与成败,不提前退出。
 * 与 withSearchKeyFailover(生产故障转移,成功即返回)的区别——本函数用于测试,目的是让用户
 * 在设置页看到每个 key 的健康度,而非尽早拿到一个可用结果。exec 内部仍用 throwSearchStatus
 * 区分可换 key 错误(401/403/429)与其它错误,前者映射为更具体的失败码。
 */
async function testAllSearchKeys(
  rawKey: string,
  exec: (apiKey: string) => Promise<void>,
): Promise<Array<{ key: string; status: "ok" | "fail"; failCode?: string; detail?: string }>> {
  const keys = splitSearchApiKeys(rawKey);
  if (keys.length === 0) throw new SearchKeyError(0, "API Key is empty");
  const entries: Array<{ key: string; status: "ok" | "fail"; failCode?: string; detail?: string }> = [];
  for (const key of keys) {
    try {
      await exec(key);
      entries.push({ key: maskSearchKey(key), status: "ok" });
    } catch (e) {
      entries.push({ key: maskSearchKey(key), status: "fail", failCode: searchKeyFailCode(e), detail: searchKeyFailDetail(e) });
    }
  }
  return entries;
}

/**
 * 包装单个搜索服务的多 key 测试:逐 key 跑 exec(返回成功响应文本,用于 preview),收集状态,
 * 组装前端测试结果对象。任一 key 成功即整体 status=ok(搜索服务可用)。exec 抛错由
 * testAllSearchKeys 归类记录,不会中断后续 key 的测试。
 */
async function runSearchKeyTestResult(
  name: string,
  endpoint: string,
  rawKey: string,
  exec: (apiKey: string) => Promise<string>,
): Promise<{
  status: "ok" | "fail";
  name: string;
  endpoint: string;
  preview: string;
  keys: Array<{ key: string; status: "ok" | "fail"; failCode?: string; detail?: string }>;
}> {
  let successPreview = "";
  const keys = await testAllSearchKeys(rawKey, async (k) => {
    const text = await exec(k);
    if (!successPreview) successPreview = text;
  });
  const anyOk = keys.some((e) => e.status === "ok");
  return {
    status: anyOk ? "ok" : "fail",
    name,
    endpoint,
    preview: successPreview ? textBody(successPreview) : "",
    keys,
  };
}

async function runCustomJsSearch(service: Record<string, JsonValue>, query: string, maxResults: number) {
  const script = String(service.searchScript ?? "").trim();
  if (!script) throw new Error("Custom JS search script is empty");
  const raw = await runCustomJsFunction(script, "search", [query, maxResults]);
  const items = Array.isArray(raw?.items) ? raw.items : [];
  return {
    query,
    service: nameOfSearchService(service),
    answer: raw?.answer,
    items: items.slice(0, maxResults).map((item: any, index: number) =>
      searchResult(index, { title: item.title, url: item.url, text: item.text ?? item.content ?? item.snippet }),
    ),
  };
}

async function runCustomJsScrape(service: Record<string, JsonValue>, target: string) {
  const script = String(service.scrapeScript ?? "").trim();
  if (!script) throw new Error("Custom JS scrape script is empty");
  const raw = await runCustomJsFunction(script, "scrape", [[target]]);
  const item = Array.isArray(raw?.urls) ? raw.urls[0] : raw;
  return {
    url: String(item?.url ?? target),
    title: item?.metadata?.title ?? item?.title,
    description: item?.metadata?.description ?? item?.description,
    language: item?.metadata?.language ?? item?.language,
    text: String(item?.content ?? item?.text ?? "").slice(0, 12000),
  };
}

// === Exa 时效证据 / 请求体构造(对齐 ExaSearchService.kt)===
const EXA_MAX_EVIDENCE_TEXT = 8_000;
const EXA_MAX_EVIDENCE_HIGHLIGHT = 1_200;
const EXA_MAX_AGE_MIN = -1;
const EXA_MAX_AGE_MAX = 720;

/** 读取可选时效参数(startPublishedDate/endPublishedDate/includeDomains/excludeDomains/maxAgeHours),
 *  由模型经 search_web 参数传入;非法/空白一律丢弃,maxAgeHours 钳到 [-1,720]。 */
function buildExaEvidenceParams(params: Record<string, JsonValue>) {
  const str = (key: string) => {
    const value = params[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const strArray = (key: string) => {
    const value = params[key];
    if (!Array.isArray(value)) return undefined;
    const list = value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter((entry) => entry.length > 0);
    return list.length ? list : undefined;
  };
  let maxAgeHours: number | undefined;
  const rawAge = params.maxAgeHours;
  if (typeof rawAge === "number" && Number.isFinite(rawAge)) {
    const clamped = Math.trunc(rawAge);
    if (clamped >= EXA_MAX_AGE_MIN && clamped <= EXA_MAX_AGE_MAX) maxAgeHours = clamped;
  }
  return {
    startPublishedDate: str("startPublishedDate"),
    endPublishedDate: str("endPublishedDate"),
    includeDomains: strArray("includeDomains"),
    excludeDomains: strArray("excludeDomains"),
    maxAgeHours,
  };
}

function buildExaSearchBody(
  params: Record<string, JsonValue>,
  resultSize: number,
  evidence: ReturnType<typeof buildExaEvidenceParams>,
) {
  const query = String(params.query ?? params.q ?? "").trim();
  const searchType = String(params.type ?? "auto").toLowerCase();
  const hasEvidence = Boolean(
    evidence.startPublishedDate || evidence.endPublishedDate || evidence.includeDomains || evidence.excludeDomains || evidence.maxAgeHours != null,
  );
  const contents: Record<string, JsonValue> = hasEvidence
    ? { text: { maxCharacters: EXA_MAX_EVIDENCE_TEXT }, highlights: { maxCharacters: EXA_MAX_EVIDENCE_HIGHLIGHT } }
    : { text: true };
  if (evidence.maxAgeHours != null) contents.maxAgeHours = evidence.maxAgeHours;
  const body: Record<string, JsonValue> = {
    query,
    numResults: resultSize,
    type: ["fast", "auto", "deep"].includes(searchType) ? searchType : "auto",
    contents,
  };
  if (evidence.startPublishedDate) body.startPublishedDate = evidence.startPublishedDate;
  if (evidence.endPublishedDate) body.endPublishedDate = evidence.endPublishedDate;
  if (evidence.includeDomains) body.includeDomains = evidence.includeDomains;
  if (evidence.excludeDomains) body.excludeDomains = evidence.excludeDomains;
  return body;
}

// === 豆包(火山 Search-Infinity)响应解析(DoubaoSearchService.parseResponse)===
// 豆包把鉴权失败装进 HTTP 200 的 ResponseMetadata.Error({"Message":"invalid api key",...})——
// 不归为 401/403 的话,多 key failover 与测试失败码都会误判成"网络/其它",永不换 key。这里把
// 明显的 key 类业务错误识别为 SearchKeyError(403),其余业务错误仍按普通 Error 抛。
function isDoubaoKeyError(message: string): boolean {
  return /invalid\s*api\s*key|invalid\s*token|unauthori[sz]ed|authentication|forbidden/i.test(message);
}
function throwDoubaoApiError(message: string): never {
  if (isDoubaoKeyError(message)) throw new SearchKeyError(403, `Doubao: ${message}`);
  throw new Error(`Doubao: ${message}`);
}
function parseDoubaoSearch(
  mode: "global" | "custom",
  raw: any,
  response: Response,
  text: string,
  maxResults: number,
  query: string,
) {
  if (!response.ok) throwSearchStatus(response.status, `Doubao search failed #${response.status}: ${text.slice(0, 500)}`);
  const metaError = raw?.ResponseMetadata?.Error;
  if (metaError && (metaError.Message || metaError.Code)) {
    throwDoubaoApiError(String(metaError.Message ?? metaError.Code ?? "Doubao API error"));
  }
  const result = raw?.Result;
  if (!result) throw new Error("Doubao response does not contain Result");
  if (mode === "global") {
    if (result.ErrorCode != null && result.ErrorCode !== 0) {
      throwDoubaoApiError(String(result.ErrorMsg ?? `Doubao API error #${result.ErrorCode}`));
    }
    const documents = Array.isArray(result.Documents) ? result.Documents : [];
    const images = documents
      .flatMap((doc: any) => (Array.isArray(doc?.Snippet) ? doc.Snippet : []))
      .map((snippet: any) => String(snippet?.Image?.ImageUrl ?? "").trim())
      .filter((url: string) => url.length > 0);
    return {
      query,
      service: "豆包",
      images: [...new Set(images)],
      items: documents.slice(0, maxResults).map((doc: any, index: number) =>
        searchResult(index, {
          title: doc?.Title,
          url: doc?.Url,
          text: (Array.isArray(doc?.Snippet) ? doc.Snippet : [])
            .map((snippet: any) => String(snippet?.Text ?? "").trim())
            .filter(Boolean)
            .join("\n"),
        }),
      ),
    };
  }
  const webResults = Array.isArray(result.WebResults) ? result.WebResults : [];
  return {
    query,
    service: "豆包",
    items: webResults.slice(0, maxResults).map((item: any, index: number) =>
      searchResult(index, {
        title: item?.Title,
        url: item?.Url,
        text: String(item?.Summary ?? "").trim() || String(item?.Snippet ?? ""),
      }),
    ),
  };
}

export async function runSearchWeb(params: Record<string, JsonValue>) {
  const started = Date.now();
  const service = selectedSearchService();
  const type = String(service.type ?? "bing_local").toLowerCase();
  const query = String(params.query ?? params.q ?? "").trim();
  if (!query) throw new Error("search_web requires query");
  // User's configured `resultSize` takes precedence over whatever the LLM passes — most
  // models default to emitting `max_results: 5` for safety, which silently overrode the
  // user-configured count of 10. Match Android: the per-service setting wins, with no
  // additional upstream-side clamp (Android forwards the value verbatim).
  const maxResults = Math.max(1, Number(searchResultSize(service)));

  if (type === "tavily") {
    return await withSearchKeyFailover(String(service.apiKey ?? ""), async (apiKey) => {
      const requestHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
      const response = await fetchWithTimeout("https://api.tavily.com/search", {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({ query, max_results: maxResults, search_depth: service.depth ?? "basic" }),
      });
      const raw = await response.json();
      addLog({
        providerId: String(service.id ?? "search"),
        providerName: nameOfSearchService(service),
        url: "https://api.tavily.com/search",
        ok: response.ok,
        status: response.status,
        kind: "tool:search_web",
        toolName: "search_web",
        durationMs: Date.now() - started,
        method: "POST",
        requestHeaders,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        requestBody: jsonBody({ query, maxResults }),
        responseBody: jsonBody(raw),
        error: response.ok ? undefined : jsonBody(raw),
      });
      if (!response.ok) throwSearchStatus(response.status, JSON.stringify(raw).slice(0, 500));
      return {
        query,
        service: "Tavily",
        items: (raw.results ?? []).slice(0, maxResults).map((item: any, index: number) =>
          searchResult(index, { title: item.title, url: item.url, text: item.content ?? item.raw_content }),
        ),
      };
    });
  }

  if (type === "rikkahub") {
    const exec = async (apiKey: string) => {
      const endpoint = "https://api.rikka-ai.com/v1/search";
      const requestBody = { q: query, depth: service.depth ?? "standard", outputType: "sourcedAnswer", includeImages: false };
      const requestHeaders = { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
      });
      const { text, raw } = await parseJsonResponse(response);
      addLog({
        providerId: String(service.id ?? "search"),
        providerName: nameOfSearchService(service),
        url: endpoint,
        ok: response.ok,
        status: response.status,
        kind: "tool:search_web",
        toolName: "search_web",
        durationMs: Date.now() - started,
        method: "POST",
        requestHeaders,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        requestBody: jsonBody(requestBody),
        responseBody: textBody(text),
        error: response.ok ? undefined : textBody(text),
      });
      if (!response.ok) throwSearchStatus(response.status, `RikkaHub search failed with code ${response.status}: ${text.slice(0, 500)}`);
      return {
        query,
        service: "RikkaHub",
        answer: raw.answer,
        items: (raw.sources ?? []).slice(0, maxResults).map((item: any, index: number) =>
          searchResult(index, { title: item.name, url: item.url, text: item.snippet }),
        ),
      };
    };
    const rawKey = String(service.apiKey ?? "");
    return rawKey.trim() ? withSearchKeyFailover(rawKey, exec) : exec("");
  }

  // Exa(ExaSearchService.kt):search 带 type(fast/auto/deep)+ contents(text/highlights)+
  // 可选时效/域过滤;Authorization Bearer(非旧 x-api-key)。scrape 走 api.exa.ai/contents。
  if (type === "exa") {
    return await withSearchKeyFailover(String(service.apiKey ?? ""), async (apiKey) => {
      const endpoint = "https://api.exa.ai/search";
      const evidenceParams = buildExaEvidenceParams(params);
      const requestBody = buildExaSearchBody(params, maxResults, evidenceParams);
      const requestHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
      });
      const { text, raw } = await parseJsonResponse(response);
      addLog({
        providerId: String(service.id ?? "search"),
        providerName: nameOfSearchService(service),
        url: endpoint,
        ok: response.ok,
        status: response.status,
        kind: "tool:search_web",
        toolName: "search_web",
        durationMs: Date.now() - started,
        method: "POST",
        requestHeaders,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        requestBody: jsonBody(requestBody),
        responseBody: textBody(text),
        error: response.ok ? undefined : textBody(text),
      });
      if (!response.ok) throwSearchStatus(response.status, `Exa search failed with code ${response.status}: ${text.slice(0, 500)}`);
      const results = Array.isArray(raw.results) ? raw.results : [];
      const images = results
        .map((item: any) => String(item?.image ?? "").trim())
        .filter((url: string) => url.length > 0);
      return {
        query,
        service: "Exa",
        answer: typeof raw.output?.content === "string" ? raw.output.content : undefined,
        images,
        items: results.slice(0, maxResults).map((item: any, index: number) =>
          searchResult(index, {
            title: item.title,
            url: item.url,
            text: item.text ?? item.summary ?? (Array.isArray(item.highlights) ? item.highlights.join("\n") : ""),
          }),
        ),
      };
    });
  }

  // Serper(google.serper.dev):Google 结果 API。answerBox/knowledgeGraph 合成答案,organic 出列表。
  if (type === "serper") {
    return await withSearchKeyFailover(String(service.apiKey ?? ""), async (apiKey) => {
      const endpoint = "https://google.serper.dev/search";
      const requestBody = { q: query, num: maxResults };
      const requestHeaders = { "Content-Type": "application/json", "X-API-KEY": apiKey };
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
      });
      const { text, raw } = await parseJsonResponse(response);
      addLog({
        providerId: String(service.id ?? "search"),
        providerName: nameOfSearchService(service),
        url: endpoint,
        ok: response.ok,
        status: response.status,
        kind: "tool:search_web",
        toolName: "search_web",
        durationMs: Date.now() - started,
        method: "POST",
        requestHeaders,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        requestBody: jsonBody(requestBody),
        responseBody: textBody(text),
        error: response.ok ? undefined : textBody(text),
      });
      if (!response.ok) throwSearchStatus(response.status, `Serper search failed with code ${response.status}: ${text.slice(0, 500)}`);
      const answer =
        (typeof raw.answerBox?.answer === "string" && raw.answerBox.answer) ||
        (typeof raw.answerBox?.snippet === "string" && raw.answerBox.snippet) ||
        (typeof raw.knowledgeGraph?.description === "string" ? raw.knowledgeGraph.description : undefined);
      return {
        query,
        service: "Serper",
        answer,
        items: (raw.organic ?? []).slice(0, maxResults).map((item: any, index: number) =>
          searchResult(index, { title: item.title, url: item.link, text: item.snippet }),
        ),
      };
    });
  }

  // 豆包(火山 Search-Infinity,DoubaoSearchService.kt):GLOBAL/CUSTOM 两模,端点与字段各不同。
  if (type === "doubao") {
    return await withSearchKeyFailover(String(service.apiKey ?? ""), async (apiKey) => {
      const mode = String(service.mode ?? "custom").toLowerCase() === "global" ? "global" : "custom";
      const endpoint = `https://open.feedcoopapi.com/search_api/${mode === "global" ? "global_search" : "web_search"}`;
      const requestBody = mode === "global"
        ? { Query: query, DocCount: Math.min(20, Math.max(1, maxResults)), MaxSnippetLength: 300, MaxImageCountPerDoc: 1 }
        : { Query: query, SearchType: "web", Count: Math.min(50, Math.max(1, maxResults)), QueryControl: { QueryRewrite: false } };
      const requestHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
      });
      const { text, raw } = await parseJsonResponse(response);
      addLog({
        providerId: String(service.id ?? "search"),
        providerName: nameOfSearchService(service),
        url: endpoint,
        ok: response.ok,
        status: response.status,
        kind: "tool:search_web",
        toolName: "search_web",
        durationMs: Date.now() - started,
        method: "POST",
        requestHeaders,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        requestBody: jsonBody(requestBody),
        responseBody: textBody(text),
        error: response.ok ? undefined : textBody(text),
      });
      return parseDoubaoSearch(mode, raw, response, text, maxResults, query);
    });
  }

  if (type === "zhipu") {
    return await withSearchKeyFailover(String(service.apiKey ?? ""), async (apiKey) => {
      const endpoint = "https://open.bigmodel.cn/api/paas/v4/web_search";
      const requestBody = { search_query: query, search_engine: "search_std", count: maxResults };
      const requestHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
      });
      const { text, raw } = await parseJsonResponse(response);
      addLog({
        providerId: String(service.id ?? "search"),
        providerName: nameOfSearchService(service),
        url: endpoint,
        ok: response.ok,
        status: response.status,
        kind: "tool:search_web",
        toolName: "search_web",
        durationMs: Date.now() - started,
        method: "POST",
        requestHeaders,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        requestBody: jsonBody(requestBody),
        responseBody: textBody(text),
        error: response.ok ? undefined : textBody(text),
      });
      if (!response.ok) throwSearchStatus(response.status, `Zhipu search failed with code ${response.status}: ${text.slice(0, 500)}`);
      return {
        query,
        service: "Zhipu",
        items: (raw.search_result ?? raw.searchResult ?? []).slice(0, maxResults).map((item: any, index: number) =>
          searchResult(index, { title: item.title, url: item.link, text: item.content }),
        ),
      };
    });
  }

  if (type === "brave") {
    return await withSearchKeyFailover(String(service.apiKey ?? ""), async (apiKey) => {
      const endpoint = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
      const requestHeaders = { Accept: "application/json", "X-Subscription-Token": apiKey };
      const response = await fetchWithTimeout(endpoint, { headers: requestHeaders });
      const { text, raw } = await parseJsonResponse(response);
      addLog({
        providerId: String(service.id ?? "search"),
        providerName: nameOfSearchService(service),
        url: endpoint,
        ok: response.ok,
        status: response.status,
        kind: "tool:search_web",
        toolName: "search_web",
        durationMs: Date.now() - started,
        method: "GET",
        requestHeaders,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        requestBody: jsonBody({ query, maxResults }),
        responseBody: textBody(text),
        error: response.ok ? undefined : textBody(text),
      });
      if (!response.ok) throwSearchStatus(response.status, `Brave search failed with code ${response.status}: ${text.slice(0, 500)}`);
      return {
        query,
        service: "Brave",
        items: (raw.web?.results ?? []).slice(0, maxResults).map((item: any, index: number) =>
          searchResult(index, { title: item.title, url: item.url, text: item.description }),
        ),
      };
    });
  }

  if (type === "searxng") {
    const baseUrl = String(service.url ?? "").trim().replace(/\/+$/, "");
    if (!baseUrl) throw new Error("SearXNG URL cannot be empty");
    const endpoint = new URL(`${baseUrl}/search`);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("format", "json");
    const engines = String(service.engines ?? "").trim();
    const language = String(service.language ?? "").trim();
    if (engines) endpoint.searchParams.set("engines", engines);
    if (language) endpoint.searchParams.set("language", language);
    const headers: Record<string, string> = {};
    const username = String(service.username ?? "");
    const password = String(service.password ?? "");
    if (username && password) headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    const response = await fetchWithTimeout(endpoint, { headers });
    const { text, raw } = await parseJsonResponse(response);
    addLog({
      providerId: String(service.id ?? "search"),
      providerName: nameOfSearchService(service),
      url: endpoint.toString(),
      ok: response.ok,
      status: response.status,
      kind: "tool:search_web",
      toolName: "search_web",
      durationMs: Date.now() - started,
      method: "GET",
      requestHeaders: headers,
      responseHeaders: Object.fromEntries(response.headers.entries()),
      requestBody: jsonBody({ query, maxResults, engines, language }),
      responseBody: textBody(text),
      error: response.ok ? undefined : textBody(text),
    });
    if (!response.ok) throw new Error(`SearXNG request failed with status ${response.status}: ${text.slice(0, 500)}`);
    return {
      query,
      service: "SearXNG",
      items: (raw.results ?? []).slice(0, maxResults).map((item: any, index: number) =>
        searchResult(index, { title: item.title, url: item.url, text: item.content }),
      ),
    };
  }

  if (type === "tinyfish") {
    return await withSearchKeyFailover(String(service.apiKey ?? ""), async (apiKey) => {
      const endpoint = `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}`;
      const requestHeaders = { "X-API-Key": apiKey };
      const response = await fetchWithTimeout(endpoint, {
        headers: requestHeaders,
      });
      const { text, raw } = await parseJsonResponse(response);
      addLog({
        providerId: String(service.id ?? "search"),
        providerName: nameOfSearchService(service),
        url: endpoint,
        ok: response.ok,
        status: response.status,
        kind: "tool:search_web",
        toolName: "search_web",
        durationMs: Date.now() - started,
        method: "GET",
        requestHeaders,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        requestBody: jsonBody({ query, maxResults }),
        responseBody: textBody(text),
        error: response.ok ? undefined : textBody(text),
      });
      if (!response.ok) throwSearchStatus(response.status, `Tinyfish search failed with code ${response.status}: ${text.slice(0, 500)}`);
      return {
        query,
        service: "Tinyfish",
        items: (raw.results ?? []).slice(0, maxResults).map((item: any, index: number) =>
          searchResult(index, { title: item.title, url: item.url, text: item.snippet }),
        ),
      };
    });
  }

  if (type === "perplexity") {
    return await withSearchKeyFailover(String(service.apiKey ?? ""), async (apiKey) => {
      const endpoint = "https://api.perplexity.ai/search";
      const body: Record<string, JsonValue> = { query, max_results: maxResults };
      const requestHeaders = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
      });
      const { text, raw } = await parseJsonResponse(response);
      addLog({
        providerId: String(service.id ?? "search"), providerName: nameOfSearchService(service),
        url: endpoint, ok: response.ok, status: response.status, kind: "search:perplexity",
        method: "POST",
        requestHeaders,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        durationMs: Date.now() - started, requestBody: jsonBody(body), responseBody: textBody(text),
        toolName: "search_web", error: response.ok ? undefined : textBody(text),
      });
      if (!response.ok) throwSearchStatus(response.status, `Perplexity search failed: ${response.status} ${text.slice(0, 300)}`);
      const results = Array.isArray(raw.results) ? raw.results : [];
      return {
        answer: typeof raw.answer === "string" ? raw.answer : "",
        items: results.filter((r: any) => r?.title && r?.url).slice(0, maxResults).map((r: any, index: number) =>
          searchResult(index, { title: String(r.title ?? ""), url: String(r.url ?? ""), text: String(r.snippet ?? r.text ?? "") }),
        ),
      };
    });
  }

  if (type === "bocha") {
    return await withSearchKeyFailover(String(service.apiKey ?? ""), async (apiKey) => {
      const endpoint = "https://api.bochaai.com/v1/web-search";
      const summary = service.summary !== false;
      const body: Record<string, JsonValue> = { query, summary, count: maxResults };
      const requestHeaders = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
      });
      const { text, raw } = await parseJsonResponse(response);
      addLog({
        providerId: String(service.id ?? "search"), providerName: nameOfSearchService(service),
        url: endpoint, ok: response.ok, status: response.status, kind: "search:bocha",
        method: "POST",
        requestHeaders,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        durationMs: Date.now() - started, requestBody: jsonBody(body), responseBody: textBody(text),
        toolName: "search_web", error: response.ok ? undefined : textBody(text),
      });
      if (!response.ok) throwSearchStatus(response.status, `Bocha search failed: ${response.status} ${text.slice(0, 300)}`);
      const pages = raw?.data?.webPages?.value ?? [];
      return {
        answer: "",
        items: (Array.isArray(pages) ? pages : []).slice(0, maxResults).map((page: any, index: number) =>
          searchResult(index, { title: String(page.name ?? ""), url: String(page.url ?? ""), text: String(page.summary ?? page.snippet ?? "") }),
        ),
      };
    });
  }

  if (type === "linkup") {
    return await withSearchKeyFailover(String(service.apiKey ?? ""), async (apiKey) => {
      const endpoint = "https://api.linkup.so/v1/search";
      const depth = String(service.depth ?? "standard");
      const body: Record<string, JsonValue> = { q: query, depth, outputType: "sourcedAnswer", includeImages: "false" };
      const requestHeaders = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
      });
      const { text, raw } = await parseJsonResponse(response);
      addLog({
        providerId: String(service.id ?? "search"), providerName: nameOfSearchService(service),
        url: endpoint, ok: response.ok, status: response.status, kind: "search:linkup",
        method: "POST",
        requestHeaders,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        durationMs: Date.now() - started, requestBody: jsonBody(body), responseBody: textBody(text),
        toolName: "search_web", error: response.ok ? undefined : textBody(text),
      });
      if (!response.ok) throwSearchStatus(response.status, `LinkUp search failed: ${response.status} ${text.slice(0, 300)}`);
      const sources = Array.isArray(raw.sources) ? raw.sources : [];
      return {
        answer: typeof raw.answer === "string" ? raw.answer : "",
        items: sources.slice(0, maxResults).map((s: any, index: number) =>
          searchResult(index, { title: String(s.name ?? ""), url: String(s.url ?? ""), text: String(s.snippet ?? "") }),
        ),
      };
    });
  }

  if (type === "metaso") {
    return await withSearchKeyFailover(String(service.apiKey ?? ""), async (apiKey) => {
      const endpoint = "https://metaso.cn/api/v1/search";
      const body: Record<string, JsonValue> = { q: query, scope: "webpage", size: maxResults, includeSummary: false };
      const requestHeaders = { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "Content-Type": "application/json" };
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
      });
      const { text, raw } = await parseJsonResponse(response);
      addLog({
        providerId: String(service.id ?? "search"), providerName: nameOfSearchService(service),
        url: endpoint, ok: response.ok, status: response.status, kind: "search:metaso",
        method: "POST",
        requestHeaders,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        durationMs: Date.now() - started, requestBody: jsonBody(body), responseBody: textBody(text),
        toolName: "search_web", error: response.ok ? undefined : textBody(text),
      });
      if (!response.ok) throwSearchStatus(response.status, `Metaso search failed: ${response.status} ${text.slice(0, 300)}`);
      const webpages = Array.isArray(raw.webpages) ? raw.webpages : [];
      return {
        answer: "",
        items: webpages.slice(0, maxResults).map((w: any, index: number) =>
          searchResult(index, { title: String(w.title ?? ""), url: String(w.link ?? ""), text: String(w.snippet ?? "") }),
        ),
      };
    });
  }

  if (type === "ollama") {
    return await withSearchKeyFailover(String(service.apiKey ?? ""), async (apiKey) => {
      const endpoint = "https://ollama.com/api/web_search";
      // OllamaSearchService.kt:max_results 钳到 [5,10](上游接受区间)。
      const clamped = Math.max(5, Math.min(10, maxResults));
      const body: Record<string, JsonValue> = { query, max_results: clamped };
      const requestHeaders = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
      });
      const { text, raw } = await parseJsonResponse(response);
      addLog({
        providerId: String(service.id ?? "search"), providerName: nameOfSearchService(service),
        url: endpoint, ok: response.ok, status: response.status, kind: "search:ollama",
        method: "POST",
        requestHeaders,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        durationMs: Date.now() - started, requestBody: jsonBody(body), responseBody: textBody(text),
        toolName: "search_web", error: response.ok ? undefined : textBody(text),
      });
      if (!response.ok) throwSearchStatus(response.status, `Ollama search failed: ${response.status} ${text.slice(0, 300)}`);
      const results = Array.isArray(raw.results) ? raw.results : [];
      return {
        answer: "",
        items: results.slice(0, maxResults).map((r: any, index: number) =>
          searchResult(index, { title: String(r.title ?? ""), url: String(r.url ?? ""), text: String(r.content ?? "") }),
        ),
      };
    });
  }

  if (type === "jina") {
    return await withSearchKeyFailover(String(service.apiKey ?? ""), async (apiKey) => {
      const searchUrl = String(service.searchUrl ?? "").trim() || "https://s.jina.ai/";
      const body: Record<string, JsonValue> = { q: query };
      const requestHeaders = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" };
      const response = await fetchWithTimeout(searchUrl, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
      });
      const { text, raw } = await parseJsonResponse(response);
      addLog({
        providerId: String(service.id ?? "search"), providerName: nameOfSearchService(service),
        url: searchUrl, ok: response.ok, status: response.status, kind: "search:jina",
        method: "POST",
        requestHeaders,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        durationMs: Date.now() - started, requestBody: jsonBody(body), responseBody: textBody(text),
        toolName: "search_web", error: response.ok ? undefined : textBody(text),
      });
      if (!response.ok) throwSearchStatus(response.status, `Jina search failed: ${response.status} ${text.slice(0, 300)}`);
      const data = Array.isArray(raw.data) ? raw.data : [];
      return {
        answer: "",
        items: data.slice(0, maxResults).map((r: any, index: number) =>
          searchResult(index, { title: String(r.title ?? ""), url: String(r.url ?? ""), text: String(r.description ?? "") }),
        ),
      };
    });
  }

  if (type === "firecrawl") {
    return await withSearchKeyFailover(String(service.apiKey ?? ""), async (apiKey) => {
      const endpoint = "https://api.firecrawl.dev/v2/search";
      const body: Record<string, JsonValue> = { query, limit: maxResults };
      const requestHeaders = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
      });
      const { text, raw } = await parseJsonResponse(response);
      addLog({
        providerId: String(service.id ?? "search"), providerName: nameOfSearchService(service),
        url: endpoint, ok: response.ok, status: response.status, kind: "search:firecrawl",
        method: "POST",
        requestHeaders,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        durationMs: Date.now() - started, requestBody: jsonBody(body), responseBody: textBody(text),
        toolName: "search_web", error: response.ok ? undefined : textBody(text),
      });
      if (!response.ok) throwSearchStatus(response.status, `Firecrawl search failed: ${response.status} ${text.slice(0, 300)}`);
      const data = isRecord(raw.data) ? (raw.data as Record<string, JsonValue>) : {};
      const web = Array.isArray(data.web) ? data.web : [];
      const news = Array.isArray(data.news) ? data.news : [];
      const items: ReturnType<typeof searchResult>[] = [];
      for (const item of web) {
        items.push(searchResult(items.length, {
          title: String((item as Record<string, JsonValue>).title ?? ""),
          url: String((item as Record<string, JsonValue>).url ?? ""),
          text: String((item as Record<string, JsonValue>).description ?? ""),
        }));
      }
      for (const item of news) {
        const record = item as Record<string, JsonValue>;
        items.push(searchResult(items.length, {
          title: String(record.title ?? ""),
          url: String(record.url ?? ""),
          text: `${String(record.snippet ?? "")}\n${String(record.date ?? "")}`.trim(),
        }));
      }
      return { answer: "", items: items.slice(0, maxResults) };
    });
  }

  if (type === "grok") {
    return await withSearchKeyFailover(String(service.apiKey ?? ""), async (apiKey) => {
      const endpoint = String(service.customUrl ?? "").trim() || "https://api.x.ai/v1/responses";
      const model = String(service.model ?? "").trim() || "grok-4-fast";
      const systemPrompt = String(service.systemPrompt ?? "").trim()
        || "You are a helpful assistant that searches the web for the user. Respond with a concise answer and cite sources via web_search/x_search tools.";
      const body: Record<string, JsonValue> = {
        model,
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: query },
        ],
        tools: [{ type: "web_search" }, { type: "x_search" }],
        store: false,
      };
      const requestHeaders = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
      });
      const { text, raw } = await parseJsonResponse(response);
      addLog({
        providerId: String(service.id ?? "search"), providerName: nameOfSearchService(service),
        url: endpoint, ok: response.ok, status: response.status, kind: "search:grok",
        method: "POST",
        requestHeaders,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        durationMs: Date.now() - started, requestBody: jsonBody(body), responseBody: textBody(text),
        toolName: "search_web", error: response.ok ? undefined : textBody(text),
      });
      if (!response.ok) throwSearchStatus(response.status, `Grok search failed: ${response.status} ${text.slice(0, 300)}`);
      const output = Array.isArray(raw.output) ? raw.output : [];
      const messageOutput = output.find((entry: any) => entry?.type === "message" && entry?.role === "assistant");
      const contentArr = Array.isArray(messageOutput?.content) ? messageOutput.content : [];
      const textContent = contentArr.find((entry: any) => entry?.type === "output_text");
      const answer = textContent?.text ? String(textContent.text) : "";
      const annotations = Array.isArray(textContent?.annotations) ? textContent.annotations : [];
      const seen = new Set<string>();
      const items: ReturnType<typeof searchResult>[] = [];
      for (const annotation of annotations) {
        if (!annotation || annotation.type !== "url_citation") continue;
        const url = String(annotation.url ?? "");
        if (!url || seen.has(url)) continue;
        seen.add(url);
        items.push(searchResult(items.length, {
          title: String(annotation.title ?? url),
          url,
          text: "",
        }));
        if (items.length >= maxResults) break;
      }
      return { answer, items };
    });
  }

  if (type === "custom_js") {
    const result = await runCustomJsSearch(service, query, maxResults);
    addLog({
      providerId: String(service.id ?? "search"),
      providerName: nameOfSearchService(service),
      url: "custom_js:search",
      ok: true,
      status: 0,
      kind: "tool:search_web",
      toolName: "search_web",
      durationMs: Date.now() - started,
      requestBody: jsonBody({ query, maxResults }),
      responseBody: jsonBody(result),
    });
    return result;
  }

  if (type === "searxng") {
    const baseUrl = String(service.url ?? "").trim().replace(/\/+$/, "");
    if (!baseUrl) throw new Error("SearXNG URL is empty");
    const searchParams = new URLSearchParams({ q: query, format: "json" });
    const engines = String(service.engines ?? "").trim();
    if (engines) searchParams.set("engines", engines);
    const language = String(service.language ?? "").trim();
    if (language) searchParams.set("language", language);
    const endpoint = `${baseUrl}/search?${searchParams.toString()}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    const username = String(service.username ?? "");
    const password = String(service.password ?? "");
    if (username && password) {
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    }
    const response = await fetchWithTimeout(endpoint, { headers });
    const text = await response.text();
    addLog({
      providerId: String(service.id ?? "search"),
      providerName: nameOfSearchService(service),
      url: endpoint,
      ok: response.ok,
      status: response.status,
      kind: "tool:search_web",
      toolName: "search_web",
      durationMs: Date.now() - started,
      method: "GET",
      requestHeaders: headers,
      responseHeaders: Object.fromEntries(response.headers.entries()),
      requestBody: jsonBody({ query, maxResults }),
      responseBody: textBody(text),
      error: response.ok ? undefined : textBody(text),
    });
    if (!response.ok) throw new Error(`SearXNG ${response.status}: ${text.slice(0, 500)}`);
    let searxngRaw: { results?: any[] };
    try {
      searxngRaw = JSON.parse(text);
    } catch {
      throw new Error("SearXNG returned a non-JSON response — confirm the URL points to a SearXNG instance with format=json support");
    }
    return {
      query,
      service: "SearXNG",
      items: (Array.isArray(searxngRaw.results) ? searxngRaw.results : [])
        .slice(0, maxResults)
        .map((item: any, index: number) =>
          searchResult(index, {
            title: item.title,
            url: item.url,
            text: item.content ?? item.snippet ?? item.description,
          }),
        ),
    };
  }

  const requestHeaders = { "User-Agent": "Mozilla/5.0 RikkaHubPC/1.0" };
  const response = await fetchWithTimeout(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`, {
    headers: requestHeaders,
  });
  const html = await response.text();
  addLog({
    providerId: String(service.id ?? "search"),
    providerName: nameOfSearchService(service),
    url: response.url,
    ok: response.ok,
    status: response.status,
    kind: "tool:search_web",
    toolName: "search_web",
    durationMs: Date.now() - started,
    method: "GET",
    requestHeaders,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    requestBody: jsonBody({ query, maxResults }),
    responseBody: textBody(stripHtml(html)),
    error: response.ok ? undefined : textBody(html),
  });
  if (!response.ok) throw new Error(`Bing ${response.status}: ${html.slice(0, 300)}`);
  const items: Array<{ id: string; title: string; url: string; domain: string; icon: string; text: string }> = [];
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/gi) ?? [];
  for (const block of blocks.slice(0, maxResults)) {
    const link = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (!link) continue;
    items.push(searchResult(items.length, {
      title: stripHtml(link[2]),
      url: link[1].replace(/&amp;/g, "&"),
      text: snippet ? stripHtml(snippet[1]) : "",
    }));
  }
  return { query, service: "Bing", items };
}

export async function runScrapeWeb(params: Record<string, JsonValue>) {
  const started = Date.now();
  const target = String(params.url ?? "").trim();
  if (!target || !/^https?:\/\//i.test(target)) throw new Error("scrape_web requires an http(s) url");
  const service = selectedSearchService();
  const type = String(service.type ?? "bing_local").toLowerCase();
  if (type === "custom_js" && String(service.scrapeScript ?? "").trim()) {
    const result = await runCustomJsScrape(service, target);
    addLog({
      providerId: String(service.id ?? "search"),
      providerName: nameOfSearchService(service),
      url: "custom_js:scrape",
      ok: true,
      status: 0,
      kind: "tool:scrape_web",
      toolName: "scrape_web",
      durationMs: Date.now() - started,
      requestBody: jsonBody({ url: target }),
      responseBody: jsonBody(result),
    });
    return result;
  }
  if (type === "exa") {
    // Exa scrape:api.exa.ai/contents,返回首条 result 的正文 + title(对齐 mapScrapedResult)。
    return await withSearchKeyFailover(String(service.apiKey ?? ""), async (apiKey) => {
      const endpoint = "https://api.exa.ai/contents";
      const evidence = buildExaEvidenceParams(params);
      const requestBody: Record<string, JsonValue> = { urls: [target], text: { maxCharacters: EXA_MAX_EVIDENCE_TEXT } };
      if (evidence.maxAgeHours != null) requestBody.maxAgeHours = evidence.maxAgeHours;
      const requestHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
      });
      const { text, raw } = await parseJsonResponse(response);
      addLog({
        providerId: String(service.id ?? "search"),
        providerName: nameOfSearchService(service),
        url: endpoint,
        ok: response.ok,
        status: response.status,
        kind: "tool:scrape_web",
        toolName: "scrape_web",
        durationMs: Date.now() - started,
        method: "POST",
        requestHeaders,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        requestBody: jsonBody(requestBody),
        responseBody: textBody(text),
        error: response.ok ? undefined : textBody(text),
      });
      if (!response.ok) throwSearchStatus(response.status, `Exa scrape failed with code ${response.status}: ${text.slice(0, 500)}`);
      const item = Array.isArray(raw.results) ? raw.results[0] : null;
      return {
        url: String(item?.url ?? target),
        title: item?.title,
        description: undefined,
        language: undefined,
        text: String(item?.text ?? "").slice(0, 12000),
      };
    });
  }
  if (type === "ollama") {
    // Ollama scrape:ollama.com/api/web_fetch,返回 { title, content }(OllamaSearchService.kt scrape)。
    return await withSearchKeyFailover(String(service.apiKey ?? ""), async (apiKey) => {
      const endpoint = "https://ollama.com/api/web_fetch";
      const requestBody = { url: target };
      const requestHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
      });
      const { text, raw } = await parseJsonResponse(response);
      addLog({
        providerId: String(service.id ?? "search"),
        providerName: nameOfSearchService(service),
        url: endpoint,
        ok: response.ok,
        status: response.status,
        kind: "tool:scrape_web",
        toolName: "scrape_web",
        durationMs: Date.now() - started,
        method: "POST",
        requestHeaders,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        requestBody: jsonBody(requestBody),
        responseBody: textBody(text),
        error: response.ok ? undefined : textBody(text),
      });
      if (!response.ok) throwSearchStatus(response.status, `Ollama fetch failed for ${target} with code ${response.status}: ${text.slice(0, 500)}`);
      return {
        url: target,
        title: raw?.title,
        description: undefined,
        language: undefined,
        text: String(raw?.content ?? "").slice(0, 12000),
      };
    });
  }
  if (type === "tinyfish") {
    return await withSearchKeyFailover(String(service.apiKey ?? ""), async (apiKey) => {
      const endpoint = "https://api.fetch.tinyfish.ai";
      const requestBody = { urls: [target], format: "markdown" };
      const requestHeaders = { "Content-Type": "application/json", "X-API-Key": apiKey };
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
      });
      const { text, raw } = await parseJsonResponse(response);
      addLog({
        providerId: String(service.id ?? "search"),
        providerName: nameOfSearchService(service),
        url: endpoint,
        ok: response.ok,
        status: response.status,
        kind: "tool:scrape_web",
        toolName: "scrape_web",
        durationMs: Date.now() - started,
        method: "POST",
        requestHeaders,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        requestBody: jsonBody(requestBody),
        responseBody: textBody(text),
        error: response.ok ? undefined : textBody(text),
      });
      if (!response.ok) throwSearchStatus(response.status, `Tinyfish fetch failed with code ${response.status}: ${text.slice(0, 500)}`);
      const item = Array.isArray(raw.results) ? raw.results[0] : null;
      const fetchError = Array.isArray(raw.errors) ? raw.errors[0]?.error : "";
      if (!item && fetchError) throw new Error(String(fetchError));
      return {
        url: String(item?.final_url ?? item?.url ?? target),
        title: item?.title,
        description: item?.description,
        language: item?.language,
        text: String(item?.text ?? "").slice(0, 12000),
      };
    });
  }
  const requestHeaders = { "User-Agent": "Mozilla/5.0 RikkaHubPC/1.0" };
  const response = await fetchWithTimeout(target, { headers: requestHeaders });
  const text = await response.text();
  addLog({
    providerId: "scrape_web",
    providerName: "Scrape Web",
    url: target,
    ok: response.ok,
    status: response.status,
    kind: "tool:scrape_web",
    toolName: "scrape_web",
    durationMs: Date.now() - started,
    method: "GET",
    requestHeaders,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    requestBody: jsonBody({ url: target }),
    responseBody: textBody(stripHtml(text)),
    error: response.ok ? undefined : textBody(text),
  });
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 300)}`);
  return {
    url: target,
    text: stripHtml(text).slice(0, 12000),
  };
}

export async function testSearchService(service: SearchService) {
  const type = String(service.type ?? "");
  const name = String(service.name ?? (type || "Search"));
  const apiKey = String(service.apiKey ?? "");
  if (type === "bing_local" || type === "rikkahub") {
    if (type === "bing_local") {
      return { status: "ok", name, endpoint: type, preview: "Built-in Bing local search is available without API key." };
    }
  }
  // custom_js 脚本自带鉴权(通过 fetch + args 执行,不读顶层 apiKey),searxng/rikkahub 同理免 key。
  // 此处必须放行这三类,否则空 key 时抛 "Custom JS API Key is empty" 拦住测试。
  if (type !== "searxng" && type !== "rikkahub" && type !== "custom_js" && splitSearchApiKeys(apiKey).length === 0) {
    throw new Error(`${name} API Key is empty`);
  }
  if (type === "rikkahub") {
    const endpoint = "https://api.rikka-ai.com/v1/search";
    const exec = async (k: string): Promise<string> => {
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(k ? { Authorization: `Bearer ${k}` } : {}) },
        body: JSON.stringify({ q: "RikkaHub", depth: service.depth ?? "standard", outputType: "sourcedAnswer", includeImages: false }),
      });
      const text = await response.text();
      if (!response.ok) throwSearchStatus(response.status, `${response.status}: ${text.slice(0, 500)}`);
      return text;
    };
    if (apiKey.trim()) return runSearchKeyTestResult(name, endpoint, apiKey, exec);
    const text = await exec("");
    return { status: "ok", name, endpoint, preview: textBody(text) };
  }
  if (type === "tavily") {
    const endpoint = "https://api.tavily.com/search";
    return runSearchKeyTestResult(name, endpoint, apiKey, async (k) => {
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` },
        body: JSON.stringify({ query: "RikkaHub", max_results: 1 }),
      });
      const text = await response.text();
      if (!response.ok) throwSearchStatus(response.status, `${response.status}: ${text.slice(0, 500)}`);
      return text;
    });
  }
  if (type === "exa") {
    const endpoint = "https://api.exa.ai/search";
    return runSearchKeyTestResult(name, endpoint, apiKey, async (k) => {
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        // 与 runSearchWeb 对齐:Authorization Bearer(非 x-api-key),numResults 最小化。
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` },
        body: JSON.stringify({ query: "RikkaHub", numResults: 1 }),
      });
      const text = await response.text();
      if (!response.ok) throwSearchStatus(response.status, `${response.status}: ${text.slice(0, 500)}`);
      return text;
    });
  }
  if (type === "serper") {
    const endpoint = "https://google.serper.dev/search";
    return runSearchKeyTestResult(name, endpoint, apiKey, async (k) => {
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": k },
        body: JSON.stringify({ q: "RikkaHub", num: 1 }),
      });
      const text = await response.text();
      if (!response.ok) throwSearchStatus(response.status, `${response.status}: ${text.slice(0, 500)}`);
      return text;
    });
  }
  if (type === "doubao") {
    const mode = String(service.mode ?? "custom").toLowerCase() === "global" ? "global" : "custom";
    const endpoint = `https://open.feedcoopapi.com/search_api/${mode === "global" ? "global_search" : "web_search"}`;
    return runSearchKeyTestResult(name, endpoint, apiKey, async (k) => {
      const body = mode === "global"
        ? { Query: "RikkaHub", DocCount: 1, MaxSnippetLength: 300, MaxImageCountPerDoc: 1 }
        : { Query: "RikkaHub", SearchType: "web", Count: 1, QueryControl: { QueryRewrite: false } };
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      // 豆包把业务错误装进 ResponseMetadata.Error(HTTP 仍 200),测试也要识别;key 类错误
      // 走 throwDoubaoApiError 归一为可换 key(与 runSearchWeb 同语义)。
      if (!response.ok) throwSearchStatus(response.status, `${response.status}: ${text.slice(0, 500)}`);
      let raw: any = null;
      // 解析失败视为非 JSON 响应(同 parseJsonResponse 兜底):raw 留 null,metaError 取不到则不误报业务错误。
      try { raw = text ? JSON.parse(text) : null; } catch { raw = null; }
      const metaError = raw?.ResponseMetadata?.Error;
      if (metaError && (metaError.Message || metaError.Code)) {
        throwDoubaoApiError(String(metaError.Message ?? metaError.Code ?? "Doubao API error"));
      }
      return text;
    });
  }
  if (type === "tinyfish") {
    const endpoint = "https://api.search.tinyfish.ai?query=RikkaHub";
    return runSearchKeyTestResult(name, endpoint, apiKey, async (k) => {
      const response = await fetchWithTimeout(endpoint, {
        headers: { "X-API-Key": k },
      });
      const text = await response.text();
      if (!response.ok) throwSearchStatus(response.status, `Tinyfish search failed with code ${response.status}: ${text.slice(0, 500)}`);
      return text;
    });
  }
  if (type === "zhipu") {
    const endpoint = "https://open.bigmodel.cn/api/paas/v4/web_search";
    return runSearchKeyTestResult(name, endpoint, apiKey, async (k) => {
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` },
        body: JSON.stringify({ search_query: "RikkaHub", search_engine: "search_std", count: 1 }),
      });
      const text = await response.text();
      if (!response.ok) throwSearchStatus(response.status, `${response.status}: ${text.slice(0, 500)}`);
      return text;
    });
  }
  if (type === "brave") {
    const endpoint = "https://api.search.brave.com/res/v1/web/search?q=RikkaHub&count=1";
    return runSearchKeyTestResult(name, endpoint, apiKey, async (k) => {
      const response = await fetchWithTimeout(endpoint, { headers: { Accept: "application/json", "X-Subscription-Token": k } });
      const text = await response.text();
      if (!response.ok) throwSearchStatus(response.status, `${response.status}: ${text.slice(0, 500)}`);
      return text;
    });
  }
  if (type === "searxng") {
    const baseUrl = String(service.url ?? "").trim().replace(/\/+$/, "");
    if (!baseUrl) throw new Error("SearXNG URL is empty");
    // 与 runSearchWeb 的 searxng 分支保持一致:带上 engines/language,让测试贴近真实搜索行为。
    const searchParams = new URLSearchParams({ q: "RikkaHub", format: "json" });
    const engines = String(service.engines ?? "").trim();
    if (engines) searchParams.set("engines", engines);
    const language = String(service.language ?? "").trim();
    if (language) searchParams.set("language", language);
    const endpoint = `${baseUrl}/search?${searchParams.toString()}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    const username = String(service.username ?? "");
    const password = String(service.password ?? "");
    if (username && password) headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    const response = await fetchWithTimeout(endpoint, { headers });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 500)}`);
    return { status: "ok", name, endpoint, preview: textBody(text) };
  }
  if (type === "custom_js") {
    const searchScript = String(service.searchScript ?? "").trim();
    if (!searchScript) throw new Error("Custom JS search script is empty");
    const result = await runCustomJsSearch(service, "RikkaHub", 1);
    return { status: "ok", name, endpoint: "custom_js", preview: jsonBody(result) };
  }
  if (type === "firecrawl") {
    const endpoint = "https://api.firecrawl.dev/v2/search";
    return runSearchKeyTestResult(name, endpoint, apiKey, async (k) => {
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` },
        body: JSON.stringify({ query: "RikkaHub", limit: 1 }),
      });
      const text = await response.text();
      if (!response.ok) throwSearchStatus(response.status, `${response.status}: ${text.slice(0, 500)}`);
      return text;
    });
  }
  if (type === "grok") {
    const endpoint = String(service.customUrl ?? "").trim() || "https://api.x.ai/v1/responses";
    const model = String(service.model ?? "").trim() || "grok-4-fast";
    return runSearchKeyTestResult(name, endpoint, apiKey, async (k) => {
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` },
        body: JSON.stringify({
          model,
          input: [
            { role: "system", content: "You are a helpful search assistant." },
            { role: "user", content: "RikkaHub" },
          ],
          tools: [{ type: "web_search" }, { type: "x_search" }],
          store: false,
        }),
      });
      const text = await response.text();
      if (!response.ok) throwSearchStatus(response.status, `${response.status}: ${text.slice(0, 500)}`);
      return text;
    });
  }
  // perplexity/bocha/linkup/metaso/ollama/jina:最小测试请求(query=RikkaHub、count/size=1)验证 key 可用。
  // 多 key 时 runSearchKeyTestResult 逐 key 测试并汇总状态。
  if (type === "perplexity") {
    const endpoint = "https://api.perplexity.ai/search";
    return runSearchKeyTestResult(name, endpoint, apiKey, async (k) => {
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "RikkaHub", max_results: 1 }),
      });
      const text = await response.text();
      if (!response.ok) throwSearchStatus(response.status, `${response.status}: ${text.slice(0, 500)}`);
      return text;
    });
  }
  if (type === "bocha") {
    const endpoint = "https://api.bochaai.com/v1/web-search";
    return runSearchKeyTestResult(name, endpoint, apiKey, async (k) => {
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "RikkaHub", summary: false, count: 1 }),
      });
      const text = await response.text();
      if (!response.ok) throwSearchStatus(response.status, `${response.status}: ${text.slice(0, 500)}`);
      return text;
    });
  }
  if (type === "linkup") {
    const endpoint = "https://api.linkup.so/v1/search";
    return runSearchKeyTestResult(name, endpoint, apiKey, async (k) => {
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
        body: JSON.stringify({ q: "RikkaHub", depth: "standard", outputType: "sourcedAnswer", includeImages: "false" }),
      });
      const text = await response.text();
      if (!response.ok) throwSearchStatus(response.status, `${response.status}: ${text.slice(0, 500)}`);
      return text;
    });
  }
  if (type === "metaso") {
    const endpoint = "https://metaso.cn/api/v1/search";
    return runSearchKeyTestResult(name, endpoint, apiKey, async (k) => {
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${k}`, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ q: "RikkaHub", scope: "webpage", size: 1, includeSummary: false }),
      });
      const text = await response.text();
      if (!response.ok) throwSearchStatus(response.status, `${response.status}: ${text.slice(0, 500)}`);
      return text;
    });
  }
  if (type === "ollama") {
    const endpoint = "https://ollama.com/api/web_search";
    // runSearchService 把 max_results clamp 到 [5,10],这里取下界 5 避免被上游拒绝。
    return runSearchKeyTestResult(name, endpoint, apiKey, async (k) => {
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "RikkaHub", max_results: 5 }),
      });
      const text = await response.text();
      if (!response.ok) throwSearchStatus(response.status, `${response.status}: ${text.slice(0, 500)}`);
      return text;
    });
  }
  if (type === "jina") {
    const searchUrl = String(service.searchUrl ?? "").trim() || "https://s.jina.ai/";
    return runSearchKeyTestResult(name, searchUrl, apiKey, async (k) => {
      const response = await fetchWithTimeout(searchUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ q: "RikkaHub" }),
      });
      const text = await response.text();
      if (!response.ok) throwSearchStatus(response.status, `${response.status}: ${text.slice(0, 500)}`);
      return text;
    });
  }
  throw new Error(`${name} search type '${type}' is not supported`);
}
