// components/settings/speech.tsx — 语音 › 文字转语音 / 语音识别两页(服务配置与试听)。
// 每个服务的配置字段由 speech-catalog 声明、speech-fields 渲染,本文件只管列表/选择/保存/试听。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Check, Square, Volume2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { getAudioPlaybackKey, playAudio, stopAudio, useAudioPlaybackKey } from "~/lib/global-audio";
import { patchDisplay } from "~/lib/settings-patch";
import api from "~/services/api";
import { confirmDialog } from "~/stores/confirm-store";
import type { AsrProviderProfile, AsrProviderType, Settings, TtsProviderProfile, TtsProviderType } from "~/types";
import {
  clone,
  moveItem,
  SettingsAdvancedSection,
  SettingsDetailFooter,
  SettingsDetailHeader,
  SettingsEmpty,
  SettingsField,
  SettingsGroup,
  SettingsListAddButton,
  SettingsListRow,
  SettingsRows,
  SettingsSplit,
  SettingsStack,
  SettingsSwitchRow,
} from "~/components/settings/shared";
import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import {
  ASR_TYPES,
  asrFields,
  asrSpec,
  createAsrProvider,
  createTtsProvider,
  hasCustomizedAdvanced,
  TTS_TYPES,
  ttsFields,
  ttsSpec,
} from "~/components/settings/speech-catalog";
import { SpeechFields } from "~/components/settings/speech-fields";

// 设置页试听的播放键前缀;卸载时据此判断当前播放的是不是本页的试听。
const TTS_TEST_KEY_PREFIX = "__tts-test__";

type Draft = Record<string, unknown>;

function useTtsTypeLabel() {
  const { t } = useTranslation();
  return (type: string) => {
    const spec = ttsSpec(type);
    return spec?.labelKey ? t(spec.labelKey) : (spec?.label ?? type);
  };
}

function asrTypeLabel(type: string) {
  return asrSpec(type)?.label ?? type;
}

/** 服务列表的一行:名称 + 类型,当前使用中的打勾。 */
function ProviderListItem({ name, typeLabel, current }: { name: string; typeLabel: string; current: boolean }) {
  const { t } = useTranslation();
  return (
    <span className="flex min-w-0 items-center justify-between gap-3 text-left">
      <span className="min-w-0">
        <span className="block truncate font-medium">{name}</span>
        <span className="block truncate text-xs text-[var(--ds-text-secondary)]">{typeLabel}</span>
      </span>
      {current ? (
        <Check className="size-4 shrink-0 text-primary" aria-label={t("settings:speech.selected")} />
      ) : null}
    </span>
  );
}

/** 「设为当前」与「已选择」:当前项给中性已选态(不可再点),其余给描边按钮。 */
function SetCurrentButton({ current, onSelect }: { current: boolean; onSelect: () => void }) {
  const { t } = useTranslation();
  return (
    <Button size="sm" variant={current ? "secondary" : "outline"} disabled={current} onClick={onSelect}>
      {current ? <Check className="size-4" /> : null}
      {current ? t("settings:speech.selected") : t("settings:speech.set_current")}
    </Button>
  );
}

function EmptyDetail({ text }: { text: string }) {
  return (
    <SettingsEmpty size="md">
      {text}
    </SettingsEmpty>
  );
}

/** 语音 › 文字转语音:语音合成服务列表/详情 + 朗读过滤。 */
export function TtsSection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const providers = settings.ttsProviders ?? [];
  const [selectedId, setSelectedId] = React.useState(
    settings.selectedTTSProviderId ?? providers[0]?.id ?? "",
  );
  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0];
  const [draft, setDraft] = React.useState<TtsProviderProfile | null>(
    selected ? clone(selected) : null,
  );
  // R8-2:防抖自动保存统一走共享三件套 hook(保存窗口内键击不丢,语义见 hook 文件头)。
  // 原实现是"每次编辑 setTimeout(0) 整包立即保存":连续输入=每键一个 POST,且下方的
  // 重对齐 effect 依赖 providers(settings 派生),每次保存回环都重触发 setDraft,把
  // 在飞键击当场冲掉(R8-2 病根)。
  const autosave = useAutosaveDraft(
    async () => {
      if (!draft) return;
      await saveProvider(draft);
    },
    { onSaveError: (error) => toast.error((error as Error).message) },
  );

  // providersRef:重对齐只在切换条目(selectedId)时重载表单。providers 是 settings 派生,
  // 不能作依赖——每次 autosave → onSettings 回环都会重触发并冲掉在飞键击(R8-2 病根,
  // 同 McpServerEditor 的 serversRef 说明)。
  const providersRef = React.useRef(providers);
  providersRef.current = providers;
  React.useEffect(() => {
    const next = providersRef.current.find((provider) => provider.id === selectedId) ?? providersRef.current[0];
    setDraft(next ? clone(next) : null);
    autosave.reset();
  }, [selectedId]);

  const saveProvider = React.useCallback(
    async (provider: TtsProviderProfile) => {
      const result = await api.post<{ provider: TtsProviderProfile }>(
        "settings/tts-provider/detail",
        provider,
      );
      const exists = providers.some((item) => item.id === result.provider.id);
      const ttsProviders = exists
        ? providers.map((item) => (item.id === result.provider.id ? result.provider : item))
        : [result.provider, ...providers];
      onSettings({
        ...settings,
        ttsProviders,
        selectedTTSProviderId: settings.selectedTTSProviderId ?? result.provider.id,
      });
      setSelectedId(result.provider.id);
    },
    [onSettings, providers, settings],
  );

  const patchDraft = React.useCallback(
    (patch: Partial<TtsProviderProfile>) => {
      autosave.markDirty();
      setDraft((current) => (current ? { ...current, ...patch } : current));
    },
    [autosave],
  );

  const addProvider = React.useCallback(
    async (type: TtsProviderType) => {
      await saveProvider(createTtsProvider(type));
    },
    [saveProvider],
  );

  const reorderProviders = React.useCallback(
    (from: number, to: number) => {
      const ttsProviders = moveItem(providers, from, to);
      onSettings({ ...settings, ttsProviders });
      void api
        .post("settings/tts-provider/reorder", { ids: ttsProviders.map((item) => item.id) })
        .catch((error: Error) => toast.error(error.message));
    },
    [onSettings, providers, settings],
  );

  // 朗读过滤开关(台账 §4.1)直写 displaySetting —— 与 provider 无关的全局朗读行为,
  // 不走 provider autosave。
  const display = settings.displaySetting;

  const selectProvider = React.useCallback(
    async (providerId: string) => {
      setSelectedId(providerId);
      await api.post("settings/tts-provider/select", { id: providerId });
      onSettings({ ...settings, selectedTTSProviderId: providerId });
    },
    [onSettings, settings],
  );

  // 删除收口到列表行(右键/悬停「⋯」):按目标行 id 删,不再依赖右侧草稿。系统语音不可删。
  const removeProviderById = React.useCallback(async (targetId: string) => {
    const target = providers.find((provider) => provider.id === targetId);
    if (!target || target.type === "system") return;
    // R8-1:破坏性删除必须确认(与供应商/助手/MCP 删除同规)
    if (!(await confirmDialog({ title: t("settings:speech.tts_delete_confirm", { name: String(target.name ?? "") }), danger: true }))) return;
    // 防复活:仅当删的是正在编辑的那条才 discard(丢脏编辑+等在飞保存,DELETE 不与迟到 POST 乱序,复审 F1)
    const removingActive = draft?.id === targetId;
    if (removingActive) await autosave.discard();
    await api.delete(`settings/tts-provider/${encodeURIComponent(targetId)}`);
    const ttsProviders = providers.filter((provider) => provider.id !== targetId);
    onSettings({
      ...settings,
      ttsProviders,
      selectedTTSProviderId:
        settings.selectedTTSProviderId === targetId
          ? (ttsProviders[0]?.id ?? null)
          : settings.selectedTTSProviderId,
    });
    // 删的是当前编辑行:选中下一个;删的是别的行:选中保持不动。
    if (removingActive) setSelectedId(ttsProviders[0]?.id ?? "");
  }, [draft?.id, onSettings, providers, settings, t, autosave]);

  // Test playback uses the global audio singleton with a synthetic key so the test button
  // can toggle (play vs stop) and so that starting the test stops any in-progress chat
  // message playback. The key embeds the draft id so multiple settings panels (if ever
  // mounted) don't collide.
  const testPlaybackKey = draft ? `${TTS_TEST_KEY_PREFIX}:${draft.id}` : TTS_TEST_KEY_PREFIX;
  const playingKey = useAudioPlaybackKey();
  const isTestPlaying = playingKey === testPlaybackKey;
  // 试听只属于本页:切到语音识别、关掉设置时一并停止。在飞的合成请求回来时页面已卸载,
  // 结果直接丢弃(否则离开页面后才开始出声,而浮动播放条不管试听,用户找不到停止入口)。
  // 系统语音由服务端在本机播放,前端停不了,要通知服务端取消。
  const mountedRef = React.useRef(true);
  const systemTestRef = React.useRef(false);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (getAudioPlaybackKey()?.startsWith(TTS_TEST_KEY_PREFIX)) stopAudio();
      if (systemTestRef.current) {
        systemTestRef.current = false;
        // 尽力而为:服务端已播完或已退出时请求失败无妨。
        void api.post("tts/cancel").catch(() => undefined);
      }
    };
  }, []);

  const handleTest = React.useCallback(async () => {
    if (!draft) return;
    if (isTestPlaying) {
      stopAudio();
      return;
    }
    try {
      // The backend's `tts/speech` endpoint accepts a `providerId` override — this is
      // critical so the test fires against the provider being edited, not the globally
      // selected one (which may be a different provider entirely). The draft must be
      // already saved for this to work — autosave is debounced now, so flush any
      // pending edits before firing the test.
      await autosave.saveNow();
      const response = await api.postBlob("tts/speech", {
        text: t("settings:speech.test_text"),
        providerId: draft.id,
      });
      const contentType = response.headers.get("Content-Type") ?? "";
      if (contentType.includes("application/json")) {
        // System TTS path — Windows is speaking on-device; nothing for us to play.
        if (!mountedRef.current) {
          void api.post("tts/cancel").catch(() => undefined);
          return;
        }
        systemTestRef.current = true;
        toast.success(t("settings:speech.test_system_done"));
        return;
      }
      if (!mountedRef.current) return;
      const blob = await response.blob();
      if (!mountedRef.current) return;
      const url = URL.createObjectURL(blob);
      await playAudio(testPlaybackKey, url, url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:speech.test_failed"));
    }
  }, [draft, isTestPlaying, testPlaybackKey, t]);

  const typeLabel = useTtsTypeLabel();
  // 「高级设置」展开态:切换服务不收起,离开本页(重挂载)复位为收起。
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const fields = draft ? ttsFields(draft.type) : [];
  const patchFields = (patch: Draft) => patchDraft(patch as Partial<TtsProviderProfile>);

  return (
    <SettingsStack>
      <SettingsSplit
        list={
          <div className="space-y-1">
            <SettingsListAddButton
              label={t("settings:speech.add_tts")}
              items={TTS_TYPES.map((type) => ({
                key: type,
                label: typeLabel(type),
                onSelect: () => void addProvider(type),
              }))}
            />
            {providers.map((provider, index) => (
              <SettingsListRow
                key={provider.id}
                id={provider.id}
                index={index}
                active={provider.id === selectedId}
                onSelect={() => setSelectedId(provider.id)}
                onMove={reorderProviders}
                onDelete={
                  provider.type === "system" ? undefined : () => removeProviderById(provider.id)
                }
              >
                <ProviderListItem
                  name={provider.name}
                  typeLabel={typeLabel(provider.type)}
                  current={provider.id === settings.selectedTTSProviderId}
                />
              </SettingsListRow>
            ))}
            {providers.length === 0 ? (
              <div className="p-6 text-center text-sm text-[var(--ds-text-secondary)]">{t("settings:speech.tts_empty")}</div>
            ) : null}
          </div>
        }
      >
        {draft ? (
          <div className="@container">
            <SettingsStack>
              <SettingsDetailHeader
                title={draft.name}
                titlePlaceholder={typeLabel(draft.type)}
                titleLabel={t("settings:speech.name")}
                onTitleCommit={(name) => patchDraft({ name })}
                description={t("settings:speech.tts_detail_desc", { type: typeLabel(draft.type) })}
                action={
                  <>
                    <Button size="compact" variant="tertiary" onClick={() => void handleTest()} title={t("settings:speech.test_title")}>
                      {isTestPlaying ? <Square className="size-4" /> : <Volume2 className="size-4" />}
                      {isTestPlaying ? t("settings:speech.stop") : t("settings:speech.test")}
                    </Button>
                    <SetCurrentButton
                      current={draft.id === settings.selectedTTSProviderId}
                      onSelect={() => void selectProvider(draft.id)}
                    />
                  </>
                }
              />

              <SettingsGroup fields>
                <SpeechFields fields={fields} section="basic" draft={draft} onPatch={patchFields} />
              </SettingsGroup>

              {fields.some((field) => field.section === "advanced") ? (
                <SettingsAdvancedSection
                  open={advancedOpen}
                  onOpenChange={setAdvancedOpen}
                  attention={hasCustomizedAdvanced(draft, fields, ttsSpec(draft.type)?.template())}
                >
                  <div className="space-y-5 pt-2">
                    <SpeechFields fields={fields} section="advanced" draft={draft} onPatch={patchFields} />
                  </div>
                </SettingsAdvancedSection>
              ) : null}

              <SettingsDetailFooter
                status={<AutosaveStatusRow status={autosave.status} onRetry={() => void autosave.saveNow()} />}
              />
            </SettingsStack>
          </div>
        ) : (
          <EmptyDetail text={t("settings:speech.select_tts")} />
        )}
      </SettingsSplit>

      {/* 朗读过滤对所有服务生效,是朗读偏好而非某个服务的配置,放在服务配置之后。 */}
      <SettingsGroup title={t("settings:speech.read_filter_title")} description={t("settings:speech.read_filter_desc")}>
        <SettingsRows>
          <SettingsSwitchRow
            label={t("settings:speech.only_read_quoted")}
            description={t("settings:speech.only_read_quoted_desc")}
            checked={display.ttsOnlyReadQuoted === true}
            onCheckedChange={(checked) => patchDisplay({ ttsOnlyReadQuoted: checked })}
          />
          <SettingsSwitchRow
            label={t("settings:speech.skip_brackets")}
            description={t("settings:speech.skip_brackets_desc")}
            checked={display.ttsOnlyReadOutsideBrackets === true}
            onCheckedChange={(checked) => patchDisplay({ ttsOnlyReadOutsideBrackets: checked })}
          />
        </SettingsRows>
      </SettingsGroup>
    </SettingsStack>
  );
}

/** 语音 › 语音识别:语音识别服务列表/详情。 */
export function AsrSection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const providers = settings.asrProviders ?? [];
  const [selectedId, setSelectedId] = React.useState(
    settings.selectedASRProviderId ?? providers[0]?.id ?? "",
  );
  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0];
  const [draft, setDraft] = React.useState<AsrProviderProfile | null>(
    selected ? clone(selected) : null,
  );
  // R8-2:同 TTS 面板——防抖自动保存走共享三件套 hook,重对齐仅随 selectedId。
  const autosave = useAutosaveDraft(
    async () => {
      if (!draft) return;
      await saveProvider(draft);
    },
    { onSaveError: (error) => toast.error((error as Error).message) },
  );

  // providersRef:重对齐只在切换条目(selectedId)时重载表单。providers 是 settings 派生,
  // 不能作依赖——每次 autosave → onSettings 回环都会重触发并冲掉在飞键击(R8-2 病根,
  // 同 McpServerEditor 的 serversRef 说明)。
  const providersRef = React.useRef(providers);
  providersRef.current = providers;
  React.useEffect(() => {
    const next = providersRef.current.find((provider) => provider.id === selectedId) ?? providersRef.current[0];
    setDraft(next ? clone(next) : null);
    autosave.reset();
  }, [selectedId]);

  const saveProvider = React.useCallback(
    async (provider: AsrProviderProfile) => {
      const result = await api.post<{ provider: AsrProviderProfile }>(
        "settings/asr-provider/detail",
        provider,
      );
      const exists = providers.some((item) => item.id === result.provider.id);
      const asrProviders = exists
        ? providers.map((item) => (item.id === result.provider.id ? result.provider : item))
        : [result.provider, ...providers];
      onSettings({
        ...settings,
        asrProviders,
        selectedASRProviderId: settings.selectedASRProviderId ?? result.provider.id,
      });
      setSelectedId(result.provider.id);
    },
    [onSettings, providers, settings],
  );

  const patchDraft = React.useCallback(
    (patch: Partial<AsrProviderProfile>) => {
      autosave.markDirty();
      setDraft((current) => (current ? { ...current, ...patch } : current));
    },
    [autosave],
  );

  const addProvider = React.useCallback(
    async (type: AsrProviderType) => {
      const provider = createAsrProvider(type);
      await saveProvider(provider);
    },
    [saveProvider],
  );

  const reorderProviders = React.useCallback(
    (from: number, to: number) => {
      const asrProviders = moveItem(providers, from, to);
      onSettings({ ...settings, asrProviders });
      void api
        .post("settings/asr-provider/reorder", { ids: asrProviders.map((item) => item.id) })
        .catch((error: Error) => toast.error(error.message));
    },
    [onSettings, providers, settings],
  );

  const selectProvider = React.useCallback(
    async (providerId: string) => {
      setSelectedId(providerId);
      await api.post("settings/asr-provider/select", { id: providerId });
      onSettings({ ...settings, selectedASRProviderId: providerId });
    },
    [onSettings, settings],
  );

  // 删除收口到列表行(右键/悬停「⋯」):按目标行 id 删,不再依赖右侧草稿。
  const removeProviderById = React.useCallback(async (targetId: string) => {
    const target = providers.find((provider) => provider.id === targetId);
    if (!target) return;
    // R8-1:破坏性删除必须确认(与供应商/助手/MCP 删除同规)
    if (!(await confirmDialog({ title: t("settings:speech.asr_delete_confirm", { name: String(target.name ?? "") }), danger: true }))) return;
    // 防复活:仅当删的是正在编辑的那条才 discard(丢脏编辑+等在飞保存,DELETE 不与迟到 POST 乱序,复审 F1)
    const removingActive = draft?.id === targetId;
    if (removingActive) await autosave.discard();
    await api.delete(`settings/asr-provider/${encodeURIComponent(targetId)}`);
    const asrProviders = providers.filter((provider) => provider.id !== targetId);
    onSettings({
      ...settings,
      asrProviders,
      selectedASRProviderId:
        settings.selectedASRProviderId === targetId
          ? (asrProviders[0]?.id ?? null)
          : settings.selectedASRProviderId,
    });
    // 删的是当前编辑行:选中下一个;删的是别的行:选中保持不动。
    if (removingActive) setSelectedId(asrProviders[0]?.id ?? "");
  }, [draft?.id, onSettings, providers, settings, t, autosave]);

  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const fields = draft ? asrFields(draft.type) : [];
  const patchFields = (patch: Draft) => patchDraft(patch as Partial<AsrProviderProfile>);

  return (
    <SettingsSplit
      scroll
      list={
        <div className="space-y-1">
          <SettingsListAddButton
            label={t("settings:speech.add_asr")}
            items={ASR_TYPES.map((type) => ({
              key: type,
              label: asrTypeLabel(type),
              onSelect: () => void addProvider(type),
            }))}
          />
          {providers.map((provider, index) => (
            <SettingsListRow
              key={provider.id}
              id={provider.id}
              index={index}
              active={provider.id === selectedId}
              onSelect={() => setSelectedId(provider.id)}
              onMove={reorderProviders}
              onDelete={() => removeProviderById(provider.id)}
            >
              <ProviderListItem
                name={provider.name}
                typeLabel={asrTypeLabel(provider.type)}
                current={provider.id === settings.selectedASRProviderId}
              />
            </SettingsListRow>
          ))}
          {providers.length === 0 ? (
            <div className="p-6 text-center text-sm text-[var(--ds-text-secondary)]">{t("settings:speech.asr_empty")}</div>
          ) : null}
        </div>
      }
    >
      {draft ? (
        <div className="@container">
          <SettingsStack>
            <SettingsDetailHeader
              title={draft.name}
              titlePlaceholder={asrTypeLabel(draft.type)}
              titleLabel={t("settings:speech.name")}
              onTitleCommit={(name) => patchDraft({ name })}
              description={t("settings:speech.asr_detail_desc", { type: asrTypeLabel(draft.type) })}
              action={
                <SetCurrentButton
                  current={draft.id === settings.selectedASRProviderId}
                  onSelect={() => void selectProvider(draft.id)}
                />
              }
            />

            <SettingsGroup fields>
              <SpeechFields fields={fields} section="basic" draft={draft} onPatch={patchFields} />
            </SettingsGroup>

            {fields.some((field) => field.section === "advanced") ? (
              <SettingsAdvancedSection
                open={advancedOpen}
                onOpenChange={setAdvancedOpen}
                attention={hasCustomizedAdvanced(draft, fields, asrSpec(draft.type)?.template())}
              >
                <div className="space-y-5 pt-2">
                  <SpeechFields fields={fields} section="advanced" draft={draft} onPatch={patchFields} />
                </div>
              </SettingsAdvancedSection>
            ) : null}

            <SettingsDetailFooter
              status={<AutosaveStatusRow status={autosave.status} onRetry={() => void autosave.saveNow()} />}
            />
          </SettingsStack>
        </div>
      ) : (
        <EmptyDetail text={t("settings:speech.select_asr")} />
      )}
    </SettingsSplit>
  );
}
