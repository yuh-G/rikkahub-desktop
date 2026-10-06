// conversations/engine-agnostic-guard.test.ts — 会话层对具体引擎零认知(T5 行为锁)。
//
// T5 把 pi 的装配(富化/资源/工具/模型极限/压缩回退)从编排器迁到 pi-engine/assembly,
// 引擎实现改在 engines/index createEngineRegistry 单点接线。本卫兵锁死回归路径:
// conversations/ 下任何生产文件 import pi-engine/ = 引擎专属逻辑又漏回会话层——下一个
// 引擎(dsh 等)接入时编排器就得再长一条分支。会话层只认 engines/ 的引擎无关契约。
// (引擎 → 会话层的方向是允许的:引擎装配读写会话数据,如 pi-engine/assembly 用
// conversations/engine-compactions。)
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("会话层引擎无关卫兵(T5)", () => {
  test("conversations/ 生产代码不得 import pi-engine/(引擎专属装配住引擎目录,经注册表接线)", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(import.meta.dir)) {
      const src = readFileSync(file, "utf8");
      if (/from\s+["'][./]*pi-engine\//.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
