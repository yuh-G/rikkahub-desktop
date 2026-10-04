"use client"

import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"

import { cn } from "~/lib/utils"

/** value 为 null/undefined 时是不确定态(进度未知):满宽指示条脉动。 */
function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  const indeterminate = value == null
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--ds-on-surface)]",
        className
      )}
      value={value}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          "h-full w-full rounded-full bg-[var(--ds-brand-primary)] transition-transform duration-(--ds-duration-base) ease-(--ds-ease-swift)",
          indeterminate && "animate-pulse"
        )}
        style={indeterminate ? undefined : { transform: `translateX(-${100 - value}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
