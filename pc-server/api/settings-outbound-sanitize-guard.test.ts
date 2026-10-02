// settings-outbound-sanitize-guard.test.ts — settings 出站净化卫兵
// 暴露面纪律(auth.ts stripAuthSecrets 头注):凡把 settings 对象回传前端的响应
// (HTTP body / SSE 帧),必须经 stripAuthSecrets —— 裸发会把 webPasswordHash 与
// OAuth refresh token 送进浏览器并写进 localStorage 镜像(settings-mirror)。
// 已收口的暴露面:settings GET、events SSE 首帧/增量、data/* 的恢复与导入响应。
// 修复前 data.ts 6 处(webdav/s3 restore 两条路 + import 两条路)裸发 state.settings。
// 卫兵方式沿用 sse-headers-guard:源码扫描而非运行时驱动——出站点分散且新增频繁,
// 扫描能在"新增响应又忘了包净化"的提交当下变红,不依赖恰好驱动到那条路径。
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

describe("settings 出站净化卫兵", () => {
  test("api/ 下不得把 state.settings 原样塞进响应/SSE 帧(必须经 stripAuthSecrets)", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(import.meta.dir)) {
      const src = readFileSync(file, "utf8");
      // 命中"响应载荷里出现 settings: state.settings"的裸形态。stripAuthSecrets 包裹后
      // 文本形态为 settings: stripAuthSecrets(state.settings),不会命中本正则。
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (/settings:\s*state\.settings\b/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test("handlers/data 的恢复/导入响应逐条走 stripAuthSecrets(结构锁,防卫兵正则被绕形)", () => {
    const src = readFileSync(join(import.meta.dir, "handlers", "data.ts"), "utf8");
    const sanitized = src.match(/settings:\s*stripAuthSecrets\(state\.settings\)/g) ?? [];
    // 6 处:webdav restore ×2(直连/流式)、s3 restore ×2(直连/流式)、import ×2(zip/json)。
    expect(sanitized.length).toBe(6);
  });
});
