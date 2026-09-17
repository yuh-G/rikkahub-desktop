// media/asr.ts — 语音识别（OpenAI Realtime / DashScope / 火山引擎实时会话与文件转写）
// 纪律：负责 ASR Provider 默认值/归一化、WebSocket 实时会话与转写实现，不处理路由。
// 请求日志暂经 ../server 的 addLog 记录（3.5 拆 api/ 时收敛）。

import { gunzipSync, gzipSync } from "node:zlib";
import type { AsrProvider, AsrRealtimeSession } from "../foundation/types";
import { id, isRecord } from "../foundation/utils";
import { fetchWithTimeout, resolveEffectiveProxy, shouldBypassProxy } from "../foundation/net";
import { state } from "../persistence/json-store";
import { textBody } from "../model-providers";
import { addLog } from "../api/logs";

export function defaultAsrProvider(type: AsrProvider["type"] = "openai_realtime"): AsrProvider {
  if (type === "dashscope") {
    return {
      type,
      id: id(),
      name: "DashScope ASR",
      apiKey: "",
      websocketUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
      model: "qwen3-asr-flash-realtime",
      language: "",
      sampleRate: 16000,
      vadThreshold: 0.2,
      silenceDurationMs: 800,
    };
  }
  if (type === "volcengine") {
    return {
      type,
      id: id(),
      name: "Volcengine ASR",
      apiKey: "",
      websocketUrl: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
      resourceId: "volc.seedasr.sauc.duration",
      language: "",
    };
  }
  return {
    type: "openai_realtime",
    id: id(),
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
  };
}

export function normalizeAsrProviders(value: unknown): AsrProvider[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((item) => {
      const type = ["dashscope", "volcengine", "openai_realtime"].includes(String(item.type))
        ? String(item.type) as AsrProvider["type"]
        : "openai_realtime";
      const base = defaultAsrProvider(type);
      return {
        ...base,
        ...item,
        type,
        id: String(item.id ?? base.id),
        name: String(item.name ?? base.name),
        apiKey: String(item.apiKey ?? ""),
        websocketUrl: String(item.websocketUrl ?? base.websocketUrl),
      };
    });
}

function selectedAsrProvider() {
  return state.settings.asrProviders.find((provider) => provider.id === state.settings.selectedASRProviderId)
    ?? state.settings.asrProviders[0]
    ?? null;
}

function openAiAsrTranscriptionEndpoint(provider: AsrProvider) {
  try {
    const url = new URL(provider.websocketUrl || "wss://api.openai.com/v1/realtime?intent=transcription");
    url.protocol = "https:";
    const basePath = url.pathname.replace(/\/realtime\/?$/, "").replace(/\/$/, "");
    url.pathname = `${basePath}/audio/transcriptions`;
    url.search = "";
    return url.toString();
  } catch {
    return "https://api.openai.com/v1/audio/transcriptions";
  }
}

export async function transcribeAudioWithAsrProvider(file: File) {
  const provider = selectedAsrProvider();
  if (!provider) throw new Error("No ASR provider configured");
  if (!provider.apiKey.trim()) throw new Error("ASR API Key is empty");
  const endpoint = provider.type === "openai_realtime"
    ? openAiAsrTranscriptionEndpoint(provider)
    : provider.type === "dashscope"
      ? "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription"
      : "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
  const form = new FormData();
  if (provider.type === "openai_realtime") {
    form.append("file", file, file.name || "speech.webm");
    form.append("model", provider.model || "gpt-4o-transcribe");
    if (provider.language?.trim()) form.append("language", provider.language.trim());
    if (provider.prompt?.trim()) form.append("prompt", provider.prompt.trim());
  } else {
    form.append("file", file, file.name || "speech.webm");
    form.append("model", provider.model || (provider.type === "dashscope" ? "paraformer-realtime-v2" : "bigmodel"));
    if (provider.language?.trim()) form.append("language", provider.language.trim());
  }
  const started = Date.now();
  const headers: Record<string, string> = provider.type === "openai_realtime"
    ? { Authorization: `Bearer ${provider.apiKey}` }
    : provider.type === "dashscope"
      ? { Authorization: `Bearer ${provider.apiKey}` }
      : {
          "X-Api-Key": provider.apiKey,
          "X-Api-Resource-Id": provider.resourceId || "volc.seedasr.sauc.duration",
          "X-Api-Request-Id": id(),
        };
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers,
    body: form,
    timeoutMs: 120_000, // 长音频转写偏慢,30s 默认会误杀
  });
  const rawText = await response.text();
  addLog({
    providerId: provider.id,
    providerName: provider.name,
    url: endpoint,
    ok: response.ok,
    status: response.status,
    kind: "provider:asr",
    durationMs: Date.now() - started,
    method: "POST",
    requestHeaders: headers,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    requestBody: `multipart audio transcription\nmodel=${provider.model || "gpt-4o-transcribe"}\nlanguage=${provider.language || "auto"}\nfile=${file.name || "speech.webm"}`,
    responseBody: textBody(rawText),
    error: response.ok ? undefined : textBody(rawText),
  });
  if (!response.ok) throw new Error(`ASR failed: ${response.status} ${rawText.slice(0, 500)}`);
  let raw: any = {};
  try {
    raw = rawText ? JSON.parse(rawText) : {};
  } catch {
    raw = { text: rawText };
  }
  return String(
    raw.text ??
    raw.transcript ??
    raw.output_text ??
    raw.output?.text ??
    raw.result?.text ??
    raw.data?.text ??
    raw.data?.result ??
    "",
  ).trim();
}

export const asrRealtimeSessions = new WeakMap<object, AsrRealtimeSession>();

function asrSendClient(session: AsrRealtimeSession, payload: Record<string, unknown>) {
  try {
    session.client.send(JSON.stringify(payload));
  } catch {
    // Client has gone away.
  }
}

function asrPublishTranscript(session: AsrRealtimeSession) {
  const transcript = [...session.completedTranscripts, ...session.partialTranscripts.values()]
    .filter((text) => text.trim().length > 0)
    .join(" ");
  asrSendClient(session, { type: "transcript", transcript });
}

/** 服务端 VAD 判停信号(语音模式专用):一句话说完、转写定稿时推一次。携带该句最终文本,
 *  前端据此收尾当前 utterance 并触发发送。去抖——同一句只推一次(Volcengine definite 会随
 *  累积全文重复到达;OpenAI/DashScope completed 本就一次)。 */
function asrSendTurnEnd(session: AsrRealtimeSession, text: string) {
  const trimmed = text.trim();
  if (!trimmed || trimmed === session.lastTurnEndText) return;
  session.lastTurnEndText = trimmed;
  asrSendClient(session, { type: "turn_end", transcript: trimmed });
}

function asrFail(session: AsrRealtimeSession, message: string) {
  if (session.finished) return;
  asrSendClient(session, { type: "error", error: message });
  addLog({
    providerId: session.provider.id,
    providerName: session.provider.name,
    url: session.provider.websocketUrl,
    ok: false,
    status: 0,
    kind: "provider:asr:realtime",
    durationMs: Date.now() - session.startedAt,
    error: message,
  });
}

function openAiAsrEndpoint(provider: AsrProvider) {
  const endpoint = (provider.websocketUrl || "wss://api.openai.com/v1/realtime?intent=transcription").trim();
  if (endpoint.includes("intent=transcription") || endpoint.includes("model=")) return endpoint;
  const separator = endpoint.includes("?") ? "&" : "?";
  return `${endpoint.replace(/\/+$/, "")}${separator}intent=transcription`;
}

function dashScopeAsrEndpoint(provider: AsrProvider) {
  const endpoint = (provider.websocketUrl || "wss://dashscope.aliyuncs.com/api-ws/v1/inference").trim().replace(/\/+$/, "");
  if (endpoint.includes("model=")) return endpoint;
  const separator = endpoint.includes("?") ? "&" : "?";
  return `${endpoint}${separator}model=${encodeURIComponent(provider.model || "qwen3-asr-flash-realtime")}`;
}

function openAiAsrSessionUpdate(provider: AsrProvider) {
  const transcription: Record<string, unknown> = { model: provider.model || "gpt-4o-transcribe" };
  if (provider.language?.trim()) transcription.language = provider.language.trim();
  if (provider.prompt?.trim()) transcription.prompt = provider.prompt.trim();
  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: Number(provider.sampleRate || 24000) },
          transcription,
          noise_reduction: { type: "near_field" },
          turn_detection: {
            type: "server_vad",
            threshold: Number(provider.vadThreshold ?? 0.5),
            prefix_padding_ms: Number(provider.prefixPaddingMs ?? 300),
            silence_duration_ms: Number(provider.silenceDurationMs ?? 500),
          },
        },
      },
    },
  };
}

function dashScopeAsrSessionUpdate(provider: AsrProvider) {
  const transcription: Record<string, unknown> = {};
  if (provider.language?.trim()) transcription.language = provider.language.trim();
  const session: Record<string, unknown> = {
    modalities: ["text"],
    input_audio_format: "pcm",
    sample_rate: Number(provider.sampleRate || 16000),
    input_audio_transcription: transcription,
  };
  const vad = Number(provider.vadThreshold ?? 0.2);
  session.turn_detection = vad > 0
    ? { type: "server_vad", threshold: vad, silence_duration_ms: Number(provider.silenceDurationMs ?? 800) }
    : null;
  return { event_id: "evt_session_update", type: "session.update", session };
}

function base64FromArrayBuffer(data: ArrayBuffer) {
  return Buffer.from(data).toString("base64");
}

function handleTextAsrEvent(session: AsrRealtimeSession, text: string) {
  const event = JSON.parse(text || "{}") as Record<string, any>;
  switch (String(event.type ?? "")) {
    case "conversation.item.input_audio_transcription.delta": {
      const itemId = String(event.item_id || "default");
      const delta = String(event.delta || "");
      if (delta) {
        session.partialTranscripts.set(itemId, `${session.partialTranscripts.get(itemId) ?? ""}${delta}`);
        asrPublishTranscript(session);
      }
      break;
    }
    case "conversation.item.input_audio_transcription.text": {
      const itemId = String(event.item_id || "default");
      const content = String(event.text || "");
      if (content) {
        session.partialTranscripts.set(itemId, content);
        asrPublishTranscript(session);
      }
      break;
    }
    case "conversation.item.input_audio_transcription.completed": {
      const itemId = String(event.item_id || "default");
      const transcript = String(event.transcript || "").trim();
      session.partialTranscripts.delete(itemId);
      if (transcript) session.completedTranscripts.push(transcript);
      asrPublishTranscript(session);
      // 一句话定稿 = 服务端 VAD 判停;通知语音模式收尾(听写模式忽略此消息)。
      if (transcript) asrSendTurnEnd(session, transcript);
      break;
    }
    case "error": {
      const message = String(event.error?.message || "ASR realtime error");
      asrFail(session, message);
      break;
    }
    default:
      break;
  }
}

const VOLC_MSG_FULL_CLIENT_REQUEST = 0x01;
const VOLC_MSG_AUDIO_ONLY = 0x02;
const VOLC_SER_NONE = 0x00;
const VOLC_SER_JSON = 0x01;
const VOLC_COMP_NONE = 0x00;
const VOLC_COMP_GZIP = 0x01;
const VOLC_FLAG_LAST_PACKET = 0x02;

function volcFrame(messageType: number, flags: number, serialization: number, compression: number, payload: Buffer) {
  const header = Buffer.from([0x11, ((messageType << 4) | (flags & 0x0f)) & 0xff, ((serialization << 4) | (compression & 0x0f)) & 0xff, 0x00]);
  const size = Buffer.alloc(4);
  size.writeInt32BE(payload.length, 0);
  return Buffer.concat([header, size, payload]);
}

function volcStartPayload(provider: AsrProvider) {
  const audio: Record<string, unknown> = { format: "pcm", rate: 16000, bits: 16, channel: 1 };
  if (provider.language?.trim()) audio.language = provider.language.trim();
  return Buffer.from(JSON.stringify({
    user: { uid: "rikkahub" },
    audio,
    request: {
      model_name: "bigmodel",
      enable_itn: true,
      enable_punc: true,
      show_utterances: true,
      result_type: "full",
    },
  }));
}

function handleVolcAsrEvent(session: AsrRealtimeSession, data: ArrayBuffer) {
  const buffer = Buffer.from(data);
  if (buffer.length < 4) return;
  const byte1 = buffer[1] & 0xff;
  const byte2 = buffer[2] & 0xff;
  const messageType = (byte1 >> 4) & 0x0f;
  const messageFlags = byte1 & 0x0f;
  const compression = byte2 & 0x0f;
  let offset = 4;
  if (messageType === 0x09) {
    if ((messageFlags & 0x01) !== 0) offset += 4;
    if (offset + 4 > buffer.length) return;
    const payloadSize = buffer.readInt32BE(offset);
    offset += 4;
    if (payloadSize <= 0 || offset + payloadSize > buffer.length) return;
    let payload = buffer.subarray(offset, offset + payloadSize);
    if (compression === VOLC_COMP_GZIP) payload = gunzipSync(payload);
    const raw = JSON.parse(payload.toString("utf8")) as Record<string, any>;
    const text = String(raw.result?.text || "");
    if (text && text !== session.lastText) {
      session.lastText = text;
      asrSendClient(session, { type: "transcript", transcript: text });
    }
    // 火山 VAD 判停:utterances[*].definite=true 表示该句经二遍纠错定稿。取定稿句文本推 turn_end;
    // definite 句会随累积全文重复到达,靠 asrSendTurnEnd 的去抖(lastTurnEndText)只推一次。
    const utterances = (raw.result?.utterances ?? []) as Array<Record<string, any>>;
    const definiteText = utterances
      .filter((u) => u?.definite === true)
      .map((u) => String(u?.text ?? ""))
      .join("")
      .trim();
    if (definiteText) asrSendTurnEnd(session, definiteText);
  } else if (messageType === 0x0f) {
    if (offset + 8 > buffer.length) return;
    offset += 4;
    const size = buffer.readInt32BE(offset);
    offset += 4;
    const message = size > 0 && offset + size <= buffer.length ? buffer.subarray(offset, offset + size).toString("utf8") : "Volcengine ASR error";
    asrFail(session, message);
  }
}

export function sendAsrAudio(session: AsrRealtimeSession, data: ArrayBuffer) {
  if (!session.upstream || session.upstream.readyState !== WebSocket.OPEN) {
    session.pendingFrames.push(data);
    return;
  }
  if (session.provider.type === "volcengine") {
    session.upstream.send(volcFrame(VOLC_MSG_AUDIO_ONLY, 0x00, VOLC_SER_NONE, VOLC_COMP_NONE, Buffer.from(data)));
    return;
  }
  const event: Record<string, unknown> = {
    type: "input_audio_buffer.append",
    audio: base64FromArrayBuffer(data),
  };
  if (session.provider.type === "dashscope") event.event_id = `evt_${Date.now()}`;
  session.upstream.send(JSON.stringify(event));
}

export function startAsrRealtimeSession(client: any, providerId?: string) {
  const provider = state.settings.asrProviders.find((item) => item.id === providerId) ?? selectedAsrProvider();
  if (!provider) {
    client.send(JSON.stringify({ type: "error", error: "No ASR provider configured" }));
    return;
  }
  if (!provider.apiKey.trim()) {
    client.send(JSON.stringify({ type: "error", error: "ASR API Key is empty" }));
    return;
  }
  const endpoint = provider.type === "openai_realtime"
    ? openAiAsrEndpoint(provider)
    : provider.type === "dashscope"
      ? dashScopeAsrEndpoint(provider)
      : provider.websocketUrl || "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
  const session: AsrRealtimeSession = {
    provider,
    client,
    upstream: null,
    completedTranscripts: [],
    partialTranscripts: new Map(),
    lastText: "",
    pendingFrames: [],
    opened: false,
    finished: false,
    startedAt: Date.now(),
    volcSequence: 1,
    lastTurnEndText: "",
  };
  asrRealtimeSessions.set(client, session);
  const headers: Record<string, string> = provider.type === "volcengine"
    ? {
        "X-Api-Key": provider.apiKey,
        "X-Api-Resource-Id": provider.resourceId || "volc.seedasr.sauc.duration",
        "X-Api-Request-Id": id(),
        "X-Api-Sequence": "-1",
      }
    : {
        Authorization: `Bearer ${provider.apiKey}`,
        ...(provider.type === "dashscope" ? { "OpenAI-Beta": "realtime=v1" } : {}),
      };
  // Bun 的 WebSocket 不自动读 HTTPS_PROXY env (跟 fetch 不同), 必须显式传 proxy 选项,
  // 否则 ASR/TTS 的 wss 请求在配了代理的环境下会绕过代理直连失败。
  const wsProxy: string | undefined = (() => {
    const cfg = state?.settings?.proxyConfig;
    const mode = cfg?.mode ?? "auto";
    if (mode === "env" || mode === "direct") return undefined;
    const { url } = resolveEffectiveProxy(state.settings.proxyConfig);
    if (!url) return undefined;
    if (shouldBypassProxy(endpoint, cfg?.bypassRules ?? "")) return undefined;
    return url;
  })();
  const upstream = new WebSocket(endpoint, (wsProxy ? { headers, proxy: wsProxy } : { headers }) as any);
  session.upstream = upstream;
  upstream.binaryType = "arraybuffer";
  upstream.onopen = () => {
    session.opened = true;
    if (provider.type === "openai_realtime") upstream.send(JSON.stringify(openAiAsrSessionUpdate(provider)));
    if (provider.type === "dashscope") upstream.send(JSON.stringify(dashScopeAsrSessionUpdate(provider)));
    if (provider.type === "volcengine") {
      upstream.send(volcFrame(VOLC_MSG_FULL_CLIENT_REQUEST, 0x00, VOLC_SER_JSON, VOLC_COMP_GZIP, gzipSync(volcStartPayload(provider))));
    }
    asrSendClient(session, { type: "status", status: "listening" });
    for (const frame of session.pendingFrames.splice(0)) sendAsrAudio(session, frame);
  };
  upstream.onmessage = (event) => {
    try {
      if (typeof event.data === "string") handleTextAsrEvent(session, event.data);
      else handleVolcAsrEvent(session, event.data as ArrayBuffer);
    } catch (err) {
      asrFail(session, err instanceof Error ? err.message : String(err));
    }
  };
  upstream.onerror = () => asrFail(session, "ASR websocket failed");
  upstream.onclose = () => {
    session.finished = true;
    addLog({
      providerId: provider.id,
      providerName: provider.name,
      url: endpoint,
      ok: true,
      status: 0,
      kind: "provider:asr:realtime",
      durationMs: Date.now() - session.startedAt,
      requestBody: `realtime pcm websocket\nprovider=${provider.type}\nsampleRate=${provider.sampleRate || (provider.type === "openai_realtime" ? 24000 : 16000)}`,
      responseBody: session.lastText || [...session.completedTranscripts, ...session.partialTranscripts.values()].join(" "),
    });
    asrSendClient(session, { type: "status", status: "idle" });
  };
}

export function stopAsrRealtimeSession(client: any) {
  const session = asrRealtimeSessions.get(client);
  if (!session) return;
  if (session.provider.type === "volcengine" && session.upstream?.readyState === WebSocket.OPEN) {
    session.upstream.send(volcFrame(VOLC_MSG_AUDIO_ONLY, VOLC_FLAG_LAST_PACKET, VOLC_SER_NONE, VOLC_COMP_NONE, Buffer.alloc(0)));
  }
  session.upstream?.close(1000, "stop");
  asrRealtimeSessions.delete(client);
}
