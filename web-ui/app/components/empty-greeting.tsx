import { useTranslation } from "react-i18next";

import { cn } from "~/lib/utils";

// 空态时段问候(前端重构A3,参考首页形态):按本地时间选问候词,与固定后半句
// 组成大标题。渲染时取当前时刻即可——空态停留期间跨时段不值得起定时器实时刷新。

type Period = "morning" | "noon" | "afternoon" | "evening" | "night";

function currentPeriod(hour: number): Period {
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 13) return "noon";
  if (hour >= 13 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 23) return "evening";
  return "night";
}

export function EmptyGreeting({ className }: { className?: string }) {
  const { t } = useTranslation("page");
  const greeting = t(`conversations.greeting.${currentPeriod(new Date().getHours())}`);
  return (
    <h1 className={cn("text-2xl font-semibold tracking-tight text-foreground", className)}>
      {t("conversations.greeting_line", { greeting })}
    </h1>
  );
}
