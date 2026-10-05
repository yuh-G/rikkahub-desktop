// tools/skills.ts — Skill 目录读写辅助
// 纪律：只依赖 foundation 路径与 fs，不读写 state。

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isRecord } from "../foundation/utils";
import { skillsDir } from "../foundation/paths";
import type { SkillMetadata } from "../foundation/types";

export function safeSkillDir(skillName: string) {
  const name = skillName.trim();
  if (!name || name === "." || name === ".." || /[\\/]/.test(name)) return null;
  const root = resolve(skillsDir);
  const target = resolve(root, name);
  if (dirname(target) !== root) return null;
  return target;
}

export function safeSkillFile(skillName: string, relativePath: string) {
  if (!relativePath.trim()) return null;
  const dir = safeSkillDir(skillName);
  if (!dir) return null;
  const root = resolve(dir);
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) return null;
  return target;
}

export function parseSkillFrontmatter(content: string) {
  const result: Record<string, string> = {};
  if (!content.startsWith("---")) return result;
  const match = content.slice(3).match(/\r?\n---(?:\r?\n|$)/);
  if (!match || match.index === undefined) return result;
  const yaml = content.slice(3, 3 + match.index).trim();
  for (const line of yaml.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^"|"$/g, "");
    if (key && value) result[key] = value;
  }
  return result;
}

function extractSkillBody(content: string) {
  if (!content.startsWith("---")) return content;
  const match = content.slice(3).match(/\r?\n---(?:\r?\n|$)/);
  if (!match || match.index === undefined) return content;
  return content.slice(3 + match.index + match[0].length).replace(/^[\r\n]+/, "");
}

export function skillMetadataFromFile(skillName: string): SkillMetadata | null {
  const file = safeSkillFile(skillName, "SKILL.md");
  if (!file || !existsSync(file)) return null;
  const content = readFileSync(file, "utf8");
  const frontmatter = parseSkillFrontmatter(content);
  // P4 对齐 pi(skills.ts loadSkillFromFile):name 缺省回退目录名——否则 pi 能加载的
  // 技能在我们列表里不可见,enabledSkills 白名单永远勾不上;description 缺失与 pi
  // 同为硬性不加载(诊断面见 listSkillsWithDiagnostics)。
  const name = frontmatter.name?.trim() || skillName;
  const description = frontmatter.description?.trim();
  if (!description) return null;
  return {
    name,
    description,
    compatibility: frontmatter.compatibility,
    allowedTools: frontmatter["allowed-tools"]?.split(/\s+/).filter(Boolean) ?? [],
  };
}

// ---- 规范化校验(P4,方案 §3.1:技能编辑器校验提示 + 设置页内联诊断) ----

export interface SkillValidationIssue {
  /** error = pi 拒绝加载(技能完全不生效);warning = pi 加载但告警。 */
  level: "error" | "warning";
  message: string;
}

const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

/** 校验规则与消息文案逐字镜像 pi(coding-agent/src/core/skills.ts validateName/
 *  validateDescription;契约测试对照 pi loadSkillsFromDir 的 diagnostics 钉住,pi 升级
 *  改规则会被测试抓住)。末条"目录名不一致"是我们自己的补充(聊天引擎 use_skill 按
 *  目录名定位,错位则技能查无此人),不镜像 pi。 */
export function validateSkillMetadata(
  dirName: string,
  frontmatter: Record<string, string>,
): SkillValidationIssue[] {
  const issues: SkillValidationIssue[] = [];
  const description = frontmatter.description?.trim();
  if (!description) {
    issues.push({ level: "error", message: "description is required" });
  } else if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    issues.push({
      level: "warning",
      message: `description exceeds ${MAX_SKILL_DESCRIPTION_LENGTH} characters (${description.length})`,
    });
  }
  const name = frontmatter.name?.trim() || dirName;
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    issues.push({ level: "warning", message: `name exceeds ${MAX_SKILL_NAME_LENGTH} characters (${name.length})` });
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    issues.push({ level: "warning", message: "name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)" });
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    issues.push({ level: "warning", message: "name must not start or end with a hyphen" });
  }
  if (name.includes("--")) {
    issues.push({ level: "warning", message: "name must not contain consecutive hyphens" });
  }
  if (frontmatter.name?.trim() && frontmatter.name.trim() !== dirName) {
    issues.push({
      level: "warning",
      message: `name "${frontmatter.name.trim()}" does not match its folder "${dirName}" (skill lookup uses the folder name in chat sessions)`,
    });
  }
  return issues;
}

export interface SkillWithDiagnostics extends SkillMetadata {
  /** false = pi 拒绝加载(description 缺失),列表可见但不会生效。 */
  available: boolean;
  issues: SkillValidationIssue[];
}

/** 设置页专用:含"不可用技能"(description 缺失,listSkills 语义排除的)与逐项诊断。
 *  聊天/pi 引擎的挂载面继续走 listSkills(可用技能),两个消费者两个函数。 */
export function listSkillsWithDiagnostics(): SkillWithDiagnostics[] {
  mkdirSync(skillsDir, { recursive: true });
  const result: SkillWithDiagnostics[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = safeSkillFile(entry.name, "SKILL.md");
    if (!file || !existsSync(file)) continue;
    const frontmatter = parseSkillFrontmatter(readFileSync(file, "utf8"));
    const issues = validateSkillMetadata(entry.name, frontmatter);
    const metadata = skillMetadataFromFile(entry.name);
    result.push(
      metadata
        ? { ...metadata, available: true, issues }
        : {
          name: frontmatter.name?.trim() || entry.name,
          description: frontmatter.description?.trim() ?? "",
          compatibility: frontmatter.compatibility,
          allowedTools: frontmatter["allowed-tools"]?.split(/\s+/).filter(Boolean) ?? [],
          available: false,
          issues,
        },
    );
  }
  return result;
}

export function listSkills(): SkillMetadata[] {
  mkdirSync(skillsDir, { recursive: true });
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => skillMetadataFromFile(entry.name))
    .filter(Boolean) as SkillMetadata[];
}

export function readSkillBody(skillName: string) {
  const file = safeSkillFile(skillName, "SKILL.md");
  if (!file || !existsSync(file)) return null;
  return extractSkillBody(readFileSync(file, "utf8"));
}

export function readSkillContent(skillName: string) {
  const file = safeSkillFile(skillName, "SKILL.md");
  if (!file || !existsSync(file)) return null;
  return readFileSync(file, "utf8");
}

export function listSkillFiles(skillName: string) {
  const dir = safeSkillDir(skillName);
  if (!dir || !existsSync(dir)) return [];
  const root = resolve(dir);
  const result: Array<{ path: string; size: number; type: "file" | "directory" }> = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      const relativePath = resolve(full).slice(root.length + 1).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        result.push({ path: relativePath, size: 0, type: "directory" });
        visit(full);
      } else {
        result.push({ path: relativePath, size: statSync(full).size, type: "file" });
      }
    }
  };
  visit(root);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

export function exportSkills() {
  return listSkills().map((skill) => ({ ...skill, content: readSkillContent(skill.name) ?? "" }));
}

export function importSkills(skills: unknown) {
  if (!Array.isArray(skills)) return;
  for (const item of skills) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = String(record.name ?? "").trim();
    const dir = safeSkillDir(name);
    if (!dir) continue;
    mkdirSync(dir, { recursive: true });
    const files = Array.isArray(record.files) ? record.files : [];
    if (files.length > 0) {
      for (const file of files) {
        if (!isRecord(file)) continue;
        const relativePath = String(file.path ?? "").replace(/\\/g, "/");
        if (!relativePath || relativePath.includes("..") || relativePath.startsWith("/")) continue;
        const target = resolve(dir, relativePath);
        // 批次二 R1-3 同模式:前缀校验必须带分隔符。128 行拦住了 ".." 与 "/" 开头,但
        // Windows 盘符绝对路径(如 "C:/.../<dir>X/...")能通过 resolve 落到同前缀兄弟
        // 目录,裸 startsWith 放行。
        const base = resolve(dir);
        if (!target.startsWith(`${base}\\`) && !target.startsWith(`${base}/`)) continue;
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, String(file.content ?? ""));
      }
      continue;
    }
    const content = String(record.content ?? "");
    if (content) writeFileSync(join(dir, "SKILL.md"), content);
  }
}

export function defaultSkillContent(name = "new-skill") {
  return `---\nname: ${name}\ndescription: Describe when this skill should be used\n---\n\nWrite the skill instructions here.\n`;
}

/**
 * 复制技能为整棵目录树(用户已拍板:随附脚本/资料可能是技能工作的一部分,只复制
 * SKILL.md 会产出残废副本)。SKILL.md 的 frontmatter name 同步改成新目录名——
 * 目录名与 name 不一致时聊天引擎按目录名定位会查无此人(validateSkillMetadata
 * 的同名告警)。返回新名;源不存在/目标已存在/新名非法返回 null。
 */
export function copySkillTree(sourceName: string, targetName: string): string | null {
  const source = safeSkillDir(sourceName);
  const target = safeSkillDir(targetName);
  if (!source || !target || !existsSync(source) || existsSync(target)) return null;
  // 新名必须落在 pi 命名规则内(小写字母/数字/连字符,禁首尾连字符与连续连字符)——
  // 复制出一个自带告警的技能不是用户要的。
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(targetName) || targetName.length > 64) return null;
  cpSync(source, target, { recursive: true, filter: (src) => !basename(src).startsWith(".") });
  const skillMd = join(target, "SKILL.md");
  const content = existsSync(skillMd) ? readFileSync(skillMd, "utf8") : null;
  if (content != null && content.startsWith("---")) {
    const match = content.slice(3).match(/\r?\n---(?:\r?\n|$)/);
    if (match && match.index !== undefined) {
      const head = content.slice(0, 3 + match.index).replace(/^(\s*name:\s*).*$/m, `$1${targetName}`);
      writeFileSync(skillMd, head + content.slice(3 + match.index));
    }
  }
  return targetName;
}
