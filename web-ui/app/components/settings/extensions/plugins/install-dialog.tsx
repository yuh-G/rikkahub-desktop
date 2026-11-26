// 「通过包名或地址安装」「链接本地文件夹」两个弹窗(方案 P6.2)。成功后关闭并跳到新插件的详情。
import * as React from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SettingsField } from "~/components/settings/shared";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Notice } from "~/components/ui/notice";
import { SegmentedControl } from "~/components/ui/segmented-tabs";
import { extractErrorMessage } from "~/lib/error";
import { followInstallProgress, pluginsApi } from "~/lib/plugins-api";
import { isWindowsPlatform } from "~/lib/system-info";
import { pushPluginView, setPluginBusy } from "~/stores/plugins-view-store";
import type { EnginePluginSource } from "~/types/plugins";

import { afterInstalled } from "./actions";
import { InstallProgressGlyph, InstallProgressTooltip } from "./install-progress";

export type InstallDialogKind = "package" | "local";

export function InstallDialog({
  kind,
  initialSpec = "",
  onOpenChange,
}: {
  /** null = 关着。 */
  kind: InstallDialogKind | null;
  initialSpec?: string;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={kind !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {kind ? <InstallForm key={`${kind}:${initialSpec}`} kind={kind} initialSpec={initialSpec} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function InstallForm({ kind, initialSpec, onDone }: { kind: InstallDialogKind; initialSpec: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = React.useState<"npm" | "git">(/^(https?:|git\+|git@)/.test(initialSpec) ? "git" : "npm");
  const [spec, setSpec] = React.useState(initialSpec);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputId = React.useId();
  const local = kind === "local";

  const submit = async () => {
    const value = spec.trim();
    if (!value || saving) return;
    const source: EnginePluginSource = { kind: local ? "local" : mode, spec: value };
    setSaving(true);
    setError(null);
    // 忙碌键与上传共用:后端同一引擎的安装是串行的,首页的「添加」在这期间也显示进行中。
    setPluginBusy("upload", true);
    const unfollow = followInstallProgress("upload");
    try {
      const { plugin } = await pluginsApi.install(source, "pi", "upload");
      afterInstalled(plugin);
      onDone();
      pushPluginView({ kind: "detail", pluginId: plugin.id });
    } catch (err) {
      setError(extractErrorMessage(err, t("settings:plugins.action_failed")));
    } finally {
      unfollow();
      setPluginBusy("upload", false);
      setSaving(false);
    }
  };

  const placeholder = local
    ? t(isWindowsPlatform() ? "settings:plugins.local_path_placeholder_windows" : "settings:plugins.local_path_placeholder_posix")
    : t(mode === "npm" ? "settings:plugins.package_npm_placeholder" : "settings:plugins.package_git_placeholder");
  const hint = local
    ? t("settings:plugins.local_path_hint")
    : t(mode === "npm" ? "settings:plugins.package_npm_hint" : "settings:plugins.package_git_hint");

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t(local ? "settings:plugins.link_local_title" : "settings:plugins.install_package_title")}</DialogTitle>
        <DialogDescription className="sr-only">{t("settings:plugins.trust_notice")}</DialogDescription>
      </DialogHeader>
      <Notice tone="danger">{t("settings:plugins.trust_notice")}</Notice>
      {local ? null : (
        <SegmentedControl
          stretch
          items={[
            { value: "npm", label: "npm" },
            { value: "git", label: "Git" },
          ]}
          value={mode}
          onChange={setMode}
          aria-label={t("settings:plugins.info_source")}
        />
      )}
      <SettingsField
        label={t(local ? "settings:plugins.local_path" : "settings:plugins.package_spec")}
        htmlFor={inputId}
        hint={hint}
      >
        <Input
          id={inputId}
          autoFocus
          value={spec}
          onChange={(event) => setSpec(event.target.value)}
          placeholder={placeholder}
          disabled={saving}
          spellCheck={false}
        />
      </SettingsField>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={saving} onClick={onDone}>
          {t("settings:plugins.cancel")}
        </Button>
        <InstallProgressTooltip busyKey="upload" active={saving && !local}>
          <Button type="submit" disabled={!spec.trim() || saving}>
            {saving ? local ? <Loader2 className="animate-spin" /> : <InstallProgressGlyph busyKey="upload" /> : null}
            {local
              ? t(saving ? "settings:plugins.linking" : "settings:plugins.link")
              : t(saving ? "settings:plugins.installing" : "settings:plugins.install")}
          </Button>
        </InstallProgressTooltip>
      </DialogFooter>
    </form>
  );
}
