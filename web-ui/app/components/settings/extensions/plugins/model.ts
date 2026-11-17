// 插件页的纯函数(方案 P6.2):首页的分组、筛选、排序,状态徽标的判定,来源与副信息的取值。不碰界面与网络,
// 引擎表从入参来(前端不写死引擎 id 与名字)。
import type { EnginePluginRecord, EnginePluginSource, EnginePluginViewDto, PluginEngineDto } from "~/types/plugins";
import type { PluginHomeFilters } from "~/stores/plugins-view-store";

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
