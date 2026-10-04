// search/service-depth.ts — 搜索深度参数登记表(前后端单源)
//
// 只有三种服务真的消费 depth:登记即显示深度选择、未登记即不显示(其余 13 种 + custom_js 不读它,
// 再给下拉就是空壳)。选项与缺省值都取自安卓同名 Options(SearchService.kt 默认值 +
// SettingSearchDetailPage.kt 分段选项,2026-10-04 核对),跨端备份往返值域一致:
//   - tavily:   basic | advanced,缺省 advanced(TavilySearchService.kt `depth.ifEmpty { "advanced" }`)。
//               厂商文档(docs.tavily.com search_depth,2026-10-04)另有 fast/ultra-fast,安卓未开放,不登记。
//   - linkup:   standard | deep,缺省 standard。厂商文档(docs.linkup.so,2026-10-04)另有 flash/fast,同上。
//   - rikkahub: standard | deep,缺省 standard。
// 值域外的存量值(旧版设置页曾对所有类型给出 basic/standard/advanced 并集)按缺省值发送,
// 不把厂商不认的值发出去。
//
// 纪律:本模块零 import、纯数据与纯函数——web-ui 经 `@server` 直接引用(先例 service-endpoints)。

export interface SearchDepthSpec {
  readonly values: readonly string[];
  readonly fallback: string;
}

export const SEARCH_DEPTH_OPTIONS: Readonly<Record<string, SearchDepthSpec>> = {
  tavily: { values: ["basic", "advanced"], fallback: "advanced" },
  linkup: { values: ["standard", "deep"], fallback: "standard" },
  rikkahub: { values: ["standard", "deep"], fallback: "standard" },
};

/** 该类型的深度登记(未登记 = 该服务不消费深度,界面不显示)。 */
export function searchDepthSpecOf(type: string | null | undefined): SearchDepthSpec | undefined {
  return SEARCH_DEPTH_OPTIONS[String(type ?? "").trim().toLowerCase()];
}

/** 实际发送的深度值:值域内取用户值,否则取缺省。未登记类型返回 undefined。前端显示同口径。 */
export function resolveSearchDepth(service: Record<string, unknown>): string | undefined {
  const spec = searchDepthSpecOf(String(service.type ?? ""));
  if (!spec) return undefined;
  const value = String(service.depth ?? "").trim();
  return spec.values.includes(value) ? value : spec.fallback;
}
