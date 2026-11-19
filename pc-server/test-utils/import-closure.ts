// test-utils/import-closure.ts — 源码扫描守卫共用:从入口出发的运行时导入闭包。
// 只跟运行时导入(`import type` / `export type` 在编译期擦除),含多行 import 与动态 import();只认相对路径
// (包名与 node: 内建不展开);落进 stopAt 里任一目录的模块记下但不再展开(vendored pi/ 就这样处理)。

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** 静态的运行时导入(import / export … from,不含 type 与动态 import())的相对说明符。 */
export function staticRuntimeSpecifiers(src: string): string[] {
  const staticPattern = /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/gm;
  return [...src.matchAll(staticPattern)].map((match) => match[1]!);
}

/** 运行时导入的相对说明符:静态的加上动态 import()。 */
export function runtimeSpecifiers(src: string): string[] {
  const dynamicPattern = /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']/g;
  return [...staticRuntimeSpecifiers(src), ...[...src.matchAll(dynamicPattern)].map((match) => match[1]!)];
}

export function resolveModule(from: string, specifier: string): string | null {
  const target = resolve(dirname(from), specifier);
  for (const candidate of [target, `${target}.ts`, join(target, "index.ts")]) {
    if (candidate.endsWith(".ts") && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** 闭包里每个模块 → 把它引进来的模块(入口为 null)。 */
export function runtimeImportClosure(entries: string[], stopAt: string[] = []): Map<string, string | null> {
  const parent = new Map<string, string | null>(entries.map((entry) => [entry, null]));
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (stopAt.some((root) => file.startsWith(root + sep))) continue;
    for (const specifier of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      const target = resolveModule(file, specifier);
      if (!target || parent.has(target)) continue;
      parent.set(target, file);
      queue.push(target);
    }
  }
  return parent;
}

/** 闭包里落进 roots 任一目录的模块,各带一条从入口过来的导入链(路径相对 base)。 */
export function closureHitsUnder(closure: Map<string, string | null>, roots: string[], base: string): string[] {
  return [...closure.keys()]
    .filter((file) => roots.some((root) => file === root || file.startsWith(root + sep)))
    .map((file) => {
      const chain: string[] = [];
      for (let cur: string | null = file; cur; cur = closure.get(cur) ?? null) chain.unshift(relative(base, cur).replaceAll("\\", "/"));
      return chain.join(" → ");
    });
}
