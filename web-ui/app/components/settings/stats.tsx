// components/settings/stats.tsx — 用量统计分区

import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { SettingsGroup, SettingsRows, SettingsStack } from "~/components/settings/shared";

export interface StatsPayload {
  totals: {
    conversations: number;
    messages: number;
    userMessages: number;
    assistantMessages: number;
    characters: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    reportedInputTokens?: number;
    launchCount: number;
    requests: number;
    failedRequests: number;
  };
  daily: Array<{ date: string; messages: number; conversations: number; characters: number }>;
  models: Array<{ id: string; name?: string; providerName?: string; count: number }>;
  requestGroups?: Array<{ name: string; ok: number; failed: number }>;
  providers: Array<{ name: string; ok: number; failed: number }>;
}

// 专题11-P1-3:大数字用 k/M/B 缩写(行业惯例,不用万/亿),完整值放 title 悬停。
// 1 万以下保留原样,以上按阶梯保留一位小数(87.5k / 41.9M / 1.2B)。
function compactNumber(value: number) {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  const trim = (scaled: number, unit: string) => {
    const text = scaled.toFixed(1);
    return `${text.endsWith(".0") ? text.slice(0, -2) : text}${unit}`;
  };
  if (abs >= 1e9) return trim(value / 1e9, "B");
  if (abs >= 1e6) return trim(value / 1e6, "M");
  if (abs >= 1e4) return trim(value / 1e3, "k");
  return value.toLocaleString();
}

const STAT_ROW = "flex items-center justify-between gap-3 py-2 text-sm";
const STAT_EMPTY = "py-2 text-sm text-[var(--ds-text-secondary)]";

export function StatsSection({ stats }: { stats: StatsPayload | null }) {
  const { t } = useTranslation();
  if (!stats) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        {t("settings:stats.loading")}
      </div>
    );
  }
  const dailyByDate = new Map(stats.daily.map((item) => [item.date, item]));
  const today = new Date();
  const start = new Date(today);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay() - 52 * 7);
  const activeCounts = stats.daily
    .map((item) => item.messages)
    .filter((count) => count > 0)
    .sort((a, b) => a - b);
  const quantile = (ratio: number, fallback: number) =>
    activeCounts[Math.floor(activeCounts.length * ratio)] ?? fallback;
  const q1 = quantile(0.25, 1);
  const q2 = quantile(0.5, 2);
  const q3 = quantile(0.75, 3);
  const formatKey = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const heatmapWeeks = Array.from({ length: 53 }, (_, weekIndex) =>
    Array.from({ length: 7 }, (_, dayIndex) => {
      const date = new Date(start);
      date.setDate(start.getDate() + weekIndex * 7 + dayIndex);
      const key = formatKey(date);
      const item = dailyByDate.get(key);
      const isFuture = date > today;
      const count = isFuture ? 0 : (item?.messages ?? 0);
      const level = isFuture
        ? -1
        : count === 0
          ? 0
          : count <= q1
            ? 1
            : count <= q2
              ? 2
              : count <= q3
                ? 3
                : 4;
      return { key, date, count, level };
    }),
  );
  const monthLabels = heatmapWeeks.map((week) => {
    const firstOfMonth = week.find((day) => day.date.getDate() === 1);
    if (!firstOfMonth) return "";
    return firstOfMonth.date.getMonth() === 0
      ? String(firstOfMonth.date.getFullYear())
      : firstOfMonth.date.toLocaleString(undefined, { month: "short" });
  });
  // 空格子用前景派生晕染而非 bg-muted:热力图直接铺在面板底上(无卡片),muted 与
  // surface 色阶在多数主题里几乎同值,空格子会隐形;晕染相对所在表面恒拉开一档。
  const heatmapClass = (level: number) => {
    if (level < 0) return "bg-[var(--ds-on-surface)]";
    if (level === 0) return "bg-[var(--ds-on-surface-active)]";
    return ["bg-primary/25", "bg-primary/45", "bg-primary/70", "bg-primary"][level - 1];
  };
  return (
    <>
      <SettingsStack>
      {/* 指标条:一行五格、格间竖线分隔,不再是五张小卡。 */}
      <div className="grid grid-cols-2 gap-y-4 md:grid-cols-5 md:divide-x md:divide-[var(--ds-divider)]">
        {[
          // 用户拍板(2026-07-30):撤掉"总对话数"腾出空间,命中率独立成卡保两位小数
          // ——合并格"505.1k / 20%"会在卡内换行。顺序:启动、消息、输入、输出、命中率。
          {
            label: t("settings:stats.t_launches"),
            value: compactNumber(stats.totals.launchCount),
            full: stats.totals.launchCount.toLocaleString(),
          },
          {
            label: t("settings:stats.t_messages"),
            value: compactNumber(stats.totals.messages),
            full: stats.totals.messages.toLocaleString(),
          },
          {
            label: t("settings:stats.t_input_tokens"),
            value: compactNumber(stats.totals.inputTokens),
            // D3(复查):悬停写明展示值含本地估算。
            full: t("settings:stats.t_input_tokens_tip", {
              input: stats.totals.inputTokens.toLocaleString(),
            }),
          },
          {
            label: t("settings:stats.t_output_tokens"),
            value: compactNumber(stats.totals.outputTokens),
            full: stats.totals.outputTokens.toLocaleString(),
          },
          {
            // 全局缓存命中率:分母用厂商真实回报的输入量(排除本地估算,其命中恒 0
            // 会稀释比例);从未有厂商回报时显示占位符。
            label: t("settings:stats.t_cache_hit_rate"),
            value: (() => {
              const cached = stats.totals.cachedTokens ?? 0;
              const denominator = stats.totals.reportedInputTokens ?? 0;
              return denominator > 0
                ? `${Math.min(100, (cached / denominator) * 100).toFixed(2)}%`
                : "—";
            })(),
            // D3(复查):悬停口径写明命中率分母只用厂商真实回报。
            full: t("settings:stats.t_cache_hit_rate_tip", {
              cached: (stats.totals.cachedTokens ?? 0).toLocaleString(),
              reported: (stats.totals.reportedInputTokens ?? 0).toLocaleString(),
            }),
          },
        ].map(({ label, value, full }) => (
          <div key={label} className="min-w-0 md:px-4 md:first:pl-0" title={full}>
            <div className="truncate text-xs text-[var(--ds-text-secondary)]">{label}</div>
            <div className="mt-1.5 text-2xl font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </div>
      <SettingsGroup title={t("settings:stats.heatmap")}>
        <div className="pt-2 pb-1">
          <div className="grid w-full grid-cols-[24px_minmax(0,1fr)] gap-x-2 overflow-hidden pr-px">
            <div />
            <div
              className="grid justify-between gap-[3px]"
              style={{ gridTemplateColumns: "repeat(53, minmax(10px, 14px))" }}
            >
              {monthLabels.map((label, index) => (
                <div
                  key={`${label}-${index}`}
                  className="h-5 overflow-visible whitespace-nowrap text-mini text-muted-foreground"
                >
                  {label}
                </div>
              ))}
            </div>
            <div
              className="grid gap-[3px] pt-[2px]"
              style={{ gridTemplateRows: "repeat(7, auto)" }}
            >
              {[
                "",
                t("settings:stats.day_mon"),
                "",
                t("settings:stats.day_wed"),
                "",
                t("settings:stats.day_fri"),
                "",
              ].map((label, index) => (
                <div
                  key={`${label}-${index}`}
                  className="flex h-3.5 items-center justify-end text-mini text-muted-foreground sm:h-4"
                >
                  {label}
                </div>
              ))}
            </div>
            <div
              className="grid justify-between gap-[3px] pt-[2px]"
              style={{ gridTemplateColumns: "repeat(53, minmax(10px, 14px))" }}
            >
              {heatmapWeeks.map((week, weekIndex) => (
                <div
                  key={weekIndex}
                  className="grid gap-[3px]"
                  style={{ gridTemplateRows: "repeat(7, auto)" }}
                >
                  {week.map((day) => (
                    <div
                      key={day.key}
                      title={t("settings:stats.day_count", { date: day.key, count: day.count })}
                      className={`size-3.5 rounded-[3px] sm:size-4 ${heatmapClass(day.level)}`}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-end gap-1 text-mini text-muted-foreground">
          <span>{t("settings:stats.less")}</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span key={level} className={`size-[12px] rounded-[4px] ${heatmapClass(level)}`} />
          ))}
          <span>{t("settings:stats.more")}</span>
        </div>
        {stats.daily.length === 0 ? (
          <div className="mt-3 text-xs text-muted-foreground">
            {t("settings:stats.heatmap_empty")}
          </div>
        ) : null}
      </SettingsGroup>
      <div className="grid gap-8 md:grid-cols-2">
        <SettingsGroup title={t("settings:stats.model_usage")}>
          <SettingsRows>
            {stats.models.slice(0, 8).map((item) => (
              <div key={item.id} className={STAT_ROW}>
                <span className="truncate">
                  {[item.providerName, item.name || item.id].filter(Boolean).join(" / ")}
                </span>
                <span className="text-muted-foreground">{item.count}</span>
              </div>
            ))}
            {stats.models.length === 0 ? (
              <div className={STAT_EMPTY}>{t("settings:stats.no_models")}</div>
            ) : null}
          </SettingsRows>
        </SettingsGroup>
        <div className="space-y-8">
        <SettingsGroup title={t("settings:stats.request_groups")}>
          <SettingsRows>
            {(stats.requestGroups ?? []).map((item) => (
              <div key={item.name} className={STAT_ROW}>
                <span className="truncate">{item.name}</span>
                <span className="text-muted-foreground">
                  {t("settings:stats.ok_failed", { ok: item.ok, failed: item.failed })}
                </span>
              </div>
            ))}
            {(stats.requestGroups ?? []).length === 0 ? (
              <div className={STAT_EMPTY}>{t("settings:stats.no_groups")}</div>
            ) : null}
          </SettingsRows>
        </SettingsGroup>
        <SettingsGroup title={t("settings:stats.provider_requests")}>
          <SettingsRows>
            {stats.providers.slice(0, 8).map((item) => (
              <div key={item.name} className={STAT_ROW}>
                <span className="truncate">{item.name}</span>
                <span className="text-muted-foreground">
                  {item.ok} / {item.failed}
                </span>
              </div>
            ))}
            {stats.providers.length === 0 ? (
              <div className={STAT_EMPTY}>{t("settings:stats.no_provider_requests")}</div>
            ) : null}
          </SettingsRows>
        </SettingsGroup>
        </div>
      </div>
      </SettingsStack>
    </>
  );
}
