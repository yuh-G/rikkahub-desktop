// components/settings/providers.tsx — 模型提供商分区（配置/测试/余额/模型列表，纯搬迁自 routes/settings.tsx）

import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  CheckCircle2,
  Database,
  ExternalLink,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { AIIcon } from "~/components/ui/ai-icon";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { ModelEditDialog } from "~/components/model-edit-dialog";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import { cn } from "~/lib/utils";
import { isBalanceResultPathValid } from "~/lib/json-expression";
import { createId } from "~/lib/id";
import { copyTextToClipboard } from "~/lib/clipboard";
import { isDesktopShell, openExternal } from "~/lib/external-link";
import api, { appendWebAuthQuery } from "~/services/api";
import { onAppEvent, type ProviderAuthEventDto } from "~/services/app-events";
import { confirmDialog } from "~/stores/confirm-store";
import type { ProviderModel, ProviderProfile, Settings } from "~/types";
import {
  clone,
  moveItem,
  PasswordInput,
  SectionHeader,
  SortableRow,
  textValue,
} from "~/components/settings/shared";
// API 格式切换的 base 换算(协议默认/出厂/登记三张表 + 机器地址判定 + 换算规则)独立在
// lib/provider-base-urls.ts——纯函数零依赖,行为锁在 pc-server/api/provider-base-urls.test.ts
// 的往返矩阵(核心不变量:往返不漂移、自定义不覆写)。御三家 URL 与登记端点只在那一个文件维护。
import { DEFAULT_BASE_URLS, type ProviderKind, baseUrlForKindSwitch } from "~/lib/provider-base-urls";

type ProviderTestMode = "non_stream" | "stream" | "tools";

interface ProviderTestCheck {
  mode: ProviderTestMode;
  ok: boolean;
  status: number;
  endpoint: string;
  preview: string;
}

interface ProviderTestInfo {
  endpoint: string;
  responseApiEndpoint: string;
  testModelId: string;
  modelCount: number;
  preview: string;
  checks?: ProviderTestCheck[];
}

/** 订阅供应商登录面板(方案 §4.3 三态卡片)。inline 卡片非模态——用户需要看着验证码
 *  操作手机,浏览器登录经系统浏览器完成。凭据永不下发,状态全经 SSE provider_auth。 */
function ProviderLoginPanel({ provider }: { provider: ProviderProfile }) {
  const { t } = useTranslation();
  const [authEvent, setAuthEvent] = React.useState<ProviderAuthEventDto | null>(null);
  const [manualCode, setManualCode] = React.useState("");
  const [textInput, setTextInput] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const signedIn = provider.oauthStatus?.signedIn === true;
  const inProgress = authEvent != null && !["success", "error", "cancelled"].includes(authEvent.phase);

  // 三态视图靠 SSE 增量拼出来,刷新页面/切换供应商后帧就丢了;服务端保留了进行中尝试的
  // 最近一帧,挂载时取回接上——否则用户只剩一个会被「已在登录中」拒绝的登录按钮。
  // 只「补上」进行中的帧,从不据此清空——GET 在途时用户可能已点登录,SSE 帧先到,迟到的
  // 「无尝试」回包不能把刚拼出的面板抹掉;终态清空只由 SSE 的 success/error/cancelled 驱动。
  const providerIdRef = React.useRef(provider.id);
  providerIdRef.current = provider.id;
  const syncLoginStatus = React.useCallback(async () => {
    const providerId = provider.id;
    try {
      const status = await api.get<{ inProgress: boolean; event: ProviderAuthEventDto | null }>(
        "settings/provider/oauth/status",
        { searchParams: { providerId } },
      );
      // 回包期间用户切了供应商,这帧属于旧供应商,丢弃。
      if (providerIdRef.current !== providerId) return;
      if (status.inProgress && status.event) setAuthEvent(status.event);
    } catch {
      // 对齐失败只是少了恢复视图,后续 SSE 帧仍会驱动面板;不打扰用户
    }
  }, [provider.id]);

  React.useEffect(() => {
    setAuthEvent(null);
    void syncLoginStatus();
  }, [syncLoginStatus]);

  // 服务端真值兜底:登录态翻转瞬间清掉残留的非终态帧。SSE 增量帧可能因通道抖动/页面
  // 后台节流丢失,而 oauthStatus 随 settings 快照可靠到达——若 signedIn 已翻真而面板还
  // 挂着"进行中"帧(说明 success 帧丢了),按真值收口并补一声成功提示;翻假(别处登出/
  // 凭证被清)同理静默清掉幽灵进度卡。终态帧(success/error/cancelled)由各自 SSE 处理
  // 器收口,不经这里。经 ref 读当前帧:toast 是副作用,不能进 setState updater。
  const authEventRef = React.useRef(authEvent);
  authEventRef.current = authEvent;
  const lastSignedInRef = React.useRef(signedIn);
  React.useEffect(() => {
    if (lastSignedInRef.current === signedIn) return;
    lastSignedInRef.current = signedIn;
    const current = authEventRef.current;
    if (current == null || ["success", "error", "cancelled"].includes(current.phase)) return;
    if (signedIn) toast.success(t("settings:providers.oauth.success"));
    setAuthEvent(null);
  }, [signedIn, t]);

  // 浏览器登录:授权 URL 首次到达时在桌面壳里直接拉起系统浏览器(pi 只给 URL 不开浏览器)。
  // 纯浏览器环境 window.open 不在用户手势内会被拦截,留给「打开浏览器」按钮。
  // 设备码登录:autoOpenUrl 是后端确认过的免输入完整链接(带 user_code,Kimi/Grok),同样自动跳转;
  // 裸地址流(Copilot/ChatGPT 设备码)不跳,避免把用户带到还需手抄验证码的输入页。
  const openedAuthUrlRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const off = onAppEvent("provider_auth", (event) => {
      if (event.providerId !== provider.id) return;
      setAuthEvent(event);
      const urlToOpen = event.phase === "waiting_browser"
        ? event.authUrl
        : event.phase === "waiting_device_code"
          ? event.deviceCode?.autoOpenUrl
          : undefined;
      if (urlToOpen && openedAuthUrlRef.current !== urlToOpen) {
        openedAuthUrlRef.current = urlToOpen;
        if (isDesktopShell()) void openExternal(urlToOpen);
      }
      if (event.phase === "success") {
        toast.success(t("settings:providers.oauth.success"));
        setAuthEvent(null);
      } else if (event.phase === "error") {
        toast.error(event.message || t("settings:providers.oauth.error"));
        setAuthEvent(null);
      } else if (event.phase === "cancelled") {
        toast.info(event.message || t("settings:providers.oauth.cancelled"));
        setAuthEvent(null);
      }
    });
    return off;
  }, [provider.id, t]);

  // start 只等服务端登记完尝试就返回(授权流在后台跑、进度走 SSE),submitting 只锁这一瞬。
  const start = async () => {
    setSubmitting(true);
    try {
      await api.post("settings/provider/oauth/start", { providerId: provider.id });
    } catch (error) {
      // 「已在登录中」是状态而非事故,给指路的 i18n 文案;其余错误保持原文。
      const message = (error as Error).message;
      toast.error(/already in progress/i.test(message) ? t("settings:providers.oauth.already_in_progress") : message);
      // 失败原因可能是服务端已有进行中的尝试(如刷新前发起的),按服务端真值对齐视图。
      await syncLoginStatus();
    } finally {
      setSubmitting(false);
    }
  };
  const submitMethod = async (methodId: string) => {
    setSubmitting(true);
    try {
      await api.post("settings/provider/oauth/manual-code", { providerId: provider.id, input: methodId });
    } catch (error) {
      toast.error((error as Error).message);
      // 失败时保持当前 phase（不 setAuthEvent(null)），让用户看到错误后可以重试其他方法
    } finally {
      setSubmitting(false);
    }
  };
  const cancel = async () => {
    try {
      await api.post("settings/provider/oauth/cancel", { providerId: provider.id });
    } catch (error) {
      toast.error((error as Error).message);
      return;
    }
    setAuthEvent(null);
  };
  const logout = async () => {
    const ok = await confirmDialog({ title: t("settings:providers.oauth.logout"), description: t("settings:providers.oauth.logout_confirm") });
    if (!ok) return;
    try {
      await api.post("settings/provider/oauth/logout", { providerId: provider.id });
      toast.success(t("settings:providers.oauth.logout_success"));
    } catch (error) {
      toast.error((error as Error).message);
    }
  };
  const submitManualCode = async () => {
    if (!manualCode.trim()) return;
    try {
      await api.post("settings/provider/oauth/manual-code", { providerId: provider.id, input: manualCode.trim() });
      setManualCode("");
    } catch (error) {
      toast.error((error as Error).message);
    }
  };
  // waiting_input(如 Copilot 企业域名):空串有语义(留空 = 用默认),所以不设非空门槛。
  const submitTextInput = async () => {
    setSubmitting(true);
    try {
      await api.post("settings/provider/oauth/manual-code", { providerId: provider.id, input: textInput.trim() });
      setTextInput("");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };
  const copy = async (text: string) => {
    try {
      await copyTextToClipboard(text);
      toast.success(t("settings:providers.oauth.copied"));
    } catch {
      toast.error(t("settings:providers.oauth.copy_failed"));
    }
  };

  // 仅工作区的订阅(Claude Pro/Max):法律与合规提示挂所有状态(登录前/登录中/已登录)——
  // 凭据复用 Claude Code 客户端身份有 ToS 风险,且此订阅不进对话模式,选择器里不可见。
  const workspaceOnlyWarning =
    provider.oauthStatus?.chatCapable === false ? (
      <div className="rounded-md border border-amber-300 bg-amber-50/60 px-3 py-2.5 md:col-span-2 dark:border-amber-900 dark:bg-amber-950/30">
        <div className="flex items-start gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          {t("settings:providers.oauth.workspace_only_title")}
        </div>
        <p className="mt-1 pl-6 text-xs leading-relaxed text-amber-800/90 dark:text-amber-300/90">
          {t("settings:providers.oauth.workspace_only_note")}
        </p>
        <a
          href="https://code.claude.com/docs/en/legal-and-compliance"
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-flex items-center gap-1 pl-6 text-xs font-medium text-amber-700 underline underline-offset-2 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
        >
          {t("settings:providers.oauth.legal_link")}
          <ExternalLink className="size-3" />
        </a>
      </div>
    ) : null;

  if (signedIn) {
    return (
      <>
        {workspaceOnlyWarning}
        <div className="rounded-md border border-emerald-200 bg-emerald-50/50 px-3 py-3 md:col-span-2 dark:border-emerald-900 dark:bg-emerald-950/30">
          <div className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="size-4" />
            {t("settings:providers.oauth.signed_in")}
          </div>
          <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {provider.oauthStatus?.accountId ? <div>{t("settings:providers.oauth.account", { id: provider.oauthStatus.accountId })}</div> : null}
            {provider.oauthStatus?.signedInAt ? <div>{t("settings:providers.oauth.signed_in_at", { time: new Date(provider.oauthStatus.signedInAt).toLocaleString() })}</div> : null}
          </div>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void logout()}>
            {t("settings:providers.oauth.logout")}
          </Button>
        </div>
      </>
    );
  }

  if (inProgress && authEvent) {
    return (
      <>
        {workspaceOnlyWarning}
        <div className="rounded-md border px-3 py-3 md:col-span-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Loader2 className="size-4 animate-spin" />
          {authEvent.phase === "select_method" && t("settings:providers.oauth.select_method")}
          {authEvent.phase === "waiting_input" && t("settings:providers.oauth.waiting_input")}
          {authEvent.phase === "waiting_browser" && t("settings:providers.oauth.waiting_browser")}
          {authEvent.phase === "waiting_device_code" &&
            (authEvent.deviceCode?.autoOpenUrl
              ? t("settings:providers.oauth.waiting_browser")
              : t("settings:providers.oauth.waiting_device_code"))}
          {authEvent.phase === "exchanging" && t("settings:providers.oauth.exchanging")}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {authEvent.phase === "waiting_input" ? (
            <div className="w-full space-y-2">
              {authEvent.message ? <p className="text-xs text-muted-foreground">{authEvent.message}</p> : null}
              <div className="flex gap-2">
                <Input
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder={authEvent.placeholder ?? ""}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !submitting) void submitTextInput();
                  }}
                />
                <Button size="sm" onClick={() => void submitTextInput()} disabled={submitting}>
                  {t("settings:providers.oauth.text_input_submit")}
                </Button>
              </div>
            </div>
          ) : null}
          {authEvent.phase === "select_method" && authEvent.methods ? (
            authEvent.methods.map((method) => (
              <Button key={method.id} variant="outline" size="sm" onClick={() => void submitMethod(method.id)} disabled={submitting}>
                {t(method.labelKey)}
              </Button>
            ))
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => void cancel()}>
            {t("settings:providers.oauth.cancel")}
          </Button>
        </div>
        {authEvent.phase === "waiting_browser" && authEvent.authUrl ? (
          <div className="mt-3 space-y-2">
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => void openExternal(authEvent.authUrl!)}>
                <ExternalLink className="mr-1 size-3" />
                {t("settings:providers.oauth.open_browser")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void copy(authEvent.authUrl!)}>
                {t("settings:providers.oauth.copy_url")}
              </Button>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("settings:providers.oauth.manual_code_hint")}</p>
              <div className="flex gap-2">
                <Input value={manualCode} onChange={(e) => setManualCode(e.target.value)} placeholder={t("settings:providers.oauth.manual_code_placeholder")} className="font-mono text-xs" />
                <Button size="sm" onClick={() => void submitManualCode()} disabled={!manualCode.trim()}>
                  {t("settings:providers.oauth.manual_code_submit")}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
        {authEvent.phase === "waiting_device_code" && authEvent.deviceCode ? (
          authEvent.deviceCode.autoOpenUrl ? (
            // 免输入完整链接(Kimi/Grok):视同浏览器登录,主行动=打开授权页面,验证码降为兜底。
            <div className="mt-3 space-y-2">
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => void openExternal(authEvent.deviceCode!.verificationUri)}>
                  <ExternalLink className="mr-1 size-3" />
                  {t("settings:providers.oauth.open_auth_page")}
                </Button>
                <Button variant="outline" size="sm" onClick={() => void copy(authEvent.deviceCode!.verificationUri)}>
                  {t("settings:providers.oauth.copy_url")}
                </Button>
              </div>
              <div className="flex items-center gap-3 rounded-md bg-muted px-3 py-2">
                <span className="text-xs text-muted-foreground">{t("settings:providers.oauth.device_code_fallback_hint")}</span>
                <span className="font-mono text-lg font-bold tracking-widest">{authEvent.deviceCode.userCode}</span>
                <Button variant="ghost" size="sm" onClick={() => void copy(authEvent.deviceCode!.userCode)}>
                  {t("settings:providers.oauth.copy_code")}
                </Button>
              </div>
              {authEvent.deviceCode.expiresInSeconds ? (
                <p className="text-xs text-muted-foreground">{t("settings:providers.oauth.device_code_expires", { minutes: Math.ceil(authEvent.deviceCode.expiresInSeconds / 60) })}</p>
              ) : null}
            </div>
          ) : (
            // 裸地址(Copilot / ChatGPT 设备码):授权页不预填,验证码保持大字便于手抄。
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-3 rounded-md bg-muted px-3 py-2">
                <span className="font-mono text-2xl font-bold tracking-widest">{authEvent.deviceCode.userCode}</span>
                <Button variant="ghost" size="sm" onClick={() => void copy(authEvent.deviceCode!.userCode)}>
                  {t("settings:providers.oauth.copy_code")}
                </Button>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="break-all">{authEvent.deviceCode.verificationUri}</span>
                <Button variant="outline" size="sm" onClick={() => void openExternal(authEvent.deviceCode!.verificationUri)}>
                  <ExternalLink className="size-3" />
                </Button>
              </div>
              {authEvent.deviceCode.expiresInSeconds ? (
                <p className="text-xs text-muted-foreground">{t("settings:providers.oauth.device_code_expires", { minutes: Math.ceil(authEvent.deviceCode.expiresInSeconds / 60) })}</p>
              ) : null}
            </div>
          )
        ) : null}
        </div>
      </>
    );
  }

  return (
    <>
      {workspaceOnlyWarning}
      <div className="rounded-md border border-dashed px-3 py-3 md:col-span-2">
        <p className="text-sm text-muted-foreground">{t("settings:providers.oauth.not_signed_in")}</p>
        <Button size="sm" className="mt-2" onClick={() => void start()} disabled={submitting}>
          {submitting ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
          {t("settings:providers.oauth.login")}
        </Button>
      </div>
    </>
  );
}

// Best-effort model-type inference from model id; falls back to CHAT when nothing matches.
// Used to pre-fill the per-model type selector when the user toggles a model on. Users can
// always override in the model row (parity with Android, which makes this manual).
function inferModelType(modelId: string): "CHAT" | "IMAGE" | "EMBEDDING" {
  const id = String(modelId ?? "").toLowerCase();
  if (!id) return "CHAT";
  if (
    /(text-embedding|^embedding|-embed(ding)?|bge|e5|gte|m3-embedding|nomic-embed|jina-embed)/.test(
      id,
    )
  )
    return "EMBEDDING";
  if (
    /(gpt-image|dall-e|dalle|imagen|stable-diffusion|sd[\d-]|flux|midjourney|kolors|qwen-image|wanx|hunyuan-dit|seedream|cogview|recraft)/.test(
      id,
    )
  )
    return "IMAGE";
  return "CHAT";
}

function applyAutoModelType<M extends { modelId?: string; type?: string }>(model: M): M {
  if (model.type && model.type !== "CHAT") return model;
  const inferred = inferModelType(String(model.modelId ?? ""));
  if (inferred === "CHAT") return model;
  return { ...model, type: inferred };
}

// ── Manual-models cache (in-memory, per provider) ────────────────────────────
// Only manually-added models (manuallyAdded === true) are cached here — fetched models are
// NOT. The point: a manual model has no upstream source to re-fetch from, so once the user
// creates it we must never let it vanish from the list just because they toggled it off (or
// navigated away and back, which clears the in-memory fetchedModels state). Toggling a
// manual model off removes it from draft.models (the enabled list) but it stays here, so the
// row remains visible with a dimmed checkbox. Fetched models keep their original behavior:
// off + a page switch → gone (the user can just re-fetch).
//
// Module scope ⇒ survives component unmount (page/provider switches) but not an app restart.
// On restart we fall back to draft.models; a manual model that was toggled off (and thus not
// in draft.models) is lost — accepted, since this is an in-memory-only convenience.
const manualModelsByProvider = new Map<string, Map<string, ProviderModel>>();

function rememberManualModel(providerId: string, model: ProviderModel): void {
  let bucket = manualModelsByProvider.get(providerId);
  if (!bucket) {
    bucket = new Map();
    manualModelsByProvider.set(providerId, bucket);
  }
  // Keep the identity-stable id on update; refresh everything else from the incoming model
  // so edits (display name, abilities, …) propagate to the cached copy too.
  const existing = bucket.get(model.modelId);
  bucket.set(model.modelId, existing ? { ...existing, ...model, id: existing.id } : model);
}

function forgetManualModel(providerId: string, modelId: string): void {
  manualModelsByProvider.get(providerId)?.delete(modelId);
}

function providerKind(provider: ProviderProfile): string {
  return textValue(provider.type) || "openai";
}

function balanceOptionOf(provider: ProviderProfile): Record<string, unknown> {
  return provider.balanceOption && typeof provider.balanceOption === "object"
    ? (provider.balanceOption as Record<string, unknown>)
    : {};
}

function defaultPathForKind(kind: ProviderKind, responseApi = false): string {
  if (kind === "openai") return responseApi ? "/responses" : "/chat/completions";
  if (kind === "claude") return "/messages";
  return "/models/{model}:generateContent";
}

// 预置供应商的"获取 API Key"官网映射。按 baseUrl 子串匹配(大小写无关)。
// 供应商表单的 API Key 标签旁,命中即显示一个靠右的"获取 API Key"链接,跳转官网。
// 新增预置供应商时只需在这里加一行 { 子串: 官网 URL }。
const PROVIDER_GET_KEY_URLS: Array<{ match: RegExp; url: string }> = [
  { match: /naapi\.cc/i, url: "https://naapi.cc/" },
];
function providerGetKeyUrl(baseUrl: string): string | null {
  for (const entry of PROVIDER_GET_KEY_URLS) {
    if (entry.match.test(baseUrl)) return entry.url;
  }
  return null;
}

function endpointPreview(provider: ProviderProfile): string {
  const kind = providerKind(provider) as ProviderKind;
  const base = textValue(provider.baseUrl).replace(/\/+$/, "");
  if (!base) return defaultPathForKind(kind, provider.useResponseApi === true);
  if (kind === "openai")
    return `${base}${provider.useResponseApi === true ? textValue(provider.responsesPath) || "/responses" : textValue(provider.chatCompletionsPath) || "/chat/completions"}`;
  // claude 拼接标准化(A):与服务端 endpointFor 同款规则(剥尾部 /v1 拼 /v1/messages),
  // 预览即真实请求 URL,带不带 /v1 都能工作。
  if (kind === "claude") return `${base.replace(/\/v1$/, "")}/v1/messages`;
  // issue10:Gemini 鉴权已改走 x-goog-api-key 头,URL 不再带 ?key=,预览同步。
  return `${base}/models/{model}:generateContent`;
}

function modelListEndpointPreview(provider: ProviderProfile): string {
  const kind = providerKind(provider) as ProviderKind;
  const base = textValue(provider.baseUrl).replace(/\/+$/, "");
  if (!base) return kind === "google" ? "/models?pageSize=100" : "/models";
  if (kind === "google") return `${base}/models?pageSize=100`;
  // claude 拼接标准化(A):与服务端 modelsEndpointFor 同款规则。
  if (kind === "claude") return `${base.replace(/\/v1$/, "")}/v1/models`;
  return `${base}/models`;
}

function createProvider(): ProviderProfile {
  return {
    id: createId(),
    type: "openai",
    enabled: true,
    name: "自定义供应商",
    builtIn: false,
    shortDescription: "用户添加的 OpenAI-compatible API",
    description: "",
    apiKey: "",
    baseUrl: "https://api.example.com/v1",
    chatCompletionsPath: "/chat/completions",
    useResponseApi: false,
    responsesPath: "/responses",
    // 与安卓 OpenAI provider 默认值一致 (commit e63d017)
    includeHistoryReasoning: true,
    models: [],
    balanceOption: { enabled: false, apiPath: "/credits", resultPath: "data.total_credits" },
  };
}

function normalizeKindPatch(provider: ProviderProfile, kind: ProviderKind): ProviderProfile {
  return {
    ...provider,
    type: kind,
    baseUrl: baseUrlForKindSwitch(provider.id, textValue(provider.baseUrl), kind),
    useResponseApi: kind === "openai" ? provider.useResponseApi === true : false,
    chatCompletionsPath: defaultPathForKind(
      kind,
      kind === "openai" && provider.useResponseApi === true,
    ),
    // kind 切换时把 responsesPath 一并归位默认,避免切到 openai+ResponseAPI 时残留旧自定义路径。
    responsesPath: "/responses",
  };
}

export function ProvidersSection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  // URL ?providerId= deep-link is only honored on first mount, so subsequent settings updates
  // (autosave, SSE) don't snap the selection back to the URL value or the default first provider.
  const initialProviderId = React.useMemo(() => {
    if (typeof window === "undefined") return settings.providers[0]?.id ?? "";
    const providerId = new URLSearchParams(window.location.search).get("providerId");
    if (providerId && settings.providers.some((provider) => provider.id === providerId))
      return providerId;
    return settings.providers[0]?.id ?? "";
    // Intentionally empty deps: capture only the initial value. We don't want to re-derive on
    // every settings update because that pulls selectedId back to the default.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const urlProviderId = React.useMemo(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("providerId");
  }, []);
  const focusedModelId = React.useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("modelId") ?? "";
  }, []);
  const [selectedId, setSelectedId] = React.useState(initialProviderId);
  const selected =
    settings.providers.find((provider) => provider.id === selectedId) ?? settings.providers[0];
  const [draft, setDraft] = React.useState<ProviderProfile | null>(
    selected ? clone(selected) : null,
  );
  const [testing, setTesting] = React.useState(false);
  const [fetchingModels, setFetchingModels] = React.useState(false);
  const [testResult, setTestResult] = React.useState("");
  const [testChecks, setTestChecks] = React.useState<ProviderTestCheck[]>([]);
  const [testInfo, setTestInfo] = React.useState<ProviderTestInfo | null>(null);
  const [checkingBalance, setCheckingBalance] = React.useState(false);
  const [balanceResult, setBalanceResult] = React.useState("");
  const [fetchedModels, setFetchedModels] = React.useState<ProviderModel[]>([]);
  // Free-text filter for the model list. Cleared whenever the user switches provider.
  const [modelFilter, setModelFilter] = React.useState("");
  const [testModelId, setTestModelId] = React.useState("");
  const [imageTestResult, setImageTestResult] = React.useState<{
    url: string;
    durationMs: number;
    modelId: string;
    prompt: string;
  } | null>(null);
  // R8-2:防抖自动保存统一走共享三件套 hook(保存窗口内键击不丢,语义见 hook 文件头)。
  const autosave = useAutosaveDraft(
    async () => {
      if (!draft) return;
      await api.post("settings/provider", draft);
      onSettings({
        ...settings,
        providers: settings.providers.map((provider) =>
          provider.id === draft.id ? draft : provider,
        ),
      });
    },
    { onSaveError: (error) => toast.error((error as Error).message || t("settings:providers.autosave_failed")) },
  );
  const lastSelectedRef = React.useRef(selectedId);

  // Only honor ?providerId=... deep-link navigation when the URL parameter is actually present
  // AND it differs from current selection. Otherwise (no URL param), do not reassert anything —
  // the user's clicks must win.
  React.useEffect(() => {
    if (!urlProviderId) return;
    if (urlProviderId === selectedId) return;
    if (!settings.providers.some((provider) => provider.id === urlProviderId)) return;
    setSelectedId(urlProviderId);
  }, [urlProviderId, selectedId, settings.providers]);

  // providersRef lets this realignment effect read the freshest providers list without
  // depending on settings.providers — otherwise every autosave → onSettings round-trip
  // re-fires the effect and overwrites mid-flight keystrokes. Same class of bug as
  // McpServerEditor; see there for the full rationale.
  const providersRef = React.useRef(settings.providers);
  providersRef.current = settings.providers;
  React.useEffect(() => {
    const next =
      providersRef.current.find((provider) => provider.id === selectedId) ?? providersRef.current[0];
    const selectedChanged = lastSelectedRef.current !== selectedId;
    lastSelectedRef.current = selectedId;
    setDraft(next ? clone(next) : null);
    autosave.reset();
    if (selectedChanged) {
      setFetchedModels([]);
      setModelFilter("");
      setTestResult("");
      setTestChecks([]);
      setTestInfo(null);
      setBalanceResult("");
      setImageTestResult(null);
      setTestModelId(next?.models?.find((model) => model.modelId !== "auto")?.modelId ?? "");
    }
  }, [selectedId]);

  // 登录/登出是服务端写路径(commitLogin 置 enabled=true 并铺入捆绑模型,logoutProvider 置
  // enabled=false 剥 oauth),而 draft 刻意不随 SSE 刷新(防键击被覆盖)。只在登录态翻转
  // 这一离散时刻把 draft 重新对齐服务端真值,否则模型列表/启用开关要等重新选中才更新,
  // 且后续自动保存会把过期的 enabled 回写。
  const signedIn = selected?.oauthStatus?.signedIn === true;
  const lastSignedInRef = React.useRef(signedIn);
  React.useEffect(() => {
    if (lastSignedInRef.current === signedIn) return;
    lastSignedInRef.current = signedIn;
    if (!selected) return;
    setDraft(clone(selected));
    // discard 而非 reset:reset 会把防抖窗口内的脏编辑「补发」出去,而此处的补发拿到的
    // 仍是上一次渲染的 save 闭包(setDraft 尚未重渲染),POST 的是登录前的旧 draft——
    // 服务端护栏只保护 oauth/authMode,models/enabled 会被旧值覆盖(刚登录铺好的捆绑
    // 模型丢失、enabled 可能被写回 false)。登录态翻转即以服务端真值为准,旧编辑必须丢弃。
    void autosave.discard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, selected?.id]);

  if (!draft) return null;
  const balanceOption = balanceOptionOf(draft);
  const kind = providerKind(draft) as ProviderKind;
  const selectedModelIds = new Set((draft.models ?? []).map((model) => model.modelId));
  // Display source: merge fetchedModels with draft.models, deduping by modelId. Fetched
  // entries win on overlap (canonical upstream view); manually-added extras are appended.
  // Persisted per-row customizations are still applied downstream via the `persisted` lookup.
  // Manual models that were toggled off (absent from draft.models) are re-merged from the
  // in-memory manual cache so they stay visible instead of disappearing — see
  // manualModelsByProvider above. Fetched models are NOT cached: toggled off + a page switch
  // still clears them (re-fetch to bring them back), preserving the original behavior.
  const displayModels: ProviderModel[] = (() => {
    const fetched = fetchedModels;
    const drafts = draft.models ?? [];
    const fetchedIds = new Set(fetched.map((m) => m.modelId));
    // Start from fetched (canonical) + drafts not in fetched.
    const base = fetched.length === 0 ? drafts : [...fetched, ...drafts.filter((m) => !fetchedIds.has(m.modelId))];
    // Re-add cached manual models that have dropped out of draft.models (toggled off).
    const baseIds = new Set(base.map((m) => m.modelId));
    const cachedManual = manualModelsByProvider.get(draft.id);
    const danglingManual = cachedManual
      ? Array.from(cachedManual.values()).filter((m) => !baseIds.has(m.modelId))
      : [];
    const merged = danglingManual.length > 0 ? [...base, ...danglingManual] : base;
    // Manual models float to the top — they're user-authored (no upstream source) and tend to
    // be the ones the user cares about most; newly-added ones already sit at the head of
    // draft.models, so this surfaces them immediately instead of burying them under the
    // fetched list. Stable order preserved within each group.
    if (merged.length <= 1) return merged;
    const manual: ProviderModel[] = [];
    const rest: ProviderModel[] = [];
    for (const model of merged) {
      (model.manuallyAdded === true ? manual : rest).push(model);
    }
    return manual.length > 0 ? [...manual, ...rest] : rest;
  })();
  // Free-text filter (name or id). Applied on top of displayModels for the list view.
  const visibleModels = (() => {
    const query = modelFilter.trim().toLowerCase();
    if (!query) return displayModels;
    return displayModels.filter(
      (model) =>
        (model.displayName ?? "").toLowerCase().includes(query) ||
        (model.modelId ?? "").toLowerCase().includes(query),
    );
  })();
  // Whether every currently-visible (filtered) model is already enabled — drives the
  // select-all toggle label + click behavior. Acts on visibleModels, not the full set,
  // so "select filtered" works intuitively when searching.
  const allFilteredEnabled =
    visibleModels.length > 0 && visibleModels.every((model) => selectedModelIds.has(model.modelId));
  const fetchedModelIds = new Set(fetchedModels.map((model) => model.modelId));
  const mergedTestModels = [
    ...fetchedModels,
    ...(draft.models ?? []).filter(
      (model) => model.modelId !== "auto" && !fetchedModelIds.has(model.modelId),
    ),
  ].filter((model) => model.modelId !== "auto");
  const effectiveTestModelId =
    (testModelId && mergedTestModels.some((model) => model.modelId === testModelId)
      ? testModelId
      : mergedTestModels[0]?.modelId) || "";
  // The selected test model's persisted record drives whether we run the image-gen test path
  // (and hide the 3-mode chat panel) vs the chat test path.
  const effectiveTestModelType = (() => {
    const persisted = (draft.models ?? []).find((item) => item.modelId === effectiveTestModelId);
    const merged = mergedTestModels.find((item) => item.modelId === effectiveTestModelId);
    return String(persisted?.type ?? merged?.type ?? "CHAT").toUpperCase();
  })();
  const isImageTestMode = effectiveTestModelType === "IMAGE";

  const patchDraft = (patch: Partial<ProviderProfile>) => {
    autosave.markDirty();
    setDraft({ ...draft, ...patch });
  };
  // 测试/查余额前的"确保服务端拿到当前草稿"。force:与原实现一致,无条件落一次。
  const save = () => autosave.saveNow({ force: true });
  const test = async () => {
    setTesting(true);
    setTestChecks([]);
    setTestInfo(null);
    setImageTestResult(null);
    // If user picked an IMAGE-type model, run a dedicated image-generation test instead of
    // the 3-mode chat test. Matches Android, which never tries chat completions for IMAGE models.
    const requestedModelId = effectiveTestModelId;
    const selectedTestModel =
      (draft.models ?? []).find((item) => item.modelId === requestedModelId) ??
      mergedTestModels.find((item) => item.modelId === requestedModelId) ??
      null;
    if (selectedTestModel && (selectedTestModel.type as string) === "IMAGE") {
      setTestResult(t("settings:providers.test_img_starting"));
      try {
        await save();
        const started = Date.now();
        const response = await api.post<{
          status: string;
          image: { url: string; mime: string; fileName: string };
        }>(
          "settings/provider/test/image",
          { providerId: draft.id, modelId: requestedModelId },
          { timeout: false },
        );
        const durationMs = Date.now() - started;
        const url = response.image?.url ?? "";
        setImageTestResult({
          url,
          durationMs,
          modelId: requestedModelId,
          prompt: "A red apple on a white background",
        });
        setTestResult(
          t("settings:providers.test_img_done", {
            model: requestedModelId,
            duration: (durationMs / 1000).toFixed(2),
            file: response.image?.fileName ?? "-",
          }),
        );
        onSettings(await api.get<Settings>("settings"));
        toast.success(t("settings:providers.test_img_ok"));
      } catch (error) {
        const message = error instanceof Error ? error.message : t("settings:providers.test_img_failed");
        setTestResult(message);
        toast.error(message);
      } finally {
        setTesting(false);
      }
      return;
    }
    setTestResult(t("settings:providers.test_starting"));
    try {
      await save();
      const response = await fetch(appendWebAuthQuery("/api/settings/provider/test/stream"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ providerId: draft.id, modelId: requestedModelId || undefined }),
      });
      if (!response.ok || !response.body) {
        if (response.status !== 404) {
          const text = await response.text();
          throw new Error(text || `HTTP ${response.status}`);
        }
        const fallback = await api.post<ProviderTestInfo>(
          "settings/provider/test",
          { providerId: draft.id, modelId: requestedModelId || undefined },
          { timeout: false },
        );
        const checks = (fallback.checks ?? [])
          .map(
            (item) =>
              `${item.ok ? "✓" : "×"} ${item.mode}: ${item.status || "failed"}\n${item.preview}`,
          )
          .join("\n\n");
        setTestInfo(fallback);
        setTestChecks(fallback.checks ?? []);
        setTestModelId(fallback.testModelId);
        setTestResult(
          t("settings:providers.test_done_fallback", {
            model: fallback.testModelId,
            endpoint: fallback.endpoint,
            chatEndpoint: fallback.responseApiEndpoint,
            count: fallback.modelCount,
            checks,
            preview: fallback.preview,
          }),
        );
        onSettings(await api.get<Settings>("settings"));
        toast.success(t("settings:providers.test_done_ok"));
        return;
      }
      const checks: ProviderTestCheck[] = [];
      let info: ProviderTestInfo | null = null;
      const renderResult = (prefix = "") => {
        setTestInfo(info);
        setTestChecks([...checks]);
        const header = info
          ? t("settings:providers.test_header", {
              model: info.testModelId || effectiveTestModelId,
              endpoint: info.endpoint,
              chatEndpoint: info.responseApiEndpoint,
              count: info.modelCount,
            })
          : t("settings:providers.test_header_pending", {
              model: effectiveTestModelId || t("settings:providers.auto_selecting"),
            });
        const checkText = checks
          .map(
            (item) =>
              `${item.ok ? "✓" : "×"} ${item.mode}: ${item.status || "failed"}\n${item.preview}`,
          )
          .join("\n\n");
        const preview = info?.preview ? t("settings:providers.test_preview", { preview: info.preview }) : "";
        setTestResult([prefix, header, checkText, preview].filter(Boolean).join("\n\n"));
      };
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\n\n+/);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const event =
            block
              .split(/\r?\n/)
              .find((line) => line.startsWith("event:"))
              ?.slice(6)
              .trim() ?? "message";
          const dataText = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (!dataText) continue;
          const data = JSON.parse(dataText) as Record<string, unknown>;
          if (event === "progress") {
            renderResult(String(data.message ?? t("settings:providers.testing")));
          } else if (event === "models") {
            info = data as unknown as ProviderTestInfo;
            if (info.testModelId) setTestModelId(info.testModelId);
            renderResult(t("settings:providers.models_read"));
          } else if (event === "check") {
            checks.push(data as unknown as ProviderTestCheck);
            renderResult(t("settings:providers.test_in_progress"));
          } else if (event === "done") {
            info = data as unknown as ProviderTestInfo;
            if (Array.isArray(info.checks)) checks.splice(0, checks.length, ...info.checks);
            if (info.testModelId) setTestModelId(info.testModelId);
            renderResult(t("settings:providers.test_complete"));
          } else if (event === "error") {
            throw new Error(String(data.error ?? t("settings:providers.test_error")));
          }
        }
      }
      onSettings(await api.get<Settings>("settings"));
      toast.success(t("settings:providers.test_success"));
    } catch (error) {
      const message = error instanceof Error ? error.message : t("settings:providers.test_failed");
      setTestInfo(null);
      setTestChecks([]);
      setTestResult(message);
      toast.error(message);
    } finally {
      setTesting(false);
    }
  };
  const fetchModels = async () => {
    // 订阅供应商:凭据在服务端 oauth 里,前端 apiKey 恒空——闸门看 oauthStatus 而非 apiKey。
    if (draft.authMode !== "oauth" && !textValue(draft.apiKey).trim()) {
      toast.error(t("settings:providers.key_required_fetch"));
      return;
    }
    setFetchingModels(true);
    try {
      await api.post("settings/provider", draft);
      const result = await api.post<{ endpoint: string; models: ProviderModel[] }>(
        "settings/provider/models",
        { providerId: draft.id },
      );
      setFetchedModels(result.models);
      setTestModelId(result.models.find((model) => model.modelId !== "auto")?.modelId ?? "");
      toast.success(t("settings:providers.fetched_models", { count: result.models.length }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:providers.fetch_failed"));
    } finally {
      setFetchingModels(false);
    }
  };
  const handleToggleEnabled = async (enabled: boolean) => {
    // 关闭：直接关
    if (!enabled) {
      patchDraft({ enabled: false });
      return;
    }
    // 已有已启用模型（历史 / 用户此前已勾选）：直接启用，不自动拉取
    if ((draft.models ?? []).length > 0) {
      patchDraft({ enabled: true });
      return;
    }
    // 空列表：先持久化当前配置（让服务端拿到最新 baseUrl / apiKey），再拉取上游模型
    // 订阅供应商:凭据在服务端 oauth 里,前端 apiKey 恒空——闸门看 oauthStatus 而非 apiKey。
    if (draft.authMode !== "oauth" && !textValue(draft.apiKey).trim()) {
      toast.error(t("settings:providers.key_required_enable"));
      return;
    }
    setFetchingModels(true);
    try {
      await api.post("settings/provider", draft);
      const result = await api.post<{ endpoint: string; models: ProviderModel[] }>(
        "settings/provider/models",
        { providerId: draft.id },
      );
      if (!result.models.length) {
        toast.error(t("settings:providers.no_models_enable"));
        return;
      }
      // 与单个勾选时一致地分类 CHAT / IMAGE / EMBEDDING
      const models = result.models.map(applyAutoModelType);
      setFetchedModels(result.models);
      patchDraft({ enabled: true, models });
      toast.success(t("settings:providers.enabled_models", { count: models.length }));
    } catch (error) {
      // 不 patch enabled —— 保持关闭
      toast.error(error instanceof Error ? error.message : t("settings:providers.enable_fetch_failed"));
    } finally {
      setFetchingModels(false);
    }
  };
  const checkBalance = async () => {
    setCheckingBalance(true);
    setBalanceResult(t("settings:providers.balance_querying"));
    try {
      await save();
      const result = await api.post<{ value: string; endpoint: string; preview: string }>(
        "settings/provider/balance",
        { providerId: draft.id },
        { timeout: false },
      );
      setBalanceResult(t("settings:providers.balance_done", { value: result.value, endpoint: result.endpoint, preview: result.preview }));
      toast.success(t("settings:providers.balance_ok", { value: result.value }));
    } catch (error) {
      const message = error instanceof Error ? error.message : t("settings:providers.balance_failed");
      setBalanceResult(message);
      toast.error(message);
    } finally {
      setCheckingBalance(false);
    }
  };
  const toggleModel = (model: ProviderModel, checked: boolean) => {
    const models = checked
      ? // Auto-fill type for newly enabled models (CHAT/IMAGE/EMBEDDING) — user can override per-row.
        [...(draft.models ?? []), applyAutoModelType(model)].filter(
          (item, index, arr) => arr.findIndex((x) => x.modelId === item.modelId) === index,
        )
      : (draft.models ?? []).filter((item) => item.modelId !== model.modelId);
    patchDraft({ models });
  };
  const toggleModelAbility = (modelId: string, ability: "TOOL" | "REASONING", enabled: boolean) => {
    const models = (draft.models ?? []).map((item) => {
      if (item.modelId !== modelId) return item;
      const current = Array.isArray(item.abilities) ? item.abilities : [];
      const next = enabled
        ? Array.from(new Set([...current, ability]))
        : current.filter((value) => value !== ability);
      return { ...item, abilities: next };
    });
    patchDraft({ models });
  };
  // Batch enable/disable for the "select all" toolbar. Acts on a given set of models
  // (the currently-visible filtered set): enable adds any missing ones (auto-typed),
  // disable removes them. Mirrors toggleModel's dedupe + applyAutoModelType semantics.
  const setModelsEnabled = (modelsToToggle: ProviderModel[], enabled: boolean) => {
    const ids = new Set(modelsToToggle.map((model) => model.modelId));
    if (enabled) {
      const existingIds = new Set((draft.models ?? []).map((model) => model.modelId));
      const additions = modelsToToggle
        .filter((model) => !existingIds.has(model.modelId))
        .map(applyAutoModelType);
      if (additions.length === 0) return;
      patchDraft({ models: [...(draft.models ?? []), ...additions] });
    } else {
      const remaining = (draft.models ?? []).filter((model) => !ids.has(model.modelId));
      if (remaining.length === (draft.models ?? []).length) return;
      patchDraft({ models: remaining });
    }
  };
  // -------- Model add/edit dialog state ----------------------------------------------------
  // Single dialog instance reused for both add (+ button) and edit (row click). The mode +
  // modelIdLocked flags determine the dialog UX. State is reset every time the dialog opens
  // (see ModelEditDialog's useEffect on `open`), so reusing one instance is safe.
  type ModelDialogState = {
    mode: "add" | "edit";
    model: ProviderModel;
    modelIdLocked: boolean;
  };
  const [modelDialog, setModelDialog] = React.useState<ModelDialogState | null>(null);

  const openAddModelDialog = () => {
    if (!draft) return;
    const uuid = createId();
    setModelDialog({
      mode: "add",
      modelIdLocked: false,
      model: {
        id: uuid,
        modelId: "",
        displayName: "",
        type: "CHAT",
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
        abilities: [],
        tools: [],
        customHeaders: [],
        customBodies: [],
        manuallyAdded: true,
      },
    });
  };

  const openEditModelDialog = (model: ProviderModel) => {
    if (!draft) return;
    // Prefer the persisted entry (with the user's prior customizations) over the fetched one.
    // If model isn't enabled yet, fall back to the fetched row — saving will auto-enable.
    const persisted = (draft.models ?? []).find((item) => item.modelId === model.modelId);
    const source = persisted ?? model;
    // Manually-added models keep ID editable; everything else (fetched, legacy) is locked
    // because the modelId is sent verbatim to the upstream API and editing it would silently
    // break request routing. See pc-server/inference-engine/providers.ts.
    const isManual = source.manuallyAdded === true;
    setModelDialog({
      mode: "edit",
      modelIdLocked: !isManual,
      model: { ...source },
    });
  };

  const handleModelDialogSave = (model: ProviderModel) => {
    if (!draft || !modelDialog) return;
    const existing = (draft.models ?? []).find((item) => item.id === model.id);
    let models: ProviderModel[];
    if (existing) {
      // Edit existing persisted model — replace by UUID id (stable across re-fetches).
      models = (draft.models ?? []).map((item) => (item.id === model.id ? model : item));
    } else if (modelDialog.mode === "add") {
      // Brand-new manual add — also reject duplicate modelId to avoid confusing dedup behavior
      // downstream (toggleModel matches by modelId, not id, so a clash would orphan the new one).
      const clash = (draft.models ?? []).some((item) => item.modelId === model.modelId);
      if (clash) {
        toast.error(t("settings:providers.model_id_exists", { id: model.modelId }));
        return;
      }
      models = [model, ...(draft.models ?? [])];
    } else {
      // Edit dialog opened on a fetched-but-not-yet-enabled row → save auto-enables.
      // Dedup by modelId in case the user toggled the checkbox in parallel.
      const without = (draft.models ?? []).filter((item) => item.modelId !== model.modelId);
      models = [...without, model];
    }
    patchDraft({ models });
    // Cache manual models so toggling them off later doesn't erase them from the list
    // (they have no upstream source to re-fetch from). Also refreshes the cached copy on edit
    // so display-name/ability changes propagate. Fetched models are intentionally not cached.
    if (model.manuallyAdded === true) rememberManualModel(draft.id, model);
    toast.success(modelDialog.mode === "add" ? t("settings:providers.model_added") : t("settings:providers.model_saved"));
  };

  const handleModelDialogDelete = () => {
    if (!draft || !modelDialog) return;
    const target = modelDialog.model;
    // Remove by both id AND modelId to be safe — if the model came from a fetched row whose
    // id wasn't yet in draft.models, the id match alone wouldn't find anything.
    patchDraft({
      models: (draft.models ?? []).filter(
        (item) => item.id !== target.id && item.modelId !== target.modelId,
      ),
    });
    // Drop from the manual cache too, otherwise the deleted row would linger in the list.
    if (target.manuallyAdded === true) forgetManualModel(draft.id, target.modelId);
    toast.success(t("settings:providers.model_deleted"));
  };
  const addProvider = async () => {
    const next = createProvider();
    next.name = t("settings:providers.custom_name");
    next.shortDescription = t("settings:providers.custom_desc");
    await api.post("settings/provider", next);
    onSettings({ ...settings, providers: [...settings.providers, next] });
    setSelectedId(next.id);
    toast.success(t("settings:providers.added"));
  };
  const moveProvider = async (from: number, to: number) => {
    const nextProviders = moveItem(settings.providers, from, to);
    onSettings({ ...settings, providers: nextProviders });
    await api.post("settings/provider/reorder", {
      ids: nextProviders.map((provider) => provider.id),
    });
  };
  const testModeLabels: Record<ProviderTestMode, string> = {
    non_stream: t("settings:providers.mode_non_stream"),
    stream: t("settings:providers.mode_stream"),
    tools: t("settings:providers.mode_tools"),
  };

  return (
    <>
      <SectionHeader
        icon={KeyRound}
        title={t("settings:providers.title")}
        subtitle={t("settings:providers.subtitle")}
      />
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="rounded-lg border bg-card p-2">
          <Button className="mb-2 w-full justify-start" variant="outline" onClick={addProvider}>
            <Plus className="size-4" />
            {t("settings:providers.add")}
          </Button>
          {settings.providers.map((provider, index) => (
            <SortableRow
              key={provider.id}
              id={provider.id}
              index={index}
              active={provider.id === draft.id}
              onSelect={() => setSelectedId(provider.id)}
              onMove={moveProvider}
            >
              <span className="grid min-w-0 grid-cols-[28px_10px_minmax(0,1fr)_auto_16px] items-center gap-2 text-left">
                <AIIcon name={provider.name} size={24} className="justify-self-start" />
                <span
                  className={`size-2 rounded-full ${provider.enabled ? "bg-success" : "bg-muted-foreground/40"}`}
                />
                <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                {provider.authMode === "oauth" ? (
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    {t("settings:providers.oauth.badge")}
                  </span>
                ) : null}
                {provider.builtIn ? <Check className="size-3 text-primary" /> : null}
              </span>
            </SortableRow>
          ))}
        </div>
        <div className="space-y-5 rounded-lg border bg-card p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-lg font-medium">{draft.name}</div>
              <div className="text-xs text-muted-foreground">
                {textValue(draft.shortDescription) || providerKind(draft)}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{t("settings:providers.enabled_label")}</span>
              <Switch
                checked={draft.enabled}
                disabled={fetchingModels}
                onCheckedChange={(enabled) => void handleToggleEnabled(enabled)}
              />
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-2">
              <span className="text-sm font-medium">{t("settings:providers.name")}</span>
              <Input
                value={draft.name}
                onChange={(event) => patchDraft({ name: event.target.value })}
              />
            </label>
            {draft.authMode !== "oauth" ? (
              <label className="space-y-2">
                <span className="text-sm font-medium">{t("settings:providers.type")}</span>
                <Select
                  value={kind}
                  onValueChange={(value) => {
                    // 类型切换也是编辑,必须置脏,否则永不自动保存(复审 F3 补获)
                    autosave.markDirty();
                    const next = normalizeKindPatch(draft, value as ProviderKind);
                    // 按登记表/协议默认换算过地址时告知用户去向;自定义地址不动则不打扰
                    if (next.baseUrl !== textValue(draft.baseUrl) && textValue(draft.baseUrl)) {
                      toast(t("settings:providers.base_url_switched", { url: next.baseUrl }));
                    }
                    setDraft(next);
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">OpenAI-compatible</SelectItem>
                    <SelectItem value="claude">Anthropic Claude</SelectItem>
                    <SelectItem value="google">Google Gemini</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            ) : null}
            {draft.authMode === "oauth" ? (
              // 登录态读 SSE 真值(selected)而非 draft:draft 只在切换供应商/登录态翻转时重对齐,
              // 用 draft 会让卡片在登出/登录后仍停留在旧状态。
              // key 绑 provider.id:切换供应商时强制重挂载,清掉上次残留的 manualCode/textInput/
              // 已打开授权 URL 等瞬态——否则 A 供应商输入的授权码会带进 B 的登录框。
              <ProviderLoginPanel key={(selected ?? draft).id} provider={selected ?? draft} />
            ) : (
              <label className="space-y-2 md:col-span-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">API Key</span>
                  {providerGetKeyUrl(textValue(draft.baseUrl)) ? (
                    <button
                      type="button"
                      onClick={() => void openExternal(providerGetKeyUrl(textValue(draft.baseUrl))!)}
                      className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      title={t("settings:providers.get_key_title")}
                    >
                      <ExternalLink className="size-3" />
                      {t("settings:providers.get_key")}
                    </button>
                  ) : null}
                </div>
                <PasswordInput
                  value={textValue(draft.apiKey)}
                  onChange={(apiKey) => patchDraft({ apiKey })}
                />
              </label>
            )}
            {draft.authMode !== "oauth" ? (
              <>
                <label className="space-y-2 md:col-span-2">
                  <span className="text-sm font-medium">Base URL</span>
                  <Input
                    value={textValue(draft.baseUrl)}
                    onChange={(event) => patchDraft({ baseUrl: event.target.value })}
                    placeholder={DEFAULT_BASE_URLS[kind]}
                  />
                  <span className="block break-all text-xs text-muted-foreground">
                    {t("settings:providers.chat_url", { url: endpointPreview(draft) })}
                  </span>
                  <span className="block break-all text-xs text-muted-foreground">
                    {t("settings:providers.models_url", { url: modelListEndpointPreview(draft) })}
                  </span>
                </label>
                <div className="grid gap-x-6 gap-y-3 rounded-md border px-3 py-3 md:col-span-2 md:grid-cols-2">
                  <label className="space-y-2">
                    {/* 单输入框按开关切换绑定字段(对齐安卓 ProviderConfigure):关→chatCompletionsPath,开→responsesPath */}
                    <span className="text-sm font-medium">
                      {draft.useResponseApi === true
                        ? t("settings:providers.responses_path_label")
                        : t("settings:providers.chat_completions_path_label")}
                    </span>
                    <Input
                      disabled={kind !== "openai"}
                      value={
                        draft.useResponseApi === true
                          ? textValue(draft.responsesPath) || "/responses"
                          : textValue(draft.chatCompletionsPath) || defaultPathForKind(kind, false)
                      }
                      onChange={(event) =>
                        patchDraft(
                          draft.useResponseApi === true
                            ? { responsesPath: event.target.value }
                            : { chatCompletionsPath: event.target.value },
                        )
                      }
                    />
                  </label>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="text-sm font-medium">Response API</div>
                      <div className="text-xs leading-relaxed text-muted-foreground">
                        {t("settings:providers.response_api_desc")}
                      </div>
                    </div>
                    <Switch
                      className="shrink-0"
                      disabled={kind !== "openai"}
                      checked={draft.useResponseApi === true}
                      onCheckedChange={(useResponseApi) => patchDraft({ useResponseApi })}
                    />
                  </div>
                </div>
                {kind === "openai" ? (
                  <div className="flex items-start justify-between gap-3 rounded-md border px-3 py-3 md:col-span-2">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="text-sm font-medium">{t("settings:providers.history_reasoning_title")}</div>
                      <div className="text-xs leading-relaxed text-muted-foreground">
                        {t("settings:providers.history_reasoning_desc")}
                      </div>
                    </div>
                    <Switch
                      className="mt-1 shrink-0"
                      checked={draft.includeHistoryReasoning !== false}
                      onCheckedChange={(includeHistoryReasoning) =>
                        patchDraft({ includeHistoryReasoning })
                      }
                    />
                  </div>
                ) : null}
                {kind === "openai" ? (
                  <div className="flex items-start justify-between gap-3 rounded-md border px-3 py-3 md:col-span-2">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="text-sm font-medium">{t("settings:providers.prompt_cache_key_title")}</div>
                      <div className="text-xs leading-relaxed text-muted-foreground">
                        {t("settings:providers.prompt_cache_key_desc")}
                      </div>
                    </div>
                    <Switch
                      className="mt-1 shrink-0"
                      checked={draft.promptCacheKey === true}
                      onCheckedChange={(promptCacheKey) => patchDraft({ promptCacheKey })}
                    />
                  </div>
                ) : null}
                {kind === "claude" ? (
                  <div className="grid gap-3 rounded-md border px-3 py-3 md:col-span-2 md:grid-cols-[1fr_180px]">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium">{t("settings:providers.prompt_cache_title")}</div>
                        <div className="text-xs text-muted-foreground">
                          {t("settings:providers.prompt_cache_desc")}
                        </div>
                      </div>
                      <Switch
                        checked={draft.promptCaching === true}
                        onCheckedChange={(promptCaching) => patchDraft({ promptCaching })}
                      />
                    </div>
                    <label className="space-y-2">
                      <span className="text-sm font-medium">{t("settings:providers.cache_ttl")}</span>
                      <Select
                        value={textValue(draft.promptCacheTtl) || "5m"}
                        onValueChange={(promptCacheTtl) =>
                          patchDraft({ promptCacheTtl: promptCacheTtl as "5m" | "1h" })
                        }
                        disabled={draft.promptCaching !== true}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="5m">{t("settings:providers.cache_5m")}</SelectItem>
                          <SelectItem value="1h">{t("settings:providers.cache_1h")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </label>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">{t("settings:providers.models_title")}</div>
                <div className="text-xs text-muted-foreground">
                  {t("settings:providers.models_desc", { count: draft.models?.length ?? 0 })}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={openAddModelDialog}
                  title={t("settings:providers.add_model_title")}
                >
                  <Plus className="size-4" />
                  {t("settings:providers.add_model")}
                </Button>
                <Button variant="outline" onClick={fetchModels} disabled={fetchingModels}>
                  {fetchingModels ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  {t("settings:providers.fetch_models")}
                </Button>
              </div>
            </div>
            {/* Search + select-all toolbar. Only relevant when there's something to show;
                hidden while the list is empty (no fetch yet, no manual models). */}
            {(fetchedModels.length > 0 || (draft.models ?? []).length > 0) && (
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={modelFilter}
                    onChange={(event) => setModelFilter(event.target.value)}
                    placeholder={t("settings:providers.models_search_placeholder")}
                    className="h-8 pl-9 pr-8"
                  />
                  {modelFilter ? (
                    <button
                      type="button"
                      onClick={() => setModelFilter("")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-4" />
                    </button>
                  ) : null}
                </div>
                {/* Visible/total counts — surfaces how many survive the current filter. */}
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t("settings:providers.models_selection_count", {
                    enabled: draft.models?.length ?? 0,
                    total: displayModels.length,
                  })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setModelsEnabled(visibleModels, !allFilteredEnabled)}
                  disabled={visibleModels.length === 0}
                  title={
                    allFilteredEnabled
                      ? modelFilter
                        ? t("settings:providers.models_deselect_all_filtered")
                        : t("settings:providers.models_deselect_all")
                      : modelFilter
                        ? t("settings:providers.models_select_all_filtered")
                        : t("settings:providers.models_select_all")
                  }
                >
                  {allFilteredEnabled
                    ? modelFilter
                      ? t("settings:providers.models_deselect_all_filtered")
                      : t("settings:providers.models_deselect_all")
                    : modelFilter
                      ? t("settings:providers.models_select_all_filtered")
                      : t("settings:providers.models_select_all")}
                </Button>
              </div>
            )}
            <div className="max-h-72 space-y-2 overflow-auto">
              {visibleModels.map((model) => {
                const focused =
                  focusedModelId &&
                  (model.modelId === focusedModelId || model.id === focusedModelId);
                const enabled = selectedModelIds.has(model.modelId);
                const persisted = (draft.models ?? []).find(
                  (item) => item.modelId === model.modelId,
                );
                const currentType =
                  (persisted?.type as "CHAT" | "IMAGE" | "EMBEDDING" | undefined) ?? "CHAT";
                const currentAbilities = Array.isArray(persisted?.abilities)
                  ? persisted!.abilities
                  : [];
                const hasTool = currentAbilities.includes("TOOL");
                const hasReasoning = currentAbilities.includes("REASONING");
                return (
                  <div
                    key={model.id ?? model.modelId}
                    // The row itself is the click target for the edit dialog. The checkbox and
                    // ability buttons inside stop propagation so they keep their own semantics.
                    role="button"
                    tabIndex={0}
                    onClick={() => openEditModelDialog(model)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openEditModelDialog(model);
                      }
                    }}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 transition hover:border-primary/40 hover:bg-muted/40",
                      focused && "border-primary bg-primary/5 shadow-sm",
                    )}
                  >
                    <span onClick={(event) => event.stopPropagation()}>
                      <Checkbox
                        checked={enabled}
                        onCheckedChange={(checked) => toggleModel(model, checked === true)}
                      />
                    </span>
                    <AIIcon name={model.modelId} size={28} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {model.displayName || model.modelId}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {model.modelId}
                      </span>
                    </span>
                    {enabled && currentType === "CHAT" ? (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            event.preventDefault();
                            toggleModelAbility(model.modelId, "TOOL", !hasTool);
                          }}
                          className={cn(
                            "h-7 rounded-md border px-2 text-xs transition",
                            hasTool
                              ? "border-warning/50 bg-warning/10 text-warning"
                              : "border-border text-muted-foreground hover:bg-muted",
                          )}
                          title={hasTool ? t("settings:providers.tool_enabled") : t("settings:providers.tool_disabled")}
                        >
                          {t("settings:providers.tool_short")}
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            event.preventDefault();
                            toggleModelAbility(model.modelId, "REASONING", !hasReasoning);
                          }}
                          className={cn(
                            "h-7 rounded-md border px-2 text-xs transition",
                            hasReasoning
                              ? "border-sky-500/50 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                              : "border-border text-muted-foreground hover:bg-muted",
                          )}
                          title={hasReasoning ? t("settings:providers.reasoning_enabled") : t("settings:providers.reasoning_disabled")}
                        >
                          {t("settings:providers.reasoning_short")}
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {displayModels.length === 0 ? (
                <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  {t("settings:providers.no_models")}
                </div>
              ) : visibleModels.length === 0 ? (
                <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  {t("settings:providers.models_no_match")}
                </div>
              ) : null}
            </div>
          </div>
          <div className="space-y-2 rounded-md border px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-muted-foreground">{t("settings:providers.test_model")}</span>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={test} disabled={testing}>
                  {testing ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Database className="size-4" />
                  )}
                  {t("settings:providers.test")}
                </Button>
                <Button
                  variant="outline"
                  onClick={async () => {
                    if (!(await confirmDialog({ title: t("settings:providers.delete_confirm", { name: draft.name }), danger: true }))) return;
                    // 防复活:丢弃待保存脏编辑并等在飞保存收尾,DELETE 不与迟到 POST 乱序(复审 F1)
                    await autosave.discard();
                    await api.delete(`settings/provider/${encodeURIComponent(draft.id)}`);
                    const providers = settings.providers.filter((item) => item.id !== draft.id);
                    onSettings({ ...settings, providers });
                    setSelectedId(providers[0]?.id ?? "");
                    toast.success(t("settings:providers.deleted"));
                  }}
                  disabled={settings.providers.length <= 1}
                >
                  <Trash2 className="size-4" />
                  {t("settings:providers.delete")}
                </Button>
                <AutosaveStatusRow
                  status={autosave.status}
                  onRetry={() => void autosave.saveNow()}
                />
              </div>
            </div>
            <Select value={effectiveTestModelId} onValueChange={setTestModelId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("settings:providers.test_model_ph")} />
              </SelectTrigger>
              <SelectContent>
                {mergedTestModels.map((model) => (
                  <SelectItem key={model.id ?? model.modelId} value={model.modelId}>
                    {model.displayName || model.modelId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex items-end justify-between gap-3">
              <div>
                <div className="text-sm font-medium">{t("settings:providers.balance_title")}</div>
                <div className="text-xs text-muted-foreground">
                  {t("settings:providers.balance_desc")}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={balanceOption.enabled === true}
                  onCheckedChange={(enabled) =>
                    patchDraft({ balanceOption: { ...balanceOptionOf(draft), enabled } })
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void checkBalance()}
                  disabled={checkingBalance || balanceOption.enabled !== true}
                >
                  {checkingBalance ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Database className="size-4" />
                  )}
                  {t("settings:providers.query")}
                </Button>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-2">
                <span className="text-sm font-medium">{t("settings:providers.balance_api_path")}</span>
                <Input
                  value={textValue(balanceOption.apiPath) || "/credits"}
                  onChange={(event) =>
                    patchDraft({
                      balanceOption: { ...balanceOptionOf(draft), apiPath: event.target.value },
                    })
                  }
                />
              </label>
              <label className="space-y-2">
                <span className="text-sm font-medium">{t("settings:providers.balance_result_path")}</span>
                <Input
                  value={textValue(balanceOption.resultPath)}
                  onChange={(event) =>
                    patchDraft({
                      balanceOption: { ...balanceOptionOf(draft), resultPath: event.target.value },
                    })
                  }
                  aria-invalid={!isBalanceResultPathValid(textValue(balanceOption.resultPath))}
                  className={cn(
                    !isBalanceResultPathValid(textValue(balanceOption.resultPath)) &&
                      "border-destructive focus-visible:ring-destructive/30",
                  )}
                />
                {!isBalanceResultPathValid(textValue(balanceOption.resultPath)) ? (
                  <p className="text-xs text-destructive">{t("settings:providers.balance_result_path_invalid")}</p>
                ) : null}
              </label>
            </div>
          </div>
          {(testing || testChecks.length > 0 || testInfo) &&
          !isImageTestMode &&
          !imageTestResult ? (
            <div className="rounded-md border bg-muted/40 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium">{t("settings:providers.test_summary")}</div>
                <div className="text-xs text-muted-foreground">
                  {testInfo?.testModelId
                    ? t("settings:providers.test_summary_model", { model: testInfo.testModelId })
                    : testing
                      ? t("settings:providers.testing")
                      : t("settings:providers.awaiting")}
                </div>
              </div>
              <div className="grid gap-2 md:grid-cols-3">
                {(["non_stream", "stream", "tools"] as ProviderTestMode[]).map((mode) => {
                  const check = testChecks.find((item) => item.mode === mode);
                  const pending = testing && !check;
                  return (
                    <div
                      key={mode}
                      className={cn(
                        "rounded-md border bg-background px-3 py-2",
                        check?.ok === true && "border-success/30 bg-success/5",
                        check?.ok === false && "border-destructive/30 bg-destructive/5",
                      )}
                    >
                      <div className="flex items-center gap-2 text-sm font-medium">
                        {pending ? (
                          <Loader2 className="size-4 animate-spin text-muted-foreground" />
                        ) : check?.ok ? (
                          <CheckCircle2 className="size-4 text-success" />
                        ) : check ? (
                          <Trash2 className="size-4 text-destructive" />
                        ) : (
                          <span className="size-2 rounded-full bg-muted-foreground/40" />
                        )}
                        <span>{testModeLabels[mode]}</span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {check
                          ? check.ok
                            ? t("settings:providers.check_ok", { status: check.status })
                            : t("settings:providers.check_failed", { status: check.status || t("settings:providers.not_connected") })
                          : pending
                            ? t("settings:providers.in_progress")
                            : t("settings:providers.not_tested")}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
          {isImageTestMode && testing && !imageTestResult ? (
            <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              <Loader2 className="mr-2 inline size-4 animate-spin align-middle" />
              {t("settings:providers.img_test_generating_pre")}<span className="font-medium text-foreground">
                {effectiveTestModelId}
              </span>{" "}
              {t("settings:providers.img_test_generating_post")}
            </div>
          ) : null}
          {imageTestResult ? (
            <div className="rounded-md border bg-muted/40 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium">{t("settings:providers.img_test_result")}</div>
                <div className="text-xs text-muted-foreground">
                  {t("settings:providers.img_test_model", { model: imageTestResult.modelId, duration: (imageTestResult.durationMs / 1000).toFixed(2) })}
                </div>
              </div>
              <div className="flex flex-wrap items-start gap-3">
                {imageTestResult.url ? (
                  <img
                    src={appendWebAuthQuery(imageTestResult.url)}
                    alt={t("settings:providers.img_alt")}
                    className="h-40 w-40 rounded-md border object-cover"
                  />
                ) : null}
                <div className="min-w-0 flex-1 text-xs text-muted-foreground">
                  <div className="mb-1 font-medium text-foreground">{t("settings:providers.prompt_label")}</div>
                  <div className="whitespace-pre-wrap">{imageTestResult.prompt}</div>
                </div>
              </div>
            </div>
          ) : null}
          {testResult ? (
            <pre className="max-h-56 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap">
              {testResult}
            </pre>
          ) : null}
          {balanceResult ? (
            <pre className="max-h-56 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap">
              {balanceResult}
            </pre>
          ) : null}
        </div>
      </div>
      {modelDialog ? (
        <ModelEditDialog
          open={Boolean(modelDialog)}
          onOpenChange={(open) => {
            if (!open) setModelDialog(null);
          }}
          mode={modelDialog.mode}
          modelIdLocked={modelDialog.modelIdLocked}
          initialModel={modelDialog.model}
          onSave={handleModelDialogSave}
          onDelete={modelDialog.mode === "edit" ? handleModelDialogDelete : undefined}
        />
      ) : null}
    </>
  );
}
