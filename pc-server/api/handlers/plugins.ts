// api/handlers/plugins.ts — 引擎插件管理(P5.8,方案 §5.9):列表 / 详情 / 审计 / 安装 / 重装 / 卸载 / 启停 / 开关
//
// 插件记录住 settings.enginePlugins,助手绑定住 assistant.enginePluginIds(绑定的端点在 settings 路由)。
// 安装:npm / git 来源经 engines/plugin-installer 装进 <数据目录>/engines/<engine>/npm,本地来源原地使用;
// 装完校验包里有 pi 扩展入口,没有就卸掉并报错。插件 id = `<engine>:<包名>`(本地来源取包名或目录名),
// 同名的 npm / git 记录即同一个安装位置,再装一次 = 重装 / 升级,沿用原记录的启停、开关与绑定。
// 读插件登记了什么(详情、MCP 声明、脚本上传的试加载)要执行插件代码,经 engines/index 的 inspectEnginePlugin 交给引擎做,
// 主程序自己不加载插件(P7.2.5,engines/engine-agnostic-guard.test.ts 锁)。
// 插件声明的 MCP 服务(D13,P5.8b):安装 / 重装时加载一次插件读出声明,登记进应用的 MCP 列表(engines/plugin-mcp),
// 工具清单在后台同步;启停翻服务器的 source.active,卸载移除。插件加载出错时不动已有登记。
// 有插件运行时的引擎见 engines/plugin-engines(目前只有 pi)。安装 / 重装时从 package.json 读说明字段存进记录(P6.2.1)。
// 更新:只对 npm 来源、没钉版本的记录查(engines/plugin-updates),更新 = 以 <包名>@latest 再装一次,记录里的来源写法不变。
// 市场(engines/plugin-market):内置 + 用户添加的市场源、检索与条目详情;从市场安装就是 plugins/install(npm 来源可带 registry)。
// 上传(engines/plugin-upload,P6.2.3):校验过的文件存进 uploads/ 再装,来源 upload;同名先回 409 等界面确认,带 replace=1
// 重发即替换那一条。压缩包的重装用存档再装一次,脚本的重装重新试加载;卸载连上传的文件一起删。

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import { updateSettings } from "../../app-config";
import { reportEngineError } from "../../engines/host";
import { enginePluginsChanged, inspectEnginePlugin } from "../../engines/index";
import { pluginAudit } from "../../engines/plugin-audit";
import { isPluginEngine, PLUGIN_ENGINES } from "../../engines/plugin-engines";
import { findMarketSource, marketDetail, marketSources, resolveMarketSource, searchMarket, withoutMarketSource } from "../../engines/plugin-market";
import { readEnginePluginMeta, readEnginePluginReadme } from "../../engines/plugin-package";
import {
  prepareUpload,
  removeUpload,
  requireUploadedFile,
  saveUpload,
  UPLOAD_REQUEST_MAX_BYTES,
  uploadInstallSpec,
  type UploadChecks,
} from "../../engines/plugin-upload";
import { checkPluginUpdates, forgetPluginUpdate, updatablePackageName } from "../../engines/plugin-updates";
import { installEnginePluginPackage, normalizeGitSpec, uninstallEnginePluginPackage } from "../../engines/plugin-installer";
import {
  removePluginMcpServers,
  setPluginMcpServersActive,
  syncPluginMcpServers,
  type PluginMcpDeclaration,
} from "../../engines/plugin-mcp";
import { isPackageSource, isUploadedScript, locateEnginePlugin, pluginNameFromPath } from "../../engines/plugins";
import { CodedError } from "../../foundation/errors";
import { resolveEffectiveProxy } from "../../foundation/net";
import type { JsonValue } from "../../foundation/types";
import type {
  EnginePluginAuditDto,
  EnginePluginDetailDto,
  EnginePluginListDto,
  EnginePluginMutationDto,
  EnginePluginUpdatesDto,
  EnginePluginUploadConflictDto,
  EnginePluginViewDto,
  PluginMarketDetailDto,
  PluginMarketPageDto,
  PluginMarketSourceDto,
  PluginMarketSourcesDto,
} from "../../foundation/types/plugins";
import type { EnginePluginRecord, EnginePluginSource } from "../../foundation/types/settings";
import { reportError } from "../../observability/app-errors";
import { state } from "../../persistence/json-store";
import { piPluginEntryError } from "../../pi-engine/plugins/entries";
import { syncMcpServerTools } from "../../tools/mcp";
import { ensureFreshMcpToken } from "../../tools/mcp-oauth";
import { pluginMcpSource } from "../../tools/mcp-source";
import { addLog } from "../logs";
import { error, json, readJson } from "../request";

function records(): EnginePluginRecord[] {
  return state.settings.enginePlugins ?? [];
}

function findRecord(pluginId: unknown): EnginePluginRecord | undefined {
  return typeof pluginId === "string" ? records().find((record) => record.id === pluginId) : undefined;
}

function pluginView(record: EnginePluginRecord): EnginePluginViewDto {
  const path = locateEnginePlugin(record);
  const audit = pluginAudit(record.id);
  return {
    ...record,
    path,
    installed: existsSync(path),
    loadFailed: audit.some((entry) => entry.code === "pi_plugin_load_failed"),
    auditCount: audit.length,
  };
}

interface SettingsPatch {
  assistants?: (pluginIds: string[]) => string[];
  mcpServers?: (servers: JsonValue[]) => JsonValue[];
}

function saveRecords(next: EnginePluginRecord[], patch: SettingsPatch = {}) {
  // 改了插件:引擎宿主进程因连续失败停止重启的(多半是插件弄崩的)允许再起;在跑的那个空下来就换掉
  enginePluginsChanged();
  updateSettings({
    ...state.settings,
    enginePlugins: next,
    ...(patch.assistants
      ? { assistants: state.settings.assistants.map((assistant) => ({ ...assistant, enginePluginIds: patch.assistants!(assistant.enginePluginIds ?? []) })) }
      : {}),
    ...(patch.mcpServers ? { mcpServers: patch.mcpServers(state.settings.mcpServers as JsonValue[]) } : {}),
  });
}

function upsertRecord(record: EnginePluginRecord, patch: SettingsPatch = {}) {
  const list = records();
  const index = list.findIndex((item) => item.id === record.id);
  saveRecords(index >= 0 ? list.map((item, i) => (i === index ? record : item)) : [...list, record], patch);
}

/** 插件加载期声明的 MCP 服务;加载出错时为 null(保留原有登记,不按半截结果删改)。 */
async function pluginMcpDeclarations(record: EnginePluginRecord): Promise<PluginMcpDeclaration[] | null> {
  // 加载错误不在这里上报:会话加载这个插件时按插件记一条 pi_plugin_load_failed。
  const inspection = await inspectEnginePlugin(record.engine, { id: record.id, path: locateEnginePlugin(record) }).catch(() => null);
  return inspection && inspection.errors.length === 0 ? inspection.mcpServers : null;
}

/** 插件服务器的工具清单在后台同步(连不上不拖住安装;结果经设置推送到 MCP 页)。同步期间服务器被改过就丢弃这次结果。 */
async function refreshPluginMcpTools(pluginId: string): Promise<void> {
  const current = () => state.settings.mcpServers as Array<Record<string, JsonValue>>;
  const targets = current().filter((server) => pluginMcpSource(server)?.pluginId === pluginId);
  const results = await Promise.all(
    targets.map(async (server) => {
      const fresh = await ensureFreshMcpToken(server);
      return { fresh, next: await syncMcpServerTools(fresh, addLog) };
    }),
  );
  const replacements = new Map(results.filter(({ fresh }) => current().includes(fresh)).map(({ fresh, next }) => [fresh as JsonValue, next as JsonValue]));
  if (replacements.size === 0) return;
  updateSettings({ ...state.settings, mcpServers: current().map((server) => replacements.get(server) ?? server) });
}

/** 存下装好的记录,连同它声明的 MCP 服务;声明里应用连不了的写审计。 */
function saveInstalled(record: EnginePluginRecord, declarations: PluginMcpDeclaration[] | null) {
  if (!declarations) return upsertRecord(record);
  let skipped: ReturnType<typeof syncPluginMcpServers>["skipped"] = [];
  upsertRecord(record, {
    mcpServers: (servers) => {
      const synced = syncPluginMcpServers(servers, record.id, record.enabled, declarations);
      skipped = synced.skipped;
      return synced.servers;
    },
  });
  for (const item of skipped) {
    reportEngineError({
      domain: "pi-engine",
      severity: "info",
      message: `插件 MCP 服务未登记:${record.id} ${item.name}(${item.reason})`,
      code: "pi_plugin_mcp_unsupported",
      params: { plugin: record.id, subject: `mcp:${item.name}`, detail: item.reason },
    });
  }
  refreshPluginMcpTools(record.id).catch((err: unknown) => reportError("tool", "warn", `插件 MCP 服务的工具同步失败:${record.id}`, err));
}

function proxyOptions() {
  const { url } = resolveEffectiveProxy(state.settings.proxyConfig);
  return url ? { proxyUrl: url } : {};
}

function parseSource(value: unknown): EnginePluginSource {
  const raw = (value ?? {}) as Partial<EnginePluginSource>;
  const spec = typeof raw.spec === "string" ? raw.spec.trim() : "";
  if (!spec || /[\r\n]/.test(spec)) throw new CodedError("来源不能为空", "plugin_source_invalid");
  // 以 - 开头会被包管理器当成选项。
  if (spec.startsWith("-")) throw new CodedError(`来源写法不对:${spec}`, "plugin_source_invalid");
  if (raw.kind === "npm") {
    const registry = typeof raw.registry === "string" ? raw.registry.trim().replace(/\/+$/, "") : "";
    if (registry && !/^https?:\/\/\S+$/i.test(registry)) throw new CodedError(`registry 地址不对:${registry}`, "plugin_source_invalid");
    return registry ? { kind: "npm", spec, registry } : { kind: "npm", spec };
  }
  if (raw.kind === "git") return { kind: "git", spec: normalizeGitSpec(spec) };
  if (raw.kind === "local") {
    if (!isAbsolute(spec)) throw new CodedError(`本地插件必须是绝对路径:${spec}`, "plugin_source_invalid");
    if (!existsSync(spec)) throw new CodedError(`路径不存在:${spec}`, "plugin_source_invalid");
    return { kind: "local", spec };
  }
  throw new CodedError("来源类型只能是 npm / git / local", "plugin_source_invalid");
}

/** 本地插件的包名与版本(目录里有 package.json 时取它的,否则按路径取名)。 */
function localPackageInfo(path: string): { name: string; version: string | null } {
  try {
    if (statSync(path).isDirectory()) {
      const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
      if (typeof pkg.name === "string" && pkg.name) return { name: pkg.name, version: typeof pkg.version === "string" ? pkg.version : null };
    }
  } catch {
    // 没有或读不懂 package.json:按路径取名
  }
  return { name: pluginNameFromPath(path), version: null };
}

function freeId(base: string): string {
  const taken = new Set(records().map((record) => record.id));
  let pluginId = base;
  for (let n = 2; taken.has(pluginId); n++) pluginId = `${base}#${n}`;
  return pluginId;
}

/** 装好(或定位好)来源,返回新的记录;existing = 重装 / 替换的那条;installSpec = 这次交给包管理器的写法(更新时是
 *  <包名>@latest),缺省即来源的写法(上传的压缩包是存档相对安装根的路径)。 */
async function install(
  engine: string,
  source: EnginePluginSource,
  existing?: EnginePluginRecord,
  installSpec?: string,
): Promise<EnginePluginRecord> {
  const installedAt = new Date().toISOString();
  if (source.kind === "local" || isUploadedScript(source)) {
    const path = source.kind === "local" ? source.spec : requireUploadedFile(engine, source.spec);
    const info = source.kind === "local" ? localPackageInfo(path) : { name: basename(path, extname(path)), version: null };
    const pluginId = existing?.id ?? freeId(`${engine}:${info.name}`);
    const entryError = piPluginEntryError({ id: pluginId, path });
    if (entryError) throw new CodedError(entryError, "plugin_entry_missing");
    return withMeta({ ...(existing ?? defaults(pluginId, engine)), name: existing?.name ?? info.name, source, version: info.version, installedAt });
  }
  const spec = installSpec ?? (source.kind === "upload" ? uploadInstallSpec(engine, source.spec) : source.spec);
  const { name, version } = await installEnginePluginPackage(engine, spec, {
    ...proxyOptions(),
    ...(existing ? { knownName: existing.name } : {}),
    ...(source.registry ? { registry: source.registry } : {}),
  });
  const same = existing ?? records().find((record) => record.engine === engine && isPackageSource(record.source) && record.name === name);
  const pluginId = same?.id ?? freeId(`${engine}:${name}`);
  const entryError = piPluginEntryError({ id: pluginId, path: locateEnginePlugin({ engine, name, source }) });
  if (entryError) {
    // 不是 pi 插件:新装的卸掉;重装的保留(原记录还指着它,用户可以再卸)。
    if (!same) await uninstallEnginePluginPackage(engine, name, proxyOptions());
    throw new CodedError(`${name} 不是可用的插件:${entryError}`, "plugin_entry_missing");
  }
  return withMeta({ ...(same ?? defaults(pluginId, engine)), name, source, version, installedAt });
}

/** 按装好的包重读说明字段(包里没有的项随之消失)。 */
function withMeta(record: EnginePluginRecord): EnginePluginRecord {
  const { meta: _old, ...rest } = record;
  const meta = readEnginePluginMeta(locateEnginePlugin(record));
  return meta ? { ...rest, meta } : rest;
}

function defaults(pluginId: string, engine: string): EnginePluginRecord {
  return { id: pluginId, engine, name: pluginId, source: { kind: "local", spec: "" }, version: null, enabled: true, hookSwitches: { toolCall: true }, toolSwitches: {}, installedAt: "" };
}

function failure(err: unknown): Response {
  if (err instanceof CodedError) return error(err.message, 400, err.errorCode);
  throw err;
}

/** 上传的预检用 pi 的规则(目前只有 pi 有插件运行时):zip 解出的包根找入口,单个脚本试加载一次。 */
const PI_UPLOAD_CHECKS: UploadChecks = {
  packageEntryError: (dir) => piPluginEntryError({ id: "upload", path: dir }),
  scriptLoadError: async (path) => {
    const inspection = await inspectEnginePlugin("pi", { id: "upload", path }).catch((err: unknown) => ({ errors: [err instanceof Error ? err.message : String(err)] }));
    return inspection.errors[0] ?? null;
  },
};

/** 上传的文件只在没有别的记录引用时删(同一份内容可能被替换前后的两条记录先后引用)。 */
function removeUploadIfUnused(record: EnginePluginRecord, remaining: readonly EnginePluginRecord[]) {
  if (record.source.kind !== "upload") return;
  const spec = record.source.spec;
  if (remaining.some((item) => item.engine === record.engine && item.source.kind === "upload" && item.source.spec === spec)) return;
  removeUpload(record.engine, spec);
}

async function handleUpload(request: Request): Promise<Response> {
  if (Number(request.headers.get("content-length") ?? 0) > UPLOAD_REQUEST_MAX_BYTES) return error("压缩包不能超过 50 MB", 413, "plugin_upload_invalid");
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return error("请求不是合法的 multipart 表单", 400, "plugin_upload_invalid"); // 坏请求体:按上传无效回给界面
  }
  const file = form.get("file");
  const engineField = form.get("engine");
  const engine = typeof engineField === "string" && engineField ? engineField : "pi";
  if (!isPluginEngine(engine)) return error(`引擎 ${engine} 没有插件运行时`, 400, "plugin_engine_unsupported");
  if (!(file instanceof File)) return error("没有收到文件", 400, "plugin_upload_invalid");
  try {
    const prepared = await prepareUpload(file.name, new Uint8Array(await file.arrayBuffer()), PI_UPLOAD_CHECKS);
    const existing = prepared.kind === "package"
      ? records().find((record) => record.engine === engine && isPackageSource(record.source) && record.name === prepared.name)
      : records().find((record) => record.engine === engine && isUploadedScript(record.source) && record.source.spec === `scripts/${prepared.fileName}`);
    if (existing && form.get("replace") !== "1") {
      const message = `已安装同名插件 ${existing.name}`;
      return json({ error: message, code: 409, errorCode: "plugin_name_conflict", existing: pluginView(existing) } satisfies EnginePluginUploadConflictDto, { status: 409 });
    }
    const spec = saveUpload(engine, prepared);
    let record: EnginePluginRecord;
    try {
      record = await install(engine, { kind: "upload", spec }, existing);
    } catch (err) {
      if (existing?.source.kind !== "upload" || existing.source.spec !== spec) removeUpload(engine, spec);
      throw err;
    }
    saveInstalled(record, await pluginMcpDeclarations(record));
    if (existing) removeUploadIfUnused(existing, records());
    return json({ plugin: pluginView(record) } satisfies EnginePluginMutationDto);
  } catch (err) {
    return failure(err);
  }
}

export async function handlePluginRoutes(request: Request, url: URL, path: string): Promise<Response | null> {
  if (path === "plugins" && request.method === "GET") {
    return json({ engines: [...PLUGIN_ENGINES], plugins: records().map(pluginView) } satisfies EnginePluginListDto);
  }
  // 插件登记的工具与指令(加载一次插件代码)+ 审计。
  if (path === "plugins/detail" && request.method === "GET") {
    const record = findRecord(url.searchParams.get("id"));
    if (!record) return error("Plugin not found", 404);
    const view = pluginView(record);
    const inspection = view.installed
      ? await inspectEnginePlugin(record.engine, { id: record.id, path: view.path }).catch((err: unknown) => ({
          tools: [],
          commands: [],
          mcpServers: [],
          errors: [err instanceof Error ? err.message : String(err)],
        }))
      : { tools: [], commands: [], mcpServers: [], errors: [] };
    const readme = view.installed ? readEnginePluginReadme(view.path) : null;
    return json({ plugin: view, ...inspection, audit: pluginAudit(record.id), readme } satisfies EnginePluginDetailDto);
  }
  if (path === "plugins/audit" && request.method === "GET") {
    const pluginId = url.searchParams.get("id") ?? "";
    return json({ audit: pluginAudit(pluginId) } satisfies EnginePluginAuditDto);
  }
  if (path === "plugins/install" && request.method === "POST") {
    const body = await readJson<{ engine?: unknown; source?: unknown }>(request);
    const engine = typeof body.engine === "string" && body.engine ? body.engine : "pi";
    if (!isPluginEngine(engine)) return error(`引擎 ${engine} 没有插件运行时`, 400, "plugin_engine_unsupported");
    try {
      const record = await install(engine, parseSource(body.source));
      saveInstalled(record, await pluginMcpDeclarations(record));
      return json({ plugin: pluginView(record) } satisfies EnginePluginMutationDto);
    } catch (err) {
      return failure(err);
    }
  }
  if (path === "plugins/upload" && request.method === "POST") return handleUpload(request);
  // 按记录里的来源再装一次(升级、换机恢复后补装、本地插件改过代码)。
  if (path === "plugins/reinstall" && request.method === "POST") {
    const body = await readJson<{ id?: unknown }>(request);
    const record = findRecord(body.id);
    if (!record) return error("Plugin not found", 404);
    try {
      const next = await install(record.engine, record.source, record);
      if (isUploadedScript(next.source)) {
        const loadError = await PI_UPLOAD_CHECKS.scriptLoadError!(locateEnginePlugin(next));
        if (loadError) throw new CodedError(`这个文件不是可用的插件:${loadError}`, "plugin_upload_invalid");
      }
      saveInstalled(next, await pluginMcpDeclarations(next));
      return json({ plugin: pluginView(next) } satisfies EnginePluginMutationDto);
    } catch (err) {
      return failure(err);
    }
  }
  if (path === "plugins/updates" && request.method === "GET") {
    const updates = await checkPluginUpdates(records(), { refresh: url.searchParams.get("refresh") === "1" });
    return json(updates satisfies EnginePluginUpdatesDto);
  }
  // 装到 registry 上的最新版(来源写法不变,之后的重装仍按原写法)。
  if (path === "plugins/update" && request.method === "POST") {
    const body = await readJson<{ id?: unknown }>(request);
    const record = findRecord(body.id);
    if (!record) return error("Plugin not found", 404);
    const name = updatablePackageName(record);
    if (!name) return error("这个插件的来源不检查更新,可以重新安装", 400, "plugin_update_unsupported");
    try {
      const next = await install(record.engine, record.source, record, `${name}@latest`);
      saveInstalled(next, await pluginMcpDeclarations(next));
      forgetPluginUpdate(name, record.source.registry);
      return json({ plugin: pluginView(next) } satisfies EnginePluginMutationDto);
    } catch (err) {
      return failure(err);
    }
  }
  // ---- 市场(P6.2.2):从市场安装复用 plugins/install ----
  if (path === "plugins/market/sources" && request.method === "GET") {
    return json({ sources: marketSources(state.settings.pluginMarketSources) } satisfies PluginMarketSourcesDto);
  }
  if (path === "plugins/market/sources" && request.method === "POST") {
    const body = await readJson<{ url?: unknown; name?: unknown; engine?: unknown }>(request);
    try {
      const record = await resolveMarketSource(body, state.settings.pluginMarketSources ?? []);
      updateSettings({ ...state.settings, pluginMarketSources: [...(state.settings.pluginMarketSources ?? []), record] });
      return json({ source: { ...record, builtin: false } satisfies PluginMarketSourceDto });
    } catch (err) {
      return failure(err);
    }
  }
  if (path === "plugins/market/sources/remove" && request.method === "POST") {
    const body = await readJson<{ id?: unknown }>(request);
    try {
      updateSettings({ ...state.settings, pluginMarketSources: withoutMarketSource(state.settings.pluginMarketSources ?? [], body.id) });
      return json({ status: "ok" });
    } catch (err) {
      return failure(err);
    }
  }
  if (path === "plugins/market" && request.method === "GET") {
    try {
      const source = findMarketSource(state.settings.pluginMarketSources, url.searchParams.get("source"));
      const page = Number.parseInt(url.searchParams.get("page") ?? "0", 10);
      const result = await searchMarket(source, url.searchParams.get("q") ?? "", Number.isFinite(page) ? page : 0, records(), {
        refresh: url.searchParams.get("refresh") === "1",
      });
      return json(result satisfies PluginMarketPageDto);
    } catch (err) {
      return failure(err);
    }
  }
  if (path === "plugins/market/detail" && request.method === "GET") {
    try {
      const source = findMarketSource(state.settings.pluginMarketSources, url.searchParams.get("source"));
      const detail = await marketDetail(source, url.searchParams.get("name") ?? "", records(), { refresh: url.searchParams.get("refresh") === "1" });
      return json(detail satisfies PluginMarketDetailDto);
    } catch (err) {
      return failure(err);
    }
  }
  // 卸载:装进安装目录的来源删掉装的包,上传的文件一并删,本地来源只删记录(不动用户的文件);所有助手的绑定与它带来的
  // MCP 服务器一并移除。
  if (path === "plugins/uninstall" && request.method === "POST") {
    const body = await readJson<{ id?: unknown }>(request);
    const record = findRecord(body.id);
    if (!record) return error("Plugin not found", 404);
    const remaining = records().filter((item) => item.id !== record.id);
    const sharesPackage = remaining.some((item) => item.engine === record.engine && isPackageSource(item.source) && item.name === record.name);
    try {
      if (isPackageSource(record.source) && !sharesPackage) await uninstallEnginePluginPackage(record.engine, record.name, proxyOptions());
    } catch (err) {
      return failure(err);
    }
    saveRecords(remaining, {
      assistants: (pluginIds) => pluginIds.filter((pluginId) => pluginId !== record.id),
      mcpServers: (servers) => removePluginMcpServers(servers, record.id),
    });
    removeUploadIfUnused(record, remaining);
    return json({ status: "ok" });
  }
  if (path === "plugins/enabled" && request.method === "POST") {
    const body = await readJson<{ id?: unknown; enabled?: unknown }>(request);
    const record = findRecord(body.id);
    if (!record) return error("Plugin not found", 404);
    if (typeof body.enabled !== "boolean") return error("enabled 必须是布尔值", 400);
    const enabled = body.enabled;
    upsertRecord({ ...record, enabled }, { mcpServers: (servers) => setPluginMcpServersActive(servers, record.id, enabled) });
    return json({ plugin: pluginView({ ...record, enabled }) } satisfies EnginePluginMutationDto);
  }
  // 钩子开关与逐工具开关(只改给出的项)。
  if (path === "plugins/switches" && request.method === "POST") {
    const body = await readJson<{ id?: unknown; toolCall?: unknown; tools?: unknown }>(request);
    const record = findRecord(body.id);
    if (!record) return error("Plugin not found", 404);
    const next: EnginePluginRecord = { ...record, hookSwitches: { ...record.hookSwitches }, toolSwitches: { ...record.toolSwitches } };
    if (body.toolCall !== undefined) {
      if (typeof body.toolCall !== "boolean") return error("toolCall 必须是布尔值", 400);
      next.hookSwitches.toolCall = body.toolCall;
    }
    if (body.tools !== undefined) {
      if (!body.tools || typeof body.tools !== "object" || Array.isArray(body.tools)) return error("tools 必须是 { 工具名: { enabled?, exempt? } }", 400);
      for (const [name, patch] of Object.entries(body.tools as Record<string, unknown>)) {
        const sw = (patch ?? {}) as { enabled?: unknown; exempt?: unknown };
        const merged = { ...next.toolSwitches[name] };
        if (typeof sw.enabled === "boolean") merged.enabled = sw.enabled;
        if (typeof sw.exempt === "boolean") merged.exempt = sw.exempt;
        next.toolSwitches[name] = merged;
      }
    }
    upsertRecord(next);
    return json({ plugin: pluginView(next) } satisfies EnginePluginMutationDto);
  }
  return null;
}
