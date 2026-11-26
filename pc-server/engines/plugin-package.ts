// engines/plugin-package.ts — 插件包里给人看的内容:package.json 的几项说明与包根的 README(P6.2.1,方案 §5.13)
//
// 安装 / 重装时读一次 package.json 存进记录(首页的行与详情直接用,不必每次加载插件代码);README 只在打开详情时读。
// 单个文件的本地插件没有包,两样都没有。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EnginePluginMeta } from "../foundation/types/settings";

const DESCRIPTION_MAX = 500;
const FIELD_MAX = 200;
const README_MAX_BYTES = 200 * 1024;

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, max) : undefined;
}

/** author 可以是字符串或 { name };repository 可以是字符串或 { url };license 可以是字符串或老写法 { type }。 */
function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : value;
}

/** 仓库地址规整成能在浏览器打开的形态:git+https://…/x.git → https://…/x,github:o/r 与 o/r → GitHub 地址。 */
export function repositoryUrl(value: unknown): string | undefined {
  const raw = clip(field(value, "url"), FIELD_MAX);
  if (!raw) return undefined;
  const shorthand = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(raw);
  if (shorthand) return `https://github.com/${shorthand[1]}`;
  return raw.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/\.git$/, "");
}

/** 记录里的说明字段按同一套上限规整(读盘、安装都走它);一项都没有时为 undefined。 */
export function normalizePluginMeta(value: unknown): EnginePluginMeta | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const meta: EnginePluginMeta = {};
  const description = clip(raw.description, DESCRIPTION_MAX);
  if (description) meta.description = description;
  for (const key of ["author", "homepage", "repository", "license"] as const) {
    const text = clip(raw[key], FIELD_MAX);
    if (text) meta[key] = text;
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

function packageRoot(path: string): string | null {
  try {
    return statSync(path).isDirectory() ? path : null;
  } catch {
    return null; // 包不在(换机恢复后未重装):没有可读的内容
  }
}

/** 从包根的 package.json 读说明字段。读不到或不是目录时为 undefined。 */
export function readEnginePluginMeta(path: string): EnginePluginMeta | undefined {
  const root = packageRoot(path);
  if (!root) return undefined;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined; // 没有或读不懂 package.json:不显示说明
  }
  return normalizePluginMeta({
    description: pkg.description,
    author: field(pkg.author, "name"),
    homepage: pkg.homepage,
    repository: repositoryUrl(pkg.repository),
    license: field(pkg.license, "type"),
  });
}

/** 包根的 README(文件名不分大小写,README / README.md / README.markdown / README.txt),截到 200 KB。 */
export function readEnginePluginReadme(path: string): string | null {
  const root = packageRoot(path);
  if (!root) return null;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return null; // 目录读不了:按没有说明处理
  }
  const name = names.find((item) => /^readme(\.(md|markdown|txt))?$/i.test(item));
  if (!name) return null;
  try {
    const bytes = readFileSync(join(root, name));
    return new TextDecoder().decode(bytes.subarray(0, README_MAX_BYTES));
  } catch {
    return null; // 读失败(被占用、权限):按没有说明处理
  }
}
