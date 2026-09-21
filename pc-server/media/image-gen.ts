// media/image-gen.ts — 图像生成（OpenAI images API / Gemini、生成图落盘与元数据登记）
// 纪律：负责图像生成请求与 state.generatedImages / files 落盘，不处理路由。
// 请求日志暂经 ../server 的 addLog 记录（3.5 拆 api/ 时收敛）。

import { readFileSync, statSync } from "node:fs";
import { bumpAnalyticsImgCount } from "../app-config/analytics";
import { fetchWithTimeout } from "../foundation/net";
import { join } from "node:path";
import type { GeneratedImage, JsonValue, Model, StoredFile } from "../foundation/types";
import { filesDir } from "../foundation/paths";
import { saveState, state } from "../persistence/json-store";
import {
  applyModelCustomBody,
  applyModelRequestHeaders,
  customBodyEntriesForForm,
  customFormValue,
  findModel,
  jsonBody,
  providerHeaders,
  textBody,
} from "../model-providers";
import { modelExists } from "../conversations/auxiliary";
import { addLog } from "../api/logs";

// 6-2:生图 provider 普遍分钟级(尤其批量/高分辨率),默认 30s 会误杀;5 分钟硬上限防永挂。
const IMAGE_GEN_TIMEOUT_MS = 300_000;

function imageSize(aspectRatio: string) {
  switch (aspectRatio) {
    case "landscape":
      return { openai: "1536x1024", google: "16:9" };
    case "portrait":
      return { openai: "1024x1536", google: "9:16" };
    default:
      return { openai: "1024x1024", google: "1:1" };
  }
}

function imageFileExtension(mime: string) {
  if (mime.includes("jpeg") || mime.includes("jpg")) return ".jpg";
  if (mime.includes("webp")) return ".webp";
  return ".png";
}

// 对齐安卓 toImageMimeType:output_format 字段 → MIME。
function imageFormatToMime(format: string | undefined): string {
  const f = (format ?? "").toLowerCase();
  if (f === "jpg" || f === "jpeg") return "image/jpeg";
  if (f === "webp") return "image/webp";
  return "image/png";
}

// 对齐安卓 OpenAIProvider.parseImageResponse / downloadImageAsBase64:
// 单条 data item 优先取 b64_json(按 output_format 推导 MIME);否则取 url,
// 下载图片并 base64 编码,用响应 Content-Type 作 MIME。
// 兼容部分 OpenAI 兼容代理(如腾讯云 COS)只返回 url、不返回 b64_json 的情况。
async function parseImageDataItem(
  item: Record<string, JsonValue> | undefined,
  defaultFormat: string,
): Promise<{ data: string; mime: string } | null> {
  if (!item || typeof item !== "object") return null;
  const b64 = String(item.b64_json ?? "");
  if (b64) {
    const format = typeof item.output_format === "string" ? item.output_format : defaultFormat;
    return { data: b64, mime: imageFormatToMime(format) };
  }
  const url = String(item.url ?? "");
  if (!url) return null;
  const dlResp = await fetchWithTimeout(url, { timeoutMs: 120_000 });
  if (!dlResp.ok) throw new Error(`Failed to download generated image: ${dlResp.status}`);
  const buf = Buffer.from(await dlResp.arrayBuffer());
  const contentType = dlResp.headers.get("content-type")?.split(";")[0]?.trim();
  return { data: buf.toString("base64"), mime: contentType || imageFormatToMime(defaultFormat) };
}

async function saveGeneratedImage(
  data: string,
  mime: string,
  prompt: string,
  model: Model,
  type: GeneratedImage["type"],
  sourceFileIds: number[] = [],
) {
  const fileId = state.nextFileId++;
  const fileName = `generated-${Date.now()}-${fileId}${imageFileExtension(mime)}`;
  const target = join(filesDir, fileName);
  await Bun.write(target, Buffer.from(data, "base64"));
  const fileEntry: StoredFile = { id: fileId, path: target, fileName, mime, size: statSync(target).size };
  state.files.push(fileEntry);
  const generated: GeneratedImage = {
    id: String(state.nextGeneratedImageId++),
    prompt,
    fileId,
    url: `/api/files/${fileId}/content`,
    fileName,
    mime,
    model: model.displayName || model.modelId,
    modelId: model.id,
    type,
    sourceFileIds,
    sourcePaths: sourceFileIds.length ? sourceFileIds.join(",") : "",
    createdAt: Date.now(),
  };
  state.generatedImages.unshift(generated);
  state.generatedImages = state.generatedImages.slice(0, 300);
  saveState();
  return generated;
}

export async function callImageGeneration(input: {
  prompt: string;
  numberOfImages: number;
  aspectRatio: string;
  referenceFileIds?: number[];
  /** 4-4:显式模型覆盖(provider 测试用)。缺省走全局设置;禁止调用方为复用管线
   *  临时改写全局 state——并发窗口内其他生图请求会读到串味模型。 */
  overrideModelUuid?: string;
  /** 域10-2:前端取消/断开时中止上游请求,不再空转到自然超时。 */
  signal?: AbortSignal;
}) {
  bumpAnalyticsImgCount();
  // 生图是"报错档"功能(用户拍板:不兜底直接报错让用户去配)。findModel 对未知 id 会
  // 兜底"第一个供应商 + 猜 gpt-image-2",未配置时这里必须显式拦截,不许走到那一步。
  // provider 测试路径带 overrideModelUuid(modelItem 已在端点里校验过),只拦全局设置。
  if (!input.overrideModelUuid && !modelExists(state.settings.imageGenerationModelId)) {
    throw new Error("未配置图像生成模型,请在「设置 - 默认模型与提示词」中指定一个");
  }
  const picked = findModel(input.overrideModelUuid || state.settings.imageGenerationModelId);
  const providerItem = picked.provider;
  const modelItem = picked.model;
  const selectedModel = modelItem.modelId === "auto" ? "gpt-image-2" : modelItem.modelId;
  const count = Math.min(4, Math.max(1, Number(input.numberOfImages) || 1));
  const sizes = imageSize(input.aspectRatio);
  const references = (input.referenceFileIds ?? [])
    .map((fileId) => state.files.find((file) => file.id === fileId))
    .filter(Boolean) as StoredFile[];
  const started = Date.now();

  if (providerItem.type === "google") {
    if (references.length > 0) throw new Error("Gemini image edit is not supported by the original provider implementation");
    const endpoint = `${providerItem.baseUrl.replace(/\/+$/, "")}/models/${selectedModel}:predict`;
    const body = applyModelCustomBody({
      instances: [{ prompt: input.prompt }],
      parameters: { sampleCount: count, aspectRatio: sizes.google },
    }, modelItem);
    const response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: applyModelRequestHeaders({ "Content-Type": "application/json", ...providerHeaders(providerItem) }, providerItem, modelItem),
      body: JSON.stringify(body),
      timeoutMs: IMAGE_GEN_TIMEOUT_MS,
      signal: input.signal,
    });
    const text = await response.text();
    addLog({
      providerId: providerItem.id,
      providerName: providerItem.name,
      url: endpoint,
      ok: response.ok,
      status: response.status,
      kind: "provider:image:generation",
      durationMs: Date.now() - started,
      method: "POST",
      requestHeaders: applyModelRequestHeaders({ "Content-Type": "application/json" }, providerItem, modelItem),
      responseHeaders: Object.fromEntries(response.headers.entries()),
      requestBody: jsonBody(body),
      responseBody: textBody(text),
      error: response.ok ? undefined : textBody(text),
    });
    if (!response.ok) throw new Error(`Failed to generate image: ${response.status} ${text.slice(0, 500)}`);
    const raw = JSON.parse(text || "{}");
    const predictions = Array.isArray(raw.predictions) ? raw.predictions : [];
    const items = [];
    for (const item of predictions) {
      const data = String(item?.bytesBase64Encoded ?? "");
      if (data) items.push(await saveGeneratedImage(data, "image/png", input.prompt, modelItem, "image_generation"));
    }
    return items;
  }

  if (providerItem.type !== "openai") {
    throw new Error("Image generation is supported for OpenAI-compatible and Google providers");
  }

  const base = providerItem.baseUrl.replace(/\/+$/, "");
  const headers = applyModelRequestHeaders(providerHeaders(providerItem), providerItem, modelItem);
  if (references.length > 0) {
    const endpoint = `${base}/images/edits`;
    const form = new FormData();
    form.append("model", selectedModel);
    form.append("prompt", input.prompt);
    form.append("n", String(count));
    form.append("size", sizes.openai);
    const field = references.length === 1 ? "image" : "image[]";
    for (const reference of references) {
      form.append(field, new Blob([readFileSync(reference.path)], { type: reference.mime || "image/png" }), reference.fileName);
    }
    for (const entry of customBodyEntriesForForm(modelItem)) {
      form.append(entry.key, customFormValue(entry.value));
    }
    const response = await fetchWithTimeout(endpoint, { method: "POST", headers, body: form, timeoutMs: IMAGE_GEN_TIMEOUT_MS, signal: input.signal });
    const text = await response.text();
    addLog({
      providerId: providerItem.id,
      providerName: providerItem.name,
      url: endpoint,
      ok: response.ok,
      status: response.status,
      kind: "provider:image:edit",
      durationMs: Date.now() - started,
      method: "POST",
      requestHeaders: headers,
      responseHeaders: Object.fromEntries(response.headers.entries()),
      requestBody: `multipart image edit\nmodel=${selectedModel}\nn=${count}\nsize=${sizes.openai}\nreferences=${references.map((file) => file.fileName).join(", ")}\ncustom=${customBodyEntriesForForm(modelItem).map((entry) => entry.key).join(", ") || "-"}`,
      responseBody: textBody(text),
      error: response.ok ? undefined : textBody(text),
    });
    if (!response.ok) throw new Error(`Failed to edit image: ${response.status} ${text.slice(0, 500)}`);
    const raw = JSON.parse(text || "{}");
    const defaultFormat = String(raw.output_format ?? "png");
    const sourceFileIds = references.map((file) => file.id);
    const items = [];
    for (const item of Array.isArray(raw.data) ? raw.data : []) {
      const parsed = await parseImageDataItem(item as Record<string, JsonValue> | undefined, defaultFormat);
      if (parsed) items.push(await saveGeneratedImage(parsed.data, parsed.mime, input.prompt, modelItem, "image_edit", sourceFileIds));
    }
    return items;
  }

  const endpoint = `${base}/images/generations`;
  const body = applyModelCustomBody({ model: selectedModel, prompt: input.prompt, n: count, size: sizes.openai }, modelItem);
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: IMAGE_GEN_TIMEOUT_MS,
    signal: input.signal,
  });
  const text = await response.text();
  addLog({
    providerId: providerItem.id,
    providerName: providerItem.name,
    url: endpoint,
    ok: response.ok,
    status: response.status,
    kind: "provider:image:generation",
    durationMs: Date.now() - started,
    method: "POST",
    requestHeaders: headers,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    requestBody: jsonBody(body),
    responseBody: textBody(text),
    error: response.ok ? undefined : textBody(text),
  });
  if (!response.ok) throw new Error(`Failed to generate image: ${response.status} ${text.slice(0, 500)}`);
  const raw = JSON.parse(text || "{}");
  const defaultFormat = String(raw.output_format ?? "png");
  const items = [];
  for (const item of Array.isArray(raw.data) ? raw.data : []) {
    const parsed = await parseImageDataItem(item as Record<string, JsonValue> | undefined, defaultFormat);
    if (parsed) items.push(await saveGeneratedImage(parsed.data, parsed.mime, input.prompt, modelItem, "image_generation"));
  }
  return items;
}
