// components/settings/proxy.tsx — 网络代理分区（纯搬迁自 routes/settings.tsx）

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff, Globe, Loader2, RefreshCw, RotateCcw, Zap } from "lucide-react";
import type { ProxyConfig, ProxyMode, Settings } from "~/types";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import api from "~/services/api";
import { SectionHeader } from "~/components/settings/shared";
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

// 设置侧边栏导航项"代理"右侧的状态点(P2-7),由 routes/settings.tsx 渲染:用户打开
// 设置任意分区即可看到代理运行态,不必点进本分区。绿=走代理 / 灰=直连(无代理)。
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
// 避免 APP↔PC 备份兼容性波纹。ProxySection 是条件渲染 (切页即 unmount), 必须持久化,
// 否则用户填的测试 URL 切走再回来就丢了。
const PROXY_TEST_URL_KEY = "rikkahub:proxy-test-url";
const DEFAULT_PROXY_TEST_URL = "https://www.gstatic.com/generate_204";

export function ProxySection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  // settings.proxyConfig 由服务端 normalizeState 保证在场,类型单源后无需兜底。
  const initial = settings.proxyConfig;
  const [draft, setDraft] = React.useState<ProxyConfig>(initial);
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
  const [status, setStatus] = React.useState<ProxyStatus | null>(null);
  // 品牌默认 UA(占位符/重置目标),来自后端 proxyStatusPayload;首次拉取前用空串。
  const defaultUA = status?.defaultUserAgent ?? "";

  // R8-2:防抖自动保存统一走共享三件套 hook(保存窗口内键击不丢,语义见 hook 文件头)。
  const autosave = useAutosaveDraft(
    async () => {
      // P0-2: Bun fetch 静默丢弃 SOCKS 代理(表现成直连失败), 在保存前拦截 ——
      // 否则用户保存后看到"已保存"却所有请求失败, 极难排查。仅 manual 模式需校验
      // (其它模式 url 字段被后端忽略)。校验不过:toast 后按"本轮已处理"返回,
      // 用户继续补全 URL 会重新置脏触发下一轮。
      if (draft.mode === "manual") {
        const trimmedUrl = draft.url.trim();
        if (/^socks/i.test(trimmedUrl)) {
          toast.error(t("settings:proxy.socks_not_supported"));
          return;
        }
        if (trimmedUrl && !isValidProxyUrl(trimmedUrl)) {
          toast.error(t("settings:proxy.url_invalid"));
          return;
        }
      }
      const result = await api.post<{ config: ProxyConfig } & ProxyStatus>("settings/proxy", draft);
      onSettings({ ...settings, proxyConfig: result.config });
      setStatus({
        activeUrl: result.activeUrl,
        source: result.source,
        detectedSystemProxy: result.detectedSystemProxy,
        mode: result.mode,
        containerMode: result.containerMode,
        runningPort: result.runningPort,
        defaultPort: result.defaultPort,
        defaultUserAgent: result.defaultUserAgent,
      });
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
  }, [initial.mode, initial.url, initial.username, initial.password, initial.bypassRules, initial.userAgent]);

  // Fetch the active-proxy footer state on mount + after every save so it reflects what the
  // backend is actually using right now (manual override vs auto-detected from system).
  const refreshStatus = React.useCallback(async () => {
    try {
      const next = await api.get<ProxyStatus>("settings/proxy/status");
      setStatus(next);
    } catch (err) {
      console.warn("[proxy] failed to load status", err);
    }
  }, []);
  React.useEffect(() => {
    void refreshStatus();
    // 后端 readSystemProxy 已加 2s TTL 缓存, 这里 3s 轮询命中缓存的成本几乎为零,
    // 用户开关 Clash 后小绿点最多 ~5s (TTL 过期 + 下一轮) 更新。
    const timer = window.setInterval(() => void refreshStatus(), 3_000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  const patch = (next: Partial<ProxyConfig>) => {
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

  // ── 服务端口 ──────────────────────────────────────────────────────────
  // 端口是启动期配置：写入后要重启应用才生效。这里沿用代理的 600ms 防抖自动保存，
  // 但走独立的 settings/port 端点（它需要做范围校验并返回 requiresRestart 提示）。
  const initialPort = settings.preferredPort ?? null;
  const [portDraft, setPortDraft] = React.useState<string>(
    initialPort == null ? "" : String(initialPort),
  );
  const portAutosave = useAutosaveDraft(
    async () => {
      const trimmed = portDraft.trim();
      const parsed = trimmed === "" ? null : Number(trimmed);
      if (
        parsed !== null &&
        (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
      ) {
        toast.error(t("settings:proxy.port_invalid"));
        return;
      }
      await api.post<{ preferredPort: number | null }>("settings/port", { port: parsed });
      onSettings({ ...settings, preferredPort: parsed });
    },
    {
      delayMs: 600,
      onSaveError: (error) =>
        toast.error(error instanceof Error ? error.message : t("settings:proxy.port_save_failed")),
    },
  );

  React.useEffect(() => {
    // 同代理 draft 的保护：用户正在输入时不让 SSE 回推覆盖，避免吞掉刚敲的字符。
    if (portAutosave.isDirty()) return;
    setPortDraft(initialPort == null ? "" : String(initialPort));
  }, [initialPort]);

  // ── 专题10-⑤:立即重启(仅 Tauri 桌面壳渲染按钮) ────────────────────
  // 端口是启动期配置,此前改完只能手动退出再启动。顺序至关重要:
  // 1) 先拿到 relaunch 再停机——若插件不可用,绝不能先把后端停掉造成死页面;
  // 2) 冲刷未到期的端口草稿(600ms 防抖),否则重启丢本次修改;
  // 3) POST app/shutdown 让后端体面停机(全部状态落盘,200 后 ~100ms 自退,
  //    释放端口与数据目录实例锁)——直接 relaunch 会让新旧 sidecar 竞争锁与端口;
  // 4) 短暂等待后 relaunch,旧壳退出钩子发现 sidecar 已退,kill 是空操作。
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const [restarting, setRestarting] = React.useState(false);
  const restartApp = async () => {
    setRestarting(true);
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      if (portAutosave.isDirty()) {
        // 重启前预检草稿合法性:非法端口下 saveNow 会"toast 后视作已处理",若继续
        // 重启用户会错过提示且白重启一次,故在这里中断。
        const trimmed = portDraft.trim();
        const parsed = trimmed === "" ? null : Number(trimmed);
        if (
          parsed !== null &&
          (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
        ) {
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

  const activeDisplay = status?.activeUrl
    ? status.source === "system"
      ? t("settings:proxy.active_from_system", { url: status.activeUrl })
      : status.source === "env"
        ? t("settings:proxy.active_from_env", { url: status.activeUrl })
        : status.activeUrl
    : t("settings:proxy.not_active");

  return (
    <>
      <SectionHeader
        icon={Globe}
        title={t("settings:proxy.title")}
        subtitle={t("settings:proxy.subtitle")}
      />
      <div className="space-y-4">
        <div className="space-y-4 rounded-lg border bg-card p-6">
          <div className="space-y-2">
            <div className="text-base font-medium">{t("settings:proxy.http_title")}</div>
            <div className="text-xs text-muted-foreground">{t("settings:proxy.mode_desc")}</div>
            <Select
              value={draft.mode}
              onValueChange={(v) => patch({ mode: v as ProxyMode })}
              disabled={status?.containerMode === true}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" sideOffset={4}>
                <SelectItem value="auto">{t("settings:proxy.mode_auto")}</SelectItem>
                <SelectItem value="manual">{t("settings:proxy.mode_manual")}</SelectItem>
                <SelectItem value="direct">{t("settings:proxy.mode_direct")}</SelectItem>
                <SelectItem value="env">{t("settings:proxy.mode_env")}</SelectItem>
              </SelectContent>
            </Select>
            <div className="text-xs text-muted-foreground">
              {draft.mode === "auto" && t("settings:proxy.mode_auto_desc")}
              {draft.mode === "manual" && t("settings:proxy.mode_manual_desc")}
              {draft.mode === "direct" && t("settings:proxy.mode_direct_desc")}
              {draft.mode === "env" && t("settings:proxy.mode_env_desc")}
            </div>
            {draft.mode === "env" && status?.containerMode === false && (
              <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
                {t("settings:proxy.env_desktop_hint")}
              </div>
            )}
          </div>

          {status?.containerMode && (
            <div className="rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
              {t("settings:proxy.container_mode_desc")}
            </div>
          )}

          {draft.mode === "manual" && (
            <div className="space-y-3">
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">{t("settings:proxy.address")}</span>
                <div className="flex gap-2">
                  <Input
                    className="flex-1"
                    value={draft.url}
                    onChange={(event) => patch({ url: event.target.value })}
                    placeholder={t("settings:proxy.address_ph")}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => void detectSystemProxy()}
                    disabled={detecting}
                  >
                    {detecting ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RefreshCw className="size-4" />
                    )}
                    {t("settings:proxy.detect")}
                  </Button>
                </div>
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium">
                    {t("settings:proxy.username")}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      {t("settings:proxy.optional")}
                    </span>
                  </span>
                  <Input
                    value={draft.username}
                    onChange={(event) => patch({ username: event.target.value })}
                    placeholder="proxy username"
                    autoComplete="off"
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium">
                    {t("settings:proxy.password")}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      {t("settings:proxy.optional")}
                    </span>
                  </span>
                  <div className="relative">
                    <Input
                      type={showPassword ? "text" : "password"}
                      value={draft.password}
                      onChange={(event) => patch({ password: event.target.value })}
                      placeholder="proxy password"
                      autoComplete="off"
                      className="pr-9"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((value) => !value)}
                      tabIndex={-1}
                      className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted"
                    >
                      {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                </label>
              </div>
            </div>
          )}

          {(draft.mode === "auto" || draft.mode === "manual") && (
            <div className="space-y-1.5">
              <div className="text-sm font-medium">{t("settings:proxy.bypass_rules")}</div>
              <Input
                value={draft.bypassRules}
                onChange={(e) => patch({ bypassRules: e.target.value })}
                placeholder={t("settings:proxy.bypass_rules_placeholder")}
              />
              <p className="text-xs text-muted-foreground">{t("settings:proxy.bypass_rules_desc")}</p>
            </div>
          )}

          <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {t("settings:proxy.current")}:
            <span className="font-mono text-foreground">{activeDisplay}</span>
          </div>

          <div className="flex justify-end">
            <AutosaveStatusRow
              status={autosave.status}
              onRetry={() => void autosave.saveNow()}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Input
                value={testUrl}
                onChange={(e) => updateTestUrl(e.target.value)}
                placeholder={DEFAULT_PROXY_TEST_URL}
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => void testProxy()}
                disabled={testing || !status?.activeUrl}
              >
                {testing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Zap className="size-4" />
                )}
                {t("settings:proxy.test")}
              </Button>
            </div>
            {testResult && (
              <div
                className={`text-xs ${
                  testResult.ok
                    ? "text-success"
                    : "text-destructive"
                }`}
              >
                {testResult.ok
                  ? t("settings:proxy.test_ok", { latency: testResult.latencyMs ?? 0 })
                  : `${t("settings:proxy.test_fail")}${testResult.error ? `: ${testResult.error}` : ""}`}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4 rounded-lg border bg-card p-6">
          <div>
            <div className="text-base font-medium">{t("settings:proxy.ua_title")}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t("settings:proxy.ua_desc")}
            </div>
          </div>
          <label className="block space-y-2">
            <span className="text-sm font-medium">{t("settings:proxy.ua_label")}</span>
            <div className="flex gap-2">
              <Input
                className="flex-1 font-mono text-sm"
                value={draft.userAgent ?? ""}
                onChange={(event) => patch({ userAgent: event.target.value })}
                placeholder={defaultUA}
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={!draft.userAgent}
                onClick={() => patch({ userAgent: "" })}
              >
                <RotateCcw className="size-4" />
                {t("settings:proxy.ua_reset")}
              </Button>
            </div>
          </label>
          <div className="flex justify-end">
            <AutosaveStatusRow
              status={autosave.status}
              onRetry={() => void autosave.saveNow()}
            />
          </div>
        </div>

        <div className="space-y-4 rounded-lg border bg-card p-6">
          <div>
            <div className="text-base font-medium">{t("settings:proxy.port_title")}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t("settings:proxy.port_desc", { port: status?.defaultPort ?? "…" })}
            </div>
          </div>
          <label className="block space-y-2">
            <span className="text-sm font-medium">
              {t("settings:proxy.port_number")}{" "}
              <span className="text-xs font-normal text-muted-foreground">
                {t("settings:proxy.port_number_hint", { port: status?.defaultPort ?? "…" })}
              </span>
            </span>
            <Input
              type="number"
              inputMode="numeric"
              disabled={status?.containerMode === true}
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
            <div className="flex justify-end">
              <AutosaveStatusRow
                status={portAutosave.status}
                onRetry={() => void portAutosave.saveNow()}
              />
            </div>
          </label>
          {status?.containerMode ? (
            <div className="text-xs text-muted-foreground">
              {t("settings:proxy.port_container_locked")}
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
              <span>{t("settings:proxy.port_restart_note")}</span>
              {isTauri && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => void restartApp()}
                  disabled={restarting}
                >
                  {restarting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RotateCcw className="size-4" />
                  )}
                  {t("settings:proxy.restart_now")}
                </Button>
              )}
            </div>
          )}
          {status?.runningPort != null && (
            <div className="text-xs text-muted-foreground">
              {t("settings:proxy.port_running", { port: status.runningPort })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
