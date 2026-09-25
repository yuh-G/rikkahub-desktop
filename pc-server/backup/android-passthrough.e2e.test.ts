// 产品决策②回归:安卓独有 settings 字段经 "APP→PC 导入→PC 使用→PC 导出" 全链路原样透传。
// 依据:导入合并以 ...app 为基底(import.ts 七层策略第 1 条),PC 全部写路径为展开合并,
// normalizeState/导出清洗同为展开——本测试把这条契约锁死,防未来某处改成逐字段重建时静默丢字段。
// APP 端导入 PC 备份是全量替换语义,PC 若不携带这些字段,用户"手机→PC→手机"一轮后设置归零。
import { waitForServerReady } from "../test-utils/e2e-server";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readZipEntries } from "../files/index";

const serverEntry = join(import.meta.dir, "..", "server.ts");

// ── 合法 zip 构造器(带真 CRC32;PowerShell/unzip 解压前校验,zip-structure 的 CRC=0 版不够)──
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildStoredZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localChunks.push(local, nameBuf, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, nameBuf);
    offset += 30 + nameBuf.length + entry.data.length;
  }
  const centralDir = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localChunks, centralDir, eocd]);
}

describe("安卓独有字段透传(产品决策②)", () => {
  test("APP zip 导入 → /settings 可见 → PC 导出 zip 的 settings.json 原样携带", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rkh-passthrough-e2e-"));
    const proc = Bun.spawn(["bun", serverEntry, "--port", "18260", "--no-open"], {
      env: { ...process.env, RIKKAHUB_PC_DATA_DIR: dataDir, RIKKAHUB_ANALYTICS: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const port = await waitForServerReady(proc);
      const base = `http://127.0.0.1:${port}`;

      // 安卓 settings.json:PC 类型系统不认识的顶层字段 + 助手内字段
      const androidSettings = {
        fastModelId: "android-fast-model-uuid",
        // APP 原生开关(手机端关掉了聊天建议):PC 未定制(出厂默认 true)→ 合并采纳 APP 值。
        // titleGenerationEnabled 是 PC 先行字段,APP 备份没有 → 必须保 PC(默认 true)。
        enableSuggestion: false,
        backupReminderConfig: { enabled: true, intervalDays: 7 },
        customThemes: [{ id: "t1", name: "AMOLED", seed: "#000000" }],
        assistants: [{
          id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          name: "手机端助手",
          androidOnlyPerAssistantFlag: "keep-me",
        }],
        displaySetting: { showDateTimeInMessage: true },
      };
      const zip = buildStoredZip([
        { name: "settings.json", data: Buffer.from(JSON.stringify(androidSettings), "utf8") },
      ]);

      const importRes = await fetch(`${base}/api/data/import`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Filename": "backup_android.zip" },
        body: new Uint8Array(zip),
      });
      expect(importRes.status).toBe(200);

      // 导入后 PC 运行时 settings 里字段在场(saveState 写回的就是它)
      const settings = await (await fetch(`${base}/api/settings`)).json() as Record<string, unknown>;
      expect(settings.fastModelId).toBe("android-fast-model-uuid");
      expect(settings.enableSuggestion).toBe(false); // APP 关闭态按标量语义采纳
      expect(settings.titleGenerationEnabled).toBe(true); // APP 无此键 → 保 PC 默认
      expect((settings.backupReminderConfig as Record<string, unknown>).intervalDays).toBe(7);
      expect(Array.isArray(settings.customThemes) && (settings.customThemes as unknown[]).length).toBe(1);
      const importedAssistant = (settings.assistants as Array<Record<string, unknown>>)
        .find((a) => a.id === "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      expect(importedAssistant?.androidOnlyPerAssistantFlag).toBe("keep-me");
      expect((settings.displaySetting as Record<string, unknown>).showDateTimeInMessage).toBe(true);

      // PC 导出 zip → settings.json 原样携带(APP 全量替换导入时不归零)
      const exportRes = await fetch(`${base}/api/data/export`);
      expect(exportRes.status).toBe(200);
      const zipBuf = Buffer.from(await exportRes.arrayBuffer());
      const entry = readZipEntries(zipBuf).find((e) => e.name === "settings.json");
      expect(entry).toBeDefined();
      const exported = JSON.parse(entry!.data.toString("utf8")) as Record<string, unknown>;
      expect(exported.fastModelId).toBe("android-fast-model-uuid");
      // 关闭态随导出回带(APP 全量替换导入后建议仍是关的);PC 先行键原样携带,APP 安全忽略。
      expect(exported.enableSuggestion).toBe(false);
      expect(exported.titleGenerationEnabled).toBe(true);
      expect((exported.backupReminderConfig as Record<string, unknown>).intervalDays).toBe(7);
      expect(Array.isArray(exported.customThemes) && (exported.customThemes as unknown[]).length).toBe(1);
      const exportedAssistant = (exported.assistants as Array<Record<string, unknown>>)
        .find((a) => a.id === "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      expect(exportedAssistant?.androidOnlyPerAssistantFlag).toBe("keep-me");
    } finally {
      proc.kill();
      await proc.exited;
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
