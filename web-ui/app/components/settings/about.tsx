// components/settings/about.tsx — 赞助与关于分区（纯搬迁自 routes/settings.tsx）

import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  ExternalLink,
  FileClock,
  Github,
  Globe,
  Heart,
  Loader2,
  RefreshCw,
  Settings2,
  Smartphone,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Separator } from "~/components/ui/separator";
import { UpdateDialog, type UpdateInfo } from "~/components/update-dialog";
import api from "~/services/api";
import { getSystemInfo } from "~/lib/system-info";
import { openExternal } from "~/lib/external-link";
import { SectionHeader } from "~/components/settings/shared";

// 爱发电品牌图标。path 数据取自 Rikkahub-Android 的 VectorDrawable,保持品牌识别度。
function AfdianIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M9,14.234a0.567,0.567 0,1 0,0 1.134,0.567 0.567 0 0,0 0,-1.134m5.351,1.705a0.567,0.567 0,1 0,0 1.135,0.567 0.567,0 0,0 0,-1.135m8.401,1.436c-0.189,0.095 -0.461,0.1 -0.713,0.013 -0.169,-0.06 -0.352,-0.116 -0.534,-0.172 -0.339,-0.104 -0.904,-0.276 -1.011,-0.407a0.533,0.533 0,1 0,-0.853 0.643c0.059,0.08 0.139,0.146 0.22,0.209 -0.816,1.131 -4.398,3.382 -9.464,2.273 -2.283,-0.5 -3.819,-1.413 -4.444,-2.639 -0.451,-0.885 -0.348,-1.797 -0.133,-2.293 0.62,-1.29 5.097,-4.261 7.955,-5.943a0.537,0.537 0,0 0,0.188 -0.733c-0.149,-0.254 -0.49,-0.356 -0.73,-0.189 -0.231,0.135 -1.015,0.601 -2.015,1.236 -0.338,-0.227 -0.923,-0.508 -1.86,-0.6 -1.486,-0.148 -4.92,-0.805 -6.029,-1.275C2.535,7.162 0.731,6.27 1.131,5.267c0.092,-0.234 0.527,-0.613 1.47,-0.974a8.5,8.5 0,0 1,1.995 -0.492l-0.212,0.103c-0.642,0.312 -1.343,0.662 -1.813,1.075 -0.034,-0.022 -0.07,-0.044 -0.094,-0.069a0.527,0.527 0,0 0,-0.754 -0.017,0.533 0.533 0,0,0 -0.017,0.756c0.19,0.2 0.471,0.35 0.829,0.465l0.039,0.014c1.245,0.383 3.458,0.336 6.578,0.211 1.345,-0.052 2.615,-0.102 3.674,-0.082 3.512,0.07 6.152,1.469 8.07,4.279 1.178,1.725 0.753,3.426 0.079,4.903a1.4,1.4 0,0 1,-0.231 -0.222,0.54 0.54,0 0,0 -0.75,-0.085 0.535,0.535 0,0 0,-0.086 0.751c0.109,0.137 0.665,0.778 1.355,0.724l0.037,-0.002c0.021,-0.003 0.042,0.001 0.064,-0.003 0.472,-0.086 0.768,-0.063 1.045,0.111 0.367,0.232 0.547,0.37 0.511,0.485 -0.021,0.073 -0.076,0.125 -0.168,0.177M8.19,11.418l-0.315,0.231a1.6,1.6 0,0 1,-0.243 -0.32c0.123,-0.038 0.33,0.007 0.558,0.089m14.733,4.356a1.9,1.9 0,0 0,-0.81 -0.27c0.632,-1.544 1.034,-3.565 -0.336,-5.572 -2.096,-3.072 -5.101,-4.668 -8.93,-4.744 -1.091,-0.022 -2.377,0.029 -3.737,0.083 -1.58,0.063 -3.683,0.145 -5.112,0.027 0.285,-0.155 0.588,-0.304 0.851,-0.431 1.006,-0.49 1.797,-0.872 1.535,-1.548 -0.137,-0.396 -0.547,-0.603 -1.219,-0.618C3.748,2.669 0.688,3.489 0.138,4.872c-0.31,0.779 -0.361,2.282 2.775,3.61 1.29,0.548 4.934,1.216 6.341,1.355 0.397,0.039 0.701,0.119 0.931,0.205a75,75 0,0 0,-0.986 0.664c-0.577,-0.329 -1.521,-0.718 -2.226,-0.237a0.94,0.94 0,0 0,-0.435 0.768c-0.01,0.385 0.224,0.763 0.486,1.066 -1.038,0.83 -1.877,1.634 -2.175,2.253 -0.332,0.762 -0.467,2.008 0.153,3.224 0.786,1.544 2.524,2.62 5.166,3.199 3.454,0.755 6.437,0.075 8.411,-0.966 1.099,-0.579 1.878,-1.27 2.257,-1.887l0.356,0.113c0.169,0.051 0.338,0.103 0.496,0.159 0.522,0.181 1.1,0.157 1.545,-0.068l0.025,-0.013c0.336,-0.177 0.577,-0.46 0.683,-0.803 0.285,-0.922 -0.528,-1.432 -1.018,-1.74" />
    </svg>
  );
}

// 赞助者数据结构(预留)。赞助用户列表上线后由 /api/sponsors 返回此结构;
// 接入方案见后端该接口注释。
interface Sponsor {
  userName: string;
  avatar: string;
  amount?: string;
}

export function DonateSection() {
  const { t } = useTranslation();
  return (
    <>
      <SectionHeader icon={Heart} title={t("settings:donate.title")} subtitle={t("settings:donate.subtitle")} />
      <div className="space-y-6">
        <div className="rounded-lg border bg-card">
          <button
            type="button"
            className="flex w-full items-center gap-3 p-4 text-left transition hover:bg-accent/50"
            onClick={() => void openExternal("https://afdian.com/a/mirsky")}
          >
            <AfdianIcon className="size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{t("settings:donate.afdian")}</div>
              <div className="text-sm text-muted-foreground">{t("settings:donate.afdian_desc")}</div>
            </div>
            <ExternalLink className="size-4 shrink-0 text-muted-foreground" />
          </button>
          <Separator />
          <div className="flex items-center gap-3 p-4">
            <Globe className="size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{t("settings:donate.international")}</div>
              <div className="text-sm text-muted-foreground">{t("settings:donate.international_desc")}</div>
            </div>
            <span className="shrink-0 rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground">
              {t("settings:donate.coming_soon")}
            </span>
          </div>
        </div>

        {/* 赞助用户列表暂未上线;数据源就绪后在此恢复,结构见 Sponsor 类型与后端 /api/sponsors 注释。 */}
      </div>
    </>
  );
}

export function AboutSection() {
  const { t } = useTranslation();
  // 版本号由 pc-server/scripts/bump-version.ts 统一改写(四处之一),
  // 勿手改;CI 的 check-version-sync.ts 校验四处一致。
  const APP_VERSION = "2.0.0-preview-v3";

  const [checking, setChecking] = React.useState(false);
  const [updateInfo, setUpdateInfo] = React.useState<UpdateInfo | null>(null);
  // 真实系统版本(走 Tauri OS 插件),异步加载。
  const [systemSummary, setSystemSummary] = React.useState("");

  React.useEffect(() => {
    void getSystemInfo().then((info) => setSystemSummary(info.summary));
  }, []);

  const checkForUpdate = async () => {
    setChecking(true);
    try {
      const info = await api.get<UpdateInfo>("update/check");
      setUpdateInfo(info);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings:about.check_failed"));
    } finally {
      setChecking(false);
    }
  };

  const aboutRows = [
    {
      key: "version",
      label: t("settings:about.version"),
      value: APP_VERSION,
      icon: Settings2,
      onClick: undefined,
      action: "update" as const,
    },
    {
      key: "system",
      label: t("settings:about.system"),
      value: systemSummary || "—",
      icon: Smartphone,
      onClick: undefined,
      action: undefined,
    },
    {
      key: "website",
      label: t("settings:about.website"),
      value: "https://rikkahub-desktop.pages.dev",
      icon: Globe,
      onClick: () => void openExternal("https://rikkahub-desktop.pages.dev/"),
      action: undefined,
    },
    {
      key: "github",
      label: "GitHub",
      value: "https://github.com/yuh-G/rikkahub-desktop",
      icon: Github,
      onClick: () => void openExternal("https://github.com/yuh-G/rikkahub-desktop/"),
      action: undefined,
    },
    {
      key: "license",
      label: "License",
      value: "https://github.com/yuh-G/rikkahub-desktop/blob/master/LICENSE",
      icon: FileClock,
      onClick: () =>
        void openExternal("https://github.com/yuh-G/rikkahub-desktop/blob/master/LICENSE"),
      action: undefined,
    },
  ];
  return (
    <>
      <SectionHeader
        icon={CheckCircle2}
        title={t("settings:about.title")}
        subtitle={t("settings:about.subtitle")}
      />
      <div className="space-y-6">
        <div className="flex flex-col items-center gap-3 rounded-lg border bg-card p-8 text-center">
          <img src="/app-icon.png" alt="RikkaHub" className="size-28 rounded-full shadow-sm" />
          <div className="text-3xl font-semibold tracking-normal">RikkaHub</div>
        </div>
        <div className="rounded-lg border bg-card">
          {aboutRows.map((row, index) => {
            const Icon = row.icon;
            const content = (
              <>
                <div className="flex min-w-0 items-center gap-3">
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="font-medium">{row.label}</div>
                </div>
                <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                  <span className="truncate">{row.value}</span>
                  {row.action === "update" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="ml-2 shrink-0"
                      onClick={(event) => {
                        event.stopPropagation();
                        void checkForUpdate();
                      }}
                      disabled={checking}
                    >
                      {checking ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="size-3.5" />
                      )}
                      {t("settings:about.check_update")}
                    </Button>
                  ) : row.onClick ? (
                    <ExternalLink className="size-3.5 shrink-0" />
                  ) : null}
                </div>
              </>
            );
            return (
              <React.Fragment key={row.key}>
                {index > 0 ? <Separator /> : null}
                {row.onClick ? (
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-4 p-4 text-left transition hover:bg-accent/50"
                    onClick={row.onClick}
                  >
                    {content}
                  </button>
                ) : (
                  <div className="flex items-center justify-between gap-4 p-4">{content}</div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>
      {updateInfo && (
        <UpdateDialog info={updateInfo} open={true} onClose={() => setUpdateInfo(null)} />
      )}
    </>
  );
}
