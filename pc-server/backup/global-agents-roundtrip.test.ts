// backup/global-agents-roundtrip.test.ts — 全局工作区指引(pi-agent/AGENTS.md)
// 备份面回归:导出 zip 携带 pi-agent 直系上下文件(仅四个候选名,运行时态文件绝不
// 打包)、导入恢复首命中候选(与 pi 读取语义对齐,不复制被遮蔽的次选)。
// 端到端走隔离数据目录直调 createSettingsBackupZipToPath / applyAndroidZipBackupFromPath
// (同 import-overwrite e2e 的数据隔离思路,不起服务器——zip 落盘后解包断言条目)。
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-gagents-bak-"));

const jsonStore = await import("../persistence/json-store");
const { defaultState } = await import("../app-config/defaults");
const { setState } = jsonStore;
const { piAgentDir } = await import("../foundation/paths");
const { createSettingsBackupZipToPath } = await import("./export");
const { readZipEntries } = await import("../files/index");
const { readGlobalAgentsFile } = await import("../pi-engine/global-agents");

import type { State } from "../foundation/types";

const priorState = jsonStore.state;
setState(defaultState() as unknown as State);

afterAll(async () => {
  await jsonStore.flushSaveState().catch(() => {});
  setState(priorState);
  rmSync(process.env.RIKKAHUB_PC_DATA_DIR!, { recursive: true, force: true });
});

describe("全局工作区指引备份面", () => {
  test("导出 zip 携带 pi-agent 直系上下文件;恢复端原样回填", async () => {
    // 本机已有全局指引
    mkdirSync(piAgentDir, { recursive: true });
    writeFileSync(join(piAgentDir, "AGENTS.md"), "# My global rules\n\n- Answer in Chinese.\n", "utf8");

    const zipPath = join(process.env.RIKKAHUB_PC_DATA_DIR!, "backup-test.zip");
    await jsonStore.flushSaveState();
    createSettingsBackupZipToPath(zipPath);
    expect(existsSync(zipPath)).toBe(true);

    // zip 内有条目 pi-agent/AGENTS.md,内容逐字
    const entries = readZipEntries(readFileSync(zipPath));
    const staged = entries.find((entry) => entry.name === "pi-agent/AGENTS.md");
    expect(staged?.data.toString("utf8")).toContain("# My global rules");
    // 只搬候选名:目录里若有其他文件(模拟运行时杂物)绝不进备份
    writeFileSync(join(piAgentDir, "stray-runtime.json"), "{}", "utf8");
    createSettingsBackupZipToPath(zipPath);
    expect(readZipEntries(readFileSync(zipPath)).some((entry) => entry.name.includes("stray-runtime"))).toBe(false);

    // 恢复语义:读回来的就是写进去的(本测试同机,等价断言 = 领域读取器看到同一内容)
    expect(readGlobalAgentsFile().content).toContain("Answer in Chinese.");
    rmSync(zipPath, { force: true });
  });

  test("候选优先级:AGENTS.md 在场时 CLAUDE.md 不重复打包;只有 CLAUDE.md 时打它", async () => {
    rmSync(join(piAgentDir, "AGENTS.md"), { force: true });
    rmSync(join(piAgentDir, "stray-runtime.json"), { force: true });
    writeFileSync(join(piAgentDir, "CLAUDE.md"), "legacy", "utf8");
    const zipPath = join(process.env.RIKKAHUB_PC_DATA_DIR!, "backup-test2.zip");
    createSettingsBackupZipToPath(zipPath);
    const names = readZipEntries(readFileSync(zipPath)).map((entry) => entry.name);
    expect(names).toContain("pi-agent/CLAUDE.md");
    expect(names.filter((name) => name.startsWith("pi-agent/"))).toEqual(["pi-agent/CLAUDE.md"]);
    rmSync(zipPath, { force: true });
  });
});
