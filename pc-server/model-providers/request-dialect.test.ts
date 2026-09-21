// 统一请求方言单测:host → 口径事实的映射矩阵(依据见 request-dialect.ts 头注)。
import { describe, expect, it } from "bun:test";
import {
  ARK_SEED2_EFFORT_BY_LEVEL,
  deepseekEffortFor,
  gemini3ThinkingLevelFor,
  isArkSeed2Model,
  isGemini3ProModel,
  isKimiK26Model,
  isKimiK27Model,
  isKimiK3Model,
  isKimiReasoningModel,
  isKimiSamplingLockedModel,
  isMiMoOfficialHost,
  isSamplingLockedModel,
  isSiliconFlowEffortModel,
  isZhipuEffortModel,
  isZhipuForcedThinkingModel,
  isZhipuGlm53Model,
  EFFORT_LOW_HIGH_MAX_BY_LEVEL,
  effortLowHighMaxFor,
  OPENAI_DEVELOPER_ROLE_ALLOWED,
  isOfficialOpenAiHost,
  openAiMaxTokensField,
  openAiThinkingSwitchProtocol,
  registeredOutputLimit,
  responsesHistoryReasoningAllowed,
  SILICONFLOW_THINKING_MODELS,
  ZHIPU_GLM53_EFFORT_BY_LEVEL,
} from "./request-dialect";

describe("request-dialect 统一请求方言", () => {
  it("developer 角色事实:恒不允许(2.0.0 内测缺陷 1/2 根因)", () => {
    expect(OPENAI_DEVELOPER_ROLE_ALLOWED).toBe(false);
  });

  it("官方 OpenAI 系主机判定:api.openai.com 与 Azure OpenAI,其余(含国内生态)皆非", () => {
    expect(isOfficialOpenAiHost("api.openai.com")).toBe(true);
    expect(isOfficialOpenAiHost("my-rg.openai.azure.com")).toBe(true);
    // 前缀伪装不放行(endsWith 带点边界)。
    expect(isOfficialOpenAiHost("evil-api.openai.com.cn")).toBe(false);
    expect(isOfficialOpenAiHost("openai.azure.com.evil.cn")).toBe(false);
    expect(isOfficialOpenAiHost("ark.cn-beijing.volces.com")).toBe(false);
    expect(isOfficialOpenAiHost("dashscope.aliyuncs.com")).toBe(false);
    expect(isOfficialOpenAiHost("api.siliconflow.cn")).toBe(false);
    expect(isOfficialOpenAiHost("openrouter.ai")).toBe(false);
    expect(isOfficialOpenAiHost("127.0.0.1")).toBe(false);
    expect(isOfficialOpenAiHost("")).toBe(false);
  });

  it("上限字段名:官方口 max_completion_tokens(o 系硬要求),其余 max_tokens(第三方静默忽略未知字段)", () => {
    expect(openAiMaxTokensField("api.openai.com")).toBe("max_completion_tokens");
    expect(openAiMaxTokensField("my-rg.openai.azure.com")).toBe("max_completion_tokens");
    expect(openAiMaxTokensField("ark.cn-beijing.volces.com")).toBe("max_tokens");
    expect(openAiMaxTokensField("dashscope.aliyuncs.com")).toBe("max_tokens");
    expect(openAiMaxTokensField("127.0.0.1")).toBe("max_tokens");
  });

  it("输出上限登记表:GLM-5.3 系 131072(2026-09-09 报障的一手实证值)", () => {
    // 登记表是"新模型上限未知时去查官方文档"这条纪律的落点(见 OUTPUT_LIMIT_FACTS 头注)。
    // 它优先于 models.dev——目录对输出上限既滞后又常错,一手文档才是权威。
    expect(registeredOutputLimit("glm-5.3")).toBe(131_072);
    expect(registeredOutputLimit("glm-5.3-flash")).toBe(131_072);
    expect(registeredOutputLimit("GLM-5.3")).toBe(131_072);
    // 未登记的模型返回 null,交由目录/兜底处理——不许在这里编数。
    expect(registeredOutputLimit("gpt-5")).toBeNull();
    expect(registeredOutputLimit("")).toBeNull();
  });

  it("输出上限登记表:2026-09 新注册模型(全一手官方文档实证);未公布的不编数", () => {
    // 每项对应一条 OUTPUT_LIMIT_FACTS,数值与出处见表内注释(2026-09-17 核实)。
    expect(registeredOutputLimit("gpt-5.6-sol")).toBe(128_000);
    expect(registeredOutputLimit("gpt-5.6")).toBe(128_000); // 别名
    expect(registeredOutputLimit("gpt-6-astra")).toBe(128_000);
    expect(registeredOutputLimit("claude-opus-4-8")).toBe(128_000);
    expect(registeredOutputLimit("gemini-3.5-flash")).toBe(65_536);
    expect(registeredOutputLimit("deepseek-flash")).toBe(384_000);
    expect(registeredOutputLimit("deepseek-v4.1-flash")).toBe(384_000);
    expect(registeredOutputLimit("glm-5.2")).toBe(131_072); // 与 5.3 同值但独立条目
    expect(registeredOutputLimit("kimi-k3")).toBe(131_072);
    expect(registeredOutputLimit("k3")).toBe(131_072); // 裸 id
    expect(registeredOutputLimit("minimax-m3")).toBe(512_000);
    expect(registeredOutputLimit("step-3.7-flash")).toBe(262_144);
    expect(registeredOutputLimit("longcat-2.0")).toBe(131_072);
    expect(registeredOutputLimit("qwen3.8-max")).toBe(131_072);
    expect(registeredOutputLimit("qwen3.8-max-0902")).toBe(131_072); // 快照版本
    // Gemini 3.5 Pro 厂商未公布输出上限——刻意不登记,返回 null 落兜底(不编数)。
    expect(registeredOutputLimit("gemini-3.5-pro")).toBeNull();
  });

  it("历史 reasoning 项:仅官方主机回传(火山 400 内测实证 2026-09-05,第二轮必炸根因)", () => {
    expect(responsesHistoryReasoningAllowed("api.openai.com")).toBe(true);
    expect(responsesHistoryReasoningAllowed("my-rg.openai.azure.com")).toBe(true);
    expect(responsesHistoryReasoningAllowed("ark.cn-beijing.volces.com")).toBe(false);
    expect(responsesHistoryReasoningAllowed("open.bigmodel.cn")).toBe(false);
    expect(responsesHistoryReasoningAllowed("")).toBe(false);
  });
});

// Kimi 代际事实(platform.kimi.com「思考模型/模型参数参考」):模型级、跨渠道、跨引擎。
describe("request-dialect Kimi 代际", () => {
  it("K3 判定:kimi-k3 各形态/裸 k3(安卓 KIMI_K3_ALIAS)/k3.5 同代;k30 与 K2.x 不误伤", () => {
    expect(isKimiK3Model("kimi-k3")).toBe(true);
    expect(isKimiK3Model("Kimi-K3-Turbo")).toBe(true);
    expect(isKimiK3Model("moonshotai/Kimi-K3")).toBe(true);
    expect(isKimiK3Model("kimi-k3.5")).toBe(true);
    expect(isKimiK3Model("k3")).toBe(true);
    expect(isKimiK3Model("kimi-k30")).toBe(false);
    expect(isKimiK3Model("kimi-k2.6")).toBe(false);
    expect(isKimiK3Model("kimi-latest")).toBe(false);
  });

  it("K2.7/K2.6 判定:含 -code(-highspeed) 后缀;互不越界", () => {
    expect(isKimiK27Model("kimi-k2.7-code")).toBe(true);
    expect(isKimiK27Model("kimi-k2.7-code-highspeed")).toBe(true);
    expect(isKimiK27Model("kimi-k2.6")).toBe(false);
    expect(isKimiK26Model("kimi-k2.6")).toBe(true);
    expect(isKimiK26Model("kimi-k2.7-code")).toBe(false);
  });

  it("裸名口径(官方新命名去 kimi 前缀,第三方常用):行首锚定接住全系;非行首无 kimi 上下文不误伤", () => {
    expect(isKimiK3Model("k3.5")).toBe(true);
    expect(isKimiK3Model("k3-turbo")).toBe(true);
    expect(isKimiK27Model("k2.7-code")).toBe(true);
    expect(isKimiK26Model("k2.6")).toBe(true);
    expect(isKimiSamplingLockedModel("k2.5")).toBe(true);
    expect(isKimiReasoningModel("k2.7-code-highspeed")).toBe(true);
    // 误伤面:非行首且无 kimi 上下文的 k+数字、行首但数字连写。
    expect(isKimiK3Model("grok-3")).toBe(false);
    expect(isKimiK3Model("k30")).toBe(false);
    expect(isKimiK27Model("mark2.7")).toBe(false);
    expect(isKimiSamplingLockedModel("k2")).toBe(false);
  });

  it("采样锁定:K2.5 起(含 K2.6/K2.7/K3/裸k3/第三方 id 形态)固定 temperature/top_p;旧代不锁", () => {
    for (const id of ["kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "kimi-k3", "k3", "Pro/moonshotai/Kimi-K2.5"]) {
      expect(isKimiSamplingLockedModel(id)).toBe(true);
    }
    for (const id of ["kimi-latest", "moonshot-v1-8k", "kimi-k2", "gpt-4o"]) {
      expect(isKimiSamplingLockedModel(id)).toBe(false);
    }
  });

  it("推理代际谓词:K2.5 起全系支持思考(能力推断消费;与采样锁定同值域、语义分立)", () => {
    for (const id of ["kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "kimi-k3", "kimi-k3.5", "k3", "Pro/moonshotai/Kimi-K2.5"]) {
      expect(isKimiReasoningModel(id)).toBe(true);
    }
    for (const id of ["kimi-latest", "moonshot-v1-8k", "kimi-k2", "gpt-4o"]) {
      expect(isKimiReasoningModel(id)).toBe(false);
    }
  });

  it("采样锁定(跨引擎谓词):o 系/精确 gpt-5/Kimi K2.5+ 锁;gpt-5.1+ 与常规模型放行", () => {
    for (const id of ["o3", "o1-mini", "provider/o4-mini", "gpt-5", "kimi-k3", "kimi-k2.5"]) {
      expect(isSamplingLockedModel(id)).toBe(true);
    }
    for (const id of ["gpt-5.1", "gpt-5.2-turbo", "gpt-4o", "kimi-latest", "claude-sonnet-4-5", "gemini-2.5-pro"]) {
      expect(isSamplingLockedModel(id)).toBe(false);
    }
  });

  it("K3 档位收拢表:六档→low/high/max(非法值即 400 的正确性表;DeepSeek 已拆至官方表);未知档位 undefined 由调用方兜底", () => {
    expect(effortLowHighMaxFor("minimal")).toBe("low");
    expect(effortLowHighMaxFor("low")).toBe("low");
    expect(effortLowHighMaxFor("medium")).toBe("high");
    expect(effortLowHighMaxFor("high")).toBe("high");
    expect(effortLowHighMaxFor("xhigh")).toBe("max");
    expect(effortLowHighMaxFor("max")).toBe("max");
    expect(effortLowHighMaxFor("auto")).toBeUndefined();
    expect(effortLowHighMaxFor("off")).toBeUndefined();
    // 表值域封闭校验:任何映射产物都必须是 K3 合法值(防未来改表时手误)。
    for (const value of Object.values(EFFORT_LOW_HIGH_MAX_BY_LEVEL)) {
      expect(["low", "high", "max"]).toContain(value);
    }
  });
});

// 厂商思考开关协议(全面审查 7):host 级事实,聊天引擎按它拼字段、pi 引擎按它译 compat。
describe("request-dialect 厂商思考开关协议", () => {
  it("host 级判定:DashScope=enable_thinking;火山/智谱/DeepSeek=thinking.type;书生=thinking_mode;兜底=reasoning_effort", () => {
    expect(openAiThinkingSwitchProtocol("dashscope.aliyuncs.com", "qwen3-max")).toBe("enable-thinking-flag");
    expect(openAiThinkingSwitchProtocol("ark.cn-beijing.volces.com", "doubao-seed-2.0")).toBe("thinking-type-object");
    expect(openAiThinkingSwitchProtocol("open.bigmodel.cn", "glm-5")).toBe("thinking-type-object");
    expect(openAiThinkingSwitchProtocol("api.deepseek.com", "deepseek-reasoner")).toBe("thinking-type-object");
    expect(openAiThinkingSwitchProtocol("chat.intern-ai.org.cn", "intern-s1")).toBe("thinking-mode-flag");
    // 兜底:官方 OpenAI/混元/阶跃/中转——OpenAI 原生 reasoning_effort。
    expect(openAiThinkingSwitchProtocol("api.openai.com", "o3")).toBe("reasoning-effort");
    expect(openAiThinkingSwitchProtocol("api.hunyuan.cloud.tencent.com", "hunyuan-t1")).toBe("reasoning-effort");
    expect(openAiThinkingSwitchProtocol("api.stepfun.com", "step-3")).toBe("reasoning-effort");
    expect(openAiThinkingSwitchProtocol("relay.example.com", "some-model")).toBe("reasoning-effort");
  });

  it("SiliconFlow:白名单模型=enable_thinking,白名单外=suppress(发了会 400)", () => {
    expect(SILICONFLOW_THINKING_MODELS.size).toBeGreaterThan(0);
    expect(openAiThinkingSwitchProtocol("api.siliconflow.cn", "Qwen/Qwen3.5-397B-A17B")).toBe("enable-thinking-flag");
    expect(openAiThinkingSwitchProtocol("api.siliconflow.cn", "Pro/zai-org/GLM-5")).toBe("enable-thinking-flag");
    expect(openAiThinkingSwitchProtocol("api.siliconflow.cn", "meta-llama/Llama-3.3-70B")).toBe("suppress");
  });

  it("Moonshot 代际分派:K3=effort(thinking 已移除);K2.7=suppress(始终思考拒收开关);K2.6/K2.5/legacy=thinking.type", () => {
    expect(openAiThinkingSwitchProtocol("api.moonshot.cn", "kimi-k3")).toBe("reasoning-effort");
    expect(openAiThinkingSwitchProtocol("api.moonshot.cn", "kimi-k2.7-code")).toBe("suppress");
    expect(openAiThinkingSwitchProtocol("api.moonshot.cn", "kimi-k2.6")).toBe("thinking-type-object");
    expect(openAiThinkingSwitchProtocol("api.moonshot.cn", "kimi-k2.5")).toBe("thinking-type-object");
    expect(openAiThinkingSwitchProtocol("api.moonshot.cn", "kimi-latest")).toBe("thinking-type-object");
  });

  it("小米 MiMo 官方主机:thinking:{type}(token-plan-cn 子域同族;对齐安卓 L354-360)", () => {
    expect(openAiThinkingSwitchProtocol("api.xiaomimimo.com", "mimo-v3")).toBe("thinking-type-object");
    expect(openAiThinkingSwitchProtocol("token-plan-cn.xiaomimimo.com", "mimo-v3")).toBe("thinking-type-object");
    expect(isMiMoOfficialHost("api.xiaomimimo.com")).toBe(true);
    expect(isMiMoOfficialHost("token-plan-cn.xiaomimimo.com")).toBe(true);
    // 误伤面:别家/空串不命中。
    expect(isMiMoOfficialHost("api.openai.com")).toBe(false);
    expect(isMiMoOfficialHost("")).toBe(false);
  });
});

// 2026-09 新格式方言:模型级谓词边界与新收拢表(官方文档口径,消费面=聊天引擎
// reasoningPayloadForProvider + 工作区 model-bridge,两引擎同源)。
// Gemini 3 档位表:官方值域按型号分裂,口径逐值对齐 pi getThinkingLevel(两引擎恒同)。
describe("request-dialect Gemini 3 thinkingLevel 档位表", () => {
  it("Pro 判定:gemini-3-pro/3.5-pro 命中;flash 与 2.5-pro 不命中", () => {
    expect(isGemini3ProModel("gemini-3-pro-preview")).toBe(true);
    expect(isGemini3ProModel("gemini-3.5-pro")).toBe(true);
    expect(isGemini3ProModel("gemini-3.5-flash")).toBe(false);
    expect(isGemini3ProModel("gemini-2.5-pro")).toBe(false);
  });

  it("Pro 仅 low/high(minimal 收 low、medium 收 high);非 Pro 全值域;xhigh/max 全系收 high(对齐 vendor patch)", () => {
    expect(gemini3ThinkingLevelFor("gemini-3-pro-preview", "minimal")).toBe("low");
    expect(gemini3ThinkingLevelFor("gemini-3-pro-preview", "medium")).toBe("high");
    expect(gemini3ThinkingLevelFor("gemini-3-pro-preview", "xhigh")).toBe("high");
    expect(gemini3ThinkingLevelFor("gemini-3.5-flash", "minimal")).toBe("minimal");
    expect(gemini3ThinkingLevelFor("gemini-3.5-flash", "medium")).toBe("medium");
    expect(gemini3ThinkingLevelFor("gemini-3.5-flash", "max")).toBe("high");
    expect(gemini3ThinkingLevelFor("gemini-3.5-flash", "unknown-future")).toBe("high");
  });
});

describe("request-dialect 2026-09 新格式谓词与收拢表", () => {
  it("智谱版本谓词:5.2 起支持 effort(未来版本默认放行);5.3 窄表;强制思考=5.3 系/4.7/4.5V", () => {
    expect(isZhipuEffortModel("glm-5.1")).toBe(false);
    expect(isZhipuEffortModel("glm-5.2")).toBe(true);
    expect(isZhipuEffortModel("GLM-5.3-Flash")).toBe(true);
    expect(isZhipuEffortModel("glm-6")).toBe(true);
    expect(isZhipuEffortModel("glm-4.7")).toBe(false);
    expect(isZhipuGlm53Model("glm-5.3")).toBe(true);
    expect(isZhipuGlm53Model("glm-5.3-flash")).toBe(true);
    expect(isZhipuGlm53Model("glm-5.2")).toBe(false);
    expect(isZhipuForcedThinkingModel("glm-5.3")).toBe(true);
    expect(isZhipuForcedThinkingModel("glm-4.7")).toBe(true);
    expect(isZhipuForcedThinkingModel("glm-4.5v")).toBe(true);
    expect(isZhipuForcedThinkingModel("glm-4.6")).toBe(false);
    expect(isZhipuForcedThinkingModel("glm-5.2")).toBe(false);
  });

  it("火山 Seed 2.x 谓词与表:seed-2+ 命中(老 doubao 不);minimal 档映 low,xhigh/max 收 high", () => {
    expect(isArkSeed2Model("doubao-seed-2-0-pro-260215")).toBe(true);
    expect(isArkSeed2Model("doubao-seed-2.0")).toBe(true);
    expect(isArkSeed2Model("doubao-seed-3-pro")).toBe(true);
    expect(isArkSeed2Model("doubao-1.5-thinking-pro")).toBe(false);
    expect(ARK_SEED2_EFFORT_BY_LEVEL).toEqual({
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
      max: "high",
    });
  });

  it("DeepSeek v4 表与 K3 表口径分歧锁定:DS xhigh→high(官方 2026-09),K3 xhigh→max", () => {
    expect(deepseekEffortFor("xhigh")).toBe("high");
    expect(deepseekEffortFor("max")).toBe("max");
    expect(deepseekEffortFor("medium")).toBe("high");
    expect(effortLowHighMaxFor("xhigh")).toBe("max");
  });

  it("智谱 5.3 窄表:服务端仅收 max/high/low,收拢建议官方口径", () => {
    expect(ZHIPU_GLM53_EFFORT_BY_LEVEL).toEqual({
      minimal: "low",
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "max",
      max: "max",
    });
  });

  it("硅基 effort 托管模型谓词:V4 系/GLM-5.2 命中,V3.2 不", () => {
    expect(isSiliconFlowEffortModel("Pro/deepseek-ai/DeepSeek-V4-Pro")).toBe(true);
    expect(isSiliconFlowEffortModel("deepseek-ai/DeepSeek-V4-Flash")).toBe(true);
    expect(isSiliconFlowEffortModel("Pro/zai-org/GLM-5.2")).toBe(true);
    expect(isSiliconFlowEffortModel("deepseek-ai/DeepSeek-V3.2")).toBe(false);
  });

  it("白名单增量:2026-09 官方 enable_thinking 支持列表新条目", () => {
    for (const id of [
      "Qwen/Qwen3-235B-A22B",
      "zai-org/GLM-4.6V",
      "zai-org/GLM-5V-Turbo",
      "deepseek-ai/DeepSeek-V3.1",
      "deepseek-ai/DeepSeek-V3.2-Exp",
    ]) {
      expect(SILICONFLOW_THINKING_MODELS.has(id)).toBe(true);
    }
  });
});
