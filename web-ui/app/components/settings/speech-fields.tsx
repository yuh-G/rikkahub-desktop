// components/settings/speech-fields.tsx — 按 speech-catalog 的字段声明渲染语音服务配置项。

import { useTranslation } from "react-i18next";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Slider } from "~/components/ui/slider";
import { Textarea } from "~/components/ui/textarea";
import { PasswordInput, SettingsField, SettingsRows, SettingsSwitchRow } from "~/components/settings/shared";
import type { SpeechField, SpeechFieldSection, SpeechOption } from "~/components/settings/speech-catalog";

// Radix Select 保留空串值,「自动/空」与「自定义」经哨兵往返,存储层仍是干净的值。
const EMPTY_SENTINEL = "__empty__";
const CUSTOM_SENTINEL = "__custom__";

type Draft = Record<string, unknown>;
type Patch = (patch: Draft) => void;

function optionLabel(option: SpeechOption, t: (key: string) => string) {
  return option.labelKey ? t(option.labelKey) : (option.label ?? option.value);
}

function FieldControl({ field, draft, onPatch }: { field: SpeechField; draft: Draft; onPatch: Patch }) {
  const { t } = useTranslation();
  const raw = draft[field.key];
  const text = typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
  const label = t(field.labelKey);
  const hint = field.hintKey ? t(field.hintKey) : undefined;

  switch (field.kind) {
    case "text":
      return (
        <SettingsField label={label} hint={hint}>
          <Input value={text} placeholder={field.placeholder} onChange={(event) => onPatch({ [field.key]: event.target.value })} />
        </SettingsField>
      );
    case "password":
      return (
        <SettingsField label={label} hint={hint}>
          <PasswordInput value={text} onChange={(value) => onPatch({ [field.key]: value })} />
        </SettingsField>
      );
    case "textarea":
      return (
        <SettingsField label={label} hint={hint}>
          <Textarea
            value={text}
            placeholder={field.placeholderKey ? t(field.placeholderKey) : undefined}
            onChange={(event) => onPatch({ [field.key]: event.target.value })}
          />
        </SettingsField>
      );
    case "select": {
      const options = field.options(draft);
      const current = raw === undefined || raw === null ? field.fallback : text;
      return (
        <SettingsField label={label} hint={hint}>
          <Select
            value={current === "" ? EMPTY_SENTINEL : current}
            onValueChange={(value) => {
              const next = value === EMPTY_SENTINEL ? "" : value;
              onPatch({ [field.key]: field.numeric ? Number(next) : next });
            }}
          >
            <SelectTrigger className="w-full" aria-label={label}>
              <SelectValue placeholder={field.placeholderKey ? t(field.placeholderKey) : undefined} />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value === "" ? EMPTY_SENTINEL : option.value}>
                  {optionLabel(option, t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsField>
      );
    }
    case "preset": {
      const isPreset = field.presets.includes(text);
      return (
        <SettingsField label={label} hint={hint}>
          <div className="flex gap-2">
            <Select
              value={isPreset ? text : CUSTOM_SENTINEL}
              // 从预设切到「自定义」时清空,提示用户填入;已在自定义态再选一次不动现值。
              onValueChange={(value) => {
                if (value !== CUSTOM_SENTINEL) onPatch({ [field.key]: value });
                else if (isPreset) onPatch({ [field.key]: "" });
              }}
            >
              <SelectTrigger className="min-w-0 flex-1" aria-label={label}>
                <SelectValue placeholder={t("settings:speech.select_voice")} />
              </SelectTrigger>
              <SelectContent>
                {field.presets.map((preset) => (
                  <SelectItem key={preset} value={preset}>
                    {preset}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_SENTINEL}>{t("settings:speech.custom_voice")}</SelectItem>
              </SelectContent>
            </Select>
            {!isPreset ? (
              <Input
                className="min-w-0 flex-1"
                value={text}
                aria-label={label}
                placeholder={t("settings:speech.custom_voice_ph")}
                onChange={(event) => onPatch({ [field.key]: event.target.value })}
              />
            ) : null}
          </div>
        </SettingsField>
      );
    }
    case "slider": {
      const value = Number(raw ?? field.fallback);
      const safe = Number.isFinite(value) ? value : field.fallback;
      const clamp = (next: number) => Math.min(field.max, Math.max(field.min, next));
      return (
        <SettingsField label={label} hint={hint}>
          <div className="flex items-center gap-3">
            <Slider
              min={field.min}
              max={field.max}
              step={field.step}
              value={[safe]}
              aria-label={label}
              onValueChange={([next]) => onPatch({ [field.key]: next ?? field.fallback })}
            />
            <Input
              className="w-24"
              inputMode="decimal"
              aria-label={label}
              value={String(safe)}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next)) onPatch({ [field.key]: clamp(next) });
              }}
            />
          </div>
        </SettingsField>
      );
    }
    case "switch":
      // 单个开关按行式渲染,与页内其它开关同一视觉。
      return (
        <SettingsRows>
          <SettingsSwitchRow
            label={label}
            description={hint}
            checked={typeof raw === "boolean" ? raw : field.fallback}
            onCheckedChange={(checked) => onPatch({ [field.key]: checked })}
          />
        </SettingsRows>
      );
  }
}

/** 渲染某一分区(基础 / 高级)的全部字段,纵向统一节奏。 */
export function SpeechFields({
  fields,
  section,
  draft,
  onPatch,
}: {
  fields: readonly SpeechField[];
  section: SpeechFieldSection;
  draft: Draft;
  onPatch: Patch;
}) {
  return (
    <>
      {fields
        .filter((field) => field.section === section)
        .map((field) => (
          <FieldControl key={field.key} field={field} draft={draft} onPatch={onPatch} />
        ))}
    </>
  );
}
