import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { platform } from "node:os";

import { listZipEntryNames } from "../backup/zip";
import androidSchemaV24 from "../backup/android-schema-v24.json";

type AnyRecord = Record<string, any>;

const rootDir = resolve(import.meta.dir, "../..");
const serverDir = join(rootDir, "pc-server");
const tempDir = join(rootDir, "pc-data", "smoke-backup-roundtrip");
const workDir = join(rootDir, "pc-data", "smoke-backup-roundtrip-work");
const pcPort = Number(process.env.SMOKE_PC_PORT ?? 18281);
const mockPort = Number(process.env.SMOKE_MOCK_PORT ?? 18282);
const baseUrl = `http://127.0.0.1:${pcPort}`;
const mockBaseUrl = `http://127.0.0.1:${mockPort}`;

const ASSISTANT_NAME = "备份往返测试助手";
const NICKNAME = "备份测试用户";
const MEMORY_CONTENT = "这是全局记忆，用于验证备份往返。";
const MODEL_ID = "smoke-model";
const PROVIDER_ID = "smoke-provider";
const CONVERSATION_ID = "smoke-conversation";

const PRESET_MESSAGE_TEXT = "预设消息:备份往返冒烟";
const CUSTOM_JS_SERVICE_ID = "smoke-custom-js";

const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lQSCdAAAAABJRU5ErkJggg==";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function spawnPcServer() {
  return Bun.spawn(["bun", "run", "server.ts"], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(pcPort),
      RIKKAHUB_PC_DATA_DIR: tempDir,
      BROWSER: "none",
      // 假新用户专题:冒烟 server 不上报(同 request-chain-smoke 注释)。
      RIKKAHUB_ANALYTICS: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function startMockProvider() {
  // 注意:本 mock 只应答 /v1/chat/completions,而 provider baseUrl 故意不带 /v1 前缀,
  // 生成必然 404 失败——PC 会给 assistant 消息写入 model_call_error 注解(PC-only 判别符),
  // 正是专题3 A-2"导出过滤"断言需要的真实脏数据。若把 mock 修成可用,请同步改造 A-2 断言。
  return Bun.serve({
    port: mockPort,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = req.body;
        if (!body) return new Response("No body", { status: 400 });
        const text = await req.text();
        const parsed = text ? JSON.parse(text) : {};
        const content = "Hi from backup smoke.";
        if (parsed.stream) {
          const payload = JSON.stringify({
            id: "chatcmpl-smoke",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { role: "assistant", content } }],
          });
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
              controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return new Response(stream, {
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return Response.json({
          id: "chatcmpl-smoke",
          choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

async function waitForHealth(timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // 服务仍在启动
    }
    await Bun.sleep(200);
  }
  throw new Error("PC server did not become healthy");
}

async function api(path: string, init: RequestInit = {}) {
  const isJson = init.body && typeof init.body === "string";
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(isJson ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: any = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    throw new Error(`API ${path} failed: ${response.status} ${text.slice(0, 500)}`);
  }
  return body;
}

function apiJson(path: string, body: AnyRecord) {
  return api(path, { method: "POST", body: JSON.stringify(body) });
}

async function seedState() {
  const settings: AnyRecord = await api("/api/settings");
  const assistant = settings.assistants[0];
  assert(assistant, "默认助手不存在");

  // 添加一个指向 mock 服务的 OpenAI 兼容 provider
  await apiJson("/api/settings/provider", {
    id: PROVIDER_ID,
    name: "Smoke Provider",
    type: "openai",
    enabled: true,
    baseUrl: mockBaseUrl,
    apiKey: "smoke-api-key",
    chatCompletionsPath: "/chat/completions",
    useResponseApi: false,
    models: [
      {
        id: MODEL_ID,
        modelId: MODEL_ID,
        displayName: "Smoke Model",
        type: "CHAT",
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
        abilities: [],
        tools: [],
      },
    ],
  });

  // 专题3 H-1/A-1:上传头像并配置 PC 简化形态的预设消息,导出侧断言其安卓契约转换。
  const avatarForm = new FormData();
  // 字节必须与会话附件不同:导出按内容 sha256 去重,同字节只留一个 zip 条目。
  avatarForm.append("files", new File([Buffer.concat([Buffer.from(TINY_PNG_BASE64, "base64"), Buffer.from("avatar-variant")])], "smoke-avatar.png", { type: "image/png" }));
  const avatarResponse = await fetch(`${baseUrl}/api/files/upload`, { method: "POST", body: avatarForm });
  assert(avatarResponse.ok, `头像上传失败: ${avatarResponse.status}`);
  const avatarUrl = ((await avatarResponse.json()) as AnyRecord).files?.[0]?.url as string;
  assert(/^\/api\/files\/\d+\/content$/.test(avatarUrl ?? ""), `头像上传未返回 PC 形态 url: ${avatarUrl}`);

  // 把默认助手绑定到 mock 模型,改名,并带上头像与 {role, content} 简化形态预设消息
  await apiJson("/api/settings/assistant/detail", {
    ...assistant,
    name: ASSISTANT_NAME,
    chatModelId: MODEL_ID,
    systemPrompt: "你是一个专门用于备份往返测试的助手。",
    avatar: { type: "url", url: avatarUrl },
    useAssistantAvatar: true,
    presetMessages: [{ role: "USER", content: PRESET_MESSAGE_TEXT }],
  });

  // 专题3 S-1 事故回归:custom_js 是安卓正式类型,断言导出 settings.json 原样保留(曾被误过滤)。
  await apiJson("/api/settings/search/service/detail", {
    id: CUSTOM_JS_SERVICE_ID,
    type: "custom_js",
    name: "冒烟自定义JS",
    searchScript: "return []",
  });

  await apiJson("/api/settings/display", { userNickname: NICKNAME });
  await apiJson("/api/settings/memory-settings", { globalEnabled: true, writeStrategy: "ask" });
  await apiJson("/api/memory/global", { content: MEMORY_CONTENT });

  // 上传一个附件并在消息里引用(批7:附件链路端到端——导出去重/URL 重写/恢复回链全覆盖)
  const uploadForm = new FormData();
  uploadForm.append("files", new File([Buffer.from(TINY_PNG_BASE64, "base64")], "smoke-att.png", { type: "image/png" }));
  const uploadResponse = await fetch(`${baseUrl}/api/files/upload`, { method: "POST", body: uploadForm });
  assert(uploadResponse.ok, `附件上传失败: ${uploadResponse.status}`);
  const uploadData = (await uploadResponse.json()) as AnyRecord;
  const attachmentId = uploadData.files?.[0]?.id;
  assert(Number.isFinite(attachmentId), "附件上传未返回 id");

  // B6-①a:先发消息前建好 folder 型工作区——会话→工作区是"首发消息建会话时绑定"
  // (ensureConversation 的 workspaceId),无独立改绑端点。folder 型 root 落库为真实绝对
  // 路径,是"实体必须随 dump 往返"的硬场景(managed 型 root 为空串、恢复后按新 dataDir 重建)。
  const folderRoot = join(workDir, "smoke-workspace-root");
  mkdirSync(folderRoot, { recursive: true });
  const wsResp: AnyRecord = await api("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ type: "folder", name: "Smoke 工作区", root: folderRoot }),
  });
  const boundWorkspaceId = wsResp?.workspace?.id;
  assert(typeof boundWorkspaceId === "string", `工作区创建失败: ${JSON.stringify(wsResp)}`);

  // 发送一条带附件的用户消息触发对话创建与生成(首发即绑定工作区)
  await apiJson(`/api/conversations/${CONVERSATION_ID}/messages`, {
    workspaceId: boundWorkspaceId,
    parts: [
      { type: "image", url: `/api/files/${attachmentId}/content` },
      { type: "text", text: "hello" },
    ],
  });

  // 等待生成完成（mock 立即返回）
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const conversation: AnyRecord = await api(`/api/conversations/${CONVERSATION_ID}`);
    const hasAssistant = conversation.messages?.some((node: AnyRecord) =>
      node.messages?.some((m: AnyRecord) => m.role === "ASSISTANT")
    );
    if (hasAssistant) break;
    await Bun.sleep(200);
  }

  // 锁死 A-2 前提:失败生成必须留下 model_call_error 注解(见 startMockProvider 注释)。
  // 注解在失败收尾时才落库,晚于 assistant 占位消息出现,轮询等待。
  let annotationSeen = false;
  const annotationDeadline = Date.now() + 10_000;
  while (Date.now() < annotationDeadline) {
    const seeded: AnyRecord = await api(`/api/conversations/${CONVERSATION_ID}`);
    if (JSON.stringify(seeded).includes("model_call_error")) { annotationSeen = true; break; }
    await Bun.sleep(200);
  }
  assert(annotationSeen, "预期的 model_call_error 注解未出现,A-2 导出过滤断言将失去意义");

  return { assistantId: assistant.id, workspaceId: boundWorkspaceId, folderRoot };
}

async function exportBackupZip(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/data/export`);
  assert(response.ok, `export failed: ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  const filename = response.headers.get("X-Export-Filename") ?? `rikkahub-backup-${Date.now()}.zip`;
  const zipPath = join(tempDir, filename);
  await Bun.write(zipPath, new Uint8Array(arrayBuffer));
  return zipPath;
}

function extractZip(zipPath: string, outDir: string) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  if (platform() === "win32") {
    const ps = `
      Add-Type -AssemblyName System.IO.Compression.FileSystem;
      [System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}', '${outDir.replace(/'/g, "''")}');
    `;
    const result = spawnSync("powershell", ["-Command", ps], { encoding: "utf8" });
    assert(result.status === 0, `ZipFile.ExtractToDirectory failed: ${result.stderr}`);
  } else {
    const result = spawnSync("unzip", ["-q", "-o", zipPath, "-d", outDir], { encoding: "utf8" });
    assert(result.status === 0, `unzip failed: ${result.stderr}`);
  }
}

// 批7:从已解包目录挑选条目重打包成 PC 格式 zip,用于构造 dump-only / settings-only 场景。
function repackagePcZip(extractDir: string, outPath: string, entries: string[]) {
  rmSync(outPath, { force: true });
  const stage = join(tempDir, `pc-repack-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  for (const entry of entries) {
    const src = join(extractDir, entry);
    if (!existsSync(src)) continue;
    cpSync(src, join(stage, entry), { recursive: true });
  }
  if (platform() === "win32") {
    const ps = `
      Add-Type -AssemblyName System.IO.Compression.FileSystem;
      [System.IO.Compression.ZipFile]::CreateFromDirectory('${stage.replace(/'/g, "''")}', '${outPath.replace(/'/g, "''")}');
    `;
    const result = spawnSync("powershell", ["-Command", ps], { encoding: "utf8" });
    assert(result.status === 0, `repackagePcZip failed: ${result.stderr}`);
  } else {
    const result = spawnSync("zip", ["-q", "-r", outPath, "."], { cwd: stage, encoding: "utf8" });
    assert(result.status === 0, `repackagePcZip zip failed: ${result.stderr}`);
  }
}

function repackageAndroidZip(extractDir: string, outPath: string) {
  rmSync(outPath, { force: true });
  if (platform() === "win32") {
    const workDir = join(tempDir, `android-repack-${Date.now()}`);
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });
    cpSync(join(extractDir, "settings.json"), join(workDir, "settings.json"));
    cpSync(join(extractDir, "rikka_hub.db"), join(workDir, "rikka_hub.db"));
    if (existsSync(join(extractDir, "upload"))) {
      cpSync(join(extractDir, "upload"), join(workDir, "upload"), { recursive: true });
    }
    const ps = `
      Add-Type -AssemblyName System.IO.Compression.FileSystem;
      [System.IO.Compression.ZipFile]::CreateFromDirectory('${workDir.replace(/'/g, "''")}', '${outPath.replace(/'/g, "''")}');
    `;
    const result = spawnSync("powershell", ["-Command", ps], { encoding: "utf8" });
    assert(result.status === 0, `ZipFile.CreateFromDirectory failed: ${result.stderr}`);
  } else {
    const entries = ["settings.json", "rikka_hub.db"];
    if (existsSync(join(extractDir, "upload"))) entries.push("upload");
    const result = spawnSync("zip", ["-q", "-r", outPath, ...entries], { cwd: extractDir, encoding: "utf8" });
    assert(result.status === 0, `zip failed: ${result.stderr}`);
  }
}

async function importZip(zipPath: string) {
  const file = Bun.file(zipPath);
  const response = await fetch(`${baseUrl}/api/data/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/zip",
      "X-Filename": zipPath.split(/[\\/]/).pop() ?? "backup.zip",
    },
    body: file,
  });
  const text = await response.text();
  assert(response.ok, `import failed: ${response.status} ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

// 批7:恢复后附件链路校验——会话里的 /api/files/<id>/content 引用必须可读(引用改写正确),
// state.files 条目数必须等于期望值(去重生效、无翻倍)。state.json 落盘有节流,轮询等待。
async function verifyAttachmentIntegrity(expectedCount: number, label: string) {
  const conversation: AnyRecord = await api(`/api/conversations/${CONVERSATION_ID}`);
  const refs = [...JSON.stringify(conversation).matchAll(/\/api\/files\/(\d+)\/content/g)].map((m) => Number(m[1]));
  assert(refs.length > 0, `${label}: 恢复后的会话缺少附件引用`);
  for (const id of new Set(refs)) {
    const res = await fetch(`${baseUrl}/api/files/${id}/content`);
    assert(res.ok, `${label}: 附件引用 /api/files/${id}/content 不可读(${res.status}),引用改写失败`);
  }
  const deadline = Date.now() + 10_000;
  let actual = -1;
  while (Date.now() < deadline) {
    try {
      const stateJson = JSON.parse(readFileSync(join(tempDir, "state.json"), "utf8"));
      actual = Array.isArray(stateJson.files) ? stateJson.files.length : -1;
      if (actual === expectedCount) return;
    } catch { /* state.json 写入中,重试 */ }
    await Bun.sleep(300);
  }
  assert(false, `${label}: state.files 应有 ${expectedCount} 条,实际 ${actual}(去重失效或附件丢失)`);
}

async function verifyRestoredState(opts: { expectCustomJs?: boolean } = {}) {
  const settings: AnyRecord = await api("/api/settings");
  assert(settings.assistants?.some((a: AnyRecord) => a.name === ASSISTANT_NAME), "助手未恢复");
  const restoredAssistant = (settings.assistants as AnyRecord[]).find((a) => a.name === ASSISTANT_NAME)!;
  // 专题3 H-1:恢复后头像必须回到 PC 形态且可读(安卓 file:// URI 改写/PC 回链)。
  const restoredAvatar = String(restoredAssistant.avatar?.url ?? "");
  assert(/^\/api\/files\/\d+\/content$/.test(restoredAvatar), `恢复后头像不是 PC 形态(头像丢失回归): ${restoredAvatar}`);
  const avatarRes = await fetch(`${baseUrl}${restoredAvatar}`);
  assert(avatarRes.ok, `恢复后头像不可读(${avatarRes.status}): ${restoredAvatar}`);
  // 专题3 A-1:preset 消息往返存活(PC 简化形态或安卓 parts 形态皆可,文本必须在)。
  assert(JSON.stringify(restoredAssistant.presetMessages ?? []).includes(PRESET_MESSAGE_TEXT), "preset 消息未在往返中存活");
  if (opts.expectCustomJs) {
    // 专题3 S-1:custom_js 必须在所有导入路径存活(PC→PC 走 pc-backup.json,安卓 zip 走 settings.json)。
    assert((settings.searchServices as AnyRecord[])?.some((svc) => svc.type === "custom_js" && svc.id === CUSTOM_JS_SERVICE_ID), "custom_js 搜索服务未在 PC→PC 往返中存活");
  }
  assert(settings.displaySetting?.userNickname === NICKNAME, "显示设置未恢复");
  assert(settings.memorySettings?.globalEnabled === true, "记忆设置未恢复");

  const memories: AnyRecord = await api("/api/memory/global");
  assert(memories.memories?.some((m: AnyRecord) => m.content === MEMORY_CONTENT), "全局记忆未恢复");

  const conversation: AnyRecord = await api(`/api/conversations/${CONVERSATION_ID}`);
  assert(conversation, "会话未恢复");
  const hasAssistant = conversation.messages?.some((node: AnyRecord) =>
    node.messages?.some((m: AnyRecord) => m.role === "ASSISTANT")
  );
  assert(hasAssistant, "助手回复未恢复");
}

async function main() {
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  // 专题3 T-1:不再合成 cached 模板——首次导出必须走 vendored 安卓 schema 路径,
  // 下方以 room identity hash 断言锁死(纯 PC 用户导出含会话库的核心保障)。

  const mock = startMockProvider();
  let pc = spawnPcServer();
  let stdout = "";
  let stderr = "";
  pc.stdout.pipeTo(new WritableStream({ write: (chunk) => { stdout += new TextDecoder().decode(chunk); } })).catch((): undefined => undefined);
  pc.stderr.pipeTo(new WritableStream({ write: (chunk) => { stderr += new TextDecoder().decode(chunk); } })).catch((): undefined => undefined);

  try {
    await waitForHealth();
    console.log("[backup-smoke] 服务已启动");

    const seedInfo = await seedState();
    console.log("[backup-smoke] 已写入测试状态（含会话）");

    // 1. PC → zip 导出，保存到 workDir 避免后续清空 tempDir 时被删
    const exportedZipPath = await exportBackupZip();
    const savedZipPath = join(workDir, "pc-backup.zip");
    cpSync(exportedZipPath, savedZipPath);
    console.log(`[backup-smoke] 已导出 PC 备份: ${savedZipPath}`);

    // 2. 验证 zip 内包含 Android 兼容文件（即 PC→Android DB 生成）
    const extractDir = join(workDir, "extracted");
    extractZip(savedZipPath, extractDir);
    assert(existsSync(join(extractDir, "settings.json")), "备份 zip 缺少 settings.json");
    assert(existsSync(join(extractDir, "rikka_hub.db")), "备份 zip 缺少 rikka_hub.db（Android 兼容库）");
    assert(existsSync(join(extractDir, "pc-backup.json")), "备份 zip 缺少 pc-backup.json");
    assert(existsSync(join(extractDir, "pc_conversations.db")), "备份 zip 缺少 pc_conversations.db(PC 原生会话 dump,批4)");
    {
      // B6-①a:dump 必须带 pc_workspace 表且含本次种入的工作区行(权限档/信任态/类型)。
      // P3.1(format 3):另带引擎私有条目两表(本冒烟不产生条目,只核表在)。
      const { Database } = require("bun:sqlite");
      const dump = new Database(join(extractDir, "pc_conversations.db"), { readonly: true });
      const fmt = (dump.query("SELECT value FROM pc_dump_meta WHERE key='format'").get() as AnyRecord)?.value;
      assert(fmt === "3", `pc_dump_meta.format 应为 3(P3.1),实际 ${fmt}`);
      const engineTables = (dump.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('pc_engine_entry','pc_engine_session')").all() as AnyRecord[]).length;
      assert(engineTables === 2, `pc dump 缺引擎私有条目表(实得 ${engineTables}/2)`);
      const wsRows = dump.query("SELECT id, name, type, permission_preset FROM pc_workspace").all() as AnyRecord[];
      dump.close();
      const wsRow = wsRows.find((w) => w.id === seedInfo.workspaceId);
      assert(wsRow, `pc dump 缺 pc_workspace 行(工作区 ${seedInfo.workspaceId} 未随备份带出)`);
      assert(wsRow.type === "folder" && wsRow.name === "Smoke 工作区", `pc_workspace 行字段不符: ${JSON.stringify(wsRow)}`);
      // 会话行的工作区绑定也必须在 dump 里(workspace_id 列)。
      const dump2 = new Database(join(extractDir, "pc_conversations.db"), { readonly: true });
      const convRow = dump2.query("SELECT workspace_id FROM pc_conversation WHERE id = ?").get(CONVERSATION_ID) as AnyRecord;
      dump2.close();
      assert(convRow?.workspace_id === seedInfo.workspaceId, `dump 会话行 workspace_id 不符(实际 ${convRow?.workspace_id})`);
    }
    const uploadEntries = readdirSync(join(extractDir, "upload"));
    assert(uploadEntries.length === 2, `upload/ 应恰有 2 个文件(会话附件+头像),实际 ${uploadEntries.length}: ${uploadEntries.join(",")}`);
    {
      // 批6②:导出的安卓库里不得残留 PC 形态附件 URL,必须已重写为安卓 upload URI
      const { Database } = require("bun:sqlite");
      const rk = new Database(join(extractDir, "rikka_hub.db"), { readonly: true });
      const nodeJson = (rk.query("SELECT messages FROM message_node").all() as { messages: string }[]).map((r) => r.messages).join("");
      rk.close();
      assert(!nodeJson.includes("/api/files/"), "rikka_hub.db 中残留 PC 形态附件 URL(安卓端将全部裂图)");
      assert(nodeJson.includes("file:///data/user/0/me.rerere.rikkahub/files/upload/"), "rikka_hub.db 未写入安卓形态附件 URI");
    }
    {
      // 专题3 Z-1:zip 条目名必须全为正斜杠且无 ./ 前缀(安卓端按 "upload/" 前缀匹配,
      // 反斜杠 = 附件/skills/fonts 全部静默丢失)。
      const entryNames = listZipEntryNames(savedZipPath);
      for (const name of entryNames) {
        assert(!name.includes("\\"), `zip 条目名含反斜杠(安卓端将静默跳过): ${name}`);
        assert(!name.startsWith("./"), `zip 条目名含 ./ 前缀(安卓端前缀匹配不中): ${name}`);
      }
      assert(entryNames.some((n) => n.startsWith("upload/") && !n.endsWith("/")), "zip 缺少 upload/ 正斜杠条目");
    }
    {
      // 专题3 A-1/S-1/H-1:settings.json 的安卓契约。
      const settingsText = readFileSync(join(extractDir, "settings.json"), "utf8");
      const exported = JSON.parse(settingsText) as AnyRecord;
      // S-1 事故回归:custom_js 是安卓正式类型(CustomJsOptions),导出决不能过滤它。
      const exportedServices = (JSON.parse(settingsText).searchServices ?? []) as AnyRecord[];
      assert(exportedServices.some((svc) => svc.type === "custom_js" && svc.id === CUSTOM_JS_SERVICE_ID), "custom_js 搜索服务未出现在导出 settings.json(安卓合法类型被误过滤)");
      assert(!settingsText.includes("/api/files/"), "settings.json 残留 PC 形态附件 URL(安卓端头像丢失)");
      const exportedAssistant = (exported.assistants as AnyRecord[]).find((a) => a.name === ASSISTANT_NAME);
      assert(exportedAssistant, "settings.json 缺少测试助手");
      const preset = (exportedAssistant.presetMessages as AnyRecord[])?.[0];
      assert(Array.isArray(preset?.parts) && preset.parts[0]?.text === PRESET_MESSAGE_TEXT, "preset 消息未转换成安卓 UIMessage 形状(parts 必填)");
      assert(!("content" in (preset ?? {})), "preset 消息残留 PC 简化形态 content 键");
      const avatarOut = String(exportedAssistant.avatar?.url ?? "");
      assert(avatarOut.startsWith("file:///data/user/0/me.rerere.rikkahub/files/upload/"), `助手头像未反写成安卓 upload URI: ${avatarOut}`);
    }
    {
      // 专题3 T-1/E-1:无 cached 模板时 rikka_hub.db 必须按 vendored schema v24 生成;
      // 消息 id 必须是合法 uuid(显式 null 会让安卓端会话解码即炸且无容错)。
      const { Database } = require("bun:sqlite");
      const rk = new Database(join(extractDir, "rikka_hub.db"), { readonly: true });
      const identity = rk.query("SELECT identity_hash FROM room_master_table WHERE id = 42").get() as AnyRecord;
      assert(identity?.identity_hash === (androidSchemaV24 as AnyRecord).database.identityHash, `rikka_hub.db identity hash 不符(vendored schema 未生效): ${identity?.identity_hash}`);
      const uv = (rk.query("PRAGMA user_version").get() as AnyRecord)?.user_version;
      assert(uv === (androidSchemaV24 as AnyRecord).database.version, `rikka_hub.db user_version 应为 v${(androidSchemaV24 as AnyRecord).database.version},实际 ${uv}`);
      const nodeRows = rk.query("SELECT messages FROM message_node").all() as { messages: string }[];
      rk.close();
      assert(nodeRows.length > 0, "rikka_hub.db 无消息节点(vendored 路径未写入会话)");
      for (const row of nodeRows) {
        for (const m of JSON.parse(row.messages) as AnyRecord[]) {
          assert(typeof m.id === "string" && /^[0-9a-fA-F-]{36}$/.test(m.id), `消息 id 非法(安卓端会话将打不开): ${JSON.stringify(m.id)}`);
          assert(Array.isArray(m.annotations) && m.annotations.every((a: AnyRecord) => a?.type !== "model_call_error"), "消息残留 model_call_error 注解(安卓端会话将打不开)");
        }
      }
    }
    console.log("[backup-smoke] zip 结构校验通过(含 pc dump、附件去重、安卓 URL 重写、Z-1 条目名、A-1/S-1/H-1 settings 契约、T-1/E-1 会话库)");

    // 3. PC → zip → PC：清空数据后重新导入同一 zip
    pc.kill();
    await pc.exited.catch((): undefined => undefined);
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });

    pc = spawnPcServer();
    pc.stdout.pipeTo(new WritableStream({ write: (chunk) => { stdout += new TextDecoder().decode(chunk); } })).catch((): undefined => undefined);
    pc.stderr.pipeTo(new WritableStream({ write: (chunk) => { stderr += new TextDecoder().decode(chunk); } })).catch((): undefined => undefined);
    await waitForHealth();

    const pcImportResult = await importZip(savedZipPath);
    assert(pcImportResult.source === "android-zip" || pcImportResult.source === "pc-zip", `未知导入来源: ${pcImportResult.source}`);
    console.log(`[backup-smoke] PC→zip→PC 导入来源: ${pcImportResult.source}`);
    await verifyRestoredState({ expectCustomJs: true });
    await verifyAttachmentIntegrity(2, "PC→zip→PC");
    {
      // B6-①a:工作区实体随 dump 恢复(PC→PC 唯一通路)——实体在、字段对、会话绑定回来。
      const wsList: AnyRecord = await api("/api/workspaces");
      const restored = (wsList.workspaces as AnyRecord[])?.find((w) => w.id === seedInfo.workspaceId);
      assert(restored, `PC→PC 恢复后工作区实体丢失(${seedInfo.workspaceId} 不在 /api/workspaces)`);
      assert(restored.name === "Smoke 工作区" && restored.type === "folder", `恢复的工作区字段不符: ${JSON.stringify(restored)}`);
      assert(restored.status === "ready", `folder root 仍在,工作区应为 ready,实际 ${restored.status}`);
      const convAfter: AnyRecord = await api(`/api/conversations/${CONVERSATION_ID}`);
      assert(convAfter?.workspaceId === seedInfo.workspaceId, `恢复后会话未绑回工作区(实际 ${convAfter?.workspaceId})`);
      console.log("[backup-smoke] B6-①a 工作区随 dump 往返校验通过(实体+绑定均恢复)");
    }
    console.log("[backup-smoke] PC→zip→PC 状态校验通过(含附件回链)");

    // 4. PC → Android DB → PC：用 settings.json + rikka_hub.db 重新打包成 Android zip 再导入
    pc.kill();
    await pc.exited.catch((): undefined => undefined);
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });

    const androidZipPath = join(workDir, "android-roundtrip.zip");
    repackageAndroidZip(extractDir, androidZipPath);
    assert(existsSync(androidZipPath), "Android zip 重新打包失败");
    console.log("[backup-smoke] 已重新打包 Android zip");

    pc = spawnPcServer();
    pc.stdout.pipeTo(new WritableStream({ write: (chunk) => { stdout += new TextDecoder().decode(chunk); } })).catch((): undefined => undefined);
    pc.stderr.pipeTo(new WritableStream({ write: (chunk) => { stderr += new TextDecoder().decode(chunk); } })).catch((): undefined => undefined);
    await waitForHealth();

    const androidImportResult = await importZip(androidZipPath);
    assert(androidImportResult.source === "android-zip", `Android zip 导入来源错误: ${androidImportResult.source}`);
    console.log(`[backup-smoke] PC→Android DB→PC 导入来源: ${androidImportResult.source}`);
    await verifyRestoredState({ expectCustomJs: true });
    await verifyAttachmentIntegrity(2, "PC→Android DB→PC");
    console.log("[backup-smoke] PC→Android DB→PC 状态校验通过(含附件回链)");

    // 4b. 同一服务器重复导入同一 Android zip:附件必须去重复用,不得翻倍(批5 根治的 4 份冗余)
    await importZip(androidZipPath);
    await verifyAttachmentIntegrity(2, "Android zip 重复导入");
    console.log("[backup-smoke] Android zip 重复导入附件未翻倍(去重生效)");

    // 5. dump-only 恢复:去掉 rikka_hub.db,纯 PC 原生 dump 也能完整恢复(批4,纯 PC 用户路径)
    pc.kill();
    await pc.exited.catch((): undefined => undefined);
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    pc = spawnPcServer();
    pc.stdout.pipeTo(new WritableStream({ write: (chunk) => { stdout += new TextDecoder().decode(chunk); } })).catch((): undefined => undefined);
    pc.stderr.pipeTo(new WritableStream({ write: (chunk) => { stderr += new TextDecoder().decode(chunk); } })).catch((): undefined => undefined);
    await waitForHealth();
    const dumpOnlyZip = join(workDir, "pc-dump-only.zip");
    repackagePcZip(extractDir, dumpOnlyZip, ["settings.json", "pc-backup.json", "pc_conversations.db", "upload"]);
    await importZip(dumpOnlyZip);
    await verifyRestoredState({ expectCustomJs: true });
    await verifyAttachmentIntegrity(2, "dump-only");
    console.log("[backup-smoke] dump-only 恢复校验通过(无 rikka_hub.db 仍完整恢复)");

    // 6. settings-only 降级:两库皆无的 zip 导入后,现有会话必须原样保留(收官审查 P0-1 清库回归)
    repackagePcZip(extractDir, join(workDir, "pc-settings-only.zip"), ["settings.json", "pc-backup.json"]);
    await importZip(join(workDir, "pc-settings-only.zip"));
    const convAfterSettingsOnly: AnyRecord = await api(`/api/conversations/${CONVERSATION_ID}`);
    const stillHasMessages = convAfterSettingsOnly?.messages?.some((node: AnyRecord) =>
      node.messages?.some((m: AnyRecord) => m.role === "ASSISTANT")
    );
    assert(stillHasMessages, "settings-only 导入清空了现有会话(P0-1 清库回归!)");
    console.log("[backup-smoke] settings-only 降级校验通过(现有会话未被清空)");

    console.log(JSON.stringify({ ok: true, dataDir: tempDir }, null, 2));
  } catch (err) {
    console.error("[backup-smoke] 失败:", err instanceof Error ? err.message : String(err));
    if (stdout.trim()) console.error("[stdout]", stdout.slice(-2000));
    if (stderr.trim()) console.error("[stderr]", stderr.slice(-2000));
    process.exitCode = 1;
    throw err;
  } finally {
    pc.kill();
    await pc.exited.catch((): undefined => undefined);
    mock.stop(true);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
