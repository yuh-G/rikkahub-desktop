// locales-pairing.test.ts — 文案成对:zh-CN 与 en-US 各命名空间的键一一对应、插值变量相同、没有空串;
// 源码里写死键名的 t("…") 必须在两种语言里都查得到(缺键时界面会露出键名或写死的兜底文字)。
//
// 键存在性按文件取命名空间:useTranslation 声明的 + 默认的 common;`ns:key` 写法按显式命名空间。
// 拼出来的键(模板字符串)扫描不到,由各自的单测兜底。自己包了一层 t 的文件(给键加前缀)跳过。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const APP = join(import.meta.dir, "..");
const NAMESPACES = ["common", "input", "markdown", "message", "page", "settings"] as const;
const LANGUAGES = ["zh-CN", "en-US"] as const;

type Tree = { [key: string]: string | Tree };

const resources = Object.fromEntries(
  LANGUAGES.map((lng) => [
    lng,
    Object.fromEntries(NAMESPACES.map((ns) => [ns, JSON.parse(readFileSync(join(APP, "locales", lng, `${ns}.json`), "utf8")) as Tree])),
  ]),
) as Record<(typeof LANGUAGES)[number], Record<(typeof NAMESPACES)[number], Tree>>;

function flatten(tree: Tree, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out[path] = value;
    else flatten(value, path, out);
  }
  return out;
}

const variables = (text: string) => [...text.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((match) => match[1]).sort();

function lookup(tree: Tree, key: string): boolean {
  const parts = key.split(".");
  const last = parts.pop()!;
  let node: string | Tree | undefined = tree;
  for (const part of parts) node = typeof node === "object" ? node[part] : undefined;
  if (typeof node !== "object") return false;
  return typeof node[last] === "string" || typeof node[`${last}_one`] === "string" || typeof node[`${last}_other`] === "string";
}

function sourceFiles(): string[] {
  return ["components", "routes", "hooks", "lib", "stores"].flatMap((dir) =>
    readdirSync(join(APP, dir), { recursive: true, encoding: "utf8" })
      .filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".test.ts") && !name.endsWith(".test.tsx"))
      .map((name) => join(APP, dir, name)),
  );
}

describe("zh-CN / en-US 成对", () => {
  for (const ns of NAMESPACES) {
    test(`${ns}:键一一对应,插值变量相同,没有空串`, () => {
      const zh = flatten(resources["zh-CN"][ns]);
      const en = flatten(resources["en-US"][ns]);
      expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
      const mismatched = Object.keys(zh).filter((key) => key in en && variables(zh[key]!).join() !== variables(en[key]!).join());
      expect(mismatched).toEqual([]);
      const empty = [...Object.entries(zh), ...Object.entries(en)].filter(([, value]) => !value.trim()).map(([key]) => key);
      expect(empty).toEqual([]);
    });
  }

  test("源码里写死键名的 t(\"…\") 两种语言都查得到", () => {
    const missing: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf8");
      if (/function t\(/.test(source)) continue;
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      const declared = [...code.matchAll(/useTranslation\(\s*(\[[^\]]*\]|"[^"]*")/g)].flatMap((match) =>
        [...match[1]!.matchAll(/"([^"]+)"/g)].map((name) => name[1]!),
      );
      const fileNamespaces = [...new Set([...declared, "common"])];
      for (const call of code.matchAll(/\b(?:t|i18n\.t)\(\s*"([^"]+)"/g)) {
        const raw = call[1]!;
        const [namespaces, key] = raw.includes(":") ? [[raw.slice(0, raw.indexOf(":"))], raw.slice(raw.indexOf(":") + 1)] : [fileNamespaces, raw];
        for (const lng of LANGUAGES) {
          const found = namespaces.some((ns) => ns in resources[lng] && lookup(resources[lng][ns as (typeof NAMESPACES)[number]], key));
          if (!found) missing.push(`${file.slice(APP.length + 1).replaceAll("\\", "/")}: ${raw} (${lng})`);
        }
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });
});
