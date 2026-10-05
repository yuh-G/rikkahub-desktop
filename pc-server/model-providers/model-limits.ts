// model-providers/model-limits.ts — 模型极限(上下文窗口 / 输出上限)的目录解析单源
//
// 背景(2026-09-09 报障:智谱 GLM-5.3 对话与工作区两模式同炸
// `[1210][max_tokens参数非法：限制数值范围[1,131072]]`):models.dev 目录原本只喂
// "统计行分母"一个消费者——查错了只是分母略偏,前端还能降级只显示分子。P5 起它成了
// **出站请求字段**的来源(Anthropic 协议 max_tokens 必填、pi 引擎恒发上限),同一份
// "尽力猜"的查表逻辑从此决定请求成败:猜大一档就是硬 400。
//
// 旧查表的两处不安全(本机实测目录数据,非推测):
//   ① 按名字搜全目录:213 个目录 provider 逐个试,命中顺序即 JSON 键序。同名模型的
//      **输出上限**跨 provider 离散极大(同名 622 组:中位 2.00 倍、p90 28 倍、最大
//      244 倍),而上下文窗口很稳(中位 1.02 倍)——这正是缺陷长期潜伏的原因:原消费者
//      只用窗口,恰好是那个宽容的字段。
//   ② 不校验自洽:目录 15.6%(1181/7562)的行 output == context,另有 70 行
//      output > context,这类行是"未知/占位"而非真实上限。本次报障的直接触发物即
//      digitalocean 的 glm-5.3 行 {context:1048576, output:1048576} 被名字搜中,
//      两引擎据此发出 1048576 / 1041128(后者是 pi 又减了估算 prompt 与安全垫)。
//
// 三条纪律:
//   一、按**端点身份**取值,不按名字猜(resolveCatalogKeys 的三级阶梯)。
//   二、输出上限必须自洽:output < context,占位行一律丢弃。
//   三、同 host 命中多个目录 provider 时取**最小**:偏小只是答案被截短(可感知的退化),
//       偏大是整个请求被拒(功能不可用),两个方向的代价不对等。
//
// 另一条同源纪律写在 outboundMaxTokens 头注:协议不要求上限时**根本不发这个字段**。

import type { Provider } from "../foundation/types";
// hostOfProvider 是 baseUrl → hostname 的纯函数,与 model-providers/index.ts 同向借用
// (不复制一份:"端点身份从哪来"必须全仓库一个答案,含 providerOverwrite 展开后的 baseUrl)。
import { hostOfProvider } from "../inference-engine/message-builder";
import { reportError } from "../observability/app-errors";
import { DEFAULT_OUTPUT_TOKENS, isOfficialOpenAiHost, registeredOutputLimit } from "./request-dialect";

/** models.dev api.json 的最小结构视图(只取我们用到的两层)。model 行的
 *  `name` 是官方显示名(display-names.ts 消费),`limit` 是上下文/输出上限
 *  (本模块消费)——同一份目录,两个消费者,字段都按需声明为可选。 */
export type ModelCatalog = Record<
  string,
  {
    api?: string;
    models?: Record<
      string,
      { name?: string; limit?: { context?: number; output?: number } } | undefined
    >;
  } | undefined
>;

export type LimitField = "context" | "output";

/** 一线厂商的目录键——**自训模型的权威上限出处**。中转站(type=openai + 陌生 baseUrl)
 *  转发的就是这些厂商的模型,拿原厂上限比拿某个不知名转售商的占位值近真。
 *  收录门槛:该键在 models.dev 里代表"模型的生产者或其官方云",不含聚合网关
 *  (openrouter/llmgateway/302ai…)——网关自填的上限精度最低,正是①要躲开的东西。
 *  没有 api 字段的键(openai/anthropic/google/azure/bedrock/xai/mistral/cohere/
 *  perplexity)只能经本表或 officialCatalogKeys 命中,故必须列全。 */
const FIRST_PARTY_CATALOG_KEYS: readonly string[] = [
  "openai",
  "azure",
  "anthropic",
  "google",
  "google-vertex",
  "amazon-bedrock",
  "xai",
  "mistral",
  "cohere",
  "perplexity",
  "meta",
  "llama",
  "deepseek",
  "zhipuai",
  "zhipuai-coding-plan",
  "zai",
  "zai-coding-plan",
  "moonshotai",
  "moonshotai-cn",
  "alibaba",
  "alibaba-cn",
  "volcengine",
  "siliconflow",
  "siliconflow-cn",
  "stepfun",
  "stepfun-ai",
  "minimax",
  "minimax-cn",
  "tencent-coding-plan",
  // 腾讯 MaaS 聚合平台 TokenHub(混元 API 2026-10 迁入,出厂 baseUrl 所指):其目录行
  // 是混元官方口径(hy3/hy4 系),老 hunyuan 域名无目录键。
  "tencent-tokenhub",
  "nvidia",
  "modelscope",
  "sensenova",
  "upstage",
  "inception",
  "lmstudio",
];

/** 官方主机 → 目录键。这几家在 models.dev 里**没有 api 字段**(端点由 SDK 内建),
 *  host 索引接不住,只能显式登记。判定与请求方言的 isOfficialOpenAiHost 共用,
 *  避免两处各写一份"什么算官方口"。 */
function officialCatalogKeys(host: string): string[] {
  if (host === "api.anthropic.com") return ["anthropic"];
  if (isOfficialOpenAiHost(host)) return host === "api.openai.com" ? ["openai"] : ["azure"];
  if (host === "generativelanguage.googleapis.com") return ["google"];
  return [];
}

// host → 目录键的索引。目录对象同一进程内是同一引用(modelsDevCache 整体替换),
// 用 WeakMap 按引用缓存:目录换了自然失效,不需要手工清。
const hostIndexCache = new WeakMap<object, Map<string, string[]>>();

function hostIndexOf(catalog: ModelCatalog): Map<string, string[]> {
  const cached = hostIndexCache.get(catalog as object);
  if (cached) return cached;
  const index = new Map<string, string[]>();
  for (const [key, entry] of Object.entries(catalog)) {
    const api = entry?.api;
    if (!api) continue;
    let host: string;
    try {
      host = new URL(api).hostname;
    } catch {
      continue; // 目录里的畸形 api 字段:跳过即可,不影响其余键。
    }
    const bucket = index.get(host);
    if (bucket) bucket.push(key);
    else index.set(host, [key]);
  }
  hostIndexCache.set(catalog as object, index);
  return index;
}

/** 端点身份 → 候选目录键,三级阶梯,**先命中先用,不合并**:
 *   ① host 精确等于某目录 provider 的 api 主机 → 就是它(智谱/DeepSeek/DashScope/
 *      火山/SiliconFlow/OpenRouter…;同 host 多键如 zhipuai + zhipuai-coding-plan
 *      一并返回,由取值层取 min);
 *   ② 官方主机白名单(目录无 api 字段的几家);
 *   ③ 都不认(自建/中转/未知网关)→ 一线厂商全集,只按模型名在**原厂**里找。
 *  第③级是"退一步而非乱猜":中转站转发的确实是原厂模型,原厂上限是可辩护的近似;
 *  而在 213 个目录里按名字撞第一个,撞到的往往是转售商的占位行(本次报障即此)。 */
export function resolveCatalogKeys(catalog: ModelCatalog, host: string): string[] {
  const byHost = host ? hostIndexOf(catalog).get(host) : undefined;
  if (byHost?.length) return byHost;
  const official = officialCatalogKeys(host).filter((key) => catalog[key]);
  if (official.length) return official;
  return FIRST_PARTY_CATALOG_KEYS.filter((key) => catalog[key]);
}

/** 一个目录 provider 内的行匹配,分两层返回:精确 id / 版本后缀前缀
 *  (`claude-3-5-sonnet` → `claude-3-5-sonnet-20241022`,目录常带日期而用户填简称)。
 *  分层是必须的:精确行存在时绝不能让后缀行参与 min——`gpt-5` 精确 128000,而
 *  `gpt-5.2-chat-latest` 等后缀行只有 16384,混在一起取 min 会把 gpt-5 砍到 1/8。
 *  `-` 与 `.` 双锚点防 `gpt-4` 误吞 `gpt-4o`。 */
function limitRowTiers(
  models: NonNullable<ModelCatalog[string]>["models"],
  modelId: string,
): [Array<{ context?: number; output?: number }>, Array<{ context?: number; output?: number }>] {
  if (!models) return [[], []];
  const exact: Array<{ context?: number; output?: number }> = [];
  const prefixed: Array<{ context?: number; output?: number }> = [];
  const own = models[modelId]?.limit;
  if (own) exact.push(own);
  for (const key of Object.keys(models)) {
    if (key === modelId) continue;
    if (!key.startsWith(`${modelId}-`) && !key.startsWith(`${modelId}.`)) continue;
    const limit = models[key]?.limit;
    if (limit) prefixed.push(limit);
  }
  return [exact, prefixed];
}

/** 取一行的目标字段,顺带把不可信的值挡掉。返回 null = 这行对该字段不可用。
 *
 *  output 的自洽性检查(`output < context`)是本模块的核心防线:目录里 15.6% 的行
 *  output == context,它们表达的是"未知/未填",当真会直接把窗口尺寸当输出上限发出去。
 *  context 字段不做此检查——它就是窗口本身,没有可比的上界。 */
function usableLimit(limit: { context?: number; output?: number }, field: LimitField): number | null {
  const value = limit[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (field === "output") {
    const context = limit.context;
    if (typeof context === "number" && context > 0 && value >= context) return null;
  }
  return value;
}

/** 按端点身份查模型极限。查不到返回 null(调用方决定兜底/降级)。
 *  同层多值取 min——见文件头注纪律三。 */
export function lookupModelLimit(
  catalog: ModelCatalog | null,
  host: string,
  modelId: string,
  field: LimitField,
): number | null {
  if (!catalog || !modelId) return null;
  const keys = resolveCatalogKeys(catalog, host);
  if (!keys.length) return null;
  for (const tier of [0, 1] as const) {
    let best: number | null = null;
    for (const key of keys) {
      for (const limit of limitRowTiers(catalog[key]?.models, modelId)[tier]) {
        const value = usableLimit(limit, field);
        if (value != null && (best == null || value < best)) best = value;
      }
    }
    if (best != null) return best;
  }
  return null;
}

/** 上下文窗口(统计行分母 + pi 自动压缩阈值)。查不到 null。 */
export function contextWindowFor(catalog: ModelCatalog | null, provider: Provider, modelId: string): number | null {
  return lookupModelLimit(catalog, hostOfProvider(provider), modelId, "context");
}

/** 模型真实输出上限。**方言登记优先于目录**——登记表是一手文档实证,目录是社区聚合
 *  (对输出上限既滞后又常错,见 request-dialect 的 OUTPUT_LIMIT_FACTS 头注)。
 *  两者都没有时返回 null(**不要**在这里兜底——兜底是 requiredOutputCap 的事,
 *  区分"我们知道"与"我们猜的"对调用方是有意义的信息)。 */
export function outputLimitFor(catalog: ModelCatalog | null, provider: Provider, modelId: string): number | null {
  const registered = registeredOutputLimit(modelId);
  if (registered != null) return registered;
  return lookupModelLimit(catalog, hostOfProvider(provider), modelId, "output");
}

/** 协议必填上限口的唯一取值(Anthropic 的 max_tokens 必填;pi 模型配置也要求给数)。
 *  三级:助手显式配置 > 目录真实上限 > 方言兜底 DEFAULT_OUTPUT_TOKENS,再收进窗口内。
 *
 *  两条刻意的不作为:
 *  ① **不钳用户显式配置**。用户把上限填过大导致 400,正确的产品行为是给可行动报错
 *     (provider-errors 的 classifyOutputCapError),不是静默改小他的设置——目录可能
 *     偏低,静默截短答案是更难察觉的伤害。同哲学:代理死就报错,不擅自降级。
 *  ② 上限**可选**的协议(OpenAI completions/responses、Google)在用户未配置时**根本不发
 *     这个字段**,不在这里凭目录补一个:不发 = 用服务端默认 = 恒合法,而发一个猜来的数
 *     就是本次报障的形态。安卓同语义(`if (params.maxTokens != null) put(...)`)。
 *     故本函数只服务"协议逼我必须给一个数"的场合。 */
export function requiredOutputCap(
  catalog: ModelCatalog | null,
  provider: Provider,
  modelId: string,
  assistantMaxTokens: number | null | undefined,
): number {
  if (typeof assistantMaxTokens === "number" && assistantMaxTokens > 0) return assistantMaxTokens;
  const known = outputLimitFor(catalog, provider, modelId);
  if (known == null) {
    // 未知上限:用兜底值(恒小于任何现役模型的窗口,发出去是安全的),但**留痕**——
    // info 级只进错误中心、不打扰用户,却是"该去查这个模型的官方文档并登记进
    // OUTPUT_LIMIT_FACTS 了"的机械化信号。不依赖任何人记得住。
    // 未加载目录时不报(启动窗口期的临时空缓存不是"未知模型")。
    if (catalog) {
      reportError(
        "provider",
        "info",
        `模型 ${modelId} 的最大输出上限未知(方言登记表与 models.dev 目录均无可信值),已按兜底 ${DEFAULT_OUTPUT_TOKENS} 发送`,
        undefined,
        "output_limit_unknown",
        { model: modelId, fallback: DEFAULT_OUTPUT_TOKENS },
      );
    }
    return DEFAULT_OUTPUT_TOKENS;
  }
  const window = contextWindowFor(catalog, provider, modelId);
  return window != null && window > 0 ? Math.min(known, window) : known;
}

/** 我们自己为内部任务定的上限(OCR 2048、提示词优化 4096、服务商连通性测试 4096…)。
 *  与 requiredOutputCap 的关键区别:这些数字**不是用户的选择**,只是"这个任务大概需要
 *  这么多",所以必须收进模型真实上限内 —— 目录里存在输出上限低于我们常数的现役对话
 *  模型(如 cohere command-r 系 4000 < 4096),硬发我们的常数就是自找 400,而用户完全
 *  没做错什么。目录查不到时原样用我们的数(保持既有行为)。 */
export function internalOutputCap(
  catalog: ModelCatalog | null,
  provider: Provider,
  modelId: string,
  desired: number,
): number {
  const cap = outputLimitFor(catalog, provider, modelId);
  return cap != null && cap < desired ? cap : desired;
}
