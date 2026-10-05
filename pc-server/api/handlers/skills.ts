// api/handlers/skills.ts — 技能路由（skills 列表/详情/文件/导入）
// 纪律：纯搬迁自 server.ts routeApi()。

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { state } from "../../persistence/json-store";
import { defaultSkillContent, listSkillFiles, listSkillsWithDiagnostics, parseSkillFrontmatter, readSkillContent, safeSkillDir, skillMetadataFromFile } from "../../tools/skills";
import { error, json, readJson } from "../request";
import { updateSettings } from "../../app-config";
import { importSkillFromBuffer, importSkillFromGitHub } from "../../tools/skills-import";

export async function handleSkillRoutes(request: Request, _url: URL, path: string): Promise<Response | null> {
  // P4:列表带诊断(available=false 的技能 pi 拒加载,前端内联警告;字段只增不减,
  // 旧消费方向后兼容)。
  if (path === "skills" && request.method === "GET") return json(listSkillsWithDiagnostics());
  const skillFiles = path.match(/^skills\/([^/]+)\/files$/);
  if (skillFiles && request.method === "GET") {
    const name = decodeURIComponent(skillFiles[1]);
    const metadata = skillMetadataFromFile(name);
    if (!metadata) return error("Skill not found", 404);
    return json({ files: listSkillFiles(name) });
  }
  const skillDetail = path.match(/^skills\/([^/]+)$/);
  if (skillDetail && request.method === "GET") {
    const name = decodeURIComponent(skillDetail[1]);
    const metadata = skillMetadataFromFile(name);
    const content = readSkillContent(name);
    if (!metadata || content == null) return error("Skill not found", 404);
    return json({ ...metadata, content });
  }
  if (path === "skills/detail" && request.method === "POST") {
    const body = await readJson<{ name?: string; content?: string }>(request);
    const requestedName = String(body.name ?? parseSkillFrontmatter(body.content ?? "").name ?? "new-skill").trim();
    const dir = safeSkillDir(requestedName);
    if (!dir) return error("Invalid skill name", 400);
    mkdirSync(dir, { recursive: true });
    const content = String(body.content ?? defaultSkillContent(requestedName));
    // 原子写(对齐 APP 9f02586d):先写同目录临时文件再 rename 覆盖——写到一半失败
    // 时原文件完好,不会出现半截 SKILL.md 让技能既在列表又加载失败。
    const target = join(dir, "SKILL.md");
    const temp = join(dir, ".SKILL.md.tmp");
    writeFileSync(temp, content);
    renameSync(temp, target);
    const metadata = skillMetadataFromFile(requestedName);
    if (!metadata) return error("Skill frontmatter must include name and description", 400);
    return json({ status: "ok", skill: { ...metadata, content } });
  }
  if (path === "skills/import-github" && request.method === "POST") {
    const body = await readJson<{ repoUrl?: string }>(request);
    try {
      const skill = await importSkillFromGitHub(String(body.repoUrl ?? ""));
      return json({ status: "ok", skill });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "skills/import-file" && request.method === "POST") {
    // 对齐安卓 commit af9b1f35：支持从本地文件导入单个 Markdown 或 ZIP 技能包。
    // 前端用 multipart/form-data 把文件 POST 上来；这里取出二进制内容后委派给
    // importSkillFromBuffer 处理。
    try {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return error("Missing file", 400);
      const buf = Buffer.from(await file.arrayBuffer());
      const imported = importSkillFromBuffer(file.name || "", buf);
      const skills = imported.map((name) => {
        const metadata = skillMetadataFromFile(name);
        const content = readSkillContent(name) ?? "";
        return metadata ? { ...metadata, content } : { name, description: "", content };
      });
      return json({ status: "ok", imported, skills });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 400);
    }
  }
  if (skillDetail && request.method === "DELETE") {
    const name = decodeURIComponent(skillDetail[1]);
    const dir = safeSkillDir(name);
    if (!dir || !existsSync(dir)) return error("Skill not found", 404);
    rmSync(dir, { recursive: true, force: true });
    updateSettings({
      ...state.settings,
      assistants: state.settings.assistants.map((assistant) => ({
        ...assistant,
        enabledSkills: assistant.enabledSkills.filter((skillName) => skillName !== name),
      })),
    });
    return json({ status: "deleted" });
  }
  return null;
}
