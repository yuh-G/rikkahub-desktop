import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

type AnyRecord = Record<string, any>;

const rootDir = resolve(import.meta.dir, "../..");
const serverDir = join(rootDir, "pc-server");
const tempDir = join(rootDir, "pc-data", "smoke-request-chain");
const pcPort = Number(process.env.SMOKE_PC_PORT ?? 18181);
const mockPort = Number(process.env.SMOKE_MOCK_PORT ?? 18182);
const mcpPort = Number(process.env.SMOKE_MCP_PORT ?? 18184);
const webDavPort = Number(process.env.SMOKE_WEBDAV_PORT ?? 18186);
const baseUrl = `http://127.0.0.1:${pcPort}`;
const mockBaseUrl = `http://127.0.0.1:${mockPort}/v1`;
const mcpBaseUrl = `http://127.0.0.1:${mcpPort}/mcp`;
const webDavBaseUrl = `http://127.0.0.1:${webDavPort}/dav`;

const requests: Array<{ path: string; body: AnyRecord }> = [];
const mcpRequests: Array<{ method: string; body: AnyRecord }> = [];
const webDavRequests: Array<{ method: string; path: string; auth: string }> = [];
const webDavFiles = new Map<string, string>();
const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lQSCdAAAAABJRU5ErkJggg==";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type SseItem = string | AnyRecord | { payload: string | AnyRecord; delayMs?: number };

function sse(payloads: SseItem[]) {
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const item of payloads) {
          const payload = typeof item === "object" && item !== null && "payload" in item ? item.payload : item;
          const delayMs = typeof item === "object" && item !== null && "payload" in item ? item.delayMs ?? 15 : 15;
          const text = typeof payload === "string" ? payload : JSON.stringify(payload);
          controller.enqueue(new TextEncoder().encode(`data: ${text}\n\n`));
          await Bun.sleep(delayMs);
        }
        controller.close();
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    },
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestJson(req: Request) {
  return req.json().catch(() => ({})) as Promise<AnyRecord>;
}

function promptTextFromChatBody(body: AnyRecord) {
  return (body.messages ?? [])
    .map((item: AnyRecord) => typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? ""))
    .join("\n");
}

function promptTextFromResponseBody(body: AnyRecord) {
  return (body.input ?? [])
    .map((item: AnyRecord) => typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? ""))
    .join("\n");
}

const mockServer = Bun.serve({
  port: mockPort,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models") {
      return json({
        data: [
          { id: "mock-chat-tool", input_modalities: ["text"], output_modalities: ["text"] },
          { id: "mock-response-tool", input_modalities: ["text"], output_modalities: ["text"] },
          { id: "mimo-v2.5-pro", input_modalities: ["text"], output_modalities: ["text"] },
        ],
      });
    }
    if (url.pathname === "/v1/chat/completions") {
      const body = await requestJson(req);
      requests.push({ path: url.pathname, body });
        if (body.stream) {
          const promptText = promptTextFromChatBody(body);
          if (promptText.includes("<source_text>") || promptText.includes("Please translate")) {
            return sse([
              { choices: [{ delta: { content: "Translated " } }] },
              { payload: { choices: [{ delta: { content: "smoke text." } }] }, delayMs: 80 },
              "[DONE]",
            ]);
          }
          if (promptText.includes("conversation compression assistant") || promptText.includes("<conversation>")) {
            return sse([
              { choices: [{ delta: { content: "Compressed " } }] },
              { payload: { choices: [{ delta: { content: "conversation summary." } }] }, delayMs: 80 },
              "[DONE]",
            ]);
          }
          if (promptText.includes("慢慢回答")) {
            return sse([
              { choices: [{ delta: { content: "第一段" } }] },
            { payload: { choices: [{ delta: { content: "第二段" } }] }, delayMs: 500 },
            { payload: { choices: [{ delta: { content: "第三段" } }] }, delayMs: 500 },
            "[DONE]",
          ]);
        }
        if (promptText.includes("并发隔离 A")) {
          return sse([
            { choices: [{ delta: { content: "A_ONLY_" } }] },
            { payload: { choices: [{ delta: { content: "REPLY" } }] }, delayMs: 220 },
            "[DONE]",
          ]);
        }
        if (promptText.includes("并发隔离 B")) {
          return sse([
            { choices: [{ delta: { content: "B_ONLY_" } }] },
            { payload: { choices: [{ delta: { content: "REPLY" } }] }, delayMs: 80 },
            "[DONE]",
          ]);
        }
        if (body.messages?.some((item: AnyRecord) => item.role === "tool")) {
          const toolText = body.messages
            .filter((item: AnyRecord) => item.role === "tool")
            .map((item: AnyRecord) => String(item.content ?? ""))
            .join("\n");
          if (toolText.includes("MCP_IMAGE_RESULT")) {
            return sse([
              { choices: [{ delta: { content: "MCP 图片工具结果已收到" } }] },
              { choices: [{ delta: { content: "，继续回复。" } }] },
              "[DONE]",
            ]);
          }
          if (toolText.includes("MCP_RESULT")) {
            return sse([
              { choices: [{ delta: { content: "MCP 工具结果已收到" } }] },
              { choices: [{ delta: { content: "，继续回复。" } }] },
              "[DONE]",
            ]);
          }
          if (toolText.includes("search.example.com") || toolText.includes("SCRAPE_RESULT")) {
            return sse([
              { choices: [{ delta: { content: "搜索工具结果已收到" } }] },
              { choices: [{ delta: { content: "，继续回复。" } }] },
              "[DONE]",
            ]);
          }
          if (toolText.includes("User likes smoke memory") || toolText.includes("\"result\":\"42\"")) {
            return sse([
              { choices: [{ delta: { content: "记忆和 JS 工具结果已收到" } }] },
              { choices: [{ delta: { content: "，继续回复。" } }] },
              "[DONE]",
            ]);
          }
          if (toolText.includes("Invalid tool arguments JSON")) {
            return sse([
              { choices: [{ delta: { content: "工具参数错误已收到" } }] },
              "[DONE]",
            ]);
          }
          return sse([
            { choices: [{ delta: { content: "工具结果已收到" } }] },
            { choices: [{ delta: { content: "，继续回复。" } }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } },
            "[DONE]",
          ]);
        }
        if (body.tools?.some((tool: AnyRecord) => tool.function?.name === "mcp__smoke_image_tool") && promptText.includes("smoke_image_tool")) {
          return sse([
            {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call_mcp_image_1",
                    type: "function",
                    function: { name: "mcp__smoke_image_tool", arguments: "{\"label\":\"smoke-img\"}" },
                  }],
                },
              }],
            },
            "[DONE]",
          ]);
        }
        if (body.tools?.some((tool: AnyRecord) => tool.function?.name === "mcp__smoke_lookup")) {
          return sse([
            { choices: [{ delta: { reasoning_content: "准备调用 MCP smoke_lookup。" } }] },
            {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call_mcp_smoke_1",
                    type: "function",
                    function: { name: "mcp__smoke_lookup", arguments: "{\"query\":\"rikkahub\"}" },
                  }],
                },
              }],
            },
            "[DONE]",
          ]);
        }
        if (body.tools?.some((tool: AnyRecord) => tool.function?.name === "search_web") && promptText.includes("搜索工具")) {
          return sse([
            { choices: [{ delta: { reasoning_content: "准备调用联网搜索。" } }] },
            {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call_search_1",
                    type: "function",
                    function: { name: "search_web", arguments: "{\"query\":\"RikkaHub PC smoke\",\"max_results\":2}" },
                  }],
                },
              }],
            },
            {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 1,
                    id: "call_scrape_1",
                    type: "function",
                    function: { name: "scrape_web", arguments: "{\"url\":\"https://search.example.com/rikkahub\"}" },
                  }],
                },
              }],
            },
            "[DONE]",
          ]);
        }
        if (body.tools?.some((tool: AnyRecord) => tool.function?.name === "memory_tool") && promptText.includes("记忆和 JS 工具")) {
          return sse([
            { choices: [{ delta: { reasoning_content: "准备写入记忆并执行 JS。" } }] },
            {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call_memory_1",
                    type: "function",
                    function: { name: "memory_tool", arguments: "{\"action\":\"create\",\"content\":\"User likes smoke memory.\"}" },
                  }],
                },
              }],
            },
            {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 1,
                    id: "call_js_1",
                    type: "function",
                    function: { name: "eval_javascript", arguments: "{\"code\":\"40 + 2\"}" },
                  }],
                },
              }],
            },
            "[DONE]",
          ]);
        }
        if (promptText.includes("坏工具参数")) {
          return sse([
            { choices: [{ delta: { reasoning_content: "准备测试坏工具参数。" } }] },
            {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call_invalid_args_1",
                    type: "function",
                    function: { name: "get_time_info", arguments: "{" },
                  }],
                },
              }],
            },
            "[DONE]",
          ]);
        }
        return sse([
          { choices: [{ delta: { reasoning_content: "先检查本地时间工具。" } }] },
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "call_time_1",
                  type: "function",
                  function: { name: "get_time_info", arguments: "{}" },
                }],
              },
            }],
          },
          "[DONE]",
        ]);
      }
      const hasToolChoice = body.tools?.some((tool: AnyRecord) => tool.function?.name === "get_current_time");
      return json({
        choices: [{
          message: {
            role: "assistant",
            content: hasToolChoice
              ? ""
              : body.messages?.[0]?.content?.includes("<content>")
              ? "本地回归标题"
              : "非流式测试通过",
            tool_calls: hasToolChoice
              ? [{ id: "test_time_1", type: "function", function: { name: "get_current_time", arguments: "{}" } }]
              : undefined,
          },
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
    }
    if (url.pathname === "/v1/images/generations") {
      const body = await requestJson(req);
      requests.push({ path: url.pathname, body });
      return json({
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: tinyPngBase64 }],
      });
    }
    if (url.pathname === "/v1/images/edits") {
      const form = await req.formData();
      const body: AnyRecord = {};
      for (const [key, value] of form.entries()) {
        if (value instanceof File) {
          const current = Array.isArray(body[key]) ? body[key] : body[key] ? [body[key]] : [];
          current.push({ name: value.name, type: value.type, size: value.size });
          body[key] = current;
        } else {
          body[key] = String(value);
        }
      }
      requests.push({ path: url.pathname, body });
      return json({
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: tinyPngBase64 }],
      });
    }
    if (url.pathname === "/v1/responses") {
      const body = await requestJson(req);
      requests.push({ path: url.pathname, body });
        if (body.stream) {
          const promptText = promptTextFromResponseBody(body);
          if (promptText.includes("<source_text>") || promptText.includes("Please translate")) {
            return sse([
              { type: "response.output_text.delta", delta: "Translated " },
              { payload: { type: "response.output_text.delta", delta: "smoke text." }, delayMs: 80 },
              "[DONE]",
            ]);
          }
          if (promptText.includes("conversation compression assistant") || promptText.includes("<conversation>")) {
            return sse([
              { type: "response.output_text.delta", delta: "Compressed " },
              { payload: { type: "response.output_text.delta", delta: "conversation summary." }, delayMs: 80 },
              "[DONE]",
            ]);
          }
          if (promptText.includes("慢慢回答")) {
            return sse([
              { type: "response.output_text.delta", delta: "第一段" },
            { payload: { type: "response.output_text.delta", delta: "第二段" }, delayMs: 500 },
            { payload: { type: "response.output_text.delta", delta: "第三段" }, delayMs: 500 },
            "[DONE]",
          ]);
        }
        if (body.input?.some((item: AnyRecord) => item.type === "function_call_output")) {
          return sse([
            { type: "response.output_text.delta", delta: "Response 工具结果已收到" },
            { type: "response.output_text.delta", delta: "，继续回复。" },
            { type: "response.completed", response: { usage: { input_tokens: 13, output_tokens: 6, total_tokens: 19 } } },
            "[DONE]",
          ]);
        }
        return sse([
          {
            type: "response.output_item.added",
            item: {
              type: "reasoning",
              id: "rs_1",
              summary: [{ type: "summary_text", text: "先检查本地时间工具。" }],
              encrypted_content: "enc-smoke",
            },
          },
          { type: "response.reasoning_summary_text.delta", delta: "先检查本地时间工具。" },
          {
            type: "response.output_item.added",
            item: {
              type: "function_call",
              id: "fc_1",
              call_id: "call_time_response_1",
              name: "get_time_info",
              arguments: "",
            },
          },
          { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{}" },
          { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: "{}" },
          "[DONE]",
        ]);
      }
      return json({
        output_text: "Response 非流式测试通过",
        output: [{ type: "message", content: [{ type: "output_text", text: "Response 非流式测试通过" }] }],
      });
    }
    return json({ error: "not found", path: url.pathname }, 404);
  },
});

const mcpServer = Bun.serve({
  port: mcpPort,
  async fetch(req) {
    const body = await requestJson(req);
    mcpRequests.push({ method: String(body.method ?? ""), body });
    if (body.method === "initialize") {
      return json(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: body.params?.protocolVersion ?? "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "smoke-mcp", version: "1.0.0" },
          },
        },
        200,
      );
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 204 });
    }
    if (body.method === "tools/list") {
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            {
              name: "smoke_lookup",
              description: "Return deterministic smoke MCP data",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
            {
              name: "smoke_image_tool",
              description: "Return a tiny image as MCP content block",
              inputSchema: {
                type: "object",
                properties: { label: { type: "string" } },
                required: ["label"],
              },
            },
          ],
        },
      });
    }
    if (body.method === "tools/call") {
      if (body.params?.name === "smoke_image_tool") {
        return json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [
              { type: "text", text: `MCP_IMAGE_RESULT:${body.params?.arguments?.label ?? ""}` },
              { type: "image", data: tinyPngBase64, mimeType: "image/png" },
            ],
          },
        });
      }
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{ type: "text", text: `MCP_RESULT:${body.params?.arguments?.query ?? ""}` }],
        },
      });
    }
    return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } }, 200);
  },
});

function webDavMultistatus(items: Array<{ href: string; displayName: string; size?: number; lastModified?: string; collection?: boolean }>) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
${items.map((item) => `  <D:response>
    <D:href>${item.href}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${item.displayName}</D:displayname>
        <D:getcontentlength>${item.size ?? 0}</D:getcontentlength>
        <D:getlastmodified>${item.lastModified ?? new Date().toUTCString()}</D:getlastmodified>
        <D:resourcetype>${item.collection ? "<D:collection/>" : ""}</D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`).join("\n")}
</D:multistatus>`;
  return new Response(body, {
    status: 207,
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}

const webDavServer = Bun.serve({
  port: webDavPort,
  async fetch(req) {
    const url = new URL(req.url);
    const auth = req.headers.get("authorization") ?? "";
    webDavRequests.push({ method: req.method, path: url.pathname, auth });
    const expectedAuth = `Basic ${btoa("smoke:secret")}`;
    if (auth !== expectedAuth) return new Response("unauthorized", { status: 401 });
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const fileName = segments.length >= 3 ? segments[segments.length - 1] : "";
    if (req.method === "PROPFIND") {
      const depth = req.headers.get("depth") ?? "0";
      if (depth === "1") {
        const items = [
          { href: "/dav/rikkahub_backups/", displayName: "rikkahub_backups", collection: true },
          ...[...webDavFiles.entries()].map(([name, content]) => ({
            href: `/dav/rikkahub_backups/${encodeURIComponent(name)}`,
            displayName: name,
            size: new TextEncoder().encode(content).byteLength,
          })),
        ];
        return webDavMultistatus(items);
      }
      return webDavMultistatus([{ href: "/dav/rikkahub_backups/", displayName: "rikkahub_backups", collection: true }]);
    }
    if (req.method === "MKCOL") return new Response(null, { status: 201 });
    if (req.method === "PUT") {
      if (!fileName) return new Response("missing file name", { status: 400 });
      webDavFiles.set(fileName, await req.text());
      return new Response(null, { status: 201 });
    }
    if (req.method === "GET") {
      const content = webDavFiles.get(fileName);
      if (!content) return new Response("not found", { status: 404 });
      return new Response(content, { headers: { "Content-Type": "application/json; charset=utf-8" } });
    }
    if (req.method === "DELETE") {
      if (!webDavFiles.delete(fileName)) return new Response("not found", { status: 404 });
      return new Response(null, { status: 204 });
    }
    return new Response("method not allowed", { status: 405 });
  },
});

function spawnPcServer() {
  return Bun.spawn(["bun", "run", "server.ts"], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(pcPort),
      RIKKAHUB_PC_DATA_DIR: tempDir,
      BROWSER: "none",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitForHealth(timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Server still booting.
    }
    await Bun.sleep(200);
  }
  throw new Error("PC server did not become healthy");
}

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  return data;
}

async function uploadFile(path: string, file: File) {
  const form = new FormData();
  form.append("files", file);
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", body: form });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`upload ${path} failed: ${response.status} ${text}`);
  return data;
}

async function uploadFiles(path: string, files: File[]) {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", body: form });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`upload ${path} failed: ${response.status} ${text}`);
  return data;
}

async function expectApiError(path: string, init: RequestInit, expected: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  assert(!response.ok, `${init.method ?? "GET"} ${path} should have failed`);
  assert(text.includes(expected), `expected error to include "${expected}", got: ${text}`);
  return text;
}

async function waitForConversation(id: string, predicate: (conversation: AnyRecord) => boolean, label: string, timeoutMs = 20_000) {
  const started = Date.now();
  let last: AnyRecord | null = null;
  while (Date.now() - started < timeoutMs) {
    last = await api(`/api/conversations/${id}`);
    if (predicate(last)) return last;
    await Bun.sleep(250);
  }
  throw new Error(`${label} timed out. Last conversation: ${JSON.stringify(last, null, 2)}`);
}

async function collectConversationEvents(id: string, stop: (events: AnyRecord[]) => boolean, timeoutMs = 20_000) {
  const response = await fetch(`${baseUrl}/api/conversations/${id}/stream`);
  if (!response.ok) throw new Error(`conversation stream failed: ${response.status} ${await response.text()}`);
  const reader = response.body?.getReader();
  assert(reader, "conversation stream reader missing");
  const events: AnyRecord[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  const started = Date.now();
  try {
    for (;;) {
      if (Date.now() - started > timeoutMs) throw new Error(`conversation stream timeout: ${JSON.stringify(events.slice(-5), null, 2)}`);
      const read = await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) =>
          setTimeout(() => reject(new Error("conversation stream idle timeout")), 1000),
        ),
      ]).catch((err) => {
        if (Date.now() - started > timeoutMs) throw err;
        return null;
      });
      if (!read) continue;
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      const blocks = buffer.split(/\n\n+/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        if (!block.trim() || block.trim().startsWith(":")) continue;
        const event = block.split(/\r?\n/).find((line) => line.startsWith("event:"))?.replace(/^event:\s*/, "").trim() ?? "message";
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.replace(/^data:\s?/, ""))
          .join("\n");
        if (data) events.push({ event, data: JSON.parse(data) });
      }
      if (stop(events)) return events;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return events;
}

function textFromParts(parts: AnyRecord[]) {
  return parts.map((part) => part?.type === "text" ? String(part.text ?? "") : "").join("");
}

function selectedMessages(conversation: AnyRecord) {
  return (conversation.messages ?? []).map((node: AnyRecord) => node.messages[node.selectIndex] ?? node.messages[0]);
}

async function configure(useResponseApi: boolean) {
  const settings = await api("/api/settings");
  const modelId = useResponseApi ? "smoke-response-model-id" : "smoke-chat-model-id";
  const providerId = useResponseApi ? "smoke-response-provider" : "smoke-chat-provider";
  const assistantId = settings.assistantId;
  const model = {
    id: modelId,
    modelId: useResponseApi ? "mock-response-tool" : "mock-chat-tool",
    displayName: useResponseApi ? "Mock Response Tool" : "Mock Chat Tool",
    type: "CHAT",
    inputModalities: ["TEXT"],
    outputModalities: ["TEXT"],
    abilities: ["TOOL", "REASONING"],
    tools: [],
  };
  await api("/api/settings/provider", {
    method: "POST",
    body: JSON.stringify({
      type: "openai",
      id: providerId,
      enabled: true,
      name: useResponseApi ? "Mock Response Provider" : "Mock Chat Provider",
      builtIn: false,
      shortDescription: "local smoke provider",
      description: "local smoke provider",
      apiKey: "smoke-key",
      baseUrl: mockBaseUrl,
      chatCompletionsPath: "/chat/completions",
      useResponseApi,
      promptCaching: false,
      promptCacheTtl: "5m",
      testPassed: true,
      testPassedAt: Date.now(),
      models: [model],
      balanceOption: { enabled: false, apiPath: "/credits", resultPath: "balance" },
    }),
  });
  const assistant = settings.assistants.find((item: AnyRecord) => item.id === assistantId);
  await api("/api/settings/assistant/detail", {
    method: "POST",
    body: JSON.stringify({
      ...assistant,
      chatModelId: modelId,
      name: useResponseApi ? "Response Smoke" : "Chat Smoke",
      systemPrompt: "You are a smoke-test assistant. Time: {{cur_datetime}}.",
      messageTemplate: "{{ message }}",
      presetMessages: [],
      regexes: [],
      streamOutput: true,
      enableMemory: false,
      useGlobalMemory: false,
      enableRecentChatsReference: false,
      enableTimeReminder: false,
      reasoningLevel: "low",
      localTools: [{ type: "time_info" }],
      enabledSkills: [],
      mcpServers: [],
      modeInjectionIds: [],
      lorebookIds: [],
      quickMessageIds: [],
      allowConversationSystemPrompt: true,
    }),
  });
  await api("/api/settings/default-models", {
    method: "POST",
    body: JSON.stringify({
      chatModelId: modelId,
      titleModelId: modelId,
      suggestionModelId: "",
      translateModeId: modelId,
      compressModelId: modelId,
    }),
  }).catch(async () => {
    const current = await api("/api/settings");
    await api("/api/settings/defaults", {
      method: "POST",
      body: JSON.stringify({
        ...current,
        chatModelId: modelId,
        titleModelId: modelId,
        suggestionModelId: "",
        translateModeId: modelId,
        compressModelId: modelId,
      }),
    });
  });
  return { modelId, providerId };
}

async function configureImageProvider(providerType: "openai" | "google") {
  const settings = await api("/api/settings");
  const providerId = providerType === "openai" ? "smoke-image-openai-provider" : "smoke-image-google-provider";
  const modelId = providerType === "openai" ? "smoke-image-openai-model" : "smoke-image-google-model";
  const model: AnyRecord = {
    id: modelId,
    modelId: providerType === "openai" ? "gpt-image-2" : "gemini-2.5-flash-image",
    displayName: providerType === "openai" ? "Mock GPT Image" : "Mock Gemini Image",
    type: "IMAGE",
    inputModalities: providerType === "openai" ? ["TEXT", "IMAGE"] : ["TEXT"],
    outputModalities: ["IMAGE"],
    abilities: [],
    tools: providerType === "openai" ? [{ type: "image_generation" }] : [],
  };
  const provider: AnyRecord = {
    type: providerType,
    id: providerId,
    enabled: true,
    name: providerType === "openai" ? "Mock OpenAI Image Provider" : "Mock Google Image Provider",
    builtIn: false,
    shortDescription: "local smoke image provider",
    description: "local smoke image provider",
    apiKey: "smoke-key",
    baseUrl: providerType === "openai" ? mockBaseUrl : `${mockBaseUrl.replace(/\/v1$/, "")}/google/v1`,
    chatCompletionsPath: "/chat/completions",
    useResponseApi: false,
    promptCaching: false,
    promptCacheTtl: "5m",
    testPassed: true,
    testPassedAt: Date.now(),
    models: [model],
    balanceOption: { enabled: false, apiPath: "/credits", resultPath: "balance" },
  };
  await api("/api/settings/provider", { method: "POST", body: JSON.stringify(provider) });
  await api("/api/settings/default-models", {
    method: "POST",
    body: JSON.stringify({
      chatModelId: settings.chatModelId,
      titleModelId: settings.titleModelId,
      suggestionModelId: settings.suggestionModelId,
      translateModeId: settings.translateModeId,
      compressModelId: settings.compressModelId,
      ocrModelId: settings.ocrModelId,
      imageGenerationModelId: modelId,
      titlePrompt: settings.titlePrompt,
      translatePrompt: settings.translatePrompt,
      suggestionPrompt: settings.suggestionPrompt,
      ocrPrompt: settings.ocrPrompt,
      compressPrompt: settings.compressPrompt,
    }),
  });
  return { providerId, modelId };
}

async function configureAssistantPatch(patch: AnyRecord) {
  const settings = await api("/api/settings");
  const assistant = settings.assistants.find((item: AnyRecord) => item.id === settings.assistantId);
  assert(assistant, "current assistant missing");
  await api("/api/settings/assistant/detail", {
    method: "POST",
    body: JSON.stringify({ ...assistant, ...patch }),
  });
}

async function findSettingsModel(modelId: string) {
  const settings = await api("/api/settings");
  for (const provider of settings.providers ?? []) {
    const model = (provider.models ?? []).find((item: AnyRecord) => item.id === modelId || item.modelId === modelId);
    if (model) return { settings, provider, model };
  }
  throw new Error(`model not found in settings: ${modelId}`);
}

async function runConversation(useResponseApi: boolean) {
  const beforeCount = requests.length;
  await configure(useResponseApi);
  const conversationId = `smoke-${useResponseApi ? "response" : "chat"}-${Date.now()}`;
  await api(`/api/conversations/${conversationId}/system-prompt`, {
    method: "POST",
    body: JSON.stringify({ systemPrompt: "Conversation scoped smoke prompt" }),
  }).catch(() => undefined);
  const streamEventsPromise = collectConversationEvents(
    conversationId,
    (events) => events.some((event) => {
      if (event.event === "node_update") {
        const node = event.data?.node;
        const msg = node?.messages?.[node?.selectIndex ?? 0] ?? node?.messages?.[0];
        return textFromParts(msg?.parts ?? []).includes("继续回复");
      }
      if (event.event === "snapshot") {
        const conversation = event.data?.conversation;
        return conversation?.isGenerating === false && selectedMessages(conversation).some((msg: AnyRecord) => textFromParts(msg.parts ?? []).includes("继续回复"));
      }
      return false;
    }),
  );
  await Bun.sleep(50);
  await api(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "请调用本地时间工具，然后回答。"}] }),
  });
  const streamEvents = await streamEventsPromise;
  const conversation = await waitForConversation(
    conversationId,
    (item) => !item.isGenerating && selectedMessages(item).some((msg: AnyRecord) => msg.role === "ASSISTANT" && textFromParts(msg.parts).includes("继续回复")),
    useResponseApi ? "response conversation" : "chat conversation",
  );
  const messages = selectedMessages(conversation);
  const assistantMessage = messages.find((msg: AnyRecord) => msg.role === "ASSISTANT");
  assert(assistantMessage, "assistant message missing");
  assert(streamEvents.some((item) => item.event === "node_update"), "conversation SSE did not emit node_update events");
  assert(streamEvents.some((item) => item.event === "snapshot" && item.data?.conversation?.isGenerating === false), "conversation SSE did not emit final non-generating snapshot");
  assert(assistantMessage.parts.some((part: AnyRecord) => part.type === "tool" && part.toolName === "get_time_info" && Array.isArray(part.output) && part.output.length > 0), "tool result was not persisted in assistant parts");
  assert(textFromParts(assistantMessage.parts).includes("继续回复"), "assistant final text missing");
  const captured = requests.slice(beforeCount);
  const streamCaptured = captured.filter((item) => item.body?.stream === true);
  assert(streamCaptured.length >= 2, "expected initial tool round and follow-up round");
  if (useResponseApi) {
    const first = streamCaptured.find((item) => item.path === "/v1/responses")?.body;
    const follow = streamCaptured.filter((item) => item.path === "/v1/responses").at(-1)?.body;
    assert(first?.instructions?.includes("Conversation scoped smoke prompt"), "Response API instructions did not include conversation system prompt");
    assert(first?.reasoning?.summary === "auto", "Response API reasoning summary was not sent");
    assert(Array.isArray(follow?.input), "Response API follow-up input missing");
    assert(follow.input.some((item: AnyRecord) => item.type === "function_call"), "Response API follow-up missing function_call history item");
    assert(follow.input.some((item: AnyRecord) => item.type === "function_call_output"), "Response API follow-up missing function_call_output item");
  } else {
    const first = streamCaptured.find((item) => item.path === "/v1/chat/completions")?.body;
    const follow = streamCaptured.filter((item) => item.path === "/v1/chat/completions").at(-1)?.body;
    assert(first?.messages?.some((item: AnyRecord) => item.role === "system" && item.content.includes("Conversation scoped smoke prompt")), "Chat Completions system prompt missing");
    assert(first?.tools?.some((tool: AnyRecord) => tool.function?.name === "get_time_info"), "Chat Completions local tool missing");
    assert(follow?.messages?.some((item: AnyRecord) => item.role === "assistant" && item.reasoning_content), "Chat Completions follow-up missing assistant reasoning_content");
    assert(follow?.messages?.some((item: AnyRecord) => item.role === "tool"), "Chat Completions follow-up missing tool message");
  }
  return { conversation, captured, streamEvents: streamEvents.length };
}

async function runInjectionChainSmoke() {
  await configure(false);
  const settings = await api("/api/settings");
  const assistantId = settings.assistantId;
  const mode = await api("/api/settings/mode-injection/detail", {
    method: "POST",
    body: JSON.stringify({
      id: "smoke-mode-injection",
      name: "Smoke Mode",
      enabled: true,
      priority: 20,
      position: "after_system_prompt",
      content: "MODE_INJECTION_SMOKE",
      role: "USER",
    }),
  });
  const lorebook = await api("/api/settings/lorebook/detail", {
    method: "POST",
    body: JSON.stringify({
      id: "smoke-lorebook",
      name: "Smoke Lorebook",
      enabled: true,
      entries: [{
        id: "smoke-lore-entry",
        enabled: true,
        priority: 10,
        keywords: ["lore-trigger"],
        content: "LOREBOOK_SMOKE",
        position: "top_of_chat",
        role: "USER",
        scanDepth: 4,
      }],
    }),
  });
  await api("/api/settings/assistant/injections", {
    method: "POST",
    body: JSON.stringify({
      assistantId,
      modeInjectionIds: [mode.item.id],
      lorebookIds: [lorebook.item.id],
      quickMessageIds: [],
    }),
  });
  await configureAssistantPatch({
    systemPrompt: "Base system prompt.",
    streamOutput: true,
    enabledSkills: [],
    localTools: [],
    mcpServers: [],
    allowConversationSystemPrompt: false,
  });
  const beforeCount = requests.length;
  const conversationId = `smoke-injection-${Date.now()}`;
  await api(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "lore-trigger 请普通回答。"}] }),
  });
  await waitForConversation(conversationId, (item) => !item.isGenerating, "injection conversation");
  const first = requests.slice(beforeCount).find((item) => item.path === "/v1/chat/completions" && item.body?.stream === true)?.body;
  assert(first, "injection chat request missing");
  const requestText = promptTextFromChatBody(first);
  assert(requestText.includes("MODE_INJECTION_SMOKE"), "mode injection did not enter request body");
  assert(requestText.includes("LOREBOOK_SMOKE"), "lorebook injection did not enter request body");
  return { mode: mode.item.id, lorebook: lorebook.item.id };
}

async function runSkillChainSmoke() {
  await configure(false);
  const skillContent = `---\nname: smoke-skill\ndescription: Use when smoke skill is requested\n---\n\nSMOKE_SKILL_BODY`;
  await api("/api/skills/detail", {
    method: "POST",
    body: JSON.stringify({ name: "smoke-skill", content: skillContent }),
  });
  const settings = await api("/api/settings");
  await api("/api/settings/assistant/skills", {
    method: "POST",
    body: JSON.stringify({ assistantId: settings.assistantId, enabledSkills: ["smoke-skill"] }),
  });
  await configureAssistantPatch({
    systemPrompt: "Base system prompt.",
    streamOutput: true,
    localTools: [],
    mcpServers: [],
  });
  const beforeCount = requests.length;
  const conversationId = `smoke-skill-${Date.now()}`;
  await api(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "请看看 smoke skill 是否可用。"}] }),
  });
  await waitForConversation(conversationId, (item) => !item.isGenerating, "skill context conversation");
  const first = requests.slice(beforeCount).find((item) => item.path === "/v1/chat/completions" && item.body?.stream === true)?.body;
  assert(first, "skill chat request missing");
  const requestText = promptTextFromChatBody(first);
  assert(requestText.includes("<name>smoke-skill</name>"), "enabled skill did not enter system context");
  assert(first.tools?.some((tool: AnyRecord) => tool.function?.name === "use_skill"), "use_skill tool was not exposed when skill is enabled");
  await expectApiError(
    "/api/settings/assistant/skills",
    { method: "POST", body: JSON.stringify({ assistantId: settings.assistantId, enabledSkills: ["missing-skill"] }) },
    "unknown skill",
  );
  await api("/api/skills/smoke-skill", { method: "DELETE", body: "{}" });
  return "smoke-skill";
}

async function runTemplateTimeAndSettingsSmoke() {
  const { modelId } = await configure(false);
  const oldUserAt = new Date(Date.now() - 7_200_000).toISOString();
  const oldAssistantAt = new Date(Date.now() - 5_400_000).toISOString();
  await configureAssistantPatch({
    systemPrompt: "Base system prompt.",
    messageTemplate: "WRAPPED({{ role }}): {{ message }}",
    enableTimeReminder: true,
    streamOutput: true,
    localTools: [],
    enabledSkills: [],
    mcpServers: [],
    presetMessages: [
      {
        role: "USER",
        createdAt: oldUserAt,
        content: "很早以前的用户消息。",
      },
      {
        role: "ASSISTANT",
        createdAt: oldAssistantAt,
        content: "很早以前的助手回复。",
      },
    ],
  });
  const beforeCount = requests.length;
  const conversationId = `smoke-template-time-${Date.now()}`;
  await api(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "模板和时间提醒 smoke。"}] }),
  });
  await waitForConversation(conversationId, (item) => !item.isGenerating, "template time conversation");
  const first = requests.slice(beforeCount).find((item) => item.path === "/v1/chat/completions" && item.body?.stream === true)?.body;
  assert(first, "template/time chat request missing");
  const requestText = promptTextFromChatBody(first);
  assert(requestText.includes("WRAPPED(user): 模板和时间提醒 smoke。"), "message template did not wrap user content");
  assert(requestText.includes("<time_reminder>Current time:"), "time reminder was not injected for first user message");
  assert(requestText.includes("since last message"), "time reminder did not inject the one-hour gap branch for later user messages");
  const reminderCount = (requestText.match(/<time_reminder>/g) ?? []).length;
  assert(reminderCount === 2, `time reminder should inject exactly first-user and one-hour-gap reminders, got ${reminderCount}`);

  await api("/api/settings/favorite-models", {
    method: "POST",
    body: JSON.stringify({ modelIds: [modelId] }),
  });
  await api("/api/settings/model/built-in-tool", {
    method: "POST",
    body: JSON.stringify({ modelId, tool: "search", enabled: true }),
  });
  let modelInfo = await findSettingsModel(modelId);
  assert(modelInfo.settings.favoriteModels.includes(modelId), "favorite model setting did not persist");
  assert((modelInfo.model.tools ?? []).some((tool: AnyRecord | string) => typeof tool === "string" ? tool === "search" : tool?.type === "search"), "built-in search tool did not persist");
  await api("/api/settings/model/built-in-tool", {
    method: "POST",
    body: JSON.stringify({ modelId, tool: "search", enabled: false }),
  });
  modelInfo = await findSettingsModel(modelId);
  assert(!(modelInfo.model.tools ?? []).some((tool: AnyRecord | string) => typeof tool === "string" ? tool === "search" : tool?.type === "search"), "built-in search tool did not disable");

  await api("/api/settings/display", {
    method: "POST",
    body: JSON.stringify({ userNickname: "Smoke User", showTokenUsage: true }),
  });
  const afterDisplay = await api("/api/settings");
  assert(afterDisplay.displaySetting.userNickname === "Smoke User", "display setting did not persist");
  assert(afterDisplay.displaySetting.showTokenUsage === true, "display token setting did not persist");
  return { modelId, template: true, timeReminder: true };
}

async function runQuickMessageBindingSmoke() {
  await configure(false);
  const settings = await api("/api/settings");
  const assistantId = settings.assistantId;
  const quick = await api("/api/settings/quick-message/detail", {
    method: "POST",
    body: JSON.stringify({ id: "smoke-quick-message", title: "Smoke Quick", content: "快速消息 smoke 内容" }),
  });
  await api("/api/settings/assistant/injections", {
    method: "POST",
    body: JSON.stringify({
      assistantId,
      modeInjectionIds: [],
      lorebookIds: [],
      quickMessageIds: [quick.item.id],
    }),
  });
  let after = await api("/api/settings");
  let assistant = after.assistants.find((item: AnyRecord) => item.id === assistantId);
  assert(after.quickMessages.some((item: AnyRecord) => item.id === quick.item.id), "quick message was not saved");
  assert(assistant.quickMessageIds.includes(quick.item.id), "quick message binding did not persist");
  await api(`/api/settings/quick-message/${encodeURIComponent(quick.item.id)}`, { method: "DELETE", body: "{}" });
  after = await api("/api/settings");
  assistant = after.assistants.find((item: AnyRecord) => item.id === assistantId);
  assert(!after.quickMessages.some((item: AnyRecord) => item.id === quick.item.id), "quick message was not deleted");
  assert(!assistant.quickMessageIds.includes(quick.item.id), "deleted quick message binding was not cleaned from assistant");
  return quick.item.id;
}

async function runMcpChainSmoke() {
  await configure(false);
  const settings = await api("/api/settings");
  const assistantId = settings.assistantId;
  const server = await api("/api/settings/mcp-server/detail", {
    method: "POST",
    body: JSON.stringify({
      id: "smoke-mcp-server",
      type: "streamable_http",
      url: mcpBaseUrl,
      commonOptions: {
        enable: true,
        name: "Smoke MCP",
        headers: [],
        tools: [],
      },
    }),
  });
  const tools = server.server?.commonOptions?.tools ?? [];
  assert(tools.some((tool: AnyRecord) => tool.name === "smoke_lookup"), "MCP tools/list did not sync smoke_lookup");
  await api("/api/settings/assistant/mcp", {
    method: "POST",
    body: JSON.stringify({ assistantId, mcpServers: ["smoke-mcp-server"] }),
  });
  await configureAssistantPatch({
    systemPrompt: "Base system prompt.",
    streamOutput: true,
    localTools: [],
    enabledSkills: [],
    mcpServers: ["smoke-mcp-server"],
  });
  const beforeCount = requests.length;
  const conversationId = `smoke-mcp-${Date.now()}`;
  await api(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "请调用 smoke MCP。"}] }),
  });
  const conversation = await waitForConversation(
    conversationId,
    (item) => !item.isGenerating && assistantMessages(item).some((msg: AnyRecord) => textFromParts(msg.parts ?? []).includes("MCP 工具结果已收到")),
    "mcp tool conversation",
  );
  const assistant = assistantMessages(conversation)[0];
  assert(assistant.parts.some((part: AnyRecord) => part.type === "tool" && part.toolName === "mcp__smoke_lookup" && JSON.stringify(part.output ?? []).includes("MCP_RESULT:rikkahub")), "MCP tool output was not persisted in assistant message");
  const first = requests.slice(beforeCount).find((item) => item.path === "/v1/chat/completions" && item.body?.stream === true)?.body;
  assert(first?.tools?.some((tool: AnyRecord) => tool.function?.name === "mcp__smoke_lookup"), "MCP tool was not exposed to provider request");
  assert(mcpRequests.some((item) => item.method === "initialize"), "MCP initialize was not called");
  assert(mcpRequests.some((item) => item.method === "tools/list"), "MCP tools/list was not called");
  assert(mcpRequests.some((item) => item.method === "tools/call"), "MCP tools/call was not called");
  return { tool: "smoke_lookup", calls: mcpRequests.length };
}

async function runMcpImageToolSmoke() {
  // Verify Android 2.1.11 fix: MCP tool returning image content block is forwarded to the provider
  // as an image in the tool_result, and the image part is persisted on the assistant message.
  await configure(false);
  const settings = await api("/api/settings");
  const assistantId = settings.assistantId;
  const server = await api("/api/settings/mcp-server/detail", {
    method: "POST",
    body: JSON.stringify({
      id: "smoke-mcp-server",
      type: "streamable_http",
      url: mcpBaseUrl,
      commonOptions: { enable: true, name: "Smoke MCP", headers: [], tools: [] },
    }),
  });
  const tools = server.server?.commonOptions?.tools ?? [];
  assert(tools.some((tool: AnyRecord) => tool.name === "smoke_image_tool"), "MCP tools/list did not sync smoke_image_tool");
  await configureAssistantPatch({
    systemPrompt: "Base system prompt.",
    streamOutput: true,
    localTools: [],
    enabledSkills: [],
    mcpServers: ["smoke-mcp-server"],
  });
  const beforeCount = requests.length;
  const mcpBefore = mcpRequests.length;
  const conversationId = `smoke-mcp-img-${Date.now()}`;
  await api(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "请调用 smoke_image_tool。" }] }),
  });
  const conversation = await waitForConversation(
    conversationId,
    (item) => !item.isGenerating && assistantMessages(item).some((msg: AnyRecord) => textFromParts(msg.parts ?? []).includes("MCP 图片工具结果已收到")),
    "mcp image tool conversation",
  );
  const assistant = assistantMessages(conversation)[0];
  // Tool part must be persisted with an image in its output
  const toolPart = assistant.parts.find((part: AnyRecord) => part.type === "tool" && part.toolName === "mcp__smoke_image_tool");
  assert(toolPart, "MCP image tool part was not persisted on assistant message");
  const outputParts = Array.isArray(toolPart.output) ? toolPart.output : [];
  assert(outputParts.some((p: AnyRecord) => p.type === "image"), "MCP image tool output did not contain an image part");
  // The follow-up chat request must include the textual prelude from the tool output.
  // (For OpenAI Chat Completions, tool messages canonically carry a string — the image part
  // is preserved on the assistant UIMessage and is forwarded as a real image block on the
  // Claude path; that conversion is exercised by the live Claude-MCP integration test.)
  const captured = requests.slice(beforeCount);
  const toolResultRound = captured.filter((item) => item.path === "/v1/chat/completions" && item.body?.stream === true)
    .find((item) => item.body?.messages?.some((m: AnyRecord) => m.role === "tool"));
  assert(toolResultRound, "No tool_result follow-up request found");
  const toolMsg = toolResultRound.body.messages.find((m: AnyRecord) => m.role === "tool");
  const toolContentText = typeof toolMsg?.content === "string"
    ? toolMsg.content
    : Array.isArray(toolMsg?.content)
      ? toolMsg.content.map((c: AnyRecord) => typeof c === "string" ? c : String(c?.text ?? "")).join("")
      : String(toolMsg?.content ?? "");
  assert(toolContentText.includes("MCP_IMAGE_RESULT"), "Tool result follow-up did not carry tool textual output");
  assert(mcpRequests.slice(mcpBefore).some((item) => item.method === "tools/call" && item.body?.params?.name === "smoke_image_tool"), "MCP tools/call for smoke_image_tool was not called");
  return { imagePersisted: true, mcpCalled: true };
}

async function runSearchToolChainSmoke() {
  await configure(false);
  const customSearch = {
    id: "smoke-custom-js-search",
    type: "custom_js",
    name: "Smoke Custom Search",
    resultSize: 2,
    searchScript: `
async function search(query, maxResults) {
  return {
    answer: "SMOKE_SEARCH_ANSWER",
    items: [
      { title: "RikkaHub PC Smoke", url: "https://search.example.com/rikkahub", text: "Smoke search snippet for " + query },
      { title: "RikkaHub Docs", url: "https://docs.example.com/rikkahub", text: "Documentation snippet" }
    ].slice(0, maxResults)
  };
}`,
    scrapeScript: `
async function scrape(urls) {
  return {
    urls: urls.map((url) => ({
      url,
      content: "SCRAPE_RESULT for " + url,
      metadata: { title: "Smoke Scraped Page", description: "Smoke scrape description", language: "en" }
    }))
  };
}`,
  };
  await api("/api/settings/search/service/detail", {
    method: "POST",
    body: JSON.stringify(customSearch),
  });
  await api("/api/settings/search/enabled", {
    method: "POST",
    body: JSON.stringify({ enabled: true }),
  });
  const settings = await api("/api/settings");
  const selectedIndex = settings.searchServices.findIndex((item: AnyRecord) => item.id === customSearch.id);
  assert(selectedIndex >= 0, "custom search service was not saved");
  await api("/api/settings/search/service", {
    method: "POST",
    body: JSON.stringify({ index: selectedIndex }),
  });
  await configureAssistantPatch({
    systemPrompt: "Base system prompt.",
    streamOutput: true,
    localTools: [],
    enabledSkills: [],
    mcpServers: [],
    enableMemory: false,
  });

  const beforeCount = requests.length;
  const conversationId = `smoke-search-tool-${Date.now()}`;
  await api(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "请调用搜索工具查 RikkaHub PC smoke。"}] }),
  });
  const conversation = await waitForConversation(
    conversationId,
    (item) => !item.isGenerating && assistantMessages(item).some((msg: AnyRecord) => textFromParts(msg.parts ?? []).includes("搜索工具结果已收到")),
    "search tool conversation",
  );
  const assistant = assistantMessages(conversation)[0];
  assert(assistant.parts.some((part: AnyRecord) => part.type === "tool" && part.toolName === "search_web" && JSON.stringify(part.output ?? []).includes("search.example.com")), "search_web output was not persisted");
  assert(assistant.parts.some((part: AnyRecord) => part.type === "tool" && part.toolName === "scrape_web" && JSON.stringify(part.output ?? []).includes("SCRAPE_RESULT")), "scrape_web output was not persisted");
  const first = requests.slice(beforeCount).find((item) => item.path === "/v1/chat/completions" && item.body?.stream === true)?.body;
  assert(first?.tools?.some((tool: AnyRecord) => tool.function?.name === "search_web"), "search_web was not exposed to provider request");
  assert(first?.tools?.some((tool: AnyRecord) => tool.function?.name === "scrape_web"), "scrape_web was not exposed to provider request");
  const requestText = promptTextFromChatBody(first);
  assert(requestText.includes("Available tools: search_web, scrape_web"), "search context was not injected into provider request");
  const stats = await api("/api/stats");
  assert((stats.requestGroups ?? []).some((item: AnyRecord) => item.name === "搜索引擎请求" && Number(item.ok ?? 0) + Number(item.failed ?? 0) >= 2), "stats did not count search/scrape requests");
  return { service: customSearch.id, toolParts: assistant.parts.filter((part: AnyRecord) => part.type === "tool").length };
}

async function runLocalToolsMemorySmoke() {
  await configure(false);
  await configureAssistantPatch({
    systemPrompt: "Base system prompt.",
    streamOutput: true,
    localTools: [{ type: "javascript_engine" }],
    enabledSkills: [],
    mcpServers: [],
    enableMemory: true,
    useGlobalMemory: false,
  });
  const beforeCount = requests.length;
  const conversationId = `smoke-local-tools-${Date.now()}`;
  await api(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "请调用记忆和 JS 工具。"}] }),
  });
  const conversation = await waitForConversation(
    conversationId,
    (item) => !item.isGenerating && assistantMessages(item).some((msg: AnyRecord) => textFromParts(msg.parts ?? []).includes("记忆和 JS 工具结果已收到")),
    "local tools conversation",
  );
  const assistantMessage = assistantMessages(conversation)[0];
  assert(assistantMessage.parts.some((part: AnyRecord) => part.type === "tool" && part.toolName === "memory_tool" && JSON.stringify(part.output ?? []).includes("User likes smoke memory")), "memory_tool output was not persisted");
  assert(assistantMessage.parts.some((part: AnyRecord) => part.type === "tool" && part.toolName === "eval_javascript" && JSON.stringify(part.output ?? []).includes("42")), "eval_javascript output was not persisted");
  const first = requests.slice(beforeCount).find((item) => item.path === "/v1/chat/completions" && item.body?.stream === true)?.body;
  assert(first?.tools?.some((tool: AnyRecord) => tool.function?.name === "memory_tool"), "memory_tool was not exposed to provider request");
  assert(first?.tools?.some((tool: AnyRecord) => tool.function?.name === "eval_javascript"), "eval_javascript was not exposed to provider request");

  const followBefore = requests.length;
  const followConversationId = `smoke-memory-context-${Date.now()}`;
  await api(`/api/conversations/${followConversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "检查已有记忆是否注入。"}] }),
  });
  await waitForConversation(followConversationId, (item) => !item.isGenerating, "memory context conversation");
  const followFirst = requests.slice(followBefore).find((item) => item.path === "/v1/chat/completions" && item.body?.stream === true)?.body;
  assert(promptTextFromChatBody(followFirst).includes("User likes smoke memory"), "stored memory did not enter later provider request");
  const stateAfter = await api("/api/settings/memories");
  assert((stateAfter.memories ?? []).some((item: AnyRecord) => item.content === "User likes smoke memory."), "memory record was not persisted in settings memory API");
  return { memoryCount: stateAfter.memories.length };
}

async function runInvalidToolArgumentsSmoke() {
  await configure(false);
  await configureAssistantPatch({
    systemPrompt: "Base system prompt.",
    streamOutput: true,
    localTools: [{ type: "time_info" }],
    enabledSkills: [],
    mcpServers: [],
    enableMemory: false,
  });
  const conversationId = `smoke-invalid-tool-args-${Date.now()}`;
  await api(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "请触发坏工具参数。"}] }),
  });
  const conversation = await waitForConversation(
    conversationId,
    (item) => !item.isGenerating && assistantMessages(item).some((msg: AnyRecord) => textFromParts(msg.parts ?? []).includes("工具参数错误已收到")),
    "invalid tool arguments conversation",
  );
  const assistant = assistantMessages(conversation)[0];
  assert(assistant.parts.some((part: AnyRecord) =>
    part.type === "tool" &&
    part.toolName === "get_time_info" &&
    JSON.stringify(part.output ?? []).includes("Invalid tool arguments JSON")
  ), "invalid tool arguments error was not persisted as tool output");
  return { retainedError: true };
}

async function runProviderTestSmoke() {
  await configure(false);
  const streamedEvents: AnyRecord[] = [];
  const response = await fetch(`${baseUrl}/api/settings/provider/test/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: "smoke-chat-provider", modelId: "mock-chat-tool" }),
  });
  if (!response.ok) {
    throw new Error(`provider test stream failed: ${response.status} ${await response.text()}`);
  }
  const reader = response.body?.getReader();
  assert(reader, "provider test stream response body missing");
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\n\n+/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const event = block.split(/\r?\n/).find((line) => line.startsWith("event:"))?.replace(/^event:\s*/, "").trim() ?? "message";
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.replace(/^data:\s?/, ""))
        .join("\n");
      if (data) streamedEvents.push({ event, data: JSON.parse(data) });
    }
  }
  const checks = streamedEvents.filter((item) => item.event === "check").map((item) => item.data);
  assert(checks.some((item) => item.mode === "non_stream" && item.ok), "provider non-stream test did not pass");
  assert(checks.some((item) => item.mode === "stream" && item.ok), "provider stream test did not pass");
  assert(checks.some((item) => item.mode === "tools" && item.ok), "provider tools test did not pass");
  return checks;
}

async function runModelRegistryParitySmoke() {
  const { providerId } = await configure(false);
  const fetched = await api("/api/settings/provider/models", {
    method: "POST",
    body: JSON.stringify({ providerId }),
  });
  const mimo = fetched.models?.find((item: AnyRecord) => item.modelId === "mimo-v2.5-pro");
  assert(mimo, "mock MiMo v2.5 model missing from fetched model list");
  assert(mimo.inputModalities?.includes("IMAGE"), "MiMo v2.5 model should infer IMAGE input like Android ModelRegistry");
  assert(mimo.abilities?.includes("REASONING"), "MiMo v2.5 model should infer reasoning ability");
  return { mimoInputModalities: mimo.inputModalities, mimoAbilities: mimo.abilities };
}

function assistantMessages(conversation: AnyRecord) {
  return selectedMessages(conversation).filter((msg: AnyRecord) => msg.role === "ASSISTANT");
}

function assertPlainAuxiliaryChatRequest(body: AnyRecord, label: string) {
  assert(Array.isArray(body.messages), `${label} auxiliary request should use messages array`);
  assert(body.messages.length === 1, `${label} auxiliary request should only include the dedicated prompt message`);
  assert(body.messages[0]?.role === "user", `${label} auxiliary request should be a user prompt`);
  assert(!body.messages.some((item: AnyRecord) => item.role === "tool"), `${label} auxiliary request leaked tool messages`);
  assert(!body.messages.some((item: AnyRecord) => item.tool_calls), `${label} auxiliary request leaked assistant tool calls`);
  assert(!body.tools, `${label} auxiliary request should not expose tools`);
}

async function runStopKeepsPartialSmoke() {
  await configure(false);
  const conversationId = `smoke-stop-${Date.now()}`;
  await api(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "请慢慢回答，我会中途停止。"}] }),
  });
  await waitForConversation(
    conversationId,
    (item) => assistantMessages(item).some((msg: AnyRecord) => textFromParts(msg.parts ?? []).includes("第一段")),
    "partial text before stop",
    10_000,
  );
  await api(`/api/conversations/${conversationId}/stop`, { method: "POST", body: "{}" });
  const stopped = await waitForConversation(
    conversationId,
    (item) => !item.isGenerating && assistantMessages(item).some((msg: AnyRecord) => textFromParts(msg.parts ?? []).includes("第一段")),
    "stopped conversation",
    10_000,
  );
  const msg = assistantMessages(stopped)[0];
  assert(msg.finishedAt, "stopped assistant message should be marked finished");
  assert(textFromParts(msg.parts).includes("第一段"), "stopped assistant message lost partial content");
  return stopped;
}

async function runDeleteWhileGeneratingSmoke() {
  await configure(false);
  const conversationId = `smoke-delete-${Date.now()}`;
  const beforeList = await api("/api/conversations");
  await api(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "请慢慢回答，随后我会删除会话。"}] }),
  });
  await waitForConversation(
    conversationId,
    (item) => assistantMessages(item).some((msg: AnyRecord) => textFromParts(msg.parts ?? []).includes("第一段")),
    "partial text before delete",
    10_000,
  );
  await fetch(`${baseUrl}/api/conversations/${conversationId}`, { method: "DELETE" });
  await Bun.sleep(1200);
  const list = await api("/api/conversations");
  assert(!list.some((item: AnyRecord) => item.id === conversationId), "deleted generating conversation still appears in list");
  assert(list.length <= beforeList.length, "delete while generating left an extra ghost conversation");
  return list.length;
}

async function runRegenerateSmoke() {
  await configure(false);
  const conversationId = `smoke-regenerate-${Date.now()}`;
  await api(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "请调用本地时间工具，然后回答。"}] }),
  });
  const first = await waitForConversation(
    conversationId,
    (item) => !item.isGenerating && assistantMessages(item).some((msg: AnyRecord) => textFromParts(msg.parts ?? []).includes("继续回复")),
    "first answer before regenerate",
  );
  const firstAssistantCount = assistantMessages(first).length;
  const assistantMessageId = assistantMessages(first)[0].id;
  await api(`/api/conversations/${conversationId}/regenerate`, {
    method: "POST",
    body: JSON.stringify({ messageId: assistantMessageId }),
  });
  const regenerated = await waitForConversation(
    conversationId,
    (item) => !item.isGenerating && assistantMessages(item).some((msg: AnyRecord) => textFromParts(msg.parts ?? []).includes("继续回复")),
    "regenerated answer",
  );
  assert(assistantMessages(regenerated).length === firstAssistantCount, "regenerate should replace the assistant answer instead of appending another assistant node");
  return regenerated;
}

async function runRegenerateTitleOrderingSmoke() {
  await configure(false);
  const olderId = `smoke-title-older-${Date.now()}`;
  const newerId = `smoke-title-newer-${Date.now()}`;
  await api(`/api/conversations/${olderId}/messages`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "第一条会话，请生成标题。"}] }),
  });
  await waitForConversation(olderId, (item) => !item.isGenerating, "older title conversation");
  await Bun.sleep(20);
  await api(`/api/conversations/${newerId}/messages`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "第二条会话，请生成标题。"}] }),
  });
  await waitForConversation(newerId, (item) => !item.isGenerating, "newer title conversation");
  const before = await api("/api/conversations");
  const beforeOlder = before.find((item: AnyRecord) => item.id === olderId);
  assert(beforeOlder, "older conversation missing before title regenerate");
  const beforeUpdateAt = beforeOlder.updateAt;
  await api(`/api/conversations/${olderId}/regenerate-title`, { method: "POST", body: "{}" });
  const after = await api("/api/conversations");
  const afterOlder = after.find((item: AnyRecord) => item.id === olderId);
  assert(afterOlder, "older conversation missing after title regenerate");
  assert(afterOlder.updateAt === beforeUpdateAt, "regenerate-title should not bump updateAt or move conversation ordering");
  const newerIndex = after.findIndex((item: AnyRecord) => item.id === newerId);
  const olderIndex = after.findIndex((item: AnyRecord) => item.id === olderId);
  assert(newerIndex >= 0 && olderIndex >= 0 && newerIndex < olderIndex, "regenerate-title changed conversation list ordering");
  return afterOlder.title;
}

async function runMultiAssistantConcurrencySmoke() {
  const { modelId } = await configure(false);
  const settings = await api("/api/settings");
  const baseAssistant = settings.assistants.find((item: AnyRecord) => item.id === settings.assistantId);
  assert(baseAssistant, "base assistant missing for concurrency smoke");
  const assistantA = {
    ...baseAssistant,
    id: "smoke-assistant-a",
    name: "Smoke Assistant A",
    chatModelId: modelId,
    systemPrompt: "并发隔离 A system",
    localTools: [],
    enabledSkills: [],
    mcpServers: [],
    streamOutput: true,
  };
  const assistantB = {
    ...baseAssistant,
    id: "smoke-assistant-b",
    name: "Smoke Assistant B",
    chatModelId: modelId,
    systemPrompt: "并发隔离 B system",
    localTools: [],
    enabledSkills: [],
    mcpServers: [],
    streamOutput: true,
  };
  await api("/api/settings/assistant/detail", { method: "POST", body: JSON.stringify(assistantA) });
  await api("/api/settings/assistant/detail", { method: "POST", body: JSON.stringify(assistantB) });

  const conversationA = `smoke-concurrent-a-${Date.now()}`;
  const conversationB = `smoke-concurrent-b-${Date.now()}`;
  await api("/api/settings/assistant", {
    method: "POST",
    body: JSON.stringify({ assistantId: assistantA.id }),
  });
  await api(`/api/conversations/${conversationA}/system-prompt`, {
    method: "POST",
    body: JSON.stringify({ systemPrompt: "" }),
  });
  await api("/api/settings/assistant", {
    method: "POST",
    body: JSON.stringify({ assistantId: assistantB.id }),
  });
  await api(`/api/conversations/${conversationB}/system-prompt`, {
    method: "POST",
    body: JSON.stringify({ systemPrompt: "" }),
  });
  const streamA = collectConversationEvents(
    conversationA,
    (events) => events.some((event) => event.event === "snapshot" && event.data?.conversation?.isGenerating === false),
    20_000,
  );
  const streamB = collectConversationEvents(
    conversationB,
    (events) => events.some((event) => event.event === "snapshot" && event.data?.conversation?.isGenerating === false),
    20_000,
  );
  await Bun.sleep(50);
  await Promise.all([
    api(`/api/conversations/${conversationA}/messages`, {
      method: "POST",
      body: JSON.stringify({ parts: [{ type: "text", text: "请执行并发隔离 A。"}] }),
    }),
    api(`/api/conversations/${conversationB}/messages`, {
      method: "POST",
      body: JSON.stringify({ parts: [{ type: "text", text: "请执行并发隔离 B。"}] }),
    }),
  ]);
  const [eventsA, eventsB] = await Promise.all([streamA, streamB]);
  const [resultA, resultB] = await Promise.all([
    waitForConversation(
      conversationA,
      (item) => !item.isGenerating && assistantMessages(item).some((msg: AnyRecord) => textFromParts(msg.parts ?? []).includes("A_ONLY_REPLY")),
      "concurrent assistant A conversation",
    ),
    waitForConversation(
      conversationB,
      (item) => !item.isGenerating && assistantMessages(item).some((msg: AnyRecord) => textFromParts(msg.parts ?? []).includes("B_ONLY_REPLY")),
      "concurrent assistant B conversation",
    ),
  ]);
  assert(resultA.assistantId === assistantA.id, "conversation A assistantId changed during concurrent generation");
  assert(resultB.assistantId === assistantB.id, "conversation B assistantId changed during concurrent generation");
  assert(!selectedMessages(resultA).some((msg: AnyRecord) => textFromParts(msg.parts ?? []).includes("B_ONLY_REPLY")), "conversation A received conversation B content");
  assert(!selectedMessages(resultB).some((msg: AnyRecord) => textFromParts(msg.parts ?? []).includes("A_ONLY_REPLY")), "conversation B received conversation A content");
  assert(eventsA.every((event) => event.data?.conversation?.id === conversationA || event.event === "node_update"), "conversation A stream received foreign snapshots");
  assert(eventsB.every((event) => event.data?.conversation?.id === conversationB || event.event === "node_update"), "conversation B stream received foreign snapshots");
  return { assistantA: resultA.assistantId, assistantB: resultB.assistantId, eventsA: eventsA.length, eventsB: eventsB.length };
}

async function runTranslationSmoke() {
  await configure(false);
  const beforeCount = requests.length;
  const conversationId = `smoke-translate-${Date.now()}`;
  await api(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "请调用本地时间工具，然后回答。"}] }),
  });
  const answered = await waitForConversation(
    conversationId,
    (item) => !item.isGenerating && assistantMessages(item).some((msg: AnyRecord) => textFromParts(msg.parts ?? []).includes("继续回复")),
    "answer before translation",
  );
  const assistantMessage = assistantMessages(answered)[0];
  const translationEventsPromise = collectConversationEvents(
    conversationId,
    (events) => events.some((event) =>
      event.event === "snapshot" &&
      selectedMessages(event.data?.conversation ?? {}).some((msg: AnyRecord) => String(msg.translation ?? "").includes("Translated smoke text."))
    ),
    15_000,
  );
  await Bun.sleep(50);
  const accepted = await api(`/api/conversations/${conversationId}/messages/${assistantMessage.id}/translate`, {
    method: "POST",
    body: JSON.stringify({ targetLanguage: "en-US" }),
  });
  assert(accepted.status === "accepted", "translation route should accept async work");
  const translationEvents = await translationEventsPromise;
  const translated = await waitForConversation(
    conversationId,
    (item) => assistantMessages(item).some((msg: AnyRecord) => String(msg.translation ?? "").includes("Translated smoke text.")),
    "translated message",
  );
  assert(translationEvents.some((event) =>
    event.event === "snapshot" &&
    selectedMessages(event.data?.conversation ?? {}).some((msg: AnyRecord) => String(msg.translation ?? "").includes("正在翻译"))
  ), "translation did not broadcast pending state");
  assert(translationEvents.some((event) =>
    event.event === "snapshot" &&
    selectedMessages(event.data?.conversation ?? {}).some((msg: AnyRecord) => String(msg.translation ?? "").includes("Translated smoke text."))
  ), "translation did not broadcast final streamed text");
  const translationRequest = requests
    .slice(beforeCount)
    .reverse()
    .find((item) => item.path === "/v1/chat/completions" && promptTextFromChatBody(item.body).includes("Please translate"));
  assert(translationRequest, "translation auxiliary provider request missing");
  assertPlainAuxiliaryChatRequest(translationRequest.body, "translation");
  return assistantMessages(translated)[0].translation;
}

async function runCompressionSmoke() {
  await configure(false);
  const beforeCount = requests.length;
  const conversationId = `smoke-compress-${Date.now()}`;
  await api(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "请调用本地时间工具，然后回答。"}] }),
  });
  await waitForConversation(
    conversationId,
    (item) => !item.isGenerating && assistantMessages(item).some((msg: AnyRecord) => textFromParts(msg.parts ?? []).includes("继续回复")),
    "answer before compression",
  );
  await expectApiError(
    `/api/conversations/${conversationId}/compress`,
    { method: "POST", body: JSON.stringify({ keepRecentMessages: 32, targetTokens: 512 }) },
    "消息数量不足",
  );
  const compressionEventsPromise = collectConversationEvents(
    conversationId,
    (events) => events.some((event) =>
      event.event === "snapshot" &&
      selectedMessages(event.data?.conversation ?? {}).some((msg: AnyRecord) => textFromParts(msg.parts ?? []).includes("Compressed conversation summary."))
    ),
    15_000,
  );
  await Bun.sleep(50);
  const result = await api(`/api/conversations/${conversationId}/compress`, {
    method: "POST",
    body: JSON.stringify({ keepRecentMessages: 0, targetTokens: 512, additionalPrompt: "保留工具调用结论" }),
  });
  assert(result.status === "compressed", "compression route should return compressed status");
  const compressionEvents = await compressionEventsPromise;
  assert(compressionEvents.some((event) =>
    event.event === "snapshot" &&
    Array.isArray(event.data?.conversation?.chatSuggestions) &&
    event.data.conversation.chatSuggestions.some((item: string) => item.includes("正在压缩对话历史"))
  ), "compression did not broadcast progress suggestion");
  const compressed = await api(`/api/conversations/${conversationId}`);
  assert(selectedMessages(compressed).some((msg: AnyRecord) => textFromParts(msg.parts ?? []).includes("Compressed conversation summary.")), "compressed summary was not written back as context");
  const compressionRequest = requests
    .slice(beforeCount)
    .reverse()
    .find((item) => item.path === "/v1/chat/completions" && promptTextFromChatBody(item.body).includes("conversation compression assistant"));
  assert(compressionRequest, "compression auxiliary provider request missing");
  assertPlainAuxiliaryChatRequest(compressionRequest.body, "compression");
  return result.summaries;
}

async function runDeletedConversationSearchSmoke() {
  await configure(false);
  const conversationId = `smoke-search-delete-${Date.now()}`;
  const unique = `unique-search-${Date.now()}`;
  await api(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: unique }] }),
  });
  await waitForConversation(conversationId, (item) => !item.isGenerating, "search-delete conversation");
  const before = await api(`/api/conversations/search?query=${encodeURIComponent(unique)}`);
  assert(before.some((item: AnyRecord) => item.conversationId === conversationId), "search should find existing conversation");
  await fetch(`${baseUrl}/api/conversations/${conversationId}`, { method: "DELETE" });
  const after = await api(`/api/conversations/search?query=${encodeURIComponent(unique)}`);
  assert(!after.some((item: AnyRecord) => item.conversationId === conversationId), "search returned deleted conversation");
  return { before: before.length, after: after.length };
}

async function runBackupRoundtripSmoke() {
  const exported = await api("/api/data/export");
  assert(exported.app === "RikkaHub PC", "backup app marker missing");
  assert(exported.state?.settings, "backup state settings missing");
  assert(Array.isArray(exported.skills), "backup skills missing");
  assert(Array.isArray(exported.files), "backup files missing");
  const fileListSkill = {
    name: "smoke-import-file-list-skill",
    description: "file list import compatibility",
    files: [
      {
        path: "SKILL.md",
        content: "---\nname: smoke-import-file-list-skill\ndescription: file list import compatibility\n---\n\n# File List Skill\n",
      },
      {
        path: "references/example.txt",
        content: "nested reference file",
      },
    ],
  };
  exported.skills = [...exported.skills, fileListSkill];
  const imported = await api("/api/data/import", {
    method: "POST",
    body: JSON.stringify(exported),
  });
  assert(imported.status === "imported", "backup import did not report imported");
  const importedSkills = await api("/api/skills");
  assert(importedSkills.some((skill: AnyRecord) => skill.name === fileListSkill.name), "backup import did not restore file-list skill");
  const importedSkillFiles = await api(`/api/skills/${encodeURIComponent(fileListSkill.name)}/files`);
  assert(importedSkillFiles.files?.some((file: AnyRecord) => file.path === "references/example.txt"), "backup import did not restore nested skill files");
  return { conversations: exported.state.conversations?.length ?? 0, files: exported.files.length, importedSkill: fileListSkill.name };
}

async function runWebDavBackupSmoke() {
  const config = {
    url: webDavBaseUrl,
    username: "smoke",
    password: "secret",
    path: "rikkahub_backups",
    items: ["DATABASE", "FILES"],
  };
  const saved = await api("/api/data/webdav/config", {
    method: "POST",
    body: JSON.stringify(config),
  });
  assert(saved.config?.url === config.url, "WebDAV config did not persist url");
  const test = await api("/api/data/webdav/test", {
    method: "POST",
    body: JSON.stringify({ config }),
  });
  assert(test.status === "ok", "WebDAV test did not pass against mock server");
  const backup = await api("/api/data/webdav/backup", { method: "POST", body: "{}" });
  assert(backup.status === "ok" && /^backup_.*\.json$/.test(backup.fileName), "WebDAV backup did not create a backup file");
  assert(webDavFiles.has(backup.fileName), "mock WebDAV server did not receive backup payload");
  const payload = JSON.parse(webDavFiles.get(backup.fileName) ?? "{}");
  assert(payload.app === "RikkaHub PC" && payload.state?.settings, "WebDAV backup payload shape is invalid");
  const listed = await api("/api/data/webdav/list");
  assert(listed.items?.some((item: AnyRecord) => item.displayName === backup.fileName), "WebDAV list did not include backup file");
  const beforeSettings = await api("/api/settings");
  await api("/api/settings/display", {
    method: "POST",
    body: JSON.stringify({ userNickname: "Changed Before Restore" }),
  });
  const changed = await api("/api/settings");
  assert(changed.displaySetting.userNickname === "Changed Before Restore", "display setting did not change before restore");
  const restored = await api("/api/data/webdav/restore", {
    method: "POST",
    body: JSON.stringify({ fileName: backup.fileName }),
  });
  assert(restored.status === "restored", "WebDAV restore did not report restored");
  const afterRestore = await api("/api/settings");
  assert(afterRestore.displaySetting.userNickname === beforeSettings.displaySetting.userNickname, "WebDAV restore did not apply backed-up state");
  const deleted = await api("/api/data/webdav/delete", {
    method: "POST",
    body: JSON.stringify({ fileName: backup.fileName }),
  });
  assert(deleted.status === "deleted", "WebDAV delete did not report deleted");
  assert(!webDavFiles.has(backup.fileName), "mock WebDAV file was not deleted");
  assert(webDavRequests.some((item) => item.method === "PUT"), "WebDAV PUT was not called");
  assert(webDavRequests.some((item) => item.method === "GET"), "WebDAV GET was not called");
  assert(webDavRequests.some((item) => item.method === "DELETE"), "WebDAV DELETE was not called");
  return { fileName: backup.fileName, requests: webDavRequests.length };
}

async function runImageGenerationSmoke() {
  const beforeCount = requests.length;
  const { modelId } = await configureImageProvider("openai");
  const generated = await api("/api/images/generate", {
    method: "POST",
    body: JSON.stringify({ prompt: "smoke generated image", numberOfImages: 1, aspectRatio: "landscape" }),
  });
  assert(generated.status === "ok" && generated.images?.length === 1, "image generation did not return one generated image");
  assert(generated.images[0].type === "image_generation", "generated image type should be image_generation");
  assert(generated.images[0].modelId === modelId, "generated image did not preserve model id");
  const generationRequest = requests.slice(beforeCount).find((item) => item.path === "/v1/images/generations");
  assert(generationRequest, "OpenAI image generation request was not sent to provider");
  assert(generationRequest.body.model === "gpt-image-2", "image generation request used wrong model");
  assert(generationRequest.body.size === "1536x1024", "landscape image generation size was not mapped");

  const uploaded = await uploadFiles("/api/files/upload", [
    new File([Buffer.from(tinyPngBase64, "base64")], "reference.png", { type: "image/png" }),
  ]);
  const referenceId = uploaded.files?.[0]?.id;
  assert(Number.isFinite(referenceId), "reference image upload failed");
  const edited = await api("/api/images/generate", {
    method: "POST",
    body: JSON.stringify({ prompt: "smoke edited image", numberOfImages: 1, aspectRatio: "portrait", referenceFileIds: [referenceId] }),
  });
  assert(edited.status === "ok" && edited.images?.length === 1, "image edit did not return one edited image");
  assert(edited.images[0].type === "image_edit", "edited image type should be image_edit");
  assert(edited.images[0].sourceFileIds?.[0] === referenceId, "image edit did not preserve reference file id");
  const editRequest = requests.slice(beforeCount).find((item) => item.path === "/v1/images/edits");
  assert(editRequest, "OpenAI image edit request was not sent to provider");
  assert(editRequest.body.model === "gpt-image-2", "image edit request used wrong model");
  assert(editRequest.body.size === "1024x1536", "portrait image edit size was not mapped");
  assert(Array.isArray(editRequest.body.image) && editRequest.body.image[0]?.name === "reference.png", "image edit did not upload reference file");

  await configureImageProvider("google");
  await expectApiError(
    "/api/images/generate",
    { method: "POST", body: JSON.stringify({ prompt: "blocked edit", referenceFileIds: [referenceId] }) },
    "Gemini image edit is not supported",
  );
  const stateAfter = JSON.parse(readFileSync(join(tempDir, "state.json"), "utf8"));
  assert(stateAfter.generatedImages.some((item: AnyRecord) => item.type === "image_generation" && item.prompt === "smoke generated image"), "generated image was not persisted");
  assert(stateAfter.generatedImages.some((item: AnyRecord) => item.type === "image_edit" && item.sourceFileIds?.[0] === referenceId), "edited image reference was not persisted");
  assert(stateAfter.logs.some((log: AnyRecord) => log.kind === "provider:image:generation" && log.requestBody?.includes("smoke generated image")), "image generation log missing full request body");
  assert(stateAfter.logs.some((log: AnyRecord) => log.kind === "provider:image:edit" && log.requestBody?.includes("reference.png")), "image edit log missing multipart reference preview");
  return { generated: generated.images.length, edited: edited.images.length, referenceId };
}

function minimalEpubBytes() {
  const files = [
    {
      name: "mimetype",
      content: new TextEncoder().encode("application/epub+zip"),
      method: 0,
    },
    {
      name: "OEBPS/chapter1.xhtml",
      content: new TextEncoder().encode(`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Smoke EPUB</h1><p>EPUB extraction smoke text.</p></body></html>`),
      method: 0,
    },
  ];
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const pushU16 = (view: DataView, pos: number, value: number) => view.setUint16(pos, value, true);
  const pushU32 = (view: DataView, pos: number, value: number) => view.setUint32(pos, value, true);
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    pushU32(localView, 0, 0x04034b50);
    pushU16(localView, 8, file.method);
    pushU32(localView, 18, file.content.length);
    pushU32(localView, 22, file.content.length);
    pushU16(localView, 26, name.length);
    local.set(name, 30);
    chunks.push(local, file.content);

    const centralHeader = new Uint8Array(46 + name.length);
    const centralView = new DataView(centralHeader.buffer);
    pushU32(centralView, 0, 0x02014b50);
    pushU16(centralView, 10, file.method);
    pushU32(centralView, 20, file.content.length);
    pushU32(centralView, 24, file.content.length);
    pushU16(centralView, 28, name.length);
    pushU32(centralView, 42, offset);
    centralHeader.set(name, 46);
    central.push(centralHeader);
    offset += local.length + file.content.length;
  }
  const centralOffset = offset;
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  chunks.push(...central);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  pushU32(endView, 0, 0x06054b50);
  pushU16(endView, 8, files.length);
  pushU16(endView, 10, files.length);
  pushU32(endView, 12, centralSize);
  pushU32(endView, 16, centralOffset);
  chunks.push(end);
  const total = chunks.reduce((sum, item) => sum + item.length, 0);
  const output = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.length;
  }
  return output;
}

async function runEpubStatsLogsSmoke() {
  const upload = await uploadFile("/api/files/upload", new File([minimalEpubBytes()], "smoke.epub", { type: "application/epub+zip" }));
  const uploaded = upload.files?.[0];
  assert(uploaded?.extractedTextLength > 0, "EPUB upload did not extract text");
  const stats = await api("/api/stats");
  const groupNames = (stats.requestGroups ?? []).map((item: AnyRecord) => item.name);
  assert(groupNames.includes("模型请求"), "stats missing model request group");
  assert(stats.totals?.requests > 0, "stats missing request totals");
  const logs = await api("/api/logs");
  assert(logs.some((log: AnyRecord) => log.kind === "provider:aux:stream" && log.requestBody && log.responseBody), "logs missing full auxiliary request/response bodies");
  return { epubTextLength: uploaded.extractedTextLength, requestGroups: groupNames, logCount: logs.length };
}

async function main() {
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });
  const pc = spawnPcServer();
  let stdout = "";
  let stderr = "";
  void new Response(pc.stdout).text().then((text) => { stdout = text; });
  void new Response(pc.stderr).text().then((text) => { stderr = text; });
  try {
    await waitForHealth();
    const chat = await runConversation(false);
    const response = await runConversation(true);
    const injections = await runInjectionChainSmoke();
    const skill = await runSkillChainSmoke();
    const templateTimeAndSettings = await runTemplateTimeAndSettingsSmoke();
    const quickMessage = await runQuickMessageBindingSmoke();
    const mcp = await runMcpChainSmoke();
    const mcpImageTool = await runMcpImageToolSmoke();
    const searchTools = await runSearchToolChainSmoke();
    const localTools = await runLocalToolsMemorySmoke();
    const invalidToolArguments = await runInvalidToolArgumentsSmoke();
    const providerChecks = await runProviderTestSmoke();
    const modelRegistryParity = await runModelRegistryParitySmoke();
    await runStopKeepsPartialSmoke();
    const deleteListCount = await runDeleteWhileGeneratingSmoke();
    await runRegenerateSmoke();
    const regeneratedTitle = await runRegenerateTitleOrderingSmoke();
    const multiAssistantConcurrency = await runMultiAssistantConcurrencySmoke();
    const translation = await runTranslationSmoke();
    const compressionSummaries = await runCompressionSmoke();
    const searchDelete = await runDeletedConversationSearchSmoke();
    const backupRoundtrip = await runBackupRoundtripSmoke();
    const webDavBackup = await runWebDavBackupSmoke();
    const imageGeneration = await runImageGenerationSmoke();
    const epubStatsLogs = await runEpubStatsLogsSmoke();
    const state = JSON.parse(readFileSync(join(tempDir, "state.json"), "utf8"));
    assert(state.logs.some((log: AnyRecord) => log.kind === "provider:chat:stream" && log.requestPreview), "request log for stream round missing");
    assert(state.logs.some((log: AnyRecord) => log.kind === "provider:aux:stream" && log.requestPreview), "request log for streamed auxiliary work missing");
    console.log(JSON.stringify({
      ok: true,
      chatRequests: chat.captured.length,
      responseRequests: response.captured.length,
      injections,
      skill,
      templateTimeAndSettings,
      quickMessage,
      mcp,
      mcpImageTool,
      searchTools,
      localTools,
      invalidToolArguments,
      modelRegistryParity,
      chatStreamEvents: chat.streamEvents,
      responseStreamEvents: response.streamEvents,
      providerChecks: providerChecks.map((item) => `${item.mode}:${item.ok ? "ok" : "failed"}`),
      deleteListCount,
      regeneratedTitle,
      multiAssistantConcurrency,
      translation,
      compressionSummaries,
      searchDelete,
      backupRoundtrip,
      webDavBackup,
      imageGeneration,
      epubStatsLogs,
      logCount: state.logs.length,
      dataDir: tempDir,
    }, null, 2));
  } finally {
    pc.kill();
    await pc.exited.catch(() => undefined);
    mockServer.stop(true);
    mcpServer.stop(true);
    webDavServer.stop(true);
    if (stdout.trim()) console.error(stdout.trim());
    if (stderr.trim()) console.error(stderr.trim());
  }
}

main().catch((error) => {
  mockServer.stop(true);
  mcpServer.stop(true);
  webDavServer.stop(true);
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
