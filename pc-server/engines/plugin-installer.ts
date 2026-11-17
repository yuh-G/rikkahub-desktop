// engines/plugin-installer.ts — 引擎插件的安装与卸载(P5.8,方案 §5.9;原型 X3)
//
// 用应用自带的运行时装包:子进程跑本程序自己(process.execPath),环境里带 BUN_BE_BUN=1 让编译出的 exe 以 bun
// 身份执行 `bun add / remove`(开发时 execPath 就是 bun,这个变量无影响)。用户机器上不需要 npm,git 来源也不需要
// git(bun 直接取仓库压缩包)。BUN_BE_BUN 只进子进程的环境,不写本进程的 process.env——别处以 execPath 起的子进程
// (文件提取等)会继承它而变成 bun。
// 没复用 pi 的包管理实现:它按命令的文件名认包管理器(本程序的 exe 名认不出是 bun,会拿到 npm 的参数),
// 子进程环境也只能取全局 process.env。安装目录的布局与它相同(<引擎数据目录>/npm 下一个私有 package.json)。
// 代理:子进程按应用当前生效的代理设 HTTPS_PROXY / HTTP_PROXY(bun 只认环境变量)。
// 同一引擎的安装与卸载串行(同一个 package.json 与 node_modules)。装失败时 bun 可能已把依赖写进清单,
// 不还原的话之后每次安装都会连带重试这个坏包,所以失败即把清单与锁文件恢复成安装前的样子。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodedError } from "../foundation/errors";
import { enginePluginInstallRoot } from "./plugins";

const INSTALL_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL_CHARS = 2000;

export interface PluginInstallOptions {
  /** 应用当前生效的代理地址;不给 = 子进程沿用本进程的环境。 */
  proxyUrl?: string;
}

const queues = new Map<string, Promise<unknown>>();

function serialized<T>(engine: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(engine) ?? Promise.resolve();
  const next = previous.then(task, task);
  // 队尾只用来排队,失败由调用方处理。
  queues.set(engine, next.catch(() => undefined));
  return next;
}

function ensureInstallRoot(root: string): void {
  mkdirSync(root, { recursive: true });
  const manifest = join(root, "package.json");
  if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ name: "rikkahub-engine-plugins", private: true }, null, 2), "utf8");
  const ignore = join(root, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n!.gitignore\n", "utf8");
}

const MANIFEST_FILES = ["package.json", "bun.lock"];

function snapshotManifests(root: string): Map<string, string | null> {
  return new Map(MANIFEST_FILES.map((name) => {
    const file = join(root, name);
    return [file, existsSync(file) ? readFileSync(file, "utf8") : null];
  }));
}

function restoreManifests(snapshot: Map<string, string | null>): void {
  for (const [file, content] of snapshot) {
    if (content === null) rmSync(file, { force: true });
    else writeFileSync(file, content, "utf8");
  }
}

function dependenciesOf(root: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    return parsed.dependencies ?? {};
  } catch {
    return {}; // 清单还没建或被手动改坏:当作没有依赖,bun 会按需重写
  }
}

export function installedPackageVersion(engine: string, name: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(enginePluginInstallRoot(engine), "node_modules", ...name.split("/"), "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null; // 包不在或清单坏了:版本未知
  }
}

/** npm 包规格里的包名(@scope/name@1.2.3 → @scope/name);认不出时为 null。 */
export function npmSpecName(spec: string): string | null {
  const match = /^(@[^/@\s]+\/[^/@\s]+|[^/@\s:]+)(?:@.*)?$/.exec(spec.trim());
  return match ? match[1]! : null;
}

/** git 来源的规范写法:裸 https 仓库地址补 git+(否则 bun 当压缩包地址下载)。 */
export function normalizeGitSpec(spec: string): string {
  const trimmed = spec.trim();
  return /^https?:\/\//.test(trimmed) && !/\.(tgz|tar\.gz)$/i.test(trimmed) ? `git+${trimmed}` : trimmed;
}

async function runBun(args: string[], root: string, options: PluginInstallOptions): Promise<void> {
  const env: Record<string, string | undefined> = { ...process.env, BUN_BE_BUN: "1" };
  if (options.proxyUrl) {
    env.HTTPS_PROXY = options.proxyUrl;
    env.HTTP_PROXY = options.proxyUrl;
  }
  const proc = Bun.spawn([process.execPath, ...args, "--cwd", root], {
    cwd: root,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    timeout: INSTALL_TIMEOUT_MS,
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code === 0) return;
  const output = `${stderr}\n${stdout}`.trim().slice(-OUTPUT_TAIL_CHARS);
  if (proc.signalCode) throw new CodedError(`安装超时或被中止(${proc.signalCode}):${output}`, "plugin_install_failed");
  throw new CodedError(`包管理器退出码 ${code}:${output}`, "plugin_install_failed");
}

/** 装一个 npm / git 来源的包,返回装上的包名与版本。knownName = 重装已有记录时的包名(依赖表没有变化时据此认领);
 *  registry = 从非默认 registry 的市场源装时的地址(只影响这次安装,不写进安装根的配置)。 */
export function installEnginePluginPackage(
  engine: string,
  spec: string,
  options: PluginInstallOptions & { knownName?: string; registry?: string } = {},
): Promise<{ name: string; version: string | null }> {
  return serialized(engine, async () => {
    const root = enginePluginInstallRoot(engine);
    ensureInstallRoot(root);
    const before = dependenciesOf(root);
    const snapshot = snapshotManifests(root);
    try {
      await runBun(["add", spec, "--omit=peer", ...(options.registry ? [`--registry=${options.registry}`] : [])], root, options);
    } catch (err) {
      restoreManifests(snapshot);
      throw err;
    }
    const after = dependenciesOf(root);
    const changed = Object.keys(after).filter((name) => before[name] !== after[name]);
    const name = changed.length === 1 ? changed[0]! : (options.knownName ?? npmSpecName(spec));
    if (!name || !(name in after)) throw new CodedError(`装好了但认不出装上的是哪个包(${spec})`, "plugin_install_failed");
    return { name, version: installedPackageVersion(engine, name) };
  });
}

/** 卸掉一个已装的包;包已经不在时无事。 */
export function uninstallEnginePluginPackage(engine: string, name: string, options: PluginInstallOptions = {}): Promise<void> {
  return serialized(engine, async () => {
    const root = enginePluginInstallRoot(engine);
    if (!(name in dependenciesOf(root))) return;
    await runBun(["remove", name], root, options);
  });
}
