// tools/schema-inline.ts — MCP 工具 inputSchema 的 $ref 内联展开(单一净化层)
//
// 为什么:开源 MCP 工具的 schema 越来越常用 $defs/$ref 复用子结构。我们的出线路里
// OpenAI/Claude 对完整 schema($defs+$ref 原样)是兼容的,但 Google 原生路
// (functionDeclarations.parameters 是 OpenAPI 子集)不认 $ref——悬空引用即 400,
// 拒掉整条请求(安卓 #1974 实证)。在工具声明单源处(openAiMcpTools)展开,聊天引擎
// 三家协议与 pi 引擎(general-tools/workspace-tools 复用同一声明)天然继承,未来
// 新引擎亦然——这是比安卓(转换层各自展开)更靠上游的单点。
//
// 展开规则(镜像安卓 McpToolSchema.kt cf79246b,行为逐条对齐):
//   - 只沿承载子 Schema 的关键字遍历;enum/const/default/examples 等字面量数据
//     即使含 "$ref" 字段也原样保留(它们不是 schema)。
//   - 与 $ref 同级的关键字(description/default 等)覆盖被引用定义的同名键。
//   - 循环引用在回到自身处截断,只保留被引用定义的 type。
//   - 无法解析的引用(外部 URL/指针不存在)去掉 $ref,退化为不限制类型——发悬空
//     引用必 400,发宽松 schema 只是模型少一层约束。
//   - 展开后 $defs 整体丢弃(已无人引用)。

import type { JsonValue } from "../foundation/types";

/** 值为子 Schema(或其数组)的关键字——递归展开沿这些键下行。 */
const SCHEMA_KEYWORDS = new Set([
  "items",
  "prefixItems",
  "additionalItems",
  "unevaluatedItems",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
]);

/** 值为「名称 -> 子 Schema」映射的关键字。 */
const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
]);

/** 工具 inputSchema 里没有任何文档内引用时返回 true,调用方可跳过克隆(零开销快路径)。 */
function hasLocalRef(node: JsonValue): boolean {
  if (Array.isArray(node)) return node.some(hasLocalRef);
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && value.startsWith("#")) return true;
      if (value !== undefined && hasLocalRef(value)) return true;
    }
  }
  return false;
}

/** 解析文档内 JSON Pointer 引用(如 #/$defs/Foo);找不到或非文档内引用返回 null。 */
function resolvePointer(root: JsonValue, ref: string): JsonValue | null {
  if (!ref.startsWith("#")) return null;
  const tokens = ref.slice(1).split("/").filter(Boolean)
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: JsonValue | undefined = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      current = current[Number.parseInt(token, 10) as never];
    } else if (current !== null && typeof current === "object") {
      current = (current as Record<string, JsonValue>)[token];
    } else {
      return null;
    }
    if (current === undefined) return null;
  }
  return current ?? null;
}

function inlineSchema(schema: JsonValue, root: JsonValue, resolving: ReadonlySet<string>): JsonValue {
  if (Array.isArray(schema)) return schema.map((item) => inlineSchema(item, root, resolving));
  if (schema === null || typeof schema !== "object") return schema;
  const record = schema as Record<string, JsonValue>;
  const ref = typeof record.$ref === "string" ? record.$ref : null;
  // 先递归子结构(剥掉 $ref 键本身),同级关键字先就位——它们之后要覆盖被引用定义。
  const inlined: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "$ref") continue;
    if (SCHEMA_KEYWORDS.has(key)) {
      inlined[key] = Array.isArray(value)
        ? value.map((item) => inlineSchema(item, root, resolving))
        : inlineSchema(value, root, resolving);
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && value !== null && typeof value === "object" && !Array.isArray(value)) {
      inlined[key] = Object.fromEntries(
        Object.entries(value as Record<string, JsonValue>).map(([name, sub]) => [name, inlineSchema(sub, root, resolving)]),
      );
    } else {
      inlined[key] = value;
    }
  }
  if (ref === null) return inlined;
  const target = resolvePointer(root, ref);
  let expanded: Record<string, JsonValue>;
  if (target === null || target === undefined) {
    // 无法解析:去掉 $ref,退化为不限制类型(发悬空引用必 400,宽松 schema 只是少一层约束)。
    expanded = {};
  } else if (resolving.has(ref)) {
    // 循环引用:回到自身处截断,只保留被引用定义的 type。
    const targetType = target !== null && typeof target === "object" && !Array.isArray(target)
      ? (target as Record<string, JsonValue>).type
      : undefined;
    expanded = typeof targetType === "string" ? { type: targetType } : {};
  } else {
    const expandedNode = inlineSchema(target, root, new Set(resolving).add(ref));
    expanded = expandedNode !== null && typeof expandedNode === "object" && !Array.isArray(expandedNode)
      ? (expandedNode as Record<string, JsonValue>)
      : {};
  }
  // 与 $ref 同级的关键字覆盖被引用定义(展开值在前,本地键在后)。
  return { ...expanded, ...inlined };
}

/** MCP 工具 inputSchema 出线净化:内联展开所有文档内 $ref,丢弃 $defs。
 *  无 $ref 的 schema 原对象返回(调用方零拷贝成本,数量占绝大多数)。 */
export function inlineMcpToolSchema(schema: JsonValue): JsonValue {
  if (!hasLocalRef(schema)) return schema;
  const inlined = inlineSchema(schema, schema, new Set());
  // $defs/$definitions 是纯引用容器,展开后已无人引用——留在根上只会白占 token
  // (Google 路还会因未知关键字增加 400 面),丢弃。
  if (inlined !== null && typeof inlined === "object" && !Array.isArray(inlined)) {
    const { $defs: _defs, definitions: _definitions, ...rest } = inlined as Record<string, JsonValue>;
    return rest;
  }
  return inlined;
}
