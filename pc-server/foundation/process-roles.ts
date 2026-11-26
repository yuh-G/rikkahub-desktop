// foundation/process-roles.ts — 进程角色表与唯一的「启动自己」(P7.2.1,方案 §5.14.3)
//
// 同一个可执行文件以三种身份运行:主程序 server、文档提取 extract-worker、引擎宿主 engine-host。子进程的身份写在
// 启动参数里、紧跟入口(argv[2],开发时与编译版相同)。不用环境变量:子进程的环境默认传给孙进程,插件在宿主进程里
// 起的命令行、再起的本程序都会带上它;启动参数不照抄就不会带过去。
// 入口 server.ts 只查这张表,再动态加载该身份的代码——先于数据目录锁、端口与启动黑匣子,子进程不跟主程序抢锁,
// 也不加载用不到的模块。另认一种不是我们发起的启动:插件把本程序当 pi 命令行再启动(子代理插件的后台子任务),
// 本程序不是 pi 命令行,入口报错退出。
// 启动自己只经 spawnSelf:编译版的 exe 自带入口,只给角色参数;开发时(bun 跑源码)要带上入口脚本。判断用
// Bun.isStandaloneExecutable(按 argv 判断曾判反)。别处不许拿本程序的路径启动进程(process-roles.test.ts 扫源码;
// engines/plugin-installer.ts 把 exe 当 bun 用,是登记的例外)。
// 本模块只引 node 内建模块:入口在分流之前只加载它。

import { resolve } from "node:path";
import type { SpawnOptions, Subprocess } from "bun";

export const PROCESS_ROLES = ["server", "extract-worker", "engine-host"] as const;
export type ProcessRole = (typeof PROCESS_ROLES)[number];
/** 由本程序启动的身份;主程序由用户或窗口壳启动,不带角色参数。 */
export type ChildRole = Exclude<ProcessRole, "server">;

const ROLE_FLAG = "--rikkahub-role=";

/** 子进程启动参数里的角色标记(启动清扫按它认出自己起的进程)。 */
export function roleFlag(role: ChildRole): string {
  return `${ROLE_FLAG}${role}`;
}

export type ProcessLaunch =
  | { kind: "role"; role: ProcessRole }
  | { kind: "pi-cli-relaunch" }
  | { kind: "unknown-role"; value: string };

/** 子代理插件的后台运行器配置(它经这个环境变量把任务交给子进程)。 */
const PI_RUNNER_CONFIG_ENV = "PI_SUBAGENT_RUNNER_CONFIG";
/** pi 命令行才有、本程序没有的参数。 */
const PI_CLI_FLAGS = new Set(["--mode", "--extension", "--no-session", "--no-extensions"]);

/** 先认 pi 命令行再启动:插件在宿主进程里照抄自己的启动参数再起一个时,参数里会带着角色标记。 */
export function resolveProcessLaunch(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): ProcessLaunch {
  if (env[PI_RUNNER_CONFIG_ENV] || argv.slice(1).some((arg) => PI_CLI_FLAGS.has(arg.split("=")[0]!))) return { kind: "pi-cli-relaunch" };
  const declared = argv[2];
  if (declared?.startsWith(ROLE_FLAG)) {
    const value = declared.slice(ROLE_FLAG.length);
    return (PROCESS_ROLES as readonly string[]).includes(value) ? { kind: "role", role: value as ProcessRole } : { kind: "unknown-role", value };
  }
  return { kind: "role", role: "server" };
}

export const PI_CLI_RELAUNCH_MESSAGE =
  "RikkaHub 不能当作 pi 命令行启动:插件的后台子任务(另起 pi 进程)不受支持,请让插件在前台运行子任务。";

export function unknownRoleMessage(value: string): string {
  return `未知的进程角色「${value}」:程序文件可能在运行期间被换成了另一个版本,请重启应用。`;
}

/** 以 role 身份启动本程序;选项照 Bun.spawn,命令由这里定。开发时的入口脚本是 pc-server/server.ts(本文件在 foundation/)。 */
export function spawnSelf<
  const In extends SpawnOptions.Writable = "ignore",
  const Out extends SpawnOptions.Readable = "pipe",
  const Err extends SpawnOptions.Readable = "inherit",
>(role: ChildRole, options: SpawnOptions.SpawnOptions<In, Out, Err> = {}): Subprocess<In, Out, Err> {
  const flag = roleFlag(role);
  const cmd = Bun.isStandaloneExecutable ? [process.execPath, flag] : [process.execPath, resolve(import.meta.dir, "..", "server.ts"), flag];
  return Bun.spawn<In, Out, Err>({ ...options, cmd });
}
