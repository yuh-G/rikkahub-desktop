// tools/permission.test.ts — 按类别判定(纯函数层):类别、三档矩阵、第三方工具按模式分治、下界与终局、单调性、免审前缀
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { WorkspacePermissionPreset } from "../foundation/types";
import {
  decidePermission,
  type PermissionPolicy,
  type PermissionRequest,
  type PermissionTarget,
  type ToolCategory,
  type WorkspacePolicy,
} from "./permission";

// 词法判定不碰文件系统,root/cwd/前缀无需真实存在
const ROOT = join(tmpdir(), "rkh-permission-root");
const SKILLS = join(tmpdir(), "rkh-skills");

function workspace(preset: WorkspacePermissionPreset, extra: Partial<WorkspacePolicy> = {}): PermissionPolicy {
  return { workspace: { preset, root: ROOT, cwd: ROOT, exemptWritePrefixes: [SKILLS], ...extra } };
}

function request(category: ToolCategory, target?: PermissionTarget): PermissionRequest {
  return {
    conversationId: "c1",
    toolName: "t",
    category,
    ...(target ? { target } : {}),
    origin: { kind: "app" },
  };
}

const decide = (category: ToolCategory, policy: PermissionPolicy, target?: PermissionTarget) =>
  decidePermission(request(category, target), policy).type;

describe("与工作区无关的类别", () => {
  test("read / network / local 恒免审;ask 恒待审", () => {
    for (const preset of ["confirm_each", "balanced", "full_access"] as const) {
      expect(decide("read", workspace(preset), { path: "/etc/passwd" })).toBe("auto");
      expect(decide("network", workspace(preset), { url: "https://example.com" })).toBe("auto");
      expect(decide("local", workspace(preset))).toBe("auto");
      expect(decide("ask", workspace(preset))).toBe("pending");
    }
    expect(decide("ask", { allowedForSession: true })).toBe("pending");
  });

  test("会话没绑工作区:写入 / 执行不挂审批", () => {
    expect(decide("write", { workspace: null }, { path: "/x" })).toBe("auto");
    expect(decide("execute", {}, { command: "rm -rf /" })).toBe("auto");
  });
});

describe("第三方工具(MCP / 插件):按模式分治(D32)", () => {
  test("工作区会话只看档位:询问批准每次问,默认权限与完全访问不问;逐工具的「需要用户审核」不起作用", () => {
    for (const category of ["mcp", "plugin"] as const) {
      for (const mcpApprovalRequired of [true, false]) {
        expect(decide(category, { ...workspace("confirm_each"), mcpApprovalRequired })).toBe("pending");
        expect(decide(category, { ...workspace("balanced"), mcpApprovalRequired })).toBe("auto");
        expect(decide(category, { ...workspace("full_access"), mcpApprovalRequired })).toBe("auto");
      }
    }
  });

  test("询问批准下待审卡不附缘由;本会话已选「总是允许」则免问", () => {
    for (const category of ["mcp", "plugin"] as const) {
      expect(decidePermission(request(category), workspace("confirm_each"))).toEqual({ type: "pending" });
      expect(decide(category, { ...workspace("confirm_each"), allowedForSession: true })).toBe("auto");
    }
  });

  test("对话模式(没有工作区):MCP 只看逐工具设置", () => {
    expect(decide("mcp", { mcpApprovalRequired: true })).toBe("pending");
    expect(decide("mcp", { workspace: null, mcpApprovalRequired: true })).toBe("pending");
    expect(decide("mcp", { mcpApprovalRequired: false })).toBe("auto");
    expect(decide("mcp", {})).toBe("auto");
  });

  test("插件工具缺工作区按最严档询问", () => {
    expect(decide("plugin", {})).toBe("pending");
    expect(decide("plugin", { workspace: null })).toBe("pending");
  });
});

describe("写入 / 执行:三档矩阵", () => {
  test("无对象(参数未到)的下界:只有 confirm_each 待审", () => {
    for (const category of ["write", "execute"] as const) {
      expect(decidePermission(request(category), workspace("confirm_each"))).toEqual({ type: "pending" });
      expect(decide(category, workspace("balanced"))).toBe("auto");
      expect(decide(category, workspace("full_access"))).toBe("auto");
    }
  });

  test("confirm_each 恒待审且不附缘由;full_access 恒免审", () => {
    expect(decidePermission(request("write", { path: "a.txt" }), workspace("confirm_each"))).toEqual({ type: "pending" });
    expect(decidePermission(request("execute", { command: "ls" }), workspace("confirm_each"))).toEqual({ type: "pending" });
    expect(decide("execute", workspace("full_access"), { command: "rm -rf /" })).toBe("auto");
    expect(decide("write", workspace("full_access"), { path: "/outside/x.txt" })).toBe("auto");
  });

  test("balanced 执行:只有危险命令待审,缘由带说明", () => {
    const decision = decidePermission(request("execute", { command: "rm -rf /" }), workspace("balanced"));
    expect(decision.type).toBe("pending");
    expect(decision.type === "pending" && decision.reason).toContain("Destructive command pattern:");
    expect(decide("execute", workspace("balanced"), { command: "bun test && git status" })).toBe("auto");
  });

  test("balanced 写入:区内免审,区外待审(缘由是解析后的目标,含 ~ 展开)", () => {
    expect(decide("write", workspace("balanced"), { path: "sub/a.txt" })).toBe("auto");
    expect(decide("write", workspace("balanced"), { path: join(ROOT, "abs.txt") })).toBe("auto");
    const outside = decidePermission(request("write", { path: "../../escape.txt" }), workspace("balanced"));
    expect(outside.type === "pending" && outside.reason).toContain("Writes outside the workspace:");
    const home = decidePermission(request("write", { path: "~/escape.txt" }), workspace("balanced"));
    expect(home.type === "pending" && home.reason).toContain(homedir());
  });

  test("balanced 写入:path 缺失或空白不挂审批(交内核按 schema 报错)", () => {
    expect(decide("write", workspace("balanced"), {})).toBe("auto");
    expect(decide("write", workspace("balanced"), { path: "  " })).toBe("auto");
  });

  test("相对路径按会话 cwd 解析", () => {
    const policy = workspace("balanced", { cwd: join(ROOT, "sub") });
    expect(decide("write", policy, { path: "../a.txt" })).toBe("auto");
    expect(decide("write", policy, { path: "../../a.txt" })).toBe("pending");
  });

  test("§6.7 免审前缀:balanced 写入前缀内免审;同名前缀的兄弟目录不算;执行与 confirm_each 不受影响", () => {
    expect(decide("write", workspace("balanced"), { path: join(SKILLS, "my-skill", "SKILL.md") })).toBe("auto");
    expect(decide("write", workspace("balanced"), { path: join(tmpdir(), "rkh-skills-evil", "x.md") })).toBe("pending");
    expect(decide("write", workspace("confirm_each"), { path: join(SKILLS, "SKILL.md") })).toBe("pending");
    expect(decide("execute", workspace("balanced"), { command: `rm -rf / && cd ${SKILLS}` })).toBe("pending");
  });

  test("单调性:下界待审的组合,带任何对象的终局仍待审(卡永不降级)", () => {
    const targets: PermissionTarget[] = [{}, { path: "a.txt" }, { path: join(SKILLS, "x.md") }, { command: "ls" }];
    for (const preset of ["confirm_each", "balanced", "full_access"] as const) {
      for (const category of ["write", "execute"] as const) {
        if (decide(category, workspace(preset)) !== "pending") continue;
        for (const target of targets) expect(decide(category, workspace(preset), target)).toBe("pending");
      }
    }
  });
});
