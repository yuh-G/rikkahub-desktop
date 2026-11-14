// workspace/boundary.test.ts — 边界校验与限额单测(M1-3)
// §5.3 要求全覆盖:../ 穿越、绝对路径、符号链接逃逸、Windows 盘符兄弟目录、
// 不存在尾段(write 新文件)、限额闸门(读 512KB/写 2MB)、经工具全链路的越界拒绝(工具是 pi 内建定义)。
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";

import {
  assertInsideWorkspace,
  createBoundedEditOperations,
  createBoundedWriteOperations,
  createWideReadOperations,
  createWideWriteOperations,
  READ_HARD_LIMIT_BYTES,
  WorkspaceBoundaryError,
  WRITE_HARD_LIMIT_BYTES,
} from "./boundary";
import { createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition } from "../../pi/packages/coding-agent/src/core/tools/index.ts";

type ToolResult = { content: Array<{ type: string; text?: string }> };
const run = (definition: { execute: unknown }, params: unknown) =>
  (definition.execute as (id: string, params: unknown) => Promise<ToolResult>)("call", params);

const host = mkdtempSync(join(tmpdir(), "rkh-boundary-"));
const root = join(host, "ws");
const outside = join(host, "outside");
mkdirSync(root, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(root, "inside.txt"), "inside content");
writeFileSync(join(outside, "secret.txt"), "secret");

/** Windows 无特权环境软链可能被拒(需开发者模式);拿到能力再跑软链用例。 */
function canSymlink(): boolean {
  try {
    const probe = join(host, `probe-${Date.now()}`);
    symlinkSync(outside, probe, "junction");
    return true;
  } catch {
    return false;
  }
}
const symlinkOk = canSymlink();

describe("assertInsideWorkspace", () => {
  test("区内路径放行并 realpath 化;root 自身放行", () => {
    expect(assertInsideWorkspace(join(root, "inside.txt"), root)).toContain("inside.txt");
    expect(() => assertInsideWorkspace(root, root)).not.toThrow();
  });

  test("../ 穿越拒绝", () => {
    expect(() => assertInsideWorkspace(resolve(root, "..", "outside", "secret.txt"), root))
      .toThrow(WorkspaceBoundaryError);
    expect(() => assertInsideWorkspace(resolve(root, "sub", "..", "..", "escape.txt"), root))
      .toThrow(WorkspaceBoundaryError);
  });

  test("区外绝对路径拒绝(含系统根)", () => {
    expect(() => assertInsideWorkspace(join(outside, "secret.txt"), root)).toThrow(WorkspaceBoundaryError);
    expect(() => assertInsideWorkspace(parse(root).root, root)).toThrow(WorkspaceBoundaryError);
  });

  test("盘符/前缀兄弟目录拒绝(前缀必须带分隔符)", () => {
    const sibling = `${root}2`;
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "x.txt"), "x");
    expect(() => assertInsideWorkspace(join(sibling, "x.txt"), root)).toThrow(WorkspaceBoundaryError);
  });

  test("不存在的尾段(write 新文件/新目录)按最深存在祖先判界", () => {
    expect(() => assertInsideWorkspace(join(root, "new-dir", "new-file.txt"), root)).not.toThrow();
    expect(() => assertInsideWorkspace(join(outside, "new-dir", "new-file.txt"), root)).toThrow(WorkspaceBoundaryError);
  });

  test.if(symlinkOk)("软链逃逸拒绝:链本体在区内、目标在区外", () => {
    const link = join(root, "escape-link");
    symlinkSync(outside, link, "junction");
    expect(() => assertInsideWorkspace(join(link, "secret.txt"), root)).toThrow(WorkspaceBoundaryError);
    expect(() => assertInsideWorkspace(link, root)).toThrow(WorkspaceBoundaryError);
  });

  test("NUL 字节路径拒绝", () => {
    expect(() => assertInsideWorkspace(join(root, "a\0b"), root)).toThrow(WorkspaceBoundaryError);
  });

  test("Windows 大小写不敏感:大小写变体不误伤", () => {
    if (process.platform !== "win32") return;
    const upper = join(root.toUpperCase(), "inside.txt");
    expect(() => assertInsideWorkspace(upper, root)).not.toThrow();
  });
});

describe("宽界 Operations(read 三档全宽;write 区内直通+黑名单)", () => {
  const skills = join(host, "skills");
  mkdirSync(join(skills, "demo"), { recursive: true });
  writeFileSync(join(skills, "demo", "SKILL.md"), "# demo skill");

  test("宽界 read 任意路径可读(读不具破坏性,三档通用);write/edit 严界仍单根拒绝", async () => {
    const readOps = createWideReadOperations();
    const text = await readOps.readFile(join(skills, "demo", "SKILL.md"));
    expect(text.toString()).toContain("demo skill");
    const outsideFile = join(outside, "readable.txt");
    writeFileSync(outsideFile, "outside-data");
    expect((await readOps.readFile(outsideFile)).toString()).toContain("outside-data");
    const writeOps = createBoundedWriteOperations(root);
    await expect(writeOps.writeFile(join(skills, "demo", "SKILL.md"), "overwrite")).rejects.toThrow(WorkspaceBoundaryError);
    const editOps = createBoundedEditOperations(root);
    // readFile 在 assert 处同步抛(非 async 函数),统一成 rejected promise 再断言
    await expect(Promise.resolve().then(() => editOps.readFile(join(skills, "demo", "SKILL.md")))).rejects.toThrow(WorkspaceBoundaryError);
  });

  test("宽界 write:区内直通;区外可写;pc-data/系统目录自 2026-08-23 起不再硬拒", async () => {
    // 回归:managed 工作区根在 dataDir/workspaces/ 之下,宽界已无黑名单,
    // 区内直通照常,区外与 pc-data、系统目录也一律放行(体积闸门照旧)。
    const { dataDir } = await import("../foundation/paths");
    const wsRoot = join(dataDir, "workspaces", "wide-test", "files");
    mkdirSync(wsRoot, { recursive: true });
    const wideOps = createWideWriteOperations(wsRoot);
    await wideOps.writeFile(join(wsRoot, "in-zone.txt"), "in");
    expect(readFileSync(join(wsRoot, "in-zone.txt"), "utf8")).toBe("in");
    await wideOps.writeFile(join(outside, "out-zone.txt"), "out");
    expect(readFileSync(join(outside, "out-zone.txt"), "utf8")).toBe("out");
    // pc-data 应用数据目录:命中旧黑名单但 now 放行。只写测试专属子目录,不碰真实状态文件。
    const dataTarget = join(dataDir, "workspaces", "wide-test", "appdata-ok.txt");
    await wideOps.writeFile(dataTarget, "x");
    expect(readFileSync(dataTarget, "utf8")).toBe("x");
    // 系统目录:同样不再硬拒。用指向系统目录黑名单内、但重定向到测试临时区的安全路径验证
    // (仅证明黑名单不再拦截;不真正写 C:\Windows / /etc)。
    const sysTarget = process.platform === "win32"
      ? join(process.env.SystemRoot ?? String.raw`C:\Windows`, "Temp", "rkh-wide-ok.txt")
      : "/tmp/rkh-wide-ok.txt";
    await wideOps.writeFile(sysTarget, "x");
    expect(readFileSync(sysTarget, "utf8")).toBe("x");
  });
});

describe("限额闸门", () => {
  test("读 512KB:超限文件报错并引导 bash 分段", async () => {
    const big = join(root, "big.txt");
    writeFileSync(big, Buffer.alloc(READ_HARD_LIMIT_BYTES + 1, 0x61));
    const ops = createWideReadOperations();
    await expect(ops.readFile(big)).rejects.toThrow("read limit");
    // 未超限正常读
    const ok = await ops.readFile(join(root, "inside.txt"));
    expect(ok.toString()).toBe("inside content");
  });

  test("写 2MB:超限内容报错", async () => {
    const ops = createBoundedWriteOperations(root);
    await expect(ops.writeFile(join(root, "big-write.txt"), "x".repeat(WRITE_HARD_LIMIT_BYTES + 1)))
      .rejects.toThrow("write limit");
  });
});

describe("工具全链路(pi 内建工具 + 有界 Operations)", () => {
  test("read:区内与区外均可读(三档全宽,2026-08-01 拍板);缺失文件报常规错误", async () => {
    const tool = createReadToolDefinition(root, { operations: createWideReadOperations(), autoResizeImages: false });
    const ok = await run(tool, { path: "inside.txt" });
    expect(ok.content[0]).toEqual({ type: "text", text: "inside content" });
    const out = await run(tool, { path: "../outside/secret.txt" });
    expect(out.content[0]).toEqual({ type: "text", text: "secret" });
    // 不存在的文件报常规 not-found,而非边界拒绝
    await expect(run(tool, { path: "../outside/missing.txt" })).rejects.toThrow(/no such file|not found|ENOENT/i);
  });

  test("write:区外绝对路径被拒,mkdir 不落地", async () => {
    const tool = createWriteToolDefinition(root, { operations: createBoundedWriteOperations(root) });
    await expect(run(tool, { path: join(outside, "evil/pwn.txt"), content: "x" })).rejects.toThrow("Access denied");
    const ok = await run(tool, { path: "sub/ok.txt", content: "fine" });
    expect(ok.content[0]?.type).toBe("text");
  });

  test("edit:区外文件被拒", async () => {
    const tool = createEditToolDefinition(root, { operations: createBoundedEditOperations(root) });
    await expect(run(tool, { path: join(outside, "secret.txt"), edits: [{ oldText: "secret", newText: "x" }] }))
      .rejects.toThrow(/Access denied|Could not edit/);
  });
});

describe("Windows 保留设备名写入阻断(问题4,2.0.0 内测)", () => {
  const onWindows = process.platform === "win32";

  test.if(onWindows)("write/edit/mkdir 拒绝保留名(含带扩展名形式),普通名不受影响", async () => {
    const ops = createBoundedWriteOperations(root);
    await expect(ops.writeFile(join(root, "nul"), "x")).rejects.toThrow("reserved Windows device name");
    await expect(ops.writeFile(join(root, "CON.log"), "x")).rejects.toThrow("reserved Windows device name");
    await expect(ops.mkdir(join(root, "lpt1"))).rejects.toThrow("reserved Windows device name");

    const editOps = createBoundedEditOperations(root);
    await expect(editOps.writeFile(join(root, "com3.txt"), "x")).rejects.toThrow("reserved Windows device name");

    await ops.writeFile(join(root, "reserved-ok.txt"), "fine");
    expect(readFileSync(join(root, "reserved-ok.txt"), "utf-8")).toBe("fine");
  });

  test.if(onWindows)("宽界写同样拒绝(full_access 也不许写设备黑洞)", async () => {
    const wide = createWideWriteOperations(root);
    await expect(wide.writeFile(join(root, "aux"), "x")).rejects.toThrow("reserved Windows device name");
    await expect(wide.mkdir(join(root, "prn"))).rejects.toThrow("reserved Windows device name");
  });

  test.if(!onWindows)("非 win32 平台不拦(nul 是合法文件名)", async () => {
    const ops = createBoundedWriteOperations(root);
    await ops.writeFile(join(root, "nul"), "posix-ok");
    expect(readFileSync(join(root, "nul"), "utf-8")).toBe("posix-ok");
  });
});
