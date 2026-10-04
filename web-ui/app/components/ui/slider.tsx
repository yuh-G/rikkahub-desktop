import * as React from "react"
import { Slider as SliderPrimitive } from "radix-ui"

import { cn } from "~/lib/utils"

// NewMax DsSlider 形态:16px 高胶囊轨道,22×12 白色拇指嵌在轨道内(四周留 2px)。
// 实现:根节点即轨道(overflow-hidden 裁切);拇指命中盒取 26×16 透明盒——Radix 按拇指实测
// 宽度做 in-bounds 偏移,盒边贴轨道边,after 伪元素画内缩 2px 的白胶囊;已选段由拇指
// before 伪元素向左无限延伸、被轨道裁切而成,因此填充恒盖到拇指右缘(两端都不露底色)。
// 该做法只适用于单拇指;全应用没有范围选择用法,需要时再另立变体。
function Slider({
  className,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn(
        "relative flex h-4 w-full touch-none items-center overflow-hidden rounded-full bg-[var(--ds-on-surface)] select-none data-[disabled]:opacity-40",
        className
      )}
      {...props}
    >
      <SliderPrimitive.Track data-slot="slider-track" className="relative h-full grow">
        <SliderPrimitive.Range data-slot="slider-range" className="absolute h-full" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        className="relative block h-4 w-[26px] cursor-grab outline-none active:cursor-grabbing data-[disabled]:pointer-events-none before:absolute before:inset-y-0 before:right-0 before:w-[200vw] before:rounded-r-full before:bg-[var(--ds-brand-primary)] after:absolute after:inset-[2px] after:rounded-full after:bg-[var(--ds-surface-100)] after:transition-shadow after:duration-(--ds-duration-base) after:ease-(--ds-ease-spring) active:after:shadow-[var(--ds-elevation-200)] focus-visible:after:shadow-[0_0_0_2px_var(--ring)]"
      />
    </SliderPrimitive.Root>
  )
}

export { Slider }
