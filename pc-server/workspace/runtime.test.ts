// workspace/runtime.test.ts — 工作区运行时:会话 → 工作区的三道闸与 cwd 解析,bash 执行后端的硬化
// 工作区工具 P4b 起是 pi 内建定义 + 应用后端:审批与边界的固定用例在 pi-engine/builtin-tools-parity.test.ts,
// 包装与挂载矩阵在 pi-engine/builtin-tools.test.ts;这里只测本模块与 bash 后端(超时夹取、流式、中止、超时)。
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// paths.ts 在 import 时刻固化 dataDir——必须先设环境变量再动态加载被测模块。
process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-runtime-test-"));

const conversations = await import("../conversations");
const { configureWorkingSet } = await import("../conversations/working-set");
const { getConversationMeta } = await import("../conversations/read-queries");
const ws = await import("./index");
const runtime = await import("./runtime");
const { BASH_HARD_TIMEOUT_SECONDS, clampBashTimeoutSeconds } = await import("./boundary");
const { createPiBuiltinTools } = await import("../pi-engine/builtin-tools");

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

const conversation = (workspaceId: string | null, workspaceCwd: string | null = null) => ({ workspaceId, workspaceCwd });

describe("会话 → 工作区(三道闸)", () => {
  test("非工作区会话 / 工作区已删除:不可用", () => {
    expect(runtime.workspaceRuntimeForConversation(null)).toBeNull();
    expect(runtime.workspaceRuntimeForConversation(conversation(null))).toBeNull();
    const workspace = ws.createWorkspace({ type: "managed", name: "gone" });
    db.exec(`DELETE FROM pc_workspace WHERE id = '${workspace.id}'`);
    expect(runtime.workspaceRuntimeForConversation(conversation(workspace.id))).toBeNull();
  });

  test("folder 工作区未过信任门不可用;信任后可用;根目录丢失又不可用", () => {
    const root = mkdtempSync(join(tmpdir(), "rkh-folder-"));
    const workspace = ws.createWorkspace({ type: "folder", root });
    expect(runtime.workspaceRuntimeForConversation(conversation(workspace.id))).toBeNull();
    ws.trustWorkspace(workspace.id);
    expect(runtime.workspaceRuntimeForConversation(conversation(workspace.id))?.root).toBe(workspace.root);
    rmSync(root, { recursive: true, force: true });
    expect(runtime.workspaceRuntimeForConversation(conversation(workspace.id))).toBeNull();
  });

  test("cwd:缺省 = root;区内子目录生效;越界或已删除自愈回 root", () => {
    const workspace = ws.createWorkspace({ type: "managed", name: "cwd" });
    const sub = join(workspace.root, "sub");
    mkdirSync(sub);
    const cwdOf = (value: string | null) => runtime.workspaceRuntimeForConversation(conversation(workspace.id, value))!.cwd;
    expect(cwdOf(null)).toBe(workspace.root);
    expect(cwdOf(sub)).toBe(sub);
    expect(cwdOf("sub")).toBe(sub);
    expect(cwdOf(join(workspace.root, ".."))).toBe(workspace.root);
    expect(cwdOf(join(workspace.root, "deleted"))).toBe(workspace.root);
  });
});

describe("bash 执行后端硬化(M1-5)", () => {
  test("timeout 夹取:缺省/超限 → 30min 硬上限;合法值透传", () => {
    expect(clampBashTimeoutSeconds(undefined)).toBe(BASH_HARD_TIMEOUT_SECONDS);
    expect(clampBashTimeoutSeconds(999_999)).toBe(BASH_HARD_TIMEOUT_SECONDS);
    expect(clampBashTimeoutSeconds(60)).toBe(60);
    expect(clampBashTimeoutSeconds(-5)).toBe(BASH_HARD_TIMEOUT_SECONDS);
    expect(clampBashTimeoutSeconds(Number.NaN)).toBe(BASH_HARD_TIMEOUT_SECONDS);
  });

  const shell = runtime.shellAvailability().shell;
  type Result = { content: Array<{ type: string; text?: string }> };
  type Exec = (id: string, params: unknown, signal?: AbortSignal, onUpdate?: (partial: Result) => void) => Promise<Result>;

  function bash(): Exec {
    const root = mkdtempSync(join(tmpdir(), "rkh-runtime-bash-"));
    const tools = createPiBuiltinTools({ cwd: root, root, shell: shell!, approve: async () => ({ scope: "default" }) });
    return tools.find((tool) => tool.name === "bash")!.execute as unknown as Exec;
  }
  const textOf = (result: Result) => result.content.map((entry) => entry.text ?? "").join("");

  test.if(Boolean(shell))("执行中部分输出经 onUpdate 回写", async () => {
    const partials: string[] = [];
    const result = await bash()("c-stream", { command: "echo first; sleep 0.3; echo second" }, undefined, (partial) => partials.push(textOf(partial)));
    expect(textOf(result)).toContain("first");
    expect(textOf(result)).toContain("second");
    // pi 内核节流下至少应有一次仅含 first 的中间帧
    expect(partials.some((text) => text.includes("first") && !text.includes("second"))).toBe(true);
  }, 15_000);

  test.if(Boolean(shell))("abort 杀进程树:长命令即时终止且报 Command aborted", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = bash()("c-abort", { command: "sleep 30" }, controller.signal);
    setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toThrow(/Command aborted/);
    expect(Date.now() - started).toBeLessThan(10_000); // 没等满 30s = 进程树被杀
  }, 15_000);

  test.if(Boolean(shell))("超时终止:timeout 生效并报 timed out", async () => {
    await expect(bash()("c-timeout", { command: "sleep 30", timeout: 1 })).rejects.toThrow(/timed out after 1 seconds/);
  }, 15_000);
});
