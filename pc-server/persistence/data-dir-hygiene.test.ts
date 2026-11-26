// 全面审查 R1-13 回归测试:数据目录卫生三类清扫。
// 安全红线:corrupt 隔离每族必须保住最新一份(唯一取证副本);updates/ 只删版本可解析
// 且 ≤ 当前版本的项;pre-memory-split.bak 只在"迁移标记已写 + 超龄"双条件下退役。
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sweepCorruptQuarantineIn, sweepLegacyPiAgentDirIn, sweepMemorySplitFossilIn, sweepStaleInstallersIn } from "./data-dir-hygiene";

const DAY_MS = 24 * 60 * 60 * 1000;

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("sweepLegacyPiAgentDirIn(旧版 pi 数据目录 pi-agent/ 退役)", () => {
  test("pi-agent/ 整目录删除;新位置 engines/pi/ 不碰;不存在时返回 false", () => {
    const dir = freshDir("rikka-pi-agent-");
    mkdirSync(join(dir, "pi-agent", "sessions"), { recursive: true });
    writeFileSync(join(dir, "pi-agent", "sessions", "a.jsonl"), "{}");
    mkdirSync(join(dir, "engines", "pi"), { recursive: true });
    writeFileSync(join(dir, "engines", "pi", "plugin-state.json"), "{}");
    expect(sweepLegacyPiAgentDirIn(dir)).toBe(true);
    expect(existsSync(join(dir, "pi-agent"))).toBe(false);
    expect(existsSync(join(dir, "engines", "pi", "plugin-state.json"))).toBe(true);
    expect(sweepLegacyPiAgentDirIn(dir)).toBe(false);
  });
});

describe("sweepCorruptQuarantineIn(损坏隔离:同族保最新,其余超龄清)", () => {
  test("最新一份无论多老都保留;更旧的超龄即删;非 corrupt 文件不碰", () => {
    const dir = freshDir("rikka-corrupt-");
    writeFileSync(join(dir, "rikka_hub.db.corrupt-100"), "old");
    writeFileSync(join(dir, "rikka_hub.db.corrupt-200"), "newer");
    writeFileSync(join(dir, "rikka_hub.db"), "live");
    // 用未来时钟模拟两份都已超龄
    const removed = sweepCorruptQuarantineIn(dir, 30 * DAY_MS, Date.now() + 60 * DAY_MS);
    expect(removed).toEqual(["rikka_hub.db.corrupt-100"]);
    expect(existsSync(join(dir, "rikka_hub.db.corrupt-200"))).toBe(true);
    expect(existsSync(join(dir, "rikka_hub.db"))).toBe(true);
  });

  test("未超龄的旧副本保留(30 天取证窗口)", () => {
    const dir = freshDir("rikka-corrupt-");
    writeFileSync(join(dir, "global_memory.json.corrupt-1"), "a");
    writeFileSync(join(dir, "global_memory.json.corrupt-2"), "b");
    expect(sweepCorruptQuarantineIn(dir)).toEqual([]);
  });
});

describe("sweepStaleInstallersIn(过时安装包:≤ 当前版本即删,解析不出版本保留)", () => {
  test("旧版/同版安装包与解压目录删,新版与不可解析项保留", () => {
    const dir = freshDir("rikka-updates-");
    writeFileSync(join(dir, "Rikkahub_1.4.1_x64-setup.exe"), "old");
    writeFileSync(join(dir, "Rikkahub_1.5.0_x64-setup.exe"), "current");
    writeFileSync(join(dir, "Rikkahub_1.6.0_x64-setup.exe"), "newer");
    writeFileSync(join(dir, "notes.txt"), "无版本号");
    mkdirSync(join(dir, "extracted-Rikkahub_1.4.1_x64"));
    writeFileSync(join(dir, "extracted-Rikkahub_1.4.1_x64", "inner.bin"), "x");

    const removed = sweepStaleInstallersIn(dir, "1.5.0").sort();
    expect(removed).toEqual(["Rikkahub_1.4.1_x64-setup.exe", "Rikkahub_1.5.0_x64-setup.exe", "extracted-Rikkahub_1.4.1_x64"]);
    expect(existsSync(join(dir, "Rikkahub_1.6.0_x64-setup.exe"))).toBe(true);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });

  test("updates/ 不存在 → 空结果不抛错", () => {
    expect(sweepStaleInstallersIn(join(tmpdir(), "rikka-不存在的目录"), "1.5.0")).toEqual([]);
  });
});

describe("sweepMemorySplitFossilIn(1.3.2 化石快照:标记已写 + 超龄双条件)", () => {
  test("迁移未完成或未超龄 → 不动;双条件满足 → 删", () => {
    const dir = freshDir("rikka-fossil-");
    const bak = join(dir, "state.json.pre-memory-split.bak");
    writeFileSync(bak, "fossil");

    expect(sweepMemorySplitFossilIn(dir, false, 30 * DAY_MS, Date.now() + 60 * DAY_MS)).toBe(false);
    expect(existsSync(bak)).toBe(true);
    expect(sweepMemorySplitFossilIn(dir, true, 30 * DAY_MS, Date.now())).toBe(false);
    expect(existsSync(bak)).toBe(true);
    expect(sweepMemorySplitFossilIn(dir, true, 30 * DAY_MS, Date.now() + 60 * DAY_MS)).toBe(true);
    expect(existsSync(bak)).toBe(false);
  });

  test("pre-sqlite.bak 绝不在清扫范围内(恢复链兜底)", () => {
    const dir = freshDir("rikka-fossil-");
    writeFileSync(join(dir, "state.json.pre-sqlite.bak"), "load-bearing");
    sweepMemorySplitFossilIn(dir, true, 30 * DAY_MS, Date.now() + 365 * DAY_MS);
    sweepCorruptQuarantineIn(dir, 30 * DAY_MS, Date.now() + 365 * DAY_MS);
    expect(existsSync(join(dir, "state.json.pre-sqlite.bak"))).toBe(true);
  });
});
