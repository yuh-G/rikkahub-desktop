// engines/engine-agnostic-guard.test.ts — 引擎中立卫兵(方案 §5.3 不变式 1)+ pi 驱动可搬迁卫兵(P2.6)
//
// conversations/(编排器、会话记录)与契约 engines/contract.ts 不得直接 import 任何具体引擎
// 目录(pi-engine/、vendored pi/)。具体驱动只在注册表(engines/index.ts)实例化:编排器经
// 注册表拿到驱动句柄,只认契约。只查直接 import——注册表本身就是组装点,传递依赖经过它是
// 设计使然。测试文件不在约束内(测试可以直接构造引擎夹具)。
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { closureHitsUnder, runtimeImportClosure, runtimeSpecifiers } from "../test-utils/import-closure";

const serverRoot = resolve(import.meta.dir, "..");
const forbiddenRoots = [join(serverRoot, "pi-engine"), resolve(serverRoot, "..", "pi")];

function productionFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...productionFilesUnder(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** 静态 import/export from、裸 import、动态 import() 的相对路径说明符。 */
function relativeSpecifiers(src: string): string[] {
  const pattern = /(?:\bfrom\s+|\bimport\s+|\bimport\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
  return [...src.matchAll(pattern)].map((match) => match[1]!);
}

function forbiddenImportsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return relativeSpecifiers(src).filter((specifier) => {
    const target = resolve(dirname(file), specifier);
    return forbiddenRoots.some((root) => target === root || target.startsWith(root + sep));
  });
}

describe("引擎中立卫兵(§5.3 不变式 1)", () => {
  test("conversations/ 与 engines/contract.ts 不直接 import pi-engine/ 或 pi/", () => {
    const files = [...productionFilesUnder(join(serverRoot, "conversations")), join(serverRoot, "engines", "contract.ts")];
    expect(files.length).toBeGreaterThan(5);
    const offenders = files.flatMap((file) =>
      forbiddenImportsOf(file).map((specifier) => `${relative(serverRoot, file)} → ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  test("扫描器自检:能识别三种 import 形态", () => {
    const sample = [
      'import { a } from "../pi-engine/runner";',
      'export type { B } from "../../pi/packages/ai/src/types.ts";',
      'const c = await import("../pi-engine/driver");',
      'import "../engines/contract";',
    ].join("\n");
    expect(relativeSpecifiers(sample)).toEqual([
      "../pi-engine/runner",
      "../../pi/packages/ai/src/types.ts",
      "../pi-engine/driver",
      "../engines/contract",
    ]);
  });
});

// pi 驱动必须能整体搬进子进程(pi-engine/host-process.ts,scripts/engine-contract-smoke.ts 实跑):
// 它的运行时导入闭包里不能有应用状态与会话层。查传递闭包——经中间模块间接拉进 persistence 与直接
// import 一样会让子进程加载应用状态。只跟运行时导入(import type 在编译期擦除);vendored pi/ 不展开。
const appStateRoots = ["persistence", "conversations", "api"].map((dir) => join(serverRoot, dir));

/** 从入口出发的运行时导入闭包;返回落进应用状态目录的模块及其导入链。 */
function appStateReachableFrom(entries: string[]): string[] {
  return closureHitsUnder(runtimeImportClosure(entries, [resolve(serverRoot, "..", "pi")]), appStateRoots, serverRoot);
}

describe("pi 驱动可搬迁卫兵(P2.6)", () => {
  test("pi-engine/ 的运行时导入闭包不含 persistence/、conversations/、api/", () => {
    const entries = productionFilesUnder(join(serverRoot, "pi-engine"));
    expect(entries.map((file) => relative(serverRoot, file).replaceAll("\\", "/"))).toContain("pi-engine/host-process.ts");
    expect(appStateReachableFrom(entries)).toEqual([]);
  });

  test("扫描器自检:跳过 import type,识别多行与动态 import", () => {
    const sample = [
      'import type { A } from "../persistence/json-store";',
      "import {",
      "  b,",
      '} from "../api/logs";',
      'export { c } from "./c";',
      'const d = await import("../conversations/index");',
    ].join("\n");
    expect(runtimeSpecifiers(sample)).toEqual(["../api/logs", "./c", "../conversations/index"]);
  });
});
