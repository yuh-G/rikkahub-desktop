// model-providers/auth/login.ts — 登录编排(方案 §2.4 §4.3)。
// 职责:startLogin / cancelLogin / logout,以及把 pi-ai 的 AuthInteraction 翻译成
// 宿主 SSE 事件(provider_auth)。关键纪律:
//   1. 每个 provider 同时只允许一个登录尝试(attempt 表)。
//   2. 10 分钟总超时(对齐 OAuth 设备码 15min 上限,留余量),超时自动 abort。
//   3. 登录成功 → CAS 写 oauth + authMode=oauth + enabled=true(方案 §4.3 形态 C)。
//   4. 取消/失败 → 不残留半成品 oauth 行。
//   5. 全程凭据不出本模块:access/refresh 不落日志、不进 SSE 载荷。

import type { OAuthCredential, ProviderAuthInteraction } from "../../../pi/packages/ai/src/auth/types.ts";
import { updateSettings } from "../../app-config";
import type { OAuthFlowId, Provider } from "../../foundation/types";
import { reportError } from "../../observability/app-errors";
import { state } from "../../persistence/json-store";
import { bundledModelsFor } from "./catalog";
import { OAUTH_FLOWS, loadOAuthFlow, oauthFlowFor } from "./flows";

export type LoginPhase =
  | "select_method"
  | "waiting_input"
  | "waiting_browser"
  | "waiting_device_code"
  | "exchanging"
  | "success"
  | "error"
  | "cancelled";

export interface ProviderAuthEvent {
  providerId: string;
  flow: string;
  phase: LoginPhase;
  /** select_method 时可选的登录方式(id + i18n labelKey)。 */
  methods?: ReadonlyArray<{ id: string; labelKey: string }>;
  /** waiting_browser 时的授权 URL(用户复制到浏览器)。 */
  authUrl?: string;
  /** waiting_device_code 时的验证码/地址/倒计时。autoOpenUrl 仅在登记表声明
   *  deviceCodeAutoOpen(verificationUri 已是带 user_code 的免输入链接)时出现。 */
  deviceCode?: { userCode: string; verificationUri: string; expiresInSeconds?: number; autoOpenUrl?: string };
  message?: string;
  /** waiting_input 时的输入框占位提示(Copilot 的企业域名)。 */
  placeholder?: string;
}

type AttemptState = {
  controller: AbortController;
  timeout: ReturnType<typeof setTimeout>;
  /** 挂起的 prompt 的 resolver(取消时统一 reject)。 */
  pendingPrompt?: { reject: (err: Error) => void };
  /** 最近一次广播的事件(取消/结束时不再需要补发)。 */
  lastEvent?: ProviderAuthEvent;
};

// providerId → 进行中的尝试。内存态,不落盘。
const attempts = new Map<string, AttemptState>();

let broadcast: (event: ProviderAuthEvent) => void = () => {};
/** api/sse.ts 注入,把登录进度推给前端三态卡片。 */
export function initProviderAuthBroadcast(fn: (event: ProviderAuthEvent) => void): void {
  broadcast = fn;
}

function emit(event: ProviderAuthEvent, attempt?: AttemptState): void {
  if (attempt) attempt.lastEvent = event;
  try {
    broadcast(event);
  } catch (error) {
    reportError("provider", "warn", "provider_auth broadcast failed", error, "oauth_broadcast_failed");
  }
}

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

function cleanup(providerId: string): void {
  const attempt = attempts.get(providerId);
  if (!attempt) return;
  clearTimeout(attempt.timeout);
  attempts.delete(providerId);
}

/** 终局:广播 + 清理。传入 owner 时只在「表里仍是这一次尝试」才清理——后台流程是异步收尾的,
 *  用户取消后立刻重新登录,旧流程的迟到终局不能把新尝试从表里删掉。 */
function finish(providerId: string, event: ProviderAuthEvent, owner?: AttemptState): void {
  const current = attempts.get(providerId);
  if (owner && current !== owner) {
    emit(event);
    return;
  }
  emit(event, current);
  cleanup(providerId);
}

/** 登录成功落盘:写 oauth + authMode=oauth + enabled=true,并在「当前无模型」时铺入捆绑目录。
 *  CAS 由调用方独占(此时 attempt 已独占该 provider 的写通道),直接读-改-写即可。flowId 从
 *  startLogin 显式传入(它已做过"oauth 行 → 登记表"的判定),这里不再推断、不落兜底值。 */
function commitLogin(providerId: string, flowId: OAuthFlowId, credential: OAuthCredential): boolean {
  const provider = state.settings.providers.find((p) => p.id === providerId);
  if (!provider) return false;
  // 仅在「当前无模型」时铺捆绑目录——用户若已手动加过模型,不覆盖其裁剪结果。
  const bundled = provider.models.length > 0 ? provider.models : bundledModelsFor(flowId, [], credential as unknown as Record<string, unknown>);
  const providers = state.settings.providers.map((p): Provider =>
    p.id === providerId
      ? {
          ...p,
          authMode: "oauth" as const,
          enabled: true,
          models: bundled,
          oauth: {
            flow: flowId,
            credential: credential as unknown as Record<string, import("../../foundation/types").JsonValue>,
            signedInAt: Date.now(),
          },
        }
      : p,
  );
  updateSettings({ ...state.settings, providers });
  return true;
}

/** 登出:剥 oauth + enabled 回落 false。authMode 保持 "oauth"——订阅供应商是 OAuth-only
 *  形态,登出只是「没凭证」,不是「变成 API Key 供应商」(拨成 apiKey 会让前端认不出订阅
 *  卡片、startLogin 也会拒绝再登录;要恢复只能重新走登录流,登录成功后 commitLogin 会
 *  把 authMode 写回 oauth——不存在独立的 restore 端点)。
 *  同时清掉可能被旧版 settings/provider POST 回写进 state 的派生视图 oauthStatus——它本
 *  该只由 stripAuthSecrets 现算,残留一份 signedIn:true 会让卡片在登出后仍显示已登录。 */
export function logoutProvider(providerId: string): boolean {
  const provider = state.settings.providers.find((p) => p.id === providerId);
  if (!provider) return false;
  const staleStatus = (provider as Provider & { oauthStatus?: unknown }).oauthStatus != null;
  if (!provider.oauth && !staleStatus) return false;
  // 若有进行中的登录尝试,先取消。
  cancelLogin(providerId);
  const providers = state.settings.providers.map((p): Provider => {
    if (p.id !== providerId) return p;
    const { oauth: _oauth, oauthStatus: _stale, ...rest } = p as Provider & { oauthStatus?: unknown };
    return { ...rest, enabled: false };
  });
  updateSettings({ ...state.settings, providers });
  return true;
}

export function cancelLogin(providerId: string): void {
  const attempt = attempts.get(providerId);
  if (!attempt) return;
  attempt.pendingPrompt?.reject(new Error("Login cancelled"));
  attempt.controller.abort();
  finish(providerId, { providerId, flow: flowOf(providerId), phase: "cancelled", message: "已取消登录" });
}

function flowOf(providerId: string): string {
  return state.settings.providers.find((p) => p.id === providerId)?.oauth?.flow ?? "";
}

/** 登录流程的 AuthInteraction 实现:把 pi 的 prompt/notify 翻译成 SSE 事件。 */
function makeInteraction(providerId: string, flow: string, attempt: AttemptState): ProviderAuthInteraction {
  return {
    signal: attempt.controller.signal,
    notify(event) {
      const base = { providerId, flow };
      if (event.type === "auth_url") {
        emit({ ...base, phase: "waiting_browser", authUrl: event.url, message: event.instructions }, attempt);
      } else if (event.type === "device_code") {
        const meta = OAUTH_FLOWS[flow as keyof typeof OAUTH_FLOWS];
        emit(
          {
            ...base,
            phase: "waiting_device_code",
            deviceCode: {
              userCode: event.userCode,
              verificationUri: event.verificationUri,
              expiresInSeconds: event.expiresInSeconds,
              autoOpenUrl: meta?.deviceCodeAutoOpen ? event.verificationUri : undefined,
            },
          },
          attempt,
        );
      } else if (event.type === "progress" || event.type === "info") {
        emit({ ...base, phase: "exchanging", message: event.message }, attempt);
      }
    },
    prompt(prompt) {
      if (attempt.controller.signal.aborted) return Promise.reject(new Error("Login cancelled"));
      if (prompt.type === "select") {
        // select 是登录方式选择:把选项广播出去,等前端经 manual-code 端点回传 id。
        const meta = OAUTH_FLOWS[flow as keyof typeof OAUTH_FLOWS];
        emit(
          {
            providerId,
            flow,
            phase: "select_method",
            methods: meta?.loginMethods ?? prompt.options.map((o) => ({ id: o.id, labelKey: o.label })),
            message: prompt.message,
          },
          attempt,
        );
      } else if (prompt.type === "manual_code") {
        // pi 的浏览器流是 notify(auth_url) 紧接 prompt(manual_code):这一帧若不带 authUrl,
        // 前端整帧替换后「打开浏览器 / 复制链接 / 手贴授权码」整块会消失,只剩转圈。
        emit(
          { providerId, flow, phase: "waiting_browser", authUrl: attempt.lastEvent?.authUrl, message: prompt.message },
          attempt,
        );
      } else if (prompt.type === "text" || prompt.type === "secret") {
        // 文本输入(Copilot 的企业域名,空串=github.com)。与 select/manual_code 同一
        // manual-code 端点回传,前端只多渲染一个输入框。
        emit(
          { providerId, flow, phase: "waiting_input", message: prompt.message, placeholder: prompt.placeholder },
          attempt,
        );
      }
      return new Promise<string>((resolve, reject) => {
        attempt.pendingPrompt = { reject };
        // manual-code 端点会调 resumePrompt 注入用户输入。
        pendingPromptResolvers.set(providerId, resolve);
        prompt.signal?.addEventListener("abort", () => {
          pendingPromptResolvers.delete(providerId);
          reject(new Error("Login cancelled"));
        });
      });
    },
  };
}

// manual-code 端点注入用户输入的通道。providerId → prompt resolver。
const pendingPromptResolvers = new Map<string, (value: string) => void>();

/** 前端回传登录方式选择或手动粘贴的授权码/重定向 URL。 */
export function resumePrompt(providerId: string, input: string): boolean {
  const resolve = pendingPromptResolvers.get(providerId);
  if (!resolve) return false;
  pendingPromptResolvers.delete(providerId);
  resolve(input);
  return true;
}

export type LoginOutcome = { ok: true } | { ok: false; error: string };

/** 启动登录。只等到「尝试已登记 + flow 模块已加载」就返回——真正的授权流(选方式 →
 *  开浏览器/设备码 → 等用户 → 换 token)可能持续数分钟,全程进度经 SSE provider_auth
 *  推送,终局也在那里。若在这里 await 整个流程,oauth/start 这个 HTTP 请求会一直挂着:
 *  前端按钮锁在 submitting、ky 30s 超时后又把面板误判为失败,而服务端尝试仍活着。
 *  `completion` 是后台流程的终局(永不 reject),给测试/编排方对齐用;HTTP 层忽略它。 */
export async function startLogin(
  providerId: string,
): Promise<{ ok: true; completion: Promise<LoginOutcome> } | { ok: false; error: string }> {
  const provider = state.settings.providers.find((p) => p.id === providerId);
  if (!provider) return { ok: false, error: "provider not found" };
  if (provider.authMode !== "oauth") return { ok: false, error: "provider is not an OAuth provider" };
  if (attempts.has(providerId)) return { ok: false, error: "login already in progress" };

  // flow 判定:已登录的行存了 oauth.flow;未登录的预置订阅供应商没有 oauth 行,按固定
  // UUID 反查(oauthFlowFor,与 pi 引擎取内建身份同一函数)。
  const flowId = oauthFlowFor(provider)?.id;
  if (!flowId) return { ok: false, error: "unknown OAuth flow" };

  const controller = new AbortController();
  const attempt: AttemptState = {
    controller,
    timeout: setTimeout(() => {
      cancelLogin(providerId);
    }, LOGIN_TIMEOUT_MS),
  };
  attempts.set(providerId, attempt);
  // 立刻发一帧「准备中」:loadOAuthFlow 之后、首个 notify 之前要发网络请求(Kimi/Copilot/xAI
  // 拿设备码/授权 URL),这段窗口里若用户刷新页面,GET oauth/status 会回 inProgress:true +
  // event:null——前端拿不到可渲染的帧,只剩一个被「已在登录中」拒绝的登录按钮,连取消都
  // 点不到,只能等 10 分钟超时。这一帧让尝试从登记那一刻起就可恢复/可取消。
  emit({ providerId, flow: flowId, phase: "exchanging", message: "正在准备登录…" }, attempt);

  let oauth: Awaited<ReturnType<typeof loadOAuthFlow>>;
  try {
    oauth = await loadOAuthFlow(flowId);
  } catch (error) {
    // 模块加载失败是同步可知的环境问题(打包缺 loader 等),直接让 HTTP 层报错,不进后台。
    const message = error instanceof Error ? error.message : String(error);
    reportError("provider", "warn", `OAuth flow load failed for ${providerId}`, error, "oauth_login_failed", { providerId, flow: flowId });
    finish(providerId, { providerId, flow: flowId, phase: "error", message }, attempt);
    return { ok: false, error: message };
  }
  // 加载期间被取消(cancelLogin 已广播 cancelled 并清理 attempt),不再起流。
  if (controller.signal.aborted) return { ok: false, error: "cancelled" };

  return { ok: true, completion: runLogin(providerId, flowId, oauth, attempt) };
}

async function runLogin(
  providerId: string,
  flowId: OAuthFlowId,
  oauth: Awaited<ReturnType<typeof loadOAuthFlow>>,
  attempt: AttemptState,
): Promise<LoginOutcome> {
  const { controller } = attempt;
  try {
    const credential = await oauth.login(makeInteraction(providerId, flowId, attempt));
    if (controller.signal.aborted) return { ok: false, error: "cancelled" };
    const ok = commitLogin(providerId, flowId, credential);
    if (!ok) {
      finish(providerId, { providerId, flow: flowId, phase: "error", message: "登录成功但凭据落盘失败,请重试" }, attempt);
      return { ok: false, error: "commit failed" };
    }
    finish(providerId, { providerId, flow: flowId, phase: "success", message: "登录成功" }, attempt);
    return { ok: true };
  } catch (error) {
    const cancelled = controller.signal.aborted || (error instanceof Error && /cancelled/i.test(error.message));
    const message = cancelled ? "已取消登录" : error instanceof Error ? error.message : String(error);
    if (!cancelled) {
      reportError("provider", "warn", `OAuth login failed for ${providerId}`, error, "oauth_login_failed", { providerId, flow: flowId });
    }
    // 经 cancelLogin 取消的:它已广播 cancelled 并清理,不再补发第二帧。
    // 流程自行以 cancelled 结束(未经 cancelLogin)或出错:正常终局。
    if (!cancelled || attempts.get(providerId) === attempt) {
      finish(providerId, { providerId, flow: flowId, phase: cancelled ? "cancelled" : "error", message }, attempt);
    }
    return { ok: false, error: message };
  }
}

/** 查询当前是否有进行中的登录尝试(前端恢复连接时对齐状态)。 */
export function loginInProgress(providerId: string): boolean {
  return attempts.has(providerId);
}

/** 进行中尝试的最近一帧。前端面板是按 SSE 增量拼三态的,刷新页面后帧就丢了——面板挂载时
 *  用这一帧把「选方式 / 等浏览器 / 等设备码」视图原样接回来,否则用户只剩一个会被
 *  "login already in progress" 拒绝的登录按钮,连取消都点不到。无进行中尝试返回 null。 */
export function currentLoginEvent(providerId: string): ProviderAuthEvent | null {
  return attempts.get(providerId)?.lastEvent ?? null;
}
