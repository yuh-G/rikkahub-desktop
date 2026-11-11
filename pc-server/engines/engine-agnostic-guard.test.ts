// engines/engine-agnostic-guard.test.ts — 引擎中立卫兵(方案 §5.3 不变式 1)
//
// conversations/(编排器、会话记录)与契约 engines/contract.ts 不得直接 import 任何具体引擎
// 目录(pi-engine/、vendored pi/)。具体驱动只在注册表(engines/index.ts)实例化:编排器经
// 注册表拿到驱动句柄,只认契约。只查直接 import——注册表本身就是组装点,传递依赖经过它是
// 设计使然。测试文件不在约束内(测试可以直接构造引擎夹具)。
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

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
