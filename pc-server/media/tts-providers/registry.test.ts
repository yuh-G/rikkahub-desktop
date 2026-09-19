// media/tts-providers/registry.test.ts — TTS 注册表行为锁定(§4.5)
// 三道防线:
//  ① 行为字节级锁:8 家既有 provider 的 endpoint/headers/body 与重构前逐字节一致(qwen 例外,
//    计划内破坏性升级),防注册表重构偷改请求。
//  ② 新增三家对齐 Android:elevenlabs/step/fish-audio 的认证头、body 字段、空值省略逐字核对。
//  ③ normalize 迁移:旧 qwen/mimo 默认值静默升级,用户自定义值不动;TTS_PROVIDER_TYPES 单源。

import { describe, expect, test } from "bun:test";
import type { TtsProvider } from "../../foundation/types";
import { defaultTtsProvider, normalizeTtsProviders } from "../tts";
import { TTS_PROVIDER_REGISTRY, TTS_PROVIDER_TYPES } from "./registry";

function provider(type: TtsProvider["type"], extra: Partial<TtsProvider> = {}): TtsProvider {
  return { ...defaultTtsProvider(type), apiKey: "sk-test", ...extra };
}

const TEXT = "你好,世界";

describe("既有 provider 行为字节级锁定(重构前后一致)", () => {
  test("openai: audio/speech + Bearer + mp3", () => {
    const spec = TTS_PROVIDER_REGISTRY.openai;
    const p = provider("openai");
    expect(spec.endpoint(p)).toBe("https://api.openai.com/v1/audio/speech");
    expect(spec.headers(p)).toEqual({ Authorization: "Bearer sk-test", "Content-Type": "application/json" });
    expect(spec.body(p, TEXT)).toEqual({
      model: "gpt-4o-mini-tts", input: TEXT, voice: "alloy", response_format: "mp3",
    });
    expect(spec.mime(p)).toBe("audio/mpeg");
  });

  test("groq: audio/speech + wav", () => {
    const spec = TTS_PROVIDER_REGISTRY.groq;
    const p = provider("groq");
    expect(spec.endpoint(p)).toBe("https://api.groq.com/openai/v1/audio/speech");
    expect(spec.body(p, TEXT)).toEqual({
      model: "canopylabs/orpheus-v1-english", input: TEXT, voice: "austin", response_format: "wav",
    });
    expect(spec.mime(p)).toBe("audio/wav");
  });

  test("gemini: generateContent + x-goog-api-key", () => {
    const spec = TTS_PROVIDER_REGISTRY.gemini;
    const p = provider("gemini");
    expect(spec.endpoint(p)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent",
    );
    expect(spec.headers(p)).toEqual({ "x-goog-api-key": "sk-test", "Content-Type": "application/json" });
    expect(spec.body(p, TEXT)).toEqual({
      contents: [{ parts: [{ text: TEXT }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
      },
      model: "gemini-2.5-flash-preview-tts",
    });
    expect(spec.mime(p)).toBe("audio/wav");
  });

  test("minimax: t2a_v2 + emotion 空串时省略字段", () => {
    const spec = TTS_PROVIDER_REGISTRY.minimax;
    const p = provider("minimax", { emotion: "" });
    expect(spec.endpoint(p)).toBe("https://api.minimaxi.com/v1/t2a_v2");
    const body = spec.body(p, TEXT);
    // 默认 model 计划内升级 2.6-turbo → 2.8-hd(对齐 Android 2.5.2),存量迁移见 normalize 用例。
    expect(body).toEqual({
      model: "speech-2.8-hd", text: TEXT, stream: true, output_format: "hex",
      stream_options: { exclude_aggregated_audio: true },
      voice_setting: { voice_id: "female-shaonv", speed: 1 },
    });
    expect("emotion" in (body.voice_setting as Record<string, unknown>)).toBe(false);
    expect(spec.mime(p)).toBe("audio/mpeg");
  });

  test("minimax: emotion 非空时下发", () => {
    const body = TTS_PROVIDER_REGISTRY.minimax.body(provider("minimax", { emotion: "happy" }), TEXT);
    expect((body.voice_setting as Record<string, unknown>).emotion).toBe("happy");
  });

  test("xai: tts + Bearer", () => {
    const spec = TTS_PROVIDER_REGISTRY.xai;
    const p = provider("xai");
    expect(spec.endpoint(p)).toBe("https://api.x.ai/v1/tts");
    expect(spec.headers(p)).toEqual({ Authorization: "Bearer sk-test", "Content-Type": "application/json" });
    expect(spec.body(p, TEXT)).toEqual({ text: TEXT, voice_id: "eve", language: "auto" });
    expect(spec.mime(p)).toBe("audio/mpeg");
  });

  test("mimo: chat/completions + api-key 头(非 Bearer)", () => {
    const spec = TTS_PROVIDER_REGISTRY.mimo;
    const p = provider("mimo");
    expect(spec.endpoint(p)).toBe("https://api.xiaomimimo.com/v1/chat/completions");
    expect(spec.headers(p)).toEqual({ "api-key": "sk-test", "Content-Type": "application/json" });
    expect(spec.body(p, TEXT)).toEqual({
      model: "mimo-v2.5-tts",
      messages: [{ role: "assistant", content: TEXT }],
      audio: { format: "pcm16", voice: "mimo_default" },
      stream: true,
    });
    expect(spec.mime(p)).toBe("audio/wav");
  });
});

describe("§4.5 新增三家(逐字对齐 Android)", () => {
  test("elevenlabs: xi-api-key + model_id + voice_settings,URL 含 voiceId 与 output_format", () => {
    const spec = TTS_PROVIDER_REGISTRY.elevenlabs;
    const p = provider("elevenlabs");
    expect(spec.endpoint(p)).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128",
    );
    expect(spec.headers(p)).toEqual({ "xi-api-key": "sk-test", "Content-Type": "application/json" });
    expect(spec.body(p, TEXT)).toEqual({
      text: TEXT,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    });
    expect(spec.mime(p)).toBe("audio/mpeg");
  });

  test("step: Bearer + Accept + camelCase body,instruction 空时省略", () => {
    const spec = TTS_PROVIDER_REGISTRY.step;
    const p = provider("step");
    expect(spec.endpoint(p)).toBe("https://api.stepfun.com/v1/audio/speech");
    expect(spec.headers(p)).toEqual({
      Authorization: "Bearer sk-test",
      "Content-Type": "application/json",
      Accept: "application/octet-stream",
    });
    const body = spec.body(p, TEXT);
    expect(body).toEqual({
      model: "step-tts-mini", input: TEXT, voice: "elegantgentle-female",
      responseFormat: "mp3", speed: 1, volume: 1, sampleRate: 24000,
    });
    expect("instruction" in body).toBe(false);
    expect(spec.mime(p)).toBe("audio/mp3");
  });

  test("step: instruction 非空时下发", () => {
    const body = TTS_PROVIDER_REGISTRY.step.body(provider("step", { instruction: "用温柔的语气" }), TEXT);
    expect(body.instruction).toBe("用温柔的语气");
  });

  test("fish-audio: model 在 header 非 body,reference_id 空时省略", () => {
    const spec = TTS_PROVIDER_REGISTRY["fish-audio"];
    const p = provider("fish-audio");
    expect(spec.endpoint(p)).toBe("https://api.fish.audio/v1/tts");
    const headers = spec.headers(p);
    expect(headers.model).toBe("s2.1-pro");
    expect(headers.Authorization).toBe("Bearer sk-test");
    const body = spec.body(p, TEXT);
    expect(body).toEqual({
      text: TEXT, format: "mp3", temperature: 0.7, top_p: 0.7,
      prosody: { speed: 1 }, chunk_length: 300, normalize: true, latency: "normal",
    });
    expect("reference_id" in body).toBe(false);
    expect("model" in body).toBe(false);
    expect(spec.mime(p)).toBe("audio/mp3");
  });

  test("fish-audio: reference_id 非空时下发", () => {
    const body = TTS_PROVIDER_REGISTRY["fish-audio"].body(provider("fish-audio", { referenceId: "abc123" }), TEXT);
    expect(body.reference_id).toBe("abc123");
  });

  test("volcengine: v3 单向 SSE 端点 + 三头 + uid/speaker/audio_params,resourceId 空回落默认", () => {
    const spec = TTS_PROVIDER_REGISTRY.volcengine;
    const p = provider("volcengine");
    expect(spec.endpoint(p)).toBe("https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse");
    const headers = spec.headers(p);
    expect(headers["X-Api-Key"]).toBe("sk-test");
    expect(headers["X-Api-Resource-Id"]).toBe("seed-tts-2.0");
    expect(headers.Accept).toBe("text/event-stream");
    // 请求 ID 每次合成必须是新 UUID(火山按其幂等去重)。
    expect(headers["X-Api-Request-Id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(spec.headers(p)["X-Api-Request-Id"]).not.toBe(headers["X-Api-Request-Id"]);
    expect(spec.body(p, TEXT)).toEqual({
      user: { uid: p.id },
      req_params: {
        text: TEXT,
        speaker: "zh_female_vv_uranus_bigtts",
        audio_params: { format: "mp3", speech_rate: 0 },
      },
    });
    expect(spec.mime(p)).toBe("audio/mpeg");
  });

  test("volcengine: 自定义 speaker/resourceId/speechRate 透传,语速钳制 -50..100", () => {
    const spec = TTS_PROVIDER_REGISTRY.volcengine;
    const p = provider("volcengine", { speaker: "zh_male_chaoxiao_Mars", resourceId: "seed-tts-2.5", speechRate: 999 });
    const headers = spec.headers(p);
    expect(headers["X-Api-Resource-Id"]).toBe("seed-tts-2.5");
    expect(spec.body(p, TEXT).req_params).toEqual({
      text: TEXT,
      speaker: "zh_male_chaoxiao_Mars",
      audio_params: { format: "mp3", speech_rate: 100 },
    });
    expect(
      (spec.body(provider("volcengine", { speechRate: -100 }), TEXT).req_params as Record<string, { speech_rate: number }>).audio_params.speech_rate,
    ).toBe(-50);
  });
});

describe("qwen-audio-3.0 升级(§4.5)", () => {
  test("新默认:SpeechSynthesizer endpoint + format/sample_rate,无 language_type", () => {
    const spec = TTS_PROVIDER_REGISTRY.qwen;
    const p = provider("qwen", { baseUrl: "https://ws123.cn-beijing.maas.aliyuncs.com/api/v1" });
    expect(spec.endpoint(p)).toBe("https://ws123.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer");
    expect(spec.headers(p)["X-DashScope-SSE"]).toBe("enable");
    const body = spec.body(p, TEXT);
    expect(body).toEqual({
      model: "qwen-audio-3.0-tts-flash",
      input: { text: TEXT, voice: "longanhuan_v3.6", format: "wav", sample_rate: 24000 },
    });
    expect("language_type" in (body.input as Record<string, unknown>)).toBe(false);
    expect(spec.mime(p)).toBe("audio/wav");
  });

  test("qwen 非 wav 格式直通 mime", () => {
    const spec = TTS_PROVIDER_REGISTRY.qwen;
    expect(spec.mime(provider("qwen", { format: "mp3" }))).toBe("audio/mp3");
  });
});

describe("normalize 存量迁移(千万别让老用户 400)", () => {
  test("旧 qwen3-tts 默认值 → qwen-audio-3.0", () => {
    const [q] = normalizeTtsProviders([{
      type: "qwen", id: "q1", name: "Qwen TTS", apiKey: "k",
      baseUrl: "https://dashscope.aliyuncs.com/api/v1",
      model: "qwen3-tts-flash", voice: "Cherry", languageType: "Auto",
    }]);
    expect(q.model).toBe("qwen-audio-3.0-tts-flash");
    expect(q.baseUrl).toBe("https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1");
    expect(q.voice).toBe("longanhuan_v3.6");
    expect(q.format).toBe("wav");
    expect(q.sampleRate).toBe(24000);
  });

  test("qwen 用户自定义 model/baseUrl 不动", () => {
    const [q] = normalizeTtsProviders([{
      type: "qwen", id: "q1", name: "Q", apiKey: "k",
      baseUrl: "https://my-gateway.example.com/api/v1",
      model: "qwen-audio-3.0-tts-plus", voice: "longanlingxin",
    }]);
    expect(q.model).toBe("qwen-audio-3.0-tts-plus");
    expect(q.baseUrl).toBe("https://my-gateway.example.com/api/v1");
    expect(q.voice).toBe("longanlingxin");
  });

  test("旧 mimo-v2-tts → mimo-v2.5-tts,自定义不动", () => {
    const [upgraded] = normalizeTtsProviders([{
      type: "mimo", id: "m1", name: "M", apiKey: "k",
      baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2-tts", voice: "mimo_default",
    }]);
    expect(upgraded.model).toBe("mimo-v2.5-tts");
    const [custom] = normalizeTtsProviders([{
      type: "mimo", id: "m2", name: "M", apiKey: "k",
      baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-custom", voice: "冰糖",
    }]);
    expect(custom.model).toBe("mimo-custom");
  });

  test("minimax 旧默认 speech-2.6-turbo → speech-2.8-hd(2.5.2),自定义不动", () => {
    const [upgraded] = normalizeTtsProviders([{
      type: "minimax", id: "mm1", name: "MM", apiKey: "k",
      baseUrl: "https://api.minimaxi.com/v1", model: "speech-2.6-turbo", voiceId: "female-shaonv",
    }]);
    expect(upgraded.model).toBe("speech-2.8-hd");
    const [custom] = normalizeTtsProviders([{
      type: "minimax", id: "mm2", name: "MM", apiKey: "k",
      baseUrl: "https://api.minimaxi.com/v1", model: "speech-2.5-hd-preview", voiceId: "female-shaonv",
    }]);
    expect(custom.model).toBe("speech-2.5-hd-preview");
  });

  test("volcengine type 归一化保留,字段齐全", () => {
    const [v] = normalizeTtsProviders([{
      type: "volcengine", id: "v1", name: "V", apiKey: "k",
      baseUrl: "https://openspeech.bytedance.com",
      resourceId: "seed-tts-2.0", speaker: "zh_female_vv_uranus_bigtts", speechRate: 10,
    }]);
    expect(v.type).toBe("volcengine");
    expect(v.resourceId).toBe("seed-tts-2.0");
    expect(v.speaker).toBe("zh_female_vv_uranus_bigtts");
    expect(v.speechRate).toBe(10);
  });

  test("新增三家 type 归一化保留;未知 type 原样保留不再收敛成 system(backup C4)", () => {
    const list = normalizeTtsProviders([
      { type: "elevenlabs", id: "e1", name: "E", apiKey: "k", baseUrl: "https://api.elevenlabs.io" },
      { type: "step", id: "s1", name: "S", apiKey: "k", baseUrl: "https://api.stepfun.com" },
      { type: "fish-audio", id: "f1", name: "F", apiKey: "k", baseUrl: "https://api.fish.audio" },
      // 移动端先行新增、桌面端未实现的类型:判别符必须原样保留(否则 PC→APP 往返会把它
      // 改写成 system,回 APP 即崩/配置丢失)。缺省 id/name 字段补齐,但不套已知类型模板。
      { type: "acme_future", id: "b1", name: "B", apiKey: "k", baseUrl: "https://api.acme.example" },
    ]);
    expect(list.find((p) => p.id === "e1")?.type).toBe("elevenlabs");
    expect(list.find((p) => p.id === "s1")?.type).toBe("step");
    expect(list.find((p) => p.id === "f1")?.type).toBe("fish-audio");
    const preserved = list.find((p) => p.id === "b1");
    expect(preserved?.type).toBe("acme_future");
    expect(preserved?.baseUrl).toBe("https://api.acme.example"); // 不套 system 模板
  });

  test("C4:未知类型缺 id 时补骨架 id,name 兜底为 type 串,字段不丢", () => {
    const list = normalizeTtsProviders([{ type: "acme_future", apiKey: "k", baseUrl: "https://a.b" } as any]);
    const item = list.find((p) => (p as any).type === "acme_future");
    expect(item).toBeTruthy();
    expect(typeof item!.id).toBe("string");
    expect(item!.id.length).toBeGreaterThan(0);
    expect(item!.apiKey).toBe("k");
  });
});

describe("type 单源(Global Verify Sync)", () => {
  test("TTS_PROVIDER_TYPES = system + 注册表全部键", () => {
    expect(TTS_PROVIDER_TYPES).toContain("system");
    for (const key of Object.keys(TTS_PROVIDER_REGISTRY)) {
      expect(TTS_PROVIDER_TYPES).toContain(key as TtsProvider["type"]);
    }
    // 12 家(1 system + 11 在线),与安卓 Types 列表一致(2.5.2 增 volcengine)。
    expect(TTS_PROVIDER_TYPES.length).toBe(12);
  });
});
