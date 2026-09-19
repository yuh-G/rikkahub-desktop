// workspace/approval.test.ts — 审批矩阵(三档改版)与危险命令清单单测(纯函数层)
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  findDangerousCommandReason,
  isWorkspaceToolName,
  lexicalWorkspaceCwd,
  workspaceCallApprovalReason,
  workspaceToolNeedsApproval,
} from "./approval";

// 词法判定不碰文件系统,root/cwd 无需真实存在
const ROOT = join(tmpdir(), "rkh-approval-root");
const CTX = { root: ROOT, cwd: ROOT };

describe("无参数下界(建卡态)", () => {
  test("read 任何档位免审", () => {
    expect(workspaceToolNeedsApproval("read", "confirm_each")).toBe(false);
    expect(workspaceToolNeedsApproval("read", "balanced")).toBe(false);
    expect(workspaceToolNeedsApproval("read", "full_access")).toBe(false);
  });

  test("仅 confirm_each 的非 read 工具在参数未到时即可断定审批", () => {
    for (const tool of ["write", "edit", "bash"] as const) {
      expect(workspaceToolNeedsApproval(tool, "confirm_each")).toBe(true);
      expect(workspaceToolNeedsApproval(tool, "balanced")).toBe(false);
      expect(workspaceToolNeedsApproval(tool, "full_access")).toBe(false);
    }
  });

  test("工具名判别", () => {
    expect(isWorkspaceToolName("read")).toBe(true);
    expect(isWorkspaceToolName("bash")).toBe(true);
    expect(isWorkspaceToolName("search_web")).toBe(false);
    expect(isWorkspaceToolName("mcp__read")).toBe(false);
    expect(isWorkspaceToolName("")).toBe(false);
  });
});

describe("终局判定(参数齐备,三档语义)", () => {
  test("confirm_each:非 read 恒审批(空串缘由);read 免审", () => {
    expect(workspaceCallApprovalReason("write", "confirm_each", { path: "a.txt" }, CTX)).toBe("");
    expect(workspaceCallApprovalReason("bash", "confirm_each", { command: "ls" }, CTX)).toBe("");
    expect(workspaceCallApprovalReason("read", "confirm_each", { path: "a.txt" }, CTX)).toBeNull();
  });

  test("full_access:全部免审,危险命令与区外路径也不审", () => {
    expect(workspaceCallApprovalReason("bash", "full_access", { command: "rm -rf /" }, CTX)).toBeNull();
    expect(workspaceCallApprovalReason("write", "full_access", { path: "/outside/x.txt" }, CTX)).toBeNull();
  });

  test("balanced bash:危险命令审批(带缘由),常规命令免审", () => {
    const reason = workspaceCallApprovalReason("bash", "balanced", { command: "rm -rf /" }, CTX);
    expect(reason).toContain("Destructive command pattern");
    expect(workspaceCallApprovalReason("bash", "balanced", { command: "bun test && git status" }, CTX)).toBeNull();
  });

  test("balanced write/edit:区内免审,区外审批(带解析后目标)", () => {
    expect(workspaceCallApprovalReason("write", "balanced", { path: "sub/a.txt" }, CTX)).toBeNull();
    expect(workspaceCallApprovalReason("edit", "balanced", { path: join(ROOT, "b.txt") }, CTX)).toBeNull();
    const outside = workspaceCallApprovalReason("write", "balanced", { path: join(tmpdir(), "elsewhere", "x.txt") }, CTX);
    expect(outside).toContain("Writes outside the workspace");
    // 相对路径逃逸与 ~ 展开都按工具内核同一 resolveToCwd 语义判定
    expect(workspaceCallApprovalReason("write", "balanced", { path: "../../escape.txt" }, CTX)).toContain("Writes outside");
    expect(workspaceCallApprovalReason("write", "balanced", { path: "~/escape.txt" }, CTX)).toContain(homedir());
  });

  test("形状残缺不挂审批(交给内核按 schema 报错)", () => {
    expect(workspaceCallApprovalReason("write", "balanced", {}, CTX)).toBeNull();
    expect(workspaceCallApprovalReason("write", "balanced", { path: "  " }, CTX)).toBeNull();
  });

  test("§6.7 免审批可写前缀:balanced 档写入前缀内目录免审,前缀外仍审批", () => {
    // 技能库与工作区边界根不同根(典型:pc-data/skills/ vs workspaces/<id>/files/)
    const SKILLS = join(tmpdir(), "rkh-skills");
    const ctxWithExempt = { ...CTX, approvalExemptWritePrefixes: [SKILLS] };
    // 落在技能库内:即便越出工作区边界根也豁免
    expect(workspaceCallApprovalReason("write", "balanced", { path: join(SKILLS, "my-skill", "SKILL.md") }, ctxWithExempt)).toBeNull();
    expect(workspaceCallApprovalReason("edit", "balanced", { path: join(SKILLS, "my-skill", "notes.md") }, ctxWithExempt)).toBeNull();
    // 前缀外的区外写入仍审批
    expect(workspaceCallApprovalReason("write", "balanced", { path: join(tmpdir(), "elsewhere", "x.txt") }, ctxWithExempt)).toContain("Writes outside");
    // 兄弟前缀不被误判(rkh-skills-evil 不在 rkh-skills 内)
    expect(workspaceCallApprovalReason("write", "balanced", { path: join(tmpdir(), "rkh-skills-evil", "x.md") }, ctxWithExempt)).toContain("Writes outside");
  });

  test("§6.7 豁免只作用于 balanced 档 write/edit:confirm_each 恒审、bash 不查前缀", () => {
    const SKILLS = join(tmpdir(), "rkh-skills");
    const ctxWithExempt = { ...CTX, approvalExemptWritePrefixes: [SKILLS] };
    // confirm_each 档不受豁免影响,仍恒审批
    expect(workspaceCallApprovalReason("write", "confirm_each", { path: join(SKILLS, "SKILL.md") }, ctxWithExempt)).toBe("");
    // bash 审批只看危险命令清单,与 write/edit 的前缀逻辑无关:同一条 bash 命令,
    // 有无豁免前缀结果完全一致(前缀对 bash 不生效)。
    const cmd = `rm -rf ${SKILLS}`;
    expect(workspaceCallApprovalReason("bash", "balanced", { command: cmd }, ctxWithExempt))
      .toBe(workspaceCallApprovalReason("bash", "balanced", { command: cmd }, CTX));
    // 且该 tmp 目录的 rm -rf 本就不在危险清单(非系统目录/盘符根),两侧都是免审
    expect(workspaceCallApprovalReason("bash", "balanced", { command: cmd }, ctxWithExempt)).toBeNull();
  });

  test("单调性:下界为 pending 的组合终局必为 pending(卡永不降级)", () => {
    for (const tool of ["write", "edit", "bash"] as const) {
      const benign: Record<string, string> = tool === "bash" ? { command: "ls" } : { path: "a.txt" };
      expect(workspaceCallApprovalReason(tool, "confirm_each", benign, CTX)).not.toBeNull();
    }
  });
});

describe("会话 cwd 词法解析", () => {
  test("空值回 root;相对值按 root 解析;词法越界回 root", () => {
    expect(lexicalWorkspaceCwd(ROOT, null)).toBe(ROOT);
    expect(lexicalWorkspaceCwd(ROOT, "sub")).toBe(join(ROOT, "sub"));
    expect(lexicalWorkspaceCwd(ROOT, join(tmpdir(), "other"))).toBe(ROOT);
  });
});

describe("危险命令拦截清单(任何档位都拦,§3.2)", () => {
  const dangerous = [
    "rm -rf /",
    "rm -fr /",
    "rm -rf ~",
    "rm -rf $HOME",
    "sudo rm -rf /",
    "rm -rf / --no-preserve-root",
    "rm -rf /etc",
    "rm -rf /usr && echo done",
    "rm -rf C:\\",
    "rm -rf c:/",
    'rm -rf "C:\\"',
    "del /s /q C:\\",
    "rd /s /q C:",
    "mkfs.ext4 /dev/sda1",
    "mkfs /dev/sdb",
    "format C:",
    "echo hi && diskpart",
    "dd if=/dev/zero of=/dev/sda",
    "cat /dev/urandom > /dev/sda",
    "chmod -R 777 /",
    'reg delete "HKLM\\SOFTWARE" /f',
    ":(){ :|:& };:",
  ];
  for (const cmd of dangerous) {
    test(`拦截: ${cmd}`, () => {
      expect(findDangerousCommandReason(cmd)).not.toBeNull();
    });
  }

  const safe = [
    "ls -la",
    "rm -rf ./build",
    "rm -rf node_modules",
    "rm -rf /tmp/mydir",
    "rm foo.txt",
    "rm -rf src/generated && bun run codegen",
    "git rm -r --cached .",
    "del build\\out.txt",
    "echo 'rm -rf /' > docs/danger-examples.md", // 字面量写入文档不执行……但保守拦截也可接受?不:重定向目标非设备,正则不命中
    "dd if=./disk.img of=./backup.img",
    "chmod 755 scripts/build.sh",
    "chmod -R 644 ./dist",
    "reg query HKCU\\Software",
    "format-code --all",
    "grep -r 'mkfs' docs/",
  ];
  for (const cmd of safe) {
    test(`放行: ${cmd}`, () => {
      expect(findDangerousCommandReason(cmd)).toBeNull();
    });
  }
});
