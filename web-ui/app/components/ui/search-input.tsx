import * as React from "react"
import { Search, X } from "lucide-react"

import { cn } from "~/lib/utils"

// 搜索框(NewMax DsInput flat 形态):未聚焦是 on-surface 浅底、无描边,聚焦恢复输入框的
// 聚焦阴影;左放大镜,有内容时右侧圆形清除钮。onClear 缺省时清除即 onValueChange("")。
function SearchInput({
  className,
  value,
  onValueChange,
  onClear,
  clearLabel,
  ref,
  ...props
}: Omit<React.ComponentProps<"input">, "value" | "onChange" | "type"> & {
  value: string
  onValueChange: (value: string) => void
  onClear?: () => void
  clearLabel: string
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  // 外部 ref(如 Ctrl+F 聚焦)与内部 ref(清除后回焦)并存。
  React.useImperativeHandle(ref, () => inputRef.current!, [])
  return (
    <div data-slot="search-input" className={cn("relative", className)}>
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[var(--ds-icon)]"
      />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        className="h-8 w-full min-w-0 rounded-[var(--ds-radius-md)] border-0 bg-[var(--ds-on-surface)] pr-8 pl-8 text-compact text-[var(--ds-text-primary)] outline-none transition-[background-color,box-shadow] placeholder:text-[var(--ds-text-tertiary)] focus-visible:bg-[var(--ds-surface-input)] focus-visible:shadow-[var(--ds-input-shadow-focus)] [&::-webkit-search-cancel-button]:hidden"
        {...props}
      />
      {value ? (
        <button
          type="button"
          aria-label={clearLabel}
          title={clearLabel}
          onClick={() => {
            if (onClear) onClear()
            else onValueChange("")
            inputRef.current?.focus()
          }}
          className="absolute top-1/2 right-2 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--ds-text-primary)_20%,transparent)] text-[var(--ds-surface-100)] outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <X className="size-2.5" strokeWidth={3} />
        </button>
      ) : null}
    </div>
  )
}

export { SearchInput }
