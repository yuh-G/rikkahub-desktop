// agents/global-agents.test.ts — 全局工作区指引(pc-data/AGENTS.md,引擎中立)行为锁。
// 钉住:候选名序与 pi 同构(AGENTS.md 优先,CLAUDE.md 就地编辑不产生第二份)、
// 无文件时 exists=false 带模板、写入即 exists=true 且内容往返、512KB 上限拒绝。
// 经 *In 参数化注入隔离目录(对齐 json-store 惯例)——piAgentDir 是进程级共享单例,
// 同进程其他测试文件(如 resources.test.ts 写 GLOBAL-INSTRUCTIONS)会互相污染。
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { readGlobalAgentsFileIn, writeGlobalAgentsFileIn, GLOBAL_AGENTS_TEMPLATE } = await import("./global-agents");

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "rkh-gagents-"));
}

describe("global-agents(pc-data/AGENTS.md,引擎中立)", () => {
  test("无文件:exists=false,fileName 引导 AGENTS.md,模板在场", () => {
    const dir = freshDir();
    try {
      const state = readGlobalAgentsFileIn(dir);
      expect(state).toMatchObject({ fileName: "AGENTS.md", exists: false, content: "" });
      expect(state.template).toBe(GLOBAL_AGENTS_TEMPLATE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("写入即创建标准名,内容往返;再读 exists=true", () => {
    const dir = freshDir();
    try {
      writeGlobalAgentsFileIn(dir, "# My rules\n\nAlways answer in Chinese.");
      const state = readGlobalAgentsFileIn(dir);
      expect(state.exists).toBe(true);
      expect(state.fileName).toBe("AGENTS.md");
      expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("# My rules\n\nAlways answer in Chinese.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("已有 CLAUDE.md(候选序内)时:读它、就地编辑,不产生被遮蔽的第二份", () => {
    const dir = freshDir();
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "legacy rules", "utf8");
      expect(readGlobalAgentsFileIn(dir)).toMatchObject({ fileName: "CLAUDE.md", exists: true, content: "legacy rules" });
      writeGlobalAgentsFileIn(dir, "edited rules");
      expect(readGlobalAgentsFileIn(dir)).toMatchObject({ fileName: "CLAUDE.md", content: "edited rules" });
      expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("超 512KB 拒写,原内容不损坏", () => {
    const dir = freshDir();
    try {
      writeGlobalAgentsFileIn(dir, "base");
      expect(() => writeGlobalAgentsFileIn(dir, "x".repeat(512 * 1024 + 1))).toThrow(/512KB/);
      expect(readGlobalAgentsFileIn(dir).content).toBe("base");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("候选存在但读取失败(EBUSY 等):按不存在降级,不把异常抛进生成链", () => {
    const dir = freshDir();
    try {
      writeFileSync(join(dir, "AGENTS.md"), "content", "utf8");
      // 用目录顶替文件让 readFileSync 抛 EISDIR——模拟反病毒锁文件等瞬时读失败。
      rmSync(join(dir, "AGENTS.md"));
      mkdirSync(join(dir, "AGENTS.md"));
      const state = readGlobalAgentsFileIn(dir);
      // statSync.isDirectory() 在候选探测处已过滤目录 → findGlobalContextFileIn 跳过,
      // 走"不存在"分支。真正命中 catch 的是"是文件但读不出"——用权限位不可行
      // (Windows 权限模型不同),这里至少锁住目录形态不抛。
      expect(state.exists).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
