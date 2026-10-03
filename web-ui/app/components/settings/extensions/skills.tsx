// components/settings/extensions/skills.tsx — 拓展 › 技能

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Download, Loader2, Trash2, TriangleAlert, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import api, { appendWebAuthQuery } from "~/services/api";
import { confirmDialog } from "~/stores/confirm-store";
import type { AssistantProfile, Settings } from "~/types";
import { textValue } from "~/components/settings/shared";
import {
  BindingAssistantSelect,
  EditorShell,
  NoAssistantsState,
  pullSettings,
  type SectionProps,
  useBindingAssistant,
} from "~/components/settings/extensions/common";

interface SkillFileInfo {
  path: string;
  size: number;
  type: "file" | "directory";
}

interface SkillProfile {
  name: string;
  description: string;
  compatibility?: string;
  allowedTools?: string[];
  content?: string;
  // P4 规范化诊断(后端 listSkillsWithDiagnostics):available=false 表示引擎拒绝加载
  // (description 缺失);issues 是逐字镜像 pi 校验规则的英文技术文案,原样内联展示。
  available?: boolean;
  issues?: Array<{ level: "error" | "warning"; message: string }>;
}

/** 拓展 › 技能。 */
export function SkillsSection({ settings, onSettings }: SectionProps) {
  const assistant = useBindingAssistant(settings);
  if (!assistant) return <NoAssistantsState />;
  return (
    <SkillsEditor
      settings={settings}
      assistant={assistant}
      onSettings={onSettings}
      bindingSelect={<BindingAssistantSelect settings={settings} assistant={assistant} className="mb-2" />}
    />
  );
}

function SkillsEditor({
  settings,
  assistant,
  onSettings,
  bindingSelect,
}: {
  settings: Settings;
  assistant: AssistantProfile;
  onSettings: (settings: Settings) => void;
  bindingSelect: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [skills, setSkills] = React.useState<SkillProfile[]>([]);
  const [selected, setSelected] = React.useState("");
  const [content, setContent] = React.useState("");
  const [files, setFiles] = React.useState<SkillFileInfo[]>([]);
  const [githubUrl, setGithubUrl] = React.useState("");
  const [importing, setImporting] = React.useState(false);
  const [importingFile, setImportingFile] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  // R8-2:防抖自动保存统一走共享三件套 hook(保存窗口内键击不丢,语义见 hook 文件头)。
  // 域7-1(3A):保存进行中 indicator 由 hook status 机驱动,不再手维护 saving state。
  const autosave = useAutosaveDraft(
    async () => {
      const name = textValue(parseSkillName(content) || selected || "new-skill");
      await api.post("skills/detail", { name, content });
      await load();
      setSelected(name);
    },
    { delayMs: 900, errorLabel: t("settings:subnav.extensions.skills") },
  );

  const load = React.useCallback(async () => {
    const list = await api.get<SkillProfile[]>("skills");
    setSkills(list);
    if (!selected && list[0]) setSelected(list[0].name);
  }, [selected]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const selectedSkill = skills.find((skill) => skill.name === selected);

  React.useEffect(() => {
    if (!selected) return;
    if (!selectedSkill) {
      setFiles([]);
      return;
    }
    api
      .get<SkillProfile>(`skills/${encodeURIComponent(selected)}`)
      .then((skill) => {
        // 编辑中(含保存窗口内的键击)不回填服务端内容:每次 autosave → load() 都会换新
        // selectedSkill 触发本 effect,无守卫会把在飞键击冲掉(R8-2 病根)。
        if (autosave.isDirty()) return;
        setContent(skill.content ?? "");
      })
      .catch(() => setContent(""));
    api
      .get<{ files: SkillFileInfo[] }>(`skills/${encodeURIComponent(selected)}/files`)
      .then((result) => setFiles(result.files))
      .catch(() => setFiles([]));
  }, [selected, selectedSkill]);

  const remove = async () => {
    if (!selected) return;
    if (!(await confirmDialog({ title: t("settings:mcp.delete_skill_confirm"), danger: true }))) return;
    // 防复活:丢弃待保存脏编辑并等在飞保存收尾,DELETE 不与迟到 POST 乱序(复审 F1)
    await autosave.discard();
    await api.delete(`skills/${encodeURIComponent(selected)}`);
    setSelected("");
    setContent("");
    await load();
    await pullSettings(onSettings);
  };
  const importFromGitHub = async () => {
    if (!githubUrl.trim()) return;
    setImporting(true);
    try {
      const result = await api.post<{ skill: SkillProfile }>(
        "skills/import-github",
        { repoUrl: githubUrl.trim() },
        { timeout: false },
      );
      await load();
      setSelected(result.skill.name);
      setContent(result.skill.content ?? "");
      autosave.reset();
      setGithubUrl("");
      toast.success(t("settings:mcp.skill_imported", { name: result.skill.name }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:mcp.import_failed"));
    } finally {
      setImporting(false);
    }
  };
  // 对齐安卓 commit af9b1f35 的 importSkillFromFile：支持从本地选择
  // .md/.zip 文件并上传到后端解析。ZIP 包内可含多个技能（每个根目录
  // 下放一份 SKILL.md），全部按原子方式导入。
  const importFromFile = async (file: File) => {
    setImportingFile(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(appendWebAuthQuery("/api/skills/import-file"), {
        method: "POST",
        body: formData,
      });
      const data = (await res.json()) as {
        imported?: string[];
        skills?: SkillProfile[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || t("settings:mcp.import_failed"));
      await load();
      const first = data.skills?.[0];
      if (first) {
        setSelected(first.name);
        setContent(first.content ?? "");
        autosave.reset();
      }
      const names = (data.imported ?? []).join("、");
      toast.success(t("settings:mcp.skill_imported", { name: names || file.name }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:mcp.import_failed"));
    } finally {
      setImportingFile(false);
    }
  };
  const handleFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void importFromFile(file);
  };
  const toggle = async (skillName: string, checked: boolean) => {
    const ids = new Set(assistant.enabledSkills as string[] | undefined);
    if (checked) ids.add(skillName);
    else ids.delete(skillName);
    await api.post("settings/assistant/skills", {
      assistantId: assistant.id,
      enabledSkills: [...ids],
    });
    await pullSettings(onSettings);
  };

  return (
    <EditorShell
      items={skills as unknown as Array<Record<string, unknown>>}
      selectedId={selected}
      emptyLabel={t("settings:mcp.empty_skill")}
      onSelect={setSelected}
      titleOf={(item) => textValue(item.name)}
      listHeader={bindingSelect}
      renderItem={(item) => {
        const name = textValue(item.name);
        const enabled = (assistant.enabledSkills as string[] | undefined)?.includes(name) ?? false;
        const issues = (item.issues as SkillProfile["issues"]) ?? [];
        const hasError = item.available === false || issues.some((issue) => issue.level === "error");
        return (
          <div className="flex min-w-0 items-center gap-2 text-left">
            <span
              // 未对当前助手启用是正常状态,用中性灰;真正的问题由右侧 TriangleAlert 标出。
              className={`size-2 shrink-0 rounded-full ${enabled ? "bg-success" : "bg-muted-foreground/40"}`}
            />
            <span className="block min-w-0 truncate font-medium">{name}</span>
            {issues.length > 0 ? (
              <TriangleAlert
                className={`size-3.5 shrink-0 ${hasError ? "text-destructive" : "text-warning"}`}
                aria-label={issues.map((issue) => issue.message).join("; ")}
              />
            ) : null}
          </div>
        );
      }}
      onCreate={() => {
        const name = "new-skill";
        setSelected(name);
        setContent(
          `---\nname: ${name}\ndescription: ${t("settings:mcp.skill_desc_default")}\n---\n\n${t("settings:mcp.skill_body_default")}\n`,
        );
        setFiles([]);
        autosave.markDirty();
      }}
    >
      <div className="space-y-5">
        <div>
          <div className="mb-2 text-sm font-medium">{t("settings:mcp.import_github")}</div>
          <div className="flex gap-2">
            <Input
              value={githubUrl}
              onChange={(event) => setGithubUrl(event.target.value)}
              placeholder={t("settings:mcp.github_url_ph")}
              onKeyDown={(event) => {
                if (event.key === "Enter") void importFromGitHub();
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => void importFromGitHub()}
              disabled={importing || !githubUrl.trim()}
            >
              {importing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              {t("settings:mcp.import_btn")}
            </Button>
          </div>
        </div>
        <div className="border-t border-[var(--ds-divider)] pt-5">
          <div className="mb-2 text-sm font-medium">{t("settings:mcp.import_file")}</div>
          <div
            className="mb-2 text-xs text-muted-foreground"
            dangerouslySetInnerHTML={{ __html: t("settings:mcp.import_file_desc") }}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.markdown,.zip,application/zip"
            className="hidden"
            onChange={handleFileInputChange}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={importingFile}
          >
            {importingFile ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
            {t("settings:mcp.select_file")}
          </Button>
        </div>
        <div className="space-y-0.5 border-t border-[var(--ds-divider)] pt-4">
          <div className="px-2 pb-1 text-xs font-semibold text-[var(--ds-text-secondary)]">
            {t("settings:mcp.enable_for_assistant")}
          </div>
          {skills.map((skill) => (
            <label
              key={skill.name}
              className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-[var(--ds-on-surface)]"
            >
              <Checkbox
                className="mt-0.5"
                checked={
                  (assistant.enabledSkills as string[] | undefined)?.includes(skill.name) ?? false
                }
                onCheckedChange={(checked) => void toggle(skill.name, checked === true)}
              />
              <span className="min-w-0 flex-1 truncate font-medium">{skill.name}</span>
            </label>
          ))}
        </div>
        {selectedSkill?.description ? (
          <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
            {selectedSkill.description}
          </div>
        ) : null}
        {selectedSkill?.issues?.length ? (
          <div className="space-y-1.5 rounded-md border border-warning/40 bg-warning/5 p-3">
            <div className="text-xs font-medium">{t("settings:mcp.skill_issues_title")}</div>
            {selectedSkill.available === false ? (
              <div className="text-xs text-destructive">{t("settings:mcp.skill_unavailable_hint")}</div>
            ) : null}
            {selectedSkill.issues.map((issue) => (
              <div
                key={issue.message}
                className={`font-mono text-xs ${issue.level === "error" ? "text-destructive" : "text-warning"}`}
              >
                {issue.message}
              </div>
            ))}
          </div>
        ) : null}
        <div className="rounded-md border">
          <div className="border-b px-3 py-2 text-sm font-medium">{t("settings:mcp.file_list")}</div>
          <div className="max-h-40 overflow-auto p-2">
            {files.length === 0 ? (
              <div className="p-2 text-sm text-muted-foreground">{t("settings:mcp.no_files")}</div>
            ) : null}
            {files.map((file) => (
              <div
                key={file.path}
                className="flex items-center justify-between gap-3 rounded px-2 py-1 text-xs hover:bg-muted/40"
              >
                <span className={file.type === "directory" ? "font-medium" : ""}>{file.path}</span>
                <span className="text-muted-foreground">
                  {file.type === "directory" ? t("settings:mcp.directory") : `${file.size} B`}
                </span>
              </div>
            ))}
          </div>
        </div>
        <label className="block space-y-2">
          <span className="text-sm font-medium">SKILL.md</span>
          <Textarea
            value={content}
            onChange={(event) => {
              autosave.markDirty();
              setContent(event.target.value);
            }}
            className="h-80 max-h-80 font-mono text-xs"
          />
        </label>
        <div className="flex justify-end gap-2">
          <AutosaveStatusRow
            className="mr-auto"
            status={autosave.status}
            onRetry={() => void autosave.saveNow()}
          />
          <Button variant="destructive" onClick={() => void remove()} disabled={!selected}>
            <Trash2 className="size-4" />
            {t("settings:mcp.delete")}
          </Button>
        </div>
      </div>
    </EditorShell>
  );
}

function parseSkillName(content: string) {
  const match = content.match(/^---[\s\S]*?\nname:\s*([^\n]+)[\s\S]*?\n---/);
  return match?.[1]?.trim().replace(/^"|"$/g, "");
}
