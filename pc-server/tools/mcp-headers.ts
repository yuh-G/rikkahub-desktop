// tools/mcp-headers.ts — MCP 服务器自定义请求头(commonOptions.headers)的形状单源。
//
// 跨端契约:安卓 McpCommonOptions.headers 是 List<Pair<String,String>>,kotlinx 序列化为
// `{"first": 名称, "second": 值}` 数组——这是唯一能被 APP 解码的存储形状。
// 历史上 PC 设置页的 JSON 输入框示例是 `[["名称","值"]]`,用户照填的就落成了元组数组,
// 另有少量 `{key/name, value}` 手写形状。读取一律三形状兼容,写入一律收敛为 {first,second}。
//
// 纪律:本模块零 Bun/node 引用——web-ui 经 @server 直接复用同一份换算(设置页读写边界)。

export interface McpHeaderPair {
  first: string;
  second: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 读任意历史形状 → 有序的 {name,value} 列表。空名称的行保留(编辑中的半成品),消费方自行跳过。 */
export function readMcpHeaders(raw: unknown): Array<{ name: string; value: string }> {
  if (!Array.isArray(raw)) return [];
  const result: Array<{ name: string; value: string }> = [];
  for (const header of raw) {
    if (Array.isArray(header)) {
      result.push({ name: String(header[0] ?? ""), value: String(header[1] ?? "") });
    } else if (isRecord(header)) {
      result.push({
        name: String(header.first ?? header.key ?? header.name ?? ""),
        value: String(header.second ?? header.value ?? ""),
      });
    }
  }
  return result;
}

/** 写入形状:与安卓 Pair 序列化逐字一致。 */
export function toMcpHeaderPairs(items: ReadonlyArray<{ name: string; value: string }>): McpHeaderPair[] {
  return items.map((item) => ({ first: item.name, second: item.value }));
}

/** 任意形状 → 存储形状(写入点与跨端导出共用)。 */
export function normalizeMcpHeaders(raw: unknown): McpHeaderPair[] {
  return toMcpHeaderPairs(readMcpHeaders(raw));
}
