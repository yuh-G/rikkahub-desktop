// model-providers/model-name-heuristic.ts — 模型显示名的启发式规整(渲染兜底层)
//
// 分层契约「确定性第一印象 + 静默权威校正」:
//   第一帧的规整名由本模块给出——纯本地同步函数,微秒级,任何模型名在界面首次
//   出现前就已规整。models.dev 官方名随后在后台静默落库替换(display-names.ts),
//   两者由 isUnclaimedModelDisplayName 的「未认领」信号隔开:display.ts(渲染)与
//   display-names.ts(落库)共用同一把尺。**启发式永不落库**——落库的只有三种真值
//   (上游接口名 / models.dev 官方名 / 用户手改名),启发式一旦落库就与用户手改名
//   不可区分,官方目录日后收录也无法升级。
//
// 规则流水线(2026-09-29 对照 models.dev 全量 8279 行审计逐条校准,取舍依据见
// 各常量注释;验收用例在 model-name-heuristic.test.ts):
//   斜杠取本地段 → 厂商点前缀剥离 → 部署尾巴剥离 → 分词 →
//   token 规整(噪音/品牌/缩写/尺寸大小写) → 品牌连字粘连 → 版本对点号化 → 连字词对
//
// 启发式的先天边界(审计实证,官方名层的存在理由):营销版本映射(mistral-medium-2505
// → "Mistral Medium 3")、昵称改写(gemini-*-image → "Nano Banana")、按端点加品牌
// 前缀(sonar-* → "Perplexity Sonar *")、区域括注((US)/(EU))——这些是映射表知识,
// 纯字符串运算不可得。
//
// 纪律:本模块必须保持零 import、纯字符串运算——web-ui 经 `@server` 直接引用它
// (先例:origin-relay.ts),引入任何 node/bun 内置都会让前端打包炸掉。

/** 品牌词 → 官方大小写。覆盖名字开头常见厂商;未命中走通用分段规则。
 *  值的形式:① 保留连字符的("GPT-")——与紧随的数字开头段粘连(GPT-5.4/GPT-4o),
 *  纯字母段(gpt-oss)则摘掉尾巴按普通词处理;② 无连字符的("Claude")——首字母
 *  大写。官方写法逐一核对 models.dev(2026-09-29)。 */
const BRAND_WORDS: Record<string, string> = {
  gpt: "GPT-",
  glm: "GLM-",
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  grok: "Grok",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  qwen: "Qwen",
  qwq: "QwQ",
  qvq: "QVQ",
  minimax: "MiniMax",
  hunyuan: "Hunyuan",
  hy: "Hunyuan",
  doubao: "Doubao",
  step: "Step",
  mimo: "MiMo",
  longcat: "LongCat",
  muse: "Muse",
  llama: "Llama",
  veo: "Veo",
  mistral: "Mistral",
  mixtral: "Mixtral",
  command: "Command",
  sonar: "Sonar",
  perplexity: "Perplexity",
  ollama: "Ollama",
  viking: "Viking",
  ling: "Ling",
  nanook: "Nanook",
  inkling: "Inkling",
  seed: "Seed",
  nemotron: "Nemotron",
  hunyuanimage: "HunyuanImage",
  stable: "Stable",
};

/** 「品牌+X」缩写变体:产品线的 X 后缀官方恒大写(glm-5.3-flashx → "FlashX"。
 *  目录全量实证无一例外(flashx×20/airx×3/tensorx×4);max/codex/flux/flex 是
 *  完整单词,x 属于词本身,不在此列。 */
const X_SUFFIX_WORDS: Record<string, string> = {
  flashx: "FlashX",
  airx: "AirX",
  tensorx: "TensorX",
};

/** 品牌+数字官方恒空格的家族(llama4 → "Llama 4"、veo3.1 → "Veo 3.1");其余家族
 *  官方恒粘连(qwen3 → "Qwen3.5" / glm5 → "GLM-5V" / k2 → "K2.7")。空格/粘连是
 *  各家排版惯例,无统一规则可推导,逐一登记。 */
const SPACE_SEPARATED_BRAND_NUMBERS = new Set(["llama", "veo"]);

/** 全大写缩写词:官方唯一写法就是全大写的普通词(qwen3-vl → "VL"、gemma-*-it →
 *  "IT"、gpt-oss → "OSS")。频次取自目录全量统计(VL×115 / IT×100 / OSS×130)。 */
const ACRONYM_TOKENS: Record<string, string> = {
  vl: "VL",
  it: "IT",
  oss: "OSS",
  tts: "TTS",
  asr: "ASR",
  ernie: "ERNIE",
  flux: "FLUX",
};

/** 部署噪音词:厂商的部署/转售标记,官方名从不保留(ga=General Availability,
 *  火山引擎 deepseek-v4-pro-ga-260813 → "DeepSeek V4 Pro 0813";maas=Vertex 的
// Model-as-a-Service 后缀;c4ai/labs=Cohere/Mistral 内部前缀;zai=Mistral 转售
// GLM 的厂商前缀)。 */
const NOISE_TOKENS = new Set(["ga", "maas", "zai", "c4ai", "labs"]);

/** 相邻词对官方写作连字符(multi-agent / flash-lite),其余默认空格分词。
 *  flash-lite 是 Gemini 家族惯例("Gemini 2.5 Flash-Lite"),computer-use 等官方
 *  反而用空格,不进表。 */
const JOINED_TOKEN_PAIRS: Record<string, string> = {
  "multi-agent": "Multi-Agent",
  "non-reasoning": "Non-Reasoning",
  "flash-lite": "Flash-Lite",
};

/** 全 id 特表:id 本身不含任何家族线索、但形态固定且高频的。对齐 pi 目录官方名
 *  (kimi-coding.json:k3 → "Kimi K3"、k3-256k → "Kimi K3-256K"——256K 的连字符
 *  是官方写法,词对规则得不出来)。chatgpt-image 是 OpenAI 图像系的别扭命名
 *  (chatgpt 前缀 + latest 指针,官方目录自己都抄 id),按家族真实产品名收口。 */
const EXACT_ID_OVERRIDES: Record<string, string> = {
  k3: "Kimi K3",
  "k3-256k": "Kimi K3-256K",
  "chatgpt-image-latest": "GPT-Image",
};

/** 首段即「k + 数字(.数字)」的裸版本段 id:月之暗面端点的裸家族段(不带 kimi-
 *  前缀)。现役模型里该形态只此一家;保守起见只认「整段就是 k+版本号」。 */
const KIMI_BARE_VERSION = /^k\d+(\.\d+)?$/i;

/** OpenAI o 系列(o3-mini/o1-pro)官方刻意全小写连字,整条 id 照抄。首字母大写
 *  规则会把它弄成 "O3 Mini",而官方名就是 "o3-mini"。 */
const OPENAI_O_SERIES = /^o\d{1,2}([-_\s]|$)/;

/** 紧跟品牌段的官方小写词:OpenAI 家族 mini 恒小写(GPT-5.4 mini / GPT-4o mini)。
 *  其余家族官方大写(Doubao Seed Mini / North Mini Code / Seed 2.0 Mini),所以
 *  只认 GPT- 连字系与 o 系前驱,不做全局小写。 */
const LOWERCASE_AFTER_BRAND_PREFIX = /^(GPT-|o\d)/;

/** 版本对点号化的左段形态:纯 1-2 位数字(claude-4-6 的 "4"),或字母前缀段
 *  (kimi-k2-7 的 "K2"、glm-5-3 的 "GLM-5"、qwen3-5 的 "Qwen3")。纯数字限 1-2
 *  位是年份保护(2025-10 的 2025 不匹配)。 */
const DOT_MERGE_LEFT = /^(?:[A-Za-z]+-?)?\d{1,2}(\.\d+)?$/;

/** 版本对点号化的右段:1-2 位数字;"0" 允许(seed-2-0 → 2.0),两位 0 前导
 *  (05/08,cohere 与 google 的日期月)不匹配。 */
const DOT_MERGE_RIGHT = /^(0|[1-9]\d?)$/;

/** Bedrock/Vertex 的「区域.厂商.」前缀(us.meta.llama4… / eu.amazon.… / mistral.voxtral…):
 *  逐段剥纯小写字母段——大写开头不匹配,FLUX.2-klein… 天然幸免;且要求点后剩余
 *  以小写字母开头:flux.1-dev / laguna-m.1 这类「产品名本体含点、点后是数字」的
 *  id 不是部署前缀(官方名原样保留 FLUX.1-dev / Laguna M.1),voxtral/kimi/palmyra
 *  这类新段才是 model 名本体。含数字的段天然不匹配(gpt-5.4 的 5 在点号前)。
 *  例外:剩余以「单字母+版本号」开头(v3/m2/r1)时品牌本体就在前缀里(bedrock
 *  deepseek.v3.2 官方名是 "DeepSeek V3.2",不是 "V3.2"),保留前缀末段接回。 */
function stripVendorDotPrefixes(localPart: string): string {
  let s = localPart;
  for (;;) {
    const m = s.match(/^([a-z]+(?:-[a-z]+)*)\./);
    if (!m) break;
    const rest = s.slice(m[0].length);
    if (!/^[a-z]/.test(rest)) break;
    if (/^[a-z]\d+(\.\d+)?([-_]|$)/.test(rest)) return `${m[1]}-${rest}`;
    s = rest;
  }
  return s;
}

/** 部署尾巴剥离。每条都经目录一线厂商全量核对:官方名从不保留这些尾巴(唯一
 *  保留方是懒名第三方网关,懒名行走渲染层启发式,不受影响)。
 *  -@尾:Vertex 路由后缀(claude-opus-4-8@default / @20250929);
 *  -latest:指针别名(openai/mistral 惯例,官方名的 "(latest)" 括注同被剥离;
 *      google/azure 少数行保留 "Latest" 一词,由官方名层接管,不在此纠结)。
 *      例外:剥后只剩裸品牌词时不剥——"Kimi" "GLM" 毫无信息量,连字保留
 *      "Kimi-Latest"(用户拍板 2026-09-29)反可区分;
 *  -8 位日期:anthropic 别名行(claude-opus-4-5-20251101 → "Claude Opus 4.5");
 *  -YYYY-MM-DD:快照日期(gpt-4o-2024-05-13 → "GPT-4o",用户拍板 2026-09-29;
 *      目录 36 行的主流形态是 "(date)" 括注——启发式产不出括注,剥出基名是
 *      到括注形态的最短距离,官方名层随后补全);
 *  -6 位日期:火山引擎系(doubao-seed-1-6-251015 → "Seed 1.6");
 *  -MM-YYYY:cohere 惯例(command-a-03-2025 → "Command A";google 的
 *      preview-10-2025 行官方保留日期,但那几行本就因括注差异不可能精确,取舍
 *      从众);
 *  -v?\d+:\d+:bedrock 版本尾(llama4-…-v1:0 / gpt-oss-…-1:0,官方名不带;全目录
 *      73 行冒号尾无一保留)。裸 -v\d 刻意不剥:官方去留不一(DeepSeek-V3 /
 *      Nemotron-v2 / whisper-v3 都保留),无可靠规则。ollama 的 llama3.3:70b 冒号
 *      后非纯数字,天然不匹配。
 *  4 位尾巴(2507/0731/0528)刻意不剥:官方去留不一(voxtral 2507 保留、
 *  deepseek 0731 保留、qwen instruct-2507 丢弃),无可靠规则。 */
function stripDeploySuffixes(localPart: string): string {
  // 冒号规格段(ollama 形态 llama3.3:70b):冒号是「家族:参数量」分隔,等同连字符
  // 处理,否则 70b 会带着冒号一起逃过分词。Bedrock 的 -v1:0 部署尾另在后面剥。
  let s = localPart.replace(/:(\d+[a-z]+)$/i, "-$1");
  if (/-latest$/i.test(s)) {
    const base = s.slice(0, -"-latest".length);
    // 剥后只剩裸品牌词(无连字符/数字) → 不剥,kimi-latest 保持连字
    if (/-|\d/.test(base)) s = base;
  }
  return s
    .replace(/@[\w.-]+$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{6}$/, "")
    .replace(/-\d{2}-\d{4}$/, "")
    .replace(/-v?\d+:\d+$/i, "");
}

/** 单个 token 的规整。返回值即产出词;噪音词在主循环里先行丢弃。
 *  prev 带上一个已产出词,用于 mini 小写判定。含大写的输入 token 原样返回
 *  (K2.7/A3B/Hy4 已是规整形态,二次加工会破坏幂等)。 */
function prettifyToken(token: string, prev: string | undefined): string {
  const lower = token.toLowerCase();
  if (BRAND_WORDS[lower]) return BRAND_WORDS[lower];
  if (ACRONYM_TOKENS[lower]) return ACRONYM_TOKENS[lower];
  if (X_SUFFIX_WORDS[lower]) return X_SUFFIX_WORDS[lower]; // flashx/airx/tensorx → FlashX/AirX/TensorX
  const dotted = token.match(/^([a-z]+)\.(\d+(?:\.\d+)?)$/);
  if (dotted && ACRONYM_TOKENS[dotted[1]]) return `${ACRONYM_TOKENS[dotted[1]]}.${dotted[2]}`; // flux.1-dev 剥尾后剩 "flux.1" → FLUX.1
  if (/^\d+(\.\d+)*$/.test(token)) return token; // 5 / 5.4 / 20251001 / 0711
  if (token !== lower) return token; // 已含大写:不二次加工
  if (token === "4o") return token; // GPT-4o 家族的 o 恒小写,其余数字尾字母都大写
  let m = token.match(/^(\d+)x(\d+)([a-z]*)$/);
  if (m) return `${m[1]}x${m[2]}${m[3].toUpperCase()}`; // 8x7b → 8x7B(乘号 x 保持小写)
  m = token.match(/^(\d+(?:\.\d+)?)([a-z]+)$/);
  if (m) return `${m[1]}${m[2].toUpperCase()}`; // 17b/256k/5v/128e → 17B/256K/5V/128E
  m = token.match(/^([a-z]+)(\d+(?:\.\d+)?)([a-z]*)$/);
  if (m) {
    const brand = BRAND_WORDS[m[1]] ?? (m[1][0].toUpperCase() + m[1].slice(1));
    const sep = SPACE_SEPARATED_BRAND_NUMBERS.has(m[1]) ? " " : "";
    return `${brand}${sep}${m[2]}${m[3].toUpperCase()}`; // k2/a3b/r7b/hy4 → K2/A3B/R7B/Hy4;llama4/veo3.1 → Llama 4/Veo 3.1
  }
  if (token === "mini" && prev !== undefined && LOWERCASE_AFTER_BRAND_PREFIX.test(prev)) {
    return "mini";
  }
  if (/^[a-z]/.test(token)) return token.slice(0, 1).toUpperCase() + token.slice(1);
  return token;
}

/** 「未认领」信号:displayName 为空或与 modelId 相等。这是官方名唯一允许写入的
 *  门,也是渲染层决定是否走启发式的同一把尺(display.ts 与 display-names.ts 共
 *  用,两处口径必须一致——否则会出现「落库层认为已认领、渲染层却拿启发式覆盖」
 *  的错位)。放在本模块(零依赖纯函数)以便前后端共享。 */
export function isUnclaimedModelDisplayName(
  displayName: string | null | undefined,
  modelId: string | null | undefined,
): boolean {
  const display = String(displayName ?? "").trim();
  if (!display) return true; // 退化数据:视同未认领,允许补名
  return display === String(modelId ?? "").trim();
}

/** 模型 id → 规整显示名。纯函数,幂等;空输入返回空串。 */
export function prettifyModelId(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) return trimmed;
  if (EXACT_ID_OVERRIDES[trimmed]) return EXACT_ID_OVERRIDES[trimmed];
  if (OPENAI_O_SERIES.test(trimmed)) return trimmed;

  // 中转站前缀(vendor/model 或 org/model):只规整斜杠后的本地段,前缀整段丢弃
  // (models.dev 官方名同样不带 vendor 前缀:meta-llama/Llama-4-Scout… → Llama 4 Scout)。
  const localPart = trimmed.includes("/") ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : trimmed;
  const cleaned = stripDeploySuffixes(stripVendorDotPrefixes(localPart));
  // 词边界:连字符/下划线/空格。空格虽非合法 id 字符,但用户手填的 id 与上游目录
  // 偶有带空格形态(如月之暗面 "K2.7 Coding")。**点号不是边界**——它是版本号的
  // 一部分(5.4 / K2.7 / GLM-4.7),切开会把 GPT-5.4 弄成 GPT-5 4。
  const tokens = cleaned.split(/[-_\s]+/).filter(Boolean);

  const words: string[] = [];
  // 连字系品牌(GPT-/GLM-)与紧随段的粘连状态:下一段以数字开头则拼进上一词
  // (GPT- + 5.4 → GPT-5.4、GLM- + 5V → GLM-5V),纯字母段(gpt-oss 的 oss)则
  // 摘掉上一词的连字尾巴(GPT- → GPT),否则会出现 "GPT- Oss" 这种残缺形态。
  let danglingBrandTail = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const lower = token.toLowerCase();
    if (NOISE_TOKENS.has(lower)) continue;
    // 0\d{3} 是部署日期(月中日,grok-4.20-0309-reasoning),官方丢弃;尾位刻意
    // 保留——官方惯例留版本尾(gpt-3.5-turbo-0125 / kimi-…-0711)。
    if (i < tokens.length - 1 && /^0\d{3}$/.test(token)) continue;
    // doubao-seed 是复合品牌(豆包 Seed),官方 "Doubao Seed 2.0 Pro";逐词处理
    // 会产生 "Doubao Seed Seed 1.6" 双写。
    if (lower === "seed" && words.length > 0 && words[words.length - 1] === "Doubao") {
      words[words.length - 1] = "Doubao Seed";
      continue;
    }
    let word = prettifyToken(token, words[words.length - 1]);
    if (words.length === 0 && KIMI_BARE_VERSION.test(token)) word = `Kimi ${word}`;
    // 空格分版家族(llama/veo)的独立品牌段与后续数字版本段恒空格("Llama 4 Scout"),
    // 点号化前的显式放行,防 4 被通用粘连并成 Llama4。(llama3 单 token 已在
    // prettifyToken 拆成 "Llama 3",这条管 llama-3 / 剥前缀后的独立段。)
    if (word === "Llama" && /^\d/.test(tokens[i + 1] ?? "")) {
      words.push(word);
      danglingBrandTail = false;
      continue;
    }
    if (danglingBrandTail) {
      if (/^\d/.test(token)) {
        words[words.length - 1] += word;
        danglingBrandTail = false;
        continue;
      }
      words[words.length - 1] = words[words.length - 1].replace(/-$/, "");
      danglingBrandTail = false;
    }
    // 多词产出(llama3 → "Llama 3")拆开入列:后续点号化按词匹配,粘成带空格的
    // 单元素会让 DOT_MERGE_LEFT 失配(llama3-1 的 1 并不进 3.1)。
    for (const piece of word.split(" ")) words.push(piece);
    danglingBrandTail = word.endsWith("-");
  }
  if (danglingBrandTail && words.length) {
    words[words.length - 1] = words[words.length - 1].replace(/-$/, "");
  }

  // 版本对点号化:数字段之间的连字符在大量家族里官方写作点号(claude-opus-4-6 →
  // 4.6、kimi-k2-7-code → K2.7、qwen3-5-27b → Qwen3.5、seed-2-0 → 2.0),含中转
  // 站的破折号改写形态(empiriolabs 全目录如此)。左段已含点号则不再并(防
  // 1-2-3 → 1.2.3);从尾向前扫,并完的点号段不再作为右段参与二次合并。
  for (let i = words.length - 1; i > 0; i--) {
    if (!DOT_MERGE_RIGHT.test(words[i])) continue;
    const left = words[i - 1];
    if (!DOT_MERGE_LEFT.test(left) || left.includes(".")) continue;
    words.splice(i - 1, 2, `${left}.${words[i]}`);
  }

  for (let i = words.length - 1; i > 0; i--) {
    const joined = JOINED_TOKEN_PAIRS[`${words[i - 1]}-${words[i]}`.toLowerCase()];
    if (joined) words.splice(i - 1, 2, joined);
  }

  // 「裸品牌-latest」连字:上一环节保留的未剥 -latest(kimi-latest / glm-latest),
  // 分词后 Latest 与品牌词用连字符相接——空格形态 "Kimi Latest" 是句子不像产品名,
  // 连字 "Kimi-Latest" 保留指针语义(用户拍板 2026-09-29)。仅限恰好两个词、首词
  // 无空格分版的形态,防止误吞多词名。
  if (words.length === 2 && words[1] === "Latest") {
    words.splice(0, 2, `${words[0]}-Latest`);
  }

  return words.join(" ").replace(/\s+/g, " ").trim();
}
