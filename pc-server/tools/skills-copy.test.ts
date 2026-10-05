// tools/skills-copy.test.ts — copySkillTree 行为锁(复制技能=整棵目录树 + frontmatter name 同步改新名)。
// 用户拍板的两条纪律:①skill 复制是整树复制(SKILL.md 之外随附脚本/资料一并带走);
// ②新名必须落在 pi 命名规则内,复制出自带告警的技能不是用户要的。
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-skillcopy-test-"));

const { skillsDir } = await import("../foundation/paths");
const { copySkillTree } = await import("./skills");

function makeSkillTree(name: string, skillMd: string, extras: Array<[string, string]> = []): void {
  mkdirSync(join(skillsDir, name), { recursive: true });
  writeFileSync(join(skillsDir, name, "SKILL.md"), skillMd, "utf-8");
  for (const [relativePath, content] of extras) {
    const target = join(skillsDir, name, relativePath);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content, "utf-8");
  }
}

describe("copySkillTree(整树复制)", () => {
  test("复制 SKILL.md + 随附脚本/资料,frontmatter name 改新名,正文不动", () => {
    makeSkillTree(
      "demo-skill",
      "---\nname: demo-skill\ndescription: demo\n---\n\n正文保持原样。\n",
      [
        ["scripts/run.py", "print('hi')"],
        ["assets/data/nested.txt", "nested"],
        [".hidden-junk.tmp", "should not copy"],
      ],
    );
    const result = copySkillTree("demo-skill", "demo-skill-1");
    expect(result).toBe("demo-skill-1");
    expect(readFileSync(join(skillsDir, "demo-skill-1", "SKILL.md"), "utf8"))
      .toBe("---\nname: demo-skill-1\ndescription: demo\n---\n\n正文保持原样。\n");
    expect(readFileSync(join(skillsDir, "demo-skill-1", "scripts", "run.py"), "utf8")).toBe("print('hi')");
    expect(readFileSync(join(skillsDir, "demo-skill-1", "assets", "data", "nested.txt"), "utf8")).toBe("nested");
    expect(existsSync(join(skillsDir, "demo-skill-1", ".hidden-junk.tmp"))).toBe(false);
    // 源目录不动(复制非移动)。
    expect(readFileSync(join(skillsDir, "demo-skill", "SKILL.md"), "utf8"))
      .toBe("---\nname: demo-skill\ndescription: demo\n---\n\n正文保持原样。\n");
  });

  test("name 带引号时替换仍落在 name: 行上", () => {
    makeSkillTree("quoted", '---\nname: "quoted"\ndescription: d\n---\nbody');
    expect(copySkillTree("quoted", "quoted-1")).toBe("quoted-1");
    const copied = readFileSync(join(skillsDir, "quoted-1", "SKILL.md"), "utf8");
    expect(copied.startsWith("---\nname: quoted-1\n")).toBe(true);
    expect(copied.endsWith("---\nbody")).toBe(true);
  });

  test("拒绝:目标已存在 / 新名违反 pi 命名规则 / 源不存在", () => {
    makeSkillTree("taken", "---\nname: taken\ndescription: d\n---\nb");
    expect(copySkillTree("taken", "taken")).toBeNull(); // 目标=源已存在
    expect(copySkillTree("taken", "Bad_Name")).toBeNull(); // 大写下划线
    expect(copySkillTree("taken", "-lead")).toBeNull(); // 连字符开头
    expect(copySkillTree("taken", "a--b")).toBeNull(); // 连续连字符
    expect(copySkillTree("no-such-skill", "any-name")).toBeNull(); // 源不存在
  });

  test("SKILL.md 无 frontmatter 时整树照复制、内容不动", () => {
    makeSkillTree("plain", "no frontmatter here", [["note.txt", "n"]]);
    expect(copySkillTree("plain", "plain-1")).toBe("plain-1");
    expect(readFileSync(join(skillsDir, "plain-1", "SKILL.md"), "utf8")).toBe("no frontmatter here");
    expect(readFileSync(join(skillsDir, "plain-1", "note.txt"), "utf8")).toBe("n");
  });
});
