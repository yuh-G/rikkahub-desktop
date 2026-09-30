// service-endpoints.test.ts — 搜索端点注册表的行为锁。
// 核心不变量:「换根不换路径」的 base 语义;完整端点粘贴/遗留字段值幂等还原;
// 遗留字段名(安卓契约)不被统一 url 吞并;未登记类型/空自建地址返回 null 走兜底。

import { describe, expect, test } from "bun:test";

import {
  SEARCH_SERVICE_ENDPOINTS,
  customUrlFieldOf,
  hasCustomServiceEndpoint,
  hasServiceEndpoint,
  requireServiceEndpoint,
  resolveServiceEndpoint,
  serviceEndpointBase,
} from "./service-endpoints";

const svc = (type: string, fields: Record<string, unknown> = {}) => ({ type, ...fields });

describe("注册表覆盖面", () => {
  test("与搜索服务的可换址集合一致:bing_local/custom_js 不登记", () => {
    expect(hasServiceEndpoint("tavily")).toBe(true);
    expect(hasServiceEndpoint("grok")).toBe(true);
    expect(hasServiceEndpoint("jina")).toBe(true);
    expect(hasServiceEndpoint("searxng")).toBe(true);
    expect(hasServiceEndpoint("bing_local")).toBe(false);
    expect(hasServiceEndpoint("custom_js")).toBe(false);
    expect(hasServiceEndpoint("unknown_type")).toBe(false);
    // runSearchWeb 里每个带固定官方端点的类型都必须登记(共 17 家)
    expect(Object.keys(SEARCH_SERVICE_ENDPOINTS).length).toBe(17);
  });

  test("官方基址单源:各类型登记的 base 与其真实服务地址一致", () => {
    expect(serviceEndpointBase("tavily")).toBe("https://api.tavily.com");
    expect(serviceEndpointBase("exa")).toBe("https://api.exa.ai");
    expect(serviceEndpointBase("zhipu")).toBe("https://open.bigmodel.cn");
    expect(serviceEndpointBase("rikkahub")).toBe("https://api.rikka-ai.com");
    expect(serviceEndpointBase("searxng")).toBe(""); // 自建实例无官方地址
  });
});

describe("resolveServiceEndpoint:base 语义", () => {
  test("未自定义 = 官方基址 + 规范路径", () => {
    expect(resolveServiceEndpoint(svc("tavily"))).toBe("https://api.tavily.com/search");
    expect(resolveServiceEndpoint(svc("exa"))).toBe("https://api.exa.ai/search");
    expect(resolveServiceEndpoint(svc("exa"), "fetch")).toBe("https://api.exa.ai/contents");
    expect(resolveServiceEndpoint(svc("ollama"), "fetch")).toBe("https://ollama.com/api/web_fetch");
    expect(resolveServiceEndpoint(svc("grok"))).toBe("https://api.x.ai/v1/responses");
    expect(resolveServiceEndpoint(svc("firecrawl"))).toBe("https://api.firecrawl.dev/v2/search");
  });

  test("自定义基址:换根不换路径", () => {
    expect(resolveServiceEndpoint(svc("tavily", { url: "https://relay.example.com" }))).toBe("https://relay.example.com/search");
    expect(resolveServiceEndpoint(svc("tavily", { url: "https://relay.example.com/" }))).toBe("https://relay.example.com/search");
    expect(resolveServiceEndpoint(svc("exa", { url: "https://relay.example.com" }), "fetch")).toBe("https://relay.example.com/contents");
  });

  test("粘贴完整端点幂等还原:填官方完整端点 = 官方地址,不会拼出 /search/search", () => {
    expect(resolveServiceEndpoint(svc("tavily", { url: "https://api.tavily.com/search" }))).toBe("https://api.tavily.com/search");
    expect(resolveServiceEndpoint(svc("exa", { url: "https://api.exa.ai/search" }))).toBe("https://api.exa.ai/search");
    expect(resolveServiceEndpoint(svc("exa", { url: "https://api.exa.ai/contents" }), "fetch")).toBe("https://api.exa.ai/contents");
    // 中转完整端点:剥尾重拼,基址保留
    expect(resolveServiceEndpoint(svc("tavily", { url: "https://relay.example.com/search" }))).toBe("https://relay.example.com/search");
  });

  test("存量 grok 行:预置的完整官方 customUrl 幂等还原(存量值零迁移)", () => {
    expect(resolveServiceEndpoint(svc("grok", { customUrl: "https://api.x.ai/v1/responses" }))).toBe("https://api.x.ai/v1/responses");
    expect(resolveServiceEndpoint(svc("grok", { customUrl: "https://relay.example.com/v1/responses" }))).toBe("https://relay.example.com/v1/responses");
    // url 优先于 legacy
    expect(resolveServiceEndpoint(svc("grok", { url: "https://relay.example.com", customUrl: "https://api.x.ai/v1/responses" }))).toBe("https://relay.example.com/responses");
  });

  test("jina:端点即所填值本身(官方形态含尾斜杠),searchUrl 遗留字段兜底", () => {
    expect(resolveServiceEndpoint(svc("jina"))).toBe("https://s.jina.ai/");
    expect(resolveServiceEndpoint(svc("jina", { searchUrl: "https://relay.example.com/s/" }))).toBe("https://relay.example.com/s/");
    expect(resolveServiceEndpoint(svc("jina", { url: "https://relay.example.com/j/" }))).toBe("https://relay.example.com/j/");
  });

  test("豆包两模:端点路径随 mode 二选一,自定义基址同样生效", () => {
    expect(resolveServiceEndpoint(svc("doubao", { mode: "custom" }))).toBe("https://open.feedcoopapi.com/search_api/web_search");
    expect(resolveServiceEndpoint(svc("doubao", { mode: "global" }))).toBe("https://open.feedcoopapi.com/search_api/global_search");
    expect(resolveServiceEndpoint(svc("doubao", { mode: "global", url: "https://relay.example.com" }))).toBe("https://relay.example.com/search_api/global_search");
    // 粘贴的任一模完整端点都剥尾还原
    expect(resolveServiceEndpoint(svc("doubao", { url: "https://open.feedcoopapi.com/search_api/web_search" }))).toBe("https://open.feedcoopapi.com/search_api/web_search");
  });

  test("tinyfish:search 与 fetch 官方不同主机;自定义基址做 search.→fetch. 主机换名", () => {
    expect(resolveServiceEndpoint(svc("tinyfish"))).toBe("https://api.search.tinyfish.ai");
    expect(resolveServiceEndpoint(svc("tinyfish"), "fetch")).toBe("https://api.fetch.tinyfish.ai");
    expect(resolveServiceEndpoint(svc("tinyfish", { url: "https://relay.example.com" }))).toBe("https://relay.example.com");
    expect(resolveServiceEndpoint(svc("tinyfish", { url: "https://relay.example.com" }), "fetch")).toBe("https://relay.example.com");
    expect(resolveServiceEndpoint(svc("tinyfish", { url: "https://relay.search.example.com" }), "fetch")).toBe("https://relay.fetch.example.com/");
  });

  test("无 fetch 实现的服务请求 fetch 返回 null(调用方走通用兜底)", () => {
    expect(resolveServiceEndpoint(svc("tavily"), "fetch")).toBeNull();
    expect(resolveServiceEndpoint(svc("brave"), "fetch")).toBeNull();
  });

  test("searxng:必填自建地址,空 = null;填后拼 /search", () => {
    expect(resolveServiceEndpoint(svc("searxng"))).toBeNull();
    expect(resolveServiceEndpoint(svc("searxng", { url: "https://search.example.com" }))).toBe("https://search.example.com/search");
    expect(resolveServiceEndpoint(svc("searxng", { url: "https://search.example.com/" }))).toBe("https://search.example.com/search");
  });

  test("未登记类型返回 null", () => {
    expect(resolveServiceEndpoint(svc("custom_js", { searchScript: "…" }))).toBeNull();
    expect(resolveServiceEndpoint({})).toBeNull();
  });
});

describe("requireServiceEndpoint:已知分支的确定性", () => {
  test("可解析时与 resolve 一致", () => {
    expect(requireServiceEndpoint(svc("tavily", { url: "https://relay.example.com" }))).toBe("https://relay.example.com/search");
  });

  test("searxng 空地址抛人话错误", () => {
    expect(() => requireServiceEndpoint(svc("searxng"))).toThrow(/SearXNG/);
  });
});

describe("中转标识与 UI 落点字段", () => {
  test("hasCustomServiceEndpoint:只有真正换了址的行亮标识", () => {
    expect(hasCustomServiceEndpoint(svc("tavily"))).toBe(false);
    expect(hasCustomServiceEndpoint(svc("tavily", { url: "https://relay.example.com" }))).toBe(true);
    // 粘贴官方完整端点 = 没换址,不亮
    expect(hasCustomServiceEndpoint(svc("tavily", { url: "https://api.tavily.com/search" }))).toBe(false);
    // grok 存量预置官方完整 customUrl = 没换址,不亮
    expect(hasCustomServiceEndpoint(svc("grok", { customUrl: "https://api.x.ai/v1/responses" }))).toBe(false);
    expect(hasCustomServiceEndpoint(svc("grok", { customUrl: "https://relay.example.com/v1/responses" }))).toBe(true);
    // 未登记类型不亮
    expect(hasCustomServiceEndpoint(svc("bing_local"))).toBe(false);
  });

  test("customUrlFieldOf:UI 输入框绑定字段——grok/jina 用安卓契约遗留名,其余统一 url", () => {
    expect(customUrlFieldOf("grok")).toBe("customUrl");
    expect(customUrlFieldOf("jina")).toBe("searchUrl");
    expect(customUrlFieldOf("tavily")).toBe("url");
    expect(customUrlFieldOf("searxng")).toBe("url");
    expect(customUrlFieldOf("exa")).toBe("url");
  });
});
