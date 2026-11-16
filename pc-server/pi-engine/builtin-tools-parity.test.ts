// pi-engine/builtin-tools-parity.test.ts — 工作区工具切换前后的平价(P4b.3,P4b.4 起只锁内建版)
//
// 一组固定用例,每个用例的期望写死:审批卡经历的状态(含缘由)、成败与模型可见结果、工具卡细节、文件副作用。
// 这些期望是 P4b.3 时移植版(应用工具时期的路径)与 pi 内建版逐项对照、两边都命中的结果;P4b.4 删除移植层后
// 留下来锁 pi 内建版(createPiBuiltinTools,执行前经生产同款 createToolPermissionChecker 审批)。
// 已知差异只有 write 的结果文本(移植版带字节数,内建版字节数在工具卡细节里,P4b.2)。
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-parity-test-"));

const conversations = await import("../conversations");
const { configureWorkingSet } = await import("../conversations/working-set");
const { getConversationMeta } = await import("../conversations/read-queries");
const ws = await import("../workspace");
const { shellAvailability } = await import("../workspace/runtime");
const { createToolPermissionChecker } = await import("../engines/app-tools");
const { resolveToolApproval } = await import("../inference-engine/approval-gate");
const { createPiBuiltinTools } = await import("./builtin-tools");
import type { AppToolsContext } from "../engines/app-tools";
import type { GenerationEvent } from "../inference-engine/events";
import type { JsonValue, WorkspacePermissionPreset } from "../foundation/types";

const db = conversations.openConversationsDb();
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

const shellPath = shellAvailability().shell;
const fakeAssistant = { id: "a1", name: "A", systemPrompt: "", mcpServers: [] } as never;
/** 1×1 PNG。 */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const DANGER = "echo ran > ran.txt; true || rm -rf /usr/rkh-never-exists";

function canSymlink(): boolean {
  try {
    const host = mkdtempSync(join(tmpdir(), "rkh-parity-link-"));
    symlinkSync(host, join(host, "probe"), "junction");
    return true;
  } catch {
    return false;
  }
}

// ----- 统一跑法 -----

type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Card = { tool: string; details: Record<string, JsonValue> };
type Outcome = { ok: true; content: Block[]; card?: Card } | { ok: false; error: string };
interface Run {
  approvals: Array<{ type: string; reason?: string }>;
  outcome: Outcome;
}

interface Fixture {
  root: string;
  outside: string;
  conversationId: string;
  ctx: AppToolsContext;
  events: GenerationEvent[];
  shell?: string;
}

interface Call {
  id: string;
  name: string;
  args: Record<string, JsonValue>;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const textOf = (content: Block[]) => content.map((block) => (block.type === "text" ? block.text : "")).join("");

let seq = 0;
function fixture(preset: WorkspacePermissionPreset, withShell: boolean): Fixture {
  seq += 1;
  const workspace = ws.createWorkspace({ type: "managed", name: `parity-${seq}` });
  ws.updateWorkspace(workspace.id, { permissionPreset: preset });
  const conversation = {
    id: `parity-conv-${seq}`,
    assistantId: "a1",
    systemPrompt: null,
    title: `t-${seq}`,
    messages: [],
    chatSuggestions: [],
    isPinned: false,
    createAt: 1000,
    updateAt: 2000,
    workspaceId: workspace.id,
    workspaceCwd: null,
  };
  conversations.persistConversation(conversation);
  const events: GenerationEvent[] = [];
  return {
    root: workspace.root,
    outside: mkdtempSync(join(tmpdir(), "rkh-parity-out-")),
    conversationId: conversation.id,
    ctx: { conversation: conversation as never, assistant: fakeAssistant, sink: (event) => void events.push(event) },
    events,
    ...(withShell && shellPath ? { shell: shellPath } : {}),
  };
}

type PiExec = (toolCallId: string, params: unknown) => Promise<{ content: Block[]; details?: Record<string, unknown>; isError?: boolean }>;

/** 生产同款审批口(createToolPermissionChecker,来源 engine)。isError 结果与抛错一样落 {error}。 */
async function execute(fx: Fixture, call: Call): Promise<Outcome> {
  const check = createToolPermissionChecker(fx.ctx);
  const tools = createPiBuiltinTools({
    cwd: fx.root,
    root: fx.root,
    ...(fx.shell ? { shell: fx.shell } : {}),
    approve: (req) => check({ ...req, origin: { kind: "engine" } }),
  });
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (!tool) throw new Error(`未挂载 ${call.name}`);
  try {
    const result = await (tool.execute as unknown as PiExec)(call.id, call.args);
    if (result.isError) return { ok: false, error: textOf(result.content) };
    const card = (result.details as { workspace?: Card } | undefined)?.workspace;
    return { ok: true, content: result.content, ...(card ? { card } : {}) };
  } catch (err) {
    return { ok: false, error: messageOf(err) };
  }
}

async function waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function approvalsOf(fx: Fixture): Run["approvals"] {
  return fx.events
    .filter((event) => event.kind === "tool_approval_updated")
    .map((event) => (event as { approvalState: { type: string; reason?: string } }).approvalState);
}

/** 跑一次;带 decide 的用例要先看到 pending 卡,再按 decide 作答。 */
async function runOnce(fx: Fixture, call: Call, decide?: { approved: boolean; reason?: string }): Promise<Run> {
  const running = execute(fx, call);
  if (decide) {
    await waitUntil(() => approvalsOf(fx).some((state) => state.type === "pending"));
    expect(resolveToolApproval(fx.conversationId, call.id, decide)).toBe(true);
  }
  const outcome = await running;
  return { approvals: approvalsOf(fx), outcome };
}

// ----- 固定用例 -----

interface Case {
  name: string;
  /** 缺省 balanced。 */
  preset?: WorkspacePermissionPreset;
  /** true = 有 bash 的挂载矩阵(本机没有 bash 则跳过);缺省 = 无 bash 矩阵(read / edit / write + 兜底搜索)。 */
  bash?: boolean;
  skip?: boolean;
  prepare?: (fx: Fixture) => void;
  call: (fx: Fixture) => Call;
  decide?: { approved: boolean; reason?: string };
  check: (run: Run, fx: Fixture) => void;
}

function okContent(run: Run): Block[] {
  if (!run.outcome.ok) throw new Error(`预期成功,实际失败:${run.outcome.error}`);
  return run.outcome.content;
}

function failure(run: Run): string {
  if (run.outcome.ok) throw new Error(`预期失败,实际成功:${textOf(run.outcome.content)}`);
  return run.outcome.error;
}

const PENDING_THEN_APPROVED = [{ type: "pending" }, { type: "approved" }];
const DENIED_TEXT = "Tool execution denied by user. Reason: 不行";
const DENY = { approved: false, reason: "不行" };
const APPROVE = { approved: true };

/** write 的结果:文本不带字节数,字节数在工具卡细节里(P4b.2)。 */
function expectWriteReceipt(run: Run, path: string, bytes: number): void {
  expect(run.outcome).toEqual({ ok: true, content: [{ type: "text", text: `Successfully wrote to ${path}` }], card: { tool: "write", details: { bytes } } });
}

const CASES: Case[] = [
  {
    name: "读文本:免审,原文返回,不带工具卡细节",
    prepare: (fx) => writeFileSync(join(fx.root, "a.txt"), "line1\nline2\n"),
    call: () => ({ id: "c-read", name: "read", args: { path: "a.txt" } }),
    check: (run) => {
      expect(run.approvals).toEqual([]);
      expect(run.outcome).toEqual({ ok: true, content: [{ type: "text", text: "line1\nline2\n" }] });
    },
  },
  {
    name: "读区间:offset / limit 与续读提示",
    prepare: (fx) => writeFileSync(join(fx.root, "long.txt"), Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join("\n")),
    call: () => ({ id: "c-range", name: "read", args: { path: "long.txt", offset: 10, limit: 5 } }),
    check: (run) => {
      const text = textOf(okContent(run));
      expect(text).toContain("line-10");
      expect(text).toContain("line-14");
      expect(text).not.toContain("line-15\n");
      expect(text).toContain("[86 more lines in file. Use offset=15 to continue.]");
    },
  },
  {
    name: "读图片:原样交给模型(不缩放)",
    prepare: (fx) => writeFileSync(join(fx.root, "p.png"), Buffer.from(PNG_BASE64, "base64")),
    call: () => ({ id: "c-image", name: "read", args: { path: "p.png" } }),
    check: (run) => {
      expect(okContent(run)).toEqual([
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: PNG_BASE64, mimeType: "image/png" },
      ]);
    },
  },
  {
    name: "读区外文件:读三档全宽,免审",
    prepare: (fx) => writeFileSync(join(fx.outside, "o.txt"), "outside-data"),
    call: (fx) => ({ id: "c-read-out", name: "read", args: { path: join(fx.outside, "o.txt") } }),
    check: (run) => {
      expect(run.approvals).toEqual([]);
      expect(textOf(okContent(run))).toBe("outside-data");
    },
  },
  {
    name: "读不存在的文件:报错",
    call: () => ({ id: "c-read-missing", name: "read", args: { path: "missing.txt" } }),
    check: (run) => expect(failure(run)).toMatch(/ENOENT|no such file|not found/i),
  },
  {
    name: "读超过 512KB:体积闸门报错并引导分段",
    prepare: (fx) => writeFileSync(join(fx.root, "big.txt"), Buffer.alloc(512 * 1024 + 1, 0x61)),
    call: () => ({ id: "c-read-big", name: "read", args: { path: "big.txt" } }),
    check: (run) => expect(failure(run)).toContain("read limit"),
  },
  {
    name: "写新文件(区内,自动建父目录):免审",
    call: () => ({ id: "c-write", name: "write", args: { path: "src/new.txt", content: "hello\n" } }),
    check: (run, fx) => {
      expect(run.approvals).toEqual([]);
      expectWriteReceipt(run, "src/new.txt", 6);
      expect(readFileSync(join(fx.root, "src", "new.txt"), "utf-8")).toBe("hello\n");
    },
  },
  {
    name: "写入超过 2MB:体积闸门报错,不落盘",
    call: () => ({ id: "c-write-big", name: "write", args: { path: "huge.txt", content: "x".repeat(2 * 1024 * 1024 + 1) } }),
    check: (run, fx) => {
      expect(failure(run)).toContain("write limit");
      expect(existsSync(join(fx.root, "huge.txt"))).toBe(false);
    },
  },
  {
    name: "balanced 区外写入:待审批(缘由带路径)→ 批准 → 走宽界写到区外",
    call: (fx) => ({ id: "c-write-out", name: "write", args: { path: join(fx.outside, "w.txt"), content: "wide" } }),
    decide: APPROVE,
    check: (run, fx) => {
      expect(run.approvals).toEqual([{ type: "pending", reason: `Writes outside the workspace: ${join(fx.outside, "w.txt")}` }, { type: "approved" }]);
      expectWriteReceipt(run, join(fx.outside, "w.txt"), 4);
      expect(readFileSync(join(fx.outside, "w.txt"), "utf-8")).toBe("wide");
    },
  },
  {
    name: "balanced 区外写入:拒绝 → 历史契约文案,不落盘",
    call: (fx) => ({ id: "c-write-out-deny", name: "write", args: { path: join(fx.outside, "d.txt"), content: "x" } }),
    decide: DENY,
    check: (run, fx) => {
      expect(run.approvals.map((state) => state.type)).toEqual(["pending", "denied"]);
      expect(run.approvals[1]).toEqual({ type: "denied", reason: "不行" });
      expect(failure(run)).toBe(DENIED_TEXT);
      expect(existsSync(join(fx.outside, "d.txt"))).toBe(false);
    },
  },
  {
    name: "full_access 区外写入:免审,直接写到区外",
    preset: "full_access",
    call: (fx) => ({ id: "c-write-full", name: "write", args: { path: join(fx.outside, "f.txt"), content: "full" } }),
    check: (run, fx) => {
      expect(run.approvals).toEqual([]);
      expectWriteReceipt(run, join(fx.outside, "f.txt"), 4);
      expect(readFileSync(join(fx.outside, "f.txt"), "utf-8")).toBe("full");
    },
  },
  {
    name: "confirm_each 区内写入:每次都问(无缘由)→ 批准后落盘",
    preset: "confirm_each",
    call: () => ({ id: "c-write-confirm", name: "write", args: { path: "c.txt", content: "ok" } }),
    decide: APPROVE,
    check: (run, fx) => {
      expect(run.approvals).toEqual(PENDING_THEN_APPROVED);
      expectWriteReceipt(run, "c.txt", 2);
      expect(readFileSync(join(fx.root, "c.txt"), "utf-8")).toBe("ok");
    },
  },
  {
    name: "软链逃逸:词法在区内故免审,严界按真实路径拒绝",
    skip: !canSymlink(),
    prepare: (fx) => symlinkSync(fx.outside, join(fx.root, "link"), "junction"),
    call: () => ({ id: "c-write-link", name: "write", args: { path: "link/escape.txt", content: "x" } }),
    check: (run, fx) => {
      expect(run.approvals).toEqual([]);
      expect(failure(run)).toContain("outside the workspace boundary");
      expect(existsSync(join(fx.outside, "escape.txt"))).toBe(false);
    },
  },
  {
    name: "Windows 保留设备名:写入被拒",
    skip: process.platform !== "win32",
    call: () => ({ id: "c-write-nul", name: "write", args: { path: "nul", content: "x" } }),
    check: (run) => expect(failure(run)).toContain("reserved Windows device name"),
  },
  {
    name: "多处编辑:一次替换两块,工具卡带 diff / patch",
    prepare: (fx) => writeFileSync(join(fx.root, "e.txt"), "one\ntwo\nthree\nfour\n"),
    call: () => ({ id: "c-edit", name: "edit", args: { path: "e.txt", edits: [{ oldText: "two", newText: "TWO" }, { oldText: "four", newText: "FOUR" }] } }),
    check: (run, fx) => {
      expect(textOf(okContent(run))).toBe("Successfully replaced 2 block(s) in e.txt.");
      const card = (run.outcome as { card?: Card }).card;
      expect(card?.tool).toBe("edit");
      expect(String(card?.details.diff)).toContain("+2 TWO");
      expect(String(card?.details.patch)).toContain("@@");
      expect(readFileSync(join(fx.root, "e.txt"), "utf-8")).toBe("one\nTWO\nthree\nFOUR\n");
    },
  },
  {
    name: "编辑找不到原文:报错,文件不变",
    prepare: (fx) => writeFileSync(join(fx.root, "n.txt"), "alpha\n"),
    call: () => ({ id: "c-edit-miss", name: "edit", args: { path: "n.txt", edits: [{ oldText: "missing", newText: "x" }] } }),
    check: (run, fx) => {
      expect(failure(run)).toContain("Could not find the exact text");
      expect(readFileSync(join(fx.root, "n.txt"), "utf-8")).toBe("alpha\n");
    },
  },
  {
    name: "balanced 区外编辑:待审批 → 拒绝,文件不变",
    prepare: (fx) => writeFileSync(join(fx.outside, "o.txt"), "keep"),
    call: (fx) => ({ id: "c-edit-out", name: "edit", args: { path: join(fx.outside, "o.txt"), edits: [{ oldText: "keep", newText: "lost" }] } }),
    decide: DENY,
    check: (run, fx) => {
      expect(run.approvals.map((state) => state.type)).toEqual(["pending", "denied"]);
      expect(failure(run)).toBe(DENIED_TEXT);
      expect(readFileSync(join(fx.outside, "o.txt"), "utf-8")).toBe("keep");
    },
  },
  {
    name: "命令成功:免审,输出原样,工具卡 exitCode 0",
    bash: true,
    call: () => ({ id: "c-bash", name: "bash", args: { command: "echo hi" } }),
    check: (run) => {
      expect(run.approvals).toEqual([]);
      expect(run.outcome).toEqual({ ok: true, content: [{ type: "text", text: "hi\n" }], card: { tool: "bash", details: { exitCode: 0 } } });
    },
  },
  {
    name: "命令非零退出:失败,输出 + 退出码文案",
    bash: true,
    call: () => ({ id: "c-bash-exit", name: "bash", args: { command: "echo out; exit 3" } }),
    check: (run) => expect(failure(run)).toBe("out\n\n\nCommand exited with code 3"),
  },
  {
    name: "命令超时:按 timeout 终止",
    bash: true,
    call: () => ({ id: "c-bash-timeout", name: "bash", args: { command: "sleep 30", timeout: 1 } }),
    check: (run) => expect(failure(run)).toContain("Command timed out after 1 seconds"),
  },
  {
    name: "confirm_each 命令:待审批(无缘由)→ 拒绝,不执行",
    preset: "confirm_each",
    bash: true,
    call: () => ({ id: "c-bash-deny", name: "bash", args: { command: "echo x > denied.txt" } }),
    decide: DENY,
    check: (run, fx) => {
      expect(run.approvals).toEqual([{ type: "pending" }, { type: "denied", reason: "不行" }]);
      expect(failure(run)).toBe(DENIED_TEXT);
      expect(existsSync(join(fx.root, "denied.txt"))).toBe(false);
    },
  },
  {
    name: "balanced 危险命令:待审批(缘由带危险说明)→ 拒绝,不执行",
    bash: true,
    call: () => ({ id: "c-danger-deny", name: "bash", args: { command: DANGER } }),
    decide: DENY,
    check: (run, fx) => {
      expect(run.approvals[0]).toEqual({ type: "pending", reason: "Destructive command pattern: recursive force-delete of a system directory" });
      expect(failure(run)).toBe(DENIED_TEXT);
      expect(existsSync(join(fx.root, "ran.txt"))).toBe(false);
    },
  },
  {
    name: "balanced 危险命令:批准即知情同意,放行执行",
    bash: true,
    call: () => ({ id: "c-danger-ok", name: "bash", args: { command: DANGER } }),
    decide: APPROVE,
    check: (run, fx) => {
      expect(run.approvals.map((state) => state.type)).toEqual(["pending", "approved"]);
      expect(run.outcome.ok).toBe(true);
      expect(existsSync(join(fx.root, "ran.txt"))).toBe(true);
    },
  },
  {
    name: "full_access 危险命令:免审,放行执行",
    preset: "full_access",
    bash: true,
    call: () => ({ id: "c-danger-full", name: "bash", args: { command: DANGER } }),
    check: (run, fx) => {
      expect(run.approvals).toEqual([]);
      expect(existsSync(join(fx.root, "ran.txt"))).toBe(true);
    },
  },
  {
    name: "grep(无 bash):匹配行格式 path:line: text,免审",
    prepare: (fx) => {
      mkdirSync(join(fx.root, "src"));
      writeFileSync(join(fx.root, "src", "a.ts"), "const needle = 1;\n");
    },
    call: () => ({ id: "c-grep", name: "grep", args: { pattern: "needle" } }),
    check: (run) => {
      expect(run.approvals).toEqual([]);
      expect(textOf(okContent(run))).toBe("src/a.ts:1: const needle = 1;");
    },
  },
  {
    name: "find(无 bash):glob 命中相对路径",
    prepare: (fx) => {
      mkdirSync(join(fx.root, "src"));
      writeFileSync(join(fx.root, "src", "a.ts"), "x");
      writeFileSync(join(fx.root, "b.md"), "x");
    },
    call: () => ({ id: "c-find", name: "find", args: { pattern: "*.ts" } }),
    check: (run) => expect(textOf(okContent(run))).toBe("src/a.ts"),
  },
  {
    name: "ls(无 bash):字典序,目录带尾 /",
    prepare: (fx) => {
      mkdirSync(join(fx.root, "src"));
      writeFileSync(join(fx.root, "b.md"), "x");
    },
    call: () => ({ id: "c-ls", name: "ls", args: {} }),
    check: (run) => expect(textOf(okContent(run))).toBe("b.md\nsrc/"),
  },
  ...(["grep", "find", "ls"] as const).map((name): Case => ({
    name: `${name}(无 bash):区外路径被边界拒绝,免审`,
    call: (fx): Call => ({ id: `c-${name}-out`, name, args: name === "ls" ? { path: fx.outside } : { pattern: "x", path: fx.outside } }),
    check: (run) => {
      expect(run.approvals).toEqual([]);
      expect(failure(run)).toContain("outside the workspace boundary");
    },
  })),
];

describe("固定用例(切换前后平价的期望)", () => {
  for (const testCase of CASES) {
    const skip = Boolean(testCase.skip) || (testCase.bash === true && !shellPath);
    test.skipIf(skip)(testCase.name, async () => {
      const fx = fixture(testCase.preset ?? "balanced", testCase.bash === true);
      testCase.prepare?.(fx);
      testCase.check(await runOnce(fx, testCase.call(fx), testCase.decide), fx);
    }, 15_000);
  }
});

describe("没有工具卡的调用(插件另开的子会话,noPrompt)", () => {
  test("需要用户确认的直接拒绝、不弹审批;免审的照常放行", async () => {
    const fx = fixture("confirm_each", false);
    const check = createToolPermissionChecker(fx.ctx);
    const base = { origin: { kind: "engine" as const }, args: {}, noPrompt: true };
    await expect(check({ ...base, toolCallId: "np-write", toolName: "write", category: "write", target: { path: join(fx.root, "a.txt") } })).rejects.toThrow(
      "cannot ask for it",
    );
    expect(approvalsOf(fx)).toEqual([]);
    expect(await check({ ...base, toolCallId: "np-read", toolName: "read", category: "read", target: { path: join(fx.root, "a.txt") } })).toEqual({ scope: "default" });
  });
});
