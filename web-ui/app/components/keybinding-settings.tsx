/**
 * 设置页 - 通用 - 快捷键区块。
 *
 * 每行:功能名 | 绑定显示/录制按钮 | 重置(仅修改过时) | 启用开关。
 * 录制:点按钮进入编辑态 → 暂停全局快捷键(setHotkeysPaused)→ 按键实时采集 → 合法且无冲突即
 * 保存并退出;Esc / 失焦退出。zoomInOut 固定 Ctrl+滚轮,不可录制,只有开关。
 * 冲突:录制时 findConflict 实时比对其它已启用的绑定,冲突即红字提示并拒绝保存。
 */
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, RotateCcw } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { setHotkeysPaused } from "~/lib/hotkey-events";
import {
  DEFAULT_KEYBINDINGS,
  KEYBINDING_ORDER,
  eventToTokens,
  findConflict,
  formatBinding,
  formatToken,
  isValidBinding,
  normalizeTokens,
  tokensEqual,
} from "~/lib/hotkeys";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import { useSettingsStore } from "~/stores";
import type { KeybindingAction, KeybindingEntry } from "~/types/settings";

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-muted px-1.5 font-mono text-[0.7rem]">
      {children}
    </kbd>
  );
}

export function KeybindingSettings() {
  const { t } = useTranslation();
  const keybindings = useSettingsStore((s) => s.settings?.keybindings);
  const [editingAction, setEditingAction] = React.useState<KeybindingAction | null>(null);
  const [pendingKeys, setPendingKeys] = React.useState<string[]>([]);
  const [conflictAction, setConflictAction] = React.useState<KeybindingAction | null>(null);

  // 合并默认 + 用户配置(用户未改的回落默认)。
  const resolved = React.useMemo<Record<KeybindingAction, KeybindingEntry>>(() => {
    const merged = {} as Record<KeybindingAction, KeybindingEntry>;
    for (const action of KEYBINDING_ORDER) {
      merged[action] = keybindings?.[action] ?? DEFAULT_KEYBINDINGS[action];
    }
    return merged;
  }, [keybindings]);

  const exitEditing = React.useCallback(() => {
    setHotkeysPaused(false);
    setEditingAction(null);
    setPendingKeys([]);
    setConflictAction(null);
  }, []);

  // 卸载时解除暂停,防止录制中切走导致全局快捷键永久失效。
  React.useEffect(() => {
    return () => setHotkeysPaused(false);
  }, []);

  const startEditing = (action: KeybindingAction) => {
    if (action === "zoomInOut") return;
    setHotkeysPaused(true);
    setEditingAction(action);
    setPendingKeys([]);
    setConflictAction(null);
  };

  const saveKeys = (action: KeybindingAction, keys: string[]) => {
    void api.post("settings/keybindings", { action, keys, enabled: true });
  };
  const setEnabled = (action: KeybindingAction, enabled: boolean) => {
    void api.post("settings/keybindings", { action, enabled });
  };
  const resetOne = (action: KeybindingAction) => {
    const def = DEFAULT_KEYBINDINGS[action];
    void api.post("settings/keybindings", { action, keys: def.keys ?? [], enabled: def.enabled });
  };
  const resetAll = () => {
    void api.post("settings/keybindings/reset");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, action: KeybindingAction) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      exitEditing();
      return;
    }
    const tokens = eventToTokens(e.nativeEvent);
    if (tokens.length === 0) return;
    setPendingKeys(tokens);
    if (!isValidBinding(tokens)) {
      setConflictAction(null);
      return;
    }
    const conflict = findConflict(action, tokens, resolved);
    if (conflict) {
      setConflictAction(conflict);
      return;
    }
    saveKeys(action, normalizeTokens(tokens));
    exitEditing();
  };

  const conflictLabel =
    editingAction && conflictAction ? t(`settings:hotkeys.actions.${conflictAction}`) : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Keyboard className="text-muted-foreground size-4" />
          <span className="text-sm font-medium">{t("settings:hotkeys.title")}</span>
        </div>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={resetAll}>
          <RotateCcw className="size-3" />
          {t("settings:hotkeys.reset_all")}
        </Button>
      </div>

      <div className="space-y-0.5">
        {KEYBINDING_ORDER.map((action) => {
          const entry = resolved[action];
          const isEditing = editingAction === action;
          const isZoom = action === "zoomInOut";
          const isModified = !isZoom && !tokensEqual(entry.keys ?? [], DEFAULT_KEYBINDINGS[action].keys ?? []);

          return (
            <div
              key={action}
              className={cn(
                "flex items-center justify-between gap-2 rounded-md px-2 py-1.5",
                !entry.enabled && "opacity-60",
              )}
            >
              <span className="text-sm">{t(`settings:hotkeys.actions.${action}`)}</span>
              <div className="flex items-center gap-2">
                {isEditing ? (
                  <button
                    autoFocus
                    onKeyDown={(e) => handleKeyDown(e, action)}
                    onBlur={exitEditing}
                    className={cn(
                      "flex h-7 min-w-28 items-center gap-1 rounded-md border px-2 text-xs",
                      conflictAction ? "border-destructive text-destructive" : "border-input",
                    )}
                  >
                    {pendingKeys.length > 0 ? (
                      normalizeTokens(pendingKeys).map((k) => <Kbd key={k}>{formatToken(k)}</Kbd>)
                    ) : (
                      <span className="text-muted-foreground">{t("settings:hotkeys.press_keys")}</span>
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={isZoom}
                    onClick={() => startEditing(action)}
                    className={cn(
                      "flex h-7 min-w-28 items-center justify-end gap-1 rounded-md border border-transparent px-2 text-xs",
                      isZoom
                        ? "cursor-not-allowed text-muted-foreground"
                        : "hover:border-input hover:bg-muted/40",
                    )}
                  >
                    {isZoom ? (
                      <span>{t("settings:hotkeys.ctrl_wheel")}</span>
                    ) : entry.keys && entry.keys.length > 0 ? (
                      normalizeTokens(entry.keys).map((k) => <Kbd key={k}>{formatToken(k)}</Kbd>)
                    ) : (
                      <span className="text-muted-foreground">{t("settings:hotkeys.click_to_set")}</span>
                    )}
                  </button>
                )}
                {isModified && !isEditing && (
                  <button
                    type="button"
                    className="text-muted-foreground transition-colors hover:text-foreground"
                    title={t("settings:hotkeys.reset")}
                    onClick={() => resetOne(action)}
                  >
                    <RotateCcw className="size-3.5" />
                  </button>
                )}
                <Switch checked={entry.enabled} onCheckedChange={(v) => setEnabled(action, v)} />
              </div>
            </div>
          );
        })}
      </div>

      {editingAction && conflictLabel && (
        <p className="text-destructive text-xs">
          {t("settings:hotkeys.conflict_with", { name: conflictLabel })}
        </p>
      )}
    </div>
  );
}
