// workspace/tools/fallback-tools.test.ts — grep/find/ls 兜底工具回归(K3,P4b 起是 pi 内建定义 + 应用的纯 TS 后端)
// 这三个工具仅在 bash 不可用时挂载(pi-engine/builtin-tools.ts 的 piBuiltinToolNames)。名称 / 描述 / 参数 / 输出
// 收尾文案是 pi 的;搜索后端是应用自建(fs-walk + Bun.Glob + JS RegExp),不调用 pi 默认的外部程序 rg / fd——
// 因此这里经生产同款装配(createPiBuiltinTools,无 bash)测后端本身:gitignore 子集、输出格式锚点、上限提示、边界断言。
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-fallback-data-"));

const { createPiBuiltinTools } = await import("../../pi-engine/builtin-tools");

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

type Result = { content: Array<{ type: string; text?: string }>; details?: { workspace?: { details: Record<string, unknown> } } };
const tools = createPiBuiltinTools({ cwd: root, root, approve: async () => ({ scope: "default" }) });

function tool(name: "grep" | "find" | "ls") {
  const found = tools.find((candidate) => candidate.name === name)!;
  return (params: Record<string, unknown>) => (found.execute as unknown as (id: string, p: unknown) => Promise<Result>)(`call-${name}`, params);
}
const grep = tool("grep");
const find = tool("find");
const ls = tool("ls");

const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");
const detailsOf = (result: Result) => result.details?.workspace?.details ?? {};

describe("ls(兜底)", () => {
  test("字典序排序 + 目录尾 / + 含 dotfile", async () => {
    const lines = textOf(await ls({})).split("\n");
    expect(lines).toContain("src/");
    expect(lines).toContain(".hidden.txt");
    expect(lines).toContain("data.log"); // ls 不看 gitignore(pi 语义)
    expect(lines.indexOf(".gitignore")).toBeLessThan(lines.indexOf("notes.md"));
  });

  test("条目上限提示文案", async () => {
    const result = await ls({ limit: 2 });
    expect(textOf(result)).toContain("2 entries limit reached. Use limit=4 for more");
    expect(detailsOf(result).entryLimitReached).toBe(2);
  });

  test("非目录/不存在路径报错", async () => {
    await expect(ls({ path: "notes.md" })).rejects.toThrow("Not a directory");
    await expect(ls({ path: "missing-dir" })).rejects.toThrow("Path not found");
  });
});

describe("find(兜底)", () => {
  test("basename 模式任意深度匹配", async () => {
    expect(textOf(await find({ pattern: "*.ts" }))).toBe("src/app.ts");
  });

  test("含 / 的模式全路径匹配", async () => {
    expect(textOf(await find({ pattern: "src/*.js" }))).toBe("src/util.js");
  });

  test("gitignore:忽略与取反", async () => {
    const text = textOf(await find({ pattern: "*.log" }));
    expect(text).toContain("keep.log");
    expect(text).not.toContain("data.log");
    expect(textOf(await find({ pattern: "secret*" }))).toBe("No files found matching pattern");
  });

  test("目录命中带尾 / + 结果上限提示", async () => {
    expect(textOf(await find({ pattern: "src" }))).toBe("src/");
    const limited = await find({ pattern: "*", limit: 3 });
    expect(textOf(limited)).toContain("3 results limit reached");
    expect(detailsOf(limited).resultLimitReached).toBe(3);
  });
});

describe("grep(兜底)", () => {
  test("匹配行格式 path:line: text + gitignore 生效 + 二进制跳过", async () => {
    const text = textOf(await grep({ pattern: "alpha" }));
    expect(text).toContain("src/app.ts:1: const alpha = 1;");
    expect(text).toContain("keep.log:1: alpha in kept log");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("data.log");
    expect(text).not.toContain("binary.bin");
  });

  test("context 上下文行格式 path-line- text", async () => {
    const text = textOf(await grep({ pattern: "alpha", path: "src", context: 1 }));
    expect(text).toContain("app.ts:1: const alpha = 1;");
    expect(text).toContain("app.ts-2- const beta = 2;");
  });

  test("literal/ignoreCase/glob 过滤", async () => {
    expect(textOf(await grep({ pattern: "ALPHA NOTE", ignoreCase: true }))).toContain("notes.md:1:");
    expect(textOf(await grep({ pattern: "alpha = 1;", literal: true }))).toContain("src/app.ts:1:");
    const filtered = textOf(await grep({ pattern: "alpha", glob: "*.md" }));
    expect(filtered).toContain("notes.md:1:");
    expect(filtered).not.toContain("app.ts");
  });

  test("无匹配/非法正则/上限提示", async () => {
    expect(textOf(await grep({ pattern: "zzz-nothing" }))).toBe("No matches found");
    await expect(grep({ pattern: "([" })).rejects.toThrow("Invalid regex pattern");
    const limited = await grep({ pattern: "alpha", limit: 1 });
    expect(textOf(limited)).toContain("1 matches limit reached");
    expect(detailsOf(limited).matchLimitReached).toBe(1);
  });

  test("单文件搜索(path 指向文件)", async () => {
    expect(textOf(await grep({ pattern: "beta", path: "src/app.ts" }))).toBe("app.ts:2: const beta = 2;");
  });
});

describe("有界 Operations(边界断言)", () => {
  test("grep/find/ls 的 path 参数越界 → 边界错误", async () => {
    const outside = join(root, "..");
    await expect(grep({ pattern: "x", path: outside })).rejects.toThrow("outside the workspace boundary");
    await expect(find({ pattern: "*", path: outside })).rejects.toThrow("outside the workspace boundary");
    await expect(ls({ path: outside })).rejects.toThrow("outside the workspace boundary");
  });

  test("有界 ops 下区内操作正常", async () => {
    expect(textOf(await grep({ pattern: "beta", path: "src" }))).toContain("app.ts:2:");
    expect(textOf(await ls({ path: "src" }))).toContain("app.ts");
  });
});
