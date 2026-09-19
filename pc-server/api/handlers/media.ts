// api/handlers/media.ts — 媒体路由（settings/asr-provider/*、settings/tts-provider/*、tts/*、asr/*、images/*）
// 纪律：纯搬迁自 server.ts routeApi()；TTS/ASR provider 契约冻结。

import type { AsrProvider, TtsProvider } from "../../foundation/types";
import { saveState, state } from "../../persistence/json-store";
import { friendlyRequestError } from "../../foundation/net";
import { cancelAllSystemTts } from "../../tools/platform";
import { unlinkSync } from "node:fs";
import { callImageGeneration } from "../../media/image-gen";
import { defaultAsrProvider, isPcKnownAsrType, normalizeAsrProviders, transcribeAudioWithAsrProvider } from "../../media/asr";
import { DEFAULT_SYSTEM_TTS_ID, defaultTtsProvider, generateSpeechWithTtsProvider, normalizeTtsProviders } from "../../media/tts";
import { TTS_PROVIDER_TYPES } from "../../media/tts-providers/registry";
import { RetryableHttpError } from "../../foundation/retry";
import { extractedTextPath } from "../../files/index";
import { error, json, readJson } from "../request";
import { updateSettings } from "../../app-config";

/**
 * 删除一组生成图(账本 generatedImages + 关联 StoredFile + 磁盘字节 + 抽取旁车)。
 * 修复既有缺口:原单删只摘 generatedImages 条目,文件字节与 files 账本永久残留(磁盘泄漏)。
 * 与 files.ts 删除纪律一致:历史去重条目共享同一路径时,仅当无其余引用才删字节。
 * 返回实际删除的图片数(已不存在的幂等跳过)。
 */
function deleteGeneratedImagesById(ids: string[]): number {
  const idSet = new Set(ids.map(String));
  const targets = state.generatedImages.filter((image) => idSet.has(image.id));
  if (targets.length === 0) return 0;
  state.generatedImages = state.generatedImages.filter((image) => !idSet.has(image.id));
  for (const target of targets) {
    if (target.fileId == null) continue;
    // 先取路径再摘账本条目——顺序反了会查不到路径,字节就删不掉。
    const filePath = state.files.find((file) => file.id === target.fileId)?.path;
    state.files = state.files.filter((file) => file.id !== target.fileId);
    if (filePath && !state.files.some((file) => file.path === filePath)) {
      try { unlinkSync(filePath); } catch { /* 不存在/被锁,忽略 */ }
    }
    try { unlinkSync(extractedTextPath(target.fileId)); } catch { /* 无旁车 */ }
  }
  saveState();
  return targets.length;
}

export async function handleMediaRoutes(request: Request, _url: URL, path: string): Promise<Response | null> {
  if (path === "settings/asr-provider/detail" && request.method === "POST") {
    const body = await readJson<Partial<AsrProvider>>(request);
    // 新增/create 时归一化会套用默认模板,故必须收敛到本端已知类型(前端下拉只给 3 家);
    // 编辑/save 时 body 携带完整对象,未知跨端类型(mimo/step)必须原样透传——
    // 在此重置成 openai_realtime 会把用户在设置页的一次保存变成「配置被没收」(backup C4)。
    const requested = String(body.type ?? "");
    const type = isPcKnownAsrType(requested) ? requested : requested || "openai_realtime";
    const base = isPcKnownAsrType(type) ? defaultAsrProvider(type) : ({} as Partial<AsrProvider>);
    const providerItem = normalizeAsrProviders([{ ...base, ...body, type, id: String(body.id ?? (base as AsrProvider).id ?? "") }])[0];
    const exists = state.settings.asrProviders.some((item) => item.id === providerItem.id);
    updateSettings({
      ...state.settings,
      asrProviders: exists
        ? state.settings.asrProviders.map((item) => item.id === providerItem.id ? providerItem : item)
        : [providerItem, ...state.settings.asrProviders],
      selectedASRProviderId: state.settings.selectedASRProviderId ?? providerItem.id,
    });
    return json({ status: "ok", provider: providerItem });
  }
  if (path === "settings/asr-provider/select" && request.method === "POST") {
    const body = await readJson<{ id: string }>(request);
    const providerId = String(body.id ?? "");
    if (!state.settings.asrProviders.some((provider) => provider.id === providerId)) return error("ASR provider not found", 404);
    updateSettings({ ...state.settings, selectedASRProviderId: providerId });
    return json({ status: "ok" });
  }
  const asrProviderDelete = path.match(/^settings\/asr-provider\/([^/]+)$/);
  if (asrProviderDelete && request.method === "DELETE") {
    const providerId = decodeURIComponent(asrProviderDelete[1]);
    const asrProviders = state.settings.asrProviders.filter((provider) => provider.id !== providerId);
    updateSettings({
      ...state.settings,
      asrProviders,
      selectedASRProviderId: state.settings.selectedASRProviderId === providerId ? asrProviders[0]?.id ?? null : state.settings.selectedASRProviderId,
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/asr-provider/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    const byId = new Map(state.settings.asrProviders.map((provider) => [provider.id, provider]));
    const reordered = (body.ids ?? []).map((providerId) => byId.get(providerId)).filter(Boolean) as AsrProvider[];
    for (const provider of state.settings.asrProviders) {
      if (!reordered.some((item) => item.id === provider.id)) reordered.push(provider);
    }
    updateSettings({ ...state.settings, asrProviders: reordered });
    return json({ status: "ok" });
  }

  if (path === "settings/tts-provider/detail" && request.method === "POST") {
    const body = await readJson<Partial<TtsProvider>>(request);
    // 同 ASR:新增/create 收敛到本端已知类型套默认模板;编辑/save 时未知跨端类型原样透传,
    // 不在此重置成 system(否则设置页一次保存即没收配置,backup C4)。
    const requested = String(body.type ?? "");
    const type = TTS_PROVIDER_TYPES.includes(requested as TtsProvider["type"]) ? requested : requested || "system";
    const base = TTS_PROVIDER_TYPES.includes(type as TtsProvider["type"]) ? defaultTtsProvider(type as TtsProvider["type"]) : ({} as Partial<TtsProvider>);
    const providerItem = normalizeTtsProviders([{ ...base, ...body, type, id: String(body.id ?? (base as TtsProvider).id ?? "") }])[0];
    const exists = state.settings.ttsProviders.some((item) => item.id === providerItem.id);
    updateSettings({
      ...state.settings,
      ttsProviders: exists
        ? state.settings.ttsProviders.map((item) => item.id === providerItem.id ? providerItem : item)
        : [providerItem, ...state.settings.ttsProviders],
      selectedTTSProviderId: state.settings.selectedTTSProviderId ?? providerItem.id,
    });
    return json({ status: "ok", provider: providerItem });
  }
  if (path === "settings/tts-provider/select" && request.method === "POST") {
    const body = await readJson<{ id: string }>(request);
    const providerId = String(body.id ?? "");
    if (!state.settings.ttsProviders.some((provider) => provider.id === providerId)) return error("TTS provider not found", 404);
    updateSettings({ ...state.settings, selectedTTSProviderId: providerId });
    return json({ status: "ok" });
  }
  const ttsProviderDelete = path.match(/^settings\/tts-provider\/([^/]+)$/);
  if (ttsProviderDelete && request.method === "DELETE") {
    const providerId = decodeURIComponent(ttsProviderDelete[1]);
    if (providerId === DEFAULT_SYSTEM_TTS_ID) return error("System TTS provider cannot be deleted", 400);
    const ttsProviders = state.settings.ttsProviders.filter((provider) => provider.id !== providerId);
    updateSettings({
      ...state.settings,
      ttsProviders,
      selectedTTSProviderId: state.settings.selectedTTSProviderId === providerId ? ttsProviders[0]?.id ?? null : state.settings.selectedTTSProviderId,
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/tts-provider/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    const byId = new Map(state.settings.ttsProviders.map((provider) => [provider.id, provider]));
    const reordered = (body.ids ?? []).map((providerId) => byId.get(providerId)).filter(Boolean) as TtsProvider[];
    for (const provider of state.settings.ttsProviders) {
      if (!reordered.some((item) => item.id === provider.id)) reordered.push(provider);
    }
    updateSettings({ ...state.settings, ttsProviders: reordered });
    return json({ status: "ok" });
  }

  // Cancel all currently-running system-TTS PowerShell processes. Called by the floating
  // play bar's stop button so the "你点了 ✕ 但 Windows TTS 还在念" gap closes within
  // ~100 ms. Online-TTS providers don't need cancellation server-side — they're already
  // synchronous request/response, and the client aborts its fetch directly.
  if (path === "tts/cancel" && request.method === "POST") {
    cancelAllSystemTts();
    return json({ status: "ok" });
  }
  if (path === "tts/speech" && request.method === "POST") {
    const body = await readJson<{ text?: string; providerId?: string; speed?: number }>(request);
    const text = String(body.text ?? "").trim();
    if (!text) return error("Text is required", 400);
    try {
      const result = await generateSpeechWithTtsProvider(text, body.providerId, body.speed);
      if (!result.audio) return error("TTS provider returned no audio", 502);
      return new Response(result.audio as BodyInit, {
        headers: {
          "Content-Type": result.mime,
          "Cache-Control": "no-store",
          "X-RikkaHub-TTS-Provider": result.provider.id,
        },
      });
    } catch (err) {
      // §4.3:透传真实状态码(408/429/5xx…),客户端据此区分可重试错;非 HTTP 错误回落 502。
      const status = err instanceof RetryableHttpError && err.statusCode >= 400 && err.statusCode <= 599
        ? err.statusCode
        : 502;
      return error(err instanceof Error ? err.message : String(err), status);
    }
  }

  if (path === "asr/transcribe" && request.method === "POST") {
    const form = await request.formData();
    const file = form.get("audio");
    if (!(file instanceof File)) return error("No audio file uploaded", 400);
    try {
      const text = await transcribeAudioWithAsrProvider(file);
      return json({ status: "ok", text });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }

  if (path === "images" && request.method === "GET") {
    return json({ images: state.generatedImages });
  }
  if (path === "images/generate" && request.method === "POST") {
    const body = await readJson<{ prompt: string; numberOfImages?: number; aspectRatio?: string; referenceFileIds?: number[] }>(request);
    if (!String(body.prompt ?? "").trim()) return error("Prompt is required", 400);
    try {
      const images = await callImageGeneration({
        prompt: String(body.prompt).trim(),
        numberOfImages: Number(body.numberOfImages ?? 1),
        aspectRatio: String(body.aspectRatio ?? "square"),
        referenceFileIds: Array.isArray(body.referenceFileIds) ? body.referenceFileIds.map(Number).filter(Number.isFinite) : [],
        // 域10-2:客户端取消/断开即中止上游生成,不再空转到自然超时。
        signal: request.signal,
      });
      return json({ status: "ok", images });
    } catch (err) {
      // 客户端主动取消(AbortError)/断开:不算失败,回 499 与压缩中止同款口径,前端静默忽略。
      if (err instanceof DOMException && err.name === "AbortError") {
        return error("Client cancelled", 499);
      }
      // 未配置生图模型:400 引导去配置,不是上游故障(502 会误导用户以为服务坏了)。
      if (err instanceof Error && err.message.includes("未配置图像生成模型")) {
        return error(err.message, 400);
      }
      return error(friendlyRequestError(err, state.settings.proxyConfig), 502);
    }
  }
  // 批量删除(图片多选):一次请求一次 saveState,原子;逐张删与单删同纪律(账本+字节+旁车)。
  if (path === "images/batch-delete" && request.method === "POST") {
    const body = await readJson<{ ids?: unknown }>(request);
    const ids = Array.isArray(body.ids) ? body.ids.map(String).filter((s) => s.trim().length > 0) : [];
    if (ids.length === 0) return error("ids required", 400);
    const deleted = deleteGeneratedImagesById(ids);
    return json({ status: "deleted", deleted });
  }
  const generatedImageDelete = path.match(/^images\/([^/]+)$/);
  if (generatedImageDelete && request.method === "DELETE") {
    const imageId = decodeURIComponent(generatedImageDelete[1]);
    const deleted = deleteGeneratedImagesById([imageId]);
    if (deleted === 0) return error("Image not found", 404);
    return json({ status: "deleted" });
  }
  return null;
}
