// pi-engine/plugins/session-binding.ts — 插件与一个 pi 会话的生命周期接线(P5.2)
//
// 插件的 session_start 只在 bindExtensions 时发出(pi 的 CLI/RPC 模式各自调用它;SDK 宿主不调就永远
// 收不到),插件在这里重放自己的状态(待办插件从会话分支里的私有条目恢复任务表)。
// session_shutdown 由宿主在会话收尾时发出(pi 的 dispose 不发):插件按会话 id 存的内存态靠它清掉,
// 否则每轮一个会话会一直累积。P5a 每轮一个 pi 会话,原因记 "quit"。
// 没有插件时什么都不做:不 bind、不发事件,会话与插件接入前逐项相同。
// mode 绑 "rpc";界面上下文(ctx.ui / hasUI)由 P5.5 的界面桥接上,此前插件看到的是 pi 的空界面。
// 裁决层的运行期部分(P5.3)也在这里装:会话建好后、session_start 之前覆盖保留域入口,session_start 之后
// 补裁插件在其中补登记的钩子与指令。

import type { AgentSession } from "../../../pi/packages/coding-agent/src/core/agent-session.ts";
import { emitSessionShutdownEvent } from "../../../pi/packages/coding-agent/src/core/extensions/runner.ts";
import type { EngineErrorReport } from "../../engines/contract";
import { arbitrateLatePiRegistrations, guardPiPluginRuntime, type PiPluginPolicy } from "./arbiter";
import { pluginIdForExtensionPath, type PiPluginEntry } from "./entries";

export interface PiPluginSessionBinding {
  /** 会话收尾前调用(dispose 之前)。不抛错:收尾路径上不能让插件挡住 dispose。 */
  shutdown(): Promise<void>;
}

const NO_PLUGINS: PiPluginSessionBinding = { shutdown: async () => undefined };

export async function bindPiPluginSession(
  session: AgentSession,
  plugins: readonly PiPluginEntry[],
  policy: PiPluginPolicy | null,
  report?: (report: EngineErrorReport) => void,
): Promise<PiPluginSessionBinding> {
  if (plugins.length === 0) return NO_PLUGINS;
  const extensions = session.resourceLoader.getExtensions();
  if (policy) guardPiPluginRuntime(extensions, policy);
  await session.bindExtensions({
    mode: "rpc",
    // 插件处理函数抛错不中断会话(pi 已捕获),只把它记进错误中心,署插件 id。
    onError: (error) => {
      const pluginId = pluginIdForExtensionPath(plugins, error.extensionPath) ?? error.extensionPath;
      report?.({
        domain: "pi-engine",
        severity: "warn",
        message: `插件出错:${pluginId}(${error.event}):${error.error}`,
        ...(error.stack ? { detail: error.stack } : {}),
        code: "pi_plugin_runtime_error",
        params: { plugin: pluginId, event: error.event, error: error.error },
      });
    },
  });
  if (policy) arbitrateLatePiRegistrations(extensions, policy);
  return {
    shutdown: async () => {
      try {
        await emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "quit" });
      } catch (err) {
        // 处理函数自己的错误 pi 已逐个捕获并走 onError;能到这里的是分发本身失败,记下即可。
        report?.({
          domain: "pi-engine",
          severity: "warn",
          message: `插件收尾失败:${err instanceof Error ? err.message : String(err)}`,
          code: "pi_plugin_shutdown_failed",
        });
      }
    },
  };
}
