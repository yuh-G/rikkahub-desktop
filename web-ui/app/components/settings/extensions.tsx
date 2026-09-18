// components/settings/extensions.tsx — MCP 与扩展分区（MCP 服务器/模式注入/世界书/快捷消息/技能编辑器，纯搬迁自 routes/settings.tsx）

import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Bot,
  CopyPlus,
  Database,
  Download,
  Loader2,
  MessageSquareText,
  Plus,
  Trash2,
  TriangleAlert,
  Upload,
  WandSparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import Markdown from "~/components/markdown/markdown";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import { openExternal } from "~/lib/external-link";
import { cn } from "~/lib/utils";
import api, { appendWebAuthQuery } from "~/services/api";
import { confirmDialog } from "~/stores/confirm-store";
import { useMcpHealthStore } from "~/stores";
import type { AssistantProfile, McpHealthEntryDto, Settings } from "~/types";
import {
  clone,
  moveItem,
  numberText,
  SectionHeader,
  SortableRow,
  textValue,
} from "~/components/settings/shared";

interface SkillFileInfo {
  path: string;
  size: number;
  type: "file" | "directory";
}

interface SkillProfile {
  name: string;
  description: string;
  compatibility?: string;
  allowedTools?: string[];
  content?: string;
  // P4 规范化诊断(后端 listSkillsWithDiagnostics):available=false 表示引擎拒绝加载
  // (description 缺失);issues 是逐字镜像 pi 校验规则的英文技术文案,原样内联展示。
  available?: boolean;
  issues?: Array<{ level: "error" | "warning"; message: string }>;
}

export function McpExtensionsSection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  type Tab = "mcp" | "mode" | "lorebook" | "quick" | "skills";
  const tabFromQuery = React.useMemo<Tab>(() => {
    if (typeof window === "undefined") return "mcp";
    const value = new URLSearchParams(window.location.search).get("tab");
    return value === "mcp" ||
      value === "mode" ||
      value === "lorebook" ||
      value === "quick" ||
      value === "skills"
      ? value
      : "mcp";
  }, []);
  const [tab, setTab] = React.useState<Tab>(tabFromQuery);
  const [selectedAssistantId, setSelectedAssistantId] = React.useState(settings.assistantId);
  // issue #49(1.5.0):本分区是设置页唯一按助手配置的分区,顶部选择器与五个子编辑器全依赖
  // selectedAssistant。正常契约下 assistants 恒非空(normalize 播种+删除防线),但异常数据
  // (Docker 卷手改 state、导入损坏备份、跨版本错配)会让渲染期裸解引用把整个分区放大成
  // 错误边界白屏("Oops")。此处按 boundary 数据收口:空则渲染引导空态,恒不裸传 undefined。
  const assistants = Array.isArray(settings.assistants) ? settings.assistants : [];
  const selectedAssistant =
    assistants.find((item) => item.id === selectedAssistantId) ?? assistants[0];

  React.useEffect(() => {
    if (!assistants.some((item) => item.id === selectedAssistantId))
      setSelectedAssistantId(settings.assistantId);
  }, [selectedAssistantId, settings.assistantId, assistants]);

  if (!selectedAssistant) {
    return (
      <>
        <SectionHeader
          icon={CopyPlus}
          title={t("settings:mcp.title")}
          subtitle={t("settings:mcp.subtitle")}
        />
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t("settings:mcp.no_assistants")}
        </div>
      </>
    );
  }

  return (
    <>
      <SectionHeader
        icon={CopyPlus}
        title={t("settings:mcp.title")}
        subtitle={t("settings:mcp.subtitle")}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(
          [
            ["mcp", "MCP", CopyPlus],
            ["mode", t("settings:mcp.tab.mode"), WandSparkles],
            ["lorebook", t("settings:mcp.tab.lorebook"), Database],
            ["quick", t("settings:mcp.tab.quick"), MessageSquareText],
            ["skills", "Skills", Bot],
          ] as Array<[Tab, string, React.ComponentType<{ className?: string }>]>
        ).map(([idValue, label, Icon]) => (
          <Button
            key={String(idValue)}
            variant={tab === idValue ? "default" : "outline"}
            size="sm"
            onClick={() => setTab(idValue as Tab)}
          >
            {React.createElement(Icon as React.ComponentType<{ className?: string }>, {
              className: "size-4",
            })}
            {label}
          </Button>
        ))}
        <div className="ml-auto min-w-56">
          <Select value={selectedAssistant.id} onValueChange={setSelectedAssistantId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {assistants.map((assistant) => (
                <SelectItem key={assistant.id} value={assistant.id}>
                  {assistant.name || t("settings:assistants.default_name")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {tab === "mcp" && (
        <McpServerEditor
          settings={settings}
          assistant={selectedAssistant}
          onSettings={onSettings}
        />
      )}
      {tab === "mode" && (
        <ModeInjectionEditor
          settings={settings}
          assistant={selectedAssistant}
          onSettings={onSettings}
        />
      )}
      {tab === "lorebook" && (
        <LorebookEditor settings={settings} assistant={selectedAssistant} onSettings={onSettings} />
      )}
      {tab === "quick" && (
        <QuickMessageEditor
          settings={settings}
          assistant={selectedAssistant}
          onSettings={onSettings}
        />
      )}
      {tab === "skills" && (
        <SkillsEditor settings={settings} assistant={selectedAssistant} onSettings={onSettings} />
      )}
    </>
  );
}

function prettyJson(value: unknown) {
  return JSON.stringify(value ?? [], null, 2);
}

function parseJson<T>(value: string, fallback: T, errorMsg = "Invalid JSON"): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    void fallback;
    throw new Error(errorMsg);
  }
}

async function pullSettings(onSettings: (settings: Settings) => void) {
  const next = await api.get<Settings>("settings");
  onSettings(next);
  return next;
}

function mcpName(server: Record<string, unknown>) {
  const common =
    server.commonOptions && typeof server.commonOptions === "object"
      ? (server.commonOptions as Record<string, unknown>)
      : {};
  return textValue(common.name) || "MCP Server";
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
  assistant,
  onSettings,
}: {
  settings: Settings;
  assistant: AssistantProfile;
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
    { delayMs: 800, errorLabel: t("settings:mcp.title") },
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
      titleOf={mcpName}
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
            <span className="truncate">{mcpName(item)}</span>
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
          <Select
            value={textValue(draft.type) || "streamable_http"}
            onValueChange={(value) => patchDraft({ ...draft, type: value })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="streamable_http">Streamable HTTP</SelectItem>
              <SelectItem value="sse">SSE</SelectItem>
            </SelectContent>
          </Select>
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
              const name = textValue(tool.name) || "unnamed_tool";
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
                                title={isRequired ? `${propName} (required)` : propName}
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
    id: crypto.randomUUID(),
    type: "streamable_http",
    url: "",
    commonOptions: { enable: true, name: "MCP Server", headers: [], tools: [] },
  };
}

function ModeInjectionEditor({
  settings,
  assistant,
  onSettings,
}: {
  settings: Settings;
  assistant: AssistantProfile;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const items = (settings.modeInjections ?? []) as Array<Record<string, unknown>>;
  const [selectedId, setSelectedId] = React.useState(textValue(items[0]?.id));
  const selected =
    items.find((item) => String(item.id) === selectedId) ?? items[0] ?? createModeInjection();
  const [draft, setDraft] = React.useState<Record<string, unknown>>(clone(selected));
  // itemsRef: avoid re-running this effect after every autosave → pullSettings round-trip
  // (would overwrite mid-flight keystrokes). See McpServerEditor for rationale.
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  React.useEffect(() => {
    const next = itemsRef.current.find((item) => String(item.id) === selectedId) ?? itemsRef.current[0];
    if (next) {
      setSelectedId(String(next.id));
      setDraft(clone(next));
    }
  }, [selectedId]);
  return (
    <PromptItemEditor
      settings={settings}
      assistant={assistant}
      onSettings={onSettings}
      items={items}
      selectedId={selectedId}
      setSelectedId={setSelectedId}
      draft={draft}
      setDraft={setDraft}
      bindKey="modeInjectionIds"
      savePath="settings/mode-injection/detail"
      deletePath="settings/mode-injection"
      reorderPath="settings/mode-injection/reorder"
      createItem={createModeInjection}
      title={t("settings:mcp.tab.mode")}
    />
  );
}

function createModeInjection(): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    type: "mode",
    name: "提示词注入",
    enabled: true,
    priority: 0,
    position: "after_system_prompt",
    role: "USER",
    injectDepth: 4,
    content: "",
  };
}

function createLorebookEntry(): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    name: "",
    enabled: true,
    priority: 0,
    position: "after_system_prompt",
    role: "USER",
    injectDepth: 4,
    scanDepth: 4,
    keywords: [],
    useRegex: false,
    caseSensitive: false,
    constantActive: false,
    content: "",
  };
}

function LorebookEntryRow({
  entry,
  index,
  onChange,
  onDelete,
}: {
  entry: Record<string, unknown>;
  index: number;
  onChange: (next: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState(false);
  const patch = (next: Partial<Record<string, unknown>>) => onChange({ ...entry, ...next });
  const keywords = Array.isArray(entry.keywords) ? entry.keywords.map(String) : [];
  const position = textValue(entry.position) || "after_system_prompt";
  const usesStandaloneMessage =
    position === "top_of_chat" || position === "bottom_of_chat" || position === "at_depth";
  const constantActive = entry.constantActive === true;
  const triggerSummary = constantActive
    ? t("settings:mcp.constant_active")
    : keywords.length > 0
      ? t("settings:mcp.keywords_count", { count: keywords.length })
      : t("settings:mcp.no_trigger");
  return (
    <div className="rounded-md border bg-background">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={cn(
              "size-2 rounded-full",
              entry.enabled === false ? "bg-muted-foreground/40" : "bg-success",
            )}
          />
          <span className="truncate text-sm font-medium">
            {textValue(entry.name) || t("settings:mcp.entry_n", { n: index + 1 })}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">· {triggerSummary}</span>
        </span>
        <ChevronDownChip expanded={expanded} />
      </button>
      {expanded ? (
        <div className="space-y-3 border-t px-3 py-3">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.name")}</span>
              <Input
                value={textValue(entry.name)}
                onChange={(event) => patch({ name: event.target.value })}
                placeholder={t("settings:mcp.entry_name_ph")}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.priority")}</span>
              <Input
                type="number"
                value={numberText(entry.priority)}
                onChange={(event) => patch({ priority: Number(event.target.value) })}
                placeholder="0"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.position")}</span>
              <Select value={position} onValueChange={(value) => patch({ position: value })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="before_system_prompt">{t("settings:mcp.pos.before")}</SelectItem>
                  <SelectItem value="after_system_prompt">{t("settings:mcp.pos.after")}</SelectItem>
                  <SelectItem value="top_of_chat">{t("settings:mcp.pos.top")}</SelectItem>
                  <SelectItem value="bottom_of_chat">{t("settings:mcp.pos.bottom")}</SelectItem>
                  <SelectItem value="at_depth">{t("settings:mcp.pos.depth")}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {usesStandaloneMessage ? (
              <label className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.role")}</span>
                <Select
                  value={textValue(entry.role) || "USER"}
                  onValueChange={(value) => patch({ role: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USER">User</SelectItem>
                    <SelectItem value="ASSISTANT">Assistant</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            ) : null}
            {position === "at_depth" ? (
              <label className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.inject_depth")}</span>
                <Input
                  type="number"
                  min={1}
                  value={numberText(entry.injectDepth ?? 4)}
                  onChange={(event) =>
                    patch({ injectDepth: Math.max(1, Number(event.target.value) || 4) })
                  }
                  placeholder="4"
                />
              </label>
            ) : null}
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t("settings:mcp.scan_depth")}
              </span>
              <Input
                type="number"
                min={1}
                value={numberText(entry.scanDepth ?? 4)}
                onChange={(event) =>
                  patch({ scanDepth: Math.max(1, Number(event.target.value) || 4) })
                }
                placeholder="4"
              />
            </label>
          </div>
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t("settings:mcp.keywords_label")}
            </span>
            <KeywordChipInput
              keywords={keywords}
              disabled={constantActive}
              onChange={(next) => patch({ keywords: next })}
            />
          </label>
          <div className="grid gap-2 md:grid-cols-3">
            <label className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <span>{t("settings:mcp.use_regex")}</span>
              <Switch
                checked={entry.useRegex === true}
                onCheckedChange={(checked) => patch({ useRegex: checked })}
                disabled={constantActive}
              />
            </label>
            <label className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <span>{t("settings:mcp.case_sensitive")}</span>
              <Switch
                checked={entry.caseSensitive === true}
                onCheckedChange={(checked) => patch({ caseSensitive: checked })}
                disabled={constantActive}
              />
            </label>
            <label className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <span>{t("settings:mcp.constant_active")}</span>
              <Switch
                checked={constantActive}
                onCheckedChange={(checked) => patch({ constantActive: checked })}
              />
            </label>
          </div>
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.inject_content")}</span>
            <Textarea
              value={textValue(entry.content)}
              onChange={(event) => patch({ content: event.target.value })}
              className="min-h-32 font-mono text-xs leading-relaxed"
              placeholder={t("settings:mcp.inject_content_ph")}
            />
          </label>
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={entry.enabled !== false}
                onCheckedChange={(checked) => patch({ enabled: checked })}
              />
              <span>{t("settings:mcp.enable_entry")}</span>
            </label>
            <Button type="button" variant="ghost" size="sm" onClick={onDelete}>
              <Trash2 className="size-4" />
              {t("settings:mcp.delete_entry")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ChevronDownChip({ expanded }: { expanded: boolean }) {
  return (
    <span
      aria-hidden
      className={cn("text-muted-foreground transition", expanded ? "rotate-180" : "rotate-0")}
    >
      ▾
    </span>
  );
}

function KeywordChipInput({
  keywords,
  disabled,
  onChange,
}: {
  keywords: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = React.useState("");
  const commit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (keywords.includes(trimmed)) {
      setValue("");
      return;
    }
    onChange([...keywords, trimmed]);
    setValue("");
  };
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1 rounded-md border bg-background px-2 py-1.5",
        disabled && "opacity-50",
      )}
    >
      {keywords.map((keyword) => (
        <span
          key={keyword}
          className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
        >
          {keyword}
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            disabled={disabled}
            onClick={() => onChange(keywords.filter((item) => item !== keyword))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="min-w-32 flex-1 bg-transparent text-xs outline-none"
        placeholder={disabled ? t("settings:mcp.keywords_disabled_ph") : t("settings:mcp.keywords_ph")}
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            commit();
          } else if (event.key === "Backspace" && !value && keywords.length > 0) {
            onChange(keywords.slice(0, -1));
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}

function LorebookEditor({
  settings,
  assistant,
  onSettings,
}: {
  settings: Settings;
  assistant: AssistantProfile;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const items = (settings.lorebooks ?? []) as Array<Record<string, unknown>>;
  const [selectedId, setSelectedId] = React.useState(textValue(items[0]?.id));
  const selected =
    items.find((item) => String(item.id) === selectedId) ?? items[0] ?? createLorebook();
  const [draft, setDraft] = React.useState<Record<string, unknown>>(clone(selected));
  // R8-2:防抖自动保存统一走共享三件套 hook(保存窗口内键击不丢,语义见 hook 文件头)。
  const autosave = useAutosaveDraft(
    async () => {
      await api.post("settings/lorebook/detail", draft);
      await pullSettings(onSettings);
    },
    { delayMs: 800, errorLabel: t("settings:mcp.tab.lorebook") },
  );
  // itemsRef: avoid re-running this effect after every autosave → pullSettings round-trip
  // (would overwrite mid-flight keystrokes). See McpServerEditor for rationale.
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  React.useEffect(() => {
    const next = itemsRef.current.find((item) => String(item.id) === selectedId) ?? itemsRef.current[0];
    if (!next) return;
    setSelectedId(String(next.id));
    setDraft(clone(next));
    autosave.reset();
  }, [selectedId]);
  const entries = Array.isArray(draft.entries)
    ? (draft.entries as Array<Record<string, unknown>>)
    : [];
  const patchDraft = (patch: Record<string, unknown>) => {
    autosave.markDirty();
    setDraft({ ...draft, ...patch });
  };
  const setEntries = (next: Array<Record<string, unknown>>) => {
    autosave.markDirty();
    setDraft({ ...draft, entries: next });
  };
  const bind = async (checked: boolean) => {
    const ids = new Set(assistant.lorebookIds ?? []);
    if (checked) ids.add(String(draft.id));
    else ids.delete(String(draft.id));
    await api.post("settings/assistant/injections", {
      assistantId: assistant.id,
      lorebookIds: [...ids],
    });
    await pullSettings(onSettings);
  };
  return (
    <EditorShell
      items={items}
      selectedId={selectedId}
      emptyLabel={t("settings:mcp.lorebook.empty")}
      onSelect={setSelectedId}
      titleOf={(item) => textValue(item.name) || t("settings:mcp.tab.lorebook")}
      onMove={async (from, to) => {
        const next = moveItem(items, from, to);
        onSettings({ ...settings, lorebooks: next as unknown as Settings["lorebooks"] });
        await api.post("settings/lorebook/reorder", { ids: next.map((item) => String(item.id)) });
      }}
      onCreate={async () => {
        // Eager-save pattern — same race-condition rationale as MCP and ModeInjection
        // (see settings.tsx:3515 and the PromptItemEditor onCreate comment). The original
        // setState + markDirty approach loses the new lorebook because the
        // `[selectedId, settings.lorebooks]` realignment effect at line 3857 fires when
        // selectedId changes, doesn't find the new id in settings (not saved yet), and
        // snaps the user back to lorebooks[0] — silently dropping the new entry.
        const next = createLorebook();
        next.name = t("settings:mcp.tab.lorebook");
        try {
          await api.post("settings/lorebook/detail", next);
          await pullSettings(onSettings);
          setSelectedId(String(next.id));
          setDraft(next);
          autosave.reset();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : t("settings:mcp.lorebook.create_failed"));
        }
      }}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">{t("settings:mcp.lorebook.detail")}</div>
          <Switch
            checked={(assistant.lorebookIds ?? []).includes(String(draft.id))}
            onCheckedChange={(checked) => void bind(checked)}
          />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.name")}</span>
            <Input
              value={textValue(draft.name)}
              onChange={(event) => patchDraft({ name: event.target.value })}
              placeholder={t("settings:mcp.lorebook.name_ph")}
            />
          </label>
          <label className="flex items-end gap-2">
            <span className="flex-1 space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.lorebook.enable")}</span>
              <div className="rounded-md border px-3 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span>{draft.enabled === false ? t("settings:mcp.disabled") : t("settings:mcp.enabled")}</span>
                  <Switch
                    checked={draft.enabled !== false}
                    onCheckedChange={(checked) => patchDraft({ enabled: checked })}
                  />
                </div>
              </div>
            </span>
          </label>
        </div>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.lorebook.desc")}</span>
          <Input
            value={textValue(draft.description)}
            onChange={(event) => patchDraft({ description: event.target.value })}
            placeholder={t("settings:mcp.lorebook.desc_ph")}
          />
        </label>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">{t("settings:mcp.entries_count", { count: entries.length })}</div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEntries([...entries, createLorebookEntry()])}
            >
              <Plus className="size-4" />
              {t("settings:mcp.add_entry")}
            </Button>
          </div>
          <div className="space-y-2">
            {entries.length === 0 ? (
              <div className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
                {t("settings:mcp.no_entries")}
              </div>
            ) : null}
            {entries.map((entry, index) => (
              <LorebookEntryRow
                key={String(entry.id ?? index)}
                entry={entry}
                index={index}
                onChange={(next) =>
                  setEntries(entries.map((item, idx) => (idx === index ? next : item)))
                }
                onDelete={() => setEntries(entries.filter((_, idx) => idx !== index))}
              />
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <AutosaveStatusRow
            className="mr-auto"
            status={autosave.status}
            onRetry={() => void autosave.saveNow()}
          />
          <Button
            variant="destructive"
            onClick={async () => {
              if (!(await confirmDialog({ title: t("settings:mcp.lorebook.delete_confirm", { name: textValue(draft.name) }), danger: true }))) return;
              // 防复活:丢弃待保存脏编辑并等在飞保存收尾,DELETE 不与迟到 POST 乱序(复审 F1)
              // 删除后显式选中下一条:重对齐 effect 只随 selectedId 触发,不选中会让草稿
              // 停留在已删实体上,再编辑一笔就经自动保存复活它(复审 F2)。
              const remaining = items.filter((item) => String(item.id) !== String(draft.id));
              await autosave.discard();
              await api.delete(`settings/lorebook/${draft.id}`);
              await pullSettings(onSettings);
              if (remaining.length) setSelectedId(String(remaining[0].id));
              else setDraft(clone(createLorebook()));
            }}
          >
            <Trash2 className="size-4" />
            {t("settings:mcp.lorebook.delete")}
          </Button>
        </div>
      </div>
    </EditorShell>
  );
}

function createLorebook(): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    name: "世界书",
    description: "",
    enabled: true,
    entries: [
      {
        id: crypto.randomUUID(),
        name: "",
        enabled: true,
        priority: 0,
        position: "after_system_prompt",
        role: "USER",
        injectDepth: 4,
        scanDepth: 4,
        keywords: [],
        useRegex: false,
        caseSensitive: false,
        content: "",
      },
    ],
  };
}

function QuickMessageEditor({
  settings,
  assistant,
  onSettings,
}: {
  settings: Settings;
  assistant: AssistantProfile;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const items = (settings.quickMessages ?? []) as unknown as Array<Record<string, unknown>>;
  const [selectedId, setSelectedId] = React.useState(textValue(items[0]?.id));
  const selected = items.find((item) => String(item.id) === selectedId) ??
    items[0] ?? { id: crypto.randomUUID(), title: "", content: "" };
  const [draft, setDraft] = React.useState<Record<string, unknown>>(clone(selected));
  // R8-2:防抖自动保存统一走共享三件套 hook(保存窗口内键击不丢,语义见 hook 文件头)。
  const autosave = useAutosaveDraft(
    async () => {
      await api.post("settings/quick-message/detail", draft);
      await pullSettings(onSettings);
    },
    { errorLabel: t("settings:mcp.tab.quick") },
  );
  // itemsRef: avoid re-running this effect after every autosave → pullSettings round-trip
  // (would overwrite mid-flight keystrokes). See McpServerEditor for rationale.
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  React.useEffect(() => {
    const next = itemsRef.current.find((item) => String(item.id) === selectedId) ?? itemsRef.current[0];
    if (next) {
      setSelectedId(String(next.id));
      setDraft(clone(next));
      autosave.reset();
    }
  }, [selectedId]);
  const patchDraft = (patch: Record<string, unknown>) => {
    autosave.markDirty();
    setDraft({ ...draft, ...patch });
  };
  const bind = async (checked: boolean) => {
    const ids = new Set(assistant.quickMessageIds ?? []);
    if (checked) ids.add(String(draft.id));
    else ids.delete(String(draft.id));
    await api.post("settings/assistant/injections", {
      assistantId: assistant.id,
      quickMessageIds: [...ids],
    });
    await pullSettings(onSettings);
  };
  return (
    <EditorShell
      items={items}
      selectedId={selectedId}
      emptyLabel={t("settings:mcp.quick.empty")}
      onSelect={setSelectedId}
      titleOf={(item) => textValue(item.title) || t("settings:mcp.tab.quick")}
      onMove={async (from, to) => {
        const next = moveItem(items, from, to);
        onSettings({ ...settings, quickMessages: next as unknown as Settings["quickMessages"] });
        await api.post("settings/quick-message/reorder", {
          ids: next.map((item) => String(item.id)),
        });
      }}
      onCreate={() => {
        const next = { id: crypto.randomUUID(), title: t("settings:mcp.tab.quick"), content: "" };
        setSelectedId(String(next.id));
        setDraft(next);
        autosave.markDirty();
      }}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">{t("settings:mcp.quick.detail")}</div>
          <Switch
            checked={(assistant.quickMessageIds ?? []).includes(String(draft.id))}
            onCheckedChange={(checked) => void bind(checked)}
          />
        </div>
        <Input
          value={textValue(draft.title)}
          onChange={(event) => patchDraft({ title: event.target.value })}
          placeholder={t("settings:mcp.quick.title")}
        />
        <Textarea
          value={textValue(draft.content)}
          onChange={(event) => patchDraft({ content: event.target.value })}
          className="min-h-52"
          placeholder={t("settings:mcp.quick.content")}
        />
        <div className="flex justify-end gap-2">
          <AutosaveStatusRow
            className="mr-auto"
            status={autosave.status}
            onRetry={() => void autosave.saveNow()}
          />
          <Button
            variant="destructive"
            onClick={async () => {
              if (!(await confirmDialog({ title: t("settings:mcp.quick.delete_confirm", { name: textValue(draft.title) }), danger: true }))) return;
              // 防复活:丢弃待保存脏编辑并等在飞保存收尾,DELETE 不与迟到 POST 乱序(复审 F1);同 Lorebook,删除后显式选中下一条(复审 F2)
              const remaining = items.filter((item) => String(item.id) !== String(draft.id));
              await autosave.discard();
              await api.delete(`settings/quick-message/${draft.id}`);
              await pullSettings(onSettings);
              if (remaining.length) setSelectedId(String(remaining[0].id));
              else setDraft({ id: crypto.randomUUID(), title: "", content: "" });
            }}
          >
            <Trash2 className="size-4" />
            {t("settings:mcp.delete")}
          </Button>
        </div>
      </div>
    </EditorShell>
  );
}

function PromptItemEditor({
  settings,
  assistant,
  onSettings,
  items,
  selectedId,
  setSelectedId,
  draft,
  setDraft,
  bindKey,
  savePath,
  deletePath,
  reorderPath,
  createItem,
  title,
}: {
  settings: Settings;
  assistant: AssistantProfile;
  onSettings: (settings: Settings) => void;
  items: Array<Record<string, unknown>>;
  selectedId: string;
  setSelectedId: (id: string) => void;
  draft: Record<string, unknown>;
  setDraft: (draft: Record<string, unknown>) => void;
  bindKey: "modeInjectionIds";
  savePath: string;
  deletePath: string;
  reorderPath: string;
  createItem: () => Record<string, unknown>;
  title: string;
}) {
  const { t } = useTranslation();
  // R8-2:防抖自动保存统一走共享三件套 hook(保存窗口内键击不丢,语义见 hook 文件头)。
  const autosave = useAutosaveDraft(
    async () => {
      await api.post(savePath, draft);
      await pullSettings(onSettings);
    },
    { errorLabel: title },
  );
  const promptVariables = [
    "{{cur_datetime}}",
    "{{date}}",
    "{{time}}",
    "{{locale}}",
    "{{timezone}}",
    "{{model_name}}",
    "{{user}}",
    "{{char}}",
  ];
  const position = textValue(draft.position) || "after_system_prompt";
  const usesStandaloneMessage =
    position === "top_of_chat" || position === "bottom_of_chat" || position === "at_depth";
  React.useEffect(() => {
    // 只在切换条目时复位;items 不能作依赖——autosave → pullSettings 回环会把保存窗口内
    // 的编辑冲掉(R8-2 病根,同 McpServerEditor 的 serversRef 说明)。
    autosave.reset();
  }, [selectedId]);
  const patchDraft = (patch: Record<string, unknown>) => {
    autosave.markDirty();
    setDraft({ ...draft, ...patch });
  };
  const appendVariable = (variable: string) => {
    const content = textValue(draft.content);
    const separator = content && !content.endsWith("\n") ? "\n" : "";
    patchDraft({ content: `${content}${separator}${variable}` });
  };
  const bind = async (checked: boolean) => {
    const ids = new Set(assistant[bindKey] ?? []);
    if (checked) ids.add(String(draft.id));
    else ids.delete(String(draft.id));
    await api.post("settings/assistant/injections", {
      assistantId: assistant.id,
      [bindKey]: [...ids],
    });
    await pullSettings(onSettings);
  };
  return (
    <EditorShell
      items={items}
      selectedId={selectedId}
      emptyLabel={t("settings:mcp.empty_item", { title })}
      onSelect={setSelectedId}
      titleOf={(item) => textValue(item.name) || title}
      onMove={async (from, to) => {
        const next = moveItem(items, from, to);
        onSettings({ ...settings, modeInjections: next as unknown as Settings["modeInjections"] });
        await api.post(reorderPath, { ids: next.map((item) => String(item.id)) });
      }}
      onCreate={async () => {
        // Eager save — same pattern as McpServerEditor.onCreate. The original code relied
        // on the 700 ms debounce, but two race conditions guaranteed the save never fired:
        //   1. The `[selectedId, items]` effect at line 4108 unconditionally reset
        //      the dirty flag when selectedId changed, cancelling the pending
        //      save.
        //   2. The wrapper component's `[selectedId, settings.modeInjections]` effect
        //      (e.g. line 3600) couldn't find the new id in settings and snapped
        //      selectedId back to items[0], silently overwriting the draft.
        // Saving first removes both races: by the time we touch any state, the new item
        // is already in settings, so both effects behave correctly.
        const next = createItem();
        next.name = title;
        try {
          await api.post(savePath, next);
          await pullSettings(onSettings);
          setSelectedId(String(next.id));
          setDraft(next);
          autosave.reset();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : t("settings:mcp.item_create_failed", { title }));
        }
      }}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">{t("settings:mcp.item_detail", { title })}</div>
          <Switch
            checked={(assistant[bindKey] ?? []).includes(String(draft.id))}
            onCheckedChange={(checked) => void bind(checked)}
          />
        </div>
        <Input
          value={textValue(draft.name)}
          onChange={(event) => patchDraft({ name: event.target.value })}
          placeholder={t("settings:mcp.name_ph")}
        />
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.priority")}</span>
            <Input
              type="number"
              value={numberText(draft.priority)}
              onChange={(event) => patchDraft({ priority: Number(event.target.value) })}
              placeholder="0"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.position")}</span>
            <Select value={position} onValueChange={(value) => patchDraft({ position: value })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="before_system_prompt">{t("settings:mcp.pos.before")}</SelectItem>
                <SelectItem value="after_system_prompt">{t("settings:mcp.pos.after")}</SelectItem>
                <SelectItem value="top_of_chat">{t("settings:mcp.pos.top")}</SelectItem>
                <SelectItem value="bottom_of_chat">{t("settings:mcp.pos.bottom")}</SelectItem>
                <SelectItem value="at_depth">{t("settings:mcp.pos.depth")}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {usesStandaloneMessage ? (
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.role")}</span>
              <Select
                value={textValue(draft.role) || "USER"}
                onValueChange={(value) => patchDraft({ role: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USER">User</SelectItem>
                  <SelectItem value="ASSISTANT">Assistant</SelectItem>
                </SelectContent>
              </Select>
            </label>
          ) : null}
          {position === "at_depth" ? (
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t("settings:mcp.inject_depth_msg")}
              </span>
              <Input
                type="number"
                min={1}
                value={numberText(draft.injectDepth ?? 4)}
                onChange={(event) =>
                  patchDraft({ injectDepth: Math.max(1, Number(event.target.value) || 4) })
                }
                placeholder="4"
              />
            </label>
          ) : null}
        </div>
        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <span className="text-sm">{t("settings:mcp.enabled")}</span>
          <Switch
            checked={draft.enabled !== false}
            onCheckedChange={(checked) => patchDraft({ enabled: checked })}
          />
        </div>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("settings:mcp.template_vars")}</span>
            {promptVariables.map((variable) => (
              <Button
                key={variable}
                type="button"
                size="xs"
                variant="outline"
                onClick={() => appendVariable(variable)}
              >
                {variable}
              </Button>
            ))}
          </div>
          <Textarea
            value={textValue(draft.content)}
            onChange={(event) => patchDraft({ content: event.target.value })}
            className="min-h-64 font-mono text-xs leading-relaxed"
            placeholder={t("settings:mcp.inject_content_template_ph", { cur_datetime: "{{cur_datetime}}" })}
          />
        </div>
        <div className="flex justify-end gap-2">
          <AutosaveStatusRow
            className="mr-auto"
            status={autosave.status}
            onRetry={() => void autosave.saveNow()}
          />
          <Button
            variant="destructive"
            onClick={async () => {
              if (!(await confirmDialog({ title: t("settings:mcp.inject_delete_confirm", { name: textValue(draft.name) }), danger: true }))) return;
              // 防复活:丢弃待保存脏编辑并等在飞保存收尾,DELETE 不与迟到 POST 乱序(复审 F1);同 Lorebook,删除后显式选中下一条(复审 F2)
              const remaining = items.filter((item) => String(item.id) !== String(draft.id));
              await autosave.discard();
              await api.delete(`${deletePath}/${draft.id}`);
              await pullSettings(onSettings);
              if (remaining.length) setSelectedId(String(remaining[0].id));
              else setDraft(clone(createItem()));
            }}
          >
            <Trash2 className="size-4" />
            {t("settings:mcp.delete")}
          </Button>
        </div>
      </div>
    </EditorShell>
  );
}

function SkillsEditor({
  settings,
  assistant,
  onSettings,
}: {
  settings: Settings;
  assistant: AssistantProfile;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const [skills, setSkills] = React.useState<SkillProfile[]>([]);
  const [selected, setSelected] = React.useState("");
  const [content, setContent] = React.useState("");
  const [files, setFiles] = React.useState<SkillFileInfo[]>([]);
  const [githubUrl, setGithubUrl] = React.useState("");
  const [importing, setImporting] = React.useState(false);
  const [importingFile, setImportingFile] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  // R8-2:防抖自动保存统一走共享三件套 hook(保存窗口内键击不丢,语义见 hook 文件头)。
  // 域7-1(3A):保存进行中 indicator 由 hook status 机驱动,不再手维护 saving state。
  const autosave = useAutosaveDraft(
    async () => {
      const name = textValue(parseSkillName(content) || selected || "new-skill");
      await api.post("skills/detail", { name, content });
      await load();
      setSelected(name);
    },
    { delayMs: 900, errorLabel: "Skills" },
  );

  const load = React.useCallback(async () => {
    const list = await api.get<SkillProfile[]>("skills");
    setSkills(list);
    if (!selected && list[0]) setSelected(list[0].name);
  }, [selected]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const selectedSkill = skills.find((skill) => skill.name === selected);

  React.useEffect(() => {
    if (!selected) return;
    if (!selectedSkill) {
      setFiles([]);
      return;
    }
    api
      .get<SkillProfile>(`skills/${encodeURIComponent(selected)}`)
      .then((skill) => {
        // 编辑中(含保存窗口内的键击)不回填服务端内容:每次 autosave → load() 都会换新
        // selectedSkill 触发本 effect,无守卫会把在飞键击冲掉(R8-2 病根)。
        if (autosave.isDirty()) return;
        setContent(skill.content ?? "");
      })
      .catch(() => setContent(""));
    api
      .get<{ files: SkillFileInfo[] }>(`skills/${encodeURIComponent(selected)}/files`)
      .then((result) => setFiles(result.files))
      .catch(() => setFiles([]));
  }, [selected, selectedSkill]);

  const remove = async () => {
    if (!selected) return;
    if (!(await confirmDialog({ title: t("settings:mcp.delete_skill_confirm"), danger: true }))) return;
    // 防复活:丢弃待保存脏编辑并等在飞保存收尾,DELETE 不与迟到 POST 乱序(复审 F1)
    await autosave.discard();
    await api.delete(`skills/${encodeURIComponent(selected)}`);
    setSelected("");
    setContent("");
    await load();
    await pullSettings(onSettings);
  };
  const importFromGitHub = async () => {
    if (!githubUrl.trim()) return;
    setImporting(true);
    try {
      const result = await api.post<{ skill: SkillProfile }>(
        "skills/import-github",
        { repoUrl: githubUrl.trim() },
        { timeout: false },
      );
      await load();
      setSelected(result.skill.name);
      setContent(result.skill.content ?? "");
      autosave.reset();
      setGithubUrl("");
      toast.success(t("settings:mcp.skill_imported", { name: result.skill.name }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:mcp.import_failed"));
    } finally {
      setImporting(false);
    }
  };
  // 对齐安卓 commit af9b1f35 的 importSkillFromFile：支持从本地选择
  // .md/.zip 文件并上传到后端解析。ZIP 包内可含多个技能（每个根目录
  // 下放一份 SKILL.md），全部按原子方式导入。
  const importFromFile = async (file: File) => {
    setImportingFile(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(appendWebAuthQuery("/api/skills/import-file"), {
        method: "POST",
        body: formData,
      });
      const data = (await res.json()) as {
        imported?: string[];
        skills?: SkillProfile[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || t("settings:mcp.import_failed"));
      await load();
      const first = data.skills?.[0];
      if (first) {
        setSelected(first.name);
        setContent(first.content ?? "");
        autosave.reset();
      }
      const names = (data.imported ?? []).join("、");
      toast.success(t("settings:mcp.skill_imported", { name: names || file.name }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:mcp.import_failed"));
    } finally {
      setImportingFile(false);
    }
  };
  const handleFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void importFromFile(file);
  };
  const toggle = async (skillName: string, checked: boolean) => {
    const ids = new Set(assistant.enabledSkills as string[] | undefined);
    if (checked) ids.add(skillName);
    else ids.delete(skillName);
    await api.post("settings/assistant/skills", {
      assistantId: assistant.id,
      enabledSkills: [...ids],
    });
    await pullSettings(onSettings);
  };

  return (
    <EditorShell
      items={skills as unknown as Array<Record<string, unknown>>}
      selectedId={selected}
      emptyLabel={t("settings:mcp.empty_skill")}
      onSelect={setSelected}
      titleOf={(item) => textValue(item.name)}
      renderItem={(item) => {
        const name = textValue(item.name);
        const enabled = (assistant.enabledSkills as string[] | undefined)?.includes(name) ?? false;
        const issues = (item.issues as SkillProfile["issues"]) ?? [];
        const hasError = item.available === false || issues.some((issue) => issue.level === "error");
        return (
          <div className="flex min-w-0 items-center gap-2 text-left">
            <span
              className={`size-2 shrink-0 rounded-full ${enabled ? "bg-success" : "bg-destructive"}`}
            />
            <span className="block min-w-0 truncate font-medium">{name}</span>
            {issues.length > 0 ? (
              <TriangleAlert
                className={`size-3.5 shrink-0 ${hasError ? "text-destructive" : "text-warning"}`}
                aria-label={issues.map((issue) => issue.message).join("; ")}
              />
            ) : null}
          </div>
        );
      }}
      onCreate={() => {
        const name = "new-skill";
        setSelected(name);
        setContent(
          `---\nname: ${name}\ndescription: ${t("settings:mcp.skill_desc_default")}\n---\n\n${t("settings:mcp.skill_body_default")}\n`,
        );
        setFiles([]);
        autosave.markDirty();
      }}
    >
      <div className="space-y-4">
        <div className="rounded-md border p-3">
          <div className="mb-2 text-sm font-medium">{t("settings:mcp.import_github")}</div>
          <div className="flex gap-2">
            <Input
              value={githubUrl}
              onChange={(event) => setGithubUrl(event.target.value)}
              placeholder={t("settings:mcp.github_url_ph")}
              onKeyDown={(event) => {
                if (event.key === "Enter") void importFromGitHub();
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => void importFromGitHub()}
              disabled={importing || !githubUrl.trim()}
            >
              {importing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              {t("settings:mcp.import_btn")}
            </Button>
          </div>
        </div>
        <div className="rounded-md border p-3">
          <div className="mb-2 text-sm font-medium">{t("settings:mcp.import_file")}</div>
          <div
            className="mb-2 text-xs text-muted-foreground"
            dangerouslySetInnerHTML={{ __html: t("settings:mcp.import_file_desc") }}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.markdown,.zip,application/zip"
            className="hidden"
            onChange={handleFileInputChange}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={importingFile}
          >
            {importingFile ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
            {t("settings:mcp.select_file")}
          </Button>
        </div>
        <div className="space-y-2 rounded-md border p-3">
          {skills.map((skill) => (
            <label
              key={skill.name}
              className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted/40"
            >
              <Checkbox
                className="mt-0.5"
                checked={
                  (assistant.enabledSkills as string[] | undefined)?.includes(skill.name) ?? false
                }
                onCheckedChange={(checked) => void toggle(skill.name, checked === true)}
              />
              <span className="min-w-0 flex-1 truncate font-medium">{skill.name}</span>
            </label>
          ))}
        </div>
        {selectedSkill?.description ? (
          <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
            {selectedSkill.description}
          </div>
        ) : null}
        {selectedSkill?.issues?.length ? (
          <div className="space-y-1.5 rounded-md border border-warning/40 bg-warning/5 p-3">
            <div className="text-xs font-medium">{t("settings:mcp.skill_issues_title")}</div>
            {selectedSkill.available === false ? (
              <div className="text-xs text-destructive">{t("settings:mcp.skill_unavailable_hint")}</div>
            ) : null}
            {selectedSkill.issues.map((issue) => (
              <div
                key={issue.message}
                className={`font-mono text-xs ${issue.level === "error" ? "text-destructive" : "text-warning"}`}
              >
                {issue.message}
              </div>
            ))}
          </div>
        ) : null}
        <div className="rounded-md border">
          <div className="border-b px-3 py-2 text-sm font-medium">{t("settings:mcp.file_list")}</div>
          <div className="max-h-40 overflow-auto p-2">
            {files.length === 0 ? (
              <div className="p-2 text-sm text-muted-foreground">{t("settings:mcp.no_files")}</div>
            ) : null}
            {files.map((file) => (
              <div
                key={file.path}
                className="flex items-center justify-between gap-3 rounded px-2 py-1 text-xs hover:bg-muted/40"
              >
                <span className={file.type === "directory" ? "font-medium" : ""}>{file.path}</span>
                <span className="text-muted-foreground">
                  {file.type === "directory" ? t("settings:mcp.directory") : `${file.size} B`}
                </span>
              </div>
            ))}
          </div>
        </div>
        <label className="block space-y-2">
          <span className="text-sm font-medium">SKILL.md</span>
          <Textarea
            value={content}
            onChange={(event) => {
              autosave.markDirty();
              setContent(event.target.value);
            }}
            className="h-80 max-h-80 font-mono text-xs"
          />
        </label>
        <div className="flex justify-end gap-2">
          <AutosaveStatusRow
            className="mr-auto"
            status={autosave.status}
            onRetry={() => void autosave.saveNow()}
          />
          <Button variant="destructive" onClick={() => void remove()} disabled={!selected}>
            <Trash2 className="size-4" />
            {t("settings:mcp.delete")}
          </Button>
        </div>
      </div>
    </EditorShell>
  );
}

function parseSkillName(content: string) {
  const match = content.match(/^---[\s\S]*?\nname:\s*([^\n]+)[\s\S]*?\n---/);
  return match?.[1]?.trim().replace(/^"|"$/g, "");
}

function EditorShell({
  items,
  selectedId,
  emptyLabel,
  onSelect,
  onMove,
  titleOf,
  renderItem,
  onCreate,
  children,
}: {
  items: Array<Record<string, unknown>>;
  selectedId: string;
  emptyLabel: string;
  onSelect: (id: string) => void;
  onMove?: (from: number, to: number) => void | Promise<void>;
  titleOf: (item: Record<string, unknown>) => string;
  renderItem?: (item: Record<string, unknown>) => React.ReactNode;
  onCreate: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <div className="rounded-lg border bg-card p-3">
        <Button className="mb-3 w-full" variant="outline" onClick={onCreate}>
          <Plus className="size-4" />
          {t("settings:mcp.add_new")}
        </Button>
        <div className="space-y-1">
          {items.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              {emptyLabel}
            </div>
          ) : null}
          {items.map((item, index) => (
            <SortableRow
              key={String(item.id ?? item.name)}
              id={String(item.id ?? item.name)}
              index={index}
              active={String(item.id ?? item.name) === selectedId}
              onSelect={() => onSelect(String(item.id ?? item.name))}
              onMove={onMove ? (from, to) => void onMove(from, to) : undefined}
            >
              {renderItem ? (
                renderItem(item)
              ) : (
                <div className="truncate text-left">{titleOf(item)}</div>
              )}
            </SortableRow>
          ))}
        </div>
      </div>
      <div className="rounded-lg border bg-card p-5">{children}</div>
    </div>
  );
}
