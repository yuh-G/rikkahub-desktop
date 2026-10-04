// components/settings/general.tsx — 通用(个人资料 / 应用)与个性化(外观 / 快捷键)四页。
// 四页共用 displaySetting,全部经 lib/settings-patch 只提交自己改动的字段。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AvatarCropper } from "~/components/avatar-cropper";
import { FontPickerPair } from "~/components/font-picker";
import { CHAT_CJK_OVERRIDE_FAMILY, UI_CJK_OVERRIDE_FAMILY } from "~/lib/font-chain";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import { KeybindingSettings } from "~/components/keybinding-settings";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Slider } from "~/components/ui/slider";
import { patchDisplay, patchSettingsLocal, saveDisplayPatch } from "~/lib/settings-patch";
import api from "~/services/api";
import type { AssistantAvatar, Settings } from "~/types";
import {
  SettingsField,
  SettingsGroup,
  SettingsRows,
  SettingsStack,
  SettingsSwitchRow,
  textValue,
} from "~/components/settings/shared";
import { isTauriEnvironment, isWindowsPlatform, getSystemInfo } from "~/lib/system-info";
import { extractErrorMessage } from "~/lib/error";

interface PageProps {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}

// 「显示思考内容」不在此列:思考卡流式中恒展开(字段保留透传,PC 不再读取)。
// 「Enter 发送」在快捷键页。
const DISPLAY_TOGGLES = [
  ["showUserAvatar", "settings:general.opt.show_user_avatar"],
  ["showModelName", "settings:general.opt.show_model_name"],
  ["showModelIcon", "settings:general.opt.show_model_icon"],
  ["showAssistantBubble", "settings:general.opt.show_assistant_bubble"],
  ["showTokenUsage", "settings:general.opt.show_token_usage"],
  ["enableAutoScroll", "settings:general.opt.auto_scroll"],
] as const;

const FONT_PREVIEW_FALLBACK = '"Noto Sans SC", "Microsoft YaHei", ui-sans-serif, system-ui, sans-serif';

/** 通用 › 个人资料:头像 + 昵称。 */
export function ProfileSection({ settings }: PageProps) {
  const { t } = useTranslation();
  const nicknameId = React.useId();
  const display = settings.displaySetting;
  const [name, setName] = React.useState(textValue(display.userNickname));
  // R8-2:防抖自动保存统一走共享三件套 hook(保存窗口内键击不丢,语义见 hook 文件头)。
  const autosave = useAutosaveDraft(
    async () => {
      await saveDisplayPatch({ userNickname: name.trim() });
    },
    { delayMs: 600, errorLabel: t("settings:subnav.general.profile") },
  );

  React.useEffect(() => {
    // 编辑中(含保存窗口内的键击)不让 settings 回环覆盖输入(R8-2 病根)。
    if (autosave.isDirty()) return;
    setName(textValue(display.userNickname));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display.userNickname]);

  return (
    <SettingsGroup fields>
      <SettingsField label={t("settings:general.avatar")}>
        <AvatarCropper
          value={display.userAvatar ?? { type: "dummy" }}
          fallbackName={name || t("settings:general.nickname")}
          onChange={(avatar: AssistantAvatar) => saveDisplayPatch({ userAvatar: avatar })}
        />
      </SettingsField>
      <SettingsField
        label={t("settings:general.nickname")}
        htmlFor={nicknameId}
        trailing={
          <AutosaveStatusRow status={autosave.status} onRetry={() => void autosave.saveNow()} />
        }
      >
        <Input
          id={nicknameId}
          value={name}
          onChange={(event) => {
            autosave.markDirty();
            setName(event.target.value);
          }}
        />
      </SettingsField>
    </SettingsGroup>
  );
}

/** 通用 › 应用:对话显示、终端(Bash,仅 Windows)、应用窗口(仅桌面壳)。 */
export function AppSection({ settings }: PageProps) {
  const { t } = useTranslation();
  const shellPathId = React.useId();
  const display = settings.displaySetting;

  // --- 关闭时最小化到托盘 —— 仅桌面壳渲染 ---
  // 该设置存在 Rust 侧的 user-config.json(跟数据目录同处),不走后端 API/SSE,
  // 因为窗口关闭的瞬间需要 Rust 直接读到它,而不是等前端回传。
  // 是否桌面壳同步可知,首帧即决定板块在不在;开关真值异步读,读到之前禁用、不显示勾选态
  // (否则关过托盘的用户会先看到 ON 再跳 OFF)。
  const tauri = isTauriEnvironment();
  const [minimizeToTray, setMinimizeToTray] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    if (!tauri) return;
    let cancelled = false;
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const value = await invoke<boolean>("get_minimize_to_tray");
        if (!cancelled) setMinimizeToTray(value);
      } catch (err) {
        console.warn("[tray] get_minimize_to_tray failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tauri]);

  // --- 终端(Bash)路径:仅 Windows 渲染(Linux/Mac 用系统 shell,无此设置) ---
  // shellPath 是机器级绝对路径,存后端 settings(走 SSE 同步);输入框本地受控,
  // 提交(失焦/回车)才 POST。后端校验 .exe + existsSync,失败 toast 并回滚到上次值。
  const [isWindows, setIsWindows] = React.useState(isWindowsPlatform());
  const [shellPath, setShellPath] = React.useState(settings.shellPath ?? "");
  const [shellBusy, setShellBusy] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    void getSystemInfo().then(() => {
      if (!cancelled) setIsWindows(isWindowsPlatform());
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // SSE 推送/外部改动时同步回输入框(用户没在编辑时)。
  React.useEffect(() => {
    setShellPath(settings.shellPath ?? "");
  }, [settings.shellPath]);

  const submitShellPath = async () => {
    const trimmed = shellPath.trim();
    if (trimmed === (settings.shellPath ?? "")) return; // 无变化不打扰
    setShellBusy(true);
    try {
      await api.post("settings/shell-path", { shellPath: trimmed });
      patchSettingsLocal({ shellPath: trimmed });
      toast.success(t("settings:general.shell_recheck_ok"));
    } catch (err) {
      setShellPath(settings.shellPath ?? ""); // 回滚
      toast.error(extractErrorMessage(err, t("settings:general.shell_path_invalid")));
    } finally {
      setShellBusy(false);
    }
  };

  return (
    <SettingsStack>
      <SettingsGroup title={t("settings:general.display_title")}>
        <SettingsRows>
          {DISPLAY_TOGGLES.map(([key, labelKey]) => (
            <SettingsSwitchRow
              key={key}
              label={t(labelKey)}
              checked={display[key] !== false}
              onCheckedChange={(checked) => patchDisplay({ [key]: checked })}
            />
          ))}
        </SettingsRows>
      </SettingsGroup>

      {isWindows && (
        <SettingsGroup
          title={t("settings:general.shell_title")}
          description={t("settings:general.shell_path_hint")}
          fields
        >
          <SettingsField label={t("settings:general.shell_path")} htmlFor={shellPathId}>
            <div className="flex items-center gap-2">
              <Input
                id={shellPathId}
                value={shellPath}
                disabled={shellBusy}
                placeholder={t("settings:general.shell_path_placeholder")}
                className="flex-1 font-mono text-xs"
                onChange={(event) => setShellPath(event.target.value)}
                onBlur={() => void submitShellPath()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitShellPath();
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={shellBusy}
                onClick={() => void submitShellPath()}
              >
                {t("settings:general.shell_recheck")}
              </Button>
            </div>
          </SettingsField>
        </SettingsGroup>
      )}

      {tauri && (
        <SettingsGroup title={t("settings:general.tray_title")} description={t("settings:general.tray_desc")}>
          <SettingsRows>
            <SettingsSwitchRow
              label={t("settings:general.minimize_to_tray")}
              description={t("settings:general.minimize_to_tray_hint")}
              checked={minimizeToTray === true}
              disabled={minimizeToTray === null}
              onCheckedChange={async (checked) => {
                // 乐观更新:先改 UI,失败回滚。invoke 走 Tauri command 写 user-config.json。
                const prev = minimizeToTray;
                setMinimizeToTray(checked);
                try {
                  const { invoke } = await import("@tauri-apps/api/core");
                  await invoke("set_minimize_to_tray", { enabled: checked });
                } catch (err) {
                  setMinimizeToTray(prev);
                  toast.error(t("settings:common.save_failed"));
                  console.warn("[tray] set_minimize_to_tray failed", err);
                }
              }}
            />
          </SettingsRows>
        </SettingsGroup>
      )}
    </SettingsStack>
  );
}

/** 个性化 › 外观:字体与字号。 */
export function AppearanceSection({ settings }: PageProps) {
  const { t } = useTranslation();
  const display = settings.displaySetting;

  // 界面字号滑块的本地镜像值。受控 Slider 的 value 若等 POST→SSE 往返才更新,松手时 thumb 会
  // 被旧 value 弹回(用户体验为"拖过去又弹回来")。改用:onValueChange 只动本地(立即跟随),
  // onValueCommit(松手)才提交后端。display 变化时(重置按钮 / SSE 推送 / Ctrl+滚轮)同步回本地。
  const uiFontSizeValue = display.uiFontSize ?? 1;
  const [uiFontSlider, setUiFontSlider] = React.useState(uiFontSizeValue);
  React.useEffect(() => {
    setUiFontSlider(uiFontSizeValue);
  }, [uiFontSizeValue]);

  return (
    <SettingsStack>
      <SettingsGroup title={t("settings:general.font_title")} fields>
        <div className="grid gap-5 md:grid-cols-2">
          <FontPickerPair
            label={t("settings:general.ui_font")}
            enValue={textValue(display.uiFontFamily)}
            cjkValue={textValue(display.uiFontFamilyCjk)}
            fallbackFamily={FONT_PREVIEW_FALLBACK}
            cjkOverrideFamily={UI_CJK_OVERRIDE_FAMILY}
            onChangeEn={(value, family) => patchDisplay({ uiFontFamily: value, uiFontFamilyCss: family })}
            onChangeCjk={(value, family) => patchDisplay({ uiFontFamilyCjk: value, uiFontFamilyCjkCss: family })}
          />
          {/* 预览兜底固定为默认链,不跟随界面字体——否则改界面字体时对话预览块跟着变,
              用户会误以为两个设置联动(内测反馈)。未设对话字体时实际聊天区仍继承界面字体。 */}
          <FontPickerPair
            label={t("settings:general.chat_font")}
            enValue={textValue(display.chatFontFamily)}
            cjkValue={textValue(display.chatFontFamilyCjk)}
            fallbackFamily={FONT_PREVIEW_FALLBACK}
            cjkOverrideFamily={CHAT_CJK_OVERRIDE_FAMILY}
            onChangeEn={(value, family) => patchDisplay({ chatFontFamily: value, chatFontFamilyCss: family })}
            onChangeCjk={(value, family) =>
              patchDisplay({ chatFontFamilyCjk: value, chatFontFamilyCjkCss: family })
            }
          />
        </div>
        <SettingsField
          label={t("settings:general.ui_font_size")}
          hint={t("settings:general.ui_font_size_hint")}
          trailing={
            <>
              <span className="text-xs tabular-nums text-[var(--ds-text-secondary)]">
                {Math.round(uiFontSlider * 100)}%
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                disabled={(display.uiFontSize ?? null) === null}
                onClick={() => patchDisplay({ uiFontSize: null })}
              >
                {t("settings:general.reset")}
              </Button>
            </>
          }
        >
          <Slider
            value={[uiFontSlider]}
            min={0.85}
            max={1.8}
            step={0.01}
            aria-label={t("settings:general.ui_font_size")}
            onValueChange={(value) => setUiFontSlider(value[0])}
            onValueCommit={(value) => {
              const next = value[0];
              // 1.00 视为"默认",存 null 以保持根字号完全等同于浏览器默认,
              // 避免任何浮点误差引入的默认态视觉偏差。
              const normalized = Math.abs(next - 1) < 0.001 ? null : Number(next.toFixed(2));
              patchDisplay({ uiFontSize: normalized });
            }}
          />
        </SettingsField>
      </SettingsGroup>
    </SettingsStack>
  );
}

/** 个性化 › 快捷键:Enter 发送 + 快捷键表。 */
export function ShortcutsSection({ settings }: PageProps) {
  const { t } = useTranslation();
  return (
    <KeybindingSettings
      leading={
        <SettingsSwitchRow
          label={t("settings:general.opt.send_on_enter")}
          description={t("settings:hotkeys.send_on_enter_desc")}
          checked={settings.displaySetting.sendOnEnter !== false}
          onCheckedChange={(checked) => patchDisplay({ sendOnEnter: checked })}
        />
      }
    />
  );
}
