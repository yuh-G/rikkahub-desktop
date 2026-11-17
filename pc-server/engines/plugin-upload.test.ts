// engines/plugin-upload.test.ts — 上传文件的逐条校验(P6.2.3):格式、大小、文件头、zip 条目路径与符号链接、条目数与
// 解压体积、包根与 package.json、两种压缩包的入口预检与脚本试加载(由调用方的回调给出);zip 重打成 package/ 下的 tgz。
// 不装包、不写数据目录。
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildZip, type TestZipEntry } from "../test-utils/build-zip";
import { prepareUpload } from "./plugin-upload";

const PKG = JSON.stringify({ name: "@demo/zipped", version: "1.0.0" });

function zip(entries: TestZipEntry[]): Uint8Array {
  return new Uint8Array(buildZip(entries));
}

async function tgz(files: Record<string, string>): Promise<Uint8Array> {
  const encoded = Object.fromEntries(Object.entries(files).map(([name, text]) => [name, new TextEncoder().encode(text)]));
  return new Bun.Archive(encoded, { compress: "gzip" }).bytes();
}

async function rejection(fileName: string, bytes: Uint8Array, checks = {}): Promise<string> {
  const err = await prepareUpload(fileName, bytes, checks).then(() => null, (e: unknown) => e as { message: string; errorCode: string });
  expect(err?.errorCode).toBe("plugin_upload_invalid");
  return err!.message;
}

describe("上传校验", () => {
  test("格式与大小:只认三种扩展名;空文件、超大文件拒绝", async () => {
    expect(await rejection("a.exe", new Uint8Array([1]))).toContain(".tgz");
    expect(await rejection("a.ts", new Uint8Array())).toContain("空");
    expect(await rejection("a.ts", new Uint8Array(1024 * 1024 + 1).fill(0x61))).toContain("1 MB");
    expect(await rejection("a.tgz", new Uint8Array(50 * 1024 * 1024 + 1))).toContain("50 MB");
  });

  test("文件头与扩展名不符、压缩包损坏都拒绝", async () => {
    expect(await rejection("a.tgz", zip([{ name: "package.json", data: PKG }]))).toContain("gzip");
    expect(await rejection("a.zip", await tgz({ "package/package.json": PKG }))).toContain("zip");
    expect(await rejection("a.tar.gz", new Uint8Array([0x1f, 0x8b, 0, 0, 0]))).toContain("损坏");
  });

  test("zip 条目:`..` 段、绝对路径、盘符、符号链接一律拒绝", async () => {
    for (const name of ["../evil.js", "pkg/../../evil.js", "/etc/evil.js", "\\evil.js", "C:/evil.js"]) {
      expect(await rejection("a.zip", zip([{ name: "package.json", data: PKG }, { name, data: "x" }]))).toContain("不安全的路径");
    }
    expect(await rejection("a.zip", zip([{ name: "package.json", data: PKG }, { name: "link", data: "/etc/passwd", method: 0, unixMode: 0o120777 }]))).toContain("符号链接");
  });

  test("zip 条目数与解压后体积超限拒绝(按中央目录登记的大小,不先解压)", async () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({ name: `f${i}.js`, data: "", method: 0 as const }));
    expect(await rejection("a.zip", zip(many))).toContain("5000");
    expect(await rejection("a.zip", zip([{ name: "package.json", data: PKG, declaredSize: 201 * 1024 * 1024 }]))).toContain("200 MB");
  });

  test("包根:根目录或唯一的顶层目录里要有合法的 package.json", async () => {
    expect(await rejection("a.zip", zip([{ name: "index.js", data: "x" }]))).toContain("找不到 package.json");
    expect(await rejection("a.zip", zip([{ name: "a/package.json", data: PKG }, { name: "b/index.js", data: "x" }]))).toContain("找不到 package.json");
    expect(await rejection("a.zip", zip([{ name: "package.json", data: "{" }]))).toContain("不是合法的 JSON");
    expect(await rejection("a.zip", zip([{ name: "package.json", data: JSON.stringify({ name: "Bad Name" }) }]))).toContain("包名不对");
    expect(await rejection("a.tgz", await tgz({ "package/index.js": "x" }))).toContain("找不到 package.json");
  });

  test("zip:包根在顶层目录时就地预检入口,通过后重打成 package/ 下的 tgz", async () => {
    const bytes = zip([
      { name: "repo-main/package.json", data: PKG },
      { name: "repo-main/src/index.js", data: "export default () => {};" },
    ]);
    let checked = "";
    expect(await rejection("a.zip", bytes, { packageEntryError: () => "找不到入口" })).toContain("不是可用的插件:找不到入口");
    const prepared = await prepareUpload("a.zip", bytes, {
      packageEntryError: (dir: string) => {
        checked = dir;
        return existsSync(join(dir, "src", "index.js")) ? null : "missing";
      },
    });
    expect(existsSync(checked)).toBe(false);
    expect(prepared).toMatchObject({ kind: "package", name: "@demo/zipped", version: "1.0.0" });
    if (prepared.kind !== "package") throw new Error("unreachable");
    expect(prepared.hash).toMatch(/^[0-9a-f]{8}$/);
    const files = await new Bun.Archive(prepared.archive).files();
    expect([...files.keys()].sort()).toEqual(["package/package.json", "package/src/index.js"]);
  });

  test("tgz 同样就地预检入口;通过后原样存档,包名与版本取 package.json", async () => {
    const bytes = await tgz({ "package/package.json": JSON.stringify({ name: "plain", version: "2.1.0" }), "package/index.js": "x" });
    const entryOf = (dir: string) => (existsSync(join(dir, "index.js")) ? null : "找不到入口");
    expect(await rejection("a.tgz", await tgz({ "package/package.json": PKG, "package/lib.js": "x" }), { packageEntryError: entryOf })).toContain("找不到入口");
    expect(await rejection("a.tgz", await tgz({ "package/package.json": PKG, "package/../x.js": "x" }))).toContain("不安全的路径");
    expect(await prepareUpload("plain.tar.gz", bytes, { packageEntryError: entryOf })).toMatchObject({ kind: "package", name: "plain", version: "2.1.0", archive: bytes });
  });

  test("单个脚本:必须是不含 NUL 的 UTF-8 文本,试加载报错即拒绝;文件名里的危险字符换掉", async () => {
    expect(await rejection("a.js", new Uint8Array([0xff, 0xfe, 0x00]))).toContain("UTF-8");
    expect(await rejection("a.js", new TextEncoder().encode("a\0b"))).toContain("NUL");
    expect(await rejection("a.ts", new TextEncoder().encode("x"), { scriptLoadError: async () => "SyntaxError" })).toContain("不是可用的插件:SyntaxError");
    const prepared = await prepareUpload("..hello:1.mjs", new TextEncoder().encode("export default () => {};"), { scriptLoadError: async () => null });
    expect(prepared).toMatchObject({ kind: "script", fileName: "hello_1.mjs" });
  });
});
