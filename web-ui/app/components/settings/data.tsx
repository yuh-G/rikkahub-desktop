// components/settings/data.tsx — 数据管理两页:备份与恢复(本地 / WebDAV / S3)、Web 服务(访问密码)。

import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Notice } from "~/components/ui/notice";
import { Progress } from "~/components/ui/progress";
import { StatusBadge } from "~/components/ui/status-badge";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import api, { appendWebAuthQuery, clearWebAuthToken, fetchWebAuthStatus, requestWebAuthToken, setWebPassword, type WebAuthStatus } from "~/services/api";
import { isTauriEnvironment } from "~/lib/system-info";
import { patchSettingsLocal } from "~/lib/settings-patch";
import { useSettingsStore } from "~/stores/app-store";
import { patchBackupTask, patchRemoteTask, useBackupTaskStore, type RemoteBackupItem } from "~/stores/backup-task-store";
import { confirmDialog } from "~/stores/confirm-store";
import type { S3Config, Settings, WebDavConfig } from "~/types";
import {
  PasswordInput,
  SettingsEmpty,
  SettingsField,
  SettingsGroup,
  SettingsRow,
  SettingsRows,
  SettingsStack,
  SettingsSwitchRow,
} from "~/components/settings/shared";

import { AutosaveStatusRow } from "~/components/settings/autosave-status";

interface AndroidSchemaStatus {
  hasAndroidSchema: boolean;
  schemaInfo: { identityHash: string; version: number } | null;
  conversationCount: number;
}

// 专题3 批3(T-1)之后,PC 内置安卓 Room schema v24,备份恒含对话记录,"手机端适配"
// 注册流程不再是必要步骤。整套 UI(卡片 + 导出弹窗"未注册"分支 + WebDAV/S3"对话不可
// 同步"徽章)从界面隐藏但代码完整保留:后端 data/register-schema 端点与本组件的上传/
// 状态逻辑原样在,未来若需重新引导用户注册(例如换底座到更高版本 schema),翻此开关即回。
const ANDROID_COMPAT_CARD_ENABLED: boolean = false;

// WebDAV「设置与会话 / 上传文件」选择:items 字段只被规整、备份流程从不读取(恒为全量备份),
// 复选框等于假开关,先隐藏。后端实现选择性备份后置 true 恢复;字段与文案保留。
const WEBDAV_ITEMS_SELECTION_ENABLED: boolean = false;

// A 族闪动修复:schemaStatus 上次已知值缓存(内存 + localStorage 镜像)。
// 病根:该状态挂载后异步 GET,首帧 null 曾被当"未注册"渲染 —— 安卓兼容卡片以
// "琥珀徽章+注册表单全展开"闪现,查询返回后收起(用户报告的"卡片式展开→恢复")。
// 修法:①首帧用上次已知值播种(stale-while-revalidate,权威仍是接口返回);
// ②真未知(首次访问)时未知态不渲染徽章/表单,只留标题行,消灭"先画错再纠正"。
const SCHEMA_STATUS_MIRROR_KEY = "rikkahub.schema-status.mirror.v1";

let schemaStatusCache: AndroidSchemaStatus | null = (() => {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(SCHEMA_STATUS_MIRROR_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof (parsed as AndroidSchemaStatus).hasAndroidSchema !== "boolean") return null;
    return parsed as AndroidSchemaStatus;
  } catch {
    return null;
  }
})();

function rememberSchemaStatus(status: AndroidSchemaStatus): void {
  schemaStatusCache = status;
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SCHEMA_STATUS_MIRROR_KEY, JSON.stringify(status));
  } catch {
    /* 尽力而为的缓存,失败静默 */
  }
}

/** 数据管理 › 备份与恢复:本地备份与恢复、上次云端恢复报告、WebDAV、S3。 */
export function BackupSection({
  settings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const fieldId = React.useId();
  const importInputRef = React.useRef<HTMLInputElement>(null);
  const schemaInputRef = React.useRef<HTMLInputElement>(null);
  // 长任务状态在模块级 store(见 backup-task-store):切到别的页再回来,进度与禁用态仍在。
  const task = useBackupTaskStore();
  const { exporting, importing, importPhase, importProgress } = task;
  const exportedBytes = task.exportLoaded;
  const exportTotalBytes = task.exportTotal;
  const exportProgress = exportTotalBytes > 0 ? Math.round((exportedBytes / exportTotalBytes) * 100) : 0;
  const webDavBusy = task.remote.webdav.busy;
  const webDavBackupProgress = task.remote.webdav.progress;
  const webDavItems = task.remote.webdav.items;
  const s3Busy = task.remote.s3.busy;
  const s3BackupProgress = task.remote.s3.progress;
  const s3Items = task.remote.s3.items;

  // 缓存播种 + 写穿透(下方 effect):所有 setSchemaStatus 调用点(挂载 GET/导出前刷新/
  // 注册成功)的结果统一落缓存,回访零闪动。
  const [schemaStatus, setSchemaStatus] = React.useState<AndroidSchemaStatus | null>(
    schemaStatusCache,
  );
  const [registeringSchema, setRegisteringSchema] = React.useState(false);
  const [schemaExpanded, setSchemaExpanded] = React.useState(false);
  // webDavConfig/s3Config 由服务端 normalizeState 保证在场且默认值同源,类型单源后无需兜底。
  const defaultWebDav = settings.webDavConfig;
  const [webDavDraft, setWebDavDraft] = React.useState<WebDavConfig>(defaultWebDav);
  // R8-2:防抖自动保存统一走共享三件套 hook(保存窗口内键击不丢,语义见 hook 文件头)。
  const webDavAutosave = useAutosaveDraft(
    async () => {
      const result = await api.post<{ config: WebDavConfig }>("data/webdav/config", webDavDraft);
      patchSettingsLocal({ webDavConfig: result.config });
    },
    { onSaveError: (error) => toast.error((error as Error).message || t("settings:data.webdav_autosave_failed")) },
  );

  const defaultS3 = settings.s3Config;
  const [s3Draft, setS3Draft] = React.useState<S3Config>(defaultS3);

  const s3Autosave = useAutosaveDraft(
    async () => {
      const result = await api.post<{ config: S3Config }>("data/s3/config", s3Draft);
      patchSettingsLocal({ s3Config: result.config });
    },
    { onSaveError: (error) => toast.error((error as Error).message || t("settings:data.s3_autosave_failed")) },
  );

  React.useEffect(() => {
    // 用户正在编辑(含保存窗口内的键击)时不让 settings 回环覆盖草稿——原实现无条件回填,
    // autosave→SSE 一回环就把窗口内新敲的字符当场清掉(R8-2 点名的病根)。
    if (webDavAutosave.isDirty()) return;
    setWebDavDraft(defaultWebDav);
  }, [
    defaultWebDav.url,
    defaultWebDav.username,
    defaultWebDav.password,
    defaultWebDav.path,
    JSON.stringify(defaultWebDav.items ?? []),
  ]);

  React.useEffect(() => {
    fetch(appendWebAuthQuery("/api/data/export/status"))
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (s) setSchemaStatus(s);
      })
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    if (schemaStatus) rememberSchemaStatus(schemaStatus);
  }, [schemaStatus]);

  const consumeBackupSse = async (
    url: string,
    onProgress: (message: string, percent: number) => void,
    body?: string,
  ) => {
    const response = await fetch(appendWebAuthQuery(url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: body ?? undefined,
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      throw new Error(text || `HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\n\n+/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const eventName =
          block
            .split(/\r?\n/)
            .find((line) => line.startsWith("event:"))
            ?.slice(6)
            .trim() ?? "message";
        const dataText = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!dataText) continue;
        const data = JSON.parse(dataText) as Record<string, unknown>;
        if (eventName === "progress") {
          onProgress(String(data.message ?? ""), Number(data.percent ?? 0));
        } else if (eventName === "done") {
          return data;
        } else if (eventName === "error") {
          throw new Error(String(data.error ?? t("settings:data.op_failed")));
        }
      }
    }
    throw new Error(t("settings:data.conn_closed"));
  };

  const patchWebDav = (patch: Partial<WebDavConfig>) => {
    webDavAutosave.markDirty();
    setWebDavDraft({ ...webDavDraft, ...patch });
  };

  // 列表/测试/备份前的"确保已保存"(仅脏时落盘,语义同原 announce=false)。
  const saveWebDav = () => webDavAutosave.saveNow();

  const refreshWebDavList = async () => {
    patchRemoteTask("webdav", { busy: "list" });
    try {
      await saveWebDav();
      const result = await api.get<{ items: RemoteBackupItem[] }>("data/webdav/list", {
        timeout: false,
      });
      patchRemoteTask("webdav", { items: result.items });
    } catch (error) {
      // 7-3:与 refreshS3List 对齐,失败不再静默
      toast.error(error instanceof Error ? error.message : t("settings:data.webdav_list_failed"));
    } finally {
      patchRemoteTask("webdav", { busy: "" });
    }
  };

  const testWebDav = async () => {
    patchRemoteTask("webdav", { busy: "test" });
    try {
      await saveWebDav();
      await api.post("data/webdav/test", { config: webDavDraft }, { timeout: false });
      toast.success(t("settings:data.webdav_conn_ok"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.webdav_conn_failed"));
    } finally {
      patchRemoteTask("webdav", { busy: "" });
    }
  };

  // 只在安卓兼容卡启用时提示:hasAndroidSchema 只看缓存库是否存在,而导出在无缓存库时用内置
  // schema 建库,备份照样含对话——卡片关闭(现状)时这条提示对纯 PC 用户是误报。
  const warnIfNoSchema = async () => {
    if (!ANDROID_COMPAT_CARD_ENABLED) return;
    try {
      const res = await fetch(appendWebAuthQuery("/api/data/export/status"));
      if (res.ok) {
        const s = await res.json();
        if (!s.hasAndroidSchema && s.conversationCount > 0) {
          toast(t("settings:data.no_schema_warn"), { duration: 6000 });
        }
      }
    } catch {
      /* 提示是尽力而为:状态查询失败不阻断备份 */
    }
  };

  const backupWebDav = async () => {
    await warnIfNoSchema();
    patchRemoteTask("webdav", { busy: "backup", progress: { message: t("settings:data.preparing"), percent: 0 } });
    try {
      await saveWebDav();
      const data = await consumeBackupSse("/api/data/webdav/backup/stream", (message, percent) => {
        patchRemoteTask("webdav", { progress: { message, percent } });
      });
      if (Array.isArray(data.items)) patchRemoteTask("webdav", { items: data.items as RemoteBackupItem[] });
      toast.success(t("settings:data.webdav_backup_done"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.webdav_backup_failed"));
    } finally {
      patchRemoteTask("webdav", { busy: "", progress: null });
    }
  };

  const restoreWebDav = async (item: RemoteBackupItem) => {
    if (!(await confirmDialog({ title: t("settings:data.restore_confirm", { name: item.displayName }), danger: true }))) return;
    patchRemoteTask("webdav", { busy: `restore:${item.displayName}`, progress: { message: t("settings:data.preparing"), percent: 0 } });
    try {
      const data = await consumeBackupSse(
        "/api/data/webdav/restore/stream",
        (message, percent) => {
          patchRemoteTask("webdav", { progress: { message, percent } });
        },
        JSON.stringify({ fileName: item.displayName }),
      );
      if (data.settings) useSettingsStore.getState().setSettings(data.settings as Settings);
      toast.success(t("settings:data.webdav_restored"));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("settings:data.webdav_restore_failed"),
      );
    } finally {
      patchRemoteTask("webdav", { busy: "", progress: null });
    }
  };

  const deleteWebDav = async (item: RemoteBackupItem) => {
    if (!(await confirmDialog({ title: t("settings:data.delete_confirm", { name: item.displayName }), danger: true }))) return;
    patchRemoteTask("webdav", { busy: `delete:${item.displayName}` });
    try {
      const result = await api.post<{ items: RemoteBackupItem[] }>(
        "data/webdav/delete",
        { fileName: item.displayName },
        { timeout: false },
      );
      patchRemoteTask("webdav", { items: result.items });
      toast.success(t("settings:data.webdav_deleted"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.webdav_delete_failed"));
    } finally {
      patchRemoteTask("webdav", { busy: "" });
    }
  };

  React.useEffect(() => {
    // 同 WebDAV:编辑中不让 settings 回环覆盖草稿。
    if (s3Autosave.isDirty()) return;
    setS3Draft(defaultS3);
  }, [
    defaultS3.endpoint,
    defaultS3.region,
    defaultS3.accessKeyId,
    defaultS3.secretAccessKey,
    defaultS3.bucket,
    defaultS3.pathStyle,
    JSON.stringify(defaultS3.items ?? []),
  ]);

  const patchS3 = (patch: Partial<S3Config>) => {
    s3Autosave.markDirty();
    setS3Draft({ ...s3Draft, ...patch });
  };
  // 列表/测试/备份前的"确保已保存"(仅脏时落盘,语义同原 announce=false)。
  const saveS3 = () => s3Autosave.saveNow();
  const refreshS3List = async () => {
    patchRemoteTask("s3", { busy: "list" });
    try {
      await saveS3();
      const result = await api.get<{ items: RemoteBackupItem[] }>("data/s3/list", { timeout: false });
      patchRemoteTask("s3", { items: result.items });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.s3_list_failed"));
    } finally {
      patchRemoteTask("s3", { busy: "" });
    }
  };
  const testS3 = async () => {
    patchRemoteTask("s3", { busy: "test" });
    try {
      await saveS3();
      await api.post("data/s3/test", { config: s3Draft }, { timeout: false });
      toast.success(t("settings:data.s3_conn_ok"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.s3_conn_failed"));
    } finally {
      patchRemoteTask("s3", { busy: "" });
    }
  };
  const backupS3 = async () => {
    await warnIfNoSchema();
    patchRemoteTask("s3", { busy: "backup", progress: { message: t("settings:data.preparing"), percent: 0 } });
    try {
      await saveS3();
      const data = await consumeBackupSse("/api/data/s3/backup/stream", (message, percent) => {
        patchRemoteTask("s3", { progress: { message, percent } });
      });
      if (Array.isArray(data.items)) patchRemoteTask("s3", { items: data.items as RemoteBackupItem[] });
      toast.success(t("settings:data.s3_backup_done"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.s3_backup_failed"));
    } finally {
      patchRemoteTask("s3", { busy: "", progress: null });
    }
  };
  const restoreS3 = async (item: RemoteBackupItem) => {
    if (!(await confirmDialog({ title: t("settings:data.s3_restore_confirm", { name: item.displayName }), danger: true }))) return;
    patchRemoteTask("s3", { busy: `restore:${item.displayName}`, progress: { message: t("settings:data.preparing"), percent: 0 } });
    try {
      const data = await consumeBackupSse(
        "/api/data/s3/restore/stream",
        (message, percent) => {
          patchRemoteTask("s3", { progress: { message, percent } });
        },
        JSON.stringify({ fileName: item.displayName }),
      );
      if (data.settings) useSettingsStore.getState().setSettings(data.settings as Settings);
      toast.success(t("settings:data.s3_restored"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.s3_restore_failed"));
    } finally {
      patchRemoteTask("s3", { busy: "", progress: null });
    }
  };
  const deleteS3 = async (item: RemoteBackupItem) => {
    if (!(await confirmDialog({ title: t("settings:data.delete_confirm", { name: item.displayName }), danger: true }))) return;
    patchRemoteTask("s3", { busy: `delete:${item.displayName}` });
    try {
      const result = await api.post<{ items: RemoteBackupItem[] }>(
        "data/s3/delete",
        { fileName: item.displayName },
        { timeout: false },
      );
      patchRemoteTask("s3", { items: result.items });
      toast.success(t("settings:data.s3_deleted"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.s3_delete_failed"));
    } finally {
      patchRemoteTask("s3", { busy: "" });
    }
  };

  // 导出前确认走全局 confirmDialog:它挂在 root、z 序在设置模态之上。此前手写的
  // fixed 遮罩渲染在模态 DialogContent 内部,而 DialogContent 带 transform(成为 fixed 的
  // 包含块)+ overflow-hidden——遮罩被困在面板里,且按 Esc 关掉的是整个设置模态。
  const handleExportClick = async () => {
    // 描述里的对话数用这里取回的局部值:setSchemaStatus 是异步的,读 state 会拿到旧值。
    let status = schemaStatus;
    try {
      const res = await fetch(appendWebAuthQuery("/api/data/export/status"));
      if (res.ok) {
        status = (await res.json()) as AndroidSchemaStatus;
        setSchemaStatus(status);
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

  const handleRegisterSchema = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setRegisteringSchema(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(appendWebAuthQuery("/api/data/register-schema"), {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("settings:data.register_failed"));
      setSchemaStatus((prev) =>
        prev
          ? { ...prev, hasAndroidSchema: true, schemaInfo: data.schemaInfo }
          : { hasAndroidSchema: true, schemaInfo: data.schemaInfo, conversationCount: 0 },
      );
      toast.success(
        t("settings:data.register_ok", {
          version: data.schemaInfo.version,
          hash: data.schemaInfo.identityHash.slice(0, 8),
        }),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings:data.register_failed"));
    } finally {
      setRegisteringSchema(false);
    }
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
      {ANDROID_COMPAT_CARD_ENABLED && (
      <div className="mb-4 rounded-lg border p-4">
        <div
          className="flex items-center gap-2 cursor-pointer"
          onClick={() => schemaStatus?.hasAndroidSchema && setSchemaExpanded(!schemaExpanded)}
        >
          <div className="text-sm font-medium">{t("settings:data.android_compat")}</div>
          {/* 未知态(schemaStatus null)不渲染任何徽章:不再把"还没查到"画成"未注册" */}
          {schemaStatus &&
            (schemaStatus.hasAndroidSchema ? (
              <StatusBadge tone="success">{t("settings:data.ready")}</StatusBadge>
            ) : (
              <StatusBadge tone="warning">{t("settings:data.unregistered")}</StatusBadge>
            ))}
          {schemaStatus?.hasAndroidSchema && (
            <span className="ml-auto text-xs text-muted-foreground">
              {schemaExpanded ? t("settings:data.collapse") : t("settings:data.expand")}
            </span>
          )}
        </div>
        {schemaStatus?.hasAndroidSchema && !schemaExpanded && (
          <div className="mt-2 text-xs text-muted-foreground">
            {t("settings:data.compat_summary", {
              version: schemaStatus.schemaInfo?.version,
              hash: schemaStatus.schemaInfo?.identityHash.slice(0, 8),
            })}
          </div>
        )}
        {schemaStatus && (!schemaStatus.hasAndroidSchema || schemaExpanded) && (
          <div className="mt-2 space-y-2">
            {!schemaStatus?.hasAndroidSchema && (
              <div
                className="text-xs text-muted-foreground"
                dangerouslySetInnerHTML={{ __html: t("settings:data.unregistered_warn") }}
              />
            )}
            {schemaStatus?.hasAndroidSchema && (
              <div className="text-xs text-muted-foreground">
                {t("settings:data.current_format", {
                  version: schemaStatus.schemaInfo?.version,
                  hash: schemaStatus.schemaInfo?.identityHash.slice(0, 8),
                })}
              </div>
            )}
            <Notice tone="warning" className="block">
              <div className="font-medium">
                {schemaStatus?.hasAndroidSchema
                  ? t("settings:data.update_format")
                  : t("settings:data.how_to_register")}
              </div>
              <ol className="mt-1.5 list-inside list-decimal space-y-1 text-[var(--ds-text-secondary)]">
                <li>{t("settings:data.step1")}</li>
                <li>{t("settings:data.step2")}</li>
                <li>{t("settings:data.step3")}</li>
              </ol>
              <div className="mt-2 font-semibold">
                {t("settings:data.register_note")}
              </div>
              <Button
                variant="tertiary"
                size="compact"
                className="mt-3"
                onClick={() => schemaInputRef.current?.click()}
                disabled={registeringSchema}
              >
                {registeringSchema ? <Loader2 className="animate-spin" /> : <Upload />}
                {t("settings:data.upload_phone_backup")}
              </Button>
              <input
                ref={schemaInputRef}
                className="sr-only"
                type="file"
                accept="application/zip,.zip"
                onChange={(e) => void handleRegisterSchema(e)}
              />
            </Notice>
          </div>
        )}
      </div>
      )}
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
        <SettingsGroup
          title={
            <span className="flex items-center gap-2">
              {t("settings:data.webdav_title")}
              {ANDROID_COMPAT_CARD_ENABLED && schemaStatus && !schemaStatus.hasAndroidSchema && (
                <StatusBadge tone="warning">{t("settings:data.chat_unsyncable")}</StatusBadge>
              )}
            </span>
          }
          description={t("settings:data.webdav_desc")}
          action={<AutosaveStatusRow status={webDavAutosave.status} onRetry={() => void webDavAutosave.saveNow()} />}
        >
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <SettingsField label={t("settings:data.server_url")} htmlFor={`${fieldId}-dav-url`}>
              <Input
                id={`${fieldId}-dav-url`}
                value={webDavDraft.url}
                onChange={(event) => patchWebDav({ url: event.target.value })}
                placeholder="https://example.com/dav"
              />
            </SettingsField>
            <SettingsField label={t("settings:data.backup_path")} htmlFor={`${fieldId}-dav-path`}>
              <Input
                id={`${fieldId}-dav-path`}
                value={webDavDraft.path}
                onChange={(event) => patchWebDav({ path: event.target.value })}
                placeholder="rikkahub_backups"
              />
            </SettingsField>
            <SettingsField label={t("settings:data.username")} htmlFor={`${fieldId}-dav-user`}>
              <Input
                id={`${fieldId}-dav-user`}
                value={webDavDraft.username}
                onChange={(event) => patchWebDav({ username: event.target.value })}
              />
            </SettingsField>
            <SettingsField label={t("settings:data.password")} htmlFor={`${fieldId}-dav-pw`}>
              <PasswordInput
                id={`${fieldId}-dav-pw`}
                value={webDavDraft.password}
                onChange={(password) => patchWebDav({ password })}
              />
            </SettingsField>
          </div>
          {WEBDAV_ITEMS_SELECTION_ENABLED ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {(["DATABASE", "FILES"] as const).map((item) => (
              <label
                key={item}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <Checkbox
                  checked={(webDavDraft.items ?? []).includes(item)}
                  onCheckedChange={(checked) => {
                    const items = new Set(webDavDraft.items ?? []);
                    if (checked) items.add(item);
                    else items.delete(item);
                    patchWebDav({ items: [...items] });
                  }}
                />
                {item === "DATABASE"
                  ? t("settings:data.item_database")
                  : t("settings:data.item_files")}
              </label>
            ))}
          </div>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="tertiary"
              size="compact"
              onClick={() => void testWebDav()}
              disabled={Boolean(webDavBusy) || !webDavDraft.url.trim()}
            >
              {webDavBusy === "test" ? <Loader2 className="animate-spin" /> : <Check />}
              {t("settings:data.test_conn")}
            </Button>
            <Button
              variant="tertiary"
              size="compact"
              onClick={() => void refreshWebDavList()}
              disabled={Boolean(webDavBusy) || !webDavDraft.url.trim()}
            >
              {webDavBusy === "list" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t("settings:data.refresh_backups")}
            </Button>
            <Button
              size="compact"
              onClick={() => void backupWebDav()}
              disabled={Boolean(webDavBusy) || !webDavDraft.url.trim()}
            >
              {webDavBusy === "backup" && !webDavBackupProgress ? <Loader2 className="animate-spin" /> : <Upload />}
              {t("settings:data.backup_now")}
            </Button>
          </div>
          {(webDavBusy === "backup" || webDavBusy.startsWith("restore:")) && webDavBackupProgress ? (
            <BackupProgress
              label={webDavBackupProgress.message}
              detail={
                webDavBackupProgress.percent > 0
                  ? t("settings:data.progress_percent", { percent: webDavBackupProgress.percent })
                  : undefined
              }
              percent={webDavBackupProgress.percent > 0 ? webDavBackupProgress.percent : null}
            />
          ) : null}
          <RemoteBackupList
            items={webDavItems}
            busy={webDavBusy}
            emptyText={t("settings:data.no_remote_backups")}
            onRestore={(item) => void restoreWebDav(item)}
            onDelete={(item) => void deleteWebDav(item)}
          />
        </SettingsGroup>
        <SettingsGroup
          title={
            <span className="flex items-center gap-2">
              {t("settings:data.s3_title")}
              {ANDROID_COMPAT_CARD_ENABLED && schemaStatus && !schemaStatus.hasAndroidSchema && (
                <StatusBadge tone="warning">{t("settings:data.chat_unsyncable")}</StatusBadge>
              )}
            </span>
          }
          description={t("settings:data.s3_desc")}
          action={<AutosaveStatusRow status={s3Autosave.status} onRetry={() => void s3Autosave.saveNow()} />}
        >
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <SettingsField label={t("settings:data.endpoint_label")} htmlFor={`${fieldId}-s3-endpoint`}>
              <Input
                id={`${fieldId}-s3-endpoint`}
                value={s3Draft.endpoint}
                onChange={(event) => patchS3({ endpoint: event.target.value })}
                placeholder="https://s3.example.com"
              />
            </SettingsField>
            <SettingsField label={t("settings:data.s3.region")} htmlFor={`${fieldId}-s3-region`}>
              <Input
                id={`${fieldId}-s3-region`}
                value={s3Draft.region}
                onChange={(event) => patchS3({ region: event.target.value })}
                placeholder="auto"
              />
            </SettingsField>
            <SettingsField label={t("settings:data.s3.bucket")} htmlFor={`${fieldId}-s3-bucket`}>
              <Input
                id={`${fieldId}-s3-bucket`}
                value={s3Draft.bucket}
                onChange={(event) => patchS3({ bucket: event.target.value })}
                placeholder="my-rikkahub-bucket"
              />
            </SettingsField>
            <SettingsField label={t("settings:data.s3.access_key_id")} htmlFor={`${fieldId}-s3-akid`}>
              <Input
                id={`${fieldId}-s3-akid`}
                value={s3Draft.accessKeyId}
                onChange={(event) => patchS3({ accessKeyId: event.target.value })}
              />
            </SettingsField>
            <SettingsField label={t("settings:data.s3.secret_access_key")} htmlFor={`${fieldId}-s3-secret`}>
              <PasswordInput
                id={`${fieldId}-s3-secret`}
                value={s3Draft.secretAccessKey}
                onChange={(secretAccessKey) => patchS3({ secretAccessKey })}
              />
            </SettingsField>
          </div>
          {/* 配置项放正文:标题行 action 槽只留状态,开关挤在那里难发现。 */}
          <SettingsRows className="mt-2">
            <SettingsSwitchRow
              label={t("settings:data.s3.path_style")}
              description={t("settings:data.s3.path_style_desc")}
              checked={s3Draft.pathStyle}
              onCheckedChange={(pathStyle) => patchS3({ pathStyle })}
            />
          </SettingsRows>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="tertiary"
              size="compact"
              onClick={() => void testS3()}
              disabled={Boolean(s3Busy) || !s3Draft.bucket.trim() || !s3Draft.accessKeyId.trim()}
            >
              {s3Busy === "test" ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
              {t("settings:data.test_conn")}
            </Button>
            <Button
              variant="tertiary"
              size="compact"
              onClick={() => void refreshS3List()}
              disabled={Boolean(s3Busy) || !s3Draft.bucket.trim()}
            >
              {s3Busy === "list" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t("settings:data.refresh_backups")}
            </Button>
            <Button
              size="compact"
              onClick={() => void backupS3()}
              disabled={Boolean(s3Busy) || !s3Draft.bucket.trim() || !s3Draft.accessKeyId.trim()}
            >
              {s3Busy === "backup" && !s3BackupProgress ? <Loader2 className="animate-spin" /> : <Upload />}
              {t("settings:data.backup_now")}
            </Button>
          </div>
          {(s3Busy === "backup" || s3Busy.startsWith("restore:")) && s3BackupProgress ? (
            <BackupProgress
              label={s3BackupProgress.message}
              detail={
                s3BackupProgress.percent > 0
                  ? t("settings:data.progress_percent", { percent: s3BackupProgress.percent })
                  : undefined
              }
              percent={s3BackupProgress.percent > 0 ? s3BackupProgress.percent : null}
            />
          ) : null}
          <RemoteBackupList
            items={s3Items}
            busy={s3Busy}
            emptyText={t("settings:data.no_remote_backups_s3")}
            onRestore={(item) => void restoreS3(item)}
            onDelete={(item) => void deleteS3(item)}
          />
        </SettingsGroup>
      </SettingsStack>
    </>
  );
}

/** 长任务进度:标题行(阶段文案 + 读数)+ 细进度条;percent 为 null 时为不确定态。 */
function BackupProgress({
  label,
  detail,
  percent,
  hint,
}: {
  label: React.ReactNode;
  detail?: React.ReactNode;
  percent: number | null;
  hint?: React.ReactNode;
}) {
  return (
    <div className="mt-3 space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-xs text-[var(--ds-text-secondary)]">
        <span className="min-w-0 truncate">{label}</span>
        {detail != null ? <span className="shrink-0 tabular-nums">{detail}</span> : null}
      </div>
      <Progress value={percent} />
      {hint != null ? <div className="text-mini text-[var(--ds-text-tertiary)]">{hint}</div> : null}
    </div>
  );
}

/** WebDAV / S3 共用的远端备份列表:行式无边框,右侧「恢复」与删除图标。 */
function RemoteBackupList({
  items,
  busy,
  emptyText,
  onRestore,
  onDelete,
}: {
  items: RemoteBackupItem[];
  busy: string;
  emptyText: string;
  onRestore: (item: RemoteBackupItem) => void;
  onDelete: (item: RemoteBackupItem) => void;
}) {
  const { t } = useTranslation();
  if (items.length === 0) {
    return (
      <SettingsEmpty className="mt-4">{emptyText}</SettingsEmpty>
    );
  }
  return (
    <SettingsRows className="mt-3">
      {items.map((item) => (
        <SettingsRow
          key={item.displayName}
          label={<span className="block truncate">{item.displayName}</span>}
          description={
            <span className="tabular-nums">
              {new Date(item.lastModified || 0).toLocaleString()} · {Math.round((item.size || 0) / 1024)} KB
            </span>
          }
          control={
            <>
              <Button
                type="button"
                size="compact"
                variant="tertiary"
                onClick={() => onRestore(item)}
                disabled={Boolean(busy)}
              >
                {busy === `restore:${item.displayName}` ? <Loader2 className="animate-spin" /> : <Download />}
                {t("settings:data.restore")}
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="text-[var(--ds-icon)] hover:text-[var(--ds-danger)]"
                onClick={() => onDelete(item)}
                disabled={Boolean(busy)}
                aria-label={t("settings:data.delete_backup")}
                title={t("settings:data.delete_backup")}
              >
                {busy === `delete:${item.displayName}` ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Trash2 className="size-4" />
                )}
              </Button>
            </>
          }
        />
      ))}
    </SettingsRows>
  );
}

/** 数据管理 › Web 服务:访问密码。对外暴露(Docker/反代)时必备。 */
export function WebServiceSection({ settings }: { settings: Settings; onSettings: (settings: Settings) => void }) {
  const { t } = useTranslation();
  // —— 访问密码(P1):状态经独立端点 /api/web-auth/status(只回布尔,不含哈希)。——
  const [webAuthStatus, setWebAuthStatus] = React.useState<WebAuthStatus | null>(null);
  const [webPwCurrent, setWebPwCurrent] = React.useState("");
  const [webPwNew, setWebPwNew] = React.useState("");
  const [webPwBusy, setWebPwBusy] = React.useState(false);
  const refreshWebAuthStatus = React.useCallback(async () => {
    try {
      setWebAuthStatus(await fetchWebAuthStatus());
    } catch {
      // 状态探测失败(网络抖动)→ 保持现状,密码表单按已有 settings.webServerJwtEnabled 兜底显示。
    }
  }, []);
  React.useEffect(() => {
    void refreshWebAuthStatus();
  }, [refreshWebAuthStatus]);
  const webAuthConfigured = webAuthStatus?.configured ?? settings.webServerJwtEnabled === true;
  const submitWebPassword = React.useCallback(
    async (clear: boolean) => {
      if (webPwBusy) return;
      setWebPwBusy(true);
      try {
        await setWebPassword({
          currentPassword: webAuthConfigured ? webPwCurrent : undefined,
          newPassword: clear ? "" : webPwNew,
        });
        // 改/设密码后旧 token 已失效:立刻用新密码换发,避免下次请求 401 弹登录墙的假锁定。
        // 清密码则清掉本地 token。
        if (clear) clearWebAuthToken();
        else await requestWebAuthToken(webPwNew);
        setWebPwCurrent("");
        setWebPwNew("");
        await refreshWebAuthStatus();
        patchSettingsLocal({ webServerJwtEnabled: !clear });
        toast.success(t(clear ? "settings:data.web_password_cleared" : "settings:data.web_password_saved"));
      } catch (error) {
        toast.error((error as Error).message || t("settings:data.web_password_failed"));
      } finally {
        setWebPwBusy(false);
      }
    },
    [webPwBusy, webAuthConfigured, webPwCurrent, webPwNew, refreshWebAuthStatus, t],
  );

  return (
    <SettingsStack>
      <SettingsGroup
        title={t("settings:data.web_password_title")}
        description={t("settings:data.web_password_desc")}
        action={
          <StatusBadge tone={webAuthConfigured ? "success" : "neutral"}>
            {webAuthConfigured ? t("settings:data.enabled") : t("settings:data.disabled")}
          </StatusBadge>
        }
      >
        {/* 访问密码(P1):对外暴露(Docker/反代)时必备。部署者锁定(argv/env)时只读提示;
            否则就地设/改/清。密码存派生哈希,这里只见布尔状态。 */}
        {webAuthStatus?.lockedByDeployment ? (
          <Notice className="mt-3">{t("settings:data.web_password_locked")}</Notice>
        ) : (
          <div className="mt-3 max-w-md space-y-2">
            {webAuthConfigured ? (
              <PasswordInput
                value={webPwCurrent}
                onChange={setWebPwCurrent}
                placeholder={t("settings:data.web_password_current")}
                aria-label={t("settings:data.web_password_current")}
              />
            ) : null}
            <PasswordInput
              value={webPwNew}
              onChange={setWebPwNew}
              placeholder={
                webAuthConfigured
                  ? t("settings:data.web_password_new")
                  : t("settings:data.web_password_set")
              }
              aria-label={
                webAuthConfigured
                  ? t("settings:data.web_password_new")
                  : t("settings:data.web_password_set")
              }
            />
            <div className="flex items-center gap-2 pt-1">
              <Button
                size="compact"
                disabled={webPwBusy || (webAuthConfigured ? !webPwCurrent || !webPwNew : !webPwNew)}
                onClick={() => void submitWebPassword(false)}
              >
                {webAuthConfigured
                  ? t("settings:data.web_password_change")
                  : t("settings:data.web_password_set_action")}
              </Button>
              {webAuthConfigured ? (
                <Button
                  size="compact"
                  variant="danger"
                  disabled={webPwBusy || !webPwCurrent}
                  onClick={() => void submitWebPassword(true)}
                >
                  {t("settings:data.web_password_clear")}
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </SettingsGroup>
    </SettingsStack>
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
