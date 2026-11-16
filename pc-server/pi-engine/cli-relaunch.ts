// pi-engine/cli-relaunch.ts — 识别「插件把本程序当 pi 命令行再启动」(P5.9)
//
// 子代理插件跑后台子任务时会以 pi 命令行的参数再启动当前可执行文件(编译版里 process.execPath 就是本程序)。
// 本程序不是 pi 命令行:子进程里没有应用的模型配置与审批,也不该抢数据目录锁、再起一个服务。入口据此
// 报错退出,插件拿到「子进程启动即退出」的错误,子任务改在前台跑或由用户换做法。
// 本模块不 import pi,入口在加载重模块之前就能判定。

/** 子代理插件的后台运行器配置(它经这个环境变量把任务交给子进程)。 */
const RUNNER_CONFIG_ENV = "PI_SUBAGENT_RUNNER_CONFIG";

/** pi 命令行才有、本程序没有的参数。 */
const PI_CLI_FLAGS = new Set(["--mode", "--extension", "--no-session", "--no-extensions"]);

export function isPiCliRelaunch(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): boolean {
  if (env[RUNNER_CONFIG_ENV]) return true;
  return argv.slice(1).some((arg) => PI_CLI_FLAGS.has(arg.split("=")[0]!));
}

export const PI_CLI_RELAUNCH_MESSAGE =
  "RikkaHub 不能当作 pi 命令行启动:插件的后台子任务(另起 pi 进程)不受支持,请让插件在前台运行子任务。";
