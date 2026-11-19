// pi-engine/host-process.ts — pi 驱动的子进程入口(P2.6 跨进程证明)
//
//   bun run pi-engine/host-process.ts      (父进程经 stdio 连接,见 scripts/engine-contract-smoke.ts)
//
// 也是进程角色 engine-host 的主体:入口 server.ts 认出角色后动态加载本文件(foundation/process-roles.ts)。
// stdin / stdout 是契约的行帧通道(engines/stdio-transport):本进程建 pi 驱动,驱动拿到的 EngineHost
// 是经 stdio 回调父进程的代理。驱动只经契约拿应用的东西,所以这里不加载任何应用状态
// (engines/engine-agnostic-guard.test.ts 锁 pi-engine 的导入闭包不含 persistence/conversations/api)。
// 生产不走这条路:它证明「同进程 / 独立进程」只是部署选择(方案 D9)。真正部署成独立进程时还要补
// 运维部分(启动 / 健康 / 重启、代理设置传播——本进程没装 foundation/net 的全局壳)。

import { serveDriverOverStdio } from "../engines/stdio-transport";
import { createLineFramer } from "../subprocess-engine/protocol";
import { createPiDriver } from "./driver";

// stdout 只走协议帧:进程内任何 console 输出改到 stderr(父进程摘录尾部用于归因)。
console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);

const server = serveDriverOverStdio(
  (line) => void process.stdout.write(`${line}\n`),
  (host) => createPiDriver(host),
  (reason) => console.error(`[engine-host] ${reason}`),
);

const framer = createLineFramer((frame) => {
  if (frame.type === "line") server.receive(frame.text);
  else console.error(`[engine-host] ${frame.reason}`);
});

process.stdin.on("data", (chunk: Buffer) => framer.feed(chunk));
process.stdin.on("end", () => {
  framer.flush();
  server.close("stdin 已关闭");
  process.exit(0);
});
