// components/settings/proxy.tsx — 网络 › 代理 与 网络 › 端口与请求 两页。
// 两页同写 settings/proxy(代理五项 / UA),后端字段级合并,各页只提交自己的字段。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff, Loader2, RefreshCw, RotateCcw, Zap } from "lucide-react";
import type { ProxyConfig, ProxyMode, Settings } from "~/types";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Notice } from "~/components/ui/notice";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { patchSettingsLocal } from "~/lib/settings-patch";
import { isTauriEnvironment } from "~/lib/system-info";
import api from "~/services/api";
import { cn } from "~/lib/utils";
import {
  SettingsField,
  SettingsGroup,
  SettingsRow,
  SettingsRows,
  SettingsStack,
} from "~/components/settings/shared";
import { AutosaveStatusRow } from "~/components/settings/autosave-status";

interface ProxyStatus {
  activeUrl: string | null;
  source: "manual" | "system" | "env" | "none";
  detectedSystemProxy: string | null;
  // 当前 mode 与容器标记(后端 proxyStatusPayload 返回)。containerMode=true 时 UI 锁定 mode=env 只读。
  mode: ProxyMode;
  containerMode: boolean;
  // 实际运行端口(顺延后可能与 preferredPort 不同), 端口 Card 显示
  runningPort: number | null;
  // 平台默认端口(容器 8080/桌面冷门默认,后端 proxyStatusPayload 下发)——端口说明与
  // 输入框占位符的唯一来源,前端不写死端口号
  defaultPort: number;
  // 品牌默认 UA(后端 proxyStatusPayload 返回),UA 输入框占位符/重置目标。
  defaultUserAgent: string;
}

function isValidProxyUrl(url: string): boolean {
  // 允许 "host:port" / "http://host:port" / "https://..."。先补 scheme 再用 WHATWG URL 校验,
  // 与后端 composeProxyUrl 的容错保持一致(用户可不填 scheme)。
  const withScheme = /^https?:\/\//i.test(url) ? url : `http://${url}`;
  try {
    const u = new URL(withScheme);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}

// 设置侧边栏导航项「网络」右侧的状态点(P2-7),由 settings-panel 的导航列表渲染:用户打开
// 设置任意页即可看到代理运行态,不必点进代理页。绿=走代理 / 灰=直连(无代理)。
// 独立轮询,不依赖 ProxySection(后端状态接口有 TTL 缓存,轮询成本趋零)。
export function ProxyNavDot() {
  const { t } = useTranslation();
  const [st, setSt] = React.useState<{ activeUrl: string | null } | null>(null);
  React.useEffect(() => {
    const refresh = async () => {
      try {
        const s = await api.get<{ activeUrl: string | null }>("settings/proxy/status");
        setSt({ activeUrl: s.activeUrl });
      } catch {
        // 后端未起或请求失败时静默, 不显示点
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 3_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!st) return null;
  const cls = st.activeUrl ? "bg-success" : "bg-muted-foreground/30";
  const tip = st.activeUrl
    ? t("settings:proxy.nav_status_proxy", { url: st.activeUrl })
    : t("settings:proxy.nav_status_direct");
  return <span className={`ml-auto size-2 shrink-0 rounded-full ${cls}`} title={tip} />;
}

// 测试 URL 是纯 UI 偏好 (不属于代理配置), 存 localStorage 即可 — 不进 settings/备份,
// 避免 APP↔PC 备份兼容性波纹。代理页切走即卸载, 必须持久化,
// 否则用户填的测试 URL 切走再回来就丢了。
const PROXY_TEST_URL_KEY = "rikkahub:proxy-test-url";
const DEFAULT_PROXY_TEST_URL = "https://www.gstatic.com/generate_204";

type ProxyFields = Pick<ProxyConfig, "mode" | "url" | "username" | "password" | "bypassRules">;
type ProxySaveResult = { config: ProxyConfig } & ProxyStatus;

function proxyFieldsOf(config: ProxyConfig): ProxyFields {
  return {
    mode: config.mode,
    url: config.url,
    username: config.username,
    password: config.password,
    bypassRules: config.bypassRules,
  };
}

function statusOf(result: ProxySaveResult): ProxyStatus {
  return {
    activeUrl: result.activeUrl,
    source: result.source,
    detectedSystemProxy: result.detectedSystemProxy,
    mode: result.mode,
    containerMode: result.containerMode,
    runningPort: result.runningPort,
    defaultPort: result.defaultPort,
    defaultUserAgent: result.defaultUserAgent,
  };
}

/**
 * 代理运行态(当前生效代理、容器标记、端口、默认 UA)。挂载即拉、之后 3s 轮询——后端
 * readSystemProxy 有 2s TTL 缓存,轮询命中缓存的成本几乎为零,用户开关 Clash 后状态最多
 * ~5s 更新。setStatus 供保存响应直接写回(响应里带着最新状态,不必等下一轮)。
 */
function useProxyStatus() {
  const [status, setStatus] = React.useState<ProxyStatus | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await api.get<ProxyStatus>("settings/proxy/status");
        if (!cancelled) setStatus(next);
      } catch (err) {
        console.warn("[proxy] failed to load status", err);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return { status, setStatus };
}

/** 两页共用的保存:只 POST 本页拥有的字段(后端字段级合并),乐观更新基于 store 最新快照。 */
async function saveProxyFields(fields: Partial<ProxyConfig>): Promise<ProxySaveResult> {
  const result = await api.post<ProxySaveResult>("settings/proxy", fields);
  patchSettingsLocal({ proxyConfig: result.config });
  return result;
}

/** 网络 › 代理:代理模式、手动地址与认证、绕过规则、当前代理、连通性测试。 */
export function ProxySection({ settings }: { settings: Settings; onSettings: (settings: Settings) => void }) {
  const { t } = useTranslation();
  const addressId = React.useId();
  const modeId = React.useId();
  const bypassId = React.useId();
  const usernameId = React.useId();
  const passwordId = React.useId();
  const { status, setStatus } = useProxyStatus();

  const initial = proxyFieldsOf(settings.proxyConfig);
  const [draft, setDraft] = React.useState<ProxyFields>(initial);
  const [showPassword, setShowPassword] = React.useState(false);
  const [detecting, setDetecting] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testUrl, setTestUrl] = React.useState<string>(() => {
    try {
      return window.localStorage.getItem(PROXY_TEST_URL_KEY) || DEFAULT_PROXY_TEST_URL;
    } catch {
      return DEFAULT_PROXY_TEST_URL;
    }
  });
  const updateTestUrl = React.useCallback((v: string) => {
    setTestUrl(v);
    try { window.localStorage.setItem(PROXY_TEST_URL_KEY, v); } catch { /* 隐私模式/SSR */ }
  }, []);
  const [testResult, setTestResult] = React.useState<{ ok: boolean; status?: number; latencyMs?: number; error?: string } | null>(null);

  // R8-2:防抖自动保存统一走共享三件套 hook(保存窗口内键击不丢,语义见 hook 文件头)。
  const autosave = useAutosaveDraft(
    async () => {
      // P0-2: Bun fetch 静默丢弃 SOCKS 代理(表现成直连失败), 在保存前拦截 ——
      // 否则用户保存后看到"已保存"却所有请求失败, 极难排查。仅 manual 模式需校验
      // (其它模式 url 字段被后端忽略)。校验不过就抛出:状态行显示保存失败而不是
      // "已自动保存",用户继续补全 URL 会重新置脏触发下一轮。
      if (draft.mode === "manual") {
        const trimmedUrl = draft.url.trim();
        if (/^socks/i.test(trimmedUrl)) throw new Error(t("settings:proxy.socks_not_supported"));
        if (trimmedUrl && !isValidProxyUrl(trimmedUrl)) throw new Error(t("settings:proxy.url_invalid"));
      }
      setStatus(statusOf(await saveProxyFields(draft)));
    },
    {
      delayMs: 600,
      onSaveError: (error) =>
        toast.error(error instanceof Error ? error.message : t("settings:proxy.save_failed")),
    },
  );

  React.useEffect(() => {
    // Only adopt the settings-prop value when the user isn't mid-edit. Without this guard,
    // a save round-trip races with continued typing: the SSE push of the (older) saved
    // value arrives a few ms after the user has typed another character, and naively
    // resetting `draft` from `initial` would wipe those new keystrokes.
    if (autosave.isDirty()) return;
    setDraft(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.mode, initial.url, initial.username, initial.password, initial.bypassRules]);

  const patch = (next: Partial<ProxyFields>) => {
    autosave.markDirty();
    setDraft((prev) => ({ ...prev, ...next }));
  };

  const detectSystemProxy = async () => {
    setDetecting(true);
    try {
      const result = await api.post<{ detected: string | null; pac: string | null }>(
        "settings/proxy/detect",
        {},
      );
      if (result.detected) {
        patch({ url: result.detected });
        toast.success(t("settings:proxy.detected_filled", { url: result.detected }));
      } else if (result.pac) {
        // 专题10-②:系统只配了 PAC 自动配置脚本(应用不支持解析),指路去代理工具查端口手动填写。
        toast.message(t("settings:proxy.pac_detected"), {
          description: t("settings:proxy.pac_detected_desc"),
        });
      } else {
        toast.message(t("settings:proxy.none_detected"), {
          description: t("settings:proxy.none_detected_desc"),
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings:proxy.detect_failed"));
    } finally {
      setDetecting(false);
    }
  };

  const testProxy = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.post<{ ok: boolean; status?: number; latencyMs?: number; error?: string }>(
        "settings/proxy/test",
        { url: testUrl.trim() },
      );
      setTestResult(result);
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const activeDisplay = status?.activeUrl
    ? status.source === "system"
      ? t("settings:proxy.active_from_system", { url: status.activeUrl })
      : status.source === "env"
        ? t("settings:proxy.active_from_env", { url: status.activeUrl })
        : status.activeUrl
    : t("settings:proxy.not_active");

  return (
    <SettingsStack>
      <SettingsGroup
        title={t("settings:proxy.http_title")}
        action={<AutosaveStatusRow status={autosave.status} onRetry={() => void autosave.saveNow()} />}
        fields
      >
        <SettingsRows className="-mt-3">
          <SettingsRow
            label={t("settings:proxy.mode")}
            htmlFor={modeId}
            description={t(`settings:proxy.mode_${draft.mode}_desc`)}
            control={
              <Select
                value={draft.mode}
                onValueChange={(v) => patch({ mode: v as ProxyMode })}
                disabled={status?.containerMode === true}
              >
                <SelectTrigger id={modeId} className="w-60 max-w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" sideOffset={4}>
                  <SelectItem value="auto">{t("settings:proxy.mode_auto")}</SelectItem>
                  <SelectItem value="manual">{t("settings:proxy.mode_manual")}</SelectItem>
                  <SelectItem value="direct">{t("settings:proxy.mode_direct")}</SelectItem>
                  <SelectItem value="env">{t("settings:proxy.mode_env")}</SelectItem>
                </SelectContent>
              </Select>
            }
          />
          <SettingsRow
            label={t("settings:proxy.current")}
            control={
              <span className="max-w-72 truncate font-mono text-xs text-[var(--ds-text-primary)]" title={activeDisplay}>
                {activeDisplay}
              </span>
            }
          />
        </SettingsRows>
        {draft.mode === "env" && status?.containerMode === false && (
          <Notice tone="warning">{t("settings:proxy.env_desktop_hint")}</Notice>
        )}

        {status?.containerMode && (
          <Notice>{t("settings:proxy.container_mode_desc")}</Notice>
        )}

        {draft.mode === "manual" && (
          <>
            <SettingsField label={t("settings:proxy.address")} htmlFor={addressId}>
              <div className="flex gap-2">
                <Input
                  id={addressId}
                  className="flex-1"
                  value={draft.url}
                  onChange={(event) => patch({ url: event.target.value })}
                  placeholder={t("settings:proxy.address_ph")}
                />
                <Button
                  type="button"
                  variant="tertiary"
                  size="compact"
                  className="shrink-0"
                  onClick={() => void detectSystemProxy()}
                  disabled={detecting}
                >
                  {detecting ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                  {t("settings:proxy.detect")}
                </Button>
              </div>
            </SettingsField>

            <div className="grid grid-cols-2 gap-3">
              <SettingsField
                htmlFor={usernameId}
                label={
                  <>
                    {t("settings:proxy.username")}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">{t("settings:proxy.optional")}</span>
                  </>
                }
              >
                <Input
                  id={usernameId}
                  value={draft.username}
                  onChange={(event) => patch({ username: event.target.value })}
                  placeholder={t("settings:proxy.username_ph")}
                  autoComplete="off"
                />
              </SettingsField>
              <SettingsField
                htmlFor={passwordId}
                label={
                  <>
                    {t("settings:proxy.password")}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">{t("settings:proxy.optional")}</span>
                  </>
                }
              >
                <div className="relative">
                  <Input
                    id={passwordId}
                    type={showPassword ? "text" : "password"}
                    value={draft.password}
                    onChange={(event) => patch({ password: event.target.value })}
                    placeholder={t("settings:proxy.password_ph")}
                    autoComplete="off"
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    aria-label={showPassword ? t("settings:proxy.hide_password") : t("settings:proxy.show_password")}
                    title={showPassword ? t("settings:proxy.hide_password") : t("settings:proxy.show_password")}
                    className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted"
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </SettingsField>
            </div>
          </>
        )}

        {(draft.mode === "auto" || draft.mode === "manual") && (
          <SettingsField
            label={t("settings:proxy.bypass_rules")}
            htmlFor={bypassId}
            hint={t("settings:proxy.bypass_rules_desc")}
          >
            <Input
              id={bypassId}
              value={draft.bypassRules}
              onChange={(e) => patch({ bypassRules: e.target.value })}
              placeholder={t("settings:proxy.bypass_rules_placeholder")}
            />
          </SettingsField>
        )}

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Input
              aria-label={t("settings:proxy.test")}
              value={testUrl}
              onChange={(e) => updateTestUrl(e.target.value)}
              placeholder={DEFAULT_PROXY_TEST_URL}
              className="flex-1"
            />
            <Button
              type="button"
              variant="tertiary"
              size="compact"
              className="shrink-0"
              onClick={() => void testProxy()}
              disabled={testing || !status?.activeUrl}
            >
              {testing ? <Loader2 className="size-4 animate-spin" /> : <Zap className="size-4" />}
              {t("settings:proxy.test")}
            </Button>
          </div>
          {testResult && (
            <div className={cn("text-xs", testResult.ok ? "text-[var(--ds-success)]" : "text-[var(--ds-danger)]")}>
              {testResult.ok
                ? t("settings:proxy.test_ok", { latency: testResult.latencyMs ?? 0 })
                : `${t("settings:proxy.test_fail")}${testResult.error ? `: ${testResult.error}` : ""}`}
            </div>
          )}
        </div>
      </SettingsGroup>
    </SettingsStack>
  );
}

function parsePort(raw: string): number | null | "invalid" {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : "invalid";
}

/** 网络 › 端口与请求:服务端口(重启生效)、出站 User-Agent。 */
export function PortRequestSection({ settings }: { settings: Settings; onSettings: (settings: Settings) => void }) {
  const { t } = useTranslation();
  const uaId = React.useId();
  const portId = React.useId();
  const { status, setStatus } = useProxyStatus();
  // 状态到达前不知道是否在容器里(容器内端口由部署方决定、不可改),输入框先禁用。
  const portLocked = status === null || status.containerMode;

  // ── 服务端口 ──────────────────────────────────────────────────────────
  // 端口是启动期配置:写入后要重启应用才生效。600ms 防抖自动保存,走独立的 settings/port
  // 端点(它做范围校验并返回 requiresRestart 提示)。
  const initialPort = settings.preferredPort ?? null;
  const [portDraft, setPortDraft] = React.useState<string>(initialPort == null ? "" : String(initialPort));
  const portAutosave = useAutosaveDraft(
    async () => {
      const parsed = parsePort(portDraft);
      if (parsed === "invalid") throw new Error(t("settings:proxy.port_invalid"));
      await api.post<{ preferredPort: number | null }>("settings/port", { port: parsed });
      patchSettingsLocal({ preferredPort: parsed });
    },
    {
      delayMs: 600,
      onSaveError: (error) =>
        toast.error(error instanceof Error ? error.message : t("settings:proxy.port_save_failed")),
    },
  );
  React.useEffect(() => {
    // 用户正在输入时不让 SSE 回推覆盖,避免吞掉刚敲的字符。
    if (portAutosave.isDirty()) return;
    setPortDraft(initialPort == null ? "" : String(initialPort));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPort]);

  // ── User-Agent ───────────────────────────────────────────────────────
  // 与代理同在 proxyConfig 里,但本页只提交 userAgent 一个字段(后端字段级合并)。
  const initialUa = settings.proxyConfig.userAgent ?? "";
  const [uaDraft, setUaDraft] = React.useState(initialUa);
  const uaAutosave = useAutosaveDraft(
    async () => {
      setStatus(statusOf(await saveProxyFields({ userAgent: uaDraft })));
    },
    {
      delayMs: 600,
      onSaveError: (error) =>
        toast.error(error instanceof Error ? error.message : t("settings:proxy.save_failed")),
    },
  );
  React.useEffect(() => {
    if (uaAutosave.isDirty()) return;
    setUaDraft(initialUa);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUa]);
  const patchUa = (value: string) => {
    uaAutosave.markDirty();
    setUaDraft(value);
  };

  // ── 专题10-⑤:立即重启(仅 Tauri 桌面壳渲染按钮) ────────────────────
  // 端口是启动期配置,此前改完只能手动退出再启动。顺序至关重要:
  // 1) 先拿到 relaunch 再停机——若插件不可用,绝不能先把后端停掉造成死页面;
  // 2) 冲刷未到期的端口草稿(600ms 防抖),否则重启丢本次修改;
  // 3) POST app/shutdown 让后端体面停机(全部状态落盘,200 后 ~100ms 自退,
  //    释放端口与数据目录实例锁)——直接 relaunch 会让新旧 sidecar 竞争锁与端口;
  // 4) 短暂等待后 relaunch,旧壳退出钩子发现 sidecar 已退,kill 是空操作。
  const isTauri = isTauriEnvironment();
  const [restarting, setRestarting] = React.useState(false);
  const restartApp = async () => {
    setRestarting(true);
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      if (portAutosave.isDirty()) {
        // 重启前预检草稿合法性:非法端口下保存会失败,若继续重启用户会错过提示且白重启一次。
        if (parsePort(portDraft) === "invalid") {
          toast.error(t("settings:proxy.port_invalid"));
          setRestarting(false);
          return;
        }
        await portAutosave.saveNow({ force: true });
      }
      try {
        await api.post("app/shutdown", {});
      } catch {
        // 停机请求可能因服务端立即退出而断开——属预期,继续重启。
      }
      await new Promise((resolve) => window.setTimeout(resolve, 600));
      await relaunch();
    } catch (err) {
      setRestarting(false);
      toast.error(t("settings:proxy.restart_failed"));
      console.warn("[port] restart failed", err);
    }
  };

  return (
    <SettingsStack>
      <SettingsGroup
        title={t("settings:proxy.port_title")}
        description={t("settings:proxy.port_desc", { port: status?.defaultPort ?? "…" })}
        action={<AutosaveStatusRow status={portAutosave.status} onRetry={() => void portAutosave.saveNow()} />}
        fields
      >
        <SettingsRows className="-mt-3">
          <SettingsRow
            label={t("settings:proxy.port_number")}
            htmlFor={portId}
            description={
              status?.runningPort != null
                ? t("settings:proxy.port_running", { port: status.runningPort })
                : t("settings:proxy.port_number_hint", { port: status?.defaultPort ?? "…" })
            }
            control={
              <Input
                id={portId}
                className="w-28"
                type="number"
                inputMode="numeric"
                disabled={portLocked}
                value={portDraft}
                onChange={(event) => {
                  portAutosave.markDirty();
                  setPortDraft(event.target.value);
                }}
                placeholder={status?.defaultPort != null ? String(status.defaultPort) : ""}
                min={1}
                max={65535}
                step={1}
              />
            }
          />
        </SettingsRows>
        {status?.containerMode ? (
          <div className="text-xs text-[var(--ds-text-secondary)]">{t("settings:proxy.port_container_locked")}</div>
        ) : status ? (
          <Notice
            tone="warning"
            action={
              isTauri ? (
                <Button type="button" variant="tertiary" size="compact" onClick={() => void restartApp()} disabled={restarting}>
                  {restarting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                  {t("settings:proxy.restart_now")}
                </Button>
              ) : undefined
            }
          >
            {t("settings:proxy.port_restart_note")}
          </Notice>
        ) : null}
      </SettingsGroup>

      <SettingsGroup
        title={t("settings:proxy.ua_title")}
        description={t("settings:proxy.ua_desc")}
        action={<AutosaveStatusRow status={uaAutosave.status} onRetry={() => void uaAutosave.saveNow()} />}
        fields
      >
        <SettingsField
          label={t("settings:proxy.ua_label")}
          htmlFor={uaId}
          trailing={
            uaDraft ? (
              <Button type="button" variant="ghost" size="compact" onClick={() => patchUa("")}>
                <RotateCcw />
                {t("settings:proxy.ua_reset")}
              </Button>
            ) : null
          }
        >
          <Input
            id={uaId}
            className="font-mono text-sm"
            value={uaDraft}
            onChange={(event) => patchUa(event.target.value)}
            placeholder={status?.defaultUserAgent ?? ""}
            autoComplete="off"
            spellCheck={false}
          />
        </SettingsField>
      </SettingsGroup>
    </SettingsStack>
  );
}
