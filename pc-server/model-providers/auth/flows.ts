// model-providers/auth/flows.ts — OAuth flow 登记表(方案 §2.4)。
// 唯一触碰 pi-ai auth 协议层(load/resolve 及各 flow 实现)的宿主模块:其余文件只面向
// 这里的声明式元数据。新增订阅供应商 = 在 OAUTH_FLOWS 登记一行 + shaping/catalog 补声明。

import type { OAuthCredential } from "../../../pi/packages/ai/src/auth/types.ts";
import type { LoginOptions } from "../../../pi/packages/ai/src/auth/types.ts";
import type { OAuthFlowId, Provider } from "../../foundation/types";
import { readFileSync, writeFileSync } from "node:fs";
import { oauthDeviceIdPath } from "../../foundation/paths";

export type PiOAuthAuth = {
  name: string;
  login(interaction: any, options?: LoginOptions): Promise<OAuthCredential>;
  refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential>;
  toAuth(credential: OAuthCredential): Promise<{ apiKey?: string; headers?: Record<string, string>; baseUrl?: string }>;
};

export interface OAuthFlowMeta {
  id: OAuthFlowId;
  /** pi-ai load.ts 中对应的 loader 函数名。 */
  loader: "loadOpenAICodexOAuth" | "loadOpenAIChatGPTOAuth" | "loadKimiCodingOAuth" | "loadGitHubCopilotOAuth" | "loadXaiOAuth" | "loadAnthropicOAuth";
  /** 登录方式:null = 直接走流程(如 Kimi 仅设备码);数组 = 先经 select 提示让用户选。 */
  loginMethods: ReadonlyArray<{ id: string; labelKey: string }> | null;
  /** pi-ai 内置 provider id(resolveProviderAuth / 内置模型目录 / pi 引擎模型身份用)。 */
  piProviderId: string;
  /** 宿主预置订阅供应商的固定 UUID——一经发布不可改(老用户 state/备份引用它)。
   *  是「宿主 provider 行 ↔ flow」在未登录(尚无 oauth 行)时的唯一反查键:登录起流、
   *  pi 引擎取内建身份、状态剥离时的 flow 判定都经 oauthFlowFor 走这里,不得在别处复制表。 */
  presetProviderId: string;
  /** 是否可进对话引擎(缺省 true)。Claude Pro/Max 的凭证要求 Claude Code 全套伪装
   *  (pi api/anthropic-messages.ts 内建),宿主聊天引擎不接:resolve 处闸门拦宿主全路径,
   *  前端据此隐藏聊天选择器入口、登录卡挂「仅工作区 + 合规」提示。
   *  【不变量】工作区引擎经 freshSubscriptionCredential(契约 host.models.credential)取令牌,
   *  不经 resolveProviderAuthForProvider,故该闸门只护宿主全路径;若将来给聊天引擎加绕过
   *  resolve 的出站路径,或让别的引擎也走取令牌通道,须一并评估此闸门是否仍成立。 */
  chatCapable?: boolean;
  /** 设备码流的 verificationUri 是否已是免输入完整链接(RFC 8628 verification_uri_complete,
   *  带 user_code 参数)。pi 协议层没有单独字段——kimi/xai 实现已把它折叠进 verificationUri,
   *  openai-codex 设备码/github-copilot 的则是需手抄验证码的裸地址。true 时登录事件下发
   *  autoOpenUrl,前端视同浏览器登录自动拉起;裸地址流自动打开只会把用户带到手抄输入页。 */
  deviceCodeAutoOpen?: boolean;
  /** 该 flow 的 pi login 需要 LoginOptions.getDeviceId(稳定安装标识,见 oauthDeviceId 头注)。
   *  目前仅 openai-chatgpt(Sign in with ChatGPT 的 agent host id);缺失时 pi 直接抛错。 */
  requiresDeviceId?: boolean;
}

export const OAUTH_FLOWS: Record<OAuthFlowId, OAuthFlowMeta> = {
  "openai-codex": {
    id: "openai-codex",
    loader: "loadOpenAICodexOAuth",
    loginMethods: [
      { id: "browser", labelKey: "settings:providers.oauth.method.browser" },
      { id: "device_code", labelKey: "settings:providers.oauth.method.device_code" },
    ],
    piProviderId: "openai-codex",
    presetProviderId: "98d0557b-0700-41e5-b1d6-ee875a53ae5a", // ChatGPT(Codex 订阅)
  },
  "openai-chatgpt": {
    id: "openai-chatgpt",
    loader: "loadOpenAIChatGPTOAuth",
    // Sign in with ChatGPT(pi 0.99 起,取代 legacy Codex 登录的新 OpenAI 订阅轨):标准
    // api.openai.com/v1/responses 端点,无实验通道头,聊天+工作区双可用。单流浏览器授权,
    // 回调 127.0.0.1:1455,被占时手贴重定向 URL(宿主 manual-code 通道原生兼容)。
    loginMethods: null,
    piProviderId: "openai",
    presetProviderId: "7ff4695a-4eec-4e91-8c6a-c5b1e1c349a8", // ChatGPT(新版订阅登录)
    // OpenAI 要求登录方携带稳定安装标识(urn:uuid:<uuid>)——见 oauthDeviceId() 头注。
    requiresDeviceId: true,
  },
  "kimi-coding": {
    id: "kimi-coding",
    loader: "loadKimiCodingOAuth",
    loginMethods: null,
    piProviderId: "kimi-coding",
    presetProviderId: "f9622c8b-5037-4540-b875-3d301521367b", // Kimi Code
    deviceCodeAutoOpen: true,
  },
  "github-copilot": {
    id: "github-copilot",
    loader: "loadGitHubCopilotOAuth",
    loginMethods: null,
    piProviderId: "github-copilot",
    presetProviderId: "55bff930-76fb-47e4-a19c-6b48e201bf48", // P2
  },
  xai: {
    id: "xai",
    loader: "loadXaiOAuth",
    loginMethods: null,
    piProviderId: "xai",
    presetProviderId: "5ec4bda4-5511-4e86-9c3f-b08d37d23dc1", // xAI SuperGrok,P2
    deviceCodeAutoOpen: true, // verificationUriComplete 缺失时 pi 退回裸地址,用户手抄验证码兜底
  },
  anthropic: {
    id: "anthropic",
    loader: "loadAnthropicOAuth",
    // pi 1.0.0 起 loginAnthropic 先 select(browser / copy_code)。copy_code 是
    // notify(auth_url) 后 prompt(manual_code,"code#state")——login.ts 的
    // waiting_browser/manual-code 回传路径原生兼容。
    loginMethods: [
      { id: "browser", labelKey: "settings:providers.oauth.method.browser" },
      { id: "copy_code", labelKey: "settings:providers.oauth.method.copy_code" },
    ],
    piProviderId: "anthropic",
    presetProviderId: "d4f86913-80d5-45e4-84ea-3e652ac63cda", // Claude Pro/Max,P3(仅工作区)
    chatCapable: false,
  },
};

/** 宿主 provider 行 → 所属 OAuth flow。已登录的行以 oauth.flow 为准;未登录的预置订阅
 *  供应商(还没有 oauth 行)按固定 UUID 反查。非订阅供应商返回 undefined。 */
export function oauthFlowFor(provider: Pick<Provider, "id" | "oauth">): OAuthFlowMeta | undefined {
  const byRow = provider.oauth?.flow ? OAUTH_FLOWS[provider.oauth.flow] : undefined;
  if (byRow) return byRow;
  return Object.values(OAUTH_FLOWS).find((flow) => flow.presetProviderId === provider.id);
}

/** 该 id 是否为预置订阅供应商的固定 UUID。 */
export function isPresetOAuthProviderId(providerId: string): boolean {
  return Object.values(OAUTH_FLOWS).some((flow) => flow.presetProviderId === providerId);
}

const cache = new Map<OAuthFlowId, Promise<PiOAuthAuth>>();

/** 测试注入点:替换 flow 的 pi-ai 实现(如锁 toAuth 不触网)。生产代码不调。 */
export function overrideOAuthFlow(flowId: OAuthFlowId, impl: PiOAuthAuth): void {
  cache.set(flowId, Promise.resolve(impl));
}

/** 清除测试注入,恢复懒加载真实实现。生产代码不调。 */
export function clearOAuthFlowOverride(flowId: OAuthFlowId): void {
  cache.delete(flowId);
}

// 静态 import 所有 loader 与实现文件——bun --compile 只能打包静态引用。
// pi 的 load.ts 已预留 registerBundledOAuthFlowLoaders 接口给 standalone 二进制使用。
import {
  loadOpenAICodexOAuth,
  loadOpenAIChatGPTOAuth,
  loadKimiCodingOAuth,
  loadGitHubCopilotOAuth,
  loadXaiOAuth,
  loadAnthropicOAuth,
  registerBundledOAuthFlowLoaders,
} from "../../../pi/packages/ai/src/auth/oauth/load.ts";
import { openaiCodexOAuth } from "../../../pi/packages/ai/src/auth/oauth/openai-codex.ts";
import { openaiChatGPTOAuth } from "../../../pi/packages/ai/src/auth/oauth/openai-chatgpt.ts";
import { kimiCodingOAuth } from "../../../pi/packages/ai/src/auth/oauth/kimi-coding.ts";
import { githubCopilotOAuth } from "../../../pi/packages/ai/src/auth/oauth/github-copilot.ts";
import { xaiOAuth } from "../../../pi/packages/ai/src/auth/oauth/xai.ts";
import { anthropicOAuth } from "../../../pi/packages/ai/src/auth/oauth/anthropic.ts";

// Bun standalone 模式(编译为 exe)下注册静态打包的 oauth 实现,绕过 load.ts 的动态 import。
if (Bun.isStandaloneExecutable) {
  registerBundledOAuthFlowLoaders({
    openaiCodex: () => openaiCodexOAuth,
    openaiChatGPT: () => openaiChatGPTOAuth,
    kimiCoding: () => kimiCodingOAuth,
    githubCopilot: () => githubCopilotOAuth,
    xai: () => xaiOAuth,
    anthropic: () => anthropicOAuth,
    openrouter: () => {
      throw new Error("OpenRouter OAuth not implemented in this build");
    },
    radius: () => {
      throw new Error("Radius OAuth not implemented in this build");
    },
    // pi 1.0.3 新增的 meta OAuth flow:宿主未预置供应商,也不会有宿主行走到这个键,
    // 声明为显式抛错——若真被调到,错误信息比静默 undefined 更可诊断。
    meta: () => {
      throw new Error("Meta OAuth not implemented in this build");
    },
  });
}

const loaderRegistry = {
  loadOpenAICodexOAuth,
  loadOpenAIChatGPTOAuth,
  loadKimiCodingOAuth,
  loadGitHubCopilotOAuth,
  loadXaiOAuth,
  loadAnthropicOAuth,
} as const;

/** OAuth 登录方的稳定安装标识,LoginOptions.getDeviceId 的宿主实现(声明
 *  requiresDeviceId 的 flow 由 login.ts 接线注入)。
 *  Sign in with ChatGPT 要求每个安装带稳定的 agent host id(urn:uuid:<uuid>):OpenAI
 *  按它做设备指纹与限额,临时随机值会让每次登录被当作新设备(可能触发风控/重复授权)。
 *  首次登录时生成、落 pc-data/oauth-device-id.txt、此后恒返同值。刻意**不复用** analytics
 *  的 device-id.txt:那是匿名 DAU 统计标识,与本服务的 OAuth 设备身份是两个信任域——
 *  合并等于把统计端点与 OpenAI 风控数据串联成同一指纹,分开则互不可关联。写失败(只读
 *  目录等)不阻断登录:本次进程内仍稳定(模块级缓存),下次登录会再试落盘。 */
let cachedOauthDeviceId: string | null = null;
export function oauthDeviceId(): string {
  if (cachedOauthDeviceId) return cachedOauthDeviceId;
  let stored = "";
  try {
    stored = readFileSync(oauthDeviceIdPath, "utf-8").trim();
  } catch {
    // 首次登录:文件不存在,走下方生成。
  }
  if (UUID_RE.test(stored)) {
    cachedOauthDeviceId = stored;
    return stored;
  }
  const generated = crypto.randomUUID();
  try {
    writeFileSync(oauthDeviceIdPath, generated);
  } catch {
    // 落盘尽力而为:内存缓存保证本次进程内稳定,登录仍可完成。
  }
  cachedOauthDeviceId = generated;
  return generated;
}

/** 测试注入点:清掉进程内缓存并复位文件读取(验证"落盘后恒返同值")。生产代码不调。 */
export function invalidateOauthDeviceIdCache(): void {
  cachedOauthDeviceId = null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 懒加载 flow 的 pi-ai OAuthAuth 实现(首次调用时执行 loader,结果缓存)。 */
export function loadOAuthFlow(flowId: OAuthFlowId): Promise<PiOAuthAuth> {
  let cached = cache.get(flowId);
  if (!cached) {
    const loaderName = OAUTH_FLOWS[flowId].loader;
    const loader = loaderRegistry[loaderName];
    if (!loader) throw new Error(`pi-ai OAuth loader missing: ${loaderName}`);
    // pi 的 toAuth 返回 ModelAuth 判别联合,PiOAuthAuth 是宿主消费视角的最小结构声明
    // (apiKey/headers/baseUrl)——运行时同构,静态断言对齐(动态 import 时代同款处理)。
    cached = loader() as Promise<PiOAuthAuth>;
    cache.set(flowId, cached);
  }
  return cached;
}
