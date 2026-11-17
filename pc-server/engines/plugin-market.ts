// engines/plugin-market.ts — 插件市场(P6.2.2,方案 §5.13「市场源」);引擎中立
//
// 市场源两种:npm-registry(按引擎的包关键词检索一个 registry;pi 的官方包目录就是带 pi-package 关键词的 npm 包)、
// catalog(用户自己维护的一份插件清单 JSON)。两种适配器产出同一种条目。内置的市场源是下面的常量表;用户添加的
// 存在 settings.pluginMarketSources(只存用户加的,读盘丢坏行)。
// 缓存:内存,键 = 市场源 id + 搜索词 + 页码,10 分钟,最多 200 项;refresh 绕过;出错不缓存,但有过期的旧结果时
// 照常给出并标明(界面写「显示的是缓存」)。请求走全局 fetch(代理与 UA 自动继承),超时 15 秒。

import type {
  PluginMarketDetailDto,
  PluginMarketItemDto,
  PluginMarketPageDto,
  PluginMarketSourceDto,
} from "../foundation/types/plugins";
import type { EnginePluginRecord, EnginePluginSource, PluginMarketSourceRecord } from "../foundation/types/settings";
import { CodedError } from "../foundation/errors";
import { normalizeGitSpec, npmSpecName } from "./plugin-installer";
import { isPluginEngine } from "./plugin-engines";
import { repositoryUrl } from "./plugin-package";
import { DEFAULT_NPM_REGISTRY, hasNewerVersion, updatablePackageName } from "./plugin-updates";

export const MARKET_PAGE_SIZE = 24;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 200;
const REQUEST_TIMEOUT_MS = 15_000;
const CATALOG_MAX_BYTES = 2 * 1024 * 1024;
const CATALOG_MAX_ENTRIES = 2000;
const PACKAGE_DOC_MAX_BYTES = 5 * 1024 * 1024;
const README_MAX_CHARS = 200 * 1024;

/** 各引擎的包在 npm 上带的关键词。 */
const ENGINE_PACKAGE_KEYWORD: Record<string, string> = { pi: "pi-package" };

export const BUILTIN_MARKET_SOURCES: readonly PluginMarketSourceDto[] = [
  { id: "pi-official", engine: "pi", kind: "npm-registry", name: "Pi", url: DEFAULT_NPM_REGISTRY, builtin: true },
];

export interface MarketOptions {
  refresh?: boolean;
  fetch?: typeof fetch;
}

// ---- 市场源记录 ----

export function normalizePluginMarketSources(value: unknown): PluginMarketSourceRecord[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: PluginMarketSourceRecord[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Partial<PluginMarketSourceRecord>;
    if (typeof raw.id !== "string" || !raw.id || seen.has(raw.id)) continue;
    if (raw.kind !== "npm-registry" && raw.kind !== "catalog") continue;
    if (typeof raw.url !== "string" || !/^https?:\/\//i.test(raw.url) || typeof raw.engine !== "string" || !raw.engine) continue;
    seen.add(raw.id);
    out.push({
      id: raw.id,
      engine: raw.engine,
      kind: raw.kind,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : hostOf(raw.url),
      url: raw.url,
      addedAt: typeof raw.addedAt === "string" ? raw.addedAt : "",
    });
  }
  return out;
}

export function marketSources(records: readonly PluginMarketSourceRecord[] | undefined): PluginMarketSourceDto[] {
  return [...BUILTIN_MARKET_SOURCES, ...(records ?? []).map((record) => ({ ...record, builtin: false }))];
}

export function findMarketSource(records: readonly PluginMarketSourceRecord[] | undefined, id: unknown): PluginMarketSourceDto {
  const source = marketSources(records).find((item) => item.id === id);
  if (!source) throw new CodedError("市场源不存在", "plugin_market_source_invalid");
  return source;
}

/** 移除一个用户添加的市场源;内置的不可移除。 */
export function withoutMarketSource(records: readonly PluginMarketSourceRecord[], id: unknown): PluginMarketSourceRecord[] {
  if (BUILTIN_MARKET_SOURCES.some((item) => item.id === id)) throw new CodedError("内置的市场源不能移除", "plugin_market_source_invalid");
  if (!records.some((item) => item.id === id)) throw new CodedError("市场源不存在", "plugin_market_source_invalid");
  forgetSource(String(id));
  return records.filter((item) => item.id !== id);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url; // 地址读盘前已校验过形态;万一解析不了就原样显示
  }
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();

// ---- 请求 ----

class TooLarge extends Error {}

async function fetchJson(url: string, fetcher: typeof fetch, maxBytes: number): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new CodedError(`连不上市场源:${err instanceof Error ? err.message : String(err)}`, "plugin_market_source_unreachable");
  }
  if (!response.ok) throw new CodedError(`市场源返回 HTTP ${response.status}`, "plugin_market_source_unreachable");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new TooLarge();
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new TooLarge();
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CodedError("市场源返回的不是 JSON", "plugin_market_source_invalid");
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** author 可以是字符串或 { name }。 */
function personName(value: unknown): string | undefined {
  return text(value) ?? text(record(value)?.name);
}

// ---- npm registry ----

const registryBase = (url: string) => url.replace(/\/+$/, "");
const encodePackage = (name: string) => name.replace("/", "%2f");

function npmSourceOf(name: string, registry: string): EnginePluginSource {
  return { kind: "npm", spec: name, ...(sameUrl(registry, DEFAULT_NPM_REGISTRY) ? {} : { registry: registryBase(registry) }) };
}

/** npm 搜索结果的一条 → 市场条目。作者取 package.author,没有则取第一个维护者(publisher 可能是发布机器人)。 */
export function npmSearchItem(object: unknown, registry: string): PluginMarketItemDto | null {
  const pkg = record(record(object)?.package);
  const name = text(pkg?.name);
  if (!pkg || !name || !npmSpecName(name)) return null;
  const links = record(pkg.links) ?? {};
  const maintainers = Array.isArray(pkg.maintainers) ? pkg.maintainers : [];
  const monthly = record(record(object)?.downloads)?.monthly;
  const item: PluginMarketItemDto = {
    name,
    links: {
      ...(text(links.npm) ? { npm: text(links.npm) } : {}),
      ...(text(links.homepage) ? { homepage: text(links.homepage) } : {}),
      ...(repositoryUrl(links.repository) ? { repository: repositoryUrl(links.repository) } : {}),
    },
    source: npmSourceOf(name, registry),
  };
  const version = text(pkg.version);
  const description = text(pkg.description);
  const author = personName(pkg.author) ?? text(record(maintainers[0])?.username);
  const updatedAt = text(pkg.date);
  if (version) item.version = version;
  if (description) item.description = description;
  if (author) item.author = author;
  if (typeof monthly === "number" && Number.isFinite(monthly)) item.monthlyDownloads = monthly;
  if (updatedAt) item.updatedAt = updatedAt;
  return item;
}

function searchUrl(registry: string, keyword: string, query: string, from: number, size: number): string {
  const terms = `keywords:${keyword}${query ? ` ${query}` : ""}`;
  return `${registryBase(registry)}/-/v1/search?text=${encodeURIComponent(terms)}&size=${size}&from=${from}`;
}

async function npmSearch(source: PluginMarketSourceDto, query: string, page: number, fetcher: typeof fetch) {
  const keyword = ENGINE_PACKAGE_KEYWORD[source.engine] ?? `${source.engine}-package`;
  const body = record(await fetchJson(searchUrl(source.url, keyword, query, page * MARKET_PAGE_SIZE, MARKET_PAGE_SIZE), fetcher, CATALOG_MAX_BYTES));
  if (!body || !Array.isArray(body.objects)) throw new CodedError("市场源返回的不是 npm 搜索结果", "plugin_market_source_invalid");
  const items = body.objects.map((object) => npmSearchItem(object, source.url)).filter((item): item is PluginMarketItemDto => item !== null);
  const total = typeof body.total === "number" ? body.total : items.length;
  return { items, total };
}

// ---- catalog ----

/** catalog 条目的来源写法(沿用 pi 文档:npm:<包名>[@版本]、git:<主机/路径>[@ref]、https 仓库地址)→ 安装来源;
 *  认不出时为 null。git: 写法换成包管理器认的 git+https://<主机/路径>#<ref>。 */
export function catalogSource(value: unknown): EnginePluginSource | null {
  const spec = text(value);
  if (!spec || /\s/.test(spec)) return null;
  if (spec.startsWith("npm:")) {
    const pkg = spec.slice(4);
    return npmSpecName(pkg) ? { kind: "npm", spec: pkg } : null;
  }
  if (spec.startsWith("git:")) {
    const match = /^git:([^@]+?)(?:@([^@]+))?$/.exec(spec);
    return match ? { kind: "git", spec: `git+https://${match[1]}${match[2] ? `#${match[2]}` : ""}` } : null;
  }
  if (/^https?:\/\//i.test(spec)) {
    return /\.(tgz|tar\.gz)$/i.test(spec) ? { kind: "npm", spec } : { kind: "git", spec: normalizeGitSpec(spec) };
  }
  return null;
}

export interface ParsedCatalog {
  name?: string;
  items: PluginMarketItemDto[];
  /** 认不出、属于别的引擎、超出条数上限的条目数。 */
  skipped: number;
}

export function parseCatalog(body: unknown, engine: string): ParsedCatalog {
  const root = record(body);
  if (!root || !Array.isArray(root.plugins)) throw new CodedError("清单里没有 plugins 数组", "plugin_market_source_invalid");
  const items: PluginMarketItemDto[] = [];
  let skipped = Math.max(0, root.plugins.length - CATALOG_MAX_ENTRIES);
  for (const entry of root.plugins.slice(0, CATALOG_MAX_ENTRIES)) {
    const raw = record(entry);
    const source = catalogSource(raw?.source);
    const entryEngine = text(raw?.engine) ?? engine;
    const name = text(raw?.name) ?? (source?.kind === "npm" ? npmSpecName(source.spec) ?? undefined : undefined);
    if (!raw || !source || !name || entryEngine !== engine) {
      skipped += 1;
      continue;
    }
    const homepage = text(raw.homepage);
    const item: PluginMarketItemDto = { name, links: homepage ? { homepage } : {}, source };
    const description = text(raw.description);
    const author = personName(raw.author);
    if (description) item.description = description;
    if (author) item.author = author;
    items.push(item);
  }
  const name = text(root.name);
  return { ...(name ? { name } : {}), items, skipped };
}

async function loadCatalog(url: string, engine: string, fetcher: typeof fetch): Promise<ParsedCatalog> {
  try {
    return parseCatalog(await fetchJson(url, fetcher, CATALOG_MAX_BYTES), engine);
  } catch (err) {
    if (err instanceof TooLarge) throw new CodedError("清单超过 2 MB", "plugin_market_source_invalid");
    throw err;
  }
}

function matches(item: PluginMarketItemDto, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [item.name, item.description, item.author].some((value) => value?.toLowerCase().includes(needle));
}

// ---- 缓存 ----

const cache = new Map<string, { value: unknown; at: number }>();

function cached<T>(key: string): { value: T; fresh: boolean } | undefined {
  const hit = cache.get(key);
  return hit ? { value: hit.value as T, fresh: Date.now() - hit.at < CACHE_TTL_MS } : undefined;
}

function remember(key: string, value: unknown): void {
  cache.delete(key);
  cache.set(key, { value, at: Date.now() });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

function forgetSource(sourceId: string): void {
  for (const key of [...cache.keys()]) if (key.startsWith(`${sourceId}|`)) cache.delete(key);
}

/** 新鲜的缓存直接用;否则取一次,出错时有旧缓存就退回旧的并带上错误。 */
async function withCache<T>(key: string, refresh: boolean, load: () => Promise<T>): Promise<{ value: T; fromCache: boolean; staleError?: string; at: number }> {
  const hit = cached<{ data: T; at: number }>(key);
  if (hit?.fresh && !refresh) return { value: hit.value.data, fromCache: true, at: hit.value.at };
  try {
    const data = await load();
    const at = Date.now();
    remember(key, { data, at });
    return { value: data, fromCache: false, at };
  } catch (err) {
    if (!hit) throw err;
    return { value: hit.value.data, fromCache: true, staleError: err instanceof Error ? err.message : String(err), at: hit.value.at };
  }
}

// ---- 已安装标注 ----

function withInstalled(item: PluginMarketItemDto, engine: string, records: readonly EnginePluginRecord[]): PluginMarketItemDto {
  const installed = records.find((rec) => rec.engine === engine && rec.source.kind !== "local" && rec.name === item.name);
  if (!installed) return item;
  const hasUpdate = updatablePackageName(installed) !== null && hasNewerVersion(item.version ?? null, installed.version);
  return { ...item, installed: { pluginId: installed.id, version: installed.version, hasUpdate } };
}

// ---- 对外 ----

/** 市场的一页(page 从 0 起)。catalog 整份缓存,搜索与分页在内存里做。 */
export async function searchMarket(
  source: PluginMarketSourceDto,
  query: string,
  page: number,
  installed: readonly EnginePluginRecord[],
  options: MarketOptions = {},
): Promise<PluginMarketPageDto> {
  const fetcher = options.fetch ?? fetch;
  const q = query.trim();
  const index = Math.max(0, Math.floor(page));
  let result: { value: { items: PluginMarketItemDto[]; total: number }; fromCache: boolean; staleError?: string; at: number };
  if (source.kind === "npm-registry") {
    result = await withCache(`${source.id}|${q}|${index}`, options.refresh === true, () => npmSearch(source, q, index, fetcher));
  } else {
    const catalog = await withCache(`${source.id}|catalog`, options.refresh === true, () => loadCatalog(source.url, source.engine, fetcher));
    const all = catalog.value.items.filter((item) => matches(item, q));
    const start = index * MARKET_PAGE_SIZE;
    result = { ...catalog, value: { items: all.slice(start, start + MARKET_PAGE_SIZE), total: all.length } };
  }
  const { items, total } = result.value;
  return {
    items: items.map((item) => withInstalled(item, source.engine, installed)),
    total,
    page: index,
    pageSize: MARKET_PAGE_SIZE,
    hasMore: (index + 1) * MARKET_PAGE_SIZE < total && items.length > 0,
    fromCache: result.fromCache,
    generatedAt: new Date(result.at).toISOString(),
    ...(result.staleError ? { staleError: result.staleError } : {}),
  };
}

function resourcesOf(pi: unknown): PluginMarketDetailDto["resources"] {
  const manifest = record(pi);
  if (!manifest) return undefined;
  const has = (key: string) => Array.isArray(manifest[key]) && (manifest[key] as unknown[]).length > 0;
  return { extensions: has("extensions"), skills: has("skills"), prompts: has("prompts"), themes: has("themes") };
}

async function npmDetail(source: PluginMarketSourceDto, name: string, fetcher: typeof fetch): Promise<PluginMarketDetailDto> {
  const base = `${registryBase(source.url)}/${encodePackage(name)}`;
  let doc: Record<string, unknown> | null = null;
  let latest: Record<string, unknown> | null;
  try {
    doc = record(await fetchJson(base, fetcher, PACKAGE_DOC_MAX_BYTES));
    const tag = text(record(doc?.["dist-tags"])?.latest);
    latest = tag ? record(record(doc?.versions)?.[tag]) : null;
  } catch (err) {
    // 完整包文档超过 5 MB(版本很多的包):退到只取最新版本,没有说明文字。
    if (!(err instanceof TooLarge)) throw err;
    latest = record(await fetchJson(`${base}/latest`, fetcher, PACKAGE_DOC_MAX_BYTES));
  }
  if (!latest || !text(latest.name)) throw new CodedError(`市场源里没有 ${name}`, "plugin_market_source_invalid");
  const version = text(latest.version);
  const time = record(doc?.time);
  const updatedAt = (version && text(time?.[version])) ?? text(time?.modified);
  const homepage = text(latest.homepage);
  const repository = repositoryUrl(latest.repository);
  const item: PluginMarketItemDto = {
    name,
    links: {
      ...(sameUrl(source.url, DEFAULT_NPM_REGISTRY) ? { npm: `https://www.npmjs.com/package/${name}` } : {}),
      ...(homepage ? { homepage } : {}),
      ...(repository ? { repository } : {}),
    },
    source: npmSourceOf(name, source.url),
  };
  const description = text(latest.description);
  const author = personName(latest.author) ?? text(record((Array.isArray(latest.maintainers) ? latest.maintainers : [])[0])?.name);
  if (version) item.version = version;
  if (description) item.description = description;
  if (author) item.author = author;
  if (updatedAt) item.updatedAt = updatedAt;
  const readme = text(doc?.readme);
  const license = text(latest.license) ?? text(record(latest.license)?.type);
  const resources = resourcesOf(latest.pi);
  return {
    item,
    ...(readme ? { readme: readme.slice(0, README_MAX_CHARS) } : {}),
    ...(license ? { license } : {}),
    ...(resources ? { resources } : {}),
  };
}

export async function marketDetail(
  source: PluginMarketSourceDto,
  name: string,
  installed: readonly EnginePluginRecord[],
  options: MarketOptions = {},
): Promise<PluginMarketDetailDto> {
  const fetcher = options.fetch ?? fetch;
  let detail: PluginMarketDetailDto;
  if (source.kind === "npm-registry") {
    if (!npmSpecName(name) || npmSpecName(name) !== name) throw new CodedError(`包名不对:${name}`, "plugin_market_source_invalid");
    detail = (await withCache(`${source.id}|detail|${name}`, options.refresh === true, () => npmDetail(source, name, fetcher))).value;
  } else {
    const catalog = await withCache(`${source.id}|catalog`, options.refresh === true, () => loadCatalog(source.url, source.engine, fetcher));
    const item = catalog.value.items.find((entry) => entry.name === name);
    if (!item) throw new CodedError(`市场源里没有 ${name}`, "plugin_market_source_invalid");
    detail = { item };
  }
  return { ...detail, item: withInstalled(detail.item, source.engine, installed) };
}

// ---- 添加市场源 ----

/** 用户填的地址 → 候选形态。owner/repo[@ref] = GitHub 仓库根目录的 rikkahub-plugins.json;.json 结尾 = 清单;
 *  其它 http(s) 地址先按 npm registry 探测,不是再按清单试。 */
export function marketAddressCandidates(input: string): Array<{ kind: PluginMarketSourceRecord["kind"]; url: string }> {
  const address = input.trim();
  const repo = /^([\w.-]+)\/([\w.-]+)(?:@([\w./-]+))?$/.exec(address);
  if (repo) {
    return [{ kind: "catalog", url: `https://raw.githubusercontent.com/${repo[1]}/${repo[2]}/${repo[3] ?? "HEAD"}/rikkahub-plugins.json` }];
  }
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new CodedError("地址写法不对:填 owner/repo、清单文件地址或 npm registry 地址", "plugin_market_source_invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CodedError("只支持 http(s) 地址", "plugin_market_source_invalid");
  }
  const href = url.href;
  if (/\.json$/i.test(url.pathname)) return [{ kind: "catalog", url: href }];
  return [
    { kind: "npm-registry", url: registryBase(href) },
    { kind: "catalog", url: href },
  ];
}

async function probeRegistry(url: string, engine: string, fetcher: typeof fetch): Promise<boolean> {
  const keyword = ENGINE_PACKAGE_KEYWORD[engine] ?? `${engine}-package`;
  try {
    return Array.isArray(record(await fetchJson(searchUrl(url, keyword, "", 0, 1), fetcher, CATALOG_MAX_BYTES))?.objects);
  } catch {
    return false; // 不是 registry(或连不上):接着按清单试,清单也不成再报错
  }
}

/** 认类型、探测、返回要保存的记录(不保存)。同一地址不重复添加。 */
export async function resolveMarketSource(
  input: { url?: unknown; name?: unknown; engine?: unknown },
  existing: readonly PluginMarketSourceRecord[],
  options: MarketOptions = {},
): Promise<PluginMarketSourceRecord> {
  const fetcher = options.fetch ?? fetch;
  const address = text(input.url);
  if (!address) throw new CodedError("地址不能为空", "plugin_market_source_invalid");
  const engine = text(input.engine) ?? "pi";
  if (!isPluginEngine(engine)) throw new CodedError(`引擎 ${engine} 没有插件运行时`, "plugin_engine_unsupported");
  const candidates = marketAddressCandidates(address);
  const taken = marketSources(existing);
  if (candidates.some((candidate) => taken.some((source) => sameUrl(source.url, candidate.url)))) {
    throw new CodedError("这个市场源已经添加过了", "plugin_market_source_duplicate");
  }
  let lastError: unknown;
  for (const candidate of candidates) {
    if (candidate.kind === "npm-registry") {
      if (await probeRegistry(candidate.url, engine, fetcher)) {
        return newRecord(candidate.kind, candidate.url, engine, text(input.name) ?? hostOf(candidate.url));
      }
      continue;
    }
    try {
      const catalog = await loadCatalog(candidate.url, engine, fetcher);
      return newRecord(candidate.kind, candidate.url, engine, text(input.name) ?? catalog.name ?? hostOf(candidate.url));
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError instanceof CodedError && lastError.errorCode === "plugin_market_source_unreachable") throw lastError;
  throw new CodedError(
    `这个地址既不是 npm registry,也不是插件清单${lastError instanceof Error ? `(${lastError.message})` : ""}`,
    "plugin_market_source_invalid",
  );
}

function newRecord(kind: PluginMarketSourceRecord["kind"], url: string, engine: string, name: string): PluginMarketSourceRecord {
  return { id: `market-${crypto.randomUUID()}`, engine, kind, name: name.slice(0, 80), url, addedAt: new Date().toISOString() };
}
