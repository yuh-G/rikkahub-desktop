// pi-engine/plugins/session-binding.ts — 插件与一个 pi 会话的生命周期接线(P5.2)
//
// 插件的 session_start 只在 bindExtensions 时发出(pi 的 CLI/RPC 模式各自调用它;SDK 宿主不调就永远
// 收不到),插件在这里重放自己的状态(待办插件从会话分支里的私有条目恢复任务表)。
// session_shutdown 由宿主在会话收尾时发出(pi 的 dispose 不发):插件按会话 id 存的内存态靠它清掉,
// 否则每轮一个会话会一直累积。P5a 每轮一个 pi 会话,原因记 "quit"。
// 没有插件时什么都不做:不 bind、不发事件,会话与插件接入前逐项相同。
// mode 绑 "rpc";给了界面通道就接上界面桥(ui-bridge,先经裁决层的对话框守卫),ctx.hasUI 为真;
// 不给(测试)则插件看到的是 pi 的空界面。
// 裁决层的运行期部分(P5.3)也在这里装:会话建好后、session_start 之前覆盖保留域入口,session_start 之后
// 补裁插件在其中补登记的钩子与指令。
// 插件指令(P5.7)上下文里的会话管理动作(新建 / 分叉 / 树导航 / 切换会话 / 重载)归应用:一律按「取消」回答并记
// 审计(pi 不绑时的默认实现是什么都不做却回答「没取消」,插件会以为成功了)。waitForIdle 等会话真正空闲。

import type { AgentSession } from "../../../pi/packages/coding-agent/src/core/agent-session.ts";
import { emitSessionShutdownEvent } from "../../../pi/packages/coding-agent/src/core/extensions/runner.ts";
import type { EngineErrorReport } from "../../engines/contract";
import { activePiPluginId, arbitrateLatePiRegistrations, guardPiPluginDialogs, guardPiPluginRuntime, type PiPluginPolicy } from "./arbiter";
import { pluginIdForExtensionPath, type PiPluginEntry } from "./entries";
import { createPiPluginUi, type PiPluginInteraction } from "./ui-bridge";

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
  interaction?: PiPluginInteraction,
): Promise<PiPluginSessionBinding> {
  if (plugins.length === 0) return NO_PLUGINS;
  const extensions = session.resourceLoader.getExtensions();
  if (policy) guardPiPluginRuntime(extensions, policy);
  const ui = interaction
    ? guardPiPluginDialogs(createPiPluginUi(interaction, { pluginIds: plugins.map((entry) => entry.pluginId), report }))
    : undefined;
  const refused = (subject: string) => policy?.onAudit({ pluginId: activePiPluginId() ?? "", action: "removed", subject });
  const cancelled = (subject: string) => async () => {
    refused(subject);
    return { cancelled: true };
  };
  await session.bindExtensions({
    ...(ui ? { uiContext: ui } : {}),
    mode: "rpc",
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: cancelled("new-session"),
      fork: cancelled("fork"),
      navigateTree: cancelled("navigate-tree"),
      switchSession: cancelled("switch-session"),
      reload: async () => refused("reload"),
    },
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
