// search/service-endpoints.ts — 搜索服务请求端点注册表(前后端单源)
//
// 「凡固定 HTTP 端点的搜索服务皆可换址」:用户给服务填一个自定义基址(中转站/反向代理),
// 请求发往该基址 + 规范路径;留空 = 官方地址。bing_local(本地 HTML 解析,无服务端点)与
// custom_js(URL 在用户脚本里,再给输入框就是第二事实源)原则性不登记。
//
// 语义是「换根不换路径」(对齐聊天供应商 baseUrl 的心智模型),而非完整端点:Exa 的
// search(/search)与 scrape(/contents)是同一基址的两条路径,一个口子全带走。兼容规则:
// 填入值以该服务任一规范路径结尾时剥掉再拼接——从别处粘贴完整端点
// (https://api.tavily.com/search)与存量完整端点字段值(grok 预置的 customUrl)都幂等还原。
//
// 字段策略:统一用 `url` 字段;三个遗留字段名是安卓契约不动——searxng 本就叫 `url`,
// grok=customUrl、jina=searchUrl 在 `url` 未填时兜底读取(UI 输入框也绑定遗留字段,
// 保证 PC→APP 备份往返后自定义地址仍被安卓认识)。新增 `url` 是字符串字段而非枚举值,
// Android kotlinx(ignoreUnknownKeys)对未知键静默忽略——跨端备份零风险,APP 侧忽略该
// 字段 = 官方地址,语义无损。
//
// 纪律:本模块必须保持零 import、纯数据与纯函数——web-ui 经 `@server` 直接引用它
// (先例:model-name-heuristic / origin-relay),引入任何 node/bun 内置都会让前端打包炸掉。

/** 单个搜索服务的端点拓扑。 */
export interface SearchServiceEndpointSpec {
  /** 官方请求基址(裸根,不含端点路径)。空串 = 无官方地址(自建实例,必填自定义)。 */
  readonly base: string;
  /** search 端点规范路径;空串 = 基址即端点(Jina/Tinyfish 形态)。豆包按 mode 二选一,用 searchMode。 */
  readonly search: string;
  /** scrape(fetch)端点规范路径;仅实现了 scrape 的服务登记(Exa/Ollama/Tinyfish)。 */
  readonly fetch?: string;
  /** fetch 与 search 不同主机时的官方基址(仅 Tinyfish:api.fetch.* vs api.search.*)。 */
  readonly fetchBase?: string;
  /** 豆包两模(GLOBAL/CUSTOM)端点路径随 service.mode 二选一。 */
  readonly searchMode?: { readonly custom: string; readonly global: string };
  /** 遗留自定义端点字段名(安卓契约):grok=customUrl、jina=searchUrl。searxng 的 url 与统一字段同名,无需登记。 */
  readonly legacyFields?: readonly string[];
}

/** 全部可换址服务的端点拓扑。顺序对齐 runSearchWeb 的分支序。 */
export const SEARCH_SERVICE_ENDPOINTS: Readonly<Record<string, SearchServiceEndpointSpec>> = {
  tavily: { base: "https://api.tavily.com", search: "/search" },
  rikkahub: { base: "https://api.rikka-ai.com", search: "/v1/search" },
  exa: { base: "https://api.exa.ai", search: "/search", fetch: "/contents" },
  serper: { base: "https://google.serper.dev", search: "/search" },
  doubao: { base: "https://open.feedcoopapi.com", search: "", searchMode: { custom: "/search_api/web_search", global: "/search_api/global_search" } },
  zhipu: { base: "https://open.bigmodel.cn", search: "/api/paas/v4/web_search" },
  brave: { base: "https://api.search.brave.com", search: "/res/v1/web/search" },
  searxng: { base: "", search: "/search" },
  tinyfish: { base: "https://api.search.tinyfish.ai", search: "", fetch: "", fetchBase: "https://api.fetch.tinyfish.ai" },
  perplexity: { base: "https://api.perplexity.ai", search: "/search" },
  bocha: { base: "https://api.bochaai.com", search: "/v1/web-search" },
  linkup: { base: "https://api.linkup.so", search: "/v1/search" },
  metaso: { base: "https://metaso.cn", search: "/api/v1/search" },
  ollama: { base: "https://ollama.com", search: "/api/web_search", fetch: "/api/web_fetch" },
  jina: { base: "https://s.jina.ai/", search: "", legacyFields: ["searchUrl"] },
  firecrawl: { base: "https://api.firecrawl.dev", search: "/v2/search" },
  grok: { base: "https://api.x.ai/v1", search: "/responses", legacyFields: ["customUrl"] },
};

type ServiceLike = Record<string, unknown>;

function entryOf(type: string | null | undefined): SearchServiceEndpointSpec | undefined {
  return SEARCH_SERVICE_ENDPOINTS[String(type ?? "").trim().toLowerCase()];
}

/** 该类型是否登记了可换址端点(前端用它决定「请求地址」输入框与中转标识的显隐)。 */
export function hasServiceEndpoint(type: string | null | undefined): boolean {
  return entryOf(type) !== undefined;
}

/** 官方基址(前端输入框 placeholder 用)。自建服务(searxng)无官方地址,返回空串。 */
export function serviceEndpointBase(type: string | null | undefined): string {
  return entryOf(type)?.base ?? "";
}

/** 自定义端点的落点字段:统一 `url`;grok/jina 的 UI 输入框绑定安卓契约遗留字段。 */
export function customUrlFieldOf(type: string | null | undefined): string {
  const legacy = entryOf(type)?.legacyFields;
  return legacy && legacy.length > 0 ? legacy[0] : "url";
}

/** 读取自定义基址:统一 url 字段优先,遗留契约字段(grok=customUrl、jina=searchUrl)兜底。 */
function customBaseOf(service: ServiceLike, entry: SearchServiceEndpointSpec): string {
  for (const field of ["url", ...(entry.legacyFields ?? [])]) {
    const value = String(service[field] ?? "").trim();
    if (value) return value;
  }
  return "";
}

/** 该类型的全部规范路径(剥尾用):search 两模 + fetch。 */
function canonicalPaths(entry: SearchServiceEndpointSpec): string[] {
  const paths = [entry.search, entry.searchMode?.custom, entry.searchMode?.global, entry.fetch]
    .filter((path): path is string => typeof path === "string" && path !== "");
  return [...new Set(paths)];
}

/** 剥掉末尾的规范路径(可叠剥;粘贴值带尾斜杠也兼容)。仅在要拼接路径时调用——路径为空的
 *  服务(Jina)端点即所填值本身,保留用户原始形态(含尾斜杠,与官方 s.jina.ai/ 字面一致)。 */
function stripCanonicalPaths(value: string, paths: string[]): string {
  let out = value.replace(/\/+$/, "");
  for (;;) {
    const hit = paths.find((path) => out.length > path.length && out.toLowerCase().endsWith(path.toLowerCase()));
    if (!hit) return out;
    out = out.slice(0, out.length - hit.length).replace(/\/+$/, "");
  }
}

/** Tinyfish 的 scrape 主机与 search 不同(api.fetch.* vs api.search.*):自定义 search 基址
 *  里的 `search.` 主机标签同名换成 `fetch.`;不含该标签的中转基址原样(同主机代理两径)。 */
function swapSearchHostLabel(url: string): string {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)search\./.test(parsed.hostname)) return url;
    parsed.hostname = parsed.hostname.replace(/(^|\.)search\./, "$1fetch.");
    return parsed.toString();
  } catch {
    return url; // 非完整 URL 形态:原样交由上游报错
  }
}

/** 解析服务行实际请求端点。返回 null = 无从解析(类型未登记 / searxng 未填地址 /
 *  请求 fetch 但该服务没有 fetch 端点)——调用方保持各自兜底。
 *  kind "search" / "fetch" 分别对应 search_web / scrape_web 两类请求。 */
export function resolveServiceEndpoint(service: ServiceLike, kind: "search" | "fetch" = "search"): string | null {
  const entry = entryOf(String(service.type ?? ""));
  if (!entry) return null;
  const custom = customBaseOf(service, entry);
  let base: string;
  let path: string;
  if (kind === "search") {
    base = custom || entry.base;
    path = entry.searchMode
      ? (String(service.mode ?? "custom").toLowerCase() === "global" ? entry.searchMode.global : entry.searchMode.custom)
      : entry.search;
  } else {
    if (entry.fetch === undefined && entry.fetchBase === undefined) return null;
    // fetch 官方根独立登记(tinyfish);自定义时跟随 search 基址做主机标签换名
    base = custom ? (entry.fetchBase ? swapSearchHostLabel(custom) : custom) : (entry.fetchBase ?? entry.base);
    path = entry.fetch ?? "";
  }
  if (!base) return null;
  if (path === "") return base;
  return `${stripCanonicalPaths(base, canonicalPaths(entry))}${path}`;
}

/** 该行是否配置了生效的自定义基址(UI 列表中转标识用):填了自定义且解析结果与官方不同。
 *  grok 预置的官方 customUrl 落在此判定之外——没换址的行不亮标识。 */
export function hasCustomServiceEndpoint(service: ServiceLike): boolean {
  const entry = entryOf(String(service.type ?? ""));
  if (!entry) return false;
  if (!customBaseOf(service, entry)) return false;
  const blanked: ServiceLike = { ...service, url: "" };
  for (const field of entry.legacyFields ?? []) blanked[field] = "";
  return resolveServiceEndpoint(service) !== resolveServiceEndpoint(blanked);
}

/** 类型已知分支内的确定性解析:注册表有该类型但解析不出(searxng 空地址)时抛描述性错误。
 *  调用方已在 `type === "x"` 分支内,未知类型不可能走到。 */
export function requireServiceEndpoint(service: ServiceLike, kind: "search" | "fetch" = "search"): string {
  const endpoint = resolveServiceEndpoint(service, kind);
  if (endpoint) return endpoint;
  const type = String(service.type ?? "").trim() || "unknown";
  if (type === "searxng") throw new Error("SearXNG request URL is empty");
  throw new Error(`Search service "${type}" has no ${kind} endpoint`);
}
