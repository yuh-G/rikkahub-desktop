// pi-engine/tool-gate-guard.test.ts — pi 会话里的每个工具都过应用审批闸门(P4b.1)
//
// 运行时:runner 在开跑前 assertPiToolsGated(session),这里锁它对未标记工具拒绝开跑。
// 源码扫描:pi-engine/ 不得用 pi 默认后端的工具集合工厂(它们不带应用后端与审批),noTools 只许 "builtin"
// (pi 内建工具一律经 customTools 同名覆盖 + excludeTools 剔除未提供的名字)。
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "../../pi/packages/coding-agent/src/core/extensions/types.ts";
import { assertPiToolsGated, markToolGated } from "./tool-gate";

function fakeSession(definitions: Array<{ name: string; gated: boolean }>) {
  const byName = new Map(
    definitions.map(({ name, gated }) => {
      const definition = { name } as unknown as ToolDefinition;
      return [name, gated ? markToolGated(definition) : definition] as const;
    }),
  );
  return {
    getAllTools: () => [...byName.keys()].map((name) => ({ name })),
    getToolDefinition: (name: string) => byName.get(name),
  };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("审批闸门", () => {
  test("全部标记 → 放行;任一未标记 → 拒绝开跑并点名", () => {
    expect(() => assertPiToolsGated(fakeSession([{ name: "read", gated: true }, { name: "mcp__x", gated: true }]))).not.toThrow();
    expect(() => assertPiToolsGated(fakeSession([{ name: "read", gated: true }, { name: "rogue", gated: false }]))).toThrow("rogue");
  });

  test("源码:不用 pi 默认后端的工具集合工厂;noTools 只许 builtin", () => {
    const forbidden = /\b(createCodingTools|createAllTools|createReadOnlyTools|createAllToolDefinitions|createCodingToolDefinitions|createReadOnlyToolDefinitions)\s*\(/;
    for (const file of sourceFiles(import.meta.dir)) {
      const source = readFileSync(file, "utf-8");
      expect({ file, hit: forbidden.exec(source)?.[0] ?? null }).toEqual({ file, hit: null });
      for (const match of source.matchAll(/^\s*noTools:\s*([^,}\n]+)/gm)) {
        expect({ file, noTools: match[1]!.trim() }).toEqual({ file, noTools: '"builtin"' });
      }
    }
  });
});
