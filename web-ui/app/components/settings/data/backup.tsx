// components/settings/data/backup.tsx — 数据管理 › 备份与恢复:本地备份与恢复、上次云端恢复报告、WebDAV、S3。
// WebDAV / S3 的配置表单在同目录 webdav.tsx / s3.tsx,远端操作共用 remote.tsx。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Download, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Notice } from "~/components/ui/notice";
import api, { appendWebAuthQuery } from "~/services/api";
import { isTauriEnvironment } from "~/lib/system-info";
import { patchSettingsLocal } from "~/lib/settings-patch";
import { useSettingsStore } from "~/stores/app-store";
import { patchBackupTask, useBackupTaskStore } from "~/stores/backup-task-store";
import { confirmDialog } from "~/stores/confirm-store";
import type { Settings } from "~/types";
import { SettingsGroup, SettingsStack } from "~/components/settings/shared";
import {
  ANDROID_COMPAT_CARD_ENABLED,
  AndroidCompatCard,
  fetchSchemaStatus,
  useSchemaStatus,
} from "~/components/settings/data/android-compat";
import { BackupProgress } from "~/components/settings/data/progress";
import { S3BackupCard } from "~/components/settings/data/s3";
import { WebDavBackupCard } from "~/components/settings/data/webdav";
import { AssistantRecoveryCard } from "~/components/settings/data/assistant-recovery";

export function BackupSection({
  settings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const importInputRef = React.useRef<HTMLInputElement>(null);
  // 长任务状态在模块级 store(见 backup-task-store):切到别的页再回来,进度与禁用态仍在。
  const { exporting, importing, importPhase, importProgress, exportLoaded: exportedBytes, exportTotal: exportTotalBytes } =
    useBackupTaskStore();
  const exportProgress = exportTotalBytes > 0 ? Math.round((exportedBytes / exportTotalBytes) * 100) : 0;
  const [schemaStatus, setSchemaStatus] = useSchemaStatus();
  // 远端备份不含对话的提示徽标:只在 APP端适配卡启用且确认未注册时出现(未知态不画)。
  const chatUnsyncable = ANDROID_COMPAT_CARD_ENABLED && schemaStatus != null && !schemaStatus.hasAndroidSchema;

  // 导出前确认走全局 confirmDialog:它挂在 root、z 序在设置模态之上。此前手写的
  // fixed 遮罩渲染在模态 DialogContent 内部,而 DialogContent 带 transform(成为 fixed 的
  // 包含块)+ overflow-hidden——遮罩被困在面板里,且按 Esc 关掉的是整个设置模态。
  const handleExportClick = async () => {
    // 描述里的对话数用这里取回的局部值:setSchemaStatus 是异步的,读 state 会拿到旧值。
    let status = schemaStatus;
    try {
      const fresh = await fetchSchemaStatus();
      if (fresh) {
        status = fresh;
        setSchemaStatus(fresh);
      }
    } catch {
      // 状态查询失败不阻断导出:按上次已知状态(或 0 条)出确认文案。
    }
    const withSchema = !ANDROID_COMPAT_CARD_ENABLED || status?.hasAndroidSchema === true;
    const confirmed = await confirmDialog({
      title: t("settings:data.export_confirm_title"),
      description: withSchema
        ? t("settings:data.export_with_schema", { count: status?.conversationCount ?? 0 })
        : t("settings:data.export_without_schema"),
      confirmLabel: withSchema ? t("settings:data.confirm_export") : t("settings:data.export_no_chat"),
    });
    if (confirmed) await doExport();
  };

  // 问题5(2.0.0 内测):桌面端(Tauri)导出用系统保存对话框自选位置。次序是"先选位置、后生成"
  // ——用户取消对话框时请求根本不会发出,天然满足"没选位置就关掉 → 不留任何文件"。
  // 生成期间服务端(与壳同机)把 zip 直写目标路径,多 GB 备份零 HTTP 传输、零下载目录中转,
  // 故无字节进度可展示(构建期本就无进度,与 GET 流程的"准备导出"阶段一致)。
  const doExportToPickedPath = async () => {
    let target: string | null = null;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      // 建议名与服务端 GET 流程同构(时间戳仅为对话框预填,最终名以用户输入为准)。
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/T/, "_").replace(/Z$/, "").replace(/-/g, "").slice(0, 15);
      target = await save({
        defaultPath: `rikkahub-backup-${stamp}.zip`,
        filters: [{ name: "Zip", extensions: ["zip"] }],
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings:data.export_failed"));
      return;
    }
    if (!target) return; // 用户取消:零生成零残留
    patchBackupTask({ exporting: true });
    const prepToast = toast.loading(t("settings:data.export_preparing"));
    try {
      const res = await fetch(appendWebAuthQuery("/api/data/export/to-path"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetPath: target }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; fileName?: string; warnings?: string[]; error?: string }
        | null;
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || t("settings:data.export_http_error", { status: res.status }));
      }
      toast.dismiss(prepToast);
      // 成功文案展示用户选择的完整路径(比 GET 流程的"文件名+去下载目录找"更明确)。
      toast.success(t("settings:data.export_done", { name: target }), { duration: 8000 });
      for (const warning of data.warnings ?? []) toast.warning(warning, { duration: 12000 });
    } catch (err) {
      toast.dismiss(prepToast);
      toast.error(err instanceof Error ? err.message : t("settings:data.export_failed"));
    } finally {
      patchBackupTask({ exporting: false });
    }
  };

  const doExport = async () => {
    if (isTauriEnvironment()) {
      await doExportToPickedPath();
      return;
    }
    patchBackupTask({ exporting: true, exportLoaded: 0, exportTotal: 0 });
    const prepToast = toast.loading(t("settings:data.export_preparing"));
    try {
      // Download the zip via XHR so we can read onprogress (loaded / total) and surface a
      // progress bar — Bun's response carries a Content-Length so the browser knows the
      // total up front. ky/fetch don't expose download progress without a custom
      // ReadableStream consumer; XHR is simpler and well-supported by Tauri's webview.
      const result: { blob: Blob; fileName: string; warnings: string[] } = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", appendWebAuthQuery("/api/data/export"));
        xhr.responseType = "blob";
        xhr.onprogress = (ev) => {
          if (ev.lengthComputable && ev.total > 0) {
            patchBackupTask({ exportTotal: ev.total, exportLoaded: ev.loaded });
          } else {
            // Server didn't send Content-Length (shouldn't happen with our endpoint, but be
            // defensive). At least bump the byte counter so the user sees something moving.
            patchBackupTask({ exportLoaded: ev.loaded });
          }
        };
        xhr.onerror = () => reject(new Error(t("settings:data.export_network_error")));
        xhr.onabort = () => reject(new Error(t("settings:data.export_cancelled")));
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            // X-Export-Filename is set by the server with the canonical zip filename, so we
            // don't have to recompute the timestamp on the client (and risk it drifting).
            const headerName = xhr.getResponseHeader("X-Export-Filename") || "";
            // B4-①:关键降级项(安卓库失败/附件缺失)随 header 透出,逐条解析成可读文案。
            let warnings: string[] = [];
            const warningsHeader = xhr.getResponseHeader("X-Export-Warnings");
            if (warningsHeader) {
              try {
                const parsed = JSON.parse(warningsHeader);
                if (Array.isArray(parsed)) warnings = parsed.map((w) => String(w));
              } catch {
                warnings = [];
              }
            }
            const fallback = `rikkahub-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
            resolve({ blob: xhr.response as Blob, fileName: headerName || fallback, warnings });
          } else {
            reject(new Error(t("settings:data.export_http_error", { status: xhr.status })));
          }
        };
        xhr.send();
      });

      // Hand off the blob to a hidden <a download> click; the browser writes it to its
      // default Downloads folder. We can't get the real filesystem path back from the
      // browser API, but we tell the user the filename and where to look.
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.fileName;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      toast.dismiss(prepToast);
      // Long-lived success toast so the user has time to read the filename before it dismisses.
      // 8s is enough to copy the name into a file manager search box if they want.
      toast.success(t("settings:data.export_done", { name: result.fileName }), { duration: 8000 });
      // B4-①:备份"成功但缺件"(安卓库失败/附件缺失)必须显式警告,不能只在成功 toast 里带过。
      for (const warning of result.warnings) {
        toast.warning(warning, { duration: 12000 });
      }
    } catch (error) {
      toast.dismiss(prepToast);
      toast.error(error instanceof Error ? error.message : t("settings:data.export_failed"));
    } finally {
      patchBackupTask({ exporting: false, exportLoaded: 0, exportTotal: 0 });
    }
  };

  const importData = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!(await confirmDialog({ title: t("settings:data.import_confirm"), danger: true }))) return;

    patchBackupTask({ importing: true, importPhase: "uploading", importProgress: 0 });
    try {
      // Stream the file body directly to /api/data/import as application/octet-stream rather
      // than wrap it in multipart/form-data. Two reasons:
      //   1. Users have reported 10+ GB backups. `Buffer.from(await file.arrayBuffer())` on
      //      the server doubles JS heap memory; with streaming, the server writes chunks
      //      straight to disk and never holds the full body in memory.
      //   2. fetch() can't report upload progress. XMLHttpRequest can. We need the progress
      //      bar so the user doesn't think the app froze during a multi-GB upload.
      // The backend's data/import endpoint detects octet-stream via Content-Type and routes
      // to the streaming path; multipart still works as a fallback.
      const result = await new Promise<{
        status: string;
        source?: string;
        summary?: string[];
        warnings?: string[];
        settings: Settings;
      }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        // Auth token goes via the query-string helper since XHR doesn't run through the
        // ky beforeRequest hook that would otherwise inject the Authorization header.
        xhr.open("POST", appendWebAuthQuery("/api/data/import"));
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        // X-Filename lets the server log the original name (useful for triage); the magic
        // bytes still determine format. Filename is URI-encoded so non-ASCII names survive.
        xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            patchBackupTask({ importProgress: pct });
          }
        };
        xhr.upload.onload = () => {
          // Upload finished, but server is still processing — switch phase so the UI shows
          // the indeterminate "processing" hint instead of stuck-at-100% progress bar.
          patchBackupTask({ importPhase: "processing" });
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText));
            } catch (err) {
              reject(new Error("Invalid server response"));
            }
          } else {
            // Try to surface the server-side error message rather than the raw status code.
            let serverError = `HTTP ${xhr.status}`;
            try {
              const parsed = JSON.parse(xhr.responseText) as { error?: string };
              if (parsed.error) serverError = parsed.error;
            } catch {
              /* keep status code */
            }
            reject(new Error(serverError));
          }
        };
        xhr.onerror = () => reject(new Error(t("settings:data.import_network_error")));
        xhr.onabort = () => reject(new Error(t("settings:data.import_cancelled")));
        // No timeout — large backups may take 10+ minutes through upload + extract + SQLite.
        xhr.timeout = 0;
        xhr.send(file);
      });
      useSettingsStore.getState().setSettings(result.settings);
      if (result.source === "android-zip") {
        const lines = (result.summary ?? []).filter(Boolean);
        toast.success(
          lines.length
            ? t("settings:data.import_android_lines", { lines: lines.join("；") })
            : t("settings:data.import_android"),
        );
      } else {
        toast.success(t("settings:data.import_done"));
      }
      // 安全告警（如导入携带 custom_js 可执行脚本）：停留时间加长，确保用户看到
      for (const warning of result.warnings ?? []) {
        toast.warning(warning, { duration: 15000 });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.import_failed"));
    } finally {
      patchBackupTask({ importing: false, importPhase: "idle", importProgress: 0 });
    }
  };

  return (
    <>
      {ANDROID_COMPAT_CARD_ENABLED ? (
        <AndroidCompatCard schemaStatus={schemaStatus} onSchemaStatus={setSchemaStatus} />
      ) : null}
      <SettingsStack>
      <SettingsGroup
        title={t("settings:data.backup_title")}
        description={t("settings:data.backup_desc")}
      >
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="tertiary"
            size="compact"
            onClick={() => void handleExportClick()}
            disabled={exporting || importing}
          >
            {exporting ? <Loader2 className="animate-spin" /> : <Download />}
            {t("settings:data.export_backup")}
          </Button>
          <Button
            variant="tertiary"
            size="compact"
            onClick={() => importInputRef.current?.click()}
            disabled={importing || exporting}
          >
            {importing ? <Loader2 className="animate-spin" /> : <Upload />}
            {t("settings:data.import_backup")}
          </Button>
          <input
            ref={importInputRef}
            className="sr-only"
            type="file"
            accept="application/json,.json,application/zip,.zip"
            onChange={(event) => void importData(event)}
          />
        </div>
        {exporting ? (
          <BackupProgress
            label={exportTotalBytes > 0 ? t("settings:data.downloading") : t("settings:data.preparing_file")}
            detail={
              exportTotalBytes > 0
                ? t("settings:data.progress_mb", {
                    loaded: (exportedBytes / (1024 * 1024)).toFixed(1),
                    total: (exportTotalBytes / (1024 * 1024)).toFixed(1),
                    percent: exportProgress,
                  })
                : undefined
            }
            percent={exportTotalBytes > 0 ? exportProgress : null}
            hint={exportTotalBytes === 0 ? t("settings:data.pack_slow") : undefined}
          />
        ) : null}
        {importing ? (
          <BackupProgress
            label={
              importPhase === "uploading"
                ? t("settings:data.uploading")
                : importPhase === "processing"
                  ? t("settings:data.extracting")
                  : t("settings:data.preparing")
            }
            detail={importPhase === "uploading" ? t("settings:data.progress_percent", { percent: importProgress }) : undefined}
            percent={importPhase === "uploading" ? importProgress : null}
            hint={importPhase === "processing" ? t("settings:data.extract_slow") : undefined}
          />
        ) : null}
      </SettingsGroup>
        <RestoreReport report={settings.lastRestoreReport} />
        <WebDavBackupCard config={settings.webDavConfig} chatUnsyncable={chatUnsyncable} />
        <S3BackupCard config={settings.s3Config} chatUnsyncable={chatUnsyncable} />
      </SettingsStack>
      {/* 恢复卡自带扫描门控:无缺失时不渲染,放在栈尾不占健康用户的视野 */}
      <AssistantRecoveryCard />
    </>
  );
}

/**
 * 上次云端恢复的降级报告。只在确有跳过/降级时显示(全部成功已有恢复完成 toast,不常驻;
 * 附件去重属正常现象,单独存在不触发)。「知道了」由后端清除,刷新不再出现。
 */
function RestoreReport({ report }: { report: Settings["lastRestoreReport"] }) {
  const { t } = useTranslation();
  const [dismissing, setDismissing] = React.useState(false);
  if (!report || (!report.dbReadError && report.messageNodesUnreadable === 0)) return null;
  const dismiss = async () => {
    setDismissing(true);
    try {
      await api.delete("data/restore-report");
      patchSettingsLocal({ lastRestoreReport: null });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:common.save_failed"));
    } finally {
      setDismissing(false);
    }
  };
  return (
    <Notice
      tone="warning"
      action={
        <Button size="compact" variant="tertiary" disabled={dismissing} onClick={() => void dismiss()}>
          {t("settings:data.restore_report_dismiss")}
        </Button>
      }
    >
      <div className="font-medium">
        {t("settings:data.restore_report_title")} · {new Date(report.finishedAt).toLocaleString()}
      </div>
      <ul className="mt-1.5 list-inside list-disc space-y-0.5">
        {report.dbReadError ? (
          <li>{t("settings:data.restore_report_db_error", { error: report.dbReadError })}</li>
        ) : null}
        {report.messageNodesUnreadable > 0 ? (
          <li>{t("settings:data.restore_report_nodes_skipped", { count: report.messageNodesUnreadable })}</li>
        ) : null}
        {report.filesDeduped > 0 ? (
          <li className="text-[var(--ds-text-secondary)]">
            {t("settings:data.restore_report_files_deduped", { count: report.filesDeduped })}
          </li>
        ) : null}
      </ul>
    </Notice>
  );
}
