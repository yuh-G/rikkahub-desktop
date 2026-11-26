// tools/skills-validation.test.ts — P4 技能规范化校验(方案 §3.1)
//
// 契约对照(升级回归门,与 pi-engine/app-tools.test 的工具契约同族):我们的
// validateSkillMetadata 镜像 pi 的 validateName/validateDescription 规则与消息原文,
// 但那两个函数是 pi 模块私有——对照走行为面:同一 fixture 目录喂 pi 的
// loadSkillsFromDir,其 diagnostics 消息必须与我们镜像规则的产出逐字一致。
// pi 升级改校验规则/文案 → 本测试失败 → 提醒同步镜像。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-skillsval-test-"));

const { skillsDir } = await import("../foundation/paths");
const { listSkills, listSkillsWithDiagnostics, parseSkillFrontmatter, skillMetadataFromFile, validateSkillMetadata } = await import("./skills");
const { loadSkillsFromDir } = await import("../../pi/packages/coding-agent/src/core/skills.ts");

function makeSkill(dirName: string, body: string): void {
  mkdirSync(join(skillsDir, dirName), { recursive: true });
  writeFileSync(join(skillsDir, dirName, "SKILL.md"), body, "utf-8");
}

afterAll(() => {
  // 数据目录是本文件独占的 mkdtemp,无需清理(系统临时目录自然回收)。
});

describe("validateSkillMetadata 规则面", () => {
  test("description 缺失是唯一 error;合法技能零告警", () => {
    expect(validateSkillMetadata("good-skill", { name: "good-skill", description: "ok" })).toEqual([]);
    const issues = validateSkillMetadata("no-desc", { name: "no-desc" });
    expect(issues).toEqual([{ level: "error", message: "description is required" }]);
  });

  test("name 规则全是 warning(pi 仍加载):大写/连字符边界/超长/目录名不一致", () => {
    const upper = validateSkillMetadata("Bad_Name", {});
    expect(upper.some((i) => i.message.includes("invalid characters"))).toBe(true);
    expect(upper.every((i) => i.level !== "error" || i.message === "description is required")).toBe(true);

    const hyphen = validateSkillMetadata("x", { name: "-lead", description: "d" });
    expect(hyphen.map((i) => i.message)).toContain("name must not start or end with a hyphen");

    const doubled = validateSkillMetadata("x", { name: "a--b", description: "d" });
    expect(doubled.map((i) => i.message)).toContain("name must not contain consecutive hyphens");

    const long = validateSkillMetadata("x", { name: "a".repeat(70), description: "d" });
    expect(long.map((i) => i.message)).toContain("name exceeds 64 characters (70)");

    const mismatch = validateSkillMetadata("folder-a", { name: "other-name", description: "d" });
    expect(mismatch.some((i) => i.message.includes('does not match its folder "folder-a"'))).toBe(true);
  });
});

describe("pi 契约对照(升级回归门)", () => {
  test("镜像规则与 pi loadSkillsFromDir 的 diagnostics 逐字一致", () => {
    const fixtures = mkdtempSync(join(tmpdir(), "rkh-skillfixture-"));
    const cases: Array<{ dir: string; body: string }> = [
      { dir: "clean-skill", body: "---\nname: clean-skill\ndescription: fine\n---\nbody" },
      { dir: "missing-desc", body: "---\nname: missing-desc\n---\nbody" },
      { dir: "UPPER_case", body: "---\ndescription: fine\n---\nbody" }, // name 回退目录名(违规大写)
      { dir: "long-name", body: `---\nname: ${"a".repeat(70)}\ndescription: fine\n---\nbody` },
      { dir: "hyphen-edge", body: "---\nname: a--b-\ndescription: fine\n---\nbody" },
      { dir: "long-desc", body: `---\nname: long-desc\ndescription: ${"d".repeat(1100)}\n---\nbody` },
    ];
    for (const item of cases) {
      mkdirSync(join(fixtures, item.dir), { recursive: true });
      writeFileSync(join(fixtures, item.dir, "SKILL.md"), item.body, "utf-8");
    }

    const piMessages = loadSkillsFromDir({ dir: fixtures, source: "path" })
      .diagnostics.map((diagnostic) => diagnostic.message)
      .sort();
    const ourMessages = cases
      .flatMap((item) => {
        const frontmatter = parseSkillFrontmatter(item.body);
        return validateSkillMetadata(item.dir, frontmatter)
          .filter((issue) => !issue.message.includes("does not match its folder")) // 我们自有的补充规则,pi 无
          .map((issue) => issue.message);
      })
      .sort();
    expect(ourMessages).toEqual(piMessages);
  });
});

describe("列表面", () => {
  test("name 回退目录名(对齐 pi);description 缺失不进可用列表但进诊断列表", () => {
    makeSkill("fallback-name", "---\ndescription: no explicit name\n---\nbody");
    makeSkill("broken-skill", "---\nname: broken-skill\n---\nbody");

    const available = listSkills();
    expect(available.map((skill) => skill.name)).toContain("fallback-name");
    expect(available.map((skill) => skill.name)).not.toContain("broken-skill");

    const all = listSkillsWithDiagnostics();
    const broken = all.find((skill) => skill.name === "broken-skill");
    expect(broken?.available).toBe(false);
    expect(broken?.issues.some((issue) => issue.level === "error")).toBe(true);
    const fallback = all.find((skill) => skill.name === "fallback-name");
    expect(fallback?.available).toBe(true);

    expect(skillMetadataFromFile("fallback-name")?.name).toBe("fallback-name");
  });
});
