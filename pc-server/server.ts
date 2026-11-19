// server.ts — 唯一入口:先认进程角色,再只加载该角色的代码(P7.2.1,方案 §5.14.3)。
// 角色表与判定在 foundation/process-roles.ts。本文件除它之外不静态引用任何模块,所以分流先于数据目录锁、
// 端口与启动黑匣子(都在 server-main.ts);子进程不跟主程序抢锁,也不加载数据库、路由与 pi
// (process-roles.test.ts 锁住这两点)。

import process from "node:process";
import { PI_CLI_RELAUNCH_MESSAGE, resolveProcessLaunch, unknownRoleMessage } from "./foundation/process-roles";

const launch = resolveProcessLaunch(Bun.argv, process.env);

if (launch.kind === "pi-cli-relaunch") {
  console.error(PI_CLI_RELAUNCH_MESSAGE);
  process.exit(2);
}
if (launch.kind === "unknown-role") {
  console.error(unknownRoleMessage(launch.value));
  process.exit(2);
}

switch (launch.role) {
  case "server":
    await import("./server-main");
    break;
  case "extract-worker": {
    const [{ installProcessSafetyNet }, { runExtractionWorker }] = await Promise.all([
      import("./observability/app-errors"),
      import("./files/extraction"),
    ]);
    installProcessSafetyNet();
    process.exit(await runExtractionWorker());
  }
  case "engine-host":
    await import("./pi-engine/host-process");
    break;
}
