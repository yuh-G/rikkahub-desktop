// workspace/runtime.test.ts — 工作区运行时集成测试(M1-4;P6 起提示词段随
// workspace/prompt.ts 退役,聊天引擎不再有工作区段)
// 覆盖:条件挂载(非工作区/不可用/未信任)、执行守卫链(解绑会话/危险命令/知情同意放行)、
// pi 内核全链路(write→read→edit 经有界 Operations)、审批矩阵经 tools/approval 联动。
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// paths.ts 在 import 时刻固化 dataDir——必须先设环境变量再动态加载被测模块。
process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-runtime-test-"));

const conversations = await import("../conversations");
const { configureWorkingSet } = await import("../conversations/working-set");
const { getConversationMeta } = await import("../conversations/read-queries");
const ws = await import("./index");
const runtime = await import("./runtime");
const approval = await import("../tools/approval");

const db = conversations.openConversationsDb();
// working set 注入是模块级全局,会被其他测试文件覆盖(如 continuation-delete-guard 的 beforeAll
// 把 loadConversation 打成 () => undefined)。在本文件 beforeAll 重注入:bun 各测试文件顺序执行,
// beforeAll 恰在本文件用例前生效,保证 getConversation 走真实 DB。
function installWorkingSet() {
  configureWorkingSet({
    loadConversation: (convId) => {
      const meta = getConversationMeta(db, convId);
      if (!meta) return undefined;
      meta.messages = conversations.loadConversationNodesFromDb(db, convId);
      return meta;
    },
    isGenerating: () => false,
    hasSseClients: () => false,
    hasDirty: () => false,
  });
}
installWorkingSet();
beforeAll(installWorkingSet);

let seq = 0;
function bindConversation(workspaceId: string | null, workspaceCwd: string | null = null) {
  seq += 1;
  const conversation = {
    id: `conv-${seq}`,
    assistantId: "a1",
    systemPrompt: null,
    title: `t-${seq}`,
    messages: [],
    chatSuggestions: [],
    isPinned: false,
    createAt: 1000,
    updateAt: 2000,
    workspaceId,
    workspaceCwd,
  };
  conversations.persistConversation(conversation);
  return conversation;
}

const fakeAssistant = { id: "a1", name: "A", systemPrompt: "", mcpServers: [] } as never;
const needsApproval = (...args: Parameters<typeof approval.decideAppToolPermission>) =>
  approval.decideAppToolPermission(...args).type === "pending";

describe("条件挂载(openAiWorkspaceTools)", () => {
  test("非工作区会话不挂载", () => {
    expect(runtime.openAiWorkspaceTools(null)).toEqual([]);
    expect(runtime.openAiWorkspaceTools(bindConversation(null))).toEqual([]);
  });

  test("managed 工作区挂载 pi 工具(schema 锚点)", () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "m1" });
    const tools = runtime.openAiWorkspaceTools(bindConversation(workspace.id));
    const names = tools.map((t) => (t.function as { name: string }).name);
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("edit");
    // bash 随 shell 探针(本机无 bash 则不挂载,双端一致性由探针保证)
    if (runtime.shellAvailability().available) expect(names).toContain("bash");
    const read = tools.find((t) => (t.function as { name: string }).name === "read")!.function as Record<string, unknown>;
    expect(String(read.description)).toContain("Read the contents of a file");
    expect((read.parameters as { required: string[] }).required).toEqual(["path"]);
  });

  test("folder 工作区未过信任门不挂载;信任后挂载", () => {
    const root = mkdtempSync(join(tmpdir(), "rkh-folder-"));
    const workspace = ws.createWorkspace({ type: "folder", root });
    const conversation = bindConversation(workspace.id);
    expect(runtime.openAiWorkspaceTools(conversation)).toEqual([]);
    ws.trustWorkspace(workspace.id);
    expect(runtime.openAiWorkspaceTools(conversation).length).toBeGreaterThan(0);
  });
});

describe("执行守卫链(runWorkspaceTool)", () => {
  test("非工作区会话的残留调用被拒", async () => {
    const conversation = bindConversation(null);
    await expect(
      runtime.runWorkspaceTool("read", { path: "a.txt" }, { conversationId: conversation.id }),
    ).rejects.toThrow(/not bound to a workspace/);
  });

  test("工作区已删除被拒", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "gone" });
    const conversation = bindConversation(workspace.id);
    // 直接删 DB 记录(deleteWorkspace 会顺带解绑会话,这里模拟悬挂引用)
    db.exec(`DELETE FROM pc_workspace WHERE id = '${workspace.id}'`);
    await expect(
      runtime.runWorkspaceTool("read", { path: "a.txt" }, { conversationId: conversation.id }),
    ).rejects.toThrow(/no longer exists/);
  });

  test("危险命令未经批准被拦;userApproved 放行到 shell 层", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "danger" });
    const conversation = bindConversation(workspace.id);
    await expect(
      runtime.runWorkspaceTool("bash", { command: "rm -rf /" }, { conversationId: conversation.id }),
    ).rejects.toThrow(/blocked by safety policy/);
    if (runtime.shellAvailability().available) {
      // 知情同意放行:不真跑 rm,用同样命中清单的无害变体验证闸门本身
      const result = await runtime.runWorkspaceTool(
        "bash",
        { command: "echo would-run; true # rm -rf /" },
        { conversationId: conversation.id, userApproved: true },
      );
      const text = result.output.map((o) => ("text" in o ? o.text : "")).join("");
      expect(text).toContain("would-run");
    }
  });

  test("full_access:危险命令不拦(不受限制操作电脑文件,用户选档即知情)", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "danger-full" });
    ws.updateWorkspace(workspace.id, { permissionPreset: "full_access" });
    const conversation = bindConversation(workspace.id);
    if (!runtime.shellAvailability().available) return;
    // 同样命中清单的无害变体:full_access 下无 userApproved 也直达 shell 层
    const result = await runtime.runWorkspaceTool(
      "bash",
      { command: "echo full-run; true # rm -rf /" },
      { conversationId: conversation.id },
    );
    const text = result.output.map((o) => ("text" in o ? o.text : "")).join("");
    expect(text).toContain("full-run");
  });
});

describe("宽/严边界选择(权限档位改版:区外写入经批准放行)", () => {
  const joined = (result: { output: Array<Record<string, unknown>> }) =>
    result.output.map((o) => (typeof o.text === "string" ? o.text : "")).join("");

  test("balanced:区外写未经批准被严界兜底拒;userApproved 走宽界成功", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "wide-approved" });
    const conversation = bindConversation(workspace.id);
    const outsideDir = mkdtempSync(join(tmpdir(), "rkh-wide-out-"));
    const target = join(outsideDir, "note.txt");
    await expect(
      runtime.runWorkspaceTool("write", { path: target, content: "hi" }, { conversationId: conversation.id }),
    ).rejects.toThrow(/outside the workspace boundary/);
    await runtime.runWorkspaceTool("write", { path: target, content: "hi" }, { conversationId: conversation.id, userApproved: true });
    expect(readFileSync(target, "utf8")).toBe("hi");
    // edit 同享宽界:经批准可改区外文件(先读后写都放行)
    await runtime.runWorkspaceTool(
      "edit",
      { path: target, edits: [{ oldText: "hi", newText: "hello" }] },
      { conversationId: conversation.id, userApproved: true },
    );
    expect(readFileSync(target, "utf8")).toBe("hello");
  });

  test("full_access:区外写免批准;区内写不被宽界黑名单误伤(managed 根在 dataDir 下)", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "wide-full" });
    ws.updateWorkspace(workspace.id, { permissionPreset: "full_access" });
    const conversation = bindConversation(workspace.id);
    const outsideDir = mkdtempSync(join(tmpdir(), "rkh-full-out-"));
    await runtime.runWorkspaceTool("write", { path: join(outsideDir, "w.txt"), content: "w" }, { conversationId: conversation.id });
    expect(readFileSync(join(outsideDir, "w.txt"), "utf8")).toBe("w");
    // 回归:managed 根在 dataDir/workspaces/ 之下,宽界"区内直通"保证区内写照常
    const inZone = await runtime.runWorkspaceTool("write", { path: "in-zone.txt", content: "in" }, { conversationId: conversation.id });
    expect(joined(inZone)).toContain("Successfully wrote");
    expect(readFileSync(join(workspace.root, "in-zone.txt"), "utf8")).toBe("in");
  });

  test("宽界无黑名单:full_access 下系统目录与应用数据目录写入也放行(2026-08-23 改版)", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "wide-allow" });
    ws.updateWorkspace(workspace.id, { permissionPreset: "full_access" });
    const conversation = bindConversation(workspace.id);
    // 系统目录:用黑名单内但重定向到测试临时区的安全路径,验证不再硬拒(不真写 C:\Windows / /etc)。
    const sysTarget = process.platform === "win32"
      ? join(process.env.SystemRoot ?? String.raw`C:\Windows`, "Temp", "rkh-allow-test.txt")
      : "/tmp/rkh-allow-test.txt";
    await runtime.runWorkspaceTool("write", { path: sysTarget, content: "x" }, { conversationId: conversation.id });
    expect(readFileSync(sysTarget, "utf8")).toBe("x");
    // 应用数据目录 pc-data:同不再硬拒。写测试专属工作区根下的文件,不碰真实状态文件。
    const { dataDir } = await import("../foundation/paths");
    const dataTarget = join(workspace.root, "appdata-ok.txt");
    expect(dataTarget.startsWith(join(dataDir, "workspaces"))).toBe(true); // 确认该路径确实在 pc-data 内
    await runtime.runWorkspaceTool("write", { path: dataTarget, content: "x" }, { conversationId: conversation.id });
    expect(readFileSync(dataTarget, "utf8")).toBe("x");
  });
});

describe("pi 内核全链路(有界 Operations)", () => {
  const workspace = ws.createWorkspace({ type: "managed", name: "e2e" });
  const conversation = bindConversation(workspace.id);
  const ctx = { conversationId: conversation.id };

  test("write → read → edit 闭环,details 挂 metadata.workspace", async () => {
    const written = await runtime.runWorkspaceTool("write", { path: "src/app.ts", content: "const a = 1;\n" }, ctx);
    expect(written.output.map((o) => ("text" in o ? o.text : "")).join("")).toContain("Successfully wrote");

    const read = await runtime.runWorkspaceTool("read", { path: "src/app.ts" }, ctx);
    expect(read.output.map((o) => ("text" in o ? o.text : "")).join("")).toContain("const a = 1;");

    const edited = await runtime.runWorkspaceTool(
      "edit",
      { path: "src/app.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
      ctx,
    );
    const first = edited.output[0] as { metadata?: { workspace?: { tool: string; details: { diff?: string } } } };
    expect(first.metadata?.workspace?.tool).toBe("edit");
    expect(String(first.metadata?.workspace?.details.diff ?? "")).toContain("const a = 2;");
  });

  test("write 越界被严界拒;read 区外放行(三档全宽,2026-08-01 拍板)", async () => {
    await expect(
      runtime.runWorkspaceTool("write", { path: "../escape.txt", content: "x" }, ctx),
    ).rejects.toThrow(/outside the workspace/);
    const outsideDir = mkdtempSync(join(tmpdir(), "rkh-read-out-"));
    writeFileSync(join(outsideDir, "free.txt"), "free-read");
    const read = await runtime.runWorkspaceTool("read", { path: join(outsideDir, "free.txt") }, ctx);
    expect(read.output.map((o) => ("text" in o ? o.text : "")).join("")).toContain("free-read");
  });

  test("workspaceCwd 生效:相对路径以 cwd 解析", async () => {
    await runtime.runWorkspaceTool("write", { path: "sub/inner.txt", content: "inner\n" }, ctx);
    const scoped = bindConversation(workspace.id, join(workspace.root, "sub"));
    const read = await runtime.runWorkspaceTool("read", { path: "inner.txt" }, { conversationId: scoped.id });
    expect(read.output.map((o) => ("text" in o ? o.text : "")).join("")).toContain("inner");
  });
});

describe("审批矩阵经 tools/approval 联动(三档改版)", () => {
  test("balanced:区内 write/常规 bash 免审;危险命令/区外写入审批(带缘由)", () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "appr" }); // 默认 balanced
    const conversation = bindConversation(workspace.id);
    // 参数未到(无参数下界):balanced 全部 auto
    expect(needsApproval("write", fakeAssistant, conversation)).toBe(false);
    expect(needsApproval("bash", fakeAssistant, conversation)).toBe(false);
    expect(needsApproval("read", fakeAssistant, conversation)).toBe(false);
    // 参数齐备(终局):区内写免审;危险命令/区外写入 pending 且带缘由
    expect(needsApproval("write", fakeAssistant, conversation, JSON.stringify({ path: "a.txt" }))).toBe(false);
    expect(needsApproval("bash", fakeAssistant, conversation, JSON.stringify({ command: "ls -la" }))).toBe(false);
    const dangerous = approval.decideAppToolPermission("bash", fakeAssistant, conversation, JSON.stringify({ command: "rm -rf /" }));
    expect(dangerous.type).toBe("pending");
    expect((dangerous as { reason?: string }).reason).toContain("Destructive command pattern");
    const outside = approval.decideAppToolPermission("write", fakeAssistant, conversation, JSON.stringify({ path: "../outside.txt" }));
    expect(outside.type).toBe("pending");
    expect((outside as { reason?: string }).reason).toContain("Writes outside the workspace");

    ws.updateWorkspace(workspace.id, { permissionPreset: "confirm_each" });
    expect(needsApproval("write", fakeAssistant, conversation)).toBe(true);
    expect(approval.decideAppToolPermission("edit", fakeAssistant, conversation)).toEqual({ type: "pending" });
    // confirm_each 恒审批,无附加缘由
    expect(approval.decideAppToolPermission("bash", fakeAssistant, conversation, JSON.stringify({ command: "ls" }))).toEqual({ type: "pending" });

    ws.updateWorkspace(workspace.id, { permissionPreset: "full_access" });
    expect(needsApproval("bash", fakeAssistant, conversation)).toBe(false);
    // full_access:危险命令与区外写入也免审("不受限制操作电脑文件")
    expect(needsApproval("bash", fakeAssistant, conversation, JSON.stringify({ command: "rm -rf /" }))).toBe(false);
    expect(needsApproval("write", fakeAssistant, conversation, JSON.stringify({ path: "../outside.txt" }))).toBe(false);
  });

  test("非工作区会话对同名工具不挂审批(执行层守卫兜底)", () => {
    expect(needsApproval("bash", fakeAssistant, bindConversation(null))).toBe(false);
    expect(needsApproval("bash", fakeAssistant, undefined)).toBe(false);
  });
});

describe("shell runner 硬化(M1-5)", () => {
  test("timeout 夹取:缺省/超限 → 30min 硬上限;合法值透传", () => {
    expect(runtime.clampBashTimeoutSeconds(undefined)).toBe(runtime.BASH_HARD_TIMEOUT_SECONDS);
    expect(runtime.clampBashTimeoutSeconds(999_999)).toBe(runtime.BASH_HARD_TIMEOUT_SECONDS);
    expect(runtime.clampBashTimeoutSeconds(60)).toBe(60);
    expect(runtime.clampBashTimeoutSeconds(-5)).toBe(runtime.BASH_HARD_TIMEOUT_SECONDS);
    expect(runtime.clampBashTimeoutSeconds(Number.NaN)).toBe(runtime.BASH_HARD_TIMEOUT_SECONDS);
  });

  const shellOk = runtime.shellAvailability().available;

  test.if(shellOk)("执行中部分输出经 onToolPartialOutput 回写", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "stream" });
    const conversation = bindConversation(workspace.id);
    const partials: string[] = [];
    const result = await runtime.runWorkspaceTool(
      "bash",
      { command: "echo first; sleep 0.3; echo second" },
      {
        conversationId: conversation.id,
        onToolPartialOutput: (output) => partials.push(output.map((o) => ("text" in o ? o.text : "")).join("")),
      },
    );
    const finalText = result.output.map((o) => ("text" in o ? o.text : "")).join("");
    expect(finalText).toContain("first");
    expect(finalText).toContain("second");
    // pi 内核 100ms 节流下至少应有一次仅含 first 的中间帧
    expect(partials.some((text) => text.includes("first") && !text.includes("second"))).toBe(true);
  }, 15_000);

  test.if(shellOk)("abort 杀进程树:长命令即时终止且报 Command aborted", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "abort" });
    const conversation = bindConversation(workspace.id);
    const controller = new AbortController();
    const started = Date.now();
    const pending = runtime.runWorkspaceTool(
      "bash",
      { command: "sleep 30" },
      { conversationId: conversation.id, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toThrow(/Command aborted/);
    expect(Date.now() - started).toBeLessThan(10_000); // 没等满 30s = 进程树被杀
  }, 15_000);

  test.if(shellOk)("超时终止:timeout 生效并报 timed out", async () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "timeout" });
    const conversation = bindConversation(workspace.id);
    await expect(
      runtime.runWorkspaceTool("bash", { command: "sleep 30", timeout: 1 }, { conversationId: conversation.id }),
    ).rejects.toThrow(/timed out after 1 seconds/);
  }, 15_000);
});
