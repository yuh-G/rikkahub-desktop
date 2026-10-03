// components/settings/speech-catalog.ts — 语音服务目录:各 TTS/ASR 类型的默认模板、可读名与
// 配置字段声明。详情页按声明渲染(基础区 / 高级设置),新增服务商只登记一行表项,不写 JSX。
//
// 默认模板与后端 media/tts.ts defaultTtsProvider、media/asr.ts defaultAsrProvider 逐字对齐
// (后端是落盘兜底),改默认值须两端同步。type 是跨端共享枚举(PC 备份会被 APP 解码),
// 新增类型必须逐字等于 APP 的 @SerialName。

import { createId } from "~/lib/id";
import type { AsrProviderProfile, AsrProviderType, TtsProviderProfile, TtsProviderType } from "~/types";

export type SpeechFieldSection = "basic" | "advanced";

export interface SpeechOption {
  value: string;
  /** 字面标签(品牌名、音色 ID 等不翻译的值);缺省显示 value。 */
  label?: string;
  labelKey?: string;
}

interface FieldBase {
  key: string;
  labelKey: string;
  hintKey?: string;
  section: SpeechFieldSection;
}

export type SpeechField =
  | (FieldBase & { kind: "text"; placeholder?: string })
  | (FieldBase & { kind: "password" })
  | (FieldBase & { kind: "textarea"; placeholderKey?: string })
  | (FieldBase & {
      kind: "select";
      options: (draft: Record<string, unknown>) => readonly SpeechOption[];
      fallback: string;
      placeholderKey?: string;
      /** 存储为数字(采样率等),选项值以字符串承载。 */
      numeric?: boolean;
    })
  /** 预设下拉 + 「自定义」时出现输入框(克隆音色等预设表外的值)。 */
  | (FieldBase & { kind: "preset"; presets: readonly string[] })
  | (FieldBase & { kind: "slider"; min: number; max: number; step: number; fallback: number })
  | (FieldBase & { kind: "switch"; fallback: boolean });

const literal = (values: readonly string[]): SpeechOption[] => values.map((value) => ({ value }));

// ---------------------------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------------------------

// 音色等预设表取自 APP TTSProviderConfigure.kt(下拉而非自由输入:拼错会让服务商静默 400/422)。
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
const TTS_EMOTIONS_MINIMAX = ["calm", "happy", "sad", "angry", "fearful", "disgusted", "surprised"] as const;
// qwen-audio-3.0:音色按 model 分两组(对齐 APP TTSProviderConfigure.kt:591)。
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
const TTS_VOICES_MIMO = ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"] as const;
// step(阶跃)音色:中文标签 + voice-id(对齐 APP TTSProviderConfigure.kt:1108)。
const TTS_VOICES_STEP: SpeechOption[] = [
  ["elegantgentle-female", "气质温婉"],
  ["livelybreezy-female", "活力轻快"],
  ["energeticconfident-female", "活力自信"],
  ["jingdiannvsheng", "经典女声"],
  ["wenroushunv", "温柔熟女"],
  ["tianmeinvsheng", "甜美女声"],
  ["qingchunshaonv", "清纯少女"],
  ["wenrounvsheng", "温柔女声"],
  ["ruanmengnvsheng", "软萌女生"],
  ["youyanvsheng", "优雅女生"],
  ["lengyanyujie", "冷艳御姐"],
  ["shuangkuaijiejie", "爽快姐姐"],
  ["wenjingxuejie", "文静学姐"],
  ["linjiajiejie", "邻家姐姐"],
  ["linjiameimei", "邻家妹妹"],
  ["zhixingjiejie", "知性姐姐"],
  ["cixingnansheng", "磁性男声"],
  ["wenrounansheng", "温柔男声"],
  ["yuanqinansheng", "元气男声"],
  ["zhengpaiqingnian", "正派青年"],
  ["ruyananshi", "儒雅男士"],
  ["boyinnansheng", "播音男声"],
  ["shenchennanyin", "深沉男音"],
  ["shuangkuainansheng", "爽快男声"],
  ["ganliannvsheng", "干练女声"],
  ["qinhenvsheng", "亲切女声"],
  ["huolinvsheng", "活力女声"],
  ["jilingshaonv", "机灵少女"],
  ["yuanqishaonv", "元气少女"],
  ["wenrougongzi", "温柔公子"],
  ["qingniandaxuesheng", "青年大学生"],
].map(([value, name]) => ({ value, label: `${name} (${value})` }));
const TTS_FORMATS_STEP = ["mp3", "wav", "pcm", "opus", "flac"] as const;
const TTS_SAMPLE_RATES_STEP = [8000, 16000, 22050, 24000] as const;
const TTS_FORMATS_FISH_AUDIO = ["mp3", "wav", "pcm", "opus"] as const;
const TTS_LATENCY_FISH_AUDIO = ["normal", "balanced"] as const;
const TTS_LANGUAGES_XAI: SpeechOption[] = [
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
const sampleRates = (rates: readonly number[]): SpeechOption[] =>
  rates.map((rate) => ({ value: String(rate), label: `${rate} Hz` }));

const TTS_CONNECTION: SpeechField[] = [
  { key: "baseUrl", kind: "text", labelKey: "settings:speech.base_url", section: "basic" },
  { key: "apiKey", kind: "password", labelKey: "settings:speech.api_key", section: "basic" },
];
const ttsModel: SpeechField = { key: "model", kind: "text", labelKey: "settings:speech.model", section: "basic" };
const ttsVoiceSelect = (voices: readonly string[]): SpeechField => ({
  key: "voice",
  kind: "select",
  labelKey: "settings:speech.field.voice",
  section: "basic",
  options: () => literal(voices),
  fallback: "",
  placeholderKey: "settings:speech.select_voice",
});
const ttsSpeed = (hintKey: string): SpeechField => ({
  key: "speed",
  kind: "slider",
  labelKey: "settings:speech.field.speed",
  hintKey,
  section: "advanced",
  min: 0.5,
  max: 2,
  step: 0.05,
  fallback: 1,
});

interface TtsSpec {
  /** 品牌名不翻译;只有「系统语音」走 i18n。 */
  label?: string;
  labelKey?: string;
  template: () => Omit<TtsProviderProfile, "id">;
  fields: SpeechField[];
}

/** 「新增」菜单顺序即本表顺序(对齐 APP 类型列表)。 */
export const TTS_CATALOG: Record<string, TtsSpec> = {
  system: {
    labelKey: "settings:speech.type_system",
    template: () => ({ type: "system", name: "System TTS", apiKey: "", baseUrl: "", speechRate: 1, pitch: 1 }),
    fields: [
      {
        key: "speechRate",
        kind: "slider",
        labelKey: "settings:speech.field.speech_rate",
        hintKey: "settings:speech.system_rate_desc",
        section: "basic",
        min: 0.2,
        max: 3,
        step: 0.05,
        fallback: 1,
      },
      {
        key: "pitch",
        kind: "slider",
        labelKey: "settings:speech.field.pitch",
        hintKey: "settings:speech.system_pitch_desc",
        section: "advanced",
        min: 0.2,
        max: 3,
        step: 0.05,
        fallback: 1,
      },
    ],
  },
  openai: {
    label: "OpenAI",
    template: () => ({
      type: "openai",
      name: "OpenAI TTS",
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-tts",
      voice: "alloy",
    }),
    fields: [...TTS_CONNECTION, ttsModel, ttsVoiceSelect(TTS_VOICES_OPENAI)],
  },
  gemini: {
    label: "Gemini",
    template: () => ({
      type: "gemini",
      name: "Gemini TTS",
      apiKey: "",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-2.5-flash-preview-tts",
      voiceName: "Kore",
    }),
    fields: [
      ...TTS_CONNECTION,
      ttsModel,
      { key: "voiceName", kind: "text", labelKey: "settings:speech.field.voice_name", section: "basic" },
    ],
  },
  minimax: {
    label: "MiniMax",
    template: () => ({
      type: "minimax",
      name: "MiniMax TTS",
      apiKey: "",
      baseUrl: "https://api.minimaxi.com/v1",
      model: "speech-2.8-hd",
      voiceId: "female-shaonv",
      emotion: "",
      speed: 1,
    }),
    fields: [
      ...TTS_CONNECTION,
      ttsModel,
      // 克隆音色得到的是预设表外的 voice_id,故预设下拉 + 「自定义」输入。
      { key: "voiceId", kind: "preset", labelKey: "settings:speech.field.voice_id", section: "basic", presets: TTS_VOICES_MINIMAX },
      {
        key: "emotion",
        kind: "select",
        labelKey: "settings:speech.field.emotion",
        section: "advanced",
        // 空串 = 不下发 emotion,由 MiniMax 按文本自定。
        options: () => [{ value: "", labelKey: "settings:speech.emotion_auto" }, ...literal(TTS_EMOTIONS_MINIMAX)],
        fallback: "",
        placeholderKey: "settings:speech.select_emotion",
      },
      ttsSpeed("settings:speech.minimax_speed_desc"),
    ],
  },
  qwen: {
    label: "Qwen",
    template: () => ({
      type: "qwen",
      name: "Qwen TTS",
      apiKey: "",
      // baseUrl 含 {WorkspaceId} 占位符,用户须替换为阿里云百炼业务空间 ID。
      baseUrl: "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1",
      model: "qwen-audio-3.0-tts-flash",
      voice: "longanhuan_v3.6",
      format: "wav",
      sampleRate: 24000,
    }),
    fields: [
      ...TTS_CONNECTION,
      ttsModel,
      {
        key: "voice",
        kind: "select",
        labelKey: "settings:speech.field.voice",
        section: "basic",
        options: (draft) =>
          literal(
            TTS_VOICES_QWEN_BY_MODEL[String(draft.model ?? "")] ?? TTS_VOICES_QWEN_BY_MODEL["qwen-audio-3.0-tts-flash"]!,
          ),
        fallback: "",
        placeholderKey: "settings:speech.select_voice",
      },
      {
        key: "format",
        kind: "select",
        labelKey: "settings:speech.field.audio_format",
        section: "advanced",
        options: () => literal(TTS_FORMATS_QWEN),
        fallback: "wav",
      },
      {
        key: "sampleRate",
        kind: "select",
        labelKey: "settings:speech.field.sample_rate",
        section: "advanced",
        options: () => sampleRates(TTS_SAMPLE_RATES_QWEN),
        fallback: "24000",
        numeric: true,
      },
    ],
  },
  groq: {
    label: "Groq",
    template: () => ({
      type: "groq",
      name: "Groq TTS",
      apiKey: "",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "canopylabs/orpheus-v1-english",
      voice: "austin",
    }),
    fields: [...TTS_CONNECTION, ttsModel, ttsVoiceSelect(TTS_VOICES_GROQ)],
  },
  xai: {
    label: "xAI",
    template: () => ({ type: "xai", name: "xAI TTS", apiKey: "", baseUrl: "https://api.x.ai/v1", voiceId: "eve", language: "auto" }),
    fields: [
      ...TTS_CONNECTION,
      {
        key: "voiceId",
        kind: "select",
        labelKey: "settings:speech.field.voice_id",
        section: "basic",
        options: () => literal(TTS_VOICES_XAI),
        fallback: "",
        placeholderKey: "settings:speech.select_voice",
      },
      {
        key: "language",
        kind: "select",
        labelKey: "settings:speech.field.language",
        section: "basic",
        options: () => TTS_LANGUAGES_XAI,
        fallback: "auto",
        placeholderKey: "settings:speech.select_language",
      },
    ],
  },
  mimo: {
    label: "MiMo",
    template: () => ({
      type: "mimo",
      name: "MiMo TTS",
      apiKey: "",
      baseUrl: "https://api.xiaomimimo.com/v1",
      model: "mimo-v2.5-tts",
      voice: "mimo_default",
    }),
    fields: [...TTS_CONNECTION, ttsModel, ttsVoiceSelect(TTS_VOICES_MIMO)],
  },
  elevenlabs: {
    label: "ElevenLabs",
    template: () => ({
      type: "elevenlabs",
      name: "ElevenLabs TTS",
      apiKey: "",
      baseUrl: "https://api.elevenlabs.io",
      model: "eleven_multilingual_v2",
      voiceId: "JBFqnCBsd6RMkjVDRZzb",
      stability: 0.5,
      similarityBoost: 0.75,
    }),
    fields: [
      ...TTS_CONNECTION,
      ttsModel,
      { key: "voiceId", kind: "text", labelKey: "settings:speech.field.voice_id", section: "basic", placeholder: "JBFqnCBsd6RMkjVDRZzb" },
      {
        key: "stability",
        kind: "slider",
        labelKey: "settings:speech.field.stability",
        hintKey: "settings:speech.elevenlabs_stability_desc",
        section: "advanced",
        min: 0,
        max: 1,
        step: 0.05,
        fallback: 0.5,
      },
      {
        key: "similarityBoost",
        kind: "slider",
        labelKey: "settings:speech.field.similarity_boost",
        hintKey: "settings:speech.elevenlabs_similarity_desc",
        section: "advanced",
        min: 0,
        max: 1,
        step: 0.05,
        fallback: 0.75,
      },
    ],
  },
  step: {
    label: "Step",
    template: () => ({
      type: "step",
      name: "Step TTS",
      apiKey: "",
      baseUrl: "https://api.stepfun.com",
      model: "step-tts-mini",
      voice: "elegantgentle-female",
      responseFormat: "mp3",
      speed: 1,
      volume: 1,
      sampleRate: 24000,
      instruction: "",
    }),
    fields: [
      ...TTS_CONNECTION,
      ttsModel,
      {
        key: "voice",
        kind: "select",
        labelKey: "settings:speech.field.voice",
        section: "basic",
        options: () => TTS_VOICES_STEP,
        fallback: "",
        placeholderKey: "settings:speech.select_voice",
      },
      {
        key: "responseFormat",
        kind: "select",
        labelKey: "settings:speech.field.format",
        section: "advanced",
        options: () => literal(TTS_FORMATS_STEP),
        fallback: "mp3",
      },
      {
        key: "sampleRate",
        kind: "select",
        labelKey: "settings:speech.field.sample_rate",
        section: "advanced",
        options: () => sampleRates(TTS_SAMPLE_RATES_STEP),
        fallback: "24000",
        numeric: true,
      },
      ttsSpeed("settings:speech.step_speed_desc"),
      {
        key: "volume",
        kind: "slider",
        labelKey: "settings:speech.field.volume",
        hintKey: "settings:speech.step_volume_desc",
        section: "advanced",
        min: 0.1,
        max: 2,
        step: 0.05,
        fallback: 1,
      },
      {
        key: "instruction",
        kind: "textarea",
        labelKey: "settings:speech.field.instruction",
        hintKey: "settings:speech.step_instruction_desc",
        placeholderKey: "settings:speech.step_instruction_ph",
        section: "advanced",
      },
    ],
  },
  "fish-audio": {
    label: "Fish Audio",
    template: () => ({
      type: "fish-audio",
      name: "Fish Audio TTS",
      apiKey: "",
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
    }),
    fields: [
      ...TTS_CONNECTION,
      ttsModel,
      {
        key: "referenceId",
        kind: "text",
        labelKey: "settings:speech.field.reference_id",
        hintKey: "settings:speech.fish_reference_desc",
        section: "basic",
        placeholder: "802e3bc2b27e49c2995d23ef70e6ac89",
      },
      {
        key: "format",
        kind: "select",
        labelKey: "settings:speech.field.format",
        section: "advanced",
        options: () => literal(TTS_FORMATS_FISH_AUDIO),
        fallback: "mp3",
      },
      {
        key: "latency",
        kind: "select",
        labelKey: "settings:speech.field.latency",
        section: "advanced",
        options: () => literal(TTS_LATENCY_FISH_AUDIO),
        fallback: "normal",
      },
      ttsSpeed("settings:speech.fish_speed_desc"),
      {
        key: "temperature",
        kind: "slider",
        labelKey: "settings:speech.field.temperature",
        hintKey: "settings:speech.fish_temperature_desc",
        section: "advanced",
        min: 0,
        max: 1,
        step: 0.05,
        fallback: 0.7,
      },
      {
        key: "topP",
        kind: "slider",
        labelKey: "settings:speech.field.top_p",
        hintKey: "settings:speech.fish_topp_desc",
        section: "advanced",
        min: 0,
        max: 1,
        step: 0.05,
        fallback: 0.7,
      },
      {
        key: "normalize",
        kind: "switch",
        labelKey: "settings:speech.field.normalize",
        hintKey: "settings:speech.fish_normalize_desc",
        section: "advanced",
        fallback: true,
      },
    ],
  },
  volcengine: {
    label: "Volcengine",
    template: () => ({
      type: "volcengine",
      name: "Volcengine TTS",
      apiKey: "",
      baseUrl: "https://openspeech.bytedance.com",
      resourceId: "seed-tts-2.0",
      speaker: "zh_female_vv_uranus_bigtts",
      speechRate: 0,
    }),
    fields: [
      ...TTS_CONNECTION,
      // 资源 ID 与控制台开通的服务绑定,填错是 403 的最常见来源,故放基础区。
      {
        key: "resourceId",
        kind: "text",
        labelKey: "settings:speech.field.resource_id",
        hintKey: "settings:speech.volc_resource_desc",
        section: "basic",
        placeholder: "seed-tts-2.0",
      },
      {
        key: "speaker",
        kind: "text",
        labelKey: "settings:speech.volc_speaker_label",
        hintKey: "settings:speech.volc_speaker_desc",
        section: "basic",
        placeholder: "zh_female_vv_uranus_bigtts",
      },
      {
        key: "speechRate",
        kind: "slider",
        labelKey: "settings:speech.volc_rate_label",
        hintKey: "settings:speech.volc_rate_desc",
        section: "advanced",
        min: -50,
        max: 100,
        step: 1,
        fallback: 0,
      },
    ],
  },
};

/** APP 独有、本端尚未实现的类型(原样保留以便回传):只给通用连接字段。 */
const TTS_UNKNOWN_FIELDS: SpeechField[] = [...TTS_CONNECTION, ttsModel];

export const TTS_TYPES = Object.keys(TTS_CATALOG) as TtsProviderType[];

export function ttsSpec(type: string): TtsSpec | undefined {
  return TTS_CATALOG[type];
}

export function ttsFields(type: string): SpeechField[] {
  return ttsSpec(type)?.fields ?? TTS_UNKNOWN_FIELDS;
}

export function createTtsProvider(type: TtsProviderType): TtsProviderProfile {
  const template = ttsSpec(type)?.template() ?? { type, name: type, apiKey: "", baseUrl: "" };
  // 系统语音全局唯一,固定 id(与后端 defaultTtsProvider 一致)。
  const id = type === "system" ? "026a01a2-c3a0-4fd5-8075-80e03bdef200" : createId();
  return { ...template, id } as TtsProviderProfile;
}

// ---------------------------------------------------------------------------------------------
// ASR
// ---------------------------------------------------------------------------------------------

interface AsrSpec {
  label: string;
  template: () => Omit<AsrProviderProfile, "id">;
  fields: SpeechField[];
}

const asrConnection = (modelPlaceholder?: string): SpeechField[] => [
  { key: "websocketUrl", kind: "text", labelKey: "settings:speech.ws_url", section: "basic" },
  { key: "apiKey", kind: "password", labelKey: "settings:speech.api_key", section: "basic" },
  ...(modelPlaceholder !== undefined
    ? [{ key: "model", kind: "text", labelKey: "settings:speech.model", section: "basic", placeholder: modelPlaceholder } as SpeechField]
    : []),
];
const asrLanguage = (placeholder: string): SpeechField => ({
  key: "language",
  kind: "text",
  labelKey: "settings:speech.language",
  hintKey: "settings:speech.language_hint",
  section: "basic",
  placeholder,
});
const asrVad: SpeechField[] = [
  {
    key: "sampleRate",
    kind: "slider",
    labelKey: "settings:speech.sample_rate",
    hintKey: "settings:speech.sample_rate_desc",
    section: "advanced",
    min: 8000,
    max: 48000,
    step: 1000,
    fallback: 8000,
  },
  {
    key: "vadThreshold",
    kind: "slider",
    labelKey: "settings:speech.vad_threshold",
    hintKey: "settings:speech.vad_threshold_desc",
    section: "advanced",
    min: 0,
    max: 1,
    step: 0.05,
    fallback: 0,
  },
];
const asrSilence: SpeechField = {
  key: "silenceDurationMs",
  kind: "slider",
  labelKey: "settings:speech.silence_duration",
  hintKey: "settings:speech.silence_duration_desc",
  section: "advanced",
  min: 100,
  max: 5000,
  step: 100,
  fallback: 100,
};

export const ASR_CATALOG: Record<string, AsrSpec> = {
  openai_realtime: {
    label: "OpenAI Realtime",
    template: () => ({
      type: "openai_realtime",
      name: "OpenAI Realtime ASR",
      apiKey: "",
      websocketUrl: "wss://api.openai.com/v1/realtime?intent=transcription",
      model: "gpt-4o-transcribe",
      language: "",
      prompt: "",
      sampleRate: 24000,
      vadThreshold: 0.5,
      prefixPaddingMs: 300,
      silenceDurationMs: 500,
    }),
    fields: [
      ...asrConnection("gpt-4o-transcribe"),
      asrLanguage("auto"),
      {
        key: "prompt",
        kind: "textarea",
        labelKey: "settings:speech.prompt",
        hintKey: "settings:speech.prompt_hint",
        placeholderKey: "settings:speech.field.optional",
        section: "advanced",
      },
      ...asrVad,
      {
        key: "prefixPaddingMs",
        kind: "slider",
        labelKey: "settings:speech.prefix_padding",
        hintKey: "settings:speech.prefix_padding_desc",
        section: "advanced",
        min: 0,
        max: 2000,
        step: 50,
        fallback: 0,
      },
      asrSilence,
    ],
  },
  dashscope: {
    label: "DashScope",
    template: () => ({
      type: "dashscope",
      name: "DashScope ASR",
      apiKey: "",
      websocketUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
      model: "qwen3-asr-flash-realtime",
      language: "",
      sampleRate: 16000,
      vadThreshold: 0.2,
      silenceDurationMs: 800,
    }),
    fields: [...asrConnection("qwen3-asr-flash-realtime"), asrLanguage("zh"), ...asrVad, asrSilence],
  },
  volcengine: {
    label: "Volcengine",
    template: () => ({
      type: "volcengine",
      name: "Volcengine ASR",
      apiKey: "",
      websocketUrl: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
      resourceId: "volc.seedasr.sauc.duration",
      language: "",
    }),
    fields: [
      ...asrConnection(),
      {
        key: "resourceId",
        kind: "text",
        labelKey: "settings:speech.field.resource_id",
        section: "basic",
        placeholder: "volc.seedasr.sauc.duration",
      },
      asrLanguage("auto"),
    ],
  },
};

const ASR_UNKNOWN_FIELDS: SpeechField[] = [...asrConnection(""), asrLanguage("auto")];

export const ASR_TYPES = Object.keys(ASR_CATALOG) as AsrProviderType[];

export function asrSpec(type: string): AsrSpec | undefined {
  return ASR_CATALOG[type];
}

export function asrFields(type: string): SpeechField[] {
  return asrSpec(type)?.fields ?? ASR_UNKNOWN_FIELDS;
}

export function createAsrProvider(type: AsrProviderType): AsrProviderProfile {
  const template = asrSpec(type)?.template() ?? { type, name: type, apiKey: "", websocketUrl: "" };
  return { ...template, id: createId() } as AsrProviderProfile;
}

/**
 * 高级区里是否有偏离该类型默认模板的值——收起时据此亮提示点,
 * 免得默认折叠把用户自己调过的参数藏起来。
 */
export function hasCustomizedAdvanced(
  draft: Record<string, unknown>,
  fields: readonly SpeechField[],
  template: Record<string, unknown> | undefined,
): boolean {
  return fields.some((field) => {
    if (field.section !== "advanced") return false;
    const value = draft[field.key];
    if (value === undefined || value === null || value === "") return false;
    return template ? value !== template[field.key] : true;
  });
}
