// engines/plugin-market.test.ts — 插件市场(P6.2.2):npm 搜索结果的字段映射(夹具取自 registry 的真实返回)、作者回退、
// catalog 解析与坏条目计数、地址形态识别、缓存命中与 refresh、过期缓存兜底、重复添加、内置源不可移除。
// 网络全部是假 fetch。
import { describe, expect, test } from "bun:test";

import type { EnginePluginRecord, PluginMarketSourceRecord } from "../foundation/types/settings";
import {
  BUILTIN_MARKET_SOURCES,
  catalogSource,
  marketAddressCandidates,
  marketDetail,
  normalizePluginMarketSources,
  npmSearchItem,
  parseCatalog,
  resolveMarketSource,
  searchMarket,
  withoutMarketSource,
} from "./plugin-market";

// 2026-11-17 registry.npmjs.org/-/v1/search?text=keywords:pi-package 的一条(删去与映射无关的字段)。
const WEB_ACCESS = {
  downloads: { monthly: 1394321, weekly: 280923 },
  updated: "2026-11-17T10:07:26.630Z",
  package: {
    name: "pi-web-access",
    keywords: ["pi-package", "pi"],
    version: "0.48.0",
    description: "Web search, URL fetching, GitHub repo cloning",
    publisher: { email: "x@example.com", username: "nicopreme" },
    maintainers: [{ email: "x@example.com", username: "nicopreme" }],
    license: "MIT",
    date: "2026-11-15T19:02:00.512Z",
    links: {
      homepage: "https://github.com/nicobailon/pi-web-access#readme",
      repository: "git+https://github.com/nicobailon/pi-web-access.git",
      npm: "https://www.npmjs.com/package/pi-web-access",
    },
  },
};

const official = BUILTIN_MARKET_SOURCES[0]!;

function fakeFetch(routes: Record<string, unknown | ((url: string) => unknown)>) {
  const urls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!key) return new Response("not found", { status: 404 });
    const route = routes[key];
    const body = typeof route === "function" ? (route as (url: string) => unknown)(url) : route;
    if (body instanceof Error) throw body;
    return Response.json(body);
  }) as typeof fetch;
  return { fetcher, urls };
}

function installedRecord(name: string, version: string, spec = name): EnginePluginRecord {
  return { id: `pi:${name}`, engine: "pi", name, source: { kind: "npm", spec }, version, enabled: true, hookSwitches: { toolCall: true }, toolSwitches: {}, installedAt: "" };
}

describe("npm 条目映射", () => {
  test("字段映射:作者回退到第一个维护者(不用 publisher),仓库地址规整,默认 registry 不写进来源", () => {
    expect(npmSearchItem(WEB_ACCESS, official.url)).toEqual({
      name: "pi-web-access",
      version: "0.48.0",
      description: "Web search, URL fetching, GitHub repo cloning",
      author: "nicopreme",
      monthlyDownloads: 1394321,
      updatedAt: "2026-11-15T19:02:00.512Z",
      links: {
        npm: "https://www.npmjs.com/package/pi-web-access",
        homepage: "https://github.com/nicobailon/pi-web-access#readme",
        repository: "https://github.com/nicobailon/pi-web-access",
      },
      source: { kind: "npm", spec: "pi-web-access" },
    });
    const withAuthor = { ...WEB_ACCESS, package: { ...WEB_ACCESS.package, author: { name: "Nico" }, publisher: { username: "GitHub Actions" } } };
    expect(npmSearchItem(withAuthor, official.url)?.author).toBe("Nico");
    expect(npmSearchItem(WEB_ACCESS, "https://npm.example.com/")?.source).toEqual({ kind: "npm", spec: "pi-web-access", registry: "https://npm.example.com" });
    expect(npmSearchItem({ package: { name: "bad name!" } }, official.url)).toBeNull();
  });
});

describe("catalog", () => {
  test("来源写法:npm: / git: / https 仓库;git: 换成包管理器认的写法;认不出的为 null", () => {
    expect(catalogSource("npm:@scope/pi-x@1.2.0")).toEqual({ kind: "npm", spec: "@scope/pi-x@1.2.0" });
    expect(catalogSource("git:github.com/o/r@v1")).toEqual({ kind: "git", spec: "git+https://github.com/o/r#v1" });
    expect(catalogSource("git:github.com/o/r")).toEqual({ kind: "git", spec: "git+https://github.com/o/r" });
    expect(catalogSource("https://github.com/o/r")).toEqual({ kind: "git", spec: "git+https://github.com/o/r" });
    expect(catalogSource("https://example.com/x.tgz")).toEqual({ kind: "npm", spec: "https://example.com/x.tgz" });
    for (const bad of ["pi-x", "ftp://x", "npm:", "git:", "npm:a b", 3]) expect(catalogSource(bad)).toBeNull();
  });

  test("解析:认不出、别的引擎的条目跳过并计数;名称缺省时取 npm 包名", () => {
    const parsed = parseCatalog(
      {
        name: "团队清单",
        plugins: [
          { name: "todo", source: "npm:pi-todo", description: "待办", author: { name: "Ada" }, homepage: "https://x.dev" },
          { source: "npm:@s/pi-y" },
          { name: "bad", source: "svn://x" },
          { name: "dsh-only", source: "npm:dsh-x", engine: "dsh" },
          "junk",
        ],
      },
      "pi",
    );
    expect(parsed.name).toBe("团队清单");
    expect(parsed.skipped).toBe(3);
    expect(parsed.items).toEqual([
      { name: "todo", description: "待办", author: "Ada", links: { homepage: "https://x.dev" }, source: { kind: "npm", spec: "pi-todo" } },
      { name: "@s/pi-y", links: {}, source: { kind: "npm", spec: "@s/pi-y" } },
    ]);
    expect(() => parseCatalog({ plugins: "x" }, "pi")).toThrow("清单里没有 plugins 数组");
  });
});

describe("地址形态", () => {
  test("owner/repo → GitHub 仓库根目录的清单;.json → 清单;其它 http(s) → 先 registry 后清单;别的写法报错", () => {
    expect(marketAddressCandidates("team/plugins")).toEqual([
      { kind: "catalog", url: "https://raw.githubusercontent.com/team/plugins/HEAD/rikkahub-plugins.json" },
    ]);
    expect(marketAddressCandidates("team/plugins@main")[0]!.url).toBe("https://raw.githubusercontent.com/team/plugins/main/rikkahub-plugins.json");
    expect(marketAddressCandidates("https://example.com/list.json")).toEqual([{ kind: "catalog", url: "https://example.com/list.json" }]);
    expect(marketAddressCandidates("https://npm.example.com/")).toEqual([
      { kind: "npm-registry", url: "https://npm.example.com" },
      { kind: "catalog", url: "https://npm.example.com/" },
    ]);
    expect(() => marketAddressCandidates("ftp://x")).toThrow();
    expect(() => marketAddressCandidates("not an address")).toThrow();
  });
});

describe("检索与缓存", () => {
  test("npm:关键词 + 搜索词、按页偏移;已装的条目带标注(钉版本的不算有更新);命中缓存不再请求,refresh 绕过", async () => {
    const source = { ...official, id: "test-npm-cache" };
    const { fetcher, urls } = fakeFetch({ "https://registry.npmjs.org/-/v1/search": { objects: [WEB_ACCESS], total: 30 } });
    const installed = [installedRecord("pi-web-access", "0.40.0")];
    const first = await searchMarket(source, " web ", 1, installed, { fetch: fetcher });
    expect(urls).toEqual(["https://registry.npmjs.org/-/v1/search?text=keywords%3Api-package%20web&size=24&from=24"]);
    expect(first).toMatchObject({ total: 30, page: 1, pageSize: 24, hasMore: false, fromCache: false });
    expect(first.items[0]!.installed).toEqual({ pluginId: "pi:pi-web-access", version: "0.40.0", hasUpdate: true });

    await searchMarket(source, "web", 1, installed, { fetch: fetcher });
    expect(urls).toHaveLength(1);
    const again = await searchMarket(source, "web", 1, [installedRecord("pi-web-access", "0.40.0", "pi-web-access@0.40.0")], { fetch: fetcher, refresh: true });
    expect(urls).toHaveLength(2);
    expect(again.items[0]!.installed?.hasUpdate).toBe(false);
  });

  test("连不上时有旧缓存就给旧的并标明;没有缓存就报错", async () => {
    const source = { ...official, id: "test-npm-stale" };
    let down = false;
    const { fetcher } = fakeFetch({ "https://registry.npmjs.org/-/v1/search": () => (down ? new Error("offline") : { objects: [WEB_ACCESS], total: 1 }) });
    await searchMarket(source, "", 0, [], { fetch: fetcher });
    down = true;
    const stale = await searchMarket(source, "", 0, [], { fetch: fetcher, refresh: true });
    expect(stale.fromCache).toBe(true);
    expect(stale.staleError).toContain("offline");
    await expect(searchMarket(source, "other", 0, [], { fetch: fetcher })).rejects.toMatchObject({ errorCode: "plugin_market_source_unreachable" });
  });

  test("catalog:整份取一次,搜索与分页在内存里做", async () => {
    const plugins = Array.from({ length: 30 }, (_, i) => ({ name: `p${i}`, source: `npm:pi-p${i}`, description: i === 7 ? "special" : "x" }));
    const { fetcher, urls } = fakeFetch({ "https://example.com/list.json": { plugins } });
    const source = { id: "test-catalog", engine: "pi", kind: "catalog" as const, name: "清单", url: "https://example.com/list.json", builtin: false };
    const page1 = await searchMarket(source, "", 1, [], { fetch: fetcher });
    expect(page1.items.map((item) => item.name)).toEqual(["p24", "p25", "p26", "p27", "p28", "p29"]);
    expect(page1).toMatchObject({ total: 30, hasMore: false });
    const found = await searchMarket(source, "SPECIAL", 0, [], { fetch: fetcher });
    expect(found.items.map((item) => item.name)).toEqual(["p7"]);
    expect(urls).toHaveLength(1);
    const detail = await marketDetail(source, "p7", [], { fetch: fetcher });
    expect(detail.item.source).toEqual({ kind: "npm", spec: "pi-p7" });
  });

  test("npm 条目详情:README、许可、资源类型;包文档过大时退到 latest", async () => {
    const source = { ...official, id: "test-npm-detail" };
    const doc = {
      name: "pi-web-access",
      readme: "# Web",
      "dist-tags": { latest: "0.48.0" },
      time: { "0.48.0": "2026-11-15T19:02:00.512Z" },
      versions: { "0.48.0": { name: "pi-web-access", version: "0.48.0", license: "MIT", homepage: "https://h.dev", pi: { extensions: ["./x.ts"], skills: ["./s"] } } },
    };
    const { fetcher } = fakeFetch({ "https://registry.npmjs.org/pi-web-access": doc });
    const detail = await marketDetail(source, "pi-web-access", [], { fetch: fetcher });
    expect(detail).toMatchObject({
      readme: "# Web",
      license: "MIT",
      resources: { extensions: true, skills: true, prompts: false, themes: false },
      item: { version: "0.48.0", updatedAt: "2026-11-15T19:02:00.512Z", links: { npm: "https://www.npmjs.com/package/pi-web-access", homepage: "https://h.dev" } },
    });

    const big = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/latest")) return Response.json({ name: "@s/big", version: "2.0.0" });
      return new Response("{}", { headers: { "content-length": String(6 * 1024 * 1024) } });
    }) as typeof fetch;
    const fallback = await marketDetail({ ...official, id: "test-npm-big" }, "@s/big", [], { fetch: big });
    expect(fallback.readme).toBeUndefined();
    expect(fallback.item.version).toBe("2.0.0");
    await expect(marketDetail(source, "../etc", [], { fetch: fetcher })).rejects.toMatchObject({ errorCode: "plugin_market_source_invalid" });
  });
});

describe("市场源", () => {
  const existing: PluginMarketSourceRecord[] = [
    { id: "market-a", engine: "pi", kind: "catalog", name: "A", url: "https://example.com/a.json", addedAt: "" },
  ];

  test("添加:registry 探测成功 → npm-registry;否则按清单试,名称取清单里的;重复地址与内置地址拒绝", async () => {
    const { fetcher } = fakeFetch({
      "https://npm.example.com/-/v1/search": { objects: [] },
      "https://lists.example.com/team": { name: "团队插件", plugins: [] },
    });
    const registry = await resolveMarketSource({ url: "https://npm.example.com/" }, existing, { fetch: fetcher });
    expect(registry).toMatchObject({ kind: "npm-registry", url: "https://npm.example.com", name: "npm.example.com", engine: "pi" });
    const catalog = await resolveMarketSource({ url: "https://lists.example.com/team" }, existing, { fetch: fetcher });
    expect(catalog).toMatchObject({ kind: "catalog", url: "https://lists.example.com/team", name: "团队插件" });
    const named = await resolveMarketSource({ url: "https://lists.example.com/team", name: "我的" }, existing, { fetch: fetcher });
    expect(named.name).toBe("我的");

    await expect(resolveMarketSource({ url: "https://example.com/a.json" }, existing, { fetch: fetcher })).rejects.toMatchObject({ errorCode: "plugin_market_source_duplicate" });
    await expect(resolveMarketSource({ url: "https://registry.npmjs.org" }, existing, { fetch: fetcher })).rejects.toMatchObject({ errorCode: "plugin_market_source_duplicate" });
    await expect(resolveMarketSource({ url: "https://nothing.example.com/" }, existing, { fetch: fetcher })).rejects.toMatchObject({ errorCode: "plugin_market_source_unreachable" });
    await expect(resolveMarketSource({ url: "https://x.example.com", engine: "chat" }, existing, { fetch: fetcher })).rejects.toMatchObject({ errorCode: "plugin_engine_unsupported" });
  });

  test("移除:内置的不可移除;读盘丢坏行,名称缺省取主机名", () => {
    expect(withoutMarketSource(existing, "market-a")).toEqual([]);
    expect(() => withoutMarketSource(existing, "pi-official")).toThrow("内置的市场源不能移除");
    expect(() => withoutMarketSource(existing, "nope")).toThrow("市场源不存在");
    expect(
      normalizePluginMarketSources([
        { id: "m1", engine: "pi", kind: "npm-registry", url: "https://npm.example.com", addedAt: "t" },
        { id: "m1", engine: "pi", kind: "catalog", url: "https://dup.example.com" },
        { id: "m2", engine: "pi", kind: "ftp", url: "https://x" },
        { id: "m3", engine: "pi", kind: "catalog", url: "file:///etc" },
        "junk",
      ]),
    ).toEqual([{ id: "m1", engine: "pi", kind: "npm-registry", name: "npm.example.com", url: "https://npm.example.com", addedAt: "t" }]);
    expect(normalizePluginMarketSources(undefined)).toEqual([]);
  });
});
