// pi-engine/model-bridge.ts — 契约 ModelGrant → pi 模型运行时（方案 §3.5 / §5.8）。
//
// 原则：模型与密钥只有一个家（应用 state）；pi 是无状态引擎，每轮由应用下发的授权注满。
// 注入走 ModelRuntime 官方内存注册面 registerProvider（为 extension 设计的公开 API），
// pi 侧的 models.json / auth.json 永不存在（modelsPath: null 走内存 store）。
//
// 授权里的数值与请求头是应用侧终值(engines/model-grant:上限单源、请求头汇聚函数),本模块
// 只做 pi 选项翻译。订阅凭据不随授权下发:pi 的 CredentialStore 换成「向应用取令牌」的薄层,
// 刷新只在应用侧发生。
import type { CredentialStore, OAuthCredential } from "../../pi/packages/ai/src/auth/types.ts";
import type { Api, CacheRetention, KnownApi, Model as PiModel } from "../../pi/packages/ai/src/types.ts";
import { ModelRuntime } from "../../pi/packages/coding-agent/src/core/model-runtime.ts";
import type { ProviderConfigInput } from "../../pi/packages/coding-agent/src/core/provider-composer.ts";
import type { ModelGrant, PromptCachePolicy, SubscriptionCredential } from "../engines/contract";
import { OAUTH_FLOWS } from "../model-providers/auth/flows";
import {
  ARK_SEED2_EFFORT_BY_LEVEL,
  budgetTokensFor,
  DASHSCOPE_QWEN38_EFFORT_BY_LEVEL,
  DEEPSEEK_EFFORT_BY_LEVEL,
  DEFAULT_OUTPUT_TOKENS,
  EFFORT_LOW_HIGH_MAX_BY_LEVEL,
  isArkSeed2Model,
  isDashScopeEffortQwenModel,
  isKimiK3Model,
  isSiliconFlowEffortModel,
  isThinkingLevelGeminiModel,
  isZhipuEffortModel,
  isZhipuForcedThinkingModel,
  isZhipuGlm53Model,
  OPENAI_DEVELOPER_ROLE_ALLOWED,
  openAiMaxTokensField,
  openAiThinkingSwitchProtocol,
  reasoningLevelNormalized,
  ZHIPU_GLM53_EFFORT_BY_LEVEL,
} from "../model-providers/request-dialect";

/** 授权在 pi 侧的身份——两种形态,两种身份空间,这里是唯一的翻译点:
 *
 *  - registered(API Key 凭据):应用 provider UUID 直接作 pi providerId(与 pi 内建 id 永不
 *    冲突),经 registerProvider 把授权译成 pi 的 ProviderConfigInput,注册面完全由我们权威。
 *  - builtin(订阅凭据):pi 侧身份 = flow.piProviderId(openai-codex / openai / kimi-coding …)。凭证不
 *    是 apiKey 而是 15 分钟级会过期的 OAuth access,pi 的 getAuth 每请求经 CredentialStore
 *    向应用取(应用侧锁内刷新);Codex 还有专用 api(openai-codex-responses,/codex 路径 +
 *    account-id 头 + 加密推理回传)——这些 pi 内建 provider 原生具备,重新 registerProvider
 *    等于把上游已维护的整形再抄一遍。故内建定义(api/baseUrl/compat/档位表/上限)为权威,
 *    应用只叠加自己独有的东西:会话身份头 + 模型级自定义头(headers),以及内建目录滞后
 *    于厂商时按模板克隆新 id(template)。 */
export type PiModelMapping =
  | {
      kind: "registered";
      providerId: string;
      /** 上游模型 id(进请求体的 model 字段)。 */
      modelId: string;
      config: ProviderConfigInput;
    }
  | {
      kind: "builtin";
      /** pi 内建 provider id(OAUTH_FLOWS[flow].piProviderId)。 */
      providerId: string;
      modelId: string;
      /** 本轮开始时是否已登录(未登录不向应用要令牌,pi 按「无凭据」报错)。 */
      signedIn: boolean;
      /** 叠加到内建模型 headers 上的应用侧请求头(??= 语义由 pi 的合并顺序保证:model.headers 先、options 后)。 */
      headers: Record<string, string>;
      /** 授权的模型身份:内建目录无此 id 时,克隆同供应商模板并按此改写 id/名称/能力。 */
      template: Pick<ModelGrant, "modelId" | "displayName" | "reasoning" | "imageInput">;
    };

export type PiMappingResult = { ok: true; mapping: PiModelMapping } | { ok: false; reason: string };

// 我们不做成本核算（pi 用 cost 算展示成本，全 0 = 不产生虚假数字）。
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
// 我们的模型配置不含上下文窗口/输出上限（安卓同构无此字段）。授权的 limits 带 models.dev
// 真实值（影响 pi 自动压缩阈值 contextWindow-reserveTokens 与请求 max_tokens），
// 查不到时用保守通用默认——128k 窗口宁可让大窗口模型早压缩，也不给小窗口模型虚报。
const DEFAULT_CONTEXT_WINDOW = 128_000;
// 输出上限兜底与聊天引擎同源(DEFAULT_OUTPUT_TOKENS,方言单源)。注意 pi 的
// ProviderConfigInput.models[].maxTokens 是**必填 number**,且其 buildBaseOptions 用
// `options?.maxTokens ?? model.maxTokens` 兜底、对 OpenAI 兼容协议也会发上限字段——
// 这是与聊天引擎的已知结构性差异(那边在用户未配置时省略该字段)。既然省不掉,数值就
// 必须来自单源,否则就是 2026-09-09 GLM-5.3 1210 报障的形态。

// 授权里的上限已是最终值(应用侧 requiredOutputCap,与聊天引擎 Claude 分支同一函数,已含
// "目录脏行剔除 + 用户配置优先 + 收进窗口"),本模块只做纯映射,不二次加工:同一配置下
// 两引擎必须发出同一个数,单源之外再加一层就是新的分歧源。null 才落上面两个默认。

/** 协议映射（方案 §3.5 映射表）。返回 null = 无法映射，走诚实过滤面。 */
export function piApiFor(grant: Pick<ModelGrant, "protocol" | "completionsPath">): KnownApi | null {
  // pi 的 OpenAI 客户端（官方 SDK）固定拼 /chat/completions，自定义补全路径无法透传。
  if (grant.protocol === "openai-completions" && grant.completionsPath) return null;
  return grant.protocol;
}

/** 端点主机(方言判定键)。与应用侧 hostOfProvider 同口径:解析失败为空串。 */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}

function piBaseUrlFor(baseUrl: string, api: KnownApi): string {
  const base = baseUrl.replace(/\/+$/, "");
  // claude 归一化(A,两引擎同款):剥尾部 /v1——pi 的 anthropic SDK 自己拼 /v1/messages;
  // 聊天引擎 endpointFor 同规则(剥 /v1 再拼 /v1/messages),用户带不带 /v1 两引擎皆通。
  // openai(SDK 拼 /chat/completions 或 /responses)与 google(两侧 base 均含 /v1beta)
  // 约定一致,逐字透传。
  if (api === "anthropic-messages") return base.replace(/\/v1$/, "");
  return base;
}

/** pi compat 显式覆盖 = 统一请求方言的 pi 侧翻译（T4.6 内测缺陷修复 → T4.7 方言单源化）。
 *
 *  背景：pi 的 detectCompat 以西方厂商白名单自动探测，未知 baseUrl（国内生态：
 *  DashScope/火山方舟/SiliconFlow/各类中转）一律按「官方 OpenAI 能力」假设——推理
 *  模型系统消息发 "developer"（第三方 400 拒收）、上限字段发 max_completion_tokens
 *  （第三方静默忽略 → 上限失效）。方言事实与依据集中在 model-providers/request-dialect
 *  （聊天引擎构建体消费同一模块），此处只做 pi compat 旋钮的逐字段翻译：
 *
 *  - supportsDeveloperRole ← OPENAI_DEVELOPER_ROLE_ALLOWED（completions/responses 同名同义）。
 *  - maxTokensField ← openAiMaxTokensField(host)（仅 completions；responses 原生
 *    max_output_tokens 无此字段。官方主机显式 max_completion_tokens 与 pi 自动探测
 *    同值，显式写死 = 口径由方言决定，不依赖 pi 探测碰巧一致）。
 *  - 思考「开关」（enable_thinking/thinking.type/thinking_mode 等厂商字段）入方言：
 *    协议种类由 openAiThinkingSwitchProtocol 声明（host 级事实＋SiliconFlow 白名单），
 *    本层经 piThinkingOverridesFor 译成 pi 的 thinkingFormat/supportsReasoningEffort
 *    覆盖——按 host 逐厂商覆盖，不会误伤 OpenRouter 等兜底主机（见该函数头注）。
 *  - 思考「档位值域」同方言（Kimi K3 官方移除 thinking、reasoning_effort 仅认
 *    low/high/max，非法值 400；DeepSeek 官方 effort 同值域）：经 pi 原生
 *    thinkingLevelMap 喂入 EFFORT_LOW_HIGH_MAX_BY_LEVEL——与聊天引擎同一张收拢表。
 *  - 思考档位已接通（runner 传 WORKSPACE_THINKING_LEVEL，非思考模型 pi 自动收拢回
 *    off）。采样设置接通那天的既定口径（勿另起判定）：温度/top_p 过方言
 *    isSamplingLockedModel；claude 老模型预算经 pi 的 options.thinkingBudgets 通道
 *    喂聊天引擎 budgetTokensFor 同款表（届时提升方言）；google 同类。历史思考回传无需接线——pi 对称回传（收到什么字段回传什么字段），
 *    K3/DeepSeek 官方硬性要求已天然满足，与聊天引擎 includeHistoryReasoning 默认
 *    行为一致（工作区不支持用户关闭回传：agent 工具循环下思考连续性即正确性）。
 *  - claude/google 协议无以上概念，不设（各自 compat 类型契约不同）。
 *  - promptCacheKeyMode ← 缓存开关(仅 completions):开关开时显式 "enabled"——pi 的 "auto" 只对
 *    api.openai.com 发 prompt_cache_key,聊天引擎则开关开即发(第三方端点同样),两引擎同义。
 *    开关关时由 cacheRetention:"none" 整体关掉(piCacheRetentionFor),这里不设。 */
function piCompatOverridesFor(host: string, api: KnownApi, promptCacheEnabled: boolean) {
  if (api === "openai-responses") return { supportsDeveloperRole: OPENAI_DEVELOPER_ROLE_ALLOWED };
  if (api !== "openai-completions") return undefined;
  return {
    supportsDeveloperRole: OPENAI_DEVELOPER_ROLE_ALLOWED,
    maxTokensField: openAiMaxTokensField(host),
    // 聊天引擎从不发 store 字段(官方 chat completions 默认即 store:false,无隐私退化;
    // 第三方严格端点对未知字段有拒收风险)——压制 pi 默认的 store:false 输出,两引擎对齐。
    supportsStore: false,
    ...(promptCacheEnabled ? { promptCacheKeyMode: "enabled" as const } : {}),
  };
}

/** 契约缓存策略 → pi 请求的 cacheRetention(各协议适配器再译成 cache_control / prompt_cache_key /
 *  保留期字段)。关必须显式 "none":pi 不传时按 "short" 处理,等于无视开关恒开。 */
export function piCacheRetentionFor(policy: PromptCachePolicy): CacheRetention {
  if (!policy.enabled) return "none";
  return policy.retention === "long" ? "long" : "short";
}

/** pi 受控 settings 的思考预算表——聊天引擎预算表(方言 THINKING_BUDGET_BY_LEVEL,
 *  安卓对齐)的 pi 投影。推导而非抄写:方言表改数值,此处自动跟随。消费面:Google 2.x
 *  预算通道(gemini 2.5 flash 类,此前 pi 默认表 medium=8192 vs 聊天 2000,同档位预算
 *  差 4 倍)。xhigh/max 独立键依赖 vendor 扩键补丁(pi ThinkingBudgets 原生仅四键,
 *  已在 pi/packages/ai 打 [RIKKAHUB PATCH: budget-xhigh-max],全档位与聊天引擎逐值
 *  对齐:xhigh 16000/max 32000);minimal 取聊天兜底值 8000(安卓无 minimal 档,兜底
 *  分支同值)。 */
export const PI_THINKING_BUDGETS: Readonly<Record<"minimal" | "low" | "medium" | "high" | "xhigh" | "max", number>> = {
  minimal: budgetTokensFor("minimal"),
  low: budgetTokensFor("low"),
  medium: budgetTokensFor("medium"),
  high: budgetTokensFor("high"),
  xhigh: budgetTokensFor("xhigh"),
  max: budgetTokensFor("max"),
};

/** Anthropic 格式思考方言(镜像聊天引擎 claudeThinkingPayload——安卓对齐的 adaptive
 *  方言:全部思考模型 thinking:{type:"adaptive"}+output_config.effort,档位原样透传):
 *  pi 默认走老预算方言(thinking:{type:"enabled"}+budget_tokens,xhigh/max 结构性钳
 *  high;用户日志实证同一 K3 端点 chat=effort"max"/pi=budget 8192,形状与值双分歧)。
 *  forceAdaptiveThinking 切 effort 通道;thinkingLevelMap 六档同名登记(pi
 *  mapThinkingLevelToEffort 有映射即原样,缺省会把 xhigh/max 钳 high);off 不标
 *  null——off 时 pi 发 thinking:{type:"disabled"},与聊天引擎 off 分支逐字一致。
 *  已知观感差异:聊天对 DeepSeek 系 display:"raw"(原始思维链),pi 无 thinkingDisplay
 *  透传通道,恒 summarized——仅展示形态,不影响思考行为。 */
function piAnthropicThinkingOverrides(): { compat: Record<string, unknown>; thinkingLevelMap: Record<string, string> } {
  return {
    compat: { forceAdaptiveThinking: true },
    thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  };
}

/** pi 会话思考档位(pi 值域 off/minimal/low/medium/high/xhigh/max,sdk 按模型支持集
 *  就近钳制,非思考模型自动收拢 off)。档位来源=助手设置 reasoningLevel(与聊天引擎
 *  同源同归一化):
 *  - off/none→off:openai 生态不发强度字段(thinking-type 厂商发 disabled);anthropic
 *    尊重 thinkingLevelMap.off=null(K3 思考关不掉→不发字段),与聊天引擎语义一致。
 *  - 六档→同名直传:openai 生态经 thinkingLevelMap 收拢(K3/DeepSeek 三档表)或原样
 *    effort;anthropic 走 adaptive+effort 方言(见 piAnthropicThinkingOverrides);
 *    google 走预算通道,查受控 settings 注入的 PI_THINKING_BUDGETS(vendor 扩键后
 *    六档精确命中,与聊天引擎逐值一致)。
 *  - auto/未知→medium:pi 无"不发字段用厂商默认"的 auto 语义,取编码 agent 生态通行
 *    默认(与接线前的固定档位一致,未显式选档的用户零行为变化)。 */
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const PI_THINKING_LEVELS: readonly PiThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function piThinkingLevelFor(reasoningLevel: string | null | undefined): PiThinkingLevel {
  const normalized = reasoningLevelNormalized(reasoningLevel);
  return (PI_THINKING_LEVELS as readonly string[]).includes(normalized) ? (normalized as PiThinkingLevel) : "medium";
}

/** 厂商思考开关的 pi 侧翻译——方言 openAiThinkingSwitchProtocol 的消费者（全面审查 7）。
 *
 *  修复的故障面：此前工作区对智谱/DeepSeek（pi 白名单探测 zai/deepseek format）在
 *  未接档位时强制发 thinking:{type:"disabled"} 关思考（agent 推理能力被残废）；对
 *  DashScope/火山/SiliconFlow（pi 白名单外）不发任何开关字段，用户无从控制。
 *  原则同 maxTokensField：显式覆盖＝口径由方言决定，不依赖 pi 探测碰巧一致（对
 *  智谱/DeepSeek 的覆盖与 pi 探测同值，幂等锁定）。
 *
 *  已知降级（诚实记录）：DashScope thinking_budget 预算精调、K2.6 keep:"all" 保留式
 *  思考——pi 无对应旋钮，开关生效但附加参数不发；书生 thinking_mode pi 无法表达，
 *  压制思考字段走模型默认。NVIDIA：pi 白名单显式关 effort（作者实证，值域特殊），
 *  预置无此厂商，尊重探测不覆盖。 */
function piThinkingOverridesFor(
  host: string,
  modelId: string,
): { compat?: Record<string, unknown>; thinkingLevelMap?: Record<string, string | null> } | undefined {
  if (host === "integrate.api.nvidia.com") return undefined;
  if (isKimiK3Model(modelId) && host !== "dashscope.aliyuncs.com") {
    // K3(模型级,跨渠道;百炼直供例外——那里包装成自家 enable_thinking 口径,与聊天
    // 引擎 host 优先的分支顺序同语义,走下方 qwen format 分支):pi 对官方 moonshot
    // 探测 supportsReasoningEffort=false,须显式开回才能发档位;收拢与 off 不可关
    // (null 隐藏 off 项)由映射表表达,与聊天引擎同表。
    return {
      compat: { supportsReasoningEffort: true },
      thinkingLevelMap: { off: null, ...EFFORT_LOW_HIGH_MAX_BY_LEVEL },
    };
  }
  const protocol = openAiThinkingSwitchProtocol(host, modelId);
  if (host === "dashscope.aliyuncs.com") {
    // qwen3.8 系(2026-10 官方:reasoning_effort 推荐控制面,与旧参数互斥):pi 原生
    // openai format 发顶层 effort,档位查 qwen3.8 收拢表(off→none 这代思考可关)。
    // 直供 kimi-k3:qwen format 仍发 enable_thinking 开关(pi 该 format 的固定语义),
    // 另开 effort 档位(max/high/low);off 不标 null——off 由 qwen format 发
    // enable_thinking:false 关思考(官方支持),与聊天引擎同义;budget 不设(官方不支持)。
    if (isDashScopeEffortQwenModel(modelId)) {
      return {
        compat: { supportsReasoningEffort: true },
        thinkingLevelMap: { ...DASHSCOPE_QWEN38_EFFORT_BY_LEVEL },
      };
    }
    if (isKimiK3Model(modelId)) {
      return {
        compat: { thinkingFormat: "qwen", supportsReasoningEffort: true },
        thinkingLevelMap: EFFORT_LOW_HIGH_MAX_BY_LEVEL,
      };
    }
    // Qwen3~3.7/VL 混合思考系与直供 GLM:enable_thinking+thinking_budget(文档未废弃)。
    return { compat: { thinkingFormat: "qwen", supportsReasoningEffort: false, thinkingTokenBudgetField: "thinking_budget" } };
  }
  if (protocol === "enable-thinking-flag") {
    // SiliconFlow 白名单:qwen format 发 enable_thinking+thinking_budget
    // (聊天引擎同款两字段;budget 查受控 settings 注入的 PI_THINKING_BUDGETS,与聊天
    // 引擎 budgetTokensFor 同源同值,pi 侧另 clamp 在答案余量内)。
    const budgetField = { thinkingTokenBudgetField: "thinking_budget" };
    if (host === "api.siliconflow.cn" && isSiliconFlowEffortModel(modelId)) {
      // V4 系/GLM-5.2 托管版另发 reasoning_effort(原样透传,服务端自行收拢;xhigh/max
      // 登记过 session clamp),与聊天引擎并发口径一致。
      return {
        compat: { thinkingFormat: "qwen", supportsReasoningEffort: true, ...budgetField },
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      };
    }
    return { compat: { thinkingFormat: "qwen", supportsReasoningEffort: false, ...budgetField } };
  }
  if (protocol === "thinking-type-object") {
    if (host === "api.deepseek.com") {
      // DeepSeek 官方:pi 原生 deepseek format(thinking:{type}+reasoning_effort)幂等
      // 锁定;effort 查 v4 官方收拢表(2026-09:xhigh→high,与 K3 表口径不同已拆分;
      // off 不标 null:可关思考,off 时 pi 发 thinking:{type:"disabled"},与聊天引擎一致)。
      return { compat: { thinkingFormat: "deepseek" }, thinkingLevelMap: { ...DEEPSEEK_EFFORT_BY_LEVEL } };
    }
    if (host === "open.bigmodel.cn") {
      if (isZhipuEffortModel(modelId)) {
        // GLM-5.2+:zai format 发 thinking:{type,clear_thinking}+reasoning_effort 并发
        // (pi zai 分支原生支持,开回 effort 探测)。5.3 系查窄表(服务端仅收 max/high/low)
        // 且强制思考——off 标 null 隐藏(session 钳到最低思考档,不发 disabled,官方 400);
        // 5.2 原样透传(服务端收全七档),可关思考,off 走 disabled。
        if (isZhipuGlm53Model(modelId)) {
          return {
            compat: { thinkingFormat: "zai", supportsReasoningEffort: true },
            thinkingLevelMap: { off: null, ...ZHIPU_GLM53_EFFORT_BY_LEVEL },
          };
        }
        return {
          compat: { thinkingFormat: "zai", supportsReasoningEffort: true },
          thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        };
      }
      if (isZhipuForcedThinkingModel(modelId)) {
        // GLM-4.7/4.5V:强制思考(disabled 会 400)但无 effort 能力——仅隐藏 off 档。
        return { compat: { thinkingFormat: "zai" }, thinkingLevelMap: { off: null } };
      }
      // 智谱其余(GLM-4.6/5/5.1 等):pi 原生 zai format(effort 探测已关)幂等锁定。
      return { compat: { thinkingFormat: "zai" } };
    }
    if (host === "ark.cn-beijing.volces.com" && isArkSeed2Model(modelId)) {
      // Doubao Seed 2.x:deepseek format 原生支持 thinking:{type}+reasoning_effort 并发,
      // 查 seed2 表(仅收 minimal/low/medium/high;用户 minimal 档映 low,off 才是关,
      // 方言表同注);off 走 disabled(seed2 支持)。
      return {
        compat: { thinkingFormat: "deepseek", supportsReasoningEffort: true },
        thinkingLevelMap: { ...ARK_SEED2_EFFORT_BY_LEVEL },
      };
    }
    // 火山老系(Seed 2 以前)/Moonshot K2.5/K2.6:deepseek format 发 thinking:{type},
    // 端点不认 reasoning_effort,压制。已知差异:聊天引擎对 K2.6 开思考时额外发
    // keep:"all"(保留历史思考,安卓 #1586),pi deepseek format 无此旋钮——工作区
    // K2.6 的历史思考由服务端默认剥离,不报错,多轮推理连贯性小损;上游若增旋钮
    // 按维护手册跟进。
    return { compat: { thinkingFormat: "deepseek", supportsReasoningEffort: false } };
  }
  if (protocol === "thinking-mode-flag" || protocol === "suppress") {
    // 书生(pi 无 thinking_mode 旋钮)/SiliconFlow 白名单外(发 enable_thinking 会 400)/
    // K2.7-code(始终思考,开关拒收):压制全部思考字段,模型走默认行为。
    return { compat: { supportsReasoningEffort: false } };
  }
  // reasoning-effort 协议(官方/混元/阶跃/未知中转):字段与格式 pi 默认已对,但 pi 对
  // xhigh/max 两档默认不放行(getSupportedThinkingLevels 仅 thinkingLevelMap 显式登记
  // 才支持),MAX 档会被 clamp 到 high——与聊天引擎默认分支"档位原样透传(含 xhigh/max,
  // 安卓对齐)"分歧(engine-request-diff 实证:chat=max/pi=high)。登记同名映射放行,
  // 两引擎逐字收敛;其余四档 pi 天然放行且不映射,勿画蛇添足。off 亦须登记映射到
  // "none":pi 默认 off 不发字段(吃服务端默认=思考照跑),而官方 completions 自
  // GPT-5.1+ 起接受显式 none(安卓 40426e93 放开钳位),登记后 off 发 reasoning_effort:
  // "none" 与聊天引擎逐字一致。
  return { thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" } };
}

/** 授权 → pi 映射。映射不到时给出原因（错误提示用，方案"诚实披露，不硬塞"）。
 *  授权请求头已含会话身份头(§7.4;X-Session-ID + opencode 特例),经注册头/内建模型头
 *  带进 pi 的每轮请求。 */
export function mapGrantToPi(grant: ModelGrant): PiMappingResult {
  if (!grant.modelId) return { ok: false, reason: "模型缺少 modelId，无法映射到 pi 引擎" };

  // 订阅凭据:身份译成 pi 内建 provider id,其余交给内建定义(见 PiModelMapping 头注)。
  // 授权的 baseUrl / 协议在这条轨上不参与判定——它们只是聊天引擎那侧的形态描述,pi 侧
  // 由内建 provider 自带;未登录不在这里拦,pi 发请求取鉴权时以「无凭据」报错。
  if (grant.credential.kind === "subscription") {
    const flow = grant.credential.flow ? OAUTH_FLOWS[grant.credential.flow] : undefined;
    if (!flow) return { ok: false, reason: `订阅供应商 ${grant.providerName} 未登记 OAuth flow，无法映射到 pi 引擎` };
    return {
      ok: true,
      mapping: {
        kind: "builtin",
        providerId: flow.piProviderId,
        modelId: grant.modelId,
        signedIn: grant.credential.signedIn,
        headers: { ...grant.headers },
        template: {
          modelId: grant.modelId,
          displayName: grant.displayName,
          reasoning: grant.reasoning,
          imageInput: grant.imageInput,
        },
      },
    };
  }

  const api = piApiFor(grant);
  if (!api) {
    return {
      ok: false,
      reason: `自定义补全路径 ${grant.completionsPath} 无法映射到 pi 引擎（其 OpenAI 客户端固定使用 /chat/completions）`,
    };
  }

  const host = hostOf(grant.baseUrl);
  const headers = { ...grant.headers };
  const compatOverrides = piCompatOverridesFor(host, api, grant.promptCache.enabled);
  // 思考开关翻译按协议分派:openai-completions 走厂商方言矩阵(K3 判定在函数内,
  // 模型级跨渠道);anthropic-messages 镜像聊天引擎 adaptive 方言(见函数头注);
  // google/responses 字段与格式 pi 原生已对,但 xhigh/max 两档须同名登记放行(pi
  // getSupportedThinkingLevels 缺映射会钳 high),聊天引擎两处均原样透传:responses
  // 发 reasoning.effort=档位,google 折预算(vendor 扩键后 xhigh/max 精确命中注入表)。
  // off:none 同 reasoning-effort 协议的理由(responses 的 off 兜底分支取它显式发
  // effort:"none");google 分 X2 两态:预算系(2.x)登记 off:"none"——pi 禁用路径发
  // thinkingBudget:0,与聊天引擎逐字一致;Gemini 3 系(thinkingLevel 控制)登记
  // off:null——pi 的 getSupportedThinkingLevels 对未映射的常规档位默认视为支持,
  // 省略键拦不住 off(实测仍走禁用路径发 thinkingBudget:0,而 Gemini 3 只认
  // thinking_level,budget 字段即 400),必须显式 null 才能让 clamp 把 off 前收
  // minimal 发 thinkingLevel——恰与聊天引擎"off 查 minimal 行取最少思考"同义。
  const thinkingOverrides =
    api === "openai-completions"
      ? piThinkingOverridesFor(host, grant.modelId)
      : api === "anthropic-messages"
        ? piAnthropicThinkingOverrides()
        : api === "google-generative-ai" && isThinkingLevelGeminiModel(grant.modelId)
          ? { thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } }
          : { thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" } };

  const { contextWindow: grantWindow, maxTokens: grantMaxTokens } = grant.limits;
  const contextWindow = typeof grantWindow === "number" && grantWindow > 0 ? grantWindow : DEFAULT_CONTEXT_WINDOW;
  const maxTokens = typeof grantMaxTokens === "number" && grantMaxTokens > 0 ? grantMaxTokens : DEFAULT_OUTPUT_TOKENS;

  const config: ProviderConfigInput = {
    name: grant.providerName,
    baseUrl: piBaseUrlFor(grant.baseUrl, api),
    // pi 组合器要求必须有鉴权方式（composeModelProvider 无 key 即抛）；无密钥的本地端点
    // （如 ollama）用占位符——等价我们聊天引擎发 `Bearer ` 空串，服务端同样忽略。
    apiKey: grant.credential.apiKey || "unused",
    api,
    ...(Object.keys(headers).length ? { headers } : {}),
    models: [
      {
        id: grant.modelId,
        name: grant.displayName || grant.modelId,
        reasoning: grant.reasoning,
        input: grant.imageInput ? ["text", "image"] : ["text"],
        cost: ZERO_COST,
        contextWindow,
        maxTokens,
        // 厂商思考开关+档位收拢(方言单源,与聊天引擎同表同判定;见 piThinkingOverridesFor 头注)。
        ...(thinkingOverrides?.thinkingLevelMap ? { thinkingLevelMap: thinkingOverrides.thinkingLevelMap } : {}),
        // 请求口径对齐聊天引擎(缺陷修复与依据见 piCompatOverridesFor/piThinkingOverridesFor 头注)。
        ...(compatOverrides || thinkingOverrides?.compat
          ? { compat: { ...compatOverrides, ...thinkingOverrides?.compat } }
          : {}),
      },
    ],
  };
  return { ok: true, mapping: { kind: "registered", providerId: grant.providerId, modelId: grant.modelId, config } };
}

/** 订阅供应商:从 pi 内建目录取模型并叠加宿主侧请求头。目录无此 id(厂商新模型、pi 快照
 *  滞后)时按同供应商任一内建模型为模板克隆——api/baseUrl/compat 是供应商级的,同供应商
 *  新模型走同一条通道;宿主行提供 id/名称/推理与图像能力。pi 不要求模型在注册表内:
 *  会话直接持有 model 对象,鉴权按 model.provider 查内建 provider,刷新经我们的 store。 */
function resolveBuiltinPiModel(
  runtime: ModelRuntime,
  mapping: Extract<PiModelMapping, { kind: "builtin" }>,
): PiModel<Api> {
  const exact = runtime.getModel(mapping.providerId, mapping.modelId);
  const template = exact ?? runtime.getModels(mapping.providerId)[0];
  if (!template) {
    throw new Error(`pi 内建目录没有订阅供应商 ${mapping.providerId}（vendor 快照缺该 provider，请检查 pi 基线）`);
  }
  const base: PiModel<Api> = exact
    ? template
    : {
        ...template,
        id: mapping.template.modelId,
        name: mapping.template.displayName || mapping.template.modelId,
        reasoning: mapping.template.reasoning,
        input: mapping.template.imageInput ? ["text", "image"] : ["text"],
      };
  // 上下文归宿主 ⇒ 关闭中途 system 消息(D1,pi 1.0 行为修正):pi 1.0 起系统提示词是会话
  // 记录里的 system 消息,提示词/工具变更时在变更处追加差异 section 消息;支持中途
  // system 的模型会把它留在对话末尾(人设/AGENTS.md/技能清单漂到尾部,Codex instructions
  // 落成兜底句)。我们的引擎上下文每轮由宿主从 SQLite 重建(context-encoder),灌注历史里
  // 没有 system 消息——每轮差异 = 整份提示词。强制声明 false:pi 把差异消息挪回开头
  // (collapseSystemMessages 合成一条放最前),与 0.85.1 行为逐字一致。不是关掉 pi 的
  // 机制,只是声明「历史 system 消息由宿主重建,不提供」;将来 §7.4 引擎状态存储把
  // pi 每轮的 system 消息记进 SQLite 原位灌回后,再放开吃「差异补丁保缓存」的红利。
  // Anthropic 另关 supportsMidConvoToolChanges:它是 toolAdditions 的闸门之一
  // (anthropic-messages 的 nativeToolChanges 分支),systemMessages=false 已挡住其
  // 主前提,这里显式压制防上游把闸门重构成复合条件。
  // Anthropic 还关 supportsMessageThreads(pi 1.5.1 新增,provider=anthropic 且端点在
  // api.anthropic.com 时默认开,即 Claude 订阅轨):开启后带 sessionId 的请求只发新增消息,由
  // 服务端续接。我们每轮新建会话、随机 session id,线程只能在一轮的工具循环内续接,收益有限,
  // 却多一个 beta 头和一份服务端状态;保持与 1.0.3 一致的全量请求。会话 id 稳定后(方案
  // P3.3)再评估放开。
  const compat = { ...(base.compat as Record<string, unknown>) };
  compat.supportsMidConvoSystemMessages = false;
  if (base.api === "anthropic-messages") {
    compat.supportsMidConvoToolChanges = false;
    compat.supportsMessageThreads = false;
  }
  const withCompat = { ...base, compat: compat as PiModel<Api>["compat"] };
  if (Object.keys(mapping.headers).length === 0) return withCompat;
  return { ...withCompat, headers: { ...withCompat.headers, ...mapping.headers } };
}

/** 订阅凭据的取用口:向应用要一份剩余有效期足够的令牌(生产 = host.models.credential)。 */
export type SubscriptionCredentialSource = () => Promise<SubscriptionCredential>;

// pi resolveStoredOAuth 的默认刷新窗口(剩余不足 5 分钟即刷新)。应用侧用同一窗口,
// 所以从应用拿到的令牌在 pi 眼里恒为「无需刷新」,正常不会走到 modify。
const PI_OAUTH_MIN_VALIDITY_MS = 5 * 60 * 1000;

/** pi CredentialStore 的「向应用取令牌」实现,只认本轮授权的那一个内建 provider id:
 *  - read:缓存仍在有效窗口内直接返回,否则向应用取(并发读共享一次在途请求)。pi 在运行时
 *    创建与每次请求取鉴权时都会 read,缓存免得每次都回到应用。
 *  - modify:pi 只在令牌临近过期时进来,传入的 fn 会在引擎内刷新。刷新权只在应用,所以不执行
 *    fn,改为向应用重取并作为写后结果返回。
 *  - delete:登出归应用,引擎侧无事可做。
 *  未登录(signedIn:false)时整个 store 为空,pi 按「无凭据」报错(与登出后的既有行为一致)。 */
function createGrantCredentialStore(
  mapping: PiModelMapping,
  source: SubscriptionCredentialSource | undefined,
): CredentialStore {
  const ownProviderId = mapping.kind === "builtin" && mapping.signedIn ? mapping.providerId : null;
  let cached: OAuthCredential | undefined;
  let inflight: Promise<OAuthCredential> | null = null;
  const fetchFresh = (): Promise<OAuthCredential> => {
    if (!source) return Promise.reject(new Error(`订阅凭据通道未接线,无法为 ${ownProviderId} 取令牌`));
    inflight ??= source()
      .then((credential) => {
        cached = { ...(credential as unknown as OAuthCredential), type: "oauth" };
        return cached;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
  return {
    read: async (providerId) => {
      if (providerId !== ownProviderId) return undefined;
      if (cached && Date.now() + PI_OAUTH_MIN_VALIDITY_MS < cached.expires) return cached;
      return fetchFresh();
    },
    list: async () => (ownProviderId ? [{ providerId: ownProviderId, type: "oauth" as const }] : []),
    modify: async (providerId) => (providerId === ownProviderId ? fetchFresh() : undefined),
    delete: async () => {},
  };
}

/** 为一次工作区会话构造 pi 模型运行时:零落盘。
 *  - registered:内存注册单 provider 单模型(registerProvider,应用 UUID 作 providerId),
 *    密钥在注册配置里,凭据存储为空。
 *  - builtin:不注册,直接用 pi 内建 provider(见 PiModelMapping 头注);令牌经
 *    createGrantCredentialStore 向应用取,凭据不落 pi 的 auth.json。 */
export async function createPiModelRuntime(
  mapping: PiModelMapping,
  credentialSource?: SubscriptionCredentialSource,
): Promise<{ runtime: ModelRuntime; model: PiModel<Api> }> {
  const runtime = await ModelRuntime.create({
    // 不传 credentials 时 pi 的文件后端会急切创建 auth.json(空 {}),破"零落盘";
    // modelsPath: null 同理走内存 store。
    credentials: createGrantCredentialStore(mapping, credentialSource),
    modelsPath: null,
  });
  if (mapping.kind === "builtin") {
    return { runtime, model: resolveBuiltinPiModel(runtime, mapping) };
  }
  runtime.registerProvider(mapping.providerId, mapping.config);
  const model = runtime.getModel(mapping.providerId, mapping.modelId);
  if (!model) {
    throw new Error(`pi 运行时未返回已注册模型 ${mapping.providerId}/${mapping.modelId}`);
  }
  return { runtime, model };
}
