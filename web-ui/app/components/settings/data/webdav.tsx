// components/settings/data/webdav.tsx — 备份与恢复 › WebDAV:连接配置(防抖自动保存)+ 远端备份操作。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { StatusBadge } from "~/components/ui/status-badge";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import api from "~/services/api";
import { patchSettingsLocal } from "~/lib/settings-patch";
import type { WebDavConfig } from "~/types";
import { PasswordInput, SettingsField, SettingsGroup } from "~/components/settings/shared";
import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import { RemoteBackupPanel } from "~/components/settings/data/remote";

// WebDAV「设置与会话 / 上传文件」选择:items 字段只被规整、备份流程从不读取(恒为全量备份),
// 复选框等于假开关,先隐藏。后端实现选择性备份后置 true 恢复;字段与文案保留。
const WEBDAV_ITEMS_SELECTION_ENABLED: boolean = false;

export function WebDavBackupCard({ config, chatUnsyncable }: { config: WebDavConfig; chatUnsyncable: boolean }) {
  const { t } = useTranslation();
  const fieldId = React.useId();
  const [webDavDraft, setWebDavDraft] = React.useState<WebDavConfig>(config);
  // R8-2:防抖自动保存统一走共享三件套 hook(保存窗口内键击不丢,语义见 hook 文件头)。
  const webDavAutosave = useAutosaveDraft(
    async () => {
      const result = await api.post<{ config: WebDavConfig }>("data/webdav/config", webDavDraft);
      patchSettingsLocal({ webDavConfig: result.config });
    },
    { onSaveError: (error) => toast.error((error as Error).message || t("settings:data.webdav_autosave_failed")) },
  );

  React.useEffect(() => {
    // 用户正在编辑(含保存窗口内的键击)时不让 settings 回环覆盖草稿——原实现无条件回填,
    // autosave→SSE 一回环就把窗口内新敲的字符当场清掉(R8-2 点名的病根)。
    if (webDavAutosave.isDirty()) return;
    setWebDavDraft(config);
  }, [config.url, config.username, config.password, config.path, JSON.stringify(config.items ?? [])]);

  const patchWebDav = (patch: Partial<WebDavConfig>) => {
    webDavAutosave.markDirty();
    setWebDavDraft({ ...webDavDraft, ...patch });
  };
  const connectable = webDavDraft.url.trim() !== "";

  return (
    <SettingsGroup
      title={
        <span className="flex items-center gap-2">
          {t("settings:data.webdav_title")}
          {chatUnsyncable ? <StatusBadge tone="warning">{t("settings:data.chat_unsyncable")}</StatusBadge> : null}
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
      <RemoteBackupPanel
        kind="webdav"
        config={webDavDraft}
        ensureSaved={() => webDavAutosave.saveNow()}
        canConnect={connectable}
        canList={connectable}
      />
    </SettingsGroup>
  );
}
