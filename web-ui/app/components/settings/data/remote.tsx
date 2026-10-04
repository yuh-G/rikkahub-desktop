// components/settings/data/remote.tsx — 远端备份(WebDAV / S3)共用件:操作按钮 + 进度 + 远端列表。
// 两种远端的操作语义完全相同,只差端点前缀与文案——差异登记在 REMOTE_BACKUP_KINDS,新增一种远端
// = 加一行登记 + 后端同构端点,不再复制一整套处理函数。长任务状态在 backup-task-store(模块级),
// 切页再回来进度与禁用态仍在。

import { useTranslation } from "react-i18next";
import { Check, Download, Loader2, RefreshCw, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import i18n from "~/i18n";
import api, { appendWebAuthQuery } from "~/services/api";
import { useSettingsStore } from "~/stores/app-store";
import { patchRemoteTask, useBackupTaskStore, type RemoteBackupItem, type RemoteKind } from "~/stores/backup-task-store";
import { confirmDialog } from "~/stores/confirm-store";
import type { Settings } from "~/types";
import { SettingsEmpty, SettingsRow, SettingsRows } from "~/components/settings/shared";
import { BackupProgress } from "~/components/settings/data/progress";
import { warnIfNoSchema } from "~/components/settings/data/android-compat";

/** 一种远端的端点前缀与文案键。端点:`data/<prefix>/{list,test,delete}`、`/api/data/<prefix>/{backup,restore}/stream`。 */
interface RemoteBackupKindSpec {
  prefix: string;
  keys: {
    empty: string;
    listFailed: string;
    connOk: string;
    connFailed: string;
    backupDone: string;
    backupFailed: string;
    restoreConfirm: string;
    restored: string;
    restoreFailed: string;
    deleted: string;
    deleteFailed: string;
  };
}

const REMOTE_BACKUP_KINDS: Record<RemoteKind, RemoteBackupKindSpec> = {
  webdav: {
    prefix: "webdav",
    keys: {
      empty: "settings:data.no_remote_backups",
      listFailed: "settings:data.webdav_list_failed",
      connOk: "settings:data.webdav_conn_ok",
      connFailed: "settings:data.webdav_conn_failed",
      backupDone: "settings:data.webdav_backup_done",
      backupFailed: "settings:data.webdav_backup_failed",
      restoreConfirm: "settings:data.restore_confirm",
      restored: "settings:data.webdav_restored",
      restoreFailed: "settings:data.webdav_restore_failed",
      deleted: "settings:data.webdav_deleted",
      deleteFailed: "settings:data.webdav_delete_failed",
    },
  },
  s3: {
    prefix: "s3",
    keys: {
      empty: "settings:data.no_remote_backups_s3",
      listFailed: "settings:data.s3_list_failed",
      connOk: "settings:data.s3_conn_ok",
      connFailed: "settings:data.s3_conn_failed",
      backupDone: "settings:data.s3_backup_done",
      backupFailed: "settings:data.s3_backup_failed",
      restoreConfirm: "settings:data.s3_restore_confirm",
      restored: "settings:data.s3_restored",
      restoreFailed: "settings:data.s3_restore_failed",
      deleted: "settings:data.s3_deleted",
      deleteFailed: "settings:data.s3_delete_failed",
    },
  },
};

/** 读备份 SSE(progress / done / error 三种事件),返回 done 事件的数据。 */
export async function consumeBackupSse(
  url: string,
  onProgress: (message: string, percent: number) => void,
  body?: string,
): Promise<Record<string, unknown>> {
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
        throw new Error(String(data.error ?? i18n.t("settings:data.op_failed")));
      }
    }
  }
  throw new Error(i18n.t("settings:data.conn_closed"));
}

/**
 * 远端备份的操作区:测试连接 / 刷新列表 / 立即备份 + 进度条 + 远端列表(恢复 / 删除)。
 * `ensureSaved` 在操作前把当前配置落盘(仅脏时);`config` 随测试连接一并发送。
 */
export function RemoteBackupPanel({
  kind,
  config,
  ensureSaved,
  canConnect,
  canList,
}: {
  kind: RemoteKind;
  config: unknown;
  ensureSaved: () => Promise<void>;
  /** 测试连接与备份所需的必填项是否齐全。 */
  canConnect: boolean;
  /** 列出远端备份所需的必填项是否齐全。 */
  canList: boolean;
}) {
  const { t } = useTranslation();
  const { prefix, keys } = REMOTE_BACKUP_KINDS[kind];
  const { busy, progress, items } = useBackupTaskStore((state) => state.remote[kind]);

  /** 占住 busy 槽跑一个操作;失败统一 toast。withProgress:备份/恢复带进度条,收尾一并清掉。 */
  const run = async (busyKey: string, failedKey: string, action: () => Promise<void>, withProgress = false) => {
    patchRemoteTask(kind, {
      busy: busyKey,
      ...(withProgress ? { progress: { message: t("settings:data.preparing"), percent: 0 } } : {}),
    });
    try {
      await action();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t(failedKey));
    } finally {
      patchRemoteTask(kind, withProgress ? { busy: "", progress: null } : { busy: "" });
    }
  };
  const onProgress = (message: string, percent: number) => patchRemoteTask(kind, { progress: { message, percent } });

  const refreshList = () =>
    run("list", keys.listFailed, async () => {
      await ensureSaved();
      const result = await api.get<{ items: RemoteBackupItem[] }>(`data/${prefix}/list`, { timeout: false });
      patchRemoteTask(kind, { items: result.items });
    });

  const testConnection = () =>
    run("test", keys.connFailed, async () => {
      await ensureSaved();
      await api.post(`data/${prefix}/test`, { config }, { timeout: false });
      toast.success(t(keys.connOk));
    });

  const backup = async () => {
    await warnIfNoSchema();
    await run(
      "backup",
      keys.backupFailed,
      async () => {
        await ensureSaved();
        const data = await consumeBackupSse(`/api/data/${prefix}/backup/stream`, onProgress);
        if (Array.isArray(data.items)) patchRemoteTask(kind, { items: data.items as RemoteBackupItem[] });
        toast.success(t(keys.backupDone));
      },
      true,
    );
  };

  const restore = async (item: RemoteBackupItem) => {
    if (!(await confirmDialog({ title: t(keys.restoreConfirm, { name: item.displayName }), danger: true }))) return;
    await run(
      `restore:${item.displayName}`,
      keys.restoreFailed,
      async () => {
        const data = await consumeBackupSse(
          `/api/data/${prefix}/restore/stream`,
          onProgress,
          JSON.stringify({ fileName: item.displayName }),
        );
        if (data.settings) useSettingsStore.getState().setSettings(data.settings as Settings);
        toast.success(t(keys.restored));
      },
      true,
    );
  };

  const remove = async (item: RemoteBackupItem) => {
    if (!(await confirmDialog({ title: t("settings:data.delete_confirm", { name: item.displayName }), danger: true }))) return;
    await run(`delete:${item.displayName}`, keys.deleteFailed, async () => {
      const result = await api.post<{ items: RemoteBackupItem[] }>(
        `data/${prefix}/delete`,
        { fileName: item.displayName },
        { timeout: false },
      );
      patchRemoteTask(kind, { items: result.items });
      toast.success(t(keys.deleted));
    });
  };

  return (
    <>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="tertiary"
          size="compact"
          onClick={() => void testConnection()}
          disabled={Boolean(busy) || !canConnect}
        >
          {busy === "test" ? <Loader2 className="animate-spin" /> : <Check />}
          {t("settings:data.test_conn")}
        </Button>
        <Button
          variant="tertiary"
          size="compact"
          onClick={() => void refreshList()}
          disabled={Boolean(busy) || !canList}
        >
          {busy === "list" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {t("settings:data.refresh_backups")}
        </Button>
        <Button size="compact" onClick={() => void backup()} disabled={Boolean(busy) || !canConnect}>
          {busy === "backup" && !progress ? <Loader2 className="animate-spin" /> : <Upload />}
          {t("settings:data.backup_now")}
        </Button>
      </div>
      {(busy === "backup" || busy.startsWith("restore:")) && progress ? (
        <BackupProgress
          label={progress.message}
          detail={progress.percent > 0 ? t("settings:data.progress_percent", { percent: progress.percent }) : undefined}
          percent={progress.percent > 0 ? progress.percent : null}
        />
      ) : null}
      <RemoteBackupList
        items={items}
        busy={busy}
        emptyText={t(keys.empty)}
        onRestore={(item) => void restore(item)}
        onDelete={(item) => void remove(item)}
      />
    </>
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
