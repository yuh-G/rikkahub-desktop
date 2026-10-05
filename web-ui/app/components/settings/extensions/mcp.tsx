// components/settings/extensions/mcp.tsx — 拓展 › MCP

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Notice } from "~/components/ui/notice";
import { StatusBadge } from "~/components/ui/status-badge";
import { SegmentedControl } from "~/components/ui/segmented-tabs";
import { Switch } from "~/components/ui/switch";
import Markdown from "~/components/markdown/markdown";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import { openExternal } from "~/lib/external-link";
import { cn } from "~/lib/utils";
import { copyItemName } from "~/lib/copy-name";
import { createId } from "~/lib/id";
import api from "~/services/api";
import { confirmDialog } from "~/stores/confirm-store";
import { useMcpHealthStore } from "~/stores";
import type { McpHealthEntryDto, Settings } from "~/types";
import { readMcpHeaders, toMcpHeaderPairs } from "@server/tools/mcp-headers";
import {
  clone,
  copyRowAction,
  deleteRowAction,
  moveItem,
  SettingsAdvancedSection,
  SettingsDetailFooter,
  SettingsDetailHeader,
  SettingsEmpty,
  SettingsField,
  SettingsGroup,
  type SettingsKeyValue,
  SettingsKeyValueList,
  SettingsStack,
  textValue,
} from "~/components/settings/shared";
import {
  EditorShell,
  ExpandChevron,
  LabeledSwitch,
  pullSettings,
  type SectionProps,
} from "~/components/settings/extensions/common";

/** 拓展 › MCP。MCP 服务器是全局配置(哪个助手用它在输入框 MCP 选择器里决定),无需选助手。 */
export function McpSection({ settings, onSettings }: SectionProps) {
  return <McpServerEditor settings={settings} onSettings={onSettings} />;
}

const MCP_TRANSPORTS = [
  { value: "streamable_http", label: "Streamable HTTP" },
  { value: "sse", label: "SSE" },
] as const;

function headersOf(commonOptions: unknown): SettingsKeyValue[] {
  const common = commonOptions && typeof commonOptions === "object" ? (commonOptions as Record<string, unknown>) : {};
  return readMcpHeaders(common.headers).map((header) => ({ key: header.name, value: header.value }));
}

/** 工具行内的紧凑开关:标签与开关同排,标签可点击。 */
function ToolSwitch({
  label,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = React.useId();
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <label htmlFor={id} className="text-xs text-[var(--ds-text-secondary)]">
        {label}
      </label>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  );
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
  // 请求头以结构化列表编辑(视图形状 {key,value});持久化形状由 @server/tools/mcp-headers 单源换算。
  const [headers, setHeaders] = React.useState<SettingsKeyValue[]>(() =>
    headersOf(selected.commonOptions),
  );
  // R8-2:三件套竞态防护("URL input eats characters" 的修复)抽成共享 hook,本编辑器是
  // 原始出处——语义与病史见 hooks/use-autosave-draft.ts 文件头。
  // draft/headers 走 ref 取最新值:persist 既被防抖调用(渲染早已提交),
  // 也被 patchCommon 同步立即调用(setState 尚未提交,由 patch 同步写 ref 保证新鲜)。
  const draftRef = React.useRef(draft);
  draftRef.current = draft;
  const headersRef = React.useRef(headers);
  headersRef.current = headers;
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
          headers: toMcpHeaderPairs(headersRef.current.map((item) => ({ name: item.key, value: item.value }))),
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
    setHeaders(headersOf(next.commonOptions));
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
  // 「高级设置」展开态:切换服务器不收起,离开本页(重挂载)复位为收起。
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const patchDraft = (nextDraft: Record<string, unknown>) => {
    markDirty();
    setDraft(nextDraft);
  };
  // 工具列表由服务器同步(tools/list),保存时服务端只保留每个工具的 enable/needsApproval
  // 偏好、其余字段一律以同步结果覆盖——所以这里只改这两个偏好,不提供原始 JSON 编辑。
  const updateToolAt = (index: number, patch: Partial<Record<string, unknown>>) => {
    const nextTools = tools.map((tool, i) => (i === index ? { ...tool, ...patch } : tool));
    patchDraft({ ...draft, commonOptions: { ...common, tools: nextTools } });
  };
  // Merge the server's authoritative fields (fetched tools, sync status, Transition 1/2
  // enable flips) into the current draft WITHOUT touching user-edited fields (url / name /
  // headers). Functional setState reads the freshest draft, so keystrokes that landed
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
  // 删除收口到列表行(右键/悬停「⋯」):按目标行 id 删,不再依赖右侧草稿。
  const removeServerById = async (targetId: string) => {
    if (!targetId) return;
    if (!(await confirmDialog({ title: t("settings:mcp.server.delete_confirm"), danger: true }))) return;
    // 防复活:仅当删的是正在编辑的那条才 discard(丢脏编辑+等在飞保存,DELETE 不与迟到 POST 乱序,复审 F1)
    const removingActive = String(draft.id) === targetId;
    if (removingActive) await autosave.discard();
    const remaining = servers.filter((item) => String(item.id) !== targetId);
    await api.delete(`settings/mcp-server/${encodeURIComponent(targetId)}`);
    // 先拉全量再选中下一条:此前 setSelectedId("") 先于 pullSettings,重对齐 effect 用
    // 旧列表兜底到 servers[0]——可能正是刚删的那条,草稿对回已删实体(复审 F2)。
    await pullSettings(onSettings);
    if (removingActive) {
      if (remaining.length) {
        setSelectedId(String(remaining[0].id));
      } else {
        // 删到空:复位为挂载空列表时同款的空白新草稿(重对齐 effect 无条目可载)
        setSelectedId("");
        setDraft(clone(createMcpServer()));
        setHeaders([]);
      }
    }
    toast.success(t("settings:mcp.server.deleted"));
  };
  // 复制 MCP 服务器:克隆配置(新 id、「原名 (N)」)。oauth 凭据/令牌在服务端且按
  // 服务器 id 绑定,克隆后必须清空——副本连不上时重新授权即可;连接/工具同步状态
  // (connected/lastSyncAt/lastSyncError)是运行时派生,不带走,让副本自己同步。
  const copyServerById = async (targetId: string) => {
    const target = servers.find((item) => String(item.id) === targetId);
    if (!target) return;
    const sourceCommon = target.commonOptions as Record<string, unknown> | undefined;
    const next = {
      ...clone(target),
      id: createId(),
      commonOptions: {
        ...(sourceCommon ?? {}),
        name: copyItemName(mcpName(target, t("settings:mcp.server.default_name")), new Set(servers.map((item) => mcpName(item, t("settings:mcp.server.default_name"))))),
        oauth: null,
        connected: false,
        lastSyncAt: null,
        lastSyncError: "",
      },
    } as Record<string, unknown>;
    try {
      const result = await api.post<{ server: Record<string, unknown> }>("settings/mcp-server/detail", next);
      await pullSettings(onSettings);
      setSelectedId(String(result.server.id));
      setDraft(clone(result.server));
      setHeaders(headersOf(result.server.commonOptions));
      toast.success(t("settings:mcp.server.copied", { name: textValue((result.server.commonOptions as Record<string, unknown> | undefined)?.name) }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:mcp.server.copy_failed"));
    }
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
      rowMenuOf={(item) => {
        const id = String(item.id ?? "");
        if (!id) return undefined;
        return [
          copyRowAction(() => copyServerById(id)),
          deleteRowAction(() => removeServerById(id)),
        ];
      }}
      renderItem={(item) => {
        const status = mcpStatusKey(item, mcpHealth[String(item.id ?? "")]);
        return (
          <div className="flex min-w-0 items-center gap-2 text-left">
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                status.key === "reconnecting"
                  ? "animate-pulse bg-warning"
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
          setHeaders([]);
          autosave.reset();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : t("settings:mcp.server.create_failed"));
        }
      }}
    >
      <div className="@container">
        <SettingsStack>
          <SettingsDetailHeader
            title={textValue(common.name)}
            titlePlaceholder={t("settings:mcp.server.default_name")}
            titleLabel={t("settings:mcp.name")}
            onTitleCommit={(name) => patchDraft({ ...draft, commonOptions: { ...common, name } })}
            description={t("settings:mcp.server.detail_desc")}
            action={
              <LabeledSwitch
                label={t("settings:mcp.enabled")}
                checked={serverEnabled}
                onCheckedChange={(checked) => patchCommon({ enable: checked })}
              />
            }
          />

          <SettingsGroup title={t("settings:mcp.connection_title")} fields>
            <SettingsField label={t("settings:mcp.transport")}>
              <SegmentedControl
                stretch
                aria-label={t("settings:mcp.transport")}
                items={MCP_TRANSPORTS}
                value={textValue(draft.type) === "sse" ? "sse" : "streamable_http"}
                onChange={(type) => patchDraft({ ...draft, type })}
              />
            </SettingsField>
            <SettingsField label={t("settings:mcp.server.url")} hint={t("settings:mcp.server.url_desc")}>
              <Input
                value={textValue(draft.url)}
                onChange={(event) => patchDraft({ ...draft, url: event.target.value })}
                placeholder="https://example.com/mcp"
              />
            </SettingsField>
            {/* 决策①③:实时健康状态行——只在"已启用"时显示;故障给人话原因 + 立即重连/重新授权。 */}
            {serverEnabled && liveHealth ? (
              <Notice
                tone={liveHealth.status === "ready" ? "success" : liveHealth.status === "reconnecting" ? "warning" : "danger"}
                icon={
                  <span
                    className={cn(
                      "mt-[5px] size-1.5 shrink-0 rounded-full bg-current",
                      liveHealth.status === "reconnecting" && "animate-pulse",
                    )}
                  />
                }
                action={
                  liveHealth.status === "failed" ? (
                    <Button
                      type="button"
                      size="compact"
                      variant="tertiary"
                      disabled={reconnectBusy || oauthBusy}
                      // 首次 401 即直达授权流(对齐 APP 4ba5d79f):鉴权过期重连无意义,
                      // 直接打开浏览器重新授权;普通故障保持立即重连。
                      onClick={() => void (liveHealth.kind === "auth_expired" ? startOAuth() : reconnectNow())}
                    >
                      {reconnectBusy || oauthBusy ? <Loader2 className="animate-spin" /> : null}
                      {liveHealth.kind === "auth_expired" ? t("settings:mcp.oauth.reauthorize") : t("settings:mcp.health.reconnect_now")}
                    </Button>
                  ) : undefined
                }
              >
                {liveHealth.status === "ready"
                  ? t("settings:mcp.health.ready")
                  : liveHealth.status === "reconnecting"
                    ? t("settings:mcp.health.reconnecting", { attempt: liveHealth.attempt, max: liveHealth.maxAttempts })
                    : t(`settings:mcp.health.kind_${liveHealth.kind}`, { defaultValue: liveHealth.message })}
              </Notice>
            ) : null}
          </SettingsGroup>

          <SettingsGroup
            title={t("settings:mcp.oauth.title")}
            description={t("settings:mcp.oauth.desc")}
            action={
              <StatusBadge tone={oauthAuthorized ? "success" : "neutral"}>
                {oauthAuthorized ? t("settings:mcp.oauth.authorized") : t("settings:mcp.oauth.not_authorized")}
              </StatusBadge>
            }
            fields
          >
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="compact"
                variant="tertiary"
                disabled={oauthBusy || !textValue(draft.url)}
                onClick={() => void startOAuth()}
              >
                {oauthBusy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {oauthAuthorized ? t("settings:mcp.oauth.reauthorize") : t("settings:mcp.oauth.authorize")}
              </Button>
              {liveOauth ? (
                <Button type="button" size="sm" variant="ghost" disabled={oauthBusy} onClick={() => void clearOAuth()}>
                  {t("settings:mcp.oauth.clear")}
                </Button>
              ) : null}
            </div>
          </SettingsGroup>

          <SettingsGroup
            title={t("settings:mcp.server.tools_title")}
            description={
              textValue(common.lastSyncError) ? (
                <span className="text-destructive">
                  {t("settings:mcp.server.last_error", { error: textValue(common.lastSyncError) })}
                </span>
              ) : tools.length > 0 ? (
                t("settings:mcp.server.tools_count", { count: tools.length })
              ) : undefined
            }
            fields
          >
            {tools.length === 0 ? (
              <SettingsEmpty>
                {t("settings:mcp.server.tools_empty")}
              </SettingsEmpty>
            ) : (
              // McpToolCard 镜像:行首 名称 + 需要审核 + 启用 + 展开;展开后是 markdown 描述与
              // 参数标签(对齐安卓 SettingMcpPage.kt:795-902,全部内联)。服务器总开关关闭时
              // 子开关只读置灰,但仍显示上次偏好——重新开启后照此恢复。
              <div className="max-h-[28rem] divide-y divide-[var(--ds-divider)] overflow-auto rounded-[var(--ds-radius-md)] border">
                {tools.map((tool, index) => {
                  const name = textValue(tool.name) || t("settings:mcp.unnamed_tool");
                  const description = textValue(tool.description);
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
                    <div key={`${name}_${index}`} className={cn("px-3 py-2", !serverEnabled && "opacity-60")}>
                      <div className="flex items-center gap-3">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={name}>
                          {name}
                        </span>
                        <ToolSwitch
                          label={t("settings:mcp.server.needs_approval")}
                          checked={tool.needsApproval === true}
                          disabled={!serverEnabled}
                          onCheckedChange={(checked) => updateToolAt(index, { needsApproval: checked })}
                        />
                        <ToolSwitch
                          label={t("settings:mcp.enabled")}
                          checked={tool.enable !== false}
                          disabled={!serverEnabled}
                          onCheckedChange={(checked) => updateToolAt(index, { enable: checked })}
                        />
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          aria-expanded={expanded}
                          aria-label={expanded ? t("settings:mcp.server.collapse") : t("settings:mcp.server.expand")}
                          onClick={() => setExpandedToolName(expanded ? null : name)}
                        >
                          <ExpandChevron expanded={expanded} />
                        </Button>
                      </div>
                      {expanded ? (
                        <div className="mt-2 space-y-2">
                          {description ? (
                            <div className="text-xs text-[var(--ds-text-secondary)]">
                              <Markdown content={description} className="message-markdown" />
                            </div>
                          ) : null}
                          {propertyEntries.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {propertyEntries.map(([propName]) => {
                                const isRequired = required.includes(propName);
                                return (
                                  <StatusBadge
                                    key={propName}
                                    tone={isRequired ? "brand" : "neutral"}
                                    className="font-mono font-normal"
                                    title={isRequired ? `${propName} ${t("settings:mcp.param_required")}` : propName}
                                  >
                                    {propName}
                                  </StatusBadge>
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
            )}
          </SettingsGroup>

          {/* 请求头里通常是鉴权凭据:配置过就亮圆点,默认折叠也不会把它藏起来。 */}
          <SettingsAdvancedSection open={advancedOpen} onOpenChange={setAdvancedOpen} attention={headers.length > 0}>
            <div className="space-y-5 pt-2">
              <SettingsKeyValueList
                label={t("settings:mcp.server.headers")}
                description={t("settings:mcp.server.headers_desc")}
                items={headers}
                onChange={(next) => {
                  markDirty();
                  setHeaders(next);
                }}
                keyPlaceholder={t("settings:common.header_name")}
                valuePlaceholder={t("settings:common.header_value")}
                emptyText={t("settings:common.no_headers")}
                removeLabel={t("settings:common.delete_header")}
              />
            </div>
          </SettingsAdvancedSection>

          <SettingsDetailFooter
            status={<AutosaveStatusRow status={autosave.status} onRetry={() => void autosave.saveNow()} />}
          />
        </SettingsStack>
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
