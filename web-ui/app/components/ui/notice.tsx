import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "~/lib/utils"

// 状态提示条:无边框色底(--ds-{tone}-bg 令牌,主题自动派生),字随语气色。
// 取代各页手写的 `border-amber-200 bg-amber-50 dark:…` 一类写死色块。
const noticeVariants = cva(
  "flex items-start gap-2 rounded-[var(--ds-radius-md)] px-3 py-2 text-xs leading-relaxed [&>svg]:mt-px [&>svg]:size-3.5 [&>svg]:shrink-0",
  {
    variants: {
      tone: {
        info: "bg-[var(--ds-on-surface)] text-[var(--ds-text-secondary)]",
        success: "bg-[var(--ds-success-bg)] text-[var(--ds-success)]",
        warning: "bg-[var(--ds-warning-bg)] text-[var(--ds-warning)]",
        danger: "bg-[var(--ds-danger-bg)] text-[var(--ds-danger)]",
      },
    },
    defaultVariants: { tone: "info" },
  }
)

function Notice({
  className,
  tone,
  icon,
  action,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> &
  VariantProps<typeof noticeVariants> & {
    icon?: React.ReactNode
    /** 右侧动作槽(「立即重启」「知道了」等)。 */
    action?: React.ReactNode
  }) {
  return (
    <div
      data-slot="notice"
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}
      className={cn(noticeVariants({ tone }), className)}
      {...props}
    >
      {icon}
      <div className="min-w-0 flex-1">{children}</div>
      {action != null ? <div className="-my-0.5 flex shrink-0 items-center gap-1">{action}</div> : null}
    </div>
  )
}

export { Notice, noticeVariants }
