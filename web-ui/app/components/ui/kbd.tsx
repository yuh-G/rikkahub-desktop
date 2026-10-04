import * as React from "react"

import { cn } from "~/lib/utils"

/** 键帽:快捷键展示(设置标题旁的 Ctrl ,、快捷键页的组合键)。 */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] bg-[var(--ds-surface-100)] px-1 font-mono text-mini leading-none text-[var(--ds-text-secondary)] shadow-[var(--ds-input-shadow)]",
        className
      )}
      {...props}
    />
  )
}

export { Kbd }
