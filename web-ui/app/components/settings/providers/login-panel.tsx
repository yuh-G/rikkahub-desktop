// components/settings/providers/login-panel.tsx — 订阅供应商(OAuth)登录面板。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Notice } from "~/components/ui/notice";
import { copyTextToClipboard } from "~/lib/clipboard";
import { isDesktopShell, openExternal } from "~/lib/external-link";
import api from "~/services/api";
import { onAppEvent, type ProviderAuthEventDto } from "~/services/app-events";
import { useSettingsStore } from "~/stores/app-store";
import { confirmDialog } from "~/stores/confirm-store";
import type { ProviderProfile, Settings } from "~/types";

/** 订阅供应商登录面板(方案 §4.3 三态卡片)。inline 卡片非模态——用户需要看着验证码
 *  操作手机,浏览器登录经系统浏览器完成。凭据永不下发,状态全经 SSE provider_auth。 */
export function ProviderLoginPanel({ provider }: { provider: ProviderProfile }) {
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
              <div className="flex items-center gap-3 rounded-[var(--ds-radius-md)] bg-[var(--ds-on-surface)] px-3 py-2">
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
              <div className="flex items-center gap-3 rounded-[var(--ds-radius-md)] bg-[var(--ds-on-surface)] px-3 py-2">
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
