// components/settings/data/s3.tsx — 备份与恢复 › S3:连接配置(防抖自动保存)+ 远端备份操作。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Input } from "~/components/ui/input";
import { StatusBadge } from "~/components/ui/status-badge";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import api from "~/services/api";
import { patchSettingsLocal } from "~/lib/settings-patch";
import type { S3Config } from "~/types";
import { PasswordInput, SettingsField, SettingsGroup, SettingsRows, SettingsSwitchRow } from "~/components/settings/shared";
import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import { RemoteBackupPanel } from "~/components/settings/data/remote";

export function S3BackupCard({ config, chatUnsyncable }: { config: S3Config; chatUnsyncable: boolean }) {
  const { t } = useTranslation();
  const fieldId = React.useId();
  const [s3Draft, setS3Draft] = React.useState<S3Config>(config);
  const s3Autosave = useAutosaveDraft(
    async () => {
      const result = await api.post<{ config: S3Config }>("data/s3/config", s3Draft);
      patchSettingsLocal({ s3Config: result.config });
    },
    { onSaveError: (error) => toast.error((error as Error).message || t("settings:data.s3_autosave_failed")) },
  );

  React.useEffect(() => {
    // 同 WebDAV:编辑中不让 settings 回环覆盖草稿。
    if (s3Autosave.isDirty()) return;
    setS3Draft(config);
  }, [
    config.endpoint,
    config.region,
    config.accessKeyId,
    config.secretAccessKey,
    config.bucket,
    config.pathStyle,
    JSON.stringify(config.items ?? []),
  ]);

  const patchS3 = (patch: Partial<S3Config>) => {
    s3Autosave.markDirty();
    setS3Draft({ ...s3Draft, ...patch });
  };
  const listable = s3Draft.bucket.trim() !== "";

  return (
    <SettingsGroup
      title={
        <span className="flex items-center gap-2">
          {t("settings:data.s3_title")}
          {chatUnsyncable ? <StatusBadge tone="warning">{t("settings:data.chat_unsyncable")}</StatusBadge> : null}
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
      <RemoteBackupPanel
        kind="s3"
        config={s3Draft}
        ensureSaved={() => s3Autosave.saveNow()}
        canConnect={listable && s3Draft.accessKeyId.trim() !== ""}
        canList={listable}
      />
    </SettingsGroup>
  );
}
