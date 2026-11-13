// 备份 zip 结构与 Android 互导契约单元测试（5.5 测试补强）。
// - readZipEntries：整个备份导入链的入口解析器（EOCD → central directory → local header），
//   测试用手工构造的最小合法 zip（stored + deflate），不依赖外部 zip 命令。
// - rewriteAvatarsInSettings：PC↔Android settings 互转的冻结契约
//   （avatar FQN 映射、PC-only 字段 strip、role/reasoningLevel 大小写、空 UUID 填充），
//   方向不对称性是历史事故的修复成果，必须锁死。
import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";

import { readZipEntries } from "../files/index";
import {
  ANDROID_AVATAR_TYPE_TO_PC,
  PC_AVATAR_TYPE_TO_ANDROID,
  rewriteAvatarsInSettings,
  wrapToolOutputEntriesForAndroid,
} from "./export";

// ── 最小 zip 构造器（仅测试用）─────────────────────────────────────────────
// readZipEntries 不校验 CRC/时间戳，只读结构字段，所以 CRC 填 0 即可。

interface TestZipEntry {
  name: string;
  data: Buffer;
  deflate?: boolean;
  /** 构造损坏的 local header 签名，验证解析器的跳过容错 */
  corruptLocalSignature?: boolean;
}

function buildTestZip(entries: TestZipEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const compressed = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const compression = entry.deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(entry.corruptLocalSignature ? 0xdeadbeef : 0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(compression, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localChunks.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(compression, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42); // local header offset
    centralChunks.push(central, nameBuf);

    offset += 30 + nameBuf.length + compressed.length;
  }
  const centralDir = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16); // central directory offset
  return Buffer.concat([...localChunks, centralDir, eocd]);
}

describe("readZipEntries", () => {
  test("解析 stored 与 deflate 两种压缩方式的成员", () => {
    const zip = buildTestZip([
      { name: "settings.json", data: Buffer.from('{"a":1}') },
      { name: "upload/file.bin", data: Buffer.from("binary-content-here"), deflate: true },
    ]);
    const entries = readZipEntries(zip);
    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe("settings.json");
    expect(entries[0].data.toString()).toBe('{"a":1}');
    expect(entries[1].name).toBe("upload/file.bin");
    expect(entries[1].data.toString()).toBe("binary-content-here");
  });

  test("目录成员（以 / 结尾）被跳过", () => {
    const zip = buildTestZip([
      { name: "upload/", data: Buffer.alloc(0) },
      { name: "upload/a.txt", data: Buffer.from("x") },
    ]);
    const entries = readZipEntries(zip);
    expect(entries.map((entry) => entry.name)).toEqual(["upload/a.txt"]);
  });

  test("缺 EOCD 的 buffer 返回空数组而不抛错", () => {
    expect(readZipEntries(Buffer.from("definitely not a zip"))).toEqual([]);
    expect(readZipEntries(Buffer.alloc(0))).toEqual([]);
  });

  test("local header 签名损坏的成员被跳过，其余正常解析", () => {
    const zip = buildTestZip([
      { name: "bad.txt", data: Buffer.from("bad"), corruptLocalSignature: true },
      { name: "good.txt", data: Buffer.from("good") },
    ]);
    const entries = readZipEntries(zip);
    expect(entries.map((entry) => entry.name)).toEqual(["good.txt"]);
  });
});

describe("wrapToolOutputEntriesForAndroid(安卓对齐批6,审查A P0)", () => {
  test("{error}/{pending} 无判别符载荷包成 text part,标准 part 与原始值不动", () => {
    const out = wrapToolOutputEntriesForAndroid([
      { error: "boom" },
      { pending: true, questions: [] },
      { type: "text", text: "ok" },
      { type: "image", url: "/api/files/1/content" },
      "raw-string",
      null,
    ]) as any[];
    expect(out[0]).toEqual({ type: "text", text: JSON.stringify({ error: "boom" }) });
    expect(out[1]).toEqual({ type: "text", text: JSON.stringify({ pending: true, questions: [] }) });
    expect(out[2]).toEqual({ type: "text", text: "ok" });
    expect(out[3]).toEqual({ type: "image", url: "/api/files/1/content" });
    expect(out[4]).toBe("raw-string");
    expect(out[5]).toBeNull();
  });
});

describe("avatar 类型映射表", () => {
  test("PC→Android 与 Android→PC 互为反向（url 与 image 共享 Android Image）", () => {
    expect(PC_AVATAR_TYPE_TO_ANDROID.emoji).toBe("me.rerere.rikkahub.data.model.Avatar.Emoji");
    // image 与 url 都映射到 Android Image；反向表由 Object.fromEntries 生成，
    // 后出现的 url 覆盖 image，所以 Android Image 导入回 PC 统一落为 url 类型。
    expect(ANDROID_AVATAR_TYPE_TO_PC["me.rerere.rikkahub.data.model.Avatar.Image"]).toBe("url");
  });
});

describe("rewriteAvatarsInSettings（to-android 导出方向）", () => {
  const pcSettings = {
    chatModelId: "",
    proxyConfig: { host: "127.0.0.1" },
    preferredPort: 8080,
    shellPath: "D:\\SoftWare\\Git\\bin\\bash.exe",
    devPiPluginPaths: ["D:\\plugins\\rpiv-todo"],
    assistants: [
      {
        id: "a1",
        avatar: { type: "emoji", value: "🤖" },
        reasoningLevel: "AUTO",
        presetMessages: [{ role: "USER", content: "hi" }],
        mcpToolOverrides: { x: true },
        allowConversationSystemPrompt: true,
      },
    ],
    modeInjections: [{ role: "USER", content: "inject" }],
    displaySetting: { userAvatar: { type: "url", value: "http://x" }, chatFontFamilyCss: "mono", theme: "dark" },
  };

  test("avatar FQN 映射 + 大小写转换 + strip PC-only 字段 + 空 UUID 填充", () => {
    const out = rewriteAvatarsInSettings(pcSettings, PC_AVATAR_TYPE_TO_ANDROID, "to-android");
    const assistant = out.assistants[0];
    expect(assistant.avatar.type).toBe("me.rerere.rikkahub.data.model.Avatar.Emoji");
    expect(assistant.reasoningLevel).toBe("auto");
    expect(assistant.presetMessages[0].role).toBe("user");
    expect(assistant.mcpToolOverrides).toBeUndefined();
    // 安卓对齐批6:allowConversationSystemPrompt 已是安卓正式字段(Assistant.kt),必须存活——
    // 此前误 strip 导致 PC→APP 后所有助手的会话级系统提示词开关归 false。
    expect(assistant.allowConversationSystemPrompt).toBe(true);
    expect(out.modeInjections[0].role).toBe("user");
    expect(out.displaySetting.userAvatar.type).toBe("me.rerere.rikkahub.data.model.Avatar.Image");
    expect(out.displaySetting.chatFontFamilyCss).toBeUndefined();
    expect(out.displaySetting.theme).toBe("dark");
    expect(out.proxyConfig).toBeUndefined();
    expect(out.preferredPort).toBeUndefined();
    // 机器级 bash 绝对路径随导出剥离(目标机走自动探测,不锁死)
    expect(out.shellPath).toBeUndefined();
    // 工作区引擎插件的本机路径同理剥离(APP 无工作区引擎)
    expect(out.devPiPluginPaths).toBeUndefined();
    // Android Uuid 反序列化拒空串 → 填随机 UUID
    expect(out.chatModelId).toMatch(/^[0-9a-f-]{36}$/);
    // 原对象不被就地修改
    expect(pcSettings.assistants[0].reasoningLevel).toBe("AUTO");
    expect(pcSettings.chatModelId).toBe("");
  });
});

describe("rewriteAvatarsInSettings（to-pc 导入方向）", () => {
  test("只映射 avatar，不 strip、不填 UUID、不动 role（否则导入会清空 PC 配置）", () => {
    const androidSettings = {
      chatModelId: "",
      assistants: [
        {
          id: "a1",
          avatar: { type: "me.rerere.rikkahub.data.model.Avatar.Emoji", value: "🤖" },
          reasoningLevel: "auto",
          mcpToolOverrides: { x: true }, // PC 端残留字段必须原样保留
        },
      ],
      proxyConfig: { host: "127.0.0.1" },
    };
    const out = rewriteAvatarsInSettings(androidSettings, ANDROID_AVATAR_TYPE_TO_PC, "to-pc");
    expect(out.assistants[0].avatar.type).toBe("emoji");
    expect(out.assistants[0].mcpToolOverrides).toEqual({ x: true });
    expect(out.proxyConfig).toEqual({ host: "127.0.0.1" });
    expect(out.chatModelId).toBe(""); // 不填随机 UUID
  });

  test("非对象输入原样返回", () => {
    expect(rewriteAvatarsInSettings(null, PC_AVATAR_TYPE_TO_ANDROID)).toBeNull();
    expect(rewriteAvatarsInSettings("junk", PC_AVATAR_TYPE_TO_ANDROID)).toBe("junk");
  });
});
