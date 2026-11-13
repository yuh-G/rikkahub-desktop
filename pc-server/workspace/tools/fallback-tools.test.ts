// workspace/tools/fallback-tools.test.ts — grep/find/ls 兜底工具回归(K3)
// 这三个工具仅在 bash 不可用时挂载(runtime.mountedWorkspaceToolNames),
// 引擎是 PC 自建(fs-walk + Bun.Glob + JS RegExp),不是 pi 的 rg/fd 外包——
// 因此这里要测引擎本身:gitignore 子集、输出格式锚点、上限提示、边界断言。
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGrepTool } from "./grep";
import { createFindTool } from "./find";
import { createLsTool } from "./ls";
import {
  createBoundedFindOperations,
  createBoundedGrepOperations,
  createBoundedLsOperations,
  WorkspaceBoundaryError,
} from "../boundary";
import type { ToolTextContent } from "./types";

// ----- 共享目录树 -----
// root/
//   .gitignore        (ignored-dir/ 与 *.log,但 !keep.log 取反)
//   .hidden.txt       (dotfile,gitignore 不管 → 可见)
//   notes.md          ("alpha note")
//   data.log          (被 *.log 忽略)
//   keep.log          (取反规则 → 可见)
//   binary.bin        (含 NUL → grep 跳过)
//   src/app.ts        (alpha/beta 两行)
//   src/util.js
//   ignored-dir/secret.txt ("alpha secret",整目录忽略)
const root = mkdtempSync(join(tmpdir(), "rkh-fallback-"));
writeFileSync(join(root, ".gitignore"), "ignored-dir/\n*.log\n!keep.log\n");
writeFileSync(join(root, ".hidden.txt"), "hidden alpha\n");
writeFileSync(join(root, "notes.md"), "alpha note\n");
writeFileSync(join(root, "data.log"), "alpha in ignored log\n");
writeFileSync(join(root, "keep.log"), "alpha in kept log\n");
writeFileSync(join(root, "binary.bin"), Buffer.from([0x61, 0x00, 0x61, 0x6c, 0x70, 0x68, 0x61]));
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src", "app.ts"), "const alpha = 1;\nconst beta = 2;\n");
writeFileSync(join(root, "src", "util.js"), "// util\n");
mkdirSync(join(root, "ignored-dir"));
writeFileSync(join(root, "ignored-dir", "secret.txt"), "alpha secret\n");

function textOf(result: { content: Array<{ type: string }> }): string {
  return (result.content.filter((c) => c.type === "text") as ToolTextContent[]).map((c) => c.text).join("\n");
}

describe("ls(兜底)", () => {
  test("字典序排序 + 目录尾 / + 含 dotfile", async () => {
    const tool = createLsTool(root);
    const text = textOf(await tool.execute({}));
    const lines = text.split("\n");
    expect(lines).toContain("src/");
    expect(lines).toContain(".hidden.txt");
    expect(lines).toContain("data.log"); // ls 不看 gitignore(pi 语义)
    expect(lines.indexOf(".gitignore")).toBeLessThan(lines.indexOf("notes.md"));
  });

  test("条目上限提示文案", async () => {
    const tool = createLsTool(root);
    const result = await tool.execute({ limit: 2 });
    expect(textOf(result)).toContain("2 entries limit reached. Use limit=4 for more");
    expect(result.details?.entryLimitReached).toBe(2);
  });

  test("非目录/不存在路径报错", async () => {
    const tool = createLsTool(root);
    await expect(tool.execute({ path: "notes.md" })).rejects.toThrow("Not a directory");
    await expect(tool.execute({ path: "missing-dir" })).rejects.toThrow("Path not found");
  });
});

describe("find(兜底)", () => {
  test("basename 模式任意深度匹配", async () => {
    const tool = createFindTool(root);
    const text = textOf(await tool.execute({ pattern: "*.ts" }));
    expect(text).toBe("src/app.ts");
  });

  test("含 / 的模式全路径匹配", async () => {
    const tool = createFindTool(root);
    const text = textOf(await tool.execute({ pattern: "src/*.js" }));
    expect(text).toBe("src/util.js");
  });

  test("gitignore:忽略与取反", async () => {
    const tool = createFindTool(root);
    const text = textOf(await tool.execute({ pattern: "*.log" }));
    expect(text).toContain("keep.log");
    expect(text).not.toContain("data.log");
    const dirText = textOf(await tool.execute({ pattern: "secret*" }));
    expect(dirText).toBe("No files found matching pattern");
  });

  test("目录命中带尾 / + 结果上限提示", async () => {
    const tool = createFindTool(root);
    expect(textOf(await tool.execute({ pattern: "src" }))).toBe("src/");
    const limited = await tool.execute({ pattern: "*", limit: 3 });
    expect(textOf(limited)).toContain("3 results limit reached. Use limit=6 for more");
  });
});

describe("grep(兜底)", () => {
  test("匹配行格式 path:line: text + gitignore 生效 + 二进制跳过", async () => {
    const tool = createGrepTool(root);
    const text = textOf(await tool.execute({ pattern: "alpha" }));
    expect(text).toContain("src/app.ts:1: const alpha = 1;");
    expect(text).toContain("keep.log:1: alpha in kept log");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("data.log");
    expect(text).not.toContain("binary.bin");
  });

  test("context 上下文行格式 path-line- text", async () => {
    const tool = createGrepTool(root);
    const text = textOf(await tool.execute({ pattern: "alpha", path: "src", context: 1 }));
    expect(text).toContain("app.ts:1: const alpha = 1;");
    expect(text).toContain("app.ts-2- const beta = 2;");
  });

  test("literal/ignoreCase/glob 过滤", async () => {
    const tool = createGrepTool(root);
    expect(textOf(await tool.execute({ pattern: "ALPHA NOTE", ignoreCase: true }))).toContain("notes.md:1:");
    expect(textOf(await tool.execute({ pattern: "alpha = 1;", literal: true }))).toContain("src/app.ts:1:");
    const filtered = textOf(await tool.execute({ pattern: "alpha", glob: "*.md" }));
    expect(filtered).toContain("notes.md:1:");
    expect(filtered).not.toContain("app.ts");
  });

  test("无匹配/非法正则/上限提示", async () => {
    const tool = createGrepTool(root);
    expect(textOf(await tool.execute({ pattern: "zzz-nothing" }))).toBe("No matches found");
    await expect(tool.execute({ pattern: "([" })).rejects.toThrow("Invalid regex pattern");
    const limited = await tool.execute({ pattern: "alpha", limit: 1 });
    expect(textOf(limited)).toContain("1 matches limit reached");
    expect(limited.details?.matchLimitReached).toBe(1);
  });

  test("单文件搜索(path 指向文件)", async () => {
    const tool = createGrepTool(root);
    const text = textOf(await tool.execute({ pattern: "beta", path: "src/app.ts" }));
    expect(text).toBe("app.ts:2: const beta = 2;");
  });
});

describe("有界 Operations(边界断言)", () => {
  test("grep/find/ls 的 path 参数越界 → WorkspaceBoundaryError", async () => {
    const outside = join(root, "..");
    const grep = createGrepTool(root, { operations: createBoundedGrepOperations(root) });
    await expect(grep.execute({ pattern: "x", path: outside })).rejects.toThrow(WorkspaceBoundaryError);
    const find = createFindTool(root, { operations: createBoundedFindOperations(root) });
    await expect(find.execute({ pattern: "*", path: outside })).rejects.toThrow(WorkspaceBoundaryError);
    const ls = createLsTool(root, { operations: createBoundedLsOperations(root) });
    await expect(ls.execute({ path: outside })).rejects.toThrow(WorkspaceBoundaryError);
  });

  test("有界 ops 下区内操作正常", async () => {
    const grep = createGrepTool(root, { operations: createBoundedGrepOperations(root) });
    expect(textOf(await grep.execute({ pattern: "beta", path: "src" }))).toContain("app.ts:2:");
    const ls = createLsTool(root, { operations: createBoundedLsOperations(root) });
    expect(textOf(await ls.execute({ path: "src" }))).toContain("app.ts");
  });
});
