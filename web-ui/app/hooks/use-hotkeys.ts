/**
 * 全局快捷键 hook。挂在 root,生命周期内常驻。
 *
 * 职责:keydown 匹配 binding → 触发对应 action;Ctrl+滚轮 → 字号缩放。
 * - 纯路由 action(openSettings / openImageGeneration):直接 navigate。
 * - 字号缩放(zoomInOut):直接 POST settings/display。
 * - 需要组件上下文的 action(新建/切换/重命名/搜索):走事件总线,由组件挂监听响应。
 *
 * keydown 用 capture 阶段抢在 webview 默认行为之前;wheel 用 passive:false 才能 preventDefault
 * (阻止 WebView2 自带的 Ctrl+滚轮页面缩放,改走我们的 rem 等比缩放)。
 */
import * as React from "react";
import { useNavigate } from "react-router";

import { areHotkeysPaused, emitHotkeyAction, type HotkeyBusAction } from "~/lib/hotkey-events";
import { DEFAULT_KEYBINDINGS, eventToTokens, hasModifier, isTextInputFocused, tokensEqual } from "~/lib/hotkeys";
import api from "~/services/api";
import { useSettingsStore } from "~/stores";
import type { KeybindingAction, KeybindingEntry } from "~/types/settings";

const FONT_MIN = 0.85;
const FONT_MAX = 1.2;
const FONT_STEP = 0.05;

/** 走事件总线的 action 集合(需要组件上下文响应)。 */
const BUS_ACTIONS = new Set<KeybindingAction>([
  "newConversation",
  "prevConversation",
  "nextConversation",
  "renameConversation",
  "searchConversations",
]);

export function useHotkeys(): void {
  const navigate = useNavigate();
  const keybindings = useSettingsStore((s) => s.settings?.keybindings);

  // ref 持有最新值,避免每次 settings 变化都重建监听器。
  const keybindingsRef = React.useRef(keybindings);
  keybindingsRef.current = keybindings;
  const navigateRef = React.useRef(navigate);
  navigateRef.current = navigate;

  // 合并默认 + 用户配置,得到每个 action 的生效 binding(用户未改的回落到默认)。
  const resolveBindings = React.useCallback(() => {
    const user = keybindingsRef.current ?? {};
    const merged: Partial<Record<KeybindingAction, KeybindingEntry>> = {};
    for (const action of Object.keys(DEFAULT_KEYBINDINGS) as KeybindingAction[]) {
      merged[action] = user[action] ?? DEFAULT_KEYBINDINGS[action];
    }
    return merged;
  }, []);

  // 字号缩放:读当前 uiFontSize,±step,clamp 到滑块同范围,1.00 存 null(与字号滑块一致)。
  const adjustFontScale = React.useCallback((direction: 1 | -1) => {
    const display = useSettingsStore.getState().settings?.displaySetting;
    const current = typeof display?.uiFontSize === "number" ? display.uiFontSize : 1;
    let next = current + direction * FONT_STEP;
    next = Math.min(FONT_MAX, Math.max(FONT_MIN, next));
    next = Math.round(next * 100) / 100;
    const normalized = Math.abs(next - 1) < 0.001 ? null : next;
    void api.post("settings/display", { uiFontSize: normalized }).catch(() => {
      // 静默:SSE 会把失败的状态纠正回来。
    });
  }, []);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (areHotkeysPaused()) return; // 设置页录制中,放行让录制组件接收
      if (event.isComposing || event.key === "Process") return;
      const tokens = eventToTokens(event);
      if (tokens.length === 0) return;

      const bindings = resolveBindings();
      let matched: KeybindingAction | null = null;
      for (const action of Object.keys(bindings) as KeybindingAction[]) {
        const entry = bindings[action];
        if (!entry?.enabled || !entry.keys || entry.keys.length === 0) continue;
        if (tokensEqual(entry.keys, tokens)) {
          matched = action;
          break;
        }
      }
      if (!matched) return;

      // 输入框聚焦时,只响应带修饰键的;F2 等单键在输入框内不触发,避免吞打字。
      if (isTextInputFocused() && !hasModifier(tokens)) return;

      event.preventDefault();
      if (BUS_ACTIONS.has(matched)) {
        emitHotkeyAction(matched as HotkeyBusAction);
      } else if (matched === "openSettings") {
        navigateRef.current("/settings");
      } else if (matched === "openImageGeneration") {
        navigateRef.current("/images");
      }
      // zoomInOut 无 keys,keydown 永远匹配不到;缩放在 onWheel 里处理。
    };

    const onWheel = (event: WheelEvent) => {
      if (areHotkeysPaused()) return;
      if (!event.ctrlKey) return;
      const bindings = resolveBindings();
      if (!bindings.zoomInOut?.enabled) return;
      event.preventDefault();
      adjustFontScale(event.deltaY < 0 ? 1 : -1);
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("wheel", onWheel);
    };
  }, [resolveBindings, adjustFontScale]);
}
