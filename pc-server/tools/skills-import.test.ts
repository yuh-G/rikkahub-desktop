// tools/skills-import.test.ts — 技能导入健壮性行为锁(对齐 APP 9f02586d)
// 核心钉住:①GitHub 按字节下载保存——zip 里的二进制附属文件(PNG 等)字节级往返,
// 不被 UTF-8 文本解码损坏;②原子落盘——写失败/非法路径不损坏既有技能目录;
// ③GitHub API 限流(403/429 + X-RateLimit-Remaining: 0)给明确人话错误。
// zip 构造器与 backup/zip-structure.test.ts 同构(stored 条目即够用,无压缩路径)。
import { afterAll, describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-skills-import-"));

const { skillsDir } = await import("../foundation/paths");
const { importSkillFromBuffer, githubJson } = await import("./skills-import");

afterAll(() => {
  rmSync(process.env.RIKKAHUB_PC_DATA_DIR!, { recursive: true, force: true });
});

function buildTestZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localChunks.push(local, nameBuf, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, nameBuf);
    offset += 30 + nameBuf.length + compressed.length;
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

/** PNG 魔数 + 一段必然含非法 UTF-8 序列的字节:任何"先 toString('utf8') 再存"的
 *  实现都会把它变成长度不同的替换串,字节比对立刻露馅。 */
function hostileBinary(bytes = 4096): Buffer {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 1) buf[i] = (i * 7 + 13) % 256; // 全字节域覆盖
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).copy(buf, 0);
  return buf;
}

describe("zip 导入按字节保存(二进制不损坏)", () => {
  test("含二进制附属文件的技能:字节级往返无损", () => {
    const binary = hostileBinary();
    const zip = buildTestZip([
      { name: "my-skill/SKILL.md", data: Buffer.from("---\nname: my-skill\ndescription: binary-safe skill\n---\n\nbody\n", "utf8") },
      { name: "my-skill/assets/logo.png", data: binary },
    ]);
    const imported = importSkillFromBuffer("pack.zip", zip);
    expect(imported).toEqual(["my-skill"]);
    expect(readFileSync(join(skillsDir, "my-skill", "assets", "logo.png")).equals(binary)).toBe(true);
  });

  test("zip 里 SKILL.md 大写变体(Skill.md)也能识别并规范化", () => {
    const zip = buildTestZip([
      { name: "cased/Skill.md", data: Buffer.from("---\nname: cased\ndescription: cased skill\n---\n", "utf8") },
    ]);
    expect(importSkillFromBuffer("p.zip", zip)).toEqual(["cased"]);
    expect(existsSync(join(skillsDir, "cased", "SKILL.md"))).toBe(true);
  });

  test("多技能 zip:各进各目录,嵌套技能文件不重复落", () => {
    const zip = buildTestZip([
      { name: "a/SKILL.md", data: Buffer.from("---\nname: a\ndescription: A\n---\n", "utf8") },
      { name: "a/nested/SKILL.md", data: Buffer.from("---\nname: nested\ndescription: N\n---\n", "utf8") },
    ]);
    const imported = importSkillFromBuffer("multi.zip", zip);
    expect(imported.sort()).toEqual(["a", "nested"]);
  });

  test("缺 name 的 SKILL.md → 明确报错,不落半截目录", () => {
    const zip = buildTestZip([
      { name: "bad/SKILL.md", data: Buffer.from("---\ndescription: no name\n---\n", "utf8") },
    ]);
    expect(() => importSkillFromBuffer("bad.zip", zip)).toThrow(/缺少 name/);
    expect(existsSync(join(skillsDir, "bad"))).toBe(false);
    // 失败不留 staging 残留
    expect(readdirSync(skillsDir).filter((n) => n.includes("staging"))).toEqual([]);
  });

  test("单个 markdown 文件导入(非 zip)", () => {
    const md = "---\nname: single-md\ndescription: single\n---\n\nhello\n";
    const imported = importSkillFromBuffer("note.md", Buffer.from(md, "utf8"));
    expect(imported).toEqual(["single-md"]);
    expect(readFileSync(join(skillsDir, "single-md", "SKILL.md"), "utf8")).toBe(md);
  });
});

describe("原子落盘:写失败不损坏既有技能", () => {
  test("重导入同名技能走 staging/backup/rename 序列,无中间态残留", () => {
    const v1 = buildTestZip([
      { name: "atomic/SKILL.md", data: Buffer.from("---\nname: atomic\ndescription: v1\n---\n", "utf8") },
    ]);
    const v2 = buildTestZip([
      { name: "atomic/SKILL.md", data: Buffer.from("---\nname: atomic\ndescription: v2\n---\n", "utf8") },
      { name: "atomic/extra.bin", data: hostileBinary(256) },
    ]);
    importSkillFromBuffer("a.zip", v1);
    importSkillFromBuffer("a2.zip", v2);
    expect(readFileSync(join(skillsDir, "atomic", "SKILL.md"), "utf8")).toContain("v2");
    // 序列跑完无 staging/backup 残留目录
    expect(readdirSync(skillsDir).filter((n) => n.startsWith("."))).toEqual([]);
  });
});

describe("GitHub API 限流人话提示", () => {
  // githubJson 走 globalThis.fetch,测试进程内替换再还原。
  const originalFetch = globalThis.fetch;
  afterAll(() => { globalThis.fetch = originalFetch; });

  test("403 + X-RateLimit-Remaining: 0 → 明确的限流文案", async () => {
    globalThis.fetch = (async () => new Response("rate limited", {
      status: 403,
      headers: { "X-RateLimit-Remaining": "0" },
    })) as unknown as typeof fetch;
    await expect(githubJson("https://api.github.com/contents/x")).rejects.toThrow(/上限/);
  });

  test("普通 404 仍是常规错误格式", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    await expect(githubJson("https://api.github.com/contents/x")).rejects.toThrow(/404/);
  });
});
