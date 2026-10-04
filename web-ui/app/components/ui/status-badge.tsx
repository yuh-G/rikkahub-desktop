import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "~/lib/utils"

// 小号状态徽标(「订阅」「已授权」「使用中」、日志级别…):胶囊、色底与 Notice 同源令牌。
// 作开关用时(模型能力「工具/推理」)用 StatusBadgeButton,未激活态 = neutral。
const statusBadgeVariants = cva(
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-[var(--ds-radius-pill)] px-1.5 text-[11px] leading-none font-medium whitespace-nowrap [&>svg]:size-3 [&>svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "bg-[var(--ds-on-surface)] text-[var(--ds-text-secondary)]",
        brand: "bg-[var(--ds-pill-bg)] text-[var(--ds-brand-primary)]",
        success: "bg-[var(--ds-success-bg)] text-[var(--ds-success)]",
        warning: "bg-[var(--ds-warning-bg)] text-[var(--ds-warning)]",
        danger: "bg-[var(--ds-danger-bg)] text-[var(--ds-danger)]",
      },
    },
    defaultVariants: { tone: "neutral" },
  }
)

type StatusBadgeTone = NonNullable<VariantProps<typeof statusBadgeVariants>["tone"]>

function StatusBadge({
  className,
  tone,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof statusBadgeVariants>) {
  return <span data-slot="status-badge" className={cn(statusBadgeVariants({ tone }), className)} {...props} />
}

/** 可切换的徽标:pressed 时取 tone,否则 neutral。 */
function StatusBadgeButton({
  className,
  tone = "brand",
  pressed,
  ...props
}: Omit<React.ComponentProps<"button">, "aria-pressed"> & { tone?: StatusBadgeTone; pressed: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        statusBadgeVariants({ tone: pressed ? tone : "neutral" }),
        "cursor-pointer outline-none transition-[background-color,color,opacity] hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { StatusBadge, StatusBadgeButton, statusBadgeVariants, type StatusBadgeTone }
