// components/memory/global-agents-card.tsx — 全局工作区指引(pc-data/AGENTS.md,引擎中立)卡片。
// 对齐 APP 2689e753 的 ~/.agents 层:对所有工作区会话生效的用户指令(沟通偏好/习惯
// 流程),与记忆分工互补——记忆=模型提取的用户事实,AGENTS.md=用户亲写的指令。
// 挂在记忆页首组;编辑走弹窗(模板引导新建),保存即被工作区引擎下一轮装配读取。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { BookOpenText, Loader2, Pencil } from "lucide-react";
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
import { SettingsGroup, SettingsRows, SettingsRow } from "~/components/settings/shared";
import { Textarea } from "~/components/ui/textarea";
import api from "~/services/api";

interface GlobalAgentsState {
  fileName: string;
  exists: boolean;
  content: string;
  template: string;
}

export function GlobalAgentsCard() {
  const { t } = useTranslation();
  const [data, setData] = React.useState<GlobalAgentsState | null>(null);
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(() => {
    api
      .get<{ agentsFile: GlobalAgentsState }>("global-agents")
      .then((res) => setData(res.agentsFile))
      .catch((err: Error) => toast.error(err.message));
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const openEditor = () => {
    if (!data) return;
    setDraft(data.exists ? data.content : data.template);
    setOpen(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.put<{ agentsFile: GlobalAgentsState }>("global-agents", { content: draft });
      setData(res.agentsFile);
      setOpen(false);
      toast.success(t("settings:memory.global_agents_saved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings:memory.global_agents_failed"));
    } finally {
      setSaving(false);
    }
  };

  const preview = data?.exists ? data.content.split("\n").find((line) => line.trim().startsWith("#"))?.replace(/^#+\s*/, "") : undefined;

  return (
    <SettingsGroup
      title={t("settings:memory.global_agents_title")}
      description={t("settings:memory.global_agents_subtitle")}
    >
      <SettingsRows>
        <SettingsRow
          label={data?.exists ? data.fileName : "AGENTS.md"}
          description={
            data?.exists
              ? preview
                ? t("settings:memory.global_agents_preview", { title: preview })
                : t("settings:memory.global_agents_active")
              : t("settings:memory.global_agents_inactive")
          }
          control={
            <Button size="compact" variant="tertiary" disabled={!data} onClick={openEditor}>
              {data?.exists ? <Pencil className="size-3.5" /> : <BookOpenText className="size-3.5" />}
              {data?.exists ? t("settings:memory.global_agents_edit") : t("settings:memory.global_agents_create")}
            </Button>
          }
        />
      </SettingsRows>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{data?.exists ? data.fileName : "AGENTS.md"}</DialogTitle>
            <DialogDescription>
              {data?.exists
                ? t("settings:memory.global_agents_edit_hint")
                : t("settings:memory.global_agents_create_hint")}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="min-h-64 flex-1 resize-none font-mono text-xs leading-5"
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t("settings:memory.cancel")}
            </Button>
            <Button type="button" disabled={saving} onClick={() => void save()}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("settings:memory.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}
