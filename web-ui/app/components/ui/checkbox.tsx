"use client"

import * as React from "react"
import { CheckIcon } from "lucide-react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"

import { cn } from "~/lib/utils"

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        // 与输入框同材质:无边框 + surface-input 底 + 描边阴影;选中走品牌色实底
        "peer bg-[var(--ds-surface-input)] shadow-[var(--ds-input-shadow)] hover:shadow-[var(--ds-input-shadow-hover)] data-[state=checked]:bg-[var(--ds-brand-primary)] data-[state=checked]:text-[var(--ds-brand-primary-text)] data-[state=checked]:shadow-none focus-visible:shadow-[var(--ds-input-shadow-focus)] aria-invalid:shadow-[0_0_0_1px_var(--destructive)] size-4 shrink-0 rounded-[5px] border-0 transition-[background-color,box-shadow] duration-150 outline-none disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
