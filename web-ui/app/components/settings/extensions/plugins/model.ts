// 插件页的纯函数(方案 P6.2):首页的分组、筛选、排序,状态徽标的判定,来源与副信息的取值。不碰界面与网络,
// 引擎表从入参来(前端不写死引擎 id 与名字)。
import type {
  EnginePluginRecord,
  EnginePluginSource,
  EnginePluginViewDto,
  PluginAuditEntryDto,
  PluginEngineDto,
} from "~/types/plugins";
import type { PluginHomeFilters } from "~/stores/plugins-view-store";
import { pluginMcpSource } from "@server/tools/mcp-source";

/** 首页一行用到的全部数据:记录来自设置(SSE 推送,进页即有),view 与 update 是两个接口晚到的补充。 */
export interface PluginRowModel {
  record: EnginePluginRecord;
  view?: Pick<EnginePluginViewDto, "installed" | "loadFailed" | "auditCount">;
  update?: { latest: string | null; hasUpdate: boolean };
}

export interface PluginGroup {
  engine: PluginEngineDto;
  rows: PluginRowModel[];
}

/** 状态徽标,按严重程度排(界面取前几个)。只表示状态,不做装饰。 */
export type PluginStatus = "missing" | "load_failed" | "disabled" | "update";

export function pluginStatuses({ record, view, update }: PluginRowModel): PluginStatus[] {
  const statuses: PluginStatus[] = [];
  if (view && !view.installed) statuses.push("missing");
  else if (view?.loadFailed) statuses.push("load_failed");
  if (!record.enabled) statuses.push("disabled");
  if (update?.hasUpdate && view?.installed !== false) statuses.push("update");
  return statuses;
}

export function joinPluginRows(
  records: readonly EnginePluginRecord[],
  views: readonly EnginePluginViewDto[] | undefined,
  updates: Readonly<Record<string, { latest: string | null; hasUpdate: boolean }>>,
): PluginRowModel[] {
  const viewById = new Map((views ?? []).map((view) => [view.id, view]));
  return records.map((record) => ({ record, view: viewById.get(record.id), update: updates[record.id] }));
}

export function matchesPluginQuery(record: EnginePluginRecord, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [record.name, record.meta?.description, record.meta?.author].some((text) =>
    text?.toLocaleLowerCase().includes(needle),
  );
}

/** 引擎筛选只在引擎数 ≥ 2 时出现,也只在那时生效。 */
export function showsEngineFilter(engines: readonly PluginEngineDto[]): boolean {
  return engines.length >= 2;
}

/** 筛选不是默认值(图标按钮据此带底色与小圆点);搜索词不算。 */
export function isPluginFilterActive(filters: PluginHomeFilters, engines: readonly PluginEngineDto[]): boolean {
  return filters.show !== "all" || (showsEngineFilter(engines) && filters.engine !== "all");
}

function byAddedDesc(a: PluginRowModel, b: PluginRowModel): number {
  const diff = Date.parse(b.record.installedAt || "") - Date.parse(a.record.installedAt || "");
  return Number.isNaN(diff) || diff === 0 ? a.record.name.localeCompare(b.record.name) : diff;
}

function byName(a: PluginRowModel, b: PluginRowModel): number {
  return a.record.name.localeCompare(b.record.name, undefined, { sensitivity: "base", numeric: true });
}

/**
 * 首页的分组:按引擎表的顺序,各组分别筛选、排序;筛选后为空的组不出现。引擎表里没有的引擎(表还没取到,或
 * 记录来自已撤下插件运行时的引擎)排在后面,组名用引擎 id。
 */
export function groupPlugins(
  rows: readonly PluginRowModel[],
  engines: readonly PluginEngineDto[],
  filters: PluginHomeFilters,
): PluginGroup[] {
  const engineFilter = showsEngineFilter(engines) ? filters.engine : "all";
  const visible = rows.filter(
    ({ record }) =>
      (filters.show === "all" || record.enabled === (filters.show === "enabled")) &&
      (engineFilter === "all" || record.engine === engineFilter) &&
      matchesPluginQuery(record, filters.query),
  );
  const order = [...engines];
  for (const { record } of rows) {
    if (!order.some((engine) => engine.id === record.engine)) order.push({ id: record.engine, label: record.engine });
  }
  const compare = filters.sort === "name" ? byName : byAddedDesc;
  return order
    .map((engine) => ({ engine, rows: visible.filter((row) => row.record.engine === engine.id).sort(compare) }))
    .filter((group) => group.rows.length > 0);
}

/** 来源的显示:kind 由界面翻译(npm / Git / 本地文件夹 / 上传的文件),detail 是给人看的那一段。 */
export function pluginSourceLabel(source: EnginePluginSource): { kind: EnginePluginSource["kind"]; detail: string } {
  const spec = source.spec.trim();
  if (source.kind === "git") {
    return { kind: "git", detail: spec.replace(/^git\+/, "").replace(/^[a-z]+:\/\//i, "").replace(/\.git(#.*)?$/, "$1") };
  }
  if (source.kind === "local" || source.kind === "upload") {
    return { kind: source.kind, detail: spec.split(/[\\/]/).filter(Boolean).pop() ?? spec };
  }
  return { kind: "npm", detail: spec };
}

/** 行的第二行:「作者 · 简介」;缺作者只写简介;都缺返回 null(界面改写来源)。 */
export function pluginSubtitle(record: EnginePluginRecord): string | null {
  const parts = [record.meta?.author, record.meta?.description].filter((part): part is string => Boolean(part?.trim()));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** 市场条目对应的已装记录:同引擎、同包名、装进安装目录的来源(npm / git / 上传的压缩包;与后端
 *  engines/plugins.ts 的 isPackageSource 同一条规则,本地文件夹与上传的单个脚本不占包名)。 */
export function marketInstalledRecord(
  records: readonly EnginePluginRecord[],
  engine: string,
  name: string,
): EnginePluginRecord | undefined {
  return records.find(
    ({ engine: recordEngine, name: recordName, source }) =>
      recordEngine === engine &&
      recordName === name &&
      (source.kind === "npm" || source.kind === "git" || (source.kind === "upload" && !source.spec.startsWith("scripts/"))),
  );
}

/** 接口返回的一行去掉补充字段,还原成设置里的记录(乐观写入用)。 */
export function recordOfView(view: EnginePluginViewDto): EnginePluginRecord {
  const { path: _path, installed: _installed, loadFailed: _loadFailed, auditCount: _auditCount, ...record } = view;
  return record;
}

/** 运行记录里算作「没有生效」的码(按开关停用、没弹窗的否决是正常行为,不算)。加载失败另有提示条。 */
const ISSUE_CODES = new Set([
  "pi_plugin_removed",
  "pi_plugin_unsupported",
  "pi_plugin_discarded",
  "pi_plugin_runtime_error",
  "pi_plugin_mcp_unsupported",
  "pi_plugin_dialog_failed",
]);

export function pluginIssueCount(audit: readonly PluginAuditEntryDto[]): number {
  return audit.filter((entry) => ISSUE_CODES.has(entry.code)).length;
}

export type AuditSubjectKind = "tool" | "command" | "event" | "mcp" | "provider" | "model" | "other";

/** 审计对象的写法是 `<类>:<名>`;否决与作废只有工具名,加载失败是 load(没有对象)。 */
export function parseAuditSubject(entry: Pick<PluginAuditEntryDto, "code" | "subject">): { kind: AuditSubjectKind; name: string } {
  if (entry.subject === "load") return { kind: "other", name: "" };
  if (entry.code === "pi_plugin_vetoed" || entry.code === "pi_plugin_discarded") return { kind: "tool", name: entry.subject };
  const match = /^(tool|command|event|mcp|provider|model):(.*)$/.exec(entry.subject);
  return match ? { kind: match[1] as AuditSubjectKind, name: match[2]! } : { kind: "other", name: entry.subject };
}

/** README 里的图片只留 https:// 绝对地址的(相对路径在应用里解析不到,渲染出来是裂图)。 */
export function stripRelativeImages(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\((?!\s*<?https:\/\/)[^)]*\)/g, "")
    .replace(/<img\b(?![^>]*\bsrc\s*=\s*["']?https:\/\/)[^>]*>/gi, "");
}

/** 插件声明的 MCP 服务在应用的 MCP 列表里对应的那一台(没登记上为 undefined)。 */
export function registeredPluginMcpServer<T>(servers: readonly T[] | undefined, pluginId: string, name: string): T | undefined {
  return (servers ?? []).find((server) => {
    const source = pluginMcpSource(server);
    return source?.pluginId === pluginId && source.name === name;
  });
}
