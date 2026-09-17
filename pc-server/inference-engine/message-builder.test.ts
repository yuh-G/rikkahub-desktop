// inference-engine/message-builder 纯路径单元测试（5.5 测试补强）。
// 消息编码是发给上游 Provider 的最终形状（OpenAI chat / Response API / Claude），
// 契约冻结：text 折叠、tool 边界分组、OCR 降级、data: URL 透传。
// 注：document part 路径会触 state.files（运行时状态），由端到端 smoke 覆盖，此处不测。
import { describe, expect, test } from "bun:test";

import {
  apiContentFromParts,
  appendAssistantApiMessages,
  claudeBlocksFromUiParts,
  claudeContentFromApiContent,
  dataUrlForMessageUrl,
  documentPartsFirst,
  groupAssistantPartsByToolBoundary,
  isModelAllowTemperature,
  parseDataUrl,
  reasoningPayloadForProvider,
  responseApiContentFromUiParts,
  responseApiMessagesFromUiMessages,
  shouldUseExternalWebSearch,
  supportsInputModality,
} from "./message-builder";
import type { MessagePart, Model, Provider } from "../foundation/types";

const textModel = { inputModalities: ["TEXT"] } as unknown as Model;
const visionModel = { inputModalities: ["TEXT", "IMAGE"] } as unknown as Model;

describe("dataUrlForMessageUrl / parseDataUrl", () => {
  test("data: 与 http(s) URL 直接透传，不查文件表", () => {
    expect(dataUrlForMessageUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(dataUrlForMessageUrl("https://x.com/a.png")).toBe("https://x.com/a.png");
    expect(dataUrlForMessageUrl("")).toBe("");
  });

  test("parseDataUrl 解析 mime 与 base64 数据", () => {
    expect(parseDataUrl("data:image/png;base64,QUJD")).toEqual({ mime: "image/png", data: "QUJD" });
    expect(parseDataUrl("not-a-data-url")).toBeNull();
  });
});

describe("apiContentFromParts", () => {
  test("空 parts 返回 fallback，单 text 折叠为字符串", () => {
    expect(apiContentFromParts([], "fallback")).toBe("fallback");
    expect(apiContentFromParts([{ type: "text", text: "hi" }])).toBe("hi");
  });

  test("多 part 返回数组，空 text 被丢弃", () => {
    const content = apiContentFromParts([
      { type: "text", text: "a" },
      { type: "text", text: "" },
      { type: "image", url: "data:image/png;base64,AA" },
    ]);
    expect(content).toEqual([
      { type: "text", text: "a" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
    ]);
  });

  test("模型不支持 IMAGE 且有 OCR 文本时，图片替换为 OCR 文本（Android OcrTransformer 对齐）", () => {
    const parts: MessagePart[] = [
      { type: "image", url: "data:image/png;base64,AA", metadata: { ocrText: "scanned" } },
    ];
    const stripped = apiContentFromParts(parts, "", textModel);
    expect(stripped).toBe("<image_file_ocr>\nscanned\n</image_file_ocr>");
    const kept = apiContentFromParts(parts, "", visionModel) as Array<{ type: string }>;
    expect(kept.map((p) => p.type)).toEqual(["image_url", "text"]);
  });

  test("audio/video 降级为文本占位", () => {
    expect(apiContentFromParts([{ type: "audio", url: "u" }])).toBe("[audio: u]");
  });
});

describe("documentPartsFirst", () => {
  test("issue6:文档 part 前置(对齐安卓 add(0, prompt)),其余保持稳定顺序", () => {
    const question = { type: "text", text: "问题" };
    const doc1 = { type: "document", url: "/api/files/1/content", fileName: "a.txt" };
    const doc2 = { type: "document", url: "/api/files/2/content", fileName: "b.txt" };
    const image = { type: "image", url: "data:image/png;base64,AA" };
    expect(documentPartsFirst([question, doc1, image, doc2])).toEqual([doc1, doc2, question, image]);
  });

  test("无文档时原样返回(同一引用,零开销)", () => {
    const parts = [{ type: "text", text: "hi" }];
    expect(documentPartsFirst(parts)).toBe(parts);
  });
});

describe("groupAssistantPartsByToolBoundary", () => {
  test("以 tool part 为边界切分 content/tools 组，保持顺序", () => {
    const groups = groupAssistantPartsByToolBoundary([
      { type: "text", text: "before" },
      { type: "tool", toolCallId: "1", toolName: "t", input: "{}", output: [], approvalState: { type: "auto" } },
      { type: "tool", toolCallId: "2", toolName: "t", input: "{}", output: [], approvalState: { type: "auto" } },
      { type: "text", text: "after" },
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["content", "tools", "content"]);
    expect((groups[1] as { tools: unknown[] }).tools).toHaveLength(2);
  });

  test("空输入返回空组", () => {
    expect(groupAssistantPartsByToolBoundary([])).toEqual([]);
  });
});

describe("responseApiContentFromUiParts", () => {
  test("单 text 折叠为字符串，多 part 按角色映射 input_text/output_text", () => {
    expect(responseApiContentFromUiParts([{ type: "text", text: "q" }], "user")).toBe("q");
    expect(responseApiContentFromUiParts([{ type: "text", text: "a" }], "assistant")).toBe("a");
    const multi = responseApiContentFromUiParts(
      [{ type: "text", text: "q" }, { type: "text", text: "r" }],
      "user",
    );
    expect(multi).toEqual([
      { type: "input_text", text: "q" },
      { type: "input_text", text: "r" },
    ]);
  });

  test("已是 API 形状的 image_url part 透传为 input_image", () => {
    const content = responseApiContentFromUiParts(
      [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }],
      "user",
    );
    expect(content).toEqual([{ type: "input_image", image_url: "data:image/png;base64,AA" }]);
  });

  test("未知 part 被过滤", () => {
    expect(responseApiContentFromUiParts([{ type: "mystery" }, "junk"], "user")).toEqual([]);
  });
});

describe("claudeContentFromApiContent", () => {
  test("字符串直接透传", () => {
    expect(claudeContentFromApiContent("plain")).toBe("plain");
  });

  test("image_url data-url 转 Claude base64 source，text 保留", () => {
    const content = claudeContentFromApiContent([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
    ]);
    expect(content).toEqual([
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
    ]);
  });

  test("非 data-url 图片降级为文本占位，未知 part JSON 兜底", () => {
    const content = claudeContentFromApiContent([
      { type: "image_url", image_url: { url: "https://x/a.png" } },
      { type: "weird", x: 1 },
    ]) as Array<{ type: string; text: string }>;
    expect(content[0]).toEqual({ type: "text", text: "[Image: https://x/a.png]" });
    expect(content[1].type).toBe("text");
    expect(JSON.parse(content[1].text)).toEqual({ type: "weird", x: 1 });
  });
});

describe("supportsInputModality", () => {
  test("大小写不敏感，缺省为空数组", () => {
    expect(supportsInputModality(visionModel, "image")).toBe(true);
    expect(supportsInputModality(textModel, "IMAGE")).toBe(false);
    expect(supportsInputModality({} as Model, "TEXT")).toBe(false);
  });
});

// issue10:Gemini 经 OpenAI 兼容层(官方 /openai 端点、各类中转网关)时,必须显式
// 请求 extra_body.google.thinking_config.include_thoughts,否则上游不回传思维链。
describe("reasoningPayloadForProvider — Gemini via OpenAI 兼容层", () => {
  const relay = { type: "openai", baseUrl: "https://my-relay.example.com/v1", apiKey: "k" } as unknown as Provider;
  const gemini25 = { modelId: "gemini-2.5-pro", abilities: ["REASONING"] } as unknown as Model;
  const gemini25Flash = { modelId: "gemini-2.5-flash", abilities: ["REASONING"] } as unknown as Model;
  const gemini3 = { modelId: "gemini-3-pro-preview", abilities: ["REASONING"] } as unknown as Model;

  test("auto 档也要发 include_thoughts(思维链默认回传是本修复的核心)", () => {
    expect(reasoningPayloadForProvider(relay, gemini25, "auto")).toEqual({
      extra_body: { google: { thinking_config: { include_thoughts: true } } },
    });
  });

  test("2.5 系用 thinking_budget;gemini-3 用 thinking_level", () => {
    expect(reasoningPayloadForProvider(relay, gemini25, "high")).toEqual({
      extra_body: { google: { thinking_config: { include_thoughts: true, thinking_budget: 8000 } } },
    });
    expect(reasoningPayloadForProvider(relay, gemini3, "low")).toEqual({
      extra_body: { google: { thinking_config: { include_thoughts: true, thinking_level: "low" } } },
    });
  });

  test("gemini-3 档位按型号查表(对齐 pi getThinkingLevel):Pro 仅 low/high,非 Pro 全值域", () => {
    const gemini35Flash = { modelId: "gemini-3.5-flash", abilities: ["REASONING"] } as unknown as Model;
    const levelOf = (m: Model, level: string) =>
      (reasoningPayloadForProvider(relay, m, level) as any).extra_body.google.thinking_config.thinking_level;
    // Pro:minimal 收 low、medium 收 high(此前 minimal 倒挂映 high、medium 原样发出值域外)。
    expect(levelOf(gemini3, "minimal")).toBe("low");
    expect(levelOf(gemini3, "medium")).toBe("high");
    expect(levelOf(gemini3, "max")).toBe("high");
    // 非 Pro:官方全值域原样。
    expect(levelOf(gemini35Flash, "minimal")).toBe("minimal");
    expect(levelOf(gemini35Flash, "medium")).toBe("medium");
    expect(levelOf(gemini35Flash, "xhigh")).toBe("high");
    // off 思考不可关:取该型号最少档。
    expect(levelOf(gemini3, "off")).toBe("low");
    expect(levelOf(gemini35Flash, "off")).toBe("minimal");
  });

  test("off:flash 关预算,pro 不可关(与原生路径 googleGenerationConfig 一致)", () => {
    expect(reasoningPayloadForProvider(relay, gemini25Flash, "off")).toEqual({
      extra_body: { google: { thinking_config: { include_thoughts: false, thinking_budget: 0 } } },
    });
    expect(reasoningPayloadForProvider(relay, gemini25, "off")).toEqual({
      extra_body: { google: { thinking_config: { include_thoughts: true } } },
    });
  });

  test("非 Gemini 模型不受影响,仍走 reasoning_effort 兜底", () => {
    const other = { modelId: "some-model", abilities: ["REASONING"] } as unknown as Model;
    expect(reasoningPayloadForProvider(relay, other, "high")).toEqual({ reasoning_effort: "high" });
  });

  test("OpenRouter 等已知 host 分支优先,不走 extra_body", () => {
    const openrouter = { type: "openai", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" } as unknown as Provider;
    expect(reasoningPayloadForProvider(openrouter, gemini25, "high")).toEqual({ reasoning: { effort: "high" } });
  });
});

// Kimi K3 请求格式收紧(官方"思考模型/模型参数参考"文档):K3 移除 thinking 参数,改用
// 顶层 reasoning_effort(仅 low/high/max);K2.7-code 传 disabled 报 400,一律不发;
// K2.6 开思考需显式 keep:"all" 才保留历史思考(#1586);K2.5 起采样参数官方固定禁发。
describe("reasoningPayloadForProvider — Moonshot Kimi 代际", () => {
  const moonshot = { type: "openai", baseUrl: "https://api.moonshot.cn/v1", apiKey: "k" } as unknown as Provider;
  const m = (modelId: string) => ({ modelId, abilities: ["REASONING"] }) as unknown as Model;

  test("K3:不发 thinking,档位收拢为顶层 reasoning_effort(low/high/max)", () => {
    expect(reasoningPayloadForProvider(moonshot, m("kimi-k3"), "high")).toEqual({ reasoning_effort: "high" });
    expect(reasoningPayloadForProvider(moonshot, m("kimi-k3"), "medium")).toEqual({ reasoning_effort: "high" });
    expect(reasoningPayloadForProvider(moonshot, m("kimi-k3"), "xhigh")).toEqual({ reasoning_effort: "max" });
    expect(reasoningPayloadForProvider(moonshot, m("kimi-k3"), "max")).toEqual({ reasoning_effort: "max" });
    expect(reasoningPayloadForProvider(moonshot, m("kimi-k3"), "low")).toEqual({ reasoning_effort: "low" });
  });

  test("K3:off 无法关思考,映射 low(官方 FAQ);auto 不发字段用服务端默认", () => {
    expect(reasoningPayloadForProvider(moonshot, m("kimi-k3"), "off")).toEqual({ reasoning_effort: "low" });
    expect(reasoningPayloadForProvider(moonshot, m("kimi-k3"), "auto")).toEqual({});
  });

  test("K3 变体:裸 k3(安卓 KIMI_K3_ALIAS)/带前缀/k3.5 同代延续;k30 不误伤", () => {
    expect(reasoningPayloadForProvider(moonshot, m("k3"), "high")).toEqual({ reasoning_effort: "high" });
    expect(reasoningPayloadForProvider(moonshot, m("moonshotai/Kimi-K3"), "high")).toEqual({ reasoning_effort: "high" });
    expect(reasoningPayloadForProvider(moonshot, m("kimi-k3.5"), "high")).toEqual({ reasoning_effort: "high" });
    expect(reasoningPayloadForProvider(moonshot, m("kimi-k30"), "high")).toEqual({ thinking: { type: "enabled" } });
  });

  test("K2.7-code:始终思考且传 disabled 会 400,一律不发 thinking", () => {
    expect(reasoningPayloadForProvider(moonshot, m("kimi-k2.7-code"), "high")).toEqual({});
    expect(reasoningPayloadForProvider(moonshot, m("kimi-k2.7-code-highspeed"), "off")).toEqual({});
  });

  test("K2.6:开思考补 keep:'all' 保留历史思考(#1586);关思考只发 type", () => {
    expect(reasoningPayloadForProvider(moonshot, m("kimi-k2.6"), "high")).toEqual({
      thinking: { type: "enabled", keep: "all" },
    });
    expect(reasoningPayloadForProvider(moonshot, m("kimi-k2.6"), "off")).toEqual({ thinking: { type: "disabled" } });
  });

  test("K2.5/kimi-latest 维持 thinking{type} 开关(现状不回归)", () => {
    expect(reasoningPayloadForProvider(moonshot, m("kimi-k2.5"), "high")).toEqual({ thinking: { type: "enabled" } });
    expect(reasoningPayloadForProvider(moonshot, m("kimi-latest"), "off")).toEqual({ thinking: { type: "disabled" } });
  });

  test("K3 经透传型中转(未知 host)同样收拢档位——K3 事实是模型级、跨渠道成立", () => {
    const relay = { type: "openai", baseUrl: "https://relay.example.com/v1", apiKey: "k" } as unknown as Provider;
    expect(reasoningPayloadForProvider(relay, m("kimi-k3"), "medium")).toEqual({ reasoning_effort: "high" });
    expect(reasoningPayloadForProvider(relay, m("kimi-k3"), "xhigh")).toEqual({ reasoning_effort: "max" });
    expect(reasoningPayloadForProvider(relay, m("kimi-k3"), "off")).toEqual({ reasoning_effort: "low" });
    expect(reasoningPayloadForProvider(relay, m("kimi-k3"), "auto")).toEqual({});
    // 非 K3 模型经中转不受影响,档位原样透传(既有兜底行为)。
    expect(reasoningPayloadForProvider(relay, m("some-model"), "medium")).toEqual({ reasoning_effort: "medium" });
  });

  test("温度禁发:K2.5+ 采样参数官方固定(跨 host 生效);旧 kimi 与其他模型不受影响", () => {
    const locked = ["kimi-k3", "k3", "kimi-k3.5", "kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "Pro/moonshotai/Kimi-K2.5"];
    for (const id of locked) {
      expect(isModelAllowTemperature({ modelId: id } as unknown as Model)).toBe(false);
    }
    const allowed = ["kimi-latest", "moonshot-v1-8k", "kimi-k2", "gpt-4o"];
    for (const id of allowed) {
      expect(isModelAllowTemperature({ modelId: id } as unknown as Model)).toBe(true);
    }
    // 既有规则回归:o 系与精确 "gpt-5" 仍禁温度
    expect(isModelAllowTemperature({ modelId: "o3" } as unknown as Model)).toBe(false);
    expect(isModelAllowTemperature({ modelId: "gpt-5" } as unknown as Model)).toBe(false);
  });
});

// 2026-09 厂商新格式方言(官方文档口径):智谱 GLM-5.2+/火山 Seed 2.x 的 effort 增强、
// 强制思考型号的 off 防御、DeepSeek v4 收拢表、硅基 V4 系 effort、百炼 K3 budget 防御。
describe("reasoningPayloadForProvider — 2026-09 新格式方言", () => {
  const mk = (baseUrl: string) => ({ type: "openai", baseUrl, apiKey: "k" }) as unknown as Provider;
  const model = (modelId: string) => ({ modelId, abilities: ["REASONING"] }) as unknown as Model;
  const zhipu = mk("https://open.bigmodel.cn/api/paas/v4");
  const ark = mk("https://ark.cn-beijing.volces.com/api/v3");
  const deepseek = mk("https://api.deepseek.com/v1");
  const siliconflow = mk("https://api.siliconflow.cn/v1");
  const dashscope = mk("https://dashscope.aliyuncs.com/compatible-mode/v1");

  test("智谱 GLM-5.3:effort 查窄表并发;off 不发 disabled(强制思考,官方 400)", () => {
    expect(reasoningPayloadForProvider(zhipu, model("glm-5.3"), "MAX")).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
    expect(reasoningPayloadForProvider(zhipu, model("glm-5.3-flash"), "medium")).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
    expect(reasoningPayloadForProvider(zhipu, model("glm-5.3"), "off")).toEqual({});
    expect(reasoningPayloadForProvider(zhipu, model("glm-4.7"), "off")).toEqual({});
  });

  test("智谱 GLM-5.2:effort 原样透传(服务端收全七档);可关思考", () => {
    expect(reasoningPayloadForProvider(zhipu, model("glm-5.2"), "xhigh")).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "xhigh",
    });
    expect(reasoningPayloadForProvider(zhipu, model("glm-5.2"), "off")).toEqual({
      thinking: { type: "disabled" },
    });
  });

  test("智谱 GLM-5.1 及以下:仅 thinking 开关,不发 effort(现状保持)", () => {
    expect(reasoningPayloadForProvider(zhipu, model("glm-5"), "max")).toEqual({
      thinking: { type: "enabled" },
    });
  });

  test("火山 Doubao Seed 2.x:effort 查 seed2 表(minimal 档映 low,xhigh/max 收 high);老系不发", () => {
    expect(reasoningPayloadForProvider(ark, model("doubao-seed-2-0-pro-260215"), "max")).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
    expect(reasoningPayloadForProvider(ark, model("doubao-seed-2-0-mini"), "minimal")).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "low",
    });
    expect(reasoningPayloadForProvider(ark, model("doubao-seed-2-0-pro-260215"), "off")).toEqual({
      thinking: { type: "disabled" },
    });
    expect(reasoningPayloadForProvider(ark, model("doubao-1.5-thinking-pro"), "max")).toEqual({
      thinking: { type: "enabled" },
    });
  });

  test("DeepSeek 官方:v4 收拢表 xhigh→high(2026-09 口径,与 K3 表拆分)", () => {
    expect(reasoningPayloadForProvider(deepseek, model("deepseek-v4-pro"), "xhigh")).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
    expect(reasoningPayloadForProvider(deepseek, model("deepseek-v4-pro"), "max")).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
  });

  test("SiliconFlow V4 系:enable_thinking+effort 原样并发;白名单一般模型不发 effort", () => {
    expect(reasoningPayloadForProvider(siliconflow, model("Pro/deepseek-ai/DeepSeek-V4-Pro"), "xhigh")).toEqual({
      enable_thinking: true,
      reasoning_effort: "xhigh",
    });
    expect(reasoningPayloadForProvider(siliconflow, model("Qwen/Qwen3.5-397B-A17B"), "high")).toEqual({
      enable_thinking: true,
    });
  });

  test("百炼:qwen 系发 thinking_budget;直供 kimi-k3 官方不支持该参数,只发开关", () => {
    expect(reasoningPayloadForProvider(dashscope, model("qwen3-max"), "high")).toEqual({
      enable_thinking: true,
      thinking_budget: 8000,
    });
    expect(reasoningPayloadForProvider(dashscope, model("kimi-k3"), "high")).toEqual({
      enable_thinking: true,
    });
  });
});

describe("responseApiMessagesFromUiMessages — 历史 reasoning 项方言（2026-09-05 内测火山 400）", () => {
  const twoRoundMessages = [
    { id: "u1", role: "USER", parts: [{ type: "text", text: "第一问" }], annotations: [], createdAt: 1 },
    {
      id: "a1",
      role: "ASSISTANT",
      parts: [
        { type: "reasoning", reasoning: "历史思考", createdAt: "2026-09-05T14:00:00Z" },
        { type: "tool", toolCallId: "call_1", toolName: "lookup", input: "{}", output: [{ type: "text", text: "r" }], approvalState: { type: "auto" } },
        { type: "text", text: "第一答" },
      ],
      annotations: [],
      createdAt: 2,
    },
    { id: "u2", role: "USER", parts: [{ type: "text", text: "第二问" }], annotations: [], createdAt: 3 },
  ] as never[];

  test("默认（官方语义）回传 reasoning 项，fc/out/text 完整", () => {
    const input = responseApiMessagesFromUiMessages(twoRoundMessages) as Array<Record<string, unknown>>;
    expect(input.map((item) => String(item.type ?? item.role))).toEqual([
      "user", "reasoning", "function_call", "function_call_output", "assistant", "user",
    ]);
  });

  test("includeReasoningItems=false（第三方端点）剥除 reasoning 项，其余项不受影响", () => {
    const input = responseApiMessagesFromUiMessages(twoRoundMessages, undefined, false) as Array<Record<string, unknown>>;
    expect(input.map((item) => String(item.type ?? item.role))).toEqual([
      "user", "function_call", "function_call_output", "assistant", "user",
    ]);
    // 火山报障核心断言：任何项都不缺 role/type 判别字段，序列化无 null
    expect(JSON.parse(JSON.stringify(input)).every((item: unknown) => item !== null)).toBe(true);
  });

  // 2026-09-07 内测报障:第二问必报 MissingParameter input.arguments。历史库里可能残留
  // 空参工具卡(旧版 Responses 双 id 串台产的幽灵卡),历史编码必须把它归一成 "{}" 而不是
  // 原样发空串——否则老会话每问必炸,且用户无从修复(卡已落库)。
  test("历史里的空参工具卡回传时归一成 \"{}\"（严格端点必填校验）", () => {
    const withEmptyArgs = [
      {
        id: "a1",
        role: "ASSISTANT",
        parts: [
          { type: "tool", toolCallId: "call_ghost", toolName: "lookup", input: "", output: [], approvalState: { type: "auto" } },
          { type: "text", text: "答" },
        ],
        annotations: [],
        createdAt: 1,
      },
      { id: "u2", role: "USER", parts: [{ type: "text", text: "第二问" }], annotations: [], createdAt: 2 },
    ] as never[];
    const input = responseApiMessagesFromUiMessages(withEmptyArgs) as Array<Record<string, unknown>>;
    const call = input.find((item) => item.type === "function_call")!;
    expect(call.arguments).toBe("{}");
    // 配对的结果项同样不能是空串（同类必填校验）。
    const output = input.find((item) => item.type === "function_call_output")!;
    expect(String(output.output ?? "").length).toBeGreaterThan(0);
  });

  test("空结果的 tool_result 在 Claude 侧不产空 text block（Anthropic 拒空块）", () => {
    const blocks = claudeBlocksFromUiParts([]);
    expect(blocks).toHaveLength(1);
    expect(String((blocks[0] as { text?: string }).text ?? "").length).toBeGreaterThan(0);
  });

  test("chat-completions 历史同纪律：空参 tool_calls 也归一成 \"{}\"", () => {
    const items: Array<Record<string, unknown>> = [];
    appendAssistantApiMessages(
      items as never,
      {
        id: "a1",
        role: "ASSISTANT",
        parts: [
          { type: "tool", toolCallId: "call_ghost", toolName: "lookup", input: "", output: [], approvalState: { type: "auto" } },
        ],
        annotations: [],
        createdAt: 1,
      } as never,
      true,
    );
    const assistantTurn = items.find((item) => Array.isArray(item.tool_calls))!;
    const toolCalls = assistantTurn.tool_calls as Array<{ function: { arguments: string } }>;
    expect(toolCalls[0]!.function.arguments).toBe("{}");
  });
});

// 防双搜裁决(对齐安卓 ChatToolFactory.kt:21):外挂 search_web 与模型内置搜索互斥。
// 这是外挂搜索注入源(openAiSearchTools)的唯一门控,聊天/pi/未来引擎同口消费,
// 谓词回归会直接打破 Responses 路的内置/外挂互斥 → 双搜。
describe("shouldUseExternalWebSearch — 内置/外挂搜索互斥", () => {
  const builtInSearchModel = { tools: ["search"] } as unknown as Model;
  const builtInSearchObjModel = { tools: [{ type: "search" }] } as unknown as Model;
  const plainModel = { tools: [] } as unknown as Model;

  test("模型带内置 search(字符串或对象形态)→ 外挂让位,无视全局开关", () => {
    expect(shouldUseExternalWebSearch(true, builtInSearchModel)).toBe(false);
    expect(shouldUseExternalWebSearch(true, builtInSearchObjModel)).toBe(false);
    // 大小写不敏感(与 hasBuiltInTool 同口径)。
    expect(shouldUseExternalWebSearch(true, { tools: ["Search"] } as unknown as Model)).toBe(false);
  });

  test("模型无内置 search → 跟随全局开关", () => {
    expect(shouldUseExternalWebSearch(true, plainModel)).toBe(true);
    expect(shouldUseExternalWebSearch(false, plainModel)).toBe(false);
    // 无 tools 字段 / null 模型 → 视为无内置搜索,不阻断外挂。
    expect(shouldUseExternalWebSearch(true, {} as Model)).toBe(true);
    expect(shouldUseExternalWebSearch(true, null)).toBe(true);
    expect(shouldUseExternalWebSearch(true, undefined)).toBe(true);
  });

  test("全局开关关闭时,任何模型都不注入外挂", () => {
    expect(shouldUseExternalWebSearch(false, builtInSearchModel)).toBe(false);
    expect(shouldUseExternalWebSearch(false, null)).toBe(false);
  });
});
