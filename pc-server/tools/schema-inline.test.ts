// tools/schema-inline 单测:$ref 内联展开的六条行为锁,用例镜像安卓 McpToolSchemaTest
// (cf79246b,#1974)。动机:Google 原生路(functionDeclarations.parameters 是 OpenAPI
// 子集)不认 $ref——悬空引用拒整条请求;展开在 openAiMcpTools 声明单源处做,聊天
// 引擎三家协议与 pi 引擎同源继承。
import { describe, expect, test } from "bun:test";

import type { JsonValue } from "../foundation/types";
import { inlineMcpToolSchema } from "./schema-inline";

const json = (text: string): JsonValue => JSON.parse(text);

describe("inlineMcpToolSchema — $ref 内联展开", () => {
  test("无 $ref 的 schema 原对象返回(零拷贝快路径)", () => {
    const schema = json(`{"type":"object","properties":{"query":{"type":"string","description":"keyword"}},"required":["query"]}`);
    expect(inlineMcpToolSchema(schema)).toBe(schema);
  });

  test("引用内联展开,同级关键字覆盖被引用定义;items/anyOf 等承载键递归下行", () => {
    const result = inlineMcpToolSchema(json(`{
      "type": "object",
      "properties": {
        "trigger": {"$ref": "#/$defs/Trigger", "description": "override"},
        "items": {"type": "array", "items": {"$ref": "#/$defs/Trigger"}},
        "choice": {"anyOf": [{"$ref": "#/$defs/Trigger"}, {"type": "null"}]}
      },
      "$defs": {
        "Trigger": {
          "type": "object",
          "description": "original",
          "properties": {"spec": {"$ref": "#/$defs/Spec"}}
        },
        "Spec": {"type": "string", "enum": ["a", "b"]}
      }
    }`)) as Record<string, any>;
    const trigger = { type: "object", description: "original", properties: { spec: { type: "string", enum: ["a", "b"] } } };
    expect(result.properties.trigger).toEqual({ ...trigger, description: "override" });
    expect(result.properties.items).toEqual({ type: "array", items: trigger });
    expect(result.properties.choice).toEqual({ anyOf: [trigger, { type: "null" }] });
    // $defs 展开后整体消失,产物不再含任何 $ref(悬空引用 400 的来源清零)。
    expect(JSON.stringify(result)).not.toContain("$ref");
    expect(result.$defs).toBeUndefined();
  });

  test("字面量数据(enum/const/default/examples)里的 $ref 字段原样保留,不当 schema 展开", () => {
    const properties = {
      trigger: {
        enum: [{ $ref: "document.json" }],
        const: { $ref: "#/$defs/Spec" },
        default: { $ref: "document.json" },
        examples: [{ $ref: "#/$defs/Spec" }],
      },
    };
    const result = inlineMcpToolSchema({ type: "object", properties, $defs: { Spec: { type: "string" } } }) as Record<string, any>;
    expect(result.properties.trigger).toEqual(properties.trigger);
  });

  test("名为关键字形状的属性(default/enum 作属性名)仍按子 Schema 处理", () => {
    const result = inlineMcpToolSchema(json(`{
      "type": "object",
      "properties": {
        "default": {"$ref": "#/$defs/Spec"},
        "trigger": {"type": "object", "properties": {"enum": {"$ref": "#/$defs/Spec"}}}
      },
      "$defs": {"Spec": {"type": "string"}}
    }`)) as Record<string, any>;
    expect(result.properties.default).toEqual({ type: "string" });
    expect(result.properties.trigger.properties.enum).toEqual({ type: "string" });
  });

  test("循环引用在回到自身处截断,只保留被引用定义的 type", () => {
    const result = inlineMcpToolSchema(json(`{
      "type": "object",
      "properties": {"trigger": {"$ref": "#/$defs/Node"}},
      "$defs": {
        "Node": {
          "type": "object",
          "properties": {"children": {"type": "array", "items": {"$ref": "#/$defs/Node"}}}
        }
      }
    }`)) as Record<string, any>;
    expect(result.properties.trigger).toEqual({
      type: "object",
      properties: { children: { type: "array", items: { type: "object" } } },
    });
  });

  test("无法解析的引用(指针缺失/外部 URL)去掉 $ref,不发悬空引用", () => {
    const result = inlineMcpToolSchema(json(`{
      "type": "object",
      "properties": {
        "trigger": {"$ref": "#/$defs/Missing", "description": "kept"},
        "remote": {"$ref": "https://example.com/schema.json"}
      }
    }`)) as Record<string, any>;
    expect(result.properties.trigger).toEqual({ description: "kept" });
    expect(result.properties.remote).toEqual({});
    expect(JSON.stringify(result)).not.toContain("$ref");
  });
});
