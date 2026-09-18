// media/tts-providers/registry.ts — 在线 TTS provider 注册表(§4.5)
// 纪律:每家 provider 一个声明式 spec,只声明「差异」(endpoint/headers/body/parse/mime);
// 公共骨架(apiKey 校验、120s 超时、addLog、{audio,mime,provider} 包装)留在 media/tts.ts
// 的 generateSpeechWithTtsProvider。加新 provider = 往 TTS_PROVIDER_REGISTRY 加一项,
// 不动主流程——对齐台账 §7.3/§7.4 的「单点注入/汇聚函数」哲学。
//
// 协议字段逐字对齐 Android speech/src/main/java/me/rerere/tts/provider/providers/*.kt。
// 重构铁律:8 家既有 provider 的 endpoint/headers/body 与重构前逐字节一致(唯一例外是
// qwen 的计划内破坏性升级,见 normalize 迁移注释),由 registry.test.ts 字节级锁定。

import type { JsonValue, TtsProvider } from "../../foundation/types";

// 仅在线(provider 需要 apiKey + endpoint);system 走 Windows System.Speech,不在此表。
export type OnlineTtsType = Exclude<TtsProvider["type"], "system">;

export interface TtsProviderSpec {
  endpoint(p: TtsProvider): string;
  headers(p: TtsProvider): Record<string, string>;
  body(p: TtsProvider, text: string): Record<string, JsonValue>;
  parse(p: TtsProvider, response: Response): Promise<Buffer>;
  mime(p: TtsProvider): string;
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

// ---- 音频解析工具(自 media/tts.ts 迁入,供各 spec.parse 复用) ----

export function pcm16ToWav(pcm: Buffer, sampleRate = 24000, channels = 1): Buffer {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function decodeHexBytes(hexString: string): Buffer {
  const clean = hexString.replace(/\s+/g, "");
  if (!clean || clean.length % 2 !== 0) return Buffer.alloc(0);
  return Buffer.from(clean, "hex");
}

// 收集 SSE 流式音频:逐事件 data 负载交给 parseData 解出一段字节,空行触发一帧。
async function collectSseAudio(
  response: Response,
  parseData: (data: string) => Buffer | null,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: Buffer[] = [];
  let buffer = "";
  let currentData = "";
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data:")) {
          currentData += line.slice(5).trim();
        } else if (line.trim() === "" && currentData) {
          const audio = parseData(currentData);
          if (audio?.length) chunks.push(audio);
          currentData = "";
        }
      }
    }
    if (done) break;
  }
  if (currentData) {
    const audio = parseData(currentData);
    if (audio?.length) chunks.push(audio);
  }
  return Buffer.concat(chunks);
}

// 非流式整段二进制(openai/groq/xai/elevenlabs/step/fish-audio 共用)。
async function parseWholeBuffer(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

const bearer = (p: TtsProvider): Record<string, string> => ({
  Authorization: `Bearer ${p.apiKey}`,
  "Content-Type": "application/json",
});

// ---- 注册表 ----

export const TTS_PROVIDER_REGISTRY: Record<OnlineTtsType, TtsProviderSpec> = {
  openai: {
    endpoint: (p) => `${trimBase(p.baseUrl)}/audio/speech`,
    headers: bearer,
    body: (p, text) => ({
      model: p.model || "gpt-4o-mini-tts",
      input: text,
      voice: p.voice || "alloy",
      response_format: "mp3",
    }),
    parse: (_p, response) => parseWholeBuffer(response),
    mime: () => "audio/mpeg",
  },

  groq: {
    endpoint: (p) => `${trimBase(p.baseUrl)}/audio/speech`,
    headers: bearer,
    body: (p, text) => ({
      model: p.model || "canopylabs/orpheus-v1-english",
      input: text,
      voice: p.voice || "austin",
      response_format: "wav",
    }),
    parse: (_p, response) => parseWholeBuffer(response),
    mime: () => "audio/wav",
  },

  gemini: {
    endpoint: (p) =>
      `${trimBase(p.baseUrl)}/models/${p.model || "gemini-2.5-flash-preview-tts"}:generateContent`,
    headers: (p) => ({ "x-goog-api-key": p.apiKey, "Content-Type": "application/json" }),
    body: (p, text) => ({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: p.voiceName || "Kore" } } },
      },
      model: p.model || "gemini-2.5-flash-preview-tts",
    }),
    parse: async (_p, response) => {
      const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const candidates = Array.isArray(raw.candidates) ? raw.candidates : [];
      const first = candidates[0] as Record<string, unknown> | undefined;
      const content = first?.content as Record<string, unknown> | undefined;
      const parts = Array.isArray(content?.parts) ? content.parts : [];
      const part = parts[0] as Record<string, unknown> | undefined;
      const inlineData = part?.inlineData as Record<string, unknown> | undefined;
      const data = typeof inlineData?.data === "string" ? inlineData.data : "";
      if (!data) throw new Error("No audio data returned from Gemini TTS");
      return pcm16ToWav(Buffer.from(data, "base64"), 24000, 1);
    },
    mime: () => "audio/wav",
  },

  minimax: {
    endpoint: (p) => `${trimBase(p.baseUrl)}/t2a_v2`,
    headers: bearer,
    body: (p, text) => {
      // emotion 软可选:空串("自动")=整个字段省略,让 MiniMax 依文本自选(对齐安卓;
      // 发 "" 会被拒)。voice_setting 内仅 voice_id/speed 恒发。
      const voiceSetting: Record<string, JsonValue> = {
        voice_id: p.voiceId || "female-shaonv",
        speed: Number(p.speed ?? 1),
      };
      if (p.emotion) voiceSetting.emotion = p.emotion;
      return {
        model: p.model || "speech-2.6-turbo",
        text,
        stream: true,
        output_format: "hex",
        stream_options: { exclude_aggregated_audio: true },
        voice_setting: voiceSetting,
      };
    },
    parse: (_p, response) =>
      collectSseAudio(response, (data) => {
        if (data === "[DONE]") return null;
        const raw = JSON.parse(data || "{}") as { data?: { audio?: string } };
        return decodeHexBytes(raw.data?.audio ?? "");
      }),
    mime: () => "audio/mpeg",
  },

  // qwen-audio-3.0(§4.5 升级):endpoint 换 SpeechSynthesizer,body 砍 language_type、
  // 加 format/sample_rate。旧 qwen3-tts 前缀模型已被安卓拒绝,PC 在 normalize 层迁移。
  qwen: {
    endpoint: (p) => `${trimBase(p.baseUrl)}/services/audio/tts/SpeechSynthesizer`,
    headers: (p) => ({
      Authorization: `Bearer ${p.apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-SSE": "enable",
    }),
    body: (p, text) => ({
      model: p.model || "qwen-audio-3.0-tts-flash",
      input: {
        text,
        voice: p.voice || "longanhuan_v3.6",
        format: p.format || "wav",
        sample_rate: Number(p.sampleRate ?? 24000),
      },
    }),
    parse: async (p, response) => {
      const pcm = await collectSseAudio(response, (data) => {
        const raw = JSON.parse(data || "{}") as { output?: { audio?: { data?: string } } };
        const encoded = raw.output?.audio?.data ?? "";
        return encoded ? Buffer.from(encoded, "base64") : null;
      });
      // 服务端按 input.format 返回音频;wav 是裸 PCM 需包 WAV 头,mp3/opus 已是封装格式直通。
      return (p.format || "wav") === "wav" ? pcm16ToWav(pcm, Number(p.sampleRate ?? 24000), 1) : pcm;
    },
    mime: (p) => ((p.format || "wav") === "wav" ? "audio/wav" : `audio/${p.format}`),
  },

  xai: {
    endpoint: (p) => `${trimBase(p.baseUrl)}/tts`,
    headers: bearer,
    body: (p, text) => ({
      text,
      voice_id: p.voiceId || "eve",
      language: p.language || "auto",
    }),
    parse: (_p, response) => parseWholeBuffer(response),
    mime: () => "audio/mpeg",
  },

  mimo: {
    endpoint: (p) => `${trimBase(p.baseUrl)}/chat/completions`,
    // MiMo 用 api-key 头传 token(非 Authorization: Bearer)。
    headers: (p) => ({ "api-key": p.apiKey, "Content-Type": "application/json" }),
    body: (p, text) => ({
      model: p.model || "mimo-v2.5-tts",
      messages: [{ role: "assistant", content: text }],
      audio: { format: "pcm16", voice: p.voice || "mimo_default" },
      stream: true,
    }),
    parse: async (_p, response) => {
      const pcm = await collectSseAudio(response, (data) => {
        if (data === "[DONE]") return null;
        const raw = JSON.parse(data || "{}") as {
          choices?: Array<{ delta?: { audio?: { data?: string } } }>;
        };
        const encoded = raw.choices?.[0]?.delta?.audio?.data ?? "";
        return encoded ? Buffer.from(encoded, "base64") : null;
      });
      return pcm16ToWav(pcm, 24000, 1);
    },
    mime: () => "audio/wav",
  },

  // ---- §4.5 新增三家(协议逐字对齐 Android) ----

  elevenlabs: {
    endpoint: (p) =>
      `${trimBase(p.baseUrl)}/v1/text-to-speech/${p.voiceId || "JBFqnCBsd6RMkjVDRZzb"}?output_format=mp3_44100_128`,
    headers: (p) => ({ "xi-api-key": p.apiKey, "Content-Type": "application/json" }),
    body: (p, text) => ({
      text,
      model_id: p.model || "eleven_multilingual_v2",
      voice_settings: {
        stability: Number(p.stability ?? 0.5),
        similarity_boost: Number(p.similarityBoost ?? 0.75),
      },
    }),
    parse: (_p, response) => parseWholeBuffer(response),
    mime: () => "audio/mpeg",
  },

  step: {
    endpoint: (p) => `${trimBase(p.baseUrl)}/v1/audio/speech`,
    headers: (p) => ({
      Authorization: `Bearer ${p.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/octet-stream",
    }),
    body: (p, text) => {
      // camelCase 字段名(阶跃官方 SDK 约定);instruction 仅 stepaudio-2.5-tts 生效,空串不下发。
      const body: Record<string, JsonValue> = {
        model: p.model || "step-tts-mini",
        input: text,
        voice: p.voice || "elegantgentle-female",
        responseFormat: p.responseFormat || "mp3",
        speed: Number(p.speed ?? 1),
        volume: Number(p.volume ?? 1),
        sampleRate: Number(p.sampleRate ?? 24000),
      };
      if (p.instruction && p.instruction.trim()) body.instruction = p.instruction;
      return body;
    },
    parse: (_p, response) => parseWholeBuffer(response),
    mime: (p) => `audio/${p.responseFormat || "mp3"}`,
  },

  "fish-audio": {
    endpoint: (p) => `${trimBase(p.baseUrl)}/v1/tts`,
    // FishAudio 把 model 放 header(非 body);reference_id=克隆音色,空串不下发。
    headers: (p) => ({
      Authorization: `Bearer ${p.apiKey}`,
      "Content-Type": "application/json",
      model: p.model || "s2.1-pro",
    }),
    body: (p, text) => {
      const body: Record<string, JsonValue> = {
        text,
        format: p.format || "mp3",
        temperature: Number(p.temperature ?? 0.7),
        top_p: Number(p.topP ?? 0.7),
        prosody: { speed: Number(p.speed ?? 1) },
        chunk_length: Number(p.chunkLength ?? 300),
        normalize: p.normalize ?? true,
        latency: p.latency || "normal",
      };
      if (p.referenceId && p.referenceId.trim()) body.reference_id = p.referenceId;
      return body;
    },
    parse: (_p, response) => parseWholeBuffer(response),
    mime: (p) => `audio/${p.format || "mp3"}`,
  },
};

// type 单源:media/tts.ts 的 normalize 与 api/handlers/media.ts 的 detail 路由都消费它,
// 消灭两处写死的同步债(台账 Global Verify Sync 纪律)。
export const TTS_PROVIDER_TYPES: readonly TtsProvider["type"][] = [
  "system",
  ...(Object.keys(TTS_PROVIDER_REGISTRY) as OnlineTtsType[]),
];
