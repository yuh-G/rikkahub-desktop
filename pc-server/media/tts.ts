// media/tts.ts — 文本转语音(Provider 默认值/归一化 + 合成入口;在线合成逻辑在 tts-providers/registry)
// 纪律:负责 TTS Provider 默认值/归一化与合成编排(查表/校验/日志),provider 协议差异下沉注册表。
// 请求日志暂经 ../server 的 addLog 记录(3.5 拆 api/ 时收敛)。

import type { TtsProvider } from "../foundation/types";
import { fetchWithTimeout } from "../foundation/net";
import { id, isRecord, mergeById } from "../foundation/utils";
import { state } from "../persistence/json-store";
import { jsonBody, textBody } from "../model-providers";
import { synthesizeSystemTtsToWav } from "../tools";
import { addLog } from "../api/logs";
import { TTS_PROVIDER_REGISTRY, TTS_PROVIDER_TYPES, type OnlineTtsType } from "./tts-providers/registry";

export const DEFAULT_SYSTEM_TTS_ID = "026a01a2-c3a0-4fd5-8075-80e03bdef200";

export function defaultTtsProvider(type: TtsProvider["type"] = "system"): TtsProvider {
  if (type === "openai") {
    return {
      type,
      id: id(),
      name: "OpenAI TTS",
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-tts",
      voice: "alloy",
    };
  }
  if (type === "gemini") {
    return {
      type,
      id: id(),
      name: "Gemini TTS",
      apiKey: "",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-2.5-flash-preview-tts",
      voiceName: "Kore",
    };
  }
  if (type === "minimax") {
    return {
      type,
      id: id(),
      name: "MiniMax TTS",
      apiKey: "",
      baseUrl: "https://api.minimaxi.com/v1",
      model: "speech-2.6-turbo",
      voiceId: "female-shaonv",
      // Empty string == "自动" in the UI dropdown == omit the `emotion` field entirely from
      // the request body so MiniMax picks an emotion based on the text. Switching the default
      // from "calm" to auto matches Android's default behavior on the Kotlin side.
      emotion: "",
      speed: 1,
    };
  }
  if (type === "qwen") {
    return {
      type,
      id: id(),
      name: "Qwen TTS",
      apiKey: "",
      // qwen-audio-3.0(§4.5):baseUrl 含 {WorkspaceId} 占位符,用户须替换为阿里云百炼业务空间 ID。
      baseUrl: "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1",
      model: "qwen-audio-3.0-tts-flash",
      voice: "longanhuan_v3.6",
      format: "wav",
      sampleRate: 24000,
    };
  }
  if (type === "groq") {
    return {
      type,
      id: id(),
      name: "Groq TTS",
      apiKey: "",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "canopylabs/orpheus-v1-english",
      voice: "austin",
    };
  }
  if (type === "xai") {
    return {
      type,
      id: id(),
      name: "xAI TTS",
      apiKey: "",
      baseUrl: "https://api.x.ai/v1",
      voiceId: "eve",
      language: "auto",
    };
  }
  if (type === "mimo") {
    return {
      type,
      id: id(),
      name: "MiMo TTS",
      apiKey: "",
      baseUrl: "https://api.xiaomimimo.com/v1",
      model: "mimo-v2.5-tts",
      voice: "mimo_default",
    };
  }
  if (type === "elevenlabs") {
    return {
      type,
      id: id(),
      name: "ElevenLabs TTS",
      apiKey: "",
      baseUrl: "https://api.elevenlabs.io",
      model: "eleven_multilingual_v2",
      voiceId: "JBFqnCBsd6RMkjVDRZzb",
      stability: 0.5,
      similarityBoost: 0.75,
    };
  }
  if (type === "step") {
    return {
      type,
      id: id(),
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
    };
  }
  if (type === "fish-audio") {
    return {
      type,
      id: id(),
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
    };
  }
  return {
    type: "system",
    id: DEFAULT_SYSTEM_TTS_ID,
    name: "System TTS",
    apiKey: "",
    baseUrl: "",
    speechRate: 1,
    pitch: 1,
  };
}

export function defaultTtsProviders(): TtsProvider[] {
  return [
    defaultTtsProvider("system"),
  ];
}

// qwen-audio-3.0 音色全集(§4.5;plus 2 个 / flash 11 个,对齐安卓 TTSProviderConfigure.kt:591)。
// 用于迁移判据:旧 qwen3-tts 的英文音色(Cherry 等)不在此集合即重置为默认。
const QWEN_AUDIO3_VOICES = new Set([
  "longanlingxin", "longanlufeng",
  "longanfengyue", "longanyuanfei", "longanlingxi", "longanxiaoxin",
  "longanhuan_v3.6", "longjielidou_v3.6", "longpaopao_v3.6",
  "longhuohuo_v3.6", "longchuanshu_v3.6", "loongmary",
  "loongeva_v3.6", "loongjohn",
]);

// qwen-audio-3.0 破坏性升级(§4.5):endpoint/body/model 全换,旧 qwen3-tts 前缀模型安卓已拒。
// 仅迁移「等于已知旧默认值」的字段(判据严格),用户自填的自定义 model/baseUrl 一律不动。
function migrateQwenProvider(item: Record<string, unknown>): Record<string, unknown> {
  const migrated = { ...item };
  const model = String(item.model ?? "");
  const baseUrl = String(item.baseUrl ?? "");
  const voice = String(item.voice ?? "");
  if (model.startsWith("qwen3-tts")) migrated.model = "qwen-audio-3.0-tts-flash";
  if (baseUrl === "https://dashscope.aliyuncs.com/api/v1") {
    migrated.baseUrl = "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1";
  }
  if (voice && !QWEN_AUDIO3_VOICES.has(voice)) migrated.voice = "longanhuan_v3.6";
  return migrated;
}

function migrateMimoProvider(item: Record<string, unknown>): Record<string, unknown> {
  // mimo-v2-tts → mimo-v2.5-tts(协议不变,仅默认串升级);自定义 model 不动。
  return String(item.model ?? "") === "mimo-v2-tts" ? { ...item, model: "mimo-v2.5-tts" } : item;
}

export function normalizeTtsProviders(value: unknown): TtsProvider[] {
  const defaults = defaultTtsProviders();
  const raw = Array.isArray(value) ? value.filter(isRecord) : [];
  const normalized = raw.map((item) => {
    const type = TTS_PROVIDER_TYPES.includes(String(item.type) as TtsProvider["type"])
      ? (String(item.type) as TtsProvider["type"])
      : "system";
    const base = defaultTtsProvider(type);
    // §4.5 破坏性升级的存量迁移在 spread 前做,保证用户显式字段仍覆盖默认值。
    const source = type === "qwen" ? migrateQwenProvider(item) : type === "mimo" ? migrateMimoProvider(item) : item;
    return {
      ...base,
      ...source,
      type,
      id: String(source.id ?? base.id),
      name: String(source.name ?? base.name),
      apiKey: String(source.apiKey ?? ""),
      baseUrl: String(source.baseUrl ?? base.baseUrl),
    };
  });
  return mergeById(normalized, defaults);
}

function selectedTtsProvider(providerId?: string) {
  return state.settings.ttsProviders.find((provider) => provider.id === providerId)
    ?? state.settings.ttsProviders.find((provider) => provider.id === state.settings.selectedTTSProviderId)
    ?? state.settings.ttsProviders[0]
    ?? null;
}

export async function generateSpeechWithTtsProvider(text: string, providerId?: string, speedOverride?: number) {
  const provider = selectedTtsProvider(providerId);
  if (!provider) throw new Error("No TTS provider configured");
  const started = Date.now();
  if (provider.type === "system") {
    const speed = Number.isFinite(speedOverride) && (speedOverride as number) > 0
      ? (speedOverride as number)
      : Number(provider.speechRate ?? 1);
    const wavBytes = await synthesizeSystemTtsToWav(text, speed);
    addLog({
      providerId: provider.id,
      providerName: provider.name,
      url: "windows:System.Speech",
      ok: true,
      status: 200,
      kind: "provider:tts",
      durationMs: Date.now() - started,
      requestBody: text,
      responseBody: `${wavBytes.length} bytes audio/wav`,
    });
    return { audio: wavBytes, mime: "audio/wav", provider };
  }
  if (!provider.apiKey.trim()) throw new Error("TTS API Key is empty");
  // 在线 provider 全部走注册表(§4.5):公共骨架(key 校验/120s 超时/addLog/返回包装)在此,
  // 各家 endpoint/headers/body/parse/mime 差异声明在 spec 里。加新 provider 不动本函数。
  const spec = TTS_PROVIDER_REGISTRY[provider.type as OnlineTtsType];
  if (!spec) throw new Error(`Unknown TTS provider type: ${provider.type}`);
  const endpoint = spec.endpoint(provider);
  const headers = spec.headers(provider);
  const body = spec.body(provider, text);
  const mime = spec.mime(provider);
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    timeoutMs: 120_000, // 长文本合成分钟级,30s 默认会误杀
  });
  const audio = response.ok
    ? await spec.parse(provider, response)
    : Buffer.from(await response.arrayBuffer());
  addLog({
    providerId: provider.id,
    providerName: provider.name,
    url: endpoint,
    ok: response.ok,
    status: response.status,
    kind: "provider:tts",
    durationMs: Date.now() - started,
    method: "POST",
    requestHeaders: headers,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    requestBody: jsonBody(body),
    responseBody: response.ok ? `${audio.length} bytes ${mime}` : textBody(audio.toString("utf8")),
    error: response.ok ? undefined : textBody(audio.toString("utf8")),
  });
  if (!response.ok) throw new Error(`TTS request failed: ${response.status} ${audio.toString("utf8").slice(0, 500)}`);
  return { audio, mime, provider };
}
