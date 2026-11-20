// pi-engine/capabilities.ts — pi 驱动的能力声明(P7.2.6 从 driver.ts 搬出)
//
// 主程序要在不加载 pi 的前提下知道这些(编排器按它路由、选审批语义),pi 驱动本体只在引擎宿主进程里跑。
// 本模块只引类型,主程序导入它不会把 pi 带进来(engine-agnostic-guard 的主程序闭包守卫)。

import type { EngineCapabilities } from "../engines/contract";

export const PI_CAPABILITIES: EngineCapabilities = {
  // 生成保持在跑,单个工具调用挂起等应用侧审批放行,不整批暂停重触发。
  resumeSemantics: "run-and-suspend",
  // runner 在 pi turn_end 调 host.steer.take,文本经 session.agent.steer() 入 pi steering 队列。
  steering: "boundary",
  // pi 原生 session.compact:压引擎记忆,界面历史不动。
  nativeCompaction: true,
  // 工作区引擎:请求必带 cwd/root(缺则以错误拒绝)。
  workspace: "required",
  placement: "portable",
  // 插件登记的指令(裁决层已拿掉入口类名字);pi 自带的指令名归应用或不在本应用里出现,不列。
  commands: true,
  plugins: true,
};
