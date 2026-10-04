// components/settings/data/android-compat.tsx — APP端数据库格式(schema)注册:状态查询与缓存、
// 注册卡、远端备份前的「未注册」提示。整套由 ANDROID_COMPAT_CARD_ENABLED 门控(现状关闭)。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Notice } from "~/components/ui/notice";
import { StatusBadge } from "~/components/ui/status-badge";
import i18n from "~/i18n";
import { appendWebAuthQuery } from "~/services/api";

export interface AndroidSchemaStatus {
  hasAndroidSchema: boolean;
  schemaInfo: { identityHash: string; version: number } | null;
  conversationCount: number;
}

// 专题3 批3(T-1)之后,PC 内置安卓 Room schema v24,备份恒含对话记录,"手机端适配"
// 注册流程不再是必要步骤。整套 UI(卡片 + 导出弹窗"未注册"分支 + WebDAV/S3"对话不可
// 同步"徽章)从界面隐藏但代码完整保留:后端 data/register-schema 端点与本组件的上传/
// 状态逻辑原样在,未来若需重新引导用户注册(例如换底座到更高版本 schema),翻此开关即回。
export const ANDROID_COMPAT_CARD_ENABLED: boolean = false;

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

/** 导出状态查询(对话数 + schema 是否已注册);非 2xx 返回 null。 */
export async function fetchSchemaStatus(): Promise<AndroidSchemaStatus | null> {
  const res = await fetch(appendWebAuthQuery("/api/data/export/status"));
  return res.ok ? ((await res.json()) as AndroidSchemaStatus) : null;
}

/** 缓存播种 + 写穿透:所有 setStatus 调用点(挂载查询 / 导出前刷新 / 注册成功)的结果统一落缓存,回访零闪动。 */
export function useSchemaStatus() {
  const [status, setStatus] = React.useState<AndroidSchemaStatus | null>(schemaStatusCache);
  React.useEffect(() => {
    fetchSchemaStatus()
      .then((next) => {
        if (next) setStatus(next);
      })
      .catch(() => {
        // 查询失败保持缓存值:权威状态下次挂载或导出前再取。
      });
  }, []);
  React.useEffect(() => {
    if (status) rememberSchemaStatus(status);
  }, [status]);
  return [status, setStatus] as const;
}

// 只在安卓兼容卡启用时提示:hasAndroidSchema 只看缓存库是否存在,而导出在无缓存库时用内置
// schema 建库,备份照样含对话——卡片关闭(现状)时这条提示对纯 PC 用户是误报。
export async function warnIfNoSchema(): Promise<void> {
  if (!ANDROID_COMPAT_CARD_ENABLED) return;
  try {
    const status = await fetchSchemaStatus();
    if (status && !status.hasAndroidSchema && status.conversationCount > 0) {
      toast(i18n.t("settings:data.no_schema_warn"), { duration: 6000 });
    }
  } catch {
    /* 提示是尽力而为:状态查询失败不阻断备份 */
  }
}

export function AndroidCompatCard({
  schemaStatus,
  onSchemaStatus,
}: {
  schemaStatus: AndroidSchemaStatus | null;
  onSchemaStatus: React.Dispatch<React.SetStateAction<AndroidSchemaStatus | null>>;
}) {
  const { t } = useTranslation();
  const schemaInputRef = React.useRef<HTMLInputElement>(null);
  const [registeringSchema, setRegisteringSchema] = React.useState(false);
  const [schemaExpanded, setSchemaExpanded] = React.useState(false);

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
      onSchemaStatus((prev) =>
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

  return (
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
  );
}
