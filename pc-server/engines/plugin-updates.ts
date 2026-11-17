// engines/plugin-updates.ts — 插件的更新检查(P6.2.1,方案 §5.13「更新检查」)
//
// 只查 npm 来源、且来源写法没钉版本的记录(pi 的规则:写了版本的 npm 包是钉住的,不随更新走;压缩包、路径、
// 地址也不是 registry 上的包)。git / 上传 / 本地来源不检查,只有「重新安装」。
// 最新版本取 GET <registry>/<包名>/latest;并发上限 6;查到的结果在内存里缓存 10 分钟,refresh 绕过,查不到的不缓存。
// 请求走全局 fetch(代理与 UA 自动继承),超时 15 秒。

import { compareSemver } from "../foundation/utils";
import type { EnginePluginRecord } from "../foundation/types/settings";
import type { EnginePluginUpdatesDto } from "../foundation/types/plugins";
import { npmSpecName } from "./plugin-installer";

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
const CACHE_TTL_MS = 10 * 60_000;
const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 15_000;

const cache = new Map<string, { latest: string; at: number }>();

/** 能检查更新时返回包名:npm 来源,写法就是裸包名(没带版本、标签、路径或地址)。 */
export function updatablePackageName(record: Pick<EnginePluginRecord, "source">): string | null {
  if (record.source.kind !== "npm") return null;
  const spec = record.source.spec.trim();
  const name = npmSpecName(spec);
  return name && name === spec && !/\.(tgz|tar\.gz)$/i.test(spec) ? name : null;
}

export function hasNewerVersion(latest: string | null, current: string | null): boolean {
  return Boolean(latest && current && compareSemver(latest, current) > 0);
}

function cacheKey(registry: string, name: string) {
  return `${registry}|${name}`;
}

export function forgetPluginUpdate(name: string, registry = DEFAULT_NPM_REGISTRY): void {
  cache.delete(cacheKey(registry, name));
}

async function fetchLatest(name: string, registry: string, fetcher: typeof fetch): Promise<string | null> {
  // 带作用域的包名里的 / 要编码(@scope%2fname),registry 两种写法都认,编码的更通用。
  const url = `${registry.replace(/\/+$/, "")}/${name.replace("/", "%2f")}/latest`;
  try {
    const response = await fetcher(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" && body.version ? body.version : null;
  } catch {
    return null; // 断网、超时、registry 返回的不是 JSON:这一条按「没查到」显示,不影响其它
  }
}

async function latestOf(name: string, registry: string, refresh: boolean, fetcher: typeof fetch): Promise<string | null> {
  const key = cacheKey(registry, name);
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.latest;
  const latest = await fetchLatest(name, registry, fetcher);
  if (latest) cache.set(key, { latest, at: Date.now() });
  return latest;
}

export async function checkPluginUpdates(
  records: readonly EnginePluginRecord[],
  options: { refresh?: boolean; fetch?: typeof fetch } = {},
): Promise<EnginePluginUpdatesDto> {
  const fetcher = options.fetch ?? fetch;
  const targets = records.flatMap((record) => {
    const name = updatablePackageName(record);
    return name ? [{ record, name }] : [];
  });
  const updates: EnginePluginUpdatesDto["updates"] = {};
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const { record, name } = targets[next++]!;
      const latest = await latestOf(name, DEFAULT_NPM_REGISTRY, options.refresh === true, fetcher);
      updates[record.id] = { latest, hasUpdate: hasNewerVersion(latest, record.version) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  return { updates, checkedAt: new Date().toISOString() };
}
