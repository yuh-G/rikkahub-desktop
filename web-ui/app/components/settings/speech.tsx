// components/settings/speech.tsx — 语音分区（TTS/ASR provider 配置与试听，纯搬迁自 routes/settings.tsx）

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Check, Mic, Quote, Square, Trash2, Volume2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import { Slider } from "~/components/ui/slider";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { playAudio, stopAudio, useAudioPlaybackKey } from "~/lib/global-audio";
import api from "~/services/api";
import { confirmDialog } from "~/stores/confirm-store";
import type {
  AsrProviderProfile,
  AsrProviderType,
  Settings,
  TtsProviderProfile,
  TtsProviderType,
} from "~/types";
import { clone, moveItem, PasswordInput, SectionHeader, SortableRow } from "~/components/settings/shared";

function createAsrProvider(type: AsrProviderType = "openai_realtime"): AsrProviderProfile {
  const base = {
    id: crypto.randomUUID(),
    type,
    apiKey: "",
    language: "",
  } as AsrProviderProfile;
  if (type === "dashscope") {
    return {
      ...base,
      name: "DashScope ASR",
      websocketUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
      model: "qwen3-asr-flash-realtime",
      sampleRate: 16000,
      vadThreshold: 0.2,
      silenceDurationMs: 800,
    };
  }
  if (type === "volcengine") {
    return {
      ...base,
      name: "Volcengine ASR",
      websocketUrl: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
      resourceId: "volc.seedasr.sauc.duration",
    };
  }
  return {
    ...base,
    name: "OpenAI Realtime ASR",
    websocketUrl: "wss://api.openai.com/v1/realtime?intent=transcription",
    model: "gpt-4o-transcribe",
    prompt: "",
    sampleRate: 24000,
    vadThreshold: 0.5,
    prefixPaddingMs: 300,
    silenceDurationMs: 500,
  };
}

function createTtsProvider(type: TtsProviderType = "system"): TtsProviderProfile {
  const base = {
    id: crypto.randomUUID(),
    type,
    apiKey: "",
    baseUrl: "",
  } as TtsProviderProfile;
  if (type === "openai")
    return {
      ...base,
      name: "OpenAI TTS",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-tts",
      voice: "alloy",
    };
  if (type === "gemini")
    return {
      ...base,
      name: "Gemini TTS",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-2.5-flash-preview-tts",
      voiceName: "Kore",
    };
  if (type === "minimax")
    return {
      ...base,
      name: "MiniMax TTS",
      baseUrl: "https://api.minimaxi.com/v1",
      model: "speech-2.6-turbo",
      voiceId: "female-shaonv",
      emotion: "calm",
      speed: 1,
    };
  if (type === "qwen")
    return {
      ...base,
      name: "Qwen TTS",
      // qwen-audio-3.0(§4.5):baseUrl 含 {WorkspaceId} 占位符,用户须替换为阿里云百炼业务空间 ID。
      baseUrl: "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1",
      model: "qwen-audio-3.0-tts-flash",
      voice: "longanhuan_v3.6",
      format: "wav",
      sampleRate: 24000,
    };
  if (type === "groq")
    return {
      ...base,
      name: "Groq TTS",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "canopylabs/orpheus-v1-english",
      voice: "austin",
    };
  if (type === "xai")
    return {
      ...base,
      name: "xAI TTS",
      baseUrl: "https://api.x.ai/v1",
      voiceId: "eve",
      language: "auto",
    };
  if (type === "mimo")
    return {
      ...base,
      name: "MiMo TTS",
      baseUrl: "https://api.xiaomimimo.com/v1",
      model: "mimo-v2.5-tts",
      voice: "mimo_default",
    };
  if (type === "elevenlabs")
    return {
      ...base,
      name: "ElevenLabs TTS",
      baseUrl: "https://api.elevenlabs.io",
      model: "eleven_multilingual_v2",
      voiceId: "JBFqnCBsd6RMkjVDRZzb",
      stability: 0.5,
      similarityBoost: 0.75,
    };
  if (type === "step")
    return {
      ...base,
      name: "Step TTS",
      baseUrl: "https://api.stepfun.com",
      model: "step-tts-mini",
      voice: "elegantgentle-female",
      responseFormat: "mp3",
      speed: 1,
      volume: 1,
      sampleRate: 24000,
      instruction: "",
    };
  if (type === "fish-audio")
    return {
      ...base,
      name: "Fish Audio TTS",
      baseUrl: "https://api.fish.audio",
      model: "s2.1-pro",
      referenceId: "",
      temperature: 0.7,
      speed: 1,
      format: "mp3",
      topP: 0.7,
      chunkLength: 300,
      normalize: true,
      latency: "normal",
    };
  return {
    ...base,
    id: "026a01a2-c3a0-4fd5-8075-80e03bdef200",
    name: "System TTS",
    speechRate: 1,
    pitch: 1,
  };
}

// Voice option lists per provider type. These mirror the curated dropdowns in Android's
// `TTSProviderConfigure.kt` — using `<Select>` (vs free-text `<Input>`) prevents typos
// that would otherwise cause silent 400/422 from the provider with no UI feedback.
// Lists are taken verbatim from the Android source as of v2.2.5.
const TTS_VOICES_OPENAI = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;
const TTS_VOICES_GROQ = ["austin", "natalie", "kailin"] as const;
const TTS_VOICES_XAI = ["eve", "ara", "rex", "sal", "leo"] as const;
const TTS_VOICES_MINIMAX = [
  "male-qn-qingse",
  "male-qn-jingying",
  "male-qn-badao",
  "male-qn-daxuesheng",
  "female-shaonv",
  "female-yujie",
  "female-chengshu",
  "female-tianmei",
  "audiobook_male_1",
  "audiobook_female_1",
  "cartoon_pig",
] as const;
const TTS_EMOTIONS_MINIMAX = [
  "calm",
  "happy",
  "sad",
  "angry",
  "fearful",
  "disgusted",
  "surprised",
] as const;
// qwen-audio-3.0(§4.5):音色按 model 分两组,对齐安卓 TTSProviderConfigure.kt:591 的 when 分支。
const TTS_VOICES_QWEN_BY_MODEL: Record<string, readonly string[]> = {
  "qwen-audio-3.0-tts-plus": ["longanlingxin", "longanlufeng"],
  "qwen-audio-3.0-tts-flash": [
    "longanfengyue",
    "longanyuanfei",
    "longanlingxi",
    "longanxiaoxin",
    "longanhuan_v3.6",
    "longjielidou_v3.6",
    "longpaopao_v3.6",
    "longhuohuo_v3.6",
    "longchuanshu_v3.6",
    "loongmary",
    "loongeva_v3.6",
    "loongjohn",
  ],
};
const TTS_FORMATS_QWEN = ["wav", "mp3", "pcm", "opus"] as const;
const TTS_SAMPLE_RATES_QWEN = [8000, 16000, 22050, 24000, 44100, 48000] as const;
const TTS_VOICES_MIMO = [
  "mimo_default",
  "冰糖",
  "茉莉",
  "苏打",
  "白桦",
  "Mia",
  "Chloe",
  "Milo",
  "Dean",
] as const;
// step(阶跃)31 个音色,中文标签 + voice-id,对齐安卓 TTSProviderConfigure.kt:1108。
const TTS_VOICES_STEP: { value: string; label: string }[] = [
  { value: "elegantgentle-female", label: "气质温婉 (elegantgentle-female)" },
  { value: "livelybreezy-female", label: "活力轻快 (livelybreezy-female)" },
  { value: "energeticconfident-female", label: "活力自信 (energeticconfident-female)" },
  { value: "jingdiannvsheng", label: "经典女声 (jingdiannvsheng)" },
  { value: "wenroushunv", label: "温柔熟女 (wenroushunv)" },
  { value: "tianmeinvsheng", label: "甜美女声 (tianmeinvsheng)" },
  { value: "qingchunshaonv", label: "清纯少女 (qingchunshaonv)" },
  { value: "wenrounvsheng", label: "温柔女声 (wenrounvsheng)" },
  { value: "ruanmengnvsheng", label: "软萌女生 (ruanmengnvsheng)" },
  { value: "youyanvsheng", label: "优雅女生 (youyanvsheng)" },
  { value: "lengyanyujie", label: "冷艳御姐 (lengyanyujie)" },
  { value: "shuangkuaijiejie", label: "爽快姐姐 (shuangkuaijiejie)" },
  { value: "wenjingxuejie", label: "文静学姐 (wenjingxuejie)" },
  { value: "linjiajiejie", label: "邻家姐姐 (linjiajiejie)" },
  { value: "linjiameimei", label: "邻家妹妹 (linjiameimei)" },
  { value: "zhixingjiejie", label: "知性姐姐 (zhixingjiejie)" },
  { value: "cixingnansheng", label: "磁性男声 (cixingnansheng)" },
  { value: "wenrounansheng", label: "温柔男声 (wenrounansheng)" },
  { value: "yuanqinansheng", label: "元气男声 (yuanqinansheng)" },
  { value: "zhengpaiqingnian", label: "正派青年 (zhengpaiqingnian)" },
  { value: "ruyananshi", label: "儒雅男士 (ruyananshi)" },
  { value: "boyinnansheng", label: "播音男声 (boyinnansheng)" },
  { value: "shenchennanyin", label: "深沉男音 (shenchennanyin)" },
  { value: "shuangkuainansheng", label: "爽快男声 (shuangkuainansheng)" },
  { value: "ganliannvsheng", label: "干练女声 (ganliannvsheng)" },
  { value: "qinhenvsheng", label: "亲切女声 (qinhenvsheng)" },
  { value: "huolinvsheng", label: "活力女声 (huolinvsheng)" },
  { value: "jilingshaonv", label: "机灵少女 (jilingshaonv)" },
  { value: "yuanqishaonv", label: "元气少女 (yuanqishaonv)" },
  { value: "wenrougongzi", label: "温柔公子 (wenrougongzi)" },
  { value: "qingniandaxuesheng", label: "青年大学生 (qingniandaxuesheng)" },
];
const TTS_FORMATS_STEP = ["mp3", "wav", "pcm", "opus", "flac"] as const;
const TTS_SAMPLE_RATES_STEP = [8000, 16000, 22050, 24000] as const;
const TTS_FORMATS_FISH_AUDIO = ["mp3", "wav", "pcm", "opus"] as const;
const TTS_LATENCY_FISH_AUDIO = ["normal", "balanced"] as const;
const TTS_LANGUAGES_XAI: { value: string; label: string }[] = [
  { value: "auto", label: "Auto-detect" },
  { value: "en", label: "English" },
  { value: "zh", label: "Chinese (Simplified)" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "es-ES", label: "Spanish (Spain)" },
  { value: "es-MX", label: "Spanish (Mexico)" },
  { value: "pt-BR", label: "Portuguese (Brazil)" },
  { value: "pt-PT", label: "Portuguese (Portugal)" },
  { value: "it", label: "Italian" },
  { value: "ru", label: "Russian" },
  { value: "ar-EG", label: "Arabic (Egypt)" },
  { value: "hi", label: "Hindi" },
  { value: "tr", label: "Turkish" },
  { value: "vi", label: "Vietnamese" },
  { value: "id", label: "Indonesian" },
  { value: "bn", label: "Bengali" },
];

function TtsSettingsPanel({
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
  // 不走 provider autosave。范式同 general.tsx 的 patchDisplay。
  const display = settings.displaySetting;
  const patchDisplay = React.useCallback(
    async (patch: Record<string, unknown>) => {
      const nextDisplay = { ...settings.displaySetting, ...patch };
      await api.post("settings/display", nextDisplay);
      onSettings({ ...settings, displaySetting: nextDisplay });
    },
    [onSettings, settings],
  );

  const selectProvider = React.useCallback(
    async (providerId: string) => {
      setSelectedId(providerId);
      await api.post("settings/tts-provider/select", { id: providerId });
      onSettings({ ...settings, selectedTTSProviderId: providerId });
    },
    [onSettings, settings],
  );

  const removeProvider = React.useCallback(async () => {
    if (!draft || draft.type === "system") return;
    // R8-1:破坏性删除必须确认(与供应商/助手/MCP 删除同规)
    if (!(await confirmDialog({ title: t("settings:speech.tts_delete_confirm", { name: String(draft.name ?? "") }), danger: true }))) return;
    // 防复活:丢弃待保存脏编辑并等在飞保存收尾,DELETE 不与迟到 POST 乱序(复审 F1)
    await autosave.discard();
    await api.delete(`settings/tts-provider/${encodeURIComponent(draft.id)}`);
    const ttsProviders = providers.filter((provider) => provider.id !== draft.id);
    onSettings({
      ...settings,
      ttsProviders,
      selectedTTSProviderId:
        settings.selectedTTSProviderId === draft.id
          ? (ttsProviders[0]?.id ?? null)
          : settings.selectedTTSProviderId,
    });
    setSelectedId(ttsProviders[0]?.id ?? "");
  }, [draft, onSettings, providers, settings, t]);

  // Test playback uses the global audio singleton with a synthetic key so the test button
  // can toggle (play vs stop) and so that starting the test stops any in-progress chat
  // message playback. The key embeds the draft id so multiple settings panels (if ever
  // mounted) don't collide.
  const testPlaybackKey = draft ? `__tts-test__:${draft.id}` : "__tts-test__";
  const playingKey = useAudioPlaybackKey();
  const isTestPlaying = playingKey === testPlaybackKey;

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
        toast.success(t("settings:speech.test_system_done"));
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      await playAudio(testPlaybackKey, url, url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:speech.test_failed"));
    }
  }, [draft, isTestPlaying, testPlaybackKey, t]);

  const numericInput = (
    key: keyof TtsProviderProfile,
    label: string,
    description: string,
    min: number,
    max: number,
    step = 0.05,
  ) => {
    if (!draft) return null;
    const value = Number(draft[key] ?? 1);
    return (
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-medium">{label}</div>
            <div className="text-xs text-muted-foreground">{description}</div>
          </div>
          <Input
            className="w-24"
            value={Number.isFinite(value) ? String(value) : ""}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next))
                patchDraft({
                  [key]: Math.min(max, Math.max(min, next)),
                } as Partial<TtsProviderProfile>);
            }}
          />
        </div>
        <Slider
          min={min}
          max={max}
          step={step}
          value={[Number.isFinite(value) ? value : 1]}
          onValueChange={([next]) =>
            patchDraft({ [key]: next ?? 1 } as Partial<TtsProviderProfile>)
          }
        />
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* 朗读过滤(台账 §4.1):朗读前对文本做正则预处理,角色扮演只念台词/跳过注释。 */}
      <div className="rounded-lg border bg-card p-5">
        <div className="flex items-center gap-2">
          <Quote className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">{t("settings:speech.read_filter_title")}</h3>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("settings:speech.read_filter_desc")}
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="flex items-start justify-between gap-4 rounded-md border px-3 py-3">
            <div className="min-w-0">
              <div className="text-sm">{t("settings:speech.only_read_quoted")}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {t("settings:speech.only_read_quoted_desc")}
              </div>
            </div>
            <Switch
              checked={display.ttsOnlyReadQuoted === true}
              onCheckedChange={(checked) => void patchDisplay({ ttsOnlyReadQuoted: checked })}
            />
          </label>
          <label className="flex items-start justify-between gap-4 rounded-md border px-3 py-3">
            <div className="min-w-0">
              <div className="text-sm">{t("settings:speech.skip_brackets")}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {t("settings:speech.skip_brackets_desc")}
              </div>
            </div>
            <Switch
              checked={display.ttsOnlyReadOutsideBrackets === true}
              onCheckedChange={(checked) =>
                void patchDisplay({ ttsOnlyReadOutsideBrackets: checked })
              }
            />
          </label>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between gap-3 border-b p-3">
          <div className="text-sm font-medium">{t("settings:speech.tts_services")}</div>
          <Select onValueChange={(value) => void addProvider(value as TtsProviderType)}>
            <SelectTrigger className="h-8 w-28">
              <SelectValue placeholder={t("settings:speech.add")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="openai">OpenAI</SelectItem>
              <SelectItem value="gemini">Gemini</SelectItem>
              <SelectItem value="minimax">MiniMax</SelectItem>
              <SelectItem value="qwen">Qwen</SelectItem>
              <SelectItem value="groq">Groq</SelectItem>
              <SelectItem value="xai">xAI</SelectItem>
              <SelectItem value="mimo">MiMo</SelectItem>
              <SelectItem value="elevenlabs">ElevenLabs</SelectItem>
              <SelectItem value="step">Step</SelectItem>
              <SelectItem value="fish-audio">Fish Audio</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 p-2">
          {providers.map((provider, index) => (
            <SortableRow
              key={provider.id}
              id={provider.id}
              index={index}
              active={provider.id === selectedId}
              onSelect={() => setSelectedId(provider.id)}
              onMove={reorderProviders}
            >
              <span className="flex min-w-0 items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{provider.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {provider.type}
                  </span>
                </span>
                {provider.id === settings.selectedTTSProviderId ? (
                  <Check className="size-4 shrink-0 text-primary" />
                ) : null}
              </span>
            </SortableRow>
          ))}
          {providers.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              {t("settings:speech.tts_empty")}
            </div>
          ) : null}
        </div>
      </div>

      {draft ? (
        <div className="space-y-4 rounded-lg border bg-card p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-lg font-semibold">{draft.name}</div>
              <div className="text-sm text-muted-foreground">
                {t("settings:speech.tts_card_desc")}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => void handleTest()}
                title={t("settings:speech.test_title")}
              >
                {isTestPlaying ? <Square className="size-4" /> : <Volume2 className="size-4" />}
                {isTestPlaying ? t("settings:speech.stop") : t("settings:speech.test")}
              </Button>
              <Button
                variant={draft.id === settings.selectedTTSProviderId ? "secondary" : "outline"}
                onClick={() => void selectProvider(draft.id)}
              >
                {draft.id === settings.selectedTTSProviderId
                  ? t("settings:speech.selected")
                  : t("settings:speech.set_current")}
              </Button>
              {draft.type !== "system" ? (
                <Button variant="outline" onClick={() => void removeProvider()}>
                  <Trash2 className="size-4" />
                  {t("settings:common.delete")}
                </Button>
              ) : null}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <div className="text-sm font-medium">{t("settings:speech.name")}</div>
              <Input
                value={draft.name}
                onChange={(event) => patchDraft({ name: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium">{t("settings:speech.type")}</div>
              <Input value={draft.type} readOnly />
            </div>
            {draft.type !== "system" ? (
              <>
                <div className="space-y-2 md:col-span-2">
                  <div className="text-sm font-medium">{t("settings:speech.api_key")}</div>
                  <PasswordInput
                    value={draft.apiKey ?? ""}
                    onChange={(apiKey) => patchDraft({ apiKey })}
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <div className="text-sm font-medium">{t("settings:speech.base_url")}</div>
                  <Input
                    value={draft.baseUrl ?? ""}
                    onChange={(event) => patchDraft({ baseUrl: event.target.value })}
                  />
                </div>
                {draft.type !== "xai" ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">{t("settings:speech.model")}</div>
                    <Input
                      value={draft.model ?? ""}
                      onChange={(event) => patchDraft({ model: event.target.value })}
                    />
                  </div>
                ) : null}
                {draft.type === "gemini" ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Voice Name</div>
                    <Input
                      value={draft.voiceName ?? ""}
                      onChange={(event) => patchDraft({ voiceName: event.target.value })}
                    />
                  </div>
                ) : null}
                {draft.type === "minimax"
                  ? (() => {
                      const voiceId = draft.voiceId ?? "";
                      const isPreset = (TTS_VOICES_MINIMAX as readonly string[]).includes(voiceId);
                      // Dropdown value: shows the matched preset, or our `__custom__` sentinel
                      // when voiceId is empty / a custom-trained value not in the preset list.
                      // The sentinel is needed because Radix Select reserves "" — we can't use
                      // the empty string as an option value directly.
                      const dropdownValue = isPreset ? voiceId : "__custom__";
                      return (
                        <div className="space-y-2">
                          <div className="text-sm font-medium">Voice ID</div>
                          {/* Preset-first combobox: dropdown is the primary control on the left;
                          a free-text Input appears on the right ONLY when the user picks
                          "自定义". MiniMax's voice cloning produces opaque voice IDs that
                          aren't in our preset list, so users need to be able to paste them.
                          Matches Android's `ExposedDropdownMenuBox` UX
                          (`TTSProviderConfigure.kt:382-431`) where the editable text field
                          appears once a custom voice is in use. */}
                          <div className="flex gap-2">
                            <Select
                              value={dropdownValue}
                              onValueChange={(value) => {
                                if (value === "__custom__") {
                                  // Switching from a preset to "custom" — wipe the voiceId so
                                  // the input starts empty and the user is prompted to fill it.
                                  // If we're already in custom mode (just re-selected "自定义"),
                                  // leave the existing custom voiceId alone.
                                  if (isPreset) patchDraft({ voiceId: "" });
                                } else {
                                  patchDraft({ voiceId: value });
                                }
                              }}
                            >
                              <SelectTrigger className="flex-1">
                                <SelectValue placeholder={t("settings:speech.select_voice")} />
                              </SelectTrigger>
                              <SelectContent>
                                {TTS_VOICES_MINIMAX.map((voice) => (
                                  <SelectItem key={voice} value={voice}>
                                    {voice}
                                  </SelectItem>
                                ))}
                                <SelectItem value="__custom__">
                                  {t("settings:speech.custom_voice")}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                            {dropdownValue === "__custom__" ? (
                              <Input
                                className="flex-1"
                                value={voiceId}
                                onChange={(event) => patchDraft({ voiceId: event.target.value })}
                                placeholder={t("settings:speech.custom_voice_ph")}
                              />
                            ) : null}
                          </div>
                        </div>
                      );
                    })()
                  : null}
                {draft.type === "xai" ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Voice ID</div>
                    <Select
                      value={draft.voiceId ?? ""}
                      onValueChange={(value) => patchDraft({ voiceId: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t("settings:speech.select_voice")} />
                      </SelectTrigger>
                      <SelectContent>
                        {TTS_VOICES_XAI.map((voice) => (
                          <SelectItem key={voice} value={voice}>
                            {voice}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                {draft.type === "openai" || draft.type === "groq" ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Voice</div>
                    <Select
                      value={draft.voice ?? ""}
                      onValueChange={(value) => patchDraft({ voice: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t("settings:speech.select_voice")} />
                      </SelectTrigger>
                      <SelectContent>
                        {(draft.type === "openai" ? TTS_VOICES_OPENAI : TTS_VOICES_GROQ).map((voice) => (
                          <SelectItem key={voice} value={voice}>
                            {voice}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                {draft.type === "qwen" ? (
                  // qwen-audio-3.0(§4.5):音色按 model 分两组,旧 language_type 字段已废(改 format/sample_rate)。
                  <>
                    <div className="space-y-2">
                      <div className="text-sm font-medium">Voice</div>
                      <Select
                        value={draft.voice ?? ""}
                        onValueChange={(value) => patchDraft({ voice: value })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={t("settings:speech.select_voice")} />
                        </SelectTrigger>
                        <SelectContent>
                          {(TTS_VOICES_QWEN_BY_MODEL[draft.model ?? ""] ?? TTS_VOICES_QWEN_BY_MODEL["qwen-audio-3.0-tts-flash"]).map((voice) => (
                            <SelectItem key={voice} value={voice}>
                              {voice}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <div className="text-sm font-medium">Audio Format</div>
                      <Select
                        value={draft.format ?? "wav"}
                        onValueChange={(value) => patchDraft({ format: value })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Format" />
                        </SelectTrigger>
                        <SelectContent>
                          {TTS_FORMATS_QWEN.map((format) => (
                            <SelectItem key={format} value={format}>
                              {format}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <div className="text-sm font-medium">Sample Rate</div>
                      <Select
                        value={String(draft.sampleRate ?? 24000)}
                        onValueChange={(value) => patchDraft({ sampleRate: Number(value) })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Hz" />
                        </SelectTrigger>
                        <SelectContent>
                          {TTS_SAMPLE_RATES_QWEN.map((rate) => (
                            <SelectItem key={rate} value={String(rate)}>
                              {rate} Hz
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                ) : null}
                {draft.type === "mimo" ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Voice</div>
                    <Select
                      value={draft.voice ?? ""}
                      onValueChange={(value) => patchDraft({ voice: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t("settings:speech.select_voice")} />
                      </SelectTrigger>
                      <SelectContent>
                        {TTS_VOICES_MIMO.map((voice) => (
                          <SelectItem key={voice} value={voice}>
                            {voice}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                {draft.type === "xai" ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Language</div>
                    <Select
                      value={draft.language ?? "auto"}
                      onValueChange={(value) => patchDraft({ language: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t("settings:speech.select_language")} />
                      </SelectTrigger>
                      <SelectContent>
                        {TTS_LANGUAGES_XAI.map((lang) => (
                          <SelectItem key={lang.value} value={lang.value}>
                            {lang.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                {draft.type === "minimax" ? (
                  <>
                    <div className="space-y-2">
                      <div className="text-sm font-medium">Emotion</div>
                      {/* "自动" maps to empty string in the persisted state, which the server
                          uses as a signal to drop the `emotion` field entirely from the
                          MiniMax request (letting MiniMax pick based on text). We can't
                          actually USE `""` as a Radix `<SelectItem value>` — Radix reserves
                          empty string — so we route it through a `__auto__` sentinel and
                          convert at the boundary. The stored data stays clean (empty string),
                          only the UI uses the sentinel. */}
                      <Select
                        value={(draft.emotion ?? "") === "" ? "__auto__" : draft.emotion}
                        onValueChange={(value) =>
                          patchDraft({ emotion: value === "__auto__" ? "" : value })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={t("settings:speech.select_emotion")} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__auto__">
                            {t("settings:speech.emotion_auto")}
                          </SelectItem>
                          {TTS_EMOTIONS_MINIMAX.map((emotion) => (
                            <SelectItem key={emotion} value={emotion}>
                              {emotion}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="md:col-span-2">
                      {numericInput(
                        "speed",
                        "Speed",
                        t("settings:speech.minimax_speed_desc"),
                        0.5,
                        2,
                        0.05,
                      )}
                    </div>
                  </>
                ) : null}
                {draft.type === "elevenlabs" ? (
                  <>
                    <div className="space-y-2 md:col-span-2">
                      <div className="text-sm font-medium">Voice ID</div>
                      <Input
                        value={draft.voiceId ?? ""}
                        onChange={(event) => patchDraft({ voiceId: event.target.value })}
                        placeholder="JBFqnCBsd6RMkjVDRZzb"
                      />
                    </div>
                    <div className="md:col-span-2">
                      {numericInput("stability", "Stability", t("settings:speech.elevenlabs_stability_desc"), 0, 1)}
                    </div>
                    <div className="md:col-span-2">
                      {numericInput("similarityBoost", "Similarity Boost", t("settings:speech.elevenlabs_similarity_desc"), 0, 1)}
                    </div>
                  </>
                ) : null}
                {draft.type === "step" ? (
                  <>
                    <div className="space-y-2 md:col-span-2">
                      <div className="text-sm font-medium">Voice</div>
                      <Select
                        value={draft.voice ?? ""}
                        onValueChange={(value) => patchDraft({ voice: value })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={t("settings:speech.select_voice")} />
                        </SelectTrigger>
                        <SelectContent>
                          {TTS_VOICES_STEP.map((voice) => (
                            <SelectItem key={voice.value} value={voice.value}>
                              {voice.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <div className="text-sm font-medium">Format</div>
                      <Select
                        value={draft.responseFormat ?? "mp3"}
                        onValueChange={(value) => patchDraft({ responseFormat: value })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Format" />
                        </SelectTrigger>
                        <SelectContent>
                          {TTS_FORMATS_STEP.map((format) => (
                            <SelectItem key={format} value={format}>
                              {format}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <div className="text-sm font-medium">Sample Rate</div>
                      <Select
                        value={String(draft.sampleRate ?? 24000)}
                        onValueChange={(value) => patchDraft({ sampleRate: Number(value) })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Hz" />
                        </SelectTrigger>
                        <SelectContent>
                          {TTS_SAMPLE_RATES_STEP.map((rate) => (
                            <SelectItem key={rate} value={String(rate)}>
                              {rate} Hz
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="md:col-span-2">
                      {numericInput("speed", "Speed", t("settings:speech.step_speed_desc"), 0.5, 2)}
                    </div>
                    <div className="md:col-span-2">
                      {numericInput("volume", "Volume", t("settings:speech.step_volume_desc"), 0.1, 2)}
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <div className="text-sm font-medium">Instruction</div>
                      <Textarea
                        value={draft.instruction ?? ""}
                        onChange={(event) => patchDraft({ instruction: event.target.value })}
                        placeholder={t("settings:speech.step_instruction_ph")}
                      />
                      <div className="text-xs text-muted-foreground">
                        {t("settings:speech.step_instruction_desc")}
                      </div>
                    </div>
                  </>
                ) : null}
                {draft.type === "fish-audio" ? (
                  <>
                    <div className="space-y-2 md:col-span-2">
                      <div className="text-sm font-medium">Reference ID</div>
                      <Input
                        value={draft.referenceId ?? ""}
                        onChange={(event) => patchDraft({ referenceId: event.target.value })}
                        placeholder="802e3bc2b27e49c2995d23ef70e6ac89"
                      />
                      <div className="text-xs text-muted-foreground">
                        {t("settings:speech.fish_reference_desc")}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <div className="text-sm font-medium">Format</div>
                      <Select
                        value={draft.format ?? "mp3"}
                        onValueChange={(value) => patchDraft({ format: value })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Format" />
                        </SelectTrigger>
                        <SelectContent>
                          {TTS_FORMATS_FISH_AUDIO.map((format) => (
                            <SelectItem key={format} value={format}>
                              {format}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <div className="text-sm font-medium">Latency</div>
                      <Select
                        value={draft.latency ?? "normal"}
                        onValueChange={(value) => patchDraft({ latency: value })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Latency" />
                        </SelectTrigger>
                        <SelectContent>
                          {TTS_LATENCY_FISH_AUDIO.map((latency) => (
                            <SelectItem key={latency} value={latency}>
                              {latency}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="md:col-span-2">
                      {numericInput("temperature", "Temperature", t("settings:speech.fish_temperature_desc"), 0, 1)}
                    </div>
                    <div className="md:col-span-2">
                      {numericInput("topP", "Top P", t("settings:speech.fish_topp_desc"), 0, 1)}
                    </div>
                    <div className="md:col-span-2">
                      {numericInput("speed", "Speed", t("settings:speech.fish_speed_desc"), 0.5, 2)}
                    </div>
                    <div className="flex items-center justify-between gap-4 md:col-span-2">
                      <div>
                        <div className="text-sm font-medium">Normalize</div>
                        <div className="text-xs text-muted-foreground">
                          {t("settings:speech.fish_normalize_desc")}
                        </div>
                      </div>
                      <Switch
                        checked={draft.normalize ?? true}
                        onCheckedChange={(checked) => patchDraft({ normalize: checked })}
                      />
                    </div>
                  </>
                ) : null}
              </>
            ) : (
              <div className="space-y-5 md:col-span-2">
                {numericInput(
                  "speechRate",
                  "Speech Rate",
                  t("settings:speech.system_rate_desc"),
                  0.2,
                  3,
                  0.05,
                )}
                {numericInput(
                  "pitch",
                  "Pitch",
                  t("settings:speech.system_pitch_desc"),
                  0.2,
                  3,
                  0.05,
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {t("settings:speech.select_tts")}
        </div>
      )}
      </div>
    </div>
  );
}

export function SpeechSection({
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

  const removeProvider = React.useCallback(async () => {
    if (!draft) return;
    // R8-1:破坏性删除必须确认(与供应商/助手/MCP 删除同规)
    if (!(await confirmDialog({ title: t("settings:speech.asr_delete_confirm", { name: String(draft.name ?? "") }), danger: true }))) return;
    // 防复活:丢弃待保存脏编辑并等在飞保存收尾,DELETE 不与迟到 POST 乱序(复审 F1)
    await autosave.discard();
    await api.delete(`settings/asr-provider/${encodeURIComponent(draft.id)}`);
    const asrProviders = providers.filter((provider) => provider.id !== draft.id);
    onSettings({
      ...settings,
      asrProviders,
      selectedASRProviderId:
        settings.selectedASRProviderId === draft.id
          ? (asrProviders[0]?.id ?? null)
          : settings.selectedASRProviderId,
    });
    setSelectedId(asrProviders[0]?.id ?? "");
  }, [draft, onSettings, providers, settings, t]);

  const numericInput = (
    key: keyof AsrProviderProfile,
    label: string,
    description: string,
    min: number,
    max: number,
    step = 1,
  ) => {
    if (!draft) return null;
    const value = Number(draft[key] ?? min);
    return (
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-medium">{label}</div>
            <div className="text-xs text-muted-foreground">{description}</div>
          </div>
          <Input
            className="w-24"
            value={Number.isFinite(value) ? String(value) : ""}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next))
                patchDraft({
                  [key]: Math.min(max, Math.max(min, next)),
                } as Partial<AsrProviderProfile>);
            }}
          />
        </div>
        <Slider
          min={min}
          max={max}
          step={step}
          value={[Number.isFinite(value) ? value : min]}
          onValueChange={([next]) =>
            patchDraft({ [key]: next ?? min } as Partial<AsrProviderProfile>)
          }
        />
      </div>
    );
  };

  return (
    <>
      <SectionHeader
        icon={Mic}
        title={t("settings:speech.tts_title")}
        subtitle={t("settings:speech.tts_subtitle")}
      />
      <TtsSettingsPanel settings={settings} onSettings={onSettings} />
      <Separator className="my-8" />
      <SectionHeader
        icon={Mic}
        title={t("settings:speech.asr_title")}
        subtitle={t("settings:speech.asr_subtitle")}
      />
      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div className="rounded-lg border bg-card">
          <div className="flex items-center justify-between gap-3 border-b p-3">
            <div className="text-sm font-medium">{t("settings:speech.asr_services")}</div>
            <Select onValueChange={(value) => void addProvider(value as AsrProviderType)}>
              <SelectTrigger className="h-8 w-28">
                <SelectValue placeholder={t("settings:speech.add")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai_realtime">OpenAI</SelectItem>
                <SelectItem value="dashscope">DashScope</SelectItem>
                <SelectItem value="volcengine">Volcengine</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 p-2">
            {providers.map((provider, index) => (
              <SortableRow
                key={provider.id}
                id={provider.id}
                index={index}
                active={provider.id === selectedId}
                onSelect={() => setSelectedId(provider.id)}
                onMove={reorderProviders}
              >
                <span className="flex min-w-0 items-center justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{provider.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {provider.type}
                    </span>
                  </span>
                  {provider.id === settings.selectedASRProviderId ? (
                    <Check className="size-4 shrink-0 text-primary" />
                  ) : null}
                </span>
              </SortableRow>
            ))}
            {providers.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {t("settings:speech.asr_empty")}
              </div>
            ) : null}
          </div>
        </div>

        {draft ? (
          <div className="space-y-4 rounded-lg border bg-card p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-lg font-semibold">{draft.name}</div>
                <div className="text-sm text-muted-foreground">
                  {t("settings:speech.asr_card_desc")}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant={draft.id === settings.selectedASRProviderId ? "secondary" : "outline"}
                  onClick={() => void selectProvider(draft.id)}
                >
                  {draft.id === settings.selectedASRProviderId
                    ? t("settings:speech.selected")
                    : t("settings:speech.set_current")}
                </Button>
                <Button variant="outline" onClick={() => void removeProvider()}>
                  <Trash2 className="size-4" />
                  {t("settings:common.delete")}
                </Button>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <div className="text-sm font-medium">{t("settings:speech.name")}</div>
                <Input
                  value={draft.name}
                  onChange={(event) => patchDraft({ name: event.target.value })}
                />
              </div>
              <div className="space-y-2">
                <div className="text-sm font-medium">{t("settings:speech.type")}</div>
                <Input value={draft.type} readOnly />
              </div>
              <div className="space-y-2 md:col-span-2">
                <div className="text-sm font-medium">{t("settings:speech.api_key")}</div>
                <PasswordInput
                  value={draft.apiKey ?? ""}
                  onChange={(apiKey) => patchDraft({ apiKey })}
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <div className="text-sm font-medium">{t("settings:speech.ws_url")}</div>
                <Input
                  value={draft.websocketUrl ?? ""}
                  onChange={(event) => patchDraft({ websocketUrl: event.target.value })}
                />
              </div>
              {draft.type !== "volcengine" ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium">{t("settings:speech.model")}</div>
                  <Input
                    value={draft.model ?? ""}
                    onChange={(event) => patchDraft({ model: event.target.value })}
                    placeholder={
                      draft.type === "dashscope" ? "qwen3-asr-flash-realtime" : "gpt-4o-transcribe"
                    }
                  />
                </div>
              ) : null}
              {draft.type === "volcengine" ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium">Resource ID</div>
                  <Input
                    value={draft.resourceId ?? ""}
                    onChange={(event) => patchDraft({ resourceId: event.target.value })}
                    placeholder="volc.seedasr.sauc.duration"
                  />
                </div>
              ) : null}
              <div className="space-y-2">
                <div className="text-sm font-medium">{t("settings:speech.language")}</div>
                <Input
                  value={draft.language ?? ""}
                  onChange={(event) => patchDraft({ language: event.target.value })}
                  placeholder={draft.type === "dashscope" ? "zh" : "auto"}
                />
              </div>
              {draft.type === "openai_realtime" ? (
                <div className="space-y-2 md:col-span-2">
                  <div className="text-sm font-medium">{t("settings:speech.prompt")}</div>
                  <Textarea
                    value={draft.prompt ?? ""}
                    onChange={(event) => patchDraft({ prompt: event.target.value })}
                    placeholder="Optional"
                  />
                </div>
              ) : null}
            </div>
            <div className="space-y-5">
              {draft.type !== "volcengine"
                ? numericInput(
                    "sampleRate",
                    t("settings:speech.sample_rate"),
                    t("settings:speech.sample_rate_desc"),
                    8000,
                    48000,
                    1000,
                  )
                : null}
              {draft.type !== "volcengine"
                ? numericInput(
                    "vadThreshold",
                    t("settings:speech.vad_threshold"),
                    t("settings:speech.vad_threshold_desc"),
                    0,
                    1,
                    0.05,
                  )
                : null}
              {draft.type === "openai_realtime"
                ? numericInput(
                    "prefixPaddingMs",
                    t("settings:speech.prefix_padding"),
                    t("settings:speech.prefix_padding_desc"),
                    0,
                    2000,
                    50,
                  )
                : null}
              {draft.type !== "volcengine"
                ? numericInput(
                    "silenceDurationMs",
                    t("settings:speech.silence_duration"),
                    t("settings:speech.silence_duration_desc"),
                    100,
                    5000,
                    100,
                  )
                : null}
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
            {t("settings:speech.select_asr")}
          </div>
        )}
      </div>
    </>
  );
}
