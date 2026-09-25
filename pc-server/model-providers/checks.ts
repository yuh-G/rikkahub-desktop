// model-providers/checks.ts — Provider 连通性测试、模型列表与余额拉取
// 纪律：纯搬迁自 server.ts（阶段 5.3a），行为不变。依赖注入见 imports；不反向依赖 ../server。

import { updateSettings } from "../app-config";
import { fetchWithTimeout, readWithIdleTimeout } from "../foundation/net";
import { evaluateJsonExpr, ParseError } from "../foundation/json-expression";
import type { Assistant, Model, Provider } from "../foundation/types";
import { state } from "../persistence/json-store";
import { addLog } from "../api/logs";
import { findAssistant } from "../assistants";
import { applyCustomBody, jsonBody, modelsEndpointFor, normalizeFetchedModels, applyRequestHeaders, providerHeaders, providerTestCorePassed, providerTestModel, textBody } from "./index";
import { hostOfProvider } from "../inference-engine/message-builder";
import { deltaReasoningContent, deltaTextContent, modelsDevCache, parseSseChunks, responseEventToDelta, upstreamHttpError } from "../inference-engine/providers";
import { internalOutputCap } from "./model-limits";

/** 连通性测试的输出预算(我们的探测,不是用户的选择;经 internalOutputCap 收进模型上限)。 */
const PROVIDER_TEST_OUTPUT_TOKENS = 4096;

export function endpointFor(providerItem: Provider) {
  const base = providerItem.baseUrl.replace(/\/+$/, "");
  if (providerItem.type === "openai") {
    // responsesPath 留空回落 /responses(对齐安卓 §2.3,适配 Azure/网关非标准路径)。
    return providerItem.useResponseApi
      ? `${base}${providerItem.responsesPath?.trim() || "/responses"}`
      : `${base}${providerItem.chatCompletionsPath || "/chat/completions"}`;
  }
  // claude 拼接标准化(A):剥尾部 /v1 再拼全路径 /v1/messages——与 pi 引擎 piBaseUrlFor
  // 同款归一化,用户填 https://api.anthropic.com 或 .../v1 都能工作。此前 `${base}/messages`
  // 要求 baseUrl 必须带 /v1,漏填即 404,且同一配置工作区(pi 剥 /v1 由 SDK 拼)能跑、
  // 聊天挂——引擎间行为分歧。设置页 Base URL 预览(providers.tsx endpointPreview)同步同款规则。
  if (providerItem.type === "claude") return `${base.replace(/\/v1$/, "")}/v1/messages`;
  return `${base}/models/{model}:generateContent`;
}

export async function fetchProviderModels(providerItem: Provider) {
  const endpoint = modelsEndpointFor(providerItem);
  const started = Date.now();
  let response: Response;
  try {
    response = await fetchWithTimeout(endpoint, { headers: providerHeaders(providerItem) });
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    addLog({
      providerId: providerItem.id,
      providerName: providerItem.name,
      url: endpoint,
      ok: false,
      status: 0,
      kind: "provider:models",
      durationMs: Date.now() - started,
      method: "GET",
      requestHeaders: providerHeaders(providerItem),
      error: detail,
    });
    throw new Error(`获取模型列表失败：请求未能发送到供应商。\n${detail}\n\n请检查 Base URL、API Key、代理、防火墙或供应商服务状态。`);
  }
  const text = await response.text();
  let raw: any = {};
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = { text };
  }
  addLog({
    providerId: providerItem.id,
    providerName: providerItem.name,
    url: endpoint,
    ok: response.ok,
    status: response.status,
    kind: "provider:models",
    durationMs: Date.now() - started,
    method: "GET",
    requestHeaders: providerHeaders(providerItem),
    responseHeaders: Object.fromEntries(response.headers.entries()),
    responseBody: textBody(text),
    error: response.ok ? undefined : textBody(text),
  });
  if (!response.ok) {
    if (response.status === 404 && providerItem.models.length > 0) {
      return {
        endpoint,
        models: providerItem.models,
        preview: `The provider did not expose a model-list endpoint at ${endpoint}; using the configured local model templates.`,
      };
    }
    // B:404 形态诊断——报文带最终 URL(模型列表 404 是 Base URL 形态错误的高频信号)。
    throw upstreamHttpError(providerItem, endpoint, response.status, text || response.statusText);
  }
  return { endpoint, models: normalizeFetchedModels(providerItem, raw), preview: textBody(text) };
}

export async function fetchProviderBalance(providerItem: Provider) {
  const option = providerItem.balanceOption ?? { enabled: false, apiPath: "", resultPath: "" };
  if (!option.enabled) throw new Error("余额查询未启用");
  if (providerItem.type !== "openai") throw new Error("原版仅对 OpenAI-compatible 供应商执行余额查询");
  const apiPath = String(option.apiPath ?? "").trim();
  if (!apiPath) throw new Error("余额 API Path 为空");
  const endpoint = /^https?:\/\//i.test(apiPath) ? apiPath : `${providerItem.baseUrl.replace(/\/+$/, "")}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`;
  const started = Date.now();
  let response: Response;
  try {
    response = await fetchWithTimeout(endpoint, { headers: providerHeaders(providerItem) });
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    addLog({
      providerId: providerItem.id,
      providerName: providerItem.name,
      url: endpoint,
      ok: false,
      status: 0,
      kind: "provider:balance",
      durationMs: Date.now() - started,
      method: "GET",
      requestHeaders: providerHeaders(providerItem),
      error: detail,
    });
    throw new Error(`余额查询请求失败：${detail}`);
  }
  const text = await response.text();
  let raw: any = {};
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = { text };
  }
  addLog({
    providerId: providerItem.id,
    providerName: providerItem.name,
    url: endpoint,
    ok: response.ok,
    status: response.status,
    kind: "provider:balance",
    durationMs: Date.now() - started,
    method: "GET",
    requestHeaders: providerHeaders(providerItem),
    responseHeaders: Object.fromEntries(response.headers.entries()),
    responseBody: textBody(text),
    error: response.ok ? undefined : textBody(text),
  });
  if (!response.ok) throw new Error(`余额查询失败：${response.status} ${text.slice(0, 500) || response.statusText}`);
  // 余额取值走表达式 DSL(对齐 Android JsonExpression):支持路径 a.b / a[0] 与
  // + - * / ++ 运算,故 OpenRouter 预设 `data.total_credits - data.total_usage` 能算出净余额。
  const resultPath = String(option.resultPath ?? "").trim();
  let value: string;
  try {
    value = evaluateJsonExpr(resultPath, raw);
  } catch (err) {
    if (err instanceof ParseError) throw new Error(`余额结果路径表达式无效：${resultPath || "(空)"}（${err.message}）`);
    throw err;
  }
  // 数值一律两位小数展示;取不到值(空串)视为路径没命中,报错引导用户检查。
  const numeric = Number(value);
  const formatted = value.trim() !== "" && Number.isFinite(numeric) ? numeric.toFixed(2) : value.trim();
  if (!formatted) throw new Error(`余额结果路径没有取到值：${resultPath || "(root)"}`);
  return { status: "ok", endpoint, value: formatted, preview: textBody(text) };
}

function providerTestAssistant(modelItem?: Model): Assistant {
  return {
    ...findAssistant(state.settings.assistants, state.settings.assistantId),
    systemPrompt: "",
    temperature: null,
    topP: null,
    maxTokens: null,
    reasoningLevel: "off",
    customHeaders: [],
    customBodies: [],
    chatModelId: modelItem?.id ?? null,
  } as Assistant;
}

function providerTestPayload(providerItem: Provider, mode: "non_stream" | "stream" | "tools", selectedModel: string) {
  if (providerItem.type === "google") {
    const body: any = {
      contents: [{ role: "user", parts: [{ text: mode === "tools" ? "Use the get_current_time tool." : "hello" }] }],
      systemInstruction: { parts: [{ text: "You are a helpful assistant" }] },
    };
    if (mode === "tools") {
      body.tools = [{ functionDeclarations: [{ name: "get_current_time", description: "Get the current date and time.", parameters: { type: "object", properties: {} } }] }];
    }
    const suffix = mode === "stream" ? "streamGenerateContent?alt=sse" : "generateContent";
    return { url: `${providerItem.baseUrl.replace(/\/+$/, "")}/models/${selectedModel}:${suffix}`, body };
  }
  if (providerItem.type === "claude") {
    const body: any = {
      model: selectedModel,
      // Anthropic 协议 max_tokens 必填。连通性测试只要一句 "hello",4096 是我们给这个
      // 探测定的预算(不是用户的选择)——经 internalOutputCap 收进模型真实上限,否则对
      // 输出上限低于 4096 的模型(目录里有 cohere command-r 系 4000)测试会假失败。
      max_tokens: internalOutputCap(modelsDevCache, providerItem, selectedModel, PROVIDER_TEST_OUTPUT_TOKENS),
      stream: mode === "stream",
      system: "You are a helpful assistant",
      messages: [{ role: "user", content: mode === "tools" ? "Use the get_current_time tool." : "hello" }],
    };
    if (mode === "tools") {
      body.tools = [{ name: "get_current_time", description: "Get the current date and time.", input_schema: { type: "object", properties: {} } }];
      body.tool_choice = { type: "tool", name: "get_current_time" };
    }
    return { url: endpointFor(providerItem), body };
  }
  if (providerItem.useResponseApi) {
    const body: any = {
      model: selectedModel,
      input: [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: mode === "tools" ? "Use the get_current_time tool." : "hello" },
      ],
      stream: mode === "stream",
      store: false,
    };
    if (mode === "tools") {
      body.tools = [{ type: "function", name: "get_current_time", description: "Get the current date and time.", parameters: { type: "object", properties: {} } }];
      body.tool_choice = { type: "function", name: "get_current_time" };
    }
    return { url: endpointFor(providerItem), body };
  }
  const body: any = {
    model: selectedModel,
    messages: [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: mode === "tools" ? "Use the get_current_time tool." : "hello" },
    ],
    stream: mode === "stream",
  };
  if (mode === "stream" && hostOfProvider(providerItem) !== "api.mistral.ai") body.stream_options = { include_usage: true };
  if (mode === "tools") {
    body.tools = [{ type: "function", function: { name: "get_current_time", description: "Get the current date and time.", parameters: { type: "object", properties: {} } } }];
    // Use `"auto"` to match the live request path (conversations/orchestrator.ts) and the Android client
    // (which never sets tool_choice at all — same as auto by default). The previous shape
    // `{ type: "function", function: { name: ... } }` is the OpenAI "force this specific
    // function" format; Deepseek's API doesn't reliably emit standard tool_calls deltas
    // for that form when streaming, so the test would falsely fail. The user prompt
    // ("Use the get_current_time tool.") is explicit enough that any well-behaved model
    // will call the tool under "auto" mode.
    body.tool_choice = "auto";
  }
  return { url: endpointFor(providerItem), body };
}

async function readProviderTestStream(response: Response, providerItem: Provider) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let buffer = "";
  let preview = "";
  let sawEvent = false;
  const appendPreview = (text: string) => {
    if (!text) return;
    preview += text;
    if (preview.length > 6000) preview = `${preview.slice(0, 6000)}...`;
  };
  // 120s between upstream chunks before declaring the connection dead. Was 10 minutes;
  // dropped to 2 minutes so a half-open TCP / Cloudflare hiccup releases the connection
  // (and its slot in the frontend's 6-per-host pool) much faster. Reasoning models can
  // pause 30+s mid-thought but rarely 2 min — well within tolerance.
  // 专题7:本地 Promise.race 实现去重,改用 foundation/net 的共用包装。
  const readChunk = () =>
    readWithIdleTimeout(() => reader.read(), 120_000, "流式测试超时：2 分钟内没有收到供应商的 SSE 数据");
  const consumePayload = (payload: string) => {
    if (!payload || payload === "[DONE]") return;
    sawEvent = true;
    try {
      const raw = JSON.parse(payload);
      if (providerItem.type === "google") {
        appendPreview(String(raw.candidates?.[0]?.content?.parts?.[0]?.text ?? ""));
        return;
      }
      if (providerItem.type === "claude") {
        appendPreview(String(raw.delta?.text ?? raw.content_block?.text ?? raw.message?.content?.[0]?.text ?? ""));
        return;
      }
      const delta = raw.choices?.[0]?.delta ?? raw.choices?.[0]?.message ?? responseEventToDelta(raw) ?? {};
      const text = deltaTextContent(delta);
      const reasoning = deltaReasoningContent(delta);
      if (text) appendPreview(text);
      else if (reasoning) appendPreview(`[reasoning] ${reasoning}`);
      else if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        const names = delta.tool_calls
          .map((call: any) => String(call?.function?.name ?? "").trim())
          .filter(Boolean)
          .join(", ");
        appendPreview(names ? `[tool_calls] ${names}` : "[tool_calls]");
      } else if (raw.usage) {
        appendPreview("[usage]");
      }
    } catch {
      appendPreview(payload);
    }
  };
  try {
    for (;;) {
      const { done, value } = await readChunk();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\n\n+/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        for (const payload of parseSseChunks(part)) consumePayload(payload);
      }
      if (sawEvent) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed by the provider.
    }
  }
  for (const payload of parseSseChunks(buffer)) consumePayload(payload);
  return preview.trim() || (sawEvent ? "已收到流式事件" : "已建立流式连接，供应商未返回可解析内容");
}

export async function runProviderCheck(providerItem: Provider, mode: "non_stream" | "stream" | "tools", selectedModel: string, fetchedModels: Model[] = []) {
  const modelItem = providerTestModel(providerItem, selectedModel, fetchedModels);
  const assistant = providerTestAssistant(modelItem);
  const { url, body: rawBody } = providerTestPayload(providerItem, mode, selectedModel);
  const body = applyCustomBody(rawBody, assistant, modelItem);
  const started = Date.now();
  let response: Response;
  const headers = applyRequestHeaders(
    {
      "Content-Type": "application/json",
      ...(mode === "stream" ? { Accept: "text/event-stream" } : {}),
      ...providerHeaders(providerItem),
    },
    assistant,
    providerItem,
    modelItem,
  );
  try {
    response = await fetchWithTimeout(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // 流式测试响应体可合法慢速产出(下游另有 120s 空闲超时),总时长给 300s 上限;
      // 非流式/工具测试 60s 足够。
      timeoutMs: mode === "stream" ? 300_000 : 60_000,
    });
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    addLog({
      providerId: providerItem.id,
      providerName: providerItem.name,
      url,
      ok: false,
      status: 0,
      kind: `provider:test:${mode}`,
      durationMs: Date.now() - started,
      method: "POST",
      requestHeaders: headers,
      requestBody: jsonBody(body),
      responseBody: "",
      error: detail,
    });
    return {
      mode,
      ok: false,
      status: 0,
      endpoint: url,
      preview: `请求未能发送到供应商。\n${detail}\n\n请检查 Base URL、API 路径、代理、防火墙、证书或供应商服务状态。`,
    };
  }
  let text = "";
  try {
    text = mode === "stream" && response.ok ? await readProviderTestStream(response, providerItem) : await response.text();
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    addLog({
      providerId: providerItem.id,
      providerName: providerItem.name,
      url,
      ok: false,
      status: response.status,
      kind: `provider:test:${mode}`,
      durationMs: Date.now() - started,
      method: "POST",
      requestHeaders: headers,
      responseHeaders: Object.fromEntries(response.headers.entries()),
      requestBody: jsonBody(body),
      responseBody: textBody(text),
      error: detail,
    });
    return {
      mode,
      ok: false,
      status: response.status,
      endpoint: url,
      preview: `供应商已建立连接，但流式读取失败。\n${detail}`,
    };
  }
  addLog({
    providerId: providerItem.id,
    providerName: providerItem.name,
    url,
    ok: response.ok,
    status: response.status,
    kind: `provider:test:${mode}`,
    durationMs: Date.now() - started,
    method: "POST",
    requestHeaders: headers,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    requestBody: jsonBody(body),
    responseBody: textBody(text),
    error: response.ok ? undefined : textBody(text),
  });
  return {
    mode,
    ok: response.ok,
    status: response.status,
    endpoint: url,
    preview: textBody(text || (mode === "stream" && response.ok ? "流式测试已收到事件" : "")),
  };
}

/** 全面审查 R5-3:凭据/端点字段是否变更。变更即旧测试结论失效——settings/provider 保存
 *  时撤销 testPassed;markProviderTestResult 落章前复核(测试飞行期间用户改了配置,
 *  结论属于旧配置,不能给新配置盖章)。
 *  订阅供应商:oauth 凭证本身变化(登录/注销/刷新轮换)也视为凭据变更。 */
export function providerAuthChanged(prev: Provider, next: Provider): boolean {
  const fields = ["type", "apiKey", "baseUrl", "chatCompletionsPath"] as const;
  if (fields.some((key) => String(prev[key] ?? "") !== String(next[key] ?? ""))) return true;
  if ((prev.useResponseApi === true) !== (next.useResponseApi === true)) return true;
  // oauth 凭据判同:都在且 refresh 相同 = 未变(刷新轮换会换 refresh,故用 refresh 作指纹)。
  const prevRefresh = prev.oauth?.credential?.refresh;
  const nextRefresh = next.oauth?.credential?.refresh;
  const prevHas = prev.oauth != null;
  const nextHas = next.oauth != null;
  if (prevHas !== nextHas) return true;
  if (prevHas && nextHas && prevRefresh !== nextRefresh) return true;
  return false;
}

export function markProviderTestResult(providerItem: Provider, checks: Array<{ mode: string; ok: boolean }>) {
  if (!providerTestCorePassed(checks)) return;
  updateSettings({
    ...state.settings,
    providers: state.settings.providers.map((item) =>
      // R5-3:providerItem 是测试开始时的快照;凭据/端点已被用户改动 → 不盖章。
      item.id === providerItem.id && !providerAuthChanged(item, providerItem)
        ? { ...item, testPassed: true, testPassedAt: Date.now() }
        : item,
    ),
  });
}
