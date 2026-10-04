import * as React from "react"

import { cn } from "~/lib/utils"

// 前端重构R4:参考项目 DsInput 材质——无边框,surface-input 底,细描边阴影三态
// (base/hover/focus 由 --ds-input-shadow* 令牌驱动,花色主题自动派生)。
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-foreground placeholder:text-[var(--ds-text-tertiary)] selection:bg-primary selection:text-primary-foreground h-8 w-full min-w-0 rounded-[var(--ds-radius-md)] border-0 bg-[var(--ds-surface-input)] px-[10px] py-1 text-base text-[var(--ds-text-primary)] shadow-[var(--ds-input-shadow)] transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium hover:shadow-[var(--ds-input-shadow-hover)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-compact",
        "focus-visible:shadow-[var(--ds-input-shadow-focus)]",
        "aria-invalid:shadow-[0_0_0_1px_var(--destructive)]",
        className
      )}
      {...props}
    />
  )
}

export { Input }
