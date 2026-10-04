import * as React from "react"

import { cn } from "~/lib/utils"

// 前端重构R4:与 Input 同套参考项目材质(surface-input 底 + 描边阴影三态)。
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "placeholder:text-[var(--ds-text-tertiary)] flex field-sizing-content min-h-16 w-full rounded-[var(--ds-radius-md)] border-0 bg-[var(--ds-surface-input)] px-[10px] py-2 text-base text-[var(--ds-text-primary)] shadow-[var(--ds-input-shadow)] transition-[color,box-shadow] outline-none hover:shadow-[var(--ds-input-shadow-hover)] focus-visible:shadow-[var(--ds-input-shadow-focus)] aria-invalid:shadow-[0_0_0_1px_var(--destructive)] disabled:cursor-not-allowed disabled:opacity-50 md:text-compact",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
