// components/settings/providers.tsx — 模型 › 供应商页:左列表,右配置(连接 → 模型 → 测试 → 高级[默认收起])。

import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  CheckCircle2,
  Database,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { AIIcon } from "~/components/ui/ai-icon";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Notice } from "~/components/ui/notice";
import { SearchInput } from "~/components/ui/search-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { StatusBadge, StatusBadgeButton } from "~/components/ui/status-badge";
import { Switch } from "~/components/ui/switch";
import { ModelEditDialog } from "~/components/model-edit-dialog";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import { cn } from "~/lib/utils";
import { isBalanceResultPathValid } from "~/lib/json-expression";
import { createId } from "~/lib/id";
import { getModelDisplayName } from "~/lib/display";
import { patchSettingsLocal, upsertById } from "~/lib/settings-patch";
import { copyTextToClipboard } from "~/lib/clipboard";
import { isDesktopShell, openExternal } from "~/lib/external-link";
import api, { appendWebAuthQuery } from "~/services/api";
import { onAppEvent, type ProviderAuthEventDto } from "~/services/app-events";
import { useSettingsStore } from "~/stores/app-store";
import { confirmDialog } from "~/stores/confirm-store";
import { getSettingsParam } from "~/stores/settings-dialog-store";
import type { ProviderModel, ProviderProfile, Settings } from "~/types";
import { SegmentedControl } from "~/components/ui/segmented-tabs";
import {
  clone,
  moveItem,
  PasswordInput,
  SettingsAdvancedSection,
  SettingsDetailFooter,
  SettingsDetailHeader,
  SettingsEmpty,
  SettingsField,
  SettingsGroup,
  SettingsRows,
  SettingsListAddButton,
  SettingsListRow,
  SettingsSplit,
  SettingsStack,
  SettingsSwitchRow,
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
  const setSettings = useSettingsStore((state) => state.setSettings);
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

  // 拉一次服务端 settings 真值收口进 store。settings 全应用唯一写入点是 setSettings
  // (SSE 快照/设置页保存都经此)。两条自愈路径共用:①登录轮询发现尝试终结时;②登出 POST
  // 成功后。settings 帧(含 signedIn)与 provider_auth success 帧同走 /api/events 通道,
  // 通道丢帧时 signedIn 停旧值——登录错翻「未登录」、登出卡在「已登录」,都靠它收口。
  const syncSettingsTruth = React.useCallback(async () => {
    const fresh = await api.get<Settings>("settings");
    setSettings(fresh);
  }, [setSettings]);

  // 周期性服务端真值对齐(治本兜底):进行中每 2s 拉一次 /status。
  // 为什么需要:授权在系统浏览器完成、状态更新在应用页——SSE 连接被拆时,provider_auth 的
  // success 帧与 settings 的 signedIn 都可能到不了面板,于是用户授权完回来,面板仍停在
  // 挂载时恢复的「进行中」。服务端 attempts 表是唯一真值:轮询到「不再有进行中尝试」说明
  // 登录已终结,此时清掉进度帧。但 signedIn 在 settings 快照上——那条通道若已丢帧,signedIn
  // 仍停在旧值,面板会错翻「未登录」。故终结时同时拉一次 settings 真值收口:signedIn 翻真
  // 按已登录落,翻假按未登录落,任何一帧丢失都能在一轮轮询内自愈。只在登录进行中才轮询。
  const signedInRef = React.useRef(signedIn);
  signedInRef.current = signedIn;
  const authEventRef = React.useRef(authEvent);
  authEventRef.current = authEvent;
  React.useEffect(() => {
    if (!inProgress) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void (async () => {
        if (cancelled) return;
        try {
          const status = await api.get<{ inProgress: boolean; event: ProviderAuthEventDto | null }>(
            "settings/provider/oauth/status",
            { searchParams: { providerId: provider.id } },
          );
          if (cancelled) return;
          // 已由 settings 真值翻「已登录」:进度帧一并清掉(无需再等轮询)。
          if (signedInRef.current) { setAuthEvent(null); return; }
          if (status.inProgress && status.event) {
            setAuthEvent(status.event);
          } else if (!status.inProgress) {
            // 尝试终结:补 settings 真值再收口,否则丢失的 settings 帧会把面板错翻「未登录」。
            await syncSettingsTruth();
            if (cancelled) return;
            const current = authEventRef.current;
            if (current != null && !["success", "error", "cancelled"].includes(current.phase)) {
              setAuthEvent(null);
            }
          }
        } catch {
          // 对齐失败仅丢一次轮询,下一轮补;不打扰用户
        }
      })();
    }, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [inProgress, provider.id, syncSettingsTruth]);

  // 服务端真值兜底:登录态翻转瞬间清掉残留的非终态帧。SSE 增量帧可能因通道抖动/页面
  // 后台节流丢失,而 oauthStatus 随 settings 快照可靠到达——若 signedIn 已翻真而面板还
  // 挂着"进行中"帧(说明 success 帧丢了),按真值收口并补一声成功提示;翻假(别处登出/
  // 凭证被清)同理静默清掉幽灵进度卡。终态帧(success/error/cancelled)由各自 SSE 处理
  // 器收口,不经这里。经 ref 读当前帧:toast 是副作用,不能进 setState updater。
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
      return;
    }
    // 登出真值兜底:POST 成功即已登出,但登出的 settings 帧可能丢——主动对齐,signedIn 翻假,
    // 卡片落「未登录」。失败仅本次不对齐,正常(未丢帧)路径不受影响。
    try { await syncSettingsTruth(); } catch { /* 丢帧兜底,失败静默 */ }
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
      <Notice tone="warning" icon={<TriangleAlert />}>
        <div className="text-sm font-medium">{t("settings:providers.oauth.workspace_only_title")}</div>
        <p className="mt-1 text-[var(--ds-text-secondary)]">{t("settings:providers.oauth.workspace_only_note")}</p>
        <a
          href="https://code.claude.com/docs/en/legal-and-compliance"
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:opacity-80"
        >
          {t("settings:providers.oauth.legal_link")}
          <ExternalLink className="size-3" />
        </a>
      </Notice>
    ) : null;

  if (signedIn) {
    return (
      <>
        {workspaceOnlyWarning}
        <Notice
          tone="success"
          icon={<CheckCircle2 />}
          action={
            <Button variant="tertiary" size="compact" onClick={() => void logout()}>
              {t("settings:providers.oauth.logout")}
            </Button>
          }
        >
          <div className="text-sm font-medium">{t("settings:providers.oauth.signed_in")}</div>
          <div className="mt-0.5 space-y-0.5 text-[var(--ds-text-secondary)]">
            {provider.oauthStatus?.accountId ? <div>{t("settings:providers.oauth.account", { id: provider.oauthStatus.accountId })}</div> : null}
            {provider.oauthStatus?.signedInAt ? <div>{t("settings:providers.oauth.signed_in_at", { time: new Date(provider.oauthStatus.signedInAt).toLocaleString() })}</div> : null}
          </div>
        </Notice>
      </>
    );
  }

  if (inProgress && authEvent) {
    return (
      <>
        {workspaceOnlyWarning}
        <div className="rounded-md border px-3 py-3">
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
              <Button key={method.id} variant="tertiary" size="compact" onClick={() => void submitMethod(method.id)} disabled={submitting}>
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
              <Button variant="tertiary" size="compact" onClick={() => void openExternal(authEvent.authUrl!)}>
                <ExternalLink className="mr-1 size-3" />
                {t("settings:providers.oauth.open_browser")}
              </Button>
              <Button variant="tertiary" size="compact" onClick={() => void copy(authEvent.authUrl!)}>
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
                <Button variant="tertiary" size="compact" onClick={() => void openExternal(authEvent.deviceCode!.verificationUri)}>
                  <ExternalLink className="mr-1 size-3" />
                  {t("settings:providers.oauth.open_auth_page")}
                </Button>
                <Button variant="tertiary" size="compact" onClick={() => void copy(authEvent.deviceCode!.verificationUri)}>
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
                <Button variant="tertiary" size="compact" onClick={() => void openExternal(authEvent.deviceCode!.verificationUri)}>
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
      <div className="rounded-md border border-dashed px-3 py-3">
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

// Single model dialog instance reused for both add (+ button) and edit (row click). The mode +
// modelIdLocked flags determine the dialog UX. State is reset every time the dialog opens
// (see ModelEditDialog's useEffect on `open`), so reusing one instance is safe.
type ModelDialogState = {
  mode: "add" | "edit";
  model: ProviderModel;
  modelIdLocked: boolean;
};

const KIND_LABEL_KEYS: Record<ProviderKind, string> = {
  openai: "settings:providers.kind.openai",
  claude: "settings:providers.kind.claude",
  google: "settings:providers.kind.google",
};
const PROVIDER_KINDS = Object.keys(KIND_LABEL_KEYS) as ProviderKind[];

// OpenAI 格式的两种请求协议:点「OpenAI *」分段弹出选择。未选过即 Chat Completions(useResponseApi 缺省)。
const OPENAI_FORMATS = [
  { responseApi: false, labelKey: "settings:providers.openai_format.chat" },
  { responseApi: true, labelKey: "settings:providers.openai_format.responses" },
] as const;

/** 详情页头的格式名:OpenAI 格式落到具体协议,不显示分段上的「OpenAI *」。 */
function providerFormatLabelKey(kind: ProviderKind, provider: ProviderProfile): string {
  if (kind !== "openai") return KIND_LABEL_KEYS[kind];
  return OPENAI_FORMATS[provider.useResponseApi === true ? 1 : 0].labelKey;
}

/** 当前格式下请求端点尾缀是否被用户改过(只有 OpenAI 格式可改)。 */
function hasCustomEndpointPath(provider: ProviderProfile): boolean {
  if (providerKind(provider) !== "openai") return false;
  const chat = textValue(provider.chatCompletionsPath) || "/chat/completions";
  const responses = textValue(provider.responsesPath) || "/responses";
  return chat !== "/chat/completions" || responses !== "/responses";
}

function normalizeKindPatch(provider: ProviderProfile, kind: ProviderKind): ProviderProfile {
  return {
    ...provider,
    type: kind,
    baseUrl: baseUrlForKindSwitch(provider.id, textValue(provider.baseUrl), kind),
    useResponseApi: kind === "openai" ? provider.useResponseApi === true : false,
    // chatCompletionsPath 只承载 Chat Completions 尾缀;Responses 尾缀在 responsesPath,两者不混写。
    chatCompletionsPath: defaultPathForKind(kind),
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
  // ?providerId= deep-link is only honored on first mount, so subsequent settings updates
  // (autosave, SSE) don't snap the selection back to the URL value or the default first provider.
  const initialProviderId = React.useMemo(() => {
    const providerId = getSettingsParam("providerId");
    if (providerId && settings.providers.some((provider) => provider.id === providerId))
      return providerId;
    return settings.providers[0]?.id ?? "";
    // Intentionally empty deps: capture only the initial value. We don't want to re-derive on
    // every settings update because that pulls selectedId back to the default.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 深链高亮的模型只属于深链指向的那个供应商;切到别的供应商不再高亮同名模型。
  const deepLink = React.useMemo(
    () => ({ providerId: getSettingsParam("providerId"), modelId: getSettingsParam("modelId") ?? "" }),
    [],
  );
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
      patchSettingsLocal((current) => ({
        providers: current.providers.map((provider) => (provider.id === draft.id ? draft : provider)),
      }));
    },
    { onSaveError: (error) => toast.error((error as Error).message || t("settings:providers.autosave_failed")) },
  );
  const lastSelectedRef = React.useRef(selectedId);

  // 「高级设置」展开态:切换供应商不收起,离开本页(重挂载)复位为收起。
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [modelDialog, setModelDialog] = React.useState<ModelDialogState | null>(null);
  // 深链高亮的模型行只滚动进视野一次(列表限高,靠后的模型否则在可视区外)。
  const focusScrolledRef = React.useRef(false);

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
    setDraft((current) => (current ? { ...current, ...patch } : current));
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
    patchSettingsLocal((current) => ({ providers: upsertById(current.providers, next) }));
    setSelectedId(next.id);
    toast.success(t("settings:providers.added"));
  };
  const moveProvider = async (from: number, to: number) => {
    const nextProviders = moveItem(settings.providers, from, to);
    patchSettingsLocal({ providers: nextProviders });
    await api.post("settings/provider/reorder", {
      ids: nextProviders.map((provider) => provider.id),
    });
  };
  const testModeLabels: Record<ProviderTestMode, string> = {
    non_stream: t("settings:providers.mode_non_stream"),
    stream: t("settings:providers.mode_stream"),
    tools: t("settings:providers.mode_tools"),
  };

  const scrollFocusedIntoView = (element: HTMLDivElement | null) => {
    if (!element || focusScrolledRef.current) return;
    focusScrolledRef.current = true;
    element.scrollIntoView({ block: "nearest" });
  };

  const isOauth = draft.authMode === "oauth";
  // 收起时高级区里有非默认配置就亮小圆点,免得默认折叠把用户自己的配置藏起来。
  const advancedAttention =
    (!isOauth &&
      kind === "openai" &&
      (hasCustomEndpointPath(draft) || draft.includeHistoryReasoning === false || draft.promptCacheKey === true)) ||
    (!isOauth && kind === "claude" && draft.promptCaching === true) ||
    balanceOption.enabled === true;
  const getKeyUrl = providerGetKeyUrl(textValue(draft.baseUrl));
  const resultPathValid = isBalanceResultPathValid(textValue(balanceOption.resultPath));
  const selectAllLabel = allFilteredEnabled
    ? modelFilter
      ? t("settings:providers.models_deselect_all_filtered")
      : t("settings:providers.models_deselect_all")
    : modelFilter
      ? t("settings:providers.models_select_all_filtered")
      : t("settings:providers.models_select_all");

  const changeKind = (value: ProviderKind, useResponseApi?: boolean) => {
    // 类型切换也是编辑,必须置脏,否则永不自动保存(复审 F3 补获)
    autosave.markDirty();
    const next: ProviderProfile = {
      ...normalizeKindPatch(draft, value),
      ...(useResponseApi !== undefined ? { useResponseApi } : {}),
    };
    // 按登记表/协议默认换算过地址时告知用户去向;自定义地址不动则不打扰。端点尾缀在折叠区里,
    // 被静默归位时一并说明。
    const baseChanged = next.baseUrl !== textValue(draft.baseUrl) && textValue(draft.baseUrl) !== "";
    const pathReset = hasCustomEndpointPath(draft);
    if (baseChanged || pathReset) {
      toast(
        [
          baseChanged ? t("settings:providers.base_url_switched", { url: next.baseUrl }) : null,
          pathReset ? t("settings:providers.path_reset_on_kind") : null,
        ]
          .filter(Boolean)
          .join(" "),
      );
    }
    setDraft(next);
  };

  // 已是 OpenAI 格式时只换协议(地址、尾缀都不动);从别的格式进来走完整的格式切换。
  const selectOpenAiFormat = (useResponseApi: boolean) => {
    if (kind !== "openai") {
      changeKind("openai", useResponseApi);
      return;
    }
    if ((draft.useResponseApi === true) !== useResponseApi) patchDraft({ useResponseApi });
  };

  const kindItems = PROVIDER_KINDS.map((value) =>
    value === "openai"
      ? {
          value,
          label: t(KIND_LABEL_KEYS[value]),
          wrap: (button: React.ReactElement) => (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-(--radix-dropdown-menu-trigger-width)">
                {OPENAI_FORMATS.map((format) => {
                  const active = kind === "openai" && (draft.useResponseApi === true) === format.responseApi;
                  return (
                    <DropdownMenuItem
                      key={String(format.responseApi)}
                      data-active={active || undefined}
                      onSelect={() => selectOpenAiFormat(format.responseApi)}
                    >
                      <span className="flex w-[18px] shrink-0 items-center justify-center">
                        {active ? <Check className="size-4 !text-current" /> : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{t(format.labelKey)}</span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ),
        }
      : { value, label: t(KIND_LABEL_KEYS[value]) },
  );

  // 删除收口到列表行(右键/悬停「⋯」):按目标行 id 删,不再依赖右侧草稿。至少保留一个供应商。
  const deleteProviderById = async (targetId: string) => {
    if (settings.providers.length <= 1) return;
    const target = settings.providers.find((item) => item.id === targetId);
    if (!target) return;
    if (!(await confirmDialog({ title: t("settings:providers.delete_confirm", { name: target.name }), danger: true }))) return;
    // 防复活:仅当删的是正在编辑的那条才 discard(丢脏编辑+等在飞保存,DELETE 不与迟到 POST 乱序)。
    const removingActive = draft.id === targetId;
    if (removingActive) await autosave.discard();
    await api.delete(`settings/provider/${encodeURIComponent(targetId)}`);
    let nextId = "";
    patchSettingsLocal((current) => {
      const providers = current.providers.filter((item) => item.id !== targetId);
      nextId = providers[0]?.id ?? "";
      return { providers };
    });
    // 删的是当前编辑行:选中下一个;删的是别的行:选中保持不动。
    if (removingActive) setSelectedId(nextId);
    toast.success(t("settings:providers.deleted"));
  };

  return (
    <>
      <SettingsSplit
        scroll
        list={
          <div className="space-y-1">
            <SettingsListAddButton label={t("settings:providers.add")} onClick={() => void addProvider()} />
            {settings.providers.map((provider, index) => (
              <SettingsListRow
                key={provider.id}
                id={provider.id}
                index={index}
                active={provider.id === draft.id}
                onSelect={() => setSelectedId(provider.id)}
                onMove={moveProvider}
                // 至少保留一个供应商:只剩一个时不给删除菜单(否则菜单在、点了却没有反应)。
                onDelete={settings.providers.length > 1 ? () => deleteProviderById(provider.id) : undefined}
                badge={
                  provider.authMode === "oauth" ? (
                    <StatusBadge tone="brand">{t("settings:providers.oauth.badge")}</StatusBadge>
                  ) : null
                }
              >
                <span className="grid min-w-0 grid-cols-[28px_10px_minmax(0,1fr)] items-center gap-2 text-left">
                  <AIIcon name={provider.name} size={24} className="justify-self-start" />
                  <span
                    className={`size-2 rounded-full ${provider.enabled ? "bg-success" : "bg-muted-foreground/40"}`}
                  />
                  <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                </span>
              </SettingsListRow>
            ))}
          </div>
        }
      >
        <div className="@container">
          <SettingsStack>
            <SettingsDetailHeader
              title={draft.name}
              titlePlaceholder={t(providerFormatLabelKey(kind, draft))}
              titleLabel={t("settings:providers.name")}
              onTitleCommit={(name) => patchDraft({ name })}
              description={textValue(draft.shortDescription) || t(providerFormatLabelKey(kind, draft))}
              action={
                <label className="flex items-center gap-2 text-sm text-[var(--ds-text-secondary)]">
                  {t("settings:providers.enabled_label")}
                  <Switch
                    checked={draft.enabled}
                    disabled={fetchingModels}
                    onCheckedChange={(enabled) => void handleToggleEnabled(enabled)}
                  />
                </label>
              }
            />

            <SettingsGroup title={t("settings:providers.connection_title")} fields>
              {!isOauth ? (
                <>
                  <SettingsField label={t("settings:providers.type")}>
                    <SegmentedControl
                      stretch
                      aria-label={t("settings:providers.type")}
                      items={kindItems}
                      value={kind}
                      onChange={changeKind}
                    />
                  </SettingsField>
                  <SettingsField
                    label="Base URL"
                    hint={
                      <span className="block space-y-0.5 break-all">
                        <span className="block">{t("settings:providers.chat_url", { url: endpointPreview(draft) })}</span>
                        <span className="block">
                          {t("settings:providers.models_url", { url: modelListEndpointPreview(draft) })}
                        </span>
                      </span>
                    }
                  >
                    <Input
                      value={textValue(draft.baseUrl)}
                      onChange={(event) => patchDraft({ baseUrl: event.target.value })}
                      placeholder={DEFAULT_BASE_URLS[kind]}
                    />
                  </SettingsField>
                </>
              ) : null}
              {isOauth ? (
                // 登录态读 SSE 真值(selected)而非 draft:draft 只在切换供应商/登录态翻转时重对齐,
                // 用 draft 会让卡片在登出/登录后仍停留在旧状态。
                // key 绑 provider.id:切换供应商时强制重挂载,清掉上次残留的 manualCode/textInput/
                // 已打开授权 URL 等瞬态——否则 A 供应商输入的授权码会带进 B 的登录框。
                <ProviderLoginPanel key={(selected ?? draft).id} provider={selected ?? draft} />
              ) : (
                <SettingsField
                  label="API Key"
                  trailing={
                    getKeyUrl ? (
                      <button
                        type="button"
                        onClick={() => void openExternal(getKeyUrl)}
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        title={t("settings:providers.get_key_title")}
                      >
                        <ExternalLink className="size-3" />
                        {t("settings:providers.get_key")}
                      </button>
                    ) : undefined
                  }
                >
                  <PasswordInput value={textValue(draft.apiKey)} onChange={(apiKey) => patchDraft({ apiKey })} />
                </SettingsField>
              )}
            </SettingsGroup>

            <SettingsGroup
              title={t("settings:providers.models_title")}
              description={t("settings:providers.models_desc", { count: draft.models?.length ?? 0 })}
              action={
                <>
                  <Button variant="tertiary" size="compact" onClick={openAddModelDialog} title={t("settings:providers.add_model_title")}>
                    <Plus className="size-4" />
                    {t("settings:providers.add_model")}
                  </Button>
                  <Button variant="tertiary" size="compact" onClick={() => void fetchModels()} disabled={fetchingModels}>
                    {fetchingModels ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                    {t("settings:providers.fetch_models")}
                  </Button>
                </>
              }
              fields
            >
              {/* 搜索 + 全选工具条:列表为空(未拉取、无手动模型)时不显示。 */}
              {(fetchedModels.length > 0 || (draft.models ?? []).length > 0) && (
                <div className="flex items-center gap-2">
                  <SearchInput
                    className="flex-1"
                    value={modelFilter}
                    onValueChange={setModelFilter}
                    placeholder={t("settings:providers.models_search_placeholder")}
                    aria-label={t("settings:providers.models_search_placeholder")}
                    clearLabel={t("settings:providers.clear_search")}
                  />
                  {/* 已启用/总数:当前过滤后还剩多少一目了然。 */}
                  <span className="shrink-0 text-xs tabular-nums text-[var(--ds-text-secondary)]">
                    {t("settings:providers.models_selection_count", {
                      enabled: draft.models?.length ?? 0,
                      total: displayModels.length,
                    })}
                  </span>
                  <Button
                    variant="ghost"
                    size="compact"
                    onClick={() => setModelsEnabled(visibleModels, !allFilteredEnabled)}
                    disabled={visibleModels.length === 0}
                    title={selectAllLabel}
                  >
                    {selectAllLabel}
                  </Button>
                </div>
              )}
              <div className="max-h-72 space-y-2 overflow-auto">
                {visibleModels.map((model) => {
                    const focused =
                      draft.id === deepLink.providerId &&
                      deepLink.modelId !== "" &&
                      (model.modelId === deepLink.modelId || model.id === deepLink.modelId);
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
                        ref={focused ? scrollFocusedIntoView : undefined}
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
                            {getModelDisplayName(model.displayName, model.modelId)}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {model.modelId}
                          </span>
                        </span>
                        {enabled && currentType === "CHAT" ? (
                          <div className="flex items-center gap-1.5">
                            <StatusBadgeButton
                              tone="warning"
                              pressed={hasTool}
                              onClick={(event) => {
                                event.stopPropagation();
                                event.preventDefault();
                                toggleModelAbility(model.modelId, "TOOL", !hasTool);
                              }}
                              title={hasTool ? t("settings:providers.tool_enabled") : t("settings:providers.tool_disabled")}
                            >
                              {t("settings:providers.tool_short")}
                            </StatusBadgeButton>
                            <StatusBadgeButton
                              tone="brand"
                              pressed={hasReasoning}
                              onClick={(event) => {
                                event.stopPropagation();
                                event.preventDefault();
                                toggleModelAbility(model.modelId, "REASONING", !hasReasoning);
                              }}
                              title={hasReasoning ? t("settings:providers.reasoning_enabled") : t("settings:providers.reasoning_disabled")}
                            >
                              {t("settings:providers.reasoning_short")}
                            </StatusBadgeButton>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                  {displayModels.length === 0 ? (
                    <SettingsEmpty>{t("settings:providers.no_models")}</SettingsEmpty>
                  ) : visibleModels.length === 0 ? (
                    <SettingsEmpty>{t("settings:providers.models_no_match")}</SettingsEmpty>
                  ) : null}
              </div>
            </SettingsGroup>

            <SettingsGroup
              title={t("settings:providers.test_title")}
              action={
                <Button variant="tertiary" size="compact" onClick={() => void test()} disabled={testing}>
                  {testing ? <Loader2 className="size-4 animate-spin" /> : <Database className="size-4" />}
                  {t("settings:providers.test")}
                </Button>
              }
              fields
            >
              <SettingsField label={t("settings:providers.test_model")}>
                <Select value={effectiveTestModelId} onValueChange={setTestModelId}>
                  <SelectTrigger className="w-full" aria-label={t("settings:providers.test_model")}>
                    <SelectValue placeholder={t("settings:providers.test_model_ph")} />
                  </SelectTrigger>
                  <SelectContent>
                    {mergedTestModels.map((model) => (
                      <SelectItem key={model.id ?? model.modelId} value={model.modelId}>
                        {getModelDisplayName(model.displayName, model.modelId)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsField>
              {(testing || testChecks.length > 0 || testInfo) &&
              !isImageTestMode &&
              !imageTestResult ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-medium">{t("settings:providers.test_summary")}</div>
                    <div className="text-xs text-[var(--ds-text-secondary)]">
                      {testInfo?.testModelId
                        ? t("settings:providers.test_summary_model", { model: testInfo.testModelId })
                        : testing
                          ? t("settings:providers.testing")
                          : t("settings:providers.awaiting")}
                    </div>
                  </div>
                  <div className="grid gap-2 @xl:grid-cols-3">
                    {(["non_stream", "stream", "tools"] as ProviderTestMode[]).map((mode) => {
                      const check = testChecks.find((item) => item.mode === mode);
                      const pending = testing && !check;
                      return (
                        <Notice
                          key={mode}
                          tone={check?.ok === true ? "success" : check?.ok === false ? "danger" : "info"}
                          icon={
                            pending ? (
                              <Loader2 className="animate-spin" />
                            ) : check?.ok ? (
                              <CheckCircle2 />
                            ) : check ? (
                              <XCircle />
                            ) : (
                              <span className="mt-[5px] size-1.5 shrink-0 rounded-full bg-current opacity-40" />
                            )
                          }
                        >
                          <div className="text-sm font-medium">{testModeLabels[mode]}</div>
                          <div className="mt-0.5 text-[var(--ds-text-secondary)]">
                            {check
                              ? check.ok
                                ? t("settings:providers.check_ok", { status: check.status })
                                : t("settings:providers.check_failed", { status: check.status || t("settings:providers.not_connected") })
                              : pending
                                ? t("settings:providers.in_progress")
                                : t("settings:providers.not_tested")}
                          </div>
                        </Notice>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              {isImageTestMode && testing && !imageTestResult ? (
                <Notice icon={<Loader2 className="animate-spin" />}>
                  {t("settings:providers.img_test_generating_pre")}<span className="font-medium text-[var(--ds-text-primary)]">
                    {effectiveTestModelId}
                  </span>{" "}
                  {t("settings:providers.img_test_generating_post")}
                </Notice>
              ) : null}
              {imageTestResult ? (
                <div className="rounded-[var(--ds-radius-md)] bg-[var(--ds-on-surface)] p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-medium">{t("settings:providers.img_test_result")}</div>
                    <div className="text-xs text-[var(--ds-text-secondary)]">
                      {t("settings:providers.img_test_model", { model: imageTestResult.modelId, duration: (imageTestResult.durationMs / 1000).toFixed(2) })}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-start gap-3">
                    {imageTestResult.url ? (
                      <img
                        src={appendWebAuthQuery(imageTestResult.url)}
                        alt={t("settings:providers.img_alt")}
                        className="h-40 w-40 rounded-[var(--ds-radius-sm)] object-cover"
                      />
                    ) : null}
                    <div className="min-w-0 flex-1 text-xs text-[var(--ds-text-secondary)]">
                      <div className="mb-1 font-medium text-[var(--ds-text-primary)]">{t("settings:providers.prompt_label")}</div>
                      <div className="whitespace-pre-wrap">{imageTestResult.prompt}</div>
                    </div>
                  </div>
                </div>
              ) : null}
              {testResult ? (
                <pre className="max-h-56 overflow-auto rounded-[var(--ds-radius-md)] bg-[var(--ds-on-surface)] p-3 text-xs whitespace-pre-wrap">
                  {testResult}
                </pre>
              ) : null}
            </SettingsGroup>

            <SettingsAdvancedSection open={advancedOpen} onOpenChange={setAdvancedOpen} attention={advancedAttention}>
              <SettingsRows>
                {!isOauth && kind === "openai" ? (
                  // 尾缀随所选协议绑定字段(对齐安卓 ProviderConfigure):Chat Completions→
                  // chatCompletionsPath,Responses API→responsesPath。
                  <div className="py-3">
                    <SettingsField
                      label={
                        draft.useResponseApi === true
                          ? t("settings:providers.responses_path_label")
                          : t("settings:providers.chat_completions_path_label")
                      }
                    >
                      <Input
                        value={
                          draft.useResponseApi === true
                            ? textValue(draft.responsesPath) || "/responses"
                            : textValue(draft.chatCompletionsPath) || defaultPathForKind(kind)
                        }
                        onChange={(event) =>
                          patchDraft(
                            draft.useResponseApi === true
                              ? { responsesPath: event.target.value }
                              : { chatCompletionsPath: event.target.value },
                          )
                        }
                      />
                    </SettingsField>
                  </div>
                ) : null}
                {!isOauth && kind === "openai" ? (
                  <SettingsSwitchRow
                    label={t("settings:providers.history_reasoning_title")}
                    description={t("settings:providers.history_reasoning_desc")}
                    checked={draft.includeHistoryReasoning !== false}
                    onCheckedChange={(includeHistoryReasoning) => patchDraft({ includeHistoryReasoning })}
                  />
                ) : null}
                {!isOauth && kind === "openai" ? (
                  <SettingsSwitchRow
                    label={t("settings:providers.prompt_cache_key_title")}
                    description={t("settings:providers.prompt_cache_key_desc")}
                    checked={draft.promptCacheKey === true}
                    onCheckedChange={(promptCacheKey) => patchDraft({ promptCacheKey })}
                  />
                ) : null}
                {!isOauth && kind === "claude" ? (
                  <SettingsSwitchRow
                    label={t("settings:providers.prompt_cache_title")}
                    description={t("settings:providers.prompt_cache_desc")}
                    checked={draft.promptCaching === true}
                    onCheckedChange={(promptCaching) => patchDraft({ promptCaching })}
                  >
                    {draft.promptCaching === true ? (
                      <SettingsField label={t("settings:providers.cache_ttl")}>
                        <Select
                          value={textValue(draft.promptCacheTtl) || "5m"}
                          onValueChange={(promptCacheTtl) => patchDraft({ promptCacheTtl: promptCacheTtl as "5m" | "1h" })}
                        >
                          <SelectTrigger className="w-full max-w-60" aria-label={t("settings:providers.cache_ttl")}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="5m">{t("settings:providers.cache_5m")}</SelectItem>
                            <SelectItem value="1h">{t("settings:providers.cache_1h")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </SettingsField>
                    ) : null}
                  </SettingsSwitchRow>
                ) : null}
                <SettingsSwitchRow
                  label={t("settings:providers.balance_title")}
                  description={t("settings:providers.balance_desc")}
                  checked={balanceOption.enabled === true}
                  onCheckedChange={(enabled) => patchDraft({ balanceOption: { ...balanceOptionOf(draft), enabled } })}
                >
                  {balanceOption.enabled === true ? (
                    <div className="space-y-3">
                      <div className="grid gap-3 @xl:grid-cols-2">
                        <SettingsField label={t("settings:providers.balance_api_path")}>
                          <Input
                            value={textValue(balanceOption.apiPath) || "/credits"}
                            onChange={(event) =>
                              patchDraft({ balanceOption: { ...balanceOptionOf(draft), apiPath: event.target.value } })
                            }
                          />
                        </SettingsField>
                        <SettingsField
                          label={t("settings:providers.balance_result_path")}
                          hint={
                            resultPathValid ? undefined : (
                              <span className="text-destructive">
                                {t("settings:providers.balance_result_path_invalid")}
                              </span>
                            )
                          }
                        >
                          <Input
                            value={textValue(balanceOption.resultPath)}
                            onChange={(event) =>
                              patchDraft({ balanceOption: { ...balanceOptionOf(draft), resultPath: event.target.value } })
                            }
                            aria-invalid={!resultPathValid}
                          />
                        </SettingsField>
                      </div>
                      <Button
                        type="button"
                        variant="tertiary"
                        size="compact"
                        onClick={() => void checkBalance()}
                        disabled={checkingBalance}
                      >
                        {checkingBalance ? <Loader2 className="animate-spin" /> : <Database />}
                        {t("settings:providers.query")}
                      </Button>
                      {balanceResult ? (
                        <pre className="max-h-56 overflow-auto rounded-[var(--ds-radius-md)] bg-[var(--ds-on-surface)] p-3 text-xs whitespace-pre-wrap">
                          {balanceResult}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}
                </SettingsSwitchRow>
              </SettingsRows>
            </SettingsAdvancedSection>

            <SettingsDetailFooter
              status={<AutosaveStatusRow status={autosave.status} onRetry={() => void autosave.saveNow()} />}
            />
          </SettingsStack>
        </div>
      </SettingsSplit>
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
