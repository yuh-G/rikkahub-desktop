// test-utils/fake-engine-host.ts — 引擎宿主进程的测试替身(subprocess-engine/host-launch.test.ts、supervisor.test.ts 用)
//   bun test-utils/fake-engine-host.ts <normal|wrong-version|hang|crash|contract>
// normal:走真实的 runEngineHost(公共底座 + 通道),驱动是假的——每轮按提示里的地址发一个请求(经网络壳),
//   把响应正文当结果返回;顺带往 stdout 写假协议帧(自己写、再起一个继承 stdout 的子命令写)、调一次 reportError,
//   验证通道不受干扰、错误能回到主程序。
// wrong-version:不走 runEngineHost,自己连通道、报一个对不上的协议版本。
// hang:同 normal,但 startTurn 进同步死循环(插件卡死主线程:ping、abort 都答不了)。
// crash:一起来就往 stderr 写一句再退出(插件在加载时把进程带走)。
// contract:驱动声明全部可选能力;startTurn 把 EngineHost 的每个方法各调一次、把各自的回答带回,其余驱动方法回显参数
//   (契约的每个方法在真实通道上各走一次,§5.14.12)。

import type { EngineDriver, EngineHost } from "../engines/contract";
import { reportError } from "../observability/app-errors";
import { connectEngineChannel } from "../subprocess-engine/channel";
import { runEngineHost } from "../subprocess-engine/host-runtime";
import type { EngineHostLaunchLine } from "../subprocess-engine/host-protocol";

const mode = Bun.argv[2] ?? "normal";

function contractDriver(host: EngineHost): EngineDriver {
  return {
    kind: "fake-contract",
    capabilities: { resumeSemantics: "run-and-suspend", steering: "boundary", nativeCompaction: true, workspace: "required", placement: "portable", commands: true, plugins: true },
    async startTurn(req) {
      const turn = { conversationId: req.conversationId, turnId: req.turnId };
      host.emit(turn, { kind: "text_delta", text: "契约:" });
      const view = await host.session.load(turn);
      await host.session.append(turn, [{ format: "fake/1", entryId: "e1", payload: { from: "engine" } }]);
      const tool = await host.tools.call({ ...turn, toolCallId: "tc1", name: "app_tool", args: { q: 1 } });
      const grant = await host.permission.check({ ...turn, toolCallId: "tc2", toolName: "write", origin: { kind: "engine" }, category: "write", target: { path: "/w/a.txt" }, summary: "a.txt" });
      const answer = await host.interaction.dialog({ ...turn, requestId: "d1", source: "dev:fake", request: { kind: "confirm", title: "确认", message: "继续?" } });
      host.interaction.dismiss({ ...turn, requestId: "d0" });
      host.interaction.show({ ...turn, source: "dev:fake", notice: { kind: "status", key: "k", text: "在跑" } });
      const steer = await host.steer.take(turn);
      host.turn.request({ engine: "fake-contract", conversationId: req.conversationId, requestId: "r1", source: "dev:fake" });
      const credential = await host.models.credential({ ...turn, providerId: "p1" });
      host.models.log(turn, { providerId: "p1", providerName: "P", url: "http://model.invalid/v1", method: "POST", ok: true, status: 200, durationMs: 1, requestBody: "{}" });
      host.report({ domain: "pi-engine", severity: "info", message: "契约上报", code: "fake_report" });
      const text = JSON.stringify({ items: view.items.length, tool, grant, answer, steer, credential, workspace: req.input?.workspace?.cwd ?? null });
      return { text, stopReason: "stop", compactions: [] };
    },
    abort: async () => {},
    compact: async (req) => ({ summary: `摘要:${req.customInstructions}`, tokensBefore: 7, estimatedTokensAfter: null, compaction: { cutMessageId: null, summary: "摘要", tokensBefore: 7 } }),
    invalidate: async () => {},
    listCommands: async (req) => [{ id: "c1", name: "hello", source: "engine", description: `会话 ${req.conversationId}` }],
    runCommand: async (req) => ({ compactions: [{ cutMessageId: null, summary: `指令 ${req.commandId} ${req.args}`, tokensBefore: 1 }] }),
    inspectPlugin: async (req) => ({ tools: [{ name: `${req.plugin.id}-tool` }], commands: [], mcpServers: [], errors: [] }),
    dispose: async () => {},
  };
}

if (mode === "crash") {
  console.error("插件加载时崩溃");
  process.exit(5);
} else if (mode === "wrong-version") {
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
} else if (mode === "contract") {
  await runEngineHost(contractDriver);
} else {
  await runEngineHost((host) => {
    const driver: EngineDriver = {
      kind: "fake-host",
      capabilities: { resumeSemantics: "run-and-suspend", steering: "boundary", nativeCompaction: false, workspace: "none", placement: "portable", commands: false, plugins: false },
      async startTurn(req) {
        if (mode === "hang") for (;;);
        process.stdout.write('{"jsonrpc":"2.0","id":1,"result":"插件往 stdout 写的假帧"}\n半行没有换行');
        // 插件起的子命令继承了 stdout(宿主进程的 stdout 本身是 ignore,子命令写进去也到不了通道)
        Bun.spawnSync([process.execPath, "-e", `process.stdout.write('{"jsonrpc":"2.0","id":2,"result":"子命令的假帧"}\\n')`], { stdout: "inherit", stderr: "inherit" });
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
