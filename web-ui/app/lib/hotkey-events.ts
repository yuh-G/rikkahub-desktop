/**
 * 快捷键事件总线。
 *
 * 需要组件上下文的 action(新建/切换/重命名/搜索——它们的 state 在 conversations/sidebar 组件内部)
 * 通过 window CustomEvent 派发,由对应组件挂监听响应。useHotkeys 只负责"匹配到 binding → 派发事件"。
 *
 * 纯路由类 action(openSettings / openImageGeneration)和字号缩放(zoomInOut)不走事件总线——
 * useHotkeys 直接 navigate / 调 API。
 */
import type { KeybindingAction } from "~/types/settings";

/** 走事件总线的 action(需要组件上下文响应)。 */
export type HotkeyBusAction = Extract<
  KeybindingAction,
  "newConversation" | "prevConversation" | "nextConversation" | "renameConversation" | "searchConversations"
>;

const HOTKEY_EVENT_PREFIX = "rikkahub:hotkey:";

export function emitHotkeyAction(action: HotkeyBusAction): void {
  window.dispatchEvent(new CustomEvent(HOTKEY_EVENT_PREFIX + action));
}

/** 订阅某个 action 的触发;返回取消订阅函数。组件在 useEffect 里挂载。 */
export function onHotkeyAction(action: HotkeyBusAction, handler: () => void): () => void {
  const listener = () => handler();
  window.addEventListener(HOTKEY_EVENT_PREFIX + action, listener);
  return () => window.removeEventListener(HOTKEY_EVENT_PREFIX + action, listener);
}

/**
 * 暂停开关:设置页录制快捷键时置 true,useHotkeys 跳过所有匹配,避免录制的按键被当成
 * 已有快捷键触发(否则按 Ctrl+N 录制时会真的新建会话)。模块级单例,录制组件进出时切换。
 */
let hotkeysPaused = false;
export function setHotkeysPaused(paused: boolean): void {
  hotkeysPaused = paused;
}
export function areHotkeysPaused(): boolean {
  return hotkeysPaused;
}
