// pi-engine/host-process.ts — 进程角色 engine-host 的主体:pi 驱动跑在引擎宿主进程里(P2.6 起;P7.2.2 改走专用通道)
//
// 入口 server.ts 认出角色后动态加载本文件(foundation/process-roles.ts)。公共底座(网络壳、错误回传、启动黑匣子)与
// 专用通道在 subprocess-engine/host-runtime.ts;这里只交出 pi 驱动。驱动拿到的 EngineHost 是经通道回调主程序的代理,
// 驱动只经契约拿应用的东西,所以这里不加载任何应用状态(foundation/process-roles.test.ts 与
// engines/engine-agnostic-guard.test.ts 锁宿主角色的导入闭包不含 persistence / conversations / api)。

import { runEngineHost } from "../subprocess-engine/host-runtime";
import { createPiDriver } from "./driver";

await runEngineHost((host) => createPiDriver(host));
