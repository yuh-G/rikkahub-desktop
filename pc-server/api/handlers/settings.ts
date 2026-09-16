// api/handlers/settings.ts — 设置路由（settings GET/stream、display/keybindings、assistant/*、mcp-server/*、
// mode-injection/*、lorebook/*、quick-message/*、search/*、模型与 provider/*、proxy/port）
// 纪律：纯搬迁自 server.ts routeApi()；settings 数据契约冻结。

import { existsSync } from "node:fs";
import type { Assistant, JsonValue, Provider, ProxyConfig, SearchService } from "../../foundation/types";
import type { Settings } from "../../foundation/types/settings";
import { getStringArray, id, isRecord } from "../../foundation/utils";
import { RUNNING_IN_CONTAINER } from "../../foundation/platform";
import { refreshShellAvailability } from "../../workspace/runtime";
import { shellStatusPayload } from "./workspaces";
import {
  applyEffectiveProxy,
  friendlyRequestError,
  proxyStatusPayload,
  detectSystemProxy,
  detectSystemPacUrl,
  resolveEffectiveProxy,
} from "../../foundation/net";
import { state } from "../../persistence/json-store";
import { defaultAssistant } from "../../assistants/index";
import { firstProviderModel } from "../../model-providers/index";
import { loadModelsDev } from "../../inference-engine/providers";
import { syncMcpServerTools } from "../../tools/mcp";
import { clearMcpOAuth, completeMcpOAuth, ensureFreshMcpToken, startMcpOAuth } from "../../tools/mcp-oauth";
import { listSkills } from "../../tools/skills";
import { testSearchService } from "../../search/index";
import { callImageGeneration } from "../../media/image-gen";
import { memoryStore } from "../../memory/index";
import { invalidateContextSnapshots } from "../../inference-engine/context-snapshots";
import { addLog } from "../logs";
import { error, json, readJson, sseHeaders } from "../request";
import { broadcastMemoryUpdate, sseFrame } from "../sse";
import { deleteById, reorderByIds, uniqueStrings, upsertById, validateKnownJsonIds } from "../../foundation/utils";
import { normalizePreferredPort, normalizeProxyConfig } from "../../foundation/net";
import { defaultSettings } from "../../app-config/defaults";
import { DEFAULT_COMPRESS_PROMPT, DEFAULT_OCR_PROMPT, DEFAULT_PROMPT_OPTIMIZE_PROMPT, DEFAULT_SUGGESTION_PROMPT, DEFAULT_TITLE_PROMPT, DEFAULT_TRANSLATION_PROMPT } from "../../app-config/prompts";
import { PI_COMPACTION_PROMPT } from "../../pi-engine/compaction-prompt-text";
import { updateSettings } from "../../app-config";
import { markProviderTestResult, providerAuthChanged } from "../../model-providers/checks";
import { endpointFor, fetchProviderBalance, fetchProviderModels, runProviderCheck } from "../../model-providers/checks";

// 全面审查 R5-4:MCP 服务器写操作按 id 串行化。detail/sync 在 await 网络同步(秒级)
// 期间存在并发写窗口——同 id 的第二个写请求先落地后,慢的那个整对象覆盖会吃掉它的改动
// (多标签页/双窗口下真实可触发);sync 期间的 DELETE 也会被 sync 完成后的 upsert 复活。
// per-id 队列让同一服务器的 detail/sync/delete 严格排队,彻底关掉窗口。Map 尺寸以用户
// 配置的 MCP 服务器数为上界,无需清理。不同 id 之间不互斥(各写各的,现读现改,安全)。
// 搜索服务的鉴权/端点字段。两处消费必须共用同一集合:detail 保存时任一变更即撤销
// testPassed(R5-3 失效规则);service/test 落章前复核当前配置与被测 body 是否仍一致
// (飞行竞态守卫)。改这份清单 = 同时改两处语义。
const SEARCH_SERVICE_AUTH_FIELDS = ["type", "apiKey", "url", "customUrl", "model", "username", "password", "engines", "mode"] as const;

const mcpServerWriteQueues = new Map<string, Promise<unknown>>();
function withMcpServerWriteLock(serverId: string, task: () => Promise<Response>): Promise<Response> {
  const prev = mcpServerWriteQueues.get(serverId) ?? Promise.resolve();
  const run = prev.then(task, task);
  mcpServerWriteQueues.set(serverId, run.catch(() => { /* 失败已由 task 内部/路由层处理 */ }));
  return run;
}

export interface AssistantInjectionPatch {
  modeInjectionIds?: string[];
  lorebookIds?: string[];
  quickMessageIds?: string[];
}

/** A1复检终极化:助手注入绑定改"部分更新"——只校验并覆盖 body 中出现的数组。
 *  旧的三数组整体覆盖要求每个调用方回填另外两个数组的正确现值,任何一处取错
 *  作用域(如把会话级集当助手级)都会静默改写助手默认;部分更新让这类交叉污染
 *  在结构上不可能发生。省略字段=不动,显式空数组=清空。 */
export function buildAssistantInjectionPatch(
  settings: { modeInjections?: unknown; lorebooks?: unknown; quickMessages?: unknown },
  body: { modeInjectionIds?: unknown; lorebookIds?: unknown; quickMessageIds?: unknown },
): AssistantInjectionPatch {
  const patch: AssistantInjectionPatch = {};
  if (body.modeInjectionIds !== undefined) {
    patch.modeInjectionIds = validateKnownJsonIds(settings.modeInjections, body.modeInjectionIds, "modeInjectionIds");
  }
  if (body.lorebookIds !== undefined) {
    patch.lorebookIds = validateKnownJsonIds(settings.lorebooks, body.lorebookIds, "lorebookIds");
  }
  if (body.quickMessageIds !== undefined) {
    patch.quickMessageIds = validateKnownJsonIds(settings.quickMessages, body.quickMessageIds, "quickMessageIds");
  }
  return patch;
}

export async function handleSettingsRoutes(request: Request, url: URL, path: string): Promise<Response | null> {
  if (path === "settings" && request.method === "GET") return json(state.settings);
  // 各引擎原生压缩 prompt(只读展示,设置页压缩 prompt 对话框的引擎切换标签)。
  // chat 引擎的 prompt 可编辑、走 settings.compressPrompt,不在此列;此端点只暴露
  // "引擎自带、不可编辑"的原生 prompt。数组形状留第三引擎拓展。
  if (path === "settings/engine-compaction-prompts" && request.method === "GET") {
    return json({ engines: [{ engine: "pi", prompt: PI_COMPACTION_PROMPT }] });
  }
  // settings 快照推送已并入 /api/events 通道(settings 事件)。
  if (path === "settings/display" && request.method === "POST") {
    const body = await readJson<Record<string, JsonValue>>(request);
    updateSettings({ ...state.settings, displaySetting: { ...state.settings.displaySetting, ...body } });
    return json({ status: "ok" });
  }
  // 更新单个 action 的快捷键(keys 录制结果)或 enabled 开关。仅接受默认 action 列表内的条目。
  if (path === "settings/keybindings" && request.method === "POST") {
    const body = await readJson<{ action: string; keys?: string[]; enabled?: boolean }>(request);
    const defaults = defaultSettings().keybindings;
    // 批次二 R5-6:`in` 含原型链,"__proto__"/"constructor"/"toString" 都能过检——
    // __proto__ 会把 current 的原型换成请求体(本次写入静默丢失),constructor 等则以
    // 垃圾键持久化进 settings。Object.hasOwn 只认自有键。
    if (typeof body.action !== "string" || !Object.hasOwn(defaults, body.action)) {
      return error("Unknown keybinding action", 400);
    }
    const current = { ...defaults, ...state.settings.keybindings } as Record<string, JsonValue>;
    const existing = isRecord(current[body.action]) ? (current[body.action] as Record<string, JsonValue>) : {};
    const next: Record<string, JsonValue> = { ...existing };
    if (Array.isArray(body.keys)) next.keys = body.keys.filter((k) => typeof k === "string");
    if (typeof body.enabled === "boolean") next.enabled = body.enabled;
    current[body.action] = next;
    updateSettings({ ...state.settings, keybindings: current });
    return json({ status: "ok" });
  }
  // 重置全部快捷键到默认(设置页"恢复默认"按钮)。
  if (path === "settings/keybindings/reset" && request.method === "POST") {
    updateSettings({ ...state.settings, keybindings: defaultSettings().keybindings });
    return json({ status: "ok" });
  }
  if (path === "settings/assistant" && request.method === "POST") {
    const body = await readJson<{ assistantId: string }>(request);
    if (!state.settings.assistants.some((assistant) => assistant.id === body.assistantId)) return error("Assistant not found", 404);
    updateSettings({ ...state.settings, assistantId: body.assistantId });
    return json({ status: "ok" });
  }
  if (path === "settings/assistant/detail" && request.method === "POST") {
    const body = await readJson<Assistant>(request);
    const assistant = { ...defaultAssistant(), ...body, id: body.id || id() };
    updateSettings({
      ...state.settings,
      assistantId: assistant.id,
      assistants: state.settings.assistants.some((item) => item.id === assistant.id)
        ? state.settings.assistants.map((item) => (item.id === assistant.id ? assistant : item))
        : [...state.settings.assistants, assistant],
    });
    // 助手改名后刷新 assistant_memory.json 里的 assistantName 快照(§12.4-22),推前端同步。
    memoryStore.refreshAssistantNames(state.settings.assistants);
    broadcastMemoryUpdate();
    return json({ status: "ok", assistant });
  }
  const assistantDelete = path.match(/^settings\/assistant\/([^/]+)$/);
  if (assistantDelete && request.method === "DELETE") {
    const idValue = decodeURIComponent(assistantDelete[1]);
    if (state.settings.assistants.length <= 1) return error("At least one assistant is required", 400);
    const deleteMemories = url.searchParams.get("deleteMemories") === "true";
    const assistants = state.settings.assistants.filter((item) => item.id !== idValue);
    // M4:默认保留记忆为孤儿(防误删助手导致记忆连带丢失);仅 deleteMemories=true 时连带清。
    if (deleteMemories) {
      memoryStore.deleteMemoriesByAssistant(idValue);
      invalidateContextSnapshots();
      broadcastMemoryUpdate();
    }
    updateSettings({
      ...state.settings,
      assistants,
      assistantId: state.settings.assistantId === idValue ? assistants[0].id : state.settings.assistantId,
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/assistants/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    const byId = new Map(state.settings.assistants.map((item) => [item.id, item]));
    const ordered = body.ids.map((itemId) => byId.get(itemId)).filter(Boolean) as Assistant[];
    const rest = state.settings.assistants.filter((item) => !body.ids.includes(item.id));
    updateSettings({ ...state.settings, assistants: [...ordered, ...rest] });
    return json({ status: "ok" });
  }
  if (path === "settings/assistant/model" && request.method === "POST") {
    const body = await readJson<{ assistantId: string; modelId: string }>(request);
    updateSettings({
      ...state.settings,
      assistants: state.settings.assistants.map((assistant) =>
        assistant.id === body.assistantId ? { ...assistant, chatModelId: body.modelId } : assistant,
      ),
    });
    return json({ status: "ok" });
  }
  if (path === "settings/assistant/thinking-budget" && request.method === "POST") {
    const body = await readJson<{ assistantId: string; reasoningLevel: string }>(request);
    updateSettings({
      ...state.settings,
      assistants: state.settings.assistants.map((assistant) =>
        assistant.id === body.assistantId ? { ...assistant, reasoningLevel: body.reasoningLevel } : assistant,
      ),
    });
    return json({ status: "ok" });
  }
  if (path === "settings/assistant/mcp" && request.method === "POST") {
    const body = await readJson<{ assistantId: string; mcpServerIds: string[] }>(request);
    const assistantExists = state.settings.assistants.some((assistant) => assistant.id === body.assistantId);
    if (!assistantExists) return error("Assistant not found", 404);
    let mcpServerIds: string[];
    try {
      mcpServerIds = validateKnownJsonIds(state.settings.mcpServers, body.mcpServerIds, "mcpServerIds");
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 400);
    }
    updateSettings({
      ...state.settings,
      assistants: state.settings.assistants.map((assistant) => {
        if (assistant.id !== body.assistantId) return assistant;
        // Master-on transition for assistant-level MCP servers. Mirror the global server's
        // behavior: when the user flips an assistant's MCP server master ON, if every tool
        // in this server is currently disabled-by-override for THIS assistant (meaning
        // there's no surviving user preference at the assistant scope), wipe the overrides
        // so the freshly-enabled MCP exposes all globally-enabled tools. If even one tool
        // override doesn't disable a tool, the user has expressed an intentional subset —
        // leave overrides untouched.
        const prevServers = new Set(getStringArray(assistant.mcpServers));
        const newlyAdded: string[] = mcpServerIds.filter((sid) => !prevServers.has(sid));
        const overrides = isRecord(assistant.mcpToolOverrides)
          ? { ...assistant.mcpToolOverrides as Record<string, Record<string, { enable?: boolean; needsApproval?: boolean }>> }
          : {};
        for (const sid of newlyAdded) {
          const globalServer = (state.settings.mcpServers as Array<Record<string, JsonValue>>).find((s) => String(s.id) === sid);
          const globalCommon = globalServer && isRecord(globalServer.commonOptions) ? globalServer.commonOptions : null;
          const globalTools = globalCommon && Array.isArray(globalCommon.tools) ? globalCommon.tools.filter(isRecord) : [];
          const visibleTools = globalTools.filter((tool) => tool.enable !== false);
          if (visibleTools.length === 0) continue;
          const perServerOverride = overrides[sid] ?? {};
          // Every visible tool effectively disabled by THIS assistant means the override
          // map is the only thing standing in the way of these tools being exposed.
          const allOverriddenOff = visibleTools.every((tool) => perServerOverride[String(tool.name ?? "")]?.enable === false);
          if (allOverriddenOff) {
            // Strip per-tool `enable` overrides for this server. Keep needsApproval entries —
            // they're an independent dimension and shouldn't get wiped just because the
            // user re-enabled the master switch.
            const cleanedServerOverride: Record<string, { enable?: boolean; needsApproval?: boolean }> = {};
            for (const [toolName, ov] of Object.entries(perServerOverride)) {
              if (typeof ov?.needsApproval === "boolean") {
                cleanedServerOverride[toolName] = { needsApproval: ov.needsApproval };
              }
            }
            if (Object.keys(cleanedServerOverride).length === 0) {
              delete overrides[sid];
            } else {
              overrides[sid] = cleanedServerOverride;
            }
          }
        }
        return { ...assistant, mcpServers: mcpServerIds, mcpToolOverrides: overrides };
      }),
    });
    return json({ status: "ok" });
  }
  // Per-tool override within one MCP server, for ONE assistant. Body shape:
  //   { assistantId, serverId, toolName, enable?, needsApproval? }
  // - enable: null/undefined → clear override (revert to global); true/false → set
  // - needsApproval: same semantics
  // Sending both nulls removes the entry from mcpToolOverrides[serverId][toolName]. If that
  // makes the server's override map empty, we drop the server key as well to keep state.json
  // tidy.
  if (path === "settings/assistant/mcp-tool-override" && request.method === "POST") {
    const body = await readJson<{
      assistantId?: string;
      serverId?: string;
      toolName?: string;
      enable?: boolean | null;
      needsApproval?: boolean | null;
    }>(request);
    const assistantId = String(body.assistantId ?? "");
    const serverId = String(body.serverId ?? "");
    const toolName = String(body.toolName ?? "");
    if (!assistantId || !serverId || !toolName) {
      return error("assistantId, serverId, toolName are required", 400);
    }
    const assistantExists = state.settings.assistants.some((assistant) => assistant.id === assistantId);
    if (!assistantExists) return error("Assistant not found", 404);
    const serverKnown = (state.settings.mcpServers as Array<Record<string, JsonValue>>).some((server) => String(server.id) === serverId);
    if (!serverKnown) return error("MCP server not found", 404);
    updateSettings({
      ...state.settings,
      assistants: state.settings.assistants.map((assistant) => {
        if (assistant.id !== assistantId) return assistant;
        const overrides = isRecord(assistant.mcpToolOverrides)
          ? { ...assistant.mcpToolOverrides as Record<string, Record<string, { enable?: boolean; needsApproval?: boolean }>> }
          : {};
        const serverOverrides = isRecord(overrides[serverId])
          ? { ...overrides[serverId] }
          : {};
        const next: { enable?: boolean; needsApproval?: boolean } = { ...(serverOverrides[toolName] ?? {}) };
        if (body.enable === null) delete next.enable;
        else if (typeof body.enable === "boolean") next.enable = body.enable;
        if (body.needsApproval === null) delete next.needsApproval;
        else if (typeof body.needsApproval === "boolean") next.needsApproval = body.needsApproval;
        if (Object.keys(next).length === 0) {
          delete serverOverrides[toolName];
        } else {
          serverOverrides[toolName] = next;
        }
        if (Object.keys(serverOverrides).length === 0) {
          delete overrides[serverId];
        } else {
          overrides[serverId] = serverOverrides;
        }
        // Mirror the global server's "all tools off → master off" rule at the assistant
        // scope: if every globally-enabled tool on this server is now disabled-by-override
        // for this assistant, remove the server from assistant.mcpServers (auto master-off).
        // This is the assistant-level counterpart of Transition 2 in settings/mcp-server/detail.
        let mcpServers = assistant.mcpServers;
        if (assistant.mcpServers.includes(serverId)) {
          const globalServer = (state.settings.mcpServers as Array<Record<string, JsonValue>>).find((s) => String(s.id) === serverId);
          const globalCommon = globalServer && isRecord(globalServer.commonOptions) ? globalServer.commonOptions : null;
          const globalTools = globalCommon && Array.isArray(globalCommon.tools) ? globalCommon.tools.filter(isRecord) : [];
          const visibleTools = globalTools.filter((tool) => tool.enable !== false);
          const serverOverrideForCheck = overrides[serverId] ?? {};
          if (visibleTools.length > 0 && visibleTools.every((tool) => serverOverrideForCheck[String(tool.name ?? "")]?.enable === false)) {
            mcpServers = assistant.mcpServers.filter((sid) => sid !== serverId);
          }
        }
        return { ...assistant, mcpServers, mcpToolOverrides: overrides };
      }),
    });
    return json({ status: "ok" });
  }
  if (path === "settings/assistant/injections" && request.method === "POST") {
    const body = await readJson<{
      assistantId: string;
      modeInjectionIds?: string[];
      lorebookIds?: string[];
      quickMessageIds?: string[];
    }>(request);
    const assistantExists = state.settings.assistants.some((assistant) => assistant.id === body.assistantId);
    if (!assistantExists) return error("Assistant not found", 404);
    let patch: AssistantInjectionPatch;
    try {
      patch = buildAssistantInjectionPatch(state.settings, body);
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 400);
    }
    updateSettings({
      ...state.settings,
      assistants: state.settings.assistants.map((assistant) =>
        assistant.id === body.assistantId ? { ...assistant, ...patch } : assistant,
      ),
    });
    return json({ status: "ok" });
  }
  if (path === "settings/assistant/skills" && request.method === "POST") {
    const body = await readJson<{ assistantId: string; enabledSkills: string[] }>(request);
    const assistantExists = state.settings.assistants.some((assistant) => assistant.id === body.assistantId);
    if (!assistantExists) return error("Assistant not found", 404);
    const installedSkillNames = new Set(listSkills().map((skill) => skill.name));
    const enabledSkills = getStringArray(body.enabledSkills);
    const unknownSkill = enabledSkills.find((skillName) => !installedSkillNames.has(skillName));
    if (unknownSkill) return error(`enabledSkills contains unknown skill: ${unknownSkill}`, 400);
    updateSettings({
      ...state.settings,
      assistants: state.settings.assistants.map((assistant) =>
        assistant.id === body.assistantId ? { ...assistant, enabledSkills } : assistant,
      ),
    });
    return json({ status: "ok" });
  }
  if (path === "settings/mcp-server/detail" && request.method === "POST") {
    const body = await readJson<Record<string, JsonValue>>(request);
    const serverId = String(body.id ?? id());
    return withMcpServerWriteLock(serverId, async () => {
      const common = isRecord(body.commonOptions) ? body.commonOptions : {};
      // Read the previous server state so we can detect the user transitioning the main MCP
      // switch from off→on, which has special "revive child switches" semantics (see below).
      const prevServer = (state.settings.mcpServers as Array<Record<string, JsonValue>>)
        .find((item) => String(item.id) === String(body.id ?? "")) ?? null;
      const prevCommon = prevServer && isRecord(prevServer.commonOptions) ? prevServer.commonOptions : null;
      const wasEnabled = prevCommon ? prevCommon.enable !== false : false;
      const willEnable = common.enable !== false;
      // 专题9 MCP OAuth:oauth 状态的权威在服务端(令牌只由后端变更),重建 commonOptions 时
      // 现读最新值透传,避免前端防抖快照把刚刷新的令牌冲掉;新建/导入时取 body 里的。
      const liveOauth = () => {
        const live = (state.settings.mcpServers as Array<Record<string, JsonValue>>)
          .find((item) => String(item.id) === serverId);
        const liveCommon = live && isRecord(live.commonOptions) ? live.commonOptions : null;
        if (liveCommon && "oauth" in liveCommon) return liveCommon.oauth ?? null;
        return isRecord(common.oauth) ? (common.oauth as JsonValue) : null;
      };
      let server: Record<string, JsonValue> = {
        type: String(body.type ?? "streamable_http") === "sse" ? "sse" : "streamable_http",
        url: String(body.url ?? ""),
        ...body,
        id: serverId,
        commonOptions: {
          enable: willEnable,
          name: String(common.name ?? body.name ?? "MCP Server"),
          headers: Array.isArray(common.headers) ? common.headers : [],
          tools: Array.isArray(common.tools) ? common.tools : [],
          lastSyncAt: typeof common.lastSyncAt === "number" ? common.lastSyncAt : null,
          lastSyncError: String(common.lastSyncError ?? ""),
          connected: common.connected === true,
          oauth: liveOauth(),
        },
      };
      // R3-3:ssePostEndpoint 是运行时会话缓存(见 tools/mcp.ts 的 mcpSsePostEndpointCache),
      // 不再持久化。剥掉前端经 ...body 回传的旧值,避免它又写回 settings。
      delete (server as Record<string, JsonValue>).ssePostEndpoint;
      if (isRecord(server.commonOptions) && server.commonOptions.enable !== false && String(server.url ?? "").trim()) {
        // 专题9 MCP OAuth:同步前补新临期令牌(对齐安卓 ensureFreshToken),刷新后重取现值。
        if (prevServer) {
          await ensureFreshMcpToken(prevServer);
          server.commonOptions = { ...server.commonOptions, oauth: liveOauth() };
        }
        server = await syncMcpServerTools(server, addLog);
        // 全域复审 H2:上面的内嵌工具同步是长 await,期间备份恢复/导入可整体替换 settings
        // (不走 per-id 锁)。仅"更新既有服务器"需要防陈旧写回:保存开始时捕获的条目引用
        // 已不在当前 settings → 结果作废;新建(prevServer 为空)保持创建语义不受影响。
        if (prevServer && !(state.settings.mcpServers as JsonValue[]).includes(prevServer)) {
          return error("MCP 服务器在保存期间已被删除或替换,本次保存已丢弃", 409);
        }
      }
      // ── Master/child switch coupling ─────────────────────────────────────────────────
      // The MCP server's `commonOptions.enable` is a master switch; each tool's `enable`
      // is a child switch that persists across master toggles to preserve user intent.
      //
      // Transition 1 — master off → on:
      //   If every child is currently off (i.e. there's no surviving user preference),
      //   revive them all to ON so the freshly-enabled MCP isn't a no-op surprise. If even
      //   one child is on, the user has expressed an intentional subset — leave it alone.
      //
      // Transition 2 — master is on AND user just turned every child off:
      //   Auto-flip master to off, since an MCP with no enabled tools is a dead control.
      //   This pairs with Transition 1: re-enabling later will revive everything.
      //
      // Transition 3 — master on → off (manual):
      //   DON'T touch child states. The user might just be temporarily hiding MCP from
      //   chat; we want their next re-enable to remember which tools were on.
      if (isRecord(server.commonOptions)) {
        const finalCommon = server.commonOptions as Record<string, JsonValue>;
        const tools = Array.isArray(finalCommon.tools) ? finalCommon.tools.filter(isRecord) : [];
        const allOff = tools.length > 0 && tools.every((tool) => tool.enable === false);
        if (!wasEnabled && willEnable && allOff) {
          // Transition 1: revive child switches.
          server.commonOptions = {
            ...finalCommon,
            tools: tools.map((tool) => ({ ...tool, enable: true })),
          };
        } else if (willEnable && allOff) {
          // Transition 2: auto-flip master off. This catches the "user turned off the last
          // tool" case from the per-tool save path (settings/mcp-server/detail also handles
          // tool toggle saves since the UI debounces a full server snapshot).
          server.commonOptions = { ...finalCommon, enable: false };
        }
        // Transition 3 needs no action — the tools array is already preserved verbatim.
      }
      // 落盘前再取一次最新 oauth:同步的长 await 期间可能发生过回调授权/令牌刷新。
      if (isRecord(server.commonOptions)) {
        server.commonOptions = { ...server.commonOptions, oauth: liveOauth() };
      }
      const result = upsertById(state.settings.mcpServers as JsonValue[], server);
      updateSettings({ ...state.settings, mcpServers: result.items });
      return json({ status: "ok", server: result.item });
    });
  }
  const mcpDelete = path.match(/^settings\/mcp-server\/([^/]+)$/);
  if (mcpDelete && request.method === "DELETE") {
    const idValue = decodeURIComponent(mcpDelete[1]);
    return withMcpServerWriteLock(idValue, async () => {
      updateSettings({
        ...state.settings,
        mcpServers: deleteById(state.settings.mcpServers as JsonValue[], idValue),
        assistants: state.settings.assistants.map((assistant) => ({
          ...assistant,
          mcpServers: assistant.mcpServers.filter((serverId) => serverId !== idValue),
        })),
      });
      return json({ status: "deleted" });
    });
  }
  if (path === "settings/mcp-server/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    updateSettings({ ...state.settings, mcpServers: reorderByIds(state.settings.mcpServers as JsonValue[], body.ids ?? []) });
    return json({ status: "ok" });
  }
  if (path === "settings/mcp-server/sync" && request.method === "POST") {
    const body = await readJson<{ serverId: string }>(request);
    return withMcpServerWriteLock(String(body.serverId ?? ""), async () => {
      const server = (state.settings.mcpServers as Array<Record<string, JsonValue>>).find((item) => String(item.id) === body.serverId);
      if (!server) return error("MCP server not found", 404);
      // 专题9 MCP OAuth:同步前补新临期令牌。persistOauth 原地替换 commonOptions、保留 server
      // 引用,下方的防陈旧写回守卫(includes(server))不受影响。
      await ensureFreshMcpToken(server);
      const nextServer = await syncMcpServerTools(server, addLog);
      // 全域复审 H1:per-id 写锁只串行化 detail/sync/delete,挡不住备份恢复/导入(它整体替换
      // settings,不走锁)。同步的长 await 期间若完成了恢复,下面的 upsertById 会把旧世界的
      // 服务器插回新 settings(复活已删/覆盖已改)。写前身份重查(同批6 G1 会话守卫):
      // 起始捕获的条目引用已不在当前 settings → 本次结果作废。其余端点保留引用不变
      // (upsertById/deleteById/reorderByIds 均复用未触及项),不会误伤。
      if (!(state.settings.mcpServers as JsonValue[]).includes(server)) {
        return error("MCP 服务器在同步期间已被删除或替换,同步结果已丢弃", 409);
      }
      const result = upsertById(state.settings.mcpServers as JsonValue[], nextServer);
      updateSettings({ ...state.settings, mcpServers: result.items });
      const common = (isRecord(nextServer.commonOptions) ? nextServer.commonOptions : {}) as Record<string, JsonValue>;
      if (common.connected === false) return error(String(common.lastSyncError ?? "MCP sync failed"), 502);
      return json({ status: "ok", tools: Array.isArray(common.tools) ? common.tools : [], server: result.item });
    });
  }
  // 专题9 MCP OAuth 2.1(对齐安卓 McpOAuthCoordinator):发起授权 → 浏览器完成 → 回调落盘。
  // 回调 redirect_uri 取自发起请求的 origin(本机回环,RFC 8252),DCR 注册与换码保持一致。
  if (path === "settings/mcp-server/oauth/start" && request.method === "POST") {
    const body = await readJson<{ serverId: string }>(request);
    const redirectUri = `${url.origin}/api/mcp/oauth/callback`;
    try {
      const result = await startMcpOAuth(String(body.serverId ?? ""), redirectUri);
      return json(result);
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "settings/mcp-server/oauth/clear" && request.method === "POST") {
    const body = await readJson<{ serverId: string }>(request);
    try {
      clearMcpOAuth(String(body.serverId ?? ""));
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 404);
    }
    return json({ status: "ok" });
  }
  // 浏览器重定向目标(GET,无鉴权 token —— 在 api/auth.ts 白名单豁免)。state 一次性校验 +
  // PKCE verifier 只存服务端内存,泄露面仅限展示性 HTML。
  if (path === "mcp/oauth/callback" && request.method === "GET") {
    let outcome: { ok: boolean; message: string; serverName?: string };
    try {
      outcome = await completeMcpOAuth({
        code: url.searchParams.get("code"),
        state: url.searchParams.get("state"),
        error: url.searchParams.get("error"),
        errorDescription: url.searchParams.get("error_description"),
      });
    } catch (err) {
      outcome = { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const title = outcome.ok ? "授权成功" : "授权失败";
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title} - RikkaHub</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f6f6f7;color:#1c1c1e}
.card{background:#fff;border-radius:12px;padding:32px 40px;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center;max-width:28rem}
h1{font-size:1.25rem;margin:0 0 8px}p{margin:4px 0;color:#6b6b70;font-size:.9rem}</style></head>
<body><div class="card"><h1>${outcome.ok ? "✅" : "❌"} ${title}</h1>
${outcome.serverName ? `<p>${esc(outcome.serverName)}</p>` : ""}
<p>${esc(outcome.message)}</p><p>${outcome.ok ? "现在可以关闭此页面,回到 RikkaHub 继续使用。" : "请回到 RikkaHub 重新发起授权。"}</p></div></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  if (path === "settings/mode-injection/detail" && request.method === "POST") {
    const body = await readJson<Record<string, JsonValue>>(request);
    const item = {
      type: "mode",
      enabled: true,
      priority: 0,
      position: "after_system_prompt",
      content: "",
      injectDepth: 4,
      role: "USER",
      ...body,
      id: String(body.id ?? id()),
      name: String(body.name ?? "Mode Injection"),
    };
    const result = upsertById(state.settings.modeInjections as JsonValue[], item);
    updateSettings({ ...state.settings, modeInjections: result.items });
    return json({ status: "ok", item: result.item });
  }
  const modeDelete = path.match(/^settings\/mode-injection\/([^/]+)$/);
  if (modeDelete && request.method === "DELETE") {
    const idValue = decodeURIComponent(modeDelete[1]);
    updateSettings({
      ...state.settings,
      modeInjections: deleteById(state.settings.modeInjections as JsonValue[], idValue),
      assistants: state.settings.assistants.map((assistant) => ({
        ...assistant,
        modeInjectionIds: assistant.modeInjectionIds.filter((itemId) => itemId !== idValue),
      })),
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/mode-injection/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    updateSettings({ ...state.settings, modeInjections: reorderByIds(state.settings.modeInjections as JsonValue[], body.ids ?? []) });
    return json({ status: "ok" });
  }
  if (path === "settings/lorebook/detail" && request.method === "POST") {
    const body = await readJson<Record<string, JsonValue>>(request);
    const item = {
      enabled: true,
      description: "",
      entries: [] as JsonValue[],
      ...body,
      id: String(body.id ?? id()),
      name: String(body.name ?? "Lorebook"),
    };
    const result = upsertById(state.settings.lorebooks as JsonValue[], item);
    updateSettings({ ...state.settings, lorebooks: result.items });
    return json({ status: "ok", item: result.item });
  }
  const lorebookDelete = path.match(/^settings\/lorebook\/([^/]+)$/);
  if (lorebookDelete && request.method === "DELETE") {
    const idValue = decodeURIComponent(lorebookDelete[1]);
    updateSettings({
      ...state.settings,
      lorebooks: deleteById(state.settings.lorebooks as JsonValue[], idValue),
      assistants: state.settings.assistants.map((assistant) => ({
        ...assistant,
        lorebookIds: assistant.lorebookIds.filter((itemId) => itemId !== idValue),
      })),
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/lorebook/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    updateSettings({ ...state.settings, lorebooks: reorderByIds(state.settings.lorebooks as JsonValue[], body.ids ?? []) });
    return json({ status: "ok" });
  }
  if (path === "settings/quick-message/detail" && request.method === "POST") {
    const body = await readJson<Record<string, JsonValue>>(request);
    const item = { title: "", content: "", ...body, id: String(body.id ?? id()) };
    const result = upsertById(state.settings.quickMessages as JsonValue[], item);
    updateSettings({ ...state.settings, quickMessages: result.items });
    return json({ status: "ok", item: result.item });
  }
  const quickMessageDelete = path.match(/^settings\/quick-message\/([^/]+)$/);
  if (quickMessageDelete && request.method === "DELETE") {
    const idValue = decodeURIComponent(quickMessageDelete[1]);
    updateSettings({
      ...state.settings,
      quickMessages: deleteById(state.settings.quickMessages as JsonValue[], idValue),
      assistants: state.settings.assistants.map((assistant) => ({
        ...assistant,
        quickMessageIds: assistant.quickMessageIds.filter((itemId) => itemId !== idValue),
      })),
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/quick-message/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    updateSettings({ ...state.settings, quickMessages: reorderByIds(state.settings.quickMessages as JsonValue[], body.ids ?? []) });
    return json({ status: "ok" });
  }
  if (path === "settings/search/enabled" && request.method === "POST") {
    const body = await readJson<{ enabled: boolean }>(request);
    updateSettings({ ...state.settings, enableWebSearch: body.enabled });
    return json({ status: "ok" });
  }
  if (path === "settings/search/service" && request.method === "POST") {
    const body = await readJson<{ index: number }>(request);
    updateSettings({ ...state.settings, searchServiceSelected: body.index });
    return json({ status: "ok" });
  }
  if (path === "settings/search/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[]; selectedId?: string }>(request);
    const services = state.settings.searchServices as Array<Record<string, JsonValue>>;
    const byId = new Map(services.map((item) => [String(item.id), item]));
    const ordered = body.ids.map((itemId) => byId.get(String(itemId))).filter(Boolean) as JsonValue[];
    const rest = services.filter((item) => !body.ids.includes(String(item.id)));
    const searchServices = [...ordered, ...rest];
    const selectedId = body.selectedId ?? String(services[state.settings.searchServiceSelected]?.id ?? "");
    const selectedIndex = Math.max(0, searchServices.findIndex((item) => String((item as Record<string, JsonValue>).id) === selectedId));
    updateSettings({ ...state.settings, searchServices, searchServiceSelected: selectedIndex });
    return json({ status: "ok" });
  }
  if (path === "settings/search/service/detail" && request.method === "POST") {
    const body = await readJson<SearchService>(request);
    const service: SearchService = { ...body, id: String(body.id ?? id()) };
    const services = state.settings.searchServices as SearchService[];
    const existing = services.find((item) => String(item.id) === String(service.id));
    // Invalidate testPassed when any auth/endpoint field changes. Preset types
    // (bing_local, rikkahub) don't need testPassed gating — they always show in chat.
    if (existing && existing.testPassed === true) {
      const changed = SEARCH_SERVICE_AUTH_FIELDS.some((key) => String(existing[key] ?? "") !== String(service[key] ?? ""));
      if (changed) {
        service.testPassed = false;
        service.testPassedAt = 0;
      } else {
        service.testPassed = existing.testPassed;
        service.testPassedAt = existing.testPassedAt;
      }
    }
    updateSettings({
      ...state.settings,
      searchServices: existing ? services.map((item) => (String(item.id) === String(service.id) ? service : item)) : [...services, service],
      searchServiceSelected: existing ? state.settings.searchServiceSelected : services.length,
      // R1-12:手动保存/重加某 type → 撤销其删除墓碑(之后再删会重新记录)。
      dismissedSearchServiceTypes: state.settings.dismissedSearchServiceTypes
        .filter((t) => t !== String(service.type ?? "").toLowerCase()),
    });
    return json({ status: "ok", service });
  }
  if (path === "settings/search/service/test" && request.method === "POST") {
    const body = await readJson<SearchService>(request);
    try {
      const result = await testSearchService(body);
      // 多 key 服务全量测试后始终返回结构化结果(含每个 key 的状态),不再用 502 表达"某个 key 失败"。
      // 只有 status=ok(至少一个 key 可用,或无 key 服务直连成功)才标 testPassed,让搜索 picker 放行。
      if (result.status === "ok") {
        const services = state.settings.searchServices as SearchService[];
        const targetId = String(body.id ?? "");
        if (targetId) {
          // R5-3 同型竞态:测试飞行期间用户改了该服务的鉴权/端点字段 → 结论属于旧配置,
          // 不盖章。字段集合与 detail 保存路径的失效规则共用 SEARCH_SERVICE_AUTH_FIELDS。
          updateSettings({
            ...state.settings,
            searchServices: services.map((item) =>
              String(item.id) === targetId
                  && SEARCH_SERVICE_AUTH_FIELDS.every((key) => String(item[key] ?? "") === String(body[key] ?? ""))
                ? { ...item, testPassed: true, testPassedAt: Date.now() }
                : item,
            ),
          });
        }
      }
      return json(result);
    } catch (err) {
      return error(friendlyRequestError(err, state.settings.proxyConfig), 502);
    }
  }
  const searchDelete = path.match(/^settings\/search\/service\/([^/]+)$/);
  if (searchDelete && request.method === "DELETE") {
    const idValue = decodeURIComponent(searchDelete[1]);
    const services = state.settings.searchServices as SearchService[];
    const removed = services.find((item) => String(item.id) === idValue) ?? null;
    const nextServices = services.filter((item) => String(item.id) !== idValue);
    // 全面审查 R1-12:被删 type 已无存活实例 → 记删除墓碑。state-load 的内置服务补齐
    // 与空列表回填都豁免墓碑,且墓碑随 settings 进备份——重启/备份恢复均不复活。
    const removedType = removed ? String(removed.type ?? "").toLowerCase() : "";
    const typeStillPresent = removedType !== "" && nextServices.some((item) => String(item.type ?? "").toLowerCase() === removedType);
    updateSettings({
      ...state.settings,
      searchServices: nextServices,
      dismissedSearchServiceTypes: removedType && !typeStillPresent
        ? uniqueStrings([...state.settings.dismissedSearchServiceTypes, removedType])
        : state.settings.dismissedSearchServiceTypes,
      searchServiceSelected: Math.min(state.settings.searchServiceSelected, Math.max(0, nextServices.length - 1)),
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/default-models" && request.method === "POST") {
    const body = await readJson<Partial<Settings>>(request);
    updateSettings({
      ...state.settings,
      chatModelId: String(body.chatModelId ?? state.settings.chatModelId),
      titleModelId: String(body.titleModelId ?? state.settings.titleModelId),
      translateModeId: String(body.translateModeId ?? state.settings.translateModeId),
      suggestionModelId: String(body.suggestionModelId ?? state.settings.suggestionModelId),
      imageGenerationModelId: String(body.imageGenerationModelId ?? state.settings.imageGenerationModelId),
      ocrModelId: String(body.ocrModelId ?? state.settings.ocrModelId),
      compressModelId: String(body.compressModelId ?? state.settings.compressModelId),
      promptOptimizeModelId: String(body.promptOptimizeModelId ?? state.settings.promptOptimizeModelId ?? ""),
      promptOptimizePrompt: String(body.promptOptimizePrompt ?? state.settings.promptOptimizePrompt ?? DEFAULT_PROMPT_OPTIMIZE_PROMPT),
      titlePrompt: String(body.titlePrompt ?? state.settings.titlePrompt ?? DEFAULT_TITLE_PROMPT),
      translatePrompt: String(body.translatePrompt ?? state.settings.translatePrompt ?? DEFAULT_TRANSLATION_PROMPT),
      suggestionPrompt: String(body.suggestionPrompt ?? state.settings.suggestionPrompt ?? DEFAULT_SUGGESTION_PROMPT),
      ocrPrompt: String(body.ocrPrompt ?? state.settings.ocrPrompt ?? DEFAULT_OCR_PROMPT),
      compressPrompt: String(body.compressPrompt ?? state.settings.compressPrompt ?? DEFAULT_COMPRESS_PROMPT),
    });
    return json({ status: "ok" });
  }
  if (path === "settings/favorite-models" && request.method === "POST") {
    const body = await readJson<{ modelIds: string[] }>(request);
    updateSettings({ ...state.settings, favoriteModels: body.modelIds ?? [] });
    return json({ status: "ok" });
  }
  if (path === "settings/model/built-in-tool" && request.method === "POST") {
    const body = await readJson<{ modelId: string; tool: string; enabled: boolean }>(request);
    const toolName = String(body.tool ?? "").trim();
    updateSettings({
      ...state.settings,
      providers: state.settings.providers.map((providerItem) => ({
        ...providerItem,
        models: providerItem.models.map((modelItem) => {
          if (modelItem.id !== body.modelId) return modelItem;
          const existingTools = Array.isArray(modelItem.tools) ? modelItem.tools : [];
          const nextTools = body.enabled
            ? [...existingTools.filter((tool) => String((tool as Record<string, JsonValue>).type ?? tool) !== toolName), { type: toolName }]
            : existingTools.filter((tool) => String((tool as Record<string, JsonValue>).type ?? tool) !== toolName);
          return { ...modelItem, tools: nextTools };
        }),
      })),
    });
    return json({ status: "ok" });
  }
  if (path === "settings/provider" && request.method === "POST") {
    const body = await readJson<Provider>(request);
    updateSettings({
      ...state.settings,
      providers: state.settings.providers.some((item) => item.id === body.id)
        ? state.settings.providers.map((item) => {
          if (item.id !== body.id) return item;
          // 全面审查 R5-3:凭据/端点字段变更即撤销"已验证"(对齐 search/service/detail 的
          // 失效规则)——apiKey/baseUrl 都换了,旧测试结论不再成立,徽章不能继续绿着。
          // 未变更时保持既有语义:测过一次即保留,防止无关字段编辑抖掉测试状态。
          if (providerAuthChanged(item, body)) return { ...item, ...body, testPassed: false, testPassedAt: 0 };
          return {
            ...item,
            ...body,
            testPassed: item.testPassed === true ? true : body.testPassed,
            testPassedAt: item.testPassed === true ? item.testPassedAt : body.testPassedAt,
          };
        })
        : [...state.settings.providers, { ...body, id: body.id || id(), builtIn: false }],
    });
    return json({ status: "ok" });
  }
  const providerDelete = path.match(/^settings\/provider\/([^/]+)$/);
  if (providerDelete && request.method === "DELETE") {
    const idValue = decodeURIComponent(providerDelete[1]);
    if (state.settings.providers.length <= 1) return error("At least one provider is required", 400);
    updateSettings({ ...state.settings, providers: state.settings.providers.filter((item) => item.id !== idValue) });
    return json({ status: "deleted" });
  }
  if (path === "settings/provider/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    const byId = new Map(state.settings.providers.map((item) => [item.id, item]));
    const ordered = body.ids.map((itemId) => byId.get(itemId)).filter(Boolean) as Provider[];
    const rest = state.settings.providers.filter((item) => !body.ids.includes(item.id));
    updateSettings({ ...state.settings, providers: [...ordered, ...rest] });
    return json({ status: "ok" });
  }
  if (path === "settings/provider/balance" && request.method === "POST") {
    const body = await readJson<{ providerId: string }>(request);
    const providerItem = state.settings.providers.find((item) => item.id === body.providerId);
    if (!providerItem) return error("Provider not found", 404);
    try {
      return json(await fetchProviderBalance(providerItem));
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "settings/provider/test" && request.method === "POST") {
    const body = await readJson<{ providerId: string; modelId?: string }>(request);
    const providerItem = state.settings.providers.find((item) => item.id === body.providerId);
    if (!providerItem) return error("Provider not found", 404);
    try {
      const result = await fetchProviderModels(providerItem);
      const selectedModel = firstProviderModel(providerItem, body.modelId, result.models);
      const checks = [];
      for (const mode of ["non_stream", "stream", "tools"] as const) {
        checks.push(await runProviderCheck(providerItem, mode, selectedModel, result.models).catch((err) => ({
          mode,
          ok: false,
          status: 0,
          endpoint: endpointFor(providerItem),
          preview: friendlyRequestError(err, state.settings.proxyConfig),
        })));
      }
      markProviderTestResult(providerItem, checks);
      return json({
        status: "ok",
        endpoint: result.endpoint,
        responseApiEndpoint: endpointFor(providerItem),
        testModelId: selectedModel,
        modelCount: result.models.length,
        models: result.models.slice(0, 20),
        checks,
        preview: result.preview,
      });
    } catch (err) {
      return error(friendlyRequestError(err, state.settings.proxyConfig), 502);
    }
  }

  if (path === "settings/provider/test/image" && request.method === "POST") {
    const body = await readJson<{ providerId: string; modelId?: string; prompt?: string }>(request);
    const providerItem = state.settings.providers.find((item) => item.id === body.providerId);
    if (!providerItem) return error("Provider not found", 404);
    const requestedModelId = String(body.modelId ?? "").trim();
    const modelItem = (providerItem.models ?? []).find((item) => item.modelId === requestedModelId)
      ?? (providerItem.models ?? []).find((item) => (item.type as string) === "IMAGE")
      ?? null;
    if (!modelItem) return error("No image model available for this provider", 400);
    // 4-4:显式 modelId 覆盖复用生图管线;此前临时改写全局 imageGenerationModelId
    // 再 finally 还原,测试期间的真实生图/并发的另一个测试会读到被测模型(多标签页下必现)。
    try {
      const prompt = String(body.prompt ?? "A red apple on a white background").trim() || "A red apple on a white background";
      const images = await callImageGeneration({ prompt, numberOfImages: 1, aspectRatio: "square", overrideModelUuid: modelItem.id });
      const generated = images[0];
      if (!generated) return error("Image generation returned no images", 502);
      return json({
        status: "ok",
        modelId: modelItem.modelId,
        image: { url: generated.url, mime: generated.mime, fileName: generated.fileName },
      });
    } catch (err) {
      return error(friendlyRequestError(err, state.settings.proxyConfig), 502);
    }
  }

  if (path === "settings/provider/test/stream" && request.method === "POST") {
    const body = await readJson<{ providerId: string; modelId?: string }>(request);
    const providerItem = state.settings.providers.find((item) => item.id === body.providerId);
    if (!providerItem) return error("Provider not found", 404);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, payload: JsonValue | object) => controller.enqueue(sseFrame(event, payload));
        try {
          send("progress", { message: "正在读取模型列表..." });
          const result = await fetchProviderModels(providerItem);
          const selectedModel = firstProviderModel(providerItem, body.modelId, result.models);
          send("models", {
            endpoint: result.endpoint,
            responseApiEndpoint: endpointFor(providerItem),
            testModelId: selectedModel,
            modelCount: result.models.length,
            models: result.models.slice(0, 20),
            preview: result.preview,
          });
          const checks = [];
          for (const mode of ["non_stream", "stream", "tools"] as const) {
            send("progress", { message: `正在测试 ${mode}...` });
            const check = await runProviderCheck(providerItem, mode, selectedModel, result.models).catch((err) => ({
              mode,
              ok: false,
              status: 0,
              endpoint: endpointFor(providerItem),
              preview: friendlyRequestError(err, state.settings.proxyConfig),
            }));
            checks.push(check);
            send("check", check);
          }
          markProviderTestResult(providerItem, checks);
          send("done", {
            status: "ok",
            endpoint: result.endpoint,
            responseApiEndpoint: endpointFor(providerItem),
            testModelId: selectedModel,
            modelCount: result.models.length,
            models: result.models.slice(0, 20),
            checks,
            preview: result.preview,
          });
        } catch (err) {
          send("error", { error: friendlyRequestError(err, state.settings.proxyConfig) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: sseHeaders() });
  }
  if (path === "settings/provider/models" && request.method === "POST") {
    const body = await readJson<{ providerId: string; save?: boolean }>(request);
    const providerItem = state.settings.providers.find((item) => item.id === body.providerId);
    if (!providerItem) return error("Provider not found", 404);
    // 用户主动获取模型列表——大概率是想试新模型。顺带刷新 models.dev 缓存,让新模型
    // 的 context 上限立即可用(不用等每日 TTL)。fire-and-forget,不阻塞模型列表返回。
    void loadModelsDev(true);
    try {
      const result = await fetchProviderModels(providerItem);
      if (body.save) {
        updateSettings({
          ...state.settings,
          providers: state.settings.providers.map((item) =>
            item.id === providerItem.id ? { ...item, models: result.models } : item,
          ),
        });
      }
      return json({ status: "ok", endpoint: result.endpoint, models: result.models, preview: result.preview });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "settings/proxy" && request.method === "POST") {
    const body = await readJson<Partial<ProxyConfig>>(request);
    // P0-2: Bun fetch 静默丢弃 SOCKS 代理(表现为直连失败), 这里显式拒绝。
    // 前端 save() 也有同样校验, 此处为防御性(防止其它调用方绕过前端直接 POST)。
    const trimmedUrl = String(body?.url ?? "").trim();
    if (/^socks/i.test(trimmedUrl)) {
      return json(
        { error: "SOCKS proxy is not supported (Bun fetch only handles HTTP/HTTPS). Please use the proxy tool's HTTP port." },
        { status: 400 },
      );
    }
    const proxyConfig = normalizeProxyConfig(body);
    updateSettings({ ...state.settings, proxyConfig });
    applyEffectiveProxy(state.settings.proxyConfig);
    return json({ status: "ok", config: proxyConfig, ...proxyStatusPayload(state.settings.proxyConfig) });
  }
  if (path === "settings/port" && request.method === "POST") {
    // D6(复查):容器内端口固定且启动时跳过该设置——静默接受会给用户"改了会生效"的
    // 假象,直接拒写并说明出路。
    if (RUNNING_IN_CONTAINER) {
      return error("容器部署的端口由 docker run -p 宿主机映射决定,应用内端口设置不生效。", 400);
    }
    const body = await readJson<{ port?: number | null }>(request).catch(
      () => ({}) as { port?: number | null },
    );
    const preferredPort = normalizePreferredPort(body?.port);
    updateSettings({ ...state.settings, preferredPort });
    // The port is only consulted at startup, so this change takes effect on the next launch.
    // The running server keeps its current port; we return requiresRestart so the UI can tell
    // the user to restart.
    return json({ status: "ok", preferredPort, requiresRestart: true });
  }
  if (path === "settings/shell-path" && request.method === "POST") {
    // shellPath 是 Windows 机器级 bash 路径;容器部署是 Linux,无此概念,直接拒写(同 port)。
    if (RUNNING_IN_CONTAINER) {
      return error("容器部署使用系统自带 shell,应用内 bash 路径设置不生效。", 400);
    }
    const body = await readJson<{ shellPath?: string | null }>(request).catch(
      () => ({}) as { shellPath?: string | null },
    );
    const shellPath = String(body?.shellPath ?? "").trim();
    // 非空则需指向真实存在的 .exe;空串 = 清除,回到自动探测。校验挡掉脏数据锁死 bash 的坑。
    if (shellPath) {
      if (!/\.exe$/i.test(shellPath)) {
        return error("请指向 bash 可执行文件(.exe)", 400);
      }
      if (!existsSync(shellPath)) {
        return error(`路径不存在: ${shellPath}`, 400);
      }
    }
    updateSettings({ ...state.settings, shellPath });
    // shellPath 变了必须重探(清 shellAvailability 与 shell.ts 两级缓存),返回最新状态。
    refreshShellAvailability();
    return json({ status: "ok", shellPath, shell: shellStatusPayload() });
  }
  if (path === "settings/proxy/detect" && request.method === "POST") {
    // R1-7:探测函数已异步化;detectSystemProxy 按平台分发(Windows 注册表 / GNOME
    // gsettings),此前只探 Windows,Linux 桌面点"检测"永远返回空。
    const detected = await detectSystemProxy();
    // 专题10-②:常规系统代理未检出时补测 PAC。只配了 PAC 的用户此前得到"未检测到系统
    // 代理"且毫无线索;现在前端据此提示去代理工具查 HTTP 端口手动填写。检出常规代理时
    // PAC 无关紧要(手动填的就是它),跳过探测少一次子进程调用。
    const pac = detected ? null : ((await detectSystemPacUrl()) ?? null);
    return json({ detected: detected ?? null, pac });
  }
  if (path === "settings/proxy/status" && request.method === "GET") {
    return json(proxyStatusPayload(state.settings.proxyConfig));
  }
  if (path === "settings/proxy/test" && request.method === "POST") {
    // 测试当前生效代理能否真的连通。显式传 proxy 选项绕过 env —— 否则降级态下 env 已清,
    // fetch 会直连成功, 误判成"代理通了"。用户可指定测试 URL (默认 generate_204 轻量快速)。
    const { url } = resolveEffectiveProxy(state.settings.proxyConfig);
    if (!url) return json({ ok: false, error: "no_proxy" });
    let testUrl = "https://www.gstatic.com/generate_204";
    try {
      const body = await request.json();
      if (typeof body?.url === "string") {
        let u = body.url.trim();
        // 用户可能填 "example.com" 不带协议 — 自动补 https://, 否则下面的正则会拒绝,
        // 回退到默认 gstatic, 表现为"改了测试 URL 但梯子日志仍 ping gstatic"。
        if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
        if (/^https?:\/\//i.test(u)) testUrl = u;
      }
    } catch { /* 空 body 用默认 */ }
    const t0 = Date.now();
    try {
      const resp = await fetch(testUrl, {
        proxy: url,
        signal: AbortSignal.timeout(8000),
        redirect: "manual",
      });
      // 2xx/3xx 都算通 (代理能回应 = 通; 5xx 可能是代理报错或目标不可达, 算不通)
      const ok = resp.status >= 200 && resp.status < 400;
      return json({ ok, status: resp.status, latencyMs: Date.now() - t0 });
    } catch (e) {
      return json({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        latencyMs: Date.now() - t0,
      });
    }
  }
  return null;
}
