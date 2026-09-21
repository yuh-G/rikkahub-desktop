/** 统一请求方言（request dialect）——跨引擎出站请求口径的单一事实源。
 *
 *  背景（2.0.0 内测缺陷 1/2 + kelivo 对照审计，台账 T4.6/T4.7）：同一个 provider，
 *  聊天引擎与工作区引擎（pi）各自决定请求形状时必然漂移——pi 按「官方 OpenAI 能力」
 *  假设未知端点，聊天引擎按国内生态口径硬编码，谁都没错但两边不一致就是缺陷。
 *  kelivo 的终态（4100 行单文件、十几个厂商布尔散布在构建逻辑里）证明了不分层的
 *  代价；我们的分层：
 *
 *    层1（本模块）：引擎中性的「方言事实」——host 字符串进、口径结论出，纯函数零依赖。
 *    层2（各引擎翻译层）：聊天引擎构建体直接消费；pi 经 model-bridge 译成 compat；
 *         未来引擎的桥接层译成它自己的旋钮。引擎特有能力（如聊天引擎的厂商思考
 *         开关 reasoningPayloadForProvider）不属于方言，留在各自构建层。
 *    层3（平价回归测试）：跨引擎 e2e 断言真实出站字节一致（pi-route.test.ts）。
 *
 *  收录门槛：**跨引擎必须一致 + 有实证（内测/生产报错或官方文档硬性要求）**。
 *  不做 kelivo 式的推测性厂商全覆盖——没有实证的字段进来只会腐烂。
 *
 *  范围：OpenAI 兼容协议（completions/responses）。claude/google 协议各只有一个
 *  规范实现，两引擎无分歧空间，不需要方言。 */

/** 官方 OpenAI 系主机（api.openai.com / Azure OpenAI）。
 *  这是方言里唯一需要区别对待的主机族：o 系/gpt-5 的 chat completions 硬性要求
 *  max_completion_tokens（对 max_tokens 直接 400）；而第三方 OpenAI 兼容端点普遍
 *  只认 max_tokens。Azure 判定与 kelivo 的 isAzureOpenAI 特判互为印证。 */
export function isOfficialOpenAiHost(host: string): boolean {
  return host === "api.openai.com" || host.endsWith(".openai.azure.com");
}

/** 方言事实：系统提示词永不使用 "developer" 角色，恒发 "system"。
 *  官方 OpenAI 对推理模型同样接受 "system" 并自动归一；第三方端点普遍拒收
 *  "developer"（DashScope 类 400 拒角色枚举、火山方舟报 missing input.role，
 *  2.0.0 内测缺陷 1/2）。聊天引擎由构造保证（全仓库零 "developer"）；pi 经
 *  model-bridge 译成 compat.supportsDeveloperRole。 */
export const OPENAI_DEVELOPER_ROLE_ALLOWED = false;

/** 方言事实：chat completions 的输出上限字段名（responses 协议原生 max_output_tokens，
 *  无此分歧）。官方主机 → max_completion_tokens（o 系硬性要求，全部现役官方模型
 *  接受）；其余一律 max_tokens（第三方端点对未知字段多为**静默忽略**，发
 *  max_completion_tokens 等于上限失效、成本失控）。 */
export function openAiMaxTokensField(host: string): "max_tokens" | "max_completion_tokens" {
  return isOfficialOpenAiHost(host) ? "max_completion_tokens" : "max_tokens";
}

/** 方言事实：Responses API 的历史 reasoning 项（{type:"reasoning", summary:[…]}）
 *  仅对官方 OpenAI 主机回传。summary[]/encrypted_content 是 OpenAI 私有形态（思考
 *  模型多轮衔接用）；第三方 Responses 兼容端点的 reasoning 输入项结构各异——火山
 *  方舟要求 content[]（reasoning_text）+status 结构，对 OpenAI summary 形态按普通
 *  消息解析，直接 400 MissingParameter input.role（2026-09-05 内测实证：
 *  GLM-5.3-flash@plan /responses 端点，第二轮对话历史带思考项必炸；首轮 input 无
 *  历史思考项、续传也不回放 reasoning 项，故首轮从不触发——与报障"第一轮怎么发都
 *  好、第二问必炸"完全吻合）。剥除历史思考项是各家默认语义（模型本就不回看思考），
 *  合法且安全。 */
export function responsesHistoryReasoningAllowed(host: string): boolean {
  return isOfficialOpenAiHost(host);
}

// ===== Kimi（Moonshot）代际事实 =====
// K3 发布后官方逐代收紧请求约束（platform.kimi.com「思考模型/模型参数参考」）。
// 代际判定是模型级事实、跨渠道成立（官方 api.moonshot.cn、硅基流动、透传型中转
// 都跑同一个模型），必须跨引擎一致——否则聊天模式认 K3 而工作区不认，行为分裂。
// 正则对齐安卓 ModelRegistry 的 token 匹配语义（kimi,k,N 连续 token：kimi-k3 /
// Kimi-K3-Turbo / moonshotai/Kimi-K3 都命中），(?![0-9]) 防 k30/k2.56 误伤，
// k3.5 等同代小版本自动延续同规则。
// 裸名口径(全系一致):官方新命名已去 kimi 前缀(K3 官方 id 就是 "k3",用户实证;
// 第三方中转也常用裸名),行首锚定 ^k… 接住 k3/k3.5/k2.7-code 等;非行首无 kimi
// 上下文的 "…k3" 不命中,防误伤别家带 k+数字的名字。

/** K3 系（kimi-k3/k3.5/裸 k3/k3-turbo…）。 */
const KIMI_K3_RE = /(kimi[-._/]?|^)k[-._]?3(?![0-9])/i;
/** K2.7-code(-highspeed)：始终思考，thinking 传 disabled 直接 400。 */
const KIMI_K2_7_RE = /(kimi[-._/]?|^)k[-._]?2[-._]7(?![0-9])/i;
/** K2.6：thinking 可开关；开思考需显式 keep:"all" 才保留历史思考（安卓 #1586）。 */
const KIMI_K2_6_RE = /(kimi[-._/]?|^)k[-._]?2[-._]6(?![0-9])/i;
/** K2.5 起（含 K2.6/K2.7/K3）temperature/top_p 等采样参数官方固定，明示"请勿显式
 *  传入"；安卓禁 K2.5/K2.6/K3/裸k3，按官方文档补 K2.7-code。 */
const KIMI_SAMPLING_LOCKED_RE = /(kimi[-._/]?|^)k[-._]?(3|2[-._][567])(?![0-9])/i;

export function isKimiK3Model(modelId: string): boolean {
  return KIMI_K3_RE.test(modelId);
}
export function isKimiK27Model(modelId: string): boolean {
  return KIMI_K2_7_RE.test(modelId);
}
export function isKimiK26Model(modelId: string): boolean {
  return KIMI_K2_6_RE.test(modelId);
}
export function isKimiSamplingLockedModel(modelId: string): boolean {
  return KIMI_SAMPLING_LOCKED_RE.test(modelId);
}

/** Kimi 推理代际(模型级事实):K2.5 起全系支持思考——K2.5/K2.6 开关型(thinking.type)、
 *  K2.7-code 常开、K3 effort 型。能力推断(inferModelAbilities)消费本谓词补 REASONING
 *  能力位;此前推断正则无任何 Kimi 模式,Kimi 模型能力位缺失 → UI 推理选项不显示、
 *  两引擎思考链路整条未激活(supportsAbility/model.reasoning 守卫全部短路)。
 *  与采样锁定谓词今天同值域(共用正则),但语义独立(思考能力 vs 采样参数),分开命名。 */
export function isKimiReasoningModel(modelId: string): boolean {
  return KIMI_SAMPLING_LOCKED_RE.test(modelId);
}

/** 方言事实：思考预算表(token)——安卓 ReasoningLevel 枚举对齐(含 MAX=32000)。
 *  消费面:聊天引擎 Google thinkingConfig.thinkingBudget、DashScope/火山 thinking_budget;
 *  工作区引擎经 model-bridge PI_THINKING_BUDGETS(四键推导)喂 pi 受控 settings,
 *  Google 2.x 预算通道两引擎同数值。未知档兜底 8000(安卓 else 分支同值)。 */
export const THINKING_BUDGET_BY_LEVEL: Readonly<Record<string, number>> = {
  off: 0,
  low: 1_000,
  medium: 2_000,
  high: 8_000,
  xhigh: 16_000,
  max: 32_000,
};

export function budgetTokensFor(level: string): number {
  return THINKING_BUDGET_BY_LEVEL[level] ?? 8_000;
}

/** 方言事实：输出上限的最终兜底(助手未设、方言无登记、模型目录也无可信输出上限时)。
 *  Anthropic 协议 max_tokens 必填,安卓对齐取 64000;聊天引擎 Claude 分支、辅助任务、
 *  工作区引擎 model-bridge 共用,禁止各处魔数。 */
export const DEFAULT_OUTPUT_TOKENS = 64_000;

// ===== 输出上限的方言登记表(模型级事实,一手文档实证)=====
// 为什么需要它:models.dev 是社区维护的聚合目录,对**输出上限**这个字段既有滞后
// (新模型未收录)也有错误(同名模型跨 213 个 provider 的 output 中位相差 2 倍、p90 28 倍,
// 15.6% 的行直接把 output 填成 context)。查表的自洽性校验(model-limits 的 usableLimit)
// 能挡掉"填成 context"那类,但挡不住"形状合法、数值就是错"的那类——那只能靠一手文档。
//
// **登记规程(新模型上限未知时的标准动作,勿凭印象填)**:
//   1. 查厂商官方 API 文档的模型页,拿到"最大输出 Tokens";只认厂商自己的文档,
//      聚合站/第三方转售页不算实证(它们本身就是目录数据的来源)。
//   2. 有真实 400 报文更好——严格端点会在报错里直接给出合法区间
//      (如智谱 `[1210][max_tokens参数非法：限制数值范围[1,131072]]`),这是最硬的证据。
//   3. 按**模型级正则**登记(与本文件 Kimi/GLM 代际谓词同哲学):同一模型经官方口、
//      中转站、云托管都是同一个上限,按 provider 逐个登记必然漏。
//   4. 注释里写清出处与日期;后续该模型的目录数据被社区修对了,本条目**不必删**——
//      它是我们核实过的权威值,存在的意义正是不随社区目录漂移。
//   5. 只登记"厂商公布了独立输出上限"的模型。像 Kimi 系官方明示"输入+输出合计不超过
//      上下文窗口"、不单独公布输出上限的,**不要编一个数**——让它落 DEFAULT_OUTPUT_TOKENS
//      兜底(恒小于窗口,安全),并由未登记告警持续提醒。
//
// 未登记且目录也查不到时,model-limits 会发一条 info 级 reportError(错误中心可见,
// 不打扰用户),这是"该去查文档了"的机械化信号——不依赖谁记得住。
export interface OutputLimitFact {
  /** 模型级判定(跨渠道成立)。 */
  match: (modelId: string) => boolean;
  /** 厂商公布的最大输出 tokens。 */
  cap: number;
  /** 出处:文档地址/报文原文 + 核实日期。 */
  source: string;
}

export const OUTPUT_LIMIT_FACTS: readonly OutputLimitFact[] = [
  {
    // 2026-09-09 用户实测报障的模型:智谱 Anthropic 兼容口发 1048576 被拒,
    // 报文直接给出合法区间。官方文档同口径,故此值有文档+报文双证。
    match: isZhipuGlm53Model,
    cap: 131_072,
    source:
      "docs.bigmodel.cn GLM-5.3 模型页「支持 1M 上下文窗口，最大输出 Tokens 为 128K」"
      + " + 上游报文 [1210][max_tokens参数非法：限制数值范围[1,131072]](2026-09-09 核实)",
  },
  // ===== 2026-09 新注册模型(对齐 APP 2.4.x/2.5.x)输出上限登记 =====
  // 全部一手官方文档实证;Gemini 3.5 Pro 未公布(2026-09 仍预览)**刻意不登记**——落
  // DEFAULT_OUTPUT_TOKENS 兜底 + output_limit_unknown 告警,待公布后再补(见头注规程 5)。
  {
    // OpenAI GPT-5.6 系(sol/terra/luna,别名 gpt-5.6)与 GPT-6 Astra:输出 128K,上下文 1.05M。
    // 用 gpt-5.6/gpt-6 token 判定,误伤面近乎零(gpt-5 精确匹配已在采样锁定单独处理)。
    match: (id) => /gpt[-._]?5[.-]6/i.test(id) || /gpt[-._]?6/i.test(id),
    cap: 128_000,
    source: "OpenAI 官方模型页(gpt-6-astra / gpt-5.6-sol/terra/luna)「Max output 128K · Context 1.05M」(2026-09-17 官方截图直证)",
  },
  {
    // Anthropic Claude Opus 4.8:同步 API 128K(Batch+beta 头可到 300K,取同步保守值)。
    match: (id) => /claude-opus-4[.-]8/i.test(id),
    cap: 128_000,
    source: "platform.claude.com/docs/en/models/opus-4-8/overview「Context 1M · Max output 128K」(2026-09-17 直抓)",
  },
  {
    // Google Gemini 3.5 Flash;Pro 未公布(2026-09 仍预览),只登记 Flash。
    match: (id) => /gemini-3[.-]5[.-]?flash/i.test(id) || /gemini-3[.-]5(?!.*pro)/i.test(id),
    cap: 65_536,
    source: "ai.google.dev/gemini-api/docs/models「Gemini 3.5 Flash Output token limit 65,536」(2026-09-17 直抓)",
  },
  {
    // DeepSeek V4.1 Flash / deepseek-flash:输出 384K(远高于 DEFAULT_OUTPUT_TOKENS,不登记会被钳小)。
    match: (id) => /deepseek.*(v[-._]?4[-._]?1|flash)/i.test(id) || /^deepseek-flash/i.test(id),
    cap: 384_000,
    source: "api-docs.deepseek.com/quick_start/pricing「MAXIMUM: 384K · Context 1M」(2026-09-17 直抓)",
  },
  {
    // 智谱 GLM-5.2(注意排除 5.3,后者上方已登记 128K):输出上限 128K。
    match: (id) => /glm-5\.2/i.test(id),
    cap: 131_072,
    source: "docs.z.ai/guides/llm/glm-5.2「Maximum supported max_tokens: 131,072」(2026-09-17 直抓)",
  },
  {
    // 月之暗面 Kimi K3(含裸 id k3):官方明示输出单独设上限,默认 131072 可配至满窗口。
    match: isKimiK3Model,
    cap: 131_072,
    source: "platform.kimi.com/docs/api/chat「此值为期望返回的 Token 长度,默认 131072」(2026-09-17 直抓)",
  },
  {
    // MiniMax M3:输出上限 512K(1M 上下文内保证最低 512K 输出)。
    match: (id) => /minimax[-._/]?m[-._]?3/i.test(id),
    cap: 512_000,
    source: "minimax.io/models/text/m3 + platform.minimax.io「max_tokens Max: 512000 · 1M context」(2026-09-17 直抓)",
  },
  {
    // 阶跃 Step 3.7 Flash:上下文与输出同 256K。
    match: (id) => /step[-._]?3[.-]7[.-]?flash/i.test(id),
    cap: 262_144,
    source: "help.aliyun.com/model-studio/step-3-7-flash「各上限统一 262,144」(2026-09-17 直抓)",
  },
  {
    // 美团 LongCat 2.0:官方 API 文档输出 128K(第三方平台口径不一,以官方为准)。
    match: (id) => /longcat[-._]?2/i.test(id),
    cap: 131_072,
    source: "longcat.chat 官方 API 文档「max output 128K · context 1M」(2026-09-17 直抓)",
  },
  {
    // 阿里 Qwen3.8-Max(含快照 qwen3.8-max-0902):输出 128K。
    match: (id) => /qwen[-._]?3[.-]8[.-]?max/i.test(id),
    cap: 131_072,
    source: "help.aliyun.com/zh/model-studio/qwen3-8-max「最大输出长度 131,072 · 上下文 1M」(2026-09-17 直抓)",
  },
];

/** 方言登记的输出上限;未登记返回 null(调用方继续查目录)。 */
export function registeredOutputLimit(modelId: string): number | null {
  for (const fact of OUTPUT_LIMIT_FACTS) {
    if (fact.match(modelId)) return fact.cap;
  }
  return null;
}

/** 档位归一化（方言事实：用户档位值域的入口收拢）——安卓对齐的大写枚举（AUTO/OFF/
 *  MINIMAL/…/MAX）统一小写，off/none 归并为 off。聊天引擎全部拼装分支、auxiliary、
 *  工作区引擎（model-bridge 的 pi 档位翻译）共用本函数，禁止各处自行 lowercase。 */
export function reasoningLevelNormalized(level: string | null | undefined) {
  const normalized = String(level ?? "").toLowerCase();
  return normalized === "off" || normalized === "none" ? "off" : normalized;
}

/** 方言事实：Kimi K3 的 effort 收拢表（官方移除 thinking，effort 是唯一强度入口，
 *  只认 low/high/max，默认 max，非法值 400）。聊天引擎拼入请求体、pi 经 model-bridge
 *  喂给 thinkingLevelMap（pi 运行时查同一张表）。off 语义：K3 无法关思考→聊天映 low、
 *  pi 标 null 隐藏 off 项。auto＝不发字段。
 *  注意：DeepSeek 已拆出独立表（官方 2026-09 文档 xhigh→high，与 K3 的 xhigh→max
 *  口径不同），勿再共用本表。 */
export const EFFORT_LOW_HIGH_MAX_BY_LEVEL = {
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
} as const;

/** 六档收拢查表；未知档位返回 undefined，由调用方决定兜底。 */
export function effortLowHighMaxFor(level: string): "low" | "high" | "max" | undefined {
  return (EFFORT_LOW_HIGH_MAX_BY_LEVEL as Record<string, "low" | "high" | "max">)[level];
}

/** 方言事实：DeepSeek v4 官方 effort 收拢表（2026-09 thinking_mode 文档明表：
 *  low→low、medium→high、high→high、xhigh→high、max→max；v4-flash 与 v4-pro 同表）。
 *  服务端自身也做同款收拢，客户端对齐官方口径以保证语义一致（此前与 K3 共用
 *  xhigh→max 表，会让 xhigh 用户实际获得比官方语义强一档的 max）。 */
export const DEEPSEEK_EFFORT_BY_LEVEL = {
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "high",
  max: "max",
} as const;

export function deepseekEffortFor(level: string): "low" | "high" | "max" | undefined {
  return (DEEPSEEK_EFFORT_BY_LEVEL as Record<string, "low" | "high" | "max">)[level];
}

/** 方言事实：智谱 GLM-5.3 的 effort 窄表（官方：仅收 max/high/low，其余值 400；
 *  收拢建议 none/minimal/low→low、medium/high→high、xhigh/max→max）。
 *  GLM-5.2 服务端收全七档并自行收拢（low/medium→high、xhigh→max），客户端原样
 *  透传即可，不查本表。 */
export const ZHIPU_GLM53_EFFORT_BY_LEVEL = {
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
} as const;

/** 方言事实：火山方舟 Doubao Seed 2.x 的 effort 表（官方：仅收 minimal/low/medium/
 *  high，minimal＝关思考，默认 medium；xhigh/max 收拢 high）。用户的 minimal 档映
 *  low 而非厂商 minimal：各家方言里 minimal＝"最少思考"而火山 minimal＝零思考，
 *  关思考的入口是 off 档（thinking:{type:"disabled"}），语义不混流。 */
export const ARK_SEED2_EFFORT_BY_LEVEL = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
} as const;

// ===== 思考强度的模型级谓词（方言单源：聊天引擎与各引擎桥接层共同消费）=====

/** 智谱 GLM-5.2 及以上支持 reasoning_effort（与 thinking.type 并发；5.1 及以下只认
 *  thinking 开关）。按版本号判定而非枚举：未来 GLM-5.4/6 默认放行。 */
export function isZhipuEffortModel(modelId: string): boolean {
  const m = /glm-(\d+)(?:\.(\d+))?/i.exec(modelId);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 2);
}

/** GLM-5.3 系（含 -flash）：effort 值域窄（仅 max/high/low），需查窄表收拢。 */
export function isZhipuGlm53Model(modelId: string): boolean {
  return /glm-5\.3/i.test(modelId);
}

/** 智谱强制思考型号（官方：GLM-5.3 系、GLM-4.7、GLM-4.5V 思考不可关，传
 *  thinking:{type:"disabled"} 直接 400）——off 档不得发 disabled。 */
export function isZhipuForcedThinkingModel(modelId: string): boolean {
  return /glm-5\.3/i.test(modelId) || /glm-4\.7/i.test(modelId) || /glm-4\.5v/i.test(modelId);
}

/** 火山方舟 Doubao Seed 2.x 及以上（doubao-seed-2-0-pro-260215 等）：支持
 *  reasoning_effort；老 doubao 系只认 thinking.type。 */
export function isArkSeed2Model(modelId: string): boolean {
  return /doubao-seed-[2-9]/i.test(modelId);
}

/** 小米 MiMo 官方主机(api.xiaomimimo.com 与订阅制 token-plan-cn 子域):思考开关走
 *  thinking:{type}(官方 OpenAI 兼容文档 mimo.mi.com/docs/zh-CN/api/chat/openai-api,
 *  安卓 ChatCompletionsAPI L354-360 同口径)。独立谓词与主机族写法,同 isOfficialOpenAiHost。 */
export function isMiMoOfficialHost(host: string): boolean {
  return host === "api.xiaomimimo.com" || host.endsWith(".xiaomimimo.com");
}

/** SiliconFlow 上支持 reasoning_effort 的托管模型（官方：DeepSeek-V4 系与
 *  Pro/zai-org/GLM-5.2；服务端自行收拢 low/medium→high、xhigh→max，客户端原样
 *  透传）。这些模型同时在 enable_thinking 白名单内，两字段并发。 */
export function isSiliconFlowEffortModel(modelId: string): boolean {
  return /deepseek-v4/i.test(modelId) || /glm-5\.2/i.test(modelId);
}

// ===== Gemini 3.x thinkingLevel 档位事实 =====
// 官方 thinking_level 值域按型号分裂（ai.google.dev「thinking」）：Pro 系仅认
// low/high（minimal 收 low、medium 收 high），非 Pro（3.5 Flash 等）全值域
// minimal/low/medium/high。口径逐值对齐 pi getThinkingLevel（含 [RIKKAHUB PATCH:
// budget-xhigh-max] 的 xhigh/max→high），两引擎恒同。off 不在表内：Gemini 3 思考
// 不可关，聊天引擎 off 时查 minimal 行取最少思考（pi 上游 off→high 为已知两引擎
// 差异，改动需扩 patch，暂记录不动）。
const GEMINI3_PRO_THINKING_LEVEL_BY_LEVEL = {
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "high",
  max: "high",
} as const;
const GEMINI3_THINKING_LEVEL_BY_LEVEL = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
} as const;

/** Gemini 3 Pro 系判定（正则对齐 pi isGemini3ProModel）。 */
export function isGemini3ProModel(modelId: string): boolean {
  return /gemini-3(?:\.\d+)?-pro/i.test(modelId);
}

/** 六档 → Gemini 3 thinking_level 官方值（按型号查对应表；未知档位保守收 high，
 *  与 pi 对未映射高档位的行为一致）。 */
export function gemini3ThinkingLevelFor(modelId: string, level: string): string {
  const table = isGemini3ProModel(modelId) ? GEMINI3_PRO_THINKING_LEVEL_BY_LEVEL : GEMINI3_THINKING_LEVEL_BY_LEVEL;
  return (table as Record<string, string>)[level] ?? "high";
}

// ===== OpenAI 兼容生态：厂商思考开关协议（host 级事实 + SiliconFlow 模型白名单）=====
// 聊天引擎 reasoningPayloadForProvider 的 host 分支是协议的「实现」（拼具体厂商字段），
// 本节是协议的「声明」——工作区引擎经 model-bridge 译成 pi compat 消费同一声明，
// 未来引擎的桥接层同理。分类依据＝聊天引擎逐厂商实证（安卓对齐、几十个版本验证）
// 与各厂官方文档；全面审查 7 的产物：此前工作区对智谱/DeepSeek 被 pi 探测强制发
// thinking:{type:"disabled"} 关思考、对 DashScope/火山/SiliconFlow 完全失控。

/** SiliconFlow 支持 enable_thinking 的模型白名单（跨引擎事实：对白名单外模型发
 *  enable_thinking 会 400，聊天引擎与工作区引擎必须同一份名单）。 */
export const SILICONFLOW_THINKING_MODELS: ReadonlySet<string> = new Set([
  "Pro/moonshotai/Kimi-K2.5",
  "Pro/zai-org/GLM-5",
  "Pro/zai-org/GLM-5.1",
  "Pro/zai-org/GLM-4.7",
  "deepseek-ai/DeepSeek-V3.2",
  "Pro/deepseek-ai/DeepSeek-V3.2",
  "Qwen/Qwen3.5-397B-A17B",
  "Qwen/Qwen3.5-122B-A10B",
  "Qwen/Qwen3.5-35B-A3B",
  "Qwen/Qwen3.5-27B",
  "Qwen/Qwen3.5-9B",
  "Qwen/Qwen3.5-4B",
  "zai-org/GLM-4.6",
  "Qwen/Qwen3-8B",
  "Qwen/Qwen3-14B",
  "Qwen/Qwen3-32B",
  "Qwen/Qwen3-30B-A3B",
  "Qwen/Qwen3-235B-A22B",
  "tencent/Hunyuan-A13B-Instruct",
  "zai-org/GLM-4.5V",
  "zai-org/GLM-4.6V",
  "zai-org/GLM-5V-Turbo",
  "deepseek-ai/DeepSeek-V3.1",
  "deepseek-ai/DeepSeek-V3.2-Exp",
  "deepseek-ai/DeepSeek-V3.1-Terminus",
  "Pro/deepseek-ai/DeepSeek-V3.1-Terminus",
  "deepseek-ai/DeepSeek-V4-Flash",
  "Pro/deepseek-ai/DeepSeek-V4-Flash",
  "deepseek-ai/DeepSeek-V4-Pro",
  "Pro/deepseek-ai/DeepSeek-V4-Pro",
]);

/** 厂商思考开关的上游协议种类：
 *  - enable-thinking-flag：顶层 enable_thinking: boolean（DashScope 全线、SiliconFlow
 *    白名单模型）。
 *  - thinking-type-object：thinking: { type: "enabled"|"disabled" }（火山方舟、智谱、
 *    DeepSeek 官方、Moonshot K2.5/K2.6；智谱另带 clear_thinking、DeepSeek 另带
 *    effort、K2.6 另带 keep——对象内差异由各引擎翻译层处理）。
 *  - thinking-mode-flag：顶层 thinking_mode: boolean（书生浦语专用；聊天引擎已实现，
 *    pi 无对应旋钮→工作区压制思考字段，模型走默认行为）。
 *  - reasoning-effort：OpenAI 原生顶层 reasoning_effort（官方/Kimi K3/混元/阶跃/各类
 *    中转兜底）。
 *  - suppress：不发任何思考开关（SiliconFlow 白名单外模型；Moonshot K2.7-code 始终
 *    思考、开关字段被拒收）。 */
export type OpenAiThinkingSwitchProtocol =
  | "enable-thinking-flag"
  | "thinking-type-object"
  | "thinking-mode-flag"
  | "reasoning-effort"
  | "suppress";

export function openAiThinkingSwitchProtocol(host: string, modelId: string): OpenAiThinkingSwitchProtocol {
  if (host === "dashscope.aliyuncs.com") return "enable-thinking-flag";
  if (host === "api.siliconflow.cn") {
    return SILICONFLOW_THINKING_MODELS.has(modelId) ? "enable-thinking-flag" : "suppress";
  }
  if (host === "ark.cn-beijing.volces.com" || host === "open.bigmodel.cn" || host === "api.deepseek.com") {
    return "thinking-type-object";
  }
  // 小米 MiMo 官方:thinking:{type} 开关(对象内无 effort/keep 差异,落各引擎翻译层的
  // 通用 thinking-type-object 兜底,与 Moonshot K2.5/火山老系同路径)。
  if (isMiMoOfficialHost(host)) return "thinking-type-object";
  if (host === "api.moonshot.cn") {
    if (isKimiK3Model(modelId)) return "reasoning-effort"; // K3 移除 thinking,唯一强度入口
    if (isKimiK27Model(modelId)) return "suppress"; // 始终思考,开关字段拒收
    return "thinking-type-object"; // K2.6/K2.5/kimi-latest
  }
  if (host === "chat.intern-ai.org.cn") return "thinking-mode-flag";
  return "reasoning-effort";
}

// ===== 采样参数锁定（模型级事实，跨引擎）=====

/** 方言事实：temperature/top_p 等采样参数被官方锁定的模型族——o 系推理模型与精确
 *  "gpt-5"（temperature≠1 直接 400；gpt-5.1+ 官方恢复可调，安卓同语义放行）、
 *  Kimi K2.5+（固定值，官方明示"请勿显式传入"）。
 *  消费面：聊天引擎 isModelAllowTemperature（orchestrator 主对话 + auxiliary 的
 *  temperature 与 top_p）；工作区引擎当前不发任何采样参数（runner 不传，pi 仅在
 *  显式传入时才发），接通助手温度设置时必须消费本谓词，禁止另起判定。 */
export function isSamplingLockedModel(modelId: string): boolean {
  return /(^o\d|[/:_-]o\d)/i.test(modelId) || /^gpt[-._]?5$/i.test(modelId) || isKimiSamplingLockedModel(modelId);
}
