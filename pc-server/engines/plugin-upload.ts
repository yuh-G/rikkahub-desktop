// engines/plugin-upload.ts — 上传本地文件作插件(P6.2.3,方案 §5.13「上传本地文件」)
//
// 三种文件:.tgz / .tar.gz(npm pack 的产物)、.zip(打包的插件目录)、单个 .ts / .js / .mjs。校验在写进数据目录之前
// 做完,任何一条不过就拒绝(只在系统临时目录里暂存,finally 清掉)。zip 的条目逐项查过后在内存里重打成 tgz,所以
// 压缩包统一以 tgz 存档、交包管理器安装(依赖照常从 registry 装)。
// 存档在 <数据目录>/engines/<engine>/uploads/<包名>-<版本>-<内容哈希前 8 位>.tgz,以相对安装根的写法交给包管理器:
// 它把给的写法原样记进安装根的 package.json 与锁文件,写绝对路径的话数据目录搬家后,之后每次安装都会连带重试这条
// 坏依赖。单个脚本存 uploads/scripts/<文件名>,原地加载、不装依赖。
// 入口与能否加载是引擎的规则,由调用方以回调给出:两种压缩包都把包根解到暂存目录里就地预检入口(装完的入口校验
// 仍在,但不会再因为入口而失败——替换已有记录时装上又报错,清单就会指着一份已删的存档)。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { ZipFileReader } from "../files/zip-file";
import { CodedError } from "../foundation/errors";
import { npmSpecName } from "./plugin-installer";
import { enginePluginInstallRoot, enginePluginUploadsDir, UNSAFE_FILE_NAME } from "./plugins";

const ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
const SCRIPT_MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
/** multipart 请求体的上限(文件上限 + 表单开销),解析表单前按 Content-Length 先挡掉。 */
export const UPLOAD_REQUEST_MAX_BYTES = ARCHIVE_MAX_BYTES + 1024 * 1024;

const GZIP_MAGIC = [0x1f, 0x8b];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const UNSAFE_CHARS = new RegExp(UNSAFE_FILE_NAME.source, "g");

export type PreparedUpload =
  | { kind: "package"; name: string; version: string | null; archive: Uint8Array; hash: string }
  | { kind: "script"; fileName: string; bytes: Uint8Array };

export interface UploadChecks {
  /** zip 解出的包根目录里找不到入口时返回原因。 */
  packageEntryError?: (dir: string) => string | null;
  /** 脚本试加载报错时返回原因。 */
  scriptLoadError?: (path: string) => Promise<string | null>;
}

function invalid(reason: string): CodedError {
  return new CodedError(reason, "plugin_upload_invalid");
}

function formatOf(fileName: string): "tgz" | "zip" | "script" {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tgz") || lower.endsWith(".tar.gz")) return "tgz";
  if (lower.endsWith(".zip")) return "zip";
  if ([".ts", ".js", ".mjs"].includes(extname(lower))) return "script";
  throw invalid("只能上传 .tgz / .tar.gz / .zip 压缩包,或单个 .ts / .js / .mjs 文件");
}

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((byte, i) => bytes[i] === byte);
}

/** 压缩包里的条目路径,规整成 / 分隔;绝对路径、盘符、`..` 段与文件名里不许出现的字符一律拒绝(\ 也当分隔符)。 */
function safeEntryPath(name: string): string {
  const segments = name.split(/[\\/]/);
  if (/^[\\/]/.test(name) || segments.some((segment) => segment === ".." || UNSAFE_FILE_NAME.test(segment))) {
    throw invalid(`压缩包里有不安全的路径:${name}`);
  }
  return segments.filter((segment) => segment !== "" && segment !== ".").join("/");
}

/** 包根:根目录有 package.json 即根目录,否则唯一的顶层目录(npm pack 的 package/、GitHub 下载的 <仓库>-<分支>/)。 */
function packageRootOf(paths: Iterable<string>): string {
  const all = [...paths];
  if (all.includes("package.json")) return "";
  const tops = new Set(all.map((path) => path.split("/")[0]!));
  const [top] = tops;
  if (tops.size === 1 && all.includes(`${top}/package.json`)) return `${top}/`;
  throw invalid("压缩包里找不到 package.json(要在根目录,或在唯一的顶层目录里)");
}

function readManifest(bytes: Uint8Array): { name: string; version: string | null } {
  let pkg: { name?: unknown; version?: unknown } | null;
  try {
    pkg = JSON.parse(new TextDecoder().decode(bytes)) as typeof pkg;
  } catch {
    throw invalid("package.json 不是合法的 JSON");
  }
  const name = typeof pkg?.name === "string" ? pkg.name : "";
  if (!name || npmSpecName(name) !== name || /^[._]/.test(name)) throw invalid(`package.json 里的包名不对:${name || "(空)"}`);
  return { name, version: typeof pkg?.version === "string" && pkg.version ? pkg.version : null };
}

/** 包根下的文件写进暂存目录的 package/,预检入口,读出 package.json。 */
function stagePackage(files: ReadonlyMap<string, Uint8Array>, root: string, staging: string, checks: UploadChecks): { name: string; version: string | null } {
  const packageDir = join(staging, "package");
  for (const [path, data] of files) {
    if (!path.startsWith(root) || path === root) continue;
    const target = join(packageDir, ...path.slice(root.length).split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  const manifest = readManifest(files.get(`${root}package.json`)!);
  const entryError = checks.packageEntryError?.(packageDir);
  if (entryError) throw invalid(`这个压缩包不是可用的插件:${entryError}`);
  return manifest;
}

/** tgz:先按上限解压(防解压炸弹),条目路径逐项查过再落到暂存目录(符号链接等非普通文件不在 files() 里,不会落地)。 */
async function prepareTarball(bytes: Uint8Array, staging: string, checks: UploadChecks): Promise<{ name: string; version: string | null }> {
  if (!startsWith(bytes, GZIP_MAGIC)) throw invalid("文件不是 gzip 压缩包(文件头不符)");
  let tar: Uint8Array;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch (err) {
    throw invalid(err instanceof RangeError ? "解压后超过 200 MB" : "压缩包损坏,解不开");
  }
  let files: Map<string, File>;
  try {
    files = await new Bun.Archive(tar).files();
  } catch {
    throw invalid("压缩包损坏,读不出里面的文件");
  }
  if (files.size > MAX_ENTRIES) throw invalid(`压缩包里的文件超过 ${MAX_ENTRIES} 个`);
  const byPath = new Map<string, Uint8Array>();
  for (const [name, file] of files) byPath.set(safeEntryPath(name), await file.bytes());
  return stagePackage(byPath, packageRootOf(byPath.keys()), staging, checks);
}

/** zip:逐项校验后解到暂存目录(就地预检入口),再在内存里重打成 tgz(包根放到 package/ 下,与 npm pack 一致)。 */
async function prepareZip(bytes: Uint8Array, staging: string, checks: UploadChecks): Promise<{ name: string; version: string | null; archive: Uint8Array }> {
  if (!startsWith(bytes, ZIP_MAGIC)) throw invalid("文件不是 zip 压缩包(文件头不符)");
  const zipPath = join(staging, "upload.zip");
  writeFileSync(zipPath, bytes);
  let zip: ZipFileReader;
  try {
    zip = new ZipFileReader(zipPath);
  } catch {
    throw invalid("压缩包损坏,读不出目录");
  }
  try {
    const entries = zip.entries();
    if (entries.length > MAX_ENTRIES) throw invalid(`压缩包里的文件超过 ${MAX_ENTRIES} 个`);
    if (entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0) > MAX_UNPACKED_BYTES) throw invalid("解压后超过 200 MB");
    const paths = entries.map((entry) => {
      if ((entry.unixMode & S_IFMT) === S_IFLNK) throw invalid(`压缩包里有符号链接:${entry.name}`);
      return safeEntryPath(entry.name);
    });
    const root = packageRootOf(paths);
    const files = new Map<string, Uint8Array>();
    const contents: Record<string, Uint8Array> = {};
    entries.forEach((entry, i) => {
      const path = paths[i]!;
      if (!path.startsWith(root) || path === root) return;
      const data = zip.readEntry(entry);
      if (!data) throw invalid(`压缩包里的文件解不开(损坏或用了不支持的压缩方式):${entry.name}`);
      files.set(path, data);
      contents[`package/${path.slice(root.length)}`] = data;
    });
    const manifest = stagePackage(files, root, staging, checks);
    return { ...manifest, archive: await new Bun.Archive(contents, { compress: "gzip" }).bytes() };
  } finally {
    zip.close();
  }
}

async function prepareScript(fileName: string, bytes: Uint8Array, staging: string, checks: UploadChecks): Promise<PreparedUpload> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid("脚本不是 UTF-8 文本");
  }
  if (text.includes("\0")) throw invalid("脚本不是文本文件(含 NUL 字符)");
  const safeName = fileName.replace(UNSAFE_CHARS, "_").replace(/^\.+/, "") || `plugin${extname(fileName)}`;
  const staged = join(staging, safeName);
  writeFileSync(staged, bytes);
  const loadError = await checks.scriptLoadError?.(staged);
  if (loadError) throw invalid(`这个文件不是可用的插件:${loadError}`);
  return { kind: "script", fileName: safeName, bytes };
}

/** 校验上传的文件并整理成可存档的形态。不写数据目录;暂存在系统临时目录,返回前清掉。 */
export async function prepareUpload(fileName: string, bytes: Uint8Array, checks: UploadChecks = {}): Promise<PreparedUpload> {
  const name = fileName.split(/[\\/]/).pop() ?? "";
  const format = formatOf(name);
  const limit = format === "script" ? SCRIPT_MAX_BYTES : ARCHIVE_MAX_BYTES;
  if (bytes.byteLength === 0) throw invalid("文件是空的");
  if (bytes.byteLength > limit) throw invalid(format === "script" ? "单个脚本不能超过 1 MB" : "压缩包不能超过 50 MB");
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const staging = mkdtempSync(join(tmpdir(), "rkh-plugin-upload-"));
  try {
    if (format === "tgz") return { kind: "package", ...(await prepareTarball(bytes, staging, checks)), archive: bytes, hash };
    if (format === "zip") return { kind: "package", ...(await prepareZip(bytes, staging, checks)), hash };
    return await prepareScript(name, bytes, staging, checks);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** 存进 uploads/,返回记录里的来源写法(压缩包 = 存档文件名,脚本 = scripts/<文件名>)。 */
export function saveUpload(engine: string, prepared: PreparedUpload): string {
  const dir = enginePluginUploadsDir(engine);
  const spec = prepared.kind === "script"
    ? `scripts/${prepared.fileName}`
    : `${prepared.name.replace(/^@/, "").replace("/", "-")}-${(prepared.version ?? "0.0.0").replace(UNSAFE_CHARS, "_")}-${prepared.hash}.tgz`;
  const target = join(dir, ...spec.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, prepared.kind === "script" ? prepared.bytes : prepared.archive);
  return spec;
}

/** 上传的文件在本机的位置;不在时报 plugin_upload_missing(换机恢复后就是这样:engines/ 不进任何备份)。 */
export function requireUploadedFile(engine: string, spec: string): string {
  const path = join(enginePluginUploadsDir(engine), ...spec.split("/"));
  if (!existsSync(path)) throw new CodedError("上传的文件不在了,请重新上传", "plugin_upload_missing");
  return path;
}

/** 压缩包存档交给包管理器的写法:相对安装根的路径(见文件头)。 */
export function uploadInstallSpec(engine: string, spec: string): string {
  return relative(enginePluginInstallRoot(engine), requireUploadedFile(engine, spec)).split(sep).join("/");
}

export function removeUpload(engine: string, spec: string): void {
  rmSync(join(enginePluginUploadsDir(engine), ...spec.split("/")), { force: true });
}
