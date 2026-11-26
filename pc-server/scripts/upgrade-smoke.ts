// scripts/upgrade-smoke.ts — 升级冒烟(D25,方案 §5.14.10):上一个发布版写下的数据,新版能打开、续聊时发给模型的历史不变;
// 新版写过之后,上一个发布版还能打开、还能续聊。以后每次改存储都跑。
//
//   bun run smoke:upgrade             用仓库里的样本跑一遍(最后一步要上一个发布版的 exe,找不到就跳过并说明)
//   bun run smoke:upgrade --generate  用上一个发布版重新生成样本(换基线版本时用)
//
// 样本在 scripts/upgrade-sample/v5/,是上一个发布版配本文件的假供应商生成的,不含任何真实密钥。expected.json 记着每个会话的
// 节点数、各节点选中的分支、压缩记录数,以及上一个发布版续聊这些会话时发给模型的历史(去掉系统提示词)。
// 老工具卡的显示由 web-ui/app/tests/upgrade-sample-tool-cards.test.tsx 读同一份样本锁住。
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";

import { waitForServerReady } from "../test-utils/e2e-server";

type AnyRecord = Record<string, any>;

const rootDir = resolve(import.meta.dir, "../..");
const serverDir = join(rootDir, "pc-server");
const sampleDir = join(import.meta.dir, "upgrade-sample", "v5");
const BASELINE_VERSION = "2.0.0-preview-v5";
const baselineExe =
  process.env.RIKKAHUB_UPGRADE_BASELINE_EXE ?? join(rootDir, "dist", `Rikkahub_${BASELINE_VERSION}_portable`, "rikkahub-pc.exe");
/** 样本里的供应商地址写死了这个端口。 */
const MOCK_PORT = 18192;
const APP_PORT = Number(process.env.SMOKE_UPGRADE_PORT ?? 18193);
const SAMPLE_ENTRIES = ["state.json", "rikka_hub.db", "workspaces"];
const MODEL_ID = "upgrade-smoke-model";
const IDS = {
  tools: "00000000-0000-4000-8000-0000000000a1",
  compacted: "00000000-0000-4000-8000-0000000000a2",
  chat: "00000000-0000-4000-8000-0000000000a3",
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ---------- 假供应商:按请求内容应答(不按轮次排剧本,两个版本的辅助请求多寡不影响结果) ----------

const probes = new Map<string, AnyRecord[]>();
let replySeq = 0;
let toolCallSeq = 0;
const LONG_TEXT = Array.from({ length: 40 }, (_, i) => `Point ${i + 1}: keep the notes short, specific and easy to check.`).join(" ");

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : "")).join("");
}

type Reply = { reasoning?: string; text?: string; toolCall?: { name: string; args: AnyRecord } };

/** 触发词都写在用户消息开头;回答带全局序号,两个分支的内容因此不同,选错分支会在历史里看出来。 */
function replyFor(body: AnyRecord): Reply {
  const messages: AnyRecord[] = Array.isArray(body.messages) ? body.messages : [];
  const raw = JSON.stringify(messages);
  if (raw.includes("<conversation>") || raw.includes("# Conversation")) return { text: "SUMMARY: the user asked for long notes on six topics." };
  const last = messages.at(-1);
  if (last?.role === "tool") return { reasoning: "Checking the tool result.", text: `Tool step ${++replySeq} finished.` };
  const said = textOf(last?.content).trim();
  const probe = said.match(/^probe:(\S+)$/);
  if (probe) probes.set(probe[1]!, messages);
  const think = `Thinking about: ${said}`;
  if (said.startsWith("[write]")) return { reasoning: think, toolCall: { name: "write", args: { path: "notes.txt", content: "alpha\nbeta\n" } } };
  if (said.startsWith("[read]")) return { reasoning: think, toolCall: { name: "read", args: { path: "notes.txt" } } };
  if (said.startsWith("[edit]")) {
    return { reasoning: think, toolCall: { name: "edit", args: { path: "notes.txt", edits: [{ oldText: "beta", newText: "gamma" }] } } };
  }
  if (said.startsWith("[long]")) return { reasoning: think, text: `Reply ${++replySeq}: ${said}. ${LONG_TEXT}` };
  return { reasoning: think, text: `Reply ${++replySeq} to: ${said}` };
}

function respond(body: AnyRecord, reply: Reply): Response {
  const usage = { prompt_tokens: 100, completion_tokens: 20 };
  const call = reply.toolCall
    ? { id: `call_${++toolCallSeq}`, type: "function", function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.args) } }
    : null;
  const finish = call ? "tool_calls" : "stop";
  if (body.stream === false) {
    const message = { role: "assistant", content: reply.text ?? "", ...(call ? { tool_calls: [call] } : {}) };
    return Response.json({ id: "chatcmpl-upgrade", object: "chat.completion", created: 0, model: "upgrade-fake", choices: [{ index: 0, message, finish_reason: finish }], usage });
  }
  const base = { id: "chatcmpl-upgrade", object: "chat.completion.chunk", created: 0, model: "upgrade-fake" };
  const frame = (delta: AnyRecord, finishReason: string | null = null, extra: AnyRecord = {}) =>
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra })}\n\n`;
  const frames: string[] = [];
  if (reply.reasoning) frames.push(frame({ role: "assistant", reasoning_content: reply.reasoning }));
  if (reply.text) frames.push(frame({ content: reply.text }));
  if (call) frames.push(frame({ tool_calls: [{ index: 0, ...call }] }));
  frames.push(frame({}, finish, { usage }), "data: [DONE]\n\n");
  return new Response(frames.join(""), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function startFakeProvider() {
  return Bun.serve({
    port: MOCK_PORT,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
      const body = (await request.json()) as AnyRecord;
      return respond(body, replyFor(body));
    },
  });
}

/** 发给模型的历史里与版本无关的部分:去掉系统提示词,其余逐条保留角色、正文、思考、工具调用与工具结果的对应。 */
function projectHistory(messages: AnyRecord[] | undefined): AnyRecord[] | null {
  if (!messages) return null;
  return messages
    .filter((m) => m.role !== "system" && m.role !== "developer")
    .map((m) => {
      const reasoning = m.reasoning_content ?? m.reasoning ?? m.reasoning_text;
      return {
        role: m.role,
        text: textOf(m.content),
        ...(reasoning ? { reasoning } : {}),
        ...(Array.isArray(m.tool_calls)
          ? { toolCalls: m.tool_calls.map((c: AnyRecord) => ({ id: c.id, name: c.function?.name, args: JSON.parse(c.function?.arguments || "{}") })) }
          : {}),
        ...(m.tool_call_id ? { toolCallId: m.tool_call_id } : {}),
      };
    });
}

// ---------- 起停应用 ----------

type App = { proc: ReturnType<typeof Bun.spawn>; base: string; label: string; output: string[] };
const PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"];

/** 子进程的输出要一直读走,否则管道写满后子进程会卡在打日志上;留最后几十行供出错时看。 */
function drain(stream: ReadableStream<Uint8Array>, sink: string[]) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      sink.push(decoder.decode(value, { stream: true }));
      if (sink.length > 80) sink.splice(0, sink.length - 80);
    }
  })().catch((): undefined => undefined); // 进程退出时流被关掉,没有要处理的
}

async function startApp(kind: "baseline" | "current", dataDir: string): Promise<App> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of PROXY_ENV) delete env[key];
  const proc = Bun.spawn(kind === "baseline" ? [baselineExe, "--no-open"] : ["bun", "run", "server.ts", "--no-open"], {
    cwd: kind === "baseline" ? dirname(baselineExe) : serverDir,
    env: { ...env, PORT: String(APP_PORT), RIKKAHUB_PC_DATA_DIR: dataDir, RIKKAHUB_ANALYTICS: "0", BROWSER: "none" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output: string[] = [];
  drain(proc.stderr as ReadableStream<Uint8Array>, output);
  const port = await waitForServerReady(proc, 60_000);
  drain(proc.stdout as ReadableStream<Uint8Array>, output);
  return { proc, base: `http://127.0.0.1:${port}`, label: kind === "baseline" ? BASELINE_VERSION : "新版(当前源码)", output };
}

async function stopApp(app: App) {
  await fetch(`${app.base}/api/app/shutdown`, { method: "POST" }).catch((): undefined => undefined);
  const exited = await Promise.race([app.proc.exited, Bun.sleep(20_000).then(() => null)]);
  if (exited === null) {
    app.proc.kill();
    throw new Error(`${app.label} 没有按 /api/app/shutdown 退出`);
  }
}

async function api(app: App, path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${app.base}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(`[${app.label}] ${init.method ?? "GET"} ${path} → ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const post = (app: App, path: string, body: unknown = {}) => api(app, path, { method: "POST", body: JSON.stringify(body) });

function selected(conversation: AnyRecord): AnyRecord[] {
  return (conversation.messages ?? []).map((node: AnyRecord) => node.messages[node.selectIndex] ?? node.messages[0]);
}

function textOfParts(parts: AnyRecord[] = []): string {
  return parts.map((part) => (part?.type === "text" ? String(part.text ?? "") : "")).join("");
}

/** 等这一轮答完:不在生成中,最后一条是带正文的回答。 */
async function waitIdle(app: App, id: string): Promise<AnyRecord> {
  const deadline = Date.now() + 60_000;
  let last: AnyRecord | null = null;
  while (Date.now() < deadline) {
    last = await api(app, `/api/conversations/${id}`);
    const tail = selected(last!).at(-1);
    if (!last!.isGenerating && tail?.role === "ASSISTANT" && textOfParts(tail.parts).trim()) return last!;
    await Bun.sleep(150);
  }
  throw new Error(`[${app.label}] 会话 ${id} 60 秒没答完,最后一条:${JSON.stringify(selected(last ?? {}).at(-1))}\n${app.output.join("").slice(-3000)}`);
}

async function send(app: App, id: string, text: string, workspaceId?: string): Promise<AnyRecord> {
  await post(app, `/api/conversations/${id}/messages`, { parts: [{ type: "text", text }], ...(workspaceId ? { workspaceId } : {}) });
  return waitIdle(app, id);
}

// ---------- 生成样本(上一个发布版) ----------

async function configure(app: App): Promise<string> {
  const settings = await api(app, "/api/settings");
  await post(app, "/api/settings/provider", {
    type: "openai",
    id: "upgrade-smoke-provider",
    enabled: true,
    name: "Upgrade Smoke Provider",
    builtIn: false,
    shortDescription: "fake provider for the upgrade smoke",
    description: "fake provider for the upgrade smoke",
    apiKey: "fake-key-not-a-secret",
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    chatCompletionsPath: "/chat/completions",
    useResponseApi: false,
    promptCaching: false,
    testPassed: true,
    testPassedAt: Date.now(),
    models: [
      { id: MODEL_ID, modelId: "upgrade-fake", displayName: "Upgrade Fake", type: "CHAT", inputModalities: ["TEXT"], outputModalities: ["TEXT"], abilities: ["TOOL", "REASONING"], tools: [] },
    ],
    balanceOption: { enabled: false, apiPath: "/credits", resultPath: "balance" },
  });
  const assistant = settings.assistants.find((item: AnyRecord) => item.id === settings.assistantId);
  await post(app, "/api/settings/assistant/detail", {
    ...assistant,
    chatModelId: MODEL_ID,
    systemPrompt: "You are the upgrade smoke assistant.",
    messageTemplate: "{{ message }}",
    presetMessages: [],
    regexes: [],
    streamOutput: true,
    enableMemory: false,
    useGlobalMemory: false,
    enableRecentChatsReference: false,
    enableTimeReminder: false,
    reasoningLevel: "low",
    localTools: [],
    mcpServers: [],
    modeInjectionIds: [],
    lorebookIds: [],
    quickMessageIds: [],
  });
  await post(app, "/api/settings/default-models", {
    chatModelId: MODEL_ID,
    fastModelId: MODEL_ID,
    compressModelId: MODEL_ID,
    translateModeId: MODEL_ID,
    titleGenerationEnabled: false,
    enableSuggestion: false,
  });
  const { workspace } = await post(app, "/api/workspaces", { type: "managed", name: "Upgrade smoke" });
  await api(app, `/api/workspaces/${workspace.id}`, { method: "PATCH", body: JSON.stringify({ permissionPreset: "full_access" }) });
  return String(workspace.id);
}

function toolParts(conversation: AnyRecord): AnyRecord[] {
  return selected(conversation).flatMap((message) => (message.parts ?? []).filter((part: AnyRecord) => part.type === "tool"));
}

async function buildConversations(app: App, workspaceId: string): Promise<string> {
  // 工作区会话:三次工具调用(写、读、改),一轮纯文字;最后一轮重新生成出第二个分支,再切回第一个。
  for (const text of ["[write] create notes.txt", "[read] show notes.txt", "[edit] change beta to gamma", "Summarize what we did"]) {
    await send(app, IDS.tools, text, workspaceId);
  }
  let tools = await api(app, `/api/conversations/${IDS.tools}`);
  const tools3 = toolParts(tools);
  assert(tools3.length === 3 && tools3.every((part) => Array.isArray(part.output) && !part.output.some((o: AnyRecord) => o?.error)), `工具调用没有都成功(会话可能没走工作区引擎):${JSON.stringify(tools3)}`);
  const lastNode = tools.messages.at(-1);
  await post(app, `/api/conversations/${IDS.tools}/regenerate`, { messageId: lastNode.messages[0].id });
  tools = await waitIdle(app, IDS.tools);
  assert(tools.messages.at(-1).messages.length === 2, "重新生成没有产生第二个分支");
  await post(app, `/api/conversations/${IDS.tools}/nodes/${lastNode.id}/select`, { selectIndex: 0 });

  // 从工作区会话第二轮的回答处分叉(分叉出的会话带前两轮)。
  const secondAnswer = selected(tools).filter((message) => message.role === "ASSISTANT")[1];
  const { conversationId: forkId } = await post(app, `/api/conversations/${IDS.tools}/fork`, { messageId: secondAnswer.id });

  // 压缩过的长会话:六轮长回答,手动压缩(引擎原生),压缩后再聊一轮。
  for (let i = 1; i <= 6; i++) await send(app, IDS.compacted, `[long] notes on topic ${i}`, workspaceId);
  const compressed = await post(app, `/api/conversations/${IDS.compacted}/compress`, {});
  assert(compressed?.status === "compressed", `压缩没成功:${JSON.stringify(compressed)}`);
  await send(app, IDS.compacted, "What was the third topic?");

  // 对话模式会话:三轮,最后一轮重新生成,留在新分支上。
  for (const text of ["chat one", "chat two", "chat three"]) await send(app, IDS.chat, text);
  const chat = await api(app, `/api/conversations/${IDS.chat}`);
  await post(app, `/api/conversations/${IDS.chat}/regenerate`, { messageId: chat.messages.at(-1).messages[0].id });
  await waitIdle(app, IDS.chat);
  return String(forkId);
}

type Shape = { nodes: number; selects: number[]; branches: number[]; selectedIds: string[]; compactions: number };

function shapeOf(conversation: AnyRecord): Shape {
  return {
    nodes: conversation.messages.length,
    selects: conversation.messages.map((node: AnyRecord) => node.selectIndex),
    branches: conversation.messages.map((node: AnyRecord) => node.messages.length),
    selectedIds: selected(conversation).map((message) => message.id),
    compactions: (conversation.engineCompactions ?? []).length,
  };
}

async function shapes(app: App, ids: Record<string, string>): Promise<Record<string, Shape>> {
  const listed = new Set(((await api(app, "/api/conversations")) as AnyRecord[]).map((item) => item.id));
  const out: Record<string, Shape> = {};
  for (const [key, id] of Object.entries(ids)) {
    assert(listed.has(id), `[${app.label}] 会话列表里没有 ${key}(${id})`);
    out[key] = shapeOf(await api(app, `/api/conversations/${id}`));
  }
  return out;
}

/** 每个会话续聊一条 probe,记下发给模型的历史。 */
async function probeAll(app: App, ids: Record<string, string>): Promise<Record<string, AnyRecord[]>> {
  const out: Record<string, AnyRecord[]> = {};
  for (const [key, id] of Object.entries(ids)) {
    probes.delete(key);
    await send(app, id, `probe:${key}`);
    const history = projectHistory(probes.get(key));
    assert(history, `[${app.label}] ${key} 续聊时假供应商没收到请求`);
    out[key] = history;
  }
  return out;
}

// ---------- 主流程 ----------

type Expected = {
  baseline: string;
  ids: Record<string, string>;
  shapes: Record<string, Shape>;
  toolCards: AnyRecord[];
  histories: Record<string, AnyRecord[]>;
};

function expectEqual(label: string, actual: unknown, expected: unknown) {
  if (Bun.deepEquals(actual, expected)) return;
  const show = (value: unknown) => JSON.stringify(value, null, 2).slice(0, 4000);
  throw new Error(`${label} 不一致\n--- 期望\n${show(expected)}\n--- 实际\n${show(actual)}`);
}

/** 关停后把 WAL 并回主文件、改回单文件模式,样本只有一个 .db。 */
function settleDatabase(dataDir: string) {
  const db = new Database(join(dataDir, "rikka_hub.db"));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("PRAGMA journal_mode = DELETE");
  db.close();
}

function copySample(from: string, to: string) {
  mkdirSync(to, { recursive: true });
  for (const entry of SAMPLE_ENTRIES) cpSync(join(from, entry), join(to, entry), { recursive: true });
}

async function searchHits(app: App, query: string): Promise<string[]> {
  const hits = (await api(app, `/api/conversations/search?query=${encodeURIComponent(query)}`)) as AnyRecord[];
  return [...new Set(hits.map((hit) => String(hit.conversationId)))];
}

async function generate() {
  assert(existsSync(baselineExe), `找不到上一个发布版:${baselineExe}(或用 RIKKAHUB_UPGRADE_BASELINE_EXE 指定)`);
  const workDir = mkdtempSync(join(tmpdir(), "rkh-upgrade-gen-"));
  const provider = startFakeProvider();
  try {
    const dataDir = join(workDir, "data");
    let app = await startApp("baseline", dataDir);
    let ids: Record<string, string>;
    try {
      const health = await api(app, "/api/health");
      assert(health.version === BASELINE_VERSION, `基线 exe 的版本是 ${health.version},不是 ${BASELINE_VERSION}`);
      const workspaceId = await configure(app);
      const forkId = await buildConversations(app, workspaceId);
      ids = { ...IDS, fork: forkId };
    } finally {
      await stopApp(app);
    }
    settleDatabase(dataDir);
    rmSync(sampleDir, { recursive: true, force: true });
    copySample(dataDir, sampleDir);

    // 用一份样本副本再开一次上一个发布版,记下它眼里的会话与续聊历史。
    const checkDir = join(workDir, "check");
    copySample(sampleDir, checkDir);
    app = await startApp("baseline", checkDir);
    try {
      const expected: Expected = {
        baseline: BASELINE_VERSION,
        ids,
        shapes: await shapes(app, ids),
        toolCards: toolParts(await api(app, `/api/conversations/${ids.tools}`)),
        histories: await probeAll(app, ids),
      };
      writeFileSync(join(sampleDir, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
    } finally {
      await stopApp(app);
    }
    console.log(`样本已写到 ${sampleDir}`);
  } finally {
    provider.stop(true);
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function check() {
  const expectedPath = join(sampleDir, "expected.json");
  assert(existsSync(expectedPath), `没有样本:${sampleDir}。先跑 bun run smoke:upgrade --generate`);
  const expected = JSON.parse(readFileSync(expectedPath, "utf-8")) as Expected;
  const workDir = mkdtempSync(join(tmpdir(), "rkh-upgrade-"));
  const provider = startFakeProvider();
  try {
    copySample(sampleDir, workDir);

    // 1) 新版打开上一个发布版的数据。
    let app = await startApp("current", workDir);
    let current: Record<string, AnyRecord[]>;
    try {
      expectEqual("新版看到的会话结构", await shapes(app, expected.ids), expected.shapes);
      expectEqual("新版返回的老工具卡", toolParts(await api(app, `/api/conversations/${expected.ids.tools}`)), expected.toolCards);
      assert((await searchHits(app, "gamma")).includes(expected.ids.tools), "新版搜不到老会话里的内容");
      current = await probeAll(app, expected.ids);
      for (const key of Object.keys(expected.ids)) expectEqual(`新版续聊 ${key} 时发给模型的历史`, current[key], expected.histories[key]);
    } finally {
      await stopApp(app);
    }
    console.log(`✓ 新版:${Object.keys(expected.ids).length} 个会话都能打开,续聊历史与 ${expected.baseline} 一致,老工具卡不变`);

    // 2) 上一个发布版打开新版写过的数据。
    if (!existsSync(baselineExe)) {
      console.log(`- 跳过降级检查:找不到 ${baselineExe}(可用 RIKKAHUB_UPGRADE_BASELINE_EXE 指定)`);
      return;
    }
    app = await startApp("baseline", workDir);
    try {
      const after = await shapes(app, expected.ids);
      for (const [key, shape] of Object.entries(expected.shapes)) {
        assert(after[key]!.nodes === shape.nodes + 2, `[${app.label}] ${key} 应有 ${shape.nodes + 2} 个节点,实际 ${after[key]!.nodes}`);
        expectEqual(`[${app.label}] ${key} 原有部分`, after[key]!.selectedIds.slice(0, shape.nodes), shape.selectedIds);
      }
      assert((await searchHits(app, "gamma")).includes(expected.ids.tools), `${app.label} 搜不到老会话里的内容`);
      for (const [key, id] of Object.entries(expected.ids)) {
        const again = `${key}-again`;
        probes.delete(again);
        await send(app, id, `probe:${again}`);
        const history = projectHistory(probes.get(again));
        assert(history, `[${app.label}] ${key} 续聊时假供应商没收到请求`);
        const sent = current[key]!;
        expectEqual(`[${app.label}] 续聊 ${key} 时历史的前段`, history.slice(0, sent.length), sent);
        assert(history.length >= sent.length + 2 && history.at(-1)?.text === `probe:${again}`, `[${app.label}] ${key} 续聊历史缺了新版那一轮`);
      }
    } finally {
      await stopApp(app);
    }
    console.log(`✓ ${BASELINE_VERSION}:打开新版写过的数据,会话都在,还能续聊`);
  } finally {
    provider.stop(true);
    rmSync(workDir, { recursive: true, force: true });
  }
}

try {
  if (process.argv.includes("--generate")) await generate();
  else await check();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
