// pi-engine/builtin-tools.test.ts — 工作区工具 = pi 内建定义 + 应用后端 + 执行前审批(P4b.1)
//
// 锁定:①挂载矩阵(有 bash 四件、无 bash 六件)与排除名单互补;②每个工具带审批闸门标记、顺序执行,
// 提示词摘要取 pi 常量原值(bash 不暴露 PI_* 会话环境条目);③执行前先审批,类别与对象来自映射表
// (路径是 pi 实际要操作的绝对路径);④放行范围决定边界:default 写入出界被拒、unrestricted 走宽界;
// 危险命令没拿到 unrestricted 不执行;⑤结果细节打成 {workspace:{tool,details}},bash 终局补 exitCode;
// ⑥grep / find 不依赖外部程序 rg / fd。
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-pibuiltin-test-"));

const { createPiBuiltinTools, excludedPiBuiltinToolNames, piBuiltinToolNames } = await import("./builtin-tools");
const { isToolGated } = await import("./tool-gate");
const { shellAvailability } = await import("../workspace/runtime");
const { allToolNames } = await import("../../pi/packages/coding-agent/src/core/tools/index.ts");
const piContributions: Record<string, { snippet: string; guidelines: readonly string[] }> = {
  read: (await import("../../pi/packages/coding-agent/src/core/tools/read.ts")).readToolSystemPromptContribution,
  bash: (await import("../../pi/packages/coding-agent/src/core/tools/bash.ts")).bashToolSystemPromptContribution,
  edit: (await import("../../pi/packages/coding-agent/src/core/tools/edit.ts")).editToolSystemPromptContribution,
  write: (await import("../../pi/packages/coding-agent/src/core/tools/write.ts")).writeToolSystemPromptContribution,
  grep: (await import("../../pi/packages/coding-agent/src/core/tools/grep.ts")).grepToolSystemPromptContribution,
  find: (await import("../../pi/packages/coding-agent/src/core/tools/find.ts")).findToolSystemPromptContribution,
  ls: (await import("../../pi/packages/coding-agent/src/core/tools/ls.ts")).lsToolSystemPromptContribution,
};
import type { PermissionGrant } from "../engines/contract";
import type { PiBuiltinToolApproval } from "./builtin-tools";

type ExecResult = { content: Array<{ type: string; text?: string }>; details: Record<string, unknown>; isError?: boolean };
type Exec = (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: (partial: ExecResult) => void) => Promise<ExecResult>;

const shell = shellAvailability().shell;

function setup(scope: PermissionGrant["scope"] = "default", withShell?: string) {
  const root = mkdtempSync(join(tmpdir(), "rkh-pibuiltin-ws-"));
  const approvals: PiBuiltinToolApproval[] = [];
  const tools = createPiBuiltinTools({
    cwd: root,
    root,
    ...(withShell ? { shell: withShell } : {}),
    approve: async (req) => {
      approvals.push(req);
      return { scope };
    },
  });
  const exec = (name: string): Exec => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`未挂载 ${name}`);
    return tool.execute as unknown as Exec;
  };
  return { root, approvals, tools, exec };
}

const text = (result: ExecResult) => result.content.map((block) => block.text ?? "").join("");

describe("挂载与形状", () => {
  test("有 bash 四件、无 bash 六件;排除名单与挂载互补,覆盖 pi 全部内建名", () => {
    expect(piBuiltinToolNames("/bin/bash")).toEqual(["read", "bash", "edit", "write"]);
    expect(piBuiltinToolNames(undefined)).toEqual(["read", "edit", "write", "grep", "find", "ls"]);
    for (const shellPath of ["/bin/bash", undefined]) {
      const union = [...piBuiltinToolNames(shellPath), ...excludedPiBuiltinToolNames(shellPath)].toSorted();
      expect(union).toEqual([...allToolNames].toSorted());
    }
    expect(excludedPiBuiltinToolNames(undefined)).toContain("powershell");
  });

  test("每个工具带审批闸门标记、顺序执行;提示词摘要取 pi 常量,bash 不带 PI_* 会话环境条目", () => {
    const { tools } = setup("default", shell ?? "/bin/bash");
    const { tools: fallback } = setup();
    for (const tool of [...tools, ...fallback]) {
      expect(isToolGated(tool)).toBe(true);
      expect(tool.executionMode).toBe("sequential");
      const contribution = piContributions[tool.name]!;
      expect(tool.promptSnippet).toBe(contribution.snippet);
      if (tool.name === "bash") expect(tool.promptGuidelines).toBeUndefined();
      else if (contribution.guidelines.length > 0) expect(tool.promptGuidelines).toEqual([...contribution.guidelines]);
    }
  });
});

describe("执行前审批与放行范围", () => {
  test("审批先于执行:类别与对象来自映射表,路径是绝对路径", async () => {
    const { root, approvals, exec } = setup();
    await exec("write")("tc-1", { path: "a.txt", content: "hello" });
    expect(approvals).toEqual([
      { toolCallId: "tc-1", toolName: "write", category: "write", target: { path: resolve(root, "a.txt") }, args: { path: "a.txt", content: "hello" } },
    ]);
    const read = await exec("read")("tc-2", { path: "a.txt" });
    expect(text(read)).toContain("hello");
    expect(approvals[1]).toMatchObject({ toolName: "read", category: "read", target: { path: resolve(root, "a.txt") } });
  });

  test("审批以错误拒绝 → 不执行,错误原样抛给 pi", async () => {
    const root = mkdtempSync(join(tmpdir(), "rkh-pibuiltin-deny-"));
    const [write] = createPiBuiltinTools({
      cwd: root,
      root,
      approve: async () => {
        throw new Error("Tool execution denied by user. Reason: 不行");
      },
    }).filter((tool) => tool.name === "write");
    await expect((write!.execute as unknown as Exec)("tc-3", { path: "x.txt", content: "x" })).rejects.toThrow("Tool execution denied by user");
    expect(existsSync(join(root, "x.txt"))).toBe(false);
  });

  test("default 范围:写入出界被边界拒绝;unrestricted:走宽界写到区外", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "rkh-pibuiltin-outside-"));
    const target = join(outsideDir, "out.txt");
    const strict = setup("default");
    await expect(strict.exec("write")("tc-4", { path: target, content: "x" })).rejects.toThrow("outside the workspace boundary");
    expect(existsSync(target)).toBe(false);
    const wide = setup("unrestricted");
    await wide.exec("write")("tc-5", { path: target, content: "wide" });
    expect(readFileSync(target, "utf-8")).toBe("wide");
    rmSync(outsideDir, { recursive: true, force: true });
  });

  test("edit 同样按范围选边界,结果细节带 diff", async () => {
    const { root, exec } = setup();
    writeFileSync(join(root, "e.txt"), "one\ntwo\n");
    const result = await exec("edit")("tc-6", { path: "e.txt", edits: [{ oldText: "two", newText: "three" }] });
    expect(readFileSync(join(root, "e.txt"), "utf-8")).toBe("one\nthree\n");
    const marker = result.details.workspace as { tool: string; details: Record<string, unknown> };
    expect(marker.tool).toBe("edit");
    expect(typeof marker.details.diff).toBe("string");
  });
});

describe("兜底搜索(无 bash)", () => {
  test("find 走应用的 glob 实现,grep 走纯 TS 实现;都受边界约束", async () => {
    const { root, exec } = setup();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "const needle = 1;\n");
    writeFileSync(join(root, "b.md"), "no match here\n");
    expect(text(await exec("find")("tc-7", { pattern: "*.ts" }))).toContain("src/a.ts");
    expect(text(await exec("grep")("tc-8", { pattern: "needle" }))).toContain("a.ts");
    expect(text(await exec("ls")("tc-9", {}))).toContain("src/");
    const outside = mkdtempSync(join(tmpdir(), "rkh-pibuiltin-ls-outside-"));
    await expect(exec("ls")("tc-10", { path: outside })).rejects.toThrow("outside the workspace boundary");
    rmSync(outside, { recursive: true, force: true });
  });
});

describe.skipIf(!shell)("bash", () => {
  test("终局细节带 exitCode 0;执行中 partial 也打细节标记", async () => {
    const { exec } = setup("default", shell);
    const partials: ExecResult[] = [];
    const result = await exec("bash")("tc-11", { command: "echo first; sleep 0.3; echo second" }, undefined, (partial) => partials.push(partial));
    expect(text(result)).toContain("second");
    expect((result.details.workspace as { details: Record<string, unknown> }).details.exitCode).toBe(0);
    for (const partial of partials) {
      const marker = partial.details.workspace as { tool: string; details: Record<string, unknown> } | undefined;
      if (marker) {
        expect(marker.tool).toBe("bash");
        expect("exitCode" in marker.details).toBe(false);
      }
    }
  });

  test("非零退出:pi 记错误结果(exitCode 由 structuredContent 补回)", async () => {
    const { exec } = setup("default", shell);
    const outcome = await exec("bash")("tc-12", { command: "exit 3" }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    // pi 1.5.1 非零退出返回 isError 结果(不抛);若上游改回抛错,这里同样能看出来。
    if ("result" in outcome) {
      expect(outcome.result.isError).toBe(true);
      expect((outcome.result.details.workspace as { details: Record<string, unknown> }).details.exitCode).toBe(3);
    } else {
      expect(String(outcome.error)).toContain("3");
    }
  });

  test("危险命令:default 范围不执行;unrestricted 范围放行", async () => {
    // 命中危险清单但永远不会真删:`true ||` 短路,rm 那一段不执行。
    const command = "echo ran; true || rm -rf /usr/rkh-never-exists";
    const strict = setup("default", shell);
    await expect(strict.exec("bash")("tc-13", { command })).rejects.toThrow("Command blocked by safety policy");
    expect(strict.approvals[0]).toMatchObject({ toolName: "bash", category: "execute", target: { command } });
    const wide = setup("unrestricted", shell);
    expect(text(await wide.exec("bash")("tc-14", { command }))).toContain("ran");
  });
});
