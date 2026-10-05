// tools/skills-import.ts — Skill 导入（GitHub 仓库拉取 / zip 或单文件导入，原子落盘 + 路径安全校验）
// 纪律：纯搬迁自 server.ts（阶段 5.3c），行为不变。

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fetchWithTimeout } from "../foundation/net";
import { dirname, join, resolve } from "node:path";
import type { GitHubSkillFile, GitHubSkillInfo } from "../foundation/types";
import { skillsDir } from "../foundation/paths";
import { readZipEntries } from "../files";
import { parseSkillFrontmatter, safeSkillDir, skillMetadataFromFile } from "./skills";

function parseGitHubSkillUrl(repoUrl: string): GitHubSkillInfo | null {
  const trimmed = repoUrl.trim().replace(/\/+$/, "");
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/tree\/([^/]+)(?:\/(.*))?)?$/.exec(trimmed);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/i, ""),
    branch: match[3] || "HEAD",
    path: match[4] || "",
  };
}

/** GitHub Contents API 请求 + 限流/HTTP 错误的人话化。导出供回归测试注入限流响应。 */
export async function githubJson(url: string) {
  const response = await fetchWithTimeout(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "RikkaHub-PC" } });
  // 未登录的 GitHub API 每小时仅 60 次;超限给明确提示而不是笼统的"读取失败"
  // (对齐 APP 9f02586d,响应体同款错误语义)。
  if ((response.status === 403 || response.status === 429) && response.headers.get("X-RateLimit-Remaining") === "0") {
    throw new Error("GitHub API 请求次数已达上限，请稍后再试");
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${text.slice(0, 500) || response.statusText}`);
  return JSON.parse(text);
}

async function collectGitHubSkillFiles(info: GitHubSkillInfo, dirPath: string, basePath: string, result: GitHubSkillFile[]) {
  const apiPath = dirPath ? encodeURI(dirPath).replace(/#/g, "%23") : "";
  const apiUrl = `https://api.github.com/repos/${info.owner}/${info.repo}/contents/${apiPath}?ref=${encodeURIComponent(info.branch)}`;
  const payload = await githubJson(apiUrl);
  const items = Array.isArray(payload) ? payload : [payload];
  for (const item of items) {
    const type = String(item.type ?? "");
    const itemPath = String(item.path ?? "");
    const relativePath = itemPath.replace(new RegExp(`^${basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?`), "");
    if (type === "file") {
      const downloadUrl = String(item.download_url ?? "");
      if (!downloadUrl) throw new Error(`GitHub 文件没有 download_url: ${itemPath}`);
      result.push({ relativePath: relativePath || itemPath.split("/").pop() || itemPath, downloadUrl });
    } else if (type === "dir") {
      await collectGitHubSkillFiles(info, itemPath, basePath, result);
    }
  }
}

export async function importSkillFromGitHub(repoUrl: string) {
  const info = parseGitHubSkillUrl(repoUrl);
  if (!info) throw new Error("无效的 GitHub 仓库链接。支持 https://github.com/owner/repo 或 /tree/branch/sub/path");
  const files: GitHubSkillFile[] = [];
  await collectGitHubSkillFiles(info, info.path, info.path, files);
  const skillFile = files.find((file) => file.relativePath === "SKILL.md");
  if (!skillFile) throw new Error("目录中未找到 SKILL.md");
  const downloaded = new Map<string, Buffer>();
  for (const file of files) {
    const response = await fetchWithTimeout(file.downloadUrl, { headers: { "User-Agent": "RikkaHub-PC" }, timeoutMs: 60_000 });
    if (!response.ok) throw new Error(`下载文件失败 ${file.relativePath}: ${response.status}`);
    downloaded.set(file.relativePath, Buffer.from(await response.arrayBuffer()));
  }
  const skillContent = downloaded.get("SKILL.md")?.toString("utf8") ?? "";
  const frontmatter = parseSkillFrontmatter(skillContent);
  const name = frontmatter.name?.trim();
  if (!name) throw new Error("SKILL.md 格式错误：缺少 name 字段");
  saveSkillFileBytesAtomically(name, downloaded);
  const metadata = skillMetadataFromFile(name);
  if (!metadata) throw new Error("Skill frontmatter must include name and description");
  return { ...metadata, content: skillContent };
}

// 对齐安卓 SkillManager.saveSkillFileBytesAtomically (commit af9b1f35)：
// 1) 在 .{name}.staging.<rand>.tmp 中先写完整目录；2) rename 旧目录到
// .{name}.backup.<rand>.tmp；3) 把 staging 重命名为正式目录；4) 删除 backup。
// 任意一步失败都回滚到原状态。
function saveSkillFileBytesAtomically(skillName: string, files: Map<string, Buffer>) {
  const targetDir = safeSkillDir(skillName);
  if (!targetDir) throw new Error("Skill name 无效");
  mkdirSync(skillsDir, { recursive: true });
  const stagingDir = join(skillsDir, `.${skillName}.staging.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  const backupDir = join(skillsDir, `.${skillName}.backup.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    mkdirSync(stagingDir, { recursive: true });
    const root = resolve(stagingDir);
    for (const [relativePath, content] of files) {
      const target = resolve(root, relativePath);
      if (target !== root && !target.startsWith(root + "\\") && !target.startsWith(root + "/")) {
        throw new Error(`非法文件路径：${relativePath}`);
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    if (!existsSync(join(stagingDir, "SKILL.md"))) {
      throw new Error("缺少 SKILL.md 文件");
    }
    if (existsSync(targetDir)) renameSync(targetDir, backupDir);
    renameSync(stagingDir, targetDir);
    if (existsSync(backupDir)) rmSync(backupDir, { recursive: true, force: true });
  } catch (err) {
    if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
    if (!existsSync(targetDir) && existsSync(backupDir)) renameSync(backupDir, targetDir);
    throw err;
  }
}

// 规范化 ZIP 条目路径：把反斜杠/前导斜杠/`.` 段抹掉，拒绝 `..`。
function normalizeZipEntryPath(path: string): string | null {
  const parts = path.replace(/\\/g, "/").replace(/^\/+/, "").split("/")
    .filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) return null;
  return parts.join("/");
}

function isPathInsideBase(path: string, basePath: string): boolean {
  return basePath.length === 0 || path === basePath || path.startsWith(`${basePath}/`);
}

function relativeToSkillBase(path: string, basePath: string): string | null {
  if (basePath.length === 0) return path;
  if (path === basePath) return null;
  const stripped = path.startsWith(`${basePath}/`) ? path.slice(basePath.length + 1) : path;
  return stripped === path ? null : stripped;
}

function isZipBuffer(fileName: string, buf: Buffer): boolean {
  if (fileName.toLowerCase().endsWith(".zip")) return true;
  if (buf.length < 4) return false;
  const sig = buf.readUInt32LE(0);
  // PK\x03\x04 | PK\x05\x06 | PK\x07\x08
  return sig === 0x04034b50 || sig === 0x06054b50 || sig === 0x08074b50;
}

// 镜像安卓 SkillsVM.importSkillMarkdown / importSkillsFromZip：
//  - 单个 markdown：解析 frontmatter，原子写入；
//  - zip：扫所有 SKILL.md，对每个根目录原子写入一组文件，跳过嵌套技能。
// 返回成功导入的 skill 名称数组。失败抛错。
export function importSkillFromBuffer(fileName: string, buf: Buffer): string[] {
  if (isZipBuffer(fileName, buf)) {
    return importSkillsFromZipBuffer(buf);
  }
  const content = buf.toString("utf8");
  const frontmatter = parseSkillFrontmatter(content);
  const name = frontmatter.name?.trim();
  if (!name) throw new Error("SKILL.md 格式错误：缺少 name 字段");
  if (!frontmatter.description?.trim()) throw new Error("SKILL.md 格式错误：缺少 description 字段");
  saveSkillFileBytesAtomically(name, new Map([["SKILL.md", Buffer.from(content, "utf8")]]));
  return [name];
}

function importSkillsFromZipBuffer(buf: Buffer): string[] {
  // 用现有的 readZipEntries（仅支持 store/deflate，跟安卓 ZipInputStream 覆盖
  // 的基础情况一致）。把条目按规范化路径聚合到 Map 里。
  const rawEntries = readZipEntries(buf);
  if (rawEntries.length === 0) throw new Error("压缩包为空或无法读取");
  const files = new Map<string, Buffer>();
  for (const entry of rawEntries) {
    const path = normalizeZipEntryPath(entry.name);
    if (!path) continue;
    files.set(path, entry.data);
  }

  const skillMdPaths = Array.from(files.keys())
    .filter((path) => path.split("/").pop()?.toLowerCase() === "skill.md")
    .sort();
  if (skillMdPaths.length === 0) throw new Error("压缩包中未找到 SKILL.md");

  const skillBasePaths = skillMdPaths.map((path) => {
    const slash = path.lastIndexOf("/");
    return slash < 0 ? "" : path.slice(0, slash);
  });

  const importedNames: string[] = [];
  for (let i = 0; i < skillMdPaths.length; i += 1) {
    const skillMdPath = skillMdPaths[i];
    const basePath = skillBasePaths[i];
    const skillBuf = files.get(skillMdPath);
    if (!skillBuf) throw new Error(`读取失败：${skillMdPath}`);
    const skillContent = skillBuf.toString("utf8");
    const frontmatter = parseSkillFrontmatter(skillContent);
    const name = frontmatter.name?.trim();
    if (!name) throw new Error(`${skillMdPath} 格式错误：缺少 name 字段`);
    if (!frontmatter.description?.trim()) throw new Error(`${skillMdPath} 格式错误：缺少 description 字段`);

    const skillFiles = new Map<string, Buffer>();
    for (const [path, content] of files) {
      // 跳过嵌套技能内部文件
      const insideNested = skillBasePaths.some((otherBase, otherIndex) => {
        if (otherIndex === i) return false;
        return isPathInsideBase(path, otherBase) && (basePath.length === 0 || isPathInsideBase(otherBase, basePath));
      });
      if (insideNested) continue;
      const relative = relativeToSkillBase(path, basePath);
      if (relative == null) continue;
      const targetPath = relative.toLowerCase() === "skill.md" ? "SKILL.md" : relative;
      skillFiles.set(targetPath, content);
    }

    if (!skillFiles.has("SKILL.md")) {
      // 主入口文件大小写规范化（zip 里可能写成 Skill.md 等）
      skillFiles.set("SKILL.md", Buffer.from(skillContent, "utf8"));
    }
    saveSkillFileBytesAtomically(name, skillFiles);
    if (!importedNames.includes(name)) importedNames.push(name);
  }
  return importedNames;
}
