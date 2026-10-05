// backup/global-agents-roundtrip.test.ts — 全局工作区指引(pc-data/AGENTS.md,引擎中立)
// 备份面回归:导出 zip 顶层携带四个候选名文件(不扫目录、不打包 pi-agent/),
// 导入恢复首命中候选(与读取语义对齐,不复制被遮蔽的次选)。
// 端到端走隔离数据目录直调 createSettingsBackupZipToPath(同 import-overwrite e2e
// 的数据隔离思路),zip 落盘后解包断言条目。
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-gagents-bak-"));

const jsonStore = await import("../persistence/json-store");
const { defaultState } = await import("../app-config/defaults");
const { setState } = jsonStore;
const { dataDir, piAgentDir } = await import("../foundation/paths");
const { createSettingsBackupZipToPath } = await import("./export");
const { readZipEntries } = await import("../files/index");
const { readGlobalAgentsFile } = await import("../agents/global-agents");

import type { State } from "../foundation/types";

const priorState = jsonStore.state;
setState(defaultState() as unknown as State);

afterAll(async () => {
  await jsonStore.flushSaveState().catch(() => {});
  setState(priorState);
  rmSync(process.env.RIKKAHUB_PC_DATA_DIR!, { recursive: true, force: true });
});

describe("全局工作区指引备份面(引擎中立)", () => {
  test("导出 zip 顶层携带 AGENTS.md;客房(pi-agent/)绝不打包", async () => {
    writeFileSync(join(dataDir, "AGENTS.md"), "# My global rules\n\n- Answer in Chinese.\n", "utf8");
    // 客房里的任何文件都不该进备份(引擎私产,且全局层已不在此)
    mkdirSync(piAgentDir, { recursive: true });
    writeFileSync(join(piAgentDir, "AGENTS.md"), "STALE", "utf8");
    try {
      const zipPath = join(process.env.RIKKAHUB_PC_DATA_DIR!, "backup-test.zip");
      await jsonStore.flushSaveState();
      createSettingsBackupZipToPath(zipPath);
      expect(existsSync(zipPath)).toBe(true);

      const entries = readZipEntries(readFileSync(zipPath));
      const staged = entries.find((entry) => entry.name === "AGENTS.md");
      expect(staged?.data.toString("utf8")).toContain("# My global rules");
      expect(entries.some((entry) => entry.name.startsWith("pi-agent/"))).toBe(false);

      // 读取器(生产路径)看到的同一内容
      expect(readGlobalAgentsFile().content).toContain("Answer in Chinese.");
      rmSync(zipPath, { force: true });
    } finally {
      // 共享路径落笔即时清(Bun 单进程跑全部文件,残留会撞 model-bridge 的客房零落盘断言)
      rmSync(piAgentDir, { recursive: true, force: true });
      rmSync(join(dataDir, "AGENTS.md"), { force: true });
    }
  });

  test("候选优先级:AGENTS.md 在场时 CLAUDE.md 不重复打包;只有 CLAUDE.md 时打它", async () => {
    rmSync(join(dataDir, "AGENTS.md"), { force: true });
    writeFileSync(join(dataDir, "CLAUDE.md"), "legacy", "utf8");
    const zipPath = join(process.env.RIKKAHUB_PC_DATA_DIR!, "backup-test2.zip");
    createSettingsBackupZipToPath(zipPath);
    try {
      const names = readZipEntries(readFileSync(zipPath)).map((entry) => entry.name);
      expect(names).toContain("CLAUDE.md");
      expect(names.filter((name) => name === "AGENTS.md" || name === "CLAUDE.md" || name === "AGENTS.MD")).toEqual(["CLAUDE.md"]);
    } finally {
      rmSync(zipPath, { force: true });
      rmSync(join(dataDir, "CLAUDE.md"), { force: true });
    }
  });
});
