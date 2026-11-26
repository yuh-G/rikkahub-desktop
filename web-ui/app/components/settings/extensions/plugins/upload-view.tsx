// 上传本地文件(方案 P6.2「视图五」):信任提示、拖放区(可聚焦,回车打开文件选择)、格式说明、上传并安装。前端只查
// 扩展名与大小,其余校验在后端。成功 → toast + 用新插件的详情替换栈顶(返回即回首页);409 同名 → 问过后带 replace 重发。
import * as React from "react";
import { FileArchive, Upload, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SettingsStack } from "~/components/settings/shared";
import { Button } from "~/components/ui/button";
import { Notice } from "~/components/ui/notice";
import i18n from "~/i18n";
import { extractErrorMessage } from "~/lib/error";
import { followInstallProgress, pluginsApi } from "~/lib/plugins-api";
import { cn } from "~/lib/utils";
import { confirmDialog } from "~/stores/confirm-store";
import { backPluginView, replacePluginView, setPluginBusy, usePluginsViewStore } from "~/stores/plugins-view-store";

import { afterInstalled } from "./actions";
import { InstallProgressGlyph, InstallProgressTooltip } from "./install-progress";
import { pluginSourceLabel } from "./model";
import { BackLink } from "./parts";

const ACCEPT = ".tgz,.gz,.zip,.ts,.js,.mjs";
const ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
const SCRIPT_MAX_BYTES = 1024 * 1024;

/** 前端的初查(与后端 engines/plugin-upload.ts 的头两条一致);通过返回 null。 */
export function uploadFileProblem(file: { name: string; size: number }): string | null {
  const lower = file.name.toLowerCase();
  const archive = lower.endsWith(".tgz") || lower.endsWith(".tar.gz") || lower.endsWith(".zip");
  const script = /\.(ts|js|mjs)$/.test(lower);
  if (!archive && !script) return "upload_bad_type";
  if (file.size === 0) return "upload_empty";
  if (archive && file.size > ARCHIVE_MAX_BYTES) return "upload_too_large_archive";
  if (script && file.size > SCRIPT_MAX_BYTES) return "upload_too_large_script";
  return null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function PluginUploadView({ backLabel }: { backLabel: string }) {
  const { t } = useTranslation();
  const [file, setFile] = React.useState<File | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const uploading = usePluginsViewStore((state) => Boolean(state.busy.upload));
  const inputRef = React.useRef<HTMLInputElement>(null);
  const problem = file ? uploadFileProblem(file) : null;

  const choose = (next: File | undefined) => {
    if (!next) return;
    setFile(next);
    setError(null);
  };

  const submit = async () => {
    if (!file || problem || uploading) return;
    setError(null);
    setPluginBusy("upload", true);
    const unfollow = followInstallProgress("upload");
    try {
      let result = await pluginsApi.upload(file, { progressKey: "upload" });
      if (result.kind === "conflict") {
        const origin = pluginSourceLabel(result.existing.source);
        const replace = await confirmDialog({
          title: t("settings:plugins.upload_conflict_title", { name: result.existing.name }),
          description: t("settings:plugins.upload_conflict_desc", {
            source: `${t(`settings:plugins.source.${origin.kind}`)} · ${origin.detail}`,
          }),
          confirmLabel: t("settings:plugins.replace"),
        });
        if (!replace) return;
        result = await pluginsApi.upload(file, { replace: true, progressKey: "upload" });
        if (result.kind === "conflict") throw new Error(i18n.t("settings:plugins.action_failed"));
      }
      afterInstalled(result.plugin);
      replacePluginView({ kind: "detail", pluginId: result.plugin.id });
    } catch (err) {
      setError(extractErrorMessage(err, t("settings:plugins.action_failed")));
    } finally {
      unfollow();
      setPluginBusy("upload", false);
    }
  };

  return (
    <SettingsStack>
      <BackLink label={backLabel} onClick={backPluginView} />
      <div>
        <h2 className="text-base font-semibold text-[var(--ds-text-primary)]">{t("settings:plugins.upload_title")}</h2>
        <p className="mt-0.5 text-xs text-[var(--ds-text-secondary)]">{t("settings:plugins.upload_desc")}</p>
      </div>
      <Notice tone="danger">{t("settings:plugins.trust_notice")}</Notice>
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-[var(--ds-text-primary)]">{t("settings:plugins.upload_file")}</h3>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(event) => {
            choose(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        {/* 拖放落在整块区域上;没选文件时整块是一个按钮(回车打开文件选择),选中后区内换成文件条。 */}
        <div
          onDragOver={(event) => {
            event.preventDefault();
            if (!uploading) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (!uploading) choose(event.dataTransfer.files?.[0]);
          }}
          className={cn(
            "flex min-h-28 rounded-[var(--ds-radius-md)] border border-dashed border-[var(--ds-divider)] transition-colors duration-(--ds-duration-fast) motion-reduce:transition-none",
            !file && "hover:border-[color-mix(in_srgb,var(--ds-text-primary)_18%,transparent)]",
            dragging && "border-[var(--ds-brand-primary)] bg-[color-mix(in_srgb,var(--ds-brand-primary)_4%,transparent)]",
          )}
        >
          {file ? (
            <div className="flex flex-1 items-center justify-center px-4 py-6">
              <FileChip file={file} onRemove={() => setFile(null)} disabled={uploading} />
            </div>
          ) : (
            <button
              type="button"
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
              className="flex flex-1 flex-col items-center justify-center gap-2 rounded-[var(--ds-radius-md)] px-4 py-6 text-sm text-[var(--ds-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Upload className="size-5 text-[var(--ds-icon)]" />
              <span>
                {t("settings:plugins.upload_drop")}{" "}
                <span className="font-medium text-[var(--ds-brand-primary)]">{t("settings:plugins.upload_pick")}</span>
              </span>
            </button>
          )}
        </div>
        {problem ? <p className="text-xs text-[var(--ds-danger)]">{t(`settings:plugins.${problem}`)}</p> : null}
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-[var(--ds-text-tertiary)]">
          <li>{t("settings:plugins.upload_formats")}</li>
          <li>{t("settings:plugins.upload_entry_rule")}</li>
          <li>{t("settings:plugins.upload_size_rule")}</li>
        </ul>
      </section>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="flex flex-wrap items-center gap-3">
        <InstallProgressTooltip busyKey="upload" active={uploading}>
          <Button type="button" disabled={!file || Boolean(problem) || uploading} onClick={() => void submit()}>
            {uploading ? <InstallProgressGlyph busyKey="upload" /> : <Upload />}
            {t(uploading ? "settings:plugins.installing" : "settings:plugins.upload_submit")}
          </Button>
        </InstallProgressTooltip>
        <Button type="button" variant="ghost" disabled={uploading} onClick={backPluginView}>
          {t("settings:plugins.cancel")}
        </Button>
        {!file ? <span className="text-xs text-[var(--ds-text-tertiary)]">{t("settings:plugins.upload_need_file")}</span> : null}
      </div>
    </SettingsStack>
  );
}

/** 拖放区里选中的文件:文件名 · 大小 · 移除。 */
function FileChip({ file, onRemove, disabled }: { file: File; onRemove: () => void; disabled: boolean }) {
  const { t } = useTranslation();
  return (
    <span className="flex max-w-full items-center gap-2 rounded-[var(--ds-radius-sm)] bg-[var(--ds-on-surface)] py-1 pr-1 pl-2.5 text-sm text-[var(--ds-text-primary)] animate-in fade-in-0 duration-(--ds-duration-fast) motion-reduce:animate-none">
      <FileArchive className="size-4 shrink-0 text-[var(--ds-icon)]" />
      <span className="min-w-0 truncate">{file.name}</span>
      <span className="shrink-0 text-xs text-[var(--ds-text-tertiary)]">{formatSize(file.size)}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        disabled={disabled}
        aria-label={t("settings:plugins.remove_file")}
        title={t("settings:plugins.remove_file")}
        onClick={onRemove}
      >
        <X />
      </Button>
    </span>
  );
}
