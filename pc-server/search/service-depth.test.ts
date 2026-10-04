// service-depth.test.ts — 搜索深度登记表的行为锁:只有真消费深度的类型登记、值域外回落缺省、
// 后端请求体用的就是这里的解析结果(index.ts 不再各写各的 `?? "basic"`)。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { SEARCH_DEPTH_OPTIONS, resolveSearchDepth, searchDepthSpecOf } from "./service-depth";

describe("深度登记表", () => {
  test("只登记真正消费 depth 的三种服务", () => {
    expect(Object.keys(SEARCH_DEPTH_OPTIONS).sort()).toEqual(["linkup", "rikkahub", "tavily"]);
    expect(searchDepthSpecOf("exa")).toBeUndefined();
    expect(searchDepthSpecOf("custom_js")).toBeUndefined();
  });

  test("缺省值必须在各自值域内", () => {
    for (const spec of Object.values(SEARCH_DEPTH_OPTIONS)) expect(spec.values).toContain(spec.fallback);
  });

  test("值域内取用户值,空值与值域外回落缺省", () => {
    expect(resolveSearchDepth({ type: "tavily", depth: "basic" })).toBe("basic");
    expect(resolveSearchDepth({ type: "tavily" })).toBe("advanced");
    expect(resolveSearchDepth({ type: "tavily", depth: "standard" })).toBe("advanced");
    expect(resolveSearchDepth({ type: "linkup", depth: "advanced" })).toBe("standard");
    expect(resolveSearchDepth({ type: "rikkahub", depth: "deep" })).toBe("deep");
    expect(resolveSearchDepth({ type: "zhipu", depth: "deep" })).toBeUndefined();
  });

  test("后端请求体统一走 resolveSearchDepth(不再各自写死回落值)", () => {
    const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(source).not.toMatch(/service\.depth\s*\?\?/);
    expect(source).not.toMatch(/depth:\s*"standard"/);
    expect(source.match(/resolveSearchDepth\(service\)/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });
});
