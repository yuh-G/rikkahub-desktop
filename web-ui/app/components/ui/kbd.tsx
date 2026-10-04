import * as React from "react"

import { cn } from "~/lib/utils"

/** 键帽:快捷键展示(设置标题旁的 ⌘,、快捷键页的组合键)。材质对齐参考设计:on-surface
 *  微底 + radius-sm,字体走 --font-sans(Inter 起链,与参考的 kbd 专用字体同为 Inter)。 */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-[var(--ds-radius-sm)] bg-[var(--ds-on-surface)] px-1 font-sans text-mini leading-none text-[var(--ds-text-secondary)]",
        className
      )}
      {...props}
    />
  )
}

export { Kbd }
