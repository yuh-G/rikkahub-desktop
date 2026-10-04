/**
 * 设置页 - 个性化 - 快捷键 的快捷键表。
 *
 * 每行:功能名 | 绑定显示/录制按钮 | 重置(仅修改过时) | 启用开关。
 * 录制:点按钮进入编辑态 → 暂停全局快捷键(setHotkeysPaused)→ 按键实时采集 → 合法且无冲突即
 * 保存并退出;Esc / 失焦退出。zoomInOut 固定 Ctrl+滚轮,不可录制,只有开关。
 * 冲突:录制时 findConflict 实时比对其它已启用的绑定,冲突即红字提示并拒绝保存。
 */
import * as React from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { SettingsGroup, SettingsRows } from "~/components/settings/shared";
import { confirmDialog } from "~/stores/confirm-store";
import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import { Switch } from "~/components/ui/switch";
import { setHotkeysPaused } from "~/lib/hotkey-events";
import {
  DEFAULT_KEYBINDINGS,
  KEYBINDING_ORDER,
  eventToTokens,
  findConflict,
  formatToken,
  isValidBinding,
  normalizeTokens,
  tokensEqual,
} from "~/lib/hotkeys";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import { useSettingsStore } from "~/stores";
import type { KeybindingAction, KeybindingEntry } from "~/types/settings";

/** leading:排在快捷键表之前、同属一张行列表的行(快捷键页的 Enter 发送)。 */
export function KeybindingSettings({ leading }: { leading?: React.ReactNode }) {
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

  // 后端写入后经 SSE 回推,UI 不做乐观更新;失败只需提示。
  const postBinding = (body: { action: KeybindingAction; keys?: string[]; enabled?: boolean }) => {
    api.post("settings/keybindings", body).catch((error: unknown) => {
      toast.error(t("settings:common.save_failed"), {
        description: error instanceof Error ? error.message : undefined,
      });
    });
  };
  const saveKeys = (action: KeybindingAction, keys: string[]) => postBinding({ action, keys, enabled: true });
  const setEnabled = (action: KeybindingAction, enabled: boolean) => postBinding({ action, enabled });
  const resetOne = (action: KeybindingAction) => {
    const def = DEFAULT_KEYBINDINGS[action];
    postBinding({ action, keys: def.keys ?? [], enabled: def.enabled });
  };
  // 后端一次原子写入同时恢复全部快捷键与 Enter 发送(同页的两类设置)。
  const resetAll = async () => {
    const confirmed = await confirmDialog({
      title: t("settings:hotkeys.reset_all_confirm_title"),
      description: t("settings:hotkeys.reset_all_confirm_desc"),
      confirmLabel: t("settings:hotkeys.reset_all"),
    });
    if (!confirmed) return;
    try {
      await api.post("settings/keybindings/reset");
    } catch (error) {
      toast.error(t("settings:common.save_failed"), {
        description: error instanceof Error ? error.message : undefined,
      });
    }
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
    <SettingsGroup>
      <SettingsRows>
        {leading}
        {KEYBINDING_ORDER.map((action) => {
          const entry = resolved[action];
          const isEditing = editingAction === action;
          const isZoom = action === "zoomInOut";
          const isModified = !isZoom && !tokensEqual(entry.keys ?? [], DEFAULT_KEYBINDINGS[action].keys ?? []);

          return (
            <div
              key={action}
              data-settings-item=""
              className={cn(
                "flex items-center justify-between gap-2 py-2",
                !entry.enabled && "opacity-60",
              )}
            >
              <span data-settings-label="" className="text-sm font-medium">{t(`settings:hotkeys.actions.${action}`)}</span>
              <div className="flex items-center gap-2">
                {/* 录制钮两态与输入框同语言:静止是 ghost 胶囊,录制中亮起聚焦阴影。 */}
                {isEditing ? (
                  <button
                    autoFocus
                    onKeyDown={(e) => handleKeyDown(e, action)}
                    onBlur={exitEditing}
                    className={cn(
                      "flex h-7 min-w-28 items-center justify-end gap-1 rounded-[var(--ds-radius-pill)] bg-[var(--ds-surface-input)] px-2.5 text-xs outline-none",
                      conflictAction
                        ? "text-[var(--ds-danger)] shadow-[0_0_0_1px_var(--ds-danger)]"
                        : "shadow-[var(--ds-input-shadow-focus)]",
                    )}
                  >
                    {pendingKeys.length > 0 ? (
                      normalizeTokens(pendingKeys).map((k) => <Kbd key={k}>{formatToken(k)}</Kbd>)
                    ) : (
                      <span className="text-[var(--ds-text-tertiary)]">{t("settings:hotkeys.press_keys")}</span>
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={isZoom}
                    onClick={() => startEditing(action)}
                    className={cn(
                      "flex h-7 min-w-28 items-center justify-end gap-1 rounded-[var(--ds-radius-pill)] px-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                      isZoom
                        ? "cursor-not-allowed text-[var(--ds-text-tertiary)]"
                        : "hover:bg-[var(--ds-on-surface)]",
                    )}
                  >
                    {isZoom ? (
                      <span>{t("settings:hotkeys.ctrl_wheel")}</span>
                    ) : entry.keys && entry.keys.length > 0 ? (
                      normalizeTokens(entry.keys).map((k) => <Kbd key={k}>{formatToken(k)}</Kbd>)
                    ) : (
                      <span className="text-[var(--ds-text-tertiary)]">{t("settings:hotkeys.click_to_set")}</span>
                    )}
                  </button>
                )}
                {isModified && !isEditing && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-[var(--ds-icon)]"
                    aria-label={t("settings:hotkeys.reset")}
                    title={t("settings:hotkeys.reset")}
                    onClick={() => resetOne(action)}
                  >
                    <RotateCcw className="size-3.5" />
                  </Button>
                )}
                <Switch
                  checked={entry.enabled}
                  aria-label={t(`settings:hotkeys.actions.${action}`)}
                  onCheckedChange={(v) => setEnabled(action, v)}
                />
              </div>
            </div>
          );
        })}
      </SettingsRows>

      {editingAction && conflictLabel && (
        <p className="text-xs text-[var(--ds-danger)]">
          {t("settings:hotkeys.conflict_with", { name: conflictLabel })}
        </p>
      )}

      {/* 尾部动作:整页扫完快捷键后才轮到「全部恢复默认」,放头部会抢在阅读流之前。 */}
      <div className="flex justify-end pt-3">
        <Button variant="ghost" size="compact" onClick={() => void resetAll()}>
          <RotateCcw />
          {t("settings:hotkeys.reset_all")}
        </Button>
      </div>
    </SettingsGroup>
  );
}
