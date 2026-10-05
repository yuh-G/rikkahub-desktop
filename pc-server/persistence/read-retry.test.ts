// 读失败三分类回归(对齐 APP 70b382f5 的灾难路径修复):
//   ①JSON 彻底损坏 → 走恢复链 + 隔离原件(corrupt-* 副本留在数据目录);
//   ②瞬时 IO 错误(EBUSY/EPERM) → 指数退避重读,读到了就用真数据;
//   ③持续 IO 错误 → 原样上抛(调用方标记启动失败重启重试,绝不当损坏回退备份)。
// 灾难路径是②被当③:文件好好的只是被杀软锁了一下,却回退到旧一天的 daily.bak,
// 随后首次落盘把旧状态写回——一整天的配置变更(含新填的 API key)静默蒸发。
// readStateFileWithRetry 的 readFn 注入即失败序列直测(不 mock node:fs)。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readStateFileWithRetry } from "./state-load";

function tempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rkh-read-retry-"));
  const path = join(dir, "state.json");
  writeFileSync(path, content);
  return path;
}

describe("readStateFileWithRetry(读失败三分类)", () => {
  test("正常文件:默认读函数一次读出", () => {
    const path = tempFile('{"settings":{"a":1}}');
    expect(readStateFileWithRetry(path)).toBe('{"settings":{"a":1}}');
  });

  test("不存在 → ENOENT 原样上抛且不重试(非瞬时,调用方走『启动失败重试』而非恢复链)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rkh-read-retry-"));
    let reads = 0;
    expect(() =>
      readStateFileWithRetry(join(dir, "missing.json"), (p) => {
        reads += 1;
        throw new Error(`open ${p}: ENOENT: no such file or directory`);
      }),
    ).toThrow(/ENOENT/);
    expect(reads).toBe(1);
  });

  test("瞬时锁文件(先两次 EBUSY、第三次成功) → 重试后读到真数据", () => {
    const path = tempFile('{"ok":true}');
    let calls = 0;
    const result = readStateFileWithRetry(path, () => {
      calls += 1;
      if (calls <= 2) throw new Error(`read ${path}: EBUSY: resource busy or locked`);
      return '{"ok":true}';
    });
    expect(result).toBe('{"ok":true}');
    expect(calls).toBe(3);
  });

  test("持续 EPERM → 退避三次(共四读)后上抛原始 IO 错误,不是 SyntaxError", () => {
    const path = tempFile("{}");
    let calls = 0;
    let thrown: unknown = null;
    try {
      readStateFileWithRetry(path, () => {
        calls += 1;
        throw new Error(`open ${path}: EPERM: operation not permitted`);
      });
    } catch (err) {
      thrown = err;
    }
    expect(calls).toBe(4); // 初读 + 3 次重试
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("EPERM");
    expect(thrown).not.toBeInstanceOf(SyntaxError);
  });

  test("瞬时判定覆盖反病毒/索引器常见错误码(EBUSY/EPERM/EACCES/EAGAIN/UNKNOWN)", () => {
    for (const code of ["EBUSY", "EPERM", "EACCES", "EAGAIN", "UNKNOWN"]) {
      const path = tempFile("{}");
      let calls = 0;
      const result = readStateFileWithRetry(path, () => {
        calls += 1;
        if (calls === 1) throw new Error(`read ${path}: ${code}: transient`);
        return '{"recovered":1}';
      });
      expect(result).toBe('{"recovered":1}');
      expect(calls).toBe(2);
    }
  });
});
