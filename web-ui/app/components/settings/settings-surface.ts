// 设置内容所处的承载形态。分区里的少数共享件(SectionHeader)据此微调排版:
// 模态里由面板自身提供关闭钮与外框,分区页头收敛为与面板匹配的尺度。
// 独立成文件是为了避免 shared.tsx ↔ settings-panel.tsx 的循环依赖。
import * as React from "react";

export type SettingsSurface = "page" | "dialog";

export const SettingsSurfaceContext = React.createContext<SettingsSurface>("page");

export function useSettingsSurface(): SettingsSurface {
  return React.useContext(SettingsSurfaceContext);
}
