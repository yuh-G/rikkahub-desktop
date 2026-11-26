import dayjs from "dayjs";

/** 列表行尾的时间:今天 / 昨天 / 月日(跨年带年份)。t 需能翻译 common 命名空间的
 *  `conversation_sidebar.today / yesterday`。 */
export function formatRelativeTime(at: number | string, t: (key: string) => string): string {
  const date = dayjs(at);
  const today = dayjs().startOf("day");
  const yesterday = today.subtract(1, "day");
  if (date.isSame(today, "day")) return t("conversation_sidebar.today");
  if (date.isSame(yesterday, "day")) return t("conversation_sidebar.yesterday");
  const sameYear = date.year() === today.year();
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(date.toDate());
}

/** 悬停时显示的绝对时间。 */
export function formatAbsoluteTime(at: number | string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(dayjs(at).toDate());
}
