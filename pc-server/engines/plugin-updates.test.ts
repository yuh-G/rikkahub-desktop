// engines/plugin-updates.test.ts — 更新检查(P6.2.1):哪些来源检查、版本比较、registry 请求(假 fetch,不出真实网络)
// 与缓存;插件包说明字段的读取与截断、README 的查找与截断。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EnginePluginRecord } from "../foundation/types/settings";
import { normalizePluginMeta, readEnginePluginMeta, readEnginePluginReadme } from "./plugin-package";
import { checkPluginUpdates, forgetPluginUpdate, hasNewerVersion, updatablePackageName } from "./plugin-updates";

const lab = mkdtempSync(join(tmpdir(), "rkh-plugin-updates-"));
afterAll(() => rmSync(lab, { recursive: true, force: true }));

function record(id: string, spec: string, version: string | null, kind: EnginePluginRecord["source"]["kind"] = "npm"): EnginePluginRecord {
  return { id, engine: "pi", name: id, source: { kind, spec }, version, enabled: true, hookSwitches: { toolCall: true }, toolSwitches: {}, installedAt: "" };
}

function fakeRegistry(versions: Record<string, string | Error>) {
  const urls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const name = decodeURIComponent(url.replace("https://registry.npmjs.org/", "").replace(/\/latest$/, ""));
    const version = versions[name];
    if (version instanceof Error) throw version;
    if (!version) return new Response("{}", { status: 404 });
    return Response.json({ name, version });
  }) as typeof fetch;
  return { fetcher, urls };
}

describe("updatablePackageName", () => {
  test("只有 npm 来源的裸包名检查;带版本、标签、压缩包、路径的与 git / 本地来源都不查", () => {
    expect(updatablePackageName(record("a", "pi-todo", "1.0.0"))).toBe("pi-todo");
    expect(updatablePackageName(record("b", "@scope/pi-x", "1.0.0"))).toBe("@scope/pi-x");
    for (const spec of ["pi-todo@1.2.3", "pi-todo@beta", "@scope/pi-x@^1", "C:\\pkgs\\x.tgz", "https://example.com/x.tgz", "file:../x"]) {
      expect(updatablePackageName(record("c", spec, "1.0.0"))).toBeNull();
    }
    expect(updatablePackageName(record("d", "git+https://github.com/o/r", null, "git"))).toBeNull();
    expect(updatablePackageName(record("e", "D:\\plugins\\x", null, "local"))).toBeNull();
  });

  test("版本比较:新版本才算有更新;任一方未知不算", () => {
    expect(hasNewerVersion("1.10.0", "1.9.3")).toBe(true);
    expect(hasNewerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(hasNewerVersion("0.9.0", "1.0.0")).toBe(false);
    expect(hasNewerVersion(null, "1.0.0")).toBe(false);
    expect(hasNewerVersion("1.0.0", null)).toBe(false);
  });
});

describe("checkPluginUpdates", () => {
  test("只查能更新的记录;作用域包名编码;查不到的为 null 且不缓存;命中缓存不再请求,refresh 绕过", async () => {
    const registry = fakeRegistry({ "pi-a": "2.0.0", "@s/pi-b": "1.0.0", "pi-down": new Error("offline") });
    const list = [
      record("pi:pi-a", "pi-a", "1.0.0"),
      record("pi:@s/pi-b", "@s/pi-b", "1.0.0"),
      record("pi:pi-down", "pi-down", "1.0.0"),
      record("pi:pinned", "pi-a@1.0.0", "1.0.0"),
      record("pi:local", "D:\\x", null, "local"),
    ];
    const first = await checkPluginUpdates(list, { fetch: registry.fetcher });
    expect(first.updates).toEqual({
      "pi:pi-a": { latest: "2.0.0", hasUpdate: true },
      "pi:@s/pi-b": { latest: "1.0.0", hasUpdate: false },
      "pi:pi-down": { latest: null, hasUpdate: false },
    });
    expect(registry.urls.toSorted()).toEqual([
      "https://registry.npmjs.org/@s%2fpi-b/latest",
      "https://registry.npmjs.org/pi-a/latest",
      "https://registry.npmjs.org/pi-down/latest",
    ]);

    registry.urls.length = 0;
    await checkPluginUpdates(list, { fetch: registry.fetcher });
    expect(registry.urls).toEqual(["https://registry.npmjs.org/pi-down/latest"]);

    registry.urls.length = 0;
    await checkPluginUpdates(list, { fetch: registry.fetcher, refresh: true });
    expect(registry.urls).toHaveLength(3);

    forgetPluginUpdate("pi-a");
    registry.urls.length = 0;
    await checkPluginUpdates([list[0]!], { fetch: registry.fetcher });
    expect(registry.urls).toEqual(["https://registry.npmjs.org/pi-a/latest"]);
  });
});

describe("插件包说明", () => {
  test("package.json 的几项:作者 / 仓库 / 许可两种写法都认,仓库地址规整成网页地址,超长截断,空项不出现", () => {
    const dir = join(lab, "pkg");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "pi-x",
        description: "说".repeat(600),
        author: { name: "Ada", email: "a@example.com" },
        homepage: "  ",
        repository: { type: "git", url: "git+https://github.com/ada/pi-x.git" },
        license: { type: "MIT" },
      }),
    );
    const meta = readEnginePluginMeta(dir)!;
    expect(meta.description).toHaveLength(500);
    expect(meta).toMatchObject({ author: "Ada", repository: "https://github.com/ada/pi-x", license: "MIT" });
    expect("homepage" in meta).toBe(false);

    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pi-x", author: "Bob", repository: "bob/pi-x", license: "Apache-2.0" }));
    expect(readEnginePluginMeta(dir)).toEqual({ author: "Bob", repository: "https://github.com/bob/pi-x", license: "Apache-2.0" });

    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pi-x" }));
    expect(readEnginePluginMeta(dir)).toBeUndefined();
    expect(readEnginePluginMeta(join(dir, "missing"))).toBeUndefined();
    expect(normalizePluginMeta({ author: "a".repeat(300), bogus: 1 })).toEqual({ author: "a".repeat(200) });
    expect(normalizePluginMeta("x")).toBeUndefined();
  });

  test("README 文件名不分大小写,截到 200 KB;没有包或没有说明时为 null", () => {
    const dir = join(lab, "readme");
    mkdirSync(dir, { recursive: true });
    expect(readEnginePluginReadme(dir)).toBeNull();
    writeFileSync(join(dir, "ReadMe.MD"), "# 标题\n" + "x".repeat(300 * 1024));
    const readme = readEnginePluginReadme(dir)!;
    expect(readme.startsWith("# 标题")).toBe(true);
    expect(new TextEncoder().encode(readme).length).toBeLessThanOrEqual(200 * 1024);
    expect(readEnginePluginReadme(join(dir, "ReadMe.MD"))).toBeNull();
  });
});
