// test-utils/fake-engine-host.ts — 引擎宿主进程的测试替身(subprocess-engine/host-launch.test.ts 用)
//   bun test-utils/fake-engine-host.ts <normal|wrong-version>
// normal:走真实的 runEngineHost(公共底座 + 通道),驱动是假的——每轮按提示里的地址发一个请求(经网络壳),
//   把响应正文当结果返回;顺带往 stdout 写假协议帧、调一次 reportError,验证通道不受干扰、错误能回到主程序。
// wrong-version:不走 runEngineHost,自己连通道、报一个对不上的协议版本。

import type { EngineDriver } from "../engines/contract";
import { reportError } from "../observability/app-errors";
import { connectEngineChannel } from "../subprocess-engine/channel";
import { runEngineHost } from "../subprocess-engine/host-runtime";
import type { EngineHostLaunchLine } from "../subprocess-engine/host-protocol";

const mode = Bun.argv[2] ?? "normal";

if (mode === "wrong-version") {
  const reader = Bun.stdin.stream().getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) process.exit(1);
    text += new TextDecoder().decode(value);
  }
  const launch = JSON.parse(text.slice(0, text.indexOf("\n"))) as EngineHostLaunchLine;
  const channel = await connectEngineChannel(launch.address, { token: launch.token, role: "engine-host", protocol: 999, appVersion: "0.0.0-old", maxFrameBytes: 1024, pid: process.pid });
  channel.onClose(() => process.exit(0));
} else {
  await runEngineHost((host) => {
    const driver: EngineDriver = {
      kind: "fake-host",
      capabilities: { resumeSemantics: "run-and-suspend", steering: "boundary", nativeCompaction: false, workspace: "none", placement: "portable", commands: false },
      async startTurn(req) {
        process.stdout.write('{"jsonrpc":"2.0","id":1,"result":"插件往 stdout 写的假帧"}\n半行没有换行');
        reportError("pi-engine", "info", `宿主进程里的错误:${req.turnId}`);
        const response = await fetch(req.input!.prompt.text);
        const text = await response.text();
        host.emit(req, { kind: "text_delta", text });
        return { text, stopReason: "stop", compactions: [] };
      },
      abort: async () => {},
      invalidate: async () => {},
      dispose: async () => {},
    };
    return driver;
  });
}
