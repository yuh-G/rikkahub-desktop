// components/settings/extensions/mcp.tsx — 拓展 › MCP

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import Markdown from "~/components/markdown/markdown";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import { openExternal } from "~/lib/external-link";
import { cn } from "~/lib/utils";
import { createId } from "~/lib/id";
import api from "~/services/api";
import { confirmDialog } from "~/stores/confirm-store";
import { useMcpHealthStore } from "~/stores";
import type { McpHealthEntryDto, Settings } from "~/types";
import { clone, moveItem, textValue } from "~/components/settings/shared";
import {
  ChevronDownChip,
  EditorShell,
  parseJson,
  prettyJson,
  pullSettings,
  type SectionProps,
} from "~/components/settings/extensions/common";

/** 拓展 › MCP。MCP 服务器是全局配置(哪个助手用它在输入框 MCP 选择器里决定),无需选助手。 */
export function McpSection({ settings, onSettings }: SectionProps) {
  return <McpServerEditor settings={settings} onSettings={onSettings} />;
}

function mcpName(server: Record<string, unknown>, fallback: string) {
  const common =
    server.commonOptions && typeof server.commonOptions === "object"
      ? (server.commonOptions as Record<string, unknown>)
      : {};
  return textValue(common.name) || fallback;
}

/** 状态灯(决策①克制口径):健康快照驱动,而非 lastSyncError 化石。
 *  离线兜底——健康快照尚未到达(刚启动/后端旧版)时回退到 settings 的 connected 字段,
 *  避免首屏闪烁。idle(未启用/未被任何助手选中)永不标红。 */
function mcpStatusKey(server: Record<string, unknown>, health?: McpHealthEntryDto): { ok: boolean; key: string } {
  const common =
    server.commonOptions && typeof server.commonOptions === "object"
      ? (server.commonOptions as Record<string, unknown>)
      : {};
  if (common.enable === false) return { ok: false, key: "off" };
  if (health) {
    switch (health.status) {
      case "ready": return { ok: true, key: "connected" };
      case "reconnecting": return { ok: true, key: "reconnecting" };
      case "failed": return { ok: false, key: "error" };
    }
  }
  // 离线兜底(健康快照未达):沿用旧逻辑
  if (common.connected === false || textValue(common.lastSyncError)) return { ok: false, key: "error" };
  return { ok: true, key: "connected" };
}

function McpServerEditor({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const mcpHealth = useMcpHealthStore((s) => s.health);
  const servers = (settings.mcpServers ?? []) as Array<Record<string, unknown>>;
  const [selectedId, setSelectedId] = React.useState(textValue(servers[0]?.id));
  const selected =
    servers.find((item) => String(item.id) === selectedId) ?? servers[0] ?? createMcpServer();
  const [draft, setDraft] = React.useState<Record<string, unknown>>(clone(selected));
  const [headersText, setHeadersText] = React.useState(
    prettyJson((selected.commonOptions as Record<string, unknown> | undefined)?.headers ?? []),
  );
  const [toolsText, setToolsText] = React.useState(
    prettyJson((selected.commonOptions as Record<string, unknown> | undefined)?.tools ?? []),
  );
  // R8-2:三件套竞态防护("URL input eats characters" 的修复)抽成共享 hook,本编辑器是
  // 原始出处——语义与病史见 hooks/use-autosave-draft.ts 文件头。
  // draft/headersText/toolsText 走 ref 取最新值:persist 既被防抖调用(渲染早已提交),
  // 也被 patchCommon 同步立即调用(setState 尚未提交,由 patch 同步写 ref 保证新鲜)。
  const draftRef = React.useRef(draft);
  draftRef.current = draft;
  const headersTextRef = React.useRef(headersText);
  headersTextRef.current = headersText;
  const toolsTextRef = React.useRef(toolsText);
  toolsTextRef.current = toolsText;
  // 域7-1(3A):保存进行中 indicator 由 hook status 机驱动,删掉手维护 busy;
  // save 体内的 POST 失败仍沿 return 路径抛给 hook → status=failed + 缺省 toast。
  const autosave = useAutosaveDraft(
    async () => {
      const currentDraft = draftRef.current;
      const currentCommon =
        currentDraft.commonOptions && typeof currentDraft.commonOptions === "object"
          ? (currentDraft.commonOptions as Record<string, unknown>)
          : {};
      const payload = {
        ...currentDraft,
        commonOptions: {
          ...currentCommon,
          headers: parseJson<unknown[]>(headersTextRef.current, [], t("settings:mcp.json_invalid")),
          tools: parseJson<unknown[]>(toolsTextRef.current, [], t("settings:mcp.json_invalid")),
        },
      };
      const result = await api.post<{ server: Record<string, unknown> }>(
        "settings/mcp-server/detail",
        payload,
      );
      setSelectedId(String(result.server.id));
      applyServerResult(result.server);
      await pullSettings(onSettings);
    },
    { delayMs: 800, errorLabel: t("settings:subnav.extensions.mcp") },
  );
  // serversRef lets the realignment effect read the freshest servers list WITHOUT taking
  // settings.mcpServers as a dependency. If settings.mcpServers were a dep, the effect
  // would re-fire after every save → pullSettings round-trip and overwrite in-flight
  // keystrokes — the original "URL input eats characters" bug.
  const serversRef = React.useRef(servers);
  serversRef.current = servers;

  const markDirty = () => autosave.markDirty();

  React.useEffect(() => {
    // Re-load the form only when the user switches server (selectedId). settings.mcpServers
    // is intentionally NOT a dep — see serversRef above.
    const all = serversRef.current;
    const next = all.find((item) => String(item.id) === selectedId) ?? all[0];
    if (!next) return;
    if (String(next.id) !== selectedId) setSelectedId(String(next.id));
    setDraft(clone(next));
    setHeadersText(
      prettyJson((next.commonOptions as Record<string, unknown> | undefined)?.headers ?? []),
    );
    setToolsText(
      prettyJson((next.commonOptions as Record<string, unknown> | undefined)?.tools ?? []),
    );
    autosave.reset();
  }, [selectedId]);

  const common =
    draft.commonOptions && typeof draft.commonOptions === "object"
      ? (draft.commonOptions as Record<string, unknown>)
      : {};
  const tools = Array.isArray(common.tools) ? (common.tools as Array<Record<string, unknown>>) : [];
  // Master switch (commonOptions.enable). When OFF, the per-tool child switches stay
  // visible AND show their last preference, but are read-only & greyed — the user can
  // see what'll come back when they re-enable the master switch.
  const serverEnabled = common.enable !== false;
  // Inline expand state — matches Android McpToolCard (SettingMcpPage.kt:801 `var expanded`).
  // Tracked by tool name (server-unique) so re-renders don't lose the open card.
  const [expandedToolName, setExpandedToolName] = React.useState<string | null>(null);
  const patchDraft = (nextDraft: Record<string, unknown>) => {
    markDirty();
    setDraft(nextDraft);
  };
  // Update one tool's fields (enable / needsApproval) without losing other tools' edits.
  // We mutate both the in-memory tools array (drives the UI) and toolsText (the canonical
  // persistence source consumed by save()) so the debounced auto-save writes the toggle.
  const updateToolAt = (index: number, patch: Partial<Record<string, unknown>>) => {
    const nextTools = tools.map((tool, i) => (i === index ? { ...tool, ...patch } : tool));
    const nextCommon = { ...common, tools: nextTools };
    patchDraft({ ...draft, commonOptions: nextCommon });
    setToolsText(prettyJson(nextTools));
  };
  // Merge the server's authoritative fields (fetched tools, sync status, Transition 1/2
  // enable flips) into the current draft WITHOUT touching user-edited fields (url / name /
  // headers text). Functional setState reads the freshest draft, so keystrokes that landed
  // during the save's network round-trip survive the merge.
  const applyServerResult = (serverData: Record<string, unknown>) => {
    const serverCommon =
      serverData.commonOptions && typeof serverData.commonOptions === "object"
        ? (serverData.commonOptions as Record<string, unknown>)
        : {};
    setDraft((prev) => {
      const prevCommon =
        prev.commonOptions && typeof prev.commonOptions === "object"
          ? (prev.commonOptions as Record<string, unknown>)
          : {};
      return {
        ...prev,
        commonOptions: {
          ...prevCommon,
          tools: serverCommon.tools ?? prevCommon.tools ?? [],
          lastSyncAt: serverCommon.lastSyncAt ?? prevCommon.lastSyncAt,
          lastSyncError: serverCommon.lastSyncError ?? prevCommon.lastSyncError,
          connected: serverCommon.connected ?? prevCommon.connected,
          enable:
            serverCommon.enable !== undefined ? serverCommon.enable : prevCommon.enable,
        },
      };
    });
    setToolsText(prettyJson(serverCommon.tools ?? []));
  };
  // 开关类修改:同步写 ref 后立即落盘(不等防抖),失败 toast。
  const patchCommon = (patch: Record<string, unknown>) => {
    const nextDraft = { ...draft, commonOptions: { ...common, ...patch } };
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    void autosave.saveNow({ force: true }).catch((error) => {
      toast.error(error instanceof Error ? error.message : t("settings:mcp.save_failed"));
    });
  };
  // 专题9 MCP OAuth 2.1(对齐安卓):授权状态以 SSE 推送的 settings 为准(回调落盘后
  // 后端广播,此处自动刷新),不读可能陈旧的 draft。
  const liveServer = servers.find((item) => String(item.id) === String(draft.id));
  const liveServerCommon =
    liveServer?.commonOptions && typeof liveServer.commonOptions === "object"
      ? (liveServer.commonOptions as Record<string, unknown>)
      : {};
  const liveOauth =
    liveServerCommon.oauth && typeof liveServerCommon.oauth === "object"
      ? (liveServerCommon.oauth as Record<string, unknown>)
      : null;
  const oauthAuthorized = Boolean(liveOauth && textValue(liveOauth.accessToken));
  const [oauthBusy, setOauthBusy] = React.useState(false);
  // 决策①③:当前服务器的实时健康项(状态灯/重连按钮的数据源)。
  const liveHealth = useMcpHealthStore((s) => s.health[String(draft.id ?? "")]);
  const [reconnectBusy, setReconnectBusy] = React.useState(false);
  const reconnectNow = async () => {
    setReconnectBusy(true);
    try {
      await api.post("settings/mcp-server/reconnect", { serverId: String(draft.id) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setReconnectBusy(false);
    }
  };
  const startOAuth = async () => {
    // 先把在飞的草稿落盘:授权依赖服务端已保存的 URL。
    setOauthBusy(true);
    try {
      await autosave.saveNow({ force: true });
      const result = await api.post<{ authorizationUrl: string }>(
        "settings/mcp-server/oauth/start",
        { serverId: String(draft.id) },
      );
      await openExternal(result.authorizationUrl);
      toast.info(t("settings:mcp.oauth.browser_opened"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setOauthBusy(false);
    }
  };
  const clearOAuth = async () => {
    if (!(await confirmDialog({ title: t("settings:mcp.oauth.clear_confirm"), danger: true }))) return;
    try {
      await api.post("settings/mcp-server/oauth/clear", { serverId: String(draft.id) });
      await pullSettings(onSettings);
      toast.success(t("settings:mcp.oauth.cleared"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };
  const remove = async () => {
    if (!selected.id) return;
    if (!(await confirmDialog({ title: t("settings:mcp.server.delete_confirm"), danger: true }))) return;
    // 防复活:丢弃待保存脏编辑并等在飞保存收尾,DELETE 不与迟到 POST 乱序(复审 F1)
    const remaining = servers.filter((item) => String(item.id) !== String(selected.id));
    await autosave.discard();
    await api.delete(`settings/mcp-server/${encodeURIComponent(String(selected.id))}`);
    // 先拉全量再选中下一条:此前 setSelectedId("") 先于 pullSettings,重对齐 effect 用
    // 旧列表兜底到 servers[0]——可能正是刚删的那条,草稿对回已删实体(复审 F2)。
    await pullSettings(onSettings);
    if (remaining.length) {
      setSelectedId(String(remaining[0].id));
    } else {
      // 删到空:复位为挂载空列表时同款的空白新草稿(重对齐 effect 无条目可载)
      setSelectedId("");
      setDraft(clone(createMcpServer()));
      setHeadersText("[]");
      setToolsText("[]");
    }
    toast.success(t("settings:mcp.server.deleted"));
  };
  const reorder = async (from: number, to: number) => {
    const next = moveItem(servers, from, to);
    onSettings({ ...settings, mcpServers: next as unknown as Settings["mcpServers"] });
    await api.post("settings/mcp-server/reorder", { ids: next.map((item) => String(item.id)) });
    await pullSettings(onSettings);
  };

  return (
    <EditorShell
      items={servers}
      selectedId={selectedId}
      emptyLabel={t("settings:mcp.server.empty")}
      onSelect={setSelectedId}
      onMove={reorder}
      titleOf={(item) => mcpName(item, t("settings:mcp.server.default_name"))}
      renderItem={(item) => {
        const status = mcpStatusKey(item, mcpHealth[String(item.id ?? "")]);
        return (
          <div className="flex min-w-0 items-center gap-2 text-left">
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                status.key === "reconnecting"
                  ? "animate-pulse bg-amber-500"
                  : status.ok
                    ? "bg-success"
                    : status.key === "off"
                      ? "bg-muted-foreground/40"
                      : "bg-destructive",
              )}
              title={t(`settings:mcp.status_${status.key}`)}
            />
            <span className="truncate">{mcpName(item, t("settings:mcp.server.default_name"))}</span>
          </div>
        );
      }}
      onCreate={async () => {
        // Save the new item server-side BEFORE touching any state. Without the immediate
        // POST, the 800 ms debounce loses the race against the `[selectedId, settings.X]`
        // realignment effect at line 3410 — which fires when `setSelectedId(next.id)`
        // changes the dep, doesn't find the new id in `servers` (settings hasn't refreshed
        // yet), and snaps selectedId back to servers[0]. End result: the new item is
        // silently discarded. Eager-saving guarantees the new item lands in `settings`
        // before the realignment effect runs, so it finds and keeps the just-created id.
        const next = createMcpServer();
        try {
          await api.post("settings/mcp-server/detail", next);
          await pullSettings(onSettings);
          setSelectedId(String(next.id));
          setDraft(clone(next));
          setHeadersText("[]");
          setToolsText("[]");
          autosave.reset();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : t("settings:mcp.server.create_failed"));
        }
      }}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">{t("settings:mcp.server.detail")}</div>
            <div className="text-xs text-muted-foreground">
              {t("settings:mcp.server.detail_desc")}
            </div>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.name")}</span>
            <Input
              value={textValue(common.name)}
              onChange={(event) =>
                patchDraft({ ...draft, commonOptions: { ...common, name: event.target.value } })
              }
              placeholder={t("settings:mcp.name_ph")}
            />
          </label>
          <label className="flex items-end gap-2 pb-1">
            <span className="pb-2 text-sm text-muted-foreground">{t("settings:mcp.enabled")}</span>
            <Switch
              checked={common.enable !== false}
              onCheckedChange={(checked) => patchCommon({ enable: checked })}
            />
          </label>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.transport")}</span>
          <Select
            value={textValue(draft.type) || "streamable_http"}
            onValueChange={(value) => patchDraft({ ...draft, type: value })}
          >
            <SelectTrigger className="w-full" aria-label={t("settings:mcp.transport")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="streamable_http">Streamable HTTP</SelectItem>
              <SelectItem value="sse">SSE</SelectItem>
            </SelectContent>
          </Select>
          </label>
        </div>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.server.url")}</span>
          <Input
            value={textValue(draft.url)}
            onChange={(event) => patchDraft({ ...draft, url: event.target.value })}
            placeholder="https://example.com/mcp"
          />
          <span className="block text-xs text-muted-foreground">
            {t("settings:mcp.server.url_desc")}
          </span>
        </label>
        {/* 决策①③:实时健康状态行——只在"已启用"时显示;故障给人话原因 + 立即重连/重新授权。 */}
        {common.enable !== false && liveHealth ? (
          <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  liveHealth.status === "ready"
                    ? "bg-success"
                    : liveHealth.status === "reconnecting"
                      ? "animate-pulse bg-amber-500"
                      : "bg-destructive",
                )}
              />
              <span className="truncate text-xs text-muted-foreground">
                {liveHealth.status === "ready"
                  ? t("settings:mcp.health.ready")
                  : liveHealth.status === "reconnecting"
                    ? t("settings:mcp.health.reconnecting", { attempt: liveHealth.attempt, max: liveHealth.maxAttempts })
                    : t(`settings:mcp.health.kind_${liveHealth.kind}`, { defaultValue: liveHealth.message })}
              </span>
            </div>
            {liveHealth.status === "failed" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={reconnectBusy}
                onClick={() => void reconnectNow()}
              >
                {reconnectBusy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {liveHealth.kind === "auth_expired" ? t("settings:mcp.oauth.reauthorize") : t("settings:mcp.health.reconnect_now")}
              </Button>
            ) : null}
          </div>
        ) : null}
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.server.headers_json")}</span>
          <Textarea
            value={headersText}
            onChange={(event) => {
              markDirty();
              setHeadersText(event.target.value);
            }}
            className="min-h-24 font-mono text-xs"
            placeholder='[["Authorization","Bearer ..."]]'
          />
          <span className="block text-xs text-muted-foreground">
            {t("settings:mcp.server.headers_desc")}
          </span>
        </label>
        <div className="space-y-2 rounded-md border p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t("settings:mcp.oauth.title")}</div>
              <div className="text-xs text-muted-foreground">{t("settings:mcp.oauth.desc")}</div>
            </div>
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-xs",
                oauthAuthorized ? "bg-success/10 text-success" : "bg-muted text-muted-foreground",
              )}
            >
              {oauthAuthorized
                ? t("settings:mcp.oauth.authorized")
                : t("settings:mcp.oauth.not_authorized")}
            </span>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={oauthBusy || !textValue(draft.url)}
              onClick={() => void startOAuth()}
            >
              {oauthBusy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : null}
              {oauthAuthorized
                ? t("settings:mcp.oauth.reauthorize")
                : t("settings:mcp.oauth.authorize")}
            </Button>
            {liveOauth ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={oauthBusy}
                onClick={() => void clearOAuth()}
              >
                {t("settings:mcp.oauth.clear")}
              </Button>
            ) : null}
          </div>
        </div>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.server.tools_json")}</span>
          <Textarea
            value={toolsText}
            onChange={(event) => {
              markDirty();
              setToolsText(event.target.value);
            }}
            className="h-44 max-h-44 font-mono text-xs"
            placeholder={t("settings:mcp.server.tools_ph")}
          />
          <span className="block text-xs text-muted-foreground">
            {t("settings:mcp.server.tools_desc")}
            {textValue(common.lastSyncError) ? t("settings:mcp.server.last_error", { error: textValue(common.lastSyncError) }) : ""}
          </span>
        </label>
        <div className="rounded-md border">
          <div className="border-b px-3 py-2 text-sm font-medium">{t("settings:mcp.server.tools_title")}</div>
          <div className="max-h-[28rem] overflow-auto p-2">
            {tools.length === 0 ? (
              <div className="p-3 text-sm text-muted-foreground">{t("settings:mcp.server.tools_empty")}</div>
            ) : null}
            {/* McpToolCard mirror — first row: name + needs-approval switch + enable switch +
                expand chevron. Expanded body: markdown description + JSON-schema property tags.
                Matches Android SettingMcpPage.kt:795-902 (no Dialog, all inline).
                Master/child semantics: when the MCP server's commonOptions.enable is false,
                the per-tool switches are read-only and greyed out — but they STILL show the
                user's last preference, which the master-on transition will revive. */}
            {tools.map((tool, index) => {
              const name = textValue(tool.name) || t("settings:mcp.unnamed_tool");
              const description = textValue(tool.description);
              const enabled = tool.enable !== false;
              const needsApproval = tool.needsApproval === true;
              const expanded = expandedToolName === name;
              const schema =
                tool.inputSchema && typeof tool.inputSchema === "object"
                  ? (tool.inputSchema as Record<string, unknown>)
                  : null;
              const properties =
                schema && schema.properties && typeof schema.properties === "object"
                  ? (schema.properties as Record<string, Record<string, unknown>>)
                  : {};
              const required = Array.isArray(schema?.required)
                ? (schema!.required as unknown[]).map(String)
                : [];
              const propertyEntries = Object.entries(properties);
              return (
                <div
                  key={`${name}_${index}`}
                  className={cn(
                    "rounded-md border bg-muted/20 px-3 py-2 mb-2 last:mb-0",
                    !serverEnabled && "opacity-60",
                  )}
                >
                  <div className="flex items-center gap-3">
                    <span className="flex-1 truncate text-sm font-medium" title={name}>
                      {name}
                    </span>
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span>{t("settings:mcp.server.needs_approval")}</span>
                      <Switch
                        checked={needsApproval}
                        disabled={!serverEnabled}
                        onCheckedChange={(checked) =>
                          updateToolAt(index, { needsApproval: checked })
                        }
                      />
                    </label>
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span>{t("settings:mcp.enabled")}</span>
                      <Switch
                        checked={enabled}
                        disabled={!serverEnabled}
                        onCheckedChange={(checked) => updateToolAt(index, { enable: checked })}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => setExpandedToolName(expanded ? null : name)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={expanded ? t("settings:mcp.server.collapse") : t("settings:mcp.server.expand")}
                    >
                      <ChevronDownChip expanded={expanded} />
                    </button>
                  </div>
                  {expanded ? (
                    <div className="mt-2 space-y-2">
                      {description ? (
                        <div className="text-xs text-muted-foreground">
                          <Markdown content={description} className="message-markdown" />
                        </div>
                      ) : null}
                      {propertyEntries.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {propertyEntries.map(([propName]) => {
                            const isRequired = required.includes(propName);
                            return (
                              <span
                                key={propName}
                                className={cn(
                                  "rounded-md px-2 py-0.5 font-mono text-mini",
                                  isRequired
                                    ? "bg-blue-500/10 text-blue-700 dark:text-blue-300"
                                    : "bg-background text-muted-foreground border",
                                )}
                                title={isRequired ? `${propName} ${t("settings:mcp.param_required")}` : propName}
                              >
                                {propName}
                              </span>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <AutosaveStatusRow
            className="mr-auto"
            status={autosave.status}
            onRetry={() => void autosave.saveNow()}
          />
          <Button variant="destructive" onClick={() => void remove()} disabled={!selected.id}>
            <Trash2 className="size-4" />
            {t("settings:mcp.delete")}
          </Button>
        </div>
      </div>
    </EditorShell>
  );
}

function createMcpServer(): Record<string, unknown> {
  return {
    id: createId(),
    type: "streamable_http",
    url: "",
    commonOptions: { enable: true, name: "", headers: [], tools: [] },
  };
}
