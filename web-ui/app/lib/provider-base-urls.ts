// lib/provider-base-urls.ts — 供应商 base 地址登记与 API 格式切换换算(纯函数,零依赖)。
// 独立成文件而非留在 providers.tsx 内,是为了让 pc-server 侧的 bun test 能直接 import
// 锁行为(web-ui 无测试框架;providers.tsx 是 tsx 且拉一整棵 React 依赖树,不可测)。
// 改动这里的表/逻辑时,必须同步跑 pc-server/api/provider-base-urls.test.ts 的往返矩阵。

export type ProviderKind = "openai" | "claude" | "google";

// 各协议的官方默认 base。三用途:①新建供应商兜底;②类型切换时"未自定义过才换默认"的
// 判定基准;③ Base URL 输入框 placeholder(此前 google 档误用 openai 占位符)。
export const DEFAULT_BASE_URLS: Record<ProviderKind, string> = {
  openai: "https://api.openai.com/v1",
  claude: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
};

// 预置供应商的出厂 base(model-providers/index.ts defaultProviders 的镜像,id→base)。
// 用途:机器集合判定 + ②类供应商切换格式的回退落点——回"自己家",绝不退到御三家。
// 新增预置供应商时在此同步一行。
export const BUILTIN_BASE_URLS: Record<string, string> = {
  "a8d2d463-e8c0-41f2-b89e-f5eb8e716cce": "https://api.rikka-ai.com/v1",
  "1eeea727-9ee5-4cae-93e6-6fb01a4d051e": "https://api.openai.com/v1",
  "b2c7e1a4-9f3d-4a6e-8c1b-5d7f9e2a3b14": "https://api.anthropic.com/v1",
  "6ab18148-c138-4394-a46f-1cd8c8ceaa6d": "https://generativelanguage.googleapis.com/v1beta",
  "ff3cde7e-0f65-43d7-8fb2-6475c99f5990": "https://api.x.ai/v1",
  "f099ad5b-ef03-446d-8e78-7e36787f780b": "https://api.deepseek.com/v1",
  "f76cae46-069a-4334-ab8e-224e4979e58c": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "3dfd6f9b-f9d9-417f-80c1-ff8d77184191": "https://ark.cn-beijing.volces.com/api/v3",
  "ef5d149b-8e34-404b-818c-6ec242e5c3c5": "https://api.hunyuan.cloud.tencent.com/v1",
  "3bc40dc1-b11a-46fa-863b-6306971223be": "https://open.bigmodel.cn/api/paas/v4",
  "d6c4d8c6-3f62-4ca9-a6f3-7ade6b15ecc3": "https://api.moonshot.cn/v1",
  "f4f8870e-82d3-495b-9b64-d58e508b3b2c": "https://api.stepfun.com/v1",
  "e7a2b5c3-8f4d-4e6a-9b1c-3d5f7e8a2c04": "https://naapi.cc/v1",
  "d5734028-d39b-4d41-9841-fd648d65440e": "https://openrouter.ai/api/v1",
  "386e0f29-8228-4512-affe-8fd8add82d88": "https://ai-gateway.vercel.sh/v1",
  "56a94d29-c88b-41c5-8e09-38a7612d6cf8": "https://api.siliconflow.cn/v1",
};

// 官方多协议地址登记表:供应商在各 API 格式下的官方端点。两类用途合一:
//   ①类(镜像端点):不同格式 base 不同(如 DeepSeek openai=/v1、claude=/anthropic),
//     切换时按表直达;**每个登记的格式都必须列全**,漏列的方向会退回出厂 base。
//   ②类(同 base 多协议):claude 端点就挂同一 base 的 /v1/messages,无需逐格式登记,
//     留空即可——切换时机器地址会退回自己的出厂 base,恰好就是正确端点。
// 判定"机器地址"时,本表全格式值 + 出厂 base + 协议默认都算——曾被旧版切换 bug 覆写成
// 御三家地址的配置,下次切换会按表自愈回这家供应商的正确端点。
// 每条端点都经厂商自己的文档核实(2026-09-15,无鉴权探测返回 Anthropic 风格鉴权错):
//   DeepSeek   https://api-docs.deepseek.com/guides/anthropic_api/
//   月之暗面   https://platform.kimi.ai/docs/guide/claude-code-kimi (国际域 /anthropic,cn 域同路径已探测)
//   智谱       https://docs.bigmodel.cn/cn/guide/develop/claude/introduction
//   火山方舟   https://www.volcengine.com/docs/82379/2160841 (按量付费口径;Agent Plan 是 /api/coding)
//   阿里百炼   https://help.aliyun.com/zh/model-studio/claude-code FAQ(搜索常见的 /api/v2/anthropic 实测 404,是错的)
//   腾讯混元   https://cloud.tencent.com/document/product/1729/127293
//   阶跃星辰   https://platform.stepfun.com/docs/zh/step-plan/integrations/claude-code (Step Plan 订阅制)
//   Gemini     https://ai.google.dev/gemini-api/docs/openai (google 原生 → openai 兼容层)
// Anthropic 官方无公开 OpenAI 兼容层,不登记。纪律:只认厂商自己的文档,查不到实证就不
// 登记(落"保留/出厂"兜底);新增预置供应商时顺手评估要不要登记。
export const PROVIDER_FORMAT_BASES: Record<string, Partial<Record<ProviderKind, string>>> = {
  // DeepSeek(①类:claude 镜像在 /anthropic;openai 出厂即 /v1)
  "f099ad5b-ef03-446d-8e78-7e36787f780b": {
    claude: "https://api.deepseek.com/anthropic",
  },
  // 月之暗面(①类)
  "d6c4d8c6-3f62-4ca9-a6f3-7ade6b15ecc3": {
    claude: "https://api.moonshot.cn/anthropic",
  },
  // 智谱AI开放平台(①类)
  "3bc40dc1-b11a-46fa-863b-6306971223be": {
    claude: "https://open.bigmodel.cn/api/anthropic",
  },
  // 火山引擎(①类)
  "3dfd6f9b-f9d9-417f-80c1-ff8d77184191": {
    claude: "https://ark.cn-beijing.volces.com/api/compatible",
  },
  // 阿里云百炼(①类)
  "f76cae46-069a-4334-ab8e-224e4979e58c": {
    claude: "https://dashscope.aliyuncs.com/apps/anthropic",
  },
  // 腾讯混元(①类)
  "ef5d149b-8e34-404b-818c-6ec242e5c3c5": {
    claude: "https://api.hunyuan.cloud.tencent.com/anthropic",
  },
  // 阶跃星辰(①类:Step Plan 订阅制端点)
  "f4f8870e-82d3-495b-9b64-d58e508b3b2c": {
    claude: "https://api.stepfun.com/step_plan",
  },
  // Gemini(①类:反向,openai 兼容层;google 原生即出厂)
  "6ab18148-c138-4394-a46f-1cd8c8ceaa6d": {
    openai: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  // xAI / OpenRouter / Vercel Gateway / 硅基流动 / 钠API / RikkaHub / 御三家:
  // ②类或不适用,无登记。x.ai 官方 FAQ 明确 Anthropic SDK 同指 /v1。
};

function normalizeTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// 当前 base 是否"机器填的"——空串、任一协议的官方默认、本供应商出厂地址,或本供应商
// 登记表里登记过的任何格式地址(剥尾斜杠后逐字比较)。用户填过的其他任何值(中转站/
// 自建网关)都不在集合里,一律视为自定义,永不覆写。
export function isMachineBaseUrl(providerId: string, baseUrl: string): boolean {
  const trimmed = normalizeTrailingSlash(baseUrl);
  if (!trimmed) return true;
  const formatBases = Object.values(PROVIDER_FORMAT_BASES[providerId] ?? {});
  const machineUrls = [
    ...Object.values(DEFAULT_BASE_URLS),
    ...Object.values(BUILTIN_BASE_URLS),
    ...formatBases,
  ];
  return machineUrls.some((u) => normalizeTrailingSlash(u) === trimmed);
}

// 切换 API 类型时换算 base。语义(优先级从上到下):
//   1. 当前地址是用户自定义的 → 一字节不动(旧版 bug 无条件覆写御三家地址,用户反馈)。
//   2. 目标格式在本供应商登记表有端点 → 直达(①类镜像)。
//   3. 本供应商有出厂地址 → 回出厂(②类同 base 多协议"不动"的等价形式;①类漏登记方向
//      的安全回退)。**绝不退其他家的协议默认**——那是往别人家里跳,反复切换即漂移。
//      例外:御三家供应商自己(出厂地址即协议默认,如 OpenAI 官方条目)切格式 = 换用另一
//      家官方协议服务,应落目标格式的协议默认,否则切了格式地址纹丝不动。
//   4. 无出厂地址(自定义供应商) → 协议默认。
// 空地址也走 2-4 兜底到合理值。
export function baseUrlForKindSwitch(providerId: string, baseUrl: string, kind: ProviderKind): string {
  const registered = PROVIDER_FORMAT_BASES[providerId]?.[kind];
  // 登记表直达只在"当前地址也是机器地址"时才生效——用户自定义过(中转站)则登记表无权
  // 介入,一字节不动(R2)。
  if (isMachineBaseUrl(providerId, baseUrl)) {
    if (registered) return registered;
    const builtin = BUILTIN_BASE_URLS[providerId];
    // 出厂地址本身就是目标协议的官方默认(御三家互切)→ 跟着协议默认走;无出厂地址的
    // 自定义供应商同理。其余(②类/①类漏登记方向)回自己家,绝不跳到别家协议默认。
    if (!builtin || Object.values(DEFAULT_BASE_URLS).includes(builtin)) {
      return DEFAULT_BASE_URLS[kind];
    }
    return builtin;
  }
  return normalizeTrailingSlash(baseUrl) || DEFAULT_BASE_URLS[kind];
}
