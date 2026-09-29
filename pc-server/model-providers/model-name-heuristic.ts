// model-providers/model-name-heuristic.ts — 模型显示名的启发式规整(渲染兜底层)
//
// 分层契约(模型名「确定性第一印象 + 静默权威校正」设计):
//   第一帧的规整名由本模块给出——纯本地同步函数,任何模型名在界面首次出现前就已规整,
//   不存在「先显示原始 ID 再变规整」的中间态。models.dev 官方名随后在后台静默落库替换
//   (display-names.ts),两者由「displayName === modelId」这个「未认领」信号隔开:
//   **启发式永不落库**——落库的只有三种真值(上游接口名 / models.dev 官方名 / 用户手改名),
//   启发式一旦落库就与用户手改名不可区分,官方目录日后收录也无法升级。
//
// 纪律:本模块必须保持零 import、纯字符串运算——web-ui 经 `@server` 直接引用它
// (先例:origin-relay.ts),引入任何 node/bun 内置都会让前端打包炸掉。

/** 品牌词 → 官方大小写。覆盖名字开头常见厂商;未命中走通用分段规则。
 *  值的形式:① 保留连字符的("GPT-")——后续 token 以空格拼接;
 *           ② 无连字符的("Claude")——等同普通词,首字母大写。
 *  官方写法逐一核对 models.dev(2026-09-29):GPT-5.4 mini / GLM-5.3 / DeepSeek V4 /
 *  Qwen3 Max / MiniMax M2.5 / Hunyuan-T1 / Doubao-Seed 1.6。 */
const BRAND_WORDS: Record<string, string> = {
  gpt: "GPT-",
  glm: "GLM-",
  "4o": "4o",
  claude: "Claude",
  gemini: "Gemini",
  grok: "Grok",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  qwen: "Qwen",
  qwq: "QwQ",
  qvq: "QvQ",
  minimax: "MiniMax",
  hunyuan: "Hunyuan",
  hy: "Hunyuan",
  doubao: "Doubao-Seed",
  step: "Step",
  mimo: "MiMo",
  longcat: "LongCat",
  muse: "Muse",
  llama: "Llama",
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
  flux: "Flux",
  hunyuanimage: "HunyuanImage",
  stable: "Stable",
};

/** 规整后保持全小写的普通词(紧跟大写品牌段之后,官方写法刻意小写)。
 *  校准依据:OpenAI 官方一律 `GPT-5.4 mini` / `gpt-4.1-mini → GPT-4.1 mini`(小写)。
 *  "pro"/"flash"/"max" 等其余词官方均首字母大写(Gemini 2.5 Pro / GLM-5.3-Flash /
 *  Qwen3 Max),不在表内。前驱判定放宽到「字母或数字结尾」(GPT-4o mini 同规则)。 */
const LOWERCASE_AFTER_BRAND = new Set(["mini"]);

/** 数字段之间的连字符在「散文式家族」(claude/opus/sonnet/haiku)里官方写作点号:
 *  claude-opus-4-6 → Claude Opus 4.6。仅当相邻两段都是「数字或数字.数字」时转换,
 *  gpt-5.4-mini 的 5.4-mini 是「数字→词」边界,不受影响(由 BRAND_WORDS/小写表处理)。 */
const DOT_VERSION_FAMILIES = /^(claude|qwen|hunyuan|llama|minimax|step)/i;

/** 全 id 特表:id 本身不含任何家族线索、但形态固定且高频的。对齐 pi 目录官方名
 *  (kimi-coding.json:k3 → "Kimi K3"、k3-256k → "Kimi K3-256K")。 */
const EXACT_ID_OVERRIDES: Record<string, string> = {
  k3: "Kimi K3",
  "k3-256k": "Kimi K3-256K",
};

/** 首段即「k + 数字(.数字)」的裸版本段 id:月之暗面端点的裸家族段(不带 kimi- 前缀)。
 *  现役模型里该形态只此一家;保守起见只认「整段就是 k+版本号」,K 开头的其他词不动。 */
const KIMI_BARE_VERSION = /^k\d+(\.\d+)?$/i;

/** 单个 token 的规整:品牌词查表;纯数字/数字.数字保持原样;字母段首字母大写;
 *  字母+数字混合段(4o/K2.7/A3B)保留原样(已含大写或视为家族版本段)。
 *  prev 带前一个已产出的词,用于 LOWERCASE_AFTER_BRAND 判定(小写词紧跟品牌段)。 */
function prettifyToken(token: string, prev: string | undefined): string {
  const lower = token.toLowerCase();
  if (BRAND_WORDS[lower]) return BRAND_WORDS[lower];
  if (/^\d+(\.\d+)*$/.test(token)) return token; // 5 / 5.4 / 20251001
  if (LOWERCASE_AFTER_BRAND.has(lower) && prev !== undefined && /[A-Za-z0-9]$/.test(prev)) {
    return lower;
  }
  if (/^[a-z]/.test(token)) return token.slice(0, 1).toUpperCase() + token.slice(1);
  return token; // 已含大写/混合形态(4o、K2.7、A3B)原样
}

/** 模型 id → 规整显示名。纯函数,幂等;空输入返回空串。 */
export function prettifyModelId(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) return trimmed;
  if (EXACT_ID_OVERRIDES[trimmed]) return EXACT_ID_OVERRIDES[trimmed];

  // 中转站前缀(vendor/model 或 org/model):只规整斜杠后的本地段,前缀整段丢弃
  // (models.dev 官方名同样不带 vendor 前缀:meta-llama/Llama-4-Scout… → Llama 4 Scout)。
  const localPart = trimmed.includes("/") ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : trimmed;
  // 词边界:连字符/下划线/空格——点号除外(见下)。空格虽非合法 id 字符,但用户手填
  // 的 id 与上游目录偶有带空格形态(如月之暗面 "K2.7 Coding"),按词边界处理。
  // **点号不是边界**(5.4 / K2.7 / GLM-4.7 里的点是版本号的一部分,切开会把 GPT-5.4
  // 弄成 GPT-5 4)。
  const tokens = localPart.split(/[-_\s]+/).filter(Boolean);

  const words: string[] = [];
  // 连字系品牌(GPT-/GLM-)与紧随段的粘连状态:记录「上一个产出词的连字尾巴」,
  // 下一段若以数字开头(版本号/4o 形态)则拼进上一词(GPT- + 5.4 → GPT-5.4、GPT- + 4o → GPT-4o),
  // 纯字母段(Codex)则正常空格分词。品牌段本身是 GPT- 时尾巴保留,允许 4o 后再接
  // 连字尾巴(GPT-4o- 的 - 已随分词消解,不会出现)。
  let danglingBrandTail = "";
  for (const token of tokens) {
    let word = prettifyToken(token, words[words.length - 1]);
    if (danglingBrandTail && /^\d/.test(token)) {
      words[words.length - 1] += word;
      danglingBrandTail = "";
      continue;
    }
    danglingBrandTail = "";
    if (words.length === 0 && KIMI_BARE_VERSION.test(token)) word = `Kimi ${word}`;
    words.push(word);
    danglingBrandTail = word.endsWith("-") ? word : "";
  }

  // 散文式家族的数字段连字符 → 点号(见 DOT_VERSION_FAMILIES):Claude Opus 4-6 → 4.6。
  // 从尾向前找相邻数字段;只动「数字.数字」相邻对,避免误伤年份(20251001)这类独立段。
  if (DOT_VERSION_FAMILIES.test(localPart)) {
    for (let i = words.length - 1; i > 0; i--) {
      if (/^\d+$/.test(words[i]) && /^\d+(\.\d+)?$/.test(words[i - 1]) && !/^\d{6,}$/.test(words[i])) {
        words.splice(i - 1, 2, `${words[i - 1]}.${words[i]}`);
      }
    }
  }

  return words.join(" ").replace(/\s+/g, " ").trim();
}
