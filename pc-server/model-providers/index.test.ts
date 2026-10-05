// model-providers/index 纯函数单测:能力推断(Kimi 代际经方言谓词——回归锁)。
import { describe, expect, it } from "bun:test";

import {
  SUNSET_PROVIDER_IDS,
  applyModelRequestHeaders,
  applyRequestHeaders,
  builtinProviderRank,
  defaultProviders,
  inferInputModalities,
  inferModelAbilities,
} from "./index";

describe("inferModelAbilities", () => {
  it("Kimi K2.5+ 全系推理(方言谓词;曾因正则无 kimi 模式致能力位缺失:UI 无推理选项、两引擎思考链路未激活)", () => {
    for (const id of [
      "kimi-k3",
      "kimi-k3.5",
      "k3",
      "kimi-k2.5",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "Pro/moonshotai/Kimi-K2.5",
      "kimi-thinking-preview", // 关键词 thinking 兜住(既有行为)
    ]) {
      expect(inferModelAbilities(id)).toContain("REASONING");
    }
    // 旧代不误伤:legacy 模型非推理。
    for (const id of ["kimi-latest", "moonshot-v1-8k", "kimi-k2"]) {
      expect(inferModelAbilities(id)).not.toContain("REASONING");
    }
  });

  it("既有模式回归锁:主流推理模型仍识别,常规模型不误伤", () => {
    for (const id of ["gpt-5", "o3-mini", "deepseek-reasoner", "qwen3-max", "glm-5", "claude-opus-4-6", "gemini-2.5-pro", "grok-4"]) {
      expect(inferModelAbilities(id)).toContain("REASONING");
    }
    for (const id of ["gpt-4o", "gemini-2.0-flash", "llama-3.3-70b"]) {
      expect(inferModelAbilities(id)).not.toContain("REASONING");
    }
  });

  it("2026-09 新注册模型能力:腾讯 hy3/hy4 等新命中 TOOL+REASONING;裸名/常规模型不误伤", () => {
    // 对齐 APP ModelRegistry:hy3/hy4、mimo-v3、minimax-m3、longcat、step-3.7、muse、裸 k3 均 toolReasoningAbility()。
    for (const id of ["hy3", "hy4-preview", "mimo-v3", "minimax-m3", "longcat-2.0", "step-3.7-flash", "qwen3.8-max", "gpt-5.6", "gpt-6-astra", "muse-spark", "muse-glimmer", "k3", "deepseek-flash"]) {
      const abilities = inferModelAbilities(id);
      expect(abilities).toContain("TOOL");
      expect(abilities).toContain("REASONING");
    }
    // 误伤面:别的词含 hy/mimo 子串不该升级(词边界/锚点守卫);gpt-4o 本就有 TOOL(既有行为),
    // 但它不该被新规则误升 REASONING。
    for (const id of ["mystic-hy", "shyte"]) {
      expect(inferModelAbilities(id)).not.toContain("TOOL");
    }
    expect(inferModelAbilities("gpt-4o")).not.toContain("REASONING");
  });

  it("2026-10 模型注册更新:Claude 5.5 视觉补位 + Gemini 4 抢先登记;近邻不误伤", () => {
    // Claude 5.x 系全部 visionInput(官方 overview「All current Claude models support
    // text and image input … and vision」2026-10-04)——claude-3/claude-4 字面量接不住
    // claude-opus-5 这类夹名变体,补现代变体位(存量 claude-5/sonnet-5 一并自愈)。
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-sonnet-5"]) {
      expect(inferInputModalities(id)).toContain("IMAGE");
    }
    // Gemini 4 对齐 APP GEMINI_4 抢先登记:TOOL(既有 gemini 前缀)+ REASONING(新增代际位)。
    expect(inferModelAbilities("gemini-4-pro")).toContain("REASONING");
    expect(inferModelAbilities("gemini-4-flash")).toContain("REASONING");
    expect(inferModelAbilities("gemini-4-pro")).toContain("TOOL");
    // 误伤面:gemma-4 不升 REASONING(非 gemini-N 主系;vision 由既有 gemini 子串兜底是既有行为)。
    expect(inferModelAbilities("gemma-4-31b-it")).not.toContain("REASONING");
  });

  it("2026-09 新模型视觉:对齐 APP visionInput() 登记;纯文本型号不收", () => {
    // 有 visionInput() 的(APP 行号见 index.ts 注释):含裸 k3(KIMI_K3_ALIAS)与 muse 系。
    for (const id of ["deepseek-flash", "deepseek-v4.1-flash", "step-3.7-flash", "minimax-m3", "mimo-v3", "mimo-v2.5", "longcat-2.0", "qwen3.8", "glm-5.3-flash", "gpt-5.6", "gpt-6-astra", "k3", "muse-spark"]) {
      expect(inferInputModalities(id)).toContain("IMAGE");
    }
    // 无 visionInput() 的纯文本(APP 同样不收):hy3/hy4、qwen3.7/3.8-max、glm-5.2/5.3 普通版。
    for (const id of ["hy3", "hy4", "qwen3.8-max", "qwen3.7-max", "glm-5.2", "glm-5.3"]) {
      expect(inferInputModalities(id)).not.toContain("IMAGE");
    }
  });
});

describe("预置供应商(对齐 APP)", () => {
  it("MiniMax(Claude 形)/ MIMO(OpenAI 形)在册,base 与 APP 一致;MaruCode 赞助商不移植", () => {
    const byId = new Map(defaultProviders().map((p) => [p.id, p]));
    const minimax = byId.get("b4deabea-20fb-4101-a74c-65679c7e4754");
    expect(minimax?.name).toBe("MiniMax");
    expect(minimax?.type).toBe("claude");
    expect(minimax?.baseUrl).toBe("https://api.minimaxi.com/anthropic/v1");
    const mimo = byId.get("a2bafe83-eaf8-47bf-a8c7-3dd82d89f637");
    expect(mimo?.name).toBe("MIMO");
    expect(mimo?.type).toBe("openai");
    expect(mimo?.baseUrl).toBe("https://api.xiaomimimo.com/v1");
    // MaruCode(afbc54ad-…)是 APP 赞助商位,明确不引进。
    expect(byId.has("afbc54ad-807e-4455-9594-7d7a546356ad")).toBe(false);
    // 两家都按预置顺序参与排序(rank 有限值)。
    expect(builtinProviderRank(minimax!)).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(builtinProviderRank(mimo!)).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it("腾讯混元出厂 baseUrl 已迁 TokenHub(APP 2.5.5 对齐;Anthropic 兼容口=同 base /v1/messages)", () => {
    const hunyuan = defaultProviders().find((p) => p.id === "ef5d149b-8e34-404b-818c-6ec242e5c3c5");
    expect(hunyuan?.baseUrl).toBe("https://tokenhub.tencentmaas.com/v1");
  });

  it("RikkaHub 已下架:不在默认集,在 SUNSET 集(存量子清理只删未配 key 的)", () => {
    const RID = "a8d2d463-e8c0-41f2-b89e-f5eb8e716cce";
    expect(defaultProviders().some((p) => p.id === RID)).toBe(false);
    expect(SUNSET_PROVIDER_IDS.has(RID)).toBe(true);
    // 下架后不再参与内置排序(回 MAX_SAFE_INTEGER,沉到自定义区)。
    expect(builtinProviderRank({ id: RID } as any)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("SUNSET 集合不残留在默认供应商里", () => {
    const ids = new Set(defaultProviders().map((p) => p.id));
    for (const sunsetId of SUNSET_PROVIDER_IDS) {
      expect(ids.has(sunsetId)).toBe(false);
    }
  });
});

// 台账 §7.4 会话身份头(对齐安卓 configureSessionHeaders)。行为锁:注入是可选的、按 host
// 加特例、不覆盖用户显式头;两汇聚函数(会话流 applyRequestHeaders / pi 引擎+辅助
// applyModelRequestHeaders)同一注入点,新引擎复用即继承。applySessionHeaders 对 Provider
// 只读 baseUrl,测试用最小对象即可。
describe("会话身份头(§7.4)", () => {
  const assistant = {} as any;
  const model = {} as any;
  const at = (baseUrl: string) => ({ baseUrl }) as any;

  it("有会话 ID 注入原值;缺省/空串兜底随机 UUID(#1902:OpenCode 拒收无会话头请求)", () => {
    const withId = applyRequestHeaders({}, assistant, at("https://api.openai.com/v1"), model, "conv-123");
    expect(withId["X-Session-ID"]).toBe("conv-123");

    const noArg = applyRequestHeaders({}, assistant, at("https://api.openai.com/v1"), model);
    expect(noArg["X-Session-ID"]).toMatch(/^[0-9a-f-]{36}$/);
    const empty = applyRequestHeaders({}, assistant, at("https://api.openai.com/v1"), model, "");
    expect(empty["X-Session-ID"]).toMatch(/^[0-9a-f-]{36}$/);
    // 兜底 ID 每次调用独立(不共享缓存),且不等于任何显式传入值。
    expect(noArg["X-Session-ID"]).not.toBe(empty["X-Session-ID"]);
  });

  it("缺省时 opencode.ai 的 x-opencode-session 也吃随机兜底(连通性测试/OCR 场景)", () => {
    // OpenCode Zen 对这个头硬校验(#1902);辅助调用不传 conversationId 也必须发出去。
    const oc = applyModelRequestHeaders({}, at("https://opencode.ai/zen/v1"), model);
    expect(oc["x-opencode-session"]).toMatch(/^[0-9a-f-]{36}$/);
    // 两个头同值(Android 同语义:opencode 只验非空,内容随意)。
    expect(oc["x-opencode-session"]).toBe(oc["X-Session-ID"]);
  });

  it("opencode.ai 追加 x-opencode-session;其它 host 不追加", () => {
    const oc = applyModelRequestHeaders({}, at("https://opencode.ai/zen/v1"), model, "conv-9");
    expect(oc["X-Session-ID"]).toBe("conv-9");
    expect(oc["x-opencode-session"]).toBe("conv-9");

    const plain = applyModelRequestHeaders({}, at("https://api.openai.com/v1"), model, "conv-9");
    expect(plain["X-Session-ID"]).toBe("conv-9");
    expect("x-opencode-session" in plain).toBe(false);
  });

  it("用户显式自定义头优先(??=):不被会话头覆盖", () => {
    const withCustom = applyRequestHeaders(
      { "X-Session-ID": "user-set" },
      assistant,
      at("https://api.openai.com/v1"),
      model,
      "conv-123",
    );
    expect(withCustom["X-Session-ID"]).toBe("user-set");
  });

  it("两汇聚函数同注入点:pi 引擎注册头与会话流一致", () => {
    const viaModel = applyModelRequestHeaders({}, at("https://api.deepseek.com/v1"), model, "conv-x");
    const viaRequest = applyRequestHeaders({}, assistant, at("https://api.deepseek.com/v1"), model, "conv-x");
    expect(viaModel["X-Session-ID"]).toBe("conv-x");
    expect(viaRequest["X-Session-ID"]).toBe("conv-x");
  });

  it("主机特例不回归:openrouter 仍打 X-Title/HTTP-Referer,aihubmix 仍打 APP-Code", () => {
    const or = applyRequestHeaders({}, assistant, at("https://openrouter.ai/api/v1"), model, "c1");
    expect(or["X-Title"]).toBe("RikkaHub");
    expect(or["HTTP-Referer"]).toBe("https://rikka-ai.com");
    expect(or["X-Session-ID"]).toBe("c1");
    const aih = applyModelRequestHeaders({}, at("https://aihubmix.com/v1"), model, "c2");
    expect(aih["APP-Code"]).toBe("DKHA9468");
    expect(aih["X-Session-ID"]).toBe("c2");
  });
});

// 供应商级自定义请求头(对齐 APP #1952/mergeCustomHeaders):三层链 provider < assistant
// < model,同名被上层覆盖;空名条目静默丢弃(安卓 toHeaders 同款过滤)。
describe("供应商级自定义请求头(三层链)", () => {
  const at = (baseUrl: string, customHeaders?: unknown) => ({ baseUrl, customHeaders }) as any;
  const headers = (list: Array<[string, string]>) => list.map(([name, value]) => ({ name, value }));

  it("供应商头单独存在即发出(无助手/模型头时不丢)", () => {
    const out = applyRequestHeaders({}, {} as any, at("https://api.openai.com/v1", headers([["X-Trace", "t1"]])), {} as any);
    expect(out["X-Trace"]).toBe("t1");
  });

  it("三层链优先级:供应商头被助手头覆盖,助手头被模型头覆盖", () => {
    const out = applyRequestHeaders(
      {},
      { customHeaders: headers([["X-Lane", "assistant"], ["X-Only-Assistant", "a"]]) } as any,
      at("https://api.openai.com/v1", headers([["X-Lane", "provider"]])),
      { customHeaders: headers([["X-Lane", "model"]]) } as any,
    );
    expect(out["X-Lane"]).toBe("model");
    expect(out["X-Only-Assistant"]).toBe("a");
  });

  it("applyModelRequestHeaders(pi/图像/辅助路径)同样供应商头 < 模型头", () => {
    const out = applyModelRequestHeaders(
      {},
      at("https://api.deepseek.com/v1", headers([["X-Deep", "provider"], ["X-Shared", "provider"]])),
      { customHeaders: headers([["X-Shared", "model"]]) } as any,
    );
    expect(out["X-Deep"]).toBe("provider");
    expect(out["X-Shared"]).toBe("model");
  });

  it("空名条目丢弃;缺省字段(undefined)不炸", () => {
    const out = applyRequestHeaders(
      {},
      {} as any,
      at("https://api.openai.com/v1", [{ value: "v" }, { name: "  ", value: "v" }, { name: "X-Ok" }]),
      {} as any,
    );
    expect(out["X-Ok"]).toBe("");
    expect(Object.keys(out).every((key) => key.trim().length > 0)).toBe(true);
  });
});

describe("订阅预置行(§6.1 贴同家 API)+ flow 元数据", () => {
  it("Claude 订阅紧跟 Anthropic 预置,且 anthropic flow chatCapable:false(仅工作区,§6 决策②)", () => {
    const providers = defaultProviders();
    const anchor = providers.findIndex((p) => p.id === "b2c7e1a4-9f3d-4a6e-8c1b-5d7f9e2a3b14");
    const claudeSub = providers[anchor + 1];
    expect(claudeSub?.id).toBe("d4f86913-80d5-45e4-84ea-3e652ac63cda");
    expect(claudeSub?.authMode).toBe("oauth");
    expect(claudeSub?.type).toBe("claude");
    // flow 元数据是前端过滤与闸门的单源:anthropic 关对话,其余订阅均可对话。
    const { OAUTH_FLOWS } = require("./auth/flows");
    expect(OAUTH_FLOWS.anthropic.chatCapable).toBe(false);
    for (const flowId of ["openai-codex", "kimi-coding", "github-copilot", "xai"]) {
      expect(OAUTH_FLOWS[flowId].chatCapable ?? true).toBe(true);
    }
  });
});
