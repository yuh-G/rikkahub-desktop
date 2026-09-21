// 出站输出上限(max_tokens 家族)的跨引擎契约。
//
// 动机(2026-09-09 用户实测:智谱 GLM-5.3 对话模式发 1048576、工作区发 1041128,
// 两模式同报 `[1210][max_tokens参数非法：限制数值范围[1,131072]]`):
// models.dev 目录原本只喂"统计行分母"——查偏了顶多分母不准。P5 起它成了**出站请求
// 字段**的来源,同一份"按名字搜全目录"的逻辑从此决定请求成败。本机目录实测:同名模型
// 的 output 跨 provider 中位差 2 倍、p90 差 28 倍,且 15.6% 的行把 output 填成 context。
//
// 与 tools/tool-protocol-contract.test.ts 同构的两道防线:
// - A(行为):把"上限从哪来、怎么算安全"钉成可执行断言,含本次报障的精确复现。
// - B(完整性):凡构造输出上限线上字段的文件必须登记。新引擎自建上限来源即变红——
//   它不判断新代码对不对,只强迫作者对"我这个上限走没走 model-limits 单源"做出并
//   登记决定。
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import type { Provider } from "../foundation/types";
import { clearAppErrors, recentAppErrors } from "../observability/app-errors";
import { provider } from "./index";
import {
  contextWindowFor,
  internalOutputCap,
  lookupModelLimit,
  outputLimitFor,
  requiredOutputCap,
  resolveCatalogKeys,
  type ModelCatalog,
} from "./model-limits";
import { DEFAULT_OUTPUT_TOKENS, OUTPUT_LIMIT_FACTS, registeredOutputLimit } from "./request-dialect";

function at(baseUrl: string, type: Provider["type"] = "openai"): Provider {
  return provider({ id: "p", name: "P", baseUrl, apiKey: "k", type, models: [] });
}

/** 本次报障的目录形状(取自本机 models-dev-cache.json 的真实行):
 *  - zhipuai / zhipuai-coding-plan 同挂 open.bigmodel.cn,输出上限 131072(权威);
 *  - digitalocean 的同名行 output == context == 1048576(占位行,旧查表撞到的就是它);
 *  - openrouter 的同名行 262144(合法但不是本端点的口径)。
 *  glm-5.1 一并入场:它是**未进方言登记表**的真实型号(glm-5.2/5.3 已分别于 2026-09 登记,
 *  不能再当"未登记"样本),用来验证纯目录路径。 */
const CATALOG: ModelCatalog = {
  zhipuai: {
    api: "https://open.bigmodel.cn/api/paas/v4",
    models: {
      "glm-5.3": { limit: { context: 1_000_000, output: 131_072 } },
      "glm-5.2": { limit: { context: 1_000_000, output: 131_072 } },
      "glm-5.1": { limit: { context: 1_000_000, output: 131_072 } },
    },
  },
  "zhipuai-coding-plan": {
    api: "https://open.bigmodel.cn/api/coding/paas/v4",
    models: {
      "glm-5.3": { limit: { context: 1_000_000, output: 200_000 } },
      "glm-5.2": { limit: { context: 1_000_000, output: 200_000 } },
      "glm-5.1": { limit: { context: 1_000_000, output: 200_000 } },
    },
  },
  digitalocean: {
    api: "https://inference.do-ai.run/v1",
    models: {
      "glm-5.3": { limit: { context: 1_048_576, output: 1_048_576 } },
      "glm-5.2": { limit: { context: 262_144, output: 262_144 } },
      "glm-5.1": { limit: { context: 262_144, output: 262_144 } },
    },
  },
  openrouter: {
    api: "https://openrouter.ai/api/v1",
    models: {
      "z-ai/glm-5.3": { limit: { context: 1_310_720, output: 262_144 } },
      "z-ai/glm-5.2": { limit: { context: 1_048_576, output: 131_072 } },
      "z-ai/glm-5.1": { limit: { context: 1_048_576, output: 131_072 } },
    },
  },
  // 无 api 字段的一线厂商(端点由 SDK 内建):只能经官方主机白名单或一线厂商全集命中。
  anthropic: {
    models: {
      "claude-sonnet-4-5": { limit: { context: 1_000_000, output: 64_000 } },
      "claude-haiku-4-5": { limit: { context: 200_000, output: 64_000 } },
    },
  },
  openai: {
    models: {
      "gpt-5": { limit: { context: 400_000, output: 128_000 } },
      "gpt-5.2-chat-latest": { limit: { context: 128_000, output: 16_384 } },
    },
  },
  google: { models: { "gemini-2.5-pro": { limit: { context: 1_048_576, output: 65_536 } } } },
};

describe("A 行为:按端点身份取上限(2026-09-09 GLM-5.3 1210 报障复现)", () => {
  test("智谱端点 → 智谱目录,不是名字撞到的第一个", () => {
    const zhipu = at("https://open.bigmodel.cn/api/paas/v4");
    // 用未登记的 glm-5.1 验证纯目录路径:同 host 两个目录键(paas 131072 +
    // coding-plan 200000)命中,取 min——偏小只是答案被截短,偏大是整个请求被 400,
    // 代价不对等。旧实现会撞到 digitalocean 的 262144 占位行。
    expect(outputLimitFor(CATALOG, zhipu, "glm-5.1")).toBe(131_072);
    expect(requiredOutputCap(CATALOG, zhipu, "glm-5.1", null)).toBe(131_072);
  });

  test("报障的两个数字不可能再出现(1048576 / 1041128)", () => {
    const zhipu = at("https://open.bigmodel.cn/api/paas/v4", "claude");
    // 1048576 来自 digitalocean 的 output==context 占位行(旧实现按名字撞中);
    // 1041128 是工作区拿同一个脏值减掉估算 prompt 与安全垫后的产物。
    const cap = requiredOutputCap(CATALOG, zhipu, "glm-5.3", null);
    expect(cap).toBe(131_072);
    expect(cap).toBeLessThan(1_041_128);
    // 走 Anthropic 兼容口(报障用的正是 /api/anthropic/v1/messages)时同值:
    // 上限是模型级事实,与协议无关。
    expect(requiredOutputCap(CATALOG, at("https://open.bigmodel.cn/api/anthropic", "claude"), "glm-5.3", null)).toBe(131_072);
  });

  test("output >= context 的占位行一律丢弃(目录里 15.6% 是这个形状)", () => {
    // 用未登记的 glm-5.1 走纯目录路径:digitalocean 端点对它只有 output==context 的
    // 占位行(262144/262144) → 视为"查不到",而不是把窗口尺寸当输出上限发出去。
    const dirty = at("https://inference.do-ai.run/v1");
    expect(lookupModelLimit(CATALOG, "inference.do-ai.run", "glm-5.1", "output")).toBeNull();
    expect(outputLimitFor(CATALOG, dirty, "glm-5.1")).toBeNull();
    // context 字段不做此校验(它就是窗口本身,没有可比的上界)。
    expect(contextWindowFor(CATALOG, dirty, "glm-5.1")).toBe(262_144);
    // 查不到 → 兜底,且兜底恒小于窗口。
    expect(requiredOutputCap(CATALOG, dirty, "glm-5.1", null)).toBe(DEFAULT_OUTPUT_TOKENS);
    // 同一份脏行在旧实现里就是报障值的来源:1048576(glm-5.3 那行)。
    expect(lookupModelLimit(CATALOG, "inference.do-ai.run", "glm-5.3", "output")).toBeNull();
  });

  test("官方主机白名单:目录无 api 字段的几家仍要查得到", () => {
    expect(outputLimitFor(CATALOG, at("https://api.anthropic.com/v1", "claude"), "claude-sonnet-4-5")).toBe(64_000);
    expect(outputLimitFor(CATALOG, at("https://api.openai.com/v1"), "gpt-5")).toBe(128_000);
    expect(
      outputLimitFor(CATALOG, at("https://generativelanguage.googleapis.com/v1beta", "google"), "gemini-2.5-pro"),
    ).toBe(65_536);
    // Azure 也走官方判定(与 openAiMaxTokensField 共用 isOfficialOpenAiHost)。
    expect(resolveCatalogKeys(CATALOG, "my-rg.openai.azure.com")).not.toContain("openrouter");
  });

  test("精确行存在时后缀行不得参与 min(否则 gpt-5 会被 chat-latest 砍到 1/8)", () => {
    // 目录里 gpt-5 精确 128000、gpt-5.2-chat-latest 只有 16384(它是 `gpt-5.` 前缀行)。
    expect(outputLimitFor(CATALOG, at("https://api.openai.com/v1"), "gpt-5")).toBe(128_000);
  });

  test("未知中转站:退到一线厂商原厂上限,不在整个目录里乱撞", () => {
    const relay = at("https://api.some-relay.example/v1");
    // 中转站转发的确实是原厂模型,原厂上限是可辩护的近似;而按名字撞第一个撞到的
    // 往往是转售商的占位行(本次报障即此)。
    expect(outputLimitFor(CATALOG, relay, "claude-sonnet-4-5")).toBe(64_000);
    // 一线厂商全集里也没有 → 兜底(而不是拿 openrouter/digitalocean 的行凑)。
    expect(outputLimitFor(CATALOG, relay, "totally-unknown-model-x")).toBeNull();
    expect(requiredOutputCap(CATALOG, relay, "totally-unknown-model-x", null)).toBe(DEFAULT_OUTPUT_TOKENS);
  });

  test("聚合网关的行不参与「退到一线厂商」这一级(它们精度最低)", () => {
    // openrouter 有 z-ai/glm-5.1;未知端点问这个名字时不得借它的值(用未登记的 5.1,
    // 才是在测目录路径——5.2/5.3 已进方言登记表,恒 131072 与目录无关)。
    expect(outputLimitFor(CATALOG, at("https://api.some-relay.example/v1"), "z-ai/glm-5.1")).toBeNull();
    // 但直连 openrouter 端点时当然要用它自己的口径。
    expect(outputLimitFor(CATALOG, at("https://openrouter.ai/api/v1"), "z-ai/glm-5.1")).toBe(131_072);
    expect(outputLimitFor(CATALOG, at("https://openrouter.ai/api/v1"), "z-ai/glm-5.3")).toBe(131_072);
  });
});

describe("A 行为:方言登记表优先于目录(新模型的适配入口)", () => {
  test("登记的模型取一手文档值,即使目录说别的", () => {
    // 目录对 GLM-5.3 恰好也是 131072,故构造一个"目录说错了"的场景验证优先级。
    const wrong: ModelCatalog = {
      zhipuai: {
        api: "https://open.bigmodel.cn/api/paas/v4",
        models: { "glm-5.3": { limit: { context: 1_000_000, output: 999_999 } } },
      },
    };
    expect(outputLimitFor(wrong, at("https://open.bigmodel.cn/api/paas/v4"), "glm-5.3")).toBe(131_072);
  });

  test("登记按模型级正则、跨渠道成立(官方口/中转/云托管同一个上限)", () => {
    for (const host of ["open.bigmodel.cn", "api.z.ai", "api.some-relay.example", "openrouter.ai"]) {
      expect(outputLimitFor(CATALOG, at(`https://${host}/v1`), "glm-5.3")).toBe(131_072);
      expect(outputLimitFor(CATALOG, at(`https://${host}/v1`), "glm-5.3-flash")).toBe(131_072);
    }
    expect(registeredOutputLimit("GLM-5.3")).toBe(131_072); // 大小写不敏感
    expect(registeredOutputLimit("glm-5.1")).toBeNull(); // 未登记 → 交给目录
  });

  test("每条登记都必须带出处(未来加档位时不许省)", () => {
    for (const fact of OUTPUT_LIMIT_FACTS) {
      expect(fact.cap).toBeGreaterThan(0);
      // 出处要含核实日期,便于日后判断是否该复核。
      expect(fact.source).toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(fact.source.length).toBeGreaterThan(20);
    }
  });
});

describe("A 行为:上限的三种来源边界", () => {
  const zhipu = at("https://open.bigmodel.cn/api/paas/v4");

  test("用户显式配置不钳(填过大是报错的事,不是静默改小设置)", () => {
    // 用户填 500000 > 真实上限 131072:原样发出,由上游报 400,再由
    // provider-errors 的 classifyOutputCapError 给可行动文案。静默截短会让
    // "我明明设了 50 万"与实际行为不符,更难排查。
    expect(requiredOutputCap(CATALOG, zhipu, "glm-5.3", 500_000)).toBe(500_000);
    expect(requiredOutputCap(CATALOG, zhipu, "glm-5.3", 1024)).toBe(1024);
    // 非法值(0/负/非数)视为未配置。
    expect(requiredOutputCap(CATALOG, zhipu, "glm-5.3", 0)).toBe(131_072);
    expect(requiredOutputCap(CATALOG, zhipu, "glm-5.3", -1)).toBe(131_072);
    expect(requiredOutputCap(CATALOG, zhipu, "glm-5.3", undefined)).toBe(131_072);
  });

  test("我们自己的内部预算必须收进模型真实上限", () => {
    // OCR 2048 / 连通性测试 4096 之类的常数不是用户的选择:模型上限更低时必须让步,
    // 否则用户什么都没做错却看到 400(目录里有输出上限 4000 的现役对话模型)。
    const tight: ModelCatalog = {
      cohere: { models: { "command-r-08-2024": { limit: { context: 128_000, output: 4_000 } } } },
    };
    const relay = at("https://api.some-relay.example/v1");
    expect(internalOutputCap(tight, relay, "command-r-08-2024", 4096)).toBe(4_000);
    // 模型上限更高时保持我们的预算(不要因为模型能吐 13 万就让 OCR 吐 13 万)。
    expect(internalOutputCap(CATALOG, zhipu, "glm-5.3", 2048)).toBe(2048);
    // 目录查不到时原样用我们的数(保持既有行为)。
    expect(internalOutputCap(CATALOG, relay, "unknown-model", 4096)).toBe(4096);
  });

  test("目录未加载(启动窗口期)不炸、不误报,直接兜底", () => {
    expect(outputLimitFor(null, zhipu, "gpt-5")).toBeNull();
    expect(contextWindowFor(null, zhipu, "gpt-5")).toBeNull();
    expect(requiredOutputCap(null, zhipu, "gpt-5", null)).toBe(DEFAULT_OUTPUT_TOKENS);
  });

  test("兜底值必须恒小于任何现役模型的上下文窗口", () => {
    // DEFAULT_OUTPUT_TOKENS 之所以能安全地发给"上限未知"的模型,依赖这个不变式:
    // 严格端点普遍校验 input + max_tokens <= context,兜底若接近窗口就会变成新的 400 源。
    expect(DEFAULT_OUTPUT_TOKENS).toBeLessThanOrEqual(64_000);
  });
});

describe("A 行为:上限未知要留痕(「该去查官方文档并登记」的机械化信号)", () => {
  const relay = at("https://api.some-relay.example/v1");

  test("目录已加载但查不到 → info 级留痕,带模型名与兜底值", () => {
    clearAppErrors();
    requiredOutputCap(CATALOG, relay, "brand-new-model-2027", null);
    const entry = recentAppErrors().find((item) => item.code === "output_limit_unknown");
    expect(entry).toBeDefined();
    // info = 只进错误中心,不弹全局提示——它是给我们看的信号,不是用户的错。
    expect(entry?.severity).toBe("info");
    expect(entry?.params?.model).toBe("brand-new-model-2027");
    expect(entry?.params?.fallback).toBe(DEFAULT_OUTPUT_TOKENS);
  });

  test("查得到的模型不留痕(否则信号被噪音淹没)", () => {
    clearAppErrors();
    requiredOutputCap(CATALOG, at("https://open.bigmodel.cn/api/paas/v4"), "glm-5.3", null);
    requiredOutputCap(CATALOG, at("https://api.openai.com/v1"), "gpt-5", null);
    // 用户显式配了上限也不留痕:那是他的选择,我们没在猜。
    requiredOutputCap(CATALOG, relay, "brand-new-model-2027", 8192);
    expect(recentAppErrors().filter((item) => item.code === "output_limit_unknown")).toHaveLength(0);
  });

  test("目录未加载(启动窗口期)不留痕:那不是「未知模型」", () => {
    clearAppErrors();
    requiredOutputCap(null, relay, "gpt-5", null);
    expect(recentAppErrors().filter((item) => item.code === "output_limit_unknown")).toHaveLength(0);
  });
});

// ── B 完整性:输出上限线上字段的构造点登记 ─────────────────────────────────────
// 登记表 = "已审阅过、确认上限经 model-limits 单源取值(或本身就是那个单源)"的文件。
const REGISTERED_OUTPUT_CAP_FILES: ReadonlySet<string> = new Set([
  // 主生成:Claude 分支 requiredOutputCap;OpenAI/Google 分支仅在用户显式配置时才发字段。
  "conversations/orchestrator.ts",
  // 辅助任务(标题/建议/翻译/压缩/提示词优化/OCR):requiredOutputCap + internalOutputCap。
  "conversations/auxiliary.ts",
  // 连通性测试:internalOutputCap(探测预算不得超模型上限)。
  "model-providers/checks.ts",
  // Google generationConfig:maxOutputTokens 仅在用户显式配置时出现。
  "inference-engine/message-builder.ts",
  // 工作区引擎桥接:上限数值由 orchestrator 经 requiredOutputCap 注入,本文件只定字段名。
  "pi-engine/model-bridge.ts",
  // 方言事实单源:OUTPUT_LIMIT_FACTS 登记表(一手文档上限)+ DEFAULT_OUTPUT_TOKENS 兜底常量。
  // 它是 model-limits 的取值来源之一(登记优先于目录),自身即单源的一部分。
  "model-providers/request-dialect.ts",
]);

/** 线上字段判别符:出现即意味着"这里在决定发给模型的输出上限"。 */
const OUTPUT_CAP_MARKERS = [
  "max_tokens:",
  "max_completion_tokens:",
  "max_output_tokens:",
  "maxOutputTokens",
  "maxTokensField",
] as const;

const SERVER_ROOT = join(import.meta.dir, "..");
const SKIP_DIRS = new Set(["node_modules", "scripts", "test-utils", "dist"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

/** 注释里提及字段名很常见(方言说明、纪律注释),扫描前剥掉,否则登记表会被注释噪音撑爆。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
}

describe("B 完整性:输出上限构造点必须登记(新引擎的强制路口)", () => {
  test("构造点文件集与登记表一致", () => {
    const found = new Set<string>();
    for (const file of sourceFiles(SERVER_ROOT)) {
      const source = stripComments(readFileSync(file, "utf8"));
      if (!OUTPUT_CAP_MARKERS.some((marker) => source.includes(marker))) continue;
      found.add(relative(SERVER_ROOT, file).replaceAll("\\", "/"));
    }
    const unregistered = [...found].filter((file) => !REGISTERED_OUTPUT_CAP_FILES.has(file)).sort();
    expect(
      unregistered,
      `以下文件在决定发给模型的输出上限,但未登记:\n  ${unregistered.join("\n  ")}\n`
        + "两条纪律:①协议允许省略上限时(OpenAI completions/responses、Google),用户没配就"
        + "**根本不发这个字段**——不发=用服务端默认=恒合法,发一个猜来的数就是 400 的来源;"
        + "②协议必填时(Anthropic、pi 模型配置),数值必须取自 model-providers/model-limits 的"
        + "requiredOutputCap(用户配置>方言登记>目录真值>兜底),我们自己定的内部预算走"
        + "internalOutputCap。确认后登记进 REGISTERED_OUTPUT_CAP_FILES。",
    ).toEqual([]);
    const stale = [...REGISTERED_OUTPUT_CAP_FILES].filter((file) => !found.has(file)).sort();
    expect(stale, `登记表存在陈旧条目(文件已不再决定输出上限):\n  ${stale.join("\n  ")}`).toEqual([]);
  });

  test("上限来源单源:除 model-limits 自身,无人再直接查目录 limit.output", () => {
    // 旧实现是 inference-engine/providers.ts 的 lookupOutputLimit —— 谁都能调、
    // 按名字搜全目录。收口后 catalog[...].models[...].limit 只允许出现在单源模块里。
    const offenders: string[] = [];
    for (const file of sourceFiles(SERVER_ROOT)) {
      const rel = relative(SERVER_ROOT, file).replaceAll("\\", "/");
      if (rel === "model-providers/model-limits.ts") continue;
      const source = stripComments(readFileSync(file, "utf8"));
      if (/\.limit\s*\?\.\s*\[?["']?(output|context)/.test(source) || /limit\?\.\[field\]/.test(source)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders.sort(),
      `以下文件直接读 models.dev 的 limit 字段,绕过了 model-limits 单源:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
