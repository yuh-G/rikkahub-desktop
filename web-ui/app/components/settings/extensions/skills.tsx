// components/settings/extensions/skills.tsx — 拓展 › 技能

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Download, FilePlus2, Github, Loader2, TriangleAlert, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Notice } from "~/components/ui/notice";
import { Textarea } from "~/components/ui/textarea";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import { cn } from "~/lib/utils";
import api, { appendWebAuthQuery } from "~/services/api";
import { confirmDialog } from "~/stores/confirm-store";
import type { AssistantProfile, Settings } from "~/types";
import {
  SettingsAdvancedSection,
  SettingsDetailFooter,
  SettingsDetailHeader,
  SettingsEmpty,
  SettingsField,
  SettingsGroup,
  SettingsStack,
  textValue,
} from "~/components/settings/shared";
import {
  BindingAssistantSelect,
  BindingSwitch,
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
      bindingSelect={<BindingAssistantSelect settings={settings} assistant={assistant} stretch className="mb-1" />}
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
  const [githubOpen, setGithubOpen] = React.useState(false);
  // 「高级设置」展开态:切换技能不收起,离开本页(重挂载)复位为收起。
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
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

  // 删除收口到列表行(右键/悬停「⋯」):按目标行技能名删,不再依赖右侧选中项。
  const removeSkill = async (skillName: string) => {
    if (!skillName) return;
    if (!(await confirmDialog({ title: t("settings:mcp.delete_skill_confirm"), danger: true }))) return;
    // 防复活:仅当删的是正在编辑的那条才 discard(丢脏编辑+等在飞保存,DELETE 不与迟到 POST 乱序,复审 F1)
    const removingActive = selected === skillName;
    if (removingActive) await autosave.discard();
    await api.delete(`skills/${encodeURIComponent(skillName)}`);
    if (removingActive) {
      setSelected("");
      setContent("");
    }
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
      setGithubOpen(false);
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
  const createBlank = () => {
    const name = "new-skill";
    setSelected(name);
    setContent(
      `---\nname: ${name}\ndescription: ${t("settings:mcp.skill_desc_default")}\n---\n\n${t("settings:mcp.skill_body_default")}\n`,
    );
    setFiles([]);
    autosave.markDirty();
  };
  const enabledSkills = (assistant.enabledSkills as string[] | undefined) ?? [];
  const toggle = async (skillName: string, checked: boolean) => {
    const ids = new Set(enabledSkills);
    if (checked) ids.add(skillName);
    else ids.delete(skillName);
    try {
      await api.post("settings/assistant/skills", {
        assistantId: assistant.id,
        enabledSkills: [...ids],
      });
      await pullSettings(onSettings);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:mcp.save_failed"));
    }
  };

  return (
    <EditorShell
      items={skills as unknown as Array<Record<string, unknown>>}
      selectedId={selected}
      emptyLabel={t("settings:mcp.empty_skill")}
      onSelect={setSelected}
      titleOf={(item) => textValue(item.name)}
      listHeader={bindingSelect}
      rowMenuOf={(item) => {
        const name = textValue(item.name);
        return name ? { onDelete: () => removeSkill(name) } : undefined;
      }}
      renderItem={(item) => {
        const name = textValue(item.name);
        const enabled = enabledSkills.includes(name);
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
      createMenu={[
        { key: "blank", label: t("settings:mcp.skill_create_blank"), icon: <FilePlus2 />, onSelect: createBlank },
        { key: "github", label: t("settings:mcp.import_github_menu"), icon: <Github />, onSelect: () => setGithubOpen(true) },
        {
          key: "file",
          label: t("settings:mcp.import_file_menu"),
          icon: importingFile ? <Loader2 className="animate-spin" /> : <Upload />,
          onSelect: () => fileInputRef.current?.click(),
        },
      ]}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.markdown,.zip,application/zip"
        className="hidden"
        onChange={handleFileInputChange}
      />
      {selected ? (
        <div className="@container">
          <SettingsStack>
            <SettingsDetailHeader
              title={selected}
              description={selectedSkill?.description || t("settings:mcp.skill_page_desc")}
              action={
                // 新建技能落盘前服务端还不认识它(启用会被 400 拒绝),保存成功出现在列表后才可绑定。
                <BindingSwitch
                  checked={enabledSkills.includes(selected)}
                  disabled={!selectedSkill}
                  onCheckedChange={(checked) => void toggle(selected, checked)}
                />
              }
            />

            {selectedSkill?.issues?.length ? (
              <Notice tone={selectedSkill.available === false ? "danger" : "warning"} className="block space-y-1">
                <div className="font-medium">{t("settings:mcp.skill_issues_title")}</div>
                {selectedSkill.available === false ? <div>{t("settings:mcp.skill_unavailable_hint")}</div> : null}
                {selectedSkill.issues.map((issue) => (
                  <div
                    key={issue.message}
                    className={cn("font-mono", issue.level === "error" ? "text-[var(--ds-danger)]" : "text-[var(--ds-warning)]")}
                  >
                    {issue.message}
                  </div>
                ))}
              </Notice>
            ) : null}

            <SettingsGroup fields>
              <SettingsField label="SKILL.md" description={t("settings:mcp.skill_md_desc")}>
                <Textarea
                  value={content}
                  onChange={(event) => {
                    autosave.markDirty();
                    setContent(event.target.value);
                  }}
                  className="h-96 max-h-[32rem] font-mono text-xs leading-relaxed"
                />
              </SettingsField>
            </SettingsGroup>

            <SettingsAdvancedSection open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <div className="space-y-5 pt-2">
                <SettingsField label={t("settings:mcp.file_list")} description={t("settings:mcp.file_list_desc")}>
                  {files.length === 0 ? (
                    <SettingsEmpty>
                      {t("settings:mcp.no_files")}
                    </SettingsEmpty>
                  ) : (
                    <div className="max-h-48 overflow-auto rounded-[var(--ds-radius-md)] border p-1">
                      {files.map((file) => (
                        <div
                          key={file.path}
                          className="flex items-center justify-between gap-3 rounded-[var(--ds-radius-sm)] px-2 py-1 text-xs hover:bg-[var(--ds-on-surface)]"
                        >
                          <span className={cn("truncate font-mono", file.type === "directory" && "font-medium")}>
                            {file.path}
                          </span>
                          <span className="shrink-0 text-[var(--ds-text-secondary)]">
                            {file.type === "directory" ? t("settings:mcp.directory") : `${file.size} B`}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </SettingsField>
              </div>
            </SettingsAdvancedSection>

            <SettingsDetailFooter
              status={<AutosaveStatusRow status={autosave.status} onRetry={() => void autosave.saveNow()} />}
            />
          </SettingsStack>
        </div>
      ) : (
        <SettingsEmpty size="md">
          {t("settings:mcp.skill_empty_detail")}
        </SettingsEmpty>
      )}

      <Dialog open={githubOpen} onOpenChange={(open) => !importing && setGithubOpen(open)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("settings:mcp.import_github")}</DialogTitle>
            <DialogDescription>{t("settings:mcp.import_github_desc")}</DialogDescription>
          </DialogHeader>
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              void importFromGitHub();
            }}
          >
            <Input
              autoFocus
              value={githubUrl}
              onChange={(event) => setGithubUrl(event.target.value)}
              placeholder={t("settings:mcp.github_url_ph")}
              aria-label={t("settings:mcp.import_github")}
            />
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={importing} onClick={() => setGithubOpen(false)}>
                {t("common:confirm_dialog.cancel")}
              </Button>
              <Button type="submit" disabled={importing || !githubUrl.trim()}>
                {importing ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                {t("settings:mcp.import_btn")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </EditorShell>
  );
}

function parseSkillName(content: string) {
  const match = content.match(/^---[\s\S]*?\nname:\s*([^\n]+)[\s\S]*?\n---/);
  return match?.[1]?.trim().replace(/^"|"$/g, "");
}
