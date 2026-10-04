import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "~/lib/utils"

// NewMax DsSwitch 规格:default 34×20 / 拇指 14 / 内边距 3 / 行程 14;sm 28×16 / 12 / 2 / 12。
// 按下时拇指横向拉伸(default 4px、sm 3px),开态同时左移等量让右缘不动——"按住"的手感。
// issue8:所有尺寸必须是整数像素。非整数高度让圆角边缘落在半像素上,且拇指垂直居中余量
// 无法均分,在 125%/150% DPI 下轨道与拇指各自取整方向不同 → 可见错位。改尺寸先算整数;
// 拇指用绝对定位 + 固定 top/left(而非 flex 居中)也是为了让余量是确定的整数。
function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 rounded-full outline-none transition-colors duration-(--ds-duration-base) ease-(--ds-ease-swift) focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-40 data-[state=checked]:bg-[var(--ds-brand-primary)] data-[state=unchecked]:bg-[color-mix(in_srgb,var(--ds-text-primary)_20%,transparent)] data-[size=default]:h-5 data-[size=default]:w-[34px] data-[size=sm]:h-4 data-[size=sm]:w-7",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none absolute block rounded-full bg-[var(--ds-surface-100)] shadow-[0_1px_3px_rgba(0,0,0,0.12),0_0.5px_1px_rgba(0,0,0,0.08)] transition-[transform,width] duration-(--ds-duration-base) ease-(--ds-ease-swift) motion-reduce:transition-none",
          "group-data-[size=default]/switch:top-[3px] group-data-[size=default]/switch:left-[3px] group-data-[size=default]/switch:h-3.5 group-data-[size=default]/switch:w-3.5 group-data-[size=default]/switch:data-[state=checked]:translate-x-3.5 group-data-[size=default]/switch:group-enabled/switch:group-active/switch:w-[18px] group-data-[size=default]/switch:data-[state=checked]:group-enabled/switch:group-active/switch:translate-x-2.5",
          "group-data-[size=sm]/switch:top-[2px] group-data-[size=sm]/switch:left-[2px] group-data-[size=sm]/switch:h-3 group-data-[size=sm]/switch:w-3 group-data-[size=sm]/switch:data-[state=checked]:translate-x-3 group-data-[size=sm]/switch:group-enabled/switch:group-active/switch:w-[15px] group-data-[size=sm]/switch:data-[state=checked]:group-enabled/switch:group-active/switch:translate-x-[9px]"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
