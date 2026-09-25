// model-bridge 单测：协议映射矩阵、URL 口径差、鉴权占位、registerProvider 内存注册闭环、
// 订阅供应商内建身份往返(真实 pi 运行时)。
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";

import { defaultSettings } from "../app-config/defaults";
import { piAgentDir } from "../foundation/paths";
import type { Provider } from "../foundation/types";
import { bundledModelsFor, isOAuthProvider, OAUTH_FLOWS } from "../model-providers/auth";
import { model, provider } from "../model-providers";
import { setState, state } from "../persistence/json-store";
import {
  createPiModelRuntime,
  mapProviderModelToPi as mapAny,
  piApiFor,
  PI_THINKING_BUDGETS,
  type PiModelMapping,
  piThinkingLevelFor,
} from "./model-bridge";

function makeProvider(input: Parameters<typeof provider>[0]) {
  return provider({ apiKey: "sk-test", ...input });
}

type RegisteredMapping = Extract<PiModelMapping, { kind: "registered" }>;

/** 本文件多数用例断言 apiKey 供应商的 registerProvider 配置(config)。包一层把返回窄成
 *  registered 变体,订阅供应商(builtin 变体)的用例直接用 mapAny。 */
function mapProviderModelToPi(
  ...args: Parameters<typeof mapAny>
): { ok: true; mapping: RegisteredMapping } | { ok: false; reason: string } {
  const result = mapAny(...args);
  if (result.ok && result.mapping.kind !== "registered") throw new Error("expected a registered (apiKey) mapping");
  return result as { ok: true; mapping: RegisteredMapping } | { ok: false; reason: string };
}

describe("piApiFor 协议映射矩阵", () => {
  it("openai 默认 → openai-completions", () => {
    expect(piApiFor(makeProvider({ id: "p1", name: "P", baseUrl: "https://x/v1" }))).toBe("openai-completions");
  });
  it("openai + useResponseApi → openai-responses", () => {
    expect(piApiFor(makeProvider({ id: "p1", name: "P", baseUrl: "https://x/v1", useResponseApi: true }))).toBe(
      "openai-responses",
    );
  });
  it("openai + 自定义补全路径 → 无法映射", () => {
    expect(
      piApiFor(makeProvider({ id: "p1", name: "P", baseUrl: "https://x", chatCompletionsPath: "/api/v3/chat" })),
    ).toBeNull();
  });
  it("claude → anthropic-messages;google → google-generative-ai", () => {
    expect(piApiFor(makeProvider({ id: "p1", name: "P", baseUrl: "https://x", type: "claude" }))).toBe(
      "anthropic-messages",
    );
    expect(piApiFor(makeProvider({ id: "p1", name: "P", baseUrl: "https://x", type: "google" }))).toBe(
      "google-generative-ai",
    );
  });
});

describe("mapProviderModelToPi", () => {
  it("claude 剥尾部 /v1(pi 的 SDK 自己拼 /v1/messages);openai/google 逐字透传", () => {
    const claude = mapProviderModelToPi(
      makeProvider({ id: "pc", name: "C", baseUrl: "https://api.anthropic.com/v1", type: "claude" }),
      model("claude-sonnet-4-5"),
    );
    if (!claude.ok) throw new Error(claude.reason);
    expect(claude.mapping.config.baseUrl).toBe("https://api.anthropic.com");

    const google = mapProviderModelToPi(
      makeProvider({
        id: "pg",
        name: "G",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        type: "google",
      }),
      model("gemini-2.5-pro"),
    );
    if (!google.ok) throw new Error(google.reason);
    expect(google.mapping.config.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");

    const openai = mapProviderModelToPi(
      makeProvider({ id: "po", name: "O", baseUrl: "https://api.openai.com/v1" }),
      model("gpt-4.1"),
    );
    if (!openai.ok) throw new Error(openai.reason);
    expect(openai.mapping.config.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("空密钥 → 占位符(pi 组合器要求非空;等价我们侧发空 Bearer)", () => {
    const result = mapProviderModelToPi(
      makeProvider({ id: "p1", name: "Local", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "" }),
      model("qwen3:8b"),
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.mapping.config.apiKey).toBe("unused");
  });

  it("Kimi K3:thinkingLevelMap 喂入方言收拢表(off:null 无法关思考)+effort 显式开回(pi 对 moonshot 探测 false)", () => {
    // 跨渠道成立:官方 host 或第三方中转,判定只看模型 id(K3 事实是模型级)。
    for (const baseUrl of ["https://relay.example.com/v1", "https://api.moonshot.cn/v1"]) {
      const k3 = mapProviderModelToPi(makeProvider({ id: "pk", name: "P", baseUrl }), model("kimi-k3"));
      if (!k3.ok) throw new Error(k3.reason);
      expect(k3.mapping.config.models?.[0]?.thinkingLevelMap).toEqual({
        off: null,
        minimal: "low",
        low: "low",
        medium: "high",
        high: "high",
        xhigh: "max",
        max: "max",
      });
      expect((k3.mapping.config.models?.[0]?.compat as any)?.supportsReasoningEffort).toBe(true);
    }
  });

  it("厂商思考开关翻译(全面审查 7):方言协议 → pi thinkingFormat/supportsReasoningEffort", () => {
    const compatOf = (baseUrl: string, modelId: string) => {
      const result = mapProviderModelToPi(makeProvider({ id: "pt", name: "P", baseUrl }), model(modelId));
      if (!result.ok) throw new Error(result.reason);
      return {
        compat: result.mapping.config.models?.[0]?.compat as Record<string, unknown> | undefined,
        thinkingLevelMap: result.mapping.config.models?.[0]?.thinkingLevelMap,
      };
    };

    // DashScope:qwen format 发 enable_thinking+thinking_budget(与聊天引擎同款两字段);
    // effort 端点不认,压制。
    const dashscope = compatOf("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3-max");
    expect(dashscope.compat?.thinkingFormat).toBe("qwen");
    expect(dashscope.compat?.supportsReasoningEffort).toBe(false);
    expect(dashscope.compat?.thinkingTokenBudgetField).toBe("thinking_budget");

    // 百炼直供 kimi-k3:官方不支持 thinking_budget,不设字段(qwen format 仍走 enable_thinking)。
    const dashscopeK3 = compatOf("https://dashscope.aliyuncs.com/compatible-mode/v1", "kimi-k3");
    expect(dashscopeK3.compat?.thinkingFormat).toBe("qwen");
    expect(dashscopeK3.compat?.thinkingTokenBudgetField).toBeUndefined();

    // SiliconFlow:白名单模型走 qwen format;白名单外压制(发 enable_thinking 会 400)。
    const sfListed = compatOf("https://api.siliconflow.cn/v1", "Qwen/Qwen3.5-397B-A17B");
    expect(sfListed.compat?.thinkingFormat).toBe("qwen");
    expect(sfListed.compat?.supportsReasoningEffort).toBe(false);
    const sfUnlisted = compatOf("https://api.siliconflow.cn/v1", "meta-llama/Llama-3.3-70B");
    expect(sfUnlisted.compat?.thinkingFormat).toBeUndefined();
    expect(sfUnlisted.compat?.supportsReasoningEffort).toBe(false);

    // SiliconFlow V4 系托管版:effort 原样透传(服务端收拢)+budget 并发,xhigh/max 登记过 clamp。
    const sfV4 = compatOf("https://api.siliconflow.cn/v1", "Pro/deepseek-ai/DeepSeek-V4-Pro");
    expect(sfV4.compat?.thinkingFormat).toBe("qwen");
    expect(sfV4.compat?.supportsReasoningEffort).toBe(true);
    expect(sfV4.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });

    // 火山方舟 Doubao Seed 2.x:deepseek format+effort 并发,查 seed2 表(minimal 档映 low,
    // xhigh/max 收 high)。
    const arkSeed2 = compatOf("https://ark.cn-beijing.volces.com/api/v3", "doubao-seed-2-0-pro-260215");
    expect(arkSeed2.compat?.thinkingFormat).toBe("deepseek");
    expect(arkSeed2.compat?.supportsReasoningEffort).toBe(true);
    expect(arkSeed2.thinkingLevelMap).toEqual({
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
      max: "high",
    });

    // 火山老系(Seed 2 以前):thinking:{type} 开关,effort 压制(端点不认)。
    const arkLegacy = compatOf("https://ark.cn-beijing.volces.com/api/v3", "doubao-1.5-thinking-pro");
    expect(arkLegacy.compat?.thinkingFormat).toBe("deepseek");
    expect(arkLegacy.compat?.supportsReasoningEffort).toBe(false);

    // 智谱 GLM-5.1 及以下:zai format 幂等锁定(effort 探测保持关)。
    const zhipu = compatOf("https://open.bigmodel.cn/api/paas/v4", "glm-5");
    expect(zhipu.compat?.thinkingFormat).toBe("zai");
    expect(zhipu.compat?.supportsReasoningEffort).toBeUndefined();

    // 智谱 GLM-5.2:effort 开回原样透传(服务端收全七档),可关思考(off 不标 null)。
    const zhipu52 = compatOf("https://open.bigmodel.cn/api/paas/v4", "glm-5.2");
    expect(zhipu52.compat?.thinkingFormat).toBe("zai");
    expect(zhipu52.compat?.supportsReasoningEffort).toBe(true);
    expect(zhipu52.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });

    // 智谱 GLM-5.3:强制思考(off 标 null,不发 disabled——官方 400)+窄表收拢。
    const zhipu53 = compatOf("https://open.bigmodel.cn/api/paas/v4", "glm-5.3-flash");
    expect(zhipu53.compat?.supportsReasoningEffort).toBe(true);
    expect(zhipu53.thinkingLevelMap).toEqual({
      off: null,
      minimal: "low",
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "max",
      max: "max",
    });

    // 智谱 GLM-4.7:强制思考但无 effort 能力——仅隐藏 off 档。
    const zhipu47 = compatOf("https://open.bigmodel.cn/api/paas/v4", "glm-4.7");
    expect(zhipu47.compat?.supportsReasoningEffort).toBeUndefined();
    expect(zhipu47.thinkingLevelMap).toEqual({ off: null });

    // DeepSeek 官方:deepseek format+v4 官方收拢表(2026-09:xhigh→high,与 K3 表口径
    // 不同已拆分;off 不标 null:可关思考走 thinking disabled)。
    const deepseek = compatOf("https://api.deepseek.com/v1", "deepseek-reasoner");
    expect(deepseek.compat?.thinkingFormat).toBe("deepseek");
    expect(deepseek.thinkingLevelMap).toEqual({
      minimal: "low",
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "high",
      max: "max",
    });

    // Moonshot K2.6:thinking:{type}(deepseek format);K2.7:始终思考,全部压制。
    const k26 = compatOf("https://api.moonshot.cn/v1", "kimi-k2.6");
    expect(k26.compat?.thinkingFormat).toBe("deepseek");
    expect(k26.compat?.supportsReasoningEffort).toBe(false);
    const k27 = compatOf("https://api.moonshot.cn/v1", "kimi-k2.7-code");
    expect(k27.compat?.thinkingFormat).toBeUndefined();
    expect(k27.compat?.supportsReasoningEffort).toBe(false);

    // 书生:thinking_mode pi 无旋钮,压制思考字段(工作区已知降级,聊天引擎单边支持)。
    const intern = compatOf("https://chat.intern-ai.org.cn/api/v1", "intern-s1");
    expect(intern.compat?.supportsReasoningEffort).toBe(false);

    // 兜底(混元/中转):pi openai format+effort 默认已对,不覆盖思考字段(仍带
    // developer role/maxTokensField 基础口径)。
    const hunyuan = compatOf("https://api.hunyuan.cloud.tencent.com/v1", "hunyuan-t1");
    expect(hunyuan.compat?.thinkingFormat).toBeUndefined();
    expect(hunyuan.compat?.supportsReasoningEffort).toBeUndefined();

    // NVIDIA:pi 白名单实证关 effort(值域特殊),尊重探测不覆盖。
    const nvidia = compatOf("https://integrate.api.nvidia.com/v1", "deepseek-ai/deepseek-v4");
    expect(nvidia.compat?.thinkingFormat).toBeUndefined();
    expect(nvidia.compat?.supportsReasoningEffort).toBeUndefined();

    // anthropic/google 协议:各有原生思考协议,不适用本翻译。
    const claude = mapProviderModelToPi(
      makeProvider({ id: "pc", name: "C", baseUrl: "https://api.anthropic.com/v1", type: "claude" }),
      model("claude-sonnet-4-5"),
    );
    if (!claude.ok) throw new Error(claude.reason);
    expect((claude.mapping.config.models?.[0]?.compat as any)?.thinkingFormat).toBeUndefined();
  });

  it("能力/模态位翻译:REASONING→reasoning,IMAGE→input 含 image", () => {
    const result = mapProviderModelToPi(
      makeProvider({ id: "p1", name: "P", baseUrl: "https://x/v1" }),
      model("gemini-2.5-pro"), // 工厂会推断 REASONING + IMAGE
    );
    if (!result.ok) throw new Error(result.reason);
    const entry = result.mapping.config.models?.[0];
    expect(entry?.reasoning).toBe(true);
    expect(entry?.input).toEqual(["text", "image"]);
  });

  it("compat 覆盖矩阵:请求口径与聊天引擎对齐(2.0.0 内测缺陷 1/2 回归锁)", () => {
    // pi 对未知 baseUrl 的 compat 自动探测按官方 OpenAI 能力假设:推理模型系统消息发
    // "developer" 角色(第三方端点 400 拒收)、上限字段发 max_completion_tokens(第三方
    // 端点静默忽略→上限失效)。覆盖依据详见 model-bridge piCompatOverridesFor 头注。
    const compatOf = (result: ReturnType<typeof mapProviderModelToPi>) => {
      if (!result.ok) throw new Error(result.reason);
      return result.mapping.config.models?.[0]?.compat;
    };

    // 第三方 OpenAI 兼容端点(内测环境):恒 system + 恒 max_tokens。火山方舟另带
    // 思考开关翻译(thinking:{type} 走 deepseek format,effort 压制;全面审查 7)。
    expect(
      compatOf(mapProviderModelToPi(
        makeProvider({ id: "p1", name: "Ark", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" }),
        model("deepseek-r1"),
      )),
    ).toEqual({
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      supportsStore: false,
      thinkingFormat: "deepseek",
      supportsReasoningEffort: false,
    });

    // 官方 OpenAI / Azure:恒 system + 显式 max_completion_tokens(o 系 chat completions
    // 硬要求;与 pi 自动探测同值,显式写死 = 口径由方言单源决定,T4.7)。
    expect(
      compatOf(mapProviderModelToPi(
        makeProvider({ id: "p2", name: "OpenAI", baseUrl: "https://api.openai.com/v1" }),
        model("o3"),
      )),
    ).toEqual({ supportsDeveloperRole: false, maxTokensField: "max_completion_tokens", supportsStore: false });
    expect(
      compatOf(mapProviderModelToPi(
        makeProvider({ id: "p3", name: "Azure", baseUrl: "https://my-rg.openai.azure.com/openai/v1" }),
        model("o3"),
      )),
    ).toEqual({ supportsDeveloperRole: false, maxTokensField: "max_completion_tokens", supportsStore: false });

    // Responses 协议:原生 max_output_tokens,只需角色覆盖。
    expect(
      compatOf(mapProviderModelToPi(
        makeProvider({ id: "p4", name: "Ark-R", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", useResponseApi: true }),
        model("deepseek-r1"),
      )),
    ).toEqual({ supportsDeveloperRole: false });

    // claude 协议:镜像聊天引擎 adaptive 方言(claudeThinkingPayload——thinking:adaptive
    // + output_config.effort 档位原样;pi 默认预算方言会把 xhigh/max 钳 high 且形状分歧)。
    const claudeMapping = mapProviderModelToPi(
      makeProvider({ id: "p5", name: "C", baseUrl: "https://api.anthropic.com/v1", type: "claude" }),
      model("claude-sonnet-4-5"),
    );
    if (!claudeMapping.ok) throw new Error(claudeMapping.reason);
    expect(claudeMapping.mapping.config.models?.[0]?.compat).toEqual({ forceAdaptiveThinking: true });
    expect(claudeMapping.mapping.config.models?.[0]?.thinkingLevelMap).toEqual({
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });
    // google 协议:思考为协议原生字段(thinkingConfig),无方言分歧,compat 保持不设。
    expect(
      compatOf(mapProviderModelToPi(
        makeProvider({ id: "p6", name: "G", baseUrl: "https://generativelanguage.googleapis.com/v1beta", type: "google" }),
        model("gemini-2.5-pro"),
      )),
    ).toBeUndefined();
  });

  it("模型级自定义头透传(与聊天引擎 applyModelRequestHeaders 同源)", () => {
    const custom = { ...model("gpt-4.1"), customHeaders: [{ name: "X-Proxy-Token", value: "t1" }] };
    const result = mapProviderModelToPi(
      makeProvider({ id: "p1", name: "P", baseUrl: "https://x/v1" }),
      custom,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.mapping.config.headers?.["X-Proxy-Token"]).toBe("t1");
  });

  it("会话身份头经注册头带进 pi 请求(§7.4);缺省兜底随机 UUID(#1902)", () => {
    const provider = makeProvider({ id: "p1", name: "P", baseUrl: "https://api.openai.com/v1" });
    const withSession = mapProviderModelToPi(provider, model("gpt-4.1"), undefined, "conv-pi");
    if (!withSession.ok) throw new Error(withSession.reason);
    expect(withSession.mapping.config.headers?.["X-Session-ID"]).toBe("conv-pi");
    // 缺省(纯测试/冒烟)兜底随机 UUID——OpenCode Zen 拒收无会话头请求,注入层不再留空洞。
    const noSession = mapProviderModelToPi(provider, model("gpt-4.1"));
    if (!noSession.ok) throw new Error(noSession.reason);
    expect(noSession.mapping.config.headers?.["X-Session-ID"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("无法映射时给出可读原因(诚实过滤面)", () => {
    const result = mapProviderModelToPi(
      makeProvider({ id: "p1", name: "P", baseUrl: "https://x", chatCompletionsPath: "/api/v3/chat" }),
      model("m"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("/api/v3/chat");
  });
});

describe("createPiModelRuntime 内存注册闭环", () => {
  it("registerProvider 注册后 getModel 可取,且零落盘", async () => {
    const mapped = mapProviderModelToPi(
      makeProvider({ id: "11111111-2222-3333-4444-555555555555", name: "我的中转", baseUrl: "https://relay.example/v1" }),
      model("gpt-4.1", "GPT 4.1"),
    );
    if (!mapped.ok) throw new Error(mapped.reason);

    const { runtime, model: piModel } = await createPiModelRuntime(mapped.mapping);
    expect(piModel.id).toBe("gpt-4.1");
    expect(piModel.provider).toBe("11111111-2222-3333-4444-555555555555");
    expect(piModel.api).toBe("openai-completions");
    expect(piModel.baseUrl).toBe("https://relay.example/v1");
    expect(runtime.hasConfiguredAuth(piModel.provider)).toBe(true);

    // 零落盘:客房目录整个不存在(auth 用内存存储,models 用内存 store,方案 §3.5 红线)。
    expect(existsSync(piAgentDir)).toBe(false);
  });
});

describe("订阅供应商(OAuth)桥接契约:pi 内建身份往返(真实 pi 运行时)", () => {
  // 2026-09-26 实战回归:Kimi Code 订阅在工作区报「pi 运行时未返回已注册模型 <宿主UUID>/k3」。
  // 根因是桥只「跳过 registerProvider」却仍拿宿主 UUID 去 getModel——两种身份空间在同一个
  // 字段里混用,而旧测试只锁了一个谓词、从未走完往返。这里锁的是往返本身。
  const KIMI = OAUTH_FLOWS["kimi-coding"];
  const CODEX = OAUTH_FLOWS["openai-codex"];

  function seedSignedIn(flow: typeof KIMI, extra: Partial<Provider> = {}): Provider {
    const row: Provider = {
      ...(flow === KIMI
        ? makeProvider({ id: flow.presetProviderId, name: "Kimi Code", baseUrl: "https://api.kimi.com/coding", type: "claude", apiKey: "" })
        : makeProvider({ id: flow.presetProviderId, name: "ChatGPT", baseUrl: "https://chatgpt.com/backend-api/codex", useResponseApi: true, apiKey: "" })),
      authMode: "oauth",
      enabled: true,
      oauth: { flow: flow.id, credential: { type: "oauth", access: "acc", refresh: "ref", expires: 9999999999000 }, signedInAt: 1 },
      models: bundledModelsFor(flow.id),
      ...extra,
    };
    setState({ settings: { ...structuredClone(defaultSettings()), providers: [row] } } as any);
    return row;
  }

  beforeEach(() => setState({ settings: structuredClone(defaultSettings()) } as any));
  afterEach(() => setState({ ...state, settings: { ...state.settings, providers: [] } } as any));

  it("Kimi Code:身份译成 pi 内建 kimi-coding,取回内建 k3(anthropic-messages + 官方 coding 端点),鉴权由我们的 store 供给", async () => {
    const row = seedSignedIn(KIMI);
    const k3 = row.models.find((m) => m.modelId === "k3")!;
    const mapped = mapAny(row, k3, undefined, "conv-ws");
    if (!mapped.ok) throw new Error(mapped.reason);
    expect(mapped.mapping.kind).toBe("builtin");
    expect(mapped.mapping.providerId).toBe("kimi-coding");

    const { runtime, model: piModel } = await createPiModelRuntime(mapped.mapping);
    expect(piModel.provider).toBe("kimi-coding");
    expect(piModel.id).toBe("k3");
    expect(piModel.api).toBe("anthropic-messages");
    expect(piModel.baseUrl).toBe("https://api.kimi.com/coding");
    // 内建定义为权威:上游维护的 compat/档位表原样保留,不被宿主覆盖。
    expect((piModel.compat as Record<string, unknown> | undefined)?.forceAdaptiveThinking).toBe(true);
    // 宿主只叠加自己独有的东西:会话身份头(§7.4)。
    expect(piModel.headers?.["X-Session-ID"]).toBe("conv-ws");
    // 凭证来自宿主 state(经 createPiCredentialStore 的 pi id → flow → 行 反查)。
    expect(runtime.hasConfiguredAuth("kimi-coding")).toBe(true);
    const auth = await runtime.getAuth(piModel);
    expect(auth?.auth.apiKey ?? auth?.auth.headers?.Authorization).toContain("acc");
    // 零落盘不变。
    expect(existsSync(piAgentDir)).toBe(false);
  });

  it("ChatGPT:身份译成 pi 内建 openai-codex,取回 Codex 专用 api(openai-codex-responses),不是宿主形态的 openai-responses", async () => {
    const row = seedSignedIn(CODEX);
    const target = row.models[0]!;
    const mapped = mapAny(row, target);
    if (!mapped.ok) throw new Error(mapped.reason);
    expect(mapped.mapping.providerId).toBe("openai-codex");
    const { model: piModel } = await createPiModelRuntime(mapped.mapping);
    expect(piModel.provider).toBe("openai-codex");
    expect(piModel.id).toBe(target.modelId);
    expect(piModel.api).toBe("openai-codex-responses");
  });

  it("登录后铺入的捆绑目录里每个模型都能在 pi 内建目录取回(catalog.ts 与 pi 快照同源的机械化核对)", async () => {
    for (const flow of [KIMI, CODEX]) {
      const row = seedSignedIn(flow);
      expect(row.models.length).toBeGreaterThan(0);
      for (const m of row.models) {
        const mapped = mapAny(row, m);
        if (!mapped.ok) throw new Error(mapped.reason);
        const { runtime, model: piModel } = await createPiModelRuntime(mapped.mapping);
        expect(runtime.getModel(flow.piProviderId, m.modelId)).toBeDefined();
        expect(piModel.id).toBe(m.modelId);
      }
    }
  });

  it("内建目录滞后于厂商:用户手动加的新 id 按同供应商模板克隆,api/baseUrl 沿用、id/能力取宿主行", async () => {
    const row = seedSignedIn(KIMI);
    const fresh = model("k4-preview", "Kimi K4 Preview");
    fresh.abilities.push("REASONING");
    const mapped = mapAny(row, fresh);
    if (!mapped.ok) throw new Error(mapped.reason);
    const { model: piModel } = await createPiModelRuntime(mapped.mapping);
    expect(piModel.provider).toBe("kimi-coding");
    expect(piModel.id).toBe("k4-preview");
    expect(piModel.name).toBe("Kimi K4 Preview");
    expect(piModel.reasoning).toBe(true);
    expect(piModel.api).toBe("anthropic-messages");
    expect(piModel.baseUrl).toBe("https://api.kimi.com/coding");
  });

  it("未登录的预置订阅供应商(无 oauth 行)仍能按固定 UUID 译出内建身份;鉴权缺失由 pi getAuth 在请求时报,不在映射期拦", async () => {
    const row = seedSignedIn(KIMI, { oauth: undefined, enabled: false });
    const mapped = mapAny(row, row.models[0]!);
    if (!mapped.ok) throw new Error(mapped.reason);
    expect(mapped.mapping.providerId).toBe("kimi-coding");
    const { runtime } = await createPiModelRuntime(mapped.mapping);
    expect(runtime.hasConfiguredAuth("kimi-coding")).toBe(false);
  });

  it("apiKey 供应商 isOAuthProvider 判 false → registered 变体,正常走 registerProvider", () => {
    const mapped = mapAny(
      makeProvider({ id: "p-key", name: "K", baseUrl: "https://relay.example/v1" }),
      model("gpt-4.1", "GPT 4.1"),
    );
    if (!mapped.ok) throw new Error(mapped.reason);
    expect(mapped.mapping.kind).toBe("registered");
    expect(isOAuthProvider(mapped.mapping.provider)).toBe(false);
    expect(mapped.mapping.providerId).toBe("p-key");
  });
});

describe("xhigh/max 档位放行(与聊天引擎原样透传收敛)", () => {
  it("通用 reasoning-effort 协议登记 xhigh/max 同名映射(pi 默认 clamp 到 high,登记后原样出线)", () => {
    const reasoner = model("some-reasoner", "Reasoner");
    reasoner.abilities.push("REASONING");
    const result = mapProviderModelToPi(
      makeProvider({ id: "p-effort", name: "中转", baseUrl: "https://relay.example/v1" }),
      reasoner,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.mapping.config.models?.[0]?.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });
  });

  it("厂商专属协议不登记(effort 压制或另有收拢表,勿覆盖)", () => {
    const arkModel = model("deepseek-r1", "DS");
    arkModel.abilities.push("REASONING");
    const ark = mapProviderModelToPi(
      makeProvider({ id: "p-ark", name: "Ark", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" }),
      arkModel,
    );
    if (!ark.ok) throw new Error(ark.reason);
    expect(ark.mapping.config.models?.[0]?.thinkingLevelMap).toBeUndefined();
  });

  it("google 协议登记 xhigh/max(vendor 扩键后预算通道精确命中注入表,compat 保持不设)", () => {
    const gm = model("gemini-2.5-flash", "GF");
    gm.abilities.push("REASONING");
    const google = mapProviderModelToPi(
      makeProvider({ id: "p-g", name: "G", baseUrl: "https://generativelanguage.googleapis.com/v1beta", type: "google" }),
      gm,
    );
    if (!google.ok) throw new Error(google.reason);
    expect(google.mapping.config.models?.[0]?.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });
    expect(google.mapping.config.models?.[0]?.compat).toBeUndefined();
  });

  it("openai-responses 协议登记 xhigh/max(聊天引擎 reasoning.effort 原样透传,pi 侧同步放行)", () => {
    const rm = model("gpt-5.2", "G5");
    rm.abilities.push("REASONING");
    const responses = mapProviderModelToPi(
      makeProvider({ id: "p-r", name: "R", baseUrl: "https://api.openai.com/v1", useResponseApi: true }),
      rm,
    );
    if (!responses.ok) throw new Error(responses.reason);
    expect(responses.mapping.config.models?.[0]?.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });
  });
});

describe("piThinkingLevelFor 档位翻译(助手设置→pi 会话档位)", () => {
  it("安卓大写六档直传为 pi 小写档位", () => {
    expect(piThinkingLevelFor("MINIMAL")).toBe("minimal");
    expect(piThinkingLevelFor("LOW")).toBe("low");
    expect(piThinkingLevelFor("MEDIUM")).toBe("medium");
    expect(piThinkingLevelFor("HIGH")).toBe("high");
    expect(piThinkingLevelFor("XHIGH")).toBe("xhigh");
    expect(piThinkingLevelFor("MAX")).toBe("max");
  });

  it("off/none 归并为 off(归一化与聊天引擎同函数)", () => {
    expect(piThinkingLevelFor("OFF")).toBe("off");
    expect(piThinkingLevelFor("NONE")).toBe("off");
    expect(piThinkingLevelFor("none")).toBe("off");
  });

  it("auto/空/未知档兜底 medium(pi 无 auto 语义;未显式选档零行为变化)", () => {
    expect(piThinkingLevelFor("AUTO")).toBe("medium");
    expect(piThinkingLevelFor(null)).toBe("medium");
    expect(piThinkingLevelFor(undefined)).toBe("medium");
    expect(piThinkingLevelFor("")).toBe("medium");
    expect(piThinkingLevelFor("超大杯")).toBe("medium");
  });
});

describe("PI_THINKING_BUDGETS 预算投影(Google 2.x 通道与聊天引擎同数值)", () => {
  it("六键推导自方言预算表(vendor 扩键后 xhigh/max 独立命中,与聊天引擎逐值一致)", () => {
    expect(PI_THINKING_BUDGETS).toEqual({ minimal: 8000, low: 1000, medium: 2000, high: 8000, xhigh: 16000, max: 32000 });
  });

  it("vendor 补丁行为锁定:预算查表精确键优先,无注入回退 clamp(升级 pi 丢补丁时此测试变红)", async () => {
    // [RIKKAHUB PATCH: budget-xhigh-max] 的语义锚点——直接测 vendored pi 的查表函数。
    const { thinkingBudgetForLevel } = await import("../../pi/packages/ai/src/api/simple-options.ts");
    expect(thinkingBudgetForLevel("max", PI_THINKING_BUDGETS)).toBe(32000);
    expect(thinkingBudgetForLevel("xhigh", PI_THINKING_BUDGETS)).toBe(16000);
    // 无注入:回退 pi 默认表并 clamp(xhigh/max→high 16384),与上游原版行为一致。
    expect(thinkingBudgetForLevel("max")).toBe(16384);
  });
});
